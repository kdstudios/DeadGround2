#!/usr/bin/env python3
"""
Builds assets/sprites/*.png and assets/manifest.json from the five atlas sheets in art/atlas2/:

  terrain.png  ground tiles (outdoor + props + manhole grate)
  ruins.png    concrete wall pieces (used for the enterable building walls)
  urban.png    indoor floors, doors, buildings (skyline), furniture / junk props
  loot.png     item icons
  chars.png    survivor, zombie and SWAT walk cycles (4 directions x 4 frames)

To swap any sprite: drop a PNG with the same name into assets/sprites/ (the game loads whatever the
manifest lists), or edit the picks below and re-run:   python3 tools/build_sprites.py
Requires: Pillow, numpy, scipy.
"""
import json
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
from scipy import ndimage as ndi

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ATLAS = os.path.join(ROOT, 'art', 'atlas2')
OUT = os.path.join(ROOT, 'assets', 'sprites')
T = 64  # tile size in pixels
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith('.png'):
        os.remove(os.path.join(OUT, f))

sprites = {}
groups = {}


def save(img, name, group=None):
    img.save(os.path.join(OUT, name + '.png'))
    sprites[name] = {'src': f'sprites/{name}.png', 'w': img.width, 'h': img.height}
    if group:
        groups.setdefault(group, []).append(name)


def load(name):
    return Image.open(os.path.join(ATLAS, name + '.png')).convert('RGBA')


# ───────────────────────── slicing ─────────────────────────


def components(im, thr=20, minpx=400, dil=3, rowgap=60):
    """Find the separate sprites on a transparent atlas, in reading order."""
    a = np.array(im)[:, :, 3]
    m = a > thr
    lab, _ = ndi.label(ndi.binary_dilation(m, iterations=dil))
    boxes = []
    for i, sl in enumerate(ndi.find_objects(lab)):
        if (m[sl] & (lab[sl] == i + 1)).sum() >= minpx:
            boxes.append((sl[1].start, sl[0].start, sl[1].stop, sl[0].stop))
    boxes.sort(key=lambda b: (b[1] + b[3]) / 2)
    rows = []
    for b in boxes:
        cy = (b[1] + b[3]) / 2
        if rows and abs(rows[-1][0] - cy) < rowgap:
            rows[-1][1].append(b)
        else:
            rows.append([cy, [b]])
    return [b for r in rows for b in sorted(r[1], key=lambda b: b[0])]


def cut(im, box, pad=0):
    return im.crop((box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad))


def trim(im):
    bb = im.split()[3].point(lambda v: 255 if v > 40 else 0).getbbox()
    return im.crop(bb) if bb else im


def fit(im, w, h, bottom=True):
    """Scale to fit inside w x h (keeping aspect) on a transparent canvas, anchored bottom-centre."""
    im = trim(im)
    s = min(w / im.width, h / im.height)
    im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    c = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    c.alpha_composite(im, ((w - im.width) // 2, (h - im.height) if bottom else (h - im.height) // 2))
    return c


def terrain_tiles():
    """12 tile rows of the terrain sheet (opaque image on a pale checker): returns {row: [boxes]}."""
    im = load('terrain').convert('RGB')
    a = np.array(im).astype(int)
    lum = a.mean(2)
    sat = a.max(2) - a.min(2)
    m = ~((lum > 190) & (sat < 25))
    m = ndi.binary_fill_holes(ndi.binary_closing(ndi.binary_opening(m, iterations=2), iterations=3))
    lab, _ = ndi.label(m)
    boxes = []
    for i, sl in enumerate(ndi.find_objects(lab)):
        if (lab[sl] == i + 1).sum() >= 4000:
            boxes.append((sl[1].start, sl[0].start, sl[1].stop, sl[0].stop))
    rows = {}
    for b in boxes:
        cy = (b[1] + b[3]) // 2
        r = 0 if cy < 140 else 1 if cy < 290 else 2 if cy < 420 else 3 if cy < 535 else 4 if cy < 650 else 5 if cy < 780 else 6 if cy < 895 else 7
        w = b[2] - b[0]
        n = 1
        if w > 150 and (b[3] - b[1]) < 125:
            n = max(1, round(w / 118))
        elif (b[3] - b[1]) >= 125 and w > 200:
            n = max(1, round(w / 130))
        for k in range(n):
            rows.setdefault(r, []).append((b[0] + w * k // n, b[1], b[0] + w * (k + 1) // n, b[3]))
    for r in rows:
        rows[r].sort(key=lambda b: b[0])
    return im, rows


# ───────────────────────── helpers ─────────────────────────


def smooth(u):
    u = np.clip(u, 0, 1)
    return u * u * (3 - 2 * u)


def seamless(im):
    """Make a texture tile edge-to-edge: cross-fade it with a half-shifted copy of itself, so the borders
    come from the (continuous) middle of the original. Removes the hard seams between neighbouring tiles."""
    a = np.asarray(im.convert('RGB')).astype(float)
    h, w, _ = a.shape
    rolled = np.roll(np.roll(a, h // 2, axis=0), w // 2, axis=1)
    ux = np.abs(np.linspace(-1, 1, w))
    uy = np.abs(np.linspace(-1, 1, h))
    mx = smooth((1 - ux) * 2.2)
    my = smooth((1 - uy) * 2.2)
    m = (mx[None, :] * my[:, None])[:, :, None]
    out = a * m + rolled * (1 - m)
    return Image.fromarray(out.astype('uint8'), 'RGB').convert('RGBA')


def ground_tile(im, box, inset=15, size=T, seam=False):
    """Square ground tile from the terrain sheet, cropped well inside the dark outline (and the pale
    checker background) so no frame lines bleed through; optionally made seamless."""
    c = im.crop((box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset))
    if seam:
        c = seamless(c)
    return c.resize((size, size), Image.LANCZOS).convert('RGBA')


def tint(im, rgb, amt):
    over = Image.new('RGBA', im.size, rgb + (255,))
    return Image.blend(im.convert('RGBA'), over, amt)


def ss_draw(size, fn, scale=4):
    """Draw with supersampling for smooth shapes."""
    big = Image.new('RGBA', (size * scale, size * scale), (0, 0, 0, 0))
    fn(ImageDraw.Draw(big), scale)
    return big.resize((size, size), Image.LANCZOS)


# ───────────────────────── load atlases ─────────────────────────

ruins = load('ruins')
urban = load('urban')
loot = load('loot')
chars = load('chars')
terrain, trows = terrain_tiles()
rb = components(ruins)
ub = components(urban)
lb = components(loot)
assert len(rb) == 54 and len(ub) == 125 and len(lb) == 68, (len(rb), len(ub), len(lb))
assert [len(trows[i]) for i in range(8)] == [12, 12, 11, 12, 13, 12, 10, 12], [len(trows[i]) for i in range(8)]


def tt(r, c, **kw):
    kw.setdefault('seam', False)
    return ground_tile(terrain, trows[r][c], **kw)


def rot(im, k):
    return im.rotate(90 * k)


# ───────────────────────── ground ─────────────────────────
# Outdoor wasteland: dirt, grass and gravel families (the renderer picks per cell and rotates freely).
DIRT = [(0, 1), (0, 5), (2, 0), (2, 1), (2, 2), (2, 3), (2, 8), (6, 4)]
DARK = [(2, 10), (0, 2)]
GRASS = [(0, 7), (2, 4), (2, 5), (2, 6), (7, 5), (7, 6), (0, 6), (7, 4)]
SPECIAL = [(0, 9), (7, 3), (2, 7)]  # crater, debris, rocks + dead bush (sprinkled sparsely)
for i, (r, c) in enumerate(DIRT):
    save(tt(r, c, seam=True), f'g_dirt{i}', 'ground_dirt')
for i, (r, c) in enumerate(DARK):
    save(tt(r, c, seam=True), f'g_dark{i}', 'ground_dark')
for i, (r, c) in enumerate(GRASS):
    save(tt(r, c, seam=True), f'g_grass{i}', 'ground_grass')
for i, (r, c) in enumerate(SPECIAL):
    save(tt(r, c, seam=(i == 2)), f'g_misc{i}', 'ground_misc')
for i, (r, c) in enumerate([(0, 3), (0, 10), (2, 9)]):
    save(tt(r, c, seam=(i != 2)), f'g_paved{i}', 'ground_paved')

# Covered ("fog") tiles: dark soil with a bevel so unexplored ground clearly reads as covered.
def fog_tile(base, seedn):
    im = base.convert('RGB')
    im = ImageEnhance.Brightness(im).enhance(0.55)
    im = ImageEnhance.Color(im).enhance(0.55)
    im = tint(im.convert('RGBA'), (24, 26, 30), 0.28)
    ov = Image.new('RGBA', (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    d.line([(0, 0), (T - 1, 0)], fill=(150, 150, 140, 150), width=2)
    d.line([(0, 0), (0, T - 1)], fill=(150, 150, 140, 110), width=2)
    d.line([(0, T - 1), (T - 1, T - 1)], fill=(0, 0, 0, 200), width=2)
    d.line([(T - 1, 0), (T - 1, T - 1)], fill=(0, 0, 0, 170), width=2)
    im.alpha_composite(ov)
    return im


for i, (r, c) in enumerate([(2, 10), (6, 2), (0, 9), (2, 2)]):
    save(fog_tile(tt(r, c), i), f'fog{i}', 'fog')

# Indoor floors from the urban sheet: concrete, grey tile, pale tile, wood, checker, carpet, light wood.
FLOORS = [8, 9, 10, 11, 12, 13, 14, 15]
for i, idx in enumerate(FLOORS):
    f = cut(urban, ub[idx])
    f = f.crop((14, 14, f.width - 14, f.height - 14))
    if idx in (8, 13, 14, 15):  # plain textures (no pattern to ghost): make seamless
        f = seamless(f)
    save(f.resize((T, T), Image.LANCZOS).convert('RGBA'), f'floor{i}', 'floor_in')

# ───────────────────────── walls (2.5D, auto-tiled) ─────────────────────────
# Top slab = pale stone tile; front face = strip cut from a ruined concrete wall piece.
FACE_H = 26


def strip(box, x0, x1, y0, y1):
    c = cut(ruins, box).crop((x0, y0, x1, y1)).convert('RGBA')
    return c.resize((T, FACE_H), Image.LANCZOS)


def build_walls(prefix, top_tex, face_tex, group):
    top_tex = ImageEnhance.Brightness(top_tex).enhance(0.9)
    for mask in range(16):  # bits: 1 N, 2 E, 4 S, 8 W  = neighbour is also wall
        n, e, s, w = mask & 1, mask & 2, mask & 4, mask & 8
        tile = top_tex.copy()
        face_top = T if s else T - FACE_H
        if not s:
            tile.paste(face_tex, (0, T - FACE_H))
        ov = Image.new('RGBA', (T, T), (0, 0, 0, 0))  # decorations are blended on top, never pasted raw
        d = ImageDraw.Draw(ov)
        if not s:
            # shadow gradient on the face and the lip between slab and face
            for y in range(FACE_H):
                d.line([(0, T - FACE_H + y), (T, T - FACE_H + y)], fill=(0, 0, 0, int(55 * (y / FACE_H))))
            d.line([(0, face_top), (T, face_top)], fill=(25, 22, 20, 255), width=2)
            d.line([(0, face_top - 2), (T, face_top - 2)], fill=(215, 205, 190, 150), width=1)
            d.line([(0, T - 2), (T, T - 2)], fill=(20, 18, 16, 255), width=2)
        if not n:
            d.line([(0, 0), (T, 0)], fill=(20, 18, 16, 255), width=3)
            d.line([(0, 3), (T, 3)], fill=(220, 210, 195, 120), width=1)
        if not w:
            d.line([(0, 0), (0, T)], fill=(20, 18, 16, 255), width=3)
            d.line([(3, 0), (3, face_top)], fill=(220, 210, 195, 90), width=1)
        if not e:
            d.line([(T - 1, 0), (T - 1, T)], fill=(20, 18, 16, 255), width=3)
            d.line([(T - 4, 0), (T - 4, face_top)], fill=(0, 0, 0, 70), width=1)
        tile.alpha_composite(ov)
        save(tile, f'{prefix}{mask}', group)


build_walls('wall', tt(0, 3), strip(rb[17], 70, 198, 52, 104), 'wall')
def dim(im, f, tint_rgb=(20, 24, 34), amt=0.18):
    return tint(ImageEnhance.Brightness(im.convert('RGBA')).enhance(f), tint_rgb, amt)


# Map boundary: dark, cold, heavy concrete so the edge of the world reads as a boundary.
build_walls('bwall', dim(tt(0, 0), 0.62), dim(strip(rb[17], 70, 198, 52, 104), 0.42), 'bwall')
build_walls('ruinwall', ImageEnhance.Brightness(tt(0, 4)).enhance(0.8), strip(rb[49], 120, 248, 70, 122), 'ruinwall')


def overlay_door():
    d = cut(urban, ub[37])
    d = fit(d, 46, 62)
    # padlock
    px, py = 32, 38
    dr = ImageDraw.Draw(d)
    dr.arc([px - 5, py - 9, px + 5, py + 1], 180, 360, fill=(20, 20, 20, 255), width=2)
    dr.rounded_rectangle([px - 6, py - 1, px + 6, py + 9], 2, fill=(235, 190, 40, 255), outline=(20, 20, 20, 255), width=2)
    dr.ellipse([px - 1, py + 2, px + 1, py + 4], fill=(30, 30, 30, 255))
    return d


save(overlay_door(), 'ov_door')
save(fit(cut(urban, ub[32]), 50, 62), 'ov_barricade')


def overlay_crack():
    base = Image.new('RGBA', (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    rnd = random.Random(7)
    for start in [(32, 4), (20, 8), (44, 10)]:
        x, y = start
        pts = [(x, y)]
        for _ in range(6):
            x += rnd.randint(-7, 7)
            y += rnd.randint(5, 9)
            pts.append((x, y))
        d.line(pts, fill=(15, 12, 10, 235), width=3)
        d.line([(px + 1, py) for px, py in pts], fill=(200, 190, 170, 110), width=1)
    rub = fit(cut(ruins, rb[46]), 58, 26)
    base.alpha_composite(rub, (3, 38))
    return base


save(overlay_crack(), 'ov_crack')

# ───────────────────────── objects ─────────────────────────
save(fit(cut(loot, lb[33]), 52, 40, bottom=False).resize((52, 40)), 'obj_mine_raw')
mine = Image.new('RGBA', (T, T), (0, 0, 0, 0))
mine.alpha_composite(fit(cut(loot, lb[33]), 54, 54, bottom=False), (5, 7))
save(mine, 'obj_mine')
os.remove(os.path.join(OUT, 'obj_mine_raw.png'))
sprites.pop('obj_mine_raw')


def crater():
    base = tt(6, 7).resize((T, T))
    mask = Image.new('L', (T, T), 0)
    ImageDraw.Draw(mask).ellipse([5, 8, 59, 58], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(3))
    out = Image.new('RGBA', (T, T), (0, 0, 0, 0))
    out.paste(ImageEnhance.Brightness(base).enhance(0.8), (0, 0), mask)
    return out


save(crater(), 'obj_crater')


def manhole():
    """An open manhole, cover slid aside and left ajar: concrete collar, black shaft with a ladder and a
    faint glow, and the round iron lid resting half across it."""
    S = 4
    N = T * S
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy, R = 28 * S, 38 * S, 24 * S

    def circle(dr, x, y, r, **kw):
        dr.ellipse([x - r, y - r, x + r, y + r], **kw)

    # ground shadow + collar
    sh = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    circle(ImageDraw.Draw(sh), cx + 2 * S, cy + 4 * S, R + 2 * S, fill=(0, 0, 0, 110))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(3 * S)))
    d = ImageDraw.Draw(img)
    circle(d, cx, cy, R, fill=(24, 22, 20, 255))
    collar = tt(0, 10).resize((N, N), Image.LANCZOS)
    cm = Image.new('L', (N, N), 0)
    circle(ImageDraw.Draw(cm), cx, cy, R - 2 * S, fill=255)
    img.paste(ImageEnhance.Brightness(collar).enhance(0.8), (0, 0), cm)
    # shaft
    shaft = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shaft)
    r = R - 6 * S
    circle(sd, cx, cy, r, fill=(6, 8, 8, 255))
    for k in range(10):  # faint glow rising from below
        rr = int(r * (1 - k * 0.07))
        circle(sd, cx - 3 * S, cy + 4 * S, rr, fill=(60 + k * 9, 120 + k * 9, 70 + k * 3, 22))
    # ladder
    for x in (cx - 9 * S, cx + 1 * S):
        sd.line([(x, cy - r + 3 * S), (x, cy + r - 3 * S)], fill=(150, 150, 140, 255), width=2 * S)
    for y in range(cy - r + 7 * S, cy + r - 4 * S, 7 * S):
        sd.line([(cx - 9 * S, y), (cx + 1 * S, y)], fill=(170, 165, 150, 255), width=2 * S)
    sm = Image.new('L', (N, N), 0)
    circle(ImageDraw.Draw(sm), cx, cy, r, fill=255)
    shaft.putalpha(Image.composite(shaft.split()[3], Image.new('L', (N, N), 0), sm))
    img.alpha_composite(shaft)
    d = ImageDraw.Draw(img)
    circle(d, cx, cy, r, outline=(10, 10, 10, 255), width=2 * S)
    circle(d, cx, cy, R, outline=(14, 12, 10, 255), width=2 * S)
    # lid, slid up and to the right
    lx, ly, lr = 42 * S, 24 * S, 18 * S
    ls = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    circle(ImageDraw.Draw(ls), lx + 2 * S, ly + 4 * S, lr, fill=(0, 0, 0, 140))
    img.alpha_composite(ls.filter(ImageFilter.GaussianBlur(2 * S)))
    plate = ground_tile(terrain, trows[7][8], inset=14, size=N)
    lm = Image.new('L', (N, N), 0)
    circle(ImageDraw.Draw(lm), lx, ly, lr, fill=255)
    lid = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    lid.paste(ImageEnhance.Brightness(plate).enhance(0.85), (0, 0), lm)
    d = ImageDraw.Draw(lid)
    circle(d, lx, ly, lr, outline=(12, 12, 14, 255), width=2 * S)
    circle(d, lx, ly, lr - 4 * S, outline=(150, 160, 175, 120), width=S)
    d.arc([lx - lr + 3 * S, ly - lr + 3 * S, lx + lr - 3 * S, ly + lr - 3 * S], 200, 290, fill=(235, 240, 250, 190), width=2 * S)
    for ang in range(0, 360, 60):  # rivets
        a_ = np.radians(ang)
        circle(d, lx + int(np.cos(a_) * (lr - 7 * S)), ly + int(np.sin(a_) * (lr - 7 * S)), int(1.3 * S), fill=(40, 42, 48, 255))
    img.alpha_composite(lid)
    return img.resize((T, T), Image.LANCZOS)


save(manhole(), 'obj_exit')

# ───────────────────────── props (blocking rubble & junk placed on open ground) ─────────────────────────
PROPS_OUT = [
    ('rubble0', cut(ruins, rb[40])), ('rubble1', cut(ruins, rb[41])), ('rubble2', cut(ruins, rb[42])),
    ('rubble3', cut(ruins, rb[43])), ('rubble4', cut(ruins, rb[45])), ('rubble5', cut(ruins, rb[46])),
    ('rubble6', cut(ruins, rb[44])),
    ('sandbags', cut(ruins, rb[37])), ('barrier0', cut(ruins, rb[38])), ('barrier1', cut(ruins, rb[39])),
    ('boulder', terrain.convert('RGBA').crop(trows[5][1])), ('rocks0', terrain.convert('RGBA').crop(trows[5][2])),
    ('rocks1', terrain.convert('RGBA').crop(trows[5][5])), ('debris0', terrain.convert('RGBA').crop(trows[5][3])),
    ('debris1', terrain.convert('RGBA').crop(trows[5][4])),
    ('crate', cut(urban, ub[104])), ('barrel0', cut(urban, ub[84])), ('barrel1', cut(urban, ub[85])),
    ('barrel2', cut(urban, ub[108])), ('tire', cut(urban, ub[107])), ('bin', cut(urban, ub[98])),
    ('planks', cut(urban, ub[115])), ('stump', terrain.convert('RGBA').crop(trows[5][8])),
]


def clean_terrain_prop(im):
    """Terrain-sheet props sit on the pale checker: key it out."""
    a = np.array(im.convert('RGBA')).astype(int)
    lum = a[:, :, :3].mean(2)
    sat = a[:, :, :3].max(2) - a[:, :, :3].min(2)
    bgm = (lum > 185) & (sat < 28)
    bgm = ndi.binary_opening(bgm, iterations=1)
    lab, n = ndi.label(bgm)
    # only background connected to the border
    edge = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    kill = np.isin(lab, [e for e in edge if e != 0])
    a[:, :, 3] = np.where(kill, 0, 255)
    return Image.fromarray(a.astype('uint8'), 'RGBA')


for name, im in PROPS_OUT:
    if name in ('boulder', 'rocks0', 'rocks1', 'debris0', 'debris1', 'stump'):
        im = clean_terrain_prop(im)
    save(fit(im, 62, 58), f'prop_{name}', 'prop_out')
for i, (r, c) in enumerate([(5, 6), (5, 7)]):
    im = clean_terrain_prop(terrain.convert('RGBA').crop(trows[r][c]))
    save(fit(im, 62, 58), f'prop_bush{i}', 'prop_out')

# Furniture: walkable flavour drawn on building floors (never blocks, never hides a clue)
FURN = [52, 53, 54, 55, 56, 57, 59, 60, 62, 63, 64, 65, 66, 70, 73, 75, 76, 77, 78, 79, 80, 82, 86, 87, 89, 90, 91, 92, 93, 95, 97, 99]
for idx in FURN:
    save(fit(cut(urban, ub[idx]), 58, 56), f'furn{idx}', 'furniture')

# Backdrop decor for the area beyond the map edge
DECOR = [
    ('tree_dead', cut(urban, ub[123])), ('bush', cut(urban, ub[124])), ('tent', cut(urban, ub[117])),
    ('crates', cut(urban, ub[116])), ('barrel', cut(urban, ub[118])), ('rubble_big', cut(urban, ub[112])),
    ('rubble_big2', cut(urban, ub[111])), ('flag', cut(urban, ub[122])),
]
for name, im in DECOR:
    save(trim(im).resize((round(trim(im).width * 0.55), round(trim(im).height * 0.55)), Image.LANCZOS), f'decor_{name}', 'decor')
save(fit(clean_terrain_prop(terrain.convert('RGBA').crop((1170, 640, 1300, 770))), 110, 110), 'decor_tree', 'decor')

# Skyline buildings (top of the level)
for i in range(8):
    im = trim(cut(urban, ub[i]))
    s = 0.85
    save(im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS), f'bld{i}', 'buildings')

# ───────────────────────── items ─────────────────────────
ITEMS = {'ammo': 23, 'crowbar': 42, 'explosive': 32, 'food': 2, 'key': 65, 'map': 66, 'materials': 50,
         'medkit': 10, 'scrap': 48}
for name, idx in ITEMS.items():
    save(fit(cut(loot, lb[idx]), T, T, bottom=False), f'item_{name}')


def shield_icon(size=T):
    def draw(d, s):
        W = size * s
        pts = [(0.5, 0.06), (0.9, 0.2), (0.88, 0.55), (0.5, 0.94), (0.12, 0.55), (0.1, 0.2)]
        P = [(x * W, y * W) for x, y in pts]
        d.polygon(P, fill=(30, 30, 34, 255))
        inner = [(0.5, 0.12), (0.84, 0.24), (0.82, 0.54), (0.5, 0.86), (0.18, 0.54), (0.16, 0.24)]
        d.polygon([(x * W, y * W) for x, y in inner], fill=(70, 120, 175, 255))
        left = [(0.5, 0.12), (0.16, 0.24), (0.18, 0.54), (0.5, 0.86)]
        d.polygon([(x * W, y * W) for x, y in left], fill=(95, 150, 205, 255))
        d.line([(0.5 * W, 0.14 * W), (0.5 * W, 0.84 * W)], fill=(35, 55, 85, 255), width=2 * s)
        d.line([(0.2 * W, 0.34 * W), (0.8 * W, 0.34 * W)], fill=(35, 55, 85, 255), width=2 * s)
        for (x, y) in [(0.28, 0.26), (0.72, 0.26)]:
            d.ellipse([(x - 0.03) * W, (y - 0.03) * W, (x + 0.03) * W, (y + 0.03) * W], fill=(200, 215, 230, 255))
    return ss_draw(size, draw)


def heart_icon(size=T):
    def draw(d, s):
        W = size * s
        def hp(scale, dy=0):
            c = W / 2
            pts = []
            for i in range(0, 361, 4):
                t = np.radians(i)
                x = 16 * np.sin(t) ** 3
                y = -(13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t))
                pts.append((c + x * scale * W / 40, c + (y + 1.5) * scale * W / 40 + dy))
            return pts
        d.polygon(hp(1.08), fill=(30, 12, 14, 255))
        d.polygon(hp(0.93), fill=(200, 38, 48, 255))
        d.ellipse([W * 0.26, W * 0.24, W * 0.4, W * 0.36], fill=(255, 150, 150, 220))
    return ss_draw(size, draw)


save(shield_icon(), 'item_shield')
save(shield_icon(), 'ui_shield')
save(heart_icon(), 'ui_heart')
def flag_icon(size=T):
    def draw(d, s_):
        W = size * s_
        k = W / 64
        # pole
        d.rounded_rectangle([14 * k, 6 * k, 19 * k, 60 * k], 2 * k, fill=(28, 24, 22, 255))
        d.rounded_rectangle([15 * k, 7 * k, 17.5 * k, 59 * k], 1 * k, fill=(120, 108, 96, 255))
        d.ellipse([12.5 * k, 3 * k, 20.5 * k, 11 * k], fill=(28, 24, 22, 255))
        d.ellipse([14 * k, 4.5 * k, 19 * k, 9.5 * k], fill=(230, 190, 60, 255))
        # waving cloth
        top = [(19 * k + i * 1.0 * k, (9 + 2.2 * np.sin(i / 5.2)) * k) for i in range(0, 41)]
        bot = [(19 * k + i * 1.0 * k, (33 + 2.2 * np.sin(i / 5.2)) * k) for i in range(40, -1, -1)]
        d.polygon(top + bot, fill=(24, 8, 8, 255))
        top2 = [(20.5 * k + i * 0.93 * k, (11 + 2.2 * np.sin(i / 5.2)) * k) for i in range(0, 40)]
        bot2 = [(20.5 * k + i * 0.93 * k, (31 + 2.2 * np.sin(i / 5.2)) * k) for i in range(39, -1, -1)]
        d.polygon(top2 + bot2, fill=(206, 34, 34, 255))
        # shading folds and highlight
        for fx in (12, 24, 36):
            fold = [(19 * k + fx * k, (11 + 2.2 * np.sin(fx / 5.2)) * k), (19 * k + (fx + 4) * k, (11 + 2.2 * np.sin((fx + 4) / 5.2)) * k),
                    (19 * k + (fx + 4) * k, (31 + 2.2 * np.sin((fx + 4) / 5.2)) * k), (19 * k + fx * k, (31 + 2.2 * np.sin(fx / 5.2)) * k)]
            d.polygon(fold, fill=(150, 20, 24, 255))
        d.line([(21 * k, 13 * k), (21 * k + 14 * k, 13 * k + 1.5 * k)], fill=(255, 130, 120, 255), width=int(1.6 * k))
    return ss_draw(size, draw)


save(flag_icon(), 'ui_flag')

# ───────────────────────── characters ─────────────────────────
cb = components(chars, minpx=600, dil=4, rowgap=70)
assert len(cb) == 48, len(cb)
# Three groups of 4 columns x 4 rows (down, up, left, right).
by_group = [[], [], []]
W = chars.width
for b in cb:
    by_group[min(2, int(((b[0] + b[2]) / 2) / (W / 3)))].append(b)
DIRS = ['down', 'up', 'left', 'right']


def character(prefix, boxes, target_h):
    assert len(boxes) == 16, (prefix, len(boxes))
    boxes.sort(key=lambda b: ((b[1] + b[3]) / 2) // 120)
    rows = [sorted(boxes[r * 4:(r + 1) * 4], key=lambda b: b[0]) for r in range(4)]
    ref = max(b[3] - b[1] for b in boxes)
    scale = target_h / ref
    for r, d in enumerate(DIRS):
        for c, b in enumerate(rows[r]):
            im = cut(chars, b)
            alpha = np.array(im)[:, :, 3].astype(float)
            ys, xs = np.nonzero(alpha > 40)
            cx = (xs * alpha[ys, xs]).sum() / alpha[ys, xs].sum()
            bottom = ys.max()
            im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
            cxs, bs = cx * scale, bottom * scale
            canvas = Image.new('RGBA', (T, T), (0, 0, 0, 0))
            canvas.alpha_composite(im, (round(T / 2 - cxs), round(T - 3 - bs)))
            save(canvas, f'{prefix}_{d}_{c}')


character('player', by_group[0], 58)
character('zombie', by_group[1], 58)
character('swat', by_group[2], 62)


# ── minigame art (lock + terminal), cut by name from the minigame atlas ──
_mg = Image.open(os.path.join(ROOT, 'art', 'atlas2', 'minigame.png')).convert('RGBA')
_mgj = json.load(open(os.path.join(ROOT, 'art', 'atlas2', 'minigame.json')))


def mg(name):
    sp = _mgj['sprites'][_mgj['names'][name]]
    return _mg.crop((sp['x'], sp['y'], sp['x'] + sp['w'], sp['y'] + sp['h']))


# native size (the minigame screens scale them); names are what the UI looks up
for out, name in [('mg_plate0', 'lock.0'), ('mg_plate1', 'lockplate.0'), ('mg_plate2', 'lock.1'), ('mg_plate3', 'lockplate.1'),
                  ('mg_plate4', 'lockplate.2'), ('mg_cylinder', 'cylinder'), ('mg_pick', 'pickpin'), ('mg_pickbroken', 'pick.broken'),
                  ('mg_chest', 'iso.chest'), ('mg_desk', 'iso.desk'), ('mg_computer', 'computer'), ('mg_lockout', 'screen.lockout')]:
    save(mg(name), out, 'minigame')

# little icons for the vault door on the map
def door_icon(name, size):
    im = mg(name)
    im.thumbnail((size, size), Image.LANCZOS)
    return im


save(door_icon('lock.0', 30), 'mg_icon_lock', 'minigame')
save(door_icon('computer', 34), 'mg_icon_term', 'minigame')

json.dump({'tile': T, 'sprites': sprites, 'groups': groups}, open(os.path.join(ROOT, 'assets', 'manifest.json'), 'w'), indent=1)
print(f'{len(sprites)} sprites -> {OUT}')
for g, v in groups.items():
    print(f'  {g}: {len(v)}')
