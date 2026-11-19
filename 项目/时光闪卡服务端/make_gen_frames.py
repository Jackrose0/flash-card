#!/usr/bin/env python3
"""为 2-9 世代生成专属卡框（版式对齐关都卡框）。

版式（800x1120，5:7）：
- 顶部横幅 y 0~80：主题色渐变 + 英文世代名
- 右上编号框：深色斜切多边形（供 print 显示编号）
- 底部信息栏 y 920~1120：深色 + 中文世代名 + 英文副标题
- 中央镂空 x 40~760, y 80~920：透明（放宝可梦主体图）
- 金色金属边框
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
H5 = ROOT / 'h5'
W, H = 800, 1120

FONT_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
FONT_REG = 'C:/Windows/Fonts/msyh.ttc'
FONT_GEORGIA = 'C:/Windows/Fonts/georgia.ttf' if Path('C:/Windows/Fonts/georgia.ttf').exists() else FONT_REG


def font(size, bold=True):
    try:
        return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)
    except Exception:
        return ImageFont.load_default()


# 各世代配置：英文名、中文名、副标题、主题色（顶部横幅）、深色（底部栏/编号框）、金色
GENS = {
    2:  dict(en='JOHTO',  cn='城都', sub='金心银魂 · 传说',   top=(74, 140, 92),  top2=(110, 180, 120), deep=(36, 74, 52)),
    3:  dict(en='HOENN',  cn='丰缘', sub='大地与海洋 · 传说', top=(46, 111, 149), top2=(78, 150, 190),  deep=(26, 61, 92)),
    4:  dict(en='SINNOH', cn='神奥', sub='时间与空间 · 传说', top=(90, 111, 165), top2=(130, 150, 200), deep=(42, 53, 96)),
    5:  dict(en='UNOVA',  cn='合众', sub='黑与白 · 传说',     top=(74, 90, 112),  top2=(120, 140, 160), deep=(34, 42, 56)),
    6:  dict(en='KALOS',  cn='卡洛斯', sub='生命与毁灭 · 传说', top=(59, 110, 165), top2=(100, 150, 200), deep=(30, 58, 90)),
    7:  dict(en='ALOLA',  cn='阿罗拉', sub='日月 · 传说',      top=(46, 158, 158),  top2=(80, 190, 180),  deep=(21, 90, 90)),
    8:  dict(en='GALAR',  cn='伽勒尔', sub='剑与盾 · 传说',   top=(138, 63, 90),   top2=(180, 100, 120), deep=(58, 30, 42)),
    9:  dict(en='PALDEA', cn='帕底亚', sub='过去与未来 · 传说', top=(192, 74, 74),  top2=(220, 110, 100), deep=(90, 30, 30)),
}


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def hgrad(draw, x0, y0, x1, y1, c0, c1):
    """水平渐变矩形"""
    for x in range(x0, x1):
        t = (x - x0) / max(1, (x1 - x0 - 1))
        draw.line([(x, y0), (x, y1 - 1)], fill=lerp(c0, c1, t))


def vgrad(draw, x0, y0, x1, y1, c0, c1):
    for y in range(y0, y1):
        t = (y - y0) / max(1, (y1 - y0 - 1))
        draw.line([(x0, y), (x1 - 1, y)], fill=lerp(c0, c1, t))


def make_frame(gen, cfg):
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    gold = (232, 192, 106)
    gold_dark = (190, 140, 60)

    # ---------- 金色边框（四周，带内缘描边） ----------
    d.rectangle([0, 0, W - 1, H - 1], fill=(232, 192, 106, 255))
    # 边框渐变：外缘亮金，内缘深金
    for i in range(40):
        t = i / 40
        c = lerp(gold_dark, gold, t)
        d.rectangle([i, i, W - 1 - i, H - 1 - i], outline=c)

    # 内缘深金描边（镂空边界）
    inner = 40
    d.rectangle([inner, inner, W - 1 - inner, H - 1 - inner], outline=(160, 110, 40, 255), width=3)

    # ---------- 顶部横幅（主题色渐变） ----------
    top_h = 80
    hgrad(d, inner, inner, W - inner, top_h, cfg['top'], cfg['top2'])
    # 横幅下缘金色分界线
    d.rectangle([inner, top_h, W - inner, top_h + 6], fill=gold)

    # ---------- 右上编号框（深色斜切多边形） ----------
    bx0, by0, bx1, by1 = 692, 28, 764, 74
    # 斜切平行四边形
    d.polygon([(bx0, by0), (bx1, by0 + 8), (bx1 - 12, by1), (bx0 - 12, by1 - 8)], fill=cfg['deep'])
    d.polygon([(bx0, by0), (bx1, by0 + 8), (bx1 - 12, by1), (bx0 - 12, by1 - 8)], outline=gold, width=2)
    # 编号框内 "No."
    f_no = font(18)
    d.text((bx0 + 10, by0 + 24), 'No.', font=f_no, fill=(255, 220, 150, 255))

    # ---------- 顶部横幅文字：英文世代名 ----------
    f_en = font(40)
    d.text((inner + 24, 18), cfg['en'], font=f_en, fill=(255, 245, 220, 255))

    # 右上角精灵球装饰（简化为圆形）
    ball_cx, ball_cy = 80, 40  # 不放在右上（编号框在右上），放左上横幅内右侧
    # 实际上横幅左侧是英文名，右侧是编号框，中间留空。在横幅中右画精灵球
    bcx, bcy = 640, 52
    d.ellipse([bcx - 16, bcy - 16, bcx + 16, bcy + 16], outline=(255, 240, 210, 255), width=3)
    d.line([(bcx - 16, bcy), (bcx + 16, bcy)], fill=(255, 240, 210, 255), width=2)
    d.ellipse([bcx - 6, bcy - 6, bcx + 6, bcy + 6], fill=(255, 240, 210, 255))

    # ---------- 底部信息栏（深色） ----------
    foot_y0 = 920
    d.rectangle([inner, foot_y0, W - inner, H - inner], fill=cfg['deep'])
    # 顶部金色分界线
    d.rectangle([inner, foot_y0 - 6, W - inner, foot_y0], fill=gold)
    # 中文世代名
    f_cn = font(52)
    d.text((inner + 26, foot_y0 + 40), f'{cfg["cn"]}图鉴', font=f_cn, fill=(240, 235, 220, 255))
    # 英文副标题
    f_sub = font(24)
    d.text((inner + 30, foot_y0 + 120), cfg['sub'], font=f_sub, fill=(200, 200, 185, 255))

    # 底部右下角精灵球线稿装饰
    d.ellipse([W - inner - 66, foot_y0 + 46, W - inner - 26, foot_y0 + 86], outline=(150, 150, 135, 255), width=3)
    d.line([(W - inner - 66, foot_y0 + 66), (W - inner - 26, foot_y0 + 66)], fill=(150, 150, 135, 255), width=2)

    # ---------- 中央镂空（透明） ----------
    # 把中央区域 (inner, top_h+6, W-inner, foot_y0-6) 设为透明
    clear = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    clear.paste(img, (0, 0))
    # 用透明擦除中央
    d2 = ImageDraw.Draw(clear)
    d2.rectangle([inner + 2, top_h + 4, W - inner - 2, foot_y0 - 4], fill=(0, 0, 0, 0))

    # 四角斜切装饰（金色小三角）
    for cx, cy, dx, dy in [(inner, inner, 1, 1), (W - inner, inner, -1, 1), (inner, H - inner, 1, -1), (W - inner, H - inner, -1, -1)]:
        pass

    return clear


def main():
    full = json.loads((H5 / 'generations_full.json').read_text('utf-8'))
    for gen, cfg in GENS.items():
        frame = make_frame(gen, cfg)
        out = H5 / f'gen{gen}' / 'frame.png'
        out.parent.mkdir(parents=True, exist_ok=True)
        frame.save(out)
        print(f'gen{gen} {cfg["cn"]}: {out.relative_to(H5)}')


if __name__ == '__main__':
    main()
