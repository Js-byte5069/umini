// Ground dressing: wrecked-civilisation debris, wrecked machinery and snow-buried ruin pieces that fill the walking lanes and their flanks.
// assets/debris.glb (tools/gen_debris.py) holds the prop library (3 LODs, baked AO + edge wear, catalogue with footprints / colliders in asset.extras).
// dressingWorld() composes clusters (focal piece + satellites of decreasing size) along the route, seats every piece in a terrain-conforming snow bank
// and merges each cluster into one LOD object (3 draw calls per level: slate, orange, snow).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MAT, RAMP_TERRAIN } from './materials.js';
import { M, rbox, cyl } from './kit.js';
import { rng, lerp, sstep, clamp, makeNoise } from './noise.js';
import { heightAt, slopeAt, canyonX, snowColorAt, HALF_X } from './terrain.js';

export const LIB = { ok: false, parts: new Map(), meta: {} };       // parts: 'name#variant#lod' -> { matKey: geometry }
const SN = makeNoise(7717);
const DBG = new URLSearchParams(location.search).has('dressdbg');
const WIND_X = 0.906, WIND_Z = 0.423;
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Color();

export async function loadDressing() {
  const q = new URLSearchParams(location.search);
  if (q.has('nodress')) return;
  if (q.has('fallbackdress')) { fallbackLib(); return; }                // debug: force the procedural fallback props
  try {
    const gltf = await new GLTFLoader().loadAsync(new URL('../assets/debris.glb', import.meta.url).href);
    gltf.scene.traverse((o) => {
      const m = o.isMesh && /^([a-z]+?)(\d+)_l(\d)_(\w+)$/.exec(o.name);
      if (!m) return;
      const key = `${m[1]}#${m[2]}#${m[3]}`;
      let e = LIB.parts.get(key);
      if (!e) LIB.parts.set(key, (e = {}));
      e[m[4]] = o.geometry;
    });
    LIB.meta = gltf.asset?.extras?.props ?? {};
    LIB.ok = LIB.parts.size > 0 && Object.keys(LIB.meta).length > 0;
  } catch (e) { console.warn('debris assets unavailable, procedural fallback props', e); }
  if (!LIB.ok) fallbackLib();
}

// ── procedural fallback (no GLB): a few bevelled boxes / cylinders in the same material keys, same catalogue shape ────────────────────
function fallbackLib() {
  const part = (geo, m) => geo.applyMatrix4(m);
  const prop = (name, tags, bank, sink, variants) => {
    const ext = [], cols = [];
    variants.forEach((parts, v) => {
      let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9, mxy = -1e9;
      const by = {};
      for (const [mat, geo] of parts) {
        geo.computeBoundingBox();
        const b = geo.boundingBox;
        mnx = Math.min(mnx, b.min.x); mxx = Math.max(mxx, b.max.x); mnz = Math.min(mnz, b.min.z); mxz = Math.max(mxz, b.max.z); mxy = Math.max(mxy, b.max.y);
        by[mat] = by[mat] ? mergeInto(by[mat], geo) : geo;
      }
      for (let l = 0; l < 3; l++) LIB.parts.set(`${name}#${v}#${l}`, by);
      ext.push([mnx, mxx, mnz, mxz, mxy]);
      cols.push(mxy > 0.85 && !tags.includes('low') ? [[mnx, -1, mnz, mxx, mxy * 0.9, mxz]] : []);
    });
    LIB.meta[name] = { variants: variants.length, tags, bank, sink, ext, cols };
  };
  const box = (w, h, d, x, y, z, ry = 0, rx = 0, rz = 0, r = 0.08) => part(rbox(w, h, d, r, 2), M(x, y, z, rx, ry, rz));
  prop('wallseg', ['wall', 'big'], [1, 0.8, 0.5], 0.15, [
    [['wall', box(6.5, 2.8, 0.8, 0, 1.0, 0)], ['wallLight', box(6.8, 0.5, 1.0, 0, -0.1, 0)], ['accent', box(1.2, 1.6, 0.14, -0.8, 1.2, 0.45)]],
    [['wall', box(5.4, 2.2, 0.7, 0, 0.7, 0)], ['wallLight', box(5.6, 0.4, 0.9, 0, -0.1, 0)], ['wallLight', box(0.5, 2.6, 0.9, 2.6, 0.9, 0)]],
  ]);
  prop('slab', ['wall', 'big'], [1, 0.9, 0.6], 0.15, [
    [['wall', box(3.2, 3.0, 0.6, 0, 1.2, 0, 0, 0, -0.45)], ['accent', box(1.2, 1.4, 0.12, -0.3, 1.0, 0.34, 0, 0, -0.45)]],
    [['wall', box(4.0, 0.8, 2.4, 0, 0.1, 0)], ['wallLight', box(2.8, 2.4, 0.5, 0.6, 1.1, 0.2, -0.2, 0, -0.9)]],
  ]);
  prop('crate', ['box', 'small'], [1, 0.8, 0.4], 0.15, [
    [['wall', box(1.6, 1.2, 1.3, 0, 0.35, 0, 0.3)], ['accentDark', box(1.3, 0.9, 1.0, 1.4, 0.15, 0.6, -0.4)]],
    [['accentDark', box(1.5, 1.2, 1.2, 0, 0.4, 0, 0.2)], ['wall', box(1.2, 0.9, 1.0, 0.1, 1.45, 0, -0.2)]],
  ]);
  prop('column', ['round'], [1, 0.9, 0.45], 0.1, [
    [['wall', part(cyl(0.9, 0.9, 3.4, 14), M(0, 0.55, 0, 0, 0.2, Math.PI / 2))], ['wallLight', box(2.0, 0.8, 2.0, -2.6, 0.0, 0.3, 0.3)]],
  ]);
  prop('pipes', ['pipe', 'low'], [1, 0.7, 0.35], 0.1, [
    [['wallLight', part(cyl(0.34, 0.34, 6.0, 12), M(0, 0.2, 0, 0, 0.1, Math.PI / 2))], ['accent', part(cyl(0.4, 0.4, 0.5, 12), M(0.5, 0.2, 0.05, 0, 0.1, Math.PI / 2))]],
  ]);
  prop('pile', ['rubble', 'small'], [1, 0.9, 0.55], 0.1, [
    [['wall', box(1.2, 0.8, 1.0, 0, 0.3, 0, 0.4, 0.1, 0.2)], ['wallLight', box(0.9, 0.6, 0.8, 0.9, 0.1, 0.5, 1.0)], ['accent', box(0.7, 0.5, 0.6, -0.8, 0.1, 0.6, 0.2)], ['wallDark', box(0.8, 0.5, 0.7, -0.2, 0.7, -0.3, 0.9, 0.2, 0.1)]],
  ]);
  prop('chunk', ['small', 'rubble', 'low'], [0.8, 0.7, 0.3], 0.05, [
    [['wall', box(1.0, 0.7, 0.8, 0, 0.2, 0, 0.5, 0.1, 0.2)]], [['wallLight', box(0.9, 0.6, 0.9, 0, 0.15, 0, 1.0, 0.0, 0.1)], ['accent', box(0.5, 0.4, 0.5, 0.8, 0.0, 0.3, 0.4)]],
  ]);
  prop('lowwall', ['low', 'wall'], [1, 0.9, 0.3], 0.2, [
    [['wall', box(4.2, 0.9, 0.6, 0, 0.1, 0)], ['accent', box(1.0, 0.4, 0.08, 0.5, 0.3, 0.32)]],
  ]);
  LIB.ok = true;
}
function mergeInto(a, b) {
  const g = new THREE.BufferGeometry();
  const ga = a.index ? a.toNonIndexed() : a, gb = b.index ? b.toNonIndexed() : b;
  for (const k of ['position', 'normal']) {
    const A = ga.attributes[k].array, B = gb.attributes[k].array, C = new Float32Array(A.length + B.length);
    C.set(A); C.set(B, A.length);
    g.setAttribute(k, new THREE.BufferAttribute(C, 3));
  }
  return g;
}

export const partsOf = (name, v, lod) => LIB.parts.get(`${name}#${v}#${Math.min(lod, 2)}`) ?? null;

// ── material folding: 4 slate shades + 2 oranges collapse into two painted-snow materials (vertex tints), so a cluster costs 3 draws ──────
const MATMAP = {
  wall: ['wall', 1, 1, 1], wallLight: ['wall', 1.22, 1.2, 1.12], trim: ['wall', 1.22, 1.2, 1.12], wallDark: ['wall', 0.70, 0.70, 0.78],
  metal: ['wall', 0.58, 0.58, 0.70], deck: ['wall', 0.84, 0.84, 0.92], glass: ['wall', 0.26, 0.30, 0.52],
  accent: ['accent', 1, 1, 1], accentDark: ['accent', 0.82, 0.80, 0.86],
};

// ── merged geometry (typed arrays, one pass) ───────────────────────────────────────────────────────────
// shading: baked AO (COLOR_0.r) and convex-edge wear (COLOR_0.g) become the vertex colour, a gentle height gradient seats pieces in the ground;
// material tints fade out on up-facing faces (the painted snow there multiplies the vertex colour and must stay white)
export class Merge {
  constructor() { this.items = []; }
  add(geo, mat, o = {}) { this.items.push([geo, mat, o]); }
  build() {
    let nv = 0, ni = 0;
    for (const [g] of this.items) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
    if (!nv) return null;
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), C = new Float32Array(nv * 3), K = new Float32Array(nv).fill(1);
    const I = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0, io = 0;
    for (const [src, mat, o] of this.items) {
      const pos = src.attributes.position, nor = src.attributes.normal, baked = src.attributes.color, idx = src.index;
      const tcol = src.attributes.tcol, tmask = src.attributes.tmask;
      const n = pos.count, tint = o.tint, yRef = o.yRef ?? 0, snow = o.snow;
      const nm = new THREE.Matrix3().getNormalMatrix(mat);
      for (let i = 0; i < n; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(mat);
        _n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        const j = (vo + i) * 3;
        P[j] = _v.x; P[j + 1] = _v.y; P[j + 2] = _v.z; N[j] = _n.x; N[j + 1] = _n.y; N[j + 2] = _n.z;
        if (snow) {
          if (tcol) { C[j] = tcol.getX(i); C[j + 1] = tcol.getY(i); C[j + 2] = tcol.getZ(i); }
          else {
            const ao = baked ? 0.86 + 0.14 * baked.getX(i) : 1;
            snowColorAt(_v.x + (o.wx ?? 0), _v.z + (o.wz ?? 0), 1, _c);
            C[j] = _c.r * 0.948 * ao; C[j + 1] = _c.g * 0.968 * ao; C[j + 2] = _c.b * 0.992 * ao;
          }
          K[vo + i] = tmask ? tmask.getX(i) : 1;
        } else {
          let k = lerp(0.80, 1.0, sstep(-0.4, 2.6, _v.y - yRef));
          if (_n.y < -0.35) k *= 0.84;
          if (baked) {
            const ao = baked.getX(i), wear = baked.itemSize > 1 ? baked.getY(i) : 0.5;
            k *= 0.50 + 0.50 * ao;
            k *= 1 + 0.42 * Math.max(0, wear - 0.52) * (0.4 + 0.6 * ao);      // convex edges catch the light
          }
          k = Math.min(k, 1.03);
          const up = sstep(0.45, 0.85, _n.y);
          const tr = tint ? lerp(tint[0], 1, up) : 1, tg = tint ? lerp(tint[1], 1, up) : 1, tb = tint ? lerp(tint[2], 1, up) : 1;
          C[j] = Math.pow(k, 1.15) * tr; C[j + 1] = k * tg; C[j + 2] = Math.pow(k, 0.86) * tb;
        }
      }
      if (idx) for (let i = 0; i < idx.count; i++) I[io + i] = idx.getX(i) + vo;
      else for (let i = 0; i < n; i++) I[io + i] = i + vo;
      vo += n; io += idx ? idx.count : n;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.setAttribute('aMask', new THREE.BufferAttribute(K, 1));
    g.setIndex(new THREE.BufferAttribute(I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// snow caps / banks: the same terrain-matched cel material the boulder scatter uses (pale ramp, per-pixel contour from the vertex mask)
export const dressSnowMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP_TERRAIN, vertexColors: true, alphaToCoverage: true });
dressSnowMat.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aMask;\nvarying float vMask;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n vMask = aMask;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vMask;')
    .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.a = smoothstep(0.44, 0.56, vMask);\n if (diffuseColor.a < 0.01) discard;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.03, 0.05, 0.118);');
};
dressSnowMat.polygonOffset = true; dressSnowMat.polygonOffsetFactor = -2; dressSnowMat.polygonOffsetUnits = -2;
dressSnowMat.customProgramCacheKey = () => 'dress-snow1';

/** one prop as a THREE.Group (viewer / debugging): name, variant, lod */
export function propObject(name, v, lod, matrix = new THREE.Matrix4()) {
  const parts = partsOf(name, v, lod);
  const grp = new THREE.Group();
  if (!parts) return grp;
  const by = {};
  for (const [mk, geo] of Object.entries(parts)) {
    const [mm, ...tint] = mk === 'snow' ? ['snow'] : (MATMAP[mk] ?? MATMAP.wall);
    (by[mm] ??= new Merge()).add(geo, matrix, { tint: mk === 'snow' ? null : tint, snow: mk === 'snow' });
  }
  for (const [mk, mer] of Object.entries(by)) {
    const g = mer.build();
    const mesh = new THREE.Mesh(g, mk === 'snow' ? dressSnowMat : MAT[mk]);
    mesh.castShadow = mk !== 'snow'; mesh.receiveShadow = true;
    grp.add(mesh);
  }
  return grp;
}

// ── snow bank hugging a piece's foot, conforming to the terrain (cluster-local coordinates) ───────────────────────
// elliptical, rotated with the piece, with a longer tail downwind; the rim fades out through a per-vertex mask that the shader
// thresholds per pixel (smooth contour), normals / colours blend into the terrain's own so the bank melts into the field.
function bankGeo(b, ox, oy, oz, rings, segs) {
  const cy = Math.cos(b.yaw), sy = Math.sin(b.yaw);
  const P = [], I = [], W = [], MK = [];
  const R = 1.55;
  const addV = (x, z, dy, m) => { const y = heightAt(x, z) + dy; P.push(x - ox, y - oy, z - oz); W.push(x, z, y); MK.push(m); };
  addV(b.cx, b.cz, b.h * 0.95, 1);
  for (let ri = 1; ri <= rings; ri++) {
    const t = ri / rings;
    for (let si = 0; si < segs; si++) {
      const a = (si / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const dx = ca * cy + sa * sy, dz = -ca * sy + sa * cy;                      // world direction of this spoke
      const wob = 1 + 0.15 * SN.n2(ca * 1.7 + b.seed, sa * 1.7 + b.seed * 0.3);
      const lump = 1 + b.tail * Math.max(0, dx * WIND_X + dz * WIND_Z);           // longer, lower tail on the lee side
      const f = (0.55 + (R - 0.55) * t) * wob * lump;
      const u = ca * b.rx * f, v = sa * b.rz * f;
      const x = b.cx + u * cy + v * sy, z = b.cz - u * sy + v * cy;
      const prof = Math.pow(1 - sstep(0.12, 0.8, t), 1.4);
      addV(x, z, b.h * prof * (0.86 + 0.28 * SN.n2(x * 0.5 + b.seed, z * 0.5)) * (1 - 0.3 * (lump - 1)) - 0.02 * t, 1 - sstep(0.62, 0.95, t));
    }
  }
  for (let si = 0; si < segs; si++) I.push(0, 1 + ((si + 1) % segs), 1 + si);
  for (let ri = 1; ri < rings; ri++)
    for (let si = 0; si < segs; si++) {
      const a = 1 + (ri - 1) * segs + si, c = 1 + (ri - 1) * segs + ((si + 1) % segs), d = a + segs, e = c + segs;
      I.push(a, c, d, c, e, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  const nA = g.attributes.normal, n = P.length / 3, col = new Float32Array(n * 3);
  const e = 0.9;
  for (let i = 0; i < n; i++) {
    const x = W[i * 3], z = W[i * 3 + 1];
    const h0 = heightAt(x, z);
    const gx = (heightAt(x + e, z) - h0) / e, gz = (heightAt(x, z + e) - h0) / e;
    const l = Math.hypot(gx, 1, gz);
    const w = sstep(0.5, 1.0, MK[i]);                      // 1 at the piece, 0 exactly at the visible rim: no shading seam
    const nx = lerp(-gx / l, nA.getX(i), w), ny = lerp(1 / l, nA.getY(i), w), nz = lerp(-gz / l, nA.getZ(i), w);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nA.setXYZ(i, nx / nl, ny / nl, nz / nl);
    snowColorAt(x, z, 1 / l, _c);
    col[i * 3] = _c.r * 0.948; col[i * 3 + 1] = _c.g * 0.968; col[i * 3 + 2] = _c.b * 0.992;      // = the terrain shader's snow tint
  }
  g.setAttribute('tcol', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tmask', new THREE.Float32BufferAttribute(MK, 1));
  return g;
}

// ── cluster -> LOD object ────────────────────────────────────────────────────────────────────────────────
const LOD_DIST = [0, 32, 90, 190];
const CULL = 280;
const MERGE_R = 22, MERGE_MAX = 30;                        // neighbouring groups are merged into one LOD object up to this radius / item count
const ORANGE_ON_WALL = [1.67, 0.72, 0.35];             // accent colour / wall colour

function buildCluster(spec, ground) {
  const items = spec.items;
  const ox = spec.x, oz = spec.z, oy = heightAt(ox, oz);
  const lod = new THREE.LOD();
  const colliders = [];
  let tall = false, top = 0;
  for (const it of items) {
    if (it.drift) {                                          // wind-sculpted drift: just a terrain-conforming snow form
      it.bankSpec = { ...it.drift, seed: Math.floor(Math.abs(it.x * 13 + it.z * 7)) % 90 + 1 };
      continue;
    }
    const fg = footGround(it, ground);                      // the final terrain (the buildings' snow drifts exist now)
    it.y = fg.y - it.sink;
    it.mat = M(it.x - ox, it.y - oy, it.z - oz, fg.rx, it.yaw, fg.rz, it.s, it.sy, it.s);
    it.jit = 0.92 + 0.16 * (0.5 + 0.5 * SN.n2(it.x * 0.31 + 5, it.z * 0.29));          // per-piece value drift: no two pieces share a shade
    if (it.top > 2.4) tall = true;
    top = Math.max(top, it.top);
    const bs = it.meta.bank ?? [1, 0.8, 0.4];
    const h = (bs[2] ?? 0.4) * (0.75 + 0.5 * SN.n2(it.x * 0.7, it.z * 0.7) + 0.25) * Math.min(1.5, 0.6 + it.rad * 0.18);
    it.bankSpec = { cx: it.cx, cz: it.cz, rx: it.hx * 1.12 + 0.55, rz: it.hz * 1.12 + 0.55, yaw: it.yaw, h, seed: Math.floor(Math.abs(it.x * 13 + it.z * 7)) % 90 + 1, tail: it.rad > 2 ? 0.55 : 0.3 };
    colliders.push(...worldColliders(it, it.meta));
  }
  const banks = items.filter((it) => it.drift || (!it.meta.tags?.includes('flat') && !it.meta.tags?.includes('slim')));
  let bankGeo0 = null;
  for (let l = 0; l < 4; l++) {
    const mers = { wall: new Merge(), accent: new Merge(), snow: new Merge() };
    for (const it of items) {
      if (it.drift) continue;
      if (l >= 2 && it.top < (l === 2 ? 1.1 : 2.2)) continue;               // small pieces vanish with distance
      const gl = Math.min(2, l);
      const parts = partsOf(it.name, it.v, gl);
      if (!parts) continue;
      for (const [mk, geo] of Object.entries(parts)) {
        if (mk === 'snow') { if (l < 2) mers.snow.add(geo, it.mat, { snow: true, wx: ox, wz: oz }); continue; }
        let [mm, ...tint] = MATMAP[mk] ?? MATMAP.wall;
        if (l >= 1 && mm === 'accent') { mm = 'wall'; tint = tint.map((t, i) => t * ORANGE_ON_WALL[i]); }      // beyond 50 m the oranges ride on the slate material: one draw less
        mers[mm].add(geo, it.mat, { tint: tint.map((t) => t * it.jit), yRef: it.y - oy });
      }
    }
    if (l < 3) {
      if (!bankGeo0) bankGeo0 = banks.map((it) => ({ it, g: bankGeo(it.bankSpec, ox, oy, oz, it.drift ? 6 : 5, it.drift ? 24 : 18) }));
      for (const { it, g } of bankGeo0) if (l < 2 || it.top > 1.6) mers.snow.add(g, new THREE.Matrix4(), { snow: true });
    }
    const grp = new THREE.Group();
    for (const key of ['wall', 'accent', 'snow']) {
      const g = mers[key].build();
      if (!g) continue;
      const mesh = new THREE.Mesh(g, key === 'snow' ? dressSnowMat : MAT[key]);
      mesh.castShadow = key !== 'snow' && (l === 0 ? top > 1.3 : l === 1 && tall);
      mesh.receiveShadow = true;
      grp.add(mesh);
    }
    lod.addLevel(grp, LOD_DIST[l]);
  }
  lod.addLevel(new THREE.Group(), CULL);
  lod.userData.dress = true;
  lod.position.set(ox, oy, oz);
  lod.updateMatrixWorld(true);
  return { object: lod, colliders };
}

// ── colliders from the catalogue (local boxes, y from -1), rotated with the piece ──────────────────────────────────
function worldColliders(it, meta) {
  const cols = meta.cols?.[it.v] ?? [];
  const out = [];
  const c = Math.cos(it.yaw), s = Math.sin(it.yaw);
  const ang = ((it.yaw % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  const axis = Math.min(ang, Math.PI / 2 - ang) < 0.06;
  for (const b of cols) {
    const x0 = b[0] * it.s, x1 = b[3] * it.s, z0 = b[2] * it.s, z1 = b[5] * it.s;
    const nx = axis ? 1 : Math.max(1, Math.ceil((x1 - x0) / 1.2)), nz = axis ? 1 : Math.max(1, Math.ceil((z1 - z0) / 1.2));
    for (let i = 0; i < nx; i++)
      for (let k = 0; k < nz; k++) {
        const ax = lerp(x0, x1, i / nx), bx = lerp(x0, x1, (i + 1) / nx), az = lerp(z0, z1, k / nz), bz = lerp(z0, z1, (k + 1) / nz);
        let mnX = 1e9, mxX = -1e9, mnZ = 1e9, mxZ = -1e9;
        for (const px of [ax, bx]) for (const pz of [az, bz]) {
          const wx = it.x + px * c + pz * s, wz = it.z - px * s + pz * c;
          mnX = Math.min(mnX, wx); mxX = Math.max(mxX, wx); mnZ = Math.min(mnZ, wz); mxZ = Math.max(mxZ, wz);
        }
        out.push({ minX: mnX, maxX: mxX, minZ: mnZ, maxZ: mxZ, minY: it.y + b[1], maxY: it.y + b[4] * it.sy, dress: true });
      }
  }
  return out;
}

// ── route geometry ───────────────────────────────────────────────────────────────────────────────────────────
// two centre lines matter: the footprint line painted in the snow (terrain shader routeX) and the straight line the walk test follows
const routeX = (z) => canyonX(z) * sstep(30, -10, z) + 1.5 * Math.sin(z * 0.083 + 0.4) * sstep(40, 150, z) + 0.7 * Math.sin(z * 0.21 + 0.68) * sstep(60, 160, z);
const WALKS = [
  [[0, 262], [0, 215], [0, 150], [0, 40], [-6, -80], [-9, -125], [-6, -165], [-6, -195]],     // main route
  [[-66, 262], [-66, 205]],                                                                    // approach to the viaduct stair
  [[-14, 152], [-14, 126]],                                                                    // approach to the overhead-bridge stair
  [[-60, 49], [-116, 49]],                                                                     // hall branch
];
function distWalk(x, z) {
  let d = 1e9;
  for (const W of WALKS) for (let i = 0; i < W.length - 1; i++) {
    const [ax, az] = W[i], [bx, bz] = W[i + 1];
    const dx = bx - ax, dz = bz - az, t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    d = Math.min(d, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return d;
}
const laneDist = (x, z) => Math.min(Math.abs(x - routeX(z)), distWalk(x, z));

/** lowest / highest ground under a piece's footprint (13 samples) */
const FOOT = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.8, 0.8], [-0.8, 0.8], [0.8, -0.8], [-0.8, -0.8], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]];
function footGround(it, ground) {
  const c = Math.cos(it.yaw), sn = Math.sin(it.yaw);
  const at = (lx, lz) => ground(it.x + lx * c + lz * sn, it.z - lx * sn + lz * c);
  // terrain plane under the piece (in its own frame): flat-lying pieces follow it, standing ones only partly
  const ex = Math.max(0.8, it.hx * 0.8), ez = Math.max(0.8, it.hz * 0.8);
  const g0 = at(0, 0);
  const gx = (at(ex, 0) - at(-ex, 0)) / (2 * ex), gz = (at(0, ez) - at(0, -ez)) / (2 * ez);
  const k = it.tiltK ?? 0.5, lim = it.low ? 0.5 : 0.3;
  const rz = clamp(Math.atan(gx) * k, -lim, lim), rx = clamp(-Math.atan(gz) * k, -lim, lim);
  let rmin = 1e9, rmax = -1e9;
  for (const [fx, fz] of FOOT) {
    const lx = it.ccx + fx * it.hx, lz = it.ccz + fz * it.hz;
    const res = at(lx, lz) - (g0 + Math.tan(rz) * lx - Math.tan(rx) * lz);      // ground above / below the tilted plane
    rmin = Math.min(rmin, res); rmax = Math.max(rmax, res);
  }
  return { y: g0 + rmin, rise: rmax - rmin, rx, rz };
}

// the eye-level views that matter (spawn, flanks, street, canyon, gate): the cameras stay free of tall pieces and each view gets foreground dressing
const ANCHORS = [[0, 240, 0], [-30, 215, 20], [6, 150, 0], [6, 100, 8], [0, 60, 0], [0, 36, 0], [-4, -30, 0], [-4, -60, -10], [-4, -100, 0], [-4, -150, 0], [0, 205, 0], [0, 125, 0], [-4, -10, 0], [-6, -80, 0], [-9, -125, 0]];
function nearAnchor(x, z, rad, tall) {
  for (const [ax, az, yaw] of ANCHORS) {
    const d = Math.hypot(x - ax, z - az);
    if (d < rad + (tall ? 5.2 : 1.6)) return true;
    if (tall) {                         // view cone ahead of the camera
      const a = yaw * Math.PI / 180, fx = -Math.sin(a), fz = -Math.cos(a);
      const f = (x - ax) * fx + (z - az) * fz, l = Math.abs((x - ax) * fz - (z - az) * fx);
      if (f > 0 && f < 14 && l < rad * 0.6 + 1.6 + f * 0.1) return true;
    }
  }
  return false;
}

// ── weighted pools: [name, variant (null = any), weight] ──────────────────────────────────────────────────────────
const BIG = [['wallseg', null, 3.2], ['slab', null, 2], ['arch', null, 1.3], ['column', 2, 1], ['hoop', null, 1.2], ['tank', null, 1.3], ['hulk', null, 1.5], ['gear', null, 1.3], ['crane', null, 1], ['stairs', null, 0.7], ['truss', null, 1.1]];
const MID = [['crate', null, 2.2], ['pipes', null, 2], ['spool', null, 1], ['pile', null, 2.2], ['panels', null, 1.4], ['column', null, 1.4], ['barrier', null, 1.2], ['lamp', null, 0.9], ['pylon', null, 0.6], ['slab', 2, 0.8], ['slab', 3, 0.8]];
const SMALL = [['chunk', null, 3.2], ['gravel', null, 2.4], ['pile', null, 1.2], ['panels', null, 0.8], ['crate', 3, 1], ['barrier', 1, 1], ['pipes', 1, 0.5], ['plate', null, 1], ['scrap', null, 1.2]];
const LOW = [['chunk', null, 2.4], ['lowwall', null, 2.4], ['beams', null, 1.4], ['plate', null, 1.4], ['barrier', 1, 0.8], ['gravel', null, 3], ['scrap', null, 2.4]];
const FLAT = [['gravel', null, 4], ['scrap', null, 2.4], ['plate', null, 1.4], ['chunk', 4, 0.8]];      // ultra-low (< 0.6 m): may lie right in the walking lane, never collide
// the world is built at epic scale (viaduct deck 16 m up, towers 40 m): debris is modelled in plain metres and scaled up so it reads from the lane
const SCALE = { BIG: [1.7, 2.4], MID: [1.5, 2.1], SMALL: [1.3, 1.8], LOW: [1.4, 2.0], FLAT: [0.95, 1.35] };

function pick(r, pool) {
  if (!pool.length) return ['chunk', 0];            // fallback library: pools thinned out (chunk exists in every library)
  let t = r() * pool.reduce((a, p) => a + p[2], 0);
  for (const p of pool) if ((t -= p[2]) < 0) return [p[0], p[1] ?? Math.floor(r() * (LIB.meta[p[0]]?.variants ?? 1))];
  const p = pool[0]; return [p[0], p[1] ?? 0];
}

/** @param {{job: Function, put: Function, ground: Function, keepClear: Array, colliders: Array}} ctx */
export function dressingWorld(ctx) {
  if (!LIB.ok) return { items: 0, clusters: 0 };
  for (const P of [BIG, MID, SMALL, LOW, FLAT]) for (let i = P.length - 1; i >= 0; i--) if (!LIB.meta[P[i][0]] || (P[i][1] != null && P[i][1] >= LIB.meta[P[i][0]].variants)) P.splice(i, 1);          // the fallback library has fewer pieces
  const { job, put, ground, keepClear } = ctx;
  const r = rng(90210);
  const placed = [];            // {x, z, r} discs of everything that stands (tall pieces) or lies (low pieces)
  const stats = { clusters: 0, items: 0, tris: 0, rej: {} };
  let curZ = 0, curF = false;
  const why = (k) => { if (DBG && curF) { const kk = 'F-' + k; stats.rej[kk] = (stats.rej[kk] || 0) + 1; } stats.rej[k] = (stats.rej[k] || 0) + 1; if (DBG) { const b = k + Math.floor(curZ / 40) * 40; stats.rej[b] = (stats.rej[b] || 0) + 1; } };

  // structures that world.js builds without registering a keep-clear rect (kept in step with world.js)
  const avoid = [];
  const box = (x, z, hx, hz, chx = hx, chz = hz) => avoid.push({ x, z, hx, hz, chx, chz });       // c* = the solid core that even ultra-low pieces must not touch
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sx * 16, 80 + sz * 3.5, 3.4, 3.4);          // pipe gantry towers
  box(0, 80, 20, 1.4);
  for (const [x, z] of [[10, 117], [-12, 100], [14, 94], [-9, 58], [11, 46], [-64, 53], [-114, 40], [-116, 57]]) box(x, z, 4.6, 4.6);        // containers
  for (const [x, z] of [[10, -10], [-14, -80], [12, -128], [-16, -160]]) box(canyonX(z) + x, z, 4.6, 4.6);
  for (const [x, z] of [[-14, 142], [16, 146], [-4, 36]]) box(x, z, 10, 3.2);                          // ruin walls
  box(canyonX(-30) - 22, -30, 10, 3.2); box(canyonX(-48) + 20, -48, 10, 3.2);
  for (const [dx, z] of [[28, -92], [-32, -142], [-30, -66], [34, -150]]) box(canyonX(z) + dx, z, 8, 8);     // leaning slabs
  box(canyonX(-118), -118, 17, 13, 17.5, 6.5);                                                         // ring gate + pedestals (the pad in front of / behind it may carry flat pieces)
  box(canyonX(-178), -178, 26, 15);                                                                    // factory gate
  box(-66, 196, 11, 27);                                                                               // viaduct stair
  box(-14, 116, 7, 13);                                                                                // bridge stair
  box(0, 172, 400, 10);                                                                                // viaduct piers
  for (const [x, z, rr] of [[-12.5, 236, 5], [14, 228, 4.5], [-27, 212, 6], [27, 205, 4.5], [-8.5, 193, 3.5], [10, 189, 3.5], [-46, 238, 5], [50, 246, 4.5]]) box(x, z, rr, rr);       // the scatter's forced foreground rocks
  for (const [dx, z] of [[-14, -108], [16, -126], [-18, -140], [14, -166], [-12, -172]]) box(canyonX(z) + dx, z, 5, 5);                  // ... and its canyon hero rocks

  const ext = keepClear.slice();            // the rects other systems registered before us (our own pushes are for the scatter that plans after us)
  const hit = (x, z, rad, flat = false) => ext.some((k) => Math.abs(x - k.x) < k.hx - 3 + rad && Math.abs(z - k.z) < k.hz - 3 + rad)
    || avoid.some((k) => (flat ? Math.abs(x - k.x) < k.chx + rad && Math.abs(z - k.z) < k.chz + rad : Math.abs(x - k.x) < k.hx + rad && Math.abs(z - k.z) < k.hz + rad));

  /** try to seat a piece; returns the resolved item or null. opts.lane: min distance of the footprint edge from the lane centre lines */
  function seat(name, v, x, z, yaw, s, o = {}) {
    const meta = LIB.meta[name];
    curZ = z; curF = !!o.focal;
    const e = meta.ext[v];
    const hx = (e[1] - e[0]) / 2 * s, hz = (e[3] - e[2]) / 2 * s, ccx = (e[1] + e[0]) / 2 * s, ccz = (e[3] + e[2]) / 2 * s;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const cx = x + ccx * c + ccz * sn, cz = z - ccx * sn + ccz * c;
    const rad = Math.hypot(hx, hz);
    const top = e[4] * s;
    const low = top <= 0.85 || !!meta.tags?.includes('low');
    if (o.inlane && top > 0.6) { why('tall'); return null; }
    if (Math.abs(cx) > HALF_X - 14 || cz > 262 || cz < -192) { why('bounds'); return null; }
    if (hit(cx, cz, rad * 0.7, top <= 0.6)) { why('keepclear'); return null; }
    if (!o.anchor && nearAnchor(cx, cz, rad * 0.7, !low && top > 1.0)) { why('camera'); return null; }
    // lane clearance from the real footprint (oriented rectangle sampled every ~0.9 m): step-over pieces (< 0.6 m, no collider) may lie close to the
    // footprint line, walk-around pieces (< 1.4 m) keep 3.0 m from it, anything taller keeps 3.2 m (the lane stays 6 m wide)
    const need = o.lane ?? (top <= 0.6 ? 0.9 : top <= 1.4 ? 3.0 : 3.2);
    let ld = 1e9;
    {
      const nu = Math.max(1, Math.ceil(hx / 0.45)), nv = Math.max(1, Math.ceil(hz / 0.45));
      for (let i = 0; i <= nu && ld >= need; i++) for (let k = 0; k <= nv; k++) {
        const lx = ccx + (i / nu * 2 - 1) * hx, lz = ccz + (k / nv * 2 - 1) * hz;
        ld = Math.min(ld, laneDist(x + lx * c + lz * sn, z - lx * sn + lz * c));
      }
    }
    if (ld < need) { why('lane'); return null; }
    if (!o.free) for (const p of placed) if (Math.hypot(cx - p.x, cz - p.z) < (rad + p.r) * (low ? 0.5 : 0.62)) { why('overlap'); return null; }
    const sink = (meta.sink ?? 0.1) + (o.sink ?? 0);
    const sy = s * (o.sy ?? 1);
    const it = { name, v, x, z, y: 0, yaw, s, sy, sink, top: e[4] * sy - sink, low, rad, cx, cz, hx, hz, ccx, ccz, meta, tiltK: e[4] > 2.2 ? 0.55 : 0.9 };
    const fg = footGround(it, ground);
    const maxRise = ((low ? 0.45 : 0.34) * Math.max(1.2, rad * 0.5) + 0.1) * (o.relax ?? 1);
    if (fg.rise > maxRise) { why('slope'); return null; }
    it.y = fg.y - sink; it.rx = fg.rx; it.rz = fg.rz;
    return it;
  }

  const commit = (it) => { placed.push({ x: it.cx, z: it.cz, r: it.rad }); };

  /** register a cluster of already seated items: keep-clear now (the boulder scatter plans after us), geometry when the job runs */
  // the stair approaches must stay open for the boulder scatter that plans after us (it only knows the main route lanes)
  keepClear.push({ x: -14, z: 130, hx: 5, hz: 24 }, { x: -66, z: 214, hx: 5.5, hz: 54 });
  const specs = [];
  function emit(list) {
    if (!list.length) return;
    stats.items += list.length;
    if (DBG) (stats.log ??= []).push(list.map((it) => `${it.name}${it.v}@${Math.round(it.x)},${Math.round(it.z)}`).join(' '));
    for (const it of list) { const t = it.drift ? null : partsOf(it.name, it.v, 0); if (t) for (const g of Object.values(t)) stats.tris += (g.index?.count ?? 0) / 3; }
    for (const it of list) {              // tight axis-aligned bounds of the oriented footprint (the boulder scatter inflates them by its own cluster radius)
      if (it.drift || it.top < 0.9) continue;
      const c = Math.abs(Math.cos(it.yaw)), sn = Math.abs(Math.sin(it.yaw));
      keepClear.push({ x: it.cx, z: it.cz, hx: (c * it.hx + sn * it.hz) * 0.9, hz: (sn * it.hx + c * it.hz) * 0.9 });
    }
    // neighbouring groups share one LOD object (fewer draw calls): join an existing cluster when its centre is close and it is not full yet
    const f = list[0];
    let host = null, best = 1e9;
    for (const sp of specs) {
      const d = Math.hypot(sp.x - f.cx, sp.z - f.cz);
      if (d < MERGE_R && sp.items.length + list.length <= MERGE_MAX && d < best) { best = d; host = sp; }
    }
    if (host) host.items.push(...list);
    else specs.push({ x: f.x, z: f.z, items: list.slice() });
  }
  const flush = () => {
    stats.clusters = specs.length;
    let left = specs.length, ms = 0;
    for (const spec of specs) job(() => {
      const t = performance.now();
      put(buildCluster(spec, ground));
      ms += performance.now() - t;
      if (--left === 0) console.info('dressing: built ' + stats.clusters + ' LOD objects in ' + Math.round(ms) + ' ms');
    });
  };

  // ── cluster recipes ──────────────────────────────────────────────────────────────────────────────────────────
  const yawAlong = (zRoute) => (r() < 0.55 ? Math.PI / 2 + (r() - 0.5) * 0.5 + (r() < 0.5 ? 0 : Math.PI) : r() * Math.PI * 2);

  /** focal + satellites that trail away from the focal piece (decreasing size) */
  function composeCluster(posFn, opts) {
    let focal = null;
    for (let t = 0; t < 12 && !focal; t++) {
      const [fn, fv] = pick(r, opts.pool);
      const sr = opts.pool === BIG ? SCALE.BIG : opts.pool === LOW ? SCALE.LOW : opts.pool === FLAT ? SCALE.FLAT : opts.pool === SMALL ? SCALE.SMALL : SCALE.MID;
      const fs = (opts.scale ?? 1) * lerp(sr[0], sr[1], r());
      const e = LIB.meta[fn].ext[fv];
      const rad = Math.hypot((e[1] - e[0]) / 2, (e[3] - e[2]) / 2) * fs;
      const [x, z] = posFn(rad, t);
      focal = seat(fn, fv, x, z, opts.yaw ?? yawAlong(z), fs, { sink: r() * 0.25, lane: opts.lane, relax: opts.relax, anchor: opts.anchor, focal: true });
    }
    if (!focal) return false;
    commit(focal);
    const list = [focal];
    const nsat = opts.sat ?? 3;
    const trail = r() * Math.PI * 2;
    for (let i = 0; i < nsat; i++) {
      const [sn, sv] = pick(r, i < 1 && opts.mid ? MID : SMALL);
      for (let t = 0; t < 6; t++) {
        const a = trail + (r() - 0.5) * 2.6, d = focal.rad * (0.85 + 0.5 * r()) + 0.9 + i * (0.9 + r() * 0.8);
        const it = seat(sn, sv, focal.cx + Math.cos(a) * d, focal.cz + Math.sin(a) * d, r() * Math.PI * 2, lerp(SCALE.SMALL[0], SCALE.SMALL[1], r()) * (i < 1 ? 1.1 : 0.95), { sink: r() * 0.25, lane: opts.lane, free: false, relax: opts.relax, anchor: opts.anchor });
        if (it) { commit(it); list.push(it); break; }
      }
    }
    emit(list);
    return true;
  }

  const lateral = (z, side, d) => routeX(z) * 0.5 + side * d;       // lateral position from the lane centre (blend of the two route lines)

  // ── placement plans, section by section ──────────────────────────────────────────────────────────────────────
  const section = (z0, z1, stepA, stepB, fn) => { for (let z = z0; z > z1; z -= stepA + r() * (stepB - stepA)) fn(z); };

  const galleryItems = () => {
  const gal = new URLSearchParams(location.search).get('gallery');
  if (gal) {          // debug: one of every piece in a row at x,z (in-game look at real scale / lighting)
    const [gx, gz, gs = 1.5, per = 7, from = 0] = gal.split(',').map(Number);
    let x = gx, n = 0, row = 0;
    for (const name of Object.keys(LIB.meta)) for (let v = 0; v < LIB.meta[name].variants; v++) {
      if (n++ < from) continue;
      if (n - from > per * 3) break;
      const e = LIB.meta[name].ext[v];
      const hx = (e[1] - e[0]) / 2 * gs, hz = (e[3] - e[2]) / 2 * gs;
      if (x > gx + per * 11) { x = gx; row++; }
      const z = gz - row * 14;
      const it = { name, v, x: x - e[0] * gs, z, y: 0, yaw: 0, s: gs, sy: gs, sink: 0.1, top: e[4] * gs, low: false, rad: Math.hypot(hx, hz), hx, hz, ccx: (e[1] + e[0]) / 2 * gs, ccz: (e[3] + e[2]) / 2 * gs, meta: LIB.meta[name], tiltK: 0 };
      it.cx = it.x + it.ccx; it.cz = z + it.ccz;
      specs.push({ x: it.x, z: it.z, items: [it] });
      x += 2 * hx + 1.5;
    }
  }
  };
  if (new URLSearchParams(location.search).has('galleryonly')) { galleryItems(); flush(); return { items: stats.items, clusters: specs.length }; }
  // positions hug the lane edge: lane clearance + the piece's own radius + a random extra
  const near = (cOf, side, z, extra, zj) => (rad, t) => [cOf(z) + side * (3.3 + rad * 0.7 + r() * extra * (1 + t * 0.35)), z + (r() - 0.5) * zj * (1 + t * 0.2)];
  const cField = (zz) => routeX(zz) * 0.5;
  /** walk down the route on each side: a near cluster (lane-edge, medium pieces) and every other step a big one further out; the cursor keeps pace with what was placed */
  const walkRoute = (z0, z1, cOf, o) => {
    for (const side of [-1, 1]) {
      let z = z0 - r() * 6;
      while (z > z1) {
        const k = r();
        let ok;
        if (k < o.nearP) ok = composeCluster(near(cOf, side, z, 4, 7), { pool: MID, sat: 3, scale: o.sNear });
        else if (k < o.nearP + o.midP) ok = composeCluster(near(cOf, side, z, 10, 9), { pool: BIG, sat: 4, mid: true, scale: o.sMid });
        else ok = composeCluster(near(cOf, side, z, 26, 12), { pool: BIG, sat: 3, mid: true, scale: o.sFar });
        z -= ok ? o.step * (0.8 + 0.5 * r()) : 2.5;
      }
    }
  };
  // foreground sets: per official view, clusters at 6-34 m ahead on both sides of the lane (relaxed slope limit, pieces follow the terrain)
  for (const [ax, az, yaw] of ANCHORS) {
    const a = yaw * Math.PI / 180, fx = -Math.sin(a), fz = -Math.cos(a), rx = -fz, rz = fx;
    for (const side of [-1, 1]) for (const [d0, d1, pool, sc, lat0, lat1] of [[6, 12, MID, 1, 3.8, 7], [12, 22, BIG, 0.9, 6, 12], [22, 34, BIG, 1.0, 9, 18]]) {
      const street = az < 143 && az > 30;
      composeCluster((rad, t) => { const d = lerp(d0, d1, r()), l = side * (lat0 + rad * 0.55 + r() * (lat1 - lat0)); return [ax + fx * d + rx * l, az + fz * d + rz * l]; }, { pool, sat: 3, mid: true, scale: street ? sc * 0.75 : sc, relax: 2.2, anchor: true });
    }
    // low pieces strewn over the slopes right in front of the eye (they follow the ground and sit half buried)
    for (let k = 0; k < 6; k++) {
      const side = k % 2 ? 1 : -1;
      composeCluster(() => { const d = 4 + r() * 12, l = side * (1.9 + r() * 8); return [ax + fx * d + rx * l, az + fz * d + rz * l]; }, { pool: LOW, sat: 2, relax: 7, anchor: true, scale: 1.1 });
    }
    // the near ring (3.5 - 8 m ahead): the first snow the eye meets in the lower frame gets a few low pieces of its own
    for (let k = 0; k < 16; k++) {
      const side = k % 2 ? 1 : -1, low = k >= 10;
      const [n, v] = pick(r, low ? LOW : FLAT);
      for (let t = 0; t < 12; t++) {
        const d = 2.2 + r() * 6.4, l = side * (1.2 + r() * 6.5);
        const it = seat(n, v, ax + fx * d + rx * l, az + fz * d + rz * l, r() * 6.28, lerp((low ? SCALE.LOW : SCALE.FLAT)[0], (low ? SCALE.LOW : SCALE.FLAT)[1], r()), { sink: r() * 0.1, anchor: true, relax: 7, inlane: !low, lane: low ? 3.0 : 0.8 });
        if (it) { commit(it); emit([it]); break; }
      }
    }
    // ultra-low strewn pieces right in the lane ahead of the eye (stepped over, never blocking)
    for (let k = 0; k < 11; k++) {
      const side = k % 2 ? 1 : -1;
      const [n, v] = pick(r, FLAT);
      for (let t = 0; t < 8; t++) {
        const d = 3.4 + 17 * Math.pow(r(), 1.7), l = side * (1.3 + r() * 4.6);
        const it = seat(n, v, ax + fx * d + rx * l, az + fz * d + rz * l, r() * 6.28, lerp(SCALE.FLAT[0], SCALE.FLAT[1], r()), { sink: r() * 0.1, lane: 1.2, anchor: true, relax: 7, inlane: true });
        if (it) { commit(it); emit([it]); break; }
      }
    }
  }
  walkRoute(250, 178, cField, { nearP: 0.45, midP: 0.4, sNear: 1, sMid: 1, sFar: 1.1, step: 6 });
  // viaduct approach (just outside the pier line) and the arches' feet
  for (const z of [188, 192, 157, 153]) for (const side of [-1, 1]) composeCluster(near(cField, side, z, 12, 6), { pool: r() < 0.5 ? MID : BIG, sat: 3, mid: true });
  // street plateau flanks: narrow band between the lane and the building lines, so smaller pieces
  walkRoute(142, 30, () => 0, { nearP: 0.5, midP: 0.5, sNear: 0.8, sMid: 0.7, sFar: 0.7, step: 6 });
  // city end -> canyon floor
  walkRoute(30, -186, canyonX, { nearP: 0.4, midP: 0.42, sNear: 1, sMid: 1, sFar: 1.1, step: 6 });
  // lane-edge trim: small pieces (rubble, plates, bollards, short walls) strung along both edges of the route, some leaning into the lane
  const edgePass = (z0, z1, cOf, step, dMin, dMax) => {
    for (const side of [-1, 1]) {
      for (let z = z0 - r() * step; z > z1; z -= step * (0.7 + 0.7 * r())) {
        for (let t = 0; t < 8; t++) {
          const [n, v] = pick(r, r() < 0.5 ? SMALL : LOW);
          const it = seat(n, v, cOf(z) + side * lerp(dMin, dMax, r()), z + (r() - 0.5) * 3, r() * Math.PI * 2, lerp(SCALE.LOW[0], SCALE.LOW[1], r()), { sink: r() * 0.2 });
          if (it) {
            commit(it);
            const list = [it];
            const [n2, v2] = pick(r, SMALL);
            const a = r() * 6.28, d = it.rad * 0.9 + 0.7 + r();
            const it2 = seat(n2, v2, it.cx + Math.cos(a) * d, it.cz + Math.sin(a) * d, r() * 6.28, lerp(1.1, 1.5, r()), { sink: r() * 0.2 });
            if (it2) { commit(it2); list.push(it2); }
            emit(list);
            break;
          }
        }
      }
    }
  };
  edgePass(250, 178, cField, 5.5, 2.6, 7);
  edgePass(142, 30, () => 0, 5.5, 2.6, 7);
  edgePass(30, -186, canyonX, 5.5, 2.6, 7);
  // wind drifts: long low snow ridges along the wind next to the lane, so the plateau and the field never read as a flat runway
  const driftPass = (z0, z1, cOf, step, dMin, dMax) => {
    for (const side of [-1, 1]) for (let z = z0 - r() * step; z > z1; z -= step * (0.7 + 0.8 * r())) {
      for (let t = 0; t < 4; t++) {
        const len = 2.6 + r() * 3.2, wid = 0.8 + r() * 0.8;
        const x = cOf(z) + side * lerp(dMin, dMax, r()), zz = z + (r() - 0.5) * 6;
        const yaw = Math.atan2(WIND_Z, WIND_X) * -1 + (r() - 0.5) * 0.5 + (r() < 0.5 ? 0 : Math.PI);
        if (laneDist(x, zz) - wid * 1.3 < 1.2 || Math.abs(x) > HALF_X - 14 || zz > 262 || zz < -192 || hit(x, zz, len * 0.5) || nearAnchor(x, zz, 0, false) || slopeAt(x, zz) > 0.35) continue;
        const d = { cx: x, cz: zz, rx: len, rz: wid, yaw, h: 0.3 + r() * 0.4, tail: 0.5 };
        emit([{ drift: d, name: 'drift', v: 0, x, z: zz, cx: x, cz: zz, top: 0, low: true, rad: len, sink: 0 }]);
        break;
      }
    }
  };
  driftPass(250, 178, cField, 9, 3, 14);
  driftPass(142, 30, () => 0, 9, 3.6, 10);
  driftPass(30, -186, canyonX, 9, 3, 14);
  // ultra-low gravel fans / scrap in loose groups along both sides of the footprint line: a focal piece plus satellites of decreasing size,
  // with irregular gaps between groups (so the lane reads as lived-in, never as an empty runway nor as an even scatter)
  const flatPass = (z0, z1, cOf, step) => {
    let k = 0;
    for (let z = z0 - r() * step; z > z1; z -= step * (0.5 + 1.1 * r()), k++) {
      const side = r() < 0.5 ? -1 : 1;
      for (let t = 0; t < 6; t++) {
        const [n, v] = pick(r, FLAT);
        const l0 = 1.5 + r() * 4.2;
        const f = seat(n, v, cOf(z) + side * l0, z + (r() - 0.5) * 3, r() * 6.28, lerp(SCALE.FLAT[0], SCALE.FLAT[1], r()), { sink: r() * 0.1, lane: 1.2, relax: 4, inlane: true });
        if (!f) continue;
        commit(f);
        const list = [f];
        const ns = Math.floor(r() * 3.2);
        for (let i = 0; i < ns; i++) for (let u = 0; u < 4; u++) {
          const [n2, v2] = pick(r, FLAT);
          const a = r() * 6.28, d = f.rad * 0.8 + 0.5 + r() * 1.6 + i * 0.6;
          const g = seat(n2, v2, f.cx + Math.cos(a) * d, f.cz + Math.sin(a) * d, r() * 6.28, lerp(0.8, 1.15, r()), { sink: r() * 0.1, lane: 1.2, relax: 4, inlane: true });
          if (g) { commit(g); list.push(g); break; }
        }
        emit(list);
        break;
      }
    }
  };
  flatPass(250, 178, (zz) => 1 + routeX(zz) * 0.3, 4.4);
  flatPass(142, 30, () => 0, 4.4);
  flatPass(30, -186, canyonX, 4.4);
  // 5) low step-over dressing inside / at the edge of the lane
  const lowAlong = (z0, z1, step, xOf) => { for (let z = z0; z > z1; z -= step * (0.7 + 0.6 * r())) {
    const side = r() < 0.5 ? -1 : 1;
    const x = xOf(z) + side * (1.8 + r() * 2.6);
    const [n, v] = pick(r, LOW);
    const it = seat(n, v, x, z, r() * Math.PI * 2, lerp(SCALE.LOW[0], SCALE.LOW[1], r()), { sink: r() * 0.15 });
    if (it) { commit(it); emit([it]); }
  } };
  lowAlong(250, 180, 5, (z) => 1 + routeX(z) * 0.3);
  lowAlong(140, 32, 5.5, () => 0);
  lowAlong(26, -190, 5, (z) => canyonX(z));

  galleryItems();
  flush();
  if (DBG) console.info('DRESSLOG ' + (stats.log ?? []).join(' | '));
  console.info('dressing: clusters ' + stats.clusters + ' items ' + stats.items + ' LOD0 tris ~' + Math.round(stats.tris) + ' rejects ' + JSON.stringify(stats.rej));
  return { items: stats.items, clusters: stats.clusters };
}
