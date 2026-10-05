"""Blender (bpy) building generator, v2.

Every building is a small architectural grammar run inside bmesh: tier volumes with chamfered / octagonal / round footprints and
battered (tapered) walls, facade skins with real stepped recesses, slit windows, louvres, arched bays, orange slab fins, piers, bands,
galleries on truss brackets, door portals, silo / stair-tower / sky-bridge / arch / dome wings, crowns (tank, dish, ring, stack ...)
and modelled snow on every ledge and against the foot of the walls.  Three LODs per building (0 <120 m, 1 120-280 m, 2 far).
Surface structure (v2.1, no blank expanses): orange fins are stacks of 3.6-5 m modules (two columns when wide) with chamfered lips, raised inner plates and real
recessed bays; doors are double leaves (panels, vision slits, push bars, hinges, kick plates) with bracketed lamps; blank wall fields get ribs / vent banks /
pipe pairs / ladders, ground-floor bays get roll-up shutters, window bays get a two-step reveal and a sill; silos are stacked courses with flutes, collar bands,
a catwalk ring, ladder and access hatch.  Faces turned away from the approach (-z) and back faces use the cheaper LOD1 grammar even in LOD0 (size budget).

buildings.json schema (the same file drives placement, collision (computed `cols`) and the fallback in src/fallback_specs.js):
  building: id, x, z, seed, door ('x+'|'x-'|'z+'|'z-', the street side), door_style ('portal'), canopy (bool), roof (kind or list:
            tank|antenna|vents|dish|ring|stack), ring_r, tiers[], wings[]
  tier:     w, d, h, ox, oz (offset from the building centre), shape (box|chamfer|oct|round), ch (chamfer), taper (0..0.15 wall batter),
            style (grid|slab|vertical|industrial), skin (wall|wallDark|wallLight), windows, bay, gf, fh, grp, arcade, pipes, buttress,
            accent[{face,x,w,from,to}] (orange fins; x = offset along the face), gallery[{face,x,y,len,depth}], rings[y..] (ring
            galleries), abands[[y,h]..] (orange bands), base_snow
  wing:     silo{x,z,r,h,top}, chimney{x,z,r,h}, volume{x,z,y,w,d,h,+tier keys,legs[[dx,dz]..]}, bridge{from,to,w,h,enclosed,truss,
            piers}, pipe{pts,r}, mast{x,z,h,w0,w1}, dome{x,z,y,r,h,ribs}, arch{x,y,z,r,thick,depth}
Face u axis: x+ -> -z, x- -> +z, z+ -> +x, z- -> -x.

Post process: weld, adaptive vertex-AO (long edges are only cut where occlusion actually changes), edge-wear term, area-weighted
creased normals, and a hand written GLB writer (int16 positions / int8 normals / ubyte AO+wear, KHR_mesh_quantization) so the file
stays small.  src/arch_building.js expands the quantised attributes.  COLOR_0 = (baked AO, edge wear 0.5 neutral..1 convex, 0, 1).

Run:  python3 gen_buildings.py [id ...] [--lods=0,1]  ->  ../assets/buildings.glb  (+ assets/buildings.json with computed colliders,
      src/fallback_specs.js).  Ids/LODs not named are taken from the dev cache (<tmp>/eden_bcache) when present.
"""
import sys
sys.dont_write_bytecode = True
import bpy, bmesh, json, math, os, random, time, struct, pickle, tempfile
import numpy as np
from mathutils import Vector, Matrix, bvhtree

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('BLD_OUT') or os.path.join(HERE, '..', 'assets', 'buildings.glb')
SPEC_PATH = os.path.join(HERE, 'buildings.json')
CACHE = os.path.join(tempfile.gettempdir(), 'eden_bcache')      # dev cache (outside the repo); safe to delete
MATS = ['wall', 'wallLight', 'wallDark', 'trim', 'metal', 'accent', 'accentDark', 'glass', 'deck', 'snow']
MI = {m: i for i, m in enumerate(MATS)}
TAU = math.tau
UP = Vector((0, 1, 0))


def clamp(x, a, b): return a if x < a else b if x > b else x
def lerp(a, b, t): return a + (b - a) * t


# ═════════════════════════════════════════════════ polygon helpers ═════════════════════════════════════════════════
def footprint(w, d, shape='box', ch=0.0, n=24):
    """convex footprint polygon (x, z) centred on 0"""
    hw, hd = w / 2, d / 2
    if shape == 'round':
        return [(hw * math.cos(TAU * (i + 0.5) / n), hd * math.sin(TAU * (i + 0.5) / n)) for i in range(n)]
    if shape == 'oct':
        ch = min(w, d) * 0.29
        shape = 'chamfer'
    if shape == 'chamfer' and ch > 0.05:
        c = min(ch, hw - 1, hd - 1)
        return [(-hw + c, -hd), (hw - c, -hd), (hw, -hd + c), (hw, hd - c), (hw - c, hd), (-hw + c, hd), (-hw, hd - c), (-hw, -hd + c)]
    return [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]


def poly_centroid(P):
    return (sum(p[0] for p in P) / len(P), sum(p[1] for p in P) / len(P))


def edge_normal(P, i):
    a, b = P[i], P[(i + 1) % len(P)]
    dx, dz = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dz)
    n = (dz / L, -dx / L)
    cx, cz = poly_centroid(P)
    if n[0] * ((a[0] + b[0]) / 2 - cx) + n[1] * ((a[1] + b[1]) / 2 - cz) < 0: n = (-n[0], -n[1])
    return n, L


def offset_poly(P, d):
    """mitre offset of a convex polygon (d > 0 grows)"""
    n = len(P)
    out = []
    for i in range(n):
        n1, _ = edge_normal(P, (i - 1) % n)
        n2, _ = edge_normal(P, i)
        k = 1 + n1[0] * n2[0] + n1[1] * n2[1]
        out.append((P[i][0] + (n1[0] + n2[0]) / k * d, P[i][1] + (n1[1] + n2[1]) / k * d))
    return out


def face_name(n):
    if abs(n[0]) > 0.97: return 'x+' if n[0] > 0 else 'x-'
    if abs(n[1]) > 0.97: return 'z+' if n[1] > 0 else 'z-'
    return 'c'


def frame_matrix(o, n):
    """local (u along face, v up, n outward) -> building frame; u = up x n"""
    n = Vector((n[0], 0, n[1])).normalized()
    u = UP.cross(n).normalized()
    m = Matrix(((u.x, UP.x, n.x, o[0]), (u.y, UP.y, n.y, o[1]), (u.z, UP.z, n.z, o[2]), (0, 0, 0, 1)))
    return m


def uniq(vals, eps=2e-3):
    out = []
    for v in sorted(vals):
        if not out or v - out[-1] > eps: out.append(v)
    return out


# ═════════════════════════════════════════════════ modelling kernel ═════════════════════════════════════════════════
class Mod:
    """bmesh wrapper; y is up; face material = index into MATS"""
    def __init__(self):
        self.bm = bmesh.new()

    def poly(self, pts, mat, flip=False):
        bm = self.bm
        vs = [bm.verts.new(p) for p in (reversed(pts) if flip else pts)]
        try:
            f = bm.faces.new(vs)
        except ValueError:
            return None
        f.material_index = MI[mat]
        return f

    def _bevel(self, faces, width, seg, edges=None):
        """bevel the convex edges of `faces` (or an explicit edge list)"""
        if width <= 0: return
        if edges is None:
            edges = []
            seen = set()
            for f in faces:
                if not f.is_valid: continue
                for e in f.edges:
                    if e in seen: continue
                    seen.add(e)
                    if len(e.link_faces) == 2 and e.calc_face_angle(0) > 0.6: edges.append(e)
        edges = [e for e in edges if e.is_valid]
        if edges:
            try:
                bmesh.ops.bevel(self.bm, geom=edges, offset=width, offset_type='OFFSET', segments=seg, profile=0.5, affect='EDGES')
            except Exception:
                pass

    def box(self, c, s, mat, rot=None, bev=0.0, seg=2, skip=(), axes=None, basis=None):
        bm = self.bm
        v = bmesh.ops.create_cube(bm, size=1.0)['verts']
        bmesh.ops.scale(bm, vec=s, verts=v)
        faces = list(dict.fromkeys(f for x in v for f in x.link_faces))
        for f in faces: f.material_index = MI[mat]
        if skip:
            kill = []
            for f in faces:
                f.normal_update()
                for sk in skip:
                    ax = 'xyz'.index(sk[1])
                    if f.normal[ax] * (1 if sk[0] == '+' else -1) > 0.9: kill.append(f)
            keep = [f for f in faces if f not in kill]
            bmesh.ops.delete(bm, geom=kill, context='FACES')
            faces = keep
        bev_edges = None
        if bev > 0:
            bev_edges = []
            seen = set()
            for f in faces:
                for e in f.edges:
                    if e in seen: continue
                    seen.add(e)
                    if len(e.link_faces) != 2: continue
                    if axes:
                        dv = e.verts[0].co - e.verts[1].co
                        ax = max(range(3), key=lambda k: abs(dv[k]))
                        if 'xyz'[ax] not in axes: continue
                    bev_edges.append(e)
        verts = list(dict.fromkeys(x for f in faces for x in f.verts))
        if basis is not None:
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=basis, verts=verts)
        if rot:
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(rot[2], 3, 'Z') @ Matrix.Rotation(rot[1], 3, 'Y') @ Matrix.Rotation(rot[0], 3, 'X'), verts=verts)
        bmesh.ops.translate(bm, vec=c, verts=verts)
        if bev > 0: self._bevel(faces, min(bev, 0.42 * min(s)), seg, bev_edges)
        return faces

    def beam(self, a, b, w, h, mat, up=None, bev=0.0, seg=1, skip=()):
        """square-section member between two points (w across, h up-ish)"""
        a, b = Vector(a), Vector(b)
        d = b - a
        L = d.length
        if L < 1e-5: return
        x = d / L
        ref = Vector(up) if up is not None else (UP if abs(x.y) < 0.95 else Vector((1, 0, 0)))
        z = x.cross(ref).normalized()
        y = z.cross(x)
        m = Matrix(((x.x, y.x, z.x), (x.y, y.y, z.y), (x.z, y.z, z.z)))
        return self.box((a + b) / 2, (L, h, w), mat, bev=bev, seg=seg, skip=skip, basis=m)

    def loft(self, rings, mat, cap0=False, cap1=False, orient=1, up=UP, bev=0.0, seg=2, closed=True, smooth_caps=True):
        """rings: lists of equally long point lists; quads between consecutive rings, outward = orient (+1 out / -1 in)"""
        bm = self.bm
        vr = [[bm.verts.new(p) for p in ring] for ring in rings]
        n = len(rings[0])
        sides = []
        for k in range(len(rings) - 1):
            for i in range(n if closed else n - 1):
                j = (i + 1) % n
                try:
                    f = bm.faces.new((vr[k][i], vr[k][j], vr[k + 1][j], vr[k + 1][i]))
                except ValueError:
                    continue
                sides.append(f)
        caps = []
        if cap0:
            try: caps.append((0, bm.faces.new(vr[0])))
            except ValueError: pass
        if cap1:
            try: caps.append((1, bm.faces.new(list(reversed(vr[-1])))))
            except ValueError: pass
        if sides:
            cen = sum((Vector(p) for p in rings[0]), Vector()) / n
            f0 = sides[0]; f0.normal_update()
            rad = f0.calc_center_median() - cen
            rad -= up * rad.dot(up)
            if f0.normal.dot(rad) * orient < 0: bmesh.ops.reverse_faces(bm, faces=sides)
        for which, f in caps:
            f.normal_update()
            want = -1 if which == 0 else 1
            if f.normal.dot(up) * want < 0: bmesh.ops.reverse_faces(bm, faces=[f])
        allf = sides + [f for _, f in caps]
        for f in allf: f.material_index = MI[mat]
        if bev > 0: self._bevel(allf, bev, seg)
        return allf

    def prism(self, P, y0, y1, mat, top=True, bottom=False, bev=0.0, seg=2, orient=1):
        return self.loft([[(x, y0, z) for x, z in P], [(x, y1, z) for x, z in P]], mat, cap0=bottom, cap1=top, orient=orient, bev=bev, seg=seg)

    def frustum(self, c, rb, rt, h, mat, seg=20, axis='y', cap0=True, cap1=True, bev=0.0, rzs=1.0):
        """cylinder / cone: base radius rb, top radius rt (rzs squashes z)"""
        ring = lambda r, y: [(c[0] + r * math.cos(TAU * i / seg), y, c[2] + r * rzs * math.sin(TAU * i / seg)) for i in range(seg)]
        if axis == 'y':
            return self.loft([ring(rb, c[1] - h / 2), ring(rt, c[1] + h / 2)], mat, cap0=cap0, cap1=cap1, bev=bev)
        # horizontal axes: build vertical then rotate
        faces = self.loft([ring(rb, -h / 2), ring(rt, h / 2)], mat, cap0=cap0, cap1=cap1)
        verts = list(dict.fromkeys(v for f in faces for v in f.verts))
        for v in verts: v.co.x -= c[0]; v.co.z -= c[2]
        rot = Matrix.Rotation(math.pi / 2, 3, 'Z') if axis == 'x' else Matrix.Rotation(math.pi / 2, 3, 'X')
        bmesh.ops.rotate(self.bm, cent=(0, 0, 0), matrix=rot, verts=verts)
        bmesh.ops.translate(self.bm, vec=(c[0], c[1], c[2]), verts=verts)
        return faces

    def dome(self, c, r, mat, h=None, seg=24, rings=6, rzs=1.0):
        h = r * 0.55 if h is None else h
        rs = []
        for k in range(rings + 1):
            a = (k / rings) * math.pi / 2
            rs.append([(c[0] + r * math.cos(a) * math.cos(TAU * i / seg), c[1] + h * math.sin(a), c[2] + r * rzs * math.cos(a) * math.sin(TAU * i / seg)) for i in range(seg)])
        rs[-1] = [(c[0] + 1e-4 * math.cos(TAU * i / seg), c[1] + h, c[2] + 1e-4 * math.sin(TAU * i / seg)) for i in range(seg)]
        return self.loft(rs, mat, cap1=True)

    def ring_prism(self, Po, Pi, y0, y1, mat, top=True, bottom=False, bev=0.0):
        """hollow prism between two same-length polygons (outer and inner)"""
        bm = self.bm
        fs = []
        fs += self.loft([[(x, y0, z) for x, z in Po], [(x, y1, z) for x, z in Po]], mat, orient=1)
        fs += self.loft([[(x, y0, z) for x, z in Pi], [(x, y1, z) for x, z in Pi]], mat, orient=-1)
        n = len(Po)
        for (ya, flipv) in ((y1, True), (y0, False)):
            if (ya == y1 and not top) or (ya == y0 and not bottom): continue
            for i in range(n):
                j = (i + 1) % n
                f = self.poly([(Po[i][0], ya, Po[i][1]), (Po[j][0], ya, Po[j][1]), (Pi[j][0], ya, Pi[j][1]), (Pi[i][0], ya, Pi[i][1])], mat)
                if f is None: continue
                f.normal_update()
                if (f.normal.y > 0) != flipv: bmesh.ops.reverse_faces(bm, faces=[f])
                fs.append(f)
        if bev > 0: self._bevel(fs, bev, 1)
        return fs

    def merge(self, other, xf=None):
        bm = self.bm
        vm = {}
        for v in other.bm.verts:
            vm[v] = bm.verts.new(xf @ v.co if xf is not None else v.co)
        for f in other.bm.faces:
            try:
                nf = bm.faces.new([vm[v] for v in f.verts])
            except ValueError:
                continue
            nf.material_index = f.material_index
            nf.smooth = f.smooth

    def free(self):
        self.bm.free()


# ═════════════════════════════════════════════════ snow ═════════════════════════════════════════════════
def snow_pillow(M, cx, cy, cz, w, d, t, seed=1, nu=10, nv=10, p=2.6, lump=0.12, bury=0.7, rz=None):
    """smooth snow mound on a ledge: height t at the middle, rolling over the rim, buried skirt"""
    rnd = random.Random(seed)
    ph = [rnd.random() * 6 for _ in range(4)]
    bm = M.bm
    grid = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            u = i / nu * 2 - 1
            v = j / nv * 2 - 1
            m = max(0.0, 1 - (abs(u) ** p + abs(v) ** p) ** (1 / p))
            e = math.sqrt(m)
            n = 1 + lump * (math.sin(u * 2.3 + ph[0]) * math.cos(v * 2.1 + ph[1]) + 0.5 * math.sin(u * 5 + v * 3 + ph[2]))
            y = cy + t * e * n - (bury if m < 1e-4 else 0)
            row.append(bm.verts.new((cx + u * w / 2, y, cz + v * d / 2)))
        grid.append(row)
    fs = []
    for j in range(nv):
        for i in range(nu):
            f = bm.faces.new((grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]))
            f.normal_update()
            if f.normal.y < 0: bmesh.ops.reverse_faces(bm, faces=[f])
            f.material_index = MI['snow']
            fs.append(f)
    return fs


def snow_poly(M, P, y, t, seed=1, bury=0.7, rings=4, lump=0.1):
    """snow mound over a convex polygon: concentric rings shrinking to a rounded peak"""
    rnd = random.Random(seed)
    ph = [rnd.random() * 6 for _ in range(3)]
    cx, cz = poly_centroid(P)
    bm = M.bm
    rs = []
    for k in range(rings + 1):
        s = 1 - k / rings
        # k = 0: rim (buried), then the roll-over, then the crown
        e = math.sqrt(max(0.0, 1 - s * s)) if k > 0 else 0.0
        e = math.sin(min(1.0, k / rings) * math.pi / 2)
        ring = []
        for (x, z) in P:
            px, pz = cx + (x - cx) * s, cz + (z - cz) * s
            n = 1 + lump * math.sin(px * 0.35 + ph[0]) * math.cos(pz * 0.3 + ph[1])
            yy = y + t * e * n - (bury if k == 0 else 0)
            ring.append((px, yy, pz))
        rs.append(ring)
    # collapse the last ring to its centre so there is no open polygon on top
    rs[-1] = [(cx, y + t * (1 + lump * 0.3), cz) for _ in P]
    fs = M.loft(rs, 'snow', cap0=False, cap1=False, orient=1)
    return fs


# ═════════════════════════════════════════════════ facade skin ═════════════════════════════════════════════════
def rect_ring(u0, v0, u1, v1, ins, z):
    return [(u0 + ins, v0 + ins, z), (u1 - ins, v0 + ins, z), (u1 - ins, v1 - ins, z), (u0 + ins, v1 - ins, z)]


def arch_ring(u0, v0, u1, v1, ins, z, n=8):
    """arched opening: straight jambs up to the springline, semicircular head (crown at v1 - ins)"""
    r = (u1 - u0) / 2 - ins
    cx = (u0 + u1) / 2
    spring = v1 - (u1 - u0) / 2
    pts = [(cx - r, v0 + ins, z), (cx + r, v0 + ins, z)]
    for k in range(n + 1):
        a = math.pi * k / n
        pts.append((cx + r * math.cos(a), spring + r * math.sin(a), z))
    return pts


def recess(S, ft):
    """true stepped recess: nested rings at different depths, side quads between them, floor cap. returns the z=0 ring (verts)"""
    bm = S.bm
    mk = arch_ring if ft.get('arch') else rect_ring
    rings = [[bm.verts.new(p) for p in mk(ft['u0'], ft['v0'], ft['u1'], ft['v1'], ins, z)] for ins, z in ft['prof']]
    n = len(rings[0])
    for k in range(len(rings) - 1):
        mat = ft['mats'][k]
        for i in range(n):
            j = (i + 1) % n
            f = bm.faces.new((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]))
            f.material_index = MI[mat]
    f = bm.faces.new(rings[-1])
    f.material_index = MI[ft['floor']]
    return rings[0]


def tile_mesh(S, u0, u1, v0, v1, feats, mat='wall'):
    """one wall tile: a quad with the feature outlines as holes (scanfill), each hole closed by its recess"""
    bm = S.bm
    c = [bm.verts.new(p) for p in ((u0, v0, 0), (u1, v0, 0), (u1, v1, 0), (u0, v1, 0))]
    if not feats:
        f = bm.faces.new(c); f.material_index = MI[mat]
        return
    loops = [c]
    for ft in feats:
        loops.append(recess(S, ft))
    edges = []
    for lp in loops:
        for i in range(len(lp)):
            a, b = lp[i], lp[(i + 1) % len(lp)]
            e = bm.edges.get((a, b)) or bm.edges.new((a, b))
            edges.append(e)
    res = bmesh.ops.triangle_fill(bm, use_beauty=True, edges=edges, normal=(0, 0, 1))
    for g in res['geom']:
        if isinstance(g, bmesh.types.BMFace):
            g.material_index = MI[mat]
            g.normal_update()
            if g.normal.z < 0: bmesh.ops.reverse_faces(bm, faces=[g])


def facade_local(W, H, tiles, lod):
    """wall skin in the local face frame (u along the face centred on 0, v up, +z outward)"""
    S = Mod()
    for t in tiles:
        tile_mesh(S, t['u0'], t['u1'], t['v0'], t['v1'], t['feats'], t.get('mat', 'wall'))
    return S


ZN = Vector((0, 0, 1))


def ring_band(S, A, B, mat, mode, c):
    """quad strip between two equally long rings in a face-local frame (+z outward); mode 'up' faces +z, 'out' / 'in' face away from / towards the centre c"""
    bm = S.bm
    va = [bm.verts.new(p) for p in A]; vb = [bm.verts.new(p) for p in B]
    k = len(A)
    for i in range(k):
        j = (i + 1) % k
        try: f = bm.faces.new((va[i], va[j], vb[j], vb[i]))
        except ValueError: continue
        f.normal_update()
        if mode == 'up': want = ZN
        else:
            r = f.calc_center_median() - c
            r.z = 0.0
            want = r if mode == 'out' else -r
        if f.normal.dot(want) < 0: f.normal_flip()
        f.material_index = MI[mat]


def relief_rect(S, u0, v0, u1, v1, mat, depth, lod, bay=None, lip=0.14, base=-0.06, floor_mat=None, bay_inset=0.5, inner=None):
    """raised stepped plate on a face (local frame): vertical flank, chamfered lip, and optionally a real recessed bay with its own floor"""
    R = lambda ins, z: [(u0 + ins, v0 + ins, z), (u1 - ins, v0 + ins, z), (u1 - ins, v1 - ins, z), (u0 + ins, v1 - ins, z)]
    c = Vector(((u0 + u1) / 2, (v0 + v1) / 2, 0.0))
    if lod >= 1:
        S.loft([R(0, base), R(lip, depth)], mat, cap1=True, up=ZN)       # far LOD: one chamfer band + cap
        return
    if not bay:
        S.loft([R(0, base), R(0, depth * 0.72), R(lip, depth)], mat, cap1=True, up=ZN)
        if inner and lod == 0 and (u1 - u0) > 1.6 and (v1 - v0) > 1.6:      # raised second plate: a stepped, layered panel
            ii = lip + 0.42
            S.loft([R(ii, depth - 0.02), R(ii, depth + 0.12), R(ii + 0.1, depth + 0.2)], inner, cap1=True, up=ZN)
        return
    ring_band(S, R(0, base), R(0, depth * 0.72), mat, 'out', c)
    ring_band(S, R(0, depth * 0.72), R(lip, depth), mat, 'out', c)
    rim = R(lip + bay_inset, depth)
    ring_band(S, R(lip, depth), rim, mat, 'up', c)
    zf = depth * 0.42
    flo = R(lip + bay_inset + 0.16, zf)
    ring_band(S, rim, flo, mat, 'in', c)
    f = S.poly(flo, floor_mat or mat)
    if f:
        f.normal_update()
        if f.normal.z < 0: f.normal_flip()
    # inner plate floating in the bay with a dark moat around it: reads as a stepped, layered panel
    i2 = lip + bay_inset + 0.16 + 0.14
    if (u1 - u0) - 2 * i2 > 0.8 and (v1 - v0) - 2 * i2 > 0.8:
        S.loft([R(i2, zf - 0.02), R(i2, zf + 0.1), R(i2 + 0.09, zf + 0.17)], mat, cap1=True, up=ZN)


def fin_blocks(S, u, w, v0, v1, lod, rnd, depth=0.62, seg_h=8.0, gap=0.24, mat='accent', mat2='accentDark', inner=True, soft=False):
    """tall orange fin: one or two columns of stepped modules (3.4-5 m tall, seams every module, staggered between the columns),
    each with a chamfered lip and - on bigger modules - a real recessed bay with a darker floor; bolt pairs on the seams."""
    ncol = 2 if (w >= 5.0 and lod == 0) else 1
    cg = 0.28
    cw = (w - cg * (ncol - 1)) / ncol
    for ci in range(ncol):
        uc = u - w / 2 + cw / 2 + ci * (cw + cg)
        y = v0
        first = True
        while y < v1 - 1.0:
            mh = rnd.uniform(3.6, 5.0) * (1.6 if lod >= 1 else 1.0)
            if first and ci == 1: mh *= rnd.uniform(0.45, 0.75)       # stagger the seams between the columns
            first = False
            top = min(v1, y + mh)
            if v1 - top < 1.6: top = v1
            a, b = y + gap / 2, top - gap / 2
            m = mat2 if rnd.random() < 0.16 else mat
            d = depth * rnd.choice((0.8, 1.0, 1.15))
            bay = lod == 0 and (b - a) > 3.0 and cw > 3.1 and rnd.random() < 0.6
            relief_rect(S, uc - cw / 2, a, uc + cw / 2, b, m, d + 0.06, lod, bay=bay, lip=0.16 if lod == 0 else 0.1, floor_mat=(mat if m == mat2 else mat2), bay_inset=min(0.75, cw * 0.2),
                        inner=(mat if m == mat2 else mat2) if rnd.random() < 0.7 else m)
            y = top


def gallery_local(S, u0, u1, v, depth, lod, snow_seed=1, rail=True):
    """cantilever walkway on truss brackets in the local face frame"""
    L = u1 - u0
    um = (u0 + u1) / 2
    S.box((um, v - 0.18, depth / 2), (L, 0.36, depth), 'deck', bev=0.07, seg=1, skip=('-z',))
    S.box((um, v - 0.62, depth - 0.13), (L, 0.56, 0.26), 'trim', bev=0.06, seg=1)
    nb = max(2, int(L / 3.6) + 1)
    for k in range(nb):
        u = u0 + 0.6 + (L - 1.2) * k / (nb - 1)
        S.box((u, v - 1.5, 0.12), (0.8, 2.6, 0.24), 'wallDark', bev=0.04, seg=1, skip=('-z',))
        S.beam((u, v - 2.7, 0.18), (u, v - 0.7, depth - 0.22), 0.26, 0.34, 'metal', up=(1, 0, 0), bev=0.0)
        if lod == 0:
            S.beam((u, v - 0.7, depth - 0.2), (u, v - 1.6, depth - 0.2), 0.16, 0.2, 'metal', up=(1, 0, 0))
            S.beam((u, v - 0.5, 0.2), (u, v - 0.5, depth - 0.2), 0.16, 0.16, 'metal', up=(1, 0, 0))
    if rail and lod == 0:
        hr = 1.08
        npst = max(3, int(L / 1.5))
        for k in range(npst + 1):
            u = u0 + 0.12 + (L - 0.24) * k / npst
            S.box((u, v + hr / 2, depth - 0.14), (0.07, hr, 0.07), 'metal')
        S.box((um, v + hr, depth - 0.14), (L, 0.09, 0.1), 'trim', bev=0.025, seg=1)
        S.box((um, v + hr * 0.55, depth - 0.14), (L, 0.05, 0.05), 'metal')
        for sx in (u0 + 0.12, u1 - 0.12):
            S.box((sx, v + hr, depth / 2 - 0.1), (0.1, 0.09, depth - 0.3), 'trim')
            S.box((sx, v + hr * 0.5, depth / 2 - 0.1), (0.07, hr, 0.07), 'metal')
    if lod < 2:
        snow_pillow(S, um, v, depth / 2 - 0.05, L - 0.2, depth - 0.15, 0.34, seed=snow_seed, nu=max(4, int(L / 2)), nv=4, bury=0.12, lump=0.08)


def buttress_wedge(S, u, w, depth, h, mat='wallDark', bev=0.1):
    """sloped buttress: triangular profile (depth at the base, 0 at the top), extruded along u"""
    r0 = [(u - w / 2, 0.0, -0.05), (u - w / 2, 0.0, depth), (u - w / 2, h, -0.05)]
    r1 = [(u + w / 2, 0.0, -0.05), (u + w / 2, 0.0, depth), (u + w / 2, h, -0.05)]
    fs = S.loft([r0, r1], mat, cap0=True, cap1=True, up=Vector((1, 0, 0)))
    # lighter cap on the slope
    return fs


# ═════════════════════════════════════════════════ face planning ═════════════════════════════════════════════════
def F_panel(u0, v0, u1, v1, rich, big=False, floor='wallDark'):
    if rich:
        # two-step recess (frame lip, deep reveal, inner step): a real shadow-casting bay, not a flat dark rectangle
        prof = [(0, 0), (0.09, -0.07), (0.09, -0.4), (0.46, -0.4), (0.46, -0.72)] + ([(1.0, -0.72), (1.0, -0.98)] if big else [])
        mats = ['wallLight', 'wall', 'wall', 'wallDark'] + (['wallDark', 'wallDark'] if big else [])
    else:
        prof, mats = [(0, 0), (0, -0.36)], ['wall']
    return dict(u0=u0, v0=v0, u1=u1, v1=v1, prof=prof, mats=mats, floor=floor, kind='panel')


def F_slit(u0, v0, u1, v1, rich):
    if rich:
        prof = [(0, 0), (0.05, -0.05), (0.05, -0.42), (0.19, -0.42), (0.19, -0.95)]
        mats = ['wallLight', 'wall', 'wall', 'wallDark']
    else:
        prof, mats = [(0, 0), (0, -0.55)], ['wall']
    return dict(u0=u0, v0=v0, u1=u1, v1=v1, prof=prof, mats=mats, floor='glass', kind='slit')


def F_arch(u0, v0, u1, v1, rich, floor='wallDark'):
    f = F_panel(u0, v0, u1, v1, rich, False, floor)
    f['prof'] = [(0, 0), (0.1, -0.08), (0.1, -0.7)] if rich else [(0, 0), (0, -0.55)]
    f['mats'] = ['trim', 'wall'] if rich else ['wall']
    f['arch'] = True
    return f


def F_louver(u0, v0, u1, v1, rich):
    f = F_panel(u0, v0, u1, v1, rich)
    f['prof'] = [(0, 0), (0.07, -0.06), (0.07, -0.38)] if rich else [(0, 0), (0, -0.36)]
    f['mats'] = ['wallLight', 'wall'] if rich else ['wall']
    f['louver'] = rich
    return f


STYLES = {
    'grid': dict(bay=6.2, gf=6.6, fh=5.4, grp=2, wts={'panel': 0.46, 'slit': 0.09, 'louver': 0.05, 'ribbon': 0.04, 'inset': 0.09, 'plain': 0.14}, ground={'panel': 0.5, 'louver': 0.26, 'inset': 0.1, 'plain': 0.08, 'slit': 0.06}),
    'slab': dict(bay=9.0, gf=7.5, fh=6.0, grp=3, wts={'panel': 0.2, 'slit': 0.1, 'louver': 0.0, 'ribbon': 0.05, 'inset': 0.12, 'plain': 0.55}, ground={'panel': 0.5, 'louver': 0.2, 'inset': 0.12, 'plain': 0.14, 'slit': 0.04}),
    'vertical': dict(bay=4.4, gf=7.0, fh=5.6, grp=3, wts={'panel': 0.16, 'slit': 0.52, 'louver': 0.0, 'ribbon': 0.0, 'inset': 0.06, 'plain': 0.2}, ground={'panel': 0.45, 'louver': 0.2, 'inset': 0.1, 'plain': 0.1, 'slit': 0.15}),
    'industrial': dict(bay=8.2, gf=8.0, fh=6.4, grp=2, wts={'panel': 0.3, 'slit': 0.04, 'louver': 0.32, 'ribbon': 0.12, 'inset': 0.1, 'plain': 0.12}, ground={'panel': 0.3, 'louver': 0.5, 'inset': 0.1, 'plain': 0.06, 'slit': 0.04}),
}


def plan_face(W, H, t, rnd, detail, lod, vmin=0.0, door_u=None, narrow=False, fins=(), door_dims=(2.5, 6.4, 1.0)):
    """decide tiles (wall quads with recess holes), piers and bands for one facade (local frame)"""
    tiles = []
    if narrow:
        feats = []
        if W > 1.0 and H > 8:
            n = 1 if W < 3.0 else 2
            for k in range(n):
                uc = (k + 0.5) / n * W - W / 2
                feats.append(F_slit(uc - 0.34, vmin + 3.0, uc + 0.34, H - 3.4, lod == 0 and detail >= 0.9))
        tiles.append(dict(u0=-W / 2, u1=W / 2, v0=vmin, v1=H, feats=feats))
        return tiles, [], []
    st = STYLES.get(t.get('style', 'grid'), STYLES['grid'])
    m = t.get('margin', 1.7)
    bay = t.get('bay', st['bay'])
    nb = max(1, int(round((W - 2 * m) / bay)))
    bw = (W - 2 * m) / nb
    gf, fh, grp = t.get('gf', st['gf']), t.get('fh', st['fh']), t.get('grp', st['grp'])
    ytop = max(H - 3.8, vmin + gf + 2.0) if H > 14 else H - 0.9
    ys = [vmin, vmin + gf]
    y = vmin + gf
    while y + grp * fh <= ytop + 0.01:
        y += grp * fh
        ys.append(y)
    if ytop - ys[-1] > 2.8: ys.append(ytop)
    elif len(ys) > 2: ys[-1] = ytop
    else: ys.append(ytop)
    dhw, dhh, ddp = door_dims
    if door_u is not None:       # a tall (portal) door swallows the floor bands below its lintel
        while len(ys) > 2 and ys[1] < dhh + 1.4: ys.pop(1)
    if lod == 1:    # far detail: every second floor band only
        inner = ys[1:-1][::2]
        ys = [ys[0]] + inner + [ys[-1]]
    piers = [-W / 2 + m + j * bw for j in range(1, nb)]
    if lod == 1: piers = piers[::2] if nb > 2 else piers
    piers = [u for u in piers if not (door_u is not None and abs(u - door_u) < dhw + 0.7)]
    bands = ys[1:-1] + ([ys[-1]] if ys[-1] < H - 1.9 else [])
    # tile columns between piers (pier half width 0.5)
    cuts = [-W / 2] + [x for u in piers for x in (u - 0.5, u + 0.5)] + [W / 2]
    cols = [(cuts[2 * i], cuts[2 * i + 1]) for i in range(len(cuts) // 2)]
    win = t.get('windows', 0.1)
    wts = dict(st['wts']); wts['slit'] += win * 1.0; wts['ribbon'] += win * 0.6; wts['inset'] = t.get('inset', wts['inset'])
    wts_ground = dict(st['ground'])
    ybounds = [(ys[k] + (0.25 if k > 0 else 0), ys[k + 1] - 0.25) for k in range(len(ys) - 1)]
    # top frieze tile band (above ytop) merged into last group when H small
    prev = [None] * len(cols)
    for k, (v0, v1) in enumerate(ybounds):
        hh = v1 - v0
        for ci, (cu0, cu1) in enumerate(cols):
            feats = []
            uc = (cu0 + cu1) / 2
            cw = cu1 - cu0
            has_door = door_u is not None and k == 0 and cu0 < door_u < cu1
            if has_door:
                feats.append(dict(u0=door_u - dhw, u1=door_u + dhw, v0=vmin, v1=dhh, prof=[(0, 0), (0.14, -0.12), (0.14, -ddp)], mats=['trim', 'wall'], floor='wallDark', door=True))
                rich = lod == 0
                # flank panels
                for sgn in (-1, 1):
                    a0, a1 = (door_u + sgn * (dhw + 0.9), door_u + sgn * (cw / 2 - 0.7)) if sgn > 0 else (door_u - (cw / 2 - 0.7), door_u - (dhw + 0.9))
                    if abs(a1 - a0) > 2.0 and (v1 - v0) > 3:
                        feats.append(F_louver(min(a0, a1), v0 + 1.0, max(a0, a1), v1 - 0.7, lod == 0))
                tiles.append(dict(u0=cu0, u1=cu1, v0=vmin if k == 0 else v0, v1=v1, feats=feats))
                continue
            tab = wts_ground if k == 0 else wts
            kind = prev[ci] if (prev[ci] and rnd.random() < 0.5 and k > 0) else None
            if kind is None:
                tot = sum(tab.values()); r = rnd.random() * tot
                for kk, ww in tab.items():
                    r -= ww
                    if r <= 0: kind = kk; break
                kind = kind or 'panel'
            prev[ci] = kind
            if k == 0 and t.get('arcade') and cw >= 3.4 and not has_door:
                kind = 'arch'
            if lod >= 1 and kind in ('panel', 'louver', 'plain'):
                kind = 'ribbon' if rnd.random() < 0.11 else 'none'
            if hh >= 2.2 and cw >= 2.6:
                pu0, pu1, pv0, pv1 = cu0 + 0.62, cu1 - 0.62, v0 + 0.62, v1 - 0.62
                rich = lod == 0 and detail >= 0.85 and v0 < vmin + (10 if detail >= 0.95 else 8)
                big = (pu1 - pu0) * (pv1 - pv0) > 14 and rich
                pfl = 'wallDark' if v0 < vmin + 12 else 'wall'
                if kind == 'panel':
                    feats.append(F_panel(pu0, pv0, pu1, pv1, rich, big, floor=pfl))
                elif kind == 'arch':
                    aw = min(cw - 1.4, 5.2)
                    feats.append(F_arch(uc - aw / 2, v0 + 0.5, uc + aw / 2, min(v1 - 0.8, v0 + 0.5 + aw * 1.55), rich))
                elif kind == 'plain' and lod == 0 and detail >= 0.78:
                    feats.append(dict(u0=pu0 + 0.5, u1=pu1 - 0.5, v0=pv0 + 0.5, v1=pv1 - 0.5, prof=[(0, 0), (0.07, -0.05), (0.07, -0.13)] if rich else [(0, 0), (0, -0.12)], mats=['wallLight', 'wall'] if rich else ['wall'], floor='wall', kind='plain'))
                elif kind == 'inset':
                    feats.append(F_panel(pu0 + 0.3, pv0, pu1 - 0.3, pv1, rich, big, floor='accent' if rnd.random() < 0.7 else 'accentDark'))
                elif kind == 'louver':
                    feats.append(F_louver(pu0 + 0.2, pv0 + 0.4, pu1 - 0.2, pv1 - 0.6, rich))
                elif kind == 'slit':
                    ns = max(2, min(4, int(cw / 2.0)))
                    sp = (pu1 - pu0) / ns
                    for q in range(ns):
                        cu = pu0 + sp * (q + 0.5)
                        feats.append(F_slit(cu - 0.4, v0 + hh * 0.2, cu + 0.4, v1 - hh * 0.2, rich))
                elif kind == 'ribbon':
                    cv = (v0 + v1) / 2
                    feats.append(F_slit(pu0 + 0.2, cv - 0.65, pu1 - 0.2, cv + 0.65, rich))
            # drop features that sit under a fin
            feats = [f for f in feats if not any(f['u1'] > fn_['x'] - fn_['w'] / 2 - 0.5 and f['u0'] < fn_['x'] + fn_['w'] / 2 + 0.5 for fn_ in fins)]
            tiles.append(dict(u0=cu0, u1=cu1, v0=v0, v1=v1, feats=feats))
    # frieze: row of short slots under the cornice, one tile band
    top0 = ys[-1] + 0.25
    if top0 < H - 0.3:
        ff = []
        if H > 14 and detail >= 0.95 and lod == 0:
            n = max(3, int((W - 2 * m) / 2.2))
            for q in range(n):
                cu = -W / 2 + m + (q + 0.5) * (W - 2 * m) / n
                ff.append(dict(u0=cu - 0.42, u1=cu + 0.42, v0=H - 3.0, v1=H - 1.35, prof=[(0, 0), (0, -0.26)], mats=['wall'], floor='wallDark'))
            ff = [f for f in ff if not any(f['u1'] > fn_['x'] - fn_['w'] / 2 - 0.5 and f['u0'] < fn_['x'] + fn_['w'] / 2 + 0.5 for fn_ in fins)]
        tiles.append(dict(u0=-W / 2, u1=W / 2, v0=top0 - 0.0, v1=H, feats=ff))
    return tiles, piers, bands


def wave_strip(S, rings, mat, want):
    """quad strip over equally long open polylines, faces turned towards `want`"""
    bm = S.bm
    vr = [[bm.verts.new(p) for p in r] for r in rings]
    for k in range(len(rings) - 1):
        for i in range(len(rings[0]) - 1):
            try: f = bm.faces.new((vr[k][i], vr[k][i + 1], vr[k + 1][i + 1], vr[k + 1][i]))
            except ValueError: continue
            f.normal_update()
            if f.normal.dot(want) < 0: f.normal_flip()
            f.material_index = MI[mat]


def roll_shutter(S, ft):
    """ground-floor bay closed by a roll-up shutter: smooth horizontal corrugation, housing box, bottom bar with a hazard stripe and a lock"""
    zf = ft['prof'][-1][1]
    ins = ft['prof'][-1][0]
    u0, u1, v0, v1 = ft['u0'] + ins + 0.05, ft['u1'] - ins - 0.05, ft['v0'] + 0.3, ft['v1'] - ins - 0.3
    w = u1 - u0
    if w < 1.5 or v1 - v0 < 2.5: return
    uc = (u0 + u1) / 2
    per = 0.34
    n = max(6, int((v1 - v0) / per * 4))
    rings = [[(u, v0 + (v1 - v0) * k / n, zf + 0.06 + 0.07 * (0.5 + 0.5 * math.sin(TAU * (v1 - v0) * k / n / per - math.pi / 2))) for k in range(n + 1)] for u in (u0, u1)]
    wave_strip(S, rings, 'metal', Vector((0, 0, 1)))
    S.box((uc, v1 + 0.14, zf + 0.2), (w + 0.1, 0.4, 0.34), 'trim', skip=('-z',))
    S.box((uc, v0 - 0.1, zf + 0.12), (w, 0.3, 0.18), 'trim', skip=('-z',))
    S.box((uc, v0 + 0.55, zf + 0.2), (w * 0.8, 0.16, 0.05), 'accentDark')
    S.box((uc + w * 0.3, v0 + 1.1, zf + 0.22), (0.16, 0.34, 0.1), 'trim')


def plain_detail(S, ft, rnd):
    """structure for an otherwise blank wall field: vertical ribs with straps, a louvred vent bank, a pipe pair with clamps or a ladder"""
    u0, v0, u1, v1 = ft['u0'], ft['v0'], ft['u1'], ft['v1']
    w, h = u1 - u0, v1 - v0
    if w < 2.0 or h < 2.4: return
    z = -0.12
    uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
    r = rnd.random()
    if r < 0.34:                                         # ribbed field
        n = max(3, min(8, int(w / 1.25)))
        for k in range(n):
            u = u0 + 0.5 + (w - 1.0) * (k + 0.5) / n
            S.box((u, vc, z + 0.1), (0.22, h - 0.9, 0.24), 'wallLight', bev=0.05, seg=1, skip=('-z',))
        for vv in (v0 + 0.45, v1 - 0.45):
            S.box((uc, vv, z + 0.16), (w - 0.5, 0.24, 0.12), 'trim', bev=0.03, seg=1, skip=('-z',))
    elif r < 0.60 and h > 3.0:                           # vent bank
        vw, vh = min(w - 1.0, 3.2), min(h - 1.2, 1.9)
        S.box((uc, vc, z + 0.06), (vw + 0.4, vh + 0.4, 0.14), 'trim', bev=0.05, seg=1, skip=('-z',))
        S.box((uc, vc, z + 0.12), (vw, vh, 0.1), 'wallDark', skip=('-z',))
        ns = max(3, int(vh / 0.32))
        for q in range(ns):
            S.box((uc, vc - vh / 2 + (q + 0.5) * vh / ns, z + 0.2), (vw - 0.16, 0.1, 0.2), 'wallLight', rot=(-0.55, 0, 0))
    elif r < 0.86:                                       # pipe pair with clamps and a junction box
        for off in (-0.28, 0.28):
            tube(S, (uc + off, v0 + 0.4, z + 0.42), (uc + off, v1 - 0.6, z + 0.42), 0.15, 'metal', 6)
        for yy in range(int(v0 + 1.2), int(v1 - 0.8), 3):
            S.box((uc, yy, z + 0.4), (0.92, 0.3, 0.22), 'trim', skip=('-z',))
        S.box((uc, v1 - 0.45, z + 0.3), (1.0, 0.7, 0.4), 'wallDark', bev=0.06, seg=1, skip=('-z',))
    elif h > 4.6:                                        # ladder
        lu = u0 + w * 0.5
        for sx in (-0.26, 0.26): S.box((lu + sx, vc, z + 0.34), (0.07, h - 0.7, 0.07), 'metal', skip=('-z',))
        for k in range(int((h - 1.0) / 0.34)):
            S.box((lu, v0 + 0.55 + k * 0.34, z + 0.34), (0.52, 0.045, 0.045), 'metal')
        for sx in (-0.26, 0.26):
            for yy in (v0 + 0.5, vc, v1 - 0.5): S.box((lu + sx, yy, z + 0.2), (0.1, 0.12, 0.3), 'metal')


def door_leaves(S, hw, ytop, ybot, zb, lod, mat='metal', rib='wall', hazard='accentDark'):
    """two door leaves set into a recess: slab, raised panels, vision slit, push bars, kick plate, hinges, centre astragal and a sill plate"""
    lw = hw - 0.05
    hgt = ytop - ybot - 0.2
    yc = ybot + 0.12 + hgt / 2
    nrow = max(2, int(round(hgt / 3.0)))
    for sx in (-1, 1):
        uc = sx * hw / 2
        S.box((uc, yc, zb + 0.22), (lw, hgt, 0.44), mat, bev=0.06 if lod == 0 else 0, seg=1, skip=('-z',))
        if lod > 0: continue
        for q in range(nrow):
            a_ = ybot + 0.95 + (hgt - 1.2) * q / nrow
            b_ = ybot + 0.95 + (hgt - 1.2) * (q + 1) / nrow - 0.22
            if b_ - a_ > 0.5: S.box((uc, (a_ + b_) / 2, zb + 0.47), (lw - 0.55, b_ - a_, 0.1), rib, skip=('-z',))
        S.box((uc, ybot + 0.12 + hgt * 0.7, zb + 0.55), (0.3, min(1.1, hgt * 0.2), 0.06), 'glass')
        S.box((uc, ybot + 0.5, zb + 0.5), (lw - 0.25, 0.62, 0.06), hazard, skip=('-z',))
        tube(S, (sx * 0.42, ybot + 1.25, zb + 0.66), (sx * (0.42 + min(1.0, lw * 0.45)), ybot + 1.25, zb + 0.66), 0.05, 'trim', 6)
        for sx2 in (0.42, 0.42 + min(1.0, lw * 0.45)): S.box((sx * sx2, ybot + 1.25, zb + 0.56), (0.08, 0.08, 0.2), 'trim')
        for hy in (ybot + 1.0, ytop - 1.0): S.box((sx * (hw - 0.1), hy, zb + 0.48), (0.16, 0.42, 0.16), 'trim')
    S.box((0, yc, zb + 0.5), (0.14, hgt, 0.08), 'trim')
    S.box((0, ybot + 0.06, zb + 0.5), (hw * 2, 0.12, 0.8), 'deck', skip=('-z',))


def wall_lamp(S, u, v, lod, mat='accent'):
    """bracketed lamp: wall plate, arm, cylindrical housing and an orange lens (replaces the tiny cubes)"""
    S.box((u, v + 0.1, 0.1), (0.4, 0.8, 0.2), 'metal', bev=0.05 if lod == 0 else 0, seg=1, skip=('-z',))
    S.box((u, v + 0.28, 0.5), (0.14, 0.14, 0.7), 'metal')
    S.frustum((u, v + 0.28, 0.9), 0.3, 0.26, 0.62, 'trim', seg=10 if lod == 0 else 6)
    S.frustum((u, v + 0.28 - 0.38, 0.9), 0.22, 0.17, 0.2, mat, seg=10 if lod == 0 else 6)


def build_face(T, spec, t, ti, P, i, y0, H, lod, detail, vmin, door):
    """one polygon edge: skin + raised members (piers, bands, fins, door, gallery, buttress). T is the tier Mod (tier-centre frame)"""
    a, b = P[i], P[(i + 1) % len(P)]
    n, L = edge_normal(P, i)
    fn = face_name(n)
    mid = ((a[0] + b[0]) / 2, y0, (a[1] + b[1]) / 2)
    xf = frame_matrix(mid, n)
    rnd = random.Random(spec['seed'] * 977 + ti * 131 + i * 17)
    Hs = H
    S = Mod()
    narrow = L < 4.0
    is_door = door and fn == front_face(spec) and spec.get('door') == fn
    fins = [a_ for a_ in t.get('accent', []) if a_['face'] == fn and not narrow]
    portal = spec.get('door_style') == 'portal'
    canopy = spec.get('canopy', True)
    door_dims = (4.6, 12.5, 2.4) if portal else (2.5, 6.4, 1.0)
    tiles, piers, bands = plan_face(L, Hs, t, rnd, detail, lod, vmin, door_u=0.0 if is_door else None, narrow=narrow, fins=fins, door_dims=door_dims)
    skin_mat = t.get('skin', 'wall')
    for tl in tiles:
        m_ = skin_mat
        if lod < 2 and t.get('tonal', True) and not narrow:
            # painterly patchwork: a few wall blocks a shade darker / lighter (keyed on position so every LOD agrees)
            cu_, cv_ = int(((tl['u0'] + tl['u1']) / 2 + 200) // 7.0), int(((tl['v0'] + tl['v1']) / 2) // 8.0)
            r_ = random.Random((spec['seed'] * 73856093) ^ (i * 19349663) ^ (cu_ * 83492791) ^ (cv_ * 2654435761) ^ (ti * 40503)).random()
            if skin_mat == 'wall': m_ = 'wallDark' if r_ < 0.12 else ('wallLight' if r_ < 0.19 else 'wall')
            elif skin_mat == 'wallDark': m_ = 'wall' if r_ < 0.14 else 'wallDark'
        tl['mat'] = m_
    if lod < 2:
        skin = facade_local(L, Hs, tiles, lod)
        S.merge(skin)
        skin.free()
        if lod == 0:   # louver slats, sills under the window bays, structure on blank wall fields
            r2 = random.Random(spec['seed'] * 131 + ti * 17 + i * 7 + 5)
            for tl in tiles:
                for ft in tl['feats']:
                    if ft.get('louver'):
                        nsl = 5
                        for q in range(nsl):
                            vv = ft['v0'] + (q + 0.5) * (ft['v1'] - ft['v0']) / nsl
                            S.box(((ft['u0'] + ft['u1']) / 2, vv, -0.2), (ft['u1'] - ft['u0'] - 0.3, 0.1, 0.22), 'wallLight', rot=(-0.5, 0, 0))
                    elif ft.get('kind') == 'plain':
                        if detail >= 0.9 and r2.random() < 0.8: plain_detail(S, ft, r2)
                    elif ft.get('kind') == 'panel' and ft['v0'] < vmin + 1.6 and ft['v1'] - ft['v0'] >= 4.0 and ft['u1'] - ft['u0'] >= 3.0 and not ft.get('door') and len(ft['prof']) >= 5 and r2.random() < 0.75:
                        roll_shutter(S, ft)
                    elif ft.get('kind') in ('panel', 'slit') and ft['u1'] - ft['u0'] > 1.0 and ft['v0'] > vmin + 0.6 and not ft.get('door') and detail >= 0.9:
                        if ft['kind'] == 'slit' or r2.random() < 0.5:
                            S.box(((ft['u0'] + ft['u1']) / 2, ft['v0'] - 0.17, 0.2), (ft['u1'] - ft['u0'] + 0.5, 0.26, 0.46), 'trim', skip=('-z',))
    dep = 0.8
    if lod < 2 and not narrow and (lod == 0 or detail >= 0.9):
        for u in piers:
            S.box((u, (vmin + Hs - 0.9) / 2 + 0.2, dep / 2 - 0.1), (1.0, Hs - vmin - 1.1, dep), 'trim', bev=0.2 if lod == 0 else 0, seg=2 if detail >= 0.9 else 1, skip=('-z',), axes='y')
        for v in bands:
            band_prism(S, -L / 2, L / 2, v, 'trim', lod)
    if lod == 0 and not narrow and t.get('pipes') and detail >= 0.78:
        for q in range(t['pipes']):
            u = (piers[(q * 2 + 1) % len(piers)] + 0.0) if piers else (q + 1) * L / (t['pipes'] + 1) - L / 2
            if any(abs(u - f['x']) < f['w'] / 2 + 1.0 for f in fins) or (is_door and abs(u) < 5): continue
            ph = Hs - 4.5
            for off in (-0.3, 0.3):
                tube(S, (u + off, vmin + 0.3, 1.0), (u + off, ph, 1.0), 0.16, 'metal', 8)
            for yy in range(int(vmin + 3), int(ph), 6):
                S.box((u, yy, 0.98), (0.95, 0.34, 0.26), 'trim', skip=('-z',))
            S.box((u, ph + 0.35, 0.8), (1.0, 0.7, 0.5), 'wallDark', bev=0.06, seg=1, skip=('-z',))
    if lod == 0 and ti == 0 and fn == front_face(spec) and not narrow and detail >= 0.95:
        # cable tray along the ground floor (stand-off brackets at the piers, a drop into the door side) + door lamps
        cv = vmin + 3.4
        segs = [(-L / 2 + 1.6, -4.4 if is_door else L / 2 - 1.6)] + ([(4.4, L / 2 - 1.6)] if is_door else [])
        for (a_, b_) in segs:
            if b_ - a_ < 2: continue
            S.box(((a_ + b_) / 2, cv, 0.92), (b_ - a_, 0.2, 0.16), 'metal')
            S.box(((a_ + b_) / 2, cv - 0.26, 0.92), (b_ - a_, 0.07, 0.07), 'metal')
            for u in piers:
                if a_ < u < b_: S.box((u, cv - 0.05, 0.46), (0.12, 0.3, 0.92), 'metal')
        if is_door:
            for sx in (-1, 1): wall_lamp(S, sx * (door_dims[0] + 1.9), 5.2, lod)
    for f in fins:
        fin_blocks(S, f['x'], f['w'], f.get('from', vmin + 1.0), min(f.get('to', Hs - 1.2), Hs - 1.0), lod, rnd, depth=f.get('depth', 0.62), soft=detail >= 0.95)
    if is_door and lod < 2:
        dhw, dh, ddp = door_dims
        bev = 0.18 if lod == 0 else 0
        for sx in (-1, 1): S.box((sx * (dhw + 0.65), (vmin + dh) / 2 + 0.2, 0.3), (1.3, dh - vmin + 0.6, 1.0), 'trim', bev=bev, seg=2, skip=('-z',))
        S.box((0, dh + 0.5, 0.3), (dhw * 2 + 2.6, 1.0, 1.1), 'trim', bev=bev, seg=2, skip=('-z',))
        S.box((0, dh + 1.2, 0.35), (dhw * 2 + 2.2, 0.4, 1.0), 'accent', bev=0.08 if lod == 0 else 0, seg=1, skip=('-z',))
        if portal:
            # deep portal: two tall orange door leaves (ribbed, vision slits, push bars, hinges) set back in the recess + two tall inner pilasters
            door_leaves(S, dhw * 0.55, dh * 0.86, vmin, -ddp + 0.15, lod, mat='accent', rib='accentDark', hazard='wallDark')
            for sx in (-1, 1): S.box((sx * (dhw * 0.62), dh * 0.5, -ddp * 0.55), (0.9, dh - 0.4, 1.4), 'trim', bev=0.14 if lod == 0 else 0, seg=2, skip=('-z',))
        else:
            door_leaves(S, dhw, dh - 0.1, vmin, -ddp, lod)
            if canopy and lod == 0:
                S.box((0, dh + 2.5, 1.6), (6.6, 0.42, 3.2), 'deck', bev=0.1, seg=1, skip=('-z',))
                for sx in (-1, 1): S.beam((sx * 3.0, dh + 0.6, 0.3), (sx * 3.0, dh + 2.3, 3.0), 0.3, 0.4, 'metal', up=(1, 0, 0))
        for s_ in range(3):
            S.box((0, vmin - 0.4 + (0.18 * (s_ + 1)) / 2 - 0.4, 0.9 + (2 - s_) * 0.75 + 0.1), (dhw * 2 + 1.6 - s_ * 0.3, 0.8 + 0.2 * (s_ + 1), 1.5), 'trim' if s_ else 'wallLight', bev=0.05 if lod == 0 else 0, seg=1, skip=('-z',))
    for gi, g in enumerate(t.get('gallery', [])):
        if g['face'] != fn or lod == 2: continue
        gu = g.get('x', 0.0)
        gallery_local(S, gu - g['len'] / 2, gu + g['len'] / 2, g['y'], g.get('depth', 2.5), lod, snow_seed=ti * 7 + gi)
    nbut = t.get('buttress', 0)
    if nbut and ti == 0 and lod < 2 and not narrow and (fn == spec.get('door') or t.get('buttress_all')):
        for q in range(nbut):
            u = -L / 2 + 3.0 + (L - 6.0) * (q + 0.5) / nbut
            if is_door and abs(u) < 4.0: continue
            buttress_wedge(S, u, 1.6, 1.4, min(Hs * 0.3, 11.0))
    T.merge(S, xf)
    S.free()


# ═════════════════════════════════════════════════ round / lattice / industrial parts ═════════════════════════════════════════════════
def circle_pts(cx, cz, r, n, y, rz=None, a0=0.0):
    rz = r if rz is None else rz
    return [(cx + r * math.cos(a0 + TAU * i / n), y, cz + rz * math.sin(a0 + TAU * i / n)) for i in range(n)]


def fluted_ring(cx, cz, r, ribs, amp, y, w=0.2, a0=0.0):
    """ring of 4*ribs points: trapezoid bumps (vertical ribs) around a cylinder"""
    pts = []
    for k in range(ribs):
        a = a0 + TAU * k / ribs
        hw = TAU / ribs * w
        for da, rr in ((-hw * 1.5, r), (-hw * 0.6, r + amp), (hw * 0.6, r + amp), (hw * 1.5, r)):
            pts.append((cx + rr * math.cos(a + da), y, cz + rr * math.sin(a + da)))
    return pts


def foot_snow(M, cx, cz, r, lod, seed=1, h=1.0):
    """snow banked against a round footing (silo / chimney base)"""
    n = 22 if lod == 0 else 12
    rnd = random.Random(seed)
    ph = rnd.random() * 6
    rings = [[], [], [], [], []]
    for i in range(n):
        a = TAU * i / n
        f = 0.8 + 0.25 * math.sin(a * 2 + ph) + 0.1 * math.sin(a * 5 + ph * 2)
        e = 0.9 + 0.35 * math.sin(a * 3 + ph * 1.5)
        for k, (dr, hy) in enumerate(((0.25, h * f + 0.3), (1.0 + e * 0.2, h * f * 0.85), (2.0 + e * 0.35, h * f * 0.5), (3.2 + e * 0.5, h * f * 0.14), (4.5 + e * 0.7, -1.2))):
            rings[k].append((cx + (r + dr) * math.cos(a), hy, cz + (r + dr) * math.sin(a)))
    M.loft(rings, 'snow', orient=1)


def silo(M, cx, cz, r, h, lod, y0=0.0, top='dome', ribs=14, bands=2, mat='wallLight', accent_band=True, snow=True, seed=1):
    """industrial silo: fluted shaft built from stepped courses (every course a hair wider than the next, so the joints read), collar bands,
    accent band, access hatch, ladder, a catwalk ring with railing at mid height, cone / domed roof"""
    nr = min(ribs, 10) if lod == 0 else (8 if lod == 1 else 0)
    if lod == 2:
        M.frustum((cx, y0 + h / 2, cz), r, r * 0.97, h, mat, seg=10)
        M.frustum((cx, y0 + h + r * 0.15, cz), r * 0.98, 0.3, r * 0.35, 'trim', seg=10, cap0=False)
        if h > 8: M.loft([circle_pts(cx, cz, r + 0.3, 10, y0 + h * 0.6 - 1.0), circle_pts(cx, cz, r + 0.3, 10, y0 + h * 0.6 + 1.0)], 'accent', orient=1)
        return
    rnd = random.Random(seed * 7 + 3)
    if y0 < 1.0: foot_snow(M, cx, cz, r + 0.9, lod, seed)
    amp = 0.26 if lod == 0 else 0.14
    nco = max(2, int(round(h / 10.0))) if lod == 0 else 2
    ybs = [y0 + 0.4 + (h - 0.4) * k / nco for k in range(nco + 1)]
    rr = lambda k: r + (0.2 if k % 2 else 0.0)
    rings = [fluted_ring(cx, cz, rr(0), nr, amp, y0 - 3.0), fluted_ring(cx, cz, rr(0), nr, amp, ybs[0])]
    for k in range(1, nco):
        rings += [fluted_ring(cx, cz, rr(k - 1), nr, amp, ybs[k] - 0.02), fluted_ring(cx, cz, rr(k), nr, amp, ybs[k] + 0.16)]
    rings.append(fluted_ring(cx, cz, rr(nco - 1), nr, amp, y0 + h))
    M.loft(rings, mat, orient=1)
    # collar bands (the shaft is a loft: bands = slightly larger short frustums)
    nb = bands
    for k in range(nb + 1):
        yy = y0 + 1.2 + (h - 2.4) * k / max(1, nb)
        if lod == 1 and k not in (0, nb): continue
        M.loft([circle_pts(cx, cz, r + 0.74, 28 if lod == 0 else 20, yy - 0.28), circle_pts(cx, cz, r + 0.74, 28 if lod == 0 else 20, yy + 0.28)], 'metal' if k % 2 else 'trim', orient=1, bev=0.0)
    if accent_band and lod < 2:
        yy = y0 + h * 0.62
        M.loft([circle_pts(cx, cz, r + 0.64, 28 if lod == 0 else 20, yy - 1.0), circle_pts(cx, cz, r + 0.64, 28 if lod == 0 else 20, yy + 1.0)], 'accent', orient=1)
    # roof
    yt = y0 + h
    if top == 'cone':
        M.loft([circle_pts(cx, cz, r + 0.3, 24, yt), circle_pts(cx, cz, r * 0.62, 24, yt + r * 0.32), circle_pts(cx, cz, r * 0.28, 24, yt + r * 0.62), circle_pts(cx, cz, 0.12, 24, yt + r * 0.8)], 'trim', cap1=True, orient=1)
    else:
        rs = []
        for k in range(6):
            a = (k / 5) * math.pi / 2
            rs.append(circle_pts(cx, cz, max(0.12, (r + 0.3) * math.cos(a)), 24, yt + r * 0.42 * math.sin(a)))
        M.loft(rs, 'trim', cap1=True, orient=1)
    if lod == 0:
        # handrail ring + ladder with safety hoops
        M.loft([circle_pts(cx, cz, r + 0.55, 24, yt - 0.25), circle_pts(cx, cz, r + 0.55, 24, yt - 0.05)], 'deck', orient=1)
        M.loft([circle_pts(cx, cz, r + 0.55, 24, yt + 0.8), circle_pts(cx, cz, r + 0.55, 24, yt + 0.9)], 'trim', orient=1)
        a = 0.9
        lx, lz = cx + (r + 0.8) * math.cos(a), cz + (r + 0.8) * math.sin(a)
        rot_a = Matrix.Rotation(-a, 3, 'Y')
        for sg in (-0.28, 0.28):
            M.box((lx - math.sin(a) * sg, y0 + h / 2 + 0.4, lz + math.cos(a) * sg), (0.08, h - 1.0, 0.08), 'metal', basis=rot_a)
        for q in range(int((h - 1.0) / 1.0)):
            M.box((lx, y0 + 0.8 + q * 1.0, lz), (0.08, 0.06, 0.6), 'metal', basis=rot_a)
        # access hatch: frame, door leaf, wheel-less handle, lamp above
        ah = a + 2.35
        hx, hz = cx + (r + 0.36) * math.cos(ah), cz + (r + 0.36) * math.sin(ah)
        rot_h = Matrix.Rotation(-ah, 3, 'Y')
        M.box((hx, y0 + 2.0, hz), (0.5, 2.6, 1.7), 'trim', basis=rot_h, bev=0.1, seg=1)
        M.box((hx + math.cos(ah) * 0.2, y0 + 2.0, hz + math.sin(ah) * 0.2), (0.3, 2.1, 1.25), 'wallDark', basis=rot_h, bev=0.05, seg=1)
        M.box((hx + math.cos(ah) * 0.38, y0 + 1.9, hz + math.sin(ah) * 0.38 + 0.0), (0.12, 0.08, 0.5), 'trim', basis=rot_h)
        M.box((hx + math.cos(ah) * 0.38, y0 + 2.9, hz + math.sin(ah) * 0.38), (0.12, 0.34, 0.34), 'accent', basis=rot_h)
        # mid-height catwalk ring on brackets with posts and rail
        yc = y0 + h * 0.36
        pts = lambda rad: [(p[0], p[2]) for p in circle_pts(cx, cz, rad, 20, 0)]
        M.ring_prism(pts(r + 1.6), pts(r + 0.3), yc - 0.3, yc, 'deck')
        M.ring_prism(pts(r + 1.62), pts(r + 1.35), yc - 0.9, yc - 0.3, 'trim')
        for q in range(10):
            ang = TAU * q / 10
            px, pz = cx + (r + 1.5) * math.cos(ang), cz + (r + 1.5) * math.sin(ang)
            M.box((px, yc + 0.5, pz), (0.07, 1.0, 0.07), 'metal')
            M.beam((cx + (r + 0.2) * math.cos(ang), yc - 2.2, cz + (r + 0.2) * math.sin(ang)), (px, yc - 0.45, pz), 0.2, 0.26, 'metal', up=(0, 1, 0))
        M.ring_prism(pts(r + 1.55), pts(r + 1.45), yc + 0.96, yc + 1.06, 'trim')
    if snow and lod < 2:
        snow_poly(M, [(p[0], p[2]) for p in circle_pts(cx, cz, r * 0.78, 24, 0)], yt + r * 0.2, 0.35, seed=seed, bury=0.0, rings=3)


def torus(M, c, R, r, axis, mat, nmaj=40, nmin=10, ry=None, sq=0.0):
    """torus (major radius R, minor r) about the given axis through c; sq>0 squares the tube cross-section (superellipse-ish)"""
    ry = r if ry is None else ry
    rings = []
    for i in range(nmaj):
        a = TAU * i / nmaj
        ca, sa = math.cos(a), math.sin(a)
        ring = []
        for j in range(nmin):
            b = TAU * j / nmin
            cb, sb = math.cos(b), math.sin(b)
            if sq: cb, sb = math.copysign(abs(cb) ** (1 - sq), cb), math.copysign(abs(sb) ** (1 - sq), sb)
            rr = R + r * cb
            lo = (rr * ca, ry * sb, rr * sa)           # ring in the XZ plane, up = y
            if axis == 'x': p = (lo[1], lo[0], lo[2])
            elif axis == 'z': p = (lo[0], lo[2], lo[1])
            else: p = lo
            ring.append((c[0] + p[0], c[1] + p[1], c[2] + p[2]))
        rings.append(ring)
    rings.append(rings[0])
    return M.loft(rings, mat, orient=1, up=UP if axis == 'y' else Vector((0, 1, 0)))


def lattice_mast(M, cx, cz, y0, h, w0, w1, lod, mat='metal', nb=None, leg=0.17):
    """four-legged tapering lattice tower: corner legs, ring braces every other bay, X diagonals on every face"""
    nb = nb or max(3, int(h / 4.0))
    legs = [(sx, sz) for sx in (-1, 1) for sz in (-1, 1)]
    pt = lambda k, sx, sz: (cx + sx * (w0 + (w1 - w0) * k / nb) / 2, y0 + h * k / nb, cz + sz * (w0 + (w1 - w0) * k / nb) / 2)
    for sx, sz in legs:
        M.beam(pt(0, sx, sz), pt(nb, sx, sz), leg, leg, mat)
    if lod == 2: return
    sides = (((1, 1), (-1, 1)), ((-1, 1), (-1, -1)), ((-1, -1), (1, -1)), ((1, -1), (1, 1)))
    for k in range(0, nb + 1, 2 if lod == 0 else 3):
        for a, b in sides:
            M.beam(pt(k, *a), pt(k, *b), leg * 0.7, leg * 0.7, mat)
    if lod == 0:
        for k in range(nb):
            for si, (a, b) in enumerate(sides):
                if k % 2 == 0: M.beam(pt(k, *a), pt(k + 1, *b), leg * 0.55, leg * 0.55, mat)
                else: M.beam(pt(k, *b), pt(k + 1, *a), leg * 0.55, leg * 0.55, mat)


def dish(M, c, r, tilt, mat='trim', lod=0, yaw=0.0):
    """radar dish: concave bowl (opening +y before tilt) with a thick rim; tilted about z, then turned by yaw"""
    seg = 18 if lod == 0 else 10
    n = 4
    top, under = [], []
    for k in range(n + 1):
        t = k / n
        rr = max(r * (1 - t), 0.02)
        y = -0.34 * r * (1 - (1 - t) ** 2)
        top.append([(rr * math.cos(TAU * i / seg), y, rr * math.sin(TAU * i / seg)) for i in range(seg)])
        under.append([(rr * math.cos(TAU * i / seg), y - 0.14, rr * math.sin(TAU * i / seg)) for i in range(seg)])
    tmp = Mod()
    tmp.loft(top, mat, cap1=True, orient=-1)
    tmp.loft(under, mat, cap1=True, orient=1)
    tmp.loft([[(r * math.cos(TAU * i / seg), -0.14, r * math.sin(TAU * i / seg)) for i in range(seg)], [(r * math.cos(TAU * i / seg), 0.0, r * math.sin(TAU * i / seg)) for i in range(seg)]], mat, orient=1)
    xf = Matrix.Translation(c) @ Matrix.Rotation(yaw, 4, 'Y') @ Matrix.Rotation(tilt, 4, 'Z')
    M.merge(tmp, xf)
    tmp.free()


def rounded_outline(P, n=32, smooth=2):
    """resample a convex polygon to n points along its perimeter and round the corners (for snow caps)"""
    per = []
    L = 0.0
    segs = []
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        l = math.hypot(b[0] - a[0], b[1] - a[1])
        segs.append((L, l, a, b)); L += l
    pts = []
    for k in range(n):
        s = L * k / n
        for (s0, l, a, b) in segs:
            if s0 <= s < s0 + l + 1e-9:
                t = (s - s0) / l
                pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)); break
    for _ in range(smooth):
        pts = [((pts[i - 1][0] + 2 * pts[i][0] + pts[(i + 1) % n][0]) / 4, (pts[i - 1][1] + 2 * pts[i][1] + pts[(i + 1) % n][1]) / 4) for i in range(n)]
    return pts


def chimney(M, cx, cz, r, h, lod, y0=0.0, seed=1):
    """tapering industrial stack with collars, an orange warning band and a flared lip"""
    seg = 20 if lod == 0 else 10
    if y0 < 1.0 and lod < 2: foot_snow(M, cx, cz, r * 1.2, lod, seed, 0.8)
    secs = [(y0 - 3.0, r * 1.25), (y0 + 0.5, r * 1.18), (y0 + h * 0.55, r * 0.92), (y0 + h - 1.6, r * 0.78), (y0 + h - 0.5, r * 0.84), (y0 + h, r * 0.9)]
    if lod == 2: secs = [secs[0], secs[1], secs[3], secs[5]]
    M.loft([circle_pts(cx, cz, rr, seg, y) for y, rr in secs], 'wall', cap1=True, orient=1)
    if lod < 2:
        for k, f in enumerate((0.3, 0.55, 0.8)):
            yy = y0 + h * f
            rr = r * (1.18 - 0.4 * f) + 0.18
            M.loft([circle_pts(cx, cz, rr, seg, yy - 0.22), circle_pts(cx, cz, rr, seg, yy + 0.22)], 'trim', orient=1)
        yy = y0 + h - 3.2
        M.loft([circle_pts(cx, cz, r * 0.8 + 0.05, seg, yy - 0.8), circle_pts(cx, cz, r * 0.8 + 0.05, seg, yy + 0.8)], 'accent', orient=1)
    if lod == 0:
        a = 2.4
        M.box((cx + (r * 1.05) * math.cos(a), y0 + h * 0.5, cz + (r * 1.05) * math.sin(a)), (0.4, h - 2, 0.07), 'metal', basis=Matrix.Rotation(-a, 3, 'Y'))
        snow_poly(M, [(p[0], p[2]) for p in circle_pts(cx, cz, r * 0.55, 12, 0)], y0 + h + 0.05, 0.25, seed=seed, bury=0.0, rings=2)


def sky_bridge(M, p0, p1, w, h, lod, seed=1, enclosed=True, truss=True, piers=()):
    """horizontal bridge between two points (building frame). enclosed tube with ribbon windows + side trusses underneath"""
    a, b = Vector(p0), Vector(p1)
    d = b - a
    L = math.hypot(d.x, d.z)
    th = math.atan2(-d.z, d.x)
    mid = (a + b) / 2
    xf = Matrix.Translation(mid) @ Matrix.Rotation(th, 4, 'Y')
    S = Mod()
    rnd = random.Random(seed)
    y_floor = 0.0
    S.box((0, y_floor - 0.35, 0), (L + 0.4, 0.7, w + 0.5), 'deck', bev=0.1 if lod == 0 else 0, seg=1)
    if enclosed:
        top = h
        S.box((0, top + 0.3, 0), (L + 0.6, 0.6, w + 0.9), 'wall', bev=0.14 if lod == 0 else 0, seg=2)
        if lod < 2:
            # side walls with ribbon windows (tile skins), both sides
            for sgn in (-1, 1):
                nwin = max(2, int(L / 5.0))
                cw = (L - 1.0) / nwin
                feats = []
                for k in range(nwin):
                    u0 = -L / 2 + 0.5 + k * cw + 0.45
                    feats.append(F_slit(u0, 0.9, u0 + cw - 0.9, h - 0.55, lod == 0))
                tile = Mod()
                tile_mesh(tile, -L / 2, L / 2, 0.0, h, feats)
                if sgn > 0: m = Matrix(((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, w / 2), (0, 0, 0, 1)))
                else: m = Matrix(((-1, 0, 0, 0), (0, 1, 0, 0), (0, 0, -1, -w / 2), (0, 0, 0, 1)))
                S.merge(tile, m)
                tile.free()
                if lod == 0:   # window mullions
                    for k in range(nwin + 1):
                        uu = -L / 2 + 0.5 + k * cw
                        S.box((uu, h / 2, sgn * (w / 2 + 0.1)), (0.42, h, 0.3), 'trim', bev=0.06, seg=1)
            S.box((0, h / 2, 0), (L, h - 0.1, w - 0.9), 'wallDark')
            # snow on the roof
            snow_pillow(S, 0, top + 0.6, 0, L + 0.2, w + 0.7, 0.55, seed=seed, nu=max(6, int(L / 2.2)), nv=4, bury=0.3, lump=0.1)
        else:
            S.box((0, h / 2, 0), (L, h, w), 'wall')
    else:
        for sgn in (-1, 1):
            S.box((0, 0.55, sgn * (w / 2 + 0.05)), (L, 0.1, 0.1), 'trim')
    # trusses under the deck: bottom chord + verticals + diagonals, both sides
    if truss and lod < 2:
        depth = min(2.6, 0.12 * L + 0.8)
        nb = max(2, int(L / 3.0))
        step = L / nb
        for sgn in (-1, 1):
            z = sgn * (w / 2 + 0.2)
            S.beam((-L / 2, -depth, z), (L / 2, -depth, z), 0.34, 0.34, 'metal', up=(0, 0, 1))
            if lod == 0:
                S.beam((-L / 2, -0.7, z), (L / 2, -0.7, z), 0.3, 0.3, 'metal', up=(0, 0, 1))
            for k in range(nb + 1):
                x = -L / 2 + step * k
                if lod == 0 or k % 2 == 0:
                    S.beam((x, -depth, z), (x, -0.7, z), 0.26, 0.26, 'metal', up=(0, 0, 1))
                if k < nb:
                    x2 = x + step
                    if k % 2 == 0: S.beam((x, -0.7, z), (x2, -depth, z), 0.24, 0.24, 'metal', up=(0, 0, 1))
                    else: S.beam((x, -depth, z), (x2, -0.7, z), 0.24, 0.24, 'metal', up=(0, 0, 1))
    for pu in piers:   # mid-span support pylons down to the ground
        gh = mid.y + 3.2
        S.box((pu, -(gh + 0.7) / 2, 0), (2.2, gh - 0.7, w * 0.7), 'wallDark', bev=0.2 if lod == 0 else 0, seg=2)
        S.box((pu, -0.9, 0), (3.2, 0.8, w + 0.9), 'trim', bev=0.1 if lod == 0 else 0, seg=1)
    M.merge(S, xf)
    S.free()


def roof_gear(M, spec, lod, kind, cx, cz, y, w, d, seed=1):
    """equipment on a roof; (cx, cz, y) = centre of the roof surface, w/d the usable footprint"""
    rnd = random.Random(seed)
    fr = front_face(spec)
    yaw = {'x+': 0.0, 'x-': math.pi, 'z+': -math.pi / 2, 'z-': math.pi / 2}[fr]
    if kind == 'tank':
        x, z = cx + (rnd.random() - 0.5) * w * 0.25, cz + (rnd.random() - 0.5) * d * 0.25
        if lod < 2:
            for sx in (-1, 1):
                for sz in (-1, 1):
                    M.box((x + sx * 1.7, y + 1.2, z + sz * 1.7), (0.4, 2.5, 0.4), 'metal', bev=0.08 if lod == 0 else 0, seg=1)
            if lod == 0:
                for sx in (-1, 1): M.beam((x + sx * 1.7, y + 0.4, z - 1.7), (x + sx * 1.7, y + 2.2, z + 1.7), 0.14, 0.14, 'metal')
        silo(M, x, z, 2.6, 3.6, lod, y0=y + 2.3, top='dome', ribs=10, bands=1, accent_band=True, snow=True, seed=seed)
    elif kind == 'antenna':
        x, z = cx + (rnd.random() - 0.5) * w * 0.3, cz + (rnd.random() - 0.5) * d * 0.3
        lattice_mast(M, x, z, y, 15.0, 2.4, 0.5, lod)
        if lod < 2:
            M.box((x, y + 7.6, z), (3.4, 0.28, 3.4), 'deck', bev=0.05, seg=1)
            if lod == 0:
                for q in range(4): M.box((x + 1.62 * (1 if q < 2 else -1), y + 8.2, z + 1.62 * (1 if q % 2 else -1)), (0.06, 1.0, 0.06), 'metal')
            dish(M, (x + 0.0, y + 9.4, z), 1.5, -0.7, 'trim', lod, yaw)
            M.frustum((x, y + 15.6, z), 0.22, 0.05, 1.3, 'metal', seg=8)
            M.frustum((x, y + 16.3, z), 0.18, 0.18, 0.36, 'accent', seg=8)
        M.box((x + 4.2, y + 1.1, z + 1.2), (3.6, 2.2, 3.0), 'wall', bev=0.18 if lod == 0 else 0, seg=2)
        if lod < 2: snow_pillow(M, x + 4.2, y + 2.2, z + 1.2, 3.8, 3.2, 0.4, seed=seed, nu=5, nv=5, bury=0.2)
    elif kind == 'dish':
        x, z = cx, cz
        M.box((x, y + 2.0, z), (4.2, 4.0, 4.2), 'wallDark', bev=0.2 if lod == 0 else 0, seg=2)
        M.frustum((x, y + 4.4, z), 1.5, 1.1, 0.8, 'trim', seg=16)
        dish(M, (x, y + 6.0, z), 4.2, -0.75, 'trim', lod, yaw)
        M.beam((x, y + 4.6, z), (x, y + 6.3, z), 0.5, 0.5, 'metal')
        if lod < 2: M.box((x + 4.2, y + 1.0, z), (3.0, 2.0, 3.0), 'wall', bev=0.14 if lod == 0 else 0, seg=1)
    elif kind == 'ring':
        axis = 'x' if fr[0] == 'x' else 'z'
        R = spec.get('ring_r', max(5.0, min(w, d) * 0.36))
        torus(M, (cx, y + R + 2.4, cz), R, 0.75, axis, 'trim', nmaj=44 if lod == 0 else 24, nmin=10 if lod == 0 else 6, ry=0.95, sq=0.35)
        if lod < 2:
            for k in range(6):
                a = k * TAU / 6 + 0.3
                px, py = R * math.cos(a), R * math.sin(a)
                if axis == 'x': pos = (cx, y + R + 2.4 + py, cz + px); basis = Matrix.Rotation(a, 3, 'X') if True else None
                else: pos = (cx + px, y + R + 2.4 + py, cz); basis = Matrix.Rotation(-a, 3, 'Z')
                if k % 2 == 0:
                    M.box(pos, (1.6, 1.9, 2.8) if axis == 'x' else (2.8, 1.9, 1.6), 'accent', bev=0.1 if lod == 0 else 0, seg=1, basis=Matrix.Rotation((a if axis == 'x' else -a), 3, 'X' if axis == 'x' else 'Z') if True else None)
            for sx in (-1, 1):
                if axis == 'x': M.beam((cx, y, cz + sx * R * 0.7), (cx, y + R + 1.8, cz + sx * R * 0.9), 0.9, 0.9, 'wallDark', up=(1, 0, 0), bev=0.1 if lod == 0 else 0)
                else: M.beam((cx + sx * R * 0.7, y, cz), (cx + sx * R * 0.9, y + R + 1.8, cz), 0.9, 0.9, 'wallDark', up=(0, 0, 1), bev=0.1 if lod == 0 else 0)
    elif kind == 'stack':
        for k, (dx, dz, rr, hh) in enumerate(((-w * 0.18, -d * 0.1, 1.3, 20.0), (w * 0.05, d * 0.15, 1.05, 15.0), (w * 0.22, -d * 0.14, 0.9, 11.0))):
            chimney(M, cx + dx, cz + dz, rr, hh, lod, y0=y, seed=seed + k)
        if lod < 2:
            M.box((cx, y + 1.4, cz), (w * 0.34, 2.8, d * 0.2), 'wall', bev=0.18 if lod == 0 else 0, seg=2)
    else:  # vents
        for k in range(3):
            vx, vz = cx + (rnd.random() - 0.5) * w * 0.55, cz + (rnd.random() - 0.5) * d * 0.55
            hh = 2.2 + rnd.random() * 1.2
            M.frustum((vx, y + hh / 2, vz), 0.7, 0.62, hh, 'metal', seg=16 if lod == 0 else 8)
            if lod < 2: M.frustum((vx, y + hh + 0.25, vz), 1.1, 0.3, 0.5, 'wallLight', seg=16 if lod == 0 else 8)
        M.box((cx + w * 0.18, y + 1.4, cz - d * 0.2), (4.4, 2.8, 3.6), 'wall', bev=0.2 if lod == 0 else 0, seg=2)
        if lod < 2: snow_pillow(M, cx + w * 0.18, y + 2.8, cz - d * 0.2, 4.6, 3.8, 0.4, seed=seed, nu=5, nv=5, bury=0.2)


def overhang_supports(M, spec, ti, lod):
    """truss corbels under a tier that overhangs the one below"""
    tiers = spec['tiers']
    if ti == 0 or lod == 2: return
    t, lo = tiers[ti], tiers[ti - 1]
    y0 = sum(tt['h'] for tt in tiers[:ti])
    lt = lo.get('taper', 0.0)
    lw = lo['w'] * (1 - lt) / 2; ld = lo['d'] * (1 - lt) / 2
    lx0, lx1 = lo.get('ox', 0) - lw, lo.get('ox', 0) + lw
    lz0, lz1 = lo.get('oz', 0) - ld, lo.get('oz', 0) + ld
    tx0, tx1 = t.get('ox', 0) - t['w'] / 2, t.get('ox', 0) + t['w'] / 2
    tz0, tz1 = t.get('oz', 0) - t['d'] / 2, t.get('oz', 0) + t['d'] / 2
    for side, ov in (('x+', tx1 - lx1), ('x-', lx0 - tx0), ('z+', tz1 - lz1), ('z-', lz0 - tz0)):
        if ov < 1.2: continue
        horiz = side[0] == 'x'
        lo_edge = {'x+': lx1, 'x-': lx0, 'z+': lz1, 'z-': lz0}[side]
        sg = 1 if side[1] == '+' else -1
        if horiz: a0, a1 = max(tz0, lz0) + 2.0, min(tz1, lz1) - 2.0
        else: a0, a1 = max(tx0, lx0) + 2.0, min(tx1, lx1) - 2.0
        n = max(2, int((a1 - a0) / 5.0) + 1)
        dep = min(ov + 0.2, 7.0)
        for k in range(n):
            u = a0 + (a1 - a0) * k / (n - 1) if n > 1 else (a0 + a1) / 2
            # diagonal strut from the lower wall up to the overhang front
            if horiz:
                p_lo = (lo_edge, y0 - dep * 0.9, u); p_hi = (lo_edge + sg * ov, y0 - 0.5, u)
                M.beam(p_lo, p_hi, 0.7, 0.7, 'wallDark', up=(0, 0, 1), bev=0.12 if lod == 0 else 0, seg=1)
                M.box((lo_edge + sg * 0.2, y0 - dep * 0.9, u), (0.8, 1.0, 1.4), 'trim', bev=0.08 if lod == 0 else 0, seg=1)
                if lod == 0: M.beam((lo_edge, y0 - 0.8, u), (lo_edge + sg * ov * 0.55, y0 - 0.8, u), 0.4, 0.4, 'metal', up=(0, 0, 1))
            else:
                p_lo = (u, y0 - dep * 0.9, lo_edge); p_hi = (u, y0 - 0.5, lo_edge + sg * ov)
                M.beam(p_lo, p_hi, 0.7, 0.7, 'wallDark', up=(1, 0, 0), bev=0.12 if lod == 0 else 0, seg=1)
                M.box((u, y0 - dep * 0.9, lo_edge + sg * 0.2), (1.4, 1.0, 0.8), 'trim', bev=0.08 if lod == 0 else 0, seg=1)
                if lod == 0: M.beam((u, y0 - 0.8, lo_edge), (u, y0 - 0.8, lo_edge + sg * ov * 0.55), 0.4, 0.4, 'metal', up=(1, 0, 0))


def tube(M, a, b, r, mat, seg=10, caps=True):
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    if L < 1e-5: return
    x = d / L
    ref = UP if abs(x.y) < 0.95 else Vector((1, 0, 0))
    y = ref.cross(x).normalized(); z = x.cross(y)
    ring = lambda p: [tuple(p + y * (r * math.cos(TAU * i / seg)) + z * (r * math.sin(TAU * i / seg))) for i in range(seg)]
    return M.loft([ring(a), ring(b)], mat, cap0=caps, cap1=caps, up=x, orient=1)


def pipe_run(M, pts, r, lod, mat='trim', flange_mat='metal', supports=True):
    seg = 12 if lod == 0 else 8
    for i in range(len(pts) - 1):
        tube(M, pts[i], pts[i + 1], r, mat, seg)
        if lod == 0:
            a, b = Vector(pts[i]), Vector(pts[i + 1])
            d = (b - a).normalized()
            for t_ in (0.12, 0.88):
                c = a + (b - a) * t_
                tube(M, c - d * 0.2, c + d * 0.2, r * 1.28, flange_mat, seg)
    if lod == 0:
        for p in pts[1:-1]:
            M.box(p, (r * 2.6, r * 2.6, r * 2.6), flange_mat, bev=r * 0.4, seg=1)


# ═════════════════════════════════════════════════ tiers, wings & building ═════════════════════════════════════════════════
def front_face(spec):
    return spec.get('door') or ('x+' if spec['x'] < 0 else 'x-')


def face_detail(spec, fn, ti, n=None):
    fr = front_face(spec)
    opp = {'x+': 'x-', 'x-': 'x+', 'z+': 'z-', 'z-': 'z+'}[fr]
    d = 1.0 if fn == fr else 0.5 if fn == opp else (0.95 if (n is not None and n[1] > 0.2) else 0.6) if fn == 'c' else (0.9 if fn == 'z+' else 0.78)      # chamfer faces that look towards the approach carry full detail
    return d * (1.0 if ti == 0 else 0.92)


def roof_snow(T, P, shape, top, thick, seed, lod, bury=0.9):
    if lod == 2: return
    if shape in ('box',) and len(P) == 4:
        w = P[1][0] - P[0][0]; d = P[2][1] - P[1][1]
        gs = 2.2 if lod == 0 else 4.2           # far LOD: coarser snow grid (4x fewer quads on every roof)
        snow_pillow(T, poly_centroid(P)[0], top, poly_centroid(P)[1], w - 1.6, d - 1.6, thick, seed=seed, nu=max(6 if lod == 0 else 4, int(w / gs)), nv=max(6 if lod == 0 else 4, int(d / gs)), bury=bury, lump=0.1)
    else:
        n = 20 if lod == 0 else 16
        snow_poly(T, rounded_outline(offset_poly(P, -0.7), n, 2), top, thick, seed=seed, bury=bury, rings=3)


CORNICE0 = [(0.0, -2.0), (0.5, -1.92), (0.5, -1.3), (0.95, -1.24), (0.95, -0.5), (0.58, -0.36), (0.46, -0.2), (0.46, 1.0), (0.64, 1.08), (0.64, 1.32), (0.3, 1.4), (-0.45, 1.4), (-0.45, 0.0)]
CORNICE1 = [(0.0, -1.3), (0.75, -1.1), (0.55, 1.1), (-0.4, 1.2)]


def profile_loft(M, P, prof, y_base, mat, orient=1):
    """sweep a (offset, height) profile around a convex footprint: cornices, mouldings, plinths"""
    rings = [[(x, y_base + dy, z) for x, z in offset_poly(P, d)] for d, dy in prof]
    return M.loft(rings, mat, orient=orient)


def band_prism(S, u0, u1, v, mat='trim', lod=0, depth=0.46, half=0.27):
    """chamfered horizontal band along a face (local frame)"""
    a = [(u0, v - half, 0.0), (u0, v - half * 0.5, depth), (u0, v + half * 0.5, depth), (u0, v + half, 0.0)]
    b = [(u1, y, z) for (_, y, z) in a]
    return S.loft([a, b], mat, cap0=lod == 0, cap1=lod == 0, up=Vector((1, 0, 0)), closed=False)


def base_snow(T, P, spec, door, lod, seed, thick=1.7):
    """wind-blown snow bank piled against the foot of a ground volume (lower in front of the door)"""
    n = 44 if lod == 0 else 16
    pts = rounded_outline(P, n, 0)
    rnd = random.Random(seed)
    ph = [rnd.random() * 6 for _ in range(3)]
    cx, cz = poly_centroid(P)
    dc = None
    if door and spec.get('door'):
        for i in range(len(P)):
            nn, L = edge_normal(P, i)
            if face_name(nn) == spec['door']:
                a, b = P[i], P[(i + 1) % len(P)]; dc = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); break
    rings = [[], [], [], [], []]
    for k, (x, z) in enumerate(pts):
        t = k / len(pts)
        f = 0.8 + 0.2 * math.sin(t * TAU * 3 + ph[0]) + 0.1 * math.sin(t * TAU * 7 + ph[1])
        g = 1.0
        if dc is not None: g = clamp(math.hypot(x - dc[0], z - dc[1]) / 8.0 - 0.4, 0.0, 1.0)
        h = thick * f * g
        dx, dz = x - cx, z - cz
        ln = math.hypot(dx, dz) or 1.0
        ox, oz = dx / ln, dz / ln
        e = 0.8 + 0.5 * math.sin(t * TAU * 4 + ph[2])
        rings[0].append((x + ox * 0.3, h + 0.3, z + oz * 0.3))
        rings[1].append((x + ox * (1.0 + e * 0.3), h * 0.86, z + oz * (1.0 + e * 0.3)))
        rings[2].append((x + ox * (2.0 + e * 0.45), h * 0.5, z + oz * (2.0 + e * 0.45)))
        rings[3].append((x + ox * (3.3 + e * 0.6), h * 0.14, z + oz * (3.3 + e * 0.6)))
        rings[4].append((x + ox * (4.6 + e * 0.8), -1.2, z + oz * (4.6 + e * 0.8)))
    T.loft(rings, 'snow', orient=1)


def build_volume(spec, t, ti, y0, lod, last=False, ground=True, door=False):
    """one prism volume in its own (tier centre) frame with absolute y: facade skins, foot, cornice, parapet, roof + snow; returns Mod"""
    w, d, H = t['w'], t['d'], t['h']
    top = y0 + H
    shape = t.get('shape', 'box')
    P = footprint(w, d, shape, t.get('ch', 0.0), t.get('seg', {0: 32, 1: 24, 2: 14}[lod]))
    T = Mod()
    ybot = -3.2 if ground else y0 - 0.2
    vmin = 1.5 if ground else 0.0
    round_ = shape == 'round'
    if lod < 2:
        T.prism(offset_poly(P, -1.3), ybot, top, 'wallDark')
        for i in range(len(P)):
            n, L = edge_normal(P, i)
            if round_ and i % 4 != 1 and lod == 0: det = 0.0
            else: det = face_detail(spec, face_name(n), ti, n)
            if round_ and det == 0.0:
                # plain facet (no features) - still needs a skin tile
                a, b = P[i], P[(i + 1) % len(P)]
                S = Mod(); tile_mesh(S, -L / 2, L / 2, vmin, H, [], t.get('skin', 'wall'))
                T.merge(S, frame_matrix(((a[0] + b[0]) / 2, y0, (a[1] + b[1]) / 2), n)); S.free()
                continue
            far_side = det <= 0.5 or (n[1] < -0.45 and det < 0.85)          # back faces and faces turned away from the route (the player walks towards -z) get the cheaper LOD1 grammar
            build_face(T, spec, t, ti, P, i, y0, H, max(lod, 1) if far_side else lod, det, vmin, door)
    else:
        T.prism(P, ybot, top, t.get('skin', 'wall'))
        for f in t.get('accent', []):
            for i in range(len(P)):
                n, L = edge_normal(P, i)
                if face_name(n) != f['face']: continue
                a, b = P[i], P[(i + 1) % len(P)]
                S = Mod()
                S.box((f['x'], H / 2, 0.2), (f['w'], H - 2.0, 0.6), 'accent', skip=('-z',))
                T.merge(S, frame_matrix(((a[0] + b[0]) / 2, y0, (a[1] + b[1]) / 2), n)); S.free()
    # foot
    if ground:
        rings = [[(x, -3.2, z) for x, z in offset_poly(P, 1.25)], [(x, 0.3, z) for x, z in offset_poly(P, 1.25)],
                 [(x, 1.5, z) for x, z in offset_poly(P, 0.55)], [(x, 1.62, z) for x, z in offset_poly(P, -0.05)]]
        if lod == 2: rings = rings[:3]
        T.loft(rings, 'wall', orient=1)
    elif lod < 2:
        profile_loft(T, P, [(0.0, -0.1), (0.55, 0.0), (0.55, 0.42), (0.28, 0.8), (-0.4, 0.8)], y0, 'wall')
    if ground and lod < 2 and t.get('base_snow', True):
        base_snow(T, P, spec, door, lod, spec['seed'] * 13 + ti)
    # cornice & parapet
    if lod == 0:
        profile_loft(T, P, CORNICE0, top, 'trim')
    elif lod == 1:
        profile_loft(T, P, CORNICE1, top, 'trim')
    else:
        profile_loft(T, P, [(0.0, -1.4), (0.7, -1.2), (0.7, 0.9), (0.0, 1.1)], top, 'trim')
        for fr_ in ((0.34, 0.67) if H > 18 else ()):
            profile_loft(T, P, [(0.0, -0.35), (0.4, -0.18), (0.4, 0.18), (0.0, 0.35)], y0 + H * fr_, 'trim')
    for (ay, ah) in t.get('abands', []):
        if lod == 2: break
        T.ring_prism(offset_poly(P, 0.32), offset_poly(P, -0.3), y0 + ay, y0 + ay + ah, 'accent', bev=0.07 if lod == 0 else 0)
    # ring galleries (round / octagonal tiers): deck ring on brackets with railing and snow
    for k, ry in enumerate(t.get('rings', [])):
        if lod == 2: break
        yy = y0 + ry
        Po, Pi = offset_poly(P, 2.3), offset_poly(P, 0.0)
        T.ring_prism(Po, Pi, yy - 0.36, yy, 'deck', bev=0.05 if lod == 0 else 0)
        T.ring_prism(offset_poly(P, 2.34), offset_poly(P, 2.0), yy - 0.95, yy - 0.36, 'trim', bev=0.05 if lod == 0 else 0)
        if lod == 0:
            nP = len(P)
            for i in range(0, nP, 1 if nP <= 8 else 2):
                a = P[i]; n_, _ = edge_normal(P, i)
                px, pz = Po[i]
                T.beam((P[i][0] + (Po[i][0] - P[i][0]) * 0.0, yy - 2.7, P[i][1] + (Po[i][1] - P[i][1]) * 0.0), (px, yy - 0.5, pz), 0.28, 0.34, 'metal', up=(0, 1, 0))
            Pr = offset_poly(P, 2.15)
            for i in range(0, len(Pr), 1 if len(Pr) <= 8 else 2):
                T.box((Pr[i][0], yy + 0.54, Pr[i][1]), (0.08, 1.08, 0.08), 'metal')
            T.ring_prism(offset_poly(P, 2.2), offset_poly(P, 2.1), yy + 1.04, yy + 1.14, 'trim')
            T.ring_prism(offset_poly(P, 2.2), offset_poly(P, 2.1), yy + 0.5, yy + 0.58, 'metal')
        T.loft([[(x, yy - 0.05, z) for x, z in offset_poly(P, 2.2)], [(x, yy + 0.3, z) for x, z in offset_poly(P, 1.7)], [(x, yy + 0.3, z) for x, z in offset_poly(P, 0.6)], [(x, yy - 0.05, z) for x, z in offset_poly(P, 0.0)]], 'snow', orient=1)
    if not ground and lod < 2 and t.get('underside', False):
        T.prism(offset_poly(P, 0.3), y0 - 0.7, y0 + 0.05, 'trim', top=False, bottom=True, bev=0.1 if lod == 0 else 0)
    if lod < 2:
        fl = T.poly([(x, top, z) for x, z in offset_poly(P, -0.3)], 'wall')
        if fl is not None:
            fl.normal_update()
            if fl.normal.y < 0: bmesh.ops.reverse_faces(T.bm, faces=[fl])
        roof_snow(T, P, shape, top, 1.0 if last else 0.85, spec['seed'] + ti * 3, lod)
    tp = t.get('taper', 0.0)
    if tp:
        for v in T.bm.verts:
            s = 1 - tp * clamp((v.co.y - y0) / H, 0.0, 1.0)
            v.co.x *= s; v.co.z *= s
    return T


def leg(M, x, z, y_top, lod, w=2.2, mat='wallDark'):
    """tapered octagonal column with footing and capital (supports a raised volume)"""
    ring = lambda r, y: circle_pts(x, z, r, 8, y, a0=math.pi / 8)
    ys = [(-3.2, w * 0.95), (0.0, w * 0.78), (y_top * 0.5, w * 0.58), (y_top - 1.8, w * 0.62), (y_top - 0.7, w * 0.9)]
    M.loft([ring(r, y) for y, r in ys], mat, cap1=True, orient=1)
    if lod < 2:
        M.box((x, 0.5, z), (w * 2.5, 1.2, w * 2.5), 'wall', bev=0.15 if lod == 0 else 0, seg=1)
        M.box((x, y_top - 0.5, z), (w * 2.3, 1.0, w * 2.3), 'trim', bev=0.15 if lod == 0 else 0, seg=1)


def dome_ribbed(M, cx, cz, y0, r, h, lod, ribs=20, seed=1):
    """observatory dome: fluted shell (radial ribs), orange band, oculus ring and a lantern on top"""
    nr = ribs if lod == 0 else (10 if lod == 1 else 0)
    K = 8 if lod == 0 else (5 if lod == 1 else 4)
    rings = []
    for k in range(K + 1):
        a = (k / K) * math.radians(84)
        rr = r * math.cos(a)
        yy = y0 + h * math.sin(a)
        if lod == 2: rings.append(circle_pts(cx, cz, max(rr, 0.2), 14, yy))
        else: rings.append(fluted_ring(cx, cz, max(rr, 0.3), nr, 0.5 * (1 - k / K) + 0.08, yy, w=0.2))
    M.loft(rings, 'wall', cap1=True, orient=1)
    if lod < 2:
        for (k0, k1) in ((2, 3),):
            band = []
            for k in (k0, k1):
                a = (k / K) * math.radians(84)
                band.append(circle_pts(cx, cz, r * math.cos(a) + 0.42, 36 if lod == 0 else 20, y0 + h * math.sin(a)))
            M.loft(band, 'accent', orient=1)
        # oculus ring + lantern
        ya = y0 + h * math.sin(math.radians(84))
        ra = r * math.cos(math.radians(84))
        M.loft([circle_pts(cx, cz, ra + 0.9, 20, ya - 0.5), circle_pts(cx, cz, ra + 0.9, 20, ya + 0.3), circle_pts(cx, cz, ra + 0.4, 20, ya + 0.5)], 'trim', orient=1)
        M.frustum((cx, ya + 1.6, cz), ra + 0.3, ra * 0.7, 2.6, 'wallLight', seg=16 if lod == 0 else 10)
        M.dome((cx, ya + 2.9, cz), ra * 0.75, 'trim', h=ra * 0.55, seg=16 if lod == 0 else 10, rings=3)
        if lod == 0: M.frustum((cx, ya + 6.0, cz), 0.14, 0.05, 3.0, 'metal', seg=8)
        snow_poly(M, [(p[0], p[2]) for p in circle_pts(cx, cz, ra + 0.4, 12, 0)], ya + 0.5, 0.3, seed=seed, bury=0.0, rings=2)


def arch_span(M, wg, lod, seed=1):
    """giant arch: rectangular-section ring swept over a half circle, orange keystone blocks, embedded in two piers"""
    cx, cy, cz = wg['x'], wg.get('y', 20.0), wg.get('z', 0.0)
    Ri, th, dp = wg['r'], wg.get('thick', 3.4), wg.get('depth', 10.0)
    n = 22 if lod == 0 else (12 if lod == 1 else 8)
    z0, z1 = cz - dp / 2, cz + dp / 2
    ro = Ri + th
    rings = []
    for k in range(n + 1):
        a = math.pi * k / n
        ca, sa = math.cos(a), math.sin(a)
        rings.append([(cx + Ri * ca, cy + Ri * sa, z0), (cx + ro * ca, cy + ro * sa, z0), (cx + ro * ca, cy + ro * sa, z1), (cx + Ri * ca, cy + Ri * sa, z1)])
    M.loft(rings, 'wall', cap0=True, cap1=True, up=Vector((0, 1, 0)), closed=True, orient=1)
    if lod == 2: return
    # voussoir seams + orange keystones on both faces, trim rim on the soffit edges
    m = 11 if lod == 0 else 5
    for k in range(m):
        a = math.pi * (k + 0.5) / m
        for sg in (-1, 1):
            zz = cz + sg * (dp / 2 + 0.2)
            if k % 2 == 0 or lod == 1:
                M.box((cx + (Ri + th / 2) * math.cos(a), cy + (Ri + th / 2) * math.sin(a), zz), (th * 0.82, math.pi * (Ri + th / 2) / m * 0.78, 0.5), 'accent' if k % 2 == 0 else 'trim', basis=Matrix.Rotation(a - math.pi / 2, 3, 'Z'), bev=0.1 if lod == 0 else 0, seg=1)
    if lod == 0:
        for sg in (-1, 1):
            rings2 = []
            for k in range(n + 1):
                a = math.pi * k / n
                rr = Ri - 0.35
                rings2.append([(cx + rr * math.cos(a), cy + rr * math.sin(a), cz + sg * (dp / 2 - 0.2)), (cx + (rr + 0.7) * math.cos(a), cy + (rr + 0.7) * math.sin(a), cz + sg * (dp / 2 - 0.2)), (cx + (rr + 0.7) * math.cos(a), cy + (rr + 0.7) * math.sin(a), cz + sg * (dp / 2 + 0.25)), (cx + rr * math.cos(a), cy + rr * math.sin(a), cz + sg * (dp / 2 + 0.25))])
            M.loft(rings2, 'trim', cap0=True, cap1=True, up=Vector((0, 1, 0)), closed=True, orient=1)


def build_wing(M, spec, wi, wg, lod):
    ty = wg['type']
    seed = spec['seed'] * 31 + wi
    if ty == 'silo':
        silo(M, wg['x'], wg['z'], wg['r'], wg['h'], lod, y0=wg.get('y', 0.0), top=wg.get('top', 'dome'), ribs=wg.get('ribs', 14), bands=wg.get('bands', 2), seed=seed)
        if wg.get('foot', True) and lod < 2:
            M.frustum((wg['x'], wg.get('y', 0.0) + 0.3, wg['z']), wg['r'] + 0.9, wg['r'] + 0.5, 1.6, 'wallDark', seg=20 if lod == 0 else 10, cap0=False)
    elif ty == 'chimney':
        chimney(M, wg['x'], wg['z'], wg['r'], wg['h'], lod, y0=wg.get('y', 0.0), seed=seed)
    elif ty == 'dome':
        dome_ribbed(M, wg['x'], wg['z'], wg.get('y', 0.0), wg['r'], wg['h'], lod, ribs=wg.get('ribs', 20), seed=seed)
    elif ty == 'arch':
        arch_span(M, wg, lod, seed)
    elif ty == 'volume':
        t = dict(wg)
        y0w = wg.get('y', 0.0)
        t['underside'] = y0w > 1.0
        T = build_volume(spec, t, 20 + wi, y0w, lod, last=True, ground=y0w < 1.0, door=False)
        M.merge(T, Matrix.Translation((wg['x'], 0.0, wg['z'])))
        T.free()
        for (lx, lz) in wg.get('legs', []):
            leg(M, wg['x'] + lx, wg['z'] + lz, y0w - 0.6, lod, w=wg.get('leg_w', 2.2))
    elif ty == 'bridge':
        sky_bridge(M, wg['from'], wg['to'], wg.get('w', 4.0), wg.get('h', 3.2), lod, seed=seed, enclosed=wg.get('enclosed', True), truss=wg.get('truss', True), piers=wg.get('piers', ()))
    elif ty == 'pipe':
        pipe_run(M, wg['pts'], wg.get('r', 0.5), lod)
    elif ty == 'mast':
        x, z, h = wg['x'], wg['z'], wg['h']
        w0, w1 = wg.get('w0', 3.0), wg.get('w1', 0.6)
        lattice_mast(M, x, z, wg.get('y', 0.0), h, w0, w1, lod)
        if lod < 2:
            M.box((x, 0.6, z), (w0 * 1.8, 1.2, w0 * 1.8), 'wallDark', bev=0.15 if lod == 0 else 0, seg=1)
            for f, wd in ((0.5, 3.4), (0.78, 2.6)):
                yy = h * f
                M.box((x, yy, z), (wd, 0.28, wd), 'deck', bev=0.05 if lod == 0 else 0, seg=1)
                if lod == 0:
                    for q in range(4): M.box((x + (wd / 2 - 0.1) * (1 if q < 2 else -1), yy + 0.55, z + (wd / 2 - 0.1) * (1 if q % 2 else -1)), (0.06, 1.1, 0.06), 'metal')
            dish(M, (x + 1.8, h * 0.5 + 1.2, z), 1.5, -0.6, 'trim', lod, 0.0)
            dish(M, (x, h * 0.78 + 1.6, z + 1.5), 1.2, -0.5, 'trim', lod, math.pi / 2)
            M.frustum((x, h + 1.0, z), 0.16, 0.05, 2.0, 'metal', seg=8)
            M.frustum((x, h + 2.1, z), 0.16, 0.16, 0.34, 'accent', seg=8)


def compute_cols(spec):
    cols = []
    y0 = 0.0
    for t in spec['tiers']:
        ox, oz = t.get('ox', 0.0), t.get('oz', 0.0)
        g = (1.1 if t.get('buttress') else 0.95) if y0 == 0 else 0.0     # the foot flares / piers / buttresses stand proud of the wall: keep the player out of them
        if t.get('shape') == 'round' and t['w'] >= 16 and y0 == 0:
            Rx, Rz = t['w'] / 2 + 0.3, t['d'] / 2 + 0.3
            ns = 6
            for q in range(ns):
                xa, xb = -Rx + 2 * Rx * q / ns, -Rx + 2 * Rx * (q + 1) / ns
                xm = max(abs(xa), abs(xb))
                hz = Rz * math.sqrt(max(0.0, 1 - (xm / Rx) ** 2))
                cols.append([round(ox + xa, 2), 0.0, round(oz - hz, 2), round(ox + xb, 2), round(t['h'] + 1.2, 2), round(oz + hz, 2)])
            y0 += t['h']
            continue
        cols.append([round(ox - t['w'] / 2 - g, 2), round(y0, 2), round(oz - t['d'] / 2 - g, 2), round(ox + t['w'] / 2 + g, 2), round(y0 + t['h'] + 1.2, 2), round(oz + t['d'] / 2 + g, 2)])
        y0 += t['h']
    for wg in spec.get('wings', []):
        ty = wg['type']
        if ty == 'silo':
            r = wg['r'] + 0.85         # collar bands / ladder / hatch stand 0.7-0.9 m proud of the flutes
            cols.append([round(wg['x'] - r, 2), wg.get('y', 0.0), round(wg['z'] - r, 2), round(wg['x'] + r, 2), wg.get('y', 0.0) + wg['h'], round(wg['z'] + r, 2)])
        elif ty == 'chimney':
            r = wg['r'] + 0.3
            cols.append([round(wg['x'] - r, 2), wg.get('y', 0.0), round(wg['z'] - r, 2), round(wg['x'] + r, 2), wg.get('y', 0.0) + wg['h'], round(wg['z'] + r, 2)])
        elif ty == 'volume':
            ox, oz = wg['x'], wg['z']
            cols.append([round(ox - wg['w'] / 2 - 0.9, 2), wg.get('y', 0.0) - 0.7, round(oz - wg['d'] / 2 - 0.9, 2), round(ox + wg['w'] / 2 + 0.9, 2), wg.get('y', 0.0) + wg['h'] + 1.2, round(oz + wg['d'] / 2 + 0.9, 2)])
            for (lx, lz) in wg.get('legs', []):
                lw = wg.get('leg_w', 2.2) * 0.8
                cols.append([round(ox + lx - lw, 2), -3.0, round(oz + lz - lw, 2), round(ox + lx + lw, 2), wg.get('y', 0.0), round(oz + lz + lw, 2)])
        elif ty == 'mast':
            r = wg.get('w0', 3.0) * 0.9
            cols.append([round(wg['x'] - r, 2), -3.0, round(wg['z'] - r, 2), round(wg['x'] + r, 2), 4.0, round(wg['z'] + r, 2)])
        elif ty == 'bridge':
            for pu in wg.get('piers', ()):
                a, b = Vector(wg['from']), Vector(wg['to'])
                m = (a + b) / 2
                dd = b - a
                L = math.hypot(dd.x, dd.z)
                px, pz = m.x + dd.x / L * pu, m.z + dd.z / L * pu
                cols.append([round(px - 1.2, 2), -3.0, round(pz - 1.2, 2), round(px + 1.2, 2), round(m.y - 0.7, 2), round(pz + 1.2, 2)])
    return cols


def build(spec, lod):
    M = Mod()
    tiers = spec['tiers']
    y0 = 0.0
    for ti, t in enumerate(tiers):
        T = build_volume(spec, t, ti, y0, lod, last=(ti == len(tiers) - 1), ground=(ti == 0), door=(ti == 0))
        M.merge(T, Matrix.Translation((t.get('ox', 0.0), 0.0, t.get('oz', 0.0))))
        T.free()
        overhang_supports(M, spec, ti, lod)
        y0 += t['h']
    for wi, wg in enumerate(spec.get('wings', [])):
        build_wing(M, spec, wi, wg, lod)
    # roof equipment on the top tier
    t = tiers[-1]
    kinds = spec.get('roof', 'vents')
    kinds = kinds if isinstance(kinds, list) else [kinds]
    tp = t.get('taper', 0.0)
    for ki, kind in enumerate(kinds):
        if lod == 2 and kind not in ('ring', 'stack', 'dish', 'antenna', 'tank'): continue
        roof_gear(M, spec, lod, kind, t.get('ox', 0.0), t.get('oz', 0.0), y0 + 0.3, t['w'] * (1 - tp) * 0.8, t['d'] * (1 - tp) * 0.8, seed=spec['seed'] + ki)
    return M, compute_cols(spec)



# ═════════════════════════════════════════════════ post process ═════════════════════════════════════════════════
def hemi_dirs(n):
    out = []
    for k in range(n):
        u = (k + 0.5) / n
        r = math.sqrt(u)
        th = k * 2.399963
        out.append((r * math.cos(th), r * math.sin(th), math.sqrt(1 - u)))
    return out


def adaptive_ao(bm, rays, maxd, thr=0.09, minlen=0.7, passes=3, strength=1.25):
    lay = bm.verts.layers.float.new('aov')
    known = bm.verts.layers.int.new('aok')
    dirs = hemi_dirs(rays)
    for it in range(passes + 1):
        bm.normal_update()
        gv = [bm.verts.new(p) for p in ((-400, -0.02, -400), (400, -0.02, -400), (400, -0.02, 400), (-400, -0.02, 400))]
        gf = bm.faces.new(gv)
        tree = bvhtree.BVHTree.FromBMesh(bm)
        for v in bm.verts:
            if v in gv or v[known]: continue
            n = v.normal.copy()
            if n.length < 1e-6: n = Vector((0, 1, 0))
            n.normalize()
            ref = UP if abs(n.y) < 0.9 else Vector((1, 0, 0))
            tt = n.cross(ref).normalized(); bb = n.cross(tt)
            o = v.co + n * 0.035
            occ = 0.0
            for (lx, ly, lz) in dirs:
                d = tt * lx + bb * ly + n * lz
                h = tree.ray_cast(o, d, maxd)
                if h[0] is not None: occ += 1.0 - h[3] / maxd
            v[lay] = clamp(1.0 - strength * occ / rays, 0.0, 1.0)
            v[known] = 1
        bmesh.ops.delete(bm, geom=[gf], context='FACES')
        if it == passes: break
        bm.edges.ensure_lookup_table()
        edges = [e for e in bm.edges if e.calc_length() > minlen and abs(e.verts[0][lay] - e.verts[1][lay]) > thr]
        if not edges: break
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, use_single_edge=False)
    return lay


def bake_wear(bm, lay_ao):
    """edge-wear / curvature term (0.5 neutral .. 1 convex edge) in a float layer; used as the G channel of COLOR_0"""
    lay = bm.verts.layers.float.new('wear')
    for v in bm.verts:
        w = 0.5
        for e in v.link_edges:
            if len(e.link_faces) != 2: continue
            try:
                ang = e.calc_face_angle(0.0)
            except Exception:
                continue
            if ang > 0.3 and e.is_convex:
                w = max(w, 0.5 + 0.5 * min(1.0, ang / 0.9))
        ao = v[lay_ao] if lay_ao is not None else 1.0
        v[lay] = w if ao > 0.78 else 0.5
    return lay


def creased_normals(pos, tris, ang=40.0, fmat=None, soft=None, soft_ang=85.0):
    """per-corner normals: area weighted average of the incident faces within `ang` degrees of the corner's own face"""
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
    for s, e in zip(starts, ends):
        ts = ct_s[s:e]
        F = fnn[ts]; A = area[ts]
        th = np.maximum(fth[ts][:, None], fth[ts][None, :])
        W = (F @ F.T > th) * A[None, :]
        N = W @ F
        ln = np.linalg.norm(N, axis=1)
        ln[ln < 1e-12] = 1
        N = N / ln[:, None]
        out[ts, corner_of[s:e]] = N
    return out


def pack(bm, lay, wlay=None):
    """triangulate -> per material arrays {mat: dict(pos, nrm(int8 x4), col(uint8 x4), idx)}"""
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='SHORT_EDGE', ngon_method='EAR_CLIP')
    bm.verts.ensure_lookup_table()
    pos = np.array([v.co[:] for v in bm.verts], np.float64)
    ao = np.array([v[lay] if lay is not None else 1.0 for v in bm.verts], np.float32)
    wr = np.array([v[wlay] if wlay is not None else 0.5 for v in bm.verts], np.float32)
    tris = np.array([[v.index for v in f.verts] for f in bm.faces if len(f.verts) == 3], np.int64)
    mats = np.array([f.material_index for f in bm.faces if len(f.verts) == 3], np.int64)
    nrm = creased_normals(pos, tris, fmat=mats, soft=[MI['snow']])
    out = {}
    for mi, mname in enumerate(MATS):
        sel = np.flatnonzero(mats == mi)
        if not len(sel): continue
        tv = tris[sel]                       # (n,3) original vertex ids
        tn = nrm[sel]                        # (n,3,3)
        q = np.rint(tn * 127).astype(np.int16)
        key = np.concatenate([tv.reshape(-1, 1), q.reshape(-1, 3)], axis=1)
        uk, inv = np.unique(key, axis=0, return_inverse=True)
        vid = uk[:, 0]
        P = pos[vid].astype(np.float32)
        N = np.zeros((len(uk), 4), np.int8); N[:, :3] = np.clip(uk[:, 1:], -127, 127)
        C = np.full((len(uk), 4), 255, np.uint8)
        C[:, 0] = np.clip(np.rint(ao[vid] * 255), 0, 255).astype(np.uint8)
        C[:, 1] = np.clip(np.rint(wr[vid] * 255), 0, 255).astype(np.uint8)
        C[:, 2] = 0
        idx = inv.reshape(-1).astype(np.uint32)
        out[mname] = dict(pos=P, nrm=N, col=C, idx=idx)
    return out


def finalize(M, rays, maxd, thr=0.09, minlen=0.7, passes=3):
    bm = M.bm
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0007)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-4, edges=bm.edges[:])
    lay = wl = None
    if rays > 0:
        lay = adaptive_ao(bm, rays, maxd, thr, minlen, passes)
        bm.normal_update()
        wl = bake_wear(bm, lay)
    return pack(bm, lay, wl)


# ═════════════════════════════════════════════════ GLB writer ═════════════════════════════════════════════════
def write_glb(path, meshes, norm_float=False, quant_pos=False):
    """meshes: {name: dict(pos, nrm, col, idx)} -> one node per mesh. int8 normals + ubyte colours (KHR_mesh_quantization)
    unless norm_float (plain float32 normals, for consumers that merge them with procedural geometry)."""
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
        P = m['pos'].astype(np.float32)
        if quant_pos:   # int16 in 1/128 m units (decoded by the consumer), padded to 8 bytes per vertex
            Q = np.zeros((len(P), 4), np.int16); Q[:, :3] = np.clip(np.rint(P * 128.0), -32767, 32767)
            at = {'POSITION': push(Q, 5122, 'VEC3', 34962, stride=8, minmax=(Q[:, :3].min(0).tolist(), Q[:, :3].max(0).tolist()))}
        else:
            at = {'POSITION': push(P, 5126, 'VEC3', 34962, minmax=(P.min(0).tolist(), P.max(0).tolist()))}
        if norm_float:
            nf = (m['nrm'][:, :3].astype(np.float32) / 127.0)
            nf /= np.maximum(np.linalg.norm(nf, axis=1, keepdims=True), 1e-6)
            at['NORMAL'] = push(nf.astype(np.float32), 5126, 'VEC3', 34962)
        else:
            at['NORMAL'] = push(m['nrm'], 5120, 'VEC3', 34962, stride=4, normalized=True)
        at['COLOR_0'] = push(m['col'], 5121, 'VEC4', 34962, stride=4, normalized=True)
        idx = m['idx']
        if int(idx.max()) < 65535: ind = push(idx.astype(np.uint16), 5123, 'SCALAR', 34963)
        else: ind = push(idx.astype(np.uint32), 5125, 'SCALAR', 34963)
        meshdefs.append({'name': name, 'primitives': [{'attributes': at, 'indices': ind, 'mode': 4}]})
        nodes.append({'name': name, 'mesh': len(meshdefs) - 1})
    j = {'asset': {'version': '2.0', 'generator': 'eden gen_buildings'}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}],
         'nodes': nodes, 'meshes': meshdefs, 'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(out)}]}
    if not norm_float:
        j['extensionsUsed'] = ['KHR_mesh_quantization']; j['extensionsRequired'] = ['KHR_mesh_quantization']
    jb = json.dumps(j, separators=(',', ':')).encode()
    while len(jb) % 4: jb += b' '
    while len(out) % 4: out.append(0)
    total = 12 + 8 + len(jb) + 8 + len(out)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(jb), 0x4E4F534A)); f.write(jb)
        f.write(struct.pack('<II', len(out), 0x004E4942)); f.write(out)


# ═════════════════════════════════════════════════ driver ═════════════════════════════════════════════════
LOD_CFG = {0: dict(rays=14, maxd=3.2, thr=0.14, minlen=2.4, passes=0), 1: dict(rays=8, maxd=4.5, thr=0.2, minlen=4.0, passes=0), 2: dict(rays=0, maxd=1, thr=1, minlen=1, passes=0)}


def build_one(spec, lod):
    t0 = time.time()
    M, cols = build(spec, lod)
    cfg = LOD_CFG[lod]
    data = finalize(M, **cfg)
    M.free()
    nv = sum(len(m['pos']) for m in data.values()); nt = sum(len(m['idx']) // 3 for m in data.values())
    print(f"building {spec['id']} lod{lod}: {nv} verts {nt} tris {time.time() - t0:.1f}s", flush=True)
    return data


def load_specs():
    return json.load(open(SPEC_PATH))['buildings']


def write_specs(specs):
    out = []
    for spec in specs:
        s2 = dict(spec); s2['cols'] = compute_cols(spec); out.append(s2)
    json.dump({'buildings': out}, open(os.path.join(HERE, '..', 'assets', 'buildings.json'), 'w'), separators=(',', ':'))
    fb = []
    for spec in specs:
        s2 = {k: v for k, v in spec.items() if k not in ('wings', 'cols')}
        s2['tiers'] = [{k: v for k, v in t.items() if k not in ('gallery', 'rings', 'buttress')} for t in spec['tiers']]
        fb.append(s2)
    with open(os.path.join(HERE, '..', 'src', 'fallback_specs.js'), 'w') as f:
        f.write('export default ' + json.dumps(fb, separators=(',', ': ')) + ';\n')


def main(argv):
    ids = [int(a) for a in argv if a.lstrip('-').isdigit() and not a.startswith('-')]
    lods = [0, 1, 2]
    for a in argv:
        if a.startswith('--lods='): lods = [int(c) for c in a[7:].split(',')]
    specs = load_specs()
    os.makedirs(CACHE, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    meshes = {}
    for spec in specs:
        for lod in (0, 1, 2):
            path = os.path.join(CACHE, f"b{spec['id']}_l{lod}.pkl")
            want = (not ids or spec['id'] in ids) and lod in lods
            if want or not os.path.exists(path):
                data = build_one(spec, lod)
                pickle.dump(data, open(path, 'wb'))
            else:
                data = pickle.load(open(path, 'rb'))
            for mname, m in data.items(): meshes[f"b{spec['id']}_l{lod}_{mname}"] = m
    write_glb(OUT, meshes, quant_pos=True)
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')
    if not os.environ.get('BLD_OUT'): write_specs(specs)


if __name__ == '__main__':
    main(sys.argv[1:])
