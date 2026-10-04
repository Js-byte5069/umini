"""Blender (bpy) props: faceted needle spires, leaning slabs, corrugated containers, lattice pylons.
Run: python3 gen_props.py  ->  ../assets/props.glb   (objects named  spire{i}_l{lod}_{mat} / slab… / container… / pylon…)
"""
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, Matrix
from gen_buildings import Mod, MI, MATS, facade, bevel_all, bake_ao, subdiv, emit

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'props.glb')


def frustum(M, y0, y1, rb, rt, n, rot, cx, cz, mat, squash=0.84, accent_faces=0, rnd=None, accent_mat='accent'):
    bm = M.bm
    v = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=n, radius1=rt, radius2=rb, depth=y1 - y0)
    verts = v['verts']
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'), verts=verts)   # axis Z → Y
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(rot, 3, 'Y'), verts=verts)
    bmesh.ops.scale(bm, vec=(1, 1, squash), verts=verts)
    bmesh.ops.translate(bm, vec=(cx, (y0 + y1) / 2, cz), verts=verts)
    faces = list({f for x in verts for f in x.link_faces})
    for f in faces: f.normal_update()
    side = [f for f in faces if abs(f.normal.y) < 0.6]
    for f in faces: f.material_index = MI[mat]
    if accent_faces and rnd:
        for f in rnd.sample(side, min(accent_faces, len(side))):
            ins = bmesh.ops.inset_individual(bm, faces=[f], thickness=(rb + rt) * 0.06, use_even_offset=True)
            f.normal_update()
            ret = bmesh.ops.extrude_face_region(bm, geom=[f])
            bmesh.ops.delete(bm, geom=[f], context='FACES_ONLY')
            nv = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)]
            nf = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMFace)]
            nrm = f.normal.copy() if f.is_valid else Vector((0, 0, 1))
            bmesh.ops.translate(bm, vec=nrm * 0.0, verts=nv)
            for g in nf: g.normal_update(); g.material_index = MI[accent_mat]
    return faces


def spire(seed, lod):
    r = random.Random(seed)
    M = Mod()
    n = r.choice([7, 8, 9]) if lod < 2 else 6
    H, W = 100.0, 6.0
    tiers = r.randint(5, 7) if lod < 2 else 3
    shaft = H * 0.82
    cuts = sorted([0] + [shaft * (k / tiers) + r.uniform(-1, 1) * shaft / tiers * 0.18 for k in range(1, tiers)] + [shaft])
    lean = r.uniform(-0.04, 0.04)
    cx = 0.0
    rot = r.random()
    # buried skirt
    frustum(M, -8, 2, W * 1.35, W * 1.15, n, rot, 0, 0, 'wallDark')
    rad = W * 1.1
    for k in range(tiers):
        y0, y1 = cuts[k], cuts[k + 1]
        taper = 1 - 0.72 * (y1 / shaft)
        rb = rad; rt = W * taper
        rot_k = rot + r.uniform(-0.18, 0.18) * (k > 0)
        ox = lean * y0 * 4 + r.uniform(-0.35, 0.35) * (k > 0)
        frustum(M, y0, y1, rb, rt, n, rot_k, ox, 0, 'wall', accent_faces=(2 if lod < 2 else 0), rnd=r)
        if lod < 2 and k < tiers - 1:        # collar ledge
            frustum(M, y1 - 0.2, y1 + 1.4, rt * 1.1, rt * 1.06, n, rot_k, ox, 0, 'wallLight')
        rad = rt * 0.97
        cx = ox
    top = shaft
    tr = W * (1 - 0.72)
    frustum(M, top, top + H * 0.1, tr, tr * 0.5, n, rot, cx, 0, 'wall')
    frustum(M, top + H * 0.1, top + H * 0.2, tr * 0.5, 0.03, n, rot, cx, 0, 'wall')
    # base buttress fins
    if lod < 3:
        for i in range(4):
            a = rot + i * math.pi / 2 + math.pi / 4
            frustum(M, -4, H * 0.22, 3.0, 0.3, 4, a, math.cos(a) * W * 1.15, math.sin(a) * W * 1.0, 'wallLight', squash=0.4)
    return M


def slab(seed, lod, accent):
    r = random.Random(seed)
    M = Mod()
    w, h, t = 14.0, 40.0, 6.0
    body_h = h * 0.74
    mat = 'accent' if accent else 'wall'
    M.box((0, body_h / 2, 0), (w - 0.6, body_h, t - 0.6), 'wallDark')
    if lod < 2:
        rects = []
        for row in range(5):
            y0 = 1.2 + row * 7.0; y1 = y0 + 5.6
            if y1 > body_h - 0.8: break
            rects.append(('panel', -w / 2 + 1.5, y0, -0.7, y1))
            rects.append(('panel', 0.7, y0, w / 2 - 1.5, y1))
        for face in ('z+', 'z-'):
            facade(M, face, w, body_h, 0.0, w, t, rects, lod)
        for face in ('x+', 'x-'):
            facade(M, face, t, body_h, 0.0, w, t, [('panel', -t / 2 + 0.9, 1.2, t / 2 - 0.9, body_h - 1.0)], lod)
    else:
        M.box((0, body_h / 2, 0), (w, body_h, t), 'wall')
    # broken crown (extruded jagged profile)
    pts = [(-w / 2, body_h), (w / 2, body_h), (w / 2, body_h + h * 0.18 * r.uniform(0.8, 1.2)), (w * 0.22, body_h + h * 0.26 * r.uniform(0.8, 1.2)),
           (w * 0.04, body_h + h * 0.12), (-w * 0.18, body_h + h * 0.22 * r.uniform(0.8, 1.2)), (-w / 2, body_h + h * 0.08)]
    bm = M.bm
    vs = [bm.verts.new((x, y, t / 2)) for x, y in pts]
    f = bm.faces.new(vs); f.material_index = MI[mat]; f.normal_update()
    if f.normal.z < 0: bmesh.ops.reverse_faces(bm, faces=[f])
    ret = bmesh.ops.extrude_face_region(bm, geom=[f])
    nv = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, 0, -t), verts=nv)
    for g in ret['geom']:
        if isinstance(g, bmesh.types.BMFace): g.material_index = MI[mat]
    # cornice bands
    if lod < 2:
        for yy in (body_h * 0.36, body_h - 0.4):
            M.box((0, yy, 0), (w + 0.7, 0.6, t + 0.7), 'trim')
        M.box((0, 0.5, 0), (w + 1.0, 1.4, t + 1.0), 'wallDark')
    return M


def container(seed, lod):
    r = random.Random(seed)
    M = Mod()
    L, Hh, Wd = 6.1, 2.6, 2.5
    M.box((0, Hh / 2 + 0.1, 0), (L, Hh, Wd), 'metal')
    if lod < 2:
        for sz in (-1, 1):
            n = int(L / 0.28) if lod == 0 else int(L / 0.6)
            for i in range(n):
                x = -L / 2 + 0.35 + (L - 0.7) * i / (n - 1)
                M.box((x, Hh / 2 + 0.1, sz * (Wd / 2 + 0.03)), (0.14, Hh - 0.35, 0.07), 'wallLight')
        for sx in (-1, 1):
            for sz in (-1, 1):
                for sy in (0.1, Hh + 0.1):
                    M.box((sx * (L / 2 - 0.1), sy, sz * (Wd / 2 - 0.1)), (0.34, 0.34, 0.34), 'trim')
        # end doors with locking bars + handles
        for sz in (-1, 1):
            M.box((L / 2 + 0.04, Hh / 2 + 0.1, sz * Wd / 4), (0.1, Hh - 0.3, Wd / 2 - 0.15), 'wallDark')
            for k in range(2):
                M.cyl((L / 2 + 0.15, Hh / 2 + 0.1, sz * (Wd / 4 + (k - 0.5) * 0.3)), 0.04, Hh - 0.3, 'trim', 8)
            M.box((L / 2 + 0.2, 1.2, sz * Wd / 4), (0.1, 0.1, 0.4), 'trim')
        M.box((0, Hh + 0.12, 0), (L + 0.08, 0.14, Wd + 0.08), 'trim')
    return M


def pylon(seed, lod):
    """lattice support leg: 4 corner posts, ring beams, X bracing — hollow, see-through structure"""
    M = Mod()
    Hh = 12.0
    b0, b1 = 1.3, 0.8
    M.box((0, 0.2, 0), (b0 * 2 + 1.2, 0.8, b0 * 2 + 1.2), 'wallDark')
    segs = 4 if lod < 2 else 2
    for i in range(segs):
        ya, yb = Hh * i / segs, Hh * (i + 1) / segs
        ra = b0 + (b1 - b0) * i / segs; rb = b0 + (b1 - b0) * (i + 1) / segs
        for sx in (-1, 1):
            for sz in (-1, 1):
                M.cyl(((sx * ra + sx * rb) / 2, (ya + yb) / 2 + 0.3, (sz * ra + sz * rb) / 2), 0.14, yb - ya, 'wall', 8)
        if lod < 2:
            for (ax, az, bx, bz) in ((ra, ra, rb, -rb), (ra, -ra, rb, ra)):   # X braces on the two visible axes
                pass
            for (sx, sz) in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
                pass
        # horizontal ring beams
        M.box((0, yb + 0.3, 0), (rb * 2 + 0.3, 0.2, rb * 2 + 0.3), 'trim') if False else None
        for s in (-1, 1):
            M.box((0, yb + 0.3, s * rb), (rb * 2, 0.2, 0.2), 'trim')
            M.box((s * rb, yb + 0.3, 0), (0.2, 0.2, rb * 2), 'trim')
        # diagonals (thin boxes rotated in each of the 4 vertical planes)
        if lod < 2:
            for s in (-1, 1):
                ang = math.atan2(yb - ya, ra + rb)
                length = math.hypot(yb - ya, ra + rb)
                M.box((0, (ya + yb) / 2 + 0.3, s * (ra + rb) / 2), (length, 0.12, 0.12), 'metal', rot=(0, 0, ang))
                M.box((0, (ya + yb) / 2 + 0.3, s * (ra + rb) / 2), (length, 0.12, 0.12), 'metal', rot=(0, 0, -ang))
                M.box((s * (ra + rb) / 2, (ya + yb) / 2 + 0.3, 0), (0.12, 0.12, length), 'metal', rot=(ang, 0, 0))
                M.box((s * (ra + rb) / 2, (ya + yb) / 2 + 0.3, 0), (0.12, 0.12, length), 'metal', rot=(-ang, 0, 0))
    M.box((0, Hh + 0.55, 0), (b1 * 2 + 0.9, 0.7, b1 * 2 + 0.9), 'wallLight')
    return M


if __name__ == '__main__':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.data.collections.new('props'); bpy.context.scene.collection.children.link(col)
    jobs = []
    for i in range(6): jobs.append((f'spire{i}', lambda l, i=i: spire(i * 11 + 2, l), dict(bevel=0.14, sub=3.0, maxd=10.0)))
    for i in range(3): jobs.append((f'slab{i}', lambda l, i=i: slab(i * 7 + 1, l, False), dict(bevel=0.1, sub=1.8, maxd=4.0)))
    for i in range(3): jobs.append((f'slabr{i}', lambda l, i=i: slab(i * 7 + 1, l, True), dict(bevel=0.1, sub=1.8, maxd=4.0)))
    jobs.append(('container0', lambda l: container(1, l), dict(bevel=0.04, sub=0.9, maxd=1.5)))
    jobs.append(('pylon0', lambda l: pylon(1, l), dict(bevel=0.04, sub=1.5, maxd=2.5)))
    for name, fn, o in jobs:
        for lod in (0, 1, 2):
            M = fn(lod)
            if lod == 0: bevel_all(M, o['bevel'], 2)
            if lod < 2: subdiv(M, o['sub'] if lod == 0 else o['sub'] * 2, 3 if lod == 0 else 2)
            bake_ao(M, rays={0: 12, 1: 6, 2: 0}[lod], maxd=o['maxd'])
            emit(M, None, f'{name}_l{lod}', smooth=(lod == 0), col=col)
            print(name, lod, len(M.bm.faces), flush=True)
            M.bm.free()
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_vertex_color='ACTIVE', export_yup=False, export_materials='NONE', export_apply=False)
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')
