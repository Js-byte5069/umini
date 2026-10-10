// Terrain surface shader: snow painting, drifts, cliff strata / planes, smooth per-chunk normals.
import * as THREE from 'three';
import { RAMP_TERRAIN, NOISE_GLSL } from './materials.js';

const _noTex = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
_noTex.needsUpdate = true;
/** called per terrain chunk draw: binds the chunk's smooth gradient texture (or disables the smooth-normal path for far tiles) */
export function setTerrainTexture(mat, tex, chunk) {
  const u = mat.userData.uniforms;
  if (!u) return;
  u.uNTex.value = tex ?? _noTex;
  if (chunk) u.uChunk.value.set(chunk[0], chunk[1], chunk[2], chunk[3]);
  u.uTexOn.value = tex ? 1 : 0;
}

/** One terrain material per chunk mesh: three only re-uploads uniforms when the material changes between draws, so the chunk's own
 *  gradient texture / rect uniforms need their own material instance (the shader program itself is shared through the cache key). */
export function makeTerrainMaterial() {
  const m = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: RAMP_TERRAIN });
  m.shadowSide = THREE.FrontSide;
  m.onBeforeCompile = (sh) => terrainCompile(m, sh);
  m.customProgramCacheKey = () => 'terrain-paint3';
  return m;
}
const TDBG = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('tdbg')) || '0';
function terrainCompile(mat, sh) {
  sh.uniforms.uNTex = { value: _noTex };
  sh.uniforms.uChunk = { value: new THREE.Vector4(0, 0, 64, 129) };
  sh.uniforms.uTexOn = { value: 0 };
  mat.userData.uniforms = sh.uniforms;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 tr;\nattribute float fh;\nvarying float vFH;\nvarying vec4 vTr;\nvarying vec3 vTP;\nvarying vec3 vTN;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n vTr = tr; vFH = fh; vTP = (modelMatrix * vec4(transformed, 1.0)).xyz; vTN = objectNormal;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
#define TDBG ${TDBG}
varying vec4 vTr;
varying float vFH;
varying vec3 vTP;
varying vec3 vTN;
uniform sampler2D uNTex;
uniform vec4 uChunk;      // chunk origin x, z, size, node count
uniform float uTexOn;
float gRockK = 0.0;
vec3 gFacet = vec3(0.0);
vec2 gGr = vec2(0.0);       // smooth height gradient at this pixel (already exaggerated for gentle snow)
float gSm = 0.0;            // 1 when gGr holds the per-pixel smooth gradient
float h11(float n){ return fract(sin(n*12.9898)*43758.5453); }
float h31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
${NOISE_GLSL}
float svn3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i), h31(i+vec3(1,0,0)), f.x), mix(h31(i+vec3(0,1,0)), h31(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i+vec3(0,0,1)), h31(i+vec3(1,0,1)), f.x), mix(h31(i+vec3(0,1,1)), h31(i+vec3(1,1,1)), f.x), f.y), f.z); }
// cubic B-spline filtering with 4 bilinear fetches (Sigg & Hadwiger): C2-smooth interpolation of a node texture
vec4 cubicW(float v){
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 sq = n * n * n;
  float x = sq.x, y = sq.y - 4.0 * sq.x, z = sq.z - 4.0 * sq.y + 6.0 * sq.x, w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}
vec4 sampleGradSmooth(vec2 xz){
  float n = uChunk.w;
  vec2 st = ((xz - uChunk.xy) / (uChunk.z / (n - 1.0)) + 0.5);       // node-space coordinate, node i centred at i + 0.5
  vec2 uvp = st - 0.5;
  vec2 fxy = fract(uvp); uvp -= fxy;
  vec4 xc = cubicW(fxy.x), yc = cubicW(fxy.y);
  vec4 c = uvp.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = c + vec4(xc.yw, yc.yw) / s;
  off /= vec4(n, n, n, n);
  vec4 s0 = textureLod(uNTex, vec2(off.x, off.z), 0.0), s1 = textureLod(uNTex, vec2(off.y, off.z), 0.0);
  vec4 s2 = textureLod(uNTex, vec2(off.x, off.w), 0.0), s3 = textureLod(uNTex, vec2(off.y, off.w), 0.0);
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}
// the main route centre line: straight through the field and city, then following the canyon
float routeX(float z, float ph){
  float base = 9.0 * sin(z * 0.017 + 0.6) * smoothstep(30.0, -10.0, z);
  return base + 1.5 * sin(z * 0.083 + ph) * smoothstep(40.0, 150.0, z) + 0.7 * sin(z * 0.21 + ph * 1.7) * smoothstep(60.0, 160.0, z);
}
// stamped trail: width and wind-fill are plain sines of z (mirrored by terrain.js trailH) so paint and geometry agree
float trailFillG(float z){ return 0.5 + 0.5 * smoothstep(-0.5, 0.55, sin(z * 0.052 + 0.9) * 0.6 + sin(z * 0.0191 + 2.3) * 0.55); }
float trailHalfG(float z){ return 1.25 + 0.3 * sin(z * 0.037 + 2.0); }
// footprints as real dimples: alternating left/right bowls every 0.82 m with jittered placement and the odd missing step.
// Returns the height-field gradient (xz) of the bowls so the cel terminator draws a lit rim and a blue inner crescent;
// .z carries a soft 0..1 coverage used for a faint cool tint.
vec3 footDimple(vec2 p, float zLo, float zHi, float ph, float fade){
  float cell = floor(p.y / 0.82);
  float side = mod(cell, 2.0) * 2.0 - 1.0;
  float hs = h11(cell * 1.37 + ph);
  float cx = routeX((cell + 0.5) * 0.82, ph);
  vec2 c = vec2(cx + side * 0.19 + (hs - 0.5) * 0.10, (cell + 0.5) * 0.82 + (h11(cell * 3.1 + ph) - 0.5) * 0.12);
  vec2 rad = vec2(0.15, 0.34) * (0.88 + 0.28 * h11(cell * 5.3 + ph));
  vec2 d = (p - c) / rad;
  float q = dot(d, d);
  float on = step(zLo, p.y) * step(p.y, zHi) * step(0.14, hs) * fade;     // ~14% of the steps are missing
  float k = max(1.0 - q, 0.0);
  vec2 g = 4.0 * k * d / rad * 0.05 * on;
  return vec3(g, k * k * on);
}
// sled tracks: two broken grooves along the route (rounded profile, tilt across the groove)
vec2 trackGroove(vec2 p, float zLo, float zHi, float ph, float off, float w, float fade){
  float cx = routeX(p.y, ph) + off;
  float dx = (p.x - cx) / w;
  float k = max(1.0 - dx * dx, 0.0);
  float brk = smoothstep(0.30, 0.52, fbm2(vec2(p.y * 0.06 + off * 7.0, off * 3.0)));
  float on = step(zLo, p.y) * step(p.y, zHi) * fade * brk;
  return vec2(4.0 * k * dx / w * 0.035 * on, k * k * on);
}
`)
    .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 N0 = normalize(vTN);
  float camD = distance(vTP, cameraPosition);
  // snow shading normal: the C2-smooth per-pixel gradient field, gently exaggerated on low relief so swells / lumps / berms draw bold cel bands
  vec2 gr0 = vec2(0.0);
  vec3 Nsn = N0;
  float flatN = N0.y;                 // un-exaggerated smooth slope measure (gates footprints / ripples)
  float holT = vTr.z;
  float dBL = vTr.w - vTP.y;          // metres below the lip of the face this pixel belongs to (vertex fallback for tiles without a gradient texture)
  float slopeN = vTr.x;               // rock mask source: per-pixel smooth slope where the gradient texture exists (vertex-blurred mask otherwise)
  if (uTexOn > 0.5 && camD < 2600.0) {
    vec4 gs = sampleGradSmooth(vTP.xz);
    gr0 = gs.xy;
    dBL = gs.z - vTP.y;                // lip height (smooth in xz) minus the exact height of this pixel
    gGr = gr0;
    gSm = 1.0;
    float gl0 = length(gr0);
    slopeN = smoothstep(0.69, 0.44, 1.0 / sqrt(1.0 + gl0 * gl0));
    if (camD < 130.0) {
      holT = gs.w;
      float kEx = 1.0 + 1.15 * (1.0 - smoothstep(0.14, 0.5, gl0)) * (1.0 - smoothstep(60.0, 130.0, camD));
      gGr = gr0 * kEx;
      Nsn = normalize(vec3(-gGr.x, 1.0, -gGr.y));
      flatN = 1.0 / sqrt(1.0 + dot(gr0, gr0));
    }
  }
  float hol = clamp(holT, -1.0, 1.0);
  hol = hol > 0.0 ? hol * (1.0 - 0.6 * smoothstep(0.25, 0.60, slopeN)) : hol;     // concave creases on cliff faces tint a soft pale blue, never a hard dark line
  // rock mask: the blurred slope mask thresholded with a slow organic wobble (never per-triangle teeth); the snow cap hangs lower on the
  // upper face in irregular, soft-edged tongues (thick snow lying over every lip)
  // cap thickness depends on horizontal position only (a y-dependent noise would draw icicle-like drips); the lower edge is a smooth wavy contour
  float capN = vn(vTP.xz * 0.043 + 4.4) * 0.84 + vn(vTP.xz * 0.097 + 1.7) * 0.16;
  // thick, soft snow lying over every lip: a deep irregular cap with a few broad blunt tongues hanging lower (never thin drips)
  float cs = clamp(vFH / 40.0, 0.22, 1.0);                            // the cap scales with its face: low steps carry a thin cap, tall faces a thick one
  float capDepth = (1.3 + 3.5 * smoothstep(0.20, 0.80, capN)) * cs;
  float capK = (1.0 - smoothstep(capDepth - 2.2 * cs, capDepth + 1.8 * cs, dBL)) * smoothstep(-1.5 * cs, 0.3, dBL);
  // boundary wobble only acts where the slope is already near the rock threshold: gentle benches never grow rock blotches
  float wob = (svn3(vTP * vec3(0.045, 0.03, 0.045)) - 0.5) * 0.24 + (svn3(vTP * vec3(0.12, 0.08, 0.12)) - 0.5) * 0.08;
  float msk = slopeN + wob * smoothstep(0.10, 0.42, slopeN);
  msk -= capK * 0.95 * smoothstep(0.35, 0.6, slopeN) * (1.0 - smoothstep(0.74, 0.93, slopeN));      // snow drapes the shoulders only: a sheer face stays clean rock (no vertical drip tongues)
  float fm = fwidth(msk) * 1.2 + 0.02;
  float m = smoothstep(0.5 - fm, 0.5 + fm, msk);
  gRockK = m;
  vec3 rc = vec3(0.0);
  float farV = 1.0 - smoothstep(110.0, 300.0, camD);
  // ── rock: painted as a few big vertical slabs. Tall narrow columns (stretched ~9x in height) alternate between slate-blue and muted coral with
  //    crisp, cel-like edges; a few low-frequency wobbling strata bands bias where the coral sits; each slab carries its own value step (lighter /
  //    deeper) and the sun-facing planes run warmer. Large clean colour blocks, no noise, no bricks, no facets ──
  if (m > 0.002) {
    vec2 nxz = normalize(N0.xz + vec2(1e-4, 0.0));
    float face = dot(nxz, vec2(-0.99, 0.12));                           // +1 = turned toward the sun
    float steep = 1.0 - smoothstep(0.30, 0.60, N0.y);
    vec3 q = vTP;
    float reg = vn(q.xz * 0.0055 + 3.3);                                // regional bias: coral-rich vs slate-rich masses
    float detK = 1.0 - smoothstep(110.0, 300.0, camD);                  // thin slabs only where they can be read
    // strata: a few wobbling stone courses (about 20 m thick); inside a course the colour field depends on the horizontal position only, so every
    // slab edge is dead vertical, and from one course to the next the slabs jog sideways a little (stacked, jointed columns)
    float yw = q.y + 10.0 * (vn(q.xz * 0.011 + 2.0) - 0.5) + 3.0 * (vn(q.xz * 0.04 + 9.0) - 0.5);
    float sy = yw * 0.047 + reg * 3.0;
    float sI = floor(sy);
    vec2 jog = vec2(h11(sI * 7.31 + 3.7), h11(sI * 3.17 + 9.1)) * 2.6;
    vec2 cq = q.xz + jog;
    float cA = vn(cq * 0.068 + vec2(3.1, 9.3));
    float cB = vn(cq * 0.17 + vec2(8.3, 1.7));
    float colF = mix(cA, cA * 0.86 + cB * 0.14, detK);
    float band = vn(vec2(yw * 0.032 + reg * 5.0, 1.7));
    float cf = colF * 0.88 + band * 0.12 + (vn(vec2(q.y * 0.045, sI * 3.3 + 1.0)) - 0.5) * 0.06;
    float thr = 0.575 - (reg - 0.5) * 0.12;
    float eC = 0.004 + min(fwidth(cf), 0.06) * 1.3;                     // one-pixel cel edge (the clamp keeps the course joints from smearing)
    // coral lives on the near-vertical faces (the colour columns are vertical): the sloping benches / talus between faces stay slate, so no camouflage spots
    float coral = smoothstep(thr - eC, thr + eC, cf) * (1.0 - 0.7 * smoothstep(110.0, 420.0, camD)) * smoothstep(0.52, 0.30, N0.y);
    // slab value steps (soft-edged): a lighter plane, the body, a deeper plane
    float vv = vn(cq * 0.15 + vec2(13.0, 5.0)) * 0.80 + vn(cq * 0.40 + vec2(2.0, 17.0)) * 0.20 * detK + 0.10 * (1.0 - detK);
    float eP = 0.004 + min(fwidth(vv), 0.06) * 1.3;
    float lighter = smoothstep(0.575 - eP, 0.575 + eP, vv), deeper = 1.0 - smoothstep(0.415 - eP, 0.415 + eP, vv);
    float hueD = svn3(vec3(q.x * 0.06, q.y * 0.009, q.z * 0.06) + 41.0);
    float drift = svn3(q * vec3(0.012, 0.016, 0.012) + 9.1) - 0.5;      // slow hue / value drift over whole masses
    float pv = clamp(0.54 + 0.26 * face + 0.20 * drift + 0.10 * (smoothstep(18.0, 0.0, dBL) - 0.4), 0.0, 1.0);
    vec3 slate = pv < 0.5 ? mix(vec3(0.080, 0.084, 0.200), vec3(0.168, 0.174, 0.340), pv * 2.0) : mix(vec3(0.168, 0.174, 0.340), vec3(0.236, 0.246, 0.462), pv * 2.0 - 1.0);
    vec3 cor = pv < 0.5 ? mix(vec3(0.250, 0.062, 0.100), vec3(0.440, 0.104, 0.098), pv * 2.0) : mix(vec3(0.440, 0.104, 0.098), vec3(0.610, 0.168, 0.118), pv * 2.0 - 1.0);
    slate *= mix(vec3(1.07, 0.98, 0.90), vec3(0.93, 1.0, 1.10), smoothstep(0.30, 0.70, hueD));   // slate drifts between violet-grey and cool blue from slab to slab
    cor *= mix(vec3(1.02, 0.92, 0.96), vec3(1.0, 1.06, 0.94), smoothstep(0.35, 0.65, hueD));      // coral between rose-red and warm orange-red
    rc = mix(slate, cor, coral);
    float stepK = steep * (1.0 - smoothstep(60.0, 190.0, camD));
    rc *= 1.0 + (lighter * 0.17 - deeper * 0.21) * stepK;
    rc *= mix(vec3(1.0), vec3(1.035, 1.0, 0.95), lighter * stepK * coral) * mix(vec3(1.0), vec3(0.97, 0.97, 1.05), deeper * stepK);
    rc *= mix(0.88, 1.04, smoothstep(30.0, 0.0, dBL));                  // heavier at the foot, lighter toward the lip
    rc *= 1.0 - clamp(vTr.z, 0.0, 1.0) * 0.20 + clamp(-vTr.z, 0.0, 1.0) * 0.14;   // cavities dark, lips bright
    rc *= vTr.y;
  }
  // ── snow: pale-blue hollows, lit crests that stay below clipping, bold sastrugi, dimpled footprints / sled tracks ──
  vec3 sn = diffuseColor.rgb * vec3(0.972, 0.972, 0.980);
  if (m < 0.998) {
    float sd = fbm2(vTP.xz * 0.02 + 11.0) - 0.5;
    sn *= 1.0 + sd * 0.08;
    sn = mix(sn, sn * vec3(0.70, 0.83, 1.0), smoothstep(0.0, 0.9, hol) * 0.9);       // saturated blue hollows (smooth: no polygon-shaped contours)
    // slopes turning away from the sun drift toward clear pale blue (continuous, under the crisp cel bands)
    sn *= mix(vec3(0.84, 0.92, 1.0), vec3(1.0), smoothstep(-0.35, 0.65, dot(Nsn, vec3(-0.80, 0.56, 0.10))));
    sn *= 1.0 + smoothstep(0.0, 0.8, -hol) * 0.07;
    // wind-combed brush strokes: long pale-blue streaks lying along the wind
    {
      vec2 wd0 = vec2(0.906, 0.423);
      vec2 sp = vec2(dot(vTP.xz, wd0) * 0.034, (vTP.z * wd0.x - vTP.x * wd0.y) * 0.21);
      float st1 = fbm2(sp + vec2(3.7, 1.3));
      float st2 = fbm2(sp * vec2(2.1, 1.9) + vec2(9.1, 4.4));
      float sk = (1.0 - smoothstep(120.0, 380.0, camD)) * (1.0 - m) * smoothstep(0.80, 0.93, flatN);       // steep snow (caps, banks) stays clean: no strokes smeared over it
      sn = mix(sn, sn * vec3(0.84, 0.91, 0.975), smoothstep(0.52, 0.64, st1) * 0.8 * sk);
      sn = mix(sn, sn * vec3(0.92, 0.955, 0.985), smoothstep(0.50, 0.60, st2) * 0.65 * sk * (1.0 - smoothstep(40.0, 160.0, camD)));
    }
    // painted value masses: broad tone / hue drift over the drifts, wind-packed crust patches (cooler, a shade darker, crisp-edged) among softer powder
    {
      float farV = 1.0 - smoothstep(110.0, 300.0, camD);
      vec2 pp = vTP.xz;
      sn *= 1.0 + sd * 0.22 * farV;
      sn *= mix(vec3(1.012, 1.0, 0.982), vec3(0.972, 0.99, 1.02), smoothstep(-0.14, 0.14, sd));
      float crust = vn(pp * 0.072 + vec2(5.0, 61.0)) * 0.65 + vn(pp * 0.15 + vec2(17.0, 3.0)) * 0.35;
      float fcr = fwidth(crust) * 1.5 + 0.01;
      float crK = smoothstep(0.57 - fcr, 0.57 + fcr, crust) * farV * (1.0 - m) * smoothstep(0.86, 0.95, flatN);
      sn = mix(sn, sn * vec3(0.90, 0.945, 1.0), crK * 0.9);
    }
    // stamped trail: compacted, cooler floor between the berms, a crisp pale-blue line at the floor edge
    {
      float tOn = smoothstep(268.0, 252.0, vTP.z) * smoothstep(-184.0, -170.0, vTP.z);
      if (tOn > 0.0 && camD < 110.0) {
        float aT = abs(vTP.x - routeX(vTP.z, 0.4));
        float tw = trailHalfG(vTP.z);
        float fillT = trailFillG(vTP.z) * tOn * (1.0 - smoothstep(60.0, 110.0, camD)) * (1.0 - m);
        float floorK = (1.0 - smoothstep(tw - 0.85, tw + 0.75, aT)) * fillT;
        float fa = fwidth(aT) + 0.03;
        float edgeK = (1.0 - smoothstep(0.04, 0.12 + fa, abs(aT - (tw + 0.05)))) * fillT;
        float laneK = (1.0 - smoothstep(2.2, 5.2, aT)) * fillT;                 // compacted lane: a cooler, firmer band; the flanks stay fluffy and white
        sn = mix(sn, sn * vec3(0.955, 0.975, 0.995), laneK * 0.8);
        sn = mix(sn, sn * vec3(0.80, 0.875, 0.98), floorK * 0.75);
        sn = mix(sn, sn * vec3(0.76, 0.85, 0.985), edgeK * 0.65);
      }
    }
    // footprints + sled tracks: height-field dimples -> normal tilt (lit rim, shaded crescent), only on gentle snow
    float flatK = smoothstep(0.935, 0.985, flatN) * (1.0 - m);
    float fpK = smoothstep(0.86, 0.93, flatN) * (1.0 - m);              // footprints also dent drift flanks
    if (camD < 60.0 && fpK > 0.01) {
      vec3 fd = footDimple(vTP.xz, -176.0, 246.0, 0.4, (1.0 - smoothstep(14.0, 44.0, camD)) * fpK);
      float tf = (1.0 - smoothstep(26.0, 58.0, camD)) * fpK;
      vec2 t1 = trackGroove(vTP.xz, -186.0, 150.0, 2.1, 1.05, 0.22, tf);
      vec2 t2 = trackGroove(vTP.xz, -186.0, 150.0, 2.1, -1.05, 0.22, tf);
      gFacet += vec3(-fd.x - t1.x - t2.x, 0.0, -fd.y);
      sn = mix(sn, sn * vec3(0.80, 0.89, 1.0), fd.z * 0.20 + (t1.y + t2.y) * 0.14);
    }
    // slow organic swell in the shading normal: big smooth slopes would otherwise draw their cel terminators as straight-edged polygons
    if (camD < 220.0) {
      vec2 sw = vec2(fbm2(vTP.xz * 0.045 + 7.3), fbm2(vTP.xz * 0.045 + 19.1)) - 0.5;
      vec2 sw2 = vec2(fbm2(vTP.xz * 0.13 + 3.3), fbm2(vTP.xz * 0.13 + 41.7)) - 0.5;
      gFacet += vec3(sw.x * 0.34 + sw2.x * 0.14, 0.0, sw.y * 0.34 + sw2.y * 0.14) * (1.0 - m) * (1.0 - smoothstep(70.0, 220.0, camD));
    }
    // wind ripples / sastrugi: normal tilt along the (locally fanning) wind so the cel terminator draws bold pale-blue bands in
    // short drifting patches (never long regular contour lines)
    if (camD < 200.0) {
      float ang = (vn(vTP.xz * 0.025 + 21.0) - 0.5) * 1.5;
      vec2 wd = vec2(cos(ang) * 0.906 - sin(ang) * 0.423, sin(ang) * 0.906 + cos(ang) * 0.423);
      float pw = dot(vTP.xz, wd);
      float pwr = vTP.z * wd.x - vTP.x * wd.y;
      float wob = fbm2(vTP.xz * 0.06) * 9.0 + sin(pwr * 0.07) * 3.0 + sin(pwr * 0.23 + pw * 0.1) * 0.8;
      float f1 = 3.1 * (0.8 + 0.5 * vn(vTP.xz * 0.013 + 4.0));
      float p1 = (pw + wob * 1.4) * f1;
      float aa1 = 1.0 - smoothstep(0.55, 1.3, fwidth(p1));                          // a ripple whose phase runs faster than ~1 rad per pixel would only alias: fade it out
      float d1 = (cos(p1) + 0.45 * cos(2.0 * p1 + 1.3)) * aa1;
      float p2 = (pw * 0.55 + wob * 0.8 + 7.0) * (1.05 + 0.3 * vn(vTP.xz * 0.02 + 8.0));
      float aa2 = 1.0 - smoothstep(0.55, 1.3, fwidth(p2));
      float d2 = (cos(p2) + 0.4 * cos(2.0 * p2 + 0.7)) * aa2;
      float dash = smoothstep(0.40, 0.60, fbm2(vTP.xz * 0.14 + 13.0));
      float mk1 = smoothstep(0.34, 0.50, fbm2(vTP.xz * 0.045 + 3.1)) * dash;
      float mk2 = smoothstep(0.36, 0.56, fbm2(vTP.xz * 0.028 + 9.7)) * smoothstep(0.30, 0.55, fbm2(vTP.xz * 0.09 + 31.0));
      float nk2 = 1.0 - smoothstep(30.0, 100.0, camD);
      float nk3 = 1.0 - smoothstep(60.0, 190.0, camD);
      float ramp1 = 0.55 + 0.45 * vn(vTP.xz * 0.11 + 5.0);
      float leeK = smoothstep(0.02, 0.12, -dot(gr0, vec2(0.906, 0.423)));          // soft lee faces stay smooth, wind-packed windward / flat snow carries the ripples
      vec2 tiltR = wd * (d1 * 0.30 * mk1 * nk2 * ramp1 + d2 * 0.20 * mk2 * nk3) * (1.0 - m) * flatK * (1.0 - 0.7 * leeK);
      float paintR = smoothstep(0.6, 1.0, d1 * 0.5 + 0.5) * mk1 * nk2 * 0.5 + smoothstep(0.62, 1.0, d2 * 0.5 + 0.5) * mk2 * nk3 * 0.3;
      sn = mix(sn, sn * vec3(0.82, 0.90, 1.0), paintR * (1.0 - m) * smoothstep(0.80, 0.93, flatN));
      gFacet += vec3(tiltR.x, 0.0, tiltR.y);
    }
  }
  diffuseColor.rgb = mix(sn, rc, m);
#if TDBG == 1
  diffuseColor.rgb = vec3(m, capK, clamp(dBL / 30.0, 0.0, 1.0));
#elif TDBG == 2
  diffuseColor.rgb = vec3(slopeN, capK, m);
#endif
}`)
    .replace('#include <gradientmap_pars_fragment>', `
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
  float d = dot(normal, lightDirection);
  float fw = fwidth(d) * 0.6 + 0.004;
  float s0 = smoothstep(-0.75 - fw, -0.75 + fw, d) * 0.5 + smoothstep(0.42 - fw, 0.42 + fw, d) * 0.5;
  // rock: painted light / mid / shade regions with soft transitions (snow keeps its crisp cel planes)
  float fr = fw + 0.07;
  float r0 = 0.10 + smoothstep(-0.45 - fr, -0.45 + fr, d) * 0.18 + smoothstep(-0.02 - fr, -0.02 + fr, d) * 0.25
           + smoothstep(0.34 - fr, 0.34 + fr, d) * 0.27 + smoothstep(0.66 - fr, 0.66 + fr, d) * 0.20;
  return vec3(mix(s0, r0, gRockK));
}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * mix(vec3(0.030, 0.050, 0.1175), vec3(0.135, 0.145, 0.235), gRockK);
{
  // soft value drift across low relief that also lives inside cast shadow: faces turned toward the open sky / fill side glow a little,
  // faces turned into the slope sink toward deeper blue (continuous, under the crisp cel bands)
  float fz = dot(-gGr, vec2(0.85, -0.33));
  totalEmissiveRadiance += diffuseColor.rgb * vec3(0.05, 0.075, 0.16) * clamp(fz * 2.2, -0.9, 0.9) * (1.0 - gRockK);
}`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (gSm > 0.5) {
  float dN = distance(vTP, cameraPosition);
  vec3 Ns = normalize((viewMatrix * vec4(normalize(vec3(-gGr.x, 1.0, -gGr.y)), 0.0)).xyz);
  float kS = 1.0 - smoothstep(260.0, 430.0, dN);              // the C2-smooth per-pixel normal carries the cel terminators far out: vertex normals would draw stair-stepped lit patches
  normal = normalize(mix(normal, Ns, kS));
}
normal = normalize(normal + (viewMatrix * vec4(gFacet, 0.0)).xyz);`);
}
export const terrainMaterial = makeTerrainMaterial();       // shared by the far tiles (no gradient texture)
