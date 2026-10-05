// Boulder scatter: clusters of Blender-sculpted rocks (rounded boulders, angular chunks, slabs, strata stacks)
// with thick snow caps, snow banks at their feet and pebble rubble. One merged LOD object per cluster, indexed
// geometry (smooth normals, baked AO) so hundreds of rocks stay cheap. Procedural fallback if rocks.glb is missing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MAT, RAMP_TERRAIN } from './materials.js';
import { M, sculptRock, snowPillow, snowTint } from './kit.js';
import { rng, lerp, sstep, clamp, makeNoise } from './noise.js';
import { heightAt, slopeAt, canyonX, canyonHalfWidthAt, snowColorAt, HALF_X } from './terrain.js';

const SN = makeNoise(4242);

// snow caps / drifts: pale cel material whose per-vertex mask (aMask, interpolated) is thresholded per pixel, so the
// contour of every cap is a smooth iso-line instead of a triangle-jagged edge (alpha-to-coverage gives it MSAA edges)
const capMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP_TERRAIN, vertexColors: true, alphaToCoverage: true });      // same ramp as the snow field: banks / caps shade like the ground they sit on
capMat.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aMask;\nvarying float vMask;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n vMask = aMask;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vMask;')
    .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.a = smoothstep(0.44, 0.56, vMask);\n if (diffuseColor.a < 0.01) discard;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.03, 0.05, 0.118);   // the terrain\'s cool snow bounce');
};
capMat.polygonOffset = true; capMat.polygonOffsetFactor = -2; capMat.polygonOffsetUnits = -2;      // the cap always wins against the rock body it hugs
capMat.customProgramCacheKey = () => 'scatter-cap2';
const SC = { rocks: [], ok: false };

// variant index ranges mirrored from tools/gen_rocks.py (HERO = the dense-mesh variants used for 2 m+ rocks)
const HERO = new Set([0, 1, 5, 6, 9]);
const KIND_IDX = { boulder: [0, 1, 2, 3, 4], chunk: [5, 6, 7, 8], slab: [9, 10, 11], strata: [12, 13, 14] };
const BASE_OFF = { boulder: 0.40, chunk: 0.40, slab: 0.20, strata: 0.45 };      // unit-rock bottom below origin
const SQUASH = { boulder: [0.72, 1.0], chunk: [0.8, 1.15], slab: [0.65, 0.95], strata: [1.5, 2.5] };
const kindOf = (idx) => (idx < 5 ? 'boulder' : idx < 9 ? 'chunk' : idx < 12 ? 'slab' : 'strata');

export async function loadScatter() {
  if (new URLSearchParams(location.search).has('norocks')) return;       // debug: force the procedural fallback
  try {
    const gltf = await new GLTFLoader().loadAsync(new URL('../assets/rocks.glb', import.meta.url).href);
    const by = {};
    gltf.scene.traverse((o) => { if (o.isMesh) by[o.name] = o.geometry; });
    for (let i = 0; i < 64; i++) {
      const lod = [0, 1, 2].map((l) => by[`rock${i}_lod${l}`]);
      if (!lod[0]) break;
      SC.rocks.push({ lod, snow: [by[`rock${i}_snow_lod0`] ?? null, by[`rock${i}_snow_lod1`] ?? null] });
    }
    SC.ok = SC.rocks.length >= 15;
  } catch (e) { console.warn('scatter rock assets unavailable, procedural fallback', e); }
}

// ── procedural fallback (no GLB) ─────────────────────────────────────────────────────────────
const fbCache = new Map();
function fallbackEntry(idx) {
  let e = fbCache.get(idx);
  if (e) return e;
  const kind = kindOf(idx);
  const ry = kind === 'slab' ? 0.55 : 0.85;
  const lod = [44, 28, 18].map((seg) => sculptRock(idx * 13 + 5, { rx: 1, ry, rz: 0.9, seg, topFlat: kind === 'slab' ? 0.45 : 0.7, k: kind === 'boulder' ? 4 : 7.5 }));
  e = { lod, snow: [null, null] };
  fbCache.set(idx, e);
  return e;
}
const entryOf = (idx) => (SC.rocks.length ? SC.rocks[((idx % SC.rocks.length) + SC.rocks.length) % SC.rocks.length] : fallbackEntry(idx));

// ── merged, indexed geometry per material ─────────────────────────────────────────────────────
class Merge {
  constructor() { this.P = []; this.N = []; this.C = []; this.I = []; this.K = []; this.base = 0; }
  add(src, mat, tint, yLocal = 0, noAO = false, hRef = 9) {
    const pos = src.attributes.position, nor = src.attributes.normal, baked = src.attributes.color, idx = src.index;
    const tmask = src.attributes.tmask, tcol = src.attributes.tcol;      // snow banks: smooth rim mask + terrain-matched colour
    const n = pos.count;
    const nm = new THREE.Matrix3().getNormalMatrix(mat);
    const v = new THREE.Vector3(), nv = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      nv.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      this.P.push(v.x, v.y, v.z); this.N.push(nv.x, nv.y, nv.z);
      let k = 1;
      if (!noAO) {
        k = lerp(0.66, 1, sstep(-0.15 * hRef, 0.95 * hRef, v.y - yLocal));
        if (nv.y < -0.35) k *= 0.80;
        if (baked) k *= 0.42 + 0.58 * baked.getX(i);
      }
      if (tcol) this.C.push(tcol.getX(i), tcol.getY(i), tcol.getZ(i));
      else this.C.push(Math.pow(k, 1.15) * (tint ? tint.r : 1), k * (tint ? tint.g : 1), Math.pow(k, 0.86) * (tint ? tint.b : 1));
      this.K.push(tmask ? tmask.getX(i) : noAO && baked ? baked.getX(i) : 1);
    }
    if (idx) for (let i = 0; i < idx.count; i++) this.I.push(idx.getX(i) + this.base);
    else for (let i = 0; i < n; i++) this.I.push(i + this.base);
    this.base += n;
  }
  build() {
    if (!this.base) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aMask', new THREE.Float32BufferAttribute(this.K, 1));
    g.setIndex(this.base > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// plump snow bank hugging a rock's foot, conforming to the ground (built in cluster-local space).
// The bank's rim fades out through a per-vertex mask that the cap shader thresholds per pixel (smooth contour, no polygon outline),
// and its normals / colours are blended into the terrain's own, so the bank melts into the snow field instead of reading as a pasted polygon.
function driftGeo(wx, wz, rx, rz, h, seed, ox, oy, oz, lee) {
  const rings = 7, segs = 28, R = 1.5;
  const P = [], I = [], W = [], M = [];
  const addV = (x, z, dy, m) => { const y = heightAt(x, z) + dy; P.push(x - ox, y - oy, z - oz); W.push(x, z, y); M.push(m); };
  addV(wx, wz, h * 0.9, 1);
  for (let ri = 1; ri <= rings; ri++) {
    const t = ri / rings;
    for (let si = 0; si < segs; si++) {
      const a = (si / segs) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const wob = 1 + 0.18 * SN.n2(ca * 1.7 + seed, sa * 1.7);
      const lump = 1 + 0.5 * Math.max(0, ca * lee[0] + sa * lee[1]);           // longer, thicker tail on the lee side
      const x = wx + ca * rx * (0.55 + (R - 0.55) * t) * wob * lump, z = wz + sa * rz * (0.55 + (R - 0.55) * t) * wob * lump;
      const prof = Math.pow(1 - sstep(0.15, 1.0, t), 1.35) * lump;
      addV(x, z, h * prof * (0.85 + 0.3 * SN.n2(x * 0.5 + seed, z * 0.5)) - 0.02 * t, 1 - sstep(0.52, 1.0, t));
    }
  }
  for (let si = 0; si < segs; si++) I.push(0, 1 + ((si + 1) % segs), 1 + si);
  for (let ri = 1; ri < rings; ri++)
    for (let si = 0; si < segs; si++) {
      const a = 1 + (ri - 1) * segs + si, b = 1 + (ri - 1) * segs + ((si + 1) % segs), c = a + segs, d = b + segs;
      I.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  // blend toward the terrain's own normal / colour with distance from the rock
  const nA = g.attributes.normal, n = P.length / 3, col = new Float32Array(n * 3), tmp = new THREE.Color();
  const e = 0.7;
  for (let i = 0; i < n; i++) {
    const x = W[i * 3], z = W[i * 3 + 1];
    const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e), gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    const l = Math.hypot(gx, 1, gz);
    const m = M[i], w = sstep(0.5, 1.0, m);                   // 1 at the rock, 0 exactly at the visible rim (mask 0.5): zero shading seam
    const nx = lerp(-gx / l, nA.getX(i), w), ny = lerp(1 / l, nA.getY(i), w), nz = lerp(-gz / l, nA.getZ(i), w);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nA.setXYZ(i, nx / nl, ny / nl, nz / nl);
    snowColorAt(x, z, 1 / l, tmp);
    col[i * 3] = tmp.r * 0.948; col[i * 3 + 1] = tmp.g * 0.968; col[i * 3 + 2] = tmp.b * 0.992;      // = the terrain shader's snow tint
  }
  g.setAttribute('tcol', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tmask', new THREE.Float32BufferAttribute(M, 1));
  return g;
}

// ── cluster → LOD object ──────────────────────────────────────────────────────────────────────────
function buildCluster(spec, items, ground) {
  const ox = spec.x, oz = spec.z, oy = ground(ox, oz);
  const colliders = [];
  const prepared = items.map((it) => {
    const kind = kindOf(it.idx), r = it.size;
    const sx = r * it.ax, sz = r * it.az, sy = r * it.sq;
    // base on the lowest ground under the footprint, buried by a fraction of the height
    let g = 1e9;
    for (const [dx, dz] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) g = Math.min(g, ground(it.x + dx * sx, it.z + dz * sz));
    const y = g + BASE_OFF[kind] * sy - it.sink * sy;
    return { ...it, kind, sx, sy, sz, gy: g, mat: M(it.x - ox, y - oy, it.z - oz, it.tx, it.yaw, it.tz, sx, sy, sz) };
  });
  const drifts = [];
  for (const p of prepared) {
    if (p.drift) drifts.push(driftGeo(p.x, p.z, p.sx, p.sz, p.drift * 0.7 * p.sy, p.idx, ox, oy, oz, [-0.78, 0.1]));
    if (p.size > 2.2 && p.kind !== 'slab' || p.size > 3.2) {
      const m = Math.max(p.sx, p.sz) * (p.kind === 'strata' ? 0.55 : 0.5);
      colliders.push({ minX: p.x - m, maxX: p.x + m, minZ: p.z - m, maxZ: p.z + m, minY: p.gy - 1, maxY: p.gy + p.sy * (p.kind === 'strata' ? 1.2 : 0.8) });
    }
  }
  const lod = new THREE.LOD();
  const dists = [0, spec.lod0 ?? 18, spec.lod1 ?? 60, spec.lod2 ?? 160];
  const big = prepared.some((p) => p.size > 2.0);
  for (let l = 0; l < 4; l++) {
    const mr = new Merge(), mb = new Merge(), ms = new Merge();
    for (const p of prepared) {
      const small = p.size < 0.9;
      if (l === 3 && small) continue;                                  // far: pebbles vanish
      const e = entryOf(p.idx);
      const gl = Math.min(2, l + (small ? 1 : 0));                      // small rocks start one detail level down, never at the coarsest while close
      (p.red ? mr : mb).add(e.lod[gl], p.mat, null, p.mat.elements[13] - 0.4 * p.sy, false, p.sy * 1.3);
      if (p.cap && l < 2) {
        const sg = e.snow[l === 0 && !small ? 0 : 1] ?? null;
        if (sg) ms.add(sg, p.mat, snowTint(p.idx), 0, true);
        else if (!SC.ok && p.size > 1.4) ms.add(snowPillow(2.0, 1.8, 0.34, { seed: p.idx, seg: 10, bury: 0.2 }), M(p.x - ox, p.mat.elements[13] + 0.62 * p.sy, p.z - oz, 0, p.yaw, 0, p.sx, p.sy, p.sz), snowTint(p.idx), 0, true);
      }
    }
    if (l < 2) for (const d of drifts) ms.add(d, new THREE.Matrix4(), snowTint(3), 0, true);
    const grp = new THREE.Group();
    for (const [mer, key] of [[mr, 'rockRed'], [mb, 'rockBlue'], [ms, 'snow']]) {
      const g = mer.build();
      if (!g) continue;
      const mkey = l < 2 && key !== 'snow' && SC.ok ? key + 'N' : key;      // near levels: real cap meshes, no painted snow
      const mesh = new THREE.Mesh(g, key === 'snow' ? capMat : MAT[mkey]);
      mesh.castShadow = big && l < 2 && key !== 'snow';
      mesh.receiveShadow = true;
      grp.add(mesh);
    }
    lod.addLevel(grp, dists[l]);
  }
  lod.addLevel(new THREE.Group(), spec.cull ?? 520);
  lod.position.set(ox, oy, oz);
  lod.updateMatrixWorld(true);
  return { object: lod, colliders };
}

// ── cluster layout ──────────────────────────────────────────────────────────────────────────────
function pickKind(r, w) {
  let t = r() * (w.boulder + w.chunk + w.slab + (w.strata || 0));
  if ((t -= w.boulder) < 0) return 'boulder';
  if ((t -= w.chunk) < 0) return 'chunk';
  if ((t -= w.slab) < 0) return 'slab';
  return 'strata';
}
function pickIdx(r, kind, size) {
  const ids = KIND_IDX[kind];
  if (kind === 'strata') return ids[Math.floor(r() * ids.length)];
  const heroes = ids.filter((i) => HERO.has(i)), small = ids.filter((i) => !HERO.has(i));
  let pool = ids;
  if (size >= 2.0 && heroes.length) pool = heroes;                       // big rocks get the dense meshes
  else if (size < 0.9 && small.length && r() < 0.75) pool = small;        // pebbles stay cheap
  return pool[Math.floor(r() * pool.length)];
}
function makeItem(r, kind, size, x, z, red, cap = true, drift = 0) {
  const idx = pickIdx(r, kind, size);
  const [a, b] = SQUASH[kind];
  const tiltAmt = kind === 'strata' ? 0.03 : kind === 'slab' ? 0.14 : 0.10;
  return {
    idx, size, x, z, red, cap, drift,
    ax: 0.9 + r() * 0.3, az: 0.9 + r() * 0.3, sq: a + r() * (b - a),
    yaw: r() * Math.PI * 2, tx: (r() - 0.5) * tiltAmt * 2, tz: (r() - 0.5) * tiltAmt * 2, sink: 0.10 + r() * 0.14,
  };
}
/** hero rock + mid rocks on the lee side + pebble rubble */
function layout(r, spec) {
  const items = [];
  const w = spec.kinds ?? { boulder: 4, chunk: 4, slab: 1.2 };
  const redP = spec.red ?? 0.65;
  const hs = spec.hero ? lerp(spec.hero[0], spec.hero[1], r()) : 0;
  const base = hs || spec.size?.[1] || 2;
  const lee = r() * Math.PI * 2;
  if (hs) items.push(makeItem(r, spec.heroKind ?? pickKind(r, w), hs, spec.x, spec.z, r() < redP, true, spec.drift ?? 0.2));
  for (let i = 0; i < (spec.n ?? 0); i++) {
    const s = spec.size ? lerp(spec.size[0], spec.size[1], r() * r()) : base * (0.22 + 0.4 * r());
    const a = lee + (r() - 0.5) * 2.6, d = (hs ? hs * 0.9 : (spec.spread ?? 4) * 0.4) + r() * (spec.spread ?? hs * 1.6 + 2);
    items.push(makeItem(r, pickKind(r, w), s, spec.x + Math.cos(a) * d, spec.z + Math.sin(a) * d, r() < redP, s > 0.7, s > 1.8 ? 0.16 : 0));
  }
  for (let i = 0, nr = Math.ceil((spec.rubble ?? 0) * 0.55); i < nr; i++) {
    const s = 0.34 + r() * 0.62 * (hs ? Math.min(1.4, hs / 3) : 1);          // fewer, chunkier stones instead of confetti
    const a = r() * Math.PI * 2, d = (hs ? hs * 0.8 : 0) + r() * ((spec.spread ?? 4) * 1.6 + 2);
    items.push(makeItem(r, r() < 0.7 ? 'boulder' : 'chunk', s, spec.x + Math.cos(a) * d, spec.z + Math.sin(a) * d, r() < redP, s > 0.35, 0));
  }
  return items;
}

// ── world scatter plan ──────────────────────────────────────────────────────────────────────────
export function scatterWorld({ job, put, ground, keepClear }) {
  const r = rng(8812);
  const placed = [];
  let count = 0, rocks = 0;
  const stats = {};
  let phase = '';
  const why = (k) => { stats[phase + ':' + k] = (stats[phase + ':' + k] || 0) + 1; };
  const okAt = (x, z, minGap = 0, rad = 0, maxSlope = 0.85, street = false, lane = 0) => {
    if (Math.abs(x) > HALF_X - 10 || z > 262 || z < -196) return false;
    if (keepClear.some((k) => Math.abs(x - k.x) < k.hx + rad && Math.abs(z - k.z) < k.hz + rad)) return false;
    if (z > 30 && z < 143 && Math.abs(x) < (lane || (street ? 8.5 : 21)) + rad) return false;      // city street (flank rubble allowed only outside the walking lane)
    if (z < 50 && z > -198 && Math.abs(x - canyonX(z)) < (lane || 15) + rad) return false;        // canyon route
    if (z > 150 && z < 258 && Math.abs(x - 1.5) < (lane || 6.5) + rad * 0.5) return false;       // spawn → gateway line + footprints
    if (Math.abs(z - 172) < 11 + rad) return false;                                      // viaduct piers
    if (x > -73 - rad && x < -59 + rad && z > 174 && z < 218) return false;              // viaduct stair
    if (slopeAt(x, z) > maxSlope) return false;
    for (const p of placed) if (Math.hypot(x - p[0], z - p[1]) < minGap + p[2]) return false;
    return true;
  };
  const cluster = (spec, force = false) => {
    const rad = (spec.hero ? spec.hero[1] * 1.8 : (spec.spread ?? 4) + 3);
    if (!force && !okAt(spec.x, spec.z, spec.gap ?? 6, rad * 0.6, spec.maxSlope ?? 0.85, !!spec.street, spec.lane ?? 0)) { why('rej'); return false; }
    placed.push([spec.x, spec.z, rad * 0.6]);
    const items = layout(r, spec).filter((it) => force || okAt(it.x, it.z, 0, it.size * 0.4, spec.maxSlope ?? 0.85, !!spec.street, spec.lane ?? 0));
    if (!items.length) { why('empty'); return false; }
    why('ok');
    count++; rocks += items.length;
    job(() => put(buildCluster(spec, items, ground)));
    return true;
  };

  phase = 'spawn';
  // 1) composition rocks around spawn (framing the line of sight to the viaduct gateway)
  cluster({ x: -12.5, z: 236, hero: [4.2, 4.8], heroKind: 'chunk', n: 4, rubble: 9, red: 0.9, drift: 0.22, lod2: 260, cull: 700 }, true);
  cluster({ x: 14, z: 228, hero: [3.6, 4.2], heroKind: 'boulder', n: 4, rubble: 8, red: 0.8, drift: 0.2, lod2: 260, cull: 700 }, true);
  cluster({ x: -27, z: 212, hero: [4.6, 5.4], heroKind: 'slab', n: 3, rubble: 7, red: 0.75, drift: 0.2, lod2: 260, cull: 700 }, true);
  cluster({ x: 27, z: 205, hero: [3.2, 3.8], heroKind: 'chunk', n: 3, rubble: 6, red: 0.7, drift: 0.2, lod2: 260, cull: 700 }, true);
  cluster({ x: -8.5, z: 193, hero: [2.6, 3.2], heroKind: 'boulder', n: 3, rubble: 5, red: 0.85, lod2: 240, cull: 700 }, true);
  cluster({ x: 10, z: 189, hero: [2.4, 3.0], heroKind: 'chunk', n: 3, rubble: 5, red: 0.6, lod2: 240, cull: 700 }, true);
  cluster({ x: -46, z: 238, hero: [3.4, 4.4], n: 5, rubble: 8, red: 0.7, lod2: 260, cull: 700 }, true);
  cluster({ x: 50, z: 246, hero: [3.0, 4.0], n: 5, rubble: 8, red: 0.7, lod2: 260, cull: 700 }, true);

  phase = 'field';
  // 2) entrance snowfield: clustered, denser around ridges (noise-modulated acceptance)
  for (let i = 0, ok = 0; ok < 40 && i < 1200; i++) {
    const x = (r() - 0.5) * 290, z = 178 + r() * 84;
    if (SN.n2(x * 0.018 + 3, z * 0.018) < -0.12 && r() < 0.8) continue;
    const hero = r() < 0.5;
    if (cluster(hero ? { x, z, hero: [2.0, 4.6], n: 3 + Math.floor(r() * 3), rubble: 4 + Math.floor(r() * 5), gap: 7, red: 0.68, drift: 0.2 }
                     : { x, z, size: [0.8, 2.2], n: 5 + Math.floor(r() * 4), rubble: 5, spread: 5, gap: 7, red: 0.66 })) ok++;
  }
  // mid-ground cluster fields at the butte feet
  for (const [x, z] of [[-112, 214], [108, 216], [-132, 236], [136, 240], [-150, 178], [150, 168]])
    for (let k = 0; k < 2; k++) cluster({ x: x + (r() - 0.5) * 30, z: z + (r() - 0.5) * 22, hero: [3, 6.5], n: 5, rubble: 7, gap: 8, red: 0.7, drift: 0.2 });

  phase = 'city';
  // 3) abandoned city: low rubble, snow-buried debris along the street flanks
  for (let i = 0, ok = 0; ok < 44 && i < 900; i++) {
    const x = (r() - 0.5) * 230, z = 40 + r() * 106;
    if (cluster({ x, z, size: [0.6, 1.7], n: 4 + Math.floor(r() * 3), rubble: 6, spread: 3.5, gap: 7, red: 0.5, kinds: { boulder: 3, chunk: 5, slab: 1.5 } })) ok++;
  }

  phase = 'canyonfoot';
  phase = 'street';
  // 3b) street flanks: debris banked against the building lines, leaving the walking lane (|x| < 8.5) clear
  for (let z = 138; z > 36; z -= 7) {
    for (const side of [-1, 1]) {
      if (r() < 0.35) continue;
      cluster({ x: side * (10.5 + r() * 8), z: z + (r() - 0.5) * 5, size: [0.45, 1.3], n: 3 + Math.floor(r() * 2), rubble: 4, spread: 2.5, gap: 4, red: 0.5, street: true, drift: 0, kinds: { boulder: 3, chunk: 5, slab: 1.5 } });
    }
  }
  phase = 'canyonfoot';
  // 4) canyon: floor boulders, wall-foot talus fields, strata towers, hero rocks flanking the ring / gate
  for (let z = 22; z > -192; z -= 11) {
    for (const side of [-1, 1]) {
      const cx = canyonX(z), hw = canyonHalfWidthAt(z);
      const x = cx + side * (hw - 4 + (r() - 0.35) * 14);
      cluster({ x, z: z + (r() - 0.5) * 8, hero: [2.4, 6.0], n: 4, rubble: 6, spread: 6, gap: 8, red: 0.72, drift: 0.18, kinds: { boulder: 3, chunk: 5, slab: 1.2 } });
    }
  }
  phase = 'canyonfloor';
  for (let z = 14; z > -190; z -= 15) {
    const x = canyonX(z) + (r() < 0.5 ? -1 : 1) * (19 + r() * 17);
    cluster({ x, z, size: [0.9, 3.0], n: 4 + Math.floor(r() * 3), rubble: 5, spread: 6, gap: 8, red: 0.6 });
  }
  phase = 'towers';
  for (let z = 6; z > -186; z -= 34) {
    for (const side of [-1, 1]) {
      const cx = canyonX(z), hw = canyonHalfWidthAt(z);
      // the foot of the wall is steep scree: try a few offsets until the ground is calm enough
      for (let t = 0; t < 14; t++) {
        const zz = z + (r() - 0.5) * 20, hh = canyonHalfWidthAt(zz);
        if (cluster({ x: canyonX(zz) + side * (hh - 6 + t * 1.6 + r() * 3), z: zz, hero: [7, 12], heroKind: 'strata', n: 3, rubble: 3, spread: 12, gap: 14, red: 0.38, drift: 0.12, kinds: { boulder: 2, chunk: 6, slab: 3 }, lod1: 110, lod2: 280, cull: 800, maxSlope: 1.7 })) break;
      }
    }
  }
  phase = 'hero';
  for (const [dx, z, red] of [[-14, -108, true], [16, -126, false], [-18, -140, true], [14, -166, true], [-12, -172, false]])
    cluster({ x: canyonX(z) + dx, z, hero: [3, 4.6], n: 3, rubble: 5, red: red ? 0.9 : 0.4, drift: 0.2, lod2: 260 }, true);

  phase = 'dress';
  // 5) eye-level foreground dressing: chunky red-brown boulder groups 3-12 m off the walking line along every route section,
  // so the lower third of each first-person view carries rocks and snow banks instead of an empty snow expanse
  for (const [x, z, sz] of [[-6.5, 241, 1.3], [8.5, 237, 1.5], [-10, 226, 1.8], [11, 220, 1.3], [-7.5, 213, 1.5], [7.5, 205, 1.7], [-9.5, 196, 1.5], [10, 192, 1.3]])
    cluster({ x, z, hero: [sz, sz * 1.4], n: 2, rubble: 3, red: 0.82, drift: 0.3, lane: 3.4, gap: 3, lod2: 220, cull: 650 });
  for (let z = 134; z > 38; z -= 11)
    for (const side of [-1, 1]) {
      if (r() < 0.3) continue;
      cluster({ x: side * (5.8 + r() * 3.2), z: z + (r() - 0.5) * 5, hero: [0.9, 1.7], n: 2, rubble: 2, spread: 2.2, gap: 3, red: 0.6, street: true, lane: 5.2, drift: 0.2, kinds: { boulder: 3, chunk: 5, slab: 1.5 } });
    }
  for (let z = 16; z > -190; z -= 8) {
    if (Math.abs(z + 118) < 18 || Math.abs(z + 178) < 18) continue;       // ring / factory gate pads
    const side = r() < 0.5 ? -1 : 1;
    cluster({ x: canyonX(z) + side * (4.2 + r() * 6), z, hero: [1.3, 2.8], n: 3, rubble: 3, spread: 3, gap: 3, red: 0.75, lane: 3.0, drift: 0.22, kinds: { boulder: 3, chunk: 5, slab: 1.2 } });
  }

  phase = 'butte';
  // 6) butte feet: stepped rock rubble around the mid-ground mesas
  for (const [x, z] of [[-118, 243], [104, 240], [88, 214], [58, 244]])
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * 6.28 + r(), d = 18 + r() * 8;
      cluster({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d * 0.8, hero: [2.4, 5], n: 4, rubble: 5, gap: 8, red: 0.72, drift: 0.18 });
    }
  return { clusters: count, rocks, stats };
}
