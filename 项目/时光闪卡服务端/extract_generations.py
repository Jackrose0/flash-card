#!/usr/bin/env python3
"""从 dex.pokedream.cn 的 JS 数据提取 2-9 世代宝可梦，生成各世代 catalog 与导入数据。

用法：
  python extract_generations.py <dex-js.txt路径> <输出目录>

输出：
  <输出目录>/generations.json   —— 每世代一份 {id, name(中文), english, number} 列表
  <输出目录>/gen{2-9}/catalog.json  —— 与 h5/kanto/catalog.json 相同格式
"""
import json
import sys
from collections import defaultdict
from pathlib import Path


def load_pokemon(js_path):
    data = Path(js_path).read_text('utf-8')
    idx = data.find('JSON.parse(')
    assert idx != -1, '未找到 JSON.parse('
    start = data.find('`', idx) + 1
    end = data.find('`', start)
    raw = data[start:end]
    return json.loads(raw)


def main():
    js_path = sys.argv[1]
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    pokemon = load_pokemon(js_path)

    # 按世代分组
    by_gen = defaultdict(list)
    for p in pokemon:
        by_gen[p['generation']].append(p)

    # 世代中文名
    gen_names = {
        1: '关都', 2: '城都', 3: '丰缘', 4: '神奥', 5: '合众',
        6: '卡洛斯', 7: '阿罗拉', 8: '伽勒尔', 9: '帕底亚',
    }

    result = {}
    for gen in range(2, 10):
        members = sorted(by_gen[gen], key=lambda x: x['id'])
        catalog = []
        for p in members:
            catalog.append({
                'number': p['id'],
                'name': p['names']['zh'],
                'english': p['names']['en'],
                'types': [t['slug'] for t in p['types']],
                'legendary': bool(p.get('legendary')),
                'mythical': bool(p.get('mythical')),
            })
        gen_dir = out_dir / f'gen{gen}'
        gen_dir.mkdir(parents=True, exist_ok=True)
        # 与 kanto catalog.json 格式一致（number/name/english）
        simple = [{'number': c['number'], 'name': c['name'], 'english': c['english']} for c in catalog]
        (gen_dir / 'catalog.json').write_text(
            json.dumps(simple, ensure_ascii=False, indent=1), 'utf-8')
        result[gen] = {
            'dir': f'gen{gen}',
            'name': gen_names[gen],
            'count': len(catalog),
            'range': f'{members[0]["id"]}-{members[-1]["id"]}',
            'catalog': catalog,
        }
        print(f'gen{gen} {gen_names[gen]}: {len(catalog)} 只 ({result[gen]["range"]})')

    # 汇总
    (out_dir / 'generations.json').write_text(
        json.dumps({str(k): {kk: vv for kk, vv in v.items() if kk != 'catalog'}
                    for k, v in result.items()}, ensure_ascii=False, indent=2), 'utf-8')
    # 完整数据（含类型，供后续稀有卡判定）
    (out_dir / 'generations_full.json').write_text(
        json.dumps({str(k): v['catalog'] for k, v in result.items()},
                   ensure_ascii=False), 'utf-8')
    print(f'\n已写入 {out_dir}/generations.json 与 generations_full.json')
    print(f'总计 {sum(len(v["catalog"]) for v in result.values())} 只')


if __name__ == '__main__':
    main()
