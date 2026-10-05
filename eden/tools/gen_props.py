"""Blender (bpy) props v2: faceted needle spires, leaning slabs, corrugated containers, lattice pylons.
Run: python3 gen_props.py [names...]  ->  ../assets/props.glb   (objects named  spire{i}_l{lod}_{mat} / slab… / container… / pylon…)

Spires (authored 100 high, base radius ~6, the game scales x/z by width/6 and y by height/100):
  spire0  obelisk stack     8-facet shaft, six tiers, collar ledges, orange facet slabs, long needle tip
  spire1  needle cluster    three fused needles of different height leaning apart, orange slabs on the tall one
  spire2  broken crown      thick 6-facet tower sheared off at an angle, thin spike growing out of the break
  spire3  buttressed tower  4-facet tower with four sloped buttress fins and tall full-height orange slabs
  spire4  twisted needle    slender 6-facet shaft whose tiers rotate, leaning, orange spiral of slabs
  spire5  ringed spire      slender 8-facet shaft with two floating rings and a fused satellite pair
  spire6  blade             flat knife tower, broad orange faces, ridge tip      spire7  shard cluster: five jagged needles fused at the foot
  Every spire keeps its stepped ledges, orange facet slabs and (spire5) its spoked, collar-fused hoops at ALL three LODs: the far LOD (rim spires at
  340-860 m) must never degrade into a plain grey cone.
Slabs: slab0-3 grey / slabr0-3 orange-dominant fallen megastructure shards (concept panel 06).  Convex shards = intersections of half-spaces (tapered / sheared
  trunks cut by diagonal fracture planes, chipped corners, separate sub-shards with deep cracks), clad in raised stepped panels with seams, a narrow orange fin column,
  recessed bays, layered strata plates on the fracture faces and debris blocks banked against the foot.  Variants: 0 sawtooth + stub, 1 split twin + splinter,
  2 arrowhead with a chamfered corner, 3 sheared block.  Authored about 14 x 40 x 6 with the base buried to y=-6; the game tilts and scales them.
container0 (smooth sine corrugation, door end with ribbed leaves / lock bars / hinges, corrugated back end), pylon0 as before.
Normals stay float32 here (the game merges props with procedural geometry, which needs identical attribute types).
"""
import sys
sys.dont_write_bytecode = True
import os, math, random, pickle, time, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix
import gen_buildings as G
from gen_buildings import Mod, MI, TAU, UP, circle_pts, offset_poly, footprint, finalize, write_glb, torus, tube, profile_loft, band_prism, tile_mesh, plan_face, facade_local, frame_matrix, edge_normal, snow_poly

OUT = os.environ.get('PROPS_OUT') or os.path.join(HERE, '..', 'assets', 'props.glb')
CACHE = os.path.join(tempfile.gettempdir(), 'eden_pcache')


# ═════════════════════════════════════════════════ spire parts ═════════════════════════════════════════════════
def facet_ring(n, r, rot, y, ox=0.0, oz=0.0, sq=1.0, ch=0.13):
    """2n points: an n-gon with narrow chamfers at the corners (so the corners shade round instead of knife-sharp)"""
    cs = [(ox + r * math.cos(rot + TAU * i / n), oz + r * sq * math.sin(rot + TAU * i / n)) for i in range(n)]
    pts = []
    for i in range(n):
        c, p, q = cs[i], cs[i - 1], cs[(i + 1) % n]
        pts.append((c[0] + (p[0] - c[0]) * ch, y, c[1] + (p[1] - c[1]) * ch))
        pts.append((c[0] + (q[0] - c[0]) * ch, y, c[1] + (q[1] - c[1]) * ch))
    return pts


def facet_plate(M, cx, cz, y, ang, r_mid, n, w, h, depth, tilt, mat, bev=0.0, off=0.0):
    """raised plate lying on facet `ang` (normal direction) of a shaft whose mean circumradius is r_mid"""
    ap = r_mid * math.cos(math.pi / n) + depth / 2 - 0.05 + off
    nx, nz = math.cos(ang), math.sin(ang)
    n3 = Vector((nx * math.cos(tilt), math.sin(tilt), nz * math.cos(tilt)))
    t = Vector((-nz, 0, nx))
    yv = n3.cross(t)
    basis = Matrix(((t.x, yv.x, n3.x), (t.y, yv.y, n3.y), (t.z, yv.z, n3.z)))
    M.box((cx + nx * ap, y, cz + nz * ap), (w, h, depth), mat, basis=basis, bev=bev, seg=1, skip=())


def fin_wedge(M, cx, cz, ang, r0, depth, height, width, mat, y0=-4.0, lod=0):
    """sloped buttress fin: triangular profile (radial, y), extruded along the tangent"""
    d = Vector((math.cos(ang), 0, math.sin(ang))); t = Vector((-d.z, 0, d.x))
    prof = [(r0 - 0.6, y0), (r0 + depth, y0), (r0 + depth, 0.0), (r0 + depth, height * 0.2), (r0 + depth * 0.45, height * 0.42), (r0 + depth * 0.45, height * 0.5), (r0 + 0.2, height * 0.74), (r0 - 0.6, height)]
    ring = lambda off: [(cx + d.x * rr + t.x * off, y, cz + d.z * rr + t.z * off) for rr, y in prof]
    M.loft([ring(-width / 2), ring(width / 2)], mat, cap0=True, cap1=True, up=t, closed=True)


def spire_body(M, lod, rnd, cx=0.0, cz=0.0, H=100.0, W=6.0, n=8, tiers=6, rot=0.0, twist=0.0, lean=0.0, slabs=2, tip=0.17,
               shoulder=1.5, plate=True, base_skirt=True, taper=0.8, slab_w=0.66, sq=1.0, full_slabs=False, pw=1.35):
    """a faceted needle: stacked tiers with collar ledges, orange facet slabs on some facets, sharp tip"""
    shaft = H * (1.0 - tip)
    ch = 0.035 if lod == 0 else 0.0
    nn = n
    cuts = [0.0]
    for k in range(1, tiers):
        cuts.append(shaft * (k / tiers) + rnd.uniform(-0.12, 0.12) * shaft / tiers)
    cuts.append(shaft)
    rad = lambda y: W * (1 - taper * (y / shaft) ** pw)
    ring = lambda r, y, rt_: (facet_ring(nn, r, rt_, y, cx + lean * y, cz, sq, ch) if lod == 0 else
                              [(cx + lean * y + r * math.cos(rt_ + TAU * i / nn), y, cz + r * sq * math.sin(rt_ + TAU * i / nn)) for i in range(nn)])
    prev_top = None
    if base_skirt and lod < 3:
        M.loft([ring(W * 1.55, -9.0, rot), ring(W * 1.3, 0.2, rot), ring(W * 1.08, 3.0, rot)], 'wallDark', orient=1)
    for k in range(tiers):
        y0, y1 = cuts[k], cuts[k + 1]
        rb, rt = rad(y0) * (1.0 if k == 0 else 0.985), rad(y1) * 0.99
        rk = rot + twist * k
        top_y = y1 - (shoulder if k < tiers - 1 else 0.0)
        rtt = rb + (rt - rb) * ((top_y - y0) / (y1 - y0))
        M.loft([ring(rb, y0, rk), ring(rtt, top_y, rk)], 'wall', orient=1, cap0=(k == 0 and False))
        if k < tiers - 1:
            rn = rad(cuts[k + 1]) * 0.985
            rk2 = rot + twist * (k + 1)
            cw_ = 0.5 if lod < 2 else 1.1          # far LOD: wider ledges so the stepped silhouette survives the distance
            col = [ring(rtt, y1 - shoulder, rk), ring(rtt + cw_, y1 - shoulder, rk), ring(rtt + cw_, y1 - 0.4, rk), ring(rtt + 0.12, y1, rk), ring(rn * 0.985, y1, rk2)]
            if lod >= 2: col = [col[0], col[1], col[3], col[4]]
            M.loft(col, 'wallLight', orient=1)
        # facet slabs / plates (the far LOD keeps the stepped silhouette and the orange slabs: a needle must not turn into a plain cone)
        if lod < 3:
            hseg = (top_y - y0)
            rmid = (rb + rtt) / 2
            facet_len = 2 * rmid * math.sin(math.pi / nn)
            tilt = math.atan2(rb - rtt, top_y - y0)
            picks = rnd.sample(range(nn), min(nn, slabs + (1 if k % 2 else 0)))
            for fi in picks:
                ang = rk + (fi + 0.5) * TAU / nn
                if full_slabs:
                    nseg = 1 if lod >= 1 else max(1, round(hseg / 14))
                else:
                    nseg = 1 if (lod >= 1 or hseg < 12) else 2
                sh = hseg * 0.84 / nseg
                for s_ in range(nseg):
                    yy = y0 + hseg * 0.08 + sh * (s_ + 0.5) + (hseg * 0.84 / nseg - sh) * 0 + s_ * 0.5
                    facet_plate(M, cx + lean * yy, cz, yy, ang, rmid, nn, facet_len * slab_w, sh - 0.55, 0.55, tilt, 'accent' if rnd.random() > 0.2 else 'accentDark', bev=0.12 if lod == 0 else 0.0)
                    if lod == 0 and sh > 8:
                        facet_plate(M, cx + lean * yy, cz, yy, ang, rmid, nn, facet_len * slab_w * 0.55, sh * 0.5, 0.18, tilt, 'accentDark', bev=0.05, off=0.5)
            if plate and lod == 0:
                others = [i for i in range(nn) if i not in picks]
                for fi in rnd.sample(others, min(len(others), 2)):
                    ang = rk + (fi + 0.5) * TAU / nn
                    yy = y0 + hseg * 0.5
                    facet_plate(M, cx + lean * yy, cz, yy, ang, rmid, nn, facet_len * 0.5, hseg * 0.55, 0.22, tilt, 'wallLight', bev=0.06, off=-0.05)
    # tip
    ytop = cuts[-1]
    rtop = rad(ytop) * 0.99
    L = H - ytop
    rings = [ring(rtop, ytop, rot + twist * tiers)]
    for f, rr in (((0.32, 0.64), (0.62, 0.3), (0.86, 0.12), (1.0, 0.03)) if lod < 2 else ((0.45, 0.5), (1.0, 0.03))):
        rings.append(ring(rtop * rr, ytop + L * f, rot + twist * tiers))
    M.loft(rings, 'wall', orient=1, cap1=True)
    if lod < 2:
        # slender accent stripe running up the needle on one facet
        ang = rot + twist * tiers + 0.5 * TAU / nn
        if lod == 0:
            facet_plate(M, cx + lean * (ytop + L * 0.3), cz, ytop + L * 0.3, ang, rtop * 0.72, nn, rtop * 0.5, L * 0.42, 0.3, math.atan2(rtop * 0.36, L * 0.64), 'accent', bev=0.06)


def blade(M, lod, rnd):
    """flat knife tower: rectangular chamfered tiers (wide in x, thin in z), orange slabs on both broad faces, sharp ridge tip"""
    H, tiers, W0, D0 = 100.0, 6, 8.4, 3.2
    shaft = H * 0.84
    cuts = [shaft * k / tiers for k in range(tiers + 1)]
    wd = lambda y: (W0 * (1 - 0.74 * (y / shaft) ** 1.25), D0 * (1 - 0.55 * (y / shaft) ** 1.1))
    M.loft([[(x, -9.0, z) for x, z in footprint(W0 * 2.9, D0 * 3.6, 'chamfer', 1.4)], [(x, 0.3, z) for x, z in footprint(W0 * 2.5, D0 * 3.0, 'chamfer', 1.2)], [(x, 3.0, z) for x, z in footprint(W0 * 2.1, D0 * 2.2, 'chamfer', 1.0)]], 'wallDark', orient=1) if lod < 3 else None
    for k in range(tiers):
        y0, y1 = cuts[k], cuts[k + 1]
        top_y = y1 - (1.4 if k < tiers - 1 else 0.0)
        w0, d0 = wd(y0); w1, d1 = wd(top_y)
        ch = 0.9 if lod == 0 else 0.0
        M.loft([[(x, y0, z) for x, z in footprint(w0 * 2, d0 * 2, 'chamfer', ch)], [(x, top_y, z) for x, z in footprint(w1 * 2, d1 * 2, 'chamfer', ch)]], 'wall', orient=1)
        if k < tiers - 1:
            wn, dn = wd(y1)
            col = [[(x, y1 - 1.4, z) for x, z in footprint(w1 * 2, d1 * 2, 'chamfer', ch)], [(x, y1 - 1.4, z) for x, z in footprint(w1 * 2 + 1.0, d1 * 2 + 1.0, 'chamfer', ch)],
                   [(x, y1 - 0.4, z) for x, z in footprint(w1 * 2 + 1.0, d1 * 2 + 1.0, 'chamfer', ch)], [(x, y1, z) for x, z in footprint(w1 * 2 + 0.2, d1 * 2 + 0.2, 'chamfer', ch)], [(x, y1, z) for x, z in footprint(wn * 2 * 0.98, dn * 2 * 0.98, 'chamfer', ch)]]
            M.loft(col, 'wallLight', orient=1)
            ym = (y0 + top_y) / 2
            wm, dm = wd(ym)
            tl = math.atan2(d0 - d1, top_y - y0)
            for sg in (-1, 1):
                nseg = 1 if lod == 1 else 2
                sh = (top_y - y0) * 0.82 / nseg
                for q in range(nseg):
                    yy = y0 + (top_y - y0) * 0.09 + sh * (q + 0.5) + q * 0.5
                    M.box((rnd.uniform(-0.8, 0.8), yy, sg * (wd(yy)[1] + 0.25)), (wd(yy)[0] * 1.35, sh - 0.5, 0.55), 'accent' if rnd.random() > 0.2 else 'accentDark', bev=0.12 if lod == 0 else 0.0, seg=1, rot=(sg * tl, 0, 0))
    ytop = cuts[-1]
    w1, d1 = wd(ytop)
    L = H - ytop
    rings = [[(x, ytop, z) for x, z in footprint(w1 * 2, d1 * 2, 'chamfer', 0.0)]]
    for f, rr in ((0.35, 0.6), (0.7, 0.28), (1.0, 0.04)):
        rings.append([(x, ytop + L * f, z) for x, z in footprint(max(0.1, w1 * 2 * rr), max(0.06, d1 * 2 * rr * 0.8), 'chamfer', 0.0)])
    M.loft(rings, 'wall', orient=1, cap1=True)


# ═════════════════════════════════════════════════ spire variants ═════════════════════════════════════════════════
def spire(i, lod):
    rnd = random.Random(i * 7919 + 11)
    M = Mod()
    if i == 0:     # obelisk stack
        spire_body(M, lod, rnd, n=8, W=6.6, tiers=6, rot=rnd.random(), slabs=3, tip=0.17, pw=1.5)
        if lod < 3:
            for k in range(4): fin_wedge(M, 0, 0, rnd.random() * 0.4 + k * math.pi / 2 + math.pi / 4, 6.6, 2.6, 15, 3.6, 'wallLight', lod=lod)
    elif i == 1:   # needle cluster
        spire_body(M, lod, rnd, cx=0, cz=0, H=100, W=5.0, n=7, tiers=6, rot=0.3, slabs=2, tip=0.16, lean=0.0)
        spire_body(M, min(lod + 1, 2), rnd, cx=-5.8, cz=2.2, H=64, W=3.6, n=6, tiers=4, rot=0.9, slabs=1, tip=0.2, lean=-0.045, base_skirt=False)
        spire_body(M, min(lod + 1, 2), rnd, cx=5.5, cz=-2.4, H=46, W=3.2, n=6, tiers=3, rot=0.1, slabs=1, tip=0.22, lean=0.05, base_skirt=False)
        if lod < 3:
            M.loft([G.circle_pts(0, 0, 9.0, 16, -9.0), G.circle_pts(0, 0, 8.4, 16, 0.5), G.circle_pts(0, 0, 6.6, 16, 5.0)], 'wallDark', orient=1)
    elif i == 2:   # broken crown
        spire_body(M, lod, rnd, H=84, W=8.2, n=6, tiers=5, rot=0.5, slabs=3, tip=0.0, plate=True, taper=0.5, full_slabs=True, pw=1.2)
        # shear the top off along an inclined plane, then grow a needle from the break
        cut_y, slope = 70.0, 0.55
        for v in M.bm.verts:
            if v.co.y > cut_y:
                lim = cut_y + (v.co.x * slope + 6.0)
                v.co.y = min(v.co.y, max(cut_y - 6.0, lim))
        sp = Mod()
        spire_body(sp, min(lod + 1, 2), rnd, cx=-1.2, cz=0.4, H=52, W=2.3, n=5, tiers=3, rot=0.2, slabs=1, tip=0.35, taper=0.6, base_skirt=False, shoulder=1.0)
        M.merge(sp, Matrix.Translation((0, 62.0, 0)) ); sp.free()
        if lod < 3:
            for k in range(3): fin_wedge(M, 0, 0, k * TAU / 3 + 0.4, 8.2, 2.6, 16, 3.6, 'wallLight', lod=lod)
    elif i == 3:   # buttressed tower
        spire_body(M, lod, rnd, H=100, W=6.4, n=4, tiers=5, rot=math.pi / 4, slabs=2, tip=0.2, taper=0.74, full_slabs=True, slab_w=0.74, shoulder=1.8, pw=1.4)
        if lod < 3:
            for k in range(4): fin_wedge(M, 0, 0, k * math.pi / 2, 6.2, 3.4, 26 if k % 2 == 0 else 18, 4.2, 'wall', lod=lod)
    elif i == 4:   # twisted needle
        spire_body(M, lod, rnd, H=100, W=4.5, n=6, tiers=9, rot=0.2, twist=0.22, lean=0.05, slabs=1, tip=0.14, taper=0.82, shoulder=1.1, plate=False)
        if lod < 3:
            for k in range(3): fin_wedge(M, 0, 0, k * TAU / 3 + 0.2, 4.8, 2.4, 14, 1.8, 'wallLight', lod=lod)
    elif i == 6:   # blade: flat wide knife tower with a broad orange face
        blade(M, lod, rnd)
    elif i == 7:   # shard cluster: five jagged needles fused at the base
        mem = ((0.0, 0.0, 100, 4.8, 7, 0.0), (-6.5, 1.5, 78, 3.6, 6, -0.07), (6.4, -1.8, 64, 3.2, 5, 0.08), (-1.5, -6.2, 52, 3.0, 6, -0.04), (2.5, 6.4, 42, 2.8, 5, 0.05))
        for k, (mx, mz, mh, mw, mn, ml) in enumerate(mem):
            spire_body(M, lod if k == 0 else min(lod + 1, 2), rnd, cx=mx, cz=mz, H=mh, W=mw, n=mn, tiers=5 if k == 0 else 3, rot=rnd.random(), slabs=2 if k < 2 else 1, tip=0.2, lean=ml, base_skirt=(k == 0), pw=1.3)
        if lod < 3:
            M.loft([G.circle_pts(0, 0, 10.0, 18, -9.0), G.circle_pts(0, 0, 9.2, 18, 0.5), G.circle_pts(0, 0, 7.0, 18, 5.5)], 'wallDark', orient=1)
    else:          # ringed spire (5): two hoops carried by a fused collar and six spokes + diagonal braces (no free floating rings)
        H_, W_, tip_, taper_, pw_ = 100.0, 4.6, 0.15, 0.8, 1.35
        spire_body(M, lod, rnd, H=H_, W=W_, n=8, tiers=7, rot=0.0, slabs=1, tip=tip_, taper=taper_)
        spire_body(M, min(lod + 1, 2), rnd, cx=7.0, cz=1.0, H=48, W=3.0, n=6, tiers=3, rot=0.4, slabs=1, tip=0.25, lean=0.05, base_skirt=False)
        shaft = H_ * (1 - tip_)
        rs = lambda y: W_ * (1 - taper_ * (y / shaft) ** pw_)
        for (ry, rr) in ((38.0, 11.0), (58.0, 8.0)):
            r0 = rs(ry)
            # collar fused to the shaft: stepped drum with an orange band
            M.loft([G.circle_pts(0, 0, r0 * 1.08, 16, ry - 2.6), G.circle_pts(0, 0, r0 * 1.42, 16, ry - 1.7), G.circle_pts(0, 0, r0 * 1.42, 16, ry + 1.7), G.circle_pts(0, 0, r0 * 1.08, 16, ry + 2.6)], 'trim', orient=1)
            if lod < 2: M.loft([G.circle_pts(0, 0, r0 * 1.46, 16, ry - 0.7), G.circle_pts(0, 0, r0 * 1.46, 16, ry + 0.7)], 'accent', orient=1)
            torus(M, (0, ry, 0), rr, 1.25 if lod < 2 else 1.4, 'y', 'trim', nmaj=(40 if lod == 0 else 24 if lod == 1 else 14), nmin=(8 if lod == 0 else 5 if lod == 1 else 4), ry=0.95, sq=0.3)
            nsp = 6
            for k in range(nsp):
                a = k * TAU / nsp + 0.3
                ca, sa = math.cos(a), math.sin(a)
                # spoke: shaft collar -> hoop, slightly drooping, with a diagonal brace under it
                M.beam((r0 * 1.3 * ca, ry + 0.2, r0 * 1.3 * sa), ((rr - 0.9) * ca, ry, (rr - 0.9) * sa), 1.0 if lod < 2 else 1.4, 0.9 if lod < 2 else 1.2, 'wall', up=(0, 1, 0), bev=0.1 if lod == 0 else 0.0)
                if lod < 2:
                    M.beam((r0 * 1.35 * ca, ry - 4.2, r0 * 1.35 * sa), ((rr * 0.78) * ca, ry - 0.5, (rr * 0.78) * sa), 0.55, 0.55, 'metal', up=(0, 1, 0))
                if lod == 0 and k % 2 == 0:
                    M.box((rr * ca, ry + 1.35, rr * sa), (2.4, 1.1, 2.4), 'accent', basis=Matrix.Rotation(-a, 3, 'Y'), bev=0.1, seg=1)
        if lod < 3:
            M.loft([G.circle_pts(0, 0, 8.4, 16, -9.0), G.circle_pts(0, 0, 7.4, 16, 0.5), G.circle_pts(0, 0, 5.9, 16, 5.0)], 'wallDark', orient=1)
    return M


# ═════════════════════════════════════════════════ slabs ═════════════════════════════════════════════════
# Fallen megastructure shards (concept panel 06): tapered / skewed convex shards cut by planes (diagonal fractures, chipped corners, deep cracks
# between sub-shards), clad in raised stepped panels with seams, orange strata bands and layered exposed cores on the fracture faces.
def clip_poly(P, ax, az, c):
    """Sutherland-Hodgman: keep the part of convex polygon P where ax*x + az*z + c >= 0"""
    out = []
    n = len(P)
    for i in range(n):
        p, q = P[i], P[(i + 1) % n]
        dp, dq = ax * p[0] + az * p[1] + c, ax * q[0] + az * q[1] + c
        if dp >= 0: out.append(p)
        if (dp >= 0) != (dq >= 0):
            t = dp / (dp - dq)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return out


def area2(P):
    return 0.5 * sum(P[i][0] * P[(i + 1) % len(P)][1] - P[(i + 1) % len(P)][0] * P[i][1] for i in range(len(P)))


def ccw(P):
    return P if area2(P) >= 0 else P[::-1]


def clip_convex(S, C):
    """clip polygon S by the convex polygon C (2D, any winding)"""
    C = ccw(C)
    out = ccw(S)
    n = len(C)
    for i in range(n):
        a, b = C[i], C[(i + 1) % n]
        ex, ez = b[0] - a[0], b[1] - a[1]
        L = math.hypot(ex, ez)
        if L < 1e-9: continue
        out = clip_poly(out, -ez / L, ex / L, (ez * a[0] - ex * a[1]) / L)
        if len(out) < 3: return []
    return out


def shrink(P, d):
    """inward offset of a convex polygon by clipping against its own edges (always valid, may vanish)"""
    P = ccw(P)
    out = P
    n = len(P)
    for i in range(n):
        a, b = P[i], P[(i + 1) % n]
        ex, ez = b[0] - a[0], b[1] - a[1]
        L = math.hypot(ex, ez)
        if L < 1e-9: continue
        out = clip_poly(out, -ez / L, ex / L, (ez * a[0] - ex * a[1]) / L - d)
        if len(out) < 3: return []
    return out


def inset_ring(P, d):
    """same vertex count mitre inset of a CCW convex polygon (mitre clamped so acute corners cannot shoot out)"""
    n = len(P)
    out = []
    for i in range(n):
        p0, p1, p2 = P[i - 1], P[i], P[(i + 1) % n]
        e1 = (p1[0] - p0[0], p1[1] - p0[1]); l1 = math.hypot(*e1) or 1.0
        e2 = (p2[0] - p1[0], p2[1] - p1[1]); l2 = math.hypot(*e2) or 1.0
        n1 = (-e1[1] / l1, e1[0] / l1); n2 = (-e2[1] / l2, e2[0] / l2)
        k = max(0.4, 1 + n1[0] * n2[0] + n1[1] * n2[1])
        out.append((p1[0] + (n1[0] + n2[0]) / k * d, p1[1] + (n1[1] + n2[1]) / k * d))
    return out


def min_angle(P):
    n = len(P)
    m = 9.0
    for i in range(n):
        a, b, c = P[i - 1], P[i], P[(i + 1) % n]
        v1 = (a[0] - b[0], a[1] - b[1]); v2 = (c[0] - b[0], c[1] - b[1])
        l = math.hypot(*v1) * math.hypot(*v2)
        if l < 1e-9: return 0.0
        m = min(m, math.acos(max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / l))))
    return m


# ── convex solids from half-spaces ──
def pl(n, p, mat, tag=''):
    n = Vector(n).normalized()
    return (n, n.dot(Vector(p)), mat, tag)


def xf_planes(planes, R=None, pivot=(0, 0, 0), T=(0, 0, 0)):
    out = []
    pv, tv = Vector(pivot), Vector(T)
    for n, d, mat, tag in planes:
        p = n * d
        if R is not None:
            n = (R @ n).normalized(); p = R @ (p - pv) + pv
        p = p + tv
        out.append((n, n.dot(p), mat, tag))
    return out


def clip3(P, n, d):
    out = []
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        da, db = n.dot(a) - d, n.dot(b) - d
        if da <= 0: out.append(a)
        if (da < 0 < db) or (db < 0 < da):
            out.append(a + (b - a) * (da / (da - db)))
    return out


def hull_faces(planes):
    res = []
    for i, (n, d, mat, tag) in enumerate(planes):
        a = (UP if abs(n.y) < 0.9 else Vector((1, 0, 0))).cross(n).normalized()
        b = n.cross(a)
        c = n * d
        S = 400.0
        P = [c + a * S + b * S, c - a * S + b * S, c - a * S - b * S, c + a * S - b * S]
        for j, (n2, d2, _, _) in enumerate(planes):
            if j == i: continue
            if (n2 - n).length < 1e-5: continue
            P = clip3(P, n2, d2 + 1e-6)
            if len(P) < 3: break
        if len(P) < 3: continue
        Q = [P[0]]
        for p in P[1:]:
            if (p - Q[-1]).length > 1e-4: Q.append(p)
        if (Q[0] - Q[-1]).length < 1e-4: Q.pop()
        if len(Q) < 3: continue
        nn = Vector((0, 0, 0))
        for k in range(len(Q)):
            u, v = Q[k], Q[(k + 1) % len(Q)]
            nn += Vector(((u.y - v.y) * (u.z + v.z), (u.z - v.z) * (u.x + v.x), (u.x - v.x) * (u.y + v.y)))
        if nn.length < 1e-4: continue
        if nn.dot(n) < 0: Q = Q[::-1]
        res.append((Q, n, mat, tag))
    return res


def solid(M, planes, bev=0.0, seg=1):
    """convex solid = intersection of half-spaces; returns [(polygon3d, normal, mat, tag)]"""
    fd = hull_faces(planes)
    fl = []
    for Q, n, mat, tag in fd:
        f = M.poly([tuple(p) for p in Q], mat)
        if f: fl.append(f)
    bm = M.bm
    vs = list(dict.fromkeys(v for f in fl for v in f.verts))        # ordered (a set would make remove_doubles / vertex order run-dependent)
    bmesh.ops.remove_doubles(bm, verts=vs, dist=3e-4)
    fl = [f for f in fl if f.is_valid]
    if bev > 0: M._bevel(fl, bev, seg)
    return fd


# ── relief cladding on a planar convex polygon ──
def face_frame(Q, n):
    u = UP.cross(n)
    if u.length < 0.25: u = Vector((1, 0, 0)) if abs(n.x) < 0.9 else Vector((0, 0, 1))
    u = u.normalized(); v = n.cross(u)
    o = sum(Q, Vector()) / len(Q)
    return o, u, v


def band(M, A, B, mat, mode, n, c):
    """quad strip between two equally long 3D rings; mode 'up' faces +n, 'out' / 'in' face away from / towards the ring centre c"""
    bm = M.bm
    va = [bm.verts.new(p) for p in A]; vb = [bm.verts.new(p) for p in B]
    k = len(A)
    for i in range(k):
        j = (i + 1) % k
        try: f = bm.faces.new((va[i], va[j], vb[j], vb[i]))
        except ValueError: continue
        f.normal_update()
        if mode == 'up': want = n
        else:
            rad = f.calc_center_median() - c
            rad = rad - n * rad.dot(n)
            want = rad if mode == 'out' else -rad
        if f.normal.dot(want) < 0: f.normal_flip()
        f.material_index = MI[mat]


def plate(M, P2, o, u, v, n, mat, depth, lod, lip=0.16, bay=None):
    """raised stepped plate over a 2D convex polygon in the face frame; bay=(floor_mat, inset) cuts a real recess into the plate"""
    P2 = ccw(P2)
    to3 = lambda q, z: tuple(o + u * q[0] + v * q[1] + n * z)
    if lod >= 2:
        M.poly([to3(q, 0.1) for q in P2], mat)
        return
    cen = o + u * (sum(q[0] for q in P2) / len(P2)) + v * (sum(q[1] for q in P2) / len(P2))
    if lod == 1 or depth < 0.2:
        rings = [[to3(q, 0.0) for q in P2], [to3(q, depth * 0.6) for q in P2], [to3(q, depth) for q in inset_ring(P2, lip * 0.8)]]
        M.loft(rings, mat, cap1=True, orient=1, up=n)
        return
    r0 = [to3(q, 0.0) for q in P2]; r1 = [to3(q, depth * 0.78) for q in P2]
    top = inset_ring(P2, lip)
    r2 = [to3(q, depth) for q in top]
    if bay is None:
        M.loft([r0, r1, r2], mat, cap1=True, orient=1, up=n)
        return
    fl_mat, bi = bay
    rim = inset_ring(top, bi)
    flr = inset_ring(rim, 0.22)
    band(M, r0, r1, mat, 'out', n, cen); band(M, r1, r2, mat, 'out', n, cen)
    r3 = [to3(q, depth) for q in rim]
    band(M, r2, r3, mat, 'up', n, cen)
    r4 = [to3(q, depth * 0.34) for q in flr]
    band(M, r3, r4, mat, 'in', n, cen)
    f = M.poly(r4, fl_mat)
    if f:
        f.normal_update()
        if f.normal.dot(n) < 0: f.normal_flip()


def clad_face(M, Q, n, lod, rnd, red, side=False, small=False):
    """broad slab face: two columns (a narrow orange fin and a wide slate field) of big plates with seams, some plates carry a recessed bay"""
    o, u, v = face_frame(Q, n)
    P = ccw([((p - o).dot(u), (p - o).dot(v)) for p in Q])
    margin = 0.6
    inner = shrink(P, margin)
    if len(inner) < 3: return
    us = [p[0] for p in inner]; vs = [p[1] for p in inner]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    W = u1 - u0
    gap = 0.46 if lod == 0 else 0.5
    if side or W < 7.5: cols = [(u0, u1, 'main')]
    else:
        fw = rnd.uniform(2.6, 3.8) if W > 10 else rnd.uniform(2.2, 3.0)
        if rnd.random() < 0.5: cols = [(u0, u0 + fw, 'fin'), (u0 + fw, u1, 'main')]
        else: cols = [(u0, u1 - fw, 'main'), (u1 - fw, u1, 'fin')]
    rowh = {'main': (6.5, 10.5), 'fin': (4.8, 7.2)}
    if small: rowh = {'main': (5.0, 8.0), 'fin': (4.0, 6.0)}
    if lod >= 1: rowh = {k: (a * 1.35, b * 1.4) for k, (a, b) in rowh.items()}
    for (cu0, cu1, kind) in cols:
        rows = []
        y = v0
        while y < v1 - 0.4:
            h = rnd.uniform(*rowh[kind])
            if v1 - (y + h) < rowh[kind][0] * 0.6: h = v1 - y
            rows.append((y, min(v1, y + h)))
            y += h
        nr = len(rows)
        special = set(rnd.sample(range(nr), min(nr, 2)))
        for ri, (a, b) in enumerate(rows):
            rect = [(cu0 + gap / 2, a + gap / 2), (cu1 - gap / 2, a + gap / 2), (cu1 - gap / 2, b - gap / 2), (cu0 + gap / 2, b - gap / 2)]
            cell = clip_convex(rect, inner)
            if len(cell) < 3 or abs(area2(cell)) < 2.2 or min_angle(cell) < 0.45: continue
            ar = abs(area2(cell))
            if red:
                orange = (kind == 'main') != (ri in special) if kind == 'main' else (ri in special)
            else:
                orange = (kind == 'fin') != (ri in special) if kind == 'fin' else (ri in special and rnd.random() < 0.5)
            mat = ('accent' if rnd.random() < 0.88 else 'accentDark') if orange else 'wall'
            d = rnd.choice((0.3, 0.45, 0.62)) if kind == 'main' else rnd.choice((0.5, 0.7))
            bay = None
            if lod == 0 and ar > 16 and rnd.random() < 0.6:
                bay = ('accentDark' if orange else 'wallDark', rnd.uniform(0.85, 1.2))
                if len(shrink(cell, bay[1] + 0.8)) < 3 or abs(area2(shrink(cell, bay[1] + 0.8))) < 3.0: bay = None
            if lod == 0 and bay is None and ar > 6.0 and rnd.random() < 0.13:
                # a panel knocked loose: thicker, turned a few degrees, no longer flush with its neighbours
                ang = rnd.choice((-1, 1)) * rnd.uniform(0.035, 0.07)
                cx_ = sum(q[0] for q in cell) / len(cell); cy_ = sum(q[1] for q in cell) / len(cell)
                ca, sa = math.cos(ang), math.sin(ang)
                cell = [(cx_ + (q[0] - cx_) * ca - (q[1] - cy_) * sa, cy_ + (q[0] - cx_) * sa + (q[1] - cy_) * ca) for q in cell]
                cell = shrink(cell, 0.12) or cell
                d = d + rnd.choice((0.3, 0.42))
            plate(M, cell, o, u, v, n, mat, d, lod, bay=bay)
            if lod == 0 and bay is None and ar > 10 and d > 0.4:
                ic = shrink(cell, 0.9)
                if len(ic) >= 3 and abs(area2(ic)) > 2.5 and min_angle(ic) > 0.45:
                    plate(M, ic, o, u, v, n, 'accentDark' if orange else 'wallLight', d + 0.18, 0, 0.1)


def clad_strata(M, Q, n, lod, rnd, red):
    """exposed layered core on a fracture face: thin alternating strata plates parallel to the contour lines"""
    o, u, v = face_frame(Q, n)
    P = ccw([((p - o).dot(u), (p - o).dot(v)) for p in Q])
    inner = shrink(P, 0.3)
    if len(inner) < 3: return
    us = [p[0] for p in inner]; vs = [p[1] for p in inner]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    seq = ['accent', 'wallDark', 'wall', 'accentDark', 'wallLight', 'wallDark'] if not red else ['accent', 'accentDark', 'accent', 'wallDark', 'accent', 'wall']
    k = rnd.randrange(len(seq))
    y = v0
    gap = 0.12
    while y < v1 - 0.2:
        h = rnd.uniform(0.7, 1.6) if lod == 0 else rnd.uniform(1.5, 2.8)
        b = min(v1, y + h)
        rect = [(u0 - 0.2, y + gap / 2), (u1 + 0.2, y + gap / 2), (u1 + 0.2, b - gap / 2), (u0 - 0.2, b - gap / 2)]
        cell = clip_convex(rect, inner)
        if len(cell) >= 3 and abs(area2(cell)) > 0.5 and min_angle(cell) > 0.3:
            plate(M, cell, o, u, v, n, seq[k % len(seq)], rnd.choice((0.14, 0.22, 0.3)), lod, lip=0.07)
        k += 1
        y = b


# ── shard parts ──
def trunk(x0, w0, w1, t0, t1, H, shx=0.0, shz=0.0, y0=-6.0, zc=0.0, bottom=True):
    """tapered, sheared convex column: width w0 -> w1 and thickness t0 -> t1 between y0 and H (centre drifts by shx / shz per metre)"""
    dy = H - y0
    cxb, cxt = x0, x0 + shx * dy
    czb, czt = zc, zc + shz * dy
    out = []
    for sx in (-1, 1):
        pb = (cxb + sx * w0 / 2, y0); pt = (cxt + sx * w1 / 2, H)
        d = (pt[0] - pb[0], pt[1] - pb[1])
        nx, ny = (d[1], -d[0]) if sx > 0 else (-d[1], d[0])
        out.append(pl((nx, ny, 0), (pb[0], pb[1], 0), 'wall', 'L' if sx < 0 else 'R'))
    for sz in (-1, 1):
        pb = (y0, czb + sz * t0 / 2); pt = (H, czt + sz * t1 / 2)
        d = (pt[0] - pb[0], pt[1] - pb[1])
        ny, nz = (-d[1], d[0]) if sz > 0 else (d[1], -d[0])
        out.append(pl((0, ny, nz), (0, pb[0], pb[1]), 'wallDark', 'F' if sz > 0 else 'B'))
    if bottom: out.append(pl((0, -1, 0), (0, y0, 0), 'wallDark', 'bot'))
    return out


def cut(n, p, mat='wallDark', tag='crown'):
    return pl(n, p, mat, tag)


def chunk(M, c, size, rnd, lod, bev=0.1, mats=('wall', 'wall', 'accent', 'wallDark')):
    """fallen debris block: jittered box with a few corner cuts, random yaw and tilt"""
    sx, sy, sz = size * rnd.uniform(0.7, 1.2), size * rnd.uniform(0.5, 0.9), size * rnd.uniform(0.7, 1.2)
    pls = []
    mat = rnd.choice(mats)
    for ax in range(3):
        for sg in (-1, 1):
            nv = Vector([0, 0, 0]); nv[ax] = sg
            nv += Vector((rnd.uniform(-0.28, 0.28), rnd.uniform(-0.2, 0.2) if ax != 1 else rnd.uniform(-0.28, 0.28), rnd.uniform(-0.28, 0.28)))
            ext = (sx, sy, sz)[ax] * rnd.uniform(0.85, 1.1) * (1.0 if sg > 0 or ax != 1 else 0.8)
            pls.append(pl(nv, nv.normalized() * ext, mat, 'c'))
    for _ in range(3):
        nv = Vector((rnd.uniform(-1, 1), rnd.uniform(-0.2, 1), rnd.uniform(-1, 1)))
        pls.append(pl(nv, nv.normalized() * size * rnd.uniform(0.55, 0.72), mat, 'c'))
    R = Matrix.Rotation(rnd.uniform(0, TAU), 3, 'Y') @ Matrix.Rotation(rnd.uniform(-0.3, 0.3), 3, 'X') @ Matrix.Rotation(rnd.uniform(-0.3, 0.3), 3, 'Z')
    pls = xf_planes(pls, R, (0, 0, 0), c)
    solid(M, pls, bev if lod == 0 else 0.0)


# ── the four shard families ──
def slab_shards(var):
    """list of shards; shard = dict(planes=..., small=True for splinters). All silhouettes are different: sawtooth + stub, spike + stub + splinter,
    arrowhead with a chamfered corner, sheared block"""
    S = []
    if var == 0:       # sawtooth: tall tapered block with a long diagonal fracture, a lower broken stub on the right, a splinter at the crown
        a = trunk(-0.7, 12.6, 8.8, 6.4, 4.4, 60.0, shx=-0.035, shz=0.01)
        a += [cut((0.66, 1.0, 0.08), (-2.2, 38.5, 0)), cut((-0.5, 1.0, -0.5), (-4.5, 39.8, -1.0)), cut((0.9, 0.5, 0.6), (4.0, 28.0, 1.2))]
        b = trunk(4.95, 4.4, 3.2, 5.4, 4.0, 40.0, shx=0.012, zc=0.55)
        b += [cut((0.5, 1.0, 0.2), (5.6, 21.5, 0)), cut((-0.45, 1.0, -0.4), (4.4, 23.0, 0))]
        b = xf_planes(b, Matrix.Rotation(-0.02, 3, 'Z'), (4.95, -6.0, 0.0))
        c = trunk(-4.4, 1.9, 0.5, 3.0, 1.5, 50.0, shx=-0.012, zc=-0.6)
        c += [cut((-0.35, 1.0, 0.2), (-4.4, 46.0, 0))]
        S += [dict(planes=a), dict(planes=b), dict(planes=c, small=True)]
    elif var == 1:     # split twin: tall spike + shorter fractured block with a wide crack, plus a splinter lodged in the crack
        a = trunk(-2.7, 8.4, 6.2, 6.3, 4.6, 60.0, shx=-0.026)
        a += [cut((-0.85, 1.0, 0.18), (-4.6, 37.0, 0)), cut((0.72, 1.0, -0.35), (-0.9, 40.5, 0)), cut((0.3, 0.4, 1.0), (-1.5, 31.0, 2.3), 'wall')]
        b = trunk(4.85, 5.0, 3.8, 5.6, 3.8, 60.0, shx=0.02, zc=0.4)
        b += [cut((0.42, 1.0, 0.0), (5.0, 26.0, 0)), cut((-0.62, 1.0, 0.52), (3.6, 28.0, 0.9)), cut((0.8, 0.35, -0.9), (7.2, 19.0, -1.6), 'wall')]
        b = xf_planes(b, Matrix.Rotation(-0.032, 3, 'Z') @ Matrix.Rotation(0.02, 3, 'Y'), (4.85, -6.0, 0.0), (0.0, 0.0, 0.0))
        c = trunk(1.7, 1.5, 0.6, 3.6, 2.0, 44.0, shx=0.0, zc=-0.1)
        c += [cut((0.55, 1.0, 0.3), (1.7, 31.0, 0))]
        c = xf_planes(c, Matrix.Rotation(0.075, 3, 'Z'), (1.7, -6.0, 0.0))
        S += [dict(planes=a), dict(planes=b), dict(planes=c, small=True)]
    elif var == 2:     # arrowhead: wedge section (thick foot, knife-thin top), steep left rake, a big chamfer broken off the right corner
        a = trunk(0.0, 11.6, 6.8, 7.2, 2.4, 60.0, shx=-0.022)
        a += [cut((-0.9, 1.0, 0.0), (-2.2, 41.5, 0)), cut((0.75, 1.0, 0.1), (-2.2, 41.5, 0)), cut((1.0, 0.6, 0.2), (4.8, 24.0, 0), 'wall'), cut((-0.2, 0.5, 1.0), (-1.0, 33.0, 1.2), 'wall')]
        b = trunk(-6.2, 2.2, 0.8, 3.4, 1.6, 52.0, shx=-0.02, zc=0.4)
        b += [cut((-0.8, 1.0, 0.0), (-6.2, 44.0, 0))]
        b = xf_planes(b, Matrix.Rotation(0.05, 3, 'Z'), (-6.2, -6.0, 0.0))
        S += [dict(planes=a), dict(planes=b, small=True)]
    else:              # sheared block: the upper half slid and twisted on a layered fracture plane
        lo = trunk(0.0, 13.2, 11.8, 6.4, 5.6, 40.0)
        lo += [cut((0.10, 1.0, 0.07), (0.0, 22.0, 0), 'wallDark', 'break'), cut((0.8, 0.5, 0.0), (6.0, 20.0, 0.0), 'wall', 'crown')]
        up = trunk(0.5, 11.2, 7.2, 5.4, 3.5, 60.0, y0=21.4, shx=-0.012)
        up += [cut((-0.46, 1.0, 0.15), (-1.8, 40.5, 0)), cut((0.42, 1.0, -0.28), (1.4, 39.0, 0)), cut((0.2, 0.3, 1.0), (0.5, 32.0, 2.2), 'wall')]
        up = xf_planes(up, Matrix.Rotation(0.055, 3, 'Z') @ Matrix.Rotation(0.085, 3, 'Y'), (0.5, 21.4, 0.0), (1.3, 0.0, 0.5))
        S += [dict(planes=lo), dict(planes=up)]
    return S


def slab(i, lod, red):
    """fractured monolith shards, authored about 14 x 40 x 6 (base buried to y=-6); the game tilts and scales it"""
    rnd = random.Random(i * 7 + 1 + (50 if red else 0))
    M = Mod()
    bev = (0.3 if lod == 0 else 0.0)
    shards = slab_shards(i % 4)
    for si, sh in enumerate(shards):
        fd = solid(M, sh['planes'], bev)
        small = sh.get('small', False)
        for Q, n, mat, tag in fd:
            if tag in ('F', 'B'):
                clad_face(M, Q, n, lod, rnd, red, small=small)
            elif tag in ('L', 'R'):
                clad_face(M, Q, n, lod, rnd, red, side=True, small=small)
            elif tag in ('crown', 'break'):
                if polygon_area3(Q) > 7.0: clad_strata(M, Q, n, lod, rnd, red)
    # debris banked against the foot
    if lod < 2:
        nch = 9 if lod == 0 else 5
        for k in range(nch):
            sg = 1 if k % 2 == 0 else -1
            x = rnd.uniform(-4.6, 4.6)
            sz = rnd.uniform(1.1, 3.0)
            zz = sg * min(3.3 + sz * rnd.uniform(0.3, 0.6), 5.8 - sz * 0.55)
            chunk(M, (x, rnd.uniform(-0.1, 0.5), zz), sz, rnd, lod, mats=('wall', 'accent', 'accent', 'wallDark') if red else ('wall', 'wall', 'accent', 'wallDark'))
    return M


def polygon_area3(Q):
    nn = Vector((0, 0, 0))
    for k in range(len(Q)):
        u, v = Q[k], Q[(k + 1) % len(Q)]
        nn += u.cross(v)
    return nn.length / 2


# ═════════════════════════════════════════════════ container ═════════════════════════════════════════════════
def strip(M, rings, mat, want):
    """quad strip over equally long open polylines, faces turned towards `want`"""
    bm = M.bm
    vr = [[bm.verts.new(p) for p in r] for r in rings]
    for k in range(len(rings) - 1):
        for i in range(len(rings[0]) - 1):
            try: f = bm.faces.new((vr[k][i], vr[k][i + 1], vr[k + 1][i + 1], vr[k + 1][i]))
            except ValueError: continue
            f.normal_update()
            if f.normal.dot(want) < 0: f.normal_flip()
            f.material_index = MI[mat]


def wave_panel(M, axis, sgn, a, b, y0, y1, base, amp, per, mat, ppp=7):
    """smooth sinusoidal corrugation (a trapezoid profile would crease into a coarse sawtooth): ridges run vertically"""
    n = max(4, int(round((b - a) / per * ppp)))
    pts = []
    for k in range(n + 1):
        s = a + (b - a) * k / n
        off = base + amp * (0.5 + 0.5 * math.sin(TAU * (s - a) / per - math.pi / 2))
        pts.append((s, sgn * off))
    mk = (lambda y: [(s, y, o) for s, o in pts]) if axis == 'x' else (lambda y: [(o, y, s) for s, o in pts])
    strip(M, [mk(y0), mk(y1)], mat, Vector((0, 0, sgn)) if axis == 'x' else Vector((sgn, 0, 0)))


def container(seed, lod):
    L, Hh, Wd = 6.1, 2.6, 2.5
    M = Mod()
    M.box((0, Hh / 2 + 0.1, 0), (L - 0.34, Hh - 0.1, Wd - 0.34), 'metal', bev=0.06 if lod == 0 else 0, seg=1)
    if lod == 2:
        M.box((0, Hh / 2 + 0.1, 0), (L, Hh, Wd), 'metal')
        return M
    ppp = 8 if lod == 0 else 5
    per = 0.32 if lod == 0 else 0.5
    # smooth sine corrugation on both long sides and the closed back end
    for sz in (-1, 1):
        wave_panel(M, 'x', sz, -L / 2 + 0.2, L / 2 - 0.2, 0.1 + 0.26, 0.1 + Hh - 0.12, Wd / 2 - 0.14, 0.1, per, 'wallLight', ppp)
    wave_panel(M, 'z', -1, -Wd / 2 + 0.2, Wd / 2 - 0.2, 0.1 + 0.26, 0.1 + Hh - 0.12, L / 2 - 0.14, 0.1, per, 'wallLight', ppp)
    # corner posts + top / bottom rails
    for sx in (-1, 1):
        for sz in (-1, 1):
            M.box((sx * (L / 2 - 0.09), Hh / 2 + 0.1, sz * (Wd / 2 - 0.09)), (0.2, Hh, 0.2), 'trim', bev=0.05 if lod == 0 else 0, seg=1)
            for sy in (0.1, Hh + 0.1):
                M.box((sx * (L / 2 - 0.15), sy, sz * (Wd / 2 - 0.15)), (0.36, 0.34, 0.36), 'trim', bev=0.06 if lod == 0 else 0, seg=1)
    for sy in (0.1, Hh + 0.1):
        for sz in (-1, 1): M.box((0, sy, sz * (Wd / 2 - 0.07)), (L - 0.2, 0.16, 0.14), 'trim')
        M.box((-L / 2 + 0.07, sy, 0), (0.14, 0.16, Wd - 0.2), 'trim')
    M.box((0, Hh + 0.14, 0), (L + 0.02, 0.14, Wd + 0.02), 'trim', bev=0.04 if lod == 0 else 0, seg=1)
    # door end: header / sill bars, two leaves with vertical ribs, lock bars with cam keepers, hinges and a data plate
    xe = L / 2
    M.box((xe + 0.01, 0.1, 0), (0.18, 0.16, Wd - 0.2), 'trim')
    M.box((xe + 0.01, Hh + 0.1, 0), (0.18, 0.16, Wd - 0.2), 'trim')
    for sz in (-1, 1):
        zc = sz * Wd / 4
        M.box((xe - 0.02, Hh / 2 + 0.1, zc), (0.12, Hh - 0.3, Wd / 2 - 0.2), 'metal', bev=0.04 if lod == 0 else 0, seg=1, skip=('-x',))
        for k in range(5 if lod == 0 else 3):
            zz = zc + (k - (2 if lod == 0 else 1)) * (0.2 if lod == 0 else 0.3)
            M.box((xe + 0.05, Hh / 2 + 0.1, zz), (0.07, Hh - 0.55, 0.075), 'wallLight', bev=0.025 if lod == 0 else 0, seg=1, skip=('-x',))
        if lod == 0:
            for k in range(2):
                zz = zc + (k - 0.5) * 0.46
                tube(M, (xe + 0.15, 0.32, zz), (xe + 0.15, Hh - 0.1, zz), 0.035, 'trim', 8)
                for yk in (0.28, Hh - 0.08): M.box((xe + 0.13, yk, zz), (0.1, 0.12, 0.12), 'trim', bev=0.02, seg=1)
            M.box((xe + 0.21, 1.3, zc), (0.08, 0.1, 0.42), 'trim', bev=0.02, seg=1)
            for yk in (0.5, Hh / 2 + 0.1, Hh - 0.3):
                M.frustum((xe + 0.06, yk, sz * (Wd / 2 - 0.2)), 0.055, 0.055, 0.3, 'trim', seg=8)
    if lod == 0:
        M.box((xe + 0.06, 0.95, 0), (0.03, 0.2, 0.34), 'wallLight')
    return M


# ═════════════════════════════════════════════════ pylon ═════════════════════════════════════════════════
def pylon(seed, lod):
    """lattice support leg 12 high: four tapering corner posts, ring beams, X bracing with gusset plates"""
    M = Mod()
    Hh = 12.0
    b0, b1 = 1.35, 0.85
    M.box((0, 0.2, 0), (b0 * 2 + 1.4, 0.8, b0 * 2 + 1.4), 'wallDark', bev=0.1 if lod == 0 else 0, seg=1)
    segs = 4 if lod < 2 else 2
    pt = lambda k, sx, sz, y=None: (sx * (b0 + (b1 - b0) * k / segs), 0.3 + (Hh * k / segs if y is None else y), sz * (b0 + (b1 - b0) * k / segs))
    for sx in (-1, 1):
        for sz in (-1, 1):
            M.beam(pt(0, sx, sz), pt(segs, sx, sz), 0.34, 0.34, 'wall', bev=0.05 if lod == 0 else 0, seg=1)
    for k in range(1, segs + 1):
        r = b0 + (b1 - b0) * k / segs
        y = 0.3 + Hh * k / segs
        for s in (-1, 1):
            M.beam((-r, y, s * r), (r, y, s * r), 0.28, 0.3, 'trim', bev=0.04 if lod == 0 else 0, seg=1)
            M.beam((s * r, y, -r), (s * r, y, r), 0.28, 0.3, 'trim', bev=0.04 if lod == 0 else 0, seg=1)
        if lod == 0 and k < segs:
            for sx in (-1, 1):
                for sz in (-1, 1): M.box((sx * r, y, sz * r), (0.62, 0.5, 0.62), 'trim', bev=0.06, seg=1)
    if lod < 2:
        for k in range(segs):
            ra = b0 + (b1 - b0) * k / segs; rb = b0 + (b1 - b0) * (k + 1) / segs
            ya, yb = 0.3 + Hh * k / segs, 0.3 + Hh * (k + 1) / segs
            for s in (-1, 1):
                for (a, b) in ((( -ra, ya, s * ra), (rb, yb, s * rb)), ((ra, ya, s * ra), (-rb, yb, s * rb)), ((s * ra, ya, -ra), (s * rb, yb, rb)), ((s * ra, ya, ra), (s * rb, yb, -rb))):
                    M.beam(a, b, 0.17, 0.17, 'metal')
    M.box((0, Hh + 0.55, 0), (b1 * 2 + 1.0, 0.8, b1 * 2 + 1.0), 'wallLight', bev=0.12 if lod == 0 else 0, seg=2)
    return M


# ═════════════════════════════════════════════════ driver ═════════════════════════════════════════════════
JOBS = {}
for _i in range(8): JOBS[f'spire{_i}'] = (lambda l, i=_i: spire(i, l), dict(rays=(10, 6, 0), maxd=7.0, passes=(1, 0, 0)))
for _i in range(4):
    JOBS[f'slab{_i}'] = (lambda l, i=_i: slab(i, l, False), dict(rays=(14, 6, 0), maxd=4.0, passes=(0, 0, 0)))
    JOBS[f'slabr{_i}'] = (lambda l, i=_i: slab(i, l, True), dict(rays=(14, 6, 0), maxd=4.0, passes=(0, 0, 0)))
JOBS['container0'] = (lambda l: container(1, l), dict(rays=(12, 6, 0), maxd=1.2, passes=(0, 0, 0)))
JOBS['pylon0'] = (lambda l: pylon(1, l), dict(rays=(10, 6, 0), maxd=2.2, passes=(0, 0, 0)))


def build_prop(name, lod):
    t0 = time.time()
    fn, o = JOBS[name]
    M = fn(lod)
    data = finalize(M, rays=o['rays'][lod], maxd=o['maxd'], thr=0.15, minlen=2.5, passes=o['passes'][lod])
    M.free()
    nv = sum(len(m['pos']) for m in data.values()); nt = sum(len(m['idx']) // 3 for m in data.values())
    print(f'{name} lod{lod}: {nv} verts {nt} tris {time.time() - t0:.1f}s', flush=True)
    return data


def main(argv):
    names = [a for a in argv if not a.startswith('-')]
    os.makedirs(CACHE, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    meshes = {}
    for name in JOBS:
        for lod in (0, 1, 2):
            path = os.path.join(CACHE, f'{name}_l{lod}.pkl')
            if (not names or name in names) or not os.path.exists(path):
                data = build_prop(name, lod)
                pickle.dump(data, open(path, 'wb'))
            else:
                data = pickle.load(open(path, 'rb'))
            for mname, m in data.items(): meshes[f'{name}_l{lod}_{mname}'] = m
    write_glb(OUT, meshes, norm_float=True)
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')


if __name__ == '__main__':
    main(sys.argv[1:])
