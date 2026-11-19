import argparse
import gzip
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
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
ALBUM_ENTRIES = f'''WITH owned AS ({OWNED_COUNTS}), tiers AS (
    SELECT e.pool, SUM(c.special=0) AS normal, SUM(c.special=1) AS rare
    FROM entries e JOIN cards c ON c.id=e.card JOIN pools p ON p.id=e.pool
    WHERE p.archived=0 AND (:pool IS NULL OR e.pool=:pool) GROUP BY e.pool
), visible AS (
    SELECT e.pool,e.card,e.rowid AS position FROM entries e
    JOIN tiers t ON t.pool=e.pool JOIN pools p ON p.id=e.pool JOIN cards c ON c.id=e.card
    WHERE :staff OR t.normal=0 OR t.rare=0
       OR (c.special=0 AND p.rareRate<10000) OR (c.special=1 AND p.rareRate>0)
), unassigned AS (
    SELECT o.card,o.quantity FROM owned o WHERE NOT EXISTS (SELECT 1 FROM visible v WHERE v.card=o.card)
)'''
ALBUM_PAGE_SIZE = 12
CARDS_PER_PACK = 10
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
        if request.method not in ('GET','HEAD') and request.endpoint != 'preview_card_file':
            g.db.execute('BEGIN IMMEDIATE')
            # Re-read privileges under the write lock.
            g.user = g.db.execute('SELECT * FROM users WHERE id=?',(g.user['id'],)).fetchone()

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

    def body():
        data = request.get_json()
        if not isinstance(data,dict):
            abort(400,'请求须为对象')
        return data

    def pool_exists(pool):
        row=g.db.execute('SELECT rareRate FROM pools WHERE id=? AND archived=0',(pool,)).fetchone()
        if row is None:
            abort(404,'卡池不存在')
        return row['rareRate']

    def effective_rare(rate,groups):
        if not groups[1]:return 0
        if not groups[0]:return 10000
        return rate

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
            g.db.execute('INSERT INTO users VALUES(?,?,?,?) ON CONFLICT(openid) DO NOTHING',
                         (user_id,openid,name or '收藏者 '+user_id[-6:],role))
            user_id = g.db.execute('SELECT id FROM users WHERE openid=?',(openid,)).fetchone()[0]
            token = secrets.token_urlsafe(32)
            now = int(time.time())
            g.db.execute('DELETE FROM sessions WHERE expires<=?',(now,))
            g.db.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),user_id,now+7*86400))
        return jsonify(token=token)

    @app.get('/api/state')
    def state():
        g.db.execute('BEGIN')
        who = identity()
        admin = who['role'] != 'user'
        pools={p['id']:{**dict(p),'entries':[]} for p in g.db.execute('SELECT id,name,rareRate FROM pools WHERE archived=0 ORDER BY rowid')}
        for pid,p in pools.items():
            if pid in POOL_PACKS:p['pack']=POOL_PACKS[pid]
        groups={pid:([],[]) for pid in pools}
        for row in g.db.execute('SELECT e.pool,e.card,c.special FROM entries e JOIN cards c ON c.id=e.card JOIN pools p ON p.id=e.pool WHERE p.archived=0 ORDER BY e.rowid'):
            groups[row['pool']][row['special']].append(row['card'])
        counts=dict(g.db.execute(OWNED_COUNTS,{'user_id':who['id']}).fetchall())
        visible=set(counts)
        for pid,p in pools.items():
            rare=effective_rare(p['rareRate'],groups[pid])
            for members,weight in zip(groups[pid],(10000-rare,rare)):
                if not members or (not admin and not weight):continue
                p['entries'].extend(dict(id=cid,chance=weight/len(members)) for cid in members)
                visible.update(members)
        cards=[{**dict(c),'special':bool(c['special'])} for c in g.db.execute(PRINTED_CARDS) if admin or c['id'] in visible]
        resources={'frames':[],'backgrounds':[],'backs':[]}
        if admin:
            for r in g.db.execute('SELECT * FROM resources'):
                resources[r['kind']].append(dict(r))
        profiles = []
        if who['role']=='owner':
            for profile in g.db.execute('''SELECT u.id,u.name,u.role,
                u.role='owner' OR a.user_id IS NOT NULL AS canDownloadCards
                FROM users u LEFT JOIN card_file_access a ON a.user_id=u.id ORDER BY u.rowid'''):
                profiles.append({**dict(profile),'canDownloadCards':bool(profile['canDownloadCards'])})
        return jsonify(who=who,profiles=profiles,cards=cards,pools=list(pools.values()),counts=counts,
                       cardsPerPack=CARDS_PER_PACK,**resources)

    @app.get('/api/home')
    def home():
        pools=[]
        for row in g.db.execute('''SELECT p.id,p.name,p.rareRate,COUNT(e.card) AS total,
            COALESCE(SUM(c.special),0) AS rare FROM pools p LEFT JOIN entries e ON e.pool=p.id
            LEFT JOIN cards c ON c.id=e.card WHERE p.archived=0
            GROUP BY p.id ORDER BY p.id!='kanto',p.rowid'''):
            normal=row['total']-row['rare']
            rare=effective_rare(row['rareRate'],(normal,row['rare']))
            count=(normal if rare<10000 else 0)+(row['rare'] if rare else 0)
            pools.append(dict(id=row['id'],name=row['name'],count=count,pack=POOL_PACKS.get(row['id'])))
        return jsonify(who=identity(),pools=pools,cardsPerPack=CARDS_PER_PACK)

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
                WHERE p.archived=0 GROUP BY p.id
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
            members='SELECT u.card,c.rowid AS position FROM unassigned u JOIN cards c ON c.id=u.card'
        else:
            pool_exists(pool)
            params=album_parameters(pool)
            members='SELECT card,position FROM visible'
        params.update(offset=offset,limit=ALBUM_PAGE_SIZE+1)
        rows=g.db.execute(ALBUM_ENTRIES+f''', members AS ({members})
            SELECT c.id,c.name,c.ratio,c.color,c.special,c.subject,c.frame,c.background,
                k.number AS dex,k.english,COALESCE(o.quantity,0) AS count
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
        card = g.db.execute(PRINTED_CARDS + ''' WHERE c.id=? AND (? OR EXISTS (
            SELECT 1 FROM draw_cards dc JOIN draws d ON d.id=dc.draw_id
            WHERE dc.card=c.id AND d.user_id=?))''',
            (card_id, g.user['role']!='user', g.user['id'])).fetchone()
        if card is None:
            abort(404, '卡片不存在或尚未获得')
        return interactive_card(card, media)

    @app.post('/api/draws')
    def draw():
        d=body()
        pool=text(d.get('pool'));key=text(d.get('requestId'))
        skin='kanto' if pool=='kanto' else text(d.get('skin'))
        if pool in GEN_PACKS and skin==pool:
            skin=GEN_PACKS[pool]['skin']
        if pool!='kanto' and skin not in SKINS:
            abort(400,'无效包面')
        old=g.db.execute('SELECT id,pool,skin FROM draws WHERE user_id=? AND request_id=?',(g.user['id'],key)).fetchone()
        if old:
            if pool!=old['pool'] or (pool!='kanto' and skin!=old['skin']):
                abort(409,'该拆包请求已被使用')
            draw_id=old['id']
        else:
            rate=pool_exists(pool)
            groups=([],[])
            for card,tier in g.db.execute('SELECT e.card,c.special FROM entries e JOIN cards c ON c.id=e.card WHERE e.pool=?',(pool,)):
                groups[tier].append(card)
            if not any(groups):
                abort(409,'这个卡池暂时没有可抽的卡')
            rare=effective_rare(rate,groups)
            draw_id=g.db.execute('INSERT INTO draws(user_id,request_id,pool,skin) VALUES(?,?,?,?)',(g.user['id'],key,pool,skin)).lastrowid
            for slot in range(CARDS_PER_PACK):
                tier=int(secrets.randbelow(10000)<rare)
                card=secrets.choice(groups[tier])
                g.db.execute('INSERT INTO draw_cards VALUES(?,?,?)',(draw_id,slot,card))
        result=[dict(c) for c in g.db.execute(PRINTED_CARDS+' JOIN draw_cards dc ON dc.card=c.id WHERE draw_id=? ORDER BY slot',(draw_id,))]
        g.db.commit()
        if d.get('thumbnails') is True:
            result=[thumbnail_card(card) for card in result]
        return jsonify(cards=result)

    @app.post('/api/pools')
    def new_pool():
        access('owner');pool=uid()
        g.db.execute('INSERT INTO pools(id,name) VALUES(?,?)',(pool,text(body().get('name'))))
        g.db.commit();return jsonify(id=pool)

    @app.post('/api/pools/<pool>/<action>')
    def edit_pool(pool,action):
        access('owner');pool_exists(pool);data=body()
        if action=='name':
            g.db.execute('UPDATE pools SET name=? WHERE id=?',(text(data.get('name')),pool))
        elif action=='member':
            card=text(data.get('card'))
            if type(data.get('included')) is not bool or not g.db.execute('SELECT 1 FROM cards WHERE id=?',(card,)).fetchone():
                abort(400,'卡片或分配状态无效')
            if data['included']:
                g.db.execute('INSERT OR IGNORE INTO entries(pool,card) VALUES(?,?)',(pool,card))
            else:
                g.db.execute('DELETE FROM entries WHERE pool=? AND card=?',(pool,card))
        elif action=='rates':
            normal,rare=data.get('normalRate'),data.get('rareRate')
            if any(type(n) is not int or not 0<=n<=10000 for n in (normal,rare)) or normal+rare!=10000:
                abort(400,'普通与稀有概率合计须为 100%，最多两位小数')
            g.db.execute('UPDATE pools SET rareRate=? WHERE id=?',(rare,pool))
        else:
            abort(404)
        g.db.commit();return jsonify(ok=True)

    @app.delete('/api/pools/<pool>')
    def remove_pool(pool):
        access('owner');pool_exists(pool)
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
        access('owner','maker')
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
        used=g.db.execute('SELECT 1 FROM resources WHERE src=? UNION ALL SELECT 1 FROM cards WHERE ? IN(subject,frame,background,back) LIMIT 1',(src,src)).fetchone()
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
        access('owner','maker');src=owned_upload('/media/'+name);file=unused_file(src)
        g.db.commit()
        remove_upload_file(file)
        return jsonify(ok=True)

    @app.post('/api/resources')
    def resource():
        access('owner','maker');d=body();kind=d.get('kind');ratio=d.get('ratio','')
        if kind not in ('frames','backgrounds','backs') or (kind!='backgrounds' and ratio not in RATIOS):
            abort(400,'素材类型或比例无效')
        rid=uid()
        g.db.execute('INSERT INTO resources VALUES(?,?,?,?,?)',(rid,kind,text(d.get('name')),owned_upload(d.get('src')),ratio if kind!='backgrounds' else ''))
        g.db.commit();return jsonify(id=rid)

    @app.delete('/api/resources/<resource_id>')
    def remove_resource(resource_id):
        access('owner','maker')
        row=g.db.execute('SELECT src FROM resources WHERE id=?',(resource_id,)).fetchone()
        if not row:abort(404,'素材不存在')
        g.db.execute('DELETE FROM resources WHERE id=?',(resource_id,))
        file=unused_file(row['src']);g.db.commit()
        remove_upload_file(file)
        return jsonify(ok=True)

    def check_appearance(ratio,color,special,frame,bg,back):
        if ratio not in RATIOS or not isinstance(color,str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',color) or type(special) is not bool:
            abort(400,'卡片比例、颜色或类型无效')
        for src,kind in ((frame,'frames'),(bg,'backgrounds'),(back,'backs')):
            if not isinstance(src,str):abort(400,'素材路径无效')
            if src and not g.db.execute('SELECT 1 FROM resources WHERE src=? AND kind=? AND (ratio=? OR kind=?)',(src,kind,ratio,'backgrounds')).fetchone():
                abort(400,'所选素材已移除或比例不匹配')

    @app.post('/api/cards/preview-file')
    def preview_card_file():
        require_card_download()
        access('owner','maker')
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
        access('owner','maker');d=body();items=d.get('items');pool=d.get('pool')
        if not isinstance(items,list) or not 1<=len(items)<=200:abort(400,'请选择 1 至 200 张图片')
        if pool:pool_exists(text(pool))
        ratio=d.get('ratio');color=d.get('color');special=d.get('special')
        frame=d.get('frame','');bg=d.get('background','');back=d.get('back','')
        check_appearance(ratio,color,special,frame,bg,back)
        created=[]
        for item in items:
            if not isinstance(item,dict):abort(400,'卡片参数无效')
            cid=uid();name=text(item.get('name'),18)
            g.db.execute('INSERT INTO cards VALUES(?,?,?,?,?,?,?,?,?)',(cid,name,ratio,special,color,owned_upload(item.get('subject')),frame,bg,back))
            created.append(dict(id=cid,name=name))
        if pool:g.db.executemany('INSERT INTO entries(pool,card) VALUES(?,?)',[(pool,c['id']) for c in created])
        g.db.commit();return jsonify(cards=created)

    @app.post('/api/users/<user_id>/role')
    def grant(user_id):
        access('owner');role=body().get('role')
        if role not in ('maker','user'):abort(400,'无效角色')
        changed=g.db.execute("UPDATE users SET role=? WHERE id=? AND role!='owner'",(role,user_id)).rowcount
        if not changed:abort(400,'无法变更该用户')
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
