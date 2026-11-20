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
        return self.register(self.http,token,who)

    def register(self,client,token,name):
        headers={'Authorization':'Bearer '+token}
        self.assertEqual(client.post('/api/profile/username',json={'name':name},headers=headers).status_code,200)
        return headers

    def post(self,path,data,headers=None):
        return self.http.post('/api/'+path,json=data,headers=headers or self.owner)

    def test_h5_browser_identity_survives_token_renewal(self):
        app=create_app(self.directory)
        first,second=app.test_client(),app.test_client()
        def browser_login(client,name):
            # A browser identity always starts as a player, regardless of input.
            reply=client.post('/api/web/login',json={'dev':'owner','role':'owner'})
            return self.register(client,reply.get_json()['token'],name)
        headers=browser_login(first,'网页用户')
        before=first.get('/api/state',headers=headers).get_json()
        self.assertEqual(before['who']['role'],'user')
        pool=before['pools'][0]['id']
        first.post('/api/draws',headers=headers,json=dict(pool=pool,skin='whale',requestId='browser-test'))
        after=first.get('/api/state',headers=browser_login(first,'网页用户')).get_json()
        other=second.get('/api/state',headers=browser_login(second,'另一个网页用户')).get_json()
        self.assertEqual(before['who']['id'],after['who']['id'])
        self.assertEqual(sum(after['counts'].values()),10)
        self.assertNotEqual(other['who']['id'],after['who']['id'])
        self.assertFalse(other['counts'])
        pool=first.post('/api/pools',headers=headers,json={'name':'x'}).get_json()
        self.assertEqual(pool['status'],'draft')
        self.assertNotIn(pool['id'],{p['id'] for p in first.get('/api/home',headers=headers).get_json()['pools']})

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
        # Existing public pools can accept proposals, but subjects still have to belong to the proposer.
        self.assertEqual(self.post('cards',recipe,self.guest).status_code,400)
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
        self.assertEqual(self.post('pools',{'name':'test'},self.guest).get_json()['status'],'draft')
        self.assertEqual(self.post('cards',dict(recipe,frame='',pool=''),self.guest).status_code,400)
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
        self.assertEqual(self.http.delete('/api/pools/kanto',headers=self.guest).status_code,404)
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
            db.executemany('INSERT INTO draw_cards(draw_id,slot,card) VALUES(?,?,?)',
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

    def test_compose_preview_file_requires_download_access(self):
        image=io.BytesIO()
        Image.new('RGB',(30,40),'#126944').save(image,'PNG')
        guest=self.http.get('/api/state',headers=self.guest).get_json()['who']['id']
        def preview(headers,ratio='7x5',back=''):
            return self.http.post('/api/cards/preview-file',headers=headers,data={
                'file':(io.BytesIO(image.getvalue()),'preview.png'),
                'name':'预览样卡','ratio':ratio,'color':'#aaccdd','special':'true','back':back})
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
        self.assertEqual(self.post(f'users/{guest}/card-file-access',{'enabled':False}).status_code,200)
        self.assertEqual(preview(self.guest).status_code,403)
        self.assertFalse(any((self.directory/'uploads').iterdir()))
        with closing(connect(self.directory/'cards.db')) as db:
            self.assertIsNone(db.execute("SELECT 1 FROM cards WHERE name='预览样卡'").fetchone())

    def test_publication_requires_owner_review_for_pool_pack_and_cards(self):
        outsider=self.register(self.http,self.http.post('/api/web/login',json={}).get_json()['token'],'路人')
        def get(path,headers):
            return self.http.get('/api/'+path,headers=headers).get_json()
        def upload(headers):
            image=io.BytesIO()
            Image.new('RGBA',(60,84),'#395eae').save(image,'PNG')
            result=self.http.post('/api/uploads',headers=headers,data={'file':(io.BytesIO(image.getvalue()),'asset.png')})
            self.assertEqual(result.status_code,200)
            return result.get_json()['src']
        pool=self.post('pools',{'name':'投稿卡池'},self.guest).get_json()['id']
        pack=upload(self.guest)
        asset=self.post('resources',dict(kind='packs',name='投稿卡包',src=pack),self.guest).get_json()['id']
        self.assertEqual(self.post(f'pools/{pool}/pack',{'src':pack},self.guest).status_code,200)
        self.assertEqual(self.post(f'pools/{pool}/submit',{},self.guest).status_code,400)
        frame,background=upload(self.guest),upload(self.guest)
        self.assertEqual(self.post('resources',dict(kind='frames',name='投稿卡框',src=frame,ratio='5x7'),self.guest).status_code,200)
        self.assertEqual(self.post('resources',dict(kind='backgrounds',name='投稿背景',src=background),self.guest).status_code,200)
        card_data=dict(ratio='5x7',color='#aabbcc',special=True,pool=pool,frame=frame,background=background,
                       items=[dict(name='投稿闪卡',subject=upload(self.guest))])
        card=self.post('cards',card_data,self.guest).get_json()['cards'][0]
        self.assertEqual(card['status'],'pending')
        self.assertEqual(get('studio',outsider)['pools'],[])
        self.assertFalse(any(c['id']==card['id'] for c in get('studio',outsider)['cards']))
        self.assertEqual(get('studio',outsider)['packs'],[])
        self.assertNotIn(frame,{r['src'] for r in get('studio',outsider)['frames']})
        self.assertNotIn(background,{r['src'] for r in get('studio',outsider)['backgrounds']})
        self.assertEqual(self.http.delete('/api/resources/'+asset,headers=outsider).status_code,404)
        self.assertEqual(self.post(f'pools/{pool}/name',{'name':'改别人的卡池'},outsider).status_code,404)
        request=dict(pool=pool,skin=pool,requestId='after-review')
        for stage in ('draft','pending'):
            self.assertNotIn(pool,{p['id'] for p in get('home',outsider)['pools']})
            self.assertNotIn(pool,{p['id'] for p in get('album',outsider)['groups']})
            self.assertEqual(self.post('draws',request,outsider).status_code,404)
            if stage=='draft':self.assertEqual(self.post(f'pools/{pool}/submit',{},self.guest).status_code,200)
        pending=next(p for p in get('studio',self.owner)['pools'] if p['id']==pool)
        self.assertEqual(pending['pack']['src'],pack)
        self.assertIsNone(pending['actualRareRate'])
        self.assertEqual(self.post(f'pools/{pool}/review',dict(approved=True,reviewKey=pending['review_key']),self.guest).status_code,403)
        self.assertEqual(self.post(f'pools/{pool}/name',{'name':'插队修改'},self.guest).status_code,409)
        self.assertEqual(self.post(f'pools/{pool}/review',
            dict(approved=False,reviewKey=pending['review_key'],reason='  请更换卡包图  ')).get_json()['status'],'returned')
        returned=next(p for p in get('studio',self.guest)['pools'] if p['id']==pool)
        self.assertEqual(returned['review_reason'],'请更换卡包图')
        self.assertEqual(self.post(f'pools/{pool}/name',{'name':'修订后卡池'},self.guest).status_code,200)
        self.assertEqual(self.post(f'pools/{pool}/submit',{},self.guest).status_code,200)
        self.assertEqual(self.post(f'pools/{pool}/review',dict(approved=True,reviewKey=pending['review_key'])).status_code,409)
        pending=next(p for p in get('studio',self.owner)['pools'] if p['id']==pool)
        self.assertEqual(pending['review_reason'],'')
        self.assertEqual(self.post(f'pools/{pool}/review',dict(approved=True,reviewKey=pending['review_key'])).status_code,200)
        approved=next(p for p in get('studio',self.owner)['pools'] if p['id']==pool)
        self.assertEqual(approved['actualRareRate'],10000)
        public=next(p for p in get('home',outsider)['pools'] if p['id']==pool)
        self.assertEqual((public['name'],public['count'],public['pack']['src']),('修订后卡池',1,pack))
        draw_cards=self.post('draws',request,outsider).get_json()['cards']
        self.assertEqual([c['id'] for c in draw_cards],[card['id']]*10)
        self.assertTrue(all(c['frame']==frame and c['background']==background for c in draw_cards))
        addition=self.post('cards',dict(card_data,items=[dict(name='追加闪卡',subject=upload(self.guest))]),self.guest).get_json()['cards'][0]['id']
        self.assertEqual(next(p for p in get('home',outsider)['pools'] if p['id']==pool)['count'],1)
        pending_card=next(c for c in get('studio',self.owner)['cards'] if c['id']==addition)
        self.assertEqual(self.post(f'cards/{addition}/review',dict(approved=True,reviewKey=pending_card['review_key'])).status_code,200)
        self.assertEqual(next(p for p in get('home',outsider)['pools'] if p['id']==pool)['count'],2)
        self.assertEqual(self.post(f'pools/{pool}/withdraw',{},self.guest).status_code,200)
        self.assertEqual(self.post('draws',dict(request,requestId='withdrew'),outsider).status_code,404)
        self.assertEqual(len(self.post('draws',request,outsider).get_json()['cards']),10)

        standalone=self.post('cards',dict(card_data,pool='',items=[dict(name='单张投稿',subject=upload(self.guest))]),
                             self.guest).get_json()['cards'][0]['id']
        def card_ticket():
            return next(c['review_key'] for c in get('studio',self.owner)['cards'] if c['id']==standalone)
        first_ticket=card_ticket()
        route=f'cards/{standalone}/review'
        self.assertEqual(self.post(route,dict(approved=True,reviewKey=first_ticket),self.guest).status_code,403)
        self.assertEqual(self.post(route,dict(approved=False,reviewKey=first_ticket,reason='x'*201)).status_code,400)
        self.assertEqual(self.post(route,dict(approved=False,reviewKey=first_ticket,reason='调整卡框')).get_json()['status'],'returned')
        own_card=next(c for c in get('studio',self.guest)['cards'] if c['id']==standalone)
        self.assertEqual(own_card['review_reason'],'调整卡框')
        self.assertEqual(self.post(f'cards/{standalone}/resubmit',{'name':'修订闪卡'},self.guest).status_code,200)
        own_card=next(c for c in get('studio',self.guest)['cards'] if c['id']==standalone)
        self.assertEqual(own_card['review_reason'],'')
        self.assertEqual(self.post(route,dict(approved=True,reviewKey=first_ticket)).status_code,409)
        self.assertEqual(self.post(route,dict(approved=True,reviewKey=card_ticket())).get_json()['status'],'approved')
        self.assertEqual(self.http.get('/api/cards/'+standalone,headers=outsider).status_code,404)

    def test_unique_username_required_and_ban_applies_to_live_sessions(self):
        client=self.app.test_client()
        def browser_token():
            return client.post('/api/web/login',json={})
        headers={'Authorization':'Bearer '+browser_token().get_json()['token']}
        self.assertEqual(client.get('/api/home',headers=headers).status_code,428)
        self.assertEqual(client.post('/api/draws',headers=headers,json={}).status_code,428)
        self.assertEqual(client.post('/api/profile/username',headers=headers,json={'name':' ＧＵＥＳＴ '}).status_code,409)
        self.assertEqual(client.post('/api/profile/username',headers=headers,json={'name':'   '}).status_code,400)
        self.assertEqual(client.post('/api/profile/username',headers=headers,json={'name':'星星'}).status_code,200)
        who=client.get('/api/home',headers=headers).get_json()['who']
        self.assertEqual(who['name'],'星星')
        self.assertEqual(browser_token().status_code,200)
        path=f"users/{who['id']}/ban"
        self.assertEqual(self.post(path,{'banned':True},self.guest).status_code,403)
        self.assertEqual(self.post(path,{'banned':True}).status_code,200)
        self.assertEqual(client.get('/api/home',headers=headers).status_code,403)
        self.assertEqual(client.post('/api/draws',headers=headers,json={}).status_code,403)
        self.assertEqual(client.post('/api/uploads',headers=headers,data={}).status_code,403)
        self.assertEqual(browser_token().status_code,403)
        profile=next(p for p in self.http.get('/api/studio',headers=self.owner).get_json()['profiles'] if p['id']==who['id'])
        self.assertTrue(profile['banned'])
        self.assertEqual(self.post(path,{'banned':False}).status_code,200)
        self.assertEqual(client.get('/api/home',headers=headers).get_json()['who'],who)
        self.assertEqual(browser_token().status_code,200)

    def test_listing_applies_to_pool_and_members_independently(self):
        pool=self.post('pools',{'name':'上架测试'}).get_json()['id']
        card='kanto-001'
        self.assertEqual(self.post(f'pools/{pool}/member',{'card':card,'included':True}).status_code,200)
        draw=dict(pool=pool,skin='peach',requestId='original')
        self.assertEqual([c['id'] for c in self.post('draws',draw,self.guest).get_json()['cards']],[card]*10)
        member=f'pools/{pool}/card-listing'
        listing=f'pools/{pool}/listing'
        self.assertEqual(self.post(member,{'card':card,'listed':False},self.guest).status_code,403)
        self.assertEqual(self.post(listing,{'listed':False},self.guest).status_code,403)
        self.assertEqual(self.post(member,{'card':card,'listed':False}).status_code,200)
        self.assertEqual(self.post('draws',dict(draw,requestId='hidden-card'),self.guest).status_code,409)
        for included in (False,True):
            self.assertEqual(self.post(f'pools/{pool}/member',{'card':card,'included':included}).status_code,200)
        self.assertEqual(self.post('draws',dict(draw,requestId='reassigned-card'),self.guest).status_code,409)
        self.assertEqual(self.http.get(f'/api/cards/{card}',headers=self.guest).status_code,200)
        self.assertEqual(self.http.get(f'/api/album/{pool}/cards',headers=self.guest).get_json()['cards'],[])
        other_pool=self.http.get('/api/album/kanto/cards',headers=self.guest).get_json()['cards']
        self.assertIn(card,{c['id'] for c in other_pool})
        def home_ids():
            return {p['id'] for p in self.http.get('/api/home',headers=self.guest).get_json()['pools']}
        self.assertNotIn(pool,home_ids())
        self.assertEqual(self.post(listing,{'listed':False}).status_code,200)
        self.assertEqual(self.post(member,{'card':card,'listed':True}).status_code,200)
        self.assertNotIn(pool,home_ids())
        self.assertEqual(self.post('draws',dict(draw,requestId='hidden-pool'),self.guest).status_code,404)
        self.assertEqual(self.post('draws',draw,self.guest).status_code,200)
        self.assertEqual(self.post(listing,{'listed':True}).status_code,200)
        self.assertIn(pool,home_ids())
        self.assertEqual(self.post('draws',dict(draw,requestId='relisted'),self.guest).status_code,200)

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
            response=self.post(f'pools/{pool}/member',dict(card=card,included=included))
            self.assertEqual(response.status_code,200)
            return response.get_json()['actualRareRate']
        def roll(key,values):
            with patch('server.secrets.randbelow',side_effect=values):
                return [c['id'] for c in self.post('draws',dict(pool=pool,skin='peach',requestId=key)).get_json()['cards']]
        def studio_pool():
            data=self.http.get('/api/studio',headers=self.owner).get_json()
            return next(p for p in data['pools'] if p['id']==pool)
        self.assertEqual(member('peach',True),0)
        self.assertEqual(self.post(f'pools/{pool}/rates',dict(normalRate=8000,rareRate=2000)).status_code,200)
        self.assertEqual(studio_pool()['actualRareRate'],0)
        self.assertEqual(roll('normal-only',[0]*10),['peach']*10)
        self.assertEqual(member('whale',True),2000)
        self.assertEqual(studio_pool()['actualRareRate'],2000)
        self.assertEqual(roll('mixed',[1999,2000]+[9999]*8),['whale']+['peach']*9)
        listing=f'pools/{pool}/card-listing'
        self.assertEqual(self.post(listing,{'card':'peach','listed':False}).get_json()['actualRareRate'],10000)
        hidden=studio_pool()
        self.assertEqual((hidden['rareRate'],hidden['actualRareRate']),(2000,10000))
        self.assertEqual(roll('normal-hidden',[9999]*10),['whale']*10)
        self.assertIsNone(self.post(listing,{'card':'whale','listed':False}).get_json()['actualRareRate'])
        self.assertIsNone(studio_pool()['actualRareRate'])
        self.assertEqual(self.post(listing,{'card':'peach','listed':True}).get_json()['actualRareRate'],0)
        self.assertEqual(self.post(listing,{'card':'whale','listed':True}).get_json()['actualRareRate'],2000)
        pool_listing=f'pools/{pool}/listing'
        self.assertIsNone(self.post(pool_listing,{'listed':False}).get_json()['actualRareRate'])
        self.assertIsNone(studio_pool()['actualRareRate'])
        self.assertEqual(self.post(pool_listing,{'listed':True}).get_json()['actualRareRate'],2000)
        member('pudding',True)
        snapshot=self.http.get('/api/state',headers=self.owner).get_json()
        entries=next(p['entries'] for p in snapshot['pools'] if p['id']==pool)
        self.assertEqual({e['id']:e['chance'] for e in entries},{'peach':4000,'pudding':4000,'whale':2000})
        member('peach',False)
        self.assertEqual(member('pudding',False),10000)
        self.assertEqual(roll('rare-only',[9999]*10),['whale']*10)
        member('pudding',True)
        self.assertEqual(self.post(f'pools/{pool}/rates',dict(normalRate=0,rareRate=10000)).status_code,200)
        shown=self.http.get(f'/api/album/{pool}/cards',headers=self.guest).get_json()
        self.assertEqual([c['id'] for c in shown['cards']],['whale'])

    def test_private_pool_custom_types_cover_review_and_stardust(self):
        def read(path,auth=self.guest):
            return self.http.get('/api/'+path,headers=auth).get_json()

        def checked(path,data,auth=self.guest):
            response=self.post(path,data,auth)
            self.assertEqual(response.status_code,200,response.get_data(as_text=True))
            return response.get_json()

        pool=checked('pools',{'name':'自制主题池'})['id']
        types=[dict(id='normal',name='普通',rate=7000),dict(id='rare',name='稀有',rate=2500),
               dict(id='legend',name='传说闪卡',rate=500)]
        config=dict(types=types,cardsPerPack=3)
        checked(f'pools/{pool}/config',config)
        self.assertEqual(self.post(f'pools/{pool}/config',dict(config,cardsPerPack=0),self.guest).status_code,400)

        image=io.BytesIO()
        Image.new('RGB',(16,24),'#d6c491').save(image,'PNG')
        upload=self.http.post('/api/uploads',headers=self.guest,data={'file':(io.BytesIO(image.getvalue()),'cover.png')})
        self.assertEqual(upload.status_code,200)
        src=upload.get_json()['src']
        checked(f'pools/{pool}/pack',{'upload':src})

        def make(target,tier):
            return checked('cards',dict(ratio='5x7',color='#bbccdd',special=False,pool=target,tier=tier,
                                        items=[dict(name='投稿闪卡',subject=src)]))['cards'][0]['id']

        draft_cards=[make(pool,tier['id']) for tier in types]
        studio=read('studio',self.owner)
        self.assertTrue(set(draft_cards).isdisjoint(studio['reviewableCards']))
        draft=next(c for c in studio['cards'] if c['id']==draft_cards[0])
        self.assertEqual(self.post(f"cards/{draft['id']}/review",
            dict(approved=True,reviewKey=draft['review_key'])).status_code,409)
        home=read('home')
        self.assertEqual(home['stardust'],50)
        self.assertIn(pool,{p['id'] for p in home['privatePools']})
        self.assertNotIn(pool,{p['id'] for p in home['pools']})
        self.assertNotIn(pool,{p['id'] for p in read('home',self.owner)['privatePools']})
        self.assertEqual(self.http.get(f'/api/pools/{pool}/preview',headers=self.owner).status_code,404)
        self.assertEqual(read(f'pools/{pool}/preview')['pool']['pack']['src'],src)
        draw=dict(pool=pool,skin=pool,requestId='test')
        with patch('server.secrets.randbelow',side_effect=[0,2700,9900]):
            result=checked('draws',dict(draw,preview=True))
        self.assertCountEqual([c['tierName'] for c in result['cards']],['普通','稀有','传说闪卡'])
        self.assertEqual((result['stardust'],read('album')['total']),(50,0))
        self.assertEqual(self.post('draws',dict(draw,preview=True),self.owner).status_code,404)
        self.assertEqual(self.post('draws',draw,self.guest).status_code,404)

        checked(f'pools/{pool}/submit',{})
        submission=next(p for p in read('studio',self.owner)['pools'] if p['id']==pool)
        checked(f'pools/{pool}/review',{'approved':True,'reviewKey':submission['review_key']},self.owner)
        public=next(p for p in read('home',self.owner)['pools'] if p['id']==pool)
        self.assertEqual((public['cardsPerPack'],public['count'],public['pack']['src']),(3,3,src))

        base=next(p['count'] for p in read('home')['pools'] if p['id']=='kanto')
        addition=make('kanto','normal')
        self.assertEqual(next(p['count'] for p in read('home')['pools'] if p['id']=='kanto'),base)
        pending=next(c for c in read('studio',self.owner)['cards'] if c['id']==addition)
        self.assertIn(addition,read('studio',self.owner)['reviewableCards'])
        checked(f'cards/{addition}/review',{'approved':True,'reviewKey':pending['review_key']},self.owner)
        self.assertEqual(next(p['count'] for p in read('home')['pools'] if p['id']=='kanto'),base+1)

        self.assertEqual(checked('checkin',{})['stardust'],60)
        self.assertEqual(checked('checkin',{})['stardust'],60)
        first=checked('draws',draw)
        self.assertEqual((len(first['cards']),first['stardust']),(3,50))
        self.assertEqual(checked('draws',draw),first)
        for index in range(5):
            checked('draws',dict(draw,requestId=f'paid-{index}'))
        self.assertEqual(read('album')['total'],18)
        self.assertEqual(read('home')['stardust'],0)
        self.assertEqual(self.post('draws',dict(draw,requestId='insufficient'),self.guest).status_code,409)
        self.assertEqual(checked('draws',draw)['cards'],first['cards'])
        self.assertEqual(read('album')['total'],18)
        with closing(connect(self.directory/'cards.db')) as db, db:
            db.execute("UPDATE users SET checkin_day='2000-01-01' WHERE name='guest'")
        self.assertEqual(checked('checkin',{})['stardust'],10)

    def test_draw_recovery_never_starts_a_new_paid_draw(self):
        draw=dict(pool='kanto',skin='kanto',requestId='recovery')
        missing=self.post('draws',dict(draw,resumeOnly=True),self.guest)
        self.assertEqual(missing.status_code,404)
        self.assertEqual(missing.get_json()['code'],'draw_not_found')
        self.assertEqual(missing.get_json()['stardust'],50)
        self.assertEqual(self.http.get('/api/album',headers=self.guest).get_json()['total'],0)

        result=self.post('draws',draw,self.guest).get_json()
        self.assertEqual(result['stardust'],40)
        with closing(connect(self.directory/'cards.db')) as db, db:
            db.execute("UPDATE users SET stardust=0 WHERE name='guest'")
        rejected=self.post('draws',dict(draw,requestId='insufficient'),self.guest)
        self.assertEqual(rejected.status_code,409)
        self.assertEqual(rejected.get_json()['code'],'insufficient_stardust')
        self.assertEqual(rejected.get_json()['stardust'],0)
        restored=self.post('draws',dict(draw,resumeOnly=True),self.guest).get_json()
        self.assertEqual(restored['cards'],result['cards'])
        self.assertEqual(restored['stardust'],0)
        self.assertEqual(self.http.get('/api/album',headers=self.guest).get_json()['total'],10)

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
                return self.register(client,r.get_json()['token'],'微信用户')
            one=client.get('/api/state',headers=authenticated()).get_json()['who']
            two=client.get('/api/state',headers=authenticated()).get_json()['who']
            self.assertEqual(one,two)
            self.assertEqual(one['role'],'user')
            db=connect(self.directory/'prod'/'cards.db')
            self.assertEqual(db.execute('SELECT openid FROM users').fetchone()[0],'verified-test-user')
            db.close()


if __name__=='__main__':
    unittest.main()
