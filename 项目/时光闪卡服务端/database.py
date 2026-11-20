import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY, openid TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('owner','maker','user')));
CREATE TABLE IF NOT EXISTS card_file_access(
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sessions(
 digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uploads(src TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users);
CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
 src TEXT NOT NULL, ratio TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, name TEXT NOT NULL, ratio TEXT NOT NULL,
 special INTEGER NOT NULL, color TEXT NOT NULL, subject TEXT NOT NULL, frame TEXT NOT NULL, background TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kanto_print(card TEXT PRIMARY KEY REFERENCES cards(id),
 number INTEGER UNIQUE NOT NULL, english TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS card_print(card TEXT PRIMARY KEY REFERENCES cards(id),
 number INTEGER NOT NULL, english TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pools(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS entries(pool TEXT NOT NULL REFERENCES pools, card TEXT NOT NULL REFERENCES cards,
 chance INTEGER NOT NULL CHECK(chance BETWEEN 0 AND 10000),PRIMARY KEY(pool,card));
CREATE TABLE IF NOT EXISTS draws(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users,
 request_id TEXT NOT NULL,pool TEXT NOT NULL REFERENCES pools,skin TEXT NOT NULL,
 drawn_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,request_id));
CREATE TABLE IF NOT EXISTS draw_cards(draw_id INTEGER NOT NULL REFERENCES draws,
 slot INTEGER NOT NULL,card TEXT NOT NULL REFERENCES cards,PRIMARY KEY(draw_id,slot));
"""


def connect(path):
    db = sqlite3.connect(path, timeout=8)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def initialize(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = connect(path)
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript(SCHEMA)
        # SQLite table replacement keeps the existing pool IDs referenced by draws.
        db.execute('PRAGMA foreign_keys=OFF')
        with db:
            db.execute('BEGIN IMMEDIATE')
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version >= 8:
                return
            if version < 1:
                if not db.execute('SELECT 1 FROM pools LIMIT 1').fetchone():
                    seed = json.loads((ROOT / 'seed.json').read_text('utf-8'))
                    for kind in ('frames', 'backgrounds'):
                        for r in seed[kind]:
                            db.execute('INSERT INTO resources VALUES(?,?,?,?,?)',
                                       (r['id'], kind, r['name'], r['src'], r.get('ratio','')))
                    db.executemany('INSERT INTO cards VALUES(:id,:name,:ratio,:special,:color,:subject,:frame,:background)', seed['cards'])
                    for pool in seed['pools']:
                        db.execute('INSERT INTO pools VALUES(?,?)', (pool['id'],pool['name']))
                        db.executemany('INSERT INTO entries VALUES(?,?,?)',
                                       [(pool['id'],e['id'],e['chance']) for e in pool['entries']])
                if not db.execute("SELECT 1 FROM pools WHERE id='kanto'").fetchone():
                    install_kanto(db)
                migrate_pool_rates(db)
            if version < 2:
                db.execute('INSERT OR IGNORE INTO card_print(card,number,english) SELECT card,number,english FROM kanto_print')
                install_generations(db)
            if version < 3:
                for cfg in GENERATIONS.values():
                    directory = cfg['dir']
                    db.execute('''UPDATE cards SET background=? WHERE background=''
                        AND id GLOB ? AND id IN (SELECT card FROM card_print)''',
                        (f'/h5/{directory}/field.webp', f'{directory}-*'))
            if version < 4:
                install_card_materials(db)
            if version < 5:
                db.execute('ALTER TABLE pools ADD COLUMN author TEXT REFERENCES users(id)')
                db.execute("ALTER TABLE pools ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('draft','pending','approved','returned'))")
                db.execute("ALTER TABLE pools ADD COLUMN pack_src TEXT NOT NULL DEFAULT ''")
                db.execute("ALTER TABLE pools ADD COLUMN review_key TEXT NOT NULL DEFAULT ''")
                db.execute('ALTER TABLE cards ADD COLUMN author TEXT REFERENCES users(id)')
                db.execute("ALTER TABLE cards ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('pending','approved','returned'))")
                db.execute("ALTER TABLE cards ADD COLUMN review_key TEXT NOT NULL DEFAULT ''")
            if version < 6:
                db.execute('ALTER TABLE users ADD COLUMN username_key TEXT')
                db.execute('CREATE UNIQUE INDEX unique_username ON users(username_key) WHERE username_key IS NOT NULL')
                db.execute('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0')
                db.execute('ALTER TABLE pools ADD COLUMN listed INTEGER NOT NULL DEFAULT 1')
                db.execute('''CREATE TABLE hidden_pool_cards(
                    pool TEXT NOT NULL REFERENCES pools, card TEXT NOT NULL REFERENCES cards,
                    PRIMARY KEY(pool,card)) WITHOUT ROWID''')
                db.execute('''CREATE VIEW drawable_entries AS
                    SELECT e.pool,e.card,e.rowid AS position,c.special FROM entries e
                    JOIN pools p ON p.id=e.pool JOIN cards c ON c.id=e.card
                    LEFT JOIN hidden_pool_cards h ON h.pool=e.pool AND h.card=e.card
                    WHERE p.archived=0 AND p.listed=1 AND p.status='approved' AND c.status='approved' AND h.card IS NULL''')
            if version < 7:
                db.execute("ALTER TABLE pools ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''")
                db.execute("ALTER TABLE cards ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''")
            db.execute('ALTER TABLE users ADD COLUMN stardust INTEGER NOT NULL DEFAULT 50')
            db.execute("ALTER TABLE users ADD COLUMN checkin_day TEXT NOT NULL DEFAULT ''")
            db.execute('ALTER TABLE pools ADD COLUMN cards_per_pack INTEGER NOT NULL DEFAULT 10')
            db.execute("ALTER TABLE pools ADD COLUMN types TEXT NOT NULL DEFAULT '[]'")
            db.execute("ALTER TABLE entries ADD COLUMN tier TEXT NOT NULL DEFAULT ''")
            db.execute("ALTER TABLE draw_cards ADD COLUMN tier_name TEXT NOT NULL DEFAULT ''")
            db.execute('''CREATE VIEW pool_types AS
                SELECT id AS pool,'normal' AS tier,'普通闪卡' AS name,10000-rareRate AS rate FROM pools WHERE types='[]'
                UNION ALL SELECT id,'rare','稀有闪卡',rareRate FROM pools WHERE types='[]'
                UNION ALL SELECT p.id,json_extract(j.value,'$.id'),json_extract(j.value,'$.name'),
                    json_extract(j.value,'$.rate') FROM pools p,json_each(p.types) j''')
            db.execute('''CREATE VIEW draw_candidates AS
                SELECT d.*,COALESCE(NULLIF(e.tier,''),CASE WHEN d.special THEN 'rare' ELSE 'normal' END) AS tier
                FROM drawable_entries d JOIN entries e ON e.pool=d.pool AND e.card=d.card''')
            db.execute('''CREATE VIEW draw_types AS
                WITH populated AS (
                    SELECT e.pool,e.tier,t.name,t.rate,COUNT(*) AS size FROM draw_candidates e
                    JOIN pool_types t ON t.pool=e.pool AND t.tier=e.tier GROUP BY e.pool,e.tier
                )
                SELECT *,CASE WHEN SUM(rate) OVER (PARTITION BY pool)>0 THEN rate ELSE 1 END AS weight FROM populated''')
            db.execute('PRAGMA user_version=8')
    finally:
        db.close()


def install_kanto(db):
    catalog = json.loads((ROOT/'h5/kanto/catalog.json').read_text('utf-8'))
    base = '/h5/kanto/'
    frame, field = base+'frame.png', base+'field.jpg'
    name = '关都卡池'
    while db.execute('SELECT 1 FROM pools WHERE name=?',(name,)).fetchone():
        name += ' · 151'
    db.execute("INSERT INTO pools VALUES('kanto',?)",(name,))
    db.executemany('INSERT INTO resources VALUES(?,?,?,?,?)', [
        ('kanto-frame','frames','关都图鉴框',frame,'5x7'),
        ('kanto-field','backgrounds','关都原野',field,'')])
    share, remainder = divmod(10000,len(catalog))
    for index, species in enumerate(catalog):
        number = species['number']
        serial = f'{number:03d}'
        card = 'kanto-'+serial
        db.execute('INSERT INTO cards VALUES(?,?,?,?,?,?,?,?)',
                   (card,species['name'],'5x7',0,'#e5dbc1',base+serial+'.webp',frame,field))
        db.execute('INSERT INTO kanto_print VALUES(?,?,?)',(card,number,species['english']))
        db.execute('INSERT OR IGNORE INTO card_print VALUES(?,?,?)',(card,number,species['english']))
        db.execute("INSERT INTO entries VALUES('kanto',?,?)",(card,share+int(index<remainder)))


# 各世代卡池配置：目录、中文名、卡框、底色
GENERATIONS = {
    2: dict(dir='gen2', name='城都卡池', color='#d8e6e0', field='城都枫林'),
    3: dict(dir='gen3', name='丰缘卡池', color='#e0d8e6', field='丰缘雨林'),
    4: dict(dir='gen4', name='神奥卡池', color='#e6e0d8', field='神奥雪岭'),
    5: dict(dir='gen5', name='合众卡池', color='#e0e6d8', field='合众暮色'),
    6: dict(dir='gen6', name='卡洛斯卡池', color='#e6d8d8', field='卡洛斯花田'),
    7: dict(dir='gen7', name='阿罗拉卡池', color='#d8e0e6', field='阿罗拉海岸'),
    8: dict(dir='gen8', name='伽勒尔卡池', color='#e6e6d8', field='伽勒尔荒原'),
    9: dict(dir='gen9', name='帕底亚卡池', color='#d8d8e6', field='帕底亚山城'),
}
# 通用卡框（竖版 5x7），按世代轮换使用，避免印"关都"字样
GEN_FRAMES = ('/assets/aurora-5x7.png', '/assets/orrery-5x7.png', '/assets/obsidian-5x7.png')


def install_card_materials(db):
    db.execute("ALTER TABLE cards ADD COLUMN back TEXT NOT NULL DEFAULT ''")
    db.execute('''UPDATE cards SET back='/h5/' || substr(id,1,instr(id,'-')-1) || '/back.webp'
        WHERE id IN (SELECT card FROM card_print)''')
    db.executemany('INSERT OR IGNORE INTO resources VALUES(?,?,?,?,?)', [
        ('kanto-field','backgrounds','关都原野','/h5/kanto/field.jpg',''),
        ('kanto-back','backs','关都卡背','/h5/kanto/back.webp','5x7'),
    ])
    for cfg in GENERATIONS.values():
        directory=cfg['dir']
        db.executemany('INSERT OR IGNORE INTO resources VALUES(?,?,?,?,?)', [
            (f'{directory}-field','backgrounds',cfg['field'],f'/h5/{directory}/field.webp',''),
            (f'{directory}-back','backs',cfg['name'].removesuffix('卡池')+'卡背',f'/h5/{directory}/back.webp','5x7'),
        ])


def install_generations(db):
    for gen, cfg in GENERATIONS.items():
        gen_dir = ROOT / 'h5' / cfg['dir']
        catalog_path = gen_dir / 'catalog.json'
        if not catalog_path.is_file():
            continue
        catalog = json.loads(catalog_path.read_text('utf-8'))
        pool_id = cfg['dir']
        if db.execute('SELECT 1 FROM pools WHERE id=?', (pool_id,)).fetchone():
            continue
        # 卡池名去重
        name = cfg['name']
        while db.execute('SELECT 1 FROM pools WHERE name=?', (name,)).fetchone():
            name += ' · ' + cfg['dir']
        db.execute('INSERT INTO pools(id,name) VALUES(?,?)', (pool_id, name))
        base = '/h5/' + cfg['dir'] + '/'
        frame = GEN_FRAMES[(gen - 2) % len(GEN_FRAMES)]
        for index, species in enumerate(catalog):
            number = species['number']
            serial = f'{number:04d}'
            card = f'{pool_id}-{serial}'
            db.execute('INSERT INTO cards VALUES(?,?,?,?,?,?,?,?)',
                       (card, species['name'], '5x7', 0, cfg['color'], base+serial+'.webp', frame, ''))
            db.execute('INSERT INTO card_print VALUES(?,?,?)', (card, number, species['english']))
            db.execute('INSERT INTO entries(pool,card) VALUES(?,?)', (pool_id, card))


def migrate_pool_rates(db):
    db.execute("""CREATE TABLE pools_new(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        rareRate INTEGER NOT NULL DEFAULT 0 CHECK(rareRate BETWEEN 0 AND 10000))""")
    db.execute("UPDATE cards SET special=0 WHERE id='cottonee'")
    db.execute("""INSERT INTO pools_new(id,name,archived,rareRate)
        SELECT p.id,p.name,p.id IN ('candy','garden'),COALESCE((
            SELECT SUM(e.chance) FROM entries e JOIN cards c ON c.id=e.card
            WHERE e.pool=p.id AND c.special=1),0) FROM pools p""")
    db.execute('DROP TABLE pools')
    db.execute('ALTER TABLE pools_new RENAME TO pools')
    db.execute('CREATE UNIQUE INDEX active_pool_name ON pools(name) WHERE archived=0')
    db.execute('ALTER TABLE entries DROP COLUMN chance')
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('卡池迁移的关联记录不完整')
    db.execute('PRAGMA user_version=1')
