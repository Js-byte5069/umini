// Stylised cel-shaded materials. One shared 3-tone ramp, cool ambient shadows, painted snow on
// every up-facing surface (so ledges / railings / roofs read as snow-covered without extra meshes).
import * as THREE from 'three';

export const PAL = {
  snow: 0xf6faff,
  snowShade: 0xb4c8f2,
  wall: 0x7f88b2,
  wallLight: 0xa3abd0,
  wallDark: 0x59618e,
  trim: 0xadb4d6,
  metal: 0x484f7c,
  glass: 0x2b376c,
  accent: 0xd4624f,
  accentDark: 0xb04a3f,
  rockBlue: 0x7882b0,
  rockRed: 0xc15a4c,
  rockRedDark: 0x9c473f,
  skyTop: 0x2f6fe4,
  skyMid: 0x5a98f4,
  skyHorizon: 0xaec9f8,
};

// 3-tone cel ramp: shadow / thin terminator band / lit
function makeRamp(shadowBelow = 0.04, litAbove = 0.45) {
  const n = 256;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const ndl = (i / (n - 1)) * 2 - 1;
    data[i] = ndl < shadowBelow ? 0 : ndl < litAbove ? 168 : 255;
  }
  const t = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
export const RAMP = makeRamp();
// terrain: wavy rock walls graze the sun, so keep the dark band for faces that truly turn away
export const RAMP_TERRAIN = makeRamp(-0.75, 0.45);

const NOISE_GLSL = /* glsl */ `
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm2(vec2 p){ return vn(p)*0.55 + vn(p*2.07+3.1)*0.3 + vn(p*4.3+7.7)*0.15; }
`;

// hand-painted look: gradient by height, brush-like colour drift, panel seams, painted snow on up-facing faces, rim light
const PAINT_GLSL = /* glsl */ `
  float topK = vWN.y + 0.05 * sin(vWP.x * 0.7 + vWP.z * 0.3) * sin(vWP.z * 0.9 - vWP.x * 0.2);
  float fw = fwidth(topK) * 0.8 + 0.006;
  float snowA = smoothstep(0.69 - fw, 0.69 + fw, topK) * uSnow;
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
  // wall seams: thin darker lines on near-vertical faces (structural joints, panel edges)
  if (uSeams > 0.5) {
    float vert = 1.0 - smoothstep(0.25, 0.55, abs(vWN.y));
    float lh = abs(fract(vWP.y / 2.7) - 0.5);
    float lv = abs(fract((vWP.x * 0.8 + vWP.z * 0.6) / 3.3) - 0.5);
    float line = (1.0 - smoothstep(0.0, 0.012 * (1.0 + uSeams), lh)) + (1.0 - smoothstep(0.0, 0.012, lv)) * 0.8;
    baseC *= 1.0 - clamp(line, 0.0, 1.0) * vert * 0.16;
    // fine speckle so large flat walls never read as blank
    baseC *= 0.97 + 0.06 * h21(floor(vWP.xz * 6.0 + vWP.y * 3.0));
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

function patchPaint(mat, snow, seams) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = { value: snow };
    sh.uniforms.uSeams = { value: seams };
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
      .replace('#include <common>', '#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;\nuniform float uSnow;\nuniform float uSeams;\n' + NOISE_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + PAINT_GLSL)
      .replace('#include <opaque_fragment>', RIM_GLSL + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'paint' + (snow > 0 ? 's' : 'n') + (seams > 0 ? 'm' : 'x');
}

function toon(color, { snow = 0, emissive = 0x000000, emissiveIntensity = 0, side, seams = 0, paint = true } = {}) {
  const m = new THREE.MeshToonMaterial({
    color, gradientMap: RAMP, vertexColors: true, emissive, emissiveIntensity,
  });
  if (side !== undefined) m.side = side;
  if (paint) patchPaint(m, snow, seams);
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
  accent: toon(PAL.accent, { snow: 0.85 }),
  accentDark: toon(PAL.accentDark, { snow: 0.85 }),
  glass: toon(PAL.glass, { emissive: 0x2a3f9a, emissiveIntensity: 0.35, paint: false }),
  glow: toon(0xff8a6a, { emissive: 0xff6a4a, emissiveIntensity: 1.2, paint: false }),
  rockBlue: toon(PAL.rockBlue, { snow: 1 }),
  rockRed: toon(PAL.rockRed, { snow: 1 }),
  snow: toon(PAL.snow, { paint: false }),
};
// snow geometry should never take the painted-snow patch; plain pale colour with shaded vertex colour
MAT.snow.color.set(0xffffff);

export const terrainMaterial = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: RAMP_TERRAIN });
terrainMaterial.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 tr;\nvarying vec2 vTr;\nvarying vec3 vTP;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n vTr = tr; vTP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec2 vTr;
varying vec3 vTP;
float h11(float n){ return fract(sin(n*12.9898)*43758.5453); }
${NOISE_GLSL}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
{
  float wob = sin(vTP.x*0.11 + vTP.z*0.07)*0.9 + sin(vTP.z*0.19 - vTP.x*0.05)*0.6;
  float bandH = 5.0;
  float yy = vTP.y + wob;
  float band = floor(yy / bandH);
  float seg = floor((vTP.x + vTP.z*0.6) / 46.0);
  bool red = h11(band*3.7 + seg*1.3) < 0.2 && vTP.y > -4.0;
  float bp = fract(yy / bandH);
  vec3 rockA = vec3(0.150, 0.178, 0.372);   // linear-space blue-grey
  vec3 rockB = vec3(0.075, 0.090, 0.215);
  vec3 redA  = vec3(0.560, 0.105, 0.075);
  vec3 redB  = vec3(0.330, 0.062, 0.050);
  float vary = sin(vTP.y*1.7 + sin(vTP.x*0.05 + vTP.z*0.04)*2.0) * 0.5 + 0.5;
  vec3 rc = red ? mix(redA, redB, smoothstep(0.5, 1.0, bp)*0.4) : mix(rockA, rockB, smoothstep(0.55, 1.0, bp)*0.3 + vary*0.1);
  rc *= vTr.y;
  // wind-sculpted snow: faint ripple lines along the dune direction + soft colour drift
  float ang = vTP.x * 0.62 + vTP.z * 0.78;
  float rip = sin(ang * 2.4 + fbm2(vTP.xz * 0.045) * 9.0);
  float ripL = smoothstep(0.93, 1.0, rip) * (1.0 - smoothstep(0.1, 0.7, vTr.x));
  float sd = fbm2(vTP.xz * 0.02 + 11.0) - 0.5;
  diffuseColor.rgb *= 1.0 + sd * 0.10;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.90, 0.94, 1.0), ripL * 0.7);
  float m = smoothstep(0.32, 0.62, vTr.x);
  diffuseColor.rgb = mix(diffuseColor.rgb, rc, m);
}`);
};
terrainMaterial.shadowSide = THREE.FrontSide;
terrainMaterial.customProgramCacheKey = () => 'terrain-strata';
