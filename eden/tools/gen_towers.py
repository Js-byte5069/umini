"""Blender (bpy) hero-tower generator: the "pre-civilisation sentinel tower" of the EDEN reference sheet.

Light cool-grey main body, dark slate secondary structure, ONE big coral slab, stepped setbacks with a cantilevered observation
gallery, a tapering crown + antenna mast, soft snow resting on every ledge. Few large clean forms; detail only where it explains the
structure (no greebles). Writes assets/towers.glb with objects named  b{id}_l{lod}_{material}  (same convention as buildings.glb, so the
engine loads them through the building path) and assets/towers.json (placement + colliders, loaded next to buildings.json).

Run:  PYTHONDONTWRITEBYTECODE=1 python3 tools/gen_towers.py [id]        (needs bpy 4.2; deterministic)
"""
import bpy, bmesh, json, math, os, random, sys
from mathutils import Vector, Matrix, noise, bvhtree

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, '..', 'assets')
MATS = ['wall', 'wallLight', 'wallDark', 'trim', 'metal', 'accent', 'accentDark', 'glass', 'deck', 'snow']
MI = {m: i for i, m in enumerate(MATS)}

# id, world x/z, yaw (local +z faces the street), overall height, base width/depth, style
TOWERS = [
    dict(id=20, x=-88, z=119.8, yaw=90, H=100, W=31, D=27, seed=3, gallery_y=0.0, slab='front',
         bridge=dict(local_x=7.8, deck=19.5, wz=112.0, dir=1, end_x=-50.7)),
    dict(id=21, x=90, z=104.2, yaw=-90, H=82, W=26, D=24, seed=8, gallery_y=0.30, slab='front',
         bridge=dict(local_x=7.8, deck=19.5, wz=112.0, dir=-1, end_x=50.7)),
]


def clamp(x, a, b): return a if x < a else b if x > b else x


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
            loops.append([Vector((c[0] + math.cos(a) * rr, y, c[2] + math.sin(a) * rr)) for a in [i / seg * math.tau for i in range(seg)]])
        self.shell(loops, mat)

    def append(self, other):
        me = bpy.data.meshes.new('t'); other.bm.to_mesh(me); n0 = len(self.bm.verts)
        self.bm.from_mesh(me); bpy.data.meshes.remove(me)


def octa(w, d, ch, k=1.0):
    """chamfered rectangle footprint, CCW seen from +y, scaled by k about the centre"""
    hw, hd = w / 2 * k, d / 2 * k; c = min(ch * k, hw * 0.45, hd * 0.45)
    return [(-hw + c, -hd), (hw - c, -hd), (hw, -hd + c), (hw, hd - c), (hw - c, hd), (-hw + c, hd), (-hw, hd - c), (-hw, -hd + c)]


def ring_pts(r, n, rz=None, a0=None):
    rz = r if rz is None else rz
    a0 = math.pi / n if a0 is None else a0
    return [(math.cos(a0 + i / n * math.tau) * r, math.sin(a0 + i / n * math.tau) * rz) for i in range(n)]


def tier(P, w, d, ch, y0, y1, mat, taper=0.94, cz=0.0):
    a = [(x, z + cz) for x, z in octa(w, d, ch, 1.0)]
    b = [(x * taper, z * taper + cz) for x, z in octa(w, d, ch, 1.0)]
    P.shell([[Vector((x, y0, z)) for x, z in a], [Vector((x, y1, z)) for x, z in b]], mat)


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


def rail_ring(F, pts, y, h, mat_post='metal', mat_rail='trim', gap=2.4):
    """handrail around a closed loop of (x,z) points (fine part: never bevelled)"""
    n = len(pts)
    for i in range(n):
        a = Vector((pts[i][0], y, pts[i][1])); b = Vector((pts[(i + 1) % n][0], y, pts[(i + 1) % n][1]))
        L = (b - a).length; m = max(1, int(L / gap)); ang = math.atan2(-(b.z - a.z), b.x - a.x)
        for k in range(m):
            p = a.lerp(b, k / m); F.box((p.x, y + h / 2, p.z), (0.12, h, 0.12), mat_post)
        c = (a + b) / 2
        F.box((c.x, y + h, c.z), (L + 0.12, 0.13, 0.13), mat_rail, rot=ang)
        F.box((c.x, y + h * 0.5, c.z), (L, 0.07, 0.07), mat_post, rot=ang)


def build_tower(T, lod):
    rnd = random.Random(T['seed'])
    H, W, D = T['H'], T['W'], T['D']
    B = Part(); F = Part()                       # B = big forms (bevelled), F = fine parts
    base_top = 7.0
    body = H - base_top
    # tier plan (fractions of the body height)
    y1a = base_top; y1b = y1a + body * 0.30
    y2b = y1b + body * 0.26
    y3b = y2b + body * 0.19
    y4b = y3b + body * 0.07
    tip = H
    w1, d1 = W * 0.74, D * 0.78
    w2, d2 = W * 0.56, D * 0.60
    w3, d3 = W * 0.40, D * 0.43
    w4, d4 = W * 0.27, D * 0.29
    cols = []

    # ── foundation: plinth, dark slate base block with buttresses and a portal ──
    tier(B, W + 3.2, D + 3.2, 3.0, -2.0, 1.3, 'wallDark', taper=0.98)
    tier(B, W, D, 2.6, 1.0, base_top + 1.5, 'wallDark', taper=0.965)
    for sx in (-1, 1):
        for sz in (-1, 1):                                          # corner buttress wedges
            cx, cz = sx * (W / 2 - 0.3), sz * (D / 2 - 0.3)
            B.shell([[Vector((cx + dx * 1.7, 1.0, cz + dz * 1.7)) for dx, dz in ((-1, -1), (1, -1), (1, 1), (-1, 1))],
                     [Vector((cx + dx * 0.9, base_top - 0.5, cz + dz * 0.9)) for dx, dz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]], 'wall')
    # portal on the front face (+z): lighter frame + proud dark door leaf
    B.box((0, 3.3, D / 2 + 0.2), (7.4, 6.6, 0.9), 'wallLight')
    B.box((0, 2.9, D / 2 + 0.75), (4.8, 5.8, 0.5), 'metal')
    B.box((0, 6.9, D / 2 + 0.3), (8.4, 0.9, 1.1), 'trim')
    if lod == 0:
        for k in (-1, 1): B.box((k * 1.2, 2.9, D / 2 + 1.1), (0.14, 5.6, 0.16), 'trim')
    cols.append([-(W + 3.2) / 2, -2, -(D + 3.2) / 2, (W + 3.2) / 2, 1.4, (D + 3.2) / 2])
    cols.append([-W / 2, -2, -D / 2, W / 2, base_top + 1.5, D / 2])

    # ── cantilevered observation gallery (flange ring around the foot of the main body) ──
    gy = base_top + 1.5 + T['gallery_y'] * body
    gR = max(W, D) * 0.80; gr = max(w1, d1) * 0.58
    nG = 16
    outer = ring_pts(gR, nG, gR * (D / W) ** 0.4); inner = ring_pts(gR * 0.74, nG, gR * 0.74 * (D / W) ** 0.4)
    if lod < 2:
        B.tube(outer, inner, gy - 0.55, gy + 0.05, 'deck')
        B.tube(ring_pts(gR + 0.35, nG, (gR + 0.35) * (D / W) ** 0.4), outer, gy - 0.8, gy + 0.05, 'wallLight')      # fascia band
        for i in range(0, nG, 2):                                   # corbels under the gallery
            a = math.pi / nG + i / nG * math.tau
            px, pz = math.cos(a) * gR * 0.8, math.sin(a) * gR * 0.8 * (D / W) ** 0.4
            B.shell([[Vector((px + dx, gy - 3.2, pz + dz)) for dx, dz in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5))],
                     [Vector((px + dx * 1.6, gy - 0.8, pz + dz * 1.6)) for dx, dz in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5))]], 'wallDark')
        if lod == 0:
            rail_ring(F, ring_pts(gR + 0.1, nG, (gR + 0.1) * (D / W) ** 0.4), gy + 0.05, 1.15)
    # ── tiers ──
    tier(B, w1, d1, 2.2, y1a, y1b, 'wall', taper=0.93)
    tier(B, w2, d2, 1.8, y1b - 0.3, y2b, 'wall', taper=0.94)
    tier(B, w3, d3, 1.4, y2b - 0.3, y3b, 'wallLight', taper=0.94)
    tier(B, w4, d4, 1.0, y3b - 0.3, y4b, 'wall', taper=0.9)
    for (wa, da, ya) in ((w1, d1, y1b), (w2, d2, y2b), (w3, d3, y3b)):      # cornice ledges (light, slightly proud) separate the tiers
        if lod < 2: B.box((0, ya - 0.1, 0), (wa * 0.97 + 1.2, 0.8, da * 0.97 + 1.2), 'trim')
    # dark secondary structure: corner pilasters + a dark band under the crown
    if lod < 2:
        for (wa, da, ya, yb) in ((w1, d1, y1a, y1b), (w2, d2, y1b, y2b), (w3, d3, y2b, y3b)):
            for sx in (-1, 1):
                for sz in (-1, 1):
                    B.box((sx * (wa / 2 - 0.15), (ya + yb) / 2, sz * (da / 2 - 0.15)), (1.1, yb - ya - 0.6, 1.1), 'wallDark')
        B.box((0, y3b + 0.9, 0), (w4 * 1.18, 1.6, d4 * 1.18), 'wallDark')
    # window ribbon on the upper body (dark glass band set in a frame)
    if lod < 2:
        yw = (y2b + y3b) / 2 + 1.0
        B.box((0, yw, d3 / 2 + 0.05), (w3 * 0.62, 1.9, 0.5), 'wallDark')
        B.box((0, yw, d3 / 2 + 0.34), (w3 * 0.54, 1.25, 0.2), 'glass')
    # ── the big coral slab(s) on the front face; thin ones on the flanks ──
    def slab(wa, da, ya, yb, wslab, front=True, thick=0.9, segs=2):
        zf = da / 2 + 0.25
        B.box((0, (ya + yb) / 2, zf - 0.1), (wslab + 1.2, yb - ya - 0.2, 0.5), 'wallDark')                  # dark frame behind
        h = (yb - ya - 1.0 - 0.28 * (segs - 1)) / segs
        for s in range(segs):
            yc = ya + 0.5 + s * (h + 0.28) + h / 2
            B.box((0, yc, zf + 0.35), (wslab, h, thick), 'accent')
            if lod == 0:
                B.box((0, yc, zf + 0.35 + thick / 2 + 0.01), (wslab - 1.3, h - 1.3, 0.18), 'accentDark')
    slab(w1, d1, y1a + 0.6, y1b - 0.6, w1 * 0.30, segs=3)
    slab(w2, d2, y1b + 0.8, y2b - 0.6, w2 * 0.32, segs=3)
    if lod < 2:                                                      # slim flank slabs on the mid tier
        for sx in (-1, 1):
            B.box((sx * (w2 / 2 + 0.2), (y1b + y2b) / 2, 0), (0.7, (y2b - y1b) * 0.78, d2 * 0.30), 'accent')
    # ── bridge portal: framed opening + landing stub where the truss bridge docks (tier 1, front face) ──
    br = T.get('bridge')
    if br:
        bx, yb, zf = br['local_x'], br['deck'], d1 / 2
        B.box((bx, yb + 2.9, zf + 0.1), (5.4, 5.8, 0.9), 'wallLight')
        B.box((bx, yb + 6.0, zf + 0.25), (6.0, 0.55, 1.2), 'trim')
        B.box((bx, yb + 2.5, zf + 0.55), (4.0, 4.6, 0.5), 'wallDark')
        B.box((bx, yb + 2.5, zf + 0.84), (3.3, 3.9, 0.12), 'glass')
        B.box((bx, yb - 0.27, zf + 1.3), (4.7, 0.5, 2.6), 'wallDark')
        B.box((bx, yb - 0.02, zf + 1.3), (4.3, 0.1, 2.4), 'deck')
        for sx in (-1, 1): B.box((bx + sx * 2.45, yb + 0.6, zf + 1.3), (0.28, 1.2, 2.6), 'trim')           # low cheek walls of the stub
        for sx in (-1, 1): B.box((bx + sx * 2.1, yb - 2.3, zf + 0.4), (0.5, 3.6, 0.7), 'wallDark')         # corbels carrying the stub
    # ── crown: stepped lantern + tapering spire with antenna mast ──
    tier(B, w4 * 0.82, d4 * 0.82, 0.9, y4b - 0.2, y4b + (tip - y4b) * 0.22, 'wallLight', taper=0.8)
    sp0 = y4b + (tip - y4b) * 0.2
    B.shell([[Vector((x, sp0, z)) for x, z in ring_pts(w4 * 0.33, 8)], [Vector((x, sp0 + (tip - sp0) * 0.55, z)) for x, z in ring_pts(w4 * 0.17, 8)]], 'wall')
    mast0 = sp0 + (tip - sp0) * 0.55
    F.cyl((0, (mast0 + tip) / 2, 0), 0.22, tip - mast0, 'metal', seg=8, r2=0.08)
    if lod < 2:
        for k, fr in enumerate((0.35, 0.62)):
            F.box((0, mast0 + (tip - mast0) * fr, 0), (3.4 - k * 1.5, 0.16, 0.16), 'trim')
            F.box((0, mast0 + (tip - mast0) * fr, 0), (0.16, 0.16, 3.4 - k * 1.5), 'trim')
    B.cyl((0, tip + 0.2, 0), 0.34, 0.7, 'accent', seg=10)

    # ── snow: soft lumps on the gallery and on every setback ledge ──
    if lod < 3:
        r2 = random.Random(T['seed'] * 11 + 1)
        def pads(yc, wa, da, wb, db, tt, cnt, seedk):
            for a in range(cnt):
                ang = a / cnt * math.tau + 0.4 + r2.random() * 0.3
                px = math.cos(ang) * (wa + wb) / 4 * 1.0; pz = math.sin(ang) * (da + db) / 4 * 1.0
                snow_pad(B, px, yc, pz, (wa - wb) / 2 + 2.6 + r2.random() * 1.6, (da - db) / 2 + 2.6 + r2.random() * 1.6, tt * (0.8 + 0.5 * r2.random()), seedk + a, n=8 if lod == 0 else 5)
        pads(base_top + 1.55 + T['gallery_y'] * body + 0.0, gR * 2 * 0.9, gR * 2 * 0.9 * (D / W) ** 0.4, w1 + 2, d1 + 2, 1.5, 7, 1)
        pads(y1b + 0.3, w1, d1, w2, d2, 1.15, 5, 20)
        pads(y2b + 0.3, w2, d2, w3, d3, 1.0, 5, 40)
        pads(y3b + 0.3, w3, d3, w4, d4, 0.85, 4, 60)
        snow_pad(B, 0, base_top + 1.5 + T['gallery_y'] * body + 0.0, 0, 0.001, 0.001, 0.001, 0, n=2)       # keeps the snow group non-empty
        for sx in (-1, 1):                                           # banked snow at the plinth corners
            snow_pad(B, sx * (W / 2 + 2.2), 0.4, D / 2 + 1.8, 7, 5.5, 1.9, 90 + sx, n=8 if lod == 0 else 5, bury=0.9)
            snow_pad(B, sx * (W / 2 + 2.2), 0.4, -(D / 2 + 1.8), 7, 5.5, 1.7, 95 + sx, n=8 if lod == 0 else 5, bury=0.9)
    # colliders: the tower shaft (the player can only reach the plinth/base, but keep the whole shaft solid)
    cols.append([-w1 / 2, base_top, -d1 / 2, w1 / 2, y1b, d1 / 2])
    cols.append([-w2 / 2, y1b, -d2 / 2, w2 / 2, y3b, d2 / 2])
    return B, F, cols


def bevel_all(P, width, segs):
    bm = P.bm; bm.edges.ensure_lookup_table()
    edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > 0.6 and e.calc_length() > 0.5]
    bmesh.ops.bevel(bm, geom=edges, offset=width, offset_type='OFFSET', segments=segs, profile=0.5, affect='EDGES')


def subdiv(P, maxlen, passes):
    bm = P.bm
    for _ in range(passes):
        edges = [e for e in bm.edges if e.calc_length() > maxlen]
        if not edges: break
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)


def bake(P, rays, maxd=6.0):
    """COLOR_0 = (baked AO, edge wear 0.5 flat .. 1 convex, 0, 1) like buildings.glb"""
    bm = P.bm; bm.normal_update(); bm.edges.ensure_lookup_table()
    lay = bm.verts.layers.float_color.new('ao')
    tree = bvhtree.BVHTree.FromBMesh(bm) if rays else None
    rnd = random.Random(5)
    for v in bm.verts:
        ao = 1.0
        if rays:
            n = v.normal.normalized(); ref = Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))
            t = n.cross(ref).normalized(); b = n.cross(t); hit = 0.0
            for _ in range(rays):
                r1, r2 = rnd.random(), rnd.random(); rr = math.sqrt(r1); th = math.tau * r2
                d = (t * (rr * math.cos(th)) + b * (rr * math.sin(th)) + n * math.sqrt(1 - r1)).normalized()
                if tree.ray_cast(v.co + n * 0.02, d, maxd)[0] is not None: hit += 1.0
            ao = 1 - 0.85 * hit / rays
        wear = 0.5
        for e in v.link_edges:
            if len(e.link_faces) == 2:
                a = e.calc_face_angle_signed(0)
                if a > 0.25: wear = max(wear, 0.5 + 0.5 * clamp(a / 0.9, 0, 1))
        v[lay] = (ao, wear, 0.0, 1.0)


def emit(P, name, col):
    bm = P.bm
    for f in bm.faces: f.smooth = True
    for mi, mname in enumerate(MATS):
        b2 = bm.copy()
        bmesh.ops.delete(b2, geom=[f for f in b2.faces if f.material_index != mi], context='FACES')
        bmesh.ops.delete(b2, geom=[v for v in b2.verts if not v.link_faces], context='VERTS')
        if not b2.faces: b2.free(); continue
        me = bpy.data.meshes.new(f'{name}_{mname}'); b2.to_mesh(me); b2.free()
        col.objects.link(bpy.data.objects.new(f'{name}_{mname}', me))


def main():
    only = int(sys.argv[1]) if len(sys.argv) > 1 else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.data.collections.new('towers'); bpy.context.scene.collection.children.link(col)
    specs = []
    for T in TOWERS:
        if only is not None and T['id'] != only: continue
        for lod in (0, 1, 2):
            B, F, cols = build_tower(T, lod)
            if lod == 0: bevel_all(B, 0.11, 2)
            if lod < 2: subdiv(B, 2.4 if lod == 0 else 4.5, 5 if lod == 0 else 3)
            B.append(F)
            bake(B, {0: 10, 1: 5, 2: 0}[lod])
            emit(B, f"b{T['id']}_l{lod}", col)
            print(f"tower {T['id']} lod{lod}: {len(B.bm.verts)} verts {len(B.bm.faces)} faces", flush=True)
            B.bm.free(); F.bm.free()
            if lod == 0:
                W, D = T['W'], T['D']
                specs.append(dict(id=T['id'], x=T['x'], z=T['z'], yaw=T['yaw'], door=None, roof=[], seed=T['seed'], canopy=False, tower=True,
                                  tiers=[dict(w=W + 3.2, d=D + 3.2, h=T['H'])], cols=[[round(c, 2) for c in b] for b in cols],
                                  **({'bridge': dict(deck=T['bridge']['deck'], dir=T['bridge']['dir'], wz=T['bridge']['wz'], end_x=T['bridge']['end_x'], stub_end=round(0.78 * D / 2 + 2.6, 2))} if T.get('bridge') else {})))
    out = os.path.join(ASSETS, 'towers.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_vertex_color='ACTIVE', export_yup=False, export_materials='NONE', export_apply=False)
    json.dump({'buildings': specs}, open(os.path.join(ASSETS, 'towers.json'), 'w'), indent=1)
    print('wrote', out, os.path.getsize(out) // 1024, 'KB')
    sys.stdout.flush(); os._exit(0)


if __name__ == '__main__':
    main()
