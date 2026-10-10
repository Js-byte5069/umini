// Analytic height-field world: the same function drives rendering, collision and prop placement.
import * as THREE from 'three';
import { makeNoise, clamp, lerp, sstep, rng } from './noise.js';
import { terrainMaterial, makeTerrainMaterial, setTerrainTexture } from './terrain_material.js';

const N = makeNoise(20240611);

/** per-mesh hook: hands the chunk's gradient texture + its world rect to the shared terrain material right before the draw */
function bindNormalTexture(renderer, scene, camera, geometry, material) {
  const ud = geometry.userData;
  setTerrainTexture(material, ud.ntex ?? null, ud.chunk);
}

export const HALF_X = 215;      // playable half width
export const Z_START = 275;     // south edge (spawn side)
export const Z_END = -205;      // north edge (factory gate side)
export const PLATEAU_H = 64;    // height of the high outer plateau that frames the map

// ── layout helpers ────────────────────────────────────────────────────────────
export const canyonX = (z) => 9 * Math.sin(z * 0.017 + 0.6);
export const canyonHalfWidthAt = (z) => canyonHalfWidth(z);
const gauss = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
const canyonHalfWidth = (z) =>
  44 + 100 * sstep(4, 50, z) - 15 * gauss(z, -58, 30) + 9 * gauss(z, -128, 28);
const canyonFloor = (z) => -17 * sstep(14, -58, z) - 2.5 * sstep(-60, -170, z);

// Registered footprints (buildings, props, walls): snow drifts pile against them and ground AO darkens around them.
// f = { x, z, hx, hz, drift, reach? } (reach: bank width in m, default 6.5; small props pass a smaller one)
export const FOOTPRINTS = [];
export function addFootprint(f) { FOOTPRINTS.push(f); }

const FP_CELL = 32, FP_MARGIN = 16;
const fpGrid = new Map();
let fpIndexed = 0;
const FP_NONE = Object.freeze({ drift: 0, ao: 0 });
/** bins footprints added since the last query into 32 m cells (incremental: world.js keeps registering while it builds) */
function fpIndex() {
  for (; fpIndexed < FOOTPRINTS.length; fpIndexed++) {
    const f = FOOTPRINTS[fpIndexed];
    const reach = Math.max(FP_MARGIN, (f.reach ?? 0) * 2 + 1, (f.aoR ?? 0) + 1);
    const i0 = Math.floor((f.x - f.hx - reach) / FP_CELL), i1 = Math.floor((f.x + f.hx + reach) / FP_CELL);
    const j0 = Math.floor((f.z - f.hz - reach) / FP_CELL), j1 = Math.floor((f.z + f.hz + reach) / FP_CELL);
    for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) { const k = ii * 4096 + j; const a = fpGrid.get(k); if (a) a.push(f); else fpGrid.set(k, [f]); }
  }
}
function footprintField(x, z) {
  if (fpIndexed !== FOOTPRINTS.length) fpIndex();
  const list = fpGrid.get(Math.floor(x / FP_CELL) * 4096 + Math.floor(z / FP_CELL));
  if (!list) return FP_NONE;
  let drift = 0, ao = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const qx = Math.abs(x - f.x) - f.hx, qz = Math.abs(z - f.z) - f.hz;
    const R = f.reach ?? 6.5, aoR = f.aoR ?? 3.2, lim = Math.max(R * 2, aoR) + 1;
    if (qx > lim || qz > lim) continue;
    const d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
    const amp = (f.drift ?? 0.8) * 1.5;
    const wob = 0.75 + 0.25 * Math.sin(x * 0.31 + z * 0.23);
    drift = Math.max(drift, amp * sstep(R, 0.2, d) * wob);
    if (amp > 0.3) {
      // wind tail: the same bank slid downwind, lower and longer, with a ridged crest line (lee drift)
      const tx = x - WIND_X * R, tz = z - WIND_Z * R;
      const ux = Math.abs(tx - f.x) - f.hx, uz = Math.abs(tz - f.z) - f.hz;
      if (ux < R + 0.5 && uz < R + 0.5) {
        const dt = Math.hypot(Math.max(ux, 0), Math.max(uz, 0)) + Math.min(Math.max(ux, uz), 0);
        const crest = 0.85 + 0.15 * Math.cos((dt - 1.5) * 1.1);
        drift = Math.max(drift, amp * 0.5 * sstep(R * 0.86, 0.4, dt) * crest * (0.8 + 0.2 * Math.sin(x * 0.17 - z * 0.21)));
      }
    }
    ao = Math.max(ao, sstep(aoR, 0, d));
  }
  return drift === 0 && ao === 0 ? FP_NONE : { drift, ao };
}
const WIND_X = 0.906, WIND_Z = 0.423;

// ── sculpted cliff profile ─────────────────────────────────────────────────────────────────────────────────
// Rock masses are a few big tiers (1-3) rather than a stack of terraces. Each tier is one steep, near-vertical face with a rounded toe and a
// soft shoulder, followed by a gently rising snow bench that spills over the lip (benches are what the shader paints as thick snow). The plan
// line of every face is a rounded polyline (long planar facets joined by soft creases) plus a few broad erosion scoops: no jogs, no
// per-block steps, no gullies. A smooth snow / scree bank sits at each face foot. Output is a height FRACTION (0..1) of the total
// wall height so the same profile serves canyon walls, mesas and the frame.
const TAU = Math.PI * 2;
const hsh = (n) => { n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d); n = Math.imul(n ^ (n >>> 12), 0x297a2d39); return ((n ^ (n >>> 15)) >>> 0) / 4294967296; };

// ── legacy cliff ────────────────────────────────────────────────────────────────────────────────────────────
// The accepted level layout (props, exit yards, gate wings, spire discs) was built around the previous stepped cliffs. Two things keep it intact:
//  1. the new tier-0 face foot follows the old first-riser line (smoothed: its crisp block jogs are rounded, and only ever pushed away from the floor);
//  2. the old cliff function itself is kept (oldCliff below) and blended in under rigid props (see padLock), so the ground a prop was seated on stays put.
/** the old chiselled block offset (crisp jogs half way between the random node values), replaced by the same node values joined with a smooth S curve.
 *  The curve is an upper envelope of the old line: a jog that moved the foot deeper into the wall is made early, one that brought it back is made late, so
 *  the new face never starts nearer to the floor than the old first riser did (props, needles and boulders were placed on that old floor). */
function legacyBlk(q, K, seed) {
  const j = Math.floor(q), fq = q - j;
  const j0 = K ? ((j % K) + K) % K : j, j1 = K ? (((j + 1) % K) + K) % K : j + 1;
  const o0 = hsh(j0 * 131 + seed) - 0.5, o1 = hsh(j1 * 131 + seed) - 0.5;
  const t = o1 > o0 ? clamp(fq * 1.8) : clamp((fq - 0.5) * 1.8 + 0.1);
  return o0 + (o1 - o0) * t * t * (3 - 2 * t);
}
/** the previous first-riser plan position (m past the wall foot) at one point along the wall */
function legacyFoot(l, along, wx, wz, circ) {
  const gq = circ > 0 ? N.n2(Math.cos(along / circ * TAU) * circ * l.gf + l.gph, Math.sin(along / circ * TAU) * circ * l.gf + 3.7) : N.n2(along * l.gf + l.gph, 11.3);
  // the old V-shaped gullies become broad, soft bays (twice as wide, rounded bottom): no radial grooves up the face
  const gg = sm01(1 - Math.abs(gq) * 2.4);
  const gdepth = gg * l.gA * 0.8 * (0.5 + 0.5 * N.n2(along * 0.017 + 5.5, l.gph));
  const jogA = l.jogA[0], jogF = l.jogF[0], bamp = l.bamp[0], blen = l.blen[0];
  let p = l.p[0] + jogA * (circ > 0 ? N.n2(wx * jogF + l.ph[0], wz * jogF) : N.n2(along * jogF + l.ph[0], 0.5));
  const K = circ > 0 ? Math.max(3, Math.round(circ / blen)) : 0;
  p += bamp * 2 * legacyBlk(K ? (along / circ) * K : along / blen, K, l.seed * 7);
  const K2 = circ > 0 ? Math.max(6, Math.round(circ / (blen * 0.48))) : 0;
  p += bamp * 0.30 * legacyBlk(K2 ? (along / circ) * K2 : along / (blen * 0.48), K2, l.seed * 11 + 5);
  return p + gdepth * 0.385;
}
const smoothLegacyFoot = legacyFoot;

function makeOldSpec(seed, n, len, H) {
  const r = rng(seed * 977 + 11);
  const rise = [], ledge = [], slope = [], run = [], p = [], jogA = [], jogF = [], bamp = [], blen = [], fil = [], fd = [], ph = [], tw = [];
  let ws = 0, ls = 0;
  for (let i = 0; i < n; i++) { const v = 0.5 + r() * 1.0 + (r() < 0.3 ? 0.8 : 0); rise.push(v); ws += v; }
  for (let i = 0; i < n; i++) { const v = (i === 0 ? 0.9 : 0.35) + r() * 1.25; ledge.push(v); ls += v; }
  let runSum = 0;
  for (let i = 0; i < n; i++) {
    rise[i] /= ws;
    slope.push(2.2 + r() * 1.8);
    run.push(Math.max(1.4, rise[i] * H / slope[i]));
    runSum += run[i];
  }
  const budget = Math.max(len - runSum, n * 3);
  let c = 0;
  for (let i = 0; i < n; i++) {
    c += (ledge[i] / ls) * budget;
    p.push(c);
    c += run[i];
    jogA.push(0.4 + r() * 1.0);
    jogF.push(0.012 + r() * 0.02);
    bamp.push(2.4 + r() * 4.6);
    blen.push(8 + r() * 16);
    fil.push(i === 0 ? 0.42 : 0.14 + r() * 0.16);
    fd.push(i === 0 ? 6.5 : 1.8 + r() * 1.6);
    ph.push(r() * 400);
    tw.push(0.04 + r() * 0.9);
  }
  const suf = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suf[i] = suf[i + 1] + rise[i];
  return { n, len, seed, suf, rise, run, p, jogA, jogF, bamp, blen, fil, fd, ph, tw, gf: 0.03 + r() * 0.015, gA: 6 + r() * 6, gph: r() * 300 };
}
const oldSpecs = {};
const oldSpec = (key, seed, n, len, H) => oldSpecs[key] ?? (oldSpecs[key] = makeOldSpec(seed, n, len, H));

/** chiselled block offset in [-0.5,0.5]: planar segments between integer nodes, joined by crisp jogs (narrow) or angled facets (wide) */
function oldBlk(q, K, seed, hwMin = 0.10) {
  const j = Math.floor(q), fq = q - j;
  const j0 = K ? ((j % K) + K) % K : j, j1 = K ? (((j + 1) % K) + K) % K : j + 1;
  const o0 = hsh(j0 * 131 + seed) - 0.5, o1 = hsh(j1 * 131 + seed) - 0.5;
  const hw = Math.max(hwMin, (0.05 + 0.7 * hsh(j0 * 17 + seed * 3)) * 0.5);
  const lin = clamp((fq - 0.5 + hw) / (2 * hw));
  return o0 + (o1 - o0) * (lin * 0.85 + lin * lin * (3 - 2 * lin) * 0.15);
}

/** s: plan distance past the wall foot (m); along: arc/axis coordinate (m); circ>0 makes the along axis periodic */
function oldCliff(s, along, wx, wz, sp, circ) {
  if (s < -8) return 0;
  // vertical gullies: V-shaped notches, depth growing upward
  const gq = circ > 0 ? N.n2(Math.cos(along / circ * TAU) * circ * sp.gf + sp.gph, Math.sin(along / circ * TAU) * circ * sp.gf + 3.7) : N.n2(along * sp.gf + sp.gph, 11.3);
  const gg = Math.max(0, 1 - Math.abs(gq) * 5.2);
  const gdepth = gg * gg * sp.gA * (0.5 + 0.5 * N.n2(along * 0.017 + 5.5, sp.gph));
  let f = 0;
  const n = sp.n;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1 || 1);
    // slow in/out drift of this ledge edge
    let p = sp.p[i] + sp.jogA[i] * (circ > 0 ? N.n2(wx * sp.jogF[i] + sp.ph[i], wz * sp.jogF[i]) : N.n2(along * sp.jogF[i] + sp.ph[i], 2.1 * i + 0.5));
    // chiselled blocks (two scales)
    const bl = sp.blen[i];
    const K = circ > 0 ? Math.max(3, Math.round(circ / bl)) : 0;
    const q = (K ? (along / circ) * K : along / bl) + i * 0.37;
    p += sp.bamp[i] * 2 * oldBlk(q, K, sp.seed * 7 + i * 53);
    const K2 = circ > 0 ? Math.max(6, Math.round(circ / (bl * 0.48))) : 0;
    const pBig = p;
    p += sp.bamp[i] * 0.30 * oldBlk(K2 ? (along / circ) * K2 : along / (bl * 0.48) + i * 0.61, K2, sp.seed * 11 + i * 71 + 5, 0.24);
    p += gdepth * (0.35 + 0.65 * u) * 1.1;
    const w = sp.run[i];
    const lin = clamp((s - p) / w);
    const t = lin * 0.45 + lin * lin * (3 - 2 * lin) * 0.55;          // steep face, crisp shoulders
    f += sp.rise[i] * t;
    // snow / scree bank at the riser foot: smooth C1 falloff measured from the calm (big-block) edge, so it never saw-tooths
    if (s < p + w) { const dd = Math.max(0, pBig - s) / sp.fd[i]; f += sp.rise[i] * sp.fil[i] * Math.exp(-dd * dd * 0.8 - dd * 0.35) * (1 - t); }
    else if (s > p + w + 40) { f += sp.suf[i + 1]; break; }
  }
  return f;
}

function makeSpec(seed, n, len, H) {
  const r = rng(seed * 977 + 11);
  // one big face for the low masses, a big face crowned by one smaller step for the tall ones: never a stack of terraces
  const T = H < 46 ? 1 : 2;
  let rise;
  if (T === 1) rise = [1];
  else { const a = 0.72 + 0.10 * r(); rise = [a, 1 - a]; }
  const a = [], sl = [], w = [], fil = [], fd = [], k1 = [], ph = [];
  let wsum = 0;
  for (let i = 0; i < T; i++) {
    const top = i === T - 1;
    a.push(top ? 0.89 + 0.06 * r() : 0.86 + 0.07 * r());                     // share of the tier's rise carried by the steep face (the rest is the snow bench)
    sl.push(i === 0 ? 3.6 + 1.8 * r() : 4.4 + 2.2 * r());                   // mean face slope (rise / run)
    w.push(Math.max(2.4, a[i] * rise[i] * H / sl[i]));
    wsum += w[i];
    fil.push((i === 0 ? 1.8 + 1.5 * r() : 0.8 + 1.0 * r()) / H);            // foot bank height (fraction of H)
    fd.push(i === 0 ? 7.5 + 3.5 * r() : 3.0 + 2.0 * r());                   // foot bank reach (m)
    k1.push(i === 0 ? 1 : 0.75 + 0.5 * r());                                 // upper tiers echo the lower tier's facet line
    ph.push(r() * 300);
  }
  const P0 = Math.min(7 + 5 * r(), len * 0.3);                               // plan distance of the lowest face foot past the wall foot
  const rest = Math.max(len - 3 - P0 - wsum * 0.85, T * 6);
  const bw = [];
  let bs = 0;
  for (let i = 0; i < T; i++) { const v = i === T - 1 ? 1.5 + 0.8 * r() : 0.7 + 0.6 * r(); bw.push(v); bs += v; }
  const B = bw.map((v) => rest * v / bs);
  const p = [];
  let c = P0;
  for (let i = 0; i < T; i++) { p.push(c); c += w[i] * 0.85 + B[i]; }
  const L1 = 34 + 22 * r();
  return {
    T, n, len, seed, H, rise, a, sl, w, p, B, fil, fd, k1, ph,
    L1, A1: Math.min(10, 2.2 + len * 0.08) * (0.7 + 0.5 * r()),            // big planar facets: segment length / amplitude
    L2: L1 * (0.38 + 0.15 * r()), A2: 1.6 + 1.6 * r(),                     // a second, smaller swing so facets never repeat
    L3: 84 + 64 * r(),                                                       // how often the first face's lip rises / sinks along the wall
    GL: 62 + 40 * r(), GD: 2.5 + 4.0 * r(),                                 // broad erosion scoops: spacing / depth
    s1: seed * 7 + 3, s2: seed * 11 + 5, s3: seed * 13 + 7,
    leg: makeOldSpec(seed, n, len, H),
  };
}
const specs = {};
const spec = (key, seed, n, len, H) => specs[key] ?? (specs[key] = makeSpec(seed, n, len, H));

/** rounded polyline: random node values in [-1,1] joined by straight segments (planar facets) with parabolic corner rounding of radius r (node units) */
function facetWave(q, K, seed, r = 0.46) {
  const j = Math.floor(q), fq = q - j;
  const v = (m) => hsh((K ? ((m % K) + K) % K : m) * 131 + seed) * 2 - 1;
  const v0 = v(j - 1), v1 = v(j), v2 = v(j + 1), v3 = v(j + 2);
  let o = v1 + (v2 - v1) * fq;
  if (fq < r) { const t = r - fq; o += ((v2 - v1) - (v1 - v0)) * t * t / (4 * r); }
  if (fq > 1 - r) { const t = r - (1 - fq); o += ((v3 - v2) - (v2 - v1)) * t * t / (4 * r); }
  return o;
}
/** broad shallow erosion scoops (cosine hollows, about one per 60-100 m, absent from a third of the cells): metres the face steps back */
function scoops(along, circ, sp) {
  const K = circ > 0 ? Math.max(2, Math.round(circ / sp.GL)) : 0;
  const q = K ? along / circ * K : along / sp.GL;
  const j = Math.floor(q);
  let o = 0;
  for (let d = -1; d <= 1; d++) {
    const jj = j + d, id = K ? ((jj % K) + K) % K : jj;
    if (hsh(id * 977 + sp.s3) > 0.64) continue;
    const c = jj + 0.2 + 0.6 * hsh(id * 31 + sp.s3 + 1), wid = 0.26 + 0.22 * hsh(id * 57 + sp.s3 + 2);
    const u = (q - c) / wid;
    if (u > -1 && u < 1) { const t = 1 - u * u; o += sp.GD * (0.45 + hsh(id * 7 + sp.s3 + 4)) * t * t; }
  }
  return o;
}
const sm01 = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };

/** set by heightAt when the caller wants the lip data (vertex building): WANT_LIP switches the extra work on; cliff() then leaves CL = height fraction of the
 *  lip of the face this point belongs to and CF = height fraction of that face (both blended smoothly across tiers) */
let WANT_LIP = false, CL = 0, CF = 0;
// per-call scratch: tier foot positions (m), bench widths, rise shares and face widths for the wall being evaluated
const _P = new Float64Array(4), _B = new Float64Array(4), _R = new Float64Array(4), _W = new Float64Array(4), _A = new Float64Array(4);
/** height fraction at plan distance s for the tier faces whose plan positions are P (m) */
function profile(s, sp, P) {
  let f = 0;
  for (let i = 0; i < sp.T; i++) {
    const p = P[i], wf = _W[i], x = (s - p) / wf;
    const t = x <= 0 ? 0 : x >= 1 ? 1 : 0.1 * x + 0.9 * x * x * (3 - 2 * x);               // rounded toe, steep middle, soft shoulder
    const a = _A[i];
    f += _R[i] * a * t;
    // snow bench behind the lip: rises gently (and flattens) up to the next tier's foot / the plateau
    f += _R[i] * (1 - a) * sm01((s - (p + wf * 0.85)) / _B[i]);
    // snow / scree bank at the face foot: smooth C1 falloff (same line as the face, so it never saw-tooths)
    if (s < p + wf) { const dd = Math.max(0, p - s) / sp.fd[i]; f += sp.fil[i] * Math.exp(-dd * dd * 0.8 - dd * 0.35) * (1 - t); }
  }
  return f;
}

/** s: plan distance past the wall foot (m); along: arc/axis coordinate (m); circ>0 makes the along axis periodic */
function cliff(s, along, wx, wz, sp, circ) {
  CL = 0; CF = 0;
  if (s < -8) return 0;
  const T = sp.T;
  const K1 = circ > 0 ? Math.max(4, Math.round(circ / sp.L1)) : 0, K2 = circ > 0 ? Math.max(6, Math.round(circ / sp.L2)) : 0;
  const w1 = facetWave(K1 ? along / circ * K1 : along / sp.L1, K1, sp.s1);
  const w2 = facetWave(K2 ? along / circ * K2 + 0.37 : along / sp.L2 + 0.37, K2, sp.s2);
  const sc = scoops(along, circ, sp);
  // the first face's lip rolls up and down along the wall (the crown step takes up the slack), so tier lines never run level like contours
  if (T === 2) {
    const K3 = circ > 0 ? Math.max(2, Math.round(circ / sp.L3)) : 0;
    const lw = facetWave(K3 ? along / circ * K3 : along / sp.L3, K3, sp.s3 + 17, 0.45);
    _R[0] = clamp(sp.rise[0] * (1 + 0.10 * lw), 0.6, 0.94); _R[1] = 1 - _R[0];
  } else _R[0] = 1;
  // tier-0 foot = the old first-riser line (smoothed along the wall) + a small facet swing; the rest of the stack is squeezed / stretched so the plateau starts where it did
  const P0 = clamp(smoothLegacyFoot(sp.leg, along, wx, wz, circ), 4, sp.len * 0.55) + 0.30 * (sp.A1 * sp.k1[0] * (0.5 + 0.5 * w1) + sp.A2 * (0.5 + 0.5 * w2)) + 0.2 * sc;
  const kS = clamp((sp.len - 3 - P0) / Math.max(sp.len - 3 - sp.p[0], 4), 0.35, 2.5);
  // the face's lean changes from plane to plane along the wall (some stand near-vertical, some lie back): lit and shaded planes of different weight
  const wl = facetWave(circ > 0 ? along / circ * Math.max(3, Math.round(circ / (sp.L1 * 1.3))) : along / (sp.L1 * 1.3) + 0.2, circ > 0 ? Math.max(3, Math.round(circ / (sp.L1 * 1.3))) : 0, sp.s2 + 59);
  _W[0] = sp.w[0] * (1 + 0.34 * wl); _W[1] = sp.w[1] * (1 + 0.2 * wl);
  _P[0] = P0;
  if (T === 2) {
    // the crown step has a plan line of its own (partly echoing the first face, partly independent) and sits back by a different amount from place to place
    const w1b = facetWave(K1 ? along / circ * K1 + 0.5 : along / (sp.L1 * 0.8) + 0.5, K1, sp.s1 + 101);
    _P[1] = P0 + (sp.p[1] - sp.p[0]) * kS + sp.A1 * (0.30 * sp.k1[1] * w1 + 0.80 * w1b) + sp.A2 * w2 * 0.6 + sc;
    // a snow bench between the two faces is either clearly a bench or not there at all, never a thin ribbon: the crown step is kept at least 6 m behind the
    // first face's shoulder wherever the facet swings would bring it nearer (as far as the plan length allows: the crown step's own bench keeps 4 m)
    const bLo = P0 + 0.85 * _W[0];
    _P[1] = Math.max(_P[1], Math.min(bLo + 6, Math.max(sp.len - 7 - 0.85 * _W[1], bLo + 2.5)));
    _B[0] = Math.max(_P[1] - bLo, 2.5);                                         // the lower snow bench runs right up to the crown step's foot
  }
  // the last bench always tops out at the same plan distance (len - 3) however the facet lines swing: the plateau of a mesa is then dead calm instead of
  // fanning out in radial ripples around its centre (where the along coordinate gets compressed)
  _B[T - 1] = Math.max(sp.len - 3 - (_P[T - 1] + 0.85 * _W[T - 1]), 3);
  // calm benches: a snow bench may climb at an average slope of 0.5 at most (peak 0.75, well under the shader's rock threshold at ~1.05..1.5), so benches always read
  // as soft snow and never hover at the snow / rock threshold (that drew meandering snow veins over the face). Whatever rise a narrow bench cannot carry
  // is handed to the face below it (the total height of the tier is unchanged: only where the climb happens moves)
  for (let i = 0; i < T; i++) {
    const rh = _R[i] * sp.H, allow = _B[i] * 0.5;
    _A[i] = rh * (1 - sp.a[i]) > allow ? 1 - allow / rh : sp.a[i];
  }
  const f = profile(s, sp, _P);
  if (WANT_LIP) {
    // lip height (as a fraction of H): the first tier's lip, blending smoothly into each next tier's lip across the bench behind the previous one,
    // so it never jumps where the active tier changes (a jump interpolated over one cell would draw saw teeth along the snow cap)
    let Lf = 0, prev = 0, Ff = 0, prevF = 0;
    for (let k = 0; k < T; k++) {
      const lk = profile(_P[k] + 0.9 * _W[k], sp, _P), fk = _R[k] * _A[k];
      if (k === 0) { Lf = lk; Ff = fk; }
      else { const wk = sm01((s - (_P[k - 1] + 0.9 * _W[k - 1])) / Math.max(_P[k] - (_P[k - 1] + 0.9 * _W[k - 1]), 3)); Lf += (lk - prev) * wk; Ff += (fk - prevF) * wk; }
      prev = lk; prevF = fk;
    }
    CL = Lf;                                     // height fraction of the lip this point belongs to
    CF = Ff;                                     // height of the face this point belongs to (fraction of H), blended the same way: the snow cap scales with it
  }
  return f;
}

// wind-sculpted dunes: long flowing swells (macro) + crisp wind ridges / sastrugi (detail) leaning along the wind
function duneMacro(x, z) {
  const wx = x * 0.9 + z * 0.42, wz = z * 0.9 - x * 0.42;
  const warp = N.n2(x * 0.006, z * 0.006) * 28;
  return N.fbm2((wx + warp) * 0.0125, (wz - warp) * 0.019, 3) * 22 + N.n2(wx * 0.03 + 3.1, wz * 0.055) * 4.2;
}
function duneDetail(x, z) {
  const wx = x * 0.9 + z * 0.42, wz = z * 0.9 - x * 0.42;
  const warp = N.n2(x * 0.006, z * 0.006) * 28;
  // rounded wind ridges (squared falloff gives a smooth crown instead of a knife-edge cusp) + fine sastrugi; the ridge
  // phase is bent by a second slow noise so crest lines wander instead of running straight
  const bend = N.n2(x * 0.011 + 4.0, z * 0.011) * 18;
  const rq = N.n2((wx + warp * 0.6 + bend) * 0.02, (wz - warp + bend * 0.5) * 0.05 + 9.3);
  const crest = Math.pow(Math.max(0, 1 - (rq * 2.5) * (rq * 2.5)), 1.5);
  const rq2 = N.n2(wx * 0.045 + 21.7 + bend * 0.04, wz * 0.11 + 4.4);
  const crest2 = Math.pow(Math.max(0, 1 - (rq2 * 3.2) * (rq2 * 3.2)), 1.4);
  const rq3 = N.n2(wx * 0.12 + 5.7, wz * 0.3 + 1.4);
  const crest3 = Math.pow(Math.max(0, 1 - (rq3 * 3.6) * (rq3 * 3.6)), 1.3);
  return crest * 2.3 + crest2 * 0.7 + crest3 * 0.22 + N.n2(wx * 0.1, wz * 0.18) * 0.3;
}

// Per-cell feature tables: jittered-grid features are described once per cell (typed arrays, filled lazily), so a height query only pays for
// arithmetic on the nine cells around it. fill(i, j, t, o) writes a cell's descriptor at t[o + 1...] and returns whether the cell holds a feature;
// cells outside the cached domain are described on the fly into a scratch buffer (same code, same result).
function makeCells(half, stride, fill) {
  const n = 2 * half, tab = new Float32Array(n * n * stride), ok = new Uint8Array(n * n), scratch = new Float32Array(stride);
  const c = {
    t: tab,
    /** offset of cell (i, j)'s descriptor in c.t, or -1 for an empty cell */
    at(i, j) {
      const ii = i + half, jj = j + half;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) { c.t = scratch; return fill(i, j, scratch, 0) ? 0 : -1; }
      c.t = tab;
      const idx = ii * n + jj, o = idx * stride;
      if (!ok[idx]) { ok[idx] = 1; tab[o] = fill(i, j, tab, o) ? 1 : 0; }
      return tab[o] ? o : -1;
    },
  };
  return c;
}

// scattered wind-sculpted snow mounds (real geometry, so they collide): jittered hash grid, elongated along the wind
const MC = 30;
const moundCells = makeCells(64, 6, (i, j, t, o) => {
  const k = i * 7919 + j * 104729 + 17;
  if (hsh(k) > 0.62) return false;
  t[o + 1] = (i + 0.12 + 0.76 * hsh(k + 1)) * MC; t[o + 2] = (j + 0.12 + 0.76 * hsh(k + 2)) * MC;
  t[o + 3] = 4.5 + 8 * hsh(k + 3); t[o + 4] = 0.45 + 1.15 * hsh(k + 4); t[o + 5] = 1.4 + 1.3 * hsh(k + 5);
  return true;
});
function mounds(x, z) {
  const ci = Math.floor(x / MC), cj = Math.floor(z / MC);
  let h = 0;
  for (let j = cj - 1; j <= cj + 1; j++)
    for (let i = ci - 1; i <= ci + 1; i++) {
      const o = moundCells.at(i, j);
      if (o < 0) continue;
      const t = moundCells.t, R = t[o + 3], Hh = t[o + 4], asp = t[o + 5];
      const dx = x - t[o + 1], dz = z - t[o + 2];
      const u = (dx * 0.906 + dz * 0.423) / (R * asp), v = (-dx * 0.423 + dz * 0.906) / R;
      const d2 = u * u + v * v;
      if (d2 < 1) { const q = 1 - d2; h += Hh * q * q * (1.0 + 0.5 * (1 - d2)); }
    }
  return h;
}

// wind-packed hummocks: small elongated snow lumps (walkable, 0.2-0.55 m) that give eye-level snow real relief and crisp terminators
const HC = 11;
const hummockCells = makeCells(80, 6, (i, j, t, o) => {
  const k = i * 15731 + j * 789221 + 3;
  if (hsh(k) > 0.8) return false;
  t[o + 1] = (i + 0.1 + 0.8 * hsh(k + 1)) * HC; t[o + 2] = (j + 0.1 + 0.8 * hsh(k + 2)) * HC;
  t[o + 3] = 2.2 + 3.4 * hsh(k + 3); t[o + 4] = 0.10 + 0.24 * hsh(k + 4); t[o + 5] = 1.9 + 1.5 * hsh(k + 5);
  return true;
});
function hummocks(x, z) {
  const ci = Math.floor(x / HC), cj = Math.floor(z / HC);
  let h = 0;
  for (let j = cj - 1; j <= cj + 1; j++)
    for (let i = ci - 1; i <= ci + 1; i++) {
      const o = hummockCells.at(i, j);
      if (o < 0) continue;
      const t = hummockCells.t, R = t[o + 3], Hh = t[o + 4], asp = t[o + 5];
      const dx = x - t[o + 1], dz = z - t[o + 2];
      const u = (dx * 0.906 + dz * 0.423) / (R * asp), v = (-dx * 0.423 + dz * 0.906) / R;
      const d2 = u * u + v * v;
      if (d2 < 1) { const q = 1 - d2; h += Hh * q * Math.sqrt(q) * (1.1 + 0.4 * v * (u < 0 ? 1 : 0.4)); }   // steeper windward end, long lee tail
    }
  return h;
}

// ── lane relief: route line, static prop pads, stamped trail, swells and clustered lumps ──────────────────────────
/** the walked route's centre line (same formula as the terrain shader's routeX and dressing.js) */
export const routeLineX = (z) => canyonX(z) * sstep(30, -10, z) + 1.5 * Math.sin(z * 0.083 + 0.4) * sstep(40, 150, z) + 0.7 * Math.sin(z * 0.21 + 0.68) * sstep(60, 160, z);

// Spots where world.js seats rigid props from ONE ground sample (containers, ruin walls, gantry legs, stair feet, leaning slabs):
// relief fades out around them so nothing floats or drowns. [x, z, halfX, halfZ, floor of the calm factor]
const PADS = [];
{
  // snow banks (drift, reach) pile against the pad's real footprint (pad minus margin) through the shared footprint system
  const box = (x, z, hx, hz, k = 0, drift = 0, reach = 4.5, inset = 0.4, ramp = 8) => {
    PADS.push([x, z, hx, hz, k, ramp]);
    if (drift > 0) addFootprint({ x, z, hx: hx - inset, hz: hz - inset, drift, reach });
  };
  const cont = (x, z, yaw) => { const q = Math.round(yaw / (Math.PI / 2)) & 1; box(x, z, q ? 1.45 : 3.25, q ? 3.25 : 1.45, 0, 0.42, 4, 0.2); };
  [[10, 117, 0], [-12, 100, Math.PI / 2], [14, 94, 0], [-9, 58, 0], [11, 46, 0], [-64, 53, 0], [-114, 40, 0], [-116, 57, Math.PI / 2]].forEach(([x, z, y]) => cont(x, z, y));
  [[10, -10, 0], [-14, -80, 1], [12, -128, 0], [-16, -160, 1]].forEach(([x, z, q]) => cont(canyonX(z) + x, z, q * Math.PI / 2));
  // ruin walls carry their own 1.2 m skirt and snow-drift meshes: they tolerate relief, so only a thin calm zone
  box(-14, 142, 9.5, 3.4, 0.45, 0.5, 5, 0.9); box(16, 146, 10.5, 3.4, 0.45, 0.5, 5, 0.9); box(-4, 36, 11.5, 3.4, 0.45, 0.5, 5, 0.9);
  box(canyonX(-30) - 22, -30, 9.5, 3.4, 0.45, 0.5, 5, 0.9); box(canyonX(-48) + 20, -48, 9.5, 3.4, 0.45, 0.5, 5, 0.9);
  box(-16, 80, 3.8, 5.8, 0, 0.5, 5, 1.0); box(16, 80, 3.8, 5.8, 0, 0.5, 5, 1.0);
  box(-14, 130, 3.6, 9, 0.2); box(-66, 214, 3.8, 9, 0.2);
  for (let px = -165; px <= 165.1; px += 22) for (const sz of [-1, 1]) box(px, 172 + sz * 5.1, 3.4, 3.4, 0.1);       // viaduct pier feet (placed from one ground sample each)
  [[28, -92, 1], [-32, -142, 2], [-30, -66, 3], [34, -150, 4]].forEach(([x, z, sd]) => box(canyonX(z) + x, z, 8.5 + sd * 0.5, 6.5, 0, 0.6, 6, 2.5));
  box(-90, 49, 40, 17, 0.35);                         // hall branch: yard, hall body and both exits
  box(canyonX(-118), -118, 19.5, 6, 0.12, 0, 0, 0, 3.5); box(canyonX(-178), -178, 58, 12, 0.12, 0, 0, 0, 5);      // ring landmark and the factory gate (wings included)
}
const PAD_CELL = 32;
const padGrid = new Map();
for (const p of PADS) {
  for (let j = Math.floor((p[1] - p[3] - 10) / PAD_CELL); j <= Math.floor((p[1] + p[3] + 10) / PAD_CELL); j++)
    for (let i = Math.floor((p[0] - p[2] - 10) / PAD_CELL); i <= Math.floor((p[0] + p[2] + 10) / PAD_CELL); i++) {
      const k = i * 4096 + j; const a = padGrid.get(k); if (a) a.push(p); else padGrid.set(k, [p]);
    }
}
/** 0 = free ground, -> 1 on / beside a rigid prop's footprint (2 m margin, 8 m ramp): the old cliff profile is blended in there so the ground under it stays where it was */
function padLock(x, z) {
  const list = padGrid.get(Math.floor(x / PAD_CELL) * 4096 + Math.floor(z / PAD_CELL));
  if (!list) return 0;
  let k = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const qx = Math.abs(x - p[0]) - p[2] - 2, qz = Math.abs(z - p[1]) - p[3] - 2;
    if (qx > 8 || qz > 8) continue;
    const d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
    k = Math.max(k, 1 - sstep(0, 8, d));
  }
  return k;
}
/** 1 = free ground, -> 0 next to a rigid prop */
function padCalm(x, z) {
  const list = padGrid.get(Math.floor(x / PAD_CELL) * 4096 + Math.floor(z / PAD_CELL));
  if (!list) return 1;
  let k = 1;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const qx = Math.abs(x - p[0]) - p[2], qz = Math.abs(z - p[1]) - p[3];
    if (qx > 10 || qz > 10) continue;
    const d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
    k = Math.min(k, p[4] + (1 - p[4]) * sstep(0.4, p[5], d));
  }
  return k;
}

// stamped / plowed trail: a shallow compacted floor between low rolled berms (the east berm, downwind, is the heavier one).
// Its width and how well wind keeps it open depend on z through plain sines so the terrain shader can repaint the very same lines.
const trailFill = (z) => 0.5 + 0.5 * sstep(-0.5, 0.55, Math.sin(z * 0.052 + 0.9) * 0.6 + Math.sin(z * 0.0191 + 2.3) * 0.55);
const trailHalf = (z) => 1.25 + 0.3 * Math.sin(z * 0.037 + 2.0);
function trailH(x, z) {
  if (z > 268 || z < -184) return 0;
  const d = x - routeLineX(z), a = Math.abs(d);
  if (a > 6) return 0;
  const w = trailHalf(z);
  const floor = -0.2 * (1 - sstep(w - 0.85, w + 0.75, a));
  const t = (a - (w + 0.85)) / 1.15;
  const berm = t * t < 1 ? (1 - t * t) * (1 - t * t) * (d > 0 ? 0.30 : 0.2) : 0;
  // the spawn mound's steep face (z 224..246) only gets a ghost of the trail: its own slope is already ~0.85
  return (floor + berm) * trailFill(z) * sstep(268, 252, z) * sstep(-184, -170, z) * (1 - 0.8 * sstep(220, 228, z) * (1 - sstep(246, 254, z)));
}

// long, soft wind swells (stretched along the wind): the street / canyon floor stops being a dead-flat slab
function swell(x, z) {
  const u = x * WIND_X + z * WIND_Z, v = -x * WIND_Z + z * WIND_X;
  return N.fbm2(u * 0.017 + 31.7, v * 0.047 + 8.1, 2) * 1.5 + N.n2(u * 0.043 + 3.3, v * 0.1 + 7.7) * 0.5;
}

const SPIRE_DISCS = [[-46, 206, 27], [40, 198, 26], [-24, 188, 19], [27, 226, 19]];

// talus fans: loose scree cones spilling from the gully mouths at the canyon wall feet (side = 0 | 1, s = plan distance past the wall foot).
// Jittered cells along the wall; each fan is a round-shouldered cone, a touch longer down the wall than out into the floor.
const TLC = 27;
const talusCells = [0, 1].map((side) => makeCells(32, 6, (i, j, t, o) => {
  const k = i * 4421 + j * 977 + side * 811 + 91;
  if (hsh(k) > 0.82) return false;
  t[o + 1] = (i + 0.1 + 0.8 * hsh(k + 1)) * TLC;                      // z of the fan axis
  t[o + 2] = 0.5 + 3.5 * hsh(k + 2);                                   // s of the apex
  t[o + 3] = 9 + 8 * hsh(k + 3);                                       // radius along the wall
  t[o + 4] = 0.9 + 1.5 * hsh(k + 4);                                   // height (slopes stay under the terrain shader's rock threshold)
  t[o + 5] = 0.75 + 0.45 * hsh(k + 5);                                 // reach into the floor / up the wall (x radius)
  return true;
}));
function talus(s, z, side) {
  if (s < -16 || s > 24) return 0;
  const C = talusCells[side], ci = Math.floor(z / TLC);
  let h = 0;
  for (let i = ci - 1; i <= ci + 1; i++) {
    const o = C.at(i, 0);
    if (o < 0) continue;
    const t = C.t, R = t[o + 3];
    const dz = (z - t[o + 1]) / R, ds = (s - t[o + 2]) / (R * t[o + 5]);
    const q = 1 - dz * dz - ds * ds;
    if (q > 0) h += t[o + 4] * q * Math.sqrt(q);
  }
  return h;
}

// compacted lane vs deep-snow flanks: the snow either side of the walked lane stands higher (and breaks into gaps / heavier banks),
// so the lane reads as a worn valley through soft deep snow; side and strength change along z, never a continuous kerb
function flankLift(x, z, dl, lx) {
  const sd = x < lx ? 3.1 : 9.7;
  const n1 = 0.5 + 0.5 * N.n2(z * 0.024 + 17.3, sd);
  const amp = 0.28 + 0.72 * sstep(0.22, 0.78, n1);
  return amp * sstep(2.3, 5.8, dl) * (1 - 0.55 * sstep(12, 32, dl));
}

// transverse wind ridges on the long descent into the canyon: sinuous round-crowned crests with a steeper lee, bent and gated by
// slow noise so they come in loose groups of two or three and never as even contour lines
function ridges(x, z) {
  const warp = N.n2(x * 0.021 + 5.1, z * 0.02) * 9 + N.n2(x * 0.055, z * 0.055 + 2.0) * 2.4;
  const lam = 15 + 6 * N.n2(x * 0.011 + 1.7, z * 0.01 + 9.3);
  const ph = (z + warp) / lam, f = ph - Math.floor(ph);
  const prof = f < 0.64 ? sstep(0, 0.64, f) : 1 - sstep(0.64, 1.0, f);
  const gate = sstep(-0.02, 0.38, N.n2(x * 0.018 + 3.3, z * 0.013 + 8.8)) * (0.55 + 0.45 * sstep(-0.1, 0.5, N.n2(x * 0.045 + 12.0, z * 0.045)));
  return prof * gate * (0.35 + 0.35 * (0.5 + 0.5 * N.n2(Math.floor(ph) * 3.7 + 0.5, 7.7)) * 2);
}

// snow-draped rubble: blunt boxy heaps (flat or slightly tilted tops, short firm shoulders) that read as collapsed blocks buried in the
// snow. A focal block is accompanied by two smaller satellites along its long axis; heaps gather in loose fields and square up with
// the street grid in the city. Blocks whose centre sits on the walked lane stay low enough to step over.
const RBC = 17;
const rubbleCells = makeCells(40, 24, (i, j, t, o) => {
  const k = i * 70001 + j * 150001 + 23;
  const gate = N.n2((i + 0.5) * RBC * 0.0105 + 61.0, (j + 0.5) * RBC * 0.0105 + 7.5);
  if (hsh(k) > 0.14 + 1.0 * sstep(-0.12, 0.34, gate)) return false;
  const mx = (i + 0.12 + 0.76 * hsh(k + 1)) * RBC, mz = (j + 0.12 + 0.76 * hsh(k + 2)) * RBC;
  const grid = mz > 28 && mz < 152;
  const yaw = grid ? (hsh(k + 3) - 0.5) * 0.7 + (hsh(k + 4) < 0.5 ? 0 : Math.PI / 2) : hsh(k + 3) * 3.14;
  const hx0 = 1.5 + 2.0 * hsh(k + 5), hz0 = hx0 * (0.55 + 0.4 * hsh(k + 6)), H0 = 0.4 + 0.75 * hsh(k + 7);
  const lowK = Math.abs(mx - routeLineX(mz)) < 3.4 + hx0 ? 0.55 : 1;                // on the lane: step-over only
  t[o + 1] = mx; t[o + 2] = mz; t[o + 3] = Math.cos(yaw); t[o + 4] = Math.sin(yaw);
  t[o + 5] = (hsh(k + 8) - 0.5) * 0.3; t[o + 6] = (hsh(k + 9) - 0.5) * 0.3;          // top plane tilt
  for (let q = 0; q < 3; q++) {
    const sc = q === 0 ? 1 : q === 1 ? 0.62 : 0.42, e = o + 7 + q * 5;
    t[e] = q === 0 ? 0 : (q === 1 ? 1 : -1) * hx0 * (1.15 + 0.5 * hsh(k + 11 + q));    // offset along the long axis
    t[e + 1] = (hsh(k + 14 + q) - 0.5) * hz0 * 1.2;
    t[e + 2] = hx0 * sc; t[e + 3] = hz0 * sc * (0.85 + 0.3 * hsh(k + 17 + q));
    t[e + 4] = H0 * (q === 0 ? 1 : q === 1 ? 0.66 : 0.45) * lowK;
  }
  return true;
});
function rubble(x, z) {
  const ci = Math.floor(x / RBC), cj = Math.floor(z / RBC);
  let h = 0;
  for (let j = cj - 1; j <= cj + 1; j++)
    for (let i = ci - 1; i <= ci + 1; i++) {
      const o = rubbleCells.at(i, j);
      if (o < 0) continue;
      const t = rubbleCells.t;
      const dx = x - t[o + 1], dz = z - t[o + 2], ca = t[o + 3], sa = t[o + 4], tx = t[o + 5], tz = t[o + 6];
      const px = dx * ca + dz * sa, pz = -dx * sa + dz * ca;
      let best = 0;
      for (let q = 0; q < 3; q++) {
        const e = o + 7 + q * 5;
        const lx = px - t[e], lz = pz - t[e + 1];
        const u = Math.abs(lx) / t[e + 2], v = Math.abs(lz) / t[e + 3];
        if (u > 1.5 || v > 1.5) continue;
        const d = Math.pow(u * u * Math.sqrt(u) + v * v * Math.sqrt(v), 0.4);        // superellipse p = 2.5: blunt but round-shouldered, no straight creases
        if (d >= 1.25) continue;
        const f = 1 - sstep(0.25, 1.25, d);
        const top = t[e + 4] * (1 + tx * lx + tz * lz) * (0.62 + 0.38 * f) * f;
        if (top > best) best = top;
      }
      h += best;
    }
  return h;
}

// clustered snow lumps: a focal lump (long gentle windward back, short steep lee) trailed downwind by smaller satellites of
// decreasing size; they gather in loose fields (never an even scatter), so low relief comes in groups with calm snow between them
function makeLumpField(LMC, seed, pBase, pGain, sizeK) {
  const cells = makeCells(Math.ceil(520 / LMC), 20, (i, j, t, o) => {
    const k = i * 20011 + j * 130003 + seed;
    const gate = N.n2((i + 0.5) * LMC * 0.012 + 4.0 + seed * 0.37, (j + 0.5) * LMC * 0.012 + 1.5);       // loose fields
    if (hsh(k) > pBase + pGain * sstep(-0.2, 0.3, gate)) return false;
    const mx = (i + 0.15 + 0.7 * hsh(k + 1)) * LMC, mz = (j + 0.15 + 0.7 * hsh(k + 2)) * LMC;
    const ang = (hsh(k + 6) - 0.5) * 0.9, ca = Math.cos(ang), sa = Math.sin(ang);
    const wx = WIND_X * ca - WIND_Z * sa, wz = WIND_Z * ca + WIND_X * sa;
    t[o + 1] = wx; t[o + 2] = wz;
    for (let q = 0; q < 3; q++) {
      const sc = q === 0 ? 1 : q === 1 ? 0.55 : 0.34, e = o + 3 + q * 5;
      const R = (2.3 + 2.6 * hsh(k + 3)) * sc * sizeK, Hh = (0.34 + 0.5 * hsh(k + 4)) * (q === 0 ? 1 : q === 1 ? 0.62 : 0.4) * Math.sqrt(sizeK), asp = 1.5 + 1.0 * hsh(k + 5);
      const off = (q === 0 ? 0 : (q === 1 ? 1 : 1.9) * (4 + 3 * hsh(k + 7 + q))) * sizeK, side = (hsh(k + 9 + q) - 0.5) * 6 * sizeK;
      t[e] = mx + wx * off - wz * side; t[e + 1] = mz + wz * off + wx * side;
      t[e + 2] = R; t[e + 3] = Hh; t[e + 4] = asp;
    }
    return true;
  });
  return (x, z) => {
    const ci = Math.floor(x / LMC), cj = Math.floor(z / LMC);
    let h = 0;
    for (let j = cj - 1; j <= cj + 1; j++)
      for (let i = ci - 1; i <= ci + 1; i++) {
        const o = cells.at(i, j);
        if (o < 0) continue;
        const t = cells.t, wx = t[o + 1], wz = t[o + 2];
        for (let q = 0; q < 3; q++) {
          const e = o + 3 + q * 5, R = t[e + 2];
          const dx = x - t[e], dz = z - t[e + 1];
          const u0 = dx * wx + dz * wz, v = (-dx * wz + dz * wx) / R;
          if (v > 1 || v < -1) continue;
          const u = u0 / (R * t[e + 4] * (u0 < 0 ? 1.35 : 0.72));
          const d2 = u * u + v * v;
          if (d2 < 1) { const q2 = 1 - d2; h += t[e + 3] * q2 * q2 * (1.0 + 0.6 * q2); }
        }
      }
    return h;
  };
}
const lumps = makeLumpField(14, 11, 0.34, 1.1, 1);
const lumpsCanyon = makeLumpField(19, 5107, 0.5, 1.0, 0.85);        // second, finer field that only the canyon floor uses

// crescent snow drifts (barchan-like): long gentle windward back, rounded crest, steeper lee slip face, horns trailing downwind.
// The lit back / blue lee split gives the toon terminator a bold, connected crescent shadow shape (as in the concept art).
const DRIFT_LAYERS = [[21, 0.70, 7, 9, 0.34, 0.62], [46, 0.55, 16, 14, 0.50, 0.85]];   // cell, probability, length min/range, height min/range
const driftCells = DRIFT_LAYERS.map(([DC, prob, Lm, Lr, Hm, Hr], li) => makeCells(Math.ceil(1700 / DC), 8, (i, j, t, o) => {
  const k = i * 31337 + j * 90017 + 29 + li * 7717;
  if (hsh(k) > prob) return false;
  const L = Lm + Lr * hsh(k + 3);                      // crest -> horn tip, along the wind
  const ang = (hsh(k + 6) - 0.5) * 0.8, ca = Math.cos(ang), sa = Math.sin(ang);
  t[o + 1] = (i + 0.12 + 0.76 * hsh(k + 1)) * DC; t[o + 2] = (j + 0.12 + 0.76 * hsh(k + 2)) * DC;
  t[o + 3] = L; t[o + 4] = L * (0.62 + 0.4 * hsh(k + 4)); t[o + 5] = Hm + Hr * hsh(k + 5);
  t[o + 6] = 0.906 * ca - 0.423 * sa; t[o + 7] = 0.423 * ca + 0.906 * sa;
  return true;
}));
function drifts(x, z) {
  let h = 0;
  for (let li = 0; li < DRIFT_LAYERS.length; li++) {
    const DC = DRIFT_LAYERS[li][0], C = driftCells[li];
    const ci = Math.floor(x / DC), cj = Math.floor(z / DC);
    for (let j = cj - 1; j <= cj + 1; j++)
      for (let i = ci - 1; i <= ci + 1; i++) {
        const o = C.at(i, j);
        if (o < 0) continue;
        const t = C.t, L = t[o + 3], W = t[o + 4], H = t[o + 5], wx = t[o + 6], wz = t[o + 7];
        const dx = x - t[o + 1], dz = z - t[o + 2];
        const u = dx * wx + dz * wz, v = -dx * wz + dz * wx;
        if (u < -0.62 * L || u > 0.84 * L) continue;
        const vn = v / W;
        if (vn <= -1 || vn >= 1) continue;
        const b0 = 1 - vn * vn, env = b0 * Math.sqrt(Math.sqrt(b0));
        const d = u - L * 0.5 * vn * vn;                     // signed distance downwind of the (convex-upwind) crest line
        const q = d < 0 ? -d / (L * 0.62) : d / (L * 0.34 * (0.6 + 0.4 * env));
        if (q >= 1) continue;
        const g = (1 - q * q) * (1 - q * q);
        h += H * env * g;
      }
  }
  return h;
}

// boxy mesas: x, z, half-extent X, half-extent Z, yaw, height, steps, seed, foot length (m)
const mesas = [
  [-150, 205, 30, 24, 0.4, 30, 5, 21, 40], [165, 190, 26, 22, -0.3, 26, 4, 22, 40], [-120, 255, 20, 16, 0.2, 20, 4, 23, 40], [118, 262, 24, 18, -0.5, 24, 4, 24, 40],
  [-185, 120, 24, 30, 0.3, 38, 5, 25, 48], [182, 100, 28, 24, -0.2, 42, 5, 26, 48], [-175, 20, 20, 24, 0.5, 30, 4, 27, 48], [176, 10, 24, 26, -0.4, 36, 5, 28, 48],
  // mid-ground buttes that frame the entrance field (kept well clear of the route line, the viaduct stair at x=-66 and the piers)
  [-118, 243, 11, 9, 0.6, 12, 3, 29, 26], [104, 240, 12, 10, -0.7, 14, 3, 30, 26], [88, 214, 8, 7, 0.9, 9, 3, 32, 20],
  // right-of-centre cliff block in the spawn view (composition: a stepped mesa edge in the mid-ground beside the line of sight)
  [58, 244, 11, 9, -0.5, 16, 3, 33, 24],
];
const MESA_LEN = 48;

// ── far field: distant mesas / ridges beyond the playable bowl (silhouettes for depth layers) ──
export const FAR_HALF = 1664;
const FARM = [];
{
  const r = rng(5150);
  for (let i = 0; i < 70; i++) {
    const a = r() * TAU, dist = 480 + Math.pow(r(), 0.85) * 1000;
    const hx = 22 + r() * 90, hz = 16 + r() * 48;
    const len = 36 + Math.max(hx, hz) * 0.45;
    FARM.push([Math.cos(a) * dist * 0.95, Math.sin(a) * dist * 1.05 + 30, hx, hz, r() * 3.14, 16 + r() * 40 + dist * 0.02, 3 + Math.floor(r() * 4), 300 + i, len]);
  }
}
function farRelief(x, z, aux, wf) {
  const base = N.fbm2(x * 0.0042 + 40, z * 0.0042, 3) * 22 + N.n2(x * 0.011, z * 0.011 + 9) * 7;
  let h = 0;
  for (let i = 0; i < FARM.length; i++) {
    const m = FARM[i];
    const dxm = x - m[0], dzm = z - m[1];
    const rr = Math.max(m[2], m[3]) + m[8] + 14;
    if (dxm > rr || dxm < -rr || dzm > rr || dzm < -rr) continue;
    const c = Math.cos(m[4]), sn = Math.sin(m[4]);
    const wxm = dxm + N.n2(x * 0.012, z * 0.012) * 8, wzm = dzm + N.n2(x * 0.014 + 9, z * 0.014) * 8;
    const u = (wxm * c + wzm * sn) / m[2], v = (-wxm * sn + wzm * c) / m[3];
    const rs = Math.max(m[2], m[3]);
    const d = Math.pow(Math.pow(Math.abs(u), 3.4) + Math.pow(Math.abs(v), 3.4), 1 / 3.4) * rs;
    const sM = rs + m[8] - d;
    if (sM > -8) {
      const sp = spec('F' + i, m[7], m[6], m[8], m[5]);
      const circ = TAU * rs * 1.1;
      const fr = cliff(sM, (Math.atan2(v, u) / TAU + 0.5) * circ, x, z, sp, circ);
      const hm = m[5] * fr;
      if (hm > h) h = hm;
      if (aux) noteAux(aux, sp, fr, hm * wf, m[5] * wf * (CL - fr), m[5] * wf * CF);
    }
  }
  return base + h;
}

// keep the ground calm around the two landmark gates (ring / factory gate sit on their own pads)
function gateFlat(x, z) {
  if (z > -90 || z < -215) return 1;
  return sstep(14, 34, Math.hypot(x - canyonX(-118), z + 118)) * sstep(14, 34, Math.hypot(x - canyonX(-178), z + 178));
}


// ── per-vertex layer coordinate: lets the terrain shader paint strata that follow the modelled ledges ──────────────────
/** dm = metres between this point and the lip of its face, fm = height of that face in metres (both worked out by the caller, who knows how the wall is added to the ground) */
function noteAux(aux, sp, f, w, dm, fm) {
  if (w > aux.w) { aux.w = w; aux.sp = sp; aux.f = f; }
  // lip depth is a weighted blend over all walls that touch this point (overlapping mesas: no jump where the dominant one changes)
  const q = w * w, q4 = q * q;
  aux.sw += q4; aux.sd += q4 * dm; aux.sf += q4 * fm;
}
// rim: the outer frame's top edge rolls up and down instead of running dead straight; rocky buttes crown the rim
const RIMB = [];
{
  const r = rng(6150);
  const side = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let si = 0; si < 4; si++) {
    const n = si < 2 ? 5 : 5;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.2 + 0.6 * r()) / n;           // 0..1 along that side
      const off = 92 + r() * 70;                      // distance past the playable edge (wall top plateau)
      let x, z;
      if (si < 2) { x = side[si][0] * (HALF_X + off); z = Z_END + 30 + t * (Z_START - Z_END - 60); }
      else if (si === 2) { x = (t - 0.5) * 2 * (HALF_X + 40); z = Z_START + off - 20; }
      else { x = (t - 0.5) * 2 * (HALF_X + 40); z = Z_END - off; }
      const hx = 16 + r() * 26, hz = 12 + r() * 22;
      RIMB.push([x, z, hx, hz, r() * 3.14, 26 + r() * 46, 3 + Math.floor(r() * 3), 500 + si * 10 + i, 34 + Math.max(hx, hz) * 0.5]);
    }
  }
}
function rimShape(x, z) {
  const base = Math.max(-2.5, 3 + 11 * N.fbm2(x * 0.0065 + 1.3, z * 0.0065 + 7.7, 3) + 7 * N.n2(x * 0.021 + 5, z * 0.021));
  return base * (1 - sstep(700, 1400, Math.hypot(x, z - 40)));
}
function rimButtes(x, z, aux) {
  let h = 0;
  for (let i = 0; i < RIMB.length; i++) {
    const m = RIMB[i];
    const dxm = x - m[0], dzm = z - m[1];
    const rr = Math.max(m[2], m[3]) + m[8] + 14;
    if (dxm > rr || dxm < -rr || dzm > rr || dzm < -rr) continue;
    const c = Math.cos(m[4]), sn = Math.sin(m[4]);
    const wxm = dxm + N.n2(x * 0.03, z * 0.03) * 6, wzm = dzm + N.n2(x * 0.04 + 9, z * 0.04) * 6;
    const u = (wxm * c + wzm * sn) / m[2], v = (-wxm * sn + wzm * c) / m[3];
    const rs = Math.max(m[2], m[3]);
    const d = Math.pow(Math.pow(Math.abs(u), 3.0) + Math.pow(Math.abs(v), 3.0), 1 / 3.0) * rs;
    const sM = rs + m[8] - d;
    if (sM > -8) {
      const sp = spec('R' + i, m[7], m[6], m[8], m[5]);
      const circ = TAU * rs * 1.1;
      const f = cliff(sM, (Math.atan2(v, u) / TAU + 0.5) * circ, x, z, sp, circ);
      const hm = m[5] * f;
      if (aux) noteAux(aux, sp, f, hm * 1.5, m[5] * (CL - f), m[5] * CF);
      if (hm > h) h = hm;
    }
  }
  return h;
}

export function heightAt(x, z, aux) {
  WANT_LIP = !!aux;
  if (aux) { aux.w = 0; aux.sp = null; aux.f = 0; aux.H = 0; aux.d = 0; aux.sw = 0; aux.sd = 0; aux.sf = 0; }
  const flat = sstep(150, 138, z) * sstep(28, 40, z) * sstep(190, 170, Math.abs(x));
  const entrance = sstep(140, 175, z);
  // the approach corridor (spawn → viaduct gateway) keeps a readable, gently falling line of sight
  const corr = sstep(62, 18, Math.abs(x - 2)) * sstep(135, 178, z) * sstep(292, 268, z);
  const gf = gateFlat(x, z);
  const hMac = duneMacro(x, z) * (1 - 0.72 * corr) * (0.32 + 0.68 * entrance) * (1 - 0.88 * flat) * gf;      // the slow swells alone (the lip data of mesas leans on this smooth part)
  let h = hMac + duneDetail(x, z) * (1 - 0.25 * corr) * (0.62 + 0.38 * entrance) * (1 - 0.6 * flat) * gf;
  h += 4.2 * Math.exp(-(((x - 2) / 38) ** 2 + ((z - 262) / 26) ** 2)) - 3.2 * corr * sstep(236, 205, z);
  // subtle wind-swell on the city plateau
  h += N.n2(x * 0.02, z * 0.03) * 0.5 * flat;

  // canyon
  const cx = canyonX(z);
  const cm0 = sstep(32, -2, z);
  {
    // mounds: not on the city plateau, off the route, away from the two landmark gates
    let mw = (1 - flat) * (1 - 0.65 * corr) * sstep(10, 26, Math.abs(x - cx)) * (z < 45 ? 1 : 1);
    if (z < 45 && z > -200) mw *= sstep(24, 40, Math.hypot(x - canyonX(-118), z + 118)) * sstep(24, 40, Math.hypot(x - canyonX(-178), z + 178));
    if (z > 150 && z < 260) mw *= sstep(10, 22, Math.abs(x - 1.5)) ;
    if (z > 150 && z < 195) mw *= sstep(9, 14, Math.abs(z - 172));       // keep the viaduct gateway clear
    if (mw > 0) h += mounds(x, z) * mw;
    // hummocks everywhere outside the buildings' flat plateau and the gate pads; softer on the walking line
    let hw = (1 - 0.35 * flat) * gf * (z < 262 ? 1 : 0.4) * padCalm(x, z);
    if (hw > 0) h += hummocks(x, z) * hw * (0.55 + 0.45 * sstep(2, 9, Math.abs(x - (z > 30 ? 0 : cx))));
    // crescent drifts: bold lit-back / blue-lee snow forms, calmer on the plateau street and on the walking line, never climbing walls
    let dw = (1 - 0.3 * flat) * gf * (z < 45 ? 1.6 : 1) * (z < 268 ? 1 : 0.35) * (0.62 + 0.38 * sstep(1.5, 8, Math.abs(x - (z > 30 ? 0 : cx))));
    if (z < 45) { const chw = canyonHalfWidth(z); dw *= 1 - cm0 * (1 - sstep(chw - 4, chw - 22, Math.abs(x - cx))); }
    if (dw > 0.01) h += drifts(x, z) * dw;
  }
  if (z < 276 && z > -204 && x < 262 && x > -262) {
    // lane relief: stamped trail, soft wind swells, clustered lumps and buried rubble on the walkable ground (street plateau, canyon floor,
    // entrance field); the compacted lane stays calmer than its flanks and props that were seated from a single ground sample stay clear
    // the relief lives in a corridor around the walked line (street / canyon floor / field): the rest of the world keeps its old shape
    const lx0 = routeLineX(z), dl0 = Math.abs(x - lx0);
    let wG = flat * sstep(42, 30, dl0);
    if (z < 45) { const chw = canyonHalfWidth(z), dc = Math.abs(x - cx); wG = Math.max(wG, (1 - sstep(chw - 10, chw + 2, dc)) * sstep(34, 26, dc)); }
    else if (z > 138) wG = Math.max(wG, sstep(140, 156, z) * (1 - sstep(266, 274, z)) * sstep(46, 34, Math.abs(x - 2)));
    // needle clusters (world.js spire()) search for the flattest ground around these spots; their layout depends on the terrain they probe,
    // so the old ground is kept bit-for-bit inside the probed discs
    for (let q = 0; q < SPIRE_DISCS.length; q++) { const sd = SPIRE_DISCS[q]; wG *= sstep(sd[2], sd[2] + 5, Math.hypot(x - sd[0], z - sd[1])); }
    wG *= 0.8 + 0.2 * gf;                         // the two landmark pads keep calmer (not dead flat) ground
    if (wG > 0.01) {
      const calm = padCalm(x, z);
      const lx = lx0, dl = dl0;
      const kF = z > 150 ? 0.6 : z < 45 ? 1.0 : 1;                       // field / canyon carry less of the street's dressing
      const kLane = 0.38 + 0.62 * sstep(1.8, 6.5, dl);
      const wl = wG * kF * kLane * calm;
      h += lumps(x, z) * wl;
      if (z < 45) h += lumpsCanyon(x, z) * wl * 0.85;
      h += rubble(x, z) * wG * (z > 150 ? 0.45 : z < 45 ? 0.75 : 0.9) * (z > 150 && z < 200 ? sstep(9, 14, Math.abs(z - 172)) : 1) * calm;
      if (z < 262) h += swell(x, z) * wG * (flat > 0.5 ? 0.85 : z < 45 ? 0.55 : 0) * calm;
      // the descent from the city plateau into the canyon: ridges break the long plain ramp (the lane's centre stays gentler)
      if (z < 56) h += ridges(x, z) * (z > -14 ? 1.15 * sstep(56, 40, z) : 0.85) * (0.3 + 0.7 * sstep(1.0, 5.0, dl)) * wG * calm;
      if (flat > 0.01 && z > 45) h += flankLift(x, z, dl, lx) * 1.3 * flat * gf * sstep(268, 250, z) * (z > 150 ? 0.7 : 1) * calm;
      h += trailH(x, z) * calm * Math.min(1, wG * 2.5);
    }
  }
  // the hump where the city street meets the canyon ramp (z 24..42) hid the whole canyon from the street's end: ease it toward a low shoulder
  {
    const hz = sstep(46, 38, z) * sstep(8, 20, z), hx = sstep(26, 12, Math.abs(x - routeLineX(z)));
    const k = hz * hx;
    if (k > 0) h = lerp(h, Math.min(h, 1.5 + 0.35 * N.n2(x * 0.08 + 3, z * 0.08)), 0.85 * k);
  }
  const cm = sstep(32, -2, z);
  const lock = padLock(x, z);
  const fl = canyonFloor(z);
  h += fl;
  // smooth ground height (slow swells + canyon floor): the lip heights handed to the shader are built from it, so hummocks / lumps / drifts at a vertex never
  // jitter the snow-cap line (a lip line that jitters at cell scale draws vertical streaks down the face)
  const hSm = hMac + fl;
  if (cm > 0) {
    const warp = N.n2(x * 0.03, z * 0.03) * 3.2 + N.n2(x * 0.06, z * 0.06) * 1.0;
    const side = x < cx ? 0 : 1;
    const bulge = 5 * sstep(0.1, 0.7, N.n2(z * 0.032 + 5, 0.5 + (side ? 2.3 : -2.3))) + 2.5 * N.n2(z * 0.09, side ? 7.1 : -7.1);
    const dx = Math.abs(x - cx) + warp - bulge;
    const s = dx - canyonHalfWidth(z);
    if (s > -16 && z > -196) h += cm * talus(s, z, side) * gateFlat(x, z);
    if (s > -8) {
      const sp = spec('c' + side, 40 + side, 6, 66, PLATEAU_H - 8);
      let fc = cliff(s, z, x, z, sp, 0);
      const kc = cm * (PLATEAU_H - 8) * (0.96 + 0.04 * N.n2(x * 0.05, z * 0.05));
      const lk = lock > 0 ? lock : 0;
      const wAux = cm * (PLATEAU_H - 8) * fc, lipC = hSm + kc * CL, cfC = kc * CF;
      if (lk > 0) fc += (oldCliff(s, z, x, z, sp.leg, 0) - fc) * lk;
      h += kc * fc;
      if (aux) noteAux(aux, sp, fc, wAux, lipC - h, cfC);
      // scree apron at the wall foot (cones under the old gullies): about half strength in the open (the tier profile adds its own foot bank), full strength under props
      h += cm * (0.55 + 0.45 * lk) * (1.2 + 1.8 * (0.5 + 0.5 * N.n2(z * 0.045 + side * 9, 3.3))) * sstep(-6, 4, s) * (1 - sstep(4, 16, s));
    }
  }

  // blocky mesas on the entrance / city flanks
  for (let i = 0; i < mesas.length; i++) {
    const m = mesas[i];
    const dxm = x - m[0], dzm = z - m[1];
    const len = m[8];
    const rr = Math.max(m[2], m[3]) + len + 14;
    if (dxm > rr || dxm < -rr || dzm > rr || dzm < -rr) continue;
    const c = Math.cos(m[4]), sn = Math.sin(m[4]);
    const wxm = dxm + N.n2(x * 0.03, z * 0.03) * 6, wzm = dzm + N.n2(x * 0.04 + 9, z * 0.04) * 6;
    const u = (wxm * c + wzm * sn) / m[2], v = (-wxm * sn + wzm * c) / m[3];
    const rs = Math.max(m[2], m[3]);
    // superellipse metric (p=3.4): boxy plan with softly chamfered corners
    const d = Math.pow(Math.pow(Math.abs(u), 3.4) + Math.pow(Math.abs(v), 3.4), 1 / 3.4) * rs;
    const sM = rs + len - d;
    if (sM > -8) {
      const sp = spec('m' + i, m[7], m[6], len, m[5]);
      const ang = Math.atan2(v, u);
      const circ = TAU * rs * 1.1;
      let fm = cliff(sM, (ang / TAU + 0.5) * circ, x, z, sp, circ);
      // the wind dunes underneath are damped across the mass, so a mesa reads as a calm, flat-topped block with a rolling snow cap, not as a lumpy hill
      const damp = 0.7 * sm01((fm - 0.1) / 0.5);
      const wAux = m[5] * fm, lipM = hSm * (1 - 0.7 * sm01((CL - 0.1) / 0.5)) + m[5] * CL, cfM = m[5] * CF;
      if (lock > 0) fm += (oldCliff(sM, (ang / TAU + 0.5) * circ, x, z, sp.leg, circ) - fm) * lock;
      h = h * (1 - damp * (1 - lock)) + m[5] * fm;
      if (aux) noteAux(aux, sp, fm, wAux, lipM - h, cfM);
    }
  }

  // outer frame
  const pw = N.n2(x * 0.03, z * 0.03) * 9.6 + 14 * N.n2(x * 0.011 + 2, z * 0.011);
  const bx = Math.abs(x) - HALF_X + pw;          // signed distances: negative inside the playable bowl
  const bzs = z - Z_START + 6 + pw;
  const bzn = Z_END - z + pw;
  const b = Math.max(bx, bzs, bzn);
  if (b > -8) {
    const sp = spec('f', 77, 6, 74, 60);
    const along = bx >= Math.max(bzs, bzn) ? z * 1 + (x < 0 ? 0 : 500) : x + (bzs > bzn ? 1000 : 1500);
    let ff = cliff(b, along, x, z, sp, 0);
    // the wall top rolls (long swells + notches) rather than being a straight plateau line
    const top = PLATEAU_H + rimShape(x, z), wAux = 60 * clamp(ff), lipF = hSm + (top - hSm) * clamp(CL), cfF = (top - hSm) * clamp(CF);
    if (lock > 0) ff += (oldCliff(b, along, x, z, sp.leg, 0) - ff) * lock;
    h = lerp(h, top, clamp(ff));
    if (aux) noteAux(aux, sp, ff, wAux, lipF - h, cfF);
    if (b > 60) h += rimButtes(x, z, aux) * clamp((ff - 0.9) * 10);
  }

  // far field relief fades in beyond the frame so the playable bowl is untouched
  if (b > 100) {
    const wf = sstep(100, 240, b) * (1 - sstep(1350, 1620, Math.hypot(x, z - 40)));
    if (wf > 0) h += wf * farRelief(x, z, aux, wf);
  }

  h += footprintField(x, z).drift;
  if (aux) { aux.d = aux.sw > 0 ? aux.sd / aux.sw : 0; aux.fh = aux.sw > 0 ? aux.sf / aux.sw : 0; }
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
const cSnowA = new THREE.Color(0xfffcf9), cSnowB = new THREE.Color(0xd3e1fb);

export function snowColorAt(x, z, ny, out) {
  const t = 0.5 + 0.5 * N.n2(x * 0.014 + 7, z * 0.019);
  const t2 = 0.5 + 0.5 * N.n2(x * 0.05, z * 0.05);
  return out.copy(cSnowA).lerp(cSnowB, clamp(t * 0.3 + t2 * 0.08 + sstep(0.97, 0.84, ny) * 0.3));
}
export const rockMask = (ny) => sstep(0.69, 0.44, ny);          // the same curve as the terrain shader's slopeN (1 / sqrt(1 + g^2) in, 0 = snow .. 1 = rock out)

// ── chunked, LOD'd mesh ─────────────────────────────────────────────────────
const CHUNK = 64;
const LOD_SEGS = [84, 56, 40, 28];             // chunks that are only snow (shading uses the smooth gradient texture, so a coarse mesh is enough)
const LOD_SEGS_CLIFF = [132, 108, 80, 56];      // chunks that contain walls: finer, so ledges / lips stay crisp
const LOD_DIST = [90, 190, 340];

const BLUR = [1, 1, 1, 1];
const cliffyCache = new Map();
/** does this chunk contain steep ground (walls, mesa flanks)? coarse 9x9 probe, cached */
function isCliffy(cx, cz) {
  const key = cx + ',' + cz;
  let v = cliffyCache.get(key);
  if (v === undefined) {
    v = false;
    const x0 = cx * CHUNK, z0 = cz * CHUNK, st = CHUNK / 8;
    for (let j = 0; j <= 8 && !v; j++)
      for (let i = 0; i <= 8; i++) {
        const x = x0 + i * st, z = z0 + j * st;
        if (Math.abs(heightAt(x + 1.5, z) - heightAt(x - 1.5, z)) > 2.4 || Math.abs(heightAt(x, z + 1.5) - heightAt(x, z - 1.5)) > 2.4) { v = true; break; }
      }
    cliffyCache.set(key, v);
  }
  return v;
}
function buildChunk(cx, cz, lod) { return buildGrid(cx * CHUNK, cz * CHUNK, CHUNK, (isCliffy(cx, cz) ? LOD_SEGS_CLIFF : LOD_SEGS)[lod], BLUR[lod], 3.5, true); }
function buildGrid(x0, z0, size, segs, R, skirt, withTex = false) {
  const step = size / segs;
  // the rock mask is smoothed over a couple of metres (two box passes of ~1 m: a triangular kernel, half width ~2 m, about the same in metres at every
  // fine LOD): mid-steep ground whose metre-scale slope hovers around the rock / snow threshold then gets a calm, flowing contour instead of marble-like
  // veins (a wider kernel would bias contours toward neighbouring faces and leave little rock islands in snow benches)
  const Rm = step < 0.95 ? clamp(Math.round(1.1 / step), 1, 3) : 0;           // coarse grids (far LODs, far tiles): their gradient is already smooth at a few metres, so no extra blur
  const n = segs + 1, P = Math.max(5, 3 + 2 * Rm), pn = n + 2 * P;
  const H = new Float32Array(pn * pn), LCs = new Float32Array(pn * pn), DEP = new Float32Array(pn * pn), FHs = new Float32Array(pn * pn);
  const aux = { w: 0, sp: null, f: 0, H: 0, d: 0, sw: 0, sd: 0, sf: 0, fh: 0 };
  for (let j = 0; j < pn; j++)
    for (let i = 0; i < pn; i++) {
      const k = j * pn + i;
      H[k] = heightAt(x0 + (i - P) * step, z0 + (j - P) * step, aux);
      LCs[k] = aux.sp ? H[k] + aux.d : -999;      // world height of the lip of the face this vertex belongs to (smooth along the wall)
      DEP[k] = aux.sp ? H[k] + aux.d : H[k] - 80;      // lip height again, for the node texture (C2-smooth per pixel; the shader subtracts the exact per-pixel y, so near-vertical faces get a clean horizontal cap line, no vertical streaks)
      FHs[k] = aux.sp ? aux.fh : 0;                // height (m) of the rock face this vertex belongs to: the snow cap on its lip scales with it   // the same as metres below the lip: goes into the node texture (C2-smooth per pixel, no per-triangle teeth)
    }
  // per-point gradient on the padded grid (indices 2..pn-3), blending 1- and 2-cell central differences
  const GX = new Float32Array(pn * pn), GZ = new Float32Array(pn * pn), RM = new Float32Array(pn * pn);
  for (let j = 2; j < pn - 2; j++)
    for (let i = 2; i < pn - 2; i++) {
      const c0 = j * pn + i;
      GX[c0] = ((H[c0 + 1] - H[c0 - 1]) / (2 * step) + (H[c0 + 2] - H[c0 - 2]) / (4 * step)) * 0.5;
      GZ[c0] = ((H[c0 + pn] - H[c0 - pn]) / (2 * step) + (H[c0 + 2 * pn] - H[c0 - 2 * pn]) / (4 * step)) * 0.5;
      RM[c0] = rockMask(1 / Math.hypot(GX[c0], 1, GZ[c0]));
    }
  // wide, separable box blurs of the rock mask: the shader thresholds this smooth field wherever the per-pixel slope is ambiguous, so the snow / rock
  // contour is a clean flowing line (never per-triangle saw teeth, never marble veins) wherever the wall normals are busy
  const RT = new Float32Array(pn * pn), RA = new Float32Array(pn * pn), RB = new Float32Array(pn * pn);
  const boxBlur = (src, dst, lo, r) => {       // blurs the interior [lo, pn - 1 - lo]; the result is valid on [lo + r, pn - 1 - lo - r]
    const hi = pn - 1 - lo, k = 2 * r + 1;
    for (let j = lo; j <= hi; j++)
      for (let i = lo + r; i <= hi - r; i++) { let a = 0; for (let d = -r; d <= r; d++) a += src[j * pn + i + d]; RT[j * pn + i] = a / k; }
    for (let j = lo + r; j <= hi - r; j++)
      for (let i = lo + r; i <= hi - r; i++) { let a = 0; for (let d = -r; d <= r; d++) a += RT[(j + d) * pn + i]; dst[j * pn + i] = a / k; }
  };
  boxBlur(RM, RA, 2, Rm);
  boxBlur(RA, RB, 2 + Rm, Rm);
  const curvK = clamp(Math.round(2.4 / step), 1, 5), curvS = clamp(Math.round(1.3 / step), 1, 5), curvM = clamp(Math.round(3.6 / step), 1, 5);

  const verts = n * n + 4 * n;
  const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), col = new Float32Array(verts * 3), tr = new Float32Array(verts * 4), fh = new Float32Array(verts);
  const c = new THREE.Color();
  const hasFoot = FOOTPRINTS.length > 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const c0 = (j + P) * pn + i + P;
      const h = H[c0];
      const x = x0 + i * step, z = z0 + j * step;
      // box blur of the gradient field → smooth, alias-free terrace contours and lighting
      let hx = 0, hz = 0, cnt = 0;
      for (let dj = -R; dj <= R; dj++)
        for (let di = -R; di <= R; di++) {
          const q = c0 + dj * pn + di;
          hx += GX[q]; hz += GZ[q]; cnt++;
        }
      hx /= cnt; hz /= cnt;
      const l = Math.hypot(hx, 1, hz);
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      nor[k * 3] = -hx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = -hz / l;
      snowColorAt(x, z, 1 / l, c);
      let ao = 0;
      if (hasFoot) ao = footprintField(x, z).ao;
      c.multiply(tmp.setRGB(1 - 0.24 * ao, 1 - 0.19 * ao, 1 - 0.07 * ao));
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      // curvature (concave hollows / convex lips) at ~2.4m scale drives painted tint + cavity shading
      const kk = curvK;
      const lap = (H[c0 + kk] + H[c0 - kk] + H[c0 + kk * pn] + H[c0 - kk * pn] - 4 * h) / (kk * step * kk * step);
      tr[k * 4] = RB[c0]; tr[k * 4 + 1] = 1 - 0.3 * ao; tr[k * 4 + 2] = clamp(lap * 0.3, -1, 1); tr[k * 4 + 3] = LCs[c0]; fh[k] = FHs[c0];

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
    tr[sv * 4] = tr[e * 4]; tr[sv * 4 + 1] = tr[e * 4 + 1]; tr[sv * 4 + 2] = tr[e * 4 + 2]; tr[sv * 4 + 3] = tr[e * 4 + 3]; fh[sv] = fh[e];
    sv++;
  }
  const idx = [];
  for (let j = 0; j < segs; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
      // split every cell along the diagonal with the smaller height difference: contour lines on steep faces then follow the mesh instead of zig-zagging across it
      const ha = H[(j + P) * pn + i + P], hb = H[(j + P) * pn + i + 1 + P], hd = H[(j + 1 + P) * pn + i + P], he = H[(j + 1 + P) * pn + i + 1 + P];
      if (Math.abs(ha - he) < Math.abs(hb - hd)) idx.push(a, d, e, a, e, b);
      else idx.push(a, d, b, b, d, e);
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
  if (withTex) {
    // height-gradient texture (RG half float) on the node grid: the shader samples it with cubic B-spline filtering, so snow
    // normals are C2-smooth per pixel and cel terminators draw flowing curves instead of triangle-edge polylines
    // B / A carry small- and medium-scale curvature (lumps, berms, swells -> pale crests, blue hollows), filtered with the same cubic kernel
    const td = new Uint16Array(n * n * 4);
    const lapK = (c0, kk, h) => (H[c0 + kk] + H[c0 - kk] + H[c0 + kk * pn] + H[c0 - kk * pn] - 4 * h) / (kk * step * kk * step);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const c0 = (j + P) * pn + i + P, o = (j * n + i) * 4, h = H[c0];
        td[o] = THREE.DataUtils.toHalfFloat(GX[c0]); td[o + 1] = THREE.DataUtils.toHalfFloat(GZ[c0]);
        td[o + 2] = THREE.DataUtils.toHalfFloat(DEP[c0]);
        td[o + 3] = THREE.DataUtils.toHalfFloat(clamp(clamp(lapK(c0, curvS, h) * 2.0, -1, 1) * 0.5 + clamp(lapK(c0, curvK, h) * 0.3 + lapK(c0, curvM, h) * 2.8, -1.5, 1.5), -2.5, 2.5));
      }
    const tex = new THREE.DataTexture(td, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    g.userData.ntex = tex;
    g.userData.chunk = [x0, z0, size, n];
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tr', new THREE.BufferAttribute(tr, 4));
  g.setAttribute('fh', new THREE.BufferAttribute(fh, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** far tiles: tiles that hold mesa / butte walls get a finer grid so distant cliffs keep smooth shoulders instead of one-cell stairs */
function farSegs(fx, fz, FS) {
  let m = 0;
  const n = 8, st = FS / n;
  const row = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const h = heightAt(fx + i * st, fz + j * st);
      row[j * (n + 1) + i] = h;
      if (i > 0) m = Math.max(m, Math.abs(h - row[j * (n + 1) + i - 1]));
      if (j > 0) m = Math.max(m, Math.abs(h - row[(j - 1) * (n + 1) + i]));
    }
  }
  return m > 24 ? 72 : m > 10 ? 40 : 24;
}

export class Terrain {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.chunks = new Map();
    this.cache = new Map();
    this.queue = [];
    const x0 = -6, x1 = 6, z0 = -6, z1 = 6;      // main LOD'd grid: [-384, 384]^2
    for (let cz = z0; cz < z1; cz++)
      for (let cx = x0; cx < x1; cx++) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), makeTerrainMaterial());
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        mesh.frustumCulled = true;
        mesh.visible = false;
        mesh.onBeforeRender = bindNormalTexture;
        this.group.add(mesh);
        this.chunks.set(cx + ',' + cz, { cx, cz, mesh, lod: -1, want: -1, center: new THREE.Vector3((cx + 0.5) * CHUNK, 0, (cz + 0.5) * CHUNK) });
      }
    // far field tiles (static, coarse): [-1664, 1664]^2 minus the main grid
    this.far = [];
    const FS = 256, f0 = -6 * CHUNK - FS * 5, nf = 13;
    for (let j = 0; j < nf; j++)
      for (let i = 0; i < nf; i++) {
        const fx = f0 + i * FS, fz = f0 + j * FS;
        if (fx >= -384 - 1 && fx + FS <= 384 + 1 && fz >= -384 - 1 && fz + FS <= 384 + 1) continue;
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), makeTerrainMaterial());      // own material: each far tile binds its own gradient texture
        mesh.visible = false;
        mesh.receiveShadow = false;
        mesh.onBeforeRender = bindNormalTexture;
        this.group.add(mesh);
        this.far.push({ fx, fz, FS, mesh });
      }
    // beyond the far tiles: flat pale aprons (4 slabs around the far field; always at/below the plateau) so the world never ends in the void
    const apronMat = new THREE.MeshToonMaterial({ color: 0xdfe9ff, gradientMap: terrainMaterial.gradientMap });
    const FH = FAR_HALF - 10, BIG = 9000;
    for (const [cx, cz, w, d] of [[0, -(FH + BIG / 2), 2 * BIG, BIG], [0, FH + BIG / 2, 2 * BIG, BIG], [-(FH + BIG / 2), 0, BIG, 2 * FH], [FH + BIG / 2, 0, BIG, 2 * FH]]) {
      const apron = new THREE.Mesh(new THREE.PlaneGeometry(w, d), apronMat);
      apron.rotation.x = -Math.PI / 2;
      apron.position.set(cx, PLATEAU_H - 4.5, cz);
      apron.receiveShadow = false;
      this.group.add(apron);
    }
  }
  buildFar() {
    for (const f of this.far) {
      if (f.built) continue;
      f.mesh.geometry = buildGrid(f.fx, f.fz, f.FS, farSegs(f.fx, f.fz, f.FS), 1, 14, true);
      f.mesh.visible = true;
      f.built = true;
    }
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
    this.primeNear(p);
    this.primeRest(p);
  }
  /** build the chunks that matter at first sight (LOD0/1) synchronously */
  primeNear(p) {
    for (const ch of this.chunks.values()) {
      const d = Math.hypot(ch.center.x - p.x, ch.center.z - p.z) - CHUNK * 0.7;
      const lod = this.lodFor(Math.max(d, 0));
      ch.want = lod;
      if (lod <= 1) { ch.lod = lod; ch.mesh.geometry = this.geo(ch, lod); ch.mesh.visible = true; }
    }
  }
  /** everything else (far LODs + far field tiles); sync variant */
  primeRest(p) {
    for (const ch of this.chunks.values()) if (ch.lod !== ch.want) { ch.lod = ch.want; ch.mesh.geometry = this.geo(ch, ch.want); ch.mesh.visible = true; }
    this.buildFar();
  }
  /** same, but sliced so the loading screen stays alive */
  async primeRestAsync(onProgress = () => {}) {
    const todo = [...this.chunks.values()].filter((ch) => ch.lod !== ch.want);
    const far = this.far.filter((f) => !f.built);
    const total = todo.length + far.length;
    let n = 0, slice = performance.now();
    const tick = async () => {
      n++;
      if (performance.now() - slice > 30) { onProgress(n / total); await new Promise((r) => setTimeout(r, 0)); slice = performance.now(); }
    };
    for (const ch of todo) { ch.lod = ch.want; ch.mesh.geometry = this.geo(ch, ch.want); ch.mesh.visible = true; await tick(); }
    for (const f of far) { f.mesh.geometry = buildGrid(f.fx, f.fz, f.FS, farSegs(f.fx, f.fz, f.FS), 1, 14, true); f.mesh.visible = true; f.built = true; await tick(); }
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
