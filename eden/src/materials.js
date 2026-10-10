// Stylised, hand-painted looking materials. Large clean colour blocks with very low-frequency drift, soft 3-tone ramps
// (LIGHT / MIDTONE / SHADOW with soft transitions), cool lifted shadows, warm sunlit planes, painted snow on every up-facing surface.
import * as THREE from 'three';
import './atmosphere.js';

export const PAL = {
  snow: 0xf8f7fb,
  snowShade: 0xaab6e8,
  wall: 0x72779c,
  wallLight: 0x9a9fbe,
  wallDark: 0x464b6e,
  trim: 0xa0a5c3,
  metal: 0x444968,
  glass: 0x1c2347,
  accent: 0xee7e72,          // coral red-orange (concept swatches #e1706d / #c85b5a), no hot orange
  accentDark: 0xd0626a,      // darker red for the shaded / secondary panels
  rockBlue: 0x7a7fa6,
  rockRed: 0xe07468,
  rockRedDark: 0xb05560,
  skyTop: 0x2f6fe4,
  skyMid: 0x5a98f4,
  skyHorizon: 0xaec9f8,
};

// ── ramps: soft, smoothstep-built tone regions (linear filtered) ─────────────────────────────────
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function rampTex(fn) {
  const n = 256, data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.round(255 * Math.min(1, Math.max(0, fn((i / (n - 1)) * 2 - 1))));
  const t = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
// SHADOW (0) -> MIDTONE (0.74) -> LIGHT (1): two soft terminators
export const RAMP = rampTex((d) => 0.74 * sm(-0.14, 0.10, d) + 0.26 * sm(0.20, 0.44, d));
// rocks: four soft steps so every curved lump still shows shade / core / half-light / light planes, without hard bands
export const RAMP_ROCK = rampTex((d) => 0.20 * sm(-0.54, -0.40, d) + 0.30 * sm(-0.16, -0.02, d) + 0.28 * sm(0.16, 0.30, d) + 0.22 * sm(0.44, 0.58, d));
// the terrain's snow ramp (also used by the debris snow caps): crisp 3 tones, only anti-aliased
export const RAMP_TERRAIN = rampTex((d) => 0.5 * sm(-0.77, -0.73, d) + 0.5 * sm(0.43, 0.47, d));

export const NOISE_GLSL = /* glsl */ `
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm2(vec2 p){ return vn(p)*0.55 + vn(p*2.07+3.1)*0.3 + vn(p*4.3+7.7)*0.15; }
`;

// Tone grade applied after the lights (shared with scatter.js): works from the sun's actual contribution (shadow-map included), so
//   SHADOW  -> a lifted, saturated cool blue-violet (never black / grey)
//   MIDTONE -> the base colour (snow: pale blue-white)
//   LIGHT   -> a touch warmer (snow: warm neutral white)
// Expects: reflectedLight, diffuseColor, outgoingLight in scope; vec3 shade / warm and float snowA given by the caller.
export const GRADE_GLSL = /* glsl */ `
  {
#if NUM_DIR_LIGHTS > 0
    float sunI = max(dot(directionalLights[0].color, vec3(0.3333)) * 0.31831, 0.05);
#else
    float sunI = 0.72;
#endif
    float rel = dot(reflectedLight.directDiffuse, vec3(0.3333)) / (dot(diffuseColor.rgb, vec3(0.3333)) * sunI + 1e-4);
    float litK = smoothstep(0.22, 0.55, rel);          // 0 in shadow .. 1 from the midtone upward
    float sunK = smoothstep(0.80, 1.0, rel);           // 1 in the full-sun band
    vec3 shT = mix(gShade, vec3(0.050, 0.062, 0.100), gSnowA);
    vec3 shA = mix(gShadeAbs, vec3(0.026, 0.032, 0.052), gSnowA);
    vec3 og = outgoingLight + (diffuseColor.rgb * shT + shA) * (1.0 - litK);
    og *= mix(vec3(1.0), mix(gWarm, vec3(1.030, 1.0, 0.962), gSnowA), sunK);
    og *= mix(vec3(1.0), vec3(0.952, 0.974, 1.04), gSnowA * litK * (1.0 - sunK));
    outgoingLight = mix(outgoingLight, og, gGradeK);
  }
`;

// hand-painted look. Everything is low frequency: large clean colour blocks whose drift only shows up close / over long runs.
const PAINT_PARS = /* glsl */ `
varying vec3 vWN;
varying vec3 vWP;
uniform float uSnow;
uniform float uSeams;
uniform float uStrata;
uniform float uSnowTh;
uniform vec3 uBounce;
uniform vec3 uDriftA;
uniform vec3 uDriftB;
uniform vec3 uShade;
uniform vec3 uShadeAbs;
uniform vec3 uWarm;
float gSnowA = 0.0;
float gGradeK = 1.0;
float gLip = 1.0;
vec3 gShade = vec3(0.0);
vec3 gShadeAbs = vec3(0.0);
vec3 gWarm = vec3(1.0);
` + NOISE_GLSL;

const PAINT_GLSL = /* glsl */ `
  {
    vec3 wp = vWP;
    float camD = distance(wp, cameraPosition);
    vec3 baseC = diffuseColor.rgb;
    float vertK = 1.0 - smoothstep(0.30, 0.65, abs(vWN.y));
    // slow world-space colour drift (about 22 m and 6 m blobs): blue-grey / slate blue / cool grey / violet-blue, or muted orange / coral / red
    float dA = vn(wp.xz * 0.043 + wp.y * 0.021 + 3.7);
    float dB = vn(wp.xz * 0.17 + wp.y * 0.12 + 9.1);
    float dr = smoothstep(0.2, 0.8, dA * 0.72 + dB * 0.28);
    baseC *= mix(uDriftA, uDriftB, dr);
    // very slow light / shade washes (60-80 m soft patches, like cloud shadows drifting over the architecture)
    baseC *= 1.0 + (smoothstep(0.30, 0.70, vn(wp.xz * 0.013 + wp.y * 0.006 + 21.0)) - 0.5) * 0.11;
    // soft vertical streaks on steep faces, only legible up close (water / snow-melt running down large panels)
    float stk = vn(vec2(dot(wp.xz, vec2(0.83, 0.56)) * 0.85, wp.y * 0.07 + 2.0));
    baseC *= 1.0 + (stk - 0.5) * 0.10 * vertK * (1.0 - smoothstep(25.0, 80.0, camD));
    // height gradient: heavier / cooler near the ground, lighter and slightly warmer high up
    float hg = smoothstep(-2.0, 46.0, wp.y);
    baseC *= mix(0.88, 1.08, hg);
    baseC = mix(baseC, baseC * vec3(1.03, 1.0, 0.96), hg * 0.5);
    // panel joints: a few faint darker seams on near-vertical faces; derivative-aware so they never moire
    if (uSeams > 0.5) {
      float syy = wp.y / 2.7, suu = (wp.x * 0.8 + wp.z * 0.6) / 3.3;
      float lh = abs(fract(syy) - 0.5), lv = abs(fract(suu) - 0.5);
      float fh = fwidth(syy), fv = fwidth(suu);
      float aaK = 1.0 - smoothstep(0.10, 0.34, max(fh, fv));
      float line = (1.0 - smoothstep(0.0, 0.012 * (1.0 + uSeams) + fh, lh)) + (1.0 - smoothstep(0.0, 0.012 + fv, lv)) * 0.8;
      baseC *= 1.0 - clamp(line, 0.0, 1.0) * vertK * 0.10 * aaK;
    }
    if (uStrata > 0.5) {
      // rock strata: wavy layers, soft per-layer value / hue steps (an occasional warmer or deeper layer), faint bedding lines on steep faces
      float ly = wp.y * 0.9 + fbm2(wp.xz * 0.25) * 1.3 + (vn(wp.xz * 0.8 + 4.0) - 0.5) * 0.9 + (wp.x * 0.3 + wp.z * 0.2) * 0.05;
      float lk = floor(ly), lfr = smoothstep(0.0, 0.18, fract(ly));
      float lh = mix(h21(vec2(lk - 1.0, 3.7)), h21(vec2(lk, 3.7)), lfr);
      float lt = mix(h21(vec2(lk - 1.0, 8.3)), h21(vec2(lk, 8.3)), lfr);
      float lc = mix(h21(vec2(lk - 1.0, 5.1)), h21(vec2(lk, 5.1)), lfr);
      float aaS = 1.0 - smoothstep(0.15, 0.6, fwidth(ly));        // layers fade to their mean once they are about a pixel thick
      baseC *= 1.0 + (0.12 * lh - 0.06) * aaS;
      baseC *= mix(vec3(1.0), mix(vec3(0.92, 0.86, 0.99), vec3(1.05, 1.12, 0.93), lc), smoothstep(0.55, 0.70, lt) * 0.8 * aaS);
      baseC *= 1.0 - (1.0 - smoothstep(0.0, 0.10 + fwidth(ly) * 1.5, fract(ly))) * 0.06 * vertK;
    }
    // painted snow on up-facing surfaces: noise-warped threshold (organic, never ruler straight), soft rounded lip, cool shoulder
    float wob = (vn(wp.xz * 1.9 + wp.y * 1.4 + 11.0) - 0.5) * 0.30 * (1.0 - smoothstep(25.0, 90.0, camD)) + (vn(wp.xz * 5.3 + wp.y * 4.1 + 3.0) - 0.5) * 0.09 * (1.0 - smoothstep(12.0, 45.0, camD));
    float topK = vWN.y + wob;
    float fwT = fwidth(topK) * 0.8 + 0.012;
    float snowA = smoothstep(uSnowTh - fwT, uSnowTh + fwT, topK) * uSnow;
    gLip = smoothstep(uSnowTh, uSnowTh + 0.17, topK);
    gSnowA = snowA;
    // the thickness of the snow shows as a soft cool shadow just under its lip
    float under = smoothstep(uSnowTh - 0.34, uSnowTh - 0.04, topK) * (1.0 - smoothstep(uSnowTh - 0.04, uSnowTh + 0.02, topK));
    baseC *= mix(vec3(1.0), vec3(0.84, 0.89, 0.99), under * 0.85 * uSnow);
    float tn = vn(wp.xz * 0.05 + 40.0);
    vec3 snowC = mix(vec3(0.985, 0.985, 0.992), vec3(0.905, 0.94, 1.0), smoothstep(0.25, 0.75, tn) * 0.7);
    vec3 snowVC = mix(vec3(dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722))), vColor.rgb, 0.35);      // snow keeps the baked value (AO), not the part's hue jitter
    diffuseColor.rgb = mix(baseC, snowC * snowVC, snowA);
    gShade = uShade;
    gShadeAbs = uShadeAbs;
    gWarm = uWarm;
  }
`;

// sky-bounce rim: only a faint cool sheen on up / side planes (no plastic fresnel glow)
const RIM_GLSL = /* glsl */ `
  {
    float nv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
    float rim = pow(1.0 - nv, 4.0);
    outgoingLight += vec3(0.30, 0.42, 0.78) * rim * 0.09 * (0.4 + 0.6 * step(0.3, vWN.y + 0.4));
  }
`;

const VERT_PARS = 'varying vec3 vWN;\nvarying vec3 vWP;';
const VERT_BODY = `#include <begin_vertex>
        vec3 _on = objectNormal;
        vec3 _op = transformed;
        #ifdef USE_INSTANCING
          _on = mat3(instanceMatrix) * _on;
          _op = (instanceMatrix * vec4(_op, 1.0)).xyz;
        #endif
        vWN = normalize(mat3(modelMatrix) * _on);
        vWP = (modelMatrix * vec4(_op, 1.0)).xyz;`;
const BOUNCE_GLSL = '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * uBounce * (0.5 + 0.5 * smoothstep(1.5, -0.5, vWN.y));   // sky/snow bounce so shade never goes flat (hue-preserving)';

function patchPaint(mat, o) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = { value: o.snow };
    sh.uniforms.uSeams = { value: o.seams };
    sh.uniforms.uStrata = { value: o.strata };
    sh.uniforms.uSnowTh = { value: o.snowTh };
    sh.uniforms.uBounce = { value: new THREE.Vector3(...o.bounce) };
    sh.uniforms.uDriftA = { value: new THREE.Vector3(...o.driftA) };
    sh.uniforms.uDriftB = { value: new THREE.Vector3(...o.driftB) };
    sh.uniforms.uShade = { value: new THREE.Vector3(...o.shade) };
    sh.uniforms.uShadeAbs = { value: new THREE.Vector3(...o.shadeAbs) };
    sh.uniforms.uWarm = { value: new THREE.Vector3(...o.warm) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', VERT_BODY);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PAINT_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + PAINT_GLSL)
      .replace('#include <emissivemap_fragment>', BOUNCE_GLSL)
      .replace('#include <opaque_fragment>', RIM_GLSL + GRADE_GLSL + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'paintG1';
}

// structure snow (snowPillow / drifts / run-drifts): same snow colour model, no painted base
const SNOW_PARS = /* glsl */ `
varying vec3 vWN;
varying vec3 vWP;
uniform vec3 uBounce;
float gSnowA = 1.0;
float gGradeK = 1.0;
vec3 gShade = vec3(0.0);
vec3 gShadeAbs = vec3(0.0);
vec3 gWarm = vec3(1.0);
` + NOISE_GLSL;
const SNOW_GLSL = /* glsl */ `
  {
    float s1 = vn(vWP.xz * 0.06 + 5.0), s2 = vn(vWP.xz * 0.23 + 17.0);
    float k = smoothstep(0.25, 0.75, s1 * 0.75 + s2 * 0.25);
    diffuseColor.rgb *= mix(vec3(1.0, 0.995, 0.985), vec3(0.935, 0.962, 1.0), k);
    gSnowA = 1.0;
  }
`;
function patchSnow(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBounce = { value: new THREE.Vector3(0.045, 0.060, 0.100) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', VERT_BODY);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SNOW_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + SNOW_GLSL)
      .replace('#include <emissivemap_fragment>', BOUNCE_GLSL)
      .replace('#include <opaque_fragment>', GRADE_GLSL + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'paintSnowG1';
}

// per-family colour behaviour
const SLATE = { driftA: [0.945, 0.98, 1.065], driftB: [1.055, 1.0, 0.975], shade: [0.140, 0.105, 0.070], shadeAbs: [0.020, 0.018, 0.022], warm: [1.04, 1.0, 0.95], bounce: [0.060, 0.062, 0.075] };
const CORAL = { driftA: [1.02, 1.14, 0.92], driftB: [0.96, 0.88, 1.06], shade: [0.150, 0.060, 0.095], shadeAbs: [0.050, 0.018, 0.032], warm: [1.02, 1.0, 0.97] };
const ROCKRED = { driftA: [1.03, 1.10, 0.92], driftB: [0.96, 0.90, 1.05], shade: [0.155, 0.062, 0.100], shadeAbs: [0.050, 0.018, 0.034], warm: [1.03, 1.0, 0.96] };
const ROCKBLUE = { driftA: [0.97, 0.99, 1.04], driftB: [1.03, 1.0, 0.99], shade: [0.130, 0.100, 0.075], shadeAbs: [0.020, 0.018, 0.026], warm: [1.03, 1.0, 0.96], bounce: [0.060, 0.062, 0.080] };

function toon(color, { snow = 0, emissive = 0x000000, emissiveIntensity = 0, side, seams = 0, paint = true, strata = 0, snowTh = 0.69, ramp = RAMP, bounce, fam = SLATE } = {}) {
  const m = new THREE.MeshToonMaterial({
    color, gradientMap: ramp, vertexColors: true, emissive, emissiveIntensity,
  });
  if (side !== undefined) m.side = side;
  if (paint) patchPaint(m, { snow, seams, strata, snowTh, ...fam, ...(bounce ? { bounce } : {}) });
  return m;
}

// Material library used by the architecture batches
export const MAT = {
  wall: toon(PAL.wall, { snow: 1, seams: 1, snowTh: 0.56 }),
  wallLight: toon(PAL.wallLight, { snow: 1, seams: 1, snowTh: 0.56 }),
  wallDark: toon(PAL.wallDark, { snow: 0.0, seams: 1 }),
  trim: toon(PAL.trim, { snow: 1, seams: 1, snowTh: 0.56 }),
  metal: toon(PAL.metal, { snow: 0.9, snowTh: 0.6 }),
  deck: toon(0x666c92, { seams: 1 }),
  accent: toon(PAL.accent, { snow: 0.85, snowTh: 0.62, bounce: [0.15, 0.05, 0.035], fam: CORAL }),
  accentDark: toon(PAL.accentDark, { snow: 0.85, snowTh: 0.62, bounce: [0.15, 0.05, 0.05], fam: CORAL }),
  glass: toon(PAL.glass, { emissive: 0x26356f, emissiveIntensity: 0.30, paint: false }),
  glow: toon(0xf08670, { emissive: 0xe0644c, emissiveIntensity: 1.0, paint: false }),
  rockBlue: toon(PAL.rockBlue, { snow: 1, strata: 1, snowTh: 0.83, ramp: RAMP_ROCK, fam: ROCKBLUE }),
  rockRed: toon(PAL.rockRed, { snow: 1, strata: 1, snowTh: 0.83, ramp: RAMP_ROCK, bounce: [0.10, 0.05, 0.05], fam: ROCKRED }),
  // near-LOD rocks carry real snow-cap meshes: no painted snow on top of them (its normal-based contour would show polygon edges)
  rockBlueN: toon(PAL.rockBlue, { snow: 0, strata: 1, ramp: RAMP_ROCK, fam: ROCKBLUE }),
  rockRedN: toon(PAL.rockRed, { snow: 0, strata: 1, ramp: RAMP_ROCK, bounce: [0.10, 0.05, 0.05], fam: ROCKRED }),
  snow: toon(PAL.snow, { paint: false }),
};
// snow geometry never takes the painted-snow patch; it has its own colour model: warm neutral white in sun, pale blue-white midtone, lavender shade
MAT.snow.color.set(0xffffff);
patchSnow(MAT.snow);
