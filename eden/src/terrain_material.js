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
  m.customProgramCacheKey = () => 'terrain-lanes1';
  return m;
}
function terrainCompile(mat, sh) {
  sh.uniforms.uNTex = { value: _noTex };
  sh.uniforms.uChunk = { value: new THREE.Vector4(0, 0, 64, 129) };
  sh.uniforms.uTexOn = { value: 0 };
  mat.userData.uniforms = sh.uniforms;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 tr;\nvarying vec4 vTr;\nvarying vec3 vTP;\nvarying vec3 vTN;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n vTr = tr; vTP = (modelMatrix * vec4(transformed, 1.0)).xyz; vTN = objectNormal;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec4 vTr;
varying vec3 vTP;
varying vec3 vTN;
uniform sampler2D uNTex;
uniform vec4 uChunk;      // chunk origin x, z, size, node count
uniform float uTexOn;
float gRockK = 0.0;
vec3 gFacet = vec3(0.0);
vec2 gGr = vec2(0.0);       // smooth height gradient at this pixel (already exaggerated for gentle snow)
float h11(float n){ return fract(sin(n*12.9898)*43758.5453); }
float h31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
${NOISE_GLSL}
float svn3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i), h31(i+vec3(1,0,0)), f.x), mix(h31(i+vec3(0,1,0)), h31(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i+vec3(0,0,1)), h31(i+vec3(1,0,1)), f.x), mix(h31(i+vec3(0,1,1)), h31(i+vec3(1,1,1)), f.x), f.y), f.z); }
vec3 hT(vec3 c){ return vec3(h31(c + 3.1) - 0.5, (h31(c + 11.7) - 0.4) * 0.6, h31(c + 23.9) - 0.5); }
// planar facet tilt per brick cell with narrow rounded blends across the vertical borders (crisp planes, soft seams)
vec3 facetBlend(vec3 q, float bw) {
  vec3 i = floor(q); vec3 u = fract(q) - 0.5;
  vec2 w = 0.5 * smoothstep(0.5 - bw, 0.5, abs(u.xz));
  vec2 sg = sign(u.xz);
  vec3 a = hT(i), b = hT(i + vec3(sg.x, 0.0, 0.0)), c = hT(i + vec3(0.0, 0.0, sg.y)), d = hT(i + vec3(sg.x, 0.0, sg.y));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
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
// ── strata: one block of one layer. x = red amount, y = vertical joint line, z = per-block value shade
float redOfBlock(float bid, float lk, float lf, float eF){
  float layerRed = step(h11(lk * 3.71 + 0.5), 0.33);
  float on = step(h31(vec3(bid, lk, 3.3)), 0.58);
  float a0 = 0.03 + 0.5 * h31(vec3(bid, lk, 5.1));
  float a1 = min(1.04, a0 + 0.22 + 0.58 * h31(vec3(bid, lk, 9.7)));
  return layerRed * on * smoothstep(a0 - eF, a0 + eF, lf) * (1.0 - smoothstep(a1 - eF, a1 + eF, lf));
}
vec3 strataCell(float wu, float fwu, float lk, float lf, float eF){
  float bw = 5.5 + 9.0 * h11(lk * 1.71 + 0.3);
  float u = wu / bw + h11(lk * 9.1) * 7.0;
  float bid = floor(u), bf = fract(u);
  float e = fwu / bw * 1.3 + 0.003;
  float dj = min(bf, 1.0 - bf);
  float nb = bf < 0.5 ? bid - 1.0 : bid + 1.0;
  float wNb = 0.5 * (1.0 - smoothstep(0.0, e, dj));
  float r0 = redOfBlock(bid, lk, lf, eF), r1 = redOfBlock(nb, lk, lf, eF);
  float s0 = h31(vec3(bid, lk, 1.7)), s1 = h31(vec3(nb, lk, 1.7));
  return vec3(mix(r0, r1, wNb), 1.0 - smoothstep(0.0, e * 1.7, dj), mix(s0, s1, wNb));
}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 N0 = normalize(vTN);
  float camD = distance(vTP, cameraPosition);
  // snow shading normal: the C2-smooth per-pixel gradient field, gently exaggerated on low relief so swells / lumps / berms draw bold cel bands
  vec2 gr0 = vec2(0.0);
  vec3 Nsn = N0;
  float flatN = N0.y;                 // un-exaggerated smooth slope measure (gates footprints / ripples)
  float holT = vTr.z;
  if (uTexOn > 0.5 && camD < 130.0) {
    vec4 gs = sampleGradSmooth(vTP.xz);
    gr0 = gs.xy;
    holT = gs.w + gs.z * 0.5;
    float gl0 = length(gr0);
    float kEx = 1.0 + 1.15 * (1.0 - smoothstep(0.14, 0.5, gl0)) * (1.0 - smoothstep(60.0, 130.0, camD));
    gGr = gr0 * kEx;
    Nsn = normalize(vec3(-gGr.x, 1.0, -gGr.y));
    flatN = 1.0 / sqrt(1.0 + dot(gr0, gr0));
  }
  float hol = clamp(holT, -1.0, 1.0);
  // wall-aligned horizontal coordinate: pick the rotated grid axis that runs along the wall, so patterns are never stretched on steep faces
  vec2 nh = normalize(N0.xz + vec2(1e-4, 0.0));
  const float CR = 0.9396926, SR = 0.3420201;
  vec2 pr = vec2(vTP.x * CR + vTP.z * SR, -vTP.x * SR + vTP.z * CR);
  vec2 nr = vec2(nh.x * CR + nh.y * SR, -nh.x * SR + nh.y * CR);
  float wX = smoothstep(0.40, 0.60, nr.y * nr.y / (nr.x * nr.x + nr.y * nr.y + 1e-5));    // 1 when the wall runs along the rotated x axis
  float fwx = fwidth(pr.x), fwz = fwidth(pr.y);
  float Lc = max(vTr.w, 0.0);
  float lk = floor(Lc - 0.002);
  float lf = clamp(Lc - lk, 0.0, 1.0);
  float eF = fwidth(Lc) * 1.5 + 0.006;
  // rock mask: the blurred slope mask thresholded with an anti-aliased crisp contour + a slow 3D wobble (no per-triangle teeth)
  float msk = vTr.x + (svn3(vTP * 0.21) - 0.5) * 0.16 + (svn3(vTP * 0.9) - 0.5) * 0.05;
  float fm = fwidth(msk) * 1.2 + 0.015;
  float m = smoothstep(0.5 - fm, 0.5 + fm, msk);
  gRockK = m;
  vec3 rc = vec3(0.0);
  float detailK = 1.0 - smoothstep(160.0, 520.0, camD);
  float bedP = lf * (2.0 + 3.0 * h11(lk * 2.3)) + 0.35 * vn(vec2((wX > 0.5 ? pr.x : pr.y) * 0.17, lk * 3.1));
  float fb = fwidth(bedP);
  // ── rock: layers follow the modelled ledges; chunky vertical blocks; red strata start/stop at block joints ──
  if (m > 0.002) {
    float lt = h11(lk * 7.13 + 2.0) * 0.82 + 0.18 * vn(vTP.xz * 0.011 + lk * 5.0);
    vec3 rockLo = vec3(0.080, 0.098, 0.225), rockMid = vec3(0.160, 0.190, 0.345), rockHi = vec3(0.275, 0.310, 0.505);
    rc = lt < 0.30 ? rockLo : (lt < 0.68 ? rockMid : rockHi);
    vec3 redA = vec3(0.575, 0.112, 0.078), redB = vec3(0.385, 0.075, 0.058);
    // along-wall block pattern: evaluate both axes, weighted by wall orientation
    vec3 cx = strataCell(pr.x, fwx, lk, lf, eF);
    vec3 cz = strataCell(pr.y + 31.7, fwz, lk + 17.0, lf, eF);
    vec3 cell = mix(cz, cx, wX);
    float baseShade = mix(0.74, 1.10, smoothstep(0.0, 0.92, lf));      // each layer is darker at its base, lighter toward its lip
    rc *= baseShade;
    // bedding planes inside the layer: a few thin darker lines, anti-aliased and faded when sub-pixel
    float bed = (1.0 - smoothstep(0.0, 0.05 + fb * 1.4, fract(bedP))) * (1.0 - smoothstep(0.15, 0.45, fb));
    float steepK = 1.0 - smoothstep(0.16, 0.42, N0.y);                 // layer decoration only on genuinely steep faces (never on slanted jogs / shoulders)
    rc *= 1.0 - bed * 0.13 * steepK;
    rc *= 0.90 + 0.18 * mix(0.5, cell.z, 1.0 - smoothstep(0.30, 0.6, N0.y));       // per-block value (calm on gentle slopes)
    float redK = cell.x;
    if (redK > 0.001) rc = mix(rc, mix(redA, redB, h11(lk * 5.0) * 0.6) * mix(0.85, 1.08, smoothstep(0.0, 0.9, lf)), redK);
    rc *= 1.0 - cell.y * 0.16 * (1.0 - smoothstep(70.0, 260.0, camD));   // chiselled vertical joints (fade out: at distance they would read as a comb)
    // overhang shadow under the lip + lit lip edge
    float under = smoothstep(0.76 - eF, 0.76 + eF, lf) * (1.0 - smoothstep(0.94 - eF, 0.94 + eF, lf));
    float lipK = smoothstep(0.94 - eF, 0.94 + eF, lf);
    rc *= 1.0 - under * 0.20 * steepK;
    rc = mix(rc, rc * 1.35 + vec3(0.02, 0.025, 0.04), lipK * 0.8 * steepK);
    // weathering streaks running down the faces (mapped along the wall, not smeared)
    float sx = (wX > 0.5 ? pr.x : pr.y) * 1.4;
    float stk = vn(vec2(sx, vTP.y * 0.16 + lk * 2.0));
    rc *= 1.0 - smoothstep(0.62, 0.78, stk) * 0.10 * detailK * (1.0 - smoothstep(0.12, 0.40, fwidth(sx)));
    rc *= 1.0 - clamp(vTr.z, 0.0, 1.0) * 0.30 + clamp(-vTr.z, 0.0, 1.0) * 0.26;   // cavities dark, lips bright
    rc *= vTr.y;
    // chiselled facets: planar tilt per cell (big blocks dominate, small ones accent) for crisp cel planes
    vec3 q = vec3(vTP.x * 0.866 - vTP.z * 0.5, vTP.y, vTP.x * 0.5 + vTP.z * 0.866) / vec3(5.2, 3.3, 5.2);
    float rowH = h11(floor(q.y) * 1.93 + 4.1);
    q.x = q.x / (0.75 + 0.7 * rowH) + floor(q.y) * 0.37; q.z = q.z / (0.75 + 0.7 * rowH) + floor(q.y) * 0.53;
    vec3 tl = facetBlend(q, 0.30);
    vec3 qb = vec3(vTP.x * 0.940 + vTP.z * 0.342, vTP.y, -vTP.x * 0.342 + vTP.z * 0.940) / vec3(13.0, 8.0, 13.0);
    qb.x += floor(qb.y) * 0.41;
    vec3 tb = facetBlend(qb, 0.22);
    gFacet = (tl * 0.20 + tb * 0.85) * m * (1.0 - smoothstep(0.22, 0.50, N0.y));
  }
  // ── snow: pale-blue hollows, lit crests that stay below clipping, bold sastrugi, dimpled footprints / sled tracks ──
  vec3 sn = diffuseColor.rgb * vec3(0.948, 0.968, 0.992);
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
      float sk = (1.0 - smoothstep(120.0, 380.0, camD)) * (1.0 - m);
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
      float d1 = cos(p1) + 0.45 * cos(2.0 * p1 + 1.3);
      float p2 = (pw * 0.55 + wob * 0.8 + 7.0) * (1.05 + 0.3 * vn(vTP.xz * 0.02 + 8.0));
      float d2 = cos(p2) + 0.4 * cos(2.0 * p2 + 0.7);
      float dash = smoothstep(0.40, 0.60, fbm2(vTP.xz * 0.14 + 13.0));
      float mk1 = smoothstep(0.34, 0.50, fbm2(vTP.xz * 0.045 + 3.1)) * dash;
      float mk2 = smoothstep(0.36, 0.56, fbm2(vTP.xz * 0.028 + 9.7)) * smoothstep(0.30, 0.55, fbm2(vTP.xz * 0.09 + 31.0));
      float nk2 = 1.0 - smoothstep(30.0, 100.0, camD);
      float nk3 = 1.0 - smoothstep(60.0, 190.0, camD);
      float ramp1 = 0.55 + 0.45 * vn(vTP.xz * 0.11 + 5.0);
      float leeK = smoothstep(0.02, 0.12, -dot(gr0, vec2(0.906, 0.423)));          // soft lee faces stay smooth, wind-packed windward / flat snow carries the ripples
      vec2 tiltR = wd * (d1 * 0.30 * mk1 * nk2 * ramp1 + d2 * 0.20 * mk2 * nk3) * (1.0 - m) * flatK * (1.0 - 0.7 * leeK);
      float paintR = smoothstep(0.6, 1.0, d1 * 0.5 + 0.5) * mk1 * nk2 * 0.5 + smoothstep(0.62, 1.0, d2 * 0.5 + 0.5) * mk2 * nk3 * 0.3;
      sn = mix(sn, sn * vec3(0.82, 0.90, 1.0), paintR * (1.0 - m));
      gFacet += vec3(tiltR.x, 0.0, tiltR.y);
    }
  }
  // snow drape hanging over each ledge lip: rounded scallops
  float drapeEdge = 0.915 + 0.055 * vn(vec2((wX > 0.5 ? pr.x : pr.y) * 0.8, lk * 3.3)) * (1.0 - smoothstep(60.0, 220.0, camD));
  float drape = smoothstep(drapeEdge - eF, drapeEdge + eF, lf) * step(0.5, lk + 0.5);
  // at distance the per-vertex layer coordinate is too coarse to draw a clean overhang edge on steep faces (it would drip): keep the snow cap on gentle ground only
  drape *= mix(1.0, smoothstep(0.12, 0.42, N0.y), smoothstep(90.0, 220.0, camD));
  diffuseColor.rgb = mix(sn, rc, m * (1.0 - drape * 0.95));
}`)
    .replace('#include <gradientmap_pars_fragment>', `
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
  float d = dot(normal, lightDirection);
  float fw = fwidth(d) * 0.6 + 0.004;
  float s0 = smoothstep(-0.75 - fw, -0.75 + fw, d) * 0.5 + smoothstep(0.42 - fw, 0.42 + fw, d) * 0.5;
  float r0 = smoothstep(-0.45 - fw, -0.45 + fw, d) * 0.18 + smoothstep(-0.02 - fw, -0.02 + fw, d) * 0.27
           + smoothstep(0.34 - fw, 0.34 + fw, d) * 0.30 + smoothstep(0.66 - fw, 0.66 + fw, d) * 0.25;
  return vec3(mix(s0, r0, gRockK));
}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vec3(0.060, 0.100, 0.235) * (0.5 + 1.1 * gRockK);
{
  // soft value drift across low relief that also lives inside cast shadow: faces turned toward the open sky / fill side glow a little,
  // faces turned into the slope sink toward deeper blue (continuous, under the crisp cel bands)
  float fz = dot(-gGr, vec2(0.85, -0.33));
  totalEmissiveRadiance += diffuseColor.rgb * vec3(0.05, 0.075, 0.16) * clamp(fz * 2.2, -0.9, 0.9) * (1.0 - gRockK);
}`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (uTexOn > 0.5 && gRockK < 0.98) {
  float dN = distance(vTP, cameraPosition);
  if (dN < 130.0) {
    vec3 Ns = normalize((viewMatrix * vec4(normalize(vec3(-gGr.x, 1.0, -gGr.y)), 0.0)).xyz);
    normal = normalize(mix(normal, Ns, (1.0 - gRockK) * (1.0 - smoothstep(80.0, 130.0, dN))));
  }
}
normal = normalize(normal + (viewMatrix * vec4(gFacet, 0.0)).xyz);`);
}
export const terrainMaterial = makeTerrainMaterial();       // shared by the far tiles (no gradient texture)
