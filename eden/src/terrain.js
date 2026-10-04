// Analytic height-field world: the same function drives rendering, collision and prop placement.
import * as THREE from 'three';
import { makeNoise, clamp, lerp, sstep } from './noise.js';
import { terrainMaterial } from './materials.js';

const N = makeNoise(20240611);

export const HALF_X = 215;      // playable half width
export const Z_START = 275;     // south edge (spawn side)
export const Z_END = -205;      // north edge (factory gate side)
export const PLATEAU_H = 64;    // height of the high outer plateau that frames the map

// ── layout helpers ────────────────────────────────────────────────────────────
export const canyonX = (z) => 9 * Math.sin(z * 0.017 + 0.6);
const gauss = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
const canyonHalfWidth = (z) =>
  44 + 100 * sstep(4, 50, z) - 15 * gauss(z, -58, 30) + 9 * gauss(z, -128, 28);
const canyonFloor = (z) => -17 * sstep(14, -58, z) - 2.5 * sstep(-60, -170, z);

// Registered building footprints: snow drifts pile against them and ground AO darkens around them
export const FOOTPRINTS = [];
export function addFootprint(f) { FOOTPRINTS.push(f); }

function footprintField(x, z) {
  let drift = 0, ao = 0;
  for (let i = 0; i < FOOTPRINTS.length; i++) {
    const f = FOOTPRINTS[i];
    const qx = Math.abs(x - f.x) - f.hx, qz = Math.abs(z - f.z) - f.hz;
    if (qx > 14 || qz > 14) continue;
    const d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
    drift = Math.max(drift, (f.drift ?? 0.8) * sstep(5.5, 0.2, d) * (0.75 + 0.25 * Math.sin(x * 0.31 + z * 0.23)));
    ao = Math.max(ao, sstep(3.2, 0, d));
  }
  return { drift, ao };
}

// terrace: stepped strata with softly rounded risers
function terrace(t, n, sharp) {
  const s = clamp(t) * n;
  const i = Math.min(Math.floor(s), n - 1);
  const f = s - i;
  return (i + sstep(0.5 - sharp, 0.5 + sharp, f)) / n;
}

// wind-sculpted dunes: long flowing ridges leaning along the wind direction
function dunes(x, z) {
  const wx = x * 0.9 + z * 0.42, wz = z * 0.9 - x * 0.42;
  const warp = N.n2(x * 0.006, z * 0.006) * 28;
  const big = N.fbm2((wx + warp) * 0.0125, (wz - warp) * 0.019, 3) * 26;
  const mid = N.n2(wx * 0.03 + 3.1, wz * 0.055) * 4.2;
  const rip = N.n2(wx * 0.1, wz * 0.18) * 0.35;
  return big + mid + rip;
}

const mesas = [
  // x, z, radius, height, terraces
  [-150, 205, 38, 30, 4], [165, 190, 32, 24, 3], [-120, 255, 24, 18, 3], [118, 262, 28, 22, 3],
  [-185, 120, 30, 36, 4], [182, 100, 34, 40, 4], [-175, 20, 26, 28, 3], [176, 10, 30, 34, 4],
];

export function heightAt(x, z) {
  const flat = sstep(150, 138, z) * sstep(28, 40, z) * sstep(190, 170, Math.abs(x));
  const entrance = sstep(140, 175, z);
  let h = dunes(x, z) * (0.2 + 0.8 * entrance) * (1 - 0.88 * flat);
  // subtle wind-swell on the city plateau
  h += N.n2(x * 0.02, z * 0.03) * 0.5 * flat;

  // canyon
  const cx = canyonX(z);
  const cm = sstep(32, -2, z);
  h += canyonFloor(z);
  const warp = N.n2(x * 0.03, z * 0.03) * 6 + N.n2(x * 0.06, z * 0.06) * 1.5;
  const dx = Math.abs(x - cx) + warp;
  const wallT = sstep(0, 62, dx - canyonHalfWidth(z));
  h += cm * (PLATEAU_H - 8) * terrace(wallT, 6, 0.42) * (0.94 + 0.06 * N.n2(x * 0.05, z * 0.05));
  // talus at wall base
  h += cm * 2.2 * sstep(-7, 3, dx - canyonHalfWidth(z)) * (1 - wallT);

  // mesas on the entrance / city flanks
  for (let i = 0; i < mesas.length; i++) {
    const m = mesas[i];
    const d = Math.hypot(x - m[0] + N.n2(x * 0.03, z * 0.03) * 12, (z - m[1]) * (1 + 0.35 * Math.sin(i * 2.3)) + N.n2(x * 0.04 + 9, z * 0.04) * 10);
    const t = sstep(m[2] + 34, m[2] - 14, d);
    if (t > 0) h += m[3] * terrace(t, m[4], 0.4);
  }

  // outer frame
  const bx = Math.max(0, Math.abs(x) - HALF_X + warp * 0.5);
  const bzs = Math.max(0, z - Z_START + 6 + warp * 0.5);
  const bzn = Math.max(0, Z_END - z - 0 + warp * 0.5);
  const b = Math.max(bx, bzs, bzn);
  h = lerp(h, PLATEAU_H + 6 * N.n2(x * 0.02, z * 0.02), terrace(sstep(0, 70, b), 5, 0.4));

  h += footprintField(x, z).drift;
  return h;
}

export function slopeAt(x, z) {
  const e = 0.6;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

const tmp = new THREE.Color();
// ── colouring ────────────────────────────────────────────────────────────────
// Vertex colour carries snow tint × ground AO; `tr` = (rockMask, ao). The rock strata (blue-grey with
// occasional red-orange bands) are painted per-pixel from world height in the terrain shader, so band
// edges stay crisp at any terrain LOD.
const cSnowA = new THREE.Color(0xfaFcff), cSnowB = new THREE.Color(0xd3e1fb);

export function snowColorAt(x, z, ny, out) {
  const t = 0.5 + 0.5 * N.n2(x * 0.014 + 7, z * 0.019);
  const t2 = 0.5 + 0.5 * N.n2(x * 0.05, z * 0.05);
  return out.copy(cSnowA).lerp(cSnowB, clamp(t * 0.3 + t2 * 0.08 + sstep(0.97, 0.84, ny) * 0.3));
}
export const rockMask = (ny) => sstep(0.9, 0.74, ny);

// ── chunked, LOD'd mesh ─────────────────────────────────────────────────────
const CHUNK = 64;
const LOD_SEGS = [128, 96, 64, 40];
const LOD_DIST = [110, 220, 380];

function buildChunk(cx, cz, lod) {
  const segs = LOD_SEGS[lod];
  const step = CHUNK / segs;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const n = segs + 1, pn = n + 4;
  const H = new Float32Array(pn * pn);
  for (let j = 0; j < pn; j++)
    for (let i = 0; i < pn; i++) H[j * pn + i] = heightAt(x0 + (i - 2) * step, z0 + (j - 2) * step);

  const skirt = 3.5;
  const verts = n * n + 4 * n;
  const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), col = new Float32Array(verts * 3), tr = new Float32Array(verts * 2);
  const c = new THREE.Color();
  const hasFoot = FOOTPRINTS.length > 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const c0 = (j + 2) * pn + i + 2;
      const h = H[c0];
      const x = x0 + i * step, z = z0 + j * step;
      // blend 1-cell and 2-cell central differences: stable contours on steep terraces
      const hx = ((H[c0 + 1] - H[c0 - 1]) / (2 * step) + (H[c0 + 2] - H[c0 - 2]) / (4 * step)) * 0.5;
      const hz = ((H[c0 + pn] - H[c0 - pn]) / (2 * step) + (H[c0 + 2 * pn] - H[c0 - 2 * pn]) / (4 * step)) * 0.5;
      const l = Math.hypot(hx, 1, hz);
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      nor[k * 3] = -hx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = -hz / l;
      snowColorAt(x, z, 1 / l, c);
      let ao = 0;
      if (hasFoot) ao = footprintField(x, z).ao;
      c.multiply(tmp.setRGB(1 - 0.24 * ao, 1 - 0.19 * ao, 1 - 0.07 * ao));
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      tr[k * 2] = rockMask(1 / l); tr[k * 2 + 1] = 1 - 0.3 * ao;
    }
  }
  // skirts hide cracks between neighbouring LOD levels
  let sv = n * n;
  const edges = [];
  for (let i = 0; i < n; i++) edges.push(i);                         // z0 edge
  for (let j = 0; j < n; j++) edges.push(j * n + n - 1);             // x1 edge
  for (let i = n - 1; i >= 0; i--) edges.push((n - 1) * n + i);      // z1 edge
  for (let j = n - 1; j >= 0; j--) edges.push(j * n);                // x0 edge
  for (const e of edges) {
    pos[sv * 3] = pos[e * 3]; pos[sv * 3 + 1] = pos[e * 3 + 1] - skirt; pos[sv * 3 + 2] = pos[e * 3 + 2];
    nor[sv * 3] = nor[e * 3]; nor[sv * 3 + 1] = nor[e * 3 + 1]; nor[sv * 3 + 2] = nor[e * 3 + 2];
    col[sv * 3] = col[e * 3]; col[sv * 3 + 1] = col[e * 3 + 1]; col[sv * 3 + 2] = col[e * 3 + 2];
    tr[sv * 2] = tr[e * 2]; tr[sv * 2 + 1] = tr[e * 2 + 1];
    sv++;
  }
  const idx = [];
  for (let j = 0; j < segs; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  // skirt quads along the ring of edge vertices
  const ring = edges.length;
  for (let s = 0; s < ring; s++) {
    const s2 = (s + 1) % ring;
    // skip the wrap quads between the 4 edge runs where the ring jumps corners
    const a = edges[s], b = edges[s2], sa = n * n + s, sb = n * n + s2;
    const d1 = Math.abs(pos[a * 3] - pos[b * 3]) + Math.abs(pos[a * 3 + 2] - pos[b * 3 + 2]);
    if (d1 > step * 1.5) continue;
    idx.push(a, b, sa, b, sb, sa);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tr', new THREE.BufferAttribute(tr, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class Terrain {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.chunks = new Map();
    this.cache = new Map();
    this.queue = [];
    const x0 = Math.floor((-HALF_X - 70) / CHUNK), x1 = Math.ceil((HALF_X + 70) / CHUNK);
    const z0 = Math.floor((Z_END - 70) / CHUNK), z1 = Math.ceil((Z_START + 70) / CHUNK);
    for (let cz = z0; cz < z1; cz++)
      for (let cx = x0; cx < x1; cx++) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), terrainMaterial);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        mesh.frustumCulled = true;
        mesh.visible = false;
        this.group.add(mesh);
        this.chunks.set(cx + ',' + cz, { cx, cz, mesh, lod: -1, want: -1, center: new THREE.Vector3((cx + 0.5) * CHUNK, 0, (cz + 0.5) * CHUNK) });
      }
    // far apron so the plateau never ends in the void
    const apronMat = new THREE.MeshToonMaterial({ color: 0xdfe9ff, gradientMap: terrainMaterial.gradientMap });
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), apronMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(0, PLATEAU_H + 1, 0);
    apron.receiveShadow = false;
    this.group.add(apron);
  }
  geo(ch, lod) {
    const key = ch.cx + ',' + ch.cz + ',' + lod;
    let g = this.cache.get(key);
    if (!g) { g = buildChunk(ch.cx, ch.cz, lod); this.cache.set(key, g); }
    return g;
  }
  lodFor(d) { return d < LOD_DIST[0] ? 0 : d < LOD_DIST[1] ? 1 : d < LOD_DIST[2] ? 2 : 3; }
  /** Build everything near `p` synchronously (used at startup). */
  prime(p) {
    for (const ch of this.chunks.values()) {
      const d = Math.hypot(ch.center.x - p.x, ch.center.z - p.z) - CHUNK * 0.7;
      const lod = this.lodFor(Math.max(d, 0));
      ch.lod = lod; ch.want = lod;
      ch.mesh.geometry = this.geo(ch, lod);
      ch.mesh.visible = true;
    }
  }
  update(p) {
    for (const ch of this.chunks.values()) {
      const d = Math.hypot(ch.center.x - p.x, ch.center.z - p.z) - CHUNK * 0.7;
      const lod = this.lodFor(Math.max(d, 0));
      if (lod !== ch.want) { ch.want = lod; if (!this.queue.includes(ch)) this.queue.push(ch); }
    }
    // one geometry build per frame to avoid hitching
    const ch = this.queue.shift();
    if (ch && ch.want !== ch.lod) {
      ch.mesh.geometry = this.geo(ch, ch.want);
      ch.lod = ch.want;
      ch.mesh.visible = true;
    }
  }
}
