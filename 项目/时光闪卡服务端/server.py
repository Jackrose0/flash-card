import argparse
import gzip
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

from flask import Flask, abort, g, jsonify, request, send_from_directory
from PIL import Image, UnidentifiedImageError
from werkzeug.exceptions import HTTPException
from database import GENERATIONS, ROOT, connect, initialize

RATIOS = ('5x7','7x5','1x1')
SKINS = ('peach','pudding','whale')
KANTO_PACK = dict(id='kanto',name='关都 151',color='#f2e4cf',ink='#8d332b',src='/h5/kanto/pack.webp')
# 保留原有拆包记录中的皮肤值，专属包面由卡池 ID 决定。
GEN_PACKS = {
    cfg['dir']: dict(id=cfg['dir'], color=cfg['color'], src=f"/h5/{cfg['dir']}/pack.webp", skin=skin)
    for cfg, skin in zip(GENERATIONS.values(), ('pudding','whale','peach','pudding','peach','whale','pudding','whale'))
}
POOL_PACKS = {'kanto': KANTO_PACK, **GEN_PACKS}
PRINTED_CARDS = 'SELECT c.*, k.number AS dex, k.english FROM cards c LEFT JOIN card_print k ON k.card=c.id'
OWNED_COUNTS = '''SELECT dc.card, COUNT(*) AS quantity FROM draws d
    JOIN draw_cards dc ON dc.draw_id=d.id WHERE d.user_id=:user_id GROUP BY dc.card'''
ALBUM_ENTRIES = f'''WITH owned AS ({OWNED_COUNTS}), visible AS (
    SELECT e.pool,e.card,e.position,t.name AS tier_name FROM draw_candidates e
    JOIN draw_types t ON t.pool=e.pool AND t.tier=e.tier
    WHERE (:pool IS NULL OR e.pool=:pool) AND (:staff OR t.weight>0)
), unassigned AS (
    SELECT o.card,o.quantity FROM owned o WHERE NOT EXISTS (SELECT 1 FROM visible v WHERE v.card=o.card)
)'''
ALBUM_PAGE_SIZE = 12
INDIVIDUAL_REVIEW = '''(NOT EXISTS (
    SELECT 1 FROM entries e JOIN pools p ON p.id=e.pool
    WHERE e.card=cards.id AND p.archived=0
) OR EXISTS (
    SELECT 1 FROM entries e JOIN pools p ON p.id=e.pool
    WHERE e.card=cards.id AND p.archived=0 AND p.status='approved'
))'''
CARDS_PER_PACK = 10
DRAW_COST = 10
CHECKIN_REWARD = 10
FORMATS = {'PNG':'png','JPEG':'jpg','WEBP':'webp'}
APPID = 'wxf274f7c9d2c051f2'


def uid():
    return secrets.token_hex(10)


def text(value, limit=80):
    if not isinstance(value,str) or not 0 < len(value.strip()) <= limit:
        abort(400,'名称或参数为空，或超出长度限制')
    return value.strip()


def thumbnail_card(card):
    for key in ('subject','frame','background','back'):
        if card.get(key):
            card[key]='/thumb'+card[key]
    return card


def create_app(directory, dev=False, *, preview_key=None):
    directory = Path(directory).resolve()
    media = directory / 'uploads'
    media.mkdir(parents=True,exist_ok=True)
    path = directory / 'cards.db'
    initialize(path)
    app = Flask(__name__,static_folder=str(ROOT/'h5'),static_url_path='/h5')
    from webfiles import interactive_card, register_web
    register_web(app, media)
    app.config['MAX_CONTENT_LENGTH'] = 12*1024*1024

    @app.before_request
    def session():
        if dev and (request.remote_addr not in ('127.0.0.1','::1') or request.host.split(':')[0] not in ('localhost','127.0.0.1')):
            abort(403,'开发模式仅限本机')
        if request.endpoint in ('static','web_home','web_asset','web_engine','web_thumbnail','image') or request.endpoint is None:
            return
        g.db = connect(path)
        if request.endpoint in ('health','login','web_login'):
            return
        token = request.headers.get('Authorization','').removeprefix('Bearer ')
        g.user = g.db.execute('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.digest=? AND s.expires>?',
                              (hashlib.sha256(token.encode()).hexdigest(),int(time.time()))).fetchone()
        if not g.user:
            abort(401,'登录已过期')
        if request.method not in ('GET','HEAD') and request.endpoint not in ('preview_card_file','upload'):
            g.db.execute('BEGIN IMMEDIATE')
            # Re-read privileges under the write lock.
            g.user = g.db.execute('SELECT * FROM users WHERE id=?',(g.user['id'],)).fetchone()
        if g.user['banned']:
            abort(403,'该账号已被封禁')
        if not g.user['username_key'] and request.endpoint!='set_username':
            abort(428,'请先设置用户名')

    @app.teardown_request
    def close(_):
        if 'db' in g:
            g.db.close()

    @app.after_request
    def compress_json(response):
        if response.mimetype=='application/json' and response.content_length and response.content_length>=2048:
            response.vary.add('Accept-Encoding')
            if request.accept_encodings['gzip']:
                response.set_data(gzip.compress(response.get_data(), compresslevel=3))
                response.headers['Content-Encoding']='gzip'
        return response

    @app.errorhandler(HTTPException)
    def problem(e):
        return jsonify(error=str(e.description)),e.code

    @app.errorhandler(sqlite3.IntegrityError)
    def conflict(e):
        return jsonify(error='记录已存在或关联对象已变更'),409

    def access(*roles):
        if g.user['role'] not in roles:
            abort(403,'当前账号没有这项权限')

    def can_download_cards():
        return g.user['role']=='owner' or g.db.execute(
            'SELECT 1 FROM card_file_access WHERE user_id=?',(g.user['id'],)).fetchone() is not None

    def require_card_download():
        if not can_download_cards():
            abort(403,'当前账号没有下载互动卡权限')

    def identity():
        return {**{key:g.user[key] for key in ('id','name','role')},
                'canDownloadCards':can_download_cards()}

    def checkin_day():
        return datetime.now(timezone(timedelta(hours=8))).date().isoformat()

    def body():
        data = request.get_json()
        if not isinstance(data,dict):
            abort(400,'请求须为对象')
        return data

    def pool_exists(pool):
        row=g.db.execute("SELECT * FROM pools WHERE id=? AND archived=0 AND listed=1 AND status='approved'",(pool,)).fetchone()
        if row is None:
            abort(404,'卡池不存在')
        return row

    def managed_pool(pool, *, editing=False):
        row=g.db.execute('SELECT * FROM pools WHERE id=? AND archived=0',(pool,)).fetchone()
        owner=g.user['role']=='owner'
        if not row or not (owner or row['author']==g.user['id']):
            abort(404,'卡池不存在或没有管理权限')
        if editing and (row['status']=='pending' or not owner and row['status']=='approved'):
            abort(409,'请先撤回卡池再修改')
        return row

    def pack_for(pool):
        if pool['pack_src']:
            return dict(id=pool['id'],src=pool['pack_src'],color='#f1e9e2',skin='peach',custom=True)
        return POOL_PACKS.get(pool['id'])

    def actual_types(pool=None):
        where,params = (' WHERE e.pool=?',(pool,)) if pool is not None else ('',())
        result={}
        for pid,tier,weight,size,total in g.db.execute(
            'SELECT e.pool,tier,weight,size,SUM(weight) OVER (PARTITION BY e.pool) FROM draw_types e'+where,params):
            result.setdefault(pid,{})[tier]=(weight*10000/total,size)
        return result

    def type_summary(pool):
        rates=actual_types(pool).get(pool,{})
        return dict(actualRates={tier:rate for tier,(rate,_) in rates.items()},
                    actualRareRate=rates.get('rare',(0,0))[0] if rates else None)

    def pool_types(pool):
        return [dict(id=r['tier'],name=r['name'],rate=r['rate']) for r in g.db.execute(
            'SELECT tier,name,rate FROM pool_types WHERE pool=?',(pool,))]

    def draw_groups(pool, private=False):
        if private:
            source="""SELECT e.card,t.tier,t.name,t.rate FROM entries e JOIN cards c ON c.id=e.card
                JOIN pool_types t ON t.pool=e.pool AND t.tier=COALESCE(NULLIF(e.tier,''),CASE WHEN c.special THEN 'rare' ELSE 'normal' END)
                LEFT JOIN hidden_pool_cards h ON h.pool=e.pool AND h.card=e.card
                WHERE e.pool=? AND h.card IS NULL AND (c.status='approved' OR c.author=?)"""
            params=(pool,g.user['id'])
        else:
            source="""SELECT e.card,t.tier,t.name,t.rate FROM draw_candidates e
                JOIN draw_types t ON t.pool=e.pool AND t.tier=e.tier WHERE e.pool=?"""
            params=(pool,)
        groups={}
        for card,tier,name,rate in g.db.execute(source+" ORDER BY t.tier!='rare',t.tier",params):
            groups.setdefault(tier,(name,rate,[]))[2].append(card)
        if not groups:
            abort(409,'这个卡池暂时没有可抽的卡')
        weighted=[(name,rate,cards) for name,rate,cards in groups.values() if rate]
        return weighted or [(name,1,cards) for name,_,cards in groups.values()]

    def private_pool(pool):
        row=managed_pool(pool)
        if row['author']!=g.user['id']:
            abort(404,'这是创作者自己的测试卡池')
        return row

    def pool_preview(row,count):
        return dict(id=row['id'],name=row['name'],count=count,pack=pack_for(row),cardsPerPack=row['cards_per_pack'])

    @app.get('/health')
    def health():
        g.db.execute('SELECT count(*) FROM pools').fetchone()
        return jsonify(status='ok',database='sqlite')

    @app.post('/api/login')
    def login():
        data = body()
        if preview_key is not None:
            supplied = data.get('previewKey')
            if not isinstance(supplied,str) or not secrets.compare_digest(supplied.encode(),preview_key.encode()):
                abort(403,'请扫描本次预览码')
            openid, name, role = 'preview:owner', '体验店主', 'owner'
        elif dev:
            who = data.get('dev','owner')
            if who not in ('owner','guest'):
                abort(400,'未知本机身份')
            openid, name, role = 'local:'+who, ('本机店主' if who=='owner' else '本机访客'), ('owner' if who=='owner' else 'user')
        else:
            code = text(data.get('code'),256)
            secret = os.environ.get('WX_APP_SECRET')
            if not secret:
                abort(503,'服务端未配置微信登录')
            query = urlencode(dict(appid=os.getenv('WX_APP_ID',APPID),secret=secret,js_code=code,grant_type='authorization_code'))
            try:
                with urlopen('https://api.weixin.qq.com/sns/jscode2session?'+query,timeout=8) as response:
                    auth = json.load(response)
            except (URLError,TimeoutError,ValueError):
                abort(502,'微信登录服务暂时不可用')
            if not auth.get('openid'):
                abort(401,'微信登录凭证无效，请重新登录')
            openid, name, role = auth['openid'], '', 'user'
        return issue_session(openid,name,role)

    @app.post('/api/web/login')
    def web_login():
        # Cross-origin forms cannot submit this JSON login request.
        data = body()
        browser_key = request.cookies.get('candy_browser','')
        if dev and data.get('dev') in ('owner','guest'):
            openid = 'local:'+data['dev']
            name = '本机店主' if data['dev']=='owner' else '本机访客'
            role = 'owner' if data['dev']=='owner' else 'user'
        else:
            openid = 'web:'+hashlib.sha256(browser_key.encode()).hexdigest()
            name, role = '', 'user'
            if not browser_key or not g.db.execute('SELECT 1 FROM users WHERE openid=?',(openid,)).fetchone():
                browser_key = secrets.token_urlsafe(32)
                openid = 'web:'+hashlib.sha256(browser_key.encode()).hexdigest()
        response = issue_session(openid,name,role)
        response.set_cookie('candy_browser', browser_key, max_age=365*86400, httponly=True,
                            path='/api/web/login', samesite='Strict',
                            secure=request.is_secure or request.headers.get('X-Forwarded-Proto')=='https')
        response.headers['Cache-Control']='no-store'
        return response

    def issue_session(openid,name,role):
        user_id = uid()
        with g.db:
            g.db.execute('INSERT INTO users(id,openid,name,role) VALUES(?,?,?,?) ON CONFLICT(openid) DO NOTHING',
                         (user_id,openid,name or '收藏者 '+user_id[-6:],role))
            user = g.db.execute('SELECT id,banned FROM users WHERE openid=?',(openid,)).fetchone()
            if user['banned']:
                abort(403,'该账号已被封禁')
            token = secrets.token_urlsafe(32)
            now = int(time.time())
            g.db.execute('DELETE FROM sessions WHERE expires<=?',(now,))
            g.db.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),user['id'],now+7*86400))
        return jsonify(token=token,dev=dev)

    @app.post('/api/profile/username')
    def set_username():
        if not g.user['username_key']:
            name=unicodedata.normalize('NFKC',text(body().get('name'),24)).strip()
            if not name or len(name)>24 or any(unicodedata.category(c).startswith('C') for c in name):
                abort(400,'用户名需为 1 至 24 个字符')
            key=name.casefold()
            if g.db.execute('SELECT 1 FROM users WHERE username_key=?',(key,)).fetchone():
                abort(409,'用户名已被使用')
            g.db.execute('UPDATE users SET name=?,username_key=? WHERE id=?',(name,key,g.user['id']))
            g.db.commit()
        return jsonify(ok=True)

    @app.get('/api/state')
    @app.get('/api/studio', defaults={'studio':True})
    def state(studio=False):
        g.db.execute('BEGIN')
        who = identity()
        admin = who['role'] != 'user'
        owner=who['role']=='owner'
        if studio:
            pool_filter='(? OR author=?)'
            pool_parameters=(owner,who['id'])
        else:
            pool_filter="listed=1 AND status='approved'"
            pool_parameters=()
        pool_columns='id,name,rareRate,status,author,pack_src,review_key,listed,cards_per_pack'
        if studio:pool_columns+=',review_reason'
        pools={p['id']:{**dict(p),'entries':[]} for p in g.db.execute(
            f'SELECT {pool_columns} FROM pools WHERE archived=0 AND '+pool_filter+' ORDER BY rowid',
            pool_parameters)}
        actual=actual_types()
        types={}
        for row in g.db.execute('SELECT * FROM pool_types'):
            types.setdefault(row['pool'],[]).append(dict(id=row['tier'],name=row['name'],rate=row['rate']))
        for pid,p in pools.items():
            pack=pack_for(p)
            if pack:p['pack']=pack
            rates=actual.get(pid,{})
            p.update(types=types[pid],cardsPerPack=p.pop('cards_per_pack'),
                     actualRates={tier:rate for tier,(rate,_) in rates.items()},
                     actualRareRate=rates.get('rare',(0,0))[0] if rates else None)
        source='''SELECT e.pool,e.card,COALESCE(NULLIF(e.tier,''),CASE WHEN c.special THEN 'rare' ELSE 'normal' END) AS tier,
            h.card IS NULL AS listed FROM entries e
            JOIN cards c ON c.id=e.card LEFT JOIN hidden_pool_cards h ON h.pool=e.pool AND h.card=e.card ORDER BY e.rowid
        ''' if studio else 'SELECT pool,card,tier,1 AS listed FROM draw_candidates ORDER BY position'
        counts=dict(g.db.execute(OWNED_COUNTS,{'user_id':who['id']}).fetchall())
        visible=set(counts)
        for pid,card,tier,listed in g.db.execute(source):
            rate,size=actual.get(pid,{}).get(tier,(0,1))
            if pid in pools and (studio or admin or rate):
                pools[pid]['entries'].append(dict(id=card,tier=tier,chance=rate/size if listed else 0,listed=bool(listed)))
                visible.add(card)
        if studio and owner:
            card_filter=''
            card_parameters=()
        elif studio:
            card_filter=''' WHERE c.author=? OR EXISTS (
                SELECT 1 FROM entries e JOIN pools p ON p.id=e.pool
                WHERE e.card=c.id AND p.author=? AND p.archived=0)'''
            card_parameters=(who['id'],who['id'])
        else:
            card_filter=" WHERE c.status='approved'"
            card_parameters=()
        cards=[{**dict(c),'special':bool(c['special'])} for c in g.db.execute(PRINTED_CARDS+card_filter,card_parameters)
               if studio or admin or c['id'] in visible]
        for card in cards:
            if not (studio and (owner or card['author']==who['id'])):
                card.pop('review_reason')
        resources={'frames':[],'backgrounds':[],'backs':[],'packs':[]}
        if studio or admin:
            for r in g.db.execute('''SELECT r.*, (? OR u.owner IS ?) AS editable FROM resources r
                LEFT JOIN uploads u ON u.src=r.src LEFT JOIN users a ON a.id=u.owner
                WHERE ? OR u.owner IS NULL OR u.owner=? OR a.role='owner' ORDER BY r.rowid''',
                (owner,who['id'],owner,who['id'])):
                resources[r['kind']].append({**dict(r),'editable':bool(r['editable'])})
        profiles = []
        if who['role']=='owner':
            for profile in g.db.execute('''SELECT u.id,u.name,u.role,u.banned,
                u.role='owner' OR a.user_id IS NOT NULL AS canDownloadCards
                FROM users u LEFT JOIN card_file_access a ON a.user_id=u.id ORDER BY u.rowid'''):
                profiles.append({**dict(profile),'banned':bool(profile['banned']),'canDownloadCards':bool(profile['canDownloadCards'])})
        submission_pools=[]
        reviewable_cards=[]
        if studio:
            for row in g.db.execute("""SELECT id,name,status FROM pools WHERE archived=0 AND status!='pending'
                AND (? OR author=? OR (listed=1 AND status='approved')) ORDER BY rowid""",(owner,who['id'])):
                submission_pools.append(dict(**row,types=types[row['id']]))
            if owner:
                reviewable_cards=[r['id'] for r in g.db.execute(
                    "SELECT id FROM cards WHERE status='pending' AND "+INDIVIDUAL_REVIEW)]
        return jsonify(who=who,profiles=profiles,cards=cards,pools=list(pools.values()),counts=counts,
                       submissionPools=submission_pools,reviewableCards=reviewable_cards,cardsPerPack=CARDS_PER_PACK,**resources)

    @app.get('/api/home')
    def home():
        pools=[]
        for row in g.db.execute('''SELECT p.*,SUM(t.size) AS total FROM pools p JOIN draw_types t ON t.pool=p.id AND t.weight>0
            GROUP BY p.id ORDER BY p.id!='kanto',p.rowid'''):
            pools.append(pool_preview(row,row['total']))
        own=[dict(r) for r in g.db.execute(
            'SELECT id,name FROM pools WHERE author=? AND archived=0 ORDER BY rowid',(g.user['id'],))]
        return jsonify(who=identity(),pools=pools,privatePools=own,cardsPerPack=CARDS_PER_PACK,
                       stardust=g.user['stardust'],checkedIn=g.user['checkin_day']==checkin_day(),
                       drawCost=DRAW_COST,checkinReward=CHECKIN_REWARD)

    @app.post('/api/checkin')
    def checkin():
        today=checkin_day()
        g.db.execute('UPDATE users SET stardust=stardust+?,checkin_day=? WHERE id=? AND checkin_day!=?',
                     (CHECKIN_REWARD,today,g.user['id'],today))
        stardust=g.db.execute('SELECT stardust FROM users WHERE id=?',(g.user['id'],)).fetchone()[0]
        g.db.commit()
        return jsonify(stardust=stardust,checkedIn=True)

    @app.get('/api/pools/<pool>/preview')
    def test_pool(pool):
        row=private_pool(pool)
        return jsonify(pool=pool_preview(row,sum(len(cards) for _,_,cards in draw_groups(pool,True))))

    def album_parameters(pool=None):
        return dict(user_id=g.user['id'],staff=g.user['role']!='user',pool=pool)

    @app.get('/api/album')
    def album():
        g.db.execute('BEGIN')
        params=album_parameters()
        groups=[dict(row) for row in g.db.execute(ALBUM_ENTRIES+'''
            SELECT id,name,total,found FROM (
                SELECT p.id,p.name,COUNT(v.card) AS total,COUNT(o.card) AS found,
                    p.id!='kanto' AS sort_group,p.rowid AS sort_order
                FROM pools p LEFT JOIN visible v ON v.pool=p.id LEFT JOIN owned o ON o.card=v.card
                WHERE p.archived=0 AND p.listed=1 AND p.status='approved' GROUP BY p.id
                UNION ALL SELECT 'unassigned','未入池收藏',COUNT(*),COUNT(*),2,0
                FROM unassigned HAVING COUNT(*)>0
            ) ORDER BY sort_group,sort_order''',params)]
        counts=g.db.execute(f'SELECT COUNT(*),COALESCE(SUM(quantity),0) FROM ({OWNED_COUNTS})',params).fetchone()
        return jsonify(who=identity(),groups=groups,distinct=counts[0],total=counts[1])

    @app.get('/api/album/<pool>/cards')
    def album_cards(pool):
        try:
            offset=int(request.args.get('offset','0'))
        except ValueError:
            abort(400,'卡片加载位置无效')
        if not 0<=offset<=1_000_000:
            abort(400,'卡片加载位置无效')
        if pool=='unassigned':
            params=album_parameters()
            members="SELECT u.card,c.rowid AS position,'' AS tier_name FROM unassigned u JOIN cards c ON c.id=u.card"
        else:
            pool_exists(pool)
            params=album_parameters(pool)
            members='SELECT card,position,tier_name FROM visible'
        params.update(offset=offset,limit=ALBUM_PAGE_SIZE+1)
        rows=g.db.execute(ALBUM_ENTRIES+f''', members AS ({members})
            SELECT c.id,c.name,c.ratio,c.color,c.special,c.subject,c.frame,c.background,
                k.number AS dex,k.english,COALESCE(o.quantity,0) AS count,m.tier_name AS tierName
            FROM members m JOIN cards c ON c.id=m.card LEFT JOIN owned o ON o.card=m.card
            LEFT JOIN card_print k ON k.card=m.card
            ORDER BY o.card IS NULL,c.special,m.position LIMIT :limit OFFSET :offset''',params).fetchall()
        cards=[thumbnail_card(dict(row)) for row in rows[:ALBUM_PAGE_SIZE]]
        next_offset=offset+ALBUM_PAGE_SIZE if len(rows)>ALBUM_PAGE_SIZE else None
        return jsonify(cards=cards,nextOffset=next_offset)

    @app.get('/api/cards/<card_id>')
    def card_detail(card_id):
        card=g.db.execute(PRINTED_CARDS+''' WHERE c.id=? AND EXISTS (
            SELECT 1 FROM draws d JOIN draw_cards dc ON dc.draw_id=d.id
            WHERE d.user_id=? AND dc.card=c.id)''',(card_id,g.user['id'])).fetchone()
        if card is None:
            abort(404,'卡册里还没有这张卡')
        return jsonify(who=identity(),card=dict(card))

    @app.get('/api/cards/<card_id>/file')
    def card_file(card_id):
        require_card_download()
        card = g.db.execute(PRINTED_CARDS + ''' WHERE c.id=? AND (? OR c.author=? OR (c.status='approved' AND ?)
            OR EXISTS (
            SELECT 1 FROM draw_cards dc JOIN draws d ON d.id=dc.draw_id
            WHERE dc.card=c.id AND d.user_id=?))''',
            (card_id, g.user['role']=='owner', g.user['id'], g.user['role']=='maker', g.user['id'])).fetchone()
        if card is None:
            abort(404, '卡片不存在或尚未获得')
        return interactive_card(card, media)

    @app.post('/api/draws')
    def draw():
        d=body()
        pool=text(d.get('pool'));key=text(d.get('requestId'))
        private=d.get('preview') is True
        skin='kanto' if pool=='kanto' else text(d.get('skin'))
        if pool!='kanto' and skin==pool:
            skin=GEN_PACKS.get(pool,{}).get('skin','peach')
        if pool!='kanto' and skin not in SKINS:
            abort(400,'无效包面')
        old=None if private else g.db.execute('SELECT id,pool,skin FROM draws WHERE user_id=? AND request_id=?',(g.user['id'],key)).fetchone()
        if not old and d.get('resumeOnly') is True:
            return jsonify(error='这次拆包未扣费，可重新拆包',code='draw_not_found',
                           stardust=g.user['stardust'],checkedIn=g.user['checkin_day']==checkin_day()),404
        if old:
            if pool!=old['pool'] or (pool!='kanto' and skin!=old['skin']):
                abort(409,'该拆包请求已被使用')
            result=[dict(c) for c in g.db.execute('''SELECT c.*, k.number AS dex, k.english, dc.tier_name AS tierName
                FROM draw_cards dc JOIN cards c ON c.id=dc.card LEFT JOIN card_print k ON k.card=c.id
                WHERE dc.draw_id=? ORDER BY dc.slot''',(old['id'],))]
        else:
            row=private_pool(pool) if private else pool_exists(pool)
            groups=draw_groups(pool,private)
            weight=sum(rate for _,rate,_ in groups)
            if not private:
                spent=g.db.execute('UPDATE users SET stardust=stardust-? WHERE id=? AND stardust>=?',
                                   (DRAW_COST,g.user['id'],DRAW_COST))
                if not spent.rowcount:
                    return jsonify(error=f'星尘不足，每发需要 {DRAW_COST} 星尘',code='insufficient_stardust',
                                   stardust=g.user['stardust'],checkedIn=g.user['checkin_day']==checkin_day()),409
                draw_id=g.db.execute('INSERT INTO draws(user_id,request_id,pool,skin) VALUES(?,?,?,?)',(g.user['id'],key,pool,skin)).lastrowid
            picks=[]
            for slot in range(row['cards_per_pack']):
                roll=secrets.randbelow(10000)*weight
                for name,rate,cards in groups:
                    if roll<rate*10000:
                        card=secrets.choice(cards)
                        break
                    roll-=rate*10000
                picks.append((card,name))
            if not private:
                g.db.executemany('INSERT INTO draw_cards(draw_id,slot,card,tier_name) VALUES(?,?,?,?)',
                                 [(draw_id,slot,card,name) for slot,(card,name) in enumerate(picks)])
            selected=list(dict.fromkeys(card for card,_ in picks))
            placeholders=','.join('?' for _ in selected)
            cards={c['id']:dict(c) for c in g.db.execute(PRINTED_CARDS+f' WHERE c.id IN ({placeholders})',selected)}
            result=[dict(cards[card],tierName=name) for card,name in picks]
        stardust=g.db.execute('SELECT stardust FROM users WHERE id=?',(g.user['id'],)).fetchone()[0]
        g.db.commit()
        if d.get('thumbnails') is True:
            result=[thumbnail_card(card) for card in result]
        return jsonify(cards=result,stardust=stardust)

    @app.post('/api/pools')
    def new_pool():
        data=body()
        pool=uid()
        status='approved' if g.user['role']=='owner' and data.get('draft') is not True else 'draft'
        g.db.execute('INSERT INTO pools(id,name,author,status) VALUES(?,?,?,?)',
                     (pool,text(data.get('name')),g.user['id'],status))
        g.db.commit();return jsonify(id=pool,status=status)

    @app.post('/api/pools/<pool>/<action>')
    def edit_pool(pool,action):
        data=body()
        if action in ('listing','card-listing'):
            access('owner')
            if managed_pool(pool)['status']!='approved':
                abort(409,'请先审核通过卡池')
            listed=data.get('listed')
            if type(listed) is not bool:
                abort(400,'请选择上架或下架')
            if action=='listing':
                g.db.execute('UPDATE pools SET listed=? WHERE id=?',(listed,pool))
            else:
                card=text(data.get('card'))
                if not g.db.execute("""SELECT 1 FROM entries e JOIN cards c ON c.id=e.card
                    WHERE e.pool=? AND e.card=? AND c.status='approved'""",(pool,card)).fetchone():
                    abort(404,'这张卡未在卡池中通过审核')
                if listed:
                    g.db.execute('DELETE FROM hidden_pool_cards WHERE pool=? AND card=?',(pool,card))
                else:
                    g.db.execute('INSERT OR IGNORE INTO hidden_pool_cards VALUES(?,?)',(pool,card))
            summary=type_summary(pool)
            g.db.commit();return jsonify(ok=True,**summary)

        if action in ('submit','withdraw','review'):
            row=managed_pool(pool)
            reason=''
            if action=='submit':
                if row['status'] not in ('draft','returned'):
                    abort(409,'卡池当前无法提交审核')
                if not g.db.execute('SELECT 1 FROM entries WHERE pool=?',(pool,)).fetchone():
                    abort(400,'请先分配至少一张闪卡')
                status='pending'
            elif action=='withdraw':
                if not row['author'] or row['status'] not in ('pending','approved'):
                    abort(409,'卡池当前无法撤回')
                status='draft'
            else:
                access('owner')
                if row['status']!='pending':
                    abort(409,'卡池已处理')
                status,reason=review_result(data)
                if data.get('reviewKey')!=row['review_key']:
                    abort(409,'卡池已重新提交，请刷新后审核')
                if status=='approved':
                    g.db.execute('''UPDATE cards SET status='approved',review_key='',review_reason='' WHERE author=?
                        AND id IN (SELECT card FROM entries WHERE pool=?)''',(row['author'],pool))
            g.db.execute('UPDATE pools SET status=?,review_key=?,review_reason=? WHERE id=?',
                         (status,uid() if status=='pending' else '',reason,pool))
            g.db.commit();return jsonify(status=status)

        row=managed_pool(pool,editing=True)
        if action=='name':
            g.db.execute('UPDATE pools SET name=? WHERE id=?',(text(data.get('name')),pool))
        elif action=='member':
            card=text(data.get('card'))
            member=g.db.execute('SELECT status,author,special FROM cards WHERE id=?',(card,)).fetchone()
            if type(data.get('included')) is not bool or not member:
                abort(400,'卡片或分配状态无效')
            if data['included']:
                if g.user['role']!='owner' and member['author']!=g.user['id']:
                    abort(403,'只能分配自己制作的闪卡')
                if member['status']!='approved' and (row['status']=='approved' or not member['author'] or member['author']!=row['author']):
                    abort(403,'此卡片不能加入该卡池')
                tier=data.get('tier')
                types=pool_types(pool)
                if tier is None:
                    tier='rare' if member['special'] else 'normal'
                    tier=next((t['id'] for t in types if t['id']==tier),types[0]['id'])
                    g.db.execute('INSERT OR IGNORE INTO entries(pool,card,tier) VALUES(?,?,?)',(pool,card,tier))
                else:
                    if tier not in [t['id'] for t in types]:
                        abort(400,'请选择此卡池的闪卡类型')
                    g.db.execute('''INSERT INTO entries(pool,card,tier) VALUES(?,?,?)
                        ON CONFLICT(pool,card) DO UPDATE SET tier=excluded.tier''',(pool,card,tier))
            else:
                g.db.execute('DELETE FROM entries WHERE pool=? AND card=?',(pool,card))
            summary=type_summary(pool)
            g.db.commit();return jsonify(ok=True,**summary)
        elif action=='config':
            types=data.get('types');size=data.get('cardsPerPack')
            if type(size) is not int or not 1<=size<=30:
                abort(400,'每发可抽 1 至 30 张')
            if not isinstance(types,list) or not 1<=len(types)<=12:
                abort(400,'请设置 1 至 12 个闪卡类型')
            normalized=[]
            for item in types:
                if not isinstance(item,dict):
                    abort(400,'类型配置无效')
                key=item.get('id');rate=item.get('rate')
                if not isinstance(key,str) or not re.fullmatch(r'[a-z0-9-]{1,40}',key) or type(rate) is not int or not 0<=rate<=10000:
                    abort(400,'类型或概率无效')
                normalized.append(dict(id=key,name=text(item.get('name'),18),rate=rate))
            ids={t['id'] for t in normalized}
            if len(ids)!=len(types) or len({t['name'].casefold() for t in normalized})!=len(types) or sum(t['rate'] for t in normalized)!=10000:
                abort(400,'闪卡类型名称须唯一，概率合计须为 100%')
            assigned={r[0] for r in g.db.execute("""SELECT DISTINCT
                COALESCE(NULLIF(e.tier,''),CASE WHEN c.special THEN 'rare' ELSE 'normal' END)
                FROM entries e JOIN cards c ON c.id=e.card WHERE e.pool=?""",(pool,))}
            if assigned-ids:
                abort(409,'请先为该类型的卡片改选类型，再删除类型')
            g.db.execute('UPDATE pools SET types=?,cards_per_pack=? WHERE id=?',
                         (json.dumps(normalized,ensure_ascii=False),size,pool))
        elif action=='rates':
            if row['types']!='[]':
                abort(409,'请在闪卡类型配置中修改概率')
            normal,rare=data.get('normalRate'),data.get('rareRate')
            if any(type(n) is not int or not 0<=n<=10000 for n in (normal,rare)) or normal+rare!=10000:
                abort(400,'普通与稀有概率合计须为 100%，最多两位小数')
            g.db.execute('UPDATE pools SET rareRate=? WHERE id=?',(rare,pool))
        elif action=='pack':
            src=owned_upload(data['upload']) if 'upload' in data else visible_resource(data.get('src',''),'packs')
            g.db.execute('UPDATE pools SET pack_src=? WHERE id=?',(src,pool))
            old_file=unused_file(row['pack_src'])
            g.db.commit()
            remove_upload_file(old_file)
            return jsonify(ok=True)
        else:
            abort(404)
        g.db.commit();return jsonify(ok=True)

    @app.delete('/api/pools/<pool>')
    def remove_pool(pool):
        managed_pool(pool,editing=True)
        g.db.execute('UPDATE pools SET archived=1 WHERE id=?',(pool,))
        g.db.commit();return jsonify(ok=True)

    def owned_upload(src):
        if not isinstance(src,str) or not g.db.execute('SELECT 1 FROM uploads WHERE src=? AND owner=?',(src,g.user['id'])).fetchone():
            abort(400,'请先上传本次使用的图片')
        return src

    def image_format(file):
        if not file:
            abort(400,'缺少图片')
        try:
            img=Image.open(file.stream)
            fmt=img.format
            if fmt not in FORMATS or img.width*img.height>24000000:
                abort(400,'请选择不超过 2400 万像素的 PNG、JPEG 或 WebP 图片')
            img.verify()
            file.stream.seek(0);Image.open(file.stream).load()
        except (UnidentifiedImageError,OSError,SyntaxError,ValueError,Image.DecompressionBombError):
            abort(400,'图片无法读取')
        file.stream.seek(0)
        return FORMATS[fmt]

    @app.post('/api/uploads')
    def upload():
        file=request.files.get('file')
        name=uid()+'.'+image_format(file);src='/media/'+name
        file.save(media/name)
        g.db.execute('INSERT INTO uploads VALUES(?,?)',(src,g.user['id']))
        g.db.commit();return jsonify(src=src)

    @app.get('/media/<name>')
    def image(name):
        return send_from_directory(media,name,max_age=31536000)

    def unused_file(src):
        if not src.startswith('/media/'):
            return None
        used=g.db.execute('''SELECT 1 FROM resources WHERE src=?
            UNION ALL SELECT 1 FROM cards WHERE ? IN(subject,frame,background,back)
            UNION ALL SELECT 1 FROM pools WHERE pack_src=? LIMIT 1''',(src,src,src)).fetchone()
        if used:
            return None
        g.db.execute('DELETE FROM uploads WHERE src=?',(src,))
        return media / Path(src).name

    def remove_upload_file(file):
        if file:
            file.unlink(missing_ok=True)
            (directory/'thumbs'/'media'/f'{file.name}.webp').unlink(missing_ok=True)

    @app.delete('/api/uploads/<name>')
    def discard(name):
        src=owned_upload('/media/'+name);file=unused_file(src)
        g.db.commit()
        remove_upload_file(file)
        return jsonify(ok=True)

    @app.post('/api/resources')
    def resource():
        d=body();kind=d.get('kind');ratio=d.get('ratio','')
        if kind not in ('frames','backgrounds','backs','packs') or (kind in ('frames','backs') and ratio not in RATIOS):
            abort(400,'素材类型或比例无效')
        rid=uid()
        g.db.execute('INSERT INTO resources VALUES(?,?,?,?,?)',(rid,kind,text(d.get('name')),owned_upload(d.get('src')),ratio if kind in ('frames','backs') else ''))
        g.db.commit();return jsonify(id=rid)

    @app.delete('/api/resources/<resource_id>')
    def remove_resource(resource_id):
        row=g.db.execute('''SELECT r.src,u.owner FROM resources r LEFT JOIN uploads u ON r.src=u.src
            WHERE r.id=? AND (? OR u.owner=?)''',(resource_id,g.user['role']=='owner',g.user['id'])).fetchone()
        if not row:abort(404,'素材不存在')
        g.db.execute('DELETE FROM resources WHERE id=?',(resource_id,))
        file=unused_file(row['src']);g.db.commit()
        remove_upload_file(file)
        return jsonify(ok=True)

    def visible_resource(src,kind,ratio=None):
        if not isinstance(src,str):
            abort(400,'素材路径无效')
        if src and not g.db.execute('''SELECT 1 FROM resources r LEFT JOIN uploads u ON r.src=u.src
            LEFT JOIN users a ON a.id=u.owner WHERE r.src=? AND r.kind=?
            AND (? IS NULL OR r.ratio=? OR r.kind='backgrounds')
            AND (? OR u.owner IS NULL OR u.owner=? OR a.role='owner')''',
            (src,kind,ratio,ratio,g.user['role']=='owner',g.user['id'])).fetchone():
            abort(400,'素材不可用或比例不匹配')
        return src

    def check_appearance(ratio,color,special,frame,bg,back):
        if ratio not in RATIOS or not isinstance(color,str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',color) or type(special) is not bool:
            abort(400,'卡片比例、颜色或类型无效')
        for src,kind in ((frame,'frames'),(bg,'backgrounds'),(back,'backs')):
            visible_resource(src,kind,ratio)

    @app.post('/api/cards/preview-file')
    def preview_card_file():
        require_card_download()
        d=request.form
        card=dict(name=text(d.get('name'),18),ratio=d.get('ratio'),color=d.get('color'),
                  special=d.get('special')=='true',frame=d.get('frame',''),background=d.get('background',''),
                  subject='',back=d.get('back',''),dex=None,english=None)
        check_appearance(card['ratio'],card['color'],card['special'],card['frame'],card['background'],card['back'])
        image=request.files.get('file')
        suffix=image_format(image)
        return interactive_card(card, media, subject=(image.read(), '.'+suffix))

    @app.post('/api/cards')
    def make_cards():
        d=body();items=d.get('items');pool=d.get('pool')
        if not isinstance(items,list) or not 1<=len(items)<=200:abort(400,'请选择 1 至 200 张图片')
        tier=d.get('tier')
        if pool:
            target=g.db.execute("""SELECT author,status,listed FROM pools WHERE id=? AND archived=0""",(text(pool),)).fetchone()
            if not target or (g.user['role']!='owner' and target['author']!=g.user['id'] and
                              (target['status']!='approved' or not target['listed'])):
                abort(404,'卡池不存在或暂不收稿')
            if target['status']=='pending':
                abort(409,'请先撤回卡池再修改')
            types=pool_types(pool)
            if tier is None:
                tier='rare' if d.get('special') else 'normal'
                tier=next((t['id'] for t in types if t['id']==tier),types[0]['id'])
            elif tier not in [t['id'] for t in types]:
                abort(400,'请选择此卡池的闪卡类型')
        ratio=d.get('ratio');color=d.get('color');special=d.get('special')
        frame=d.get('frame','');bg=d.get('background','');back=d.get('back','')
        check_appearance(ratio,color,special,frame,bg,back)
        created=[]
        status='approved' if g.user['role']=='owner' else 'pending'
        for item in items:
            if not isinstance(item,dict):abort(400,'卡片参数无效')
            cid=uid();name=text(item.get('name'),18)
            g.db.execute('''INSERT INTO cards(id,name,ratio,special,color,subject,frame,background,back,author,status,review_key)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
                (cid,name,ratio,special,color,owned_upload(item.get('subject')),frame,bg,back,g.user['id'],status,
                 uid() if status=='pending' else ''))
            created.append(dict(id=cid,name=name,status=status))
        if pool:g.db.executemany('INSERT INTO entries(pool,card,tier) VALUES(?,?,?)',[(pool,c['id'],tier) for c in created])
        g.db.commit();return jsonify(cards=created)

    def review_result(data):
        if type(data.get('approved')) is not bool:
            abort(400,'请选择审核结果')
        if data['approved']:
            return 'approved',''
        reason=data.get('reason','')
        if not isinstance(reason,str) or len(reason.strip())>200:
            abort(400,'退回原因最多 200 个字符')
        return 'returned',reason.strip()

    @app.post('/api/cards/<card_id>/review')
    def review_card(card_id):
        access('owner');data=body();status,reason=review_result(data)
        changed=g.db.execute("""UPDATE cards SET status=?,review_key='',review_reason=?
            WHERE id=? AND status='pending' AND review_key=? AND """+INDIVIDUAL_REVIEW,
                             (status,reason,card_id,text(data.get('reviewKey')))).rowcount
        if not changed:abort(409,'闪卡状态已变更，请刷新后审核')
        g.db.commit();return jsonify(status=status)

    @app.post('/api/cards/<card_id>/resubmit')
    def resubmit_card(card_id):
        name=text(body().get('name'),18)
        changed=g.db.execute('''UPDATE cards SET name=?,status='pending',review_key=?,review_reason=''
            WHERE id=? AND author=? AND status='returned' AND NOT EXISTS (
                SELECT 1 FROM entries e JOIN pools p ON p.id=e.pool
                WHERE e.card=cards.id AND p.archived=0 AND p.status='pending')''',
            (name,uid(),card_id,g.user['id'])).rowcount
        if not changed:abort(409,'闪卡当前无法再次提交')
        g.db.commit();return jsonify(status='pending')

    @app.post('/api/users/<user_id>/role')
    def grant(user_id):
        access('owner');role=body().get('role')
        if role not in ('maker','user'):abort(400,'无效角色')
        changed=g.db.execute("UPDATE users SET role=? WHERE id=? AND role!='owner'",(role,user_id)).rowcount
        if not changed:abort(400,'无法变更该用户')
        g.db.commit();return jsonify(ok=True)

    @app.post('/api/users/<user_id>/ban')
    def ban_user(user_id):
        access('owner')
        banned=body().get('banned')
        if type(banned) is not bool:
            abort(400,'请选择封禁或解封')
        if not g.db.execute("UPDATE users SET banned=? WHERE id=? AND role!='owner'",(banned,user_id)).rowcount:
            abort(404,'用户不存在或不可封禁')
        g.db.commit();return jsonify(ok=True)

    @app.post('/api/users/<user_id>/card-file-access')
    def grant_card_download(user_id):
        access('owner')
        enabled=body().get('enabled')
        if type(enabled) is not bool:
            abort(400,'权限状态无效')
        if not g.db.execute("SELECT 1 FROM users WHERE id=? AND role!='owner'",(user_id,)).fetchone():
            abort(404,'用户不存在或权限不可修改')
        if enabled:
            g.db.execute('INSERT OR IGNORE INTO card_file_access(user_id) VALUES(?)',(user_id,))
        else:
            g.db.execute('DELETE FROM card_file_access WHERE user_id=?',(user_id,))
        g.db.commit();return jsonify(ok=True)

    return app


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--dev',action='store_true',help='Loopback-only development identities')
    parser.add_argument('--data',type=Path)
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--owner',metavar='USER_ID',help='Grant ownership to an existing account and exit')
    args=parser.parse_args()
    directory=args.data or ROOT/('data-dev' if args.dev else 'data')
    app=create_app(directory,args.dev)
    if args.owner:
        db=connect(directory/'cards.db')
        with db:
            if not db.execute("UPDATE users SET role='owner' WHERE id=?",(args.owner,)).rowcount:
                parser.error('用户 ID 不存在，请先登录小程序')
        db.close()
    else:
        from waitress import serve
        serve(app,host='127.0.0.1',port=args.port,max_request_body_size=12*1024*1024)
