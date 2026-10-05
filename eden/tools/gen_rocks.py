"""Blender (bpy) asset generator: stylised sculpted rocks with baked vertex AO, 3 LODs each, plus snow caps.
Run:  python3 gen_rocks.py   (needs `pip install bpy==4.2.0`)  ->  ../assets/rocks.glb

Variant index ranges (mirrored in src/scatter.js):
    0-4   rounded boulders  (smooth pebble forms with a few soft planar flats)
    5-8   angular chunks    (plane-cut polyhedra: crisp faces, small rounded bevels, ledge grooves)
    9-11  slabs             (wide flat boulders, boxy plan, flat tops)
    12-14 strata stacks     (tiered buttes: stepped ledges, gullies, blocky plan, rounded dome cap)
Objects:  rock{i}_lod{0..2}  (unit scale, y up in game, base buried near y=-0.4)
          rock{i}_snow_lod{0,1} (thick rounded snow cap that sits on the up-facing part of the rock)
Blender y is exported as UP (export_yup=False).
The GLB is rewritten with int8 normals / ubyte colours (KHR_mesh_quantization); src/scatter.js reads them through the
normalised BufferAttribute accessors, so nothing needs expanding.
"""
import bpy, bmesh, math, random, os
from mathutils import Vector, noise, bvhtree

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'rocks.glb')

KINDS = ['boulder'] * 5 + ['chunk'] * 4 + ['slab'] * 3 + ['strata'] * 3
VARIANTS = len(KINDS)
# icosphere subdivision per LOD (bmesh: 6 -> 10242 verts, 5 -> 2562, 4 -> 642 ...)
ICO = {'boulder': [6, 5, 4], 'chunk': [6, 5, 4], 'slab': [6, 5, 4]}          # hero variants (3-12 m rocks seen from 3 m away)
ICO_SMALL = {'boulder': [5, 4, 3], 'chunk': [5, 4, 3], 'slab': [5, 4, 3]}   # variants only used for small rocks / rubble
HERO = {0, 1, 5, 6, 9}                                                         # indices that get the dense meshes (mirrored in scatter.js)
STRATA_RES = [(72, 84), (44, 52), (28, 32)]    # (angular, vertical) samples per LOD


def sstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def soft_min(vals, k):
    m = min(vals)
    return m - math.log(sum(math.exp(-k * (v - m)) for v in vals)) / k


def finish(bm, name):
    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    return me


# ── radial (star-shaped) rocks: boulders, chunks, slabs ──────────────────────────────────────
def build_radial(kind, seed, detail):
    rnd = random.Random(seed)
    off = Vector((rnd.random() * 50, rnd.random() * 50, rnd.random() * 50))
    planes = []
    if kind == 'boulder':
        # chunky block-rounded lump: a dominant top plane, 4-6 big side planes with different depths, generous bevels
        rad = (1.0, 0.62 + rnd.random() * 0.12, 0.84 + rnd.random() * 0.16)
        expo, k, topd, chip, crack, ledge = 2.5, 6.5 + rnd.random() * 2.5, 0.58 + rnd.random() * 0.08, 0.010, 0.0, 0.0
        n_pl = 4 + rnd.randint(0, 2)
        for i in range(n_pl):
            a = (i + rnd.random() * 0.8) / n_pl * math.tau
            y = (rnd.random() - 0.15) * 0.55
            planes.append((Vector((math.cos(a), y, math.sin(a))).normalized(), 0.66 + rnd.random() * 0.22))
    elif kind == 'chunk':
        rad = (1.0, 0.7 + rnd.random() * 0.2, 0.8 + rnd.random() * 0.2)
        expo, k, topd, chip, crack, ledge = 2.1, 7.0 + rnd.random() * 3.0, 0.62 + rnd.random() * 0.12, 0.006, 0.0, 0.016
        for _ in range(7 + rnd.randint(0, 2)):
            a = rnd.random() * math.tau; y = (rnd.random() - 0.35) * 1.2
            planes.append((Vector((math.cos(a), y, math.sin(a))).normalized(), 0.58 + rnd.random() * 0.30))
    else:  # slab
        rad = (1.0, 0.34 + rnd.random() * 0.1, 0.62 + rnd.random() * 0.22)
        expo, k, topd, chip, crack, ledge = 3.2, 8.0 + rnd.random() * 3.0, 0.30 + rnd.random() * 0.06, 0.006, 0.0, 0.016
        for _ in range(5 + rnd.randint(0, 2)):
            a = rnd.random() * math.tau; y = (rnd.random() - 0.4) * 0.5
            planes.append((Vector((math.cos(a), y, math.sin(a))).normalized(), 0.7 + rnd.random() * 0.22))
    # tilted flat top + flat buried base
    ta = rnd.random() * math.tau
    tilt = 0.10 + rnd.random() * 0.12
    planes.append((Vector((math.cos(ta) * tilt, 1, math.sin(ta) * tilt)).normalized(), topd))
    planes.append((Vector((0, -1, 0)), 0.40 if kind != 'slab' else 0.2))

    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=1.0)
    smooth = []          # detail-free positions (same vertex order): the snow cap derives its mask and shading normals from these
    for v in bm.verts:
        u = v.co.normalized()
        # superellipsoid extent along u
        s = (abs(u.x / rad[0]) ** expo + abs(u.y / rad[1]) ** expo + abs(u.z / rad[2]) ** expo) ** (-1.0 / expo)
        base = s * (1 + 0.10 * noise.fractal(u * 1.8 + off, 0.5, 2.0, 2))
        ts = [base]
        for n, d in planes:
            dn = n.dot(u)
            if dn > 0.02:
                ts.append(d / dn)
        t = soft_min(ts, k)
        p = u * t
        smooth.append(p.copy())
        r = t
        # chips (medium facets), fine ridged cracks, and subtle horizontal ledge grooves (strata)
        r += noise.fractal(p * 2.4 + off, 0.5, 2.0, 3) * chip
        if crack:
            r -= (1 - abs(noise.noise(p * 7.0 + off))) ** 7 * crack * 1.4
        if ledge:
            r += ledge * (sstep(0.0, 0.18, (p.y * 3.1 + noise.noise(p * 0.8 + off) * 0.5) % 1.0) - 0.5) * (1 if abs(u.y) < 0.8 else 0.3)
        v.co = u * r
    me = finish(bm, f'rk{seed}_{detail}')
    me['smooth'] = [c for p in smooth for c in p]
    return me


# ── strata stacks: tiered buttes, solid of revolution with stepped ledges ─────────────────
def build_strata(seed, res):
    nth, nrow = res
    rnd = random.Random(seed)
    off = Vector((rnd.random() * 40, rnd.random() * 40, rnd.random() * 40))
    tiers = 3 + rnd.randint(0, 2)
    ytop = 0.78 + rnd.random() * 0.22
    ybot = -0.45
    # tier boundaries (heights), irregular
    ws = [0.6 + rnd.random() for _ in range(tiers)]
    tot = sum(ws)
    ys, acc = [], ybot
    for w in ws:
        acc += (ytop - ybot) * w / tot
        ys.append(acc)                               # top of each tier
    rm, expo, phi, batter, gully = [], [], [], [], []
    r0 = 0.88 + rnd.random() * 0.12
    for i in range(tiers):
        rm.append(r0)
        r0 *= 0.66 + rnd.random() * 0.26             # each tier steps in (sometimes barely)
        expo.append(2.6 + rnd.random() * 1.8)
        phi.append(rnd.random() * math.pi)
        batter.append((rnd.random() - 0.5) * 0.16)  # +: leans in, -: overhangs
        gully.append((rnd.random() * math.tau, 0.12 + rnd.random() * 0.1, 0.08 + rnd.random() * 0.1))
    ledge_w = 0.045

    def radius_at(y, th):
        # tier index by smooth blend across risers
        R = 0.0
        prev = rm[0]
        R = rm[0]
        for i in range(tiers - 1):
            t = sstep(ys[i] - ledge_w, ys[i] + ledge_w * 0.6, y)
            R = R + (rm[i + 1] - R) * t
        # which tier dominates plan shape / batter
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
        pl = math.hypot(px, pz)                      # plan-shape extent factor (>=1 for squarish)
        # blocky radial offsets: planar segments with rounded kinks, gullies
        blk = noise.fractal(Vector((math.cos(th) * 1.6, math.sin(th) * 1.6, ti * 3.1)) + off, 0.5, 2.0, 2) * 0.10
        gth, gw, gd = gully[ti]
        dth = (th - gth + math.pi) % math.tau - math.pi
        g = gd * math.exp(-(dth / gw) ** 2) * sstep(lo, lo + (hi - lo) * 0.5, y)
        return max(0.05, R * (1 + blk - g)), px, pz

    bm = bmesh.new()
    rows = []
    # rows from base to top; the top few rows form a rounded flat dome
    for j in range(nrow + 1):
        t = j / nrow
        y = ybot + (ytop - ybot) * t * 1.0
        ring = []
        for i in range(nth):
            th = (i / nth) * math.tau
            R, px, pz = radius_at(y, th)
            # dome: over the last 8% pull radius in with an elliptical profile
            dome = 1.0
            if t > 0.92:
                q = (t - 0.92) / 0.08
                dome = math.sqrt(max(0.0, 1 - q * q))
                y2 = y - (ytop - ybot) * 0.0
            ring.append(bm.verts.new(Vector((R * px * dome, y, R * pz * dome))))
        rows.append(ring)
    # bottom cap (buried)
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
    # merge duplicate verts at the poles
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    return finish(bm, f'rs{seed}_{nth}')


# ── baked vertex AO ─────────────────────────────────────────────────────────────────────────
def bake_ao(me, rays=24, maxd=0.9):
    bm = bmesh.new(); bm.from_mesh(me)
    bm.normal_update()
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
            if tree.ray_cast(v.co + n * 0.002, d, maxd)[0] is not None:
                hit += 1
        ao = 1 - hit / rays
        # buried underside is darker; soft sky gradient so the base reads cooler/darker
        ao *= 0.50 + 0.50 * sstep(-0.42, 0.30, v.co.y)
        attr.data[i].color = (ao, ao, ao, 1)
    bm.free()


# ── snow cap: thick rounded blanket on the up-facing part of a rock ───────────────────────
def snow_cap(src_me, seed, thick):
    """Duplicate faces whose verts are up-facing, push them out along the normal with a rounded falloff.
    The mask AND the shading normals come from the detail-free base shape (chips / ledge grooves / gullies removed), so the
    contour the game thresholds (COLOR_0.r > 0.5) is one smooth flowing line and the cap shades like a clean snow pillow."""
    rnd = random.Random(seed)
    off = Vector((rnd.random() * 30, rnd.random() * 30, rnd.random() * 30))
    bm = bmesh.new(); bm.from_mesh(src_me)
    bm.normal_update()
    # the source mesh carries the baked-AO colour layer 'Col': drop it, otherwise the mask layer below would collide with it
    # (the exported COLOR_0 would be the noisy per-vertex AO and the snow border would turn into a sawtooth)
    for layer in list(bm.verts.layers.float_color):
        bm.verts.layers.float_color.remove(layer)
    sm_pos = src_me.get('smooth')
    bms = bmesh.new(); bms.from_mesh(src_me)
    if sm_pos is not None:
        for v in bms.verts:
            v.co = Vector((sm_pos[v.index * 3], sm_pos[v.index * 3 + 1], sm_pos[v.index * 3 + 2]))
    bms.normal_update()
    nrm = {v.index: v.normal.copy() for v in bms.verts}
    # a few Jacobi passes on the base normals: removes the last vertex-level noise
    for _ in range(3):
        nn = {}
        for v in bms.verts:
            acc = nrm[v.index].copy()
            for e in v.link_edges:
                acc += nrm[e.other_vert(v).index]
            nn[v.index] = acc.normalized()
        nrm = nn
    spos = {v.index: v.co.copy() for v in bms.verts}
    bms.free()
    lm = bm.verts.layers.float.new('m')
    ln = bm.verts.layers.float_vector.new('n')
    lsn = bm.verts.layers.float_vector.new('sn')
    for v in bm.verts:
        n = nrm[v.index]
        nz = noise.fractal(spos[v.index] * 1.5 + off, 0.5, 2.0, 2) * 0.10
        # snow settles on up-facing faces and gentle upper flanks, never on the buried underside
        v[lm] = sstep(0.40, 0.86, n.y + nz) * sstep(-0.30, 0.05, spos[v.index].y)
        v[ln] = v.normal
        v[lsn] = n
    # diffuse the mask over the mesh (Jacobi smoothing, ~2 edge lengths) so the contour is one flowing line
    for _ in range(7):
        new = {}
        for v in bm.verts:
            acc, cnt = v[lm], 1
            for e in v.link_edges:
                acc += e.other_vert(v)[lm]; cnt += 1
            new[v.index] = acc / cnt
        for v in bm.verts:
            v[lm] = new[v.index]
    for v in bm.verts:
        v[lm] = sstep(0.12, 0.88, v[lm])
    dele = [f for f in bm.faces if max(v[lm] for v in f.verts) < 0.12]
    bmesh.ops.delete(bm, geom=dele, context='FACES')
    for v in list(bm.verts):
        if not v.link_faces:
            bm.verts.remove(v)
    fc = bm.verts.layers.float_color.new('Col')
    for v in bm.verts:
        m = v[lm]
        n = Vector(v[lsn])
        lump = 1 + 0.10 * noise.fractal(spos[v.index] * 1.3 + off, 0.5, 2.0, 2)
        # rounded thickness profile: full blanket where the surface faces up, easing to a thin lip toward the contour
        t = thick * sstep(0.46, 1.0, m) * lump
        v.co = v.co + n * (t + 0.012)          # always lifted clear of the rock body: no coincident surfaces, so no z-fight teeth along the border
        # the mask rides along in COLOR_0.r; the game's cap shader discards pixels below 0.5, giving a smooth,
        # per-pixel contour instead of triangle-jagged edges
        v[fc] = (m, m, m, 1.0)
    vnorms = [Vector(v[lsn]) for v in bm.verts]
    me = bpy.data.meshes.new('cap')
    bm.to_mesh(me); bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    me.normals_split_custom_set_from_vertices(vnorms)       # shade with the clean base-shape normals
    return me


def add_color(me, value=1.0):
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    for i in range(len(me.vertices)):
        attr.data[i].color = (value, value, value, 1)


def quantize_glb(path):
    """rewrite the GLB with compact vertex data: NORMAL int8 (normalized), COLOR_0 ubyte (normalized) -> KHR_mesh_quantization
    (about half the bytes per vertex; three's GLTFLoader keeps them as normalised attributes)."""
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


bpy.ops.wm.read_factory_settings(use_empty=True)
col = bpy.data.collections.new('rocks'); bpy.context.scene.collection.children.link(col)
for s in range(VARIANTS):
    kind = KINDS[s]
    seed = s * 17 + 3
    meshes = []
    for l in range(3):
        if kind == 'strata':
            me = build_strata(seed, STRATA_RES[l])
        else:
            me = build_radial(kind, seed, (ICO if s in HERO else ICO_SMALL)[kind][l])
        bake_ao(me, rays=24 if l == 0 else 12)
        ob = bpy.data.objects.new(f'rock{s}_lod{l}', me); col.objects.link(ob)
        ob.location = (s * 3.5, l * 3.5, 0)
        meshes.append(me)
    # snow caps are built on the same-resolution mesh (LOD0 cap on LOD0 body, LOD1 on LOD1) so the contour is smooth
    for l in range(2):
        cap = snow_cap(meshes[l], seed + 101, 0.105 if kind != 'slab' else 0.08)
        ob = bpy.data.objects.new(f'rock{s}_snow_lod{l}', cap); col.objects.link(ob)
        ob.location = (s * 3.5, l * 3.5, 0)
    print('rock', s, kind, 'done', flush=True)
TMP = OUT + '.tmp.glb'
bpy.ops.export_scene.gltf(filepath=TMP, export_format='GLB', export_vertex_color='ACTIVE',
                          export_apply=False, export_yup=False, export_materials='NONE')
quantize_glb(TMP)
os.replace(TMP, OUT)
print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')
