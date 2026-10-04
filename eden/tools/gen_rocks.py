"""Blender (bpy) asset generator: sculpted stylised rocks with baked vertex AO, 3 LODs each.
Run:  python3 gen_rocks.py   (needs `pip install bpy==4.2.0`)  ->  ../assets/rocks.glb
"""
import bpy, bmesh, math, random, os
from mathutils import Vector, noise, bvhtree

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'rocks.glb')
VARIANTS = 10
LODS = [6, 5, 4]            # bmesh icosphere levels -> 10k / 2.5k / 640 verts

def soft_min(vals, k):
    return -math.log(sum(math.exp(-k * v) for v in vals)) / k

def build(seed, detail):
    rnd = random.Random(seed)
    # large structural planes (shared by every LOD so the silhouettes match)
    planes = []
    for _ in range(5 + seed % 4):
        a = rnd.random() * math.tau; y = (rnd.random() - 0.35) * 1.2
        n = Vector((math.cos(a), y, math.sin(a))).normalized()
        planes.append((n, 0.6 + rnd.random() * 0.3))
    planes.append((Vector((0, 1, 0)), 0.55 + rnd.random() * 0.2))     # flat-ish top
    planes.append((Vector((0, -1, 0)), 0.4))                           # flat buried base
    k = 5.5 + rnd.random() * 2.0
    off = Vector((rnd.random() * 50, rnd.random() * 50, rnd.random() * 50))
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=1.0)
    for v in bm.verts:
        u = v.co.normalized()
        base = 1 + 0.12 * noise.fractal(u * 2.2 + off, 0.5, 2.0, 3)
        ts = [base]
        for n, d in planes:
            dn = n.dot(u)
            if dn > 0.02: ts.append(d / dn)
        t = soft_min(ts, k)
        # sculpted detail: medium chips + fine cracks (ridged noise)
        p = u * t
        chip = noise.fractal(p * 4.0 + off, 0.5, 2.0, 4) * 0.045
        crack = (1 - abs(noise.noise(p * 9.0 + off))) ** 6 * -0.035
        v.co = u * (t + chip + crack)
    bm.normal_update()
    me = bpy.data.meshes.new(f'rock{seed}_{detail}')
    bm.to_mesh(me); bm.free()
    for poly in me.polygons: poly.use_smooth = True
    return me

def bake_ao(me, rays=24, maxd=0.9):
    bm = bmesh.new(); bm.from_mesh(me)
    tree = bvhtree.BVHTree.FromBMesh(bm)
    rnd = random.Random(7)
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    for i, v in enumerate(bm.verts):
        n = v.normal.normalized()
        t = n.cross(Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))).normalized(); b = n.cross(t)
        hit = 0
        for _ in range(rays):
            r1, r2 = rnd.random(), rnd.random()
            rr = math.sqrt(r1); th = math.tau * r2
            d = (t * (rr * math.cos(th)) + b * (rr * math.sin(th)) + n * math.sqrt(1 - r1)).normalized()
            if tree.ray_cast(v.co + n * 0.002, d, maxd)[0] is not None: hit += 1
        ao = 1 - hit / rays
        attr.data[i].color = (ao, ao, ao, 1)
    bm.free()

bpy.ops.wm.read_factory_settings(use_empty=True)
col = bpy.data.collections.new('rocks'); bpy.context.scene.collection.children.link(col)
for s in range(VARIANTS):
    for l, detail in enumerate(LODS):
        me = build(s * 17 + 3, detail)
        bake_ao(me, rays=24 if l == 0 else 12)
        ob = bpy.data.objects.new(f'rock{s}_lod{l}', me); col.objects.link(ob)
        ob.location = (s * 3.5, l * 3.5, 0)
    print('rock', s, 'done', flush=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_vertex_color='ACTIVE',
                          export_apply=False, export_yup=False, export_materials='NONE')
print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')
