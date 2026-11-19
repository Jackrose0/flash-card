"""Serve an isolated phone preview and prepare a copy for WeChat DevTools."""
import argparse
import ipaddress
import json
from pathlib import Path
import secrets
import shutil
from threading import Timer

from waitress import create_server

from server import ROOT, create_app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('address', type=ipaddress.IPv4Address)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    if not any(args.address in ipaddress.ip_network(net) for net in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')):
        parser.error('请选择电脑的局域网 IPv4 地址')

    source = ROOT.parent / '糖果闪卡'
    project = ROOT.parents[1] / 'tmp' / 'candy-scan-preview'
    shutil.copytree(source, project, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('project.private.config.json', '.git'))
    key = secrets.token_urlsafe(32)
    config = dict(serverOrigin=f'http://{args.address}:{args.port}', previewKey=key)
    (project / 'lib/config.js').write_text('module.exports=' + json.dumps(config) + ';\n', encoding='utf-8')
    app = create_app(ROOT / 'data-preview', preview_key=key)
    server = create_server(app, host=str(args.address), port=args.port, max_request_body_size=12*1024*1024)
    timer = Timer(7200, server.close)
    timer.daemon = True
    timer.start()
    print(f'Preview at {config["serverOrigin"]} for 2 hours. DevTools project: {project}', flush=True)
    server.run()
