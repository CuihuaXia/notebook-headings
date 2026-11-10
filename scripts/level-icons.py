#!/usr/bin/env python3
"""Generates media/level-icons.woff: the level shape that VS Code's own icon
font (codicons) does not have. package.json registers the glyph as an icon
(`contributes.icons`), so it can be used like a codicon and takes the level's
theme color.

Glyph (300-unit em, like codicons, whose circle, diamond, triangle and hexagon
are used for the other levels):
    U+E001  filled square, 134 units wide, tuned by eye in the tree next to
            the codicon shapes (a square fills its box: 156 looked much too
            heavy, 124 too small)

Needs fontTools (`pip install fonttools`). Run after changing the shape:
    python3 scripts/level-icons.py

VS Code keeps a loaded icon font until it is restarted: after rebuilding the
font under an unchanged extension version, quit and reopen VS Code (a window
reload is not enough; new glyphs show as blanks until then).
"""
import math
import os

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

EM = 300
C = EM / 2  # glyphs are centered in the em square
OUT = os.path.join(os.path.dirname(__file__), '..', 'media', 'level-icons.woff')


def polygon(points, r):
    """A filled polygon with corners rounded by radius r (points clockwise)."""
    pen = TTGlyphPen(None)
    n = len(points)
    for i, (x, y) in enumerate(points):
        (px, py), (nx, ny) = points[i - 1], points[(i + 1) % n]
        lp, ln = math.hypot(px - x, py - y), math.hypot(nx - x, ny - y)
        a = (round(x + (px - x) * r / lp), round(y + (py - y) * r / lp))
        b = (round(x + (nx - x) * r / ln), round(y + (ny - y) * r / ln))
        (pen.moveTo if i == 0 else pen.lineTo)(a)
        pen.qCurveTo((round(x), round(y)), b)
    pen.closePath()
    return pen.glyph()


def square(side):
    a = side / 2
    return polygon([(C - a, C - a), (C - a, C + a), (C + a, C + a), (C + a, C - a)], 16)


glyphs = {'.notdef': TTGlyphPen(None).glyph(), 'square': square(134)}
fb = FontBuilder(EM, isTTF=True)
fb.setupGlyphOrder(list(glyphs))
fb.setupCharacterMap({0xE001: 'square'})
fb.setupGlyf(glyphs)
# The left side bearing must be the outline's left edge: with 0, VS Code
# (unlike some renderers) draws the glyph shifted left by that much.
fb.setupHorizontalMetrics({name: (EM, getattr(fb.font['glyf'][name], 'xMin', 0)) for name in glyphs})
fb.setupHorizontalHeader(ascent=EM, descent=0)
fb.setupNameTable({'familyName': 'notebook-headings-levels', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=EM, sTypoDescender=0, usWinAscent=EM, usWinDescent=0)
fb.setupPost()
# A fixed date keeps the file identical from run to run.
fb.font['head'].created = fb.font['head'].modified = 0
fb.font.flavor = 'woff'
fb.save(OUT)
print(os.path.relpath(OUT), os.path.getsize(OUT), 'bytes')
