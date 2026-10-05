"""Blender (bpy 4.2) generator for the big landmark structures.

  python3 gen_structures.py                  rebuild everything  -> ../assets/structures.glb   (about 20 s, deterministic)
  python3 gen_structures.py ring gate        rebuild only these groups; the other groups are re-used from a dev cache in the temp dir
                                             (falls back to skipping them if the cache is empty - so run the full build once first)
  python3 gen_structures.py --nocache ring   rebuild only the named groups and drop the rest
  python3 gen_structures.py --out=/tmp/x.glb  write somewhere else (experiments)
  groups: ring viaduct gate gantry catwalk stairs ruin hall

Objects are named  <module>_l<lod>_<material>  (material keys map to MAT in src/materials.js); the loader is assets.js addStruct().
Everything is real modelled geometry: bevelled primitives, revolved ring profiles, lofted fluted columns, arch rings cut from true circles,
recessed/raised panels, baked vertex AO (COLOR_0).  Blender y is treated as UP (export_yup=False).
The GLB is rewritten with int8 normals / ubyte colours (KHR_mesh_quantization) to keep it around 5 MB; assets.js expands them again.

Coupling with the engine code (keep in sync):  PIER_HEAD here == PIER_HEAD in src/arch_infra.js (pier head length, the shaft is stretched below it);
the 'glow' objects are drawn with the softer MAT.glowSoft registered by src/assets.js; baked AO goes through AO_GAMMA (deeper, bluer recesses).
Snow is NOT modelled here: the engine lays smooth drifts (snowDrift in src/arch_infra.js) over the modules.
"""
import bpy, bmesh, math, os, pickle, sys, tempfile, time
from mathutils import Vector, Matrix, bvhtree

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'assets', 'structures.glb')
CACHE = os.path.join(tempfile.gettempdir(), 'eden_struct_cache')
MATS = ['wall', 'wallLight', 'wallDark', 'trim', 'metal', 'accent', 'accentDark', 'glass', 'deck', 'glow']
MI = {m: i for i, m in enumerate(MATS)}
TAU = math.tau
AO_GAMMA = 1.9               # baked AO contrast (the engine maps 0..1 to a 0.58..1 brightness factor)


# ───────────────────────────────────────────────── 2D helpers ──────────────────────────────────────────────────
def dedupe(pts, eps=1e-6):
    out = []
    for p in pts:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > eps:
            out.append(tuple(p))
    if len(out) > 1 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= eps:
        out.pop()
    return out


def arc(cx, cy, r, a0, a1, n):
    """points on a circle arc, endpoints included (angles in radians)"""
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def rpoly(pts, r, n=None):
    """polygon with rounded corners. r: float or list per corner (0 = sharp). n: arc segments (auto from radius when None)."""
    k = len(pts)
    rr = r if isinstance(r, (list, tuple)) else [r] * k
    out = []
    for i in range(k):
        p = Vector(pts[i]); a = Vector(pts[i - 1]); b = Vector(pts[(i + 1) % k])
        rad = rr[i]
        if rad <= 1e-6:
            out.append(tuple(p)); continue
        v1 = (a - p); v2 = (b - p)
        l1, l2 = v1.length, v2.length
        v1.normalize(); v2.normalize()
        ang = math.acos(max(-1, min(1, v1.dot(v2))))
        if ang < 1e-3 or abs(ang - math.pi) < 1e-3:
            out.append(tuple(p)); continue
        t = rad / math.tan(ang / 2)
        t = min(t, l1 * 0.5, l2 * 0.5)
        rad = t * math.tan(ang / 2)
        T1 = p + v1 * t; T2 = p + v2 * t
        c = p + (v1 + v2).normalized() * (rad / math.sin(ang / 2))
        a1 = math.atan2(T1.y - c.y, T1.x - c.x); a2 = math.atan2(T2.y - c.y, T2.x - c.x)
        d = a2 - a1
        while d > math.pi: d -= TAU
        while d < -math.pi: d += TAU
        nn = n if n else (1 if rad < 0.09 else 2 if rad < 0.3 else 3 if rad < 0.9 else 5)
        for j in range(nn + 1):
            q = a1 + d * j / nn
            out.append((c.x + rad * math.cos(q), c.y + rad * math.sin(q)))
    return dedupe(out)


def rrect(x0, y0, x1, y1, r, n=None):
    return rpoly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], r, n)


def sector(r0, r1, a0, a1, n, cx=0.0, cy=0.0):
    """annular sector polygon (CCW outer arc then inner arc back)"""
    return dedupe(arc(cx, cy, r1, a0, a1, n) + arc(cx, cy, r0, a1, a0, n))


# ───────────────────────────────────────────────── mesh builder ────────────────────────────────────────────────
class Mod:
    """bmesh wrapper; y is up. Face material = index into MATS. Bevels only at lod 0."""

    def __init__(self, lod=0):
        self.bm = bmesh.new()
        self.lod = lod

    # finish a primitive: material, outward normals, optional bevel of sharp edges
    def _fin(self, faces, mat, bevel=0.0, seg=2, ang=0.62, minlen=0.03):
        bm = self.bm
        faces = [f for f in faces if f.is_valid]
        bmesh.ops.recalc_face_normals(bm, faces=faces)
        for f in faces: f.material_index = MI[mat]
        if bevel > 0 and self.lod == 0:
            if bevel < 0.1: seg = 1          # small bevels do not need extra rounding rings (keeps the GLB small)
            edges = set()
            for f in faces:
                for e in f.edges:
                    if len(e.link_faces) == 2 and e.calc_length() > minlen and e.calc_face_angle(0.0) > ang:
                        edges.add(e)
            if edges:
                res = bmesh.ops.bevel(bm, geom=list(edges), offset=bevel, offset_type='OFFSET', segments=seg, profile=0.5, affect='EDGES', clamp_overlap=True)
                faces = [g for g in res.get('faces', [])] + [f for f in faces if f.is_valid]
        return faces

    def box(self, c, s, mat, rot=None, bevel=0.0, seg=2, taper=None):
        """centre c, size s=(x,y,z). rot=(rx,ry,rz) radians applied about the centre (XYZ order). taper=(kx,kz): scale of the top face."""
        bm = self.bm
        v = bmesh.ops.create_cube(bm, size=1.0)['verts']
        if taper:
            for p in v:
                if p.co.y > 0: p.co.x *= taper[0]; p.co.z *= taper[1]
        bmesh.ops.scale(bm, vec=s, verts=v)
        if rot:
            m = Matrix.Rotation(rot[2], 3, 'Z') @ Matrix.Rotation(rot[1], 3, 'Y') @ Matrix.Rotation(rot[0], 3, 'X')
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=m, verts=v)
        bmesh.ops.translate(bm, vec=c, verts=v)
        faces = list({f for p in v for f in p.link_faces})
        return self._fin(faces, mat, bevel, seg)

    def prism(self, pts, w0, w1, mat, plane='xy', bevel=0.0, seg=2, ang=0.62):
        """extrude a 2D polygon along the third axis from w0 to w1.
        plane 'xy': (u,v,w)=(x,y,z); 'zy': (u,v,w)=(z,y,x); 'xz': (u,v,w)=(x,z,y)"""
        bm = self.bm
        pts = dedupe(pts)

        def P(u, v, w):
            if plane == 'xy': return (u, v, w)
            if plane == 'zy': return (w, v, u)
            return (u, w, v)
        A = [bm.verts.new(P(u, v, w0)) for u, v in pts]
        B = [bm.verts.new(P(u, v, w1)) for u, v in pts]
        n = len(pts)
        faces = [bm.faces.new(A), bm.faces.new(B[::-1])]
        for i in range(n):
            j = (i + 1) % n
            faces.append(bm.faces.new((A[i], A[j], B[j], B[i])))
        return self._fin(faces, mat, bevel, seg, ang)

    def loft(self, rings, mat, bevel=0.0, seg=2, caps=True, closed=True, ang=0.62):
        """rings: list of equal-length lists of 3D points (closed loops). Skins consecutive rings."""
        bm = self.bm
        V = [[bm.verts.new(p) for p in ring] for ring in rings]
        n = len(V[0])
        faces = []
        for k in range(len(V) - 1):
            for i in range(n):
                j = (i + 1) % n
                if not closed and j == 0: continue
                faces.append(bm.faces.new((V[k][i], V[k][j], V[k + 1][j], V[k + 1][i])))
        if caps and closed:
            faces.append(bm.faces.new(V[0])); faces.append(bm.faces.new(V[-1][::-1]))
        return self._fin(faces, mat, bevel, seg, ang)

    def revolve(self, profile, steps, mat, cx=0.0, cy=0.0, a0=0.0, a1=TAU, bevel=0.0, seg=2):
        """revolve a closed (r, w) profile about the z axis through (cx, cy): point = (cx + r cos a, cy + r sin a, w). Full turn by default."""
        bm = self.bm
        prof = dedupe(profile)
        full = abs((a1 - a0) - TAU) < 1e-6
        nA = steps if full else steps + 1
        V = []
        for k in range(nA):
            a = a0 + (a1 - a0) * k / steps
            ca, sa = math.cos(a), math.sin(a)
            V.append([bm.verts.new((cx + r * ca, cy + r * sa, w)) for r, w in prof])
        n = len(prof)
        faces = []
        for k in range(steps if not full else nA):
            k2 = (k + 1) % nA
            for i in range(n):
                j = (i + 1) % n
                faces.append(bm.faces.new((V[k][i], V[k][j], V[k2][j], V[k2][i])))
        if not full:
            faces.append(bm.faces.new(V[0])); faces.append(bm.faces.new(V[-1][::-1]))
        return self._fin(faces, mat, bevel, seg)

    def cyl(self, c, r, h, mat, axis='y', seg=16, r2=None, bevel=0.0, bseg=1):
        """cylinder / frustum along an axis ('x','y','z'), centre c, radius r (bottom/near) .. r2 (top/far)"""
        r2 = r if r2 is None else r2
        n = seg
        ring0 = [(r * math.cos(TAU * i / n), r * math.sin(TAU * i / n)) for i in range(n)]
        ring1 = [(r2 * math.cos(TAU * i / n), r2 * math.sin(TAU * i / n)) for i in range(n)]

        def P(u, v, w):
            if axis == 'y': return (c[0] + u, c[1] + w, c[2] + v)
            if axis == 'x': return (c[0] + w, c[1] + u, c[2] + v)
            return (c[0] + u, c[1] + v, c[2] + w)
        rings = [[P(u, v, -h / 2) for u, v in ring0], [P(u, v, h / 2) for u, v in ring1]]
        return self.loft(rings, mat, bevel, bseg, ang=0.5)

    def append_moved(self, other, matrix):
        """copy another Mod into this one with a 4x4 transform"""
        me = bpy.data.meshes.new('tmp'); other.bm.to_mesh(me)
        n0 = len(self.bm.verts)
        self.bm.from_mesh(me)
        vs = list(self.bm.verts)[n0:]
        bmesh.ops.transform(self.bm, matrix=matrix, verts=vs)
        bpy.data.meshes.remove(me)


# ───────────────────────────────────────────────── 3D helpers ──────────────────────────────────────────────────
def beam(M, a, b, w, h, mat, bevel=0.0, seg=1, up=(0, 1, 0)):
    """box between two points (length along a->b), cross-section w (across) x h (along 'up')"""
    a = Vector(a); b = Vector(b)
    d = b - a; L = d.length
    if L < 1e-5: return []
    x = d.normalized(); u = Vector(up)
    if abs(x.dot(u)) > 0.98: u = Vector((1, 0, 0))
    z = x.cross(u).normalized(); y = z.cross(x).normalized()
    v = bmesh.ops.create_cube(M.bm, size=1.0)['verts']
    bmesh.ops.scale(M.bm, vec=(L, h, w), verts=v)
    bmesh.ops.rotate(M.bm, cent=(0, 0, 0), matrix=Matrix((x, y, z)).transposed(), verts=v)
    bmesh.ops.translate(M.bm, vec=(a + b) / 2, verts=v)
    return M._fin(list({f for p in v for f in p.link_faces}), mat, bevel, seg)


def tube(M, a, b, r, mat, seg=10, r2=None):
    """cylinder between two points"""
    a = Vector(a); b = Vector(b)
    d = (b - a).normalized()
    u = Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))
    e1 = d.cross(u).normalized(); e2 = d.cross(e1).normalized()
    r2 = r if r2 is None else r2
    rings = []
    for p, rr in ((a, r), (b, r2)):
        rings.append([tuple(p + (e1 * math.cos(TAU * i / seg) + e2 * math.sin(TAU * i / seg)) * rr) for i in range(seg)])
    return M.loft(rings, mat, ang=0.9)


def torus(M, c, R, r, axis, mat, nmaj=24, nmin=8):
    rings = []
    for k in range(nmaj):
        a = TAU * k / nmaj
        ring = []
        for i in range(nmin):
            t = TAU * i / nmin
            rho = R + r * math.cos(t)
            if axis == 'z': p = (rho * math.cos(a), rho * math.sin(a), r * math.sin(t))
            elif axis == 'y': p = (rho * math.cos(a), r * math.sin(t), rho * math.sin(a))
            else: p = (r * math.sin(t), rho * math.cos(a), rho * math.sin(a))
            ring.append((c[0] + p[0], c[1] + p[1], c[2] + p[2]))
        rings.append(ring)
    # close the major loop by repeating the first ring
    rings.append(rings[0])
    return M.loft(rings, mat, caps=False, ang=0.9)


# ───────────────────────────────────────────────── post processing ─────────────────────────────────────────────
def finish(M, sub=2.2, passes=3, rays=12, maxd=3.0, smooth_ang=0.87):
    """triangulate, cut long edges, mark sharp edges, bake vertex AO into float colour layer 'ao'"""
    bm = M.bm
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method='SHORT_EDGE', ngon_method='EAR_CLIP')
    if sub:
        for _ in range(passes):
            edges = [e for e in bm.edges if e.calc_length() > sub]
            if not edges: break
            bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=False, use_single_edge=False)
    bm.normal_update()
    for f in bm.faces: f.smooth = True
    for e in bm.edges:
        e.smooth = not (len(e.link_faces) != 2 or e.calc_face_angle(0.0) > smooth_ang)
    bake_ao(M, rays, maxd)


def bake_ao(M, rays, maxd=3.0):
    bm = M.bm
    bm.normal_update()
    lay = bm.verts.layers.float_color.get('ao') or bm.verts.layers.float_color.new('ao')
    if rays == 0:
        for v in bm.verts: v[lay] = (1, 1, 1, 1)
        return
    tree = bvhtree.BVHTree.FromBMesh(bm)
    import random
    rnd = random.Random(5)
    for v in bm.verts:
        n = v.normal.normalized() if v.normal.length > 1e-6 else Vector((0, 1, 0))
        ref = Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))
        t = n.cross(ref).normalized(); b = n.cross(t)
        hit = 0.0
        for _ in range(rays):
            r1, r2 = rnd.random(), rnd.random(); rr = math.sqrt(r1); th = TAU * r2
            d = (t * (rr * math.cos(th)) + b * (rr * math.sin(th)) + n * math.sqrt(1 - r1)).normalized()
            if tree.ray_cast(v.co + n * 0.012, d, maxd)[0] is not None: hit += 1.0
        a = (1 - hit / rays) ** AO_GAMMA          # contrast curve: shallow occlusion stays light, recesses sink toward deep navy
        v[lay] = (a, a, a, 1)


def dump(M):
    """plain-python snapshot of a finished module (for the dev cache)"""
    bm = M.bm
    lay = bm.verts.layers.float_color['ao']
    bm.verts.ensure_lookup_table()
    verts = [tuple(v.co) for v in bm.verts]
    ao = [v[lay][0] for v in bm.verts]
    faces = [([v.index for v in f.verts], f.material_index) for f in bm.faces]
    sharp = [(e.verts[0].index, e.verts[1].index) for e in bm.edges if not e.smooth]
    return dict(verts=verts, ao=ao, faces=faces, sharp=sharp)


def restore(data):
    M = Mod(0)
    bm = M.bm
    lay = bm.verts.layers.float_color.new('ao')
    vs = [bm.verts.new(p) for p in data['verts']]
    for v, a in zip(vs, data['ao']): v[lay] = (a, a, a, 1)
    for idx, mi in data['faces']:
        f = bm.faces.new([vs[i] for i in idx]); f.material_index = mi; f.smooth = True
    bm.edges.ensure_lookup_table()
    sharp = {tuple(sorted(p)) for p in data['sharp']}
    for e in bm.edges:
        e.smooth = tuple(sorted((e.verts[0].index, e.verts[1].index))) not in sharp
    return M


def emit(M, name, col):
    """split by material into one object per material"""
    bm = M.bm
    for mi, mname in enumerate(MATS):
        b2 = bm.copy()
        kill = [f for f in b2.faces if f.material_index != mi]
        bmesh.ops.delete(b2, geom=kill, context='FACES')
        loose = [v for v in b2.verts if not v.link_faces]
        bmesh.ops.delete(b2, geom=loose, context='VERTS')
        if not b2.faces:
            b2.free(); continue
        me = bpy.data.meshes.new(f'{name}_{mname}')
        b2.to_mesh(me); b2.free()
        ob = bpy.data.objects.new(f'{name}_{mname}', me); col.objects.link(ob)


# registry: name -> builder(lod) -> Mod ; options per module
MODULES = {}


def module(group, name, lods=(0, 1, 2), sub=(2.2, 3.5, 6.0), rays=(12, 5, 0), maxd=3.0, passes=3):
    def deco(fn):
        MODULES[name] = dict(group=group, fn=fn, lods=lods, sub=sub, rays=rays, maxd=maxd, passes=passes)
        return fn
    return deco


def build_module(name, spec):
    out = {}
    for lod in spec['lods']:
        t0 = time.time()
        M = spec['fn'](lod)
        finish(M, sub=spec['sub'][lod], passes=spec['passes'], rays=spec['rays'][lod], maxd=spec['maxd'])
        out[lod] = dump(M)
        print(f'  {name} l{lod}: {len(M.bm.verts)} verts {len(M.bm.faces)} tris {time.time() - t0:.1f}s', flush=True)
        M.bm.free()
    return out


# ═════════════════════════════════════════════════ RING GATE ═══════════════════════════════════════════════════
# Ring axis = z (the ring plane faces +z/-z), centre at the origin. rIn is the walk-through opening.
RIN, ROUT = 12.2, 17.0
NSEC = 32                    # face panel sectors


@module('ring', 'ringbase', sub=(3.2, 6.0, 9.0), maxd=2.5, passes=2)
def ringbase(lod):
    M = Mod(lod)
    steps = [160, 96, 48][lod]
    # core body: stepped face with an annular trough that holds the segmented panels
    core = [(12.6, -3.3), (12.6, 3.3), (13.45, 3.3), (13.45, 2.85), (16.2, 2.85), (16.2, 3.3), (17.4, 3.3), (17.4, -3.3), (16.2, -3.3), (16.2, -2.85), (13.45, -2.85), (13.45, -3.3)]
    if lod >= 1:
        core = [(12.6, -3.3), (12.6, 3.3), (17.4, 3.3), (17.4, -3.3)]
    M.revolve(rpoly(core, [0.2, 0.2, 0.05, 0.05, 0.05, 0.05, 0.2, 0.2, 0.05, 0.05, 0.05, 0.05][:len(core)] if lod == 0 else 0.2), steps, 'wallDark')
    # outer flange: chamfered, centre groove on the outer cylinder
    fl = [(16.3, -3.95), (16.3, 3.95), (17.4, 3.95), (17.95, 3.4), (17.95, 0.35), (17.8, 0.35), (17.8, -0.35), (17.95, -0.35), (17.95, -3.4), (17.4, -3.95)]
    if lod >= 1:
        fl = [(16.3, -3.95), (16.3, 3.95), (17.4, 3.95), (17.95, 3.4), (17.95, -3.4), (17.4, -3.95)]
    M.revolve(rpoly(fl, 0.1 if lod == 0 else 0), steps, 'wallLight')
    # inner rim / tunnel liner (plates are added by the ringliner modules)
    ln = [(12.3, -3.8), (12.3, 3.8), (13.5, 3.8), (13.5, -3.8)]
    M.revolve(rpoly(ln, [0.16, 0.16, 0.1, 0.1] if lod == 0 else 0), steps, 'wallDark')
    M.revolve(rpoly([(12.8, -3.9), (13.55, -3.9), (13.55, 3.9), (12.8, 3.9)], [0.12, 0.12, 0.12, 0.12] if lod == 0 else 0), steps, 'trim') if lod < 2 else None
    if lod == 0:
        # raised hoops on the outer cylinder, thin seam rings next to the trough, glowing line round the middle of the tunnel
        for w in (-2.5, 2.5):
            M.revolve(rpoly([(17.9, w - 0.28), (18.17, w - 0.28), (18.17, w + 0.28), (17.9, w + 0.28)], 0.06), steps, 'trim')
        M.revolve([(12.12, -0.1), (12.4, -0.1), (12.4, 0.1), (12.12, 0.1)], steps, 'glow')
    return M


NLINER = 32


@module('ring', 'ringliner', sub=(1.4, 3, 5), rays=(10, 0, 0), maxd=1.0, lods=(0, 1))
def ringliner(lod):
    """tunnel lining plates for one sector (centred on +x): three bands across the ring depth, each a bevelled plate with an inset pad"""
    M = Mod(lod)
    half = math.radians(360 / NLINER / 2 - 0.4)
    n = 5 if lod == 0 else 2
    for (z0, z1) in ((-3.75, -1.55), (-1.12, -0.1), (0.1, 1.12), (1.55, 3.75)):
        M.prism(sector(12.1, 12.5, -half, half, n), z0, z1, 'trim', 'xy', bevel=0.04 if lod == 0 else 0, seg=1)
        if lod == 0:
            h2 = half * 0.7
            if z1 - z0 > 1.5: M.prism(sector(12.0, 12.2, -h2, h2, n), z0 + 0.3, z1 - 0.3, 'wallLight', 'xy', bevel=0.03, seg=1)
    return M


@module('ring', 'ringouter', sub=(1.4, 3, 5), rays=(10, 0, 0), maxd=1.0, lods=(0, 1))
def ringouter(lod):
    """plates on the outer cylinder for one sector (centred on +x), between the hoops"""
    M = Mod(lod)
    half = math.radians(360 / NLINER / 2 - 0.45)
    n = 5 if lod == 0 else 2
    for (z0, z1) in ((-2.2, -0.5), (0.5, 2.2)):
        M.prism(sector(17.85, 18.12, -half, half, n), z0, z1, 'wall', 'xy', bevel=0.05 if lod == 0 else 0, seg=1)
        if lod == 0:
            M.prism(sector(18.08, 18.18, -half * 0.55, half * 0.55, n), z0 + 0.35, z1 - 0.35, 'wallLight', 'xy', bevel=0.02, seg=1)
    return M


@module('ring', 'ringpanel', sub=(1.0, 2.5, 4.0), rays=(10, 4, 0), maxd=1.2)
def ringpanel(lod):
    """one face-panel sector centred on +x, sitting in the trough of the front face (w>0) + a plate on the outer flange"""
    M = Mod(lod)
    half = math.radians(360 / NSEC / 2 - 0.85)
    n = 6 if lod == 0 else 2
    plate = sector(13.6, 16.05, -half, half, n)
    M.prism(rpoly(plate, 0.1, 2) if lod == 0 else plate, 2.8, 3.46, 'wallLight', 'xy', bevel=0.07, seg=2)
    if lod < 2:
        h2 = half * 0.62
        M.prism(rpoly(sector(14.05, 15.6, -h2, h2, n), 0.07, 2) if lod == 0 else sector(14.05, 15.6, -h2, h2, n), 3.44, 3.6, 'wall', 'xy', bevel=0.04, seg=1)
        # flange plate
        hf = math.radians(360 / NSEC / 2 - 0.7)
        M.prism(sector(16.6, 17.65, -hf, hf, n), 3.9, 4.1, 'wall', 'xy', bevel=0.05 if lod == 0 else 0, seg=1)
    if lod == 0:
        for r in (13.8, 15.85):
            for s_ in (-1, 1):
                a = s_ * half * 0.8
                M.cyl((r * math.cos(a), r * math.sin(a), 3.5), 0.075, 0.1, 'metal', 'z', 8)
        M.prism(rrect(14.4, -0.06, 15.3, 0.06, 0.03, 1), 3.58, 3.66, 'wallDark', 'xy')
        hf = math.radians(360 / NSEC / 2 - 0.7)
        M.prism(sector(16.85, 17.4, -hf * 0.55, hf * 0.55, 4), 4.08, 4.17, 'wallLight', 'xy', bevel=0.02, seg=1)
        for s_ in (-1, 1):
            a = s_ * math.radians(360 / NSEC / 3.2)
            M.cyl((17.12 * math.cos(a), 17.12 * math.sin(a), 4.14), 0.14, 0.12, 'metal', 'z', 10, bevel=0.025, bseg=1)
    return M


@module('ring', 'ringclamp', sub=(1.6, 3, 5), rays=(10, 4, 0), maxd=1.6)
def ringclamp(lod):
    """structural joint at angle 0 (+x): a ribbed shell that follows the outer flange curvature, curved yoke plates on both faces with bolts"""
    M = Mod(lod)
    d0 = lod == 0
    A = math.radians(5.5)
    nst = 8 if d0 else 4 if lod == 1 else 3
    prof = rpoly([(17.85, -4.55), (18.95, -4.55), (18.95, 4.55), (17.85, 4.55)], [0.0, 0.42, 0.42, 0.0] if d0 else 0, 3)
    M.revolve(prof, nst, 'metal', a0=-A, a1=A)
    if lod < 2:
        da = math.radians(0.5)
        for k in (-1, 0, 1):                                              # crest ribs that follow the curve
            a = k * math.radians(2.9)
            M.prism(sector(18.9, 19.24, a - da, a + da, 2), -4.2, 4.2, 'wallLight', 'xy', bevel=0.04 if d0 else 0, seg=1)
        for sz in (-1, 1):
            z0, z1 = (3.95, 4.6) if sz > 0 else (-4.6, -3.95)
            M.prism(sector(14.8, 18.1, -math.radians(3.7), math.radians(3.7), 4), z0, z1, 'metal', 'xy', bevel=0.1 if d0 else 0, seg=2)
            z2, z3 = (4.5, 4.74) if sz > 0 else (-4.74, -4.5)
            M.prism(sector(15.3, 17.6, -math.radians(2.7), math.radians(2.7), 4), z2, z3, 'trim', 'xy', bevel=0.04 if d0 else 0, seg=1)
            if d0:
                for (rr, aa) in ((15.7, 2.0), (15.7, -2.0), (17.2, 2.0), (17.2, -2.0)):
                    a = math.radians(aa)
                    M.cyl((rr * math.cos(a), rr * math.sin(a), sz * 4.8), 0.17, 0.14, 'wallDark', 'z', 10, bevel=0.025, bseg=1)
                M.prism(sector(16.0, 16.9, -math.radians(1.1), math.radians(1.1), 3), *((4.7, 4.82) if sz > 0 else (-4.82, -4.7)), 'accent', 'xy', bevel=0.02, seg=1)
    return M


@module('ring', 'ringcrown', sub=(1.6, 3, 5), rays=(10, 4, 0), maxd=1.8)
def ringcrown(lod):
    """crown housing at angle 0 (placed at 90 deg): a ribbed shell that follows the ring curvature, curved yoke plates on both faces,
    a muted orange cap panel, a plinth with a tapered mast and a small beacon"""
    M = Mod(lod)
    d0 = lod == 0
    A = math.radians(8.6)                                                  # half angle of the shell
    nst = 14 if d0 else 7 if lod == 1 else 4
    # shell: rounded-rectangle profile (r, w) revolved around the ring axis, so its underside hugs the outer flange
    prof = rpoly([(17.8, -4.75), (19.25, -4.75), (19.25, 4.75), (17.8, 4.75)], [0.0, 0.5, 0.5, 0.0] if d0 else 0, 3)
    M.revolve(prof, nst, 'metal', a0=-A, a1=A, bevel=0.0)
    # lighter belt rings at the shell ends and a recessed dark band round the middle
    for k in (-1, 1):
        a = k * A * 0.9
        M.prism(sector(19.2, 19.52, a - 0.02, a + 0.02, 2), -4.3, 4.3, 'trim', 'xy', bevel=0.03 if d0 else 0, seg=1)
    if lod < 2:
        # transverse ribs along the crest (outside the cap panel), each following the curve
        for k in (-3, -2, -1, 1, 2, 3):
            a = k * math.radians(2.45) + (0.0 if abs(k) == 1 else 0.0)
            da = math.radians(0.55)
            M.prism(sector(19.15, 19.5, a - da, a + da, 2), -4.4, 4.4, 'wallLight', 'xy', bevel=0.04 if d0 else 0, seg=1)
        # muted orange panel set into the crest between the ribs
        da = math.radians(1.6)
        M.prism(sector(19.2, 19.42, -da, da, 3), -2.7, 2.7, 'accent', 'xy', bevel=0.05 if d0 else 0, seg=1)
        # curved yoke plates on both ring faces
        for sz in (-1, 1):
            z0, z1 = (3.9, 4.8) if sz > 0 else (-4.8, -3.9)
            M.prism(sector(14.6, 18.2, -math.radians(5.4), math.radians(5.4), 4), z0, z1, 'wall', 'xy', bevel=0.1 if d0 else 0, seg=2)
            z2, z3 = (4.7, 4.95) if sz > 0 else (-4.95, -4.7)
            M.prism(sector(15.0, 17.7, -math.radians(3.9), math.radians(3.9), 4), z2, z3, 'trim', 'xy', bevel=0.04 if d0 else 0, seg=1)
            if d0:
                for (rr, aa) in ((15.4, 3.2), (15.4, -3.2), (17.3, 3.2), (17.3, -3.2)):
                    a = math.radians(aa)
                    M.cyl((rr * math.cos(a), rr * math.sin(a), sz * 5.0), 0.2, 0.18, 'wallDark', 'z', 10, bevel=0.03, bseg=1)
    # plinth, tapered mast with cross arms and a beacon
    M.box((19.7, 0, 0), (0.7, 1.0, 2.6), 'wall', bevel=0.12 if d0 else 0, seg=2)
    M.cyl((20.35, 0, 0), 0.5, 0.5, 'trim', 'x', 12 if d0 else 6, r2=0.34)
    tube(M, (20.55, 0, 0), (26.0, 0, 0), 0.15, 'metal', 10 if d0 else 6, r2=0.06)
    if lod < 2:
        for rr, ww in ((22.2, 1.9), (23.7, 1.3), (25.0, 0.8)):
            M.box((rr, 0, 0), (0.1, 0.1, ww), 'trim', bevel=0.02 if d0 else 0, seg=1)
        for sy in (-1, 1):
            tube(M, (20.6, 0, 0), (22.2, sy * 0.0, sy * 0.95), 0.04, 'metal', 5)
    M.cyl((26.1, 0, 0), 0.24, 0.5, 'accent', 'x', 12 if d0 else 6, r2=0.12, bevel=0.03 if d0 else 0, bseg=1)
    return M


def tube_arc(M, R, a0, a1, zc, rad, mat, n_ring=14, n_seg=10):
    rings = []
    for k in range(n_ring + 1):
        a = a0 + (a1 - a0) * k / n_ring
        ca, sa = math.cos(a), math.sin(a)
        ring = []
        for i in range(n_seg):
            t = TAU * i / n_seg
            rr = R + rad * math.cos(t)
            ring.append((rr * ca, rr * sa, zc + rad * math.sin(t)))
        rings.append(ring)
    return M.loft(rings, mat, ang=0.9)


@module('ring', 'ringduct', sub=(1.6, 3, 5), rays=(10, 4, 0), maxd=1.2)
def ringduct(lod):
    """three cable conduits running along the front outer flange (centred on angle 0) with brackets"""
    M = Mod(lod)
    span = math.radians(22)
    nr = 16 if lod == 0 else 6
    for (R, z, r, mat) in ((16.75, 4.4, 0.17, 'metal'), (17.2, 4.4, 0.17, 'metal'), (16.97, 4.75, 0.13, 'trim')):
        tube_arc(M, R, -span, span, z, r, mat, nr, 10 if lod == 0 else 6)
    for k in range(-2, 3):
        a = k * math.radians(9)
        ca, sa = math.cos(a), math.sin(a)
        M.box((16.97 * ca, 16.97 * sa, 4.28), (1.0, 0.5, 0.45), 'wallDark', rot=(0, 0, a), bevel=0.06, seg=1)
        M.box((16.97 * ca, 16.97 * sa, 4.82), (1.3, 0.36, 0.2), 'trim', rot=(0, 0, a), bevel=0.04, seg=1)
    # junction boxes at both ends
    for s in (-1, 1):
        a = s * span
        M.box((17.0 * math.cos(a), 17.0 * math.sin(a), 4.7), (1.5, 1.2, 1.1), 'wall', rot=(0, 0, a), bevel=0.14, seg=2)
    return M


@module('ring', 'ringped', sub=(2.0, 3.5, 6), rays=(12, 4, 0), maxd=3.0)
def ringped(lod):
    """cradle pedestal for the +x side (ground = y 0); symmetric in z. footprint x -3.75..3.75, z +-6.5, top 4.1"""
    M = Mod(lod)
    M.box((0, -1.6, 0), (7.8, 5.0, 13.4), 'wallDark', bevel=0.3, seg=2)            # plinth (mostly buried, top at y=0.9)
    M.box((0, 1.95, 0), (7.0, 2.2, 12.4), 'wall', bevel=0.22, seg=2)                 # mid block
    M.box((0, 3.25, 0), (7.6, 0.6, 13.2), 'trim', bevel=0.16, seg=2)                 # cap
    M.box((0, 3.85, 0), (6.2, 0.55, 11.8), 'wallLight', bevel=0.15, seg=2)           # upper tier
    d0 = lod == 0
    for sz in (-1, 1):
        # raised frames on the long faces: dividing trims, two framed panels with dark pads and bolts, rails
        for x in (-1.95, 1.95):
            M.box((x, 1.95, sz * 6.36), (0.3, 1.7, 0.2), 'trim', bevel=0.06 if d0 else 0, seg=1)
        if lod < 2:
            for sx2 in (-1, 1):
                M.box((sx2 * 2.65, 1.95, sz * 6.34), (1.2, 1.55, 0.16), 'trim', bevel=0.05 if d0 else 0, seg=1)
                M.box((sx2 * 2.65, 1.95, sz * 6.42), (0.8, 1.1, 0.12), 'wallDark', bevel=0.03 if d0 else 0, seg=1)
                if d0:
                    for (bx, by) in ((-0.45, 0.62), (0.45, 0.62), (-0.45, -0.62), (0.45, -0.62)):
                        M.cyl((sx2 * 2.65 + bx, 1.95 + by, sz * 6.46), 0.06, 0.06, 'metal', 'z', 8)
        M.box((0, 1.15, sz * 6.34), (7.0, 0.2, 0.16), 'trim', bevel=0.05 if d0 else 0, seg=1)
        M.box((0, 2.75, sz * 6.34), (7.0, 0.2, 0.16), 'trim', bevel=0.05 if d0 else 0, seg=1)
    # louvred vent panel on the end facing the opening
    if lod < 2:
        M.box((-3.5, 1.95, 0), (0.16, 1.9, 5.2), 'trim', bevel=0.05 if d0 else 0, seg=1)
        M.box((-3.56, 1.95, 0), (0.12, 1.55, 4.6), 'wallDark')
        for k in range(6):
            M.box((-3.62, 1.35 + k * 0.24, 0), (0.1, 0.1, 4.5), 'wallLight')
    # orange slabs on the outward (+x) end and a dark access slot
    M.box((3.5, 1.9, 0), (0.28, 1.5, 7.4), 'accent', bevel=0.09, seg=2)
    M.box((3.62, 1.9, 0), (0.12, 0.9, 5.0), 'accentDark', bevel=0.04, seg=1)
    # orange slabs on the long faces
    for sz in (-1, 1):
        M.box((0.0, 1.95, sz * 6.46), (3.6, 1.2, 0.16), 'accent', bevel=0.05 if lod == 0 else 0, seg=1)
        if lod < 2: M.box((0.0, 1.95, sz * 6.56), (2.6, 0.6, 0.1), 'accentDark')
    if lod == 0:
        for sz in (-1, 1):
            for x in (-3.0, 3.0):
                M.cyl((x, 3.55, sz * 5.4), 0.2, 0.12, 'metal', 'y', 10, bevel=0.03, bseg=1)
    return M


# ═════════════════════════════════════════════════ VIADUCT ═════════════════════════════════════════════════════
# span module: x along the viaduct (22 m between pier centres), z across (13 m), y = 0 at deck top.
# pier modules: y = 0 at pier top (= deck top - 2.8), x/z centred on the pier / column.
# Airy arcade: a slim deck edge, tall elliptical arches that spring low on slender fluted piers, open balustrade.
SPAN, DW = 22.0, 13.0
HW = DW / 2
AA, BB = 9.5, 6.9            # arch opening half-width and rise
YS = -9.6                    # springing level (deck-relative); crown intrados = YS + BB = -2.7
WALL_Z0, WALL_Z1 = 5.0, 6.25  # thickness of the arcade wall (z, outer side)


def ell(cx, cy, a, b, a0, a1, n):
    """points on an elliptical arc, endpoints included"""
    return [(cx + a * math.cos(a0 + (a1 - a0) * i / n), cy + b * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def lathe(M, c, prof, mat, seg=16, bevel=0.0, caps=True, ang=0.62):
    """surface of revolution about the vertical axis through c = (x, y, z); prof = [(radius, height)] bottom -> top (radius > 0)"""
    rings = [[(c[0] + r * math.cos(TAU * i / seg), c[1] + y, c[2] + r * math.sin(TAU * i / seg)) for i in range(seg)] for r, y in prof]
    return M.loft(rings, mat, bevel=bevel, caps=caps, ang=ang)


@module('viaduct', 'viaspan', sub=(3.6, 5.5, 9), rays=(12, 5, 0), maxd=4.0, passes=2)
def viaspan(lod):
    M = Mod(lod)
    L = SPAN
    d0 = lod == 0
    # deck slab (dark core) + paving tiles
    M.box((0, -0.54, 0), (L, 0.84, 2 * 5.65), 'wallDark', bevel=0.07 if d0 else 0, seg=1)
    if d0:
        for i in range(4):
            x = -8.25 + 5.5 * i
            M.box((x, -0.07, 0), (5.3, 0.14, 5.7), 'deck', bevel=0.05, seg=1)
            for sz in (-1, 1):
                M.box((x, -0.07, sz * 4.2), (5.3, 0.14, 2.3), 'deck', bevel=0.05, seg=1)
        for sz in (-1, 1):
            M.box((0, 0.06, sz * 3.0), (L - 0.3, 0.12, 0.2), 'trim', bevel=0.04, seg=1)
            M.box((0, 0.025, sz * 3.55), (L - 0.3, 0.05, 0.1), 'accentDark')
            for k in range(2):                       # drain grates beside the curbs
                M.box((-5.5 + 11.0 * k, 0.02, sz * 4.5), (1.3, 0.05, 0.6), 'wallDark', bevel=0.015, seg=1)
                for q in range(4):
                    M.box((-5.5 + 11.0 * k + (q - 1.5) * 0.28, 0.05, sz * 4.5), (0.07, 0.03, 0.5), 'metal')
        # continuous centre line with expansion-joint grooves every 5.5 m
        M.box((0, 0.015, 0), (L - 0.5, 0.03, 0.16), 'trim')
        for k in range(-3, 4):
            M.box((k * 5.5 if k else 0.0, 0.02, 0), (0.12, 0.04, 2 * 5.5), 'wallDark')
        for sx in (-1, 1):                           # expansion joint cover at the pier lines
            M.box((sx * (L / 2 - 0.12), 0.03, 0), (0.34, 0.05, 2 * 5.6), 'wallDark', bevel=0.015, seg=1)
    else:
        M.box((0, -0.06, 0), (L, 0.12, 2 * 5.65), 'deck')
    # arcade wall: slim deck-edge beam, then a wall pierced by tall elliptical arches on slender piers
    n = 28 if d0 else 14 if lod == 1 else 8
    for sz in (-1, 1):
        zc = sz * 5.75
        M.box((0, -0.72, zc), (L, 1.44, 1.5), 'wall', bevel=0.1 if d0 else 0, seg=2)                              # deck-edge beam
        M.box((0, -0.28, sz * 6.62), (L, 0.5, 0.52), 'trim', bevel=0.1 if d0 else 0, seg=2)                        # cornice
        M.box((0, -1.5, sz * 6.46), (L, 0.26, 0.5), 'wallLight', bevel=0.07 if d0 else 0, seg=1)                  # string course
        if d0:
            M.box((0, -0.62, sz * 6.7), (L, 0.14, 0.3), 'wallLight', bevel=0.03, seg=1)                           # drip lip
            for x in (-5.5, 5.5):
                M.box((x, -0.82, sz * 6.52), (5.2, 0.5, 0.1), 'wallDark', bevel=0.03, seg=1)                      # sunken panel
                M.box((x, -0.82, sz * 6.58), (4.6, 0.07, 0.07), 'accentDark')
        poly = [(-L / 2, -1.4), (L / 2, -1.4), (L / 2, YS), (AA, YS)] + ell(0, YS, AA, BB, 0, math.pi, n)[1:-1] + [(-AA, YS), (-L / 2, YS)]
        z0, z1 = (sz * WALL_Z0, sz * WALL_Z1) if sz > 0 else (sz * WALL_Z1, sz * WALL_Z0)
        M.prism(poly, z0, z1, 'wall', 'xy', bevel=0.1 if d0 else 0, seg=2)
        if lod < 2:
            # moulded arch band proud of the wall face, keystone, impost blocks and a pilaster strip over each pier line
            band = ell(0, YS, AA - 0.02, BB - 0.02, 0, math.pi, n) + ell(0, YS, AA + 0.34, BB + 0.34, math.pi, 0, n)
            zz0, zz1 = (sz * 6.1, sz * 6.52) if sz > 0 else (sz * 6.52, sz * 6.1)
            M.prism(band, zz0, zz1, 'trim', 'xy', bevel=0.05 if d0 else 0, seg=1)
            M.box((0, YS + BB + 0.1, sz * 6.62), (1.3, 1.1, 0.4), 'wallLight', bevel=0.1 if d0 else 0, seg=2)
            for sx in (-1, 1):
                M.box((sx * (AA + 0.1), YS + 0.28, sz * 6.52), (0.75, 0.56, 0.5), 'wallLight', bevel=0.08 if d0 else 0, seg=1)
                M.box((sx * (L / 2 - 0.27), (YS + 0.6 - 1.8) / 2, sz * 6.4), (0.54, -1.8 - YS - 0.6, 0.3), 'wallLight', bevel=0.05 if d0 else 0, seg=1)
                M.box((sx * (L / 2 - 0.4), -1.78, sz * 6.46), (0.8, 0.28, 0.42), 'trim', bevel=0.06 if d0 else 0, seg=1)
    # underside: box girders + diaphragm ribs (kept shallow so the arches stay open)
    for z in (-3.3, 0.0, 3.3):
        M.box((0, -1.7, z), (L, 1.7, 1.5), 'wallDark', bevel=0.1 if d0 else 0, seg=2)
        if lod < 2: M.box((0, -2.58, z), (L, 0.18, 2.1), 'metal', bevel=0.05 if d0 else 0, seg=1)
    if lod < 2:
        for k in range(1, 6):
            x = -L / 2 + L * k / 6
            M.box((x, -1.5, 0), (0.46, 1.1, 9.6), 'metal', bevel=0.08 if d0 else 0, seg=1)
    return M


@module('viaduct', 'viarail', sub=(2.8, 4.0, 6), rays=(8, 4, 0), maxd=1.6)
def viarail(lod):
    """open balustrade module: 5.5 m along x (z centred), standing on y = 0. Low kerb, slender posts, round rails; taller piers at the joints."""
    M = Mod(lod)
    Lr = 5.5
    d0 = lod == 0
    M.box((0, 0.2, 0), (Lr, 0.4, 0.84), 'wallLight', bevel=0.07 if d0 else 0, seg=1)                  # kerb (snow settles on it)
    M.box((0, 0.1, 0.0), (Lr, 0.2, 0.96), 'wallDark')                                                  # plinth under the kerb
    for k in range(-2, 3):
        x = k * 1.1
        M.box((x, 0.8, 0), (0.2, 0.8, 0.26), 'wall')                                                  # post
    tube(M, (-Lr / 2, 1.2, 0), (Lr / 2, 1.2, 0), 0.075, 'trim', 8 if d0 else 5)                       # top rail
    if lod < 2:
        tube(M, (-Lr / 2, 0.84, 0), (Lr / 2, 0.84, 0), 0.035, 'metal', 6)
        tube(M, (-Lr / 2, 0.58, 0), (Lr / 2, 0.58, 0), 0.035, 'metal', 6)
        for k in range(-2, 2):
            M.box((k * 1.1 + 0.55, 0.78, 0), (0.045, 0.6, 0.045), 'metal')                              # one inset baluster per bay
    for sx in (-1, 1):
        M.box((sx * (Lr / 2 - 0.13), 0.72, 0), (0.26, 1.34, 0.52), 'wallLight', bevel=0.06 if d0 else 0, seg=2)   # joint pier (pairs up with the next module)
        if lod < 2:
            for sz in (-1, 1): M.box((sx * (Lr / 2 - 0.13), 1.0, sz * 0.27), (0.16, 0.5, 0.05), 'accentDark')
    return M


@module('viaduct', 'vialamp', sub=(1.0, 2, 4), rays=(10, 4, 0), maxd=1.2)
def vialamp(lod):
    """street lamp: slim post on y = 0 at x = z = 0, gooseneck reaching toward -z (over the deck), hooded round head with a pale lens"""
    M = Mod(lod)
    d0 = lod == 0
    seg = 12 if d0 else 6
    M.box((0, 0.22, 0), (0.7, 0.44, 0.7), 'wallLight', bevel=0.1 if d0 else 0, seg=2)
    M.cyl((0, 1.9, 0), 0.15, 3.0, 'metal', 'y', seg, r2=0.1)
    M.cyl((0, 0.62, 0), 0.22, 0.34, 'trim', 'y', seg, r2=0.16)
    # gooseneck: quadratic bezier from the post top over to the head
    p0, p1, p2 = Vector((0, 3.4, 0)), Vector((0, 4.25, -0.35)), Vector((0, 3.78, -1.3))
    pts = [p0 * (1 - t) ** 2 + p1 * 2 * (1 - t) * t + p2 * t * t for t in [i / (6 if d0 else 3) for i in range(7 if d0 else 4)]]
    for a, b in zip(pts[:-1], pts[1:]):
        tube(M, a, b, 0.07, 'metal', 8 if d0 else 5)
    # head: hooded dome, rim ring, small warm lens below (no emissive: bloom would white it out)
    hc = (0, 3.62, -1.3)
    lathe(M, hc, [(0.08, 0.2), (0.3, 0.18), (0.46, 0.08), (0.52, -0.02), (0.5, -0.1), (0.3, -0.12), (0.08, -0.12)], 'wallDark', seg=14 if d0 else 7, bevel=0.0, ang=0.9)
    if lod < 2:
        lathe(M, hc, [(0.3, -0.115), (0.34, -0.15), (0.34, -0.17), (0.28, -0.19), (0.05, -0.19)], 'accentDark', seg=14 if d0 else 7, ang=0.9)
    return M


# ── pier ─────────────────────────────────────────────────────────────────────────────
def col_poly(rx, rz, flute=True):
    """column cross-section (x, z): rounded rectangle with a shallow channel on each +-z face"""
    w, dd = 0.55 * rx / 1.55, 0.13
    p = [(rx, -rz), (rx, rz)]; r = [0.34, 0.34]
    if flute:
        p += [(w + 0.14, rz), (w, rz - dd), (-w, rz - dd), (-w - 0.14, rz)]; r += [0, 0, 0, 0]
    p += [(-rx, rz), (-rx, -rz)]; r += [0.34, 0.34]
    if flute:
        p += [(-w - 0.14, -rz), (-w, -rz + dd), (w, -rz + dd), (w + 0.14, -rz)]; r += [0, 0, 0, 0]
    return rpoly(p, r, 3)


def flute_panel(M, cx, cz, side, y0, y1, rx0, rz0, rx1, rz1, mat='accent', bevel=0.0):
    """tapered slab sitting in the +-z channel of a column between heights y0 (top) and y1"""
    rings = []
    for (y, rx, rz) in ((y0, rx0, rz0), (y1, rx1, rz1)):
        w = 0.55 * rx / 1.55 - 0.08
        zi = side * (rz - 0.13 - 0.03); zo = side * (rz - 0.13 + 0.09)
        rings.append([(cx - w, y, cz + zi), (cx + w, y, cz + zi), (cx + w, y, cz + zo), (cx - w, y, cz + zo)])
    return M.loft(rings, mat, bevel=bevel, seg=1)


def column(M, cx, cz, secs, mat, flute=True):
    """secs: [(y, rx, rz)] top-down; skinned loft of the fluted section"""
    rings = []
    for (y, rx, rz) in secs:
        poly = col_poly(rx, rz, flute)
        rings.append([(cx + u, y, cz + v) for (u, v) in poly])
    return M.loft(rings, mat, ang=0.9)


COLZ = 5.1          # column offset from the viaduct axis (columns carry the arcade wall directly)
PIER_HEAD = 7.4     # head module length (pier top -> start of the stretched shaft); JS must use the same value


@module('viaduct', 'viahead', sub=(2.4, 4, 7), rays=(12, 5, 0), maxd=3.5)
def viahead(lod):
    """pier head: cap beam, transverse portal arch and the upper 7.4 m of both columns, capitals at the arch springing (y = 0 at pier top)"""
    M = Mod(lod)
    d0 = lod == 0
    M.box((0, -0.7, 0), (3.1, 1.4, 12.4), 'wallDark', bevel=0.2 if d0 else 0, seg=2)
    M.box((0, -1.55, 0), (3.7, 0.3, 11.8), 'trim', bevel=0.08 if d0 else 0, seg=2)
    if lod < 2:
        M.box((0, -0.8, 0), (3.34, 0.12, 12.6), 'wallDark')
    ysp = YS + 2.8                                                          # springing level in pier coordinates
    for sz in (-1, 1):
        zc = sz * COLZ
        column(M, 0, zc, [(-1.2, 1.5, 1.32), (-4.0, 1.42, 1.28), (-PIER_HEAD, 1.36, 1.24)], 'wall')
        M.box((0, ysp - 0.12, zc), (3.2, 0.34, 2.9), 'wallLight', bevel=0.08 if d0 else 0, seg=1)       # capital where the arches spring
        M.box((0, ysp + 0.1, zc), (2.9, 0.12, 2.6), 'trim', bevel=0.03 if d0 else 0, seg=1)
        if lod < 2:
            for sd in (-1, 1):
                flute_panel(M, 0, zc, sd, -1.7, ysp - 0.5, 1.46, 1.3, 1.4, 1.27, 'accent', 0.03 if d0 else 0)
    # transverse portal arch between the columns (visible when looking along the viaduct / through the gateway)
    r_in = COLZ - 1.4
    n = 24 if d0 else 12 if lod == 1 else 8
    cy = -1.5 - r_in
    ring = arc(0, cy, r_in, math.pi, 0, n) + arc(0, cy, r_in + 0.8, 0, math.pi, n)
    M.prism(ring, -0.9, 0.9, 'wall', 'zy', bevel=0.1 if d0 else 0, seg=2)
    if lod < 2:
        M.prism(arc(0, cy, r_in - 0.02, math.pi, 0, n) + arc(0, cy, r_in + 0.2, 0, math.pi, n), -1.1, 1.1, 'trim', 'zy', bevel=0.05 if d0 else 0, seg=1)
        M.box((0, cy + r_in + 0.1, 0), (2.1, 0.5, 1.2), 'wallLight', bevel=0.1 if d0 else 0, seg=1)   # key block
    return M


@module('viaduct', 'viashaft', sub=(3.0, 5, 9), rays=(8, 4, 0), maxd=3.0, passes=3)
def viashaft(lod):
    """column shaft, reference length 10 (y 0 .. -10), scaled in y by the builder; x/z centred on the column"""
    M = Mod(lod)
    column(M, 0, 0, [(0, 1.36, 1.24), (-5, 1.24, 1.14), (-10, 1.14, 1.06)], 'wall')
    if lod < 2:
        for sd in (-1, 1):
            flute_panel(M, 0, 0, sd, -0.6, -9.4, 1.34, 1.22, 1.16, 1.08, 'accent', 0.03 if lod == 0 else 0)
    return M


@module('viaduct', 'viafoot', sub=(2.2, 4, 7), rays=(12, 5, 0), maxd=3.0)
def viafoot(lod):
    """bell-flared footing: y = 0 at the shaft bottom, smooth concave flare below, plinth buried underneath"""
    M = Mod(lod)
    d0 = lod == 0
    steps = 6 if lod == 0 else 4 if lod == 1 else 3
    secs = []
    for i in range(steps + 1):
        t = i / steps
        f = t ** 2.1
        secs.append((-2.6 * t, 1.14 + (2.5 - 1.14) * f, 1.06 + (2.35 - 1.06) * f))
    column(M, 0, 0, secs, 'wall')
    M.box((0, -2.6 - 0.65, 0), (5.8, 1.3, 5.5), 'wallDark', bevel=0.2 if d0 else 0, seg=2)
    M.box((0, -2.55, 0), (5.1, 0.16, 4.8), 'trim', bevel=0.05 if d0 else 0, seg=1)
    M.box((0, -4.3, 0), (6.2, 1.6, 5.8), 'wallDark', bevel=0.15 if d0 else 0, seg=1)
    return M


@module('viaduct', 'viatie', sub=(2, 4, 7), rays=(10, 4, 0), maxd=2.5)
def viatie(lod):
    """tie beam between the two columns (for tall piers), centred at y 0"""
    M = Mod(lod)
    d0 = lod == 0
    M.box((0, 0, 0), (2.0, 0.9, 2 * COLZ - 2.0), 'wall', bevel=0.14 if d0 else 0, seg=2)
    M.box((0, -0.48, 0), (2.5, 0.14, 2 * COLZ - 1.6), 'trim', bevel=0.04 if d0 else 0, seg=1)
    return M


# ═════════════════════════════════════════════════ FACTORY GATE ════════════════════════════════════════════════
# front faces +z. Wall W x Hh x D centred on x=0, ground y=0 (buried to y=-1). Door opening half-width GDW, height GDH.
GW, GH, GD, GDW, GDH = 46.0, 34.0, 9.0, 11.5, 17.5
GR = 5.5            # door top-corner radius


def door_path(hw, h, r, yb, n=8):
    pts = [(-hw, yb)]
    pts += arc(-hw + r, h - r, r, math.pi, math.pi / 2, n)
    pts += arc(hw - r, h - r, r, math.pi / 2, 0, n)
    pts += [(hw, yb)]
    return pts


def u_frame(o0, o1, yb, n=8, hw=GDW, h=GDH, r=GR):
    """U-shaped frame hugging the door opening between offsets o0..o1 (open at the bottom)"""
    outer = door_path(hw + o1, h + o1, r + o1, yb, n)
    inner = door_path(hw + o0, h + o0, r + o0, yb, n)[::-1]
    return outer + inner


@module('gate', 'gate', lods=(0, 1, 2), sub=(3.0, 6.0, 10), rays=(10, 4, 0), maxd=4.5, passes=3)
def gate(lod):
    M = Mod(lod)
    d0 = lod == 0
    nb = lambda v: v if d0 else 0
    z0 = GD / 2
    n = 9 if d0 else 4
    # ── wall core with the arched opening, door plug behind the leaves
    core = [(-GW / 2, -1.0)] + door_path(GDW, GDH, GR, -1.0, n) + [(GW / 2, -1.0), (GW / 2, GH), (-GW / 2, GH)]
    M.prism(core, -z0, z0, 'wall', 'xy', bevel=nb(0.3), seg=2)
    M.prism(door_path(GDW + 0.2, GDH + 0.2, GR + 0.2, -1.0, n), -z0, -2.4, 'wallDark', 'xy')
    # ── layered door frame (stepped) with an orange outline ring
    M.prism(u_frame(0.0, 1.3, -1.0, n), z0 - 0.1, z0 + 0.55, 'wallLight', 'xy', bevel=nb(0.14), seg=2)
    M.prism(u_frame(1.3, 2.5, -1.0, n), z0 - 0.1, z0 + 1.05, 'trim', 'xy', bevel=nb(0.16), seg=2)
    M.prism(u_frame(2.5, 3.15, -1.0, n), z0 - 0.1, z0 + 0.5, 'accent', 'xy', bevel=nb(0.08), seg=1)
    if lod < 2:
        M.prism(u_frame(3.15, 3.55, -1.0, n), z0 - 0.1, z0 + 0.8, 'wallDark', 'xy', bevel=nb(0.08), seg=1)
    # ── heavy leaves: dark core, raised panels, hazard bands, glowing seam
    lw = GDW - 0.2
    for sx in (-1, 1):
        # leaf outline follows the arch (split down the middle)
        a0 = GDW - 0.15; hh = GDH - 0.15; rr = GR - 0.15
        pts = []
        pts += [(sx * 0.07, -0.4)]
        if sx < 0:
            pts = [(-0.07, -0.4), (-a0, -0.4), (-a0, hh - rr)] + arc(-a0 + rr, hh - rr, rr, math.pi, math.pi / 2, n) + [(-0.07, hh)]
        else:
            pts = [(0.07, -0.4), (0.07, hh)] + arc(a0 - rr, hh - rr, rr, math.pi / 2, 0, n) + [(a0, hh - rr), (a0, -0.4)]
        M.prism(pts, -2.4, -0.9, 'metal', 'xy', bevel=nb(0.12), seg=2)
        zf = -0.9
        if lod < 2:
            cx = sx * (0.07 + a0) / 2
            wcell = (a0 - 0.07 - 1.2) / 2
            for c in range(2):
                for r_ in range(5):
                    y0 = 2.7 + r_ * 2.95
                    if y0 + 2.45 > hh - (0 if r_ < 3 else 3.2 if c == 1 else 0) - 0.2 and r_ >= 3 and c == 1:
                        pass
                    x = cx + (c - 0.5) * (wcell + 0.5)
                    # skip panels whose top corner would poke out of the arch
                    xo = abs(x) + wcell / 2
                    ytop = y0 + 2.5
                    if xo > a0 - rr and ytop > hh - rr + math.sqrt(max(0.0, rr * rr - (xo - (a0 - rr)) ** 2)) - 0.3: continue
                    M.box((x, y0 + 1.25, zf + 0.12), (wcell, 2.5, 0.28), 'wall', bevel=nb(0.1), seg=2)
                    M.box((x, y0 + 1.25, zf + 0.3), (wcell - 0.8, 1.7, 0.12), 'wallLight', bevel=nb(0.05), seg=1)
            # horizontal ribs + hazard bands
            for yy in (0.9, 8.6, 16.0):
                M.box((cx, yy, zf + 0.24), (a0 - 0.07 - 0.3, 0.42, 0.36), 'wallLight', bevel=nb(0.08), seg=1)
            M.box((cx, 1.65, zf + 0.38), (a0 - 0.07 - 0.9, 1.0, 0.18), 'accent', bevel=nb(0.05), seg=1)
            M.box((cx, 12.3, zf + 0.34), (a0 - 0.07 - 1.2, 0.8, 0.14), 'accent', bevel=nb(0.05), seg=1)
            if d0:
                for yy in (0.9, 8.6, 16.0):
                    for k in range(5):
                        M.cyl((cx + (k - 2) * (a0 - 1.2) / 4.4, yy, zf + 0.46), 0.13, 0.12, 'trim', 'z', 8)
    M.box((0, GDH / 2 - 0.4, -0.95), (0.3, GDH - 3.0, 0.2), 'glow')
    # ── base plinth beside the frame
    for sx in (-1, 1):
        x0 = GDW + 3.7; x1 = GW / 2 + 0.35
        M.box((sx * (x0 + x1) / 2, 0.3, z0 + 0.1), (x1 - x0, 2.6, 1.3), 'wallDark', bevel=nb(0.2), seg=2)
        M.box((sx * (x0 + x1) / 2, 1.7, z0 + 0.2), (x1 - x0 - 0.3, 0.3, 1.0), 'trim', bevel=nb(0.07), seg=1)
    # ── facade bays beside the door
    for sx in (-1, 1):
        for (px, wd) in ((15.65, 1.7), (21.5, 3.0)):          # pilasters
            M.box((sx * px, 16.2, z0 + 0.45), (wd, 29.6, 0.95), 'trim', bevel=nb(0.18), seg=2)
            M.box((sx * px, 31.3, z0 + 0.6), (wd + 0.7, 1.0, 1.3), 'wallLight', bevel=nb(0.15), seg=2)     # capital
            M.box((sx * px, 1.9, z0 + 0.6), (wd + 0.6, 0.8, 1.2), 'wallLight', bevel=nb(0.12), seg=1)       # base
        bx = 18.55                                                                                          # bay centre
        bwid = 3.45
        # orange slab stack
        for (y0, y1) in ((2.8, 8.6), (9.1, 14.9), (15.4, 19.0)):
            M.box((sx * bx, (y0 + y1) / 2, z0 + 0.35), (bwid - 0.4, y1 - y0, 0.55), 'accent', bevel=nb(0.15), seg=2)
            if lod < 2: M.box((sx * bx, (y0 + y1) / 2, z0 + 0.7), (bwid - 1.3, y1 - y0 - 1.0, 0.16), 'accentDark', bevel=nb(0.05), seg=1)
        # string course + window row (raised skin leaves slit windows recessed)
        M.box((sx * 18.55, 19.7, z0 + 0.25), (bwid + 2.0, 0.5, 0.6), 'trim', bevel=nb(0.1), seg=1)
        M.box((sx * bx, 20.6, z0 + 0.25), (bwid, 1.0, 0.5), 'wall', bevel=nb(0.08), seg=1)
        M.box((sx * bx, 30.9, z0 + 0.25), (bwid, 1.2, 0.5), 'wall', bevel=nb(0.08), seg=1)
        for k, ox in enumerate((-1.2, 0.0, 1.2)):
            pass
        for ox in (-1.75, 0.0, 1.75):
            M.box((sx * (bx + ox), 25.75, z0 + 0.25), (0.55 if ox else 0.5, 9.4, 0.5), 'wall', bevel=nb(0.06), seg=1)
        for ox in (-0.87, 0.87):
            M.box((sx * (bx + ox), 25.75, z0 + 0.04), (0.98, 8.6, 0.08), 'glass')
            if lod < 2: M.box((sx * (bx + ox), 21.2, z0 + 0.2), (1.15, 0.2, 0.4), 'trim', bevel=nb(0.04), seg=1)
    # ── lintel housing above the door: louvres, orange sign
    M.box((0, 25.3, z0 + 0.85), (28.6, 6.6, 1.7), 'wall', bevel=nb(0.25), seg=2)
    M.box((0, 28.85, z0 + 1.0), (29.4, 0.5, 2.1), 'trim', bevel=nb(0.12), seg=2)
    M.box((0, 21.95, z0 + 1.0), (29.4, 0.5, 2.1), 'trim', bevel=nb(0.12), seg=2)
    if lod < 2:
        M.box((0, 25.3, z0 + 1.62), (20.8, 4.8, 0.22), 'wallDark', bevel=nb(0.05), seg=1)
        for k in range(9):
            M.box((0, 23.3 + k * 0.5, z0 + 1.82), (20.2, 0.22, 0.34), 'wallLight', bevel=nb(0.04), seg=1)
        for sx in (-1, 1):
            M.box((sx * 12.3, 25.3, z0 + 1.82), (1.6, 5.0, 0.3), 'accent', bevel=nb(0.1), seg=2)
    # ── sign plate and crown
    M.box((0, 30.1, z0 + 0.4), (9.0, 1.7, 0.6), 'accent', bevel=nb(0.15), seg=2)
    if lod < 2: M.box((0, 30.1, z0 + 0.78), (7.6, 0.8, 0.16), 'accentDark', bevel=nb(0.05), seg=1)
    nc = 21 if lod < 2 else 0
    for i in range(nc):
        x = -GW / 2 + 1.5 + i * (GW - 3.0) / (nc - 1)
        M.box((x, 31.7, z0 + 0.35), (1.35, 1.0, 0.85), 'wallLight', bevel=nb(0.1), seg=1)
    M.box((0, GH - 1.25, 0), (GW + 1.8, 1.4, GD + 1.8), 'trim', bevel=nb(0.2), seg=2)
    for sz in (-1, 1):
        M.box((0, GH + 0.75, sz * (GD / 2 - 0.5)), (GW - 0.4, 1.6, 1.0), 'wallLight', bevel=nb(0.15), seg=2)
    for sx in (-1, 1):
        M.box((sx * (GW / 2 - 0.5), GH + 0.75, 0), (1.0, 1.6, GD - 1.8), 'wallLight', bevel=nb(0.15), seg=2)
    # ── roof masts
    if lod < 2:
        for sx in (-1, 1):
            mx = sx * 17.0
            M.box((mx, GH + 5.2, 0.0), (1.1, 8.0, 1.1), 'metal', bevel=nb(0.08), seg=1, taper=(0.55, 0.55))
            for yy in (GH + 3.0, GH + 6.5):
                M.box((mx, yy, 0.0), (1.7, 0.3, 1.7), 'trim', bevel=nb(0.06), seg=1)
            M.cyl((mx, GH + 9.6, 0), 0.38, 0.9, 'accent', 'y', 10 if d0 else 6)
    return M


# ═════════════════════════════════════════════════ PIPE GANTRY ═════════════════════════════════════════════════
# x along the span (32 m between tower centres), z depth 7, ground y = 0, legs 11 m, deck top y = 12.35
GSPAN, GHT, GDEP = 32.0, 11.0, 7.0


def lattice_tower(M, cx, cz, h, w0, w1, nb, lod, y0=0.0):
    d0 = lod == 0
    wy = lambda t: w0 + (w1 - w0) * t
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for (sx, sz) in corners:
        a = (cx + sx * w0, y0, cz + sz * w0); b = (cx + sx * w1, y0 + h, cz + sz * w1)
        beam(M, a, b, 0.36, 0.36, 'wall', bevel=0.06 if d0 else 0, seg=1, up=(sz, 0, -sx))
    for k in range(nb + 1):
        t = k / nb; y = y0 + h * t; hw = wy(t)
        if lod >= 2 and k not in (0, nb): continue
        for i in range(4):
            (sx, sz) = corners[i]; (tx, tz) = corners[(i + 1) % 4]
            beam(M, (cx + sx * hw, y, cz + sz * hw), (cx + tx * hw, y, cz + tz * hw), 0.2, 0.24, 'trim', bevel=0.04 if d0 else 0, seg=1)
    if lod < 2:
        for k in range(nb):
            t0, t1 = k / nb, (k + 1) / nb
            h0, h1 = wy(t0), wy(t1)
            y_a, y_b = y0 + h * t0, y0 + h * t1
            for i in range(4):
                (sx, sz) = corners[i]; (tx, tz) = corners[(i + 1) % 4]
                pa = (cx + sx * h0, y_a, cz + sz * h0); pb = (cx + tx * h1, y_b, cz + tz * h1)
                pc = (cx + tx * h0, y_a, cz + tz * h0); pd = (cx + sx * h1, y_b, cz + sz * h1)
                beam(M, pa, pb, 0.13, 0.13, 'metal')
                beam(M, pc, pd, 0.13, 0.13, 'metal')
            if d0:   # gusset plates at the ring nodes
                for (sx, sz) in corners:
                    M.box((cx + sx * (h1 + 0.02), y_b, cz + sz * (h1 + 0.02)), (0.62, 0.62, 0.62), 'wallLight', rot=(0, math.atan2(sz, sx) + math.pi / 4, 0), bevel=0.05, seg=1)
    # footing + base plates + head plate
    M.box((cx, y0 - 0.5, cz), (w0 * 2 + 1.5, 1.4, w0 * 2 + 1.5), 'wallDark', bevel=0.15 if d0 else 0, seg=1)
    if lod < 2:
        M.box((cx, y0 + 0.22, cz), (w0 * 2 + 0.5, 0.3, w0 * 2 + 0.5), 'trim', bevel=0.05 if d0 else 0, seg=1)
    M.box((cx, y0 + h + 0.25, cz), (w1 * 2 + 0.9, 0.5, w1 * 2 + 0.9), 'wallLight', bevel=0.1 if d0 else 0, seg=1)


@module('gantry', 'gantry', lods=(0, 1, 2), sub=(2.6, 5, 9), rays=(10, 4, 0), maxd=3.0, passes=3)
def gantry(lod):
    M = Mod(lod)
    d0 = lod == 0
    nb = lambda v: v if d0 else 0
    hs, dz = GSPAN / 2, GDEP / 2
    yd = 12.35                 # deck top
    for sx in (-1, 1):
        for sz in (-1, 1):
            lattice_tower(M, sx * hs, sz * dz, GHT, 1.5, 0.95, 4, lod)
        # portal cross beam over each pair of legs
        M.box((sx * hs, 11.85, 0), (1.5, 1.4, GDEP + 1.6), 'wall', bevel=nb(0.15), seg=2)
        if lod < 2: M.box((sx * hs, 11.1, 0), (2.1, 0.2, GDEP + 1.9), 'trim', bevel=nb(0.05), seg=1)
    # longitudinal girders with stiffeners
    for sz in (-1, 1):
        M.box((0, 11.9, sz * dz), (GSPAN + 3.4, 1.3, 1.0), 'wall', bevel=nb(0.12), seg=2)
        if lod < 2:
            M.box((0, 12.58, sz * dz), (GSPAN + 3.4, 0.14, 1.5), 'trim', bevel=nb(0.04), seg=1)
            M.box((0, 11.22, sz * dz), (GSPAN + 3.4, 0.14, 1.5), 'trim', bevel=nb(0.04), seg=1)
        if d0:
            for k in range(-7, 8):
                M.box((k * 2.2, 11.9, sz * (dz + 0.55)), (0.2, 1.1, 0.12), 'wallLight', bevel=0.03, seg=1)
    # deck plate + walking surface ribs, floor beams
    M.box((0, yd - 0.2, 0), (GSPAN + 3.0, 0.3, GDEP - 0.8), 'deck', bevel=nb(0.06), seg=1)
    if d0:
        for k in range(-18, 19):
            M.box((k * 0.9, yd - 0.01, 0), (0.22, 0.05, GDEP - 1.2), 'wallDark')
        for sz in (-1, 1):
            M.box((0, yd + 0.04, sz * (dz - 0.25)), (GSPAN + 2.6, 0.1, 0.14), 'accentDark')
    if lod < 2:
        for k in range(-7, 8):
            M.box((k * 2.2, 11.15, 0), (0.28, 0.5, GDEP - 0.7), 'metal', bevel=nb(0.05), seg=1)
        for k in range(-7, 7):          # plan X-bracing between the girders
            xa, xb = k * 2.2, (k + 1) * 2.2
            beam(M, (xa, 10.85, -dz + 0.4), (xb, 10.85, dz - 0.4), 0.12, 0.12, 'metal', bevel=nb(0.02), seg=1)
            beam(M, (xa, 10.85, dz - 0.4), (xb, 10.85, -dz + 0.4), 0.12, 0.12, 'metal', bevel=nb(0.02), seg=1)
        # railings both sides (outside the girders) with kick plates
        n = 19 if d0 else 9
        for sz in (-1, 1):
            zr = sz * (dz - 0.2)
            for i in range(n + 1):
                x = -GSPAN / 2 - 1.2 + (GSPAN + 2.4) * i / n
                if d0: M.cyl((x, yd + 0.56, zr), 0.045, 1.1, 'metal', 'y', 8)
            tube(M, (-GSPAN / 2 - 1.2, yd + 1.1, zr), (GSPAN / 2 + 1.2, yd + 1.1, zr), 0.05, 'trim', 8 if d0 else 5)
            if d0: tube(M, (-GSPAN / 2 - 1.2, yd + 0.6, zr), (GSPAN / 2 + 1.2, yd + 0.6, zr), 0.03, 'metal', 6)
            M.box((0, yd + 0.13, zr), (GSPAN + 2.4, 0.2, 0.05), 'wallLight')
    # pipes with flanges, saddles, branch, valve assembly
    pipes = [(0.62, -1.7, 'trim'), (0.45, 0.0, 'wallLight'), (0.32, 1.7, 'wallLight')]
    ypipe = yd + 1.55
    sg = 24 if d0 else 12 if lod == 1 else 8
    for (r, z, m) in pipes:
        tube(M, (-GSPAN / 2 - 1.2, ypipe, z), (GSPAN / 2 + 1.2, ypipe, z), r, m, sg)
        if lod < 2:
            for x in range(-14, 15, 5):
                xx = x + (0.7 if r > 0.5 else -0.4 if r > 0.4 else 1.2)
                tube(M, (xx - 0.15, ypipe, z), (xx + 0.15, ypipe, z), r + 0.13, 'metal', sg)
                if d0:
                    tube(M, (xx - 0.36, ypipe, z), (xx - 0.2, ypipe, z), r + 0.06, 'metal', sg)
                    tube(M, (xx + 0.2, ypipe, z), (xx + 0.36, ypipe, z), r + 0.06, 'metal', sg)
            for k in range(-3, 4):
                xs = k * 4.6
                M.box((xs, yd + (ypipe - yd - r) / 2 - 0.02, z), (0.9, ypipe - yd - r + 0.05, 0.7), 'wallDark', bevel=nb(0.06), seg=1)
    if lod < 2:
        # vent stack on the small pipe, valve wheel + actuator on the trunk, pump cabinet on the deck
        tube(M, (-9.0, ypipe, 1.7), (-9.0, ypipe + 3.4, 1.7), 0.26, 'wallLight', 14 if d0 else 8)
        tube(M, (-9.0, ypipe + 3.4, 1.7), (-9.0, ypipe + 3.7, 1.7), 0.38, 'metal', 14 if d0 else 8)
        tube(M, (7.0, ypipe + 0.6, -1.7), (7.0, ypipe + 1.9, -1.7), 0.09, 'metal', 8)
        M.box((7.0, ypipe + 0.95, -1.7), (0.9, 0.8, 0.9), 'wall', bevel=nb(0.1), seg=1)
        if d0: torus(M, (7.0, ypipe + 2.0, -1.7), 0.62, 0.07, 'y', 'accent', 20, 6)
        M.box((10.6, yd + 0.85, -1.9), (2.6, 1.7, 1.5), 'wall', bevel=nb(0.12), seg=2)
        M.box((10.6, yd + 1.74, -1.9), (2.8, 0.18, 1.7), 'trim', bevel=nb(0.05), seg=1)
        if d0:
            for k in range(6): M.box((10.6, yd + 0.5 + k * 0.2, -1.12), (1.8, 0.1, 0.08), 'wallDark')
        M.box((10.6, yd + 0.95, -1.12), (0.8, 0.5, 0.08), 'accent', bevel=nb(0.03), seg=1)
    return M


# ═════════════════════════════════════════════════ CATWALK ═════════════════════════════════════════════════════
# bay: 2.6 m along x (centred), width 4.6, deck top y = 0, truss depth 2.2 below the side beams
CWL, CWW, CWD = 2.6, 4.6, 2.2


@module('catwalk', 'cwbay', sub=(2.2, 4, 8), rays=(10, 4, 0), maxd=2.2)
def cwbay(lod):
    M = Mod(lod)
    d0 = lod == 0
    nb = lambda v: v if d0 else 0
    L, W = CWL, CWW
    hw = W / 2
    M.box((0, -0.17, 0), (L, 0.2, W - 0.5), 'wallDark', bevel=nb(0.04), seg=1)
    if lod < 2:
        for k in range(-4, 5):
            M.box((0, -0.04, k * 0.46), (L - 0.06, 0.08, 0.34), 'deck', bevel=nb(0.025), seg=1)
    else:
        M.box((0, -0.04, 0), (L, 0.08, W - 0.5), 'deck')
    zt = hw - 0.2
    ytop, ybot = -0.7, -0.7 - CWD
    for sz in (-1, 1):
        zs = sz * (hw - 0.12)
        M.box((0, -0.34, zs), (L, 0.62, 0.16), 'wallLight', bevel=nb(0.03), seg=1)
        M.box((0, -0.03, zs), (L, 0.09, 0.44), 'trim', bevel=nb(0.03), seg=1)
        if lod < 2: M.box((0, -0.64, zs), (L, 0.09, 0.4), 'trim', bevel=nb(0.03), seg=1)
        if lod < 2:
            zc = sz * zt
            M.box((0, ytop, zc), (L, 0.26, 0.26), 'metal', bevel=nb(0.04), seg=1)
            M.box((0, ybot, zc), (L, 0.26, 0.26), 'metal', bevel=nb(0.04), seg=1)
            for ex in (-1, 1):
                beam(M, (ex * L / 2, ytop, zc), (ex * L / 2, ybot, zc), 0.2, 0.2, 'metal', bevel=nb(0.03), seg=1)
            beam(M, (-L / 2, ytop, zc), (L / 2, ybot, zc), 0.14, 0.14, 'metal', bevel=nb(0.025), seg=1)
            if d0:
                for (gx, gy) in ((-L / 2, ytop), (L / 2, ytop), (-L / 2, ybot), (L / 2, ybot)):
                    M.box((gx * 0.97, gy, zc + sz * 0.15), (0.5, 0.5, 0.06), 'wallLight', bevel=0.02, seg=1)
    if lod < 2:
        M.box((-L / 2 + 0.15, -0.55, 0), (0.3, 0.34, W - 0.4), 'metal', bevel=nb(0.05), seg=1)
        beam(M, (-L / 2, ybot, -zt), (-L / 2, ybot, zt), 0.16, 0.16, 'metal', bevel=nb(0.02), seg=1)
        if d0:
            beam(M, (-L / 2, ybot, -zt), (L / 2, ybot, zt), 0.1, 0.1, 'metal')
            beam(M, (-L / 2, ybot, zt), (L / 2, ybot, -zt), 0.1, 0.1, 'metal')
    return M


@module('catwalk', 'cwrail', sub=(1.4, 3, 6), rays=(8, 4, 0), maxd=1.2)
def cwrail(lod):
    """guard rail module: 2.6 m along x, standing on y = 0 at z = 0"""
    M = Mod(lod)
    d0 = lod == 0
    L = CWL
    for sx in (-1, 1):
        x = sx * (L / 2 - 0.03)
        M.cyl((x, 0.58, 0), 0.045, 1.12, 'metal', 'y', 8 if d0 else 5)
        if d0: M.cyl((x, 0.05, 0), 0.1, 0.1, 'trim', 'y', 10)
    tube(M, (-L / 2, 1.12, 0), (L / 2, 1.12, 0), 0.052, 'trim', 8 if d0 else 5)
    if lod < 2:
        tube(M, (-L / 2, 0.6, 0), (L / 2, 0.6, 0), 0.032, 'metal', 6 if d0 else 4)
        M.box((0, 0.12, 0), (L, 0.14, 0.04), 'wallLight')
    return M


# ═════════════════════════════════════════════════ STAIRS ══════════════════════════════════════════════════════
# run 0.36, rise 0.2 per step (the builder stretches y by sh/0.2), ascending along +z, tread width 3.4 (builder scales x)
SRUN, SRISE = 0.36, 0.2


@module('stairs', 'stairstep', sub=(2.0, 4, 8), rays=(8, 0, 0), maxd=1.2, passes=2)
def stairstep(lod):
    M = Mod(lod)
    d0 = lod == 0
    M.box((0, 0.162, 0.2), (3.4, 0.076, 0.42), 'trim', bevel=0.02 if d0 else 0, seg=1)
    M.box((0, 0.09, 0.045), (3.4, 0.2, 0.08), 'wallLight', bevel=0.012 if d0 else 0, seg=1)
    if d0:
        for zz in (0.1, 0.17, 0.24):
            M.box((0, 0.2, zz), (3.0, 0.012, 0.022), 'wallDark')
    return M


def _stair_run(lod, n, side):
    """one stringer cap beam (+ handrail with posts) for n steps; side=+1 extends toward +x from the tread edge (x=0), -1 toward -x"""
    M = Mod(lod)
    d0 = lod == 0
    L = n * SRUN
    k = SRISE / SRUN
    yt = lambda z: 0.4 + k * z
    drop = 0.95
    t0, t1 = (0.0, 0.5 * side) if side > 0 else (0.5 * side, 0.0)
    pts = [(0, yt(0) - drop), (L, yt(L) - drop), (L, yt(L)), (0, yt(0))]
    M.prism(pts, t0, t1, 'wall', 'zy', bevel=0.06 if d0 else 0, seg=1)
    if lod < 2:
        # cap strip along the top edge
        cap = [(0, yt(0) - 0.02), (L, yt(L) - 0.02), (L, yt(L) + 0.07), (0, yt(0) + 0.07)]
        M.prism(cap, 0.5 * side - 0.1 * side if side > 0 else 0.5 * side, 0.1 * side if side > 0 else 0.0, 'trim', 'zy', bevel=0.03 if d0 else 0, seg=1) if False else None
        xs0, xs1 = (-0.04, 0.54) if side > 0 else (-0.54, 0.04)
        M.prism(cap, xs0, xs1, 'trim', 'zy', bevel=0.03 if d0 else 0, seg=1)
        # inset panel on the outer face
        if d0 and n >= 4:
            xo = 0.5 * side
            pp = [(0.25, yt(0.25) - drop + 0.14), (L - 0.25, yt(L - 0.25) - drop + 0.14), (L - 0.25, yt(L - 0.25) - 0.18), (0.25, yt(0.25) - 0.18)]
            xa, xb = (xo - 0.05, xo + 0.04) if side > 0 else (xo - 0.04, xo + 0.05)
            M.prism(pp, xa, xb, 'wallLight', 'zy', bevel=0.02, seg=1)
        # rail posts + rails
        px = 0.25 * side
        posts = [0.2, L - 0.2] if n >= 3 else [L / 2]
        if n >= 6: posts = [0.2, 0.2 + (L - 0.4) / 2, L - 0.2]
        for z in posts:
            y0 = yt(z) + 0.07
            M.cyl((px, y0 + 0.5, z), 0.042, 1.0, 'metal', 'y', 8 if d0 else 5)
            if d0: M.cyl((px, y0 + 0.04, z), 0.09, 0.08, 'trim', 'y', 10)
        tube(M, (px, yt(0) + 0.07 + 1.0, 0), (px, yt(L) + 0.07 + 1.0, L), 0.05, 'trim', 8 if d0 else 5)
        if d0 or n > 1:
            tube(M, (px, yt(0) + 0.07 + 0.52, 0), (px, yt(L) + 0.07 + 0.52, L), 0.03, 'metal', 6 if d0 else 4)
    return M


for _n in (6, 1):
    for _side, _nm in ((1, 'a'), (-1, 'b')):
        module('stairs', f'stairrun{_n}{_nm}', sub=(2.0, 4, 8), rays=(8, 0, 0), maxd=1.2, passes=2)((lambda lod, n=_n, sd=_side: _stair_run(lod, n, sd)))


@module('stairs', 'stairfin', sub=(2.5, 5, 8), rays=(8, 0, 0), maxd=1.5, passes=2)
def stairfin(lod):
    """buttress fin: unit height, base at y=0 (scaled in y by the builder), protrudes +x, 0.8 wide along z"""
    M = Mod(lod)
    M.box((0.15, 0.5, 0), (0.3, 1.0, 0.8), 'wallLight', bevel=0.05 if lod == 0 else 0, seg=1)
    return M


# ═════════════════════════════════════════════════ RUIN WALL ═══════════════════════════════════════════════════
# collapsed arcade wall: wall plane XY, thickness along z (centred), ground y = 0 (buried to -1.2); nominal w 16 x h 10 x t 2.4
RUW, RUH, RUT = 16.0, 10.0, 2.4


def chunk(M, c, s, mat, r, rot=(0, 0, 0), bevel=0.0, n=11, flat=0.6, sharp=0.35):
    """irregular broken-masonry chunk: convex hull of jittered points on an ellipsoid (centre c, half extents s), bevelled when lod 0"""
    bm = M.bm
    pts = []
    for _ in range(n):
        v = Vector((r.gauss(0, 1), r.gauss(0, 1) * flat, r.gauss(0, 1)))
        if v.length < 1e-3: v = Vector((1, 0, 0))
        v.normalize()
        v *= r.uniform(0.8, 1.0)
        pts.append(Vector((v.x * s[0], v.y * s[1], v.z * s[2])))
    m = Matrix.Rotation(rot[2], 3, 'Z') @ Matrix.Rotation(rot[1], 3, 'Y') @ Matrix.Rotation(rot[0], 3, 'X')
    verts = [bm.verts.new(Vector(c) + m @ p) for p in pts]
    res = bmesh.ops.convex_hull(bm, input=verts, use_existing_faces=False)
    junk = list({g for g in res['geom_interior'] + res['geom_unused'] if isinstance(g, bmesh.types.BMVert) and g.is_valid})
    if junk: bmesh.ops.delete(bm, geom=junk, context='VERTS')
    faces = [g for g in res['geom'] if isinstance(g, bmesh.types.BMFace) and g.is_valid]
    return M._fin(faces, mat, bevel, 1, ang=sharp)


def broken_post(M, x, top, w, thick, r, mat, bevel=0.0, base=-1.2):
    """pilaster whose top has snapped off along a slanted fracture"""
    dz = r.uniform(0.3, 0.9)
    pts = [(x - w / 2, base), (x + w / 2, base), (x + w / 2, top), (x + w * 0.12, top + r.uniform(0.15, 0.55)), (x - w / 2, top - dz)]
    return M.prism(pts, -thick / 2, thick / 2, mat, 'xy', bevel=bevel, seg=1)


def ruin(seed, lod):
    import random
    r = random.Random(seed * 13 + 5)
    M = Mod(lod)
    d0 = lod == 0
    nb = lambda v: v if d0 else 0
    kind = (seed - 1) % 3
    ys = 2.3; a = 4.4; b = 3.6
    n = 20 if d0 else 10 if lod == 1 else 6
    # broken top contour from right to left: slanted fracture lines, never lower than the arch moulding where the arch is still carried
    tops = []
    x = 8.0
    cap_r = {0: 0.86, 1: 0.52, 2: 0.84}[kind] * RUH
    cap_l = {0: 0.76, 1: 0.84, 2: 0.46}[kind] * RUH
    y = cap_r
    tops.append((x, y))
    while x > -8.0 + 0.5:
        dx = r.uniform(0.9, 2.2)
        x2 = max(-8.0, x - dx)
        lo = 7.5 if abs(x2) < 5.4 else 3.6
        hi = max((cap_r if x2 > 0 else cap_l) + (0.4 if abs(x2) < 5.4 else 0.0), lo + 0.25)
        y2 = min(hi, max(lo, y + r.uniform(-1.9, 1.3)))
        if r.random() < 0.28 and abs(x2) > 5.4:
            y2 = max(lo, y2 - r.uniform(1.0, 2.2))                 # spalled bite
        tops.append((x2, y2))
        x, y = x2, y2
    tops[-1] = (-8.0, tops[-1][1])
    arc_pts = [(a * math.cos(math.pi - math.pi * i / n), ys + b * math.sin(math.pi * i / n)) for i in range(n + 1)]
    poly = [(-8.0, -1.2), (-a, -1.2), (-a, ys)] + arc_pts[1:-1] + [(a, ys), (a, -1.2), (8.0, -1.2)] + tops
    M.prism(poly, -RUT / 2, RUT / 2, 'wall', 'xy', bevel=nb(0.14), seg=2)
    # arch ring of voussoirs with a keystone; stones knocked out (more of them on the collapsed variants)
    nv = 15 if lod < 2 else 0
    missing = {0: {2, 12}, 1: {9, 10, 11, 13}, 2: {1, 3, 8}}[kind] if lod < 2 else set()
    t_out = 1.0
    for i in range(nv):
        a0 = math.pi - math.pi * i / nv; a1 = math.pi - math.pi * (i + 1) / nv
        if i in missing: continue
        gap = 0.018 if d0 else 0.0
        a0 -= gap; a1 += gap
        pts_in = [(a * math.cos(a0 + (a1 - a0) * j / 3), ys + b * math.sin(a0 + (a1 - a0) * j / 3)) for j in range(4)]
        pts_out = [((a + t_out) * math.cos(a1 + (a0 - a1) * j / 3), ys + (b + t_out) * math.sin(a1 + (a0 - a1) * j / 3)) for j in range(4)]
        big = 0.12 if i == nv // 2 else 0.0
        jit = r.uniform(-0.05, 0.07) if d0 else 0.0
        M.prism(pts_in + pts_out, -RUT / 2 - 0.3 - big - jit, RUT / 2 + 0.3 + big + jit, 'wallLight', 'xy', bevel=nb(0.05), seg=1)
    # pilasters beside the arch (snapped off at different heights) and at both ends, plinth, string courses
    for sx in (-1, 1):
        topp = [ys + 3.4 + 0.2, ys + 1.9, ys + 3.4 - 0.9][(kind + (0 if sx > 0 else 1)) % 3]
        broken_post(M, sx * (a + 0.8), topp, 1.6, RUT + 0.7, r, 'wallLight', nb(0.12))
        if topp > ys + 3.0: M.box((sx * (a + 0.8), ys + 3.55, 0), (1.9, 0.45, RUT + 1.0), 'trim', bevel=nb(0.1), seg=1)
        he = (cap_r if sx > 0 else cap_l) - 0.5
        broken_post(M, sx * 7.25, he, 1.5, RUT + 0.7, r, 'wallLight', nb(0.12))
        M.box((sx * (a + (8.0 - a) / 2), 0.3, 0), (8.0 - a + 0.4, 1.4, RUT + 0.9), 'wallDark', bevel=nb(0.12), seg=2)
        if lod < 2:
            M.box((sx * (a + (8.0 - a) / 2), 2.0, 0), (8.0 - a, 0.42, RUT + 0.55), 'trim', bevel=nb(0.08), seg=1)
    # raised panel frames on the wall bays
    if lod < 2:
        for sx in (-1, 1):
            for zz in (-1, 1):
                M.box((sx * 6.4, 4.4, zz * (RUT / 2 + 0.07)), (1.3, 3.0, 0.14), 'wallDark', bevel=nb(0.04), seg=1)
    # rebar stubs standing out of the fractures (bent), exposed
    if lod < 2 and d0:
        for i in range(7):
            x = r.uniform(-6.8, 6.8)
            cand = [(xx, yy) for (xx, yy) in tops if abs(xx - x) < 1.6]
            yt = max(yy for (_, yy) in cand) if cand else RUH * 0.7
            p0 = Vector((x, yt - 0.35, r.uniform(-0.7, 0.7)))
            p1 = p0 + Vector((r.uniform(-0.15, 0.15), r.uniform(0.6, 1.2), r.uniform(-0.15, 0.15)))
            p2 = p1 + Vector((r.uniform(-0.45, 0.45), r.uniform(0.2, 0.55), r.uniform(-0.2, 0.2)))
            tube(M, p0, p1, 0.045, 'metal', 6); tube(M, p1, p2, 0.045, 'metal', 6)
    # rubble: broken masonry chunks at three sizes, partly sunk into the ground, in front of and behind the wall
    for i in range(10 if lod < 2 else 3):
        k = i % 3
        sz = (0.8 + r.random() * 0.7, 0.45 + r.random() * 0.25, 0.4)[k] if i < 9 else 0.5
        s = (sz * 0.95, sz * 0.62, sz * 0.8)
        x = r.uniform(-9.5, 9.5)
        zz = (1 if r.random() > 0.5 else -1) * (RUT / 2 + 0.5 + r.random() * 2.4)
        chunk(M, (x, s[1] * 0.55 - 0.12, zz), s, 'wall' if k != 1 else 'wallLight', r, (r.random() * 0.4, r.random() * 3, r.random() * 0.5), bevel=nb(0.07), n=10)
    if lod < 2:
        for i in range(4):                                          # fallen voussoirs: lighter wedge-shaped stones lying on the ground
            x = (a + 1.8 + r.uniform(0.3, 3.0)) * (1 if i % 2 else -1)
            zz = (1 if i < 2 else -1) * (RUT / 2 + 0.6 + r.random() * 1.2)
            chunk(M, (x, 0.2, zz), (0.62, 0.34, 0.5), 'wallLight', r, (0, r.random() * 3, r.random() * 0.25), bevel=nb(0.05), n=8, flat=0.5)
    return M


for _i in range(3):
    module('ruin', f'ruin{_i}', sub=(2.0, 3.5, 6.0), rays=(10, 4, 0), maxd=2.5)((lambda lod, i=_i: ruin(i + 1, lod)))


# ═════════════════════════════════════════════════ TRANSIT HALL ════════════════════════════════════════════════
# walk-through hall: length HL along x, width HWD along z, height HH; ground y = 0 (floor top 0.5); openings at both x ends
HL, HWD, HH, HT = 34.0, 20.0, 9.5, 1.5
HDW, HDH = 5.2, 6.6


def bez(p0, p1, p2, n):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) for t in [i / n for i in range(n + 1)]]


@module('hall', 'hall', lods=(0, 1, 2), sub=(3.0, 6.0, 10), rays=(10, 4, 0), maxd=4.0, passes=3)
def hall(lod):
    M = Mod(lod)
    d0 = lod == 0
    nb = lambda v: v if d0 else 0
    hw = HWD / 2
    L = HL; H = HH; T = HT
    # ── floor: dark base, light central lane of plates, door mats, base skirting, cable trench along the pillar lines
    M.box((0, -0.45, 0), (L + 2, 1.9, HWD + 2), 'deck', bevel=nb(0.15), seg=2)
    if lod < 2:
        for k in range(-4, 5):
            M.box((k * 4.0, 0.505, 0), (0.16, 0.02, HWD - 0.6), 'wallDark')
        for k in range(-4, 4):                                                         # central lane plates
            M.box((k * 4.0 + 2.0, 0.515, 0), (3.72, 0.03, 5.9), 'wallLight', bevel=nb(0.012), seg=1)
        for sz in (-1, 1):
            M.box((0, 0.51, sz * 3.2), (L - 0.6, 0.03, 0.2), 'trim')
            M.box((0, 0.512, sz * 4.6), (L - 0.6, 0.03, 0.34), 'wallDark')          # trench along the pillar line
            M.box((0, 0.78, sz * (hw - T - 0.14)), (L, 0.55, 0.28), 'wallDark', bevel=nb(0.05), seg=1)   # skirting
        for sx in (-1, 1):
            M.box((sx * (L / 2 + 1.7), 0.14, 0), (1.4, 0.26, 12.4), 'trim', bevel=nb(0.08), seg=1)
            M.box((sx * (L / 2 - 2.6), 0.512, 0), (4.4, 0.03, 10.0), 'wallDark')      # door mat
            M.box((sx * (L / 2 - 2.6), 0.52, 0), (0.22, 0.03, 10.0), 'accentDark')    # muted stripe across the threshold
    # ── long walls: lower band, upper band, piers between slit windows, frames, glass, pilasters, bands
    xs = [-L / 2 + 3.2 + 4.4 * k for k in range(7)]
    for sz in (-1, 1):
        zc = sz * (hw - T / 2)
        zi = sz * (hw - T)                                    # interior face
        M.box((0, 1.1, zc), (L, 4.2, T), 'wall', bevel=nb(0.12), seg=2)
        M.box((0, (7.2 + H) / 2, zc), (L, H - 7.2, T), 'wall', bevel=nb(0.12), seg=2)
        for a, b in zip([-L / 2] + [x + 0.9 for x in xs], [x - 0.9 for x in xs] + [L / 2]):
            M.box(((a + b) / 2, 5.2, zc), (b - a, 4.0, T), 'wall', bevel=nb(0.1), seg=1)
        for x in xs:
            M.box((x, 5.2, zc), (1.84, 4.04, 0.08), 'glass')
            if lod < 2:
                M.box((x, 7.28, zc + sz * (T / 2 + 0.05)), (2.3, 0.28, 0.3), 'trim', bevel=nb(0.05), seg=1)
                M.box((x, 3.12, zc + sz * (T / 2 + 0.07)), (2.3, 0.28, 0.4), 'trim', bevel=nb(0.05), seg=1)
                for sx2 in (-1, 1):
                    M.box((x + sx2 * 1.08, 5.2, zc + sz * (T / 2 + 0.04)), (0.26, 4.2, 0.24), 'trim', bevel=nb(0.05), seg=1)
                # interior: window surround and a raised wainscot panel with a dark inset under each window
                M.box((x, 7.26, zi - sz * 0.07), (2.4, 0.3, 0.2), 'trim', bevel=nb(0.04), seg=1)
                M.box((x, 3.14, zi - sz * 0.1), (2.4, 0.26, 0.26), 'trim', bevel=nb(0.04), seg=1)
                for sx2 in (-1, 1):
                    M.box((x + sx2 * 1.1, 5.2, zi - sz * 0.06), (0.22, 4.1, 0.16), 'trim', bevel=nb(0.04), seg=1)
                M.box((x, 1.95, zi - sz * 0.08), (3.3, 2.5, 0.16), 'wallLight', bevel=nb(0.05), seg=1)
                M.box((x, 1.95, zi - sz * 0.17), (2.8, 2.0, 0.08), 'wallDark', bevel=nb(0.03), seg=1)
                if d0:
                    M.box((x, 1.2, zi - sz * 0.22), (2.0, 0.08, 0.05), 'accentDark')
        if lod < 2:
            for k in range(8):
                M.box((-L / 2 + 1.0 + 4.4 * k, H / 2, zc + sz * 0.0), (0.9, H - 0.4, T + 0.5), 'wallLight', bevel=nb(0.16), seg=2)
            M.box((0, 2.2, zc), (L + 0.8, 0.6, T + 0.8), 'trim', bevel=nb(0.1), seg=1)
            M.box((0, H + 0.1, zc), (L + 1.0, 0.9, T + 1.0), 'trim', bevel=nb(0.15), seg=2)
            tube(M, (-L / 2 + 0.6, 8.3, zi - sz * 0.2), (L / 2 - 0.6, 8.3, zi - sz * 0.2), 0.08, 'metal', 8 if d0 else 5)   # conduit run
            for k in range(8):
                M.box((-L / 2 + 1.0 + 4.4 * k, 8.3, zi - sz * 0.22), (0.3, 0.3, 0.1), 'trim')
    # ── end walls with arched opening, stepped surround (both sides), orange lintel and pilasters
    r = 3.6
    for sx in (-1, 1):
        x0, x1 = (L / 2 - T, L / 2) if sx > 0 else (-L / 2, -L / 2 + T)
        door = [(-HDW, -1.0)] + arc(-HDW + r, HDH - r, r, math.pi, math.pi / 2, 8 if d0 else 4) + arc(HDW - r, HDH - r, r, math.pi / 2, 0, 8 if d0 else 4) + [(HDW, -1.0)]
        poly = [(-hw, -1.0)] + door + [(hw, -1.0), (hw, H + 0.6), (-hw, H + 0.6)]
        M.prism(poly, x0, x1, 'wall', 'zy', bevel=nb(0.12), seg=2)
        xo0, xo1 = (L / 2 - 0.1, L / 2 + 0.8) if sx > 0 else (-L / 2 - 0.8, -L / 2 + 0.1)
        if lod < 2:
            outer = [(-HDW - 1.1, -1.0)] + arc(-HDW - 1.1 + r + 1.1, HDH + 1.1 - r - 1.1, r + 1.1, math.pi, math.pi / 2, 8 if d0 else 4) + arc(HDW + 1.1 - r - 1.1, HDH + 1.1 - r - 1.1, r + 1.1, math.pi / 2, 0, 8 if d0 else 4) + [(HDW + 1.1, -1.0)]
            inner = door[::-1]
            M.prism(outer + inner, xo0, xo1, 'wallLight', 'zy', bevel=nb(0.12), seg=2)
            xi0, xi1 = (L / 2 - T - 0.7, L / 2 - T + 0.1) if sx > 0 else (-L / 2 + T - 0.1, -L / 2 + T + 0.7)
            M.prism(outer + inner, xi0, xi1, 'trim', 'zy', bevel=nb(0.1), seg=2)                    # inner surround
            xa = sx * (L / 2 + 0.55)
            M.box((xa, HDH + 1.5, 0), (0.7, 1.4, 2.4), 'accent', bevel=nb(0.12), seg=2)
            for sz in (-1, 1):
                M.box((sx * (L / 2 + 0.3), (H - 0.6) / 2, sz * (HDW + 2.6)), (0.9, H - 0.6, 1.4), 'trim', bevel=nb(0.15), seg=2)
                M.box((sx * (L / 2 + 0.3), (H - 0.6) / 2, sz * (hw - 0.8)), (0.9, H - 0.6, 1.4), 'trim', bevel=nb(0.15), seg=2)
                for k in range(2):
                    M.box((sx * (L / 2 + 0.25), 1.8 + k * 3.1, sz * ((HDW + hw - 0.8) / 2 + 0.1)), (0.5, 2.6, 2.6), 'accent', bevel=nb(0.14), seg=2)
                    if d0: M.box((sx * (L / 2 + 0.55), 1.8 + k * 3.1, sz * ((HDW + hw - 0.8) / 2 + 0.1)), (0.1, 1.5, 1.5), 'accentDark', bevel=0.03, seg=1)
                # string band on each side of the opening only (it used to run straight across the doorway)
                zb = (HDW + 1.1 + hw + 0.4) / 2
                M.box((sx * (L / 2 + 0.3), 3.0, sz * zb), (0.9, 0.5, hw + 0.4 - HDW - 1.1), 'trim', bevel=nb(0.08), seg=1)
    # ── roof slab, arched ribs under the roof, light troughs with soft glow strips, fluted pillars
    M.box((0, H + 0.55, 0), (L + 1.4, 1.1, HWD + 1.4), 'wallLight', bevel=nb(0.3), seg=2)
    if lod < 2:
        for k in range(6):
            x = -L / 2 + 3 + 6 * k
            hwi = hw - T
            top = bez((-hwi, H - 0.2), (0, H + 2.4), (hwi, H - 0.2), 10 if d0 else 5)
            bot = bez((hwi, H - 1.2), (0, H + 1.0), (-hwi, H - 1.2), 10 if d0 else 5)
            M.prism(top + bot, x - 0.4, x + 0.4, 'wall', 'zy', bevel=nb(0.08), seg=1)
            # lighter moulding along the lower edge of each rib
            bot2 = bez((hwi, H - 1.35), (0, H + 0.85), (-hwi, H - 1.35), 10 if d0 else 5)
            M.prism(bot + bot2[::-1], x - 0.52, x + 0.52, 'trim', 'zy', bevel=nb(0.04), seg=1)
        for k in range(5):                                                                               # dark coffers between the ribs
            M.box((-L / 2 + 6 + 6 * k, H - 0.03, 0), (4.9, 0.1, HWD - 2 * T - 1.0), 'wallDark')
        for sz in (-1, 1):
            M.box((0, H - 0.38, sz * 3.2), (L - 4, 0.14, 0.9), 'wallDark', bevel=nb(0.04), seg=1)       # trough housing
            M.box((0, H - 0.47, sz * 3.2), (L - 4.5, 0.05, 0.22), 'glow')                                  # soft strip, narrower than before
            for k in range(6):
                M.box((-L / 2 + 5 + k * 6, H - 0.4, sz * 3.2), (0.3, 0.18, 1.04), 'trim', bevel=nb(0.03), seg=1)   # brackets
        for k in range(5):
            x = -L / 2 + 6 + 6 * k
            for sz in (-1, 1):
                cz = sz * 4.6
                column(M, x, cz, [(H - 0.3, 0.8, 0.8), (H * 0.5, 0.86, 0.86), (0.5, 0.92, 0.92)], 'trim', flute=d0)
                M.box((x, 0.95, cz), (1.62, 0.9, 1.62), 'wallLight', bevel=nb(0.1), seg=1)             # plinth
                M.box((x, 1.5, cz), (1.36, 0.14, 1.36), 'trim', bevel=nb(0.04), seg=1)
                M.box((x, 4.4, cz), (1.5, 0.26, 1.5), 'wallLight', bevel=nb(0.07), seg=1)              # mid collar
                M.box((x, H - 0.55, cz), (1.62, 0.5, 1.62), 'wallLight', bevel=nb(0.08), seg=1)         # capital
                M.box((x, H - 0.95, cz), (1.36, 0.2, 1.36), 'trim', bevel=nb(0.04), seg=1)
                if d0:
                    for sd in (-1, 1):
                        flute_panel(M, x, cz, sd, 3.7, 2.0, 0.9, 0.9, 0.9, 0.9, 'accentDark', 0.02)   # muted orange inset in each fluting
    return M


# ═════════════════════════════════════════════════ GLB size reduction ══════════════════════════════════════════
def quantize_glb(path):
    """rewrite the GLB with compact vertex data: NORMAL int8 (normalized), COLOR_0 ubyte (normalized) -> KHR_mesh_quantization.
    ~35% smaller; the loader (assets.js) expands them back to float32 attributes."""
    import json, struct
    import numpy as np
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


# ═════════════════════════════════════════════════ driver ══════════════════════════════════════════════════════
def main(argv):
    global OUT
    for a in argv:
        if a.startswith('--out='): OUT = os.path.abspath(a[6:])
    groups = [a for a in argv if not a.startswith('-')]
    use_cache = '--nocache' not in argv     # groups not named on the command line are taken from the dev cache (if present)
    os.makedirs(CACHE, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.data.collections.new('structures'); bpy.context.scene.collection.children.link(col)
    total_t = time.time()
    for name, spec in MODULES.items():
        if groups and spec['group'] not in groups and not use_cache: continue
        path = os.path.join(CACHE, name + '.pkl')
        if groups and spec['group'] not in groups and use_cache:
            if not os.path.exists(path): continue
            data = pickle.load(open(path, 'rb'))
        else:
            print(name, flush=True)
            data = build_module(name, spec)
            pickle.dump(data, open(path, 'wb'))
        for lod, d in data.items():
            M = restore(d)
            emit(M, f'{name}_l{lod}', col)
            M.bm.free()
    tmp = OUT + '.tmp.glb'
    bpy.ops.export_scene.gltf(filepath=tmp, export_format='GLB', export_vertex_color='ACTIVE', export_yup=False, export_materials='NONE', export_apply=False)
    quantize_glb(tmp)
    os.replace(tmp, OUT)
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB', f'({time.time() - total_t:.0f}s)')


if __name__ == '__main__':
    main(sys.argv[1:])
