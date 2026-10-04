"""Blender (bpy) building generator.
Real modelled geometry: recessed wall panels & stepped slit windows (extruded in the mesh, not faked),
bevelled edges, buttress piers, galleries, pipes, roof equipment, baked vertex AO. 3 LODs per building.
Run:  python3 gen_buildings.py [only_id]   ->  ../assets/buildings.glb  (+ ../assets/buildings.json copy)
"""
import bpy, bmesh, json, math, os, random, sys, time, shutil
from mathutils import Vector, Matrix, bvhtree

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'assets', 'buildings.glb')
SPEC = json.load(open(os.path.join(HERE, 'buildings.json')))['buildings']
MATS = ['wall', 'wallLight', 'wallDark', 'trim', 'metal', 'accent', 'accentDark', 'glass', 'deck']
MI = {m: i for i, m in enumerate(MATS)}
FACE = 1.1


class Mod:
    """bmesh wrapper; y is up, face material = index into MATS."""
    def __init__(self): self.bm = bmesh.new()

    def _mat(self, verts, mat):
        for f in {f for v in verts for f in v.link_faces}: f.material_index = MI[mat]

    def box(self, c, s, mat, rot=None):
        v = bmesh.ops.create_cube(self.bm, size=1.0)['verts']
        bmesh.ops.scale(self.bm, vec=s, verts=v)
        if rot: bmesh.ops.rotate(self.bm, cent=(0, 0, 0), matrix=Matrix.Rotation(rot[0], 3, 'X') @ Matrix.Rotation(rot[1], 3, 'Y') @ Matrix.Rotation(rot[2], 3, 'Z'), verts=v)
        bmesh.ops.translate(self.bm, vec=c, verts=v)
        self._mat(v, mat)

    def cyl(self, c, r, h, mat, seg=20, r2=None, axis='Y'):
        v = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)['verts']
        # bmesh cone axis is +Z → rotate to requested axis
        if axis == 'Y': bmesh.ops.rotate(self.bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'), verts=v)
        elif axis == 'X': bmesh.ops.rotate(self.bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'), verts=v)
        bmesh.ops.translate(self.bm, vec=c, verts=v)
        self._mat(v, mat)

    def dome(self, c, r, mat):
        v = bmesh.ops.create_uvsphere(self.bm, u_segments=24, v_segments=10, radius=r)['verts']
        bmesh.ops.scale(self.bm, vec=(1, 0.5, 1), verts=v)
        dele = [x for x in v if x.co.y < -1e-4]
        bmesh.ops.delete(self.bm, geom=dele, context='VERTS')
        bmesh.ops.translate(self.bm, vec=c, verts=[x for x in v if x.is_valid])
        self._mat([x for x in v if x.is_valid], mat)

    def append(self, other, xf):
        me = bpy.data.meshes.new('tmp'); other.bm.to_mesh(me)
        n0 = len(self.bm.verts)
        self.bm.from_mesh(me)
        vs = list(self.bm.verts)[n0:]
        bmesh.ops.transform(self.bm, matrix=xf, verts=vs)
        bpy.data.meshes.remove(me)


def face_xf(face, plane_w, plane_d, y0):
    """local facade frame (u along face, v up, n outward) → building frame"""
    if face == 'z+': return Matrix.Translation((0, y0, plane_d / 2)), Vector((0, 0, 1))
    if face == 'z-': return Matrix.Translation((0, y0, -plane_d / 2)) @ Matrix.Rotation(math.pi, 4, 'Y'), Vector((0, 0, -1))
    if face == 'x+': return Matrix.Translation((plane_w / 2, y0, 0)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'), Vector((1, 0, 0))
    return Matrix.Translation((-plane_w / 2, y0, 0)) @ Matrix.Rotation(-math.pi / 2, 4, 'Y'), Vector((-1, 0, 0))


def layout(W, H, t, r, door):
    gf, fh = t.get('gf', 6.0), t.get('fh', 5.2)
    nf = max(0, int((H - gf - 1.6) // fh))
    margin = 2.2
    nc = max(1, round((W - 2 * margin) / t.get('bay', 7.0)))
    bw = (W - 2 * margin) / nc
    winp = t.get('windows', 0.1)
    rects = []   # (kind, x0, y0, x1, y1)
    for f in range(nf + 1):
        base = 0 if f == 0 else gf + (f - 1) * fh
        rh = gf if f == 0 else fh
        for c in range(nc):
            cx = -W / 2 + margin + (c + 0.5) * bw
            if door and f == 0 and abs(cx) < 3.2: continue
            if r.random() < winp:
                ww = bw * 0.26
                rects.append(('win', cx - ww / 2, base + rh * 0.2, cx + ww / 2, base + rh * 0.8))
            else:
                rects.append(('panel', cx - bw * 0.40, base + 0.6, cx + bw * 0.40, base + rh - 0.55))
    if door: rects.append(('door', -2.3, 0.0, 2.3, 5.6))
    pil = [-W / 2 + margin + c * bw for c in range(1, nc)]
    return rects, pil, gf, fh


def uniq(vals, eps=1e-4):
    out = []
    for v in sorted(vals):
        if not out or v - out[-1] > eps: out.append(v)
    return out


def facade(M, face, W, H, y0, plane_w, plane_d, rects, lod):
    """wall grid on the outer plane; panels/windows/door are extruded INTO the wall"""
    bm = bmesh.new()
    xs = uniq([-W / 2, W / 2] + [x for r in rects for x in (r[1], r[3])])
    ys = uniq([0, H] + [y for r in rects for y in (r[2], r[4])])
    grid = {}
    vert = [[bm.verts.new((x, y, 0)) for x in xs] for y in ys]
    cells = {}
    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            f = bm.faces.new((vert[j][i], vert[j][i + 1], vert[j + 1][i + 1], vert[j + 1][i]))
            f.material_index = MI['wall']
            cells[(i, j)] = f
    for kind, x0, y0_, x1, y1 in rects:
        fs = [f for (i, j), f in cells.items() if x0 - 1e-4 <= (xs[i] + xs[i + 1]) / 2 <= x1 + 1e-4 and y0_ - 1e-4 <= (ys[j] + ys[j + 1]) / 2 <= y1 + 1e-4 and f.is_valid]
        if not fs: continue
        depth, floor_mat = {'panel': (0.18, 'wall'), 'win': (0.3, 'wall'), 'door': (0.8, 'wallDark')}[kind]
        ret = bmesh.ops.extrude_face_region(bm, geom=fs)
        bmesh.ops.delete(bm, geom=fs, context='FACES_ONLY')
        nv = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, vec=(0, 0, -depth), verts=nv)
        for g in ret['geom']:
            if isinstance(g, bmesh.types.BMFace): g.normal_update()
        caps = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMFace) and g.normal.z > 0.9]
        for f in caps: f.material_index = MI[floor_mat]
        if kind == 'win' and lod == 0:
            # stepped slit: inset the recess floor, then punch a deeper glazed pocket
            ins = bmesh.ops.inset_region(bm, faces=caps, thickness=0.32, depth=0.0, use_even_offset=True)
            caps = [f for f in caps if f.is_valid]
            ret2 = bmesh.ops.extrude_face_region(bm, geom=caps)
            bmesh.ops.delete(bm, geom=caps, context='FACES_ONLY')
            nv2 = [g for g in ret2['geom'] if isinstance(g, bmesh.types.BMVert)]
            bmesh.ops.translate(bm, vec=(0, 0, -0.7), verts=nv2)
            for g in ret2['geom']:
                if isinstance(g, bmesh.types.BMFace): g.normal_update()
            for f in [g for g in ret2['geom'] if isinstance(g, bmesh.types.BMFace) and g.normal.z > 0.9]: f.material_index = MI['glass']
        elif kind == 'win':
            for f in caps: f.material_index = MI['glass']
    me = bpy.data.meshes.new('fac'); bm.to_mesh(me); bm.free()
    tmp = Mod(); tmp.bm.from_mesh(me); bpy.data.meshes.remove(me)
    xf, out = face_xf(face, plane_w, plane_d, y0)
    # keep outward-facing winding
    bmesh.ops.transform(tmp.bm, matrix=xf, verts=list(tmp.bm.verts))
    tmp.bm.normal_update()
    cen = sum((f.normal for f in tmp.bm.faces if f.calc_center_median().y > 0), Vector()) / max(1, len(tmp.bm.faces))
    ref = max(tmp.bm.faces, key=lambda f: f.calc_area())
    if ref.normal.dot(out) < 0: bmesh.ops.reverse_faces(tmp.bm, faces=list(tmp.bm.faces))
    M.append(tmp, Matrix.Identity(4))


def build(spec, lod):
    r = random.Random(spec['seed'])
    M = Mod()
    y0 = 0.0
    tiers = spec['tiers']
    for ti, t in enumerate(tiers):
        w, d, H = t['w'], t['d'], t['h']
        ox = t.get('ox', 0)
        sub = Mod()
        # core slightly inside the wall plane so recess floors read as separate dark wall
        sub.box((0, y0 + H / 2, 0), (w - 1.6, H, d - 1.6), 'wallDark')
        if lod < 2:
            for face in ('z+', 'z-', 'x+', 'x-'):
                W = w if face[0] == 'z' else d
                rects, pil, gf, fh = layout(W, H, t, r, ti == 0 and spec.get('door') == face)
                facade(sub, face, W, H, y0, w, d, rects, lod)
                if lod == 0:
                    for px in pil:
                        c = {'z+': (px, y0 + H / 2, d / 2 + 0.2), 'z-': (-px, y0 + H / 2, -d / 2 - 0.2), 'x+': (w / 2 + 0.2, y0 + H / 2, -px), 'x-': (-w / 2 - 0.2, y0 + H / 2, px)}[face]
                        s = (1.1, H - 0.8, 0.7) if face[0] == 'z' else (0.7, H - 0.8, 1.1)
                        sub.box(c, s, 'trim')
        else:
            sub.box((0, y0 + H / 2, 0), (w, H, d), 'wall')
        # corner buttresses
        for sx in (-1, 1):
            for sz in (-1, 1):
                sub.box((sx * (w / 2 - 0.1), y0 + H / 2, sz * (d / 2 - 0.1)), (2.4, H + 0.2, 2.4), 'wallLight' if lod else 'trim')
                if lod == 0: sub.box((sx * (w / 2 - 0.1), y0 + H + 0.35, sz * (d / 2 - 0.1)), (3.0, 0.7, 3.0), 'wallLight')
        # cornice + parapet
        sub.box((0, y0 + H - 0.2, 0), (w + 0.9, 0.85, d + 0.9), 'trim')
        pt, ph = 0.7, 1.0
        sub.box((0, y0 + H + 0.65, d / 2 - 0.5), (w - 0.1, ph, pt), 'wallLight')
        sub.box((0, y0 + H + 0.65, -d / 2 + 0.5), (w - 0.1, ph, pt), 'wallLight')
        sub.box((w / 2 - 0.5, y0 + H + 0.65, 0), (pt, ph, d - 2 * pt - 0.1), 'wallLight')
        sub.box((-w / 2 + 0.5, y0 + H + 0.65, 0), (pt, ph, d - 2 * pt - 0.1), 'wallLight')
        if lod == 0:
            gf, fh = t.get('gf', 6.0), t.get('fh', 5.2)
            y = gf + fh * 2 - 0.1
            while y < H - 3:
                sub.box((0, y0 + y, 0), (w + 0.45, 0.42, d + 0.45), 'trim'); y += fh * 3
        # accent slabs (segmented)
        for a in t.get('accent', []):
            segH, gap = 8.2, 0.22
            yy, to = 1.2, min(H - 1.6, H - 0.8)
            while yy < to - 1:
                sh = min(segH, to - yy)
                u = a.get('x', 0)
                cc = {'z+': (u, 0, d / 2 + 0.25), 'z-': (-u, 0, -d / 2 - 0.25), 'x+': (w / 2 + 0.25, 0, -u), 'x-': (-w / 2 - 0.25, 0, u)}[a['face']]
                ss = (a['w'] * 1.25, sh - gap, 0.7) if a['face'][0] == 'z' else (0.7, sh - gap, a['w'] * 1.25)
                sub.box((cc[0], y0 + yy + sh / 2, cc[2]), ss, 'accent')
                if lod == 0 and sh > 3:
                    s2 = (a['w'] * 1.25 - 1.0, sh - gap - 1.1, 0.25) if a['face'][0] == 'z' else (0.25, sh - gap - 1.1, a['w'] * 1.25 - 1.0)
                    k = 0.5 if a['face'][1] == '+' else -0.5
                    sub.box((cc[0] + (0 if a['face'][0] == 'z' else k), y0 + yy + sh / 2, cc[2] + (k if a['face'][0] == 'z' else 0)), s2, 'accentDark')
                yy += sh
        # plinth + steps
        if ti == 0:
            sub.box((0, -0.1, 0), (w + 0.9, 1.5, d + 0.9), 'wallDark')
            if spec.get('door') and lod < 2:
                side = spec['door']; horiz = side[0] == 'z'; sg = 1 if side[1] == '+' else -1
                for s_ in range(3):
                    off = (d if horiz else w) / 2 + 0.8 + (2 - s_) * 0.8 + 0.6
                    hgt = 0.2 * (s_ + 1) + 0.4
                    c = (0, 0.2 * s_ + 0.1 - 0.2 + hgt / 2 - 0.1, sg * off) if horiz else (sg * off, 0.2 * s_ + hgt / 2 - 0.1, 0)
                    sub.box(c, (5.4, hgt, 1.6) if horiz else (1.6, hgt, 5.4), 'trim')
        # roof equipment on the top tier
        if ti == len(tiers) - 1 and lod < 2:
            ry = y0 + H + 0.3
            kind = spec.get('roof', 'vents'); rr = random.Random(spec['seed'] + ti)
            x, z = (rr.random() - 0.5) * w * 0.3, (rr.random() - 0.5) * d * 0.3
            if kind == 'tank':
                for sx in (-1, 1):
                    for sz in (-1, 1): sub.cyl((x + sx * 1.5, ry + 1.1, z + sz * 1.5), 0.14, 2.2, 'metal', 8)
                sub.cyl((x, ry + 3.8, z), 2.5, 3.2, 'trim', 32)
                sub.dome((x, ry + 5.4, z), 2.5, 'trim')
                sub.cyl((x, ry + 3.0, z), 2.62, 0.28, 'metal', 32); sub.cyl((x, ry + 4.7, z), 2.62, 0.28, 'metal', 32)
            elif kind == 'antenna':
                sub.cyl((x, ry + 4.5, z), 0.25, 9, 'metal', 12, r2=0.18)
                sub.box((x, ry + 7.2, z), (2.4, 0.18, 0.18), 'trim'); sub.box((x, ry + 8.2, z), (1.6, 0.16, 0.16), 'trim')
                sub.box((x + 3.5, ry + 1.1, z + 1), (3.4, 2.2, 3.0), 'wall')
            else:
                for _ in range(3):
                    vx, vz = (rr.random() - 0.5) * w * 0.55, (rr.random() - 0.5) * d * 0.55
                    sub.cyl((vx, ry + 1.3, vz), 0.75, 2.2 + rr.random() * 1.2, 'metal', 20)
                sub.box((w * 0.18, ry + 1.4, -d * 0.2), (4.2, 2.8, 3.4), 'wall')
        # gallery + pipe on the street-facing side of tall tiers (LOD0)
        if lod == 0 and H > 18 and ti == 0:
            gy = min(H * 0.42, 16)
            for face in ([spec['door']] if spec.get('door') else ['z+']):
                horiz = face[0] == 'z'; sg = 1 if face[1] == '+' else -1
                L = min((w if horiz else d) * 0.55, 16)
                cc = (0, y0 + gy, sg * (d / 2 + 1.3)) if horiz else (sg * (w / 2 + 1.3), y0 + gy, 0)
                sub.box(cc, (L, 0.34, 2.6) if horiz else (2.6, 0.34, L), 'deck')
                for k in range(5):
                    off = -L / 2 + 0.4 + (L - 0.8) * k / 4
                    px = (off, y0 + gy - 0.9, sg * (d / 2 + 0.7)) if horiz else (sg * (w / 2 + 0.7), y0 + gy - 0.9, off)
                    sub.box(px, (0.14, 1.9, 0.14) if True else None, 'metal')
                    pp = (off, y0 + gy + 0.55, sg * (d / 2 + 2.5)) if horiz else (sg * (w / 2 + 2.5), y0 + gy + 0.55, off)
                    sub.cyl(pp, 0.05, 1.05, 'metal', 6)
                rc = (0, y0 + gy + 1.1, sg * (d / 2 + 2.5)) if horiz else (sg * (w / 2 + 2.5), y0 + gy + 1.1, 0)
                sub.box(rc, (L, 0.09, 0.09) if horiz else (0.09, 0.09, L), 'trim')
        # apply the tier's local x offset and merge
        M.append(sub, Matrix.Translation((ox, 0, 0)))
        y0 += H
    return M


def bake_ao(M, rays, maxd=3.0):
    bm = M.bm
    bm.normal_update()
    tree = bvhtree.BVHTree.FromBMesh(bm)
    lay = bm.verts.layers.float_color.new('ao')
    rnd = random.Random(5)
    for v in bm.verts:
        if rays == 0: v[lay] = (1, 1, 1, 1); continue
        n = v.normal.normalized()
        ref = Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))
        t = n.cross(ref).normalized(); b = n.cross(t)
        hit = 0.0
        for _ in range(rays):
            r1, r2 = rnd.random(), rnd.random(); rr = math.sqrt(r1); th = math.tau * r2
            d = (t * (rr * math.cos(th)) + b * (rr * math.sin(th)) + n * math.sqrt(1 - r1)).normalized()
            loc = tree.ray_cast(v.co + n * 0.01, d, maxd)[0]
            if loc is not None: hit += 1.0
        a = 1 - hit / rays
        v[lay] = (a, a, a, 1)
    return lay


def bevel_all(M, width, segs):
    bm = M.bm
    bm.edges.ensure_lookup_table()
    edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > 0.5 and e.calc_length() > 0.15]
    bmesh.ops.bevel(bm, geom=edges, offset=width, offset_type='OFFSET', segments=segs, profile=0.5, affect='EDGES')


def subdiv(M, maxlen, passes=4):
    """cut long edges so baked AO has enough vertices to resolve creases"""
    bm = M.bm
    for _ in range(passes):
        edges = [e for e in bm.edges if e.calc_length() > maxlen]
        if not edges: break
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, use_single_edge=False)


def emit(M, lay, name, smooth, col):
    bm = M.bm
    for f in bm.faces: f.smooth = smooth
    for mi, mname in enumerate(MATS):
        b2 = bm.copy()
        kill = [f for f in b2.faces if f.material_index != mi]
        bmesh.ops.delete(b2, geom=kill, context='FACES')
        loose = [v for v in b2.verts if not v.link_faces]
        bmesh.ops.delete(b2, geom=loose, context='VERTS')
        if not b2.faces: b2.free(); continue
        me = bpy.data.meshes.new(f'{name}_{mname}')
        b2.to_mesh(me); b2.free()
        ob = bpy.data.objects.new(f'{name}_{mname}', me); col.objects.link(ob)


if __name__ == '__main__':
    only = int(sys.argv[1]) if len(sys.argv) > 1 else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.data.collections.new('buildings'); bpy.context.scene.collection.children.link(col)
    for spec in SPEC:
        if only is not None and spec['id'] != only: continue
        for lod in (0, 1, 2):
            t0 = time.time()
            M = build(spec, lod)
            if lod == 0: bevel_all(M, 0.07, 2)
            if lod < 2: subdiv(M, 1.9 if lod == 0 else 3.2, 3 if lod == 0 else 2)
            bake_ao(M, rays={0: 12, 1: 6, 2: 0}[lod])
            emit(M, None, f"b{spec['id']}_l{lod}", smooth=(lod == 0), col=col)
            print(f"building {spec['id']} lod{lod}: {len(M.bm.verts)} verts {len(M.bm.faces)} faces {time.time() - t0:.1f}s", flush=True)
            M.bm.free()
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_vertex_color='ACTIVE', export_yup=False, export_materials='NONE', export_apply=False)
    shutil.copy(os.path.join(HERE, 'buildings.json'), os.path.join(HERE, '..', 'assets', 'buildings.json'))
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')
