import gzip
import io
import json
import os
import re
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from server import create_app
from database import connect


class CardsIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory=Path(self.tmp.name)
        self.app=create_app(self.directory, True)
        self.http=self.app.test_client()
        self.owner=self.login('owner')
        self.guest=self.login('guest')

    def login(self,who):
        token=self.http.post('/api/login',json={'dev':who}).get_json()['token']
        return {'Authorization':'Bearer '+token}

    def post(self,path,data,headers=None):
        return self.http.post('/api/'+path,json=data,headers=headers or self.owner)

    def test_h5_browser_identity_survives_token_renewal(self):
        app=create_app(self.directory)
        first,second=app.test_client(),app.test_client()
        def browser_login(client):
            # A browser identity always starts as a player, regardless of input.
            reply=client.post('/api/web/login',json={'dev':'owner','role':'owner'})
            return {'Authorization':'Bearer '+reply.get_json()['token']}
        headers=browser_login(first)
        before=first.get('/api/state',headers=headers).get_json()
        self.assertEqual(before['who']['role'],'user')
        pool=before['pools'][0]['id']
        first.post('/api/draws',headers=headers,json=dict(pool=pool,skin='whale',requestId='browser-test'))
        after=first.get('/api/state',headers=browser_login(first)).get_json()
        other=second.get('/api/state',headers=browser_login(second)).get_json()
        self.assertEqual(before['who']['id'],after['who']['id'])
        self.assertEqual(sum(after['counts'].values()),10)
        self.assertNotEqual(other['who']['id'],after['who']['id'])
        self.assertFalse(other['counts'])
        self.assertEqual(first.post('/api/pools',headers=headers,json={'name':'x'}).status_code,403)

    def test_shared_pool_private_collection_and_atomic_draw(self):
        pool=self.post('pools',{'name':'联调卡池'}).get_json()['id']
        img=io.BytesIO()
        Image.new('RGBA',(40,56),'#228866').save(img,'PNG')
        raw=img.getvalue()
        def upload():
            r=self.http.post('/api/uploads',data={'file':(io.BytesIO(raw),'card.png')},headers=self.owner)
            self.assertEqual(r.status_code,200)
            return r.get_json()['src']
        subject,frame,back=upload(),upload(),upload()
        resource=self.post('resources',dict(kind='frames',src=frame,name='测试边框',ratio='5x7')).get_json()['id']
        back_resource=self.post('resources',dict(kind='backs',src=back,name='测试卡背',ratio='5x7')).get_json()['id']
        recipe=dict(ratio='5x7',color='#AABBCC',special=True,background='',frame=frame,pool=pool,
                    back=back,items=[dict(name='样卡',subject=subject)])
        # A bad second selection must not leave the first card in the catalog.
        bad=dict(recipe,items=recipe['items']+[dict(name='坏图',subject='/media/missing.png')])
        self.assertEqual(self.post('cards',bad).status_code,400)
        created=self.post('cards',recipe).get_json()['cards'][0]['id']
        self.assertEqual(self.post('pools/'+pool+'/rates',{'normalRate':9999,'rareRate':0}).status_code,400)
        self.assertEqual(self.post('pools/'+pool+'/rates',{'normalRate':0,'rareRate':10000}).status_code,200)
        self.assertEqual(self.post('cards',recipe,self.guest).status_code,403)
        self.http.delete('/api/resources/'+resource,headers=self.owner)
        self.http.delete('/api/resources/'+back_resource,headers=self.owner)
        with self.http.get(frame) as r:self.assertEqual(r.data,raw)
        with self.http.get(subject) as r:self.assertEqual(r.data,raw)
        with self.http.get(back) as r:self.assertEqual(r.data,raw)
        export_path=f'/api/cards/{created}/file'
        self.assertEqual(self.http.get(export_path).status_code,401)
        guest=self.http.get('/api/state',headers=self.guest).get_json()['who']
        permission='users/'+guest['id']+'/card-file-access'
        self.assertFalse(guest['canDownloadCards'])
        self.assertEqual(self.http.get(export_path,headers=self.guest).status_code,403)
        self.assertEqual(self.post(permission,{'enabled':True},self.guest).status_code,403)
        self.assertEqual(self.post(permission,{'enabled':True}).status_code,200)
        self.assertEqual(self.http.get(export_path,headers=self.guest).status_code,404)
        data={'requestId':'same-pack','pool':pool,'skin':'whale'}
        def draw(_):
            with self.app.test_client() as client:
                r=client.post('/api/draws',json=data,headers=self.guest)
                self.assertEqual(r.status_code,200)
                return [c['id'] for c in r.get_json()['cards']]
        with ThreadPoolExecutor(2) as executor:
            self.assertEqual(list(executor.map(draw,range(2))),[[created]*10]*2)
        self.assertEqual(self.post('draws',dict(data,skin='peach'),self.guest).status_code,409)
        self.http=create_app(self.directory,True).test_client()
        a=self.http.get('/api/state',headers=self.owner).get_json()
        b=self.http.get('/api/state',headers=self.login('guest')).get_json()
        self.assertEqual(a['counts'],{})
        self.assertEqual(b['counts'],{created:10})
        self.assertTrue(b['who']['canDownloadCards'])
        with self.http.get(export_path,headers=self.guest) as response:
            self.assertEqual(response.status_code,200)
            self.assertTrue(response.headers['Content-Disposition'].startswith('attachment;'))
            self.assertTrue(response.cache_control.no_store)
            match=re.search(r'id="card-data">(.*?)</script>',response.get_data(as_text=True))
            card=json.loads(match[1])
            self.assertTrue(card['frame'].startswith('data:image/png;base64,'))
            self.assertEqual(card['subject'],card['frame'])
            self.assertEqual(card['back'],card['frame'])
        self.assertEqual(self.post(permission,{'enabled':False}).status_code,200)
        self.assertEqual(self.http.get(export_path,headers=self.guest).status_code,403)
        self.assertFalse(b['profiles'])
        self.assertEqual(len([c for c in a['cards'] if c['name']=='样卡']),1)
        target='users/'+b['who']['id']+'/role'
        self.assertEqual(self.post(target,{'role':'maker'},self.guest).status_code,403)
        self.assertEqual(self.post(target,{'role':'maker'}).status_code,200)
        self.assertEqual(self.post('pools',{'name':'test'},self.guest).status_code,403)
        self.assertEqual(self.post('cards',dict(recipe,frame=''),self.guest).status_code,400)
        self.assertEqual(self.post(target,{'role':'user'}).status_code,200)

    def test_kanto_cached_skin_and_archived_collection(self):
        def state():
            return self.http.get('/api/state',headers=self.guest).get_json()
        initial=state()
        self.assertEqual([p['id'] for p in initial['pools']],['kanto']+[f'gen{i}' for i in range(2,10)])
        self.assertEqual(len([c for c in initial['cards'] if c['id'].startswith('kanto-')]),151)
        self.assertFalse(any(c['special'] for c in initial['cards']))
        data=dict(pool='kanto',requestId='cached-pack',skin='whale')
        result=self.post('draws',data,self.guest).get_json()['cards']
        self.assertEqual(len(result),10)
        with closing(connect(self.directory/'cards.db')) as db:
            self.assertEqual(db.execute('SELECT skin FROM draws').fetchone()[0],'kanto')
        self.assertEqual(self.http.delete('/api/pools/kanto',headers=self.guest).status_code,403)
        self.assertEqual(self.http.delete('/api/pools/kanto',headers=self.owner).status_code,200)
        self.http=create_app(self.directory,True).test_client()
        after=state()
        self.assertNotIn('kanto',{p['id'] for p in after['pools']})
        self.assertEqual(sum(after['counts'].values()),10)
        self.assertEqual(set(after['counts']),{c['id'] for c in after['cards'] if c['id'].startswith('kanto-')})
        album=self.http.get('/api/album',headers=self.guest).get_json()
        self.assertEqual(album['groups'][-1]['id'],'unassigned')
        cards=self.http.get('/api/album/unassigned/cards',headers=self.guest).get_json()
        self.assertEqual({c['id'] for c in cards['cards']},set(after['counts']))
        self.assertIsNone(cards['nextOffset'])
        self.assertEqual(self.post('draws',dict(data,skin='kanto'),self.guest).get_json()['cards'],result)
        self.assertEqual(self.post('draws',dict(data,requestId='new'),self.guest).status_code,404)
        self.assertEqual(self.post('pools',{'name':initial['pools'][0]['name']}).status_code,200)

    def test_three_card_draw_can_be_replayed_after_pack_size_change(self):
        who=self.http.get('/api/album',headers=self.guest).get_json()['who']
        saved=['kanto-001','kanto-002','kanto-003']
        with closing(connect(self.directory/'cards.db')) as db, db:
            draw=db.execute('INSERT INTO draws(user_id,request_id,pool,skin) VALUES(?,?,?,?)',
                            (who['id'],'old-pack','kanto','kanto')).lastrowid
            db.executemany('INSERT INTO draw_cards VALUES(?,?,?)',
                           [(draw,slot,card) for slot,card in enumerate(saved)])
        data=dict(pool='kanto',skin='kanto',requestId='old-pack',thumbnails=True)
        replay=self.post('draws',data,self.guest).get_json()['cards']
        self.assertEqual([card['id'] for card in replay],saved)
        self.assertEqual(replay[0]['back'],'/thumb/h5/kanto/back.webp')
        results=self.post('draws',dict(data,requestId='new-pack'),self.guest).get_json()['cards']
        self.assertEqual(len(results),10)
        self.assertEqual(self.http.get('/api/album',headers=self.guest).get_json()['total'],13)

    def test_interactive_file_embeds_printed_faces_and_escapes_name(self):
        card_id='kanto-001'
        name='</script><script>'
        with closing(connect(self.directory/'cards.db')) as db, db:
            db.execute('UPDATE cards SET name=? WHERE id=?',(name,card_id))
        with self.http.get(f'/api/cards/{card_id}/file',headers=self.owner) as response:
            self.assertEqual(response.status_code,200)
            html=response.get_data(as_text=True)
            self.assertIn('&lt;/script&gt;&lt;script&gt;',html)
            self.assertNotIn(name,html)
            card=json.loads(re.search(r'id="card-data">(.*?)</script>',html)[1])
            self.assertEqual(card['name'],name)
            self.assertEqual(card['dex'],1)
            self.assertTrue(all(card[key].startswith('data:image/') for key in ('subject','frame','background','back')))

    def test_compose_preview_file_requires_download_and_maker_access(self):
        image=io.BytesIO()
        Image.new('RGB',(30,40),'#126944').save(image,'PNG')
        guest=self.http.get('/api/state',headers=self.guest).get_json()['who']['id']
        def preview(headers,ratio='7x5',back=''):
            return self.http.post('/api/cards/preview-file',headers=headers,data={
                'file':(io.BytesIO(image.getvalue()),'preview.png'),
                'name':'预览样卡','ratio':ratio,'color':'#aaccdd','special':'true','back':back})
        self.assertEqual(self.post(f'users/{guest}/role',{'role':'maker'}).status_code,200)
        self.assertEqual(preview(self.guest).status_code,403)
        self.assertEqual(self.post(f'users/{guest}/card-file-access',{'enabled':True}).status_code,200)
        with preview(self.guest) as response:
            self.assertEqual(response.status_code,200)
            card=json.loads(re.search(r'id="card-data">(.*?)</script>',response.get_data(as_text=True))[1])
            self.assertEqual(card['name'],'预览样卡')
            self.assertEqual(card['ratio'],'7x5')
            self.assertTrue(card['special'])
            self.assertTrue(card['subject'].startswith('data:image/png;base64,'))
            self.assertEqual(card['back'],'')
        self.assertEqual(preview(self.guest,back='/h5/gen2/back.webp').status_code,400)
        with preview(self.guest,ratio='5x7',back='/h5/gen2/back.webp') as response:
            self.assertEqual(response.status_code,200)
            card=json.loads(re.search(r'id="card-data">(.*?)</script>',response.get_data(as_text=True))[1])
            self.assertTrue(card['back'].startswith('data:image/webp;base64,'))
        self.assertEqual(self.post(f'users/{guest}/role',{'role':'user'}).status_code,200)
        self.assertEqual(preview(self.guest).status_code,403)
        self.assertFalse(any((self.directory/'uploads').iterdir()))
        with closing(connect(self.directory/'cards.db')) as db:
            self.assertIsNone(db.execute("SELECT 1 FROM cards WHERE name='预览样卡'").fetchone())

    def test_generation_art_and_draw_retry(self):
        state=self.http.get('/api/state',headers=self.guest).get_json()
        for pool in state['pools']:
            base='/h5/'+pool['id']+'/'
            card=next(c for c in state['cards'] if c['id']==pool['entries'][0]['id'])
            self.assertEqual(pool['pack']['src'],base+'pack.webp')
            self.assertEqual(card['background'],base+('field.jpg' if pool['id']=='kanto' else 'field.webp'))
            self.assertEqual(card['back'],base+'back.webp')
            for src in (pool['pack']['src'],card['background'],card['back']):
                with self.http.get(src) as response:
                    self.assertEqual(response.status_code,200)

        data=dict(pool='gen2',skin='pudding',requestId='generation-retry')
        before=self.post('draws',data,self.guest).get_json()['cards']
        after=self.post('draws',dict(data,skin='gen2'),self.guest)
        self.assertEqual(after.status_code,200)
        self.assertEqual(after.get_json()['cards'],before)
        self.assertTrue(all(c['back']=='/h5/gen2/back.webp' for c in before))

    def test_album_summary_batches_and_thumbnail_responses(self):
        drawn=self.post('draws',dict(pool='kanto',skin='kanto',requestId='album'),self.guest).get_json()['cards']
        owned={card['id'] for card in drawn}
        album=self.http.get('/api/album',headers=self.guest).get_json()
        self.assertEqual(album['total'],10)
        self.assertEqual(album['distinct'],len(owned))
        self.assertNotIn('cards',album)
        self.assertEqual(album['groups'][0],dict(id='kanto',name='关都卡池',total=151,found=len(owned)))
        home=self.http.get('/api/home',headers=self.guest).get_json()
        self.assertEqual(home['pools'][0]['count'],151)
        self.assertEqual(home['cardsPerPack'],10)
        self.assertNotIn('entries',home['pools'][0])
        route='/api/album/kanto/cards'
        first=self.http.get(route,headers=self.guest).get_json()
        second=self.http.get(route+'?offset=12',headers=self.guest).get_json()
        self.assertEqual(first['nextOffset'],12)
        self.assertEqual(len(first['cards']),12)
        self.assertEqual({c['id'] for c in first['cards'][:len(owned)]},owned)
        self.assertFalse({c['id'] for c in first['cards']}&{c['id'] for c in second['cards']})
        self.assertEqual(self.http.get(route+'?offset=bad',headers=self.guest).status_code,400)
        card=first['cards'][0]
        self.assertTrue(card['subject'].startswith('/thumb/'))
        with self.http.get(card['subject']) as response:
            self.assertEqual(response.mimetype,'image/webp')
            image=Image.open(io.BytesIO(response.data))
            self.assertEqual(image.format,'WEBP')
            self.assertLessEqual(max(image.size),320)
            self.assertEqual(response.cache_control.max_age,3600)
        detail=self.http.get('/api/cards/'+card['id'],headers=self.guest).get_json()['card']
        self.assertEqual(card['subject'],'/thumb'+detail['subject'])
        unowned=first['cards'][-1]['id']
        self.assertEqual(self.http.get('/api/cards/'+unowned,headers=self.guest).status_code,404)
        with self.http.get('/api/state',headers={**self.guest,'Accept-Encoding':'gzip'}) as compressed:
            self.assertEqual(compressed.headers['Content-Encoding'],'gzip')
            self.assertIn('Accept-Encoding',compressed.vary)
            self.assertGreater(len(json.loads(gzip.decompress(compressed.data))['cards']),100)

    def test_mixed_tier_draw_and_empty_tier_fallback(self):
        pool=self.post('pools',{'name':'分档'}).get_json()['id']
        with closing(connect(self.directory/'cards.db')) as db, db:
            db.execute("UPDATE cards SET special=1 WHERE id='whale'")
        def member(card,included):
            self.assertEqual(self.post(f'pools/{pool}/member',dict(card=card,included=included)).status_code,200)
        def roll(key,values):
            with patch('server.secrets.randbelow',side_effect=values):
                return [c['id'] for c in self.post('draws',dict(pool=pool,skin='peach',requestId=key)).get_json()['cards']]
        member('peach',True)
        self.assertEqual(self.post(f'pools/{pool}/rates',dict(normalRate=8000,rareRate=2000)).status_code,200)
        self.assertEqual(roll('normal-only',[0]*10),['peach']*10)
        member('whale',True)
        self.assertEqual(roll('mixed',[1999,2000]+[9999]*8),['whale']+['peach']*9)
        member('pudding',True)
        snapshot=self.http.get('/api/state',headers=self.owner).get_json()
        entries=next(p['entries'] for p in snapshot['pools'] if p['id']==pool)
        self.assertEqual({e['id']:e['chance'] for e in entries},{'peach':4000,'pudding':4000,'whale':2000})
        member('peach',False)
        member('pudding',False)
        self.assertEqual(roll('rare-only',[9999]*10),['whale']*10)
        member('pudding',True)
        self.assertEqual(self.post(f'pools/{pool}/rates',dict(normalRate=0,rareRate=10000)).status_code,200)
        shown=self.http.get(f'/api/album/{pool}/cards',headers=self.guest).get_json()
        self.assertEqual([c['id'] for c in shown['cards']],['whale'])

    def test_wechat_identity_not_supplied_by_client(self):
        client=create_app(self.directory/'prod').test_client()
        self.assertEqual(client.post('/api/login',json={'dev':'owner'}).status_code,400)
        self.assertEqual(client.get('/api/state').status_code,401)
        with patch.dict(os.environ,{'WX_APP_SECRET':'test'}),patch('server.urlopen') as exchange:
            def response(*args,**kwargs):
                return io.BytesIO(b'{"openid":"verified-test-user"}')
            exchange.side_effect=response
            def authenticated():
                r=client.post('/api/login',json={'code':'test-code','role':'owner','openid':'fake'})
                return {'Authorization':'Bearer '+r.get_json()['token']}
            one=client.get('/api/state',headers=authenticated()).get_json()['who']
            two=client.get('/api/state',headers=authenticated()).get_json()['who']
            self.assertEqual(one,two)
            self.assertEqual(one['role'],'user')
            db=connect(self.directory/'prod'/'cards.db')
            self.assertEqual(db.execute('SELECT openid FROM users').fetchone()[0],'verified-test-user')
            db.close()


if __name__=='__main__':
    unittest.main()
