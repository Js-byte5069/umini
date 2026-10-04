// Geometry kit: everything is real, smoothly shaded geometry (bevelled, lofted, extruded with true recesses).
import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MAT } from './materials.js';
import { makeNoise, rng, lerp, sstep, clamp } from './noise.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
/** compose matrix: translate, euler rotate (rad), scale */
export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

// ── batching ────────────────────────────────────────────────────────────────
/** Collects transformed geometry per material key, bakes cheap vertical AO into vertex colours, merges. */
export class Batch {
  constructor() { this.parts = new Map(); }
  add(key, geo, matrix = null, o = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    const baked = g.getAttribute('color');   // baked AO (Blender assets) → multiplied into the vertex colour
    for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
    if (matrix) g.applyMatrix4(matrix);
    const pos = g.attributes.position, nor = g.attributes.normal;
    const col = new Float32Array(pos.count * 3);
    const tint = o.tint;
    for (let i = 0; i < pos.count; i++) {
      let k = 1;
      if (!o.noAO) {
        const y = pos.getY(i);
        k = lerp(0.74, 1, sstep(-1, 9, y));
        if (nor.getY(i) < -0.35) k *= 0.84;
      }
      if (baked) k *= 0.58 + 0.42 * baked.getX(i);
      col[i * 3] = Math.pow(k, 1.15) * (tint ? tint.r : 1);
      col[i * 3 + 1] = k * (tint ? tint.g : 1);
      col[i * 3 + 2] = Math.pow(k, 0.86) * (tint ? tint.b : 1);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let list = this.parts.get(key);
    if (!list) this.parts.set(key, (list = []));
    list.push(g);
    return this;
  }
  build(cast = true) {
    const grp = new THREE.Group();
    for (const [key, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, MAT[key]);
      mesh.castShadow = cast; mesh.receiveShadow = true;
      grp.add(mesh);
      list.forEach((g) => g.dispose());
    }
    return grp;
  }
}

// ── primitives with bevels ────────────────────────────────────────────────────
export function rbox(w, h, d, r = 0.1, seg = 3) {
  r = Math.max(0.005, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  return new RoundedBoxGeometry(w, h, d, seg, r);
}
export function cyl(rt, rb, h, seg = 24) { return new THREE.CylinderGeometry(rt, rb, h, seg, 1); }

/** cylinder between two points */
export function strut(a, b, r, seg = 10) {
  const v = new THREE.Vector3().subVectors(b, a);
  const len = v.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
  const mat = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(mat);
  return g;
}
/** rounded-rect box between two points (square-section beam), `up` keeps orientation stable */
export function beam(a, b, w, h, r = 0.05) {
  const v = new THREE.Vector3().subVectors(b, a);
  const len = v.length();
  const g = rbox(len, h, w, r, 2);
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), v, new THREE.Vector3(0, 1, 0));
  // lookAt aims -z at target; rbox is long along x, so rotate x→dir
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), v.clone().normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/** superellipse loft: sections [{y, rx, rz, ox, oz, n}] → smooth tapered column / tower / spire */
export function loft(sections, { seg = 40, capTop = true, capBottom = true, crease = 55 } = {}) {
  const S = sections.length;
  const pos = [], idx = [];
  const ring = (s) => {
    const n = s.n ?? 4, e = 2 / n;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), si = Math.sin(a);
      pos.push((s.ox ?? 0) + s.rx * Math.sign(c) * Math.pow(Math.abs(c), e), s.y, (s.oz ?? 0) + s.rz * Math.sign(si) * Math.pow(Math.abs(si), e));
    }
  };
  sections.forEach(ring);
  for (let k = 0; k < S - 1; k++)
    for (let i = 0; i < seg; i++) {
      const a = k * seg + i, b = k * seg + ((i + 1) % seg), c = a + seg, d = b + seg;
      idx.push(a, b, c, b, d, c);
    }
  const cap = (k, up) => {
    const s = sections[k];
    const base = pos.length / 3;
    ring(s);
    pos.push(s.ox ?? 0, s.y, s.oz ?? 0);
    const cc = base + seg;
    for (let i = 0; i < seg; i++) {
      const a = base + i, b = base + ((i + 1) % seg);
      if (up) idx.push(cc, b, a); else idx.push(cc, a, b);
    }
  };
  if (capTop) cap(S - 1, true);
  if (capBottom) cap(0, false);
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g = g.toNonIndexed();
  return toCreasedNormals(g, (crease * Math.PI) / 180);
}

export function roundRectPath(path, x0, y0, x1, y1, r) {
  r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  path.moveTo(x0 + r, y0);
  path.lineTo(x1 - r, y0); path.quadraticCurveTo(x1, y0, x1, y0 + r);
  path.lineTo(x1, y1 - r); path.quadraticCurveTo(x1, y1, x1 - r, y1);
  path.lineTo(x0 + r, y1); path.quadraticCurveTo(x0, y1, x0, y1 - r);
  path.lineTo(x0, y0 + r); path.quadraticCurveTo(x0, y0, x0 + r, y0);
  return path;
}

/** extrude a shape with a smooth bevel; z spans [0, t]; outline preserved (bevel eats inward) */
export function extrude(shape, t, bevel = 0.05, curveSegments = 6, bevelSegments = 2, smooth = true) {
  const bs = Math.min(bevel, t / 3);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: t - 2 * bs, bevelEnabled: bs > 0, bevelThickness: bs, bevelSize: bs, bevelOffset: -bs,
    bevelSegments, curveSegments, steps: 1,
  });
  g.translate(0, 0, bs);
  return smooth ? toCreasedNormals(g, (45 * Math.PI) / 180) : g;
}

/** wall slab in the XY plane (x centred, y from 0..h) with rounded-rect holes [x0,y0,x1,y1,r]; thickness along +z */
export function slabWithHoles(w, h, t, holes, { bevel = 0.05, r = 0.15, curveSegments = 3 } = {}) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h); s.closePath();
  for (const hl of holes) s.holes.push(roundRectPath(new THREE.Path(), hl[0], hl[1], hl[2], hl[3], hl[4] ?? r));
  return extrude(s, t, bevel, curveSegments, 1, false);
}

/** annulus sector / full ring in the XY plane, thickness along z */
export function ringShape(rOut, rIn, a0 = 0, a1 = Math.PI * 2, arcSeg = 96) {
  const s = new THREE.Shape();
  const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
  if (full) {
    s.absarc(0, 0, rOut, 0, Math.PI * 2, false);
    const h = new THREE.Path(); h.absarc(0, 0, rIn, 0, Math.PI * 2, true); s.holes.push(h);
  } else {
    s.absarc(0, 0, rOut, a0, a1, false);
    s.absarc(0, 0, rIn, a1, a0, true);
    s.closePath();
  }
  return { shape: s, arcSeg };
}

// ── snow ────────────────────────────────────────────────────────────────────
const SN = makeNoise(99);
/** soft rounded snow pillow: plump, smooth, buried skirt so it never floats. Footprint w×d, peak height t. */
export function snowPillow(w, d, t, { seed = 1, seg = 20, p = 2.8, lump = 0.14, bury = 0.5 } = {}) {
  const nx = Math.max(8, Math.round(seg * Math.min(2, Math.max(0.6, w / Math.max(w, d)) + 0.2))),
        nz = Math.max(8, Math.round(seg * Math.min(2, Math.max(0.6, d / Math.max(w, d)) + 0.2)));
  const pos = [], idx = [];
  const W = nx + 1;
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const u = (i / nx) * 2 - 1, v = (j / nz) * 2 - 1;
      const m = Math.max(0, 1 - Math.pow(Math.pow(Math.abs(u), p) + Math.pow(Math.abs(v), p), 1 / p));
      const edge = Math.pow(m, 0.5);
      const n = 1 + lump * SN.n2(u * 1.6 + seed * 3.1, v * 1.6 + seed * 1.7) + lump * 0.5 * SN.n2(u * 4 + seed, v * 4);
      const y = t * edge * n - (m < 1e-4 ? bury : 0);
      pos.push(u * w / 2, y, v * d / 2);
    }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * W + i, b = a + 1, c = a + W, e = c + 1;
      idx.push(a, c, b, b, c, e);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const snowTints = [new THREE.Color(0xffffff), new THREE.Color(0xe4edff), new THREE.Color(0xd2e0ff)];
export const snowTint = (i) => snowTints[((i % 3) + 3) % 3];

// ── sculpted stylised rock ──────────────────────────────────────────────────
/** big-plane-cut blob with soft-min blending: large structural faces, rounded transitions, a few sharp-ish edges */
export function sculptRock(seed, { rx = 1, ry = 0.8, rz = 1, planes = 6, seg = 44, k = 7.5, rough = 0.1, topFlat = 0.7 } = {}) {
  const r = rng(seed * 7919 + 13);
  const nz = makeNoise(seed * 31 + 5);
  const P = [];
  for (let i = 0; i < planes; i++) {
    const a = r() * Math.PI * 2, y = (r() - 0.35) * 1.2;
    const l = Math.hypot(Math.cos(a), y, Math.sin(a));
    P.push([Math.cos(a) / l, y / l, Math.sin(a) / l, 0.62 + r() * 0.3]);
  }
  P.push([0, 1, 0, topFlat]);          // flat-ish top
  P.push([0, -1, 0, 0.42]);            // flat buried base
  const sph = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7));
  sph.deleteAttribute('uv'); sph.deleteAttribute('normal');
  const pos = sph.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const ux = pos.getX(i), uy = pos.getY(i), uz = pos.getZ(i);
    let s = Math.exp(-k * (1 + rough * nz.fbm3(ux * 2.2, uy * 2.2, uz * 2.2, 3)));
    for (const pl of P) {
      const dn = pl[0] * ux + pl[1] * uy + pl[2] * uz;
      if (dn > 0.02) s += Math.exp(-k * (pl[3] / dn));
    }
    const t = -Math.log(s) / k;
    pos.setXYZ(i, ux * t * rx, uy * t * ry, uz * t * rz);
  }
  const g = mergeVertices(sph, 1e-4);
  g.computeVertexNormals();
  return g;
}

// ── LOD wrapper ─────────────────────────────────────────────────────────────
/**
 * Build a structure at 4 detail levels. `build(lod, B, col)` fills a Batch in local space (origin = ground centre)
 * and may register local collision boxes via col(minX,minY,minZ,maxX,maxY,maxZ) (called for lod 0 only).
 */
export function makeStructure(build, { x = 0, y = 0, z = 0, yaw = 0, lods = [0, 110, 260, 560], cast = true, cull = 0 } = {}) {
  const lod = new THREE.LOD();
  const boxes = [];
  const levels = Math.min(4, lods.length);
  for (let l = 0; l < levels; l++) {
    const B = new Batch();
    build(l, B, l === 0 ? (a, b, c, d, e, f) => boxes.push([a, b, c, d, e, f]) : () => {});
    const grp = B.build(cast && l < 3);
    lod.addLevel(grp, lods[l]);
  }
  if (cull) lod.addLevel(new THREE.Group(), cull);
  lod.position.set(x, y, z);
  lod.rotation.y = yaw;
  lod.updateMatrixWorld(true);
  // transform local boxes to world (yaw is a multiple of 90°)
  const c = Math.round(Math.cos(yaw)), s = Math.round(Math.sin(yaw));
  const colliders = boxes.map(([a, b, cz, d, e, f]) => {
    const xs = [], zs = [];
    for (const px of [a, d]) for (const pz of [cz, f]) { xs.push(px * c + pz * s + x); zs.push(-px * s + pz * c + z); }
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), minY: b + y, maxY: e + y };
  });
  return { object: lod, colliders };
}

// ── sub-frames (rotate/offset a whole group of parts + their colliders) ──────────────────────────
/** rotate local box [minX,minY,minZ,maxX,maxY,maxZ] by yaw (multiple of 90°) then translate */
export function xformBox(yaw, tx, ty, tz, b) {
  const c = Math.round(Math.cos(yaw)), s = Math.round(Math.sin(yaw));
  const xs = [], zs = [];
  for (const px of [b[0], b[3]]) for (const pz of [b[2], b[5]]) { xs.push(px * c + pz * s + tx); zs.push(-px * s + pz * c + tz); }
  return [Math.min(...xs), b[1] + ty, Math.min(...zs), Math.max(...xs), b[4] + ty, Math.max(...zs)];
}
/** returns {B, col} that emit parts/colliders through a rigid transform (yaw multiple of 90°) */
export function frame(B, col, tx, ty, tz, yaw = 0) {
  const base = M(tx, ty, tz, 0, yaw, 0);
  return {
    B: { add(key, geo, m, o) { B.add(key, geo, m ? base.clone().multiply(m) : base, o); return this; } },
    col: (a, b, c, d, e, f) => { const x = xformBox(yaw, tx, ty, tz, [a, b, c, d, e, f]); col(...x); },
  };
}
