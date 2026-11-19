#!/usr/bin/env python3
"""Render the README illustrations locally (no screenshots of a real machine).

  docs/images/hero.png           full DSH window with the simulator tab open
  docs/images/device-picker.png  same window with the grouped device picker open
  docs/images/icon.png           512x512 app icon

All UI text and device content is fictional. Run from the repository root.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 2
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"

F_CJK = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
F_LAT = "/System/Library/Fonts/SFNS.ttf"

INK = (31, 35, 40)
MUTED = (108, 114, 126)
FAINT = (146, 152, 164)
LINE = (228, 231, 236)
PANEL = (255, 255, 255)
SIDEBAR = (247, 248, 250)
STAGE = (242, 244, 247)
BLUE = (77, 107, 254)
PURPLE = (124, 92, 255)
GREEN = (34, 197, 94)
SHELL = (23, 24, 28)


def s(v):
    return int(round(v * SS))


def font(size, latin=False):
    return ImageFont.truetype(F_LAT if latin else F_CJK, s(size))


def text(draw, x, y, value, size=12, color=INK, bold=False, latin=False, anchor=None):
    draw.text((s(x), s(y)), value, font=font(size, latin=latin), fill=color, anchor=anchor,
              stroke_width=s(0.55) if bold else 0, stroke_fill=color)


def rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle([s(box[0]), s(box[1]), s(box[2]), s(box[3])], radius=s(radius),
                           fill=fill, outline=outline, width=max(1, s(width)) if outline else 0)


def soft_shadow(img, box, radius, blur=16, spread=2, alpha=38, dy=8):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([s(box[0] - spread), s(box[1] - spread + dy), s(box[2] + spread), s(box[3] + spread + dy)],
                        radius=s(radius + spread), fill=(15, 23, 42, alpha))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(s(blur))))


def chip(draw, x, y, w, hgt, label, size=11, radius=7, bg=PANEL, border=LINE, color=INK, pad=9):
    rounded(draw, (x, y, x + w, y + hgt), radius, fill=bg, outline=border, width=1)
    text(draw, x + pad, y + hgt / 2, label, size=size, color=color, anchor="lm")


def icon_rotate(draw, x, y, color=INK, k=1.0):
    r = 9 * k
    draw.arc([s(x + 13 - r), s(y + 14 - r), s(x + 13 + r), s(y + 14 + r)], 35, 315, fill=color, width=s(1.5 * k))
    draw.polygon([(s(x + 13 + r - 2), s(y + 14 - r - 2)), (s(x + 13 + r + 2), s(y + 14 - r + 3)), (s(x + 13 + r - 3), s(y + 14 - r + 4))], fill=color)


def icon_home(draw, x, y, color=INK, k=1.0):
    draw.line([(s(x + 4), s(y + 10)), (s(x + 13), s(y + 3.5)), (s(x + 22), s(y + 10))], fill=color, width=s(1.6 * k))
    draw.line([(s(x + 6.5), s(y + 9.5)), (s(x + 6.5), s(y + 21)), (s(x + 19.5), s(y + 21)), (s(x + 19.5), s(y + 9.5))], fill=color, width=s(1.6 * k))
    draw.line([(s(x + 11), s(y + 21)), (s(x + 11), s(y + 14.5)), (s(x + 15), s(y + 14.5)), (s(x + 15), s(y + 21))], fill=color, width=s(1.6 * k))


def icon_power(draw, x, y, color=INK, k=1.0):
    draw.line([(s(x + 13), s(y + 3.5)), (s(x + 13), s(y + 12.5))], fill=color, width=s(1.7 * k))
    draw.arc([s(x + 5), s(y + 6.5), s(x + 21), s(y + 22.5)], 300, 240, fill=color, width=s(1.7 * k))


def icon_button(img, draw, x, y, paint):
    rounded(draw, (x, y, x + 28, y + 28), 7, fill=PANEL, outline=LINE, width=1)
    paint(draw, x, y)


def sim_toolbar(img, draw, x0, width, device_label, connected=True):
    draw.ellipse([s(x0 + 16), s(26), s(x0 + 24), s(34)], fill=GREEN if connected else (156, 163, 175))
    text(draw, x0 + 30, 30, "已连接" if connected else "未连接", size=11, color=MUTED, anchor="lm")
    chip(draw, x0 + 74, 16, 178, 28, device_label, size=11.5)
    text(draw, x0 + 236, 30, "▾", size=8, color=FAINT, anchor="lm")
    icon_button(img, draw, x0 + width - 214, 16, icon_rotate)
    icon_button(img, draw, x0 + width - 180, 16, icon_home)
    icon_button(img, draw, x0 + width - 146, 16, icon_power)
    chip(draw, x0 + width - 108, 16, 66, 28, "手机框", size=10.5)
    text(draw, x0 + width - 54, 30, "▾", size=7, color=FAINT, anchor="lm")


def mock_screen(img, draw, x, y, w, hgt):
    rounded(draw, (x, y, x + w, y + hgt), 32, fill=(247, 247, 249))
    text(draw, x + 24, y + 16, "9:41", size=11.5, bold=True, latin=True)
    for i in range(4):
        draw.rectangle([s(x + w - 96 + i * 5), s(y + 24 - i * 2), s(x + w - 93 + i * 5), s(y + 26)], fill=INK)
    draw.arc([s(x + w - 62), s(y + 16), s(x + w - 50), s(y + 28)], 210, 330, fill=INK, width=s(1.3))
    draw.rounded_rectangle([s(x + w - 44), s(y + 18), s(x + w - 24), s(y + 28)], radius=s(2), outline=INK, width=s(1.1))
    draw.rectangle([s(x + w - 22), s(y + 21), s(x + w - 19), s(y + 25)], fill=INK)
    text(draw, x + 22, y + 48, "设置", size=24, bold=True)
    rounded(draw, (x + 22, y + 86, x + w - 22, y + 110), 9, fill=(233, 234, 239))
    text(draw, x + 34, y + 98, "搜索", size=10.5, color=FAINT, anchor="lm")
    rows = [("通用", (120, 144, 156)), ("显示与亮度", BLUE), ("声音与触感", (236, 72, 153)),
            ("待机显示", (245, 158, 11)), ("隐私与安全", (16, 185, 129))]
    top = y + 122
    for label, color in rows:
        rounded(draw, (x + 16, top, x + w - 16, top + 50), 12, fill=PANEL)
        rounded(draw, (x + 27, top + 13, x + 50, top + 36), 7, fill=color)
        text(draw, x + 60, top + 25, label, size=11.5, anchor="lm")
        text(draw, x + w - 30, top + 25, "›", size=14, color=(176, 181, 190), anchor="mm")
        top += 59
    draw.rounded_rectangle([s(x + w * 0.35), s(y + hgt - 13), s(x + w * 0.65), s(y + hgt - 9)], radius=s(3), fill=(190, 193, 200))


def mock_phone(img, draw, cx, top, width):
    hgt = width / 0.462
    x = cx - width / 2
    soft_shadow(img, (x, top, x + width, top + hgt), 44, blur=14, spread=3, alpha=70)
    rounded(draw, (x, top, x + width, top + hgt), 44, fill=SHELL)
    rounded(draw, (x + 10, top + 10, x + width - 10, top + hgt - 10), 36, fill=(0, 0, 0))
    mock_screen(img, draw, x + 12, top + 12, width - 24, hgt - 24)
    return hgt


def sidebar(draw, x0, height):
    rounded(draw, (0, 28, 280, height), 0, fill=SIDEBAR)
    draw.line([(s(280), s(28)), (s(280), s(height))], fill=LINE, width=s(1))
    rounded(draw, (16, 44, 40, 68), 7, fill=BLUE)
    text(draw, 24, 50, "D", size=12, bold=True, color=(255, 255, 255), latin=True)
    text(draw, 48, 56, "DeepSeek Harness", size=11, bold=True, anchor="lm")
    rounded(draw, (16, 84, 264, 116), 8, fill=PANEL, outline=LINE, width=1)
    text(draw, 28, 100, "＋  新会话", size=11, color=BLUE, anchor="lm")
    text(draw, 20, 138, "工作区", size=9.5, color=FAINT)
    rows = [("模拟器插件开发", "现在"), ("护理页面流程优化", "2 分钟"), ("登录页重构", "1 小时"),
            ("数据看板", "昨天"), ("发布检查", "2 天")]
    top = 154
    for i, (title, when) in enumerate(rows):
        if i == 0:
            rounded(draw, (10, top - 2, 270, top + 32), 8, fill=(238, 240, 246))
        text(draw, 22, top + 8, title, size=11, bold=(i == 0))
        text(draw, 258, top + 9, when, size=9, color=FAINT, anchor="ra")
        top += 36
    text(draw, 20, 372, "全局面板", size=9.5, color=FAINT)
    panels = ["插件", "自动化任务", "需求", "上下文洞察", "记忆系统", "SSH"]
    top = 390
    for name in panels:
        draw.ellipse([s(22), s(top + 4), s(28), s(top + 10)], outline=FAINT, width=s(1))
        text(draw, 38, top + 7, name, size=10.5, color=(90, 96, 108), anchor="lm")
        top += 28
    draw.line([(s(16), s(height - 56)), (s(264), s(height - 56))], fill=LINE, width=s(1))
    draw.ellipse([s(18), s(height - 44), s(42), s(height - 20)], fill=(210, 214, 222))
    text(draw, 50, height - 32, "本地账户", size=10.5, anchor="lm")
    text(draw, 264, height - 32, "完全权限", size=9, color=FAINT, anchor="ra")


def conversation(draw, x0, x1, height):
    draw.rectangle([s(x0), s(28), s(x1), s(height)], fill=(252, 252, 253))
    draw.line([(s(x1), s(28)), (s(x1), s(height))], fill=LINE, width=s(1))
    text(draw, x0 + 20, 46, "模拟器插件开发", size=12, bold=True)
    tabs = ["对话", "轨迹", "上下文", "编队"]
    tx = x0 + 20
    for i, name in enumerate(tabs):
        color = INK if i == 0 else FAINT
        text(draw, tx, 72, name, size=10.5, color=color, bold=(i == 0))
        if i == 0:
            draw.rectangle([s(tx), s(86), s(tx + 22), s(88)], fill=BLUE)
        tx += 44
    draw.line([(s(x0), s(96)), (s(x1), s(96))], fill=LINE, width=s(1))
    # user message
    text(draw, x0 + 20, 116, "你", size=10, color=FAINT, bold=True)
    rounded(draw, (x0 + 20, 132, x1 - 20, 226), 10, fill=(242, 244, 249))
    text(draw, x0 + 34, 146, "把模拟器接进侧边栏：选中设备就能看，", size=11)
    text(draw, x0 + 34, 168, "每个会话独立，点按直接操作。", size=11)
    text(draw, x0 + 34, 198, "设备用 HLK AL10 试一下。", size=11, color=MUTED)
    # assistant
    text(draw, x0 + 20, 246, "DSH", size=10, color=FAINT, bold=True)
    text(draw, x0 + 20, 264, "已接好 scrcpy 的 H.264 流，面板里直接能操作。", size=11)
    text(draw, x0 + 20, 286, "先启动设备：", size=11)
    # tool card
    rounded(draw, (x0 + 20, 306, x1 - 20, 352), 9, fill=PANEL, outline=LINE, width=1)
    draw.ellipse([s(x0 + 32), s(322), s(x0 + 40), s(330)], fill=GREEN)
    text(draw, x0 + 46, 326, "sim_start", size=10.5, bold=True, latin=True, anchor="lm")
    text(draw, x0 + 108, 326, '{"device": "HLK AL10"}', size=9.5, color=MUTED, latin=True, anchor="lm")
    text(draw, x1 - 30, 326, "完成", size=9, color=GREEN, anchor="rm")
    rounded(draw, (x0 + 20, 362, x1 - 20, 408), 9, fill=PANEL, outline=LINE, width=1)
    draw.ellipse([s(x0 + 32), s(378), s(x0 + 40), s(386)], fill=GREEN)
    text(draw, x0 + 46, 382, "sim_status", size=10.5, bold=True, latin=True, anchor="lm")
    text(draw, x0 + 112, 382, "running · 500×1088", size=9.5, color=MUTED, latin=True, anchor="lm")
    text(draw, x1 - 30, 382, "完成", size=9, color=GREEN, anchor="rm")
    text(draw, x0 + 20, 432, "画面已经在右侧面板里了，点按/拖动都能用。", size=11, color=MUTED)
    # composer
    rounded(draw, (x0 + 20, height - 92, x1 - 20, height - 40), 11, fill=PANEL, outline=LINE, width=1)
    text(draw, x0 + 34, height - 66, "发消息或创建任务，/ 调用指令…", size=10.5, color=FAINT, anchor="lm")
    draw.ellipse([s(x1 - 58), s(height - 80), s(x1 - 32), s(height - 54)], fill=BLUE)
    text(draw, x1 - 45, height - 67, "↑", size=12, color=(255, 255, 255), anchor="mm")


def app_window(with_picker=False):
    W, H = 1440, 900
    img = Image.new("RGBA", (s(W), s(H)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    rounded(draw, (0, 0, W, H), 10, fill=PANEL)
    # title bar
    rounded(draw, (0, 0, W, 28), 10, fill=(246, 247, 249))
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        draw.ellipse([s(14 + i * 18), s(10), s(24 + i * 18), s(20)], fill=color)
    text(draw, W / 2, 14, "DeepSeek Harness", size=9.5, color=FAINT, anchor="mm")
    sidebar(draw, 0, H)
    conversation(draw, 280, 820, H)
    # right sidebar
    draw.rectangle([s(820), s(28), s(W), s(H)], fill=PANEL)
    draw.line([(s(820), s(28)), (s(820), s(H))], fill=LINE, width=s(1))
    # tab strip
    tx = 836
    for name, active in [("README.md", False), ("任务管理", False), ("模拟器", True)]:
        w = 84 if name != "README.md" else 92
        if active:
            rounded(draw, (tx - 6, 36, tx + w - 6, 64), 7, fill=(238, 240, 246))
        text(draw, tx + 4, 50, name, size=10, color=INK if active else FAINT, anchor="lm")
        tx += w + 6
    text(draw, W - 92, 50, "+", size=13, color=FAINT, anchor="mm")
    text(draw, W - 60, 50, "⤢", size=11, color=FAINT, anchor="mm")
    text(draw, W - 30, 50, "⌄", size=11, color=FAINT, anchor="mm")
    draw.line([(s(820), s(74)), (s(W), s(74))], fill=LINE, width=s(1))
    # toolbar + stage
    sim_toolbar(img, draw, 820, W - 820, "iPhone 18 Pro", connected=True)
    rounded(draw, (830, 74, W - 10, H - 10), 10, fill=STAGE)
    mock_phone(img, draw, 820 + (W - 820) / 2, 96, 306)
    rounded(draw, (W - 126, H - 52, W - 20, H - 24), 14, fill=(24, 24, 28))
    draw.ellipse([s(W - 114), s(H - 42), s(W - 106), s(H - 34)], fill=GREEN)
    text(draw, W - 98, H - 38, "已连接", size=9.5, color=(255, 255, 255), anchor="lm")
    if with_picker:
        card = (894, 84, 1290, 500)
        soft_shadow(img, card, 12, blur=18, spread=2, alpha=55)
        rounded(draw, card, 12, fill=PANEL, outline=LINE, width=1)
        rounded(draw, (904, 94, 1280, 122), 8, fill=(246, 247, 249), outline=LINE, width=1)
        text(draw, 916, 108, "搜索设备…", size=10.5, color=FAINT, anchor="lm")
        text(draw, 906, 134, "使用过的设备", size=9.5, color=FAINT)
        rows = [("iPhone 18 Pro", "iOS 27.2 · 已停止", True, None),
                ("Pixel 9 Pro", "Android 15 · API 35 · 运行中", False, GREEN)]
        y = 148
        for name, sub, check, dot in rows:
            if check:
                rounded(draw, (902, y, 1282, y + 48), 8, fill=(246, 247, 249))
            if dot:
                draw.ellipse([s(914), s(y + 12), s(920), s(y + 18)], fill=dot)
            text(draw, 926, y + 14, name, size=11)
            text(draw, 926, y + 32, sub, size=9, color=MUTED)
            if check:
                text(draw, 1266, y + 24, "✓", size=11, color=INK, anchor="mm")
            y += 56
        draw.line([(s(906), s(y + 4)), (s(1278), s(y + 4))], fill=(238, 240, 243), width=s(1))
        text(draw, 908, y + 20, "›", size=10, color=FAINT)
        text(draw, 924, y + 21, "此计算机上的其他设备（12）", size=10, color=(120, 126, 138))
    return img.convert("RGB")


def render_icon(size=512):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    top, bottom = (77, 107, 254), (124, 92, 255)
    for y in range(size):
        t = y / (size - 1)
        row = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = row
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # phone outline
    pw, ph = int(size * 0.40), int(size * 0.60)
    x0, y0 = (size - pw) // 2, (size - ph) // 2
    d.rounded_rectangle([x0, y0, x0 + pw, y0 + ph], radius=int(size * 0.085),
                        outline=(255, 255, 255), width=int(size * 0.036))
    # play triangle
    cx, cy = size // 2 + int(size * 0.012), int(size * 0.5)
    tri = int(size * 0.062)
    d.polygon([(cx - tri, cy - tri * 1.35), (cx - tri, cy + tri * 1.35), (cx + tri * 1.3, cy)], fill=(255, 255, 255))
    # live dot
    r = int(size * 0.045)
    dx, dy = x0 + pw - int(size * 0.03), y0 + ph - int(size * 0.03)
    d.ellipse([dx - r, dy - r, dx + r, dy + r], fill=GREEN, outline=(255, 255, 255), width=int(size * 0.012))
    img.save(OUT / "icon.png", optimize=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    app_window(False).save(OUT / "hero.png", optimize=True)
    app_window(True).save(OUT / "device-picker.png", optimize=True)
    render_icon()
    print("rendered:", *(p.name for p in sorted(OUT.glob("*.png"))))
