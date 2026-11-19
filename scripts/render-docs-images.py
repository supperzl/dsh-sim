#!/usr/bin/env python3
"""Render the repository icon at docs/images/icon.png (512x512).

The README screenshots in docs/images are real captures of the DSH desktop app
(see docs/images/README.md); only the icon is generated here.

    python3 scripts/render-docs-images.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"

BLUE = (77, 107, 254)
PURPLE = (124, 92, 255)
GREEN = (34, 197, 94)


def render_icon(size=512):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # vertical gradient clipped to a rounded square
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    for y in range(size):
        t = y / (size - 1)
        row = tuple(int(BLUE[i] + (PURPLE[i] - BLUE[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = row
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    pw, ph = int(size * 0.40), int(size * 0.60)
    x0, y0 = (size - pw) // 2, (size - ph) // 2
    d.rounded_rectangle([x0, y0, x0 + pw, y0 + ph], radius=int(size * 0.085),
                        outline=(255, 255, 255), width=int(size * 0.036))
    cx, cy = size // 2 + int(size * 0.012), int(size * 0.5)
    tri = int(size * 0.062)
    d.polygon([(cx - tri, cy - tri * 1.35), (cx - tri, cy + tri * 1.35), (cx + tri * 1.3, cy)],
              fill=(255, 255, 255))
    r = int(size * 0.045)
    dx, dy = x0 + pw - int(size * 0.03), y0 + ph - int(size * 0.03)
    d.ellipse([dx - r, dy - r, dx + r, dy + r], fill=GREEN, outline=(255, 255, 255),
              width=int(size * 0.012))
    img.save(OUT / "icon.png", optimize=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    render_icon()
    print("rendered: icon.png")
