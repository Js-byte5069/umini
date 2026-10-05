"""Blender (bpy) ground-dressing props: wrecked-civilisation debris that lies half buried in the snow (src/dressing.js places them).
Run:  PYTHONDONTWRITEBYTECODE=1 python3 gen_debris.py [names...]  ->  ../assets/debris.glb      (objects named  {prop}{variant}_l{lod}_{mat})
Deterministic (seeded per prop / variant).  Names rebuild only those props, the others come from the dev cache ($TMPDIR/eden_dcache).
Look at the props in the game with  ?galleryonly&gallery=x,z,scale,perRow,skip&cam=...  (src/dressing.js lays one of every piece out in a row).

Every prop is authored with its footprint centre at the origin, y up, ground plane at y = 0 and the buried part reaching down to y = -0.4
(everything below that is cut away: no hidden geometry).  Three LODs: 0 (< 32 m in game: bevelled, panel detailed, baked AO + edge wear),
1 (32-90 m: the readable silhouette + the main panel), 2 (beyond 90 m: block-out).  COLOR_0 = (baked AO, edge wear 0.5 neutral .. 1 convex, 0, 1).
Materials by name suffix: wall, wallLight, wallDark, trim, metal, accent, accentDark, deck, glass, snow (modelled snow caps).
The GLB also carries the catalogue (footprint extents, collider boxes, bank / burial hints, tags) in glTF asset.extras: the game reads it, so the
generator is the single source of truth for dimensions.

Prop families (variants in brackets): wallseg (5 broken wall runs, bays, windows, corner), arch (2 half arches + fallen voussoirs), column
(fallen drums, broken stub), slab (A-frame toppled slabs, facade chunk with window grid), truss (collapsed catwalk), pipes (run with elbow, bundle),
tank (half shell, dome cap), crate (stacks, container end), gear (toothed wheel), crane (lattice boom), hulk (tracked crawler wreck), stairs,
lamp (bent post), pylon (signal tower), barrier (jersey barrier, bollards), pile (ice-crusted rubble heap), spool (cable reel), hoop (ring segment), panels
(leaning orange plates), chunk (bevelled concrete rubble pieces), lowwall (knee-high wall remnants), beams (fallen girders),
plate (deck plates, hatch, grating), gravel (stone fans, 5-13 chunky faceted stones with decreasing size), scrap (flat slab, rails, bent cladding, cable coil).
"""
import sys
sys.dont_write_bytecode = True
import os, math, random, json, struct, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix
import gen_buildings as G
from gen_buildings import Mod, MI, TAU, UP, finalize, clamp, lerp, circle_pts, tube, torus, snow_poly

OUT = os.environ.get('DEBRIS_OUT') or os.path.join(HERE, '..', 'assets', 'debris.glb')
CUT_Y = -0.42          # everything below is removed (buried, never seen)


# ═════════════════════════════════════════════════ helpers ═════════════════════════════════════════════════
def ru(rnd, a, b): return a + (b - a) * rnd.random()


def prism_xy(M, P, z0, z1, mat, bev=0.0, seg=1):
    """extrude a polygon given as (x, y) points along z in [z0, z1]; any winding, concave allowed. Returns the faces."""
    area = sum(P[i][0] * P[(i + 1) % len(P)][1] - P[(i + 1) % len(P)][0] * P[i][1] for i in range(len(P)))
    if area < 0: P = list(reversed(P))
    bm = M.bm
    a = [bm.verts.new((x, y, z0)) for x, y in P]
    b = [bm.verts.new((x, y, z1)) for x, y in P]
    fs = []
    n = len(P)
    for i in range(n):
        j = (i + 1) % n
        try: fs.append(bm.faces.new((a[i], a[j], b[j], b[i])))
        except ValueError: pass
    for vs in (list(reversed(a)), b):
        try: fs.append(bm.faces.new(vs))
        except ValueError: pass
    for f in fs: f.material_index = MI[mat]
    for f in fs: f.normal_update()
    if bev > 0: M._bevel(fs, bev, seg)
    return fs


def prism_xz(M, P, y0, y1, mat, bev=0.0, seg=1):
    """extrude a plan polygon (x, z) between y0 and y1 (any winding)"""
    return M.prism([(x, z) for x, z in P] if _ccw_xz(P) else list(reversed([(x, z) for x, z in P])), y0, y1, mat, top=True, bottom=True, bev=bev, seg=seg)


def _ccw_xz(P):
    area = sum(P[i][0] * P[(i + 1) % len(P)][1] - P[(i + 1) % len(P)][0] * P[i][1] for i in range(len(P)))
    return area > 0


def sub(M_, xf, fn):
    """build into a scratch Mod with fn(S), then merge it transformed by xf (a Matrix) into M_"""
    S = Mod()
    fn(S)
    M_.merge(S, xf)
    S.free()


def T(x=0, y=0, z=0, rx=0, ry=0, rz=0):
    return Matrix.Translation((x, y, z)) @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X') @ Matrix.Rotation(rz, 4, 'Z')


def beam_box(M, a, b, w, h, mat, bev=0.03, up=None):
    return M.beam(a, b, w, h, mat, up=up, bev=bev, seg=1)


def rod(M, a, b, r, mat, seg=8, caps=True):
    tube(M, a, b, r, mat, seg, caps)


def cyl_x(M, cx, cy, cz, L, r, mat, seg=16, bev=0.0, r1=None, cap0=True, cap1=True):
    """cylinder along x from cx-L/2 to cx+L/2 (radius r, r1 at +x end)"""
    r1 = r if r1 is None else r1
    ring = lambda x, rr: [(x, cy + rr * math.sin(TAU * i / seg), cz + rr * math.cos(TAU * i / seg)) for i in range(seg)]
    return M.loft([ring(cx - L / 2, r), ring(cx + L / 2, r1)], mat, cap0=cap0, cap1=cap1, up=Vector((1, 0, 0)), orient=1, bev=bev, seg=1)


def cyl_z(M, cx, cy, cz, L, r, mat, seg=16, bev=0.0, r1=None, cap0=True, cap1=True):
    r1 = r if r1 is None else r1
    ring = lambda z, rr: [(cx + rr * math.cos(TAU * i / seg), cy + rr * math.sin(TAU * i / seg), z) for i in range(seg)]
    return M.loft([ring(cz - L / 2, r), ring(cz + L / 2, r1)], mat, cap0=cap0, cap1=cap1, up=Vector((0, 0, 1)), orient=1, bev=bev, seg=1)


def cyl_y(M, cx, cy, cz, H, r, mat, seg=16, bev=0.0, r1=None, cap0=True, cap1=True, rz=None):
    r1 = r if r1 is None else r1
    return M.frustum((cx, cy + H / 2, cz), r, r1, H, mat, seg=seg, cap0=cap0, cap1=cap1, bev=bev, rzs=1.0 if rz is None else rz / r)


def chunk(M, c, s, mat, rnd, jit=0.16, bev=0.08, rot=None, seg=1):
    """a chunky broken-concrete piece: a box whose corners are jittered, then bevelled (reads as a fragment, not a crate)"""
    bm = M.bm
    v = bmesh.ops.create_cube(bm, size=1.0)['verts']
    for x in v:
        x.co = Vector(((x.co.x + ru(rnd, -jit, jit)) * s[0], (x.co.y + ru(rnd, -jit, jit)) * s[1], (x.co.z + ru(rnd, -jit, jit)) * s[2]))
    faces = list(dict.fromkeys(f for x in v for f in x.link_faces))
    for f in faces: f.material_index = MI[mat]
    if rot:
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(rot[1], 3, 'Y') @ Matrix.Rotation(rot[0], 3, 'X') @ Matrix.Rotation(rot[2], 3, 'Z'), verts=v)
    bmesh.ops.translate(bm, vec=c, verts=v)
    if bev > 0: M._bevel(faces, min(bev, 0.4 * min(s)), seg)
    return faces


def orient(M, faces, want):
    """flip faces whose normal disagrees with want(center) (a direction vector): robust outward orientation for hand-built surfaces"""
    bm = M.bm
    for f in faces:
        if not f.is_valid: continue
        f.normal_update()
        if f.normal.dot(want(f.calc_center_median())) < 0: bmesh.ops.reverse_faces(bm, faces=[f])


def strip(M, A, B, mat, want=None, closed=False):
    """quad strip between two equally long polylines (3D points); `want(center)` gives the wanted outward direction"""
    bm = M.bm
    va = [bm.verts.new(p) for p in A]
    vb = [bm.verts.new(p) for p in B]
    fs = []
    n = len(A)
    for i in range(n if closed else n - 1):
        j = (i + 1) % n
        try: fs.append(bm.faces.new((va[i], va[j], vb[j], vb[i])))
        except ValueError: pass
    for f in fs: f.material_index = MI[mat]
    if want: orient(M, fs, want)
    return fs


def poly_face(M, pts, mat, want=None):
    bm = M.bm
    try: f = bm.faces.new([bm.verts.new(p) for p in pts])
    except ValueError: return None
    f.material_index = MI[mat]
    if want: orient(M, [f], want)
    return f


def cut_below(M, y=CUT_Y):
    bm = M.bm
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=(0, y, 0), plane_no=(0, 1, 0), clear_inner=True, clear_outer=False)


def bank_ring(M, cx, cz, rx, rz, y_top, seed, n=18, depth=0.4, lump=0.18):
    """modelled snow collar around a base: low plump ring that merges into the surrounding snow (buried skirt)"""
    rnd = random.Random(seed)
    ph = [rnd.random() * 6 for _ in range(3)]
    rings = []
    spec = [(0.70, y_top * 0.9), (1.0, y_top * 0.78), (1.35, y_top * 0.42), (1.8, y_top * 0.10), (2.3, -0.45)]
    for k, (f, hy) in enumerate(spec):
        ring = []
        for i in range(n):
            a = TAU * i / n
            w = 1 + lump * math.sin(a * 2 + ph[0]) + lump * 0.5 * math.sin(a * 5 + ph[1])
            ring.append((cx + math.cos(a) * rx * f * w, hy, cz + math.sin(a) * rz * f * w))
        rings.append(ring)
    M.loft(rings, 'snow', orient=1)


# ═════════════════════════════════════════════════ props ═════════════════════════════════════════════════
PROPS = {}      # name -> dict(fn=fn(M, lod, rnd, v), variants=n, meta=dict(h, fp=(hx, hz), cols=[local boxes], bank=(a, b, h), sink, tags))


def prop(name, variants=1, **meta):
    def deco(fn):
        PROPS[name] = dict(fn=fn, variants=variants, meta=meta)
        return fn
    return deco


def bv(lod, b=0.07):
    return b if lod == 0 else 0.0


def snow_top(M, x0, x1, y, T_, t=0.26, seed=1, lod=0):
    """plump snow pillow resting on a flat wall top (convex rectangle in plan)"""
    if lod >= 2 or x1 - x0 < 0.7: return
    snow_poly(M, [(x0 - 0.06, -T_ / 2 - 0.1), (x1 + 0.06, -T_ / 2 - 0.1), (x1 + 0.06, T_ / 2 + 0.1), (x0 - 0.06, T_ / 2 + 0.1)], y - 0.02, t, seed=seed, bury=0.12, rings=3 if lod == 0 else 2, lump=0.12)


# ── broken walls ─────────────────────────────────────────────────────────────────────────────
WALL_PROFILES = [
    [(0, 1.0), (0.21, 1.0), (0.23, 0.77), (0.36, 0.75), (0.40, 0.47), (0.68, 0.44), (0.70, 0.65), (1.0, 0.62)],
    [(0, 0.55), (0.20, 0.55), (0.24, 1.0), (0.50, 1.0), (0.53, 0.78), (0.70, 0.74), (0.76, 0.40), (1.0, 0.38)],
    [(0, 1.0), (0.12, 0.96), (0.45, 0.58), (0.50, 0.58), (0.54, 0.70), (0.80, 0.42), (1.0, 0.40)],
    [(0, 0.70), (0.30, 0.70), (0.34, 0.38), (0.60, 0.36), (0.64, 0.90), (0.78, 1.0), (1.0, 0.82)],
    [(0, 0.42), (0.25, 0.40), (0.28, 0.85), (0.50, 0.90), (0.55, 1.0), (0.72, 0.98), (0.78, 0.50), (1.0, 0.46)],
]


def clip_profile(ks, xa, xb):
    """top key points restricted to [xa, xb] (interpolated at the ends)"""
    out = [(xa, top_at(ks, xa))]
    for x, y in ks:
        if xa + 1e-4 < x < xb - 1e-4: out.append((x, y))
    out.append((xb, top_at(ks, xb)))
    return out


def top_at(ks, x):
    if x <= ks[0][0]: return ks[0][1]
    for (xa, ya), (xb, yb) in zip(ks, ks[1:]):
        if xa - 1e-6 <= x <= xb + 1e-6:
            if xb - xa < 1e-6: return min(ya, yb)
            return ya + (yb - ya) * (x - xa) / (xb - xa)
    return ks[-1][1]


def profile_poly(ks, y0):
    return [(ks[0][0], y0), (ks[-1][0], y0)] + [(x, y) for x, y in reversed(ks)]


@prop('wallseg', variants=5, h=3.4, fp=(3.7, 1.0), bank=(1.0, 0.8, 0.5), sink=0.15, tags=['wall', 'big'], cols=None)
def p_wallseg(M, lod, rnd, v=0):
    cfg = [dict(L=7.0, H=3.4, T=0.8, orange=1, win=0), dict(L=5.6, H=2.8, T=0.7, orange=0, win=0), dict(L=6.4, H=3.2, T=0.75, orange=1, win=1),
           dict(L=5.0, H=2.7, T=0.7, orange=1, win=0), dict(L=7.4, H=2.8, T=0.8, orange=0, win=1)][v]
    L, H, T_ = cfg['L'], cfg['H'], cfg['T']
    ks = [(-L / 2 + f * L, h * H) for f, h in WALL_PROFILES[v]]
    y0 = -0.45
    b = bv(lod)

    def wall(S):
        S.box((0, -0.1, 0), (L + 0.3, 0.8, T_ + 0.3), 'wallDark', bev=bv(lod), seg=1)           # footing, mostly buried
        # window openings where the wall is tall enough
        wins = []
        if cfg['win'] and lod < 2:
            wl, sill, lint = 1.25, 0.95, 2.2
            x = -L / 2 + 1.0
            while x < L / 2 - 1.0 and len(wins) < 2:
                if min(top_at(ks, x - wl / 2 - 0.35), top_at(ks, x + wl / 2 + 0.35), top_at(ks, x)) > lint + 0.45: wins.append(x); x += 2.6
                else: x += 0.2
        xs = [-L / 2] + sum([[w - 0.625, w + 0.625] for w in wins], []) + [L / 2]
        for k in range(0, len(xs), 2):
            pk = clip_profile(ks, xs[k], xs[k + 1])
            prism_xy(S, profile_poly(pk, y0), -T_ / 2, T_ / 2, 'wall', bev=b, seg=1)
        for w in wins:
            prism_xy(S, [(w - 0.625, y0), (w + 0.625, y0), (w + 0.625, 0.95), (w - 0.625, 0.95)], -T_ / 2, T_ / 2, 'wall', bev=b, seg=1)
            pk = clip_profile(ks, w - 0.625, w + 0.625)
            prism_xy(S, [(w - 0.625, 2.2)] + [(w + 0.625, 2.2)] + [(x, y) for x, y in reversed(pk)], -T_ / 2, T_ / 2, 'wall', bev=b, seg=1)
            S.box((w, 0.99, T_ / 2 + 0.07), (1.75, 0.14, 0.2), 'wallLight', bev=bv(lod, 0.04), seg=1)
            S.box((w, 2.27, T_ / 2 + 0.06), (1.75, 0.16, 0.18), 'wallLight', bev=bv(lod, 0.04), seg=1)
        if lod == 2: return
        # coping + snow on every flat top run, plinth band on the face
        for (xa, ya), (xb, yb) in zip(ks, ks[1:]):
            if abs(ya - yb) < 1e-3 and xb - xa > 0.8:
                if not any(xa < w < xb for w in wins) or True:
                    S.box(((xa + xb) / 2, ya + 0.07, 0), (xb - xa + 0.08, 0.16, T_ + 0.22), 'wallLight', bev=bv(lod, 0.05), seg=1)
                    snow_top(S, xa + 0.05, xb - 0.05, ya + 0.15, T_, 0.30, seed=v * 7 + int(xa * 3), lod=lod)
        S.box((0, 0.62, T_ / 2 + 0.04), (L - 0.1, 0.16, 0.1), 'wallLight', bev=bv(lod, 0.04), seg=1)
        for sx in (-1, 1):
            xp = sx * (L / 2 - 0.17)
            hp = top_at(ks, xp) - 0.2
            if hp > 0.8: S.box((xp, hp / 2 + 0.05, 0), (0.34, hp, T_ + 0.2), 'wallLight', bev=bv(lod, 0.06), seg=1)
        # orange cladding bay on the tallest stretch
        if cfg['orange']:
            best = max(np.arange(-L / 2 + 0.9, L / 2 - 0.9, 0.1), key=lambda x: min(top_at(ks, x - 0.6), top_at(ks, x + 0.6)) - (9 if any(abs(x - w) < 1.5 for w in wins) else 0))
            top = min(top_at(ks, best - 0.6), top_at(ks, best + 0.6)) - 0.3
            if top > 1.4:
                ph = min(top, 2.6) - 0.85
                if lod == 0: S.box((best, 0.85 + ph / 2, T_ / 2 + 0.06), (1.4, ph + 0.18, 0.12), 'accentDark', bev=0.05, seg=1)
                S.box((best, 0.85 + ph / 2, T_ / 2 + (0.13 if lod == 0 else 0.07)), (1.2, ph, 0.12), 'accent', bev=bv(lod, 0.04), seg=1)
        # raised panels
        if lod == 0:
            ncol = max(2, int(L / 1.6))
            pw = (L - 1.0) / ncol - 0.22
            for c in range(ncol):
                xc = -L / 2 + 0.5 + (c + 0.5) * (L - 1.0) / ncol
                if any(abs(xc - w) < 1.5 for w in wins): continue
                if cfg['orange'] and abs(xc - best) < 1.1: continue
                for (ya, yb) in ((0.82, 1.9), (2.1, 3.0)):
                    top = top_at(ks, xc) - 0.3
                    yb2 = min(yb, top)
                    if yb2 - ya > 0.5 and rnd.random() > 0.15:
                        S.box((xc, (ya + yb2) / 2, T_ / 2 + 0.035), (pw, yb2 - ya, 0.09), 'wallLight', bev=0.03, seg=1)
            # back ribs (only where the wall stands that high) + bent steel poking out of the break
            for yy in (0.9, 1.9):
                for (xa, ya), (xb, yb) in zip(ks, ks[1:]):
                    if min(ya, yb) > yy + 0.3 and xb - xa > 0.4: S.box(((xa + xb) / 2, yy, -T_ / 2 - 0.04), (xb - xa - 0.1, 0.14, 0.1), 'wallLight', bev=0.03, seg=1)
            for (xa, ya) in ks[2:-1:2]:
                a = Vector((xa + 0.25, ya - 0.1, ru(rnd, -0.15, 0.15)))
                bb = a + Vector((ru(rnd, -0.25, 0.25), ru(rnd, 0.4, 0.7), ru(rnd, -0.15, 0.15)))
                beam_box(S, a, bb, 0.14, 0.26, 'metal', 0.03)
    sub(M, T(0, 0, 0, ru(rnd, -0.03, 0.03), ru(rnd, -0.04, 0.04), ru(rnd, -0.02, 0.02)), wall)


@prop('arch', variants=2, h=4.4, fp=(3.2, 1.3), bank=(1.0, 0.8, 0.5), sink=0.1, tags=['wall', 'big'], cols=None)
def p_arch(M, lod, rnd, v=0):
    """half an arch: a pier at the springline, a ring of voussoir blocks climbing to a broken crown, spandrel infill and fallen blocks at its feet"""
    R = [2.1, 1.7][v]
    T_ = 1.0
    nb = 9 if lod == 0 else 6
    brk = [0.80, 0.56][v]
    cy = 2.05
    M.box((-R - 0.55, 0.55, 0), (1.6, 2.0, T_ + 0.3), 'wallDark', bev=bv(lod), seg=1)
    M.box((-R - 0.55, 1.65, 0), (1.8, 0.28, T_ + 0.45), 'wallLight', bev=bv(lod, 0.06), seg=1)
    for i in range(nb):
        a0 = math.pi * (1 - brk * i / nb)
        a1 = math.pi * (1 - brk * (i + 1) / nb)
        am = (a0 + a1) / 2
        rm = R + 0.42
        arc = abs(a1 - a0) * rm
        c = (rm * math.cos(am), cy + rm * math.sin(am), 0)
        mat = 'wallLight' if i % 2 == 0 else 'wall'
        M.box(c, (0.92, arc * 0.97, T_ + (0.12 if i % 3 == 0 else 0)), mat, rot=(0, 0, am), bev=bv(lod, 0.06), seg=1)
    if lod < 2:
        poly = [(-R - 1.35, cy - 0.3), (-R - 1.35, cy + 2.4), (-R + 0.2, cy + 3.0), (-R * 0.3, cy + 2.4), (-R * 0.75, cy + 1.0)]
        prism_xy(M, poly, -T_ / 2 + 0.05, T_ / 2 - 0.05, 'wall', bev=bv(lod, 0.06), seg=1)
        snow_top(M, -R - 1.3, -R * 0.7, cy + 2.7, T_, 0.25, seed=v, lod=lod)
    chunk(M, (R * 0.55, 0.15, 1.9), (1.0, 0.8, 0.9), 'wallLight', rnd, 0.05, bv(lod, 0.08), rot=(0.1, 0.5, 0.35))
    chunk(M, (R * 0.95, 0.0, -1.6), (0.8, 0.6, 0.8), 'wall', rnd, 0.06, bv(lod, 0.07), rot=(0.2, 1.1, 0.1))
    if lod < 2: chunk(M, (R * 1.5, 0.05, 0.4), (0.7, 0.45, 0.8), 'wallLight', rnd, 0.06, bv(lod, 0.06), rot=(0.1, 0.2, -0.2))


@prop('column', variants=3, h=3.4, fp=(3.4, 1.4), bank=(1.0, 0.9, 0.45), sink=0.1, tags=['round'], cols=None)
def p_column(M, lod, rnd, v=0):
    seg = 16 if lod == 0 else 8
    r = [0.95, 0.8, 1.05][v]
    if v == 2:      # standing broken stub: plinth, fluted shaft, sheared top + two toppled drums
        M.box((0, 0.0, 0), (2.7, 0.9, 2.7), 'wallDark', bev=bv(lod, 0.08), seg=1)
        M.box((0, 0.62, 0), (2.2, 0.34, 2.2), 'wallLight', bev=bv(lod, 0.07), seg=1)
        n = seg * 2 if lod == 0 else seg
        rings = []
        for k, (y, sh) in enumerate(((0.75, 0.0), (1.4, 0.0), (2.4, 0.0), (3.1, 0.7))):
            rr = r * (1.0 - 0.035 * k)
            rings.append([(rr * (1 + (0.04 * math.cos(a * 12) if lod == 0 else 0)) * math.cos(a), y + sh * math.cos(a + 0.8), rr * (1 + (0.04 * math.cos(a * 12) if lod == 0 else 0)) * math.sin(a)) for a in (TAU * i / n for i in range(n))])
        M.loft(rings, 'wall', cap1=True, orient=1)
        if lod < 2:
            M.loft([[(rr * math.cos(TAU * i / seg), y, rr * math.sin(TAU * i / seg)) for i in range(seg)] for rr, y in ((r * 1.13, 0.8), (r * 1.13, 1.1), (r * 1.0, 1.22))], 'wallLight', orient=1)
        for i, (x, z, ang) in enumerate(((2.6, 0.7, 0.4), (3.5, -1.0, -0.5))):
            sub(M, T(x, 0.5, z, 0, ang, 0), lambda S, i=i: (cyl_x(S, 0, 0, 0, 1.3 if i == 0 else 0.9, r * 0.92, 'wall', seg, bv(lod, 0.03)),
                                                           [cyl_x(S, sx * 0.55, 0, 0, 0.2, r * 1.0, 'wallLight', seg) for sx in (-1, 1)] if (lod < 2 and i == 0) else None))
    else:
        n = 3 if v == 0 else 2
        x = -(n - 1) * 1.3
        for i in range(n):
            ln = ru(rnd, 1.5, 2.2)
            yaw = ru(rnd, -0.22, 0.22)
            rr_ = r
            sub(M, T(x, r * 0.62, ru(rnd, -0.35, 0.35), 0, yaw, ru(rnd, -0.05, 0.05)), lambda S, ln=ln, i=i, rr_=rr_: (
                cyl_x(S, 0, 0, 0, ln, rr_, 'wall', seg, bv(lod, 0.03)),
                [cyl_x(S, sx * (ln / 2 - 0.12), 0, 0, 0.22, rr_ * 1.1, 'wallLight', seg) for sx in (-1, 1)] if lod < 2 else None,
                cyl_x(S, 0, 0, 0, ln * 0.35, rr_ * 1.06, 'accent', seg) if (i == n - 1 and lod < 2) else None,
                cyl_x(S, ln / 2 + 0.01, 0, 0, 0.05, rr_ * 0.7, 'wallDark', seg, cap0=False) if lod == 0 else None))
            x += ln * 0.5 + 1.25 + ru(rnd, 0, 0.4)
        if lod < 2:
            M.box((-(n - 1) * 1.3 - 1.7, 0.1, 0.2), (1.7, 0.9, 1.7), 'wallDark', rot=(0, 0.3, 0), bev=bv(lod, 0.08), seg=1)
            M.box((-(n - 1) * 1.3 - 1.7, 0.62, 0.2), (1.9, 0.18, 1.9), 'wallLight', rot=(0, 0.3, 0), bev=bv(lod, 0.05), seg=1)


# ── toppled slabs & facade chunks ─────────────────────────────────────────────────────────────────
def irregular_poly(rnd, w, h):
    """broken-outline slab polygon (x, y) with base at y=0: chipped corners, a diagonal fracture along the top"""
    hw = w / 2
    top_l, top_r = h * ru(rnd, 0.82, 1.0), h * ru(rnd, 0.5, 0.78)
    mid = ru(rnd, -0.1, 0.2) * w
    return [(-hw, 0.0), (hw, 0.0), (hw, top_r * 0.88), (hw - w * ru(rnd, 0.06, 0.12), top_r), (mid + w * 0.14, top_r + (top_l - top_r) * 0.32),
            (mid - w * 0.04, top_l * 0.86), (-hw + w * ru(rnd, 0.1, 0.2), top_l), (-hw, top_l * 0.94)]


def slab_piece(S, lod, rnd, w, h, t, orange=0):
    P = irregular_poly(rnd, w, h)
    prism_xy(S, P, -t / 2, t / 2, 'wall', bev=bv(lod), seg=1)
    if lod == 2: return
    S.box((0, 0.2, t / 2 + 0.03), (w - 0.1, 0.3, 0.1), 'wallLight', bev=bv(lod, 0.03), seg=1)
    if orange:
        pw, ph = w * 0.42, min(P[4][1], P[5][1]) * 0.66
        cx_, cy_ = -w * 0.15, 0.5 + ph / 2
        if lod == 0: S.box((cx_, cy_, t / 2 + 0.05), (pw + 0.2, ph + 0.2, 0.1), 'accentDark', bev=0.05, seg=1)
        S.box((cx_, cy_, t / 2 + (0.1 if lod == 0 else 0.05)), (pw, ph, 0.1), 'accent', bev=bv(lod, 0.04), seg=1)
    if lod == 0:
        for xp in (-w / 2 + 0.2, w / 2 - 0.2):
            hh = min(P[2][1], P[-1][1]) * 0.85
            S.box((xp, hh / 2, t / 2 + 0.04), (0.24, hh, 0.1), 'wallLight', bev=0.03, seg=1)
        S.box((0, 0.9, -t / 2 - 0.04), (w - 0.5, 0.16, 0.1), 'wallDark', bev=0.03, seg=1)


@prop('slab', variants=4, h=3.2, fp=(3.2, 2.3), bank=(1.0, 0.9, 0.6), sink=0.15, tags=['wall', 'big'], cols=None)
def p_slab(M, lod, rnd, v=0):
    if v == 0:      # A-frame: two slabs propped against each other
        for sgn, w, h, ori in ((-1, 3.0, 3.0, 1), (1, 2.6, 2.4, 0)):
            sub(M, T(sgn * 0.95, -0.15, 0.0, 0, 0, -sgn * 0.5), lambda S, w=w, h=h, ori=ori: slab_piece(S, lod, rnd, w, h, 0.55, ori))
    elif v == 1:    # long facade chunk lying tilted, with a window grid
        def fac(S):
            w, h, t = 5.0, 3.0, 0.7
            S.box((0, h / 2, 0), (w, h, t), 'wall', bev=bv(lod), seg=1)
            if lod < 2:
                for i in range(3):
                    for j in range(2):
                        xc, yc = -w / 2 + 0.9 + (i + 0.5) * (w - 1.1) / 3, 0.6 + (j + 0.5) * (h - 0.95) / 2
                        S.box((xc, yc, t / 2 + 0.01), (0.95, 0.85, 0.12), 'wallDark', bev=bv(lod, 0.03), seg=1)
                        if lod == 0: S.box((xc, yc, t / 2 + 0.07), (0.7, 0.62, 0.06), 'glass', bev=0)
                S.box((-w / 2 + 0.35, h / 2, t / 2 + 0.06), (0.6, h - 0.1, 0.18), 'accent', bev=bv(lod, 0.04), seg=1)
                S.box((0, h - 0.12, t / 2 + 0.05), (w, 0.26, 0.14), 'wallLight', bev=bv(lod, 0.04), seg=1)
        sub(M, T(0, -0.25, 0.0, 0.0, 0.1, -0.30), fac)
        if lod < 2:
            chunk(M, (2.9, 0.2, 1.4), (1.4, 0.8, 1.0), 'wallLight', rnd, 0.06, bv(lod), rot=(0.1, 0.5, 0.2))
            chunk(M, (-2.9, 0.1, 1.1), (1.0, 0.6, 0.9), 'wall', rnd, 0.06, bv(lod), rot=(0.15, 1.0, 0.1))
    elif v == 2:    # single leaning shard with an orange face
        sub(M, T(0, -0.1, 0.0, 0.0, 0.25, 0.38), lambda S: slab_piece(S, lod, rnd, 3.4, 3.0, 0.7, 1))
        if lod < 2: chunk(M, (-1.9, 0.1, 1.3), (1.2, 0.7, 1.0), 'wall', rnd, 0.06, bv(lod), rot=(0.0, 0.7, 0.2))
    else:           # one block flat on the ground, one slab leaning on it
        M.box((-0.7, 0.2, 0.0), (4.2, 0.8, 2.6), 'wallDark', rot=(0, 0.2, 0), bev=bv(lod, 0.08), seg=1)
        if lod < 2: M.box((-0.7, 0.62, 0.0), (3.9, 0.12, 2.3), 'wallLight', rot=(0, 0.2, 0), bev=bv(lod, 0.04), seg=1)
        sub(M, T(0.4, 0.55, 0.3, 0.0, -0.2, -0.95), lambda S: slab_piece(S, lod, rnd, 2.8, 2.6, 0.5, 1))


# ── crates, containers, barrels ───────────────────────────────────────────────────────────────────
def crate_unit(S, lod, c, s, yaw, tilt, accent):
    body = 'accentDark' if accent else 'metal'
    frame_m = 'accent' if accent else 'trim'
    b = bv(lod, 0.06)

    def q(Q):
        Q.box((0, 0, 0), s, body, bev=b, seg=1)
        if lod < 2:
            for sx in (-1, 1):
                for sz in (-1, 1): Q.box((sx * (s[0] / 2 - 0.07), 0, sz * (s[2] / 2 - 0.07)), (0.14, s[1] + 0.06, 0.14), frame_m, bev=bv(lod, 0.03), seg=1)
            for sy in (-1, 1): Q.box((0, sy * (s[1] / 2 - 0.05), 0), (s[0] + 0.06, 0.1, s[2] + 0.06), frame_m, bev=bv(lod, 0.03), seg=1)
        if lod == 0:
            Q.box((0, 0, s[2] / 2 + 0.01), (s[0] * 0.72, s[1] * 0.2, 0.05), 'wallLight', bev=0.0)
            beam_box(Q, (-s[0] / 2 + 0.2, -s[1] / 2 + 0.2, s[2] / 2 + 0.03), (s[0] / 2 - 0.2, s[1] / 2 - 0.2, s[2] / 2 + 0.03), 0.09, 0.05, frame_m, 0.0, up=(0, 0, 1))
    sub(S, T(c[0], c[1], c[2], tilt[0], yaw, tilt[1]), q)


@prop('crate', variants=4, h=2.0, fp=(2.0, 1.5), bank=(1.0, 0.8, 0.4), sink=0.15, tags=['box', 'small'], cols=None)
def p_crate(M, lod, rnd, v=0):
    if v == 0:      # three stacked askew
        crate_unit(M, lod, (-0.5, 0.45, 0.0), (1.5, 1.2, 1.2), 0.15, (0.0, 0.0), False)
        crate_unit(M, lod, (1.05, 0.2, 0.6), (1.2, 0.9, 1.0), -0.4, (0.0, 0.05), True)
        crate_unit(M, lod, (-0.35, 1.5, 0.1), (1.1, 0.9, 1.0), -0.1, (0.05, -0.1), True)
    elif v == 1:    # tipped pair
        crate_unit(M, lod, (0, 0.45, 0), (1.7, 1.3, 1.4), 0.25, (0.0, 0.06), False)
        crate_unit(M, lod, (1.9, 0.1, -0.45), (1.3, 1.0, 1.2), -0.2, (0.2, 0.15), True)
    elif v == 2:    # container end / fragment: corrugated box
        L, Wd, Hh = 2.8, 2.5, 2.6

        def cont(S):
            S.box((0, Hh / 2, 0), (L, Hh, Wd), 'metal', bev=bv(lod, 0.06), seg=1)
            if lod < 2:
                for x in np.linspace(-L / 2 + 0.25, L / 2 - 0.25, 7):
                    for sz in (-1, 1): S.box((x, Hh / 2, sz * (Wd / 2 + 0.03)), (0.12, Hh - 0.2, 0.08), 'trim', bev=0.0)
                S.box((0, Hh * 0.55, Wd / 2 + 0.06), (L * 0.6, Hh * 0.2, 0.06), 'accent', bev=0.0)
                S.box((L / 2 + 0.01, Hh / 2, 0), (0.1, Hh, Wd - 0.1), 'wallDark', bev=0)
        sub(M, T(-0.4, 0.0, 0, 0.0, 0.2, 0.0) @ Matrix.Translation((0, -1.0, 0)), cont)
        crate_unit(M, lod, (2.6, 0.35, 1.0), (1.3, 1.0, 1.1), -0.5, (0.0, 0.05), True)
    else:           # barrels: two upright, one rolled
        for i, (x, y, z, rz) in enumerate(((0, 0.55, 0, 0), (0.88, 0.55, 0.15, 0), (0.45, 0.42, -0.9, math.pi / 2 - 0.1))):
            sub(M, T(x, y, z, 0, 0.3 * i, rz), lambda S, i=i: (
                cyl_y(S, 0, -0.55, 0, 1.1, 0.42, 'accentDark' if i != 1 else 'metal', 14 if lod == 0 else 8, bv(lod, 0.02)),
                [cyl_y(S, 0, -0.55 + h_, 0, 0.1, 0.45, 'trim', 14) for h_ in (0.25, 0.8)] if lod < 2 else None))


# ── collapsed catwalk ──────────────────────────────────────────────────────────────────────────────
@prop('truss', variants=2, h=2.4, fp=(3.2, 1.3), bank=(1.0, 0.8, 0.5), sink=0.1, tags=['metal', 'big'], cols=None)
def p_truss(M, lod, rnd, v=0):
    L, Wd = [4.6, 3.8][v], 1.5

    def walk(S):
        S.box((0, 0, 0), (L, 0.14, Wd), 'deck', bev=bv(lod, 0.03), seg=1)
        for sz in (-1, 1): S.box((0, -0.22, sz * (Wd / 2 - 0.08)), (L, 0.32, 0.14), 'wallDark', bev=bv(lod, 0.03), seg=1)
        if lod == 2: return
        n = int(L / 1.1)
        xs = [-L / 2 + 0.15 + k * (L - 0.3) / n for k in range(n + 1)]
        for sz in (-1, 1):
            for xk in xs: S.box((xk, 0.55, sz * (Wd / 2 - 0.05)), (0.09, 1.1, 0.09), 'metal', bev=0.0)
            S.box((0, 1.1, sz * (Wd / 2 - 0.05)), (L, 0.09, 0.1), 'trim', bev=bv(lod, 0.03), seg=1)
            if lod == 0: S.box((0, 0.6, sz * (Wd / 2 - 0.05)), (L, 0.06, 0.06), 'metal', bev=0)
        if lod == 0:
            for sz in (-1, 1):
                for k in range(0, len(xs) - 1, 2):
                    beam_box(S, Vector((xs[k], -0.38, sz * (Wd / 2 - 0.08))), Vector((xs[k + 1], -0.02, sz * (Wd / 2 - 0.08))), 0.08, 0.1, 'metal', 0.0)
            for xk in xs[::2]: S.box((xk, -0.2, 0), (0.1, 0.06, Wd - 0.2), 'metal', bev=0)
        if lod < 2: S.box((L / 2 - 0.2, 0.09, 0), (0.3, 0.05, Wd - 0.1), 'accent', bev=0.0)
    sub(M, T(0.2, [1.0, 0.75][v], 0, 0.0, 0.0, [-0.34, -0.22][v]) @ Matrix.Rotation(0.1, 4, 'X'), walk)
    if lod < 2:
        chunk(M, (1.7, 0.35, -0.3), (1.5, 1.4, 1.6), 'wallDark', rnd, 0.05, bv(lod, 0.08), rot=(0.0, 0.4, 0.1))
        chunk(M, (-2.3, 0.0, 1.4), (1.0, 0.6, 1.0), 'wall', rnd, 0.06, bv(lod), rot=(0.1, 0.9, 0.2))


# ── pipes ────────────────────────────────────────────────────────────────────────────────────────
@prop('pipes', variants=3, h=1.6, fp=(3.8, 1.3), bank=(1.0, 0.7, 0.35), sink=0.1, tags=['pipe', 'low'], cols=None)
def p_pipes(M, lod, rnd, v=0):
    seg = 14 if lod == 0 else 8
    if v == 0:      # run with a coupling, a broken end and an elbow rising out of the snow
        r, y = 0.34, 0.2
        tube(M, Vector((-3.6, y, 0.3)), Vector((-0.2, y, 0.0)), r, 'trim', seg)
        tube(M, Vector((0.35, y, -0.05)), Vector((2.2, y, -0.25)), r, 'trim', seg)
        if lod < 2:
            for xx in (-3.3, -0.35, 0.5, 2.1):
                zz = 0.3 - 0.3 * (xx + 3.6) / 3.4 if xx < 0 else -0.05 - 0.2 * (xx - 0.35) / 1.85
                tube(M, Vector((xx - 0.14, y, zz)), Vector((xx + 0.14, y, zz)), r * 1.3, 'metal', seg)
            for xx in (-2.0, -1.5): M.box((xx, 0.0, 0.2 - 0.1 * (xx + 2)), (0.22, 0.35, 1.0), 'wallDark', bev=bv(lod, 0.04), seg=1)
            tube(M, Vector((-1.4, y, 0.17)), Vector((-1.0, y, 0.12)), r * 1.12, 'accent', seg)
            tube(M, Vector((-0.22, y, 0.0)), Vector((-0.12, y, -0.01)), r * 0.82, 'wallDark', seg)
        el = Mod()
        torus(el, (0, 0, 0), 0.9, r, 'z', 'trim', nmaj=14 if lod == 0 else 8, nmin=seg)
        M.merge(el, Matrix.Translation((2.2, y + 0.9, -0.25)))
        el.free()
        tube(M, Vector((3.1, y + 0.9, -0.25)), Vector((3.1, 1.5, -0.25)), r, 'trim', seg)
        if lod < 2:
            tube(M, Vector((3.1, 1.3, -0.25)), Vector((3.1, 1.52, -0.25)), r * 1.4, 'metal', seg)
            tube(M, Vector((3.1, 0.9, -0.25)), Vector((3.1, 1.05, -0.25)), r * 1.14, 'accent', seg)
    elif v == 1:    # bundle of three pipes on saddles + a valve wheel
        for k, (r, z, mat) in enumerate(((0.3, -0.45, 'trim'), (0.22, 0.1, 'metal'), (0.26, 0.6, 'trim'))):
            x0, x1 = -3.0 + ru(rnd, 0, 0.4), 2.8 - ru(rnd, 0, 0.6)
            tube(M, Vector((x0, 0.22, z)), Vector((x1, 0.22 + 0.1 * (k - 1), z)), r, mat, seg)
            if lod < 2:
                for xx in (-1.8, 0.6): tube(M, Vector((xx - 0.1, 0.22, z)), Vector((xx + 0.1, 0.22, z)), r * 1.3, 'accent' if k == 1 else 'metal', seg)
        if lod < 2:
            for xx in (-2.2, 1.4): M.box((xx, 0.0, 0.1), (0.4, 0.5, 2.0), 'wallDark', bev=bv(lod, 0.05), seg=1)
        if lod == 0:
            tube(M, Vector((-0.4, 0.3, 0.1)), Vector((-0.4, 0.95, 0.1)), 0.07, 'metal', 8)
            wheel = Mod(); torus(wheel, (0, 0, 0), 0.34, 0.05, 'y', 'accent', nmaj=16, nmin=6)
            for a in (0, math.pi / 2): tube(wheel, Vector((-0.34 * math.cos(a), 0, -0.34 * math.sin(a))), Vector((0.34 * math.cos(a), 0, 0.34 * math.sin(a))), 0.035, 'accent', 6)
            M.merge(wheel, Matrix.Translation((-0.4, 0.98, 0.1)) @ Matrix.Rotation(0.3, 4, 'X')); wheel.free()
    else:           # one big drain pipe section: flange rings, orange stripe, dark open end
        r = 0.62
        sub(M, T(0, 0.25, 0, 0, 0.2, 0.05), lambda S: (
            cyl_x(S, 0, 0, 0, 4.0, r, 'trim', 18 if lod == 0 else 10, 0.0),
            [cyl_x(S, xx, 0, 0, 0.22, r * 1.12, 'metal', 18 if lod == 0 else 10) for xx in (-1.9, 1.9)] if lod < 2 else None,
            cyl_x(S, -0.3, 0, 0, 0.7, r * 1.06, 'accent', 18 if lod == 0 else 10) if lod < 2 else None,
            cyl_x(S, 2.02, 0, 0, 0.06, r * 0.84, 'wallDark', 18 if lod == 0 else 10) if lod < 2 else None))


# ── tank shells ──────────────────────────────────────────────────────────────────────────────────
@prop('tank', variants=2, h=2.4, fp=(2.8, 2.3), bank=(1.0, 0.9, 0.55), sink=0.1, tags=['round', 'big'], cols=None)
def p_tank(M, lod, rnd, v=0):
    if v == 0:      # half shell lying like a trough: lower arc of a cylinder with rolled rim, rib collars, an orange band and an end plate
        R, L, cy, t_ = 2.0, 4.4, 1.0, 0.14
        na = 22 if lod == 0 else 11
        th0, th1 = math.radians(158), math.radians(382)
        angs = [th0 + (th1 - th0) * k / na for k in range(na + 1)]
        P = lambda x, r, a: (x, cy + r * math.sin(a), r * math.cos(a))
        radial = lambda c: Vector((0, c.y - cy, c.z))
        strip(M, [P(-L / 2, R, a) for a in angs], [P(L / 2, R, a) for a in angs], 'wall', want=lambda c: radial(c))
        strip(M, [P(-L / 2, R - t_, a) for a in angs], [P(L / 2, R - t_, a) for a in angs], 'wallDark', want=lambda c: -radial(c))
        for x in (-L / 2, L / 2):
            strip(M, [P(x, R, a) for a in angs], [P(x, R - t_, a) for a in angs], 'wallLight', want=lambda c, x=x: Vector((1 if x > 0 else -1, 0, 0)))
        for a, sgn in ((th0, -1), (th1, 1)):
            strip(M, [P(-L / 2, R, a), P(L / 2, R, a)], [P(-L / 2, R - t_, a), P(L / 2, R - t_, a)], 'wallLight', want=lambda c, a=a, sgn=sgn: Vector((0, sgn * math.cos(a), -sgn * math.sin(a))))
        if lod < 2:
            for xx in (-L / 2 + 0.12, 0.3, L / 2 - 0.12):       # rib collars
                strip(M, [P(xx - 0.13, R + 0.1, a) for a in angs], [P(xx + 0.13, R + 0.1, a) for a in angs], 'wallLight', want=lambda c: radial(c))
                for sg in (-1, 1): strip(M, [P(xx + sg * 0.13, R, a) for a in angs], [P(xx + sg * 0.13, R + 0.1, a) for a in angs], 'wallLight', want=lambda c, sg=sg: Vector((sg, 0, 0)))
            strip(M, [P(-1.2, R + 0.03, a) for a in angs], [P(-0.5, R + 0.03, a) for a in angs], 'accent', want=lambda c: radial(c))
            # end plate (a thick half-disc closing the far end)
            pts = [(R - t_ - 0.02) * math.cos(a) for a in angs], [cy + (R - t_ - 0.02) * math.sin(a) for a in angs]
            poly = [(z, y) for z, y in zip(*pts)]
            def plate(S):
                prism_xy(S, poly, 0.0, 0.16, 'wall', bev=bv(lod, 0.04), seg=1)
            sub(M, Matrix.Translation((-L / 2 + 0.08, 0, 0)) @ Matrix.Rotation(-math.pi / 2, 4, 'Y'), plate)
    else:           # domed cap, tipped, with banding, a hatch and an orange foot band
        R = 2.1
        sg = 24 if lod == 0 else 12

        def cap(S):
            S.dome((0, 0.0, 0), R, 'wallLight', h=R * 0.85, seg=sg, rings=7 if lod == 0 else 4)
            if lod < 2:
                S.frustum((0, -0.35, 0), R * 1.0, R * 1.0, 0.7, 'wall', seg=sg, cap0=False, cap1=False)
                S.frustum((0, -0.55, 0), R * 1.05, R * 1.05, 0.32, 'accent', seg=sg, cap0=False, cap1=False)
                S.frustum((0, R * 0.85 - 0.1, 0), 0.5, 0.5, 0.3, 'metal', seg=14, cap0=True, cap1=True, bev=0.03 if lod == 0 else 0)
                for aa in (math.radians(28), math.radians(58)):
                    ra, rb = R * math.cos(aa - 0.05), R * math.cos(aa + 0.05)
                    ya, yb = R * 0.85 * math.sin(aa - 0.05), R * 0.85 * math.sin(aa + 0.05)
                    S.loft([[(ra * 1.0 * math.cos(TAU * i / sg), ya, ra * math.sin(TAU * i / sg)) for i in range(sg)], [((rb + 0.0) * math.cos(TAU * i / sg), yb, rb * math.sin(TAU * i / sg)) for i in range(sg)]], 'wall', orient=1) if False else None
        sub(M, T(0.0, 0.9, 0.0, 0.0, 0.3, 0.38), cap)
        if lod < 2: chunk(M, (2.6, 0.2, 1.4), (1.2, 0.7, 1.0), 'wall', rnd, 0.06, bv(lod), rot=(0.0, 0.6, 0.2))
# ── machinery helpers ──────────────────────────────────────────────────────────────────────────────
def annulus(S, cx, cy, r_out, r_in, z0, z1, mat, seg=24, mat_in=None):
    """flat ring (axis z): outer wall, inner wall and both faces, normals forced outward"""
    ang = [TAU * i / seg for i in range(seg)]
    P = lambda r, z, a: (cx + r * math.cos(a), cy + r * math.sin(a), z)
    rad = lambda c: Vector((c.x - cx, c.y - cy, 0))
    strip(S, [P(r_out, z0, a) for a in ang], [P(r_out, z1, a) for a in ang], mat, want=rad, closed=True)
    strip(S, [P(r_in, z0, a) for a in ang], [P(r_in, z1, a) for a in ang], mat_in or mat, want=lambda c: -rad(c), closed=True)
    for z, sg in ((z0, -1), (z1, 1)):
        strip(S, [P(r_out, z, a) for a in ang], [P(r_in, z, a) for a in ang], mat, want=lambda c, sg=sg: Vector((0, 0, sg)), closed=True)


def cone_tube(S, a, b, r0, r1, mat, seg=8, caps=True):
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    if L < 1e-5: return
    x = d / L
    ref = UP if abs(x.y) < 0.95 else Vector((1, 0, 0))
    y = ref.cross(x).normalized(); z = x.cross(y)
    ring = lambda p, r: [tuple(p + y * (r * math.cos(TAU * i / seg)) + z * (r * math.sin(TAU * i / seg))) for i in range(seg)]
    return S.loft([ring(a, r0), ring(b, r1)], mat, cap0=caps, cap1=caps, up=x, orient=1)


# ── wheels ───────────────────────────────────────────────────────────────────────────────────────
@prop('gear', variants=2, h=3.4, fp=(2.6, 1.0), bank=(1.0, 0.7, 0.5), sink=0.1, tags=['machine', 'big'], cols=None)
def p_gear(M, lod, rnd, v=0):
    if v == 0:      # big toothed wheel standing half buried, hub + six spokes
        R, t = 2.1, 0.5
        nt = 22 if lod == 0 else (16 if lod == 1 else 0)
        seg = 40 if lod == 0 else (24 if lod == 1 else 16)

        def wheel(S):
            annulus(S, 0, 0, R, R - 0.34, -t / 2, t / 2, 'metal', seg, 'wallDark')
            if lod < 2: annulus(S, 0, 0, R - 0.02, R - 0.26, t / 2, t / 2 + 0.06, 'trim', seg)
            for i in range(nt):
                a = TAU * i / nt
                S.box(((R + 0.1) * math.cos(a), (R + 0.1) * math.sin(a), 0), (0.3, 0.34, t), 'metal', rot=(0, 0, a), bev=bv(lod, 0.04), seg=1)
            cyl_z(S, 0, 0, 0, t + 0.5, 0.55, 'accent', 18 if lod == 0 else 10, bv(lod, 0.03))
            if lod < 2: cyl_z(S, 0, 0, t / 2 + 0.3, 0.14, 0.7, 'accentDark', 18 if lod == 0 else 10)
            for k in range(6):
                a = TAU * k / 6 + 0.2
                beam_box(S, Vector((0.5 * math.cos(a), 0.5 * math.sin(a), 0)), Vector(((R - 0.3) * math.cos(a), (R - 0.3) * math.sin(a), 0)), 0.34, 0.3, 'metal', bv(lod, 0.04), up=(0, 0, 1))
        sub(M, T(0, 1.2, 0, 0.0, 0.2, 0.0) @ Matrix.Rotation(0.14, 4, 'X'), wheel)
        if lod < 2: chunk(M, (1.9, 0.15, 1.2), (1.3, 0.7, 1.1), 'wallLight', rnd, 0.06, bv(lod), rot=(0.1, 0.5, 0.2))
    else:           # turbine shroud: ring housing, hub and slanted blades, orange band
        R = 1.9

        def fan(S):
            annulus(S, 0, 0, R, R - 0.22, -0.5, 0.5, 'wall', 32 if lod == 0 else 16, 'wallDark')
            if lod < 2:
                annulus(S, 0, 0, R + 0.08, R - 0.1, 0.5, 0.64, 'wallLight', 32 if lod == 0 else 16)
                annulus(S, 0, 0, R + 0.04, R - 0.02, -0.55, -0.1, 'accent', 32 if lod == 0 else 16)
            cyl_z(S, 0, 0, 0, 0.9, 0.5, 'accentDark', 16 if lod == 0 else 8, bv(lod, 0.03))
            cyl_z(S, 0, 0, 0.6, 0.3, 0.3, 'metal', 14)
            nb = 11 if lod == 0 else 7
            for k in range(nb):
                a = TAU * k / nb
                S.box((1.15 * math.cos(a), 1.15 * math.sin(a), 0), (1.2, 0.34, 0.12), 'metal', rot=(0.6, 0, a), bev=0, seg=1) if False else None
                beam_box(S, Vector((0.5 * math.cos(a), 0.5 * math.sin(a), 0)), Vector(((R - 0.2) * math.cos(a), (R - 0.2) * math.sin(a), 0)), 0.5, 0.1, 'metal', bv(lod, 0.02), up=(math.cos(a) * 0.5, math.sin(a) * 0.5, 0.85))
        sub(M, T(0, 1.15, 0, 0.0, 0.5, 0.0) @ Matrix.Rotation(0.22, 4, 'X'), fan)
        if lod < 2: chunk(M, (-2.0, 0.1, 1.0), (1.2, 0.6, 1.0), 'wall', rnd, 0.06, bv(lod), rot=(0.0, 0.6, 0.2))


# ── crane boom ────────────────────────────────────────────────────────────────────────────────────
@prop('crane', variants=1, h=2.4, fp=(4.6, 1.2), bank=(1.0, 0.6, 0.4), sink=0.1, tags=['machine', 'big'], cols=None)
def p_crane(M, lod, rnd, v=0):
    L = 9.0
    ns = 10 if lod == 0 else 5

    def boom(S):
        def sec(x):
            f = 1.0 - 0.45 * (x + L / 2) / L
            return [Vector((x, 0.46 * f, 0)), Vector((x, -0.28 * f, -0.42 * f)), Vector((x, -0.28 * f, 0.42 * f))]
        st = [sec(-L / 2 + L * k / ns) for k in range(ns + 1)]
        for c in range(3):
            beam_box(S, st[0][c], st[-1][c], 0.13, 0.13, 'accentDark' if c == 0 else 'accent', bv(lod, 0.03))
        if lod == 2: return
        for k in range(ns):
            for c in range(3):
                a, b = st[k][c], st[k + 1][(c + 1) % 3]
                beam_box(S, a, b, 0.07, 0.07, 'metal', 0.0)
            if lod == 0 or k % 2 == 0:
                for c in range(3): beam_box(S, st[k][c], st[k][(c + 1) % 3], 0.07, 0.07, 'metal', 0.0)
        # sheave housing at the tip
        S.box((L / 2 + 0.2, 0.0, 0), (0.5, 0.75, 0.7), 'wallDark', bev=bv(lod, 0.05), seg=1)
        cyl_z(S, L / 2 + 0.2, 0.0, 0, 0.95, 0.34, 'trim', 14, bv(lod, 0.02))
        # foot clevis
        S.box((-L / 2 - 0.15, 0.0, 0), (0.5, 0.9, 1.0), 'wallDark', bev=bv(lod, 0.05), seg=1)
    sub(M, T(0.3, 0.55, 0, 0.0, 0.0, 0.17) @ Matrix.Rotation(0.1, 4, 'X'), boom)
    chunk(M, (1.2, 0.55, 0.2), (1.2, 1.4, 1.2), 'wallDark', rnd, 0.05, bv(lod, 0.08), rot=(0.0, 0.4, 0.1))
    if lod < 2: chunk(M, (-3.5, 0.1, 1.3), (1.2, 0.6, 1.0), 'wall', rnd, 0.06, bv(lod), rot=(0.1, 0.9, 0.2))


# ── tracked crawler wreck ──────────────────────────────────────────────────────────────────────────
@prop('hulk', variants=2, h=2.8, fp=(3.4, 2.4), bank=(1.0, 0.85, 0.6), sink=0.2, tags=['machine', 'big'], cols=None)
def p_hulk(M, lod, rnd, v=0):
    """tracked snow-crawler hauler: low cab with a raked windscreen, a ribbed cargo box (orange side panel), two track units"""
    def hulk(S):
        b = bv(lod, 0.08)
        body = [(-3.0, 0.0), (3.0, 0.0), (3.0, 0.85), (2.35, 1.2), (1.7, 1.28), (1.15, 2.2), (0.35, 2.25), (0.3, 0.9), (-3.0, 0.9)]
        prism_xy(S, body, -1.05, 1.05, 'wall', bev=b, seg=1)
        # cargo box behind the cab
        S.box((-1.45, 1.78, 0), (3.2, 1.7, 2.1), 'wallLight', bev=bv(lod, 0.08), seg=1)
        # tracks
        for sz in (-1, 1):
            z0, z1 = (1.05, 1.85) if sz > 0 else (-1.85, -1.05)
            P = []
            n = 8
            for i in range(n + 1): a = -math.pi / 2 + math.pi * i / n; P.append((3.15 + 0.62 * math.cos(a) * 0.9, 0.55 + 0.62 * math.sin(a)))
            for i in range(n + 1): a = math.pi / 2 + math.pi * i / n; P.append((-3.15 + 0.62 * math.cos(a) * 0.9, 0.55 + 0.62 * math.sin(a)))
            prism_xy(S, P, z0, z1, 'wallDark', bev=bv(lod, 0.05), seg=1)
            if lod < 2:
                zc = z1 + 0.04 if sz > 0 else z0 - 0.04
                for xw in np.linspace(-2.9, 2.9, 6): cyl_z(S, xw, 0.55, zc, 0.08, 0.3, 'metal', 12 if lod == 0 else 8)
            if lod == 0:
                for xx in np.linspace(-3.0, 3.0, 22): S.box((xx, 1.18, (z0 + z1) / 2), (0.12, 0.07, 0.86), 'metal', bev=0)
        if lod == 2: return
        # windscreen (raked), side window, orange cargo panel + trim, roof rack
        S.box((1.38, 1.78, 0), (0.1, 0.78, 1.7), 'glass', rot=(0, 0, -0.55), bev=0)
        for sz in (-1, 1): S.box((0.78, 1.9, sz * 1.07), (0.6, 0.55, 0.05), 'glass', bev=0)
        for sz in (-1, 1):
            S.box((-1.45, 1.7, sz * 1.1), (2.4, 1.0, 0.1), 'accent', bev=bv(lod, 0.04), seg=1)
            if lod == 0: S.box((-1.45, 1.7, sz * 1.14), (2.6, 1.2, 0.05), 'accentDark', bev=0)
        S.box((-1.45, 2.66, 0), (3.3, 0.14, 2.2), 'wallLight', bev=bv(lod, 0.05), seg=1)
        snow_poly(S, [(-2.95, -0.9), (-0.0, -0.9), (-0.0, 0.9), (-2.95, 0.9)], 2.72, 0.36, seed=3, bury=0.1, rings=3 if lod == 0 else 2, lump=0.1)
        S.box((0.75, 2.28, 0), (1.0, 0.1, 1.3), 'wallLight', bev=bv(lod, 0.04), seg=1)
        if lod == 0:
            S.box((3.02, 0.55, 0), (0.1, 0.4, 1.4), 'accentDark', bev=0.02, seg=1)
            tube(S, Vector((-0.1, 2.3, 0.7)), Vector((-0.1, 3.1, 0.7)), 0.1, 'metal', 8)
            for k in range(5): S.box((-2.6 + 0.65 * k, 1.78, 1.12), (0.1, 1.55, 0.04), 'wallDark', bev=0)
    sub(M, T(0, 0.3, 0, 0.14 if v == 0 else -0.1, [0.5, -0.9][v], 0.1 if v == 0 else -0.07), hulk)


# ── stair run ────────────────────────────────────────────────────────────────────────────────────
@prop('stairs', variants=2, h=2.0, fp=(2.4, 1.6), bank=(1.0, 0.9, 0.5), sink=0.05, tags=['stairs', 'big'], cols=None)
def p_stairs(M, lod, rnd, v=0):
    n, rise, run, w = [8, 6][v], 0.19, 0.42, 2.4

    def st(S):
        for i in range(n):
            S.box((i * run + run / 2, (i + 1) * rise / 2 - 0.2, 0), (run, (i + 1) * rise + 0.4, w), 'wallLight', bev=bv(lod, 0.03), seg=1)
            if lod == 0: S.box((i * run + 0.03, (i + 1) * rise - 0.01, 0), (0.07, 0.04, w - 0.05), 'trim', bev=0)
        for sz in (-1, 1):
            if sz < 0 and v == 1: continue                                     # one cheek wall is gone
            P = [(-0.2, -0.4), (n * run + 0.2, -0.4), (n * run + 0.2, n * rise + 0.45)]
            for i in reversed(range(n)): P += [(i * run + run, (i + 1) * rise + 0.14), (i * run, (i + 1) * rise + 0.14)]
            P += [(-0.2, rise + 0.14)]
            prism_xy(S, P, sz * (w / 2 + 0.2) - 0.15, sz * (w / 2 + 0.2) + 0.15, 'wall', bev=bv(lod, 0.04), seg=1)
        if lod == 0:
            S.box((n * run - 0.15, n * rise + 0.12, 0), (0.5, 0.1, w), 'accent', bev=0.02, seg=1)
    sub(M, T(0, -0.1, 0, 0.0, 0.0, -0.06) @ Matrix.Rotation(0.07, 4, 'X'), st)
    if lod < 2: chunk(M, (n * run + 0.7, 0.2, -0.9), (1.2, 0.7, 1.0), 'wall', rnd, 0.06, bv(lod), rot=(0.1, 0.5, 0.2))
# ── bent lamp posts & signal pylons ───────────────────────────────────────────────────────────────
@prop('lamp', variants=2, h=3.6, fp=(1.6, 1.0), bank=(0.9, 0.7, 0.3), sink=0.05, tags=['slim'], colmax=2, colmin=0.6)
def p_lamp(M, lod, rnd, v=0):
    seg = 10 if lod == 0 else 6
    def post(S):
        cyl_y(S, 0, -0.1, 0, 0.42, 0.38, 'wallDark', 14 if lod == 0 else 8, bv(lod, 0.04))
        cone_tube(S, Vector((0, 0.3, 0)), Vector((0.1, 2.2, 0)), 0.14, 0.1, 'metal', seg)
        if lod < 2:
            cone_tube(S, Vector((0.0, 0.32, 0)), Vector((0.02, 0.62, 0)), 0.22, 0.17, 'trim', seg)
            cone_tube(S, Vector((0.1, 2.15, 0)), Vector((0.12, 2.3, 0)), 0.15, 0.15, 'accent', seg)
        cone_tube(S, Vector((0.1, 2.2, 0)), Vector((1.15, 3.1, 0.0)), 0.1, 0.07, 'metal', seg)
        cone_tube(S, Vector((1.15, 3.1, 0.0)), Vector((1.85, 3.0, 0.0)), 0.07, 0.07, 'metal', seg)
        S.box((1.95, 2.92, 0), (0.85, 0.16, 0.38), 'wallDark', rot=(0, 0, -0.1), bev=bv(lod, 0.04), seg=1)
        if lod < 2: S.box((1.95, 2.82, 0), (0.7, 0.05, 0.3), 'accent', rot=(0, 0, -0.1), bev=0)
    if v == 0: sub(M, T(0, 0.0, 0, 0.0, 0.3, -0.38), post)
    else: sub(M, T(0, 0.2, 0, 0.0, -0.6, -1.25) @ Matrix.Translation((0, -0.5, 0)), post)


@prop('pylon', variants=2, h=5.4, fp=(2.4, 1.2), bank=(0.9, 0.7, 0.4), sink=0.1, tags=['slim', 'tall'], colmax=2, colmin=0.6)
def p_pylon(M, lod, rnd, v=0):
    h = 5.0

    def mast(S):
        S.box((0, -0.1, 0), (1.7, 0.6, 1.7), 'wallDark', bev=bv(lod, 0.06), seg=1)
        G.lattice_mast(S, 0, 0, 0.2, h, 1.25, 0.42, lod, 'metal', nb=5 if lod < 2 else 3, leg=0.17)
        S.box((0, h + 0.3, 0), (0.8, 0.5, 0.8), 'wallLight', bev=bv(lod, 0.05), seg=1)
        if lod < 2:
            cyl_z(S, 0, h + 0.3, 0.46, 0.14, 0.26, 'accent', 12 if lod == 0 else 8)
            cyl_z(S, 0, h + 0.3, -0.46, 0.14, 0.26, 'accentDark', 12 if lod == 0 else 8)
            S.box((0, h + 0.65, 0), (0.95, 0.08, 0.95), 'trim', bev=0.0)
    if v == 0: sub(M, T(0, 0.0, 0, 0.0, 0.0, -0.20), mast)
    else:
        sub(M, T(0, 0.5, 0, 0.0, 0.4, -math.pi / 2 + 0.12) @ Matrix.Translation((0, 0.3, 0)), mast)
        if lod < 2: chunk(M, (0.2, 0.2, 1.2), (1.3, 0.7, 1.1), 'wall', rnd, 0.06, bv(lod), rot=(0.1, 0.5, 0.2))


# ── barriers, bollards ────────────────────────────────────────────────────────────────────────────
@prop('barrier', variants=2, h=0.9, fp=(3.4, 1.4), bank=(1.0, 0.7, 0.3), sink=0.1, tags=['low'], cols=None)
def p_barrier(M, lod, rnd, v=0):
    def jersey(S, ln=2.4):
        P = [(-0.38, -0.3), (0.38, -0.3), (0.38, 0.08), (0.3, 0.25), (0.14, 0.62), (0.14, 0.82), (-0.14, 0.82), (-0.14, 0.62), (-0.3, 0.25), (-0.38, 0.08)]
        prism_xy(S, P, -ln / 2, ln / 2, 'wallLight', bev=bv(lod, 0.04), seg=1)
        if lod < 2:
            for zz in (-0.7, 0.7): S.box((0, 0.5, zz), (0.4, 0.3, 0.5), 'accent', bev=0, seg=1) if False else None
            S.box((0.0, 0.66, 0.0), (0.34, 0.22, ln * 0.62), 'accent', bev=bv(lod, 0.03), seg=1)
            S.box((0, 0.86, 0), (0.34, 0.06, ln - 0.1), 'trim', bev=0)
    if v == 0:
        sub(M, T(-2.0, 0.0, 0.0, 0.0, math.pi / 2 + 0.05, 0.0), lambda S: jersey(S))
        sub(M, T(0.5, 0.0, 0.3, 0.0, math.pi / 2 - 0.12, 0.0), lambda S: jersey(S, 2.0))
        sub(M, T(2.7, 0.12, 0.4, 0.0, 0.5, 0.0) @ Matrix.Rotation(0.5, 4, 'X'), lambda S: jersey(S))
    else:
        for i, (x, z) in enumerate(((-2.2, 0.2), (-1.0, -0.1), (0.2, 0.25), (1.4, 0.0), (2.5, 0.3))):
            if i == 3: sub(M, T(x, 0.15, z, 0.0, 0.3, 1.25), lambda S: (cyl_y(S, 0, 0, 0, 0.9, 0.17, 'wallDark', 12 if lod == 0 else 6, bv(lod, 0.02)), cyl_y(S, 0, 0.7, 0, 0.14, 0.19, 'accent', 12 if lod == 0 else 6)))
            else: sub(M, T(x, 0.0, z, 0.0, 0.0, 0.0), lambda S: (cyl_y(S, 0, -0.3, 0, 0.9, 0.17, 'wallDark', 12 if lod == 0 else 6, bv(lod, 0.02)), cyl_y(S, 0, 0.45, 0, 0.14, 0.19, 'accent', 12 if lod == 0 else 6)))


# ── ice-crusted rubble heap ───────────────────────────────────────────────────────────────────────
@prop('pile', variants=3, h=1.6, fp=(2.2, 2.0), bank=(1.0, 0.9, 0.55), sink=0.1, tags=['rubble', 'small'], cols=None)
def p_pile(M, lod, rnd, v=0):
    n = [12, 9, 14][v]
    R = [1.5, 1.2, 1.8][v]
    mats = ['wall', 'wallLight', 'wallDark', 'wall', 'wallLight', 'accent', 'wallDark', 'accentDark']
    tops = []
    for i in range(n):
        d = R * (0.15 + 0.85 * math.sqrt(rnd.random()))
        a = TAU * rnd.random()
        s = (ru(rnd, 0.5, 1.2) * (1.15 - 0.55 * d / R), ru(rnd, 0.35, 0.8), ru(rnd, 0.5, 1.1) * (1.15 - 0.55 * d / R))
        y = max(0.0, 0.62 * (1 - d / R)) * 1.1 + s[1] / 2 - 0.25 + ru(rnd, 0, 0.15)
        mat = mats[i % len(mats)] if (i != 0) else 'wall'
        chunk(M, (d * math.cos(a), y, d * math.sin(a)), s, mat, rnd, 0.14, bv(lod, 0.08), rot=(ru(rnd, -0.5, 0.5), ru(rnd, 0, 3.1), ru(rnd, -0.5, 0.5)))
        tops.append(y + s[1] / 2)
    # a couple of bent steel members poking out
    if lod < 2:
        for k in range(2 if v != 1 else 1):
            a = TAU * rnd.random()
            p0 = Vector((0.3 * math.cos(a), 0.45, 0.3 * math.sin(a)))
            p1 = p0 + Vector((ru(rnd, -0.8, 0.8), ru(rnd, 0.7, 1.2), ru(rnd, -0.8, 0.8)))
            beam_box(M, p0, p1, 0.12, 0.24, 'metal', 0.02)
        snow_poly(M, [(R * 0.55 * math.cos(TAU * i / 8 + 0.3), R * 0.55 * math.sin(TAU * i / 8 + 0.3)) for i in range(8)], max(tops) - 0.55, 0.5, seed=v + 4, bury=0.3, rings=3 if lod == 0 else 2, lump=0.16)


# ── cable spool ──────────────────────────────────────────────────────────────────────────────────
@prop('spool', variants=1, h=2.6, fp=(2.0, 2.4), bank=(1.0, 0.8, 0.45), sink=0.1, tags=['machine', 'small'], cols=None)
def p_spool(M, lod, rnd, v=0):
    sg = 22 if lod == 0 else 12

    def reel(S):
        for z in (-0.7, 0.7): cyl_z(S, 0, 0, z, 0.14, 1.15, 'accent', sg, bv(lod, 0.03))
        cyl_z(S, 0, 0, 0, 1.4, 0.5, 'wallDark', 14 if lod == 0 else 8)
        cyl_z(S, 0, 0, 0, 1.3, 0.82, 'metal', sg)
        if lod < 2:
            for z in (-0.78, 0.78): cyl_z(S, 0, 0, z, 0.08, 0.55, 'wallLight', 14)
            for k in range(6):
                a = TAU * k / 6
                if lod == 0: S.box((0.9 * math.cos(a), 0.9 * math.sin(a), 0.78), (0.26, 0.16, 0.05), 'accentDark', rot=(0, 0, a), bev=0)
    sub(M, T(0, 0.85, 0, 0.0, 0.45, 0.0) @ Matrix.Rotation(0.28, 4, 'X'), reel)
    if lod < 2:
        pts = [Vector((1.3, 0.1, 0.4)), Vector((2.4, 0.07, 0.9)), Vector((3.4, 0.07, 0.6)), Vector((4.2, 0.07, 1.2))]
        for a, b in zip(pts, pts[1:]): tube(M, a, b, 0.07, 'metal', 6)
        chunk(M, (-1.7, 0.3, 1.0), (1.3, 1.0, 1.0), 'wallDark', rnd, 0.05, bv(lod, 0.07), rot=(0.0, 0.4, 0.1))


# ── ring segments (echo of the landmark ring) ─────────────────────────────────────────────────────
@prop('hoop', variants=2, h=4.2, fp=(3.4, 1.4), bank=(1.0, 0.8, 0.5), sink=0.05, tags=['wall', 'big'], cols=None)
def p_hoop(M, lod, rnd, v=0):
    R, tr, wd = [4.0, 2.7][v], 0.95, 1.5
    a0, a1 = [math.radians(2), math.radians(30)][v], [math.radians(78), math.radians(150)][v]
    cx, cy = [(-R, 0.0), (0.0, -R * math.cos(math.radians(60)) + 0.2)][v]
    na = int((a1 - a0) / math.radians(7)) + 1 if lod == 0 else int((a1 - a0) / math.radians(14)) + 1

    def core(c, rm):
        a = math.atan2(c.y - cy, c.x - cx)
        return Vector((cx + rm * math.cos(a), cy + rm * math.sin(a), 0))

    def sweep(r_in, r_out, w, mat, aa, bb):
        rm = (r_in + r_out) / 2
        bm = M.bm
        rings = []
        for k in range(na + 1):
            a = aa + (bb - aa) * k / na
            ca, sa = math.cos(a), math.sin(a)
            rings.append([bm.verts.new(p) for p in ((cx + r_in * ca, cy + r_in * sa, -w / 2), (cx + r_out * ca, cy + r_out * sa, -w / 2), (cx + r_out * ca, cy + r_out * sa, w / 2), (cx + r_in * ca, cy + r_in * sa, w / 2))])
        fs = []
        for k in range(na):
            for i in range(4):
                j = (i + 1) % 4
                fs.append(bm.faces.new((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i])))
        orient(M, fs, lambda c: c - core(c, rm))
        for k, sg in ((0, -1), (na, 1)):
            f = bm.faces.new(rings[k]); fs.append(f)
            a = aa + (bb - aa) * k / na
            orient(M, [f], lambda c, a=a, sg=sg: Vector((-math.sin(a) * sg, math.cos(a) * sg, 0)))
        for f in fs: f.material_index = MI[mat]
    sweep(R, R + tr, wd, 'wall', a0, a1)
    if lod < 2:
        sweep(R - 0.06, R + 0.2, wd + 0.14, 'wallLight', a0 + 0.05, a0 + 0.05 + (a1 - a0) * 0.18)
        sweep(R - 0.06, R + 0.2, wd + 0.14, 'wallLight', a1 - 0.05 - (a1 - a0) * 0.18, a1 - 0.05)
        sweep(R + tr - 0.2, R + tr + 0.07, wd * 0.62, 'accent', a0 + (a1 - a0) * 0.3, a0 + (a1 - a0) * 0.62)
        if lod == 0: sweep(R - 0.03, R + 0.05, wd + 0.04, 'accentDark', a0 + (a1 - a0) * 0.3, a0 + (a1 - a0) * 0.62)
    chunk(M, (cx + (R + 0.5) * math.cos(a0) + 0.9, 0.2, 1.2), (1.2, 0.7, 1.0), 'wallLight', rnd, 0.06, bv(lod), rot=(0.0, 0.7, 0.2))


# ── leaning plates ────────────────────────────────────────────────────────────────────────────────
@prop('panels', variants=2, h=2.2, fp=(1.6, 1.2), bank=(0.8, 0.7, 0.3), sink=0.05, tags=['small'], cols=None)
def p_panels(M, lod, rnd, v=0):
    def plate(S, w, h, mat='accent'):
        S.box((0, h / 2, 0), (w, h, 0.14), mat, bev=bv(lod, 0.04), seg=1)
        if lod < 2:
            fm = 'accentDark' if mat == 'accent' else 'wallLight'
            S.box((0, h / 2, 0.09), (w * 0.8, h * 0.78, 0.06), fm, bev=0, seg=1)
            S.box((0, 0.1, 0.08), (w, 0.2, 0.1), 'wallDark', bev=0, seg=1)
    if v == 0:
        sub(M, T(0, -0.12, 0.2, -0.38, 0.0, 0.05), lambda S: plate(S, 1.5, 2.1))
        sub(M, T(1.55, -0.1, -0.1, -0.2, -0.5, -0.1), lambda S: plate(S, 1.3, 1.8))
        sub(M, T(-1.35, -0.1, 0.2, -0.55, 0.45, 0.12), lambda S: plate(S, 1.2, 1.5, 'wall'))
        if lod < 2: chunk(M, (0.3, 0.25, -0.7), (1.2, 0.9, 0.9), 'wallDark', rnd, 0.06, bv(lod), rot=(0.0, 0.3, 0.1))
    else:
        sub(M, T(0, -0.1, 0.0, -0.45, 0.2, 0.08), lambda S: plate(S, 1.8, 2.2, 'wall'))
        sub(M, T(1.7, -0.1, 0.2, -0.22, -0.4, -0.15), lambda S: plate(S, 1.2, 1.4))


# ── rubble pieces: bevelled concrete fragments (satellites) ───────────────────────────────────────
@prop('chunk', variants=5, h=1.2, fp=(1.2, 1.0), bank=(0.8, 0.7, 0.3), sink=0.05, tags=['small', 'rubble'], cols=None)
def p_chunk(M, lod, rnd, v=0):
    b = bv(lod, 0.07)
    if v == 0:      # wedge slab
        P = [(-0.8, -0.3), (0.8, -0.3), (0.8, 0.25), (0.15, 0.62), (-0.6, 0.45), (-0.8, 0.15)]
        sub(M, T(0, 0.1, 0, 0.1, 0.5, 0.18), lambda S: (prism_xy(S, P, -0.45, 0.45, 'wall', bev=b, seg=1), S.box((0, 0.25, 0.47), (1.0, 0.45, 0.06), 'accent', bev=0) if lod < 2 else None))
    elif v == 1:    # pair of blocks
        chunk(M, (-0.4, 0.28, 0), (1.1, 0.8, 0.9), 'wallLight', rnd, 0.1, b, rot=(0.1, 0.4, 0.15))
        chunk(M, (0.7, 0.18, 0.4), (0.7, 0.5, 0.6), 'wall', rnd, 0.1, b, rot=(0.2, 1.0, -0.2))
    elif v == 2:    # trio
        chunk(M, (0, 0.3, 0), (1.0, 0.8, 1.0), 'wall', rnd, 0.12, b, rot=(0.15, 0.2, 0.3))
        chunk(M, (0.9, 0.15, 0.5), (0.6, 0.45, 0.55), 'accent', rnd, 0.12, b, rot=(0.0, 0.8, 0.2))
        chunk(M, (-0.6, 0.12, 0.8), (0.55, 0.35, 0.5), 'wallDark', rnd, 0.1, b, rot=(0.3, 0.1, 0.1))
    elif v == 3:    # chunk with exposed steel
        chunk(M, (0, 0.35, 0), (1.3, 0.9, 1.0), 'wallLight', rnd, 0.1, b, rot=(0.1, 0.3, 0.1))
        if lod < 2:
            for k in range(3): beam_box(M, Vector((-0.4 + 0.4 * k, 0.8, 0.1)), Vector((-0.5 + 0.45 * k, 1.35 + 0.1 * k, 0.1 + 0.1 * k)), 0.07, 0.07, 'metal', 0.0)
    else:           # long fallen beam piece
        sub(M, T(0, 0.2, 0, 0.0, 0.4, 0.06), lambda S: (S.box((0, 0, 0), (2.2, 0.4, 0.5), 'metal', bev=b, seg=1), S.box((0, 0.2, 0), (2.2, 0.1, 0.9), 'trim', bev=b, seg=1)))


# ── low, step-over dressing for the walking lanes ────────────────────────────────────────────────
@prop('lowwall', variants=3, h=1.1, fp=(2.4, 0.7), bank=(1.0, 0.9, 0.3), sink=0.2, tags=['low', 'wall'], colmax=3, colmin=0.55)
def p_lowwall(M, lod, rnd, v=0):
    """knee-high wall remnant (footing of a lost building): stepped top, snow cap, a recessed orange bay"""
    L, T_ = [4.6, 3.6, 5.4][v], 0.62
    prof = [[(0, 0.80), (0.28, 0.80), (0.31, 0.52), (0.62, 0.50), (0.66, 0.74), (1.0, 0.70)],
            [(0, 0.55), (0.3, 0.58), (0.34, 0.86), (0.74, 0.84), (0.78, 0.5), (1.0, 0.48)],
            [(0, 0.72), (0.18, 0.72), (0.22, 0.46), (0.5, 0.44), (0.56, 0.84), (0.8, 0.82), (0.84, 0.58), (1.0, 0.56)]][v]
    ks = [(-L / 2 + f * L, h) for f, h in prof]
    M.box((0, -0.15, 0), (L + 0.2, 0.4, T_ + 0.2), 'wallDark', bev=bv(lod, 0.05), seg=1)
    prism_xy(M, profile_poly(ks, -0.45), -T_ / 2, T_ / 2, 'wall', bev=bv(lod, 0.05), seg=1)
    if lod == 2: return
    for (xa, ya), (xb, yb) in zip(ks, ks[1:]):
        if abs(ya - yb) < 1e-3 and xb - xa > 0.6:
            M.box(((xa + xb) / 2, ya + 0.06, 0), (xb - xa + 0.06, 0.14, T_ + 0.16), 'wallLight', bev=bv(lod, 0.04), seg=1)
            snow_top(M, xa + 0.04, xb - 0.04, ya + 0.12, T_, 0.2, seed=v * 5 + int(xa * 3), lod=lod)
    xc = ks[2][0] + (ks[3][0] - ks[2][0]) * 0.5 if v != 1 else ks[1][0] + 0.5
    M.box((xc, 0.28, T_ / 2 + 0.03), (min(1.1, L * 0.22), 0.4, 0.07), 'accent', bev=0.0)
    if lod == 0:
        for sx in (-1, 1): M.box((sx * (L / 2 - 0.12), 0.2, T_ / 2 + 0.03), (0.2, 0.5, 0.07), 'wallLight', bev=0.02, seg=1)


@prop('beams', variants=2, h=0.9, fp=(2.2, 1.4), bank=(0.9, 0.8, 0.25), sink=0.05, tags=['low', 'metal'], colmax=3, colmin=0.55)
def p_beams(M, lod, rnd, v=0):
    """fallen girders: I-beams crossing at low angles, painted ends"""
    def ibeam(S, L, wf=0.34, hw=0.4):
        S.box((0, 0, 0), (L, 0.05, hw * 0.6 + 0.06), 'metal', bev=0, seg=1) if False else None
        S.box((0, hw / 2, 0), (L, 0.07, wf), 'metal', bev=bv(lod, 0.02), seg=1)
        S.box((0, -hw / 2, 0), (L, 0.07, wf), 'metal', bev=bv(lod, 0.02), seg=1)
        S.box((0, 0, 0), (L, hw, 0.07), 'wallDark', bev=0, seg=1)
        if lod < 2: S.box((L / 2 - 0.35, 0.0, 0), (0.7, hw + 0.08, wf + 0.04), 'accent', bev=bv(lod, 0.02), seg=1)
    if v == 0:
        sub(M, T(-0.2, 0.2, 0.3, 0.0, 0.2, 0.05), lambda S: ibeam(S, 3.6))
        sub(M, T(0.4, 0.5, -0.2, 0.0, -0.9, 0.18), lambda S: ibeam(S, 3.0))
        sub(M, T(0.8, 0.12, 0.8, 0.0, 0.55, 0.0), lambda S: ibeam(S, 2.4))
    else:
        sub(M, T(0, 0.2, 0, 0.0, 0.1, 0.06), lambda S: ibeam(S, 4.0, 0.4, 0.5))
        sub(M, T(0.6, 0.65, 0.1, 0.0, 0.1, 0.12) @ Matrix.Translation((0, 0, 0)), lambda S: ibeam(S, 3.0, 0.3, 0.36))
        if lod < 2: chunk(M, (-1.4, 0.15, 0.9), (1.0, 0.5, 0.8), 'wall', rnd, 0.06, bv(lod), rot=(0.0, 0.6, 0.1))


@prop('plate', variants=3, h=0.7, fp=(1.6, 1.4), bank=(0.9, 0.8, 0.22), sink=0.05, tags=['low', 'flat'], col=False)
def p_plate(M, lod, rnd, v=0):
    """deck plates and hatch covers half sunk in the snow"""
    if v == 0:      # two deck plates, one lifted at an edge
        sub(M, T(-0.5, 0.0, 0.1, 0.0, 0.2, 0.0), lambda S: (S.box((0, 0.06, 0), (2.2, 0.14, 1.6), 'deck', bev=bv(lod, 0.03), seg=1), S.box((0, 0.14, 0), (2.0, 0.04, 1.4), 'wallDark', bev=0) if lod < 2 else None))
        sub(M, T(1.5, 0.0, -0.2, 0.0, -0.4, 0.28), lambda S: (S.box((0, 0.0, 0), (1.6, 0.14, 1.3), 'wallLight', bev=bv(lod, 0.03), seg=1), S.box((0, 0.08, 0), (1.4, 0.04, 1.1), 'accent', bev=0) if lod < 2 else None))
    elif v == 1:    # circular hatch cover with an orange ring
        def hatch(S):
            cyl_y(S, 0, -0.1, 0, 0.3, 1.1, 'wall', 22 if lod == 0 else 12, bv(lod, 0.04))
            if lod < 2:
                cyl_y(S, 0, 0.18, 0, 0.06, 0.88, 'accent', 22 if lod == 0 else 12)
                cyl_y(S, 0, 0.22, 0, 0.06, 0.5, 'wallDark', 18 if lod == 0 else 10)
                if lod == 0: S.box((0, 0.3, 0), (0.9, 0.08, 0.14), 'metal', bev=0.02, seg=1)
        sub(M, T(0, 0.04, 0, 0.14, 0.4, 0.08), hatch)
        if lod < 2: chunk(M, (1.6, 0.1, 0.9), (0.9, 0.5, 0.8), 'wallLight', rnd, 0.06, bv(lod), rot=(0.0, 0.5, 0.1))
    else:           # grating panel + a coil of cable
        sub(M, T(0, 0.0, 0, 0.0, 0.3, 0.1), lambda S: (S.box((0, 0.05, 0), (2.4, 0.12, 1.4), 'metal', bev=bv(lod, 0.03), seg=1),
                                                         [S.box((x, 0.12, 0), (0.07, 0.06, 1.3), 'wallLight', bev=0) for x in np.linspace(-1.0, 1.0, 6)] if lod == 0 else None))
        if lod < 2:
            cb = Mod(); torus(cb, (0, 0, 0), 0.55, 0.09, 'y', 'accentDark', nmaj=16 if lod == 0 else 10, nmin=6)
            M.merge(cb, Matrix.Translation((1.8, 0.1, 0.6))); cb.free()


# ── stones, gravel fans, flat scrap: ultra-low dressing that may lie right in the lane (all below 0.5 m, never a collider) ───────────
def stone(M, c, r, mat, rnd, lod=0, sq=(1.0, 0.7, 0.86), cuts=3, yaw=None, flat=0.34):
    """chunky irregular stone: an icosphere pushed around by low-frequency noise and clamped by a few planes (crisp facets, rounded transitions),
    flattened at the foot so it sits in the snow. The planes are biased to the sides so the flat top stays small (a stone, not a snow-capped dome)."""
    bm = M.bm
    ico = bmesh.ops.create_icosphere(bm, subdivisions=(3 if r > 0.33 else 2) if lod == 0 else (2 if r > 0.33 else 1), radius=1.0)
    vs = ico['verts']
    ph = Vector((rnd.random() * 9, rnd.random() * 9, rnd.random() * 9))
    planes = []
    a0 = rnd.random() * TAU
    for i in range(cuts):
        a = a0 + TAU * (i + ru(rnd, -0.2, 0.2)) / cuts
        el = ru(rnd, 0.15, 0.62)                       # tilted side facets (normal.y 0.15 .. 0.58): no painted snow on them
        n = Vector((math.cos(a) * math.cos(el), math.sin(el), math.sin(a) * math.cos(el))).normalized()
        planes.append((n, ru(rnd, 0.58, 0.76)))
    topc = ru(rnd, 0.62, 0.8)                           # one clearly lower, narrow, slightly tilted top plane
    tt = Vector((ru(rnd, -0.35, 0.35), 1.0, ru(rnd, -0.35, 0.35))).normalized()
    planes.append((tt, topc))
    for v in vs:
        p = v.co.copy()
        k = 1.0 + 0.30 * (math.sin(p.x * 2.3 + ph.x) * math.cos(p.z * 2.1 + ph.z) + 0.6 * math.sin(p.y * 3.1 + p.x * 1.7 + ph.y))
        p *= k
        for n, d in planes:
            dd = p.dot(n)
            if dd > d: p -= n * (dd - d)
        p.y = max(p.y, -flat)
        v.co = Vector((p.x * sq[0] * r, p.y * sq[1] * r, p.z * sq[2] * r))
    faces = list(dict.fromkeys(f for v in vs for f in v.link_faces))
    for f in faces: f.material_index = MI[mat]
    if yaw is None: yaw = rnd.random() * TAU
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(yaw, 3, 'Y'), verts=vs)
    bmesh.ops.translate(bm, vec=c, verts=vs)


def fan(M, rnd, lod, n, r0, spread, along, mats, flat=0.34):
    """gravel fan: a focal stone, then satellites of decreasing size trailing off along `along` (radians, plan direction)"""
    for i in range(n):
        t = i / max(1, n - 1)
        r = r0 * (1.0 - 0.62 * t) * ru(rnd, 0.85, 1.15)
        d = (r0 * 1.1 + spread * t ** 0.85) * ru(rnd, 0.8, 1.15) if i else 0.0
        a = along + ru(rnd, -0.6, 0.6) * (0.4 + t)
        c = Vector((math.cos(a) * d, r * 0.2 - 0.02, math.sin(a) * d))
        if lod == 2 and i > 3: continue
        stone(M, c, r, mats[i % len(mats)] if i else mats[0], rnd, lod, sq=(ru(rnd, 0.9, 1.3), ru(rnd, 0.62, 0.85), ru(rnd, 0.8, 1.15)), cuts=3 if r > 0.18 else 2, flat=flat)


@prop('gravel', variants=4, h=0.5, fp=(1.8, 1.0), bank=(0.7, 0.6, 0.16), sink=0.05, tags=['low', 'flat', 'gravel'], col=False)
def p_gravel(M, lod, rnd, v=0):
    if v == 0:      # a hero stone with a short trailing fan
        fan(M, rnd, lod, 6, 0.46, 2.0, 0.2, ['wall', 'accent', 'wallLight', 'wallDark'])
    elif v == 1:    # orange stones leaning on each other + a few pebbles
        fan(M, rnd, lod, 5, 0.40, 1.6, 2.4, ['accent', 'accentDark', 'wall'])
    elif v == 2:    # slate cobbles in a tight clump
        fan(M, rnd, lod, 7, 0.32, 1.3, 1.2, ['wall', 'wallDark', 'wallLight'])
    else:           # wide spill of mid stones
        fan(M, rnd, lod, 8, 0.28, 2.4, -0.4, ['wall', 'wallDark', 'accent', 'wallLight'])


@prop('scrap', variants=4, h=0.5, fp=(1.6, 1.0), bank=(0.7, 0.6, 0.15), sink=0.04, tags=['low', 'flat', 'scrap'], col=False)
def p_scrap(M, lod, rnd, v=0):
    b = bv(lod, 0.03)
    if v == 0:      # flat broken slab sunk in the snow, one raised orange edge
        P = [(-1.1, -0.7), (1.0, -0.8), (1.25, 0.1), (0.5, 0.8), (-0.6, 0.7), (-1.2, 0.0)]
        sub(M, T(0, 0.02, 0, 0.0, 0.3, 0.07), lambda S: prism_xz(S, P, -0.2, 0.22, 'wall', bev=b, seg=1))
        if lod < 2: sub(M, T(0.2, 0.14, 0.25, 0.0, 0.3, 0.07), lambda S: S.box((0, 0, 0), (1.0, 0.1, 0.5), 'accent', bev=bv(lod, 0.02), seg=1))
        stone(M, Vector((1.4, 0.0, 0.7)), 0.28, 'wallLight', rnd, lod)
    elif v == 1:    # two fallen rails with sleepers
        for k, z in enumerate((-0.45, 0.45)):
            sub(M, T(0, 0.12, z, 0.0, 0.05 * (k - 0.5), 0.02), lambda S: (S.box((0, 0, 0), (4.2, 0.14, 0.12), 'trim', bev=bv(lod, 0.02), seg=1), S.box((0, 0.1, 0), (4.2, 0.06, 0.2), 'wallLight', bev=0), S.box((1.3, 0.1, 0), (0.7, 0.07, 0.22), 'accent', bev=0) if lod < 2 else None))
        if lod < 2:
            for x in (-1.6, -0.5, 0.7, 1.7): sub(M, T(x, 0.02, 0, 0.0, 0.1 * x, 0.0), lambda S: S.box((0, 0, 0), (0.28, 0.14, 1.5), 'wall', bev=bv(lod, 0.03), seg=1))
    elif v == 2:    # bent sheet of orange cladding half under the snow + two plates
        sub(M, T(-0.2, 0.0, 0, -0.18, 0.4, 0.12), lambda S: (S.box((0, 0.1, 0), (1.9, 0.1, 1.2), 'accent', bev=bv(lod, 0.03), seg=1), S.box((0, 0.06, 0), (1.7, 0.1, 1.0), 'accentDark', bev=0) if lod < 2 else None))
        sub(M, T(1.7, -0.02, 0.3, 0.0, -0.5, 0.0), lambda S: S.box((0, 0.1, 0), (1.1, 0.12, 0.8), 'deck', bev=bv(lod, 0.03), seg=1))
        stone(M, Vector((-1.7, 0.0, -0.4)), 0.26, 'wall', rnd, lod)
    else:           # coil of cable + a short pipe + a stone
        cb = Mod(); torus(cb, (0, 0, 0), 0.5, 0.08, 'y', 'accentDark', nmaj=18 if lod == 0 else 10, nmin=6 if lod < 2 else 4)
        M.merge(cb, Matrix.Translation((0, 0.08, 0))); cb.free()
        tube(M, Vector((0.5, 0.14, 0.4)), Vector((1.9, 0.12, 1.1)), 0.06, 'metal', 6)
        tube(M, Vector((-0.6, 0.12, -0.2)), Vector((-2.0, 0.1, -0.9)), 0.15, 'trim', 8 if lod == 0 else 6)
        stone(M, Vector((0.9, 0.0, -0.9)), 0.3, 'wall', rnd, lod)


# ═════════════════════════════════════════════════ driver ═════════════════════════════════════════════════
LOD_CFG = {0: dict(rays=12, maxd=2.6, thr=0.12, minlen=1.0, passes=2), 1: dict(rays=8, maxd=3.0, thr=0.2, minlen=2.0, passes=1), 2: dict(rays=0, maxd=1, thr=1, minlen=1, passes=0)}
CACHE_DIR = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'eden_dcache')


def build_mod(name, v, lod):
    P = PROPS[name]
    M = Mod()
    rnd = random.Random(hash_name(name) * 31 + v * 7 + 3)
    P['fn'](M, lod, rnd, v=v)
    bmesh.ops.remove_doubles(M.bm, verts=M.bm.verts[:], dist=0.0007)
    cut_below(M)
    return M


def hash_name(s):
    h = 17
    for ch in s: h = (h * 131 + ord(ch)) % 1000003
    return h


def build_one(name, v, lod):
    t0 = time.time()
    M = build_mod(name, v, lod)
    data = finalize(M, **LOD_CFG[lod])
    M.free()
    nv = sum(len(m['pos']) for m in data.values()); nt = sum(len(m['idx']) // 3 for m in data.values())
    print(f'{name}{v} lod{lod}: {nv} verts {nt} tris {time.time() - t0:.1f}s', flush=True)
    return data


def tri_samples(P, I, step=0.22):
    """dense surface sample points over all triangles (numpy)"""
    T_ = P[I.reshape(-1, 3)]
    out = [P]
    e = np.maximum.reduce([np.linalg.norm(T_[:, 1] - T_[:, 0], axis=1), np.linalg.norm(T_[:, 2] - T_[:, 1], axis=1), np.linalg.norm(T_[:, 0] - T_[:, 2], axis=1)])
    for k in range(1, 12):
        sel = np.flatnonzero((np.ceil(e / step) == k) if k < 11 else (np.ceil(e / step) >= k))
        if not len(sel): continue
        t = T_[sel]
        for i in range(k + 1):
            for j in range(k + 1 - i):
                u, v = i / k, j / k
                out.append(t[:, 0] * (1 - u - v) + t[:, 1] * u + t[:, 2] * v)
    return np.concatenate(out)


def merge_cells(Qc, cs, colmin):
    cell = {}
    for ia, ib, y in zip(np.floor(Qc[:, 0] / cs).astype(int), np.floor(Qc[:, 2] / cs).astype(int), Qc[:, 1]):
        if y > cell.get((ia, ib), -9): cell[(ia, ib)] = y
    hot = {k: v for k, v in cell.items() if v >= colmin}
    bucket = lambda y: math.floor(y / 1.0)
    runs = []
    for ib in sorted({k[1] for k in hot}):
        cur = None
        for ia in sorted(k[0] for k in hot if k[1] == ib):
            y = hot[(ia, ib)]
            if cur and ia == cur['a1'] + 1 and bucket(y) == cur['bk']:
                cur['a1'] = ia; cur['y'] = min(cur['y'], y)
            else:
                if cur: runs.append(cur)
                cur = dict(a0=ia, a1=ia, b=ib, y=y, bk=bucket(y))
        if cur: runs.append(cur)
    boxes = []
    for r in sorted(runs, key=lambda r: (r['a0'], r['a1'], r['b'])):
        for bx in boxes:
            if bx['a0'] == r['a0'] and bx['a1'] == r['a1'] and bx['bk'] == r['bk'] and bx['b1'] == r['b'] - 1:
                bx['b1'] = r['b']; bx['y'] = min(bx['y'], r['y']); break
        else:
            boxes.append(dict(a0=r['a0'], a1=r['a1'], b0=r['b'], b1=r['b'], y=r['y'], bk=r['bk']))
    return [[round(bx['a0'] * cs + 0.05, 2), -1.0, round(bx['b0'] * cs + 0.05, 2), round((bx['a1'] + 1) * cs - 0.05, 2), round(max(0.8, bx['y'] * 0.92), 2), round((bx['b1'] + 1) * cs - 0.05, 2)] for bx in boxes]


def analyze(data, meta):
    """footprint extents above ground + merged collider boxes (local space, y from -1) from the LOD0 geometry"""
    pts = [tri_samples(m['pos'].astype(np.float64), m['idx'].astype(np.int64)) for mn, m in data.items() if mn != 'snow']
    if not pts: return dict(ext=[0, 0, 0, 0, 0], cols=[])
    Q = np.concatenate(pts)
    above = Q[Q[:, 1] > 0.12]
    ext = [float(above[:, 0].min()), float(above[:, 0].max()), float(above[:, 2].min()), float(above[:, 2].max()), float(above[:, 1].max())] if len(above) else [0, 0, 0, 0, 0]
    cols = []
    if meta.get('col', True):
        Qc = Q[Q[:, 1] < meta.get('colcap', 99.0)]
        for cs in (0.5, 0.7, 0.9, 1.2, 1.6):               # coarser cells until the box count is small enough (the player tests every box)
            cols = merge_cells(Qc, cs, meta.get('colmin', 0.78))
            if len(cols) <= meta.get('colmax', 6): break
    return dict(ext=[round(e, 2) for e in ext], cols=cols)


def write_with_extras(path, meshes, extras):
    G.write_glb(path, meshes)           # int8 normals / ubyte colour / float positions (KHR_mesh_quantization)
    raw = open(path, 'rb').read()
    jl, jt = struct.unpack('<II', raw[12:20])
    j = json.loads(raw[20:20 + jl].decode())
    j['asset']['extras'] = extras
    j['asset']['generator'] = 'eden gen_debris'
    jb = json.dumps(j, separators=(',', ':')).encode()
    while len(jb) % 4: jb += b' '
    rest = raw[20 + jl:]
    total = 12 + 8 + len(jb) + len(rest)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(jb), 0x4E4F534A)); f.write(jb)
        f.write(rest)


def main(argv):
    names = [a for a in argv if not a.startswith('-')]
    os.makedirs(CACHE_DIR, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    meshes = {}
    cat = {}
    EXT = {}
    for name, P in PROPS.items():
        for v in range(P['variants']):
            for lod in (0, 1, 2):
                path = os.path.join(CACHE_DIR, f'{name}{v}_l{lod}.pkl')
                if (not names or name in names) or not os.path.exists(path):
                    import pickle
                    data = build_one(name, v, lod)
                    pickle.dump(data, open(path, 'wb'))
                else:
                    import pickle
                    data = pickle.load(open(path, 'rb'))
                if lod == 0: EXT[(name, v)] = analyze(data, P['meta'])
                for mname, m in data.items(): meshes[f'{name}{v}_l{lod}_{mname}'] = m
        meta = {k: v for k, v in P['meta'].items() if k not in ('cols', 'fp', 'h')}
        meta['variants'] = P['variants']
        meta['ext'] = [EXT[(name, v)]['ext'] for v in range(P['variants'])]
        meta['cols'] = [EXT[(name, v)]['cols'] for v in range(P['variants'])]
        cat[name] = meta
    write_with_extras(OUT, meshes, {'props': cat})
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')


if __name__ == '__main__':
    main(sys.argv[1:])
