"""Serve the H5 player and package its shared mini-program art for Debian."""
from base64 import b64encode
from html import escape
import io
import json
from pathlib import Path
import re
import sys
import tarfile
from tempfile import NamedTemporaryFile
from flask import Response, abort, send_file, send_from_directory
from PIL import Image, ImageOps
from werkzeug.security import safe_join

ROOT = Path(__file__).resolve().parent
MINI = ROOT.parent / '糖果闪卡'
H5 = ROOT / 'h5'
ASSETS = H5 / 'assets' if (H5 / 'assets').is_dir() else MINI / 'assets'
IMAGE_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp'}


def thumbnail(path):
    size = 640 if path.stem == 'pack' or path.stem.endswith('-pack') else 320
    data = io.BytesIO()
    with Image.open(path) as image:
        image.thumbnail((size, size), Image.Resampling.LANCZOS, reducing_gap=3)
        ImageOps.exif_transpose(image, in_place=True)
        image.save(data, 'WEBP', quality=82, method=2)
    return data.getvalue()


def engine():
    parts = ["const CardEngine = (() => { const modules = {}; const require = key => modules[key];"]
    for name in ('art','scene','holo'):
        js = (MINI/'lib'/f'{name}.js').read_text('utf-8')
        parts.append("modules['./%s'] = (() => { const module = {};\n%s\nreturn module.exports; })();" % (name, js))
    parts.append("return {...modules['./art'], ...modules['./scene'], ...modules['./holo']}; })();")
    return '\n'.join(parts)


def data_url(content, suffix):
    return f'data:{IMAGE_TYPES[suffix]};base64,{b64encode(content).decode("ascii")}'


def interactive_card(card, media, *, subject=None):
    roots = {'h5': H5, 'assets': ASSETS, 'media': media}
    card = {key: card[key] for key in ('name', 'ratio', 'color', 'special', 'dex', 'english',
                                      'background', 'subject', 'frame', 'back')}
    embedded = {}
    for key in ('background', 'subject', 'frame', 'back'):
        src = card[key]
        if not src:
            continue
        if src not in embedded:
            _, prefix, relative = src.split('/', 2)
            path = safe_join(str(roots[prefix]), relative)
            if path is None or not Path(path).is_file():
                abort(404, '卡片素材已缺失，无法生成文件')
            asset = Path(path)
            embedded[src] = data_url(asset.read_bytes(), asset.suffix.lower())
        card[key] = embedded[src]
    if subject is not None:
        card['subject'] = data_url(*subject)

    name = escape(card['name'])
    data = json.dumps(card, ensure_ascii=False).replace('<', r'\u003c')
    packed_engine = H5 / 'engine.js'
    js = packed_engine.read_text('utf-8') if packed_engine.is_file() else engine()
    license_file = H5 / 'HOLO-LICENSE.txt' if packed_engine.is_file() else MINI / 'lib/HOLO-LICENSE.txt'
    license_text = license_file.read_text('utf-8')
    motion = (H5 / 'motion.js').read_text('utf-8')
    css = (H5 / 'style.css').read_text('utf-8')
    document = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<link rel="icon" href="data:,">
<title>{name} · 时光闪卡</title><style>{css}</style></head>
<body class="immersive"><main id="app"></main><div id="notice" role="status" hidden></div>
<script>/*{license_text}*/\n{js}</script>
<script>{motion}</script>
<script type="application/json" id="card-data">{data}</script>
<script>
const notice = document.getElementById('notice');
window.motion.card(document.getElementById('app'), JSON.parse(document.getElementById('card-data').textContent), {{
  standalone: true,
  toast(message) {{ notice.textContent = message; notice.hidden = false; }}
}});
</script></body></html>'''
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', card['name']) + '-互动闪卡.html'
    response = send_file(io.BytesIO(document.encode('utf-8')), mimetype='text/html',
                         as_attachment=True, download_name=filename)
    response.cache_control.no_store = True
    return response


def register_web(app, media):
    roots = {'h5': H5, 'assets': ASSETS, 'media': media}

    @app.get('/')
    def web_home():
        return send_from_directory(ROOT/'h5','index.html')

    @app.get('/assets/<name>')
    def web_asset(name):
        return send_from_directory(ASSETS,name)

    @app.get('/h5/engine.js')
    def web_engine():
        if (ROOT/'h5/engine.js').is_file():
            return send_from_directory(ROOT/'h5','engine.js')
        return Response(engine(), mimetype='application/javascript')

    @app.get('/thumb/<prefix>/<path:name>')
    def web_thumbnail(prefix, name):
        path = safe_join(str(roots[prefix]), name) if prefix in roots else None
        if path is None:
            abort(404)
        source = Path(path)
        if source.suffix.lower() not in IMAGE_TYPES or not source.is_file():
            abort(404)
        relative = f'{prefix}/{name}.webp'
        packed = H5/'thumbs'/relative
        if packed.is_file():
            return send_file(packed, mimetype='image/webp', max_age=3600)

        cached = media.parent/'thumbs'/relative
        if not cached.exists() or cached.stat().st_mtime_ns < source.stat().st_mtime_ns:
            data = thumbnail(source)
            cached.parent.mkdir(parents=True,exist_ok=True)
            with NamedTemporaryFile(dir=cached.parent,delete=False) as temp:
                temp.write(data)
            staged = Path(temp.name)
            try:
                staged.replace(cached)
            finally:
                staged.unlink(missing_ok=True)
        return send_file(cached, mimetype='image/webp', max_age=31536000 if prefix=='media' else 3600)


if __name__ == '__main__':
    with tarfile.open(sys.argv[1], 'w:gz') as archive:
        for filename in ('deploy-debian.sh','server.py','database.py','webfiles.py','seed.json','requirements.txt','h5'):
            archive.add(ROOT/filename,arcname=filename)
        archive.add(MINI/'assets',arcname='h5/assets')
        archive.add(MINI/'lib/HOLO-LICENSE.txt',arcname='h5/HOLO-LICENSE.txt')
        js = engine().encode()
        info = tarfile.TarInfo('h5/engine.js')
        info.size = len(js)
        archive.addfile(info, io.BytesIO(js))
        for prefix, directory in (('h5', H5), ('assets', MINI/'assets')):
            for asset in sorted(directory.rglob('*')):
                relative = asset.relative_to(directory)
                if relative.parts[0] in ('thumbs','assets') or asset.suffix.lower() not in IMAGE_TYPES or not asset.is_file():
                    continue
                data = thumbnail(asset)
                info = tarfile.TarInfo(f'h5/thumbs/{prefix}/{relative.as_posix()}.webp')
                info.size = len(data)
                info.mtime = int(asset.stat().st_mtime)
                archive.addfile(info, io.BytesIO(data))
