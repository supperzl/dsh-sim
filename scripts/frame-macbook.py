#!/usr/bin/env python3
"""Frame a DSH window screenshot in a MacBook-style mockup for the README.

    python3 scripts/frame-macbook.py <screenshot.png> <out.png>

Draws a black-bezel lid with a camera notch and an aluminium base, with a soft
shadow, on a transparent background. The window becomes the screen 1:1.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SS = 2  # supersample for smooth bezel/base edges


def s(v):
    return int(round(v * SS))


def main(src: Path, dst: Path):
    shot = Image.open(src).convert("RGBA")
    # drop the window-capture shadow margin (keep the opaque window)
    solid = shot.split()[3].point(lambda v: 255 if v >= 250 else 0).getbbox()
    if solid:
        shot = shot.crop(solid)
    sw, sh = shot.size

    pad = 26          # bezel around the screen
    lid_w, lid_h = sw + pad * 2, sh + pad * 2
    base_extra = 56   # base sticks out on both sides
    base_h = 52
    gap = 6
    mx, top, bottom = 90, 54, 120

    canvas_w = lid_w + base_extra * 2 + mx * 2
    canvas_h = top + lid_h + gap + base_h + bottom

    img = Image.new("RGBA", (s(canvas_w), s(canvas_h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    lid_x, lid_y = mx + base_extra, top
    # shadow
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        [s(lid_x - 20), s(lid_y - 10), s(lid_x + lid_w + 20), s(lid_y + lid_h + gap + base_h + 10)],
        radius=s(46), fill=(15, 23, 42, 70),
    )
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(s(26))))

    # base
    base_x = lid_x - base_extra
    base_y = lid_y + lid_h + gap
    base_w = lid_w + base_extra * 2
    d.rounded_rectangle([s(base_x), s(base_y), s(base_x + base_w), s(base_y + base_h)],
                        radius=s(18), fill=(196, 199, 206, 255))
    d.rounded_rectangle([s(base_x + 8), s(base_y), s(base_x + base_w - 8), s(base_y + 20)],
                        radius=s(10), fill=(224, 226, 231, 255))
    d.rounded_rectangle([s(base_x + base_w / 2 - 90), s(base_y - 2), s(base_x + base_w / 2 + 90), s(base_y + 8)],
                        radius=s(6), fill=(170, 173, 181, 255))

    # lid
    d.rounded_rectangle([s(lid_x), s(lid_y), s(lid_x + lid_w), s(lid_y + lid_h)],
                        radius=s(30), fill=(13, 13, 16, 255), outline=(46, 46, 54, 255), width=s(1.5))

    # screen (rounded mask) with the screenshot
    screen = shot.resize((s(sw), s(sh)), Image.LANCZOS)
    mask = Image.new("L", screen.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, screen.size[0] - 1, screen.size[1] - 1],
                                           radius=s(10), fill=255)
    img.paste(screen, (s(lid_x + pad), s(lid_y + pad)), mask)

    out = img.resize((canvas_w, canvas_h), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst, optimize=True)
    print(f"framed {src.name} -> {dst} ({out.size[0]}x{out.size[1]})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: frame-macbook.py <screenshot.png> <out.png>")
    main(Path(sys.argv[1]), Path(sys.argv[2]))
