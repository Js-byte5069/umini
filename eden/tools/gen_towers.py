"""Blender (bpy) hero-tower generator: the "pre-civilisation sentinel tower" of the EDEN reference sheet.

Massive dark slate basement on a rock-and-snow plinth (rock collar + soft snow banks), a cantilevered observation gallery (ring corridor,
continuous railing, lower ring beam, robust corbels and pale corner piers), a wide stepped pale cool-grey body (5 tapered tiers) with real
recessed window bays (bevelled dark frames, dark glass) and vertical slit bands, dark corner pilasters that climb into slender spire spines,
ONE huge coral slab on the front (+ one on a flank), a second maintenance ring platform under the upper body, a stepped lantern crown with a long
antenna mast with two cross yards, and soft thick snow drifts on every ledge and platform.  Few large clean forms; detail only where it
explains the structure (no greebles).

Writes assets/towers.glb with objects named b{id}_l{lod}_{material} (same convention as buildings.glb, so the engine loads them through the
building path; hand-written GLB with int16 positions / int8 normals / ubyte AO+wear like gen_buildings.py) and assets/towers.json (placement,
colliders and bridge dock, loaded next to buildings.json).  The footprint is ~25 % bigger than the first version; the street-facing front
(tier-1 face, bridge dock, plinth front) keeps its world position, so the towers grow backwards/sideways and towers.json carries the shifted
origin (bridge deck height / local_x / end_x are unchanged, stub_end follows the new tier-1 face).

Run:  PYTHONDONTWRITEBYTECODE=1 python3 tools/gen_towers.py [id]        (needs bpy 4.2 + numpy; deterministic; with an id only that tower is
written; TOWERS_OUT=dir redirects the output)
"""
import sys
sys.dont_write_bytecode = True
import bpy, bmesh, json, math, os, random, struct
import numpy as np
from mathutils import Vector, Matrix, noise, bvhtree

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.environ.get('TOWERS_OUT') or os.path.join(HERE, '..', 'assets')
os.makedirs(ASSETS, exist_ok=True)
MATS = ['wall', 'wallLight', 'wallDark', 'trim', 'metal', 'accent', 'accentDark', 'glass', 'deck', 'snow']
MI = {m: i for i, m in enumerate(MATS)}
TAU = math.tau

# id, world x/z of the ORIGINAL placement, yaw (local +z faces the street), height, base width/depth, seed.  The footprint grew ~25 %, but the
# street-facing front (tier-1 face, bridge dock, plinth front) keeps its world position: the tower grows backwards and sideways, so the
# placement written to towers.json is shifted by `grow` along the tower's back (dock end, bridge and street lane stay frozen).
TOWERS = [
    dict(id=20, x=-88, z=119.8, yaw=90, H=112, W=39, D=34, seed=3, old_d1h=10.53, flank=-1,
         tiers=[(0.82, 0.84, 2.4, 0.975, 9.2, 27.4), (0.66, 0.68, 3.4, 0.93, 27.0, 41.0), (0.54, 0.56, 3.0, 0.87, 40.6, 70.0), (0.31, 0.33, 2.4, 0.86, 69.6, 81.0), (0.20, 0.21, 1.8, 0.85, 80.6, 88.5)],
         gallery=dict(y=9.9, wrap=0, support='base', piers=True), plat=dict(y=70.3, wrap=3, support=2),
         bridge=dict(local_x=7.8, deck=19.5, wz=112.0, dir=1, end_x=-50.7)),
    dict(id=21, x=90, z=104.2, yaw=-90, H=96, W=32.5, D=30, seed=8, old_d1h=9.36, flank=1,
         tiers=[(0.82, 0.84, 2.4, 0.975, 9.2, 27.4), (0.66, 0.68, 3.4, 0.93, 27.0, 39.0), (0.54, 0.56, 3.0, 0.87, 38.6, 62.0), (0.31, 0.33, 2.4, 0.86, 61.6, 72.0), (0.20, 0.21, 1.8, 0.85, 71.6, 79.0)],
         gallery=dict(y=31.3, wrap=1, support=0), plat=dict(y=62.3, wrap=3, support=2),
         bridge=dict(local_x=7.8, deck=19.5, wz=112.0, dir=-1, end_x=50.7)),
]
BASE_TOP = 9.5


def clamp(x, a, b): return a if x < a else b if x > b else x
def lerp(a, b, t): return a + (b - a) * t
def fbm(a, seed, f=1.0):
    return 0.65 * noise.noise(Vector((math.cos(a) * f + seed, math.sin(a) * f, seed * 0.37))) + 0.35 * noise.noise(Vector((math.cos(a) * f * 2.3 + seed * 1.7, math.sin(a) * f * 2.3, 3.0 + seed)))


class Part:
    """one bmesh; every shell is built closed so recalc_face_normals orients it outward"""
    def __init__(self): self.bm = bmesh.new()

    def _quad(self, vs, mat):
        f = self.bm.faces.new(vs); f.material_index = MI[mat]; return f

    def shell(self, loops, mat, cap_top=True, cap_bot=True, mats=None):
        """loops: list of rings (each a list of Vector, same count n) from bottom to top"""
        bm = self.bm
        R = [[bm.verts.new(p) for p in ring] for ring in loops]
        n = len(R[0]); faces = []
        for k in range(len(R) - 1):
            for i in range(n):
                j = (i + 1) % n
                faces.append(self._quad([R[k][i], R[k][j], R[k + 1][j], R[k + 1][i]], (mats[k] if mats else mat)))
        if cap_bot: faces.append(self._quad(list(reversed(R[0])), mat))
        if cap_top: faces.append(self._quad(R[-1], mat))
        bmesh.ops.recalc_face_normals(bm, faces=faces)
        return faces

    def tube(self, outer, inner, y0, y1, mat):
        """annular prism between two same-count loops (xz points)"""
        bm = self.bm
        OT = [bm.verts.new((x, y1, z)) for x, z in outer]; OB = [bm.verts.new((x, y0, z)) for x, z in outer]
        IT = [bm.verts.new((x, y1, z)) for x, z in inner]; IB = [bm.verts.new((x, y0, z)) for x, z in inner]
        n = len(outer); faces = []
        for i in range(n):
            j = (i + 1) % n
            faces += [self._quad([OT[i], OT[j], IT[j], IT[i]], mat), self._quad([OB[j], OB[i], IB[i], IB[j]], mat),
                      self._quad([OB[i], OB[j], OT[j], OT[i]], mat), self._quad([IT[i], IT[j], IB[j], IB[i]], mat)]
        bmesh.ops.recalc_face_normals(bm, faces=faces)

    def sweep(self, pts, y, section, mat):
        """closed torus: cross-section [(outward offset, dy)...] swept around a closed xz loop that surrounds the origin"""
        bm = self.bm; n = len(pts); m = len(section); R = []
        for i in range(n):
            a = pts[i - 1]; b = pts[(i + 1) % n]; p = pts[i]
            tx, tz = b[0] - a[0], b[1] - a[1]; L = math.hypot(tx, tz) or 1.0
            nx, nz = tz / L, -tx / L
            if nx * p[0] + nz * p[1] < 0: nx, nz = -nx, -nz
            R.append([bm.verts.new((p[0] + nx * o, y + dy, p[1] + nz * o)) for o, dy in section])
        faces = []
        for i in range(n):
            j = (i + 1) % n
            for k in range(m):
                l = (k + 1) % m
                faces.append(self._quad([R[i][k], R[j][k], R[j][l], R[i][l]], mat))
        bmesh.ops.recalc_face_normals(bm, faces=faces)

    def box(self, c, s, mat, rot=None):
        v = bmesh.ops.create_cube(self.bm, size=1.0)['verts']
        bmesh.ops.scale(self.bm, vec=s, verts=v)
        if rot is not None:
            bmesh.ops.rotate(self.bm, cent=(0, 0, 0), matrix=Matrix.Rotation(rot, 3, 'Y'), verts=v)
        bmesh.ops.translate(self.bm, vec=c, verts=v)
        for f in {f for x in v for f in x.link_faces}: f.material_index = MI[mat]

    def cyl(self, c, r, h, mat, seg=16, r2=None):
        loops = []
        for y, rr in ((c[1] - h / 2, r), (c[1] + h / 2, r if r2 is None else r2)):
            loops.append([Vector((c[0] + math.cos(a) * rr, y, c[2] + math.sin(a) * rr)) for a in [i / seg * TAU for i in range(seg)]])
        self.shell(loops, mat)

    def append(self, other):
        me = bpy.data.meshes.new('t'); other.bm.to_mesh(me)
        self.bm.from_mesh(me); bpy.data.meshes.remove(me)


# ───────────────────────────── plan helpers (star-shaped loops around the tower axis) ─────────────────────────────
def octa(w, d, ch, k=1.0):
    """chamfered rectangle footprint scaled by k about the centre"""
    hw, hd = w / 2 * k, d / 2 * k; c = min(ch * k, hw * 0.45, hd * 0.45)
    return [(-hw + c, -hd), (hw - c, -hd), (hw, -hd + c), (hw, hd - c), (hw - c, hd), (-hw + c, hd), (-hw, hd - c), (-hw, -hd + c)]


def ring_pts(r, n, rz=None, a0=None):
    rz = r if rz is None else rz
    a0 = math.pi / n if a0 is None else a0
    return [(math.cos(a0 + i / n * TAU) * r, math.sin(a0 + i / n * TAU) * rz) for i in range(n)]


def sq_pt(hw, hd, p, th):
    c, s = math.cos(th), math.sin(th)
    return (hw * math.copysign(abs(c) ** (2 / p), c), hd * math.copysign(abs(s) ** (2 / p), s))


def ray_poly(poly, th):
    dx, dz = math.cos(th), math.sin(th); best = None
    for i in range(len(poly)):
        ax, az = poly[i]; bx, bz = poly[(i + 1) % len(poly)]
        ex, ez = bx - ax, bz - az
        den = dx * ez - dz * ex
        if abs(den) < 1e-9: continue
        t = (ax * ez - az * ex) / den; u = (ax * dz - az * dx) / den
        if t > 1e-6 and -1e-6 <= u <= 1 + 1e-6 and (best is None or t < best): best = t
    return (best * dx, best * dz)


def thetas(N, *polys):
    """uniform angles + the vertex angles of every polygon, so octagon corners are never skipped"""
    base = [i / N * TAU for i in range(N)]
    extra = [math.atan2(z, x) % TAU for poly in polys for x, z in poly]
    allv = sorted(base + extra); out = [allv[0]]
    for a in allv[1:]:
        if a - out[-1] > 0.004: out.append(a)
    return out


class Tier:
    """tapered chamfered-rectangle prism; every coordinate scales linearly with height about the axis"""
    def __init__(self, w, d, ch, y0, y1, taper):
        self.hw = w / 2; self.hd = d / 2; self.c = min(ch, self.hw * 0.45, self.hd * 0.45)
        self.y0 = y0; self.y1 = y1; self.k = 1 - taper

    def sc(self, y): return 1 - self.k * (y - self.y0) / (self.y1 - self.y0)

    def oct(self, y, grow=0.0):
        s = self.sc(y); hw = self.hw * s + grow; hd = self.hd * s + grow; c = self.c * s
        return [(-hw + c, -hd), (hw - c, -hd), (hw, -hd + c), (hw, hd - c), (hw - c, hd), (-hw + c, hd), (-hw, hd - c), (-hw, -hd + c)]


class Shell:
    """welded vertex cache for one closed tier shell"""
    def __init__(self, P): self.bm = P.bm; self.c = {}; self.faces = []

    def v(self, co):
        k = (round(co[0] * 1000), round(co[1] * 1000), round(co[2] * 1000))
        r = self.c.get(k)
        if r is None: r = self.c[k] = self.bm.verts.new(co)
        return r

    def f(self, vs, mat):
        if len({id(x) for x in vs}) < 3: return None
        try: fc = self.bm.faces.new(vs)
        except ValueError: return None
        fc.material_index = MI[mat]; self.faces.append(fc); return fc


FACE_N = {'+z': (0, 1), '+x': (1, 0), '-z': (0, -1), '-x': (-1, 0)}
ORDER = ['+z', '+x', '-z', '-x']


def feat(fd, face, u0, u1, y0, y1, off, mat, smat='wallDark', lod=1):
    fd.setdefault(face, []).append(dict(u0=u0, u1=u1, y0=y0, y1=y1, off=off, mat=mat, smat=smat, lod=lod))


def bay(fd, face, u, w, y0, y1, depth=1.25, fr=0.6, lod=2):
    """tall recessed window bay: proud dark bevelled frame + recessed dark glass"""
    if fr: feat(fd, face, u - w / 2 - fr, u + w / 2 + fr, y0 - fr, y1 + fr, -0.4, 'wallDark', 'wallDark', lod)
    feat(fd, face, u - w / 2, u + w / 2, y0, y1, depth, 'glass', 'wallDark', lod)


def slits(fd, face, uc, n, pitch, w, y0, y1, depth=1.0, fr=0.8, lod=2):
    """vertical slit band: n narrow recessed slits inside one proud dark frame"""
    span = (n - 1) * pitch + w
    if fr: feat(fd, face, uc - span / 2 - fr, uc + span / 2 + fr, y0 - fr, y1 + fr, -0.35, 'wallDark', 'wallDark', lod)
    for k in range(n):
        u = uc + (k - (n - 1) / 2) * pitch
        feat(fd, face, u - w / 2, u + w / 2, y0, y1, depth, 'glass', 'wallDark', lod)


def slab(fd, face, u, w, y0, y1, nseg, lod=2, head=2.4):
    """one huge coral slab: dark frame with a heavier head, proud coral plates (thin seams), shallow inset panels"""
    feat(fd, face, u - w / 2 - 1.3, u + w / 2 + 1.3, y0 - 1.3, y1 + head, -0.45, 'wallDark', 'wallDark', lod)
    h = (y1 - y0 - 0.45 * (nseg - 1)) / nseg
    for s in range(nseg):
        a = y0 + s * (h + 0.45)
        feat(fd, face, u - w / 2, u + w / 2, a, a + h, -1.1, 'accent', 'accentDark', lod)
        feat(fd, face, u - w / 2 + 0.9, u + w / 2 - 0.9, a + 0.9, a + h - 0.9, -1.3, 'accent', 'accentDark', 0)


def dedupe(vals, tol=1e-3):
    out = []
    for v in sorted(vals):
        if not out or v - out[-1] > tol: out.append(v)
    return out


def tier_shell(P, T, fd, mat, lod):
    """closed tapered tier whose four big faces carry real recesses / proud frames (grid facade, border cells flush).
    All four faces share one set of horizontal grid lines so the chamfer strips between them are plain quads (no T-junction cracks)."""
    sh = Shell(P); tops = {}; bots = {}; Rb = {}; Lb = {}
    ys_all = {T.y0, T.y1}
    for fk in ORDER:
        N = FACE_N[fk]; hu = T.hw if N[1] else T.hd; uh = hu - T.c
        for f in fd.get(fk, []):
            if f['lod'] < lod: continue
            f['u0'] = clamp(f['u0'], -uh + 0.6, uh - 0.6); f['u1'] = clamp(f['u1'], -uh + 0.6, uh - 0.6)
            f['y0'] = clamp(f['y0'], T.y0 + 0.6, T.y1 - 0.6); f['y1'] = clamp(f['y1'], T.y0 + 0.6, T.y1 - 0.6)
            ys_all.update((f['y0'], f['y1']))
    ys = dedupe(ys_all)
    for fk in ORDER:
        N = FACE_N[fk]; U = (N[1], -N[0])
        hn = T.hd if N[1] else T.hw; hu = T.hw if N[1] else T.hd; uh = hu - T.c
        fl = [f for f in fd.get(fk, []) if f['lod'] >= lod]
        us = {-uh, uh}
        for f in fl: us.update((f['u0'], f['u1']))
        us = dedupe(us)

        def pt(u, y, off):
            s = T.sc(y)
            return (U[0] * u * s + N[0] * (hn * s - off), y, U[1] * u * s + N[1] * (hn * s - off))
        nu, ny = len(us) - 1, len(ys) - 1
        cell = [[(0.0, mat, mat)] * ny for _ in range(nu)]
        for i in range(nu):
            for j in range(ny):
                uc = (us[i] + us[i + 1]) / 2; yc = (ys[j] + ys[j + 1]) / 2
                for f in fl:
                    if f['u0'] <= uc <= f['u1'] and f['y0'] <= yc <= f['y1']: cell[i][j] = (f['off'], f['mat'], f['smat'])
        V = lambda i, j, off: sh.v(pt(us[i], ys[j], off))
        for i in range(nu):
            for j in range(ny):
                o, m, _ = cell[i][j]
                sh.f([V(i, j, o), V(i + 1, j, o), V(i + 1, j + 1, o), V(i, j + 1, o)], m)
        for i in range(1, nu):                                        # walls on the vertical grid lines
            for j in range(ny):
                a, b = cell[i - 1][j], cell[i][j]
                if abs(a[0] - b[0]) > 1e-4:
                    sm = a[2] if abs(a[0]) > abs(b[0]) else b[2]
                    sh.f([V(i, j, a[0]), V(i, j + 1, a[0]), V(i, j + 1, b[0]), V(i, j, b[0])], sm)
        for i in range(nu):                                           # walls on the horizontal grid lines
            for j in range(1, ny):
                a, b = cell[i][j - 1], cell[i][j]
                if abs(a[0] - b[0]) > 1e-4:
                    sm = a[2] if abs(a[0]) > abs(b[0]) else b[2]
                    sh.f([V(i, j, a[0]), V(i + 1, j, a[0]), V(i + 1, j, b[0]), V(i, j, b[0])], sm)
        tops[fk] = [V(i, ny, 0.0) for i in range(nu + 1)]; bots[fk] = [V(i, 0, 0.0) for i in range(nu + 1)]
        Rb[fk] = [V(nu, j, 0.0) for j in range(ny + 1)]; Lb[fk] = [V(0, j, 0.0) for j in range(ny + 1)]
    for a, b in zip(ORDER, ORDER[1:] + ORDER[:1]):                    # chamfer strips (one quad per grid row)
        for j in range(len(ys) - 1):
            sh.f([Rb[a][j], Lb[b][j], Lb[b][j + 1], Rb[a][j + 1]], mat)
    sh.f([v for fk in ORDER for v in tops[fk]], mat); sh.f([v for fk in ORDER for v in bots[fk]], mat)
    bmesh.ops.recalc_face_normals(P.bm, faces=sh.faces)


def tier(P, w, d, ch, y0, y1, mat, taper=0.94, cz=0.0):
    a = [(x, z + cz) for x, z in octa(w, d, ch, 1.0)]
    b = [(x * taper, z * taper + cz) for x, z in octa(w, d, ch, 1.0)]
    P.shell([[Vector((x, y0, z)) for x, z in a], [Vector((x, y1, z)) for x, z in b]], mat)


def band(P, T, y0, y1, grow, mat, taper=1.0):
    """horizontal dark ring beam hugging a tier outline (prism between two outline loops)"""
    a = T.oct(y0, grow); b = T.oct(y1, grow * taper)
    P.shell([[Vector((x, y0, z)) for x, z in a], [Vector((x, y1, z)) for x, z in b]], mat)


def pilaster(P, T, corner, y0, y1, pw, proud, mat='wallDark', ext=0.0, ext_w=0.18):
    """dark pilaster on a chamfer corner following the tier taper; with ext>0 it climbs above the tier as a slender spire spike"""
    sx, sz = corner; r = 1 / math.sqrt(2)
    d1 = (sx * r, sz * r); d2 = (-sz * r, sx * r)
    cx, cz = sx * (T.hw - T.c / 2), sz * (T.hd - T.c / 2)

    def ring(y, wf, pf, yy=None):
        s = T.sc(min(y, T.y1)) if y <= T.y1 else T.sc(T.y1)
        px, pz = cx * s, cz * s
        w = pw * wf / 2
        return [Vector((px + d2[0] * a + d1[0] * b, y, pz + d2[1] * a + d1[1] * b)) for a, b in ((-w, -0.5), (w, -0.5), (w, proud * pf), (-w, proud * pf))]
    loops = [ring(y0, 1, 1), ring(min(y1, T.y1), 1, 1)]
    if ext > 0:
        loops += [ring(T.y1 + ext * 0.55, 0.62, 0.8), ring(T.y1 + ext, ext_w, 0.4)]
    P.shell(loops, mat)
    s_ = T.sc(T.y1)
    return (cx * s_, cz * s_, T.y1 + ext)


def snow_pad(P, cx, cy, cz, w, d, t, seed, n=9, bury=0.5, p=2.6):
    """soft rounded snow lump (superellipse footprint, organic wobble), buried skirt so it never floats"""
    bm = P.bm; W = n + 1; V = []
    for j in range(W):
        row = []
        for i in range(W):
            u = i / n * 2 - 1; v = j / n * 2 - 1
            m = max(0.0, 1 - (abs(u) ** p + abs(v) ** p) ** (1 / p))
            e = m ** 0.5
            nz = 1 + 0.22 * noise.noise(Vector((u * 1.7 + seed, v * 1.7, seed * 0.3))) + 0.1 * noise.noise(Vector((u * 4 + seed, v * 4, 1.0)))
            y = t * e * nz - (bury if m < 1e-4 else 0)
            row.append(bm.verts.new((cx + u * w / 2, cy + y, cz + v * d / 2)))
        V.append(row)
    faces = []
    for j in range(n):
        for i in range(n):
            faces.append(P._quad([V[j][i], V[j + 1][i], V[j + 1][i + 1], V[j][i + 1]], 'snow'))
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    for f in faces:
        if f.normal.y < 0: f.normal_flip()


SNOW_PROFILE = [(0.0, -0.35, 0.5), (0.0, 0.1, 0.35), (0.05, 0.5, 0.0), (0.18, 0.88, 0.0), (0.4, 1.0, 0.0), (0.7, 0.9, 0.0), (1.0, 0.72, 0.0), (1.12, 0.45, 0.0)]


SNOW_PROFILE_LO = [(0.0, -0.35, 0.5), (0.05, 0.5, 0.0), (0.4, 1.0, 0.0), (1.0, 0.72, 0.0), (1.12, 0.45, 0.0)]


def snow_band(P, outer, inner, y, th, seed, k_fn=None, prof=SNOW_PROFILE):
    """continuous soft snow drift between two same-count loops: rolled lip over the outer edge, crest, buried against the inner wall"""
    bm = P.bm; n = len(outer); R = []
    if CUR_LOD == 2: prof = SNOW_PROFILE_LO
    for i in range(n):
        ox, oz = outer[i]; ix, iz = inner[i]
        dx, dz = ox - ix, oz - iz; L = math.hypot(dx, dz) or 1.0; nx, nz = dx / L, dz / L
        a = i / n * TAU
        k = clamp(1 + 0.42 * fbm(a, seed, 1.7), 0.5, 1.7) * (k_fn(i, ox, oz) if k_fn else 1.0)
        ti = min(th * k, 0.62 * L + 0.35)
        ring = []
        for v, hf, push in prof:
            ring.append(bm.verts.new((lerp(ox, ix, v) + nx * push, y + ti * hf, lerp(oz, iz, v) + nz * push)))
        R.append(ring)
    faces = []
    for i in range(n):
        j = (i + 1) % n
        for k in range(len(prof) - 1):
            faces.append(P._quad([R[i][k], R[j][k], R[j][k + 1], R[i][k + 1]], 'snow'))
    bm.normal_update()
    if sum(f.normal.y for f in faces) < 0:
        for f in faces: f.normal_flip()


def boulder(P, c, r, seed, sqz=(1.0, 0.7, 1.0), rot=0.0, mat='wallDark', e=0.62, sub=2):
    """chunky rounded rock block (rounded-cube projection of an icosphere + lumpy noise), bottom flattened so it sits buried in the snow"""
    bm = P.bm
    verts = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)['verts']
    rm = Matrix.Rotation(rot, 3, 'Y')
    for v in verts:
        n = v.co.normalized()
        q = Vector((math.copysign(abs(n.x) ** e, n.x), math.copysign(abs(n.y) ** e, n.y), math.copysign(abs(n.z) ** e, n.z)))
        d = 1 + 0.26 * noise.noise(Vector((n.x * 1.5 + seed, n.y * 1.5, n.z * 1.5))) + 0.14 * noise.noise(Vector((n.x * 3.7 + seed, n.y * 3.7 + 2, n.z * 3.7)))
        co = Vector((q.x * d * r * sqz[0], max(q.y * d * r * sqz[1], -0.3 * r), q.z * d * r * sqz[2]))
        v.co = rm @ co + Vector(c)
    for f in {f for v in verts for f in v.link_faces}: f.material_index = MI[mat]
    return max(v.co.y for v in verts)


def rail_loop(F, pts, y, h, lod):
    """continuous railing: top rail, mid rail, toe board (swept loops) + posts every ~2.7 m"""
    F.sweep(pts, y, [(-0.11, h - 0.16), (0.11, h - 0.16), (0.11, h + 0.04), (-0.11, h + 0.04)], 'trim')
    F.sweep(pts, y, [(-0.18, 0.0), (0.18, 0.0), (0.18, 0.42), (-0.18, 0.42)], 'metal')
    if lod == 0:
        F.sweep(pts, y, [(-0.05, h * 0.55), (0.05, h * 0.55), (0.05, h * 0.55 + 0.1), (-0.05, h * 0.55 + 0.1)], 'metal')
        acc = 0.0; n = len(pts)
        for i in range(n):
            a = pts[i]; b = pts[(i + 1) % n]; acc += math.hypot(b[0] - a[0], b[1] - a[1])
            if acc >= 2.7:
                acc = 0.0; F.box((a[0], y + h / 2, a[1]), (0.2, h, 0.2), 'metal')


CUR_LOD = 0


def build_tower(T, lod):
    global CUR_LOD
    CUR_LOD = lod
    H, W, D = T['H'], T['W'], T['D']
    B = Part(); F = Part(); S = Part(); G = Part()    # B = big forms (bevelled), G = ring tubes (not bevelled), F = fine parts, S = snow
    cols = []
    base = Tier(W, D, 4.0, 1.0, BASE_TOP, 0.955)
    tiers = [Tier(W * fw, D * fd_, ch, y0, y1, tp) for fw, fd_, ch, tp, y0, y1 in T['tiers']]
    t1a, t1b, t2, t3, t4 = tiers
    gal = T['gallery']; gy = gal['y']; pl = T['plat']; py = pl['y']
    pick = lambda k: base if k == 'base' else tiers[k]
    ymin = gy + 5.3                                              # lowest y for facade features above the ring corridor of the gallery

    # ── foundation: plinth, dark slate basement, corner buttresses, portal ──
    tier(B, W + 4.0, D + 4.0, 3.4, -2.0, 1.3, 'wallDark', taper=0.98)
    fb = {}
    for sd in ('+x', '-x'): slits(fb, sd, 0.0, 5, 3.4, 0.8, 3.6, 7.0, depth=0.9, fr=0.7, lod=2)
    slits(fb, '-z', 0.0, 7, 3.6, 0.8, 3.6, 7.0, depth=0.9, fr=0.7, lod=2)
    uhb = base.hw - base.c; pa, pb = 6.4, uhb - 1.1                        # recessed pale-framed metal panels either side of the portal
    for sg in (-1, 1):
        feat(fb, '+z', pa * sg if sg > 0 else -pb, pb * sg if sg > 0 else -pa, 2.4, 6.7, -0.35, 'trim', 'trim', 2)
        feat(fb, '+z', (pa + 0.5) * sg if sg > 0 else -(pb - 0.5), (pb - 0.5) * sg if sg > 0 else -(pa + 0.5), 2.9, 6.2, 0.8, 'metal', 'wallDark', 2)
    tier_shell(B, base, fb, 'wallDark', lod)
    zf = D / 2
    B.box((0, 3.9, zf + 0.15), (9.0, 7.8, 1.0), 'wallLight')                 # portal: pale frame + proud dark door leaf + lintel
    B.box((0, 3.4, zf + 0.8), (5.8, 6.8, 0.6), 'metal')
    B.box((0, 8.0, zf + 0.35), (10.2, 1.0, 1.3), 'trim')
    if lod == 0:
        for k in (-1, 1): F.box((k * 1.45, 3.4, zf + 1.2), (0.16, 6.6, 0.18), 'trim')
    cols.append([-(W + 4.0) / 2, -2, -(D + 4.0) / 2, (W + 4.0) / 2, 1.4, (D + 4.0) / 2])
    cols.append([-W / 2, -2, -D / 2, W / 2, BASE_TOP + 1.0, D / 2])

    NG = {0: 64, 1: 36, 2: 24}[lod]

    def ring_platform(gy, wrap, sup, ov, wm, corridor, corb, cw, piers, seed, dock_clear=False):
        """observation platform around tier `wrap`, carried by `sup`: deck + fascia + lower ring beam + robust corbels + continuous railing (+ ring corridor)"""
        hw_o = max(sup.hw * sup.sc(gy - 2) + ov, wrap.hw * wrap.sc(gy) + wm)
        hd_o = max(sup.hd * sup.sc(gy - 2) + ov, wrap.hd * wrap.sc(gy) + wm)
        cm = 2.9 if corridor else 0.0
        wi = wrap.oct(gy, -1.5)
        th = thetas(NG, wrap.oct(gy, 0), wi, wrap.oct(gy, cm))
        SQ = lambda a, b, p=5.0: [sq_pt(hw_o - a, hd_o - b, p, t) for t in th]
        gouter = SQ(0, 0); ginner = [ray_poly(wi, t) for t in th]
        G.tube(gouter, ginner, gy - 0.8, gy, 'deck')
        G.tube([sq_pt(hw_o + 0.5, hd_o + 0.5, 5.0, t) for t in th], gouter, gy - 1.3, gy + 0.1, 'wallLight')        # fascia band
        G.tube(SQ(1.0, 1.0), SQ(2.6, 2.6), gy - 3.0, gy - 0.8, 'wallDark')                                    # lower ring beam
        for i in range(corb):                                                                                  # robust corbels
            a = math.radians(corb_ang[corb][i])
            if dock_clear and 44 <= corb_ang[corb][i] <= 76: continue                                         # keep clear of the bridge dock portal
            wx, wz = ray_poly(sup.oct(gy - 3.5), a)
            ox, oz = sq_pt(hw_o - 1.8, hd_o - 1.8, 5.0, a)
            L = math.hypot(ox, oz); rx, rz = ox / L, oz / L; tx, tz = -rz, rx
            wb = 2.5 * cw; wt = wb * 1.5; db = 1.9 * cw; dt = 3.3 * cw
            def cring(cx, cz, w, dp, y): return [Vector((cx + tx * sa * w / 2 + rx * sb * dp / 2, y, cz + tz * sa * w / 2 + rz * sb * dp / 2)) for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            B.shell([cring(wx - rx * 0.3, wz - rz * 0.3, wb, db, gy - 7.0 * min(1.0, cw)), cring(ox, oz, wt, dt, gy - 0.8)], 'wallDark')
        if piers:                                                                                              # pale corner piers carrying the platform down to the plinth
            for sx in (-1, 1):
                for sz in (-1, 1):
                    px, pz = sx * (hw_o - 3.6) * 0.865, sz * (hd_o - 3.6) * 0.865
                    B.shell([[Vector((px + dx * 2.2, 1.0, pz + dz * 2.2)) for dx, dz in ((-1, -1), (1, -1), (1, 1), (-1, 1))],
                             [Vector((px + dx * 1.7, gy - 0.9, pz + dz * 1.7)) for dx, dz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]], 'wall')
                    B.box((px, gy - 1.2, pz), (4.6, 0.9, 4.6), 'wallDark')
        if corridor:
            wo = wrap.oct(gy, 2.9); co_ = [ray_poly(wo, t) for t in th]; pro = [ray_poly(wrap.oct(gy, 3.05), t) for t in th]
            roof = [ray_poly(wrap.oct(gy, 3.9), t) for t in th]
            G.tube(co_, ginner, gy, gy + 3.6, 'wallLight')                                                    # ring corridor wall
            G.tube(pro, co_, gy + 1.15, gy + 2.55, 'glass')                                                   # continuous glazing band
            G.tube(roof, ginner, gy + 3.6, gy + 4.3, 'wallDark')                                              # corridor roof slab
            snow_band(S, SQ(0.8, 0.8), pro, gy, 0.7, seed)
            snow_band(S, [ray_poly(wrap.oct(gy, 3.8), t) for t in th], [ray_poly(wrap.oct(gy, 0.0), t) for t in th], gy + 4.3, 0.9, seed + 1)
        else:
            snow_band(S, SQ(0.8, 0.8), [ray_poly(wrap.oct(gy, 0.2), t) for t in th], gy, 0.9, seed)
        if lod < 2: rail_loop(F, SQ(0.3, 0.3), gy, 1.2, lod)

    corb_ang = {8: [22.5 + 45 * i for i in range(8)]}
    ring_platform(gy, pick(gal['wrap']), pick(gal['support']), 4.9, 7.4, True, 8, 1.0, gal.get('piers', False), 21, dock_clear=gy > 22)
    ring_platform(py, pick(pl['wrap']), pick(pl['support']), 1.7, 4.2, False, 8, 0.55, False, 25)

    # ── the stepped body: real recesses (bays, slit bands), proud dark frames, one huge coral slab on the front + one on a flank ──
    f1a = {}; f1b = {}; f2 = {}; f3 = {}; f4 = {}
    uh1 = t1a.hw - t1a.c
    for k in range(3): bay(f1a, '+z', -uh1 + 2.7 + k * 5.4, 2.9, 15.2, 26.0)                  # tier 1a front: three tall bays left of the bridge dock
    for k in range(3): bay(f1a, '-z', -5.4 + k * 5.4, 2.9, 15.2, 26.0)
    slits(f1a, '+x', 0.0, 5, 3.4, 1.0, 15.6, 25.2); slits(f1a, '-x', 0.0, 5, 3.4, 1.0, 15.6, 25.2)
    if gal['wrap'] != 1:                                                    # (tower 21's gallery girdles tier 1b: no windows there)
        yy0 = t1b.y0 + 2.8; yy1 = t1b.y1 - 2.6
        slits(f1b, '+z', 0.0, 4, 3.2, 1.0, yy0, yy1); slits(f1b, '-z', 0.0, 4, 3.2, 1.0, yy0, yy1)
        bay(f1b, '+x', 0.0, 3.2, yy0, yy1); bay(f1b, '-x', 0.0, 3.2, yy0, yy1)
    s0 = max(t2.y0 + 2.4, ymin); s1 = t2.y1 - 3.6
    slab(f2, '+z', 0.0, min(8.6, (t2.hw - t2.c) * 0.96), s0, s1, 1)                                    # THE huge coral slab (front)
    fk = '+x' if T['flank'] > 0 else '-x'; ok = '-x' if T['flank'] > 0 else '+x'
    slab(f2, fk, 0.0, min(5.0, (t2.hd - t2.c) * 0.7), s0 + 1.0, s1 - 1.5, 1)                       # one flank slab
    slits(f2, ok, 0.0, 3, 3.0, 1.0, s0 + 1.0, s1 - 1.0)
    bay(f2, '-z', 0.0, 3.4, s0, s1 - 2.0)
    q0 = max(t3.y0 + 2.4, py + 5.0); q1 = t3.y1 - 2.4
    bay(f3, '+z', 0.0, 2.6, q0, q1); bay(f3, '-z', 0.0, 2.6, q0, q1)
    slits(f3, '+x', 0.0, 2, 2.2, 0.8, q0, q1); slits(f3, '-x', 0.0, 2, 2.2, 0.8, q0, q1)
    slits(f4, '+z', 0.0, 1, 1.0, 1.2, t4.y0 + 1.4, t4.y1 - 1.4, fr=0.5); slits(f4, '-z', 0.0, 1, 1.0, 1.2, t4.y0 + 1.4, t4.y1 - 1.4, fr=0.5)
    for Tt, fd, mt in ((t1a, f1a, 'wallLight'), (t1b, f1b, 'wallLight'), (t2, f2, 'wall'), (t3, f3, 'wallLight'), (t4, f4, 'wall')):
        tier_shell(B, Tt, fd, mt, lod)
    # dark secondary structure: ring beams at the first setbacks, corner pilasters, tall spire spines with thin masts
    tips = []
    if True:
        for Tt, g in ((t1a, 0.55),):
            band(B, Tt, Tt.y1 - 1.5, Tt.y1 + 0.35, g, 'wallDark')
        for Tt, pw, pr in ((t1a, 2.8, 1.0), (t1b, 2.6, 0.9)):
            for sx in (-1, 1):
                for sz in (-1, 1): pilaster(B, Tt, (sx, sz), Tt.y0 + 0.3, Tt.y1 - 0.3, pw, pr)
        for (sx, sz), eh in {(1, 1): 17.0, (-1, 1): 17.0, (1, -1): 11.0, (-1, -1): 11.0}.items():              # main spine pillars: climb above the mid body
            tips.append(pilaster(B, t2, (sx, sz), t2.y0 + 2.0, t2.y1, 3.0, 1.3, ext=eh, ext_w=0.42))
        for (sx, sz), eh in {(1, 1): 9.0, (-1, 1): 9.0, (1, -1): 6.0, (-1, -1): 6.0}.items():
            tips.append(pilaster(B, t3, (sx, sz), t3.y0 + 1.0, t3.y1, 1.8, 0.8, ext=eh, ext_w=0.4))
        for sx in (-1, 1): tips.append(pilaster(B, t4, (sx, 1), t4.y0 + 1.0, t4.y1, 1.4, 0.6, ext=6.0, ext_w=0.4))
        for (tx_, tz_, ty_) in tips[:4]:
            if lod < 2: F.cyl((tx_, ty_ + 2.2, tz_), 0.14, 5.0, 'metal', seg=6, r2=0.05)
    # ── bridge portal: framed opening + landing stub where the truss bridge docks (tier 1a, front face; world position frozen) ──
    br = T.get('bridge')
    if br:
        bx, yb_, zf1 = br['local_x'], br['deck'], t1a.hd
        B.box((bx, yb_ + 2.9, zf1 + 0.1), (5.4, 5.8, 0.9), 'wallLight')
        B.box((bx, yb_ + 6.0, zf1 + 0.25), (6.0, 0.55, 1.2), 'trim')
        B.box((bx, yb_ + 2.5, zf1 + 0.55), (4.0, 4.6, 0.5), 'wallDark')
        B.box((bx, yb_ + 2.5, zf1 + 0.84), (3.3, 3.9, 0.12), 'glass')
        B.box((bx, yb_ - 0.27, zf1 + 1.3), (4.7, 0.5, 2.6), 'wallDark')
        B.box((bx, yb_ - 0.02, zf1 + 1.3), (4.3, 0.1, 2.4), 'deck')
        for sx in (-1, 1): B.box((bx + sx * 2.45, yb_ + 0.6, zf1 + 1.3), (0.28, 1.2, 2.6), 'trim')
        for sx in (-1, 1): B.box((bx + sx * 2.1, yb_ - 2.3, zf1 + 0.4), (0.5, 3.6, 0.7), 'wallDark')
    # ── crown: stepped lantern + long tapering spire with antenna mast and two cross yards ──
    y4 = t4.y1; wt4 = t4.hw * 2 * t4.sc(y4); dt4 = t4.hd * 2 * t4.sc(y4)
    yL = y4 + 6.0
    L1 = Tier(wt4 * 0.9, dt4 * 0.9, 1.0, y4 - 0.3, y4 + 2.6, 0.9); L2 = Tier(wt4 * 0.62, dt4 * 0.62, 0.8, y4 + 2.4, y4 + 6.0, 0.88)
    fl = {}
    for fkk in ORDER: slits(fl, fkk, 0.0, 1, 1.0, 0.8, L2.y0 + 0.9, L2.y1 - 0.9, depth=0.7, fr=0.3)
    tier_shell(B, L1, {}, 'wallLight', lod); tier_shell(B, L2, fl, 'wall', lod)
    band(B, L1, y4 + 1.7, y4 + 2.8, 0.45, 'wallDark')
    wl = wt4 * 0.62 * 0.88; dl = dt4 * 0.62 * 0.88
    B.shell([[Vector((x, yL - 0.2, z)) for x, z in octa(wl * 1.15, dl * 1.15, 0.8)], [Vector((x, yL + 0.8, z)) for x, z in octa(wl * 1.05, dl * 1.05, 0.8)]], 'wallDark')
    sp0 = yL + 0.6; sp1 = sp0 + (H - sp0) * 0.5; mast0 = sp1
    B.shell([[Vector((x, sp0, z)) for x, z in ring_pts(wl * 0.30, 8)], [Vector((x, sp1, z)) for x, z in ring_pts(wl * 0.07, 8)]], 'wall')
    F.cyl((0, (mast0 + H) / 2, 0), 0.26, H - mast0 + 0.4, 'metal', seg=8, r2=0.08)
    for fr, ln in ((0.30, 7.0), (0.64, 4.4)):
        ym = mast0 + (H - mast0) * fr
        F.box((0, ym, 0), (ln, 0.2, 0.2), 'trim'); F.box((0, ym, 0), (0.2, 0.2, ln * 0.82), 'trim')
    B.cyl((0, H + 0.1, 0), 0.34, 0.9, 'accent', seg=10)

    # ── snow: continuous soft drifts on every ledge, plus chunky rounded banks at the plinth ──
    nb = {0: 52, 1: 28, 2: 18}[lod]
    def ledge(A, Bt, y, th_, seed):
        thl = thetas(nb, A.oct(y), Bt.oct(y))
        outer = [ray_poly(A.oct(y, 0.25), t) for t in thl]; inner = [ray_poly(Bt.oct(y, -0.5), t) for t in thl]
        snow_band(S, outer, inner, y, th_, seed)
    ledge(t1a, t1b, t1a.y1, 1.7, 11)
    ledge(t1b, t2, t1b.y1, 1.7, 12)
    ledge(t3, t4, t3.y1, 1.5, 14)
    ledge(t4, L1, y4, 1.3, 15)
    # plinth banks: rounded soft drifts all around the foot, low at the portal, fat at the corners
    thb = thetas({0: 80, 1: 44, 2: 28}[lod], base.oct(2.0))
    pw_, pd_ = (W + 4.0) / 2, (D + 4.0) / 2
    def corner_k(i, ox, oz):
        a = math.atan2(oz, ox); front = math.exp(-((a - math.pi / 2) / 0.30) ** 2)
        diag = abs(math.sin(2 * a)); return (0.55 + 0.7 * diag ** 1.5) * (1 - 0.85 * front)
    bank_out = [sq_pt(pw_ + 2.6, pd_ + 2.6, 5.0, t) for t in thb]; bank_in = [ray_poly(base.oct(5.0, -0.4), t) for t in thb]
    snow_band(S, bank_out, bank_in, 0.9, 2.1, 31, k_fn=corner_k, prof=[(0.0, -0.45, 0.4), (0.0, 0.05, 0.3), (0.06, 0.45, 0.0), (0.22, 0.85, 0.0), (0.45, 1.0, 0.0), (0.75, 0.95, 0.0), (1.0, 0.85, 0.0), (1.1, 0.7, 0.0)])
    if lod < 2:
        # rock collar: chunky dark slate blocks around the foot (sides and back; the street side stays open), snow caps resting on them
        rr = random.Random(T['seed'] * 7 + 3)
        for i in range(11):
            a = math.radians(160 + i * (222 / 10.0)) + rr.uniform(-0.05, 0.05)                            # sweeps round the flanks and the back (the street-side corners stay rock-free)
            rx_, rz_ = sq_pt(pw_ + 1.7, pd_ + 1.7, 5.0, a)
            big = 3.4 + 1.6 * rr.random()
            rot_ = rr.uniform(0, 3.1)
            top = boulder(F, (rx_, 0.7, rz_), big, 40 + i, sqz=(1.3, 0.5 + 0.12 * rr.random(), 1.05), rot=rot_, sub=2 if lod == 0 else 1)         # lower rock layer
            if i % 2 == 0:                                                                                  # stacked second layer: strata like the reference plinth
                dx_, dz_ = math.cos(rot_) * big * 0.35, -math.sin(rot_) * big * 0.35
                top = boulder(F, (rx_ + dx_, top - 0.55, rz_ + dz_), big * 0.62, 130 + i, sqz=(1.25, 0.5, 1.0), rot=rot_ + 0.5, sub=1)
            snow_pad(S, rx_, top - 0.8, rz_, big * 1.75, big * 1.5, 1.9 + 0.5 * rr.random(), 70 + i, n=6 if lod == 0 else 3)
            if lod == 0:
                ox_, oz_ = sq_pt(pw_ + 1.7 + 3.6, pd_ + 1.7 + 3.6, 5.0, a + 0.12)
                sm = big * 0.55
                top2 = boulder(F, (ox_, 0.6, oz_), sm, 90 + i, sqz=(1.2, 0.6, 1.0), rot=rr.uniform(0, 3.1), sub=1)
                snow_pad(S, ox_, top2 - 0.45, oz_, sm * 1.7, sm * 1.5, 0.8, 110 + i, n=4)
        for sx in (-1, 1):                                                                                # fat soft snow lumps at the front corners (street side stays rock-free)
            snow_pad(S, sx * (pw_ + 0.4), 0.9, pd_ + 0.2, 6.0, 5.0, 1.6, 60 + sx, n=7 if lod == 0 else 4, bury=1.0)
    snow_pad(S, 0, y4 + 0.1, 0, 0.001, 0.001, 0.001, 0, n=2)                  # keeps the snow group non-empty
    # colliders: the tower shaft (the player can only reach the plinth/base, but keep the whole shaft solid)
    cols.append([-t1a.hw, BASE_TOP, -t1a.hd, t1a.hw, t1a.y1, t1a.hd])
    cols.append([-t1b.hw, t1a.y1, -t1b.hd, t1b.hw, t1b.y1, t1b.hd])
    cols.append([-t2.hw, t1b.y1, -t2.hd, t2.hw, t3.y1, t2.hd])
    return B, F, S, G, cols


def bevel_all(P, width, segs):
    """bevel the convex edges; the new strips take the material of the neighbouring original face (bmesh gives them material 0)"""
    bm = P.bm; bm.edges.ensure_lookup_table()
    edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.is_convex and e.calc_face_angle(0) > 0.6 and e.calc_length() > 0.5]
    res = bmesh.ops.bevel(bm, geom=edges, offset=width, offset_type='OFFSET', segments=segs, profile=0.5, affect='EDGES')
    new = set(res['faces']); todo = set(new)
    for _ in range(4):
        done = {}
        for f in todo:
            best = None; ba = -1.0
            for e in f.edges:
                for g in e.link_faces:
                    if g is not f and g not in todo and g.calc_area() > ba: best = g; ba = g.calc_area()
            if best is not None: done[f] = best.material_index
        for f, m in done.items(): f.material_index = m
        todo -= set(done)
        if not todo: break


def subdiv(P, maxlen, passes):
    bm = P.bm
    for _ in range(passes):
        edges = [e for e in bm.edges if e.calc_length() > maxlen]
        if not edges: break
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)


UP = Vector((0, 1, 0))


def hemi_dirs(n):
    out = []
    for k in range(n):
        u = (k + 0.5) / n; r = math.sqrt(u); th = k * 2.399963
        out.append((r * math.cos(th), r * math.sin(th), math.sqrt(1 - u)))
    return out


def adaptive_ao(bm, rays, maxd, thr, minlen, passes, strength=1.25):
    """baked ambient occlusion per vertex; edges whose end values differ get split again (so AO detail only costs triangles where it shows)"""
    lay = bm.verts.layers.float.new('aov'); known = bm.verts.layers.int.new('aok')
    dirs = hemi_dirs(rays)
    for it in range(passes + 1):
        bm.normal_update()
        tree = bvhtree.BVHTree.FromBMesh(bm)
        for v in bm.verts:
            if v[known]: continue
            n = v.normal.copy()
            if n.length < 1e-6: n = Vector((0, 1, 0))
            n.normalize()
            ref = UP if abs(n.y) < 0.9 else Vector((1, 0, 0))
            tt = n.cross(ref).normalized(); bb = n.cross(tt)
            o = v.co + n * 0.035; occ = 0.0
            for (lx, ly, lz) in dirs:
                h = tree.ray_cast(o, tt * lx + bb * ly + n * lz, maxd)
                if h[0] is not None: occ += 1.0 - h[3] / maxd
            v[lay] = clamp(1.0 - strength * occ / rays, 0.0, 1.0); v[known] = 1
        if it == passes: break
        bm.edges.ensure_lookup_table()
        edges = [e for e in bm.edges if e.calc_length() > minlen and abs(e.verts[0][lay] - e.verts[1][lay]) > thr]
        if not edges: break
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, use_single_edge=False)
    return lay


def finish_color(bm, lay_ao):
    """COLOR_0 = (baked AO, edge wear 0.5 flat .. 1 convex, 0, 1) like buildings.glb"""
    bm.normal_update(); bm.edges.ensure_lookup_table()
    col = bm.verts.layers.float_color.new('ao')
    for v in bm.verts:
        wear = 0.5
        for e in v.link_edges:
            if len(e.link_faces) == 2:
                a = e.calc_face_angle_signed(0)
                if a > 0.25: wear = max(wear, 0.5 + 0.5 * clamp(a / 0.9, 0, 1))
        ao = v[lay_ao] if lay_ao is not None else 1.0
        v[col] = (ao, wear if ao > 0.78 else 0.5, 0.0, 1.0)


def creased_normals(pos, tris, ang=40.0, fmat=None, soft=None, soft_ang=85.0):
    """per-corner normals: area weighted average of the incident faces within `ang` degrees of the corner's own face (crisp architecture, soft snow)"""
    p0, p1, p2 = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    fn = np.cross(p1 - p0, p2 - p0)
    area = np.linalg.norm(fn, axis=1)
    ok = area > 1e-12
    fnn = np.zeros_like(fn)
    fnn[ok] = fn[ok] / area[ok, None]
    T = len(tris)
    cv = tris.reshape(-1)
    ct = np.repeat(np.arange(T), 3)
    order = np.argsort(cv, kind='stable')
    cv_s, ct_s = cv[order], ct[order]
    bounds = np.flatnonzero(np.diff(cv_s)) + 1
    starts = np.concatenate(([0], bounds)); ends = np.concatenate((bounds, [len(cv_s)]))
    cth = math.cos(math.radians(ang))
    fth = np.full(T, cth)
    if fmat is not None and soft is not None: fth[np.isin(fmat, soft)] = math.cos(math.radians(soft_ang))
    out = np.zeros((T, 3, 3), np.float32)
    corner_of = np.tile(np.arange(3), T)[order]
    for s_, e_ in zip(starts, ends):
        ts = ct_s[s_:e_]
        Fn = fnn[ts]; A = area[ts]
        th = np.maximum(fth[ts][:, None], fth[ts][None, :])
        Wt = (Fn @ Fn.T > th) * A[None, :]
        N = Wt @ Fn
        ln = np.linalg.norm(N, axis=1)
        ln[ln < 1e-12] = 1
        N = N / ln[:, None]
        out[ts, corner_of[s_:e_]] = N
    return out


def pack(bm):
    """triangulate -> per material arrays {mat: dict(pos, nrm(int8 x4), col(uint8 x4), idx)}; COLOR_0 = (baked AO, edge wear, 0, 1)"""
    lay = bm.verts.layers.float_color['ao']
    nl = bm.faces.layers.float_vector.new('n0'); bm.normal_update()
    for f in bm.faces: f[nl] = f.normal
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='SHORT_EDGE', ngon_method='EAR_CLIP')
    bm.normal_update()
    for f in bm.faces:                                                  # ear clipping can fold a triangle of a nasty n-gon over: face it the way its polygon faced
        if f.normal.dot(f[nl]) < -0.2: f.normal_flip()
    bm.verts.ensure_lookup_table()
    pos = np.array([v.co[:] for v in bm.verts], np.float64)
    ao = np.array([v[lay][0] for v in bm.verts], np.float32)
    wr = np.array([v[lay][1] for v in bm.verts], np.float32)
    tris = np.array([[v.index for v in f.verts] for f in bm.faces if len(f.verts) == 3], np.int64)
    mats = np.array([f.material_index for f in bm.faces if len(f.verts) == 3], np.int64)
    nrm = creased_normals(pos, tris, fmat=mats, soft=[MI['snow']])
    out = {}
    for mi, mname in enumerate(MATS):
        sel = np.flatnonzero(mats == mi)
        if not len(sel): continue
        tv = tris[sel]; tn = nrm[sel]
        q = np.rint(tn * 127).astype(np.int16)
        key = np.concatenate([tv.reshape(-1, 1), q.reshape(-1, 3)], axis=1)
        uk, inv = np.unique(key, axis=0, return_inverse=True)
        vid = uk[:, 0]
        N = np.zeros((len(uk), 4), np.int8); N[:, :3] = np.clip(uk[:, 1:], -127, 127)
        C = np.full((len(uk), 4), 255, np.uint8)
        C[:, 0] = np.clip(np.rint(ao[vid] * 255), 0, 255).astype(np.uint8)
        C[:, 1] = np.clip(np.rint(wr[vid] * 255), 0, 255).astype(np.uint8)
        C[:, 2] = 0
        out[mname] = dict(pos=pos[vid].astype(np.float32), nrm=N, col=C, idx=inv.reshape(-1).astype(np.uint32))
    return out


def write_glb(path, meshes):
    """hand written GLB like buildings.glb: int16 positions (1/128 m) / int8 normals / ubyte AO+wear (KHR_mesh_quantization); expanded by src/arch_building.js"""
    out = bytearray(); views = []; accs = []; nodes = []; meshdefs = []

    def push(arr, ctype, atype, target, stride=None, normalized=False, minmax=None):
        while len(out) % 4: out.append(0)
        off = len(out)
        data = arr.tobytes(); out.extend(data)
        bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data), 'target': target}
        if stride: bv['byteStride'] = stride
        views.append(bv)
        a = {'bufferView': len(views) - 1, 'componentType': ctype, 'count': int(arr.shape[0]) if arr.ndim else int(arr.size), 'type': atype}
        if normalized: a['normalized'] = True
        if minmax: a['min'], a['max'] = minmax
        accs.append(a)
        return len(accs) - 1

    for name, m in meshes.items():
        Q = np.zeros((len(m['pos']), 4), np.int16); Q[:, :3] = np.clip(np.rint(m['pos'] * 128.0), -32767, 32767)
        at = {'POSITION': push(Q, 5122, 'VEC3', 34962, stride=8, minmax=(Q[:, :3].min(0).tolist(), Q[:, :3].max(0).tolist()))}
        at['NORMAL'] = push(m['nrm'], 5120, 'VEC3', 34962, stride=4, normalized=True)
        at['COLOR_0'] = push(m['col'], 5121, 'VEC4', 34962, stride=4, normalized=True)
        idx = m['idx']
        if int(idx.max()) < 65535: ind = push(idx.astype(np.uint16), 5123, 'SCALAR', 34963)
        else: ind = push(idx.astype(np.uint32), 5125, 'SCALAR', 34963)
        meshdefs.append({'name': name, 'primitives': [{'attributes': at, 'indices': ind, 'mode': 4}]})
        nodes.append({'name': name, 'mesh': len(meshdefs) - 1})
    j = {'asset': {'version': '2.0', 'generator': 'eden gen_towers'}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}],
         'nodes': nodes, 'meshes': meshdefs, 'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(out)}],
         'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization']}
    jb = json.dumps(j, separators=(',', ':')).encode()
    while len(jb) % 4: jb += b' '
    while len(out) % 4: out.append(0)
    total = 12 + 8 + len(jb) + 8 + len(out)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(jb), 0x4E4F534A)); f.write(jb)
        f.write(struct.pack('<II', len(out), 0x004E4942)); f.write(out)


def main():
    only = int(sys.argv[1]) if len(sys.argv) > 1 else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    specs = []; meshes = {}
    for T in TOWERS:
        if only is not None and T['id'] != only: continue
        for lod in (0, 1, 2):
            B, F, S, G, cols = build_tower(T, lod)
            if lod == 0: bevel_all(B, 0.1, 1)
            subdiv(B, {0: 8.0, 1: 6.0}.get(lod, 9999), {0: 3, 1: 3}.get(lod, 0))
            B.append(G); B.append(F)
            AO = {0: dict(rays=12, maxd=5.0, thr=0.16, minlen=2.8, passes=2), 1: dict(rays=6, maxd=5.0, thr=0.2, minlen=4.0, passes=0), 2: None}[lod]
            lay = adaptive_ao(B.bm, **AO) if AO else None
            B.append(S)
            if lay is not None:
                lay = B.bm.verts.layers.float['aov']
                for v in B.bm.verts:
                    if not v[B.bm.verts.layers.int['aok']]: v[lay] = 1.0
            finish_color(B.bm, lay)
            nv = len(B.bm.verts)
            data = pack(B.bm)
            if os.environ.get('TOWERS_DEBUG'): print({k: len(m['idx']) // 3 for k, m in data.items()})
            for mname, m in data.items(): meshes[f"b{T['id']}_l{lod}_{mname}"] = m
            if lod == 0: print({k: len(m['idx']) // 3 for k, m in data.items()})
            print(f"tower {T['id']} lod{lod}: {nv} verts -> {sum(len(m['pos']) for m in data.values())} packed, {sum(len(m['idx']) for m in data.values()) // 3} tris", flush=True)
            B.bm.free(); F.bm.free(); S.bm.free(); G.bm.free()
            if lod == 0:
                W, D = T['W'], T['D']
                hd1 = D * T['tiers'][0][1] / 2
                grow = hd1 - T['old_d1h']                       # the tier-1 front face (bridge dock) keeps its world position: shift the origin backwards
                yaw = math.radians(T['yaw']); fx, fz = math.sin(yaw), math.cos(yaw)   # local +z (front) in world
                x = round(T['x'] - fx * grow, 3); z = round(T['z'] - fz * grow, 3)
                b = T['bridge']
                specs.append(dict(id=T['id'], x=x, z=z, yaw=T['yaw'], door=None, roof=[], seed=T['seed'], canopy=False, tower=True,
                                  tiers=[dict(w=W + 4.0, d=D + 4.0, h=T['H'])], cols=[[round(c, 2) for c in bb] for bb in cols],
                                  bridge=dict(deck=b['deck'], dir=b['dir'], wz=b['wz'], end_x=b['end_x'], stub_end=round(hd1 + 2.6, 2))))
    out = os.path.join(ASSETS, 'towers.glb')
    write_glb(out, meshes)
    json.dump({'buildings': specs}, open(os.path.join(ASSETS, 'towers.json'), 'w'), indent=1)
    print('wrote', out, os.path.getsize(out) // 1024, 'KB')
    sys.stdout.flush(); os._exit(0)


if __name__ == '__main__':
    main()
