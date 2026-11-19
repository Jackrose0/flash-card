#!/usr/bin/env python3
"""下载 2-9 世代宝可梦卡图（透明主体图），转 webp 存到各世代目录。

用法：
  python download_generations.py <输出根目录>
"""
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

BASE = 'https://dex.pokedream.cn/assets/pokemon/{}.png'


def download_one(pid, out_path):
    if out_path.exists():
        return pid, True, 'skip'
    url = BASE.format(pid)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    tmp = out_path.with_suffix('.tmp.png')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        tmp.write_bytes(data)
        img = Image.open(tmp).convert('RGBA')
        # 与 kanto 卡图一致：475x475，webp
        img.save(out_path, 'WEBP', quality=88)
        tmp.unlink(missing_ok=True)
        return pid, True, 'ok'
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return pid, False, str(e)


def main():
    root = Path(sys.argv[1])
    full = json.loads((root / 'generations_full.json').read_text('utf-8'))

    tasks = []
    for gen_str, members in full.items():
        gen = int(gen_str)
        gen_dir = root / f'gen{gen}'
        gen_dir.mkdir(parents=True, exist_ok=True)
        for m in members:
            pid = m['number']
            out = gen_dir / f'{pid:04d}.webp'
            tasks.append((pid, out))

    print(f'共 {len(tasks)} 张卡图待下载')
    ok = fail = 0
    fails = []
    with ThreadPoolExecutor(max_workers=12) as ex:
        futures = {ex.submit(download_one, pid, out): pid for pid, out in tasks}
        for i, fut in enumerate(as_completed(futures), 1):
            pid, success, msg = fut.result()
            if success:
                ok += 1
            else:
                fail += 1
                fails.append((pid, msg))
            if i % 100 == 0 or i == len(tasks):
                print(f'  进度 {i}/{len(tasks)}  成功 {ok} 失败 {fail}')

    print(f'\n完成：成功 {ok}，失败 {fail}')
    if fails:
        print('失败列表：')
        for pid, msg in fails[:30]:
            print(f'  {pid}: {msg}')


if __name__ == '__main__':
    main()
