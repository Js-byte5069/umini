// Stylised cel-shaded materials. One shared 3-tone ramp, cool ambient shadows, painted snow on
// every up-facing surface (so ledges / railings / roofs read as snow-covered without extra meshes).
import * as THREE from 'three';
import './atmosphere.js';

export const PAL = {
  snow: 0xf6faff,
  snowShade: 0xb4c8f2,
  wall: 0x7f88b2,
  wallLight: 0xa3abd0,
  wallDark: 0x59618e,
  trim: 0xadb4d6,
  metal: 0x484f7c,
  glass: 0x2b376c,
  accent: 0xd4623e,
  accentDark: 0xb04a34,
  rockBlue: 0x7882b0,
  rockRed: 0xc15a47,
  rockRedDark: 0x9c473a,
  skyTop: 0x2f6fe4,
  skyMid: 0x5a98f4,
  skyHorizon: 0xaec9f8,
};

// 3-tone cel ramp: shadow / thin terminator band / lit
function makeRamp(shadowBelow = 0.04, litAbove = 0.45, mid = 168) {
  const n = 256;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const ndl = (i / (n - 1)) * 2 - 1;
    data[i] = ndl < shadowBelow ? 0 : ndl < litAbove ? mid : 255;
  }
  const t = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
export const RAMP = makeRamp();
// 5-tone ramp for rocks: every curved lump shows 3-4 crisp bands (shade / core / half-light / light) instead of one flat colour
function makeRampRock() {
  const n = 256, data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = (i / (n - 1)) * 2 - 1;
    data[i] = Math.round(255 * ((d > -0.40 ? 0.15 : 0) + (d > 0.0 ? 0.27 : 0) + (d > 0.34 ? 0.30 : 0) + (d > 0.62 ? 0.28 : 0)));
  }
  const t = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
export const RAMP_ROCK = makeRampRock();
// terrain: wavy rock walls graze the sun, so keep the dark band for faces that truly turn away
export const RAMP_TERRAIN = makeRamp(-0.75, 0.45, 128);

export const NOISE_GLSL = /* glsl */ `
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm2(vec2 p){ return vn(p)*0.55 + vn(p*2.07+3.1)*0.3 + vn(p*4.3+7.7)*0.15; }
`;

// hand-painted look: gradient by height, brush-like colour drift, panel seams, painted snow on up-facing faces, rim light
const PAINT_GLSL = /* glsl */ `
  float topK = vWN.y + 0.05 * sin(vWP.x * 0.7 + vWP.z * 0.3) * sin(vWP.z * 0.9 - vWP.x * 0.2);
  float fw = fwidth(topK) * 0.8 + 0.006;
  float snowA = smoothstep(uSnowTh - fw, uSnowTh + fw, topK) * uSnow;
  vec3 baseC = diffuseColor.rgb;
  // brush drift: low-freq value/hue variation along the surface (stretched vertically like strokes)
  vec2 bp = vec2(vWP.x * 0.11 + vWP.z * 0.09, vWP.y * 0.32);
  float drift = fbm2(bp) - 0.5;
  baseC *= 1.0 + drift * 0.26;
  baseC += vec3(-0.01, 0.0, 0.02) * drift;
  // height gradient: heavier/cooler at the base, lighter and slightly warmer high up
  float hg = smoothstep(-2.0, 46.0, vWP.y);
  baseC *= mix(0.84, 1.10, hg);
  baseC = mix(baseC, baseC * vec3(1.04, 1.0, 0.95), hg * 0.5);
  // wall seams: thin darker lines on near-vertical faces (structural joints, panel edges); derivative-aware so they never moire at distance
  if (uSeams > 0.5) {
    float vert = 1.0 - smoothstep(0.25, 0.55, abs(vWN.y));
    float syy = vWP.y / 2.7, suu = (vWP.x * 0.8 + vWP.z * 0.6) / 3.3;
    float lh = abs(fract(syy) - 0.5), lv = abs(fract(suu) - 0.5);
    float fh = fwidth(syy), fv = fwidth(suu);
    float aaK = 1.0 - smoothstep(0.10, 0.34, max(fh, fv));
    float line = (1.0 - smoothstep(0.0, 0.012 * (1.0 + uSeams) + fh, lh)) + (1.0 - smoothstep(0.0, 0.012 + fv, lv)) * 0.8;
    baseC *= 1.0 - clamp(line, 0.0, 1.0) * vert * 0.16 * aaK;
    // fine speckle so large flat walls never read as blank, but only while a cell is clearly larger than a pixel
    float spK = 1.0 - smoothstep(0.12, 0.40, fwidth(vWP.x * 6.0 + vWP.z * 6.0 + vWP.y * 3.0));
    baseC *= 1.0 + (h21(floor(vWP.xz * 6.0 + vWP.y * 3.0)) - 0.5) * 0.06 * spK;
  }
  if (uStrata > 0.5) {
    // rock strata: thin darker bedding lines + per-layer value shifts on steep faces
    float ly = vWP.y * 0.85 + fbm2(vWP.xz * 0.3) * 0.9 + (vWP.x * 0.3 + vWP.z * 0.2) * 0.05;
    float lf = fract(ly);
    float vert = 1.0 - smoothstep(0.3, 0.7, abs(vWN.y));
    baseC *= 1.0 - (1.0 - smoothstep(0.0, 0.05 + fwidth(ly) * 1.5, lf)) * 0.16 * vert;
    baseC *= 0.93 + 0.12 * h21(vec2(floor(ly), 3.7));
  }
  float tint = 0.5 + 0.5 * sin(vWP.x * 0.045 + vWP.z * 0.031);
  vec3 snowCol = mix(vec3(0.965, 0.985, 1.0), vec3(0.83, 0.89, 0.99), tint * 0.55);
  diffuseColor.rgb = mix(baseC, snowCol * vColor.rgb, snowA);
`;

const RIM_GLSL = /* glsl */ `
  {
    float nv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
    float rim = pow(1.0 - nv, 3.0);
    outgoingLight += vec3(0.30, 0.42, 0.78) * rim * 0.20 * (0.4 + 0.6 * step(0.3, vWN.y + 0.4));
  }
`;

function patchPaint(mat, snow, seams, strata = 0, snowTh = 0.69, bounce = [0.055, 0.078, 0.16]) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = { value: snow };
    sh.uniforms.uSeams = { value: seams };
    sh.uniforms.uStrata = { value: strata };
    sh.uniforms.uSnowTh = { value: snowTh };
    sh.uniforms.uBounce = { value: new THREE.Vector3(...bounce) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 _on = objectNormal;
        vec3 _op = transformed;
        #ifdef USE_INSTANCING
          _on = mat3(instanceMatrix) * _on;
          _op = (instanceMatrix * vec4(_op, 1.0)).xyz;
        #endif
        vWN = normalize(mat3(modelMatrix) * _on);
        vWP = (modelMatrix * vec4(_op, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;\nuniform float uSnow;\nuniform float uSeams;\nuniform float uStrata;\nuniform float uSnowTh;\nuniform vec3 uBounce;\n' + NOISE_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + PAINT_GLSL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * uBounce * (0.5 + 0.5 * smoothstep(1.5, -0.5, vWN.y));   // sky/snow bounce so shade never goes flat (hue-preserving for the accent paint)')
      .replace('#include <opaque_fragment>', RIM_GLSL + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'paintF' + (snow > 0 ? 's' : 'n') + (seams > 0 ? 'm' : 'x') + (strata > 0 ? 'r' : 'q') + snowTh;
}

function toon(color, { snow = 0, emissive = 0x000000, emissiveIntensity = 0, side, seams = 0, paint = true, strata = 0, snowTh = 0.69, ramp = RAMP, bounce } = {}) {
  const m = new THREE.MeshToonMaterial({
    color, gradientMap: ramp, vertexColors: true, emissive, emissiveIntensity,
  });
  if (side !== undefined) m.side = side;
  if (paint) patchPaint(m, snow, seams, strata, snowTh, bounce);
  return m;
}

// Material library used by the architecture batches
export const MAT = {
  wall: toon(PAL.wall, { snow: 1, seams: 1 }),
  wallLight: toon(PAL.wallLight, { snow: 1, seams: 1 }),
  wallDark: toon(PAL.wallDark, { snow: 0.0, seams: 1 }),
  trim: toon(PAL.trim, { snow: 1, seams: 1 }),
  metal: toon(PAL.metal, { snow: 0.9 }),
  deck: toon(0x6d76a2, { seams: 1 }),
  accent: toon(PAL.accent, { snow: 0.85, bounce: [0.15, 0.05, 0.012] }),
  accentDark: toon(PAL.accentDark, { snow: 0.85, bounce: [0.15, 0.05, 0.012] }),
  glass: toon(PAL.glass, { emissive: 0x2a3f9a, emissiveIntensity: 0.35, paint: false }),
  glow: toon(0xff8a6a, { emissive: 0xff6a4a, emissiveIntensity: 1.2, paint: false }),
  rockBlue: toon(PAL.rockBlue, { snow: 1, strata: 1, snowTh: 0.83, ramp: RAMP_ROCK }),
  rockRed: toon(PAL.rockRed, { snow: 1, strata: 1, snowTh: 0.83, ramp: RAMP_ROCK, bounce: [0.10, 0.05, 0.045] }),
  // near-LOD rocks carry real snow-cap meshes: no painted snow on top of them (its normal-based contour would show polygon edges)
  rockBlueN: toon(PAL.rockBlue, { snow: 0, strata: 1, ramp: RAMP_ROCK }),
  rockRedN: toon(PAL.rockRed, { snow: 0, strata: 1, ramp: RAMP_ROCK, bounce: [0.10, 0.05, 0.045] }),
  snow: toon(PAL.snow, { paint: false }),
};
// snow geometry should never take the painted-snow patch; plain pale colour with shaded vertex colour
MAT.snow.color.set(0xffffff);
