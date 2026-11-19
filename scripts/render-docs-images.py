#!/usr/bin/env python3
"""Render the README's illustrative images (no screenshots of a real machine).

Produces:
  docs/images/hero.png           - the simulator tab, phone frame, mock Settings screen
  docs/images/device-picker.png  - the grouped device picker
  docs/images/icon.png           - 512x512 app icon

Everything is drawn locally with Pillow; the mock device content is fictional.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 2  # supersample factor
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"

FONT_CJK = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
FONT_LAT = "/System/Library/Fonts/SFNS.ttf"

INK = (31, 35, 40)
MUTED = (107, 114, 128)
LINE = (227, 230, 234)
PANEL = (255, 255, 255)
STAGE = (242, 244, 247)
BLUE = (77, 107, 254)
GREEN = (34, 197, 94)
SHELL = (23, 24, 28)


def s(v):
    return int(round(v * SS))


def font(size, latin=False):
    return ImageFont.truetype(FONT_LAT if latin else FONT_CJK, s(size))


def text(draw, x, y, value, size=13, color=INK, bold=False, latin=False, anchor=None):
    f = font(size, latin=latin)
    draw.text((s(x), s(y)), value, font=f, fill=color, anchor=anchor,
              stroke_width=1 if bold else 0, stroke_fill=color)


def rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle([s(box[0]), s(box[1]), s(box[2]), s(box[3])], radius=s(radius),
                           fill=fill, outline=outline, width=max(1, s(width)) if outline else 0)


def shadow(base, box, radius, blur=18, spread=2, alpha=40):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([s(box[0] - spread), s(box[1] - spread + 6), s(box[2] + spread), s(box[3] + spread + 6)],
                        radius=s(radius + spread), fill=(15, 23, 42, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(s(blur)))
    base.alpha_composite(layer)


def chip(draw, x, y, w, hgt, label, size=12, radius=8, bg=(255, 255, 255), border=LINE, color=INK, pad=10):
    rounded(draw, (x, y, x + w, y + hgt), radius, fill=bg, outline=border, width=1)
    text(draw, x + pad, y + hgt / 2, label, size=size, color=color, anchor="lm")


def icon_rotate(draw, x, y, color=INK):
    draw.arc([s(x + 4), s(y + 4), s(x + 22), s(y + 22)], 40, 320, fill=color, width=s(1.6))
    draw.polygon([(s(x + 19), s(y + 3)), (s(x + 23), s(y + 8)), (s(x + 18.5), s(y + 9))], fill=color)


def icon_home(draw, x, y, color=INK):
    draw.line([(s(x + 4), s(y + 11)), (s(x + 13), s(y + 4)), (s(x + 22), s(y + 11))], fill=color, width=s(1.7))
    draw.line([(s(x + 6.5), s(y + 10.5)), (s(x + 6.5), s(y + 22)), (s(x + 19.5), s(y + 22)), (s(x + 19.5), s(y + 10.5))],
              fill=color, width=s(1.7))
    draw.line([(s(x + 11), s(y + 22)), (s(x + 11), s(y + 15)), (s(x + 15), s(y + 15)), (s(x + 15), s(y + 22))],
              fill=color, width=s(1.7))


def icon_power(draw, x, y, color=INK):
    draw.line([(s(x + 13), s(y + 4)), (s(x + 13), s(y + 13))], fill=color, width=s(1.8))
    draw.arc([s(x + 5), s(y + 7), s(x + 21), s(y + 23)], 300, 240, fill=color, width=s(1.8))


def icon_button(base, draw, x, y, paint):
    rounded(draw, (x, y, x + 28, y + 28), 7, fill=(255, 255, 255), outline=LINE, width=1)
    paint(draw, x, y)


def toolbar(base, draw, width, device_label, connected=True):
    draw.ellipse([s(16), s(26), s(24), s(34)], fill=GREEN if connected else (156, 163, 175))
    text(draw, 30, 30, "已连接" if connected else "未连接", size=11, color=MUTED, anchor="lm")
    chip(draw, 74, 16, 178, 28, device_label, size=12)
    text(draw, 236, 30, "▾", size=9, color=MUTED, anchor="lm")
    icon_button(base, draw, width - 214, 16, icon_rotate)
    icon_button(base, draw, width - 180, 16, icon_home)
    icon_button(base, draw, width - 146, 16, icon_power)
    chip(draw, width - 108, 16, 66, 28, "手机框", size=11)
    text(draw, width - 54, 30, "▾", size=8, color=MUTED, anchor="lm")


def phone_screen(img, draw, x, y, w, hgt):
    """Mock iOS Settings screen (fictional)."""
    rounded(draw, (x, y, x + w, y + hgt), 34, fill=(247, 247, 249))
    # status bar
    text(draw, x + 26, y + 18, "9:41", size=12, bold=True, latin=True)
    for i in range(4):
        draw.rectangle([s(x + w - 96 + i * 5), s(y + 26 - i * 2), s(x + w - 93 + i * 5), s(y + 28)], fill=INK)
    draw.arc([s(x + w - 62), s(y + 18), s(x + w - 50), s(y + 30)], 210, 330, fill=INK, width=s(1.4))
    draw.rounded_rectangle([s(x + w - 44), s(y + 20), s(x + w - 24), s(y + 30)], radius=s(2), outline=INK, width=s(1.2))
    draw.rectangle([s(x + w - 22), s(y + 23), s(x + w - 19), s(y + 27)], fill=INK)
    # title + search
    text(draw, x + 24, y + 52, "设置", size=26, bold=True)
    rounded(draw, (x + 24, y + 92, x + w - 24, y + 118), 10, fill=(233, 234, 239))
    text(draw, x + 38, y + 105, "搜索", size=11, color=MUTED, anchor="lm")
    # settings rows
    rows = [
        ("通用", (120, 144, 156)),
        ("显示与亮度", (77, 107, 254)),
        ("声音与触感", (236, 72, 153)),
        ("待机显示", (245, 158, 11)),
        ("隐私与安全", (16, 185, 129)),
    ]
    top = y + 132
    for label, color in rows:
        rounded(draw, (x + 18, top, x + w - 18, top + 54), 13, fill=PANEL)
        rounded(draw, (x + 30, top + 14, x + 56, top + 40), 8, fill=color)
        text(draw, x + 66, top + 27, label, size=12.5, anchor="lm")
        text(draw, x + w - 34, top + 27, "›", size=16, color=(170, 175, 185), anchor="mm")
        top += 64
    # home indicator
    draw.rounded_rectangle([s(x + w * 0.34), s(y + hgt - 14), s(x + w * 0.66), s(y + hgt - 9)], radius=s(3), fill=(190, 193, 200))


def build_panel(width=620, height=1000):
    img = Image.new("RGBA", (s(width), s(height)), (0, 0, 0, 0))
    shadow(img, (6, 4, width - 6, height - 8), 18, blur=16, spread=2, alpha=36)
    draw = ImageDraw.Draw(img)
    rounded(draw, (0, 0, width, height), 18, fill=PANEL, outline=LINE, width=1)
    return img, draw


def render_hero():
    width, height = 620, 1000
    img, draw = build_panel(width, height)
    rounded(draw, (10, 60, width - 10, height - 10), 12, fill=STAGE)
    shell_w, shell_h = 306, 660
    sx = (width - shell_w) / 2
    sy = 96
    shadow(img, (sx, sy, sx + shell_w, sy + shell_h), 46, blur=14, spread=3, alpha=70)
    rounded(draw, (sx, sy, sx + shell_w, sy + shell_h), 46, fill=SHELL)
    rounded(draw, (sx + 10, sy + 10, sx + shell_w - 10, sy + shell_h - 10), 38, fill=(0, 0, 0))
    phone_screen(img, draw, sx + 12, sy + 12, shell_w - 24, shell_h - 24)
    # floating status badge
    rounded(draw, (width - 116, height - 54, width - 16, height - 24), 15, fill=(24, 24, 28, 235))
    draw.ellipse([s(width - 104), s(height - 43), s(width - 96), s(height - 35)], fill=GREEN)
    text(draw, width - 88, height - 39, "已连接", size=10, color=(255, 255, 255), anchor="lm")
    toolbar(img, draw, width, "iPhone 18 Pro")
    img.convert("RGB").save(OUT / "hero.png", optimize=True)


def render_picker():
    width, height = 620, 760
    img, draw = build_panel(width, height)
    rounded(draw, (10, 60, width - 10, height - 10), 12, fill=STAGE)
    toolbar(img, draw, width, "选择模拟器 / 设备", connected=False)
    # dropdown card
    card = (74, 52, 470, 470)
    shadow(img, card, 12, blur=18, spread=2, alpha=55)
    rounded(draw, card, 12, fill=PANEL, outline=LINE, width=1)
    rounded(draw, (84, 62, 460, 90), 8, fill=(246, 247, 249), outline=LINE, width=1)
    text(draw, 96, 76, "搜索设备…", size=11.5, color=(150, 155, 165), anchor="lm")
    text(draw, 86, 102, "使用过的设备", size=10, color=(140, 146, 158))
    rows = [
        ("iPhone 18 Pro", "iOS 26.2 · 已停止", True, None),
        ("Pixel 9 Pro", "Android 15 · API 35 · 运行中", False, GREEN),
    ]
    y = 116
    for name, sub, check, dot in rows:
        rounded(draw, (82, y, 462, y + 48), 8, fill=(246, 247, 249) if check else None)
        if dot:
            draw.ellipse([s(94), s(y + 12), s(100), s(y + 18)], fill=dot)
        text(draw, 106, y + 16, name, size=12)
        text(draw, 106, y + 33, sub, size=9.5, color=MUTED)
        if check:
            text(draw, 446, y + 24, "✓", size=12, color=INK, anchor="mm")
        y += 56
    draw.line([(s(86), s(y + 4)), (s(458), s(y + 4))], fill=(238, 240, 243), width=s(1))
    text(draw, 88, y + 20, "›", size=11, color=MUTED)
    text(draw, 104, y + 21, "此计算机上的其他设备（12）", size=10.5, color=(120, 126, 138))
    img.convert("RGB").save(OUT / "device-picker.png", optimize=True)


def render_icon(size=512):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGB", (size, size))
    top, bottom = (77, 107, 254), (124, 92, 255)
    px = grad.load()
    for y in range(size):
        t = y / (size - 1)
        for x in range(size):
            px[x, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # soft highlight
    d.ellipse([int(size * 0.05), int(-size * 0.25), int(size * 0.95), int(size * 0.55)],
              fill=(255, 255, 255, 18))
    # phone outline
    pw, ph = int(size * 0.42), int(size * 0.62)
    x0, y0 = (size - pw) // 2, (size - ph) // 2 + int(size * 0.02)
    d.rounded_rectangle([x0, y0, x0 + pw, y0 + ph], radius=int(size * 0.09), outline=(255, 255, 255, 235), width=int(size * 0.035))
    d.rounded_rectangle([x0 + int(size * 0.035), y0 + int(size * 0.05), x0 + pw - int(size * 0.035), y0 + ph - int(size * 0.05)],
                        radius=int(size * 0.06), outline=(255, 255, 255, 120), width=int(size * 0.012))
    # play triangle
    cx, cy = size // 2, y0 + ph // 2
    tri = int(size * 0.075)
    d.polygon([(cx - tri // 2, cy - tri), (cx - tri // 2, cy + tri), (cx + tri, cy)], fill=(255, 255, 255, 235))
    # live dot
    r = int(size * 0.05)
    dx, dy = x0 + pw - int(size * 0.02), y0 + ph - int(size * 0.02)
    d.ellipse([dx - r, dy - r, dx + r, dy + r], fill=(34, 197, 94, 255), outline=(255, 255, 255, 255), width=int(size * 0.012))
    img.save(OUT / "icon.png", optimize=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    render_hero()
    render_picker()
    render_icon()
    print("rendered:", *(p.name for p in sorted(OUT.glob("*.png"))))
