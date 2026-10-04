#!/usr/bin/env python3
"""Generate the Hyperion-RAIN app icon (data/icons/*.svg).

Style after Arknights' "Bloodline of Combat" mark: a tall solid block with the kanji cut out of it as
hard-edged, 45-degree geometry (strokes bleed off the block edges), and a light Latin word laid across the
block's lower-left edge, filled outside the block and outlined inside it.

Here the kanji is 雨, built by hand from polygons (no font), its four dots drawn as parallel rain slashes,
and the word is "rain" (Noto Sans Light outlines, so the SVG needs no fonts).

Needs fontTools + Noto Sans Light. The SVGs are committed; run this only to change them:
    python3 tools/make-icon.py && ninja -C build
"""
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT = "/usr/share/fonts/noto/NotoSans-Light.ttf"
OUT = Path(__file__).resolve().parent.parent / "data" / "icons"
ACCENT = "#4c90f0"   # the panel's accent

# The block, in icon coordinates (512 x 512).
BX, BY, BW, BH = 188, 28, 296, 456
T = 46               # stroke weight

# 雨 in block coordinates (0..BW, 0..BH). Anything past the edges merges with the background.
OUTSIDE = 40
KANJI = [
    # 一 top bar, 45-degree cut on the left, runs off the right edge
    [(26 + T, 22), (BW + OUTSIDE, 22), (BW + OUTSIDE, 22 + T), (26, 22 + T)],
    # centre stroke, from the bar down through the box and out the bottom
    [(125, 22 + T - 1), (125 + T, 22 + T - 1), (125 + T, BH + OUTSIDE), (125, BH + OUTSIDE)],
    # 冂 left side, out the bottom
    [(16, 120 + 24), (16 + T, 120 + 24), (16 + T, BH + OUTSIDE), (16, BH + OUTSIDE)],
    # 冂 top, its outer corner cut at 45 degrees like the bar
    [(16 + 24, 120), (BW - 16, 120), (BW - 16, 120 + T), (16, 120 + T), (16, 120 + 24)],
    # 冂 right side ending in a hook that sweeps down-left
    [(BW - 16 - T, 120), (BW - 16, 120), (BW - 16, 392), (BW - 16 - 58, 392 + 58),
     (BW - 16 - 58 - T, 392 + 58), (BW - 16 - T, 392 + 58 - T - 12)],
]
# the four dots: rain slashes falling down-right, two in each half of the box
SLASH_W, SLASH_DROP = 36, 58


def slash(x, y):
    return [(x, y), (x + SLASH_W, y), (x + SLASH_W + SLASH_DROP, y + SLASH_DROP), (x + SLASH_DROP, y + SLASH_DROP)]


LEFT_IN = (16 + T, 125)
RIGHT_IN = (125 + T, BW - 16 - T)
DOTS = [slash(LEFT_IN[0] + 6, 206), slash(LEFT_IN[0] + 6, 300), slash(RIGHT_IN[0] + 6, 206)]
DROP = slash(RIGHT_IN[0] + 6, 300)   # the last dot, in the accent colour

# the word
WORD, WORD_SIZE, WORD_X, WORD_BASE = "rain", 150, 40, 438


def poly(pts, dx=BX, dy=BY):
    return "M" + "L".join(f"{x + dx:.1f} {y + dy:.1f}" for x, y in pts) + "Z"


def word_path():
    font = TTFont(FONT)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    s = WORD_SIZE / font["head"].unitsPerEm
    sp = SVGPathPen(gs)
    x = WORD_X
    for ch in WORD:
        name = cmap[ord(ch)]
        gs[name].draw(TransformPen(sp, (s, 0, 0, -s, x, WORD_BASE)))
        x += gs[name].width * s
    return sp.getCommands()


def icon(tile, block, cut):
    d_kanji = "".join(poly(p) for p in KANJI + DOTS)
    d_word = word_path()
    block_rect = f'x="{BX}" y="{BY}" width="{BW}" height="{BH}"'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <clipPath id="in"><rect {block_rect}/></clipPath>
    <clipPath id="out"><path clip-rule="evenodd" d="M0 0H512V512H0Z M{BX} {BY}h{BW}v{BH}h-{BW}Z"/></clipPath>
  </defs>
  <rect width="512" height="512" fill="{tile}"/>
  <rect {block_rect} fill="{block}"/>
  <path fill="{cut}" d="{d_kanji}"/>
  <path fill="{ACCENT}" clip-path="url(#in)" d="{poly(DROP)}"/>
  <path fill="{block}" clip-path="url(#out)" d="{d_word}"/>
  <path fill="{block}" stroke="{cut}" stroke-width="3" stroke-linejoin="round" clip-path="url(#in)" d="{d_word}"/>
</svg>
'''


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "hyperion-rain.svg").write_text(icon("#f2f2f2", "#000000", "#f2f2f2"))
    (OUT / "hyperion-rain-dark.svg").write_text(icon("#000000", "#f2f2f2", "#000000"))
    print("wrote", *sorted(p.name for p in OUT.glob("*.svg")))
