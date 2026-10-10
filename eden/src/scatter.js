// Rock scatter: composed clusters of hand-sculpted Blender rocks (focal rock + leaning satellites + gravel fans), conforming snow caps,
// ground-hugging snow banks. One merged LOD object per cluster (indexed geometry, smooth baked normals, baked AO) so hundreds of rocks
// stay cheap. Procedural fallback if rocks.glb is missing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RAMP_ROCK, NOISE_GLSL, GRADE_GLSL } from './materials.js';
import { sculptRock, snowPillow, snowTint } from './kit.js';
import { rng, lerp, sstep, clamp, makeNoise } from './noise.js';
import { heightAt, slopeAt, canyonX, canyonHalfWidthAt, snowColorAt, HALF_X } from './terrain.js';

const SN = makeNoise(4242);
const TAU = Math.PI * 2;

// One material for everything a cluster draws (rock bodies, snow caps, snow banks, pebbles) so a cluster costs a single draw call per pass.
// Per-vertex mask aMask: 2 = rock body (painted: soft drift, strata bands, soft 5-tone cel ramp), 3 = pebble (same, no shadow); <= 1 = snow cap / bank
// (mask thresholded per pixel with alpha-to-coverage -> smooth contour, 3-tone terrain-like snow ramp). aBank = 1 on the snow banks that melt into the terrain
// (they keep the terrain's own shading so they never show a seam). Colours live in the vertex colours.
// chiselled rock planes: nearest-feature cells (2x2x2 search, jittered points) give polygonal facets with straight-ish borders; the facet id drives a planar normal tilt
// (distinct light / mid / shade planes) and a small value / hue shift, with a narrow soft blend across borders
const FACET_GLSL = /* glsl */ `
vec3 h33(vec3 p){ p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6))); return fract(sin(p) * 43758.5453); }
vec3 facetAttr(vec3 p) {
  vec3 ip = floor(p), f = fract(p);
  vec3 base = ip + step(0.5, f) - 1.0;
  float d1 = 9.0, d2 = 9.0; vec3 i1 = vec3(0.0), i2 = vec3(0.0);
  for (int k = 0; k < 2; k++) for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec3 c = base + vec3(float(i), float(j), float(k));
    vec3 r = c + 0.15 + 0.7 * h33(c) - p;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = c; } else if (d < d2) { d2 = d; i2 = c; }
  }
  float wB = 0.5 * (1.0 - smoothstep(0.0, 0.12, sqrt(d2) - sqrt(d1)));
  return mix(h33(i1 + 7.0), h33(i2 + 7.0), wB) - 0.5;
}
`;
const rockMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP_ROCK, vertexColors: true, alphaToCoverage: true });
rockMat.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aMask;\nattribute float aBank;\nvarying float vMask;\nvarying float vBank;\nvarying vec3 vWN;\nvarying vec3 vWP;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n vMask = aMask;\n vBank = aBank;\n vWN = normalize(mat3(modelMatrix) * objectNormal);\n vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vMask;\nvarying float vBank;\nvarying vec3 vWN;\nvarying vec3 vWP;\nfloat gSnow = 0.0;\nfloat gSnowA = 0.0;\nfloat gGradeK = 1.0;\nvec3 gShade = vec3(0.0);\nvec3 gShadeAbs = vec3(0.0);\nvec3 gWarm = vec3(1.0);\nvec3 gFacet = vec3(0.0);\n' + FACET_GLSL + NOISE_GLSL)
    .replace('#include <gradientmap_pars_fragment>', `uniform sampler2D gradientMap;
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
  float dotNL = dot( normal, lightDirection );
  float rockR = texture2D( gradientMap, vec2( dotNL * 0.5 + 0.5, 0.0 ) ).r;
  float snowR = 0.5 * smoothstep( -0.80, -0.70, dotNL ) + 0.5 * smoothstep( 0.38, 0.52, dotNL );      // the terrain's 3-tone snow ramp (soft terminators)
  return vec3( mix( rockR, snowR, gSnow ) );
}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
  gSnow = step(vMask, 1.5);
  diffuseColor.a = gSnow > 0.5 ? smoothstep(0.44, 0.56, vMask) : 1.0;
  if (diffuseColor.a < 0.01) discard;
  gSnowA = gSnow;
  gGradeK = 1.0 - vBank;
  if (gSnow < 0.5) {
    // hand-painted rock: slow colour drift (slate / violet, or muted orange / coral / red), soft per-layer strata steps, no streaky noise
    vec3 baseC = diffuseColor.rgb;
    float redK = smoothstep(0.02, 0.22, baseC.r - baseC.b);
    float dA = vn(vWP.xz * 0.043 + vWP.y * 0.021 + 3.7), dB = vn(vWP.xz * 0.17 + vWP.y * 0.12 + 9.1);
    float dr = smoothstep(0.2, 0.8, dA * 0.72 + dB * 0.28);
    baseC *= mix(mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.99), dr), mix(vec3(1.03, 1.10, 0.92), vec3(0.95, 0.88, 1.04), dr), redK);
    float hg = smoothstep(-2.0, 46.0, vWP.y);
    baseC *= mix(0.90, 1.08, hg);
    // wavy strata: soft per-layer value / hue steps (a coral-orange or deep-red layer now and then on red rocks, violet / cool layers on slate)
    float ly = vWP.y * 1.0 + fbm2(vWP.xz * 0.25) * 1.3 + (vn(vWP.xz * 0.8 + 4.0) - 0.5) * 0.9 + (vWP.x * 0.3 + vWP.z * 0.2) * 0.05;
    float lk = floor(ly), lfr = smoothstep(0.0, 0.18, fract(ly));
    float vert = 1.0 - smoothstep(0.3, 0.7, abs(vWN.y));
    float lh = mix(h21(vec2(lk - 1.0, 3.7)), h21(vec2(lk, 3.7)), lfr);
    float lt = mix(h21(vec2(lk - 1.0, 8.3)), h21(vec2(lk, 8.3)), lfr);
    float lc = mix(h21(vec2(lk - 1.0, 5.1)), h21(vec2(lk, 5.1)), lfr);
    float aaS = 1.0 - smoothstep(0.15, 0.6, fwidth(ly));        // layers fade to their mean once they are about a pixel thick
    baseC *= 1.0 + (0.12 * lh - 0.06) * aaS;
    float band = smoothstep(0.55, 0.70, lt) * aaS;
    baseC *= mix(vec3(1.0), mix(vec3(0.90, 0.80, 0.98), vec3(1.05, 1.13, 0.92), lc), band * 0.85 * redK);
    baseC *= mix(vec3(1.0), mix(vec3(0.94, 0.98, 1.03), vec3(1.03, 0.99, 1.05), lc), band * 0.8 * (1.0 - redK));
    // chiselled planes: facet cells (warped by a slow noise so borders are never a grid) tilt the shading normal and shift each plane's value / hue
    {
      float camD = distance(vWP, cameraPosition);
      vec2 w1 = vec2(vn(vWP.xz * 0.55 + vWP.y * 0.35 + 3.0), vn(vWP.zx * 0.55 + vWP.y * 0.35 + 17.0)) - 0.5;
      float wy = vn(vec2(vWP.x + vWP.z, vWP.y) * 0.7 + 5.0) - 0.5;
      vec3 pf = (vWP + vec3(w1.x, wy, w1.y) * 1.1) / vec3(1.9, 1.5, 1.9);
      vec3 fa = facetAttr(pf);
      float fade = 1.0 - smoothstep(60.0, 200.0, camD);
      gFacet = vec3(fa.x * 1.5, fa.y * 0.8, fa.z * 1.5) * fade;
      baseC *= 1.0 + (fa.x * 0.26 + w1.x * 0.14) * fade;
      baseC *= mix(vec3(1.0 + fa.z * 0.10, 1.0, 1.0 - fa.z * 0.10), vec3(1.0, 1.0 + fa.z * 0.34, 1.0 - fa.z * 0.18), redK);
    }
    baseC *= 1.0 - (1.0 - smoothstep(0.0, 0.10 + fwidth(ly) * 1.5, fract(ly))) * 0.05 * vert;
    diffuseColor.rgb = baseC;
    gShade = mix(vec3(0.130, 0.100, 0.075), vec3(0.155, 0.062, 0.100), redK);
    gShadeAbs = mix(vec3(0.020, 0.018, 0.026), vec3(0.050, 0.018, 0.034), redK);
    gWarm = vec3(1.03, 1.0, 0.96);
  } else {
    // snow cap: warm white <-> cool white drift (banks keep the terrain's own colour)
    float k = smoothstep(0.25, 0.75, vn(vWP.xz * 0.06 + 5.0) * 0.75 + vn(vWP.xz * 0.23 + 17.0) * 0.25);
    vec3 snowV = mix(vec3(1.0, 0.995, 0.985), vec3(0.935, 0.962, 1.0), k);
    snowV *= mix(vec3(0.90, 0.935, 1.02), vec3(1.0), smoothstep(0.52, 0.86, vMask));      // rounded shoulder: the lip is a shade cooler / deeper than the crown
    diffuseColor.rgb *= mix(vec3(1.0), snowV, 1.0 - vBank);
  }`)
    .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = normalize(normal + (viewMatrix * vec4(gFacet, 0.0)).xyz);')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * mix(vec3(0.11, 0.075, 0.105), vec3(0.03, 0.05, 0.118), gSnow) * (0.5 + 0.5 * smoothstep(1.5, -0.5, vWN.y));   // sky/snow bounce keeps shade from going flat`)
    .replace('#include <opaque_fragment>', `{
    float nv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
    float rim = pow(1.0 - nv, 4.0);
    outgoingLight += vec3(0.30, 0.42, 0.78) * rim * 0.08 * (1.0 - gSnow * 0.6) * (0.4 + 0.6 * step(0.3, vWN.y + 0.4));
  }
` + GRADE_GLSL + `
#include <opaque_fragment>`);
};
rockMat.polygonOffset = true; rockMat.polygonOffsetFactor = -1; rockMat.polygonOffsetUnits = -1;
rockMat.customProgramCacheKey = () => 'scatter-rock6';
// shadow caster: only rock bodies (snow caps / banks / pebbles are skipped so thin snow never shadows the ground it hugs)
const rockDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
rockDepth.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aMask;\nvarying float vM;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n vM = aMask;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vM;')
    .replace('void main() {', 'void main() {\n  if (vM < 1.5 || vM > 2.5) discard;');
};
rockDepth.customProgramCacheKey = () => 'scatter-rockdepth1';
const RED_C = new THREE.Color(0xe07468), BLUE_C = new THREE.Color(0x8f94b8);       // = the palette's rock colours (the slate is lifted a little so AO / cel bands never turn it navy)
// per-instance colour families (multiply the material colour: value and hue shifts, never brighter than the base)
const RED_TINTS = [[1, 1, 1], [1, 0.90, 0.80], [0.93, 0.82, 0.85], [0.98, 0.95, 0.90], [0.88, 0.78, 0.76]].map((a) => new THREE.Color(...a));
const BLUE_TINTS = [[1, 1, 1], [0.93, 0.96, 1], [0.96, 0.92, 0.97], [0.88, 0.92, 0.98]].map((a) => new THREE.Color(...a));

// ── library ─────────────────────────────────────────────────────────────────────────────────────
// entry: { id, kind, hero, lod: [g0,g1,g2], snow: [c0,c1], base (depth below the waterline), top, half (horizontal half-extent) }
const LIB = { hero: {}, small: {}, all: [], peb: [], ok: false };
const KINDS = ['boulder', 'chunk', 'shard', 'slab', 'stack', 'strata'];
const SQUASH = { boulder: [0.8, 1.15], chunk: [0.85, 1.25], shard: [0.85, 1.35], slab: [0.8, 1.2], stack: [0.85, 1.2], strata: [1.5, 2.5] };
const LEAN = { boulder: 0.10, chunk: 0.14, shard: 0.12, slab: 0.10, stack: 0.12, strata: 0.03 };
const HERO_MIN = 1.05;      // focal rocks from this half-length (m) upward use the dense hero meshes

function finishEntry(en) {
  const g = en.lod[0];
  g.computeBoundingBox();
  const b = g.boundingBox;
  en.base = -b.min.y; en.top = b.max.y;
  en.half = Math.max(b.max.x, -b.min.x, b.max.z, -b.min.z);
  (en.hero ? LIB.hero : LIB.small)[en.kind] = ((en.hero ? LIB.hero : LIB.small)[en.kind] ?? []).concat([en]);
  LIB.all.push(en);
}

export async function loadScatter() {
  const prm = new URLSearchParams(location.search);
  if (prm.has('norocks')) return;       // debug: force the procedural fallback
  try {
    const gltf = await new GLTFLoader().loadAsync(prm.get('rocksglb') || new URL('../assets/rocks.glb', import.meta.url).href);
    const ents = new Map();
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      let m = /^rk(\d+)_([a-z]+)_([HS])_(lod|snow)(\d)$/.exec(o.name);
      if (m) {
        const id = +m[1];
        let en = ents.get(id);
        if (!en) ents.set(id, (en = { id, kind: m[2], hero: m[3] === 'H', lod: [], snow: [] }));
        (m[4] === 'lod' ? en.lod : en.snow)[+m[5]] = o.geometry;
        return;
      }
      m = /^pb(\d+)$/.exec(o.name);
      if (m) LIB.peb[+m[1]] = o.geometry;
    });
    [...ents.values()].sort((a, b) => a.id - b.id).forEach((en) => { if (en.lod[0] && en.lod[1] && en.lod[2]) finishEntry(en); });
    LIB.peb = LIB.peb.filter(Boolean);
    LIB.ok = LIB.all.length >= 10 && LIB.peb.length >= 4;
  } catch (e) { console.warn('scatter rock assets unavailable, procedural fallback', e); }
}

// ── procedural fallback (no GLB) ─────────────────────────────────────────────────────────────
function fallbackLib() {
  if (LIB.all.length) return;
  const mk = (kind, hero, i) => {
    const ry = kind === 'slab' ? 0.55 : kind === 'shard' ? 1.1 : 0.85;
    const lod = [44, 28, 18].map((seg) => sculptRock(i * 13 + 5, { rx: kind === 'shard' ? 0.7 : 1, ry, rz: 0.9, seg, topFlat: kind === 'slab' ? 0.45 : 0.7, k: kind === 'boulder' ? 4 : 7.5 }));
    finishEntry({ id: i, kind, hero, lod, snow: [] });
  };
  let i = 0;
  for (const kind of ['boulder', 'chunk', 'shard', 'slab', 'stack']) for (const hero of [true, false]) for (let k = 0; k < 2; k++) mk(kind, hero, i++);
  LIB.peb = [sculptRock(1, { seg: 7, ry: 0.7 }), sculptRock(2, { seg: 7, ry: 0.6 }), sculptRock(3, { seg: 7, ry: 0.8 }), sculptRock(4, { seg: 7, ry: 0.65 })];
}

// ── merged, indexed geometry ─────────────────────────────────────────────────────────────────
const _v = new THREE.Vector3(), _nv = new THREE.Vector3(), _c = new THREE.Color();
class Merge {
  constructor() { this.P = []; this.N = []; this.C = []; this.I = []; this.K = []; this.B = []; this.base = 0; }
  /** rock body (rockC given: colour x tint x baked shade, mask 2) or snow cap / bank (no rockC: white-ish tint, mask from the geometry) */
  add(src, mat, tint, yLocal = 0, noAO = false, hRef = 9, rockC = null) {
    const pos = src.attributes.position, nor = src.attributes.normal, baked = src.attributes.color, idx = src.index;
    const tmask = src.attributes.tmask, tcol = src.attributes.tcol;      // snow banks: smooth rim mask + terrain-matched colour
    const n = pos.count;
    const nm = new THREE.Matrix3().getNormalMatrix(mat);
    for (let i = 0; i < n; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      _nv.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      this.P.push(_v.x, _v.y, _v.z); this.N.push(_nv.x, _nv.y, _nv.z);
      let k = 1;
      if (!noAO) {
        k = lerp(0.84, 1, sstep(-0.10 * hRef, 0.80 * hRef, _v.y - yLocal));
        if (_nv.y < -0.35) k *= 0.80;
        if (baked) k *= 0.55 + 0.45 * baked.getX(i);
      }
      if (tcol) this.C.push(tcol.getX(i), tcol.getY(i), tcol.getZ(i));
      else if (rockC) this.C.push(Math.pow(k, 1.15) * rockC.r, k * rockC.g, Math.pow(k, 0.86) * rockC.b);
      else this.C.push(Math.pow(k, 1.15) * (tint ? tint.r : 1), k * (tint ? tint.g : 1), Math.pow(k, 0.86) * (tint ? tint.b : 1));
      this.K.push(rockC ? 2 : tmask ? tmask.getX(i) : baked ? baked.getX(i) : 1);
      this.B.push(tcol ? 1 : 0);
    }
    if (idx) for (let i = 0; i < idx.count; i++) this.I.push(idx.getX(i) + this.base);
    else for (let i = 0; i < n; i++) this.I.push(i + this.base);
    this.base += n;
  }
  /** pebble: colour mixed here (rock colour x baked shade, snow on up-facing tops), mask 1 */
  addPeb(src, mat, rockC, tint, snowC, hasSnow) {
    const pos = src.attributes.position, nor = src.attributes.normal, baked = src.attributes.color, idx = src.index;
    const n = pos.count;
    const nm = new THREE.Matrix3().getNormalMatrix(mat);
    for (let i = 0; i < n; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      _nv.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      this.P.push(_v.x, _v.y, _v.z); this.N.push(_nv.x, _nv.y, _nv.z);
      const sh = baked ? 0.45 + 0.55 * baked.getX(i) : 1;
      _c.copy(rockC).multiply(tint).multiplyScalar(sh);
      if (hasSnow) _c.lerp(snowC, sstep(0.70, 0.92, _nv.y));
      this.C.push(_c.r, _c.g, _c.b); this.K.push(3); this.B.push(0);       // mask class 3: rock-shaded (5-tone ramp) but never a shadow caster
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
    g.setAttribute('aBank', new THREE.Float32BufferAttribute(this.B, 1));
    g.setIndex(this.base > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// plump snow bank hugging a rock's foot, conforming to the ground (built in cluster-local space).
// The bank's rim fades out through a per-vertex mask that the cap shader thresholds per pixel (smooth contour, no polygon outline),
// and its normals / colours are blended into the terrain's own, so the bank melts into the snow field instead of reading as a pasted polygon.
function driftGeo(hAt, wx, wz, rx, rz, h, seed, ox, oy, oz, lee, rings = 7, segs = 28, rot = 0) {
  const R = 1.5;
  const P = [], I = [], W = [], M = [];
  const addV = (x, z, dy, m) => { const y = hAt(x, z) + dy; P.push(x - ox, y - oy, z - oz); W.push(x, z, y); M.push(m); };
  addV(wx, wz, h * 0.9, 1);
  for (let ri = 1; ri <= rings; ri++) {
    const t = ri / rings;
    for (let si = 0; si < segs; si++) {
      const a = (si / segs) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const wob = 1 + 0.18 * SN.n2(ca * 1.7 + seed, sa * 1.7);
      const lump = 1 + 0.5 * Math.max(0, ca * lee[0] + sa * lee[1]);           // longer, thicker tail on the lee side
      const ex = ca * rx * (0.55 + (R - 0.55) * t) * wob * lump, ez = sa * rz * (0.55 + (R - 0.55) * t) * wob * lump;
      const x = wx + ex * Math.cos(rot) - ez * Math.sin(rot), z = wz + ex * Math.sin(rot) + ez * Math.cos(rot);
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
    const gx = (hAt(x + e, z) - hAt(x - e, z)) / (2 * e), gz = (hAt(x, z + e) - hAt(x, z - e)) / (2 * e);
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
const _q = new THREE.Quaternion(), _ql = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _ax = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);
function placeMat(x, y, z, yaw, leanDx, leanDz, leanAmt, sx, sy, sz) {
  _q.setFromAxisAngle(_Y, yaw);
  if (leanAmt) { _ax.set(leanDz, 0, -leanDx).normalize(); _ql.setFromAxisAngle(_ax, leanAmt); _q.premultiply(_ql); }
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

function buildCluster(spec, items, pebs, ground) {
  const ox = spec.x, oz = spec.z, oy = ground(ox, oz);
  const colliders = [];
  const prepared = items.map((it) => {
    const e = it.e, r = it.size;
    const sx = r * it.ax, sz = r * it.az, sy = r * it.sq;
    // ground under the footprint: base on the lowest sample so the rock never floats, the high side gets buried
    const rr = 0.55 * Math.max(sx, sz) * e.half;
    let g = 1e9, gmax = -1e9;
    for (let k = -1; k < 8; k++) {
      const a = k * TAU / 8, dx = k < 0 ? 0 : Math.cos(a) * rr, dz = k < 0 ? 0 : Math.sin(a) * rr, h = ground(it.x + dx, it.z + dz);
      g = Math.min(g, h); gmax = Math.max(gmax, h);
    }
    const H = (e.top + e.base) * sy;
    const y = g - it.bury * H + e.base * sy;
    const mat = placeMat(it.x - ox, y - oy, it.z - oz, it.yaw, it.leanX, it.leanZ, it.leanAmt, sx, sy, sz);
    return { ...it, sx, sy, sz, gy: g, gmax, y, H, mat, topW: y + e.top * sy };
  });
  const drifts = [];
  for (const p of prepared) {
    if (p.drift) {
      const small = p.size < 0.9;
      drifts.push(driftGeo(ground, p.x, p.z, p.sx * p.e.half * 0.95, p.sz * p.e.half * 0.95, p.drift * p.size * 0.2, p.e.id + 3, ox, oy, oz, spec.leeV ?? [-0.78, 0.1], small ? 4 : 7, small ? 16 : 28));
    }
    if (p.ridge) {
      const rx = p.size * p.ridge.len + 0.8, rz = p.size * p.ridge.wid + 0.35, off = rx * 0.45;
      drifts.push(driftGeo(ground, p.x + Math.cos(p.ridge.rot) * off, p.z + Math.sin(p.ridge.rot) * off, rx * 0.8, rz * 0.8, Math.min(0.08 + 0.14 * p.size, 0.7), p.e.id + 11, ox, oy, oz, [1, 0], 6, 26, p.ridge.rot));
    }
    // colliders: only rocks that clearly stand above the player's step-up; low rocks are walk-over
    if (p.topW - p.gmax > 0.66) {
      const m = Math.max(p.sx, p.sz) * p.e.half * (p.e.kind === 'shard' ? 0.42 : p.e.kind === 'strata' ? 0.55 : 0.5);
      colliders.push({ minX: p.x - m, maxX: p.x + m, minZ: p.z - m, maxZ: p.z + m, minY: p.gy - 1, maxY: p.topW - 0.05 * p.sy });
    }
  }
  const prep = pebs.map((b) => {
    let g = 1e9;
    for (const [dx, dz] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) g = Math.min(g, ground(b.x + dx * b.size, b.z + dz * b.size));
    const y = g + (0.30 - b.bury) * b.size * 1.0;       // waterline at ~30 % of the pebble height: bury moves it deeper
    return { ...b, mat: placeMat(b.x - ox, y - oy, b.z - oz, b.yaw, b.leanX, b.leanZ, b.leanAmt, b.size * b.ax, b.size * b.sq, b.size * b.az) };
  });
  const lod = new THREE.LOD();
  const maxS = prepared.reduce((m, p) => Math.max(m, p.size), 0.2);
  const cull = spec.cull ?? clamp(maxS * 75 + 70, 120, 650);        // small clusters stop being drawn early: nothing under ~12 px is worth a draw call
  const dists = [0, spec.lod0 ?? (maxS > 1.6 ? 15 : 22), spec.lod1 ?? 56, spec.lod2 ?? Math.min(160, cull * 0.55)];
  const castAny = prepared.some((p) => p.size >= 0.3);
  for (let l = 0; l < 4; l++) {
    const mer = new Merge();
    const tmp = new THREE.Color();
    for (const p of prepared) {
      if (l === 3 && p.size < 0.9) continue;                           // far: small rocks vanish
      const e = p.e, gl = l;
      tmp.copy(p.red ? RED_C : BLUE_C).multiply(p.tint);
      mer.add(e.lod[gl] ?? e.lod[2], p.mat, null, p.y - e.base * p.sy, false, p.H, tmp);
      if (p.cap) {
        const sg = e.snow[gl] ?? e.snow[Math.min(gl, 2)] ?? null;
        if (sg) mer.add(sg, p.mat, snowTint(e.id), 0, true);
        else if (!LIB.ok && p.size > 1.4 && l < 2) mer.add(snowPillow(2.0, 1.8, 0.34, { seed: e.id, seg: 10, bury: 0.2 }), placeMat(p.x - ox, p.y - oy + 0.62 * p.sy, p.z - oz, p.yaw, 0, 0, 0, p.sx, p.sy, p.sz), snowTint(e.id), 0, true);
      }
    }
    if (l < 2) {
      for (const b of prep) mer.addPeb(b.geo, b.mat, b.red ? RED_C : BLUE_C, b.tint, SNOW_C, true);
      for (const d of drifts) mer.add(d, new THREE.Matrix4(), snowTint(3), 0, true);
    }
    const g = mer.build();
    const grp = new THREE.Group();
    if (g) {
      const mesh = new THREE.Mesh(g, rockMat);
      mesh.castShadow = castAny && l < 2;
      mesh.customDepthMaterial = rockDepth;
      mesh.receiveShadow = true;
      grp.add(mesh);
    }
    lod.addLevel(grp, dists[l]);
  }
  lod.addLevel(new THREE.Group(), cull);
  lod.position.set(ox, oy, oz);
  lod.userData.rocks = true;
  lod.updateMatrixWorld(true);
  return { object: lod, colliders };
}
const SNOW_C = new THREE.Color(0xf4f8ff);

// ── cluster layout ──────────────────────────────────────────────────────────────────────────────
const DEFAULT_KINDS = { boulder: 3, chunk: 4, shard: 2, slab: 1.2, stack: 2 };
function pickKind(r, w) {
  let tot = 0;
  for (const k of KINDS) tot += w[k] || 0;
  let t = r() * tot;
  for (const k of KINDS) if ((t -= w[k] || 0) < 0) return k;
  return 'chunk';
}
function pickEntry(r, kind, size) {
  const hero = size >= HERO_MIN;
  const pool = (hero ? LIB.hero : LIB.small)[kind] ?? (hero ? LIB.small : LIB.hero)[kind] ?? LIB.all.filter((e) => e.kind !== 'strata');
  return pool[Math.floor(r() * pool.length)];
}
function makeItem(r, kind, size, x, z, o = {}) {
  const e = o.entry ?? pickEntry(r, kind, size);
  kind = e.kind;
  const [a, b] = SQUASH[kind];
  const red = o.red ?? true;
  const la = r() * TAU;
  return {
    e, size, x, z, red, cap: o.cap ?? true, drift: o.drift ?? 0,
    ax: 0.86 + r() * 0.42, az: 0.82 + r() * 0.34, sq: a + r() * (b - a),
    yaw: r() * TAU, leanX: o.leanX ?? Math.cos(la), leanZ: o.leanZ ?? Math.sin(la), leanAmt: o.leanAmt ?? (r() * LEAN[kind] * (r() < 0.3 ? 2 : 1)),
    bury: o.bury ?? (0.16 + r() * 0.22),
    tint: (red ? RED_TINTS : BLUE_TINTS)[Math.floor(r() * (red ? RED_TINTS.length : BLUE_TINTS.length))].clone().multiplyScalar(0.86 + r() * 0.14),
  };
}
function makePeb(r, size, x, z, red, bury) {
  const geo = LIB.peb[Math.floor(r() * LIB.peb.length)];
  const la = r() * TAU;
  return {
    geo, size, x, z, red, ax: 0.8 + r() * 0.5, az: 0.8 + r() * 0.4, sq: 0.9 + r() * 0.6, yaw: r() * TAU,
    leanX: Math.cos(la), leanZ: Math.sin(la), leanAmt: r() * 0.4, bury,
    tint: (red ? RED_TINTS : BLUE_TINTS)[Math.floor(r() * (red ? RED_TINTS.length : BLUE_TINTS.length))].clone().multiplyScalar(0.82 + r() * 0.18),
  };
}
/** focal rock + leaning satellites of decreasing size on the lee side + a gravel fan downslope */
function layout(r, spec) {
  const items = [], pebs = [];
  const w = spec.kinds ?? DEFAULT_KINDS;
  const redP = spec.red ?? 0.65;
  const hs = spec.hero ? lerp(spec.hero[0], spec.hero[1], r()) : spec.size ? spec.size[1] : 1.2;
  const lee = r() * TAU;
  const fk = spec.heroKind ?? pickKind(r, w);
  const mound = !!spec.mound;
  const focal = makeItem(r, fk, hs, spec.x, spec.z, { red: r() < redP, drift: mound ? 0.85 : (spec.drift ?? 0.5), bury: mound ? 0.36 + r() * 0.12 : 0.10 + r() * 0.12 });
  if (hs > 0.5 && (spec.ridge ?? 0.35) > r()) focal.ridge = { rot: lee + (r() - 0.5) * 0.8, len: 1.7 + r() * 1.3, wid: 0.5 + r() * 0.3 };      // wind-sculpted tail of snow on the lee side
  items.push(focal);
  const nSat = spec.n ?? 0;
  const fr = hs * focal.e.half * 0.8;
  for (let i = 0; i < nSat; i++) {
    const t = (i + r() * 0.7) / Math.max(1, nSat);
    const s = Math.max(0.1, hs * lerp(0.62, 0.16, t) * (0.85 + r() * 0.3));
    const near = i < Math.ceil(nSat * 0.7) || !spec.spread;
    let a, d;
    if (near) { a = lee + (r() - 0.5) * 2.5; d = fr + s * (0.55 + r() * 0.8); }
    else { a = r() * TAU; d = fr + (spec.spread ?? 4) * (0.5 + r()); }
    const x = spec.x + Math.cos(a) * d, z = spec.z + Math.sin(a) * d;
    const sat = makeItem(r, pickKind(r, w), s, x, z, { red: r() < (focal.red ? 0.8 : 0.35) || r() < redP * 0.4, cap: s > 0.14, drift: mound ? 0.7 : (s > 0.45 ? 0.35 : (s > 0.22 && r() < 0.6 ? 0.3 : 0)), bury: (mound ? 0.30 : 0.14) + r() * 0.20 });
    if (near) { sat.leanX = -Math.cos(a); sat.leanZ = -Math.sin(a); sat.leanAmt = 0.06 + r() * 0.18; }      // leaning against the focal rock
    items.push(sat);
  }
  // gravel fan: a few chunky stones decreasing with distance, on the downhill side (lee if flat); sizes kept large enough to read as stones, not confetti
  const nPeb = Math.round((spec.rubble ?? 0) * (spec.gravel ?? 1) * 0.6);
  if (nPeb) {
    const e = 1.0;
    const gx = (heightAt(spec.x + e, spec.z) - heightAt(spec.x - e, spec.z)), gz = (heightAt(spec.x, spec.z + e) - heightAt(spec.x, spec.z - e));
    const slope = Math.hypot(gx, gz) / (2 * e);
    const dirA = slope > 0.12 ? Math.atan2(-gz, -gx) : lee + 0.8;
    for (let i = 0; i < nPeb; i++) {
      const u = Math.pow(r(), 1.3);
      const a = dirA + (r() - 0.5) * 1.6, d = fr * (0.85 + 2.4 * u) + r() * 0.4;
      const s = clamp(Math.min(hs, 2.2) * lerp(0.22, 0.09, u) * (0.75 + r() * 0.6), 0.07, 0.45);
      const px = spec.x + Math.cos(a) * d, pz = spec.z + Math.sin(a) * d;
      pebs.push(makePeb(r, s, px, pz, focal.red ? r() < 0.8 : r() < 0.3, 0.05 + r() * 0.2));
      if (r() < 0.35) pebs.push(makePeb(r, s * (0.45 + r() * 0.3), px + (r() - 0.5) * s * 3, pz + (r() - 0.5) * s * 3, focal.red ? r() < 0.8 : r() < 0.3, 0.05 + r() * 0.2));       // stones come in twos and threes
    }
  }
  return { items, pebs };
}

// the main route: the canyon centre line AND the straight guard path between the route waypoints (field -> gateway -> city end -> canyon -> ring -> gate)
const GUARD = [[262, 0], [215, 0], [150, 0], [40, 0], [-80, -6], [-125, -9], [-165, -6], [-205, -6]];
const guardX = (z) => {
  for (let i = 0; i < GUARD.length - 1; i++) if (z <= GUARD[i][0] && z >= GUARD[i + 1][0]) return lerp(GUARD[i][1], GUARD[i + 1][1], (GUARD[i][0] - z) / (GUARD[i][0] - GUARD[i + 1][0]));
  return 0;
};
/** horizontal distance from x to the walking corridor (between canyon centre line and guard path) at z */
const corridorDist = (x, z) => { const a = canyonX(z), b = guardX(z), lo = Math.min(a, b), hi = Math.max(a, b); return x < lo ? lo - x : x > hi ? x - hi : 0; };

// ── world scatter plan ──────────────────────────────────────────────────────────────────────────
const hashStr = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };
const hashPos = (x, z) => (Math.imul(Math.round(x * 100) | 0, 73856093) ^ Math.imul(Math.round(z * 100) | 0, 19349663)) >>> 0;

export function scatterWorld({ job, put, ground, keepClear }) {
  fallbackLib();
  let r = rng(8812);
  const placed = [];
  let count = 0, rocks = 0;
  const stats = {};
  let phase = '';
  const why = (k) => { stats[phase + ':' + k] = (stats[phase + ':' + k] || 0) + 1; };
  const CAMS = [[0, 240], [-30, 215], [6, 150], [6, 100], [0, 60], [0, 36], [-4, -30], [-4, -60], [-4, -100], [-4, -150], [0, 250], [0, 215], [0, 150], [0, 40], [-6, -80], [-9, -125], [-6, -165]];
  let rej = '';
  // ext = horizontal reach of the thing being placed (lane / street / canyon-route / pier clearances are measured to its EDGE), rad = footprint used for the soft tests
  const okAt = (x, z, minGap = 0, rad = 0, maxSlope = 0.85, street = false, lane = 0, tiny = false, ext = rad, soft = 0.3) => {
    if (Math.abs(x) > HALF_X - 10 || z > 262 || z < -196) { rej = 'bounds'; return false; }
    // structures / spires / buildings keep their full clearance; the small rects of ground-dressing props (<= 6.5 m half extent) are soft: rubble may bank against them
    if (keepClear.some((k) => { const f = k.hx < 6.5 && k.hz < 6.5 ? soft : 0.8; return Math.abs(x - k.x) < k.hx * f + rad * 0.5 && Math.abs(z - k.z) < k.hz * f + rad * 0.5; })) { rej = 'keep'; return false; }
    if (z > 30 && z < 143 && Math.abs(x) < (lane || (street ? 8.5 : 21)) + ext) { rej = 'street'; return false; }      // city street (flank rubble allowed only outside the walking lane)
    if (z < 50 && z > -198 && corridorDist(x, z) < (lane || 15) + ext) { rej = 'canyon'; return false; }        // canyon route
    if (z > 150 && z < 258 && Math.abs(x - 0.75) < (lane || 6.5) + ext + 0.75) { rej = 'spawnlane'; return false; }       // spawn → gateway line + footprints
    if (Math.abs(z - 172) < 11 + rad) { rej = 'pier'; return false; }                                      // viaduct piers
    if (x > -73 - rad && x < -59 + rad && z > 174 && z < 218) { rej = 'stair'; return false; }              // viaduct stair
    if (slopeAt(x, z) > maxSlope) { rej = 'slope'; return false; }
    if (!tiny) for (const c of CAMS) if (Math.hypot(x - c[0], z - c[1]) < 3.2 + rad) { rej = 'cam'; return false; }       // never plant a rock on a reference viewpoint / route waypoint
    for (const p of placed) if (Math.hypot(x - p[0], z - p[1]) < minGap + p[2]) { rej = 'gap'; return false; }
    return true;
  };
  const cluster = (spec, force = false) => {
    const rad = (spec.hero ? spec.hero[1] * 1.8 : (spec.spread ?? 4) + 3);
    if (!force && !okAt(spec.x, spec.z, spec.gap ?? 6, rad * 0.6, spec.maxSlope ?? 0.85, !!spec.street, spec.lane ?? 0, (spec.hero?.[1] ?? 2) < 0.5, (spec.hero?.[1] ?? 1.2) * 1.1, spec.soft ?? 0.3)) { why('rej:' + rej); return false; }
    const lay = layout(rng(hashPos(spec.x, spec.z)), spec);       // items are tested against OTHER clusters only (this cluster registers itself afterwards)
    const items = lay.items.filter((it, i) => force || okAt(it.x, it.z, 0, it.size * 0.4, spec.maxSlope ?? 0.85, !!spec.street, spec.lane ?? 0, it.size < 0.5, it.size * 1.1, spec.soft ?? 0.3));
    const pebs = lay.pebs.filter((b) => force || okAt(b.x, b.z, 0, 0, 1.1, !!spec.street, spec.lane ?? 0, true, 0, spec.soft ?? 0.3));
    if (!items.length) { why('empty'); return false; }
    placed.push([spec.x, spec.z, rad * 0.6]);
    why('ok');
    count++; rocks += items.length;
    job(() => put(buildCluster(spec, items, pebs, ground)));
    return true;
  };

  /** try a few jittered candidate specs for one slot (crowded areas: the dressing props claim much of the ground) */
  const tc = (gen, tries = 12) => { for (let t = 0; t < tries; t++) if (cluster(gen(t))) return true; return false; };
  // spawn route: x ~ 1.5 (the line to the viaduct gateway); lane half-width for the hand-placed edge dressing
  const sx0 = 1.5;
  phase = 'spawn'; r = rng(hashStr('spawn'));
  // 1) composition rocks around spawn (framing the line of sight to the viaduct gateway)
  cluster({ x: -12.5, z: 236, hero: [4.2, 4.8], heroKind: 'chunk', n: 5, rubble: 16, red: 0.9, drift: 0.7, spread: 5, lod2: 260, cull: 700 }, true);
  cluster({ x: 14, z: 228, hero: [3.6, 4.2], heroKind: 'boulder', n: 5, rubble: 14, red: 0.8, drift: 0.7, spread: 5, lod2: 260, cull: 700 }, true);
  cluster({ x: -37, z: 201, hero: [4.6, 5.4], heroKind: 'slab', n: 4, rubble: 12, red: 0.75, drift: 0.7, spread: 5, lod2: 260, cull: 700 }, true);
  cluster({ x: 27, z: 205, hero: [3.2, 3.8], heroKind: 'chunk', n: 4, rubble: 12, red: 0.7, drift: 0.7, spread: 5, lod2: 260, cull: 700 }, true);
  cluster({ x: -8.5, z: 193, hero: [2.6, 3.2], heroKind: 'boulder', n: 4, rubble: 10, red: 0.85, drift: 0.6, spread: 4, lod2: 240, cull: 700 }, true);
  cluster({ x: 10, z: 189, hero: [2.4, 3.0], heroKind: 'chunk', n: 4, rubble: 10, red: 0.6, drift: 0.6, spread: 4, lod2: 240, cull: 700 }, true);
  cluster({ x: -46, z: 238, hero: [3.4, 4.4], n: 5, rubble: 12, red: 0.7, drift: 0.6, spread: 5, lod2: 260, cull: 700 }, true);
  cluster({ x: 50, z: 246, hero: [3.0, 4.0], n: 5, rubble: 12, red: 0.7, drift: 0.6, spread: 5, lod2: 260, cull: 700 }, true);

  phase = 'edge'; r = rng(hashStr('edge'));
  // 2) spawn lane edges: rock groups 4-14 m off the walking line on both sides, from the viewer's feet to the viaduct. Fixed slots along the route;
  // a blocked slot is retried farther out, so the foreground flanks are reliably dressed instead of depending on a lucky roll
  const routeSlots = (z0, z1, step, cxf, lat0, latR, mk, lane, halfF = () => 0) => {
    for (let z = z0; z > z1; z -= step * (0.8 + r() * 0.4)) {
      for (const side of [-1, 1]) {
        if (r() < 0.07) continue;
        const lat = lat0 + halfF(z) + r() * latR;
        tc((t) => ({ x: cxf(z) + side * (lat + t * 1.5), z: z + (r() - 0.5) * (2 + t), ...mk(), lane, gap: 2.0, maxSlope: 1.1 }), 7);
      }
    }
  };
  const mkEdge = () => (r() < 0.25 ? { hero: [1.8, 3.2], n: 3 + Math.floor(r() * 3), rubble: 10, spread: 3.5, red: 0.85, drift: 0.55, mound: r() < 0.3, }
                                  : { hero: [0.7, 1.7], n: 2 + Math.floor(r() * 3), rubble: 8 + Math.floor(r() * 8), spread: 3, red: 0.85, drift: 0.55, mound: r() < 0.25 });
  routeSlots(254, 180, 5.0, () => sx0, 4.4, 7, mkEdge, 3.3);

  // composed foreground for the key viewpoints: groups in camera-relative slots (forward, lateral, focal size, satellites), jittered if blocked
  const compose = (cx, cz, yawDeg, slots) => {
    const yw = (yawDeg * Math.PI) / 180, fx = -Math.sin(yw), fz = -Math.cos(yw), rx = Math.cos(yw), rz = -Math.sin(yw), rc = rng(hashPos(cx, cz));
    for (const [fwd, lat, lo, hi, n, rub, mound, inLane] of slots)
      tc((t) => ({ x: cx + fx * fwd + rx * (lat + Math.sign(lat || 1) * t * (inLane ? 0.3 : 0.8)), z: cz + fz * fwd + rz * (lat + Math.sign(lat || 1) * t * (inLane ? 0.3 : 0.8)) + (rc() - 0.5) * t, hero: [lo, hi], n, rubble: rub, spread: inLane ? 1.8 : 2.6, red: 0.85, drift: inLane ? 0.35 : 0.6, mound: !!mound, lane: inLane ? -1 : 3.0, gap: inLane ? 0.8 : 0.6, maxSlope: 1.25, soft: 0 }), 9);
  };
  compose(0, 240, 0, [[5.5, -4.6, 0.9, 1.3, 3, 8], [7, 5.8, 0.8, 1.2, 3, 8, 1], [13, -8.5, 1.8, 2.6, 4, 10], [14, 9, 1.4, 2.2, 4, 10], [22, 1, 0.5, 0.9, 2, 12], [8.5, 1.2, 0.26, 0.4, 1, 16, 0, 1], [15, -1.4, 0.3, 0.45, 2, 14, 0, 1], [11, 2.6, 0.22, 0.34, 1, 10, 0, 1]]);
  compose(-30, 215, 20, [[6, -4, 1.1, 1.6, 3, 8], [8, 6, 0.8, 1.2, 3, 8, 1], [16, -5, 2, 3, 4, 10], [14, 8, 1.4, 2, 3, 8]]);
  compose(6, 150, 0, [[6, -4.5, 0.8, 1.3, 3, 8], [8, 5.5, 0.7, 1.1, 3, 8], [16, -8, 1.2, 1.8, 3, 8]]);

  phase = 'field'; r = rng(hashStr('field'));
  // 3) entrance snowfield: clustered, denser around ridges (noise-modulated acceptance)
  for (let i = 0, ok = 0; ok < 56 && i < 1600; i++) {
    const x = (r() - 0.5) * 290, z = 178 + r() * 84;
    if (SN.n2(x * 0.018 + 3, z * 0.018) < -0.12 && r() < 0.8) continue;
    const hero = r() < 0.45;
    if (cluster(hero ? { x, z, hero: [2.0, 4.6], n: 4 + Math.floor(r() * 3), rubble: 8 + Math.floor(r() * 8), spread: 5, gap: 7, red: 0.68, drift: 0.6, mound: r() < 0.25 }
                     : { x, z, hero: [0.7, 1.9], n: 4 + Math.floor(r() * 4), rubble: 10, spread: 5, gap: 6, red: 0.66, drift: 0.5, mound: r() < 0.3 })) ok++;
  }
  // mid-ground cluster fields at the butte feet
  for (const [x, z] of [[-112, 214], [108, 216], [-132, 236], [136, 240], [-150, 178], [150, 168]])
    for (let k = 0; k < 2; k++) cluster({ x: x + (r() - 0.5) * 30, z: z + (r() - 0.5) * 22, hero: [3, 6.5], n: 5, rubble: 10, spread: 6, gap: 8, red: 0.7, drift: 0.6 });

  phase = 'city'; r = rng(hashStr('city'));
  // 4) abandoned city: low rubble, snow-buried debris along the street flanks
  for (let i = 0, ok = 0; ok < 60 && i < 1200; i++) {
    const x = (r() - 0.5) * 230, z = 40 + r() * 106;
    if (cluster({ x, z, hero: [0.6, 1.7], n: 4 + Math.floor(r() * 3), rubble: 10, spread: 3.5, gap: 6, red: 0.5, drift: 0.5, mound: r() < 0.3, kinds: { boulder: 3, chunk: 5, slab: 1.5, stack: 2, shard: 1.5 } })) ok++;
  }
  phase = 'street'; r = rng(hashStr('street'));
  // 4b) street flanks: debris banked against the building lines, leaving the walking lane (|x| < 5.2) clear
  routeSlots(140, 34, 4.8, () => 0, 5.8, 8, () => ({ hero: r() < 0.2 ? [1.3, 2.4] : [0.5, 1.4], n: 2 + Math.floor(r() * 3), rubble: 8, spread: 2.4, red: 0.55, street: true, drift: 0.5, mound: r() < 0.25,
    kinds: { boulder: 3, chunk: 5, slab: 1.5, stack: 2, shard: 1.5 } }), 5.2);
  compose(6, 100, 8, [[6, -4.8, 0.7, 1.2, 3, 8], [8, 5.2, 0.7, 1.1, 3, 8], [15, -7, 1.2, 1.8, 3, 8], [9, -1.0, 0.26, 0.4, 1, 14, 0, 1], [14, 1.0, 0.3, 0.42, 2, 12, 0, 1]]);
  compose(0, 60, 0, [[6, -4.8, 0.7, 1.2, 3, 8], [8, 5.2, 0.7, 1.1, 3, 8], [15, -7, 1.2, 1.8, 3, 8], [9, 0.8, 0.26, 0.4, 1, 14, 0, 1], [14, -1.2, 0.3, 0.42, 2, 12, 0, 1]]);
  compose(0, 36, 0, [[5, -4.5, 0.9, 1.4, 3, 9, 1], [6, 5.5, 0.8, 1.2, 3, 9], [12, -7, 1.4, 2.2, 4, 10], [12, 8, 1.2, 1.8, 3, 8], [20, 0, 0.6, 1.0, 2, 10]]);
  phase = 'canyonfoot'; r = rng(hashStr('canyonfoot'));
  // 5) canyon: floor boulders, wall-foot talus fields, strata towers, hero rocks flanking the ring / gate
  for (let z = 22; z > -192; z -= 10) {
    for (const side of [-1, 1]) {
      const cx = canyonX(z), hw = canyonHalfWidthAt(z);
      const x = cx + side * (hw - 4 + (r() - 0.35) * 14);
      cluster({ x, z: z + (r() - 0.5) * 8, hero: [2.4, 6.0], n: 5, rubble: 10, spread: 6, gap: 8, red: 0.72, drift: 0.6, kinds: { boulder: 3, chunk: 5, slab: 1.2, stack: 2 } });
    }
  }
  phase = 'canyonfloor'; r = rng(hashStr('canyonfloor'));
  for (let z = 14; z > -190; z -= 12) {
    const x = canyonX(z) + (r() < 0.5 ? -1 : 1) * (19 + r() * 17);
    cluster({ x, z, hero: [0.9, 3.0], n: 5 + Math.floor(r() * 3), rubble: 10, spread: 6, gap: 8, red: 0.6, drift: 0.5 });
  }
  phase = 'towers'; r = rng(hashStr('towers'));
  for (let z = 6; z > -186; z -= 34) {
    for (const side of [-1, 1]) {
      const cx = canyonX(z), hw = canyonHalfWidthAt(z);
      // the foot of the wall is steep scree: try a few offsets until the ground is calm enough
      for (let t = 0; t < 14; t++) {
        const zz = z + (r() - 0.5) * 20, hh = canyonHalfWidthAt(zz);
        if (cluster({ x: canyonX(zz) + side * (hh - 6 + t * 1.6 + r() * 3), z: zz, hero: [7, 12], heroKind: 'strata', n: 3, rubble: 6, spread: 12, gap: 14, red: 0.38, drift: 0.4, kinds: { boulder: 2, chunk: 6, slab: 3 }, lod1: 110, lod2: 280, cull: 800, maxSlope: 1.7 })) break;
      }
    }
  }
  phase = 'hero'; r = rng(hashStr('hero'));
  for (const [dx, z, red] of [[-14, -108, true], [16, -126, false], [-18, -140, true], [14, -166, true], [-12, -172, false]])
    cluster({ x: canyonX(z) + dx, z, hero: [3, 4.6], n: 4, rubble: 10, red: red ? 0.9 : 0.4, drift: 0.6, spread: 4, lod2: 260 }, true);

  phase = 'dress'; r = rng(hashStr('dress'));
  // 6) canyon route: groups along the floor on both sides of the walking line (lane kept clear), larger toward the walls
  routeSlots(34, -190, 5.2, (z) => (canyonX(z) + guardX(z)) / 2, 4.4, 8, () => ({ hero: r() < 0.25 ? [1.4, 2.8] : [0.6, 1.5], n: 2 + Math.floor(r() * 3), rubble: 8, spread: 3, red: 0.75, drift: 0.55, mound: r() < 0.2,
    kinds: { boulder: 3, chunk: 5, slab: 1.2, stack: 2, shard: 1.5 } }), 3.0, (z) => Math.abs(canyonX(z) - guardX(z)) / 2);
  compose(-4, -30, 0, [[5.5, -4.6, 0.9, 1.4, 3, 9], [6.5, 5.2, 0.8, 1.2, 3, 8, 1], [14, -8, 1.6, 2.4, 4, 10], [13, 9, 1.4, 2.2, 3, 10], [9, 1.0, 0.26, 0.4, 1, 16, 0, 1], [16, -1.2, 0.3, 0.45, 2, 14, 0, 1]]);
  compose(-4, -60, -10, [[5.5, -4.8, 0.9, 1.4, 3, 9], [7, 5.5, 0.8, 1.2, 3, 8], [14, -8, 1.6, 2.4, 4, 10], [4.2, -6.5, 0.7, 1.0, 2, 8], [4.5, 6.8, 0.7, 1.0, 2, 8], [9, 1.0, 0.26, 0.4, 1, 16, 0, 1]]);
  compose(-4, -100, 0, [[5.5, -4.8, 0.9, 1.4, 3, 9], [7, 5.5, 0.8, 1.2, 3, 8, 1], [14, -8, 1.6, 2.4, 4, 10], [9, 1.0, 0.26, 0.4, 1, 16, 0, 1]]);
  compose(-4, -150, 0, [[5.5, -4.8, 0.9, 1.4, 3, 9], [7, 5.5, 0.8, 1.2, 3, 8, 1], [13, -8, 1.4, 2.2, 4, 10]]);

  phase = 'lane'; r = rng(hashStr('lane'));
  // 7) the walking lane itself: scree patches + low step-over stones (no colliders) so the route never reads as an empty runway
  const routeX = (z) => (z > 150 ? 0.75 : z > 40 ? 0.5 : (canyonX(z) + guardX(z)) / 2);
  for (let z = 258; z > -188; z -= 5 + r() * 3.5) {
    if (Math.abs(z - 172) < 12 || (z < -104 && z > -134) || (z < -164 && z > -192)) continue;       // viaduct piers / ring / gate pads
    tc(() => ({ x: routeX(z) + (r() - 0.5) * (6.4 + (z < 40 ? Math.abs(canyonX(z) - guardX(z)) : 0)), z: z + (r() - 0.5) * 4, hero: [0.2, 0.42], n: 1 + Math.floor(r() * 2), rubble: 16 + Math.floor(r() * 12), spread: 2.2, gap: 2.0, red: 0.8, lane: -1, drift: 0.35, kinds: { boulder: 3, chunk: 4, slab: 2, stack: 1 } }), 5);
  }
  // scree fields off the lane: gravel fans with a few knee-high stones
  for (let i = 0, ok = 0; ok < 40 && i < 400; i++) {
    const z = 255 - r() * 440, side = r() < 0.5 ? -1 : 1, rx = routeX(z) + side * ((z < 40 ? Math.abs(canyonX(z) - guardX(z)) / 2 : 0) + 5 + r() * 14);
    if (cluster({ x: rx, z, hero: [0.3, 0.55], n: 2, rubble: 20 + Math.floor(r() * 14), spread: 3, gap: 2.5, red: 0.8, street: z > 36 && z < 143, lane: 4, drift: 0.4 })) ok++;
  }

  phase = 'butte'; r = rng(hashStr('butte'));
  // 7) butte feet: stepped rock rubble around the mid-ground mesas
  for (const [x, z] of [[-118, 243], [104, 240], [88, 214], [58, 244]])
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * 6.28 + r(), d = 18 + r() * 8;
      cluster({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d * 0.8, hero: [2.4, 5], n: 5, rubble: 10, spread: 6, gap: 8, red: 0.72, drift: 0.6 });
    }
  return { clusters: count, rocks, stats };
}
