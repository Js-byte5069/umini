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
// Per material family: part-to-part painted drift (value v, hue h as an rgb multiplier at +1) and the soft highlight an exposed convex edge picks up.
const KEY_STYLE = {
  wall:       { g: 0.055, v: 0.065, h: [0.035, 0.000, -0.050], edge: [1.12, 1.13, 1.17] },
  wallLight:  { g: 0.045, v: 0.055, h: [0.035, 0.000, -0.050], edge: [1.10, 1.11, 1.15] },
  wallDark:   { g: 0.055, v: 0.060, h: [0.035, 0.000, -0.050], edge: [1.14, 1.15, 1.20] },
  trim:       { g: 0.040, v: 0.050, h: [0.030, 0.000, -0.040], edge: [1.10, 1.11, 1.15] },
  metal:      { g: 0.030, v: 0.045, h: [0.020, 0.000, -0.030], edge: [1.16, 1.17, 1.22] },
  deck:       { g: 0.040, v: 0.055, h: [0.030, 0.000, -0.045], edge: [1.10, 1.11, 1.15] },
  accent:     { g: 0.060, v: 0.055, h: [0.040, 0.100, -0.080], edge: [1.08, 1.19, 1.15] },
  accentDark: { g: 0.060, v: 0.055, h: [0.040, 0.100, -0.080], edge: [1.10, 1.22, 1.16] },
  rockBlue:   { g: 0.040, v: 0.050, h: [0.020, 0.000, -0.030], edge: [1.08, 1.09, 1.12] },
  rockRed:    { g: 0.040, v: 0.050, h: [0.040, 0.090, -0.070], edge: [1.07, 1.14, 1.10] },
};
const SUNV = new THREE.Vector3(-0.78, 0.55, 0.1).normalize();
const hash1 = (x, y, z, s) => { const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + s * 4.1414) * 43758.5453; return h - Math.floor(h); };
let _keySeed = new Map();
const keySeed = (k) => { let v = _keySeed.get(k); if (v === undefined) { v = 0; for (let i = 0; i < k.length; i++) v = (v * 31 + k.charCodeAt(i)) % 997; _keySeed.set(k, v); } return v; };

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
    const style = !tint && !o.noAO ? KEY_STYLE[key] : null;
    // painted drift: every placed part gets its own slight value / hue shift (stable across LODs: keyed on the placement, not the mesh)
    let jv = 1, jr = 1, jg = 1, jb = 1;
    if (style) {
      let cx, cy, cz;
      if (matrix) { const e = matrix.elements; cx = e[12]; cy = e[13]; cz = e[14]; }
      else { g.computeBoundingBox(); const b = g.boundingBox; cx = Math.round((b.min.x + b.max.x) / 8); cy = Math.round((b.min.y + b.max.y) / 8); cz = Math.round((b.min.z + b.max.z) / 8); }
      const s = keySeed(key);
      const r1 = hash1(cx, cy, cz, s) * 2 - 1, r2 = hash1(cx + 1.7, cy - 3.1, cz + 5.3, s + 7) * 2 - 1;
      jv = 1 + r1 * style.v;
      jr = jv * (1 + r2 * style.h[0]); jg = jv * (1 + r2 * style.h[1]); jb = jv * (1 + r2 * style.h[2]);
    }
    // painted gradient across each placed part (lighter / warmer at its top, deeper / cooler at its foot): large faces never read as one flat fill
    let gy0 = 0, gHi = 0;
    if (style) { g.computeBoundingBox(); const bb = g.boundingBox; gy0 = bb.min.y; gHi = bb.max.y - bb.min.y; if (gHi < 0.9) gHi = 0; }
    // stylised edges: triangles that bend the normal over a short run (rounded bevels / chamfers) are exposed convex edges: they pick up a soft light edge
    let edge = null;
    if (style) {
      edge = new Float32Array(pos.count);
      for (let t = 0; t + 2 < pos.count; t += 3) {
        const ax = pos.getX(t), ay = pos.getY(t), az = pos.getZ(t);
        const bx = pos.getX(t + 1), by = pos.getY(t + 1), bz = pos.getZ(t + 1);
        const cx2 = pos.getX(t + 2), cy2 = pos.getY(t + 2), cz2 = pos.getZ(t + 2);
        const l2 = Math.max((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2, (bx - cx2) ** 2 + (by - cy2) ** 2 + (bz - cz2) ** 2, (cx2 - ax) ** 2 + (cy2 - ay) ** 2 + (cz2 - az) ** 2);
        if (l2 > 0.2) continue;           // longer than ~0.45 m: a surface, not a bevel
        const n0x = nor.getX(t), n0y = nor.getY(t), n0z = nor.getZ(t), n1x = nor.getX(t + 1), n1y = nor.getY(t + 1), n1z = nor.getZ(t + 1), n2x = nor.getX(t + 2), n2y = nor.getY(t + 2), n2z = nor.getZ(t + 2);
        const d = Math.min(n0x * n1x + n0y * n1y + n0z * n1z, n1x * n2x + n1y * n2y + n1z * n2z, n0x * n2x + n0y * n2y + n0z * n2z);
        if (d > 0.996) continue;          // flat (< ~5 degrees): not an edge
        const my = (n0y + n1y + n2y) / 3;
        if (my < -0.3) continue;          // undersides stay calm
        const sun = (n0x + n1x + n2x) / 3 * SUNV.x + my * SUNV.y + (n0z + n1z + n2z) / 3 * SUNV.z;
        const w = 0.55 + 0.45 * clamp(sun * 1.6 + 0.5, 0, 1);       // sunward edges catch the most light
        edge[t] = edge[t + 1] = edge[t + 2] = w;
      }
    }
    for (let i = 0; i < pos.count; i++) {
      let k = 1;
      if (!o.noAO) {
        const y = pos.getY(i);
        k = lerp(0.74, 1, sstep(-1, 9, y));
        if (nor.getY(i) < -0.35) k *= 0.84;
      }
      if (baked) k *= 0.58 + 0.42 * baked.getX(i);
      let er = 1, eg = 1, eb = 1;
      if (edge && edge[i] > 0) { const w = edge[i], e = style.edge; er = 1 + (e[0] - 1) * w; eg = 1 + (e[1] - 1) * w; eb = 1 + (e[2] - 1) * w; }
      let gr = 1, gg = 1, gb = 1;
      if (gHi > 0) { const t = clamp((pos.getY(i) - gy0) / gHi, 0, 1) * 2 - 1, gv = style.g * t; gr = 1 + gv * 1.15; gg = 1 + gv; gb = 1 + gv * 0.8; }
      col[i * 3] = Math.pow(k, 1.15) * (tint ? tint.r : jr * er * gr);
      col[i * 3 + 1] = k * (tint ? tint.g : jg * eg * gg);
      col[i * 3 + 2] = Math.pow(k, 0.86) * (tint ? tint.b : jb * eb * gb);
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
/** thick, soft, rounded snow pillow: plump shoulder, organic (noise-warped) outline, lumpy crown, buried skirt so it never floats.
 *  Footprint w×d, peak height t. The outline only ever pulls inward (never outside w×d); the steep lip is shaded a little darker / cooler through the baked colour. */
export function snowPillow(w, d, t, { seed = 1, seg = 20, p = 2.8, lump = 0.14, bury = 0.5 } = {}) {
  // POLAR tessellation: the outline is a smooth ring of M points, not the edge of a square grid. Where the lip meets the terrain / roof the
  // intersection curve is therefore smooth (a square grid draws it as a 1-cell staircase, visible on every snow pad and pier foot).
  const M = Math.max(24, Math.min(48, Math.round(seg * 1.8))), R = Math.max(6, Math.min(12, Math.round(seg * 0.55)));
  const pos = [0, 0, 0], idx = [], mm = [0];
  const ring = (i) => 1 + (i - 1) * M;                                  // first vertex index of ring i (1..R); vertex 0 is the centre
  for (let i = 1; i <= R; i++) {
    const q = i / R, sr = lerp(q, Math.sin(q * Math.PI / 2), 0.6);      // rings crowd toward the outline (the profile changes fastest there)
    for (let k = 0; k < M; k++) {
      const a = (k / M) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      const norm = Math.pow(Math.pow(Math.abs(c), p) + Math.pow(Math.abs(sn), p), 1 / p);      // superellipse: unit radius along this direction
      const u = (c / norm) * sr, v = (sn / norm) * sr;
      const wob = 1 + 0.10 * (0.5 + 0.5 * SN.n2(u * 1.5 + seed * 3.1, v * 1.5 + seed * 1.3)) + 0.05 * (0.5 + 0.5 * SN.n2(u * 4.6 + seed, v * 4.6 + 7.7));
      const m = Math.max(0, 1 - sr * wob);
      const edge = Math.pow(m, 0.42);
      const n = 1 + lump * SN.n2(u * 1.6 + seed * 3.1, v * 1.6 + seed * 1.7) + lump * 0.5 * SN.n2(u * 4 + seed, v * 4);
      pos.push(u * w / 2, t * edge * n - (m < 1e-4 ? bury : 0), v * d / 2);
      mm.push(m);
    }
  }
  { const m0 = 1, n0 = 1 + lump * SN.n2(seed * 3.1, seed * 1.7); pos[1] = t * Math.pow(m0, 0.42) * n0; mm[0] = 1; }
  for (let k = 0; k < M; k++) idx.push(0, ring(1) + ((k + 1) % M), ring(1) + k);
  for (let i = 1; i < R; i++)
    for (let k = 0; k < M; k++) {
      const a = ring(i) + k, b = ring(i) + ((k + 1) % M), c = ring(i + 1) + k, e = ring(i + 1) + ((k + 1) % M);
      idx.push(a, b, c, b, e, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // steep lip walls sit a shade deeper / cooler than the crown (read by Batch as the baked-AO channel)
  const nA = g.attributes.normal, cl = new Float32Array(pos.length);
  for (let i = 0; i < mm.length; i++) {
    const x = 1 - 0.45 * (1 - sstep(0.3, 0.8, nA.getY(i))) * (1 - 0.5 * sstep(0.3, 0.7, mm[i]));
    cl[i * 3] = cl[i * 3 + 1] = cl[i * 3 + 2] = x;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cl, 3));
  return g;
}

const snowTints = [new THREE.Color(0xffffff), new THREE.Color(0xf0f4ff), new THREE.Color(0xe3ebff)];
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
