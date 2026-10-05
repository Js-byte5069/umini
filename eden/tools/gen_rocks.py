"""Blender (bpy) asset generator: hand-sculpted stylised rocks (anime / cel-shaded look) with baked vertex AO + edge lightening,
3 LODs each, conforming snow caps, plus a small library of pebbles.
Run:  PYTHONDONTWRITEBYTECODE=1 python3 gen_rocks.py   (needs `pip install bpy==4.2.0`, numpy)  ->  ../assets/rocks.glb
      (ROCKS_OUT=/path/x.glb redirects the output, ROCKS_ONLY=3,7 builds only some variants for quick looks)

How a rock is made (all vectorised with numpy, deterministic):
  * a rock is a union of 1-3 convex "lumps"; every lump is a superellipsoid cut by 4-8 big planes with soft edges
    (soft-max of signed distances -> chiselled planar faces with softly rounded crisp edges), then shaved by a few chip planes,
    a groove/crack, strata ledges and a little noise.  The surface is solved radially (bisection) on an icosphere.
  * the dense (ico 6, ~20k tris) rock is baked: self-occlusion AO + convex-edge lightening + patchy value variation,
    then decimated (Blender collapse) to the LOD budget; AO and normals are projected from the dense mesh onto the low
    poly vertices (high -> low bake), so 150-600 triangles still shade like a smooth sculpt with crisp cel terminators.
  * snow caps are separate meshes built on the rock surface: a mask (up-facing, thicker on flat tops, longer drips on the lee
    side, azimuth "tongues") thresholded per pixel in the game, thickness profile with pillow bumps, own smooth normals.
Variants (names `rk{i}_{kind}_{H|S}_lod{0..3}`, snow `rk{i}_{kind}_{H|S}_snow{0..3}`; H = dense hero variant for 2 m+ rocks,
S = cheap small-rock variant):  kinds boulder / chunk / shard / slab / stack (and strata = tiered butte, hero only).
Pebbles `pb{j}`: ~40-triangle stones; COLOR_0 = (shade, snow-top weight, 0): the game mixes rock/snow colour.
Triangle budgets per LOD (body / snow cap): hero 3000/~900, 1050/~250, 380/~70, 120/~20; small 520/~250, 210/~70, 84/~25, 36/~8.
Unit conventions: horizontal half-extent = 1, y = 0 is the nominal waterline (roughly the lowest third is buried).
Blender y is exported as UP (export_yup=False).
The GLB is rewritten with int8 normals / ubyte colours (KHR_mesh_quantization).
"""
import bpy, bmesh, math, random, os, sys
import numpy as np
from mathutils import Vector, bvhtree
from mathutils.interpolate import poly_3d_calc

OUT = os.environ.get('ROCKS_OUT') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'rocks.glb')
ONLY = set(int(x) for x in os.environ['ROCKS_ONLY'].split(',')) if os.environ.get('ROCKS_ONLY') else None
TAU = math.tau

# (kind, hero) per variant index
VARIANTS = (
    [('boulder', True)] * 3 + [('chunk', True)] * 4 + [('slab', True)] * 2 + [('stack', True)] * 2 + [('strata', True)] * 3 +
    [('boulder', False)] * 5 + [('chunk', False)] * 6 + [('shard', False)] * 5 + [('slab', False)] * 3 + [('stack', False)] * 4
)
N_PEB = 12
TRIS = {True: [3000, 1050, 380, 120], False: [520, 210, 84, 36]}        # decimation targets per LOD
CAPSUB = {True: [5, 4, 3, 2], False: [4, 3, 2, 1]}                          # icosphere subdivision of the snow-cap base mesh
HI_SUB = 6
SHRINK = [0.014, 0.026, 0.040, 0.07]                                  # body pulled inside the true surface per LOD (cap lip sits above it)
LIP = [0.042, 0.056, 0.075, 0.11]                                          # snow cap lift at its contour per LOD


# ── numpy helpers ─────────────────────────────────────────────────────────────────────────────
def sstep(a, b, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def smax(terms, k):
    T = np.stack(terms, 0)
    m = T.max(0)
    return m + np.log(np.exp(k * (T - m)).sum(0)) / k


class Noise:
    """smooth vectorised noise: sum of random plane waves (std ~1)"""
    def __init__(self, seed, n=28):
        r = np.random.RandomState(seed)
        d = r.normal(size=(n, 3))
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        self.d = (d * r.uniform(0.7, 1.4, size=(n, 1))).T
        self.ph = r.uniform(0, TAU, n)
        self.n = n

    def __call__(self, P, f=1.0):
        return np.sin(TAU * f * (P @ self.d) + self.ph).sum(1) / math.sqrt(self.n / 2)

    def fbm(self, P, f=1.0, oct=2):
        return sum(self(P, f * 2.03 ** o) * 0.5 ** o for o in range(oct)) / (1.0 + 0.5 * (oct > 1) + 0.25 * (oct > 2))


_ico = {}


def ico(sub):
    if sub not in _ico:
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
        bm.verts.ensure_lookup_table()
        V = np.array([v.co[:] for v in bm.verts], dtype=np.float64)
        F = np.array([[v.index for v in f.verts] for f in bm.faces], dtype=np.int64)
        bm.free()
        _ico[sub] = (V, F)
    return _ico[sub]


def rot_matrix(rnd):
    # random rotation (so the triangulation poles never line up with the rock features)
    q = np.array([rnd.gauss(0, 1) for _ in range(4)])
    q /= np.linalg.norm(q)
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def dirv(az, el):
    return np.array([math.cos(el) * math.cos(az), math.sin(el), math.cos(el) * math.sin(az)])


def rot_axis(axis, ang):
    a = np.asarray(axis, dtype=np.float64)
    a = a / np.linalg.norm(a)
    c, s = math.cos(ang), math.sin(ang)
    x, y, z = a
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


def face_normals(V, F):
    return np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])


def vert_normals(V, F):
    fn = face_normals(V, F)
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    return vn / (np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12)


def adjacency(F):
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]], 0)
    e = np.concatenate([e, e[:, ::-1]], 0)
    return e[:, 0], e[:, 1]


def nbr_mean(x, adj, n):
    ai, bi = adj
    acc = np.zeros_like(x)
    cnt = np.zeros(n)
    np.add.at(acc, ai, x[bi])
    np.add.at(cnt, ai, 1.0)
    cnt = np.maximum(cnt, 1.0)
    return acc / (cnt[:, None] if x.ndim == 2 else cnt)


def jacobi(x, adj, n, iters):
    for _ in range(iters):
        x = 0.5 * x + 0.5 * nbr_mean(x, adj, n)
    return x


# ── the rock field ────────────────────────────────────────────────────────────────────────────
def lump_terms(P, L):
    q = P - L['c']
    qr = q @ L['R'] if L.get('R') is not None else q
    a = np.abs(qr) / np.array(L['r'])
    e = L['e']
    s_e = ((a ** e).sum(1)) ** (1.0 / e) - 1.0
    s_e = s_e * min(L['r'])
    terms = [s_e] + [q @ n - d for n, d in L['planes']]
    return smax(terms, L['k'])


def solve_radial(spec, U, extra):
    """per-lump radial extent along each direction of U (origin must be inside every lump), combined with a soft maximum"""
    ts = []
    for L in spec['lumps']:
        def S(P, L=L):
            terms = [lump_terms(P, L)] + [P @ n - d for n, d in extra]
            return smax(terms, spec['kx'])
        lo = np.zeros(len(U))
        hi = np.full(len(U), 3.2)
        for _ in range(26):
            mid = (lo + hi) * 0.5
            inside = S(U * mid[:, None]) < 0
            lo = np.where(inside, mid, lo)
            hi = np.where(inside, hi, mid)
        ts.append(lo)
    if len(ts) == 1:
        return ts[0]
    return smax(ts, spec['kr'])


def rock_shape(spec, U, noise, norm=None, detail=True):
    """positions of the rock surface along directions U (n,3)"""
    extra = [(np.array([0.0, -1.0, 0.0]), spec['bottom'])]
    t = solve_radial(spec, U, extra)
    if 'chips' not in spec:
        # chip planes shave the corners of the pass-1 shape (support distance minus a few %)
        P0 = U * t[:, None]
        rnd = random.Random(spec['seed'] + 7)
        chips = []
        for _ in range(spec['nchip']):
            for _try in range(6):
                if rnd.random() < 0.55:
                    n = dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(25, 62)))    # shoulder facet
                else:
                    n = dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(-20, 25)))   # side facet
                h = (P0 @ n).max()
                if h > 0.25:
                    break
            chips.append((n, h * (1 - rnd.uniform(*spec['chipdelta']))))
        spec['chips'] = chips
        extra = extra + chips
        t = solve_radial(spec, U, extra)
    else:
        extra = extra + spec['chips']
        t = solve_radial(spec, U, extra)
    P = U * t[:, None]
    if not detail:      # the smooth base (planes + chips only): the snow cap is built on it so ledges / cracks never notch the snow outline
        return (P - norm[0]) * norm[1], norm
    # detail: broad facet wobble + fine noise + strata ledges + crack grooves (all along the radial direction)
    dr = noise.fbm(P, spec['nf'], 2) * spec['namp']
    if spec['strata']:
        amp, fr, soft = spec['strata']
        ph = P[:, 1] * fr + noise(P, 0.35) * 0.6
        saw = (ph % 1.0)
        dr = dr + amp * (sstep(0.0, 0.2 + soft, saw) - 0.5) * (1 - 0.7 * sstep(0.55, 0.95, np.abs(P[:, 1] / max(t.max(), 1e-3))))
    for (n, d0, w, depth) in spec['cracks']:
        dist = P @ n - d0
        dr = dr - depth * np.exp(-(dist / w) ** 2)
    t2 = np.maximum(t + dr, 0.05)
    P = U * t2[:, None]
    if norm is None:
        mn, mx = P.min(0), P.max(0)
        h = max(mx[0] - mn[0], mx[2] - mn[2]) / 2
        y0 = mn[1] + spec['wl'] * (mx[1] - mn[1])
        norm = (np.array([(mn[0] + mx[0]) / 2, y0, (mn[2] + mx[2]) / 2]), 1.0 / h)
    return (P - norm[0]) * norm[1], norm


# ── spec builders (one per rock family) ───────────────────────────────────────────────────────
def planes_ring(rnd, n, d_lo, d_hi, el_lo, el_hi, jitter=0.28, a0=None):
    a0 = rnd.uniform(0, TAU) if a0 is None else a0
    out = []
    for i in range(n):
        az = a0 + (i + rnd.uniform(-jitter, jitter)) / n * TAU
        out.append((dirv(az, rnd.uniform(el_lo, el_hi)), rnd.uniform(d_lo, d_hi)))
    return out


def spec_common(seed, **kw):
    s = dict(seed=seed, kx=22.0, kr=14.0, bottom=0.45, nchip=3, chipdelta=(0.04, 0.10), nf=2.4, namp=0.012, strata=None,
             cracks=[], wl=0.34, lee=None)
    s.update(kw)
    return s


def spec_chunk(rnd, seed, hero):
    ns = rnd.choice([6, 7, 7, 8]) if hero else rnd.choice([4, 5, 5, 6])
    planes = planes_ring(rnd, ns, 0.56, 0.98, -0.06, 0.48, jitter=0.34)
    planes.append((dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(62, 82))), rnd.uniform(0.72, 0.95)))     # tilted top
    for _ in range(rnd.choice([1, 2, 2])):
        planes.append((dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(30, 55))), rnd.uniform(0.74, 1.0)))   # shoulders
    L = dict(c=np.zeros(3), r=(1.4, rnd.uniform(1.2, 1.5), rnd.uniform(1.0, 1.35)), e=2.4, planes=planes, k=rnd.uniform(30, 40) if hero else rnd.uniform(20, 30))
    cr = []
    if rnd.random() < 0.5:
        cr.append((dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(-10, 40))), rnd.uniform(0.15, 0.4), 0.03, rnd.uniform(0.03, 0.06)))
    if hero:
        return spec_common(seed, lumps=[L], nchip=rnd.choice([5, 6, 7]), chipdelta=(0.05, 0.17), cracks=cr, namp=0.011, nf=1.1, bottom=0.48, kx=34.0,
                           strata=(0.030, rnd.uniform(1.6, 2.3), 0.22) if rnd.random() < 0.6 else None)
    return spec_common(seed, lumps=[L], nchip=rnd.choice([3, 4, 5]), cracks=cr, namp=0.006, nf=1.4, bottom=0.48, kx=26.0)


def spec_boulder(rnd, seed, hero):
    planes = planes_ring(rnd, rnd.choice([5, 6, 6]) if hero else rnd.choice([4, 4, 5]), 0.78, 0.97, 0.0, 0.38, 0.35)
    planes.append((dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(64, 82))), rnd.uniform(0.70, 0.90)))
    planes.append((dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(36, 55))), rnd.uniform(0.84, 1.0)))
    L = dict(c=np.zeros(3), r=(1.2, rnd.uniform(1.05, 1.35), rnd.uniform(0.95, 1.2)), e=2.1, planes=planes, k=(rnd.uniform(14, 20) if hero else rnd.uniform(10, 15)))
    return spec_common(seed, lumps=[L], nchip=(4 if hero else 2), chipdelta=((0.05, 0.14) if hero else (0.03, 0.08)), kx=16.0, namp=(0.010 if hero else 0.006), nf=1.2, bottom=0.46)


def spec_shard(rnd, seed, hero):
    ang = math.radians(rnd.uniform(10, 24))
    az = rnd.uniform(0, TAU)
    R = rot_axis([math.cos(az), 0, math.sin(az)], ang)
    sides = [(np.array([1.0, 0, 0]), rnd.uniform(0.44, 0.58)), (np.array([-1.0, 0, 0]), rnd.uniform(0.44, 0.58)),
             (np.array([0, 0, 1.0]), rnd.uniform(0.62, 0.86)), (np.array([0, 0, -1.0]), rnd.uniform(0.62, 0.86))]
    # slanted wedge cut on top: normal pitched over one side
    wa = rnd.choice([0, math.pi, math.pi / 2, -math.pi / 2]) + rnd.uniform(-0.3, 0.3)
    sides.append((dirv(wa, math.radians(rnd.uniform(34, 52))), rnd.uniform(0.78, 0.96)))
    sides.append((dirv(wa + rnd.uniform(1.8, 2.8), math.radians(rnd.uniform(55, 75))), rnd.uniform(0.96, 1.12)))
    planes = [(R @ n, d) for n, d in sides]
    L = dict(c=np.zeros(3), r=(0.9, 1.6, 1.1), e=2.7, planes=planes, k=rnd.uniform(20, 28), R=R)
    return spec_common(seed, lumps=[L], nchip=rnd.choice([3, 4]), bottom=0.62, wl=0.30, namp=0.005, nf=1.6, kx=26.0)


def spec_slab(rnd, seed, hero):
    planes = planes_ring(rnd, rnd.choice([4, 5, 6]), 0.66, 0.92, -0.04, 0.22, 0.3)
    planes.append((dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(76, 86))), rnd.uniform(0.27, 0.34)))
    L = dict(c=np.zeros(3), r=(1.4, rnd.uniform(0.40, 0.5), rnd.uniform(0.9, 1.15)), e=3.0, planes=planes, k=rnd.uniform(18, 26))
    return spec_common(seed, lumps=[L], nchip=rnd.choice([3, 4]), bottom=0.22, namp=0.004, nf=1.4, wl=0.38, kx=24.0)


def spec_stack(rnd, seed, hero):
    lumps = []

    def mk(c, sc, tall):
        pl = planes_ring(rnd, rnd.choice([4, 5]), 0.58 * sc, 0.92 * sc, -0.04, 0.42, 0.32)
        pl.append((dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(62, 82))), rnd.uniform(0.70, 0.92) * sc * tall))
        L = dict(c=np.array(c, dtype=np.float64), r=(1.4 * sc, 1.35 * sc * tall, 1.2 * sc), e=2.4, planes=pl, k=rnd.uniform(18, 26))
        for _ in range(8):     # every lump must contain the origin (the union is solved radially from there)
            if lump_terms(np.zeros((1, 3)), L)[0] < -0.04:
                break
            L['c'] = L['c'] * 0.8
        return L

    lumps.append(mk([0, 0, 0], 1.0, rnd.uniform(0.9, 1.1)))
    a = rnd.uniform(0, TAU)
    for i in range(rnd.choice([1, 2, 2])):
        sc = rnd.uniform(0.58, 0.74) if i == 0 else rnd.uniform(0.40, 0.54)
        ang = a + i * rnd.uniform(2.0, 3.4)
        lumps.append(mk([math.cos(ang) * 0.62, rnd.uniform(-0.12, 0.22), math.sin(ang) * 0.62], sc, rnd.uniform(0.9, 1.4)))
    return spec_common(seed, lumps=lumps, kr=rnd.uniform(16, 24), nchip=(rnd.choice([4, 5]) if hero else rnd.choice([2, 3])), chipdelta=((0.05, 0.15) if hero else (0.04, 0.10)), bottom=0.48, namp=(0.010 if hero else 0.006), nf=1.2, kx=26.0)


def spec_pebble(rnd, seed):
    planes = planes_ring(rnd, rnd.choice([5, 6, 7]), 0.80, 0.96, -0.10, 0.40, 0.35)
    planes.append((dirv(rnd.uniform(0, TAU), math.radians(rnd.uniform(62, 80))), rnd.uniform(0.74, 0.92)))
    L = dict(c=np.zeros(3), r=(1.0, rnd.uniform(0.85, 1.1), rnd.uniform(0.8, 1.0)), e=2.0, planes=planes, k=rnd.uniform(9, 13))
    return spec_common(seed, lumps=[L], nchip=2, chipdelta=(0.04, 0.10), kx=14.0, bottom=0.55, namp=0.02, nf=2.4, wl=0.34)


SPEC = {'chunk': spec_chunk, 'boulder': spec_boulder, 'shard': spec_shard, 'slab': spec_slab, 'stack': spec_stack}


# ── bake: AO + edge lightening + patchy variation ─────────────────────────────────────────────
def bake_ao(V, F, N, rays=18, maxd=0.9, seed=7):
    tree = bvhtree.BVHTree.FromPolygons([tuple(v) for v in V.tolist()], [tuple(f) for f in F.tolist()])
    rnd = np.random.RandomState(seed)
    r1, r2 = rnd.uniform(size=rays), rnd.uniform(size=rays)
    rr = np.sqrt(r1)
    samp = np.stack([rr * np.cos(TAU * r2), rr * np.sin(TAU * r2), np.sqrt(1 - r1)], 1)      # cosine hemisphere (local t,b,n)
    ao = np.zeros(len(V))
    for i in range(len(V)):
        n = N[i]
        t = np.cross(n, [0, 1, 0] if abs(n[1]) < 0.9 else [1, 0, 0])
        t /= np.linalg.norm(t)
        b = np.cross(n, t)
        D = samp[:, 0:1] * t + samp[:, 1:2] * b + samp[:, 2:3] * n
        o = Vector(V[i] + n * 0.003)
        hit = 0
        for d in D:
            if tree.ray_cast(o, Vector(d), maxd)[0] is not None:
                hit += 1
        ao[i] = 1 - hit / rays
    return ao


def bake_shade(V, F, N, noise, spec, banded):
    """vertex shade in 0..1: soft self-occlusion + lightened convex edges + patchy value + optional strata band"""
    n = len(V)
    adj = adjacency(F)
    ao = bake_ao(V, F, N)
    ao = jacobi(ao, adj, n, 1)
    lap = nbr_mean(V, adj, n) - V
    curv = (lap * N).sum(1)                      # < 0 convex, > 0 concave
    edge_len = np.linalg.norm(lap, axis=1).mean() + 1e-6
    cv = jacobi(curv / edge_len, adj, n, 2)
    convex = sstep(0.0, 0.55, -cv)
    concave = sstep(0.0, 0.7, cv)
    sh = (0.82 + 0.18 * ao) * (0.88 + 0.12 * convex) * (1.0 - 0.14 * concave)
    sh *= 0.58 + 0.42 * sstep(-0.62, 0.20, V[:, 1])                      # buried underside darker / cooler
    sh *= 0.94 + 0.06 * noise(V, 1.1) + 0.03 * noise(V, 3.1)
    # per-plane hand-painted value: normals are binned by direction and each bin gets its own small value offset, so neighbouring facets
    # of the same cel band still read as separately painted planes
    az = np.arctan2(N[:, 2], N[:, 0])
    el = np.arcsin(np.clip(N[:, 1], -1, 1))
    key = np.floor(az / (math.pi / 3.5) + 0.37).astype(np.int64) * 7 + np.floor(el / (math.pi / 5.0) + 0.21).astype(np.int64) * 13
    hv = ((key * 2654435761) % 1000) / 1000.0
    sh *= 0.93 + 0.12 * hv                                     # patchy hand-painted value
    if banded:
        band = np.sin((V[:, 1] * 3.3 + noise(V, 0.5) * 0.5) * TAU * 0.5)
        sh *= 1.0 - 0.10 * sstep(0.55, 0.95, band) * (1 - np.abs(N[:, 1]))
    return np.clip(sh, 0, 1)


# ── mesh helpers ──────────────────────────────────────────────────────────────────────────────
def make_mesh(name, V, F, normals=None, cols=None, extra_attr=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(V.tolist(), [], F.tolist())
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    if cols is not None:
        attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        flat = np.zeros((len(V), 4), dtype=np.float32)
        flat[:, :3] = cols if cols.ndim == 2 else cols[:, None]
        flat[:, 3] = 1.0
        attr.data.foreach_set('color', flat.reshape(-1))
    if normals is not None:
        me.normals_split_custom_set_from_vertices([tuple(x) for x in normals.tolist()])
    return me


def decimate(V, F, target_tris):
    me = make_mesh('tmp_hi', V, F)
    ob = bpy.data.objects.new('tmp_hi', me)
    bpy.context.scene.collection.objects.link(ob)
    md = ob.modifiers.new('d', 'DECIMATE')
    md.decimate_type = 'COLLAPSE'
    md.ratio = min(1.0, max(0.002, target_tris / len(F)))
    dg = bpy.context.evaluated_depsgraph_get()
    me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    V2 = np.array([v.co[:] for v in me2.vertices], dtype=np.float64)
    F2 = np.array([list(p.vertices) for p in me2.polygons], dtype=np.int64)
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    bpy.data.meshes.remove(me2)
    return V2, F2


def project(Vlo, Vhi, Fhi, attrs):
    """high -> low bake: interpolate per-vertex attributes (dict name -> (n,k) arrays on the hi mesh) at the closest hi surface points"""
    tree = bvhtree.BVHTree.FromPolygons([tuple(v) for v in Vhi.tolist()], [tuple(f) for f in Fhi.tolist()])
    out = {k: np.zeros((len(Vlo),) + a.shape[1:]) for k, a in attrs.items()}
    for i, p in enumerate(Vlo):
        loc, nor, fi, dist = tree.find_nearest(Vector(p))
        f = Fhi[fi]
        w = poly_3d_calc([Vector(Vhi[f[0]]), Vector(Vhi[f[1]]), Vector(Vhi[f[2]])], loc)
        for k, a in attrs.items():
            out[k][i] = w[0] * a[f[0]] + w[1] * a[f[1]] + w[2] * a[f[2]]
    return out


def build_body(V, F, N, shade, tris, shrink=0.0):
    if tris >= len(F):
        return V, F, N, shade
    V2, F2 = decimate(V, F, tris)
    pr = project(V2, V, F, {'n': N, 's': shade[:, None]})
    N2 = pr['n'] / (np.linalg.norm(pr['n'], axis=1, keepdims=True) + 1e-9)
    # the collapsed mesh may bulge past the true surface: pull it just inside so the snow cap (built on the true surface) always sits above it
    return V2 - N2 * shrink, F2, N2, pr['s'][:, 0]


# ── snow cap ──────────────────────────────────────────────────────────────────────────────────
def snow_cap(spec, noise, norm, U, F, thick, lee_az, seed, iters, lip):
    """thick rounded blanket on the up-facing part, built on the same smooth rock surface (no chips/cracks)"""
    n = len(U)
    adj = adjacency(F)
    P, _ = rock_shape(spec, U, noise, norm, detail=False)
    nrm0 = vert_normals(P, F)
    h = np.linalg.norm(P[F[:, 0]] - P[F[:, 1]], axis=1).mean()                     # mean edge length of this cap base mesh
    its = lambda sigma: max(1, int(round((sigma / h) ** 2 / 0.3)))                   # Jacobi passes for a blur of radius sigma (rock units)
    nrm = jacobi(nrm0, adj, n, its(0.07))
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
    nbl = jacobi(nrm0, adj, n, its(0.22))                  # heavily blurred normal: the snow outline ignores individual rock facets
    nbl /= np.linalg.norm(nbl, axis=1, keepdims=True) + 1e-9
    rnd = np.random.RandomState(seed)
    ny = nbl[:, 1]
    az = np.arctan2(nbl[:, 2], nbl[:, 0])
    horiz = np.sqrt(np.clip(1 - ny * ny, 0, 1))
    lee = np.maximum(np.cos(az - lee_az), 0) * horiz                       # lee side: snow hangs lower, drips
    nz = Noise(seed + 5)
    tongue = (np.sin(az * 2 + rnd.uniform(0, TAU)) * 0.5 + np.sin(az * 3 + rnd.uniform(0, TAU)) * 0.5)
    th = 0.77 - 0.32 * lee + 0.07 * tongue
    m = sstep(th - 0.14, th + 0.14, ny + 0.07 * nz(P, 1.1)) * sstep(-0.30, 0.10, P[:, 1])
    m = np.maximum(m, 0.97 * sstep(0.84, 0.95, ny))             # flat tops are always fully covered (no pinholes)
    m = jacobi(m, adj, n, its(0.15))                        # wide transition band (>= 3 triangles): the per-pixel contour stays smooth at any rock size
    m = sstep(0.08, 0.92, m)
    keep = m[F].max(1) >= 0.06
    # thickness: full on flat tops, soft pillows, thin lip toward the contour; below the contour the shell dives into the rock (alpha-cut anyway)
    flat = sstep(0.45, 0.97, ny)
    pil = np.zeros(n)
    for _ in range(2):
        c = rnd.normal(size=3)
        c /= np.linalg.norm(c)
        c[1] = abs(c[1]) * 0.8 + 0.4
        c /= np.linalg.norm(c)
        pil += np.exp(-np.sum((nbl - c) ** 2, 1) / 0.6) * rnd.uniform(0.10, 0.30)
    prof = sstep(0.48, 0.98, m)
    t = lip * sstep(0.30, 0.52, m) - 0.05 * (1 - sstep(0.15, 0.48, m)) + thick * prof * (0.55 + 0.45 * flat) * (1.0 + 0.12 * nz(P, 0.9) + pil)
    Pc = P + nrm * t[:, None]
    Fk = F[keep]
    used = np.unique(Fk)
    remap = -np.ones(n, dtype=np.int64)
    remap[used] = np.arange(len(used))
    Pk, mk, nk0 = Pc[used], m[used], nrm[used]
    Fk = remap[Fk]
    # normals of the cap itself (pillow shading), blended toward the rock's smooth normal at the lip
    ncap = vert_normals(Pk, Fk)
    adj2 = adjacency(Fk)
    ncap = jacobi(ncap, adj2, len(Pk), its(0.10))
    w = sstep(0.5, 0.85, mk)[:, None]
    nn = w * ncap + (1 - w) * nk0
    nn /= np.linalg.norm(nn, axis=1, keepdims=True) + 1e-9
    return Pk, Fk, nn, mk


# ── strata stacks (tiered buttes) ─────────────────────────────────────────────────────────────
STRATA_RES = [(52, 62), (34, 40), (22, 26)]


def sstep1(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def build_strata(seed, res):
    from mathutils import noise as bnoise
    nth, nrow = res
    rnd = random.Random(seed)
    off = Vector((rnd.random() * 40, rnd.random() * 40, rnd.random() * 40))
    tiers = 3 + rnd.randint(0, 2)
    ytop = 0.78 + rnd.random() * 0.22
    ybot = -0.45
    ws = [0.6 + rnd.random() for _ in range(tiers)]
    tot = sum(ws)
    ys, acc = [], ybot
    for w in ws:
        acc += (ytop - ybot) * w / tot
        ys.append(acc)
    rm, expo, phi, batter, gully = [], [], [], [], []
    r0 = 0.88 + rnd.random() * 0.12
    for i in range(tiers):
        rm.append(r0)
        r0 *= 0.66 + rnd.random() * 0.26
        expo.append(2.6 + rnd.random() * 1.8)
        phi.append(rnd.random() * math.pi)
        batter.append((rnd.random() - 0.5) * 0.16)
        gully.append((rnd.random() * TAU, 0.12 + rnd.random() * 0.1, 0.08 + rnd.random() * 0.1))
    ledge_w = 0.045

    def radius_at(y, th):
        R = rm[0]
        for i in range(tiers - 1):
            t = sstep1(ys[i] - ledge_w, ys[i] + ledge_w * 0.6, y)
            R = R + (rm[i + 1] - R) * t
        ti = 0
        for i in range(tiers):
            if y > ys[i] - ledge_w * 0.5 and i < tiers - 1:
                ti = i + 1
        ti = min(ti, tiers - 1)
        lo = ybot if ti == 0 else ys[ti - 1]
        hi = ys[ti]
        fy = (y - lo) / max(hi - lo, 1e-4)
        R *= 1.0 - batter[ti] * (fy - 0.5)
        c, s = math.cos(th + phi[ti]), math.sin(th + phi[ti])
        e = 2.0 / expo[ti]
        px = math.copysign(abs(c) ** e, c)
        pz = math.copysign(abs(s) ** e, s)
        blk = bnoise.fractal(Vector((math.cos(th) * 1.6, math.sin(th) * 1.6, ti * 3.1)) + off, 0.5, 2.0, 2) * 0.10
        gth, gw, gd = gully[ti]
        dth = (th - gth + math.pi) % TAU - math.pi
        g = gd * math.exp(-(dth / gw) ** 2) * sstep1(lo, lo + (hi - lo) * 0.5, y)
        return max(0.05, R * (1 + blk - g)), px, pz

    bm = bmesh.new()
    rows = []
    for j in range(nrow + 1):
        t = j / nrow
        y = ybot + (ytop - ybot) * t
        ring = []
        for i in range(nth):
            th = (i / nth) * TAU
            R, px, pz = radius_at(y, th)
            dome = 1.0
            if t > 0.92:
                q = (t - 0.92) / 0.08
                dome = math.sqrt(max(0.0, 1 - q * q))
            ring.append(bm.verts.new(Vector((R * px * dome, y, R * pz * dome))))
        rows.append(ring)
    bc = bm.verts.new(Vector((0, ybot, 0)))
    tc = bm.verts.new(Vector((0, ytop, 0)))
    for j in range(nrow):
        for i in range(nth):
            a, b = rows[j][i], rows[j][(i + 1) % nth]
            c, d = rows[j + 1][(i + 1) % nth], rows[j + 1][i]
            try:
                bm.faces.new((a, b, c, d))
            except ValueError:
                pass
    for i in range(nth):
        try:
            bm.faces.new((rows[0][(i + 1) % nth], rows[0][i], bc))
            bm.faces.new((rows[nrow][i], rows[nrow][(i + 1) % nth], tc))
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.normal_update()
    V = np.array([v.co[:] for v in bm.verts], dtype=np.float64)
    bm.verts.ensure_lookup_table()
    F = np.array([[v.index for v in f.verts] for f in bm.faces], dtype=np.int64)
    bm.free()
    return V, F


def strata_variant(seed, lodres):
    V, F = build_strata(seed, lodres)
    N = vert_normals(V, F)
    nz = Noise(seed)
    adj = adjacency(F)
    # cheaper AO: fewer rays on the big meshes
    ao = bake_ao(V, F, N, rays=10 if len(V) > 3000 else 14, maxd=0.9)
    ao = jacobi(ao, adj, len(V), 1)
    sh = (0.80 + 0.20 * ao) * (0.50 + 0.50 * sstep(-0.42, 0.30, V[:, 1])) * (0.94 + 0.06 * nz(V, 1.5))
    return V, F, N, np.clip(sh, 0, 1)


def strata_cap(V, F, seed, thick):
    """snow on the tier tops: mask from the surface normal, same technique as the other caps"""
    n = len(V)
    adj = adjacency(F)
    nrm = jacobi(vert_normals(V, F), adj, n, 3)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
    nz = Noise(seed + 9)
    m = sstep(0.40, 0.86, nrm[:, 1] + 0.10 * nz(V, 1.5)) * sstep(-0.30, 0.05, V[:, 1])
    m = jacobi(m, adj, n, 7)
    m = sstep(0.12, 0.88, m)
    keep = m[F].max(1) >= 0.12
    t = thick * sstep(0.46, 1.0, m) * (1.0 + 0.10 * nz(V, 1.3))
    Pc = V + nrm * (t + 0.012)[:, None]
    Fk = F[keep]
    used = np.unique(Fk)
    remap = -np.ones(n, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return Pc[used], remap[Fk], nrm[used], m[used]


# ── export plumbing ───────────────────────────────────────────────────────────────────────────
def quantize_glb(path):
    """rewrite the GLB with compact vertex data: NORMAL int8 (normalized), COLOR_0 ubyte (normalized) -> KHR_mesh_quantization"""
    import json, struct
    raw = open(path, 'rb').read()
    jlen = struct.unpack('<I', raw[12:16])[0]
    j = json.loads(raw[20:20 + jlen])
    boff = 20 + jlen
    blen = struct.unpack('<I', raw[boff:boff + 4])[0]
    binary = raw[boff + 8: boff + 8 + blen]
    CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
    NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}

    def read(ai):
        a = j['accessors'][ai]; bv = j['bufferViews'][a['bufferView']]
        n = a['count'] * NC[a['type']]
        return np.frombuffer(binary, dtype=CT[a['componentType']], count=n, offset=bv.get('byteOffset', 0) + a.get('byteOffset', 0)).reshape(a['count'], NC[a['type']])

    out = bytearray(); views = []; accs = []

    def push(arr, ctype, atype, target, stride=None, normalized=False, minmax=None):
        while len(out) % 4: out.append(0)
        off = len(out); data = arr.tobytes(); out.extend(data)
        bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data), 'target': target}
        if stride: bv['byteStride'] = stride
        views.append(bv)
        a = {'bufferView': len(views) - 1, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': atype}
        if normalized: a['normalized'] = True
        if minmax: a['min'], a['max'] = minmax
        accs.append(a)
        return len(accs) - 1

    for m in j['meshes']:
        for pr in m['primitives']:
            at = pr['attributes']
            pos = read(at['POSITION']).astype(np.float32)
            pr['attributes'] = {'POSITION': push(pos, 5126, 'VEC3', 34962, minmax=(pos.min(0).tolist(), pos.max(0).tolist()))}
            nrm = read(at['NORMAL']).astype(np.float32)
            q = np.zeros((nrm.shape[0], 4), np.int8); q[:, :3] = np.clip(np.rint(nrm * 127), -127, 127)
            pr['attributes']['NORMAL'] = push(q, 5120, 'VEC3', 34962, stride=4, normalized=True)
            if 'COLOR_0' in at:
                col = read(at['COLOR_0']).astype(np.float32)
                c4 = np.full((col.shape[0], 4), 255, np.uint8); c4[:, :3] = np.clip(np.rint(col[:, :3] * 255), 0, 255)
                pr['attributes']['COLOR_0'] = push(c4, 5121, 'VEC4', 34962, stride=4, normalized=True)
            if 'indices' in pr:
                idx = read(pr['indices'])
                dt = np.uint16 if int(idx.max()) < 65535 else np.uint32
                pr['indices'] = push(idx.astype(dt).reshape(-1), 5123 if dt == np.uint16 else 5125, 'SCALAR', 34963)
    j['accessors'] = accs; j['bufferViews'] = views
    j['buffers'] = [{'byteLength': len(out)}]
    j['extensionsUsed'] = sorted(set(j.get('extensionsUsed', []) + ['KHR_mesh_quantization']))
    j['extensionsRequired'] = sorted(set(j.get('extensionsRequired', []) + ['KHR_mesh_quantization']))
    jb = json.dumps(j, separators=(',', ':')).encode()
    while len(jb) % 4: jb += b' '
    while len(out) % 4: out.append(0)
    total = 12 + 8 + len(jb) + 8 + len(out)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(jb), 0x4E4F534A)); f.write(jb)
        f.write(struct.pack('<II', len(out), 0x004E4942)); f.write(out)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.data.collections.new('rocks')
    bpy.context.scene.collection.children.link(col)
    report = []

    def add_obj(name, me, loc):
        ob = bpy.data.objects.new(name, me)
        col.objects.link(ob)
        ob.location = loc

    for s, (kind, hero) in enumerate(VARIANTS):
        if ONLY is not None and s not in ONLY:
            continue
        hs = 'H' if hero else 'S'
        seed = s * 17 + 3
        tris = []
        if kind == 'strata':
            for l in range(3):
                V, F, N, sh = strata_variant(seed, STRATA_RES[l])
                add_obj(f'rk{s}_{kind}_{hs}_lod{l}', make_mesh('b', V, F, N, sh), (s * 3.5, l * 3.5, 0))
                if True:
                    Pc, Fc, Nc, mc = strata_cap(V, F, seed, 0.105)
                    add_obj(f'rk{s}_{kind}_{hs}_snow{l}', make_mesh('c', Pc, Fc, Nc, mc), (s * 3.5, l * 3.5, 0))
                tris.append(len(F))
        else:
            rnd = random.Random(seed)
            spec = SPEC[kind](rnd, seed, hero)
            noise = Noise(seed)
            R = rot_matrix(rnd)
            Uh, Fh = ico(HI_SUB)
            Uh = Uh @ R.T
            Vh, norm = rock_shape(spec, Uh, noise)
            Nh = vert_normals(Vh, Fh)
            shade_hi = bake_shade(Vh, Fh, Nh, noise, spec, banded=(kind in ('chunk', 'stack', 'shard') and rnd.random() < 0.4))
            lee_az = rnd.uniform(0, TAU)
            for l in range(4):
                V, F, N, sh = build_body(Vh, Fh, Nh, shade_hi, TRIS[hero][l], SHRINK[l] * (1.0 if not hero else 0.7))
                add_obj(f'rk{s}_{kind}_{hs}_lod{l}', make_mesh('b', V, F, N, sh), (s * 3.5, l * 3.5, 0))
                tris.append(len(F))
            thick = (0.07 if hero else 0.10) * (0.8 if kind == 'slab' else 1.0)
            for l in range(4):
                sub = CAPSUB[hero][l]
                Uc, Fc0 = ico(sub)
                Uc = Uc @ R.T
                Pc, Fc, Nc, mc = snow_cap(spec, noise, norm, Uc, Fc0, thick, lee_az, seed + 101, iters=1, lip=LIP[l])
                add_obj(f'rk{s}_{kind}_{hs}_snow{l}', make_mesh('c', Pc, Fc, Nc, mc), (s * 3.5, l * 3.5, 0))
                tris.append(len(Fc))
        report.append((s, kind, hs, tris))
        print('rock', s, kind, hs, tris, flush=True)

    # pebbles
    for j in range(N_PEB):
        if ONLY is not None and 100 not in ONLY:
            break
        seed = 900 + j * 13
        rnd = random.Random(seed)
        spec = spec_pebble(rnd, seed)
        noise = Noise(seed)
        R = rot_matrix(rnd)
        Uh, Fh = ico(4)
        Uh = Uh @ R.T
        Vh, norm = rock_shape(spec, Uh, noise)
        Nh = vert_normals(Vh, Fh)
        tree_ao = bake_ao(Vh, Fh, Nh, rays=12, maxd=0.8)
        shade = np.clip((0.78 + 0.22 * tree_ao) * (0.5 + 0.5 * sstep(-0.6, 0.2, Vh[:, 1])), 0, 1)
        top = sstep(0.55, 0.9, Nh[:, 1])
        V, F, N, pr = None, None, None, None
        V2, F2 = decimate(Vh, Fh, 40)
        pj = project(V2, Vh, Fh, {'n': Nh, 's': shade[:, None], 't': top[:, None]})
        N2 = pj['n'] / (np.linalg.norm(pj['n'], axis=1, keepdims=True) + 1e-9)
        cols = np.stack([pj['s'][:, 0], pj['t'][:, 0], np.zeros(len(V2))], 1)
        add_obj(f'pb{j}', make_mesh('p', V2, F2, N2, cols), (j * 1.5, 12, 0))
        print('pebble', j, len(F2), flush=True)

    TMP = OUT + '.tmp.glb'
    bpy.ops.export_scene.gltf(filepath=TMP, export_format='GLB', export_vertex_color='ACTIVE',
                              export_apply=False, export_yup=False, export_materials='NONE')
    quantize_glb(TMP)
    os.replace(TMP, OUT)
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')


main()
sys.stdout.flush()
os._exit(0)       # skip bpy's interpreter teardown (segfaults on exit in some builds)
