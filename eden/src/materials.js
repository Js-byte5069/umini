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
function makeRamp() {
  const n = 256;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const ndl = (i / (n - 1)) * 2 - 1;
    data[i] = ndl < 0.04 ? 0 : ndl < 0.45 ? 168 : 255;
  }
  const t = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
export const RAMP = makeRamp();

const SNOW_GLSL = /* glsl */ `
  float topK = vWN.y + 0.05 * sin(vWP.x * 0.7 + vWP.z * 0.3) * sin(vWP.z * 0.9 - vWP.x * 0.2);
  float fw = fwidth(topK) * 0.8 + 0.006;
  float snowA = smoothstep(0.69 - fw, 0.69 + fw, topK) * uSnow;
  float tint = 0.5 + 0.5 * sin(vWP.x * 0.045 + vWP.z * 0.031);
  vec3 snowCol = mix(vec3(0.965, 0.985, 1.0), vec3(0.83, 0.89, 0.99), tint * 0.55);
  diffuseColor.rgb = mix(diffuseColor.rgb, snowCol * vColor.rgb, snowA);
`;

function patchSnow(mat, amount) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = { value: amount };
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
      .replace('#include <common>', '#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;\nuniform float uSnow;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + SNOW_GLSL);
  };
  mat.customProgramCacheKey = () => 'snowtop';
}

function toon(color, { snow = 0, emissive = 0x000000, emissiveIntensity = 0, side } = {}) {
  const m = new THREE.MeshToonMaterial({
    color, gradientMap: RAMP, vertexColors: true, emissive, emissiveIntensity,
  });
  if (side !== undefined) m.side = side;
  if (snow > 0) patchSnow(m, snow);
  return m;
}

// Material library used by the architecture batches
export const MAT = {
  wall: toon(PAL.wall, { snow: 1 }),
  wallLight: toon(PAL.wallLight, { snow: 1 }),
  wallDark: toon(PAL.wallDark, { snow: 0.0 }),
  trim: toon(PAL.trim, { snow: 1 }),
  metal: toon(PAL.metal, { snow: 0.9 }),
  deck: toon(0x6d76a2),
  accent: toon(PAL.accent, { snow: 0.85 }),
  accentDark: toon(PAL.accentDark, { snow: 0.85 }),
  glass: toon(PAL.glass, { emissive: 0x2a3f9a, emissiveIntensity: 0.35 }),
  glow: toon(0xff8a6a, { emissive: 0xff6a4a, emissiveIntensity: 1.2 }),
  rockBlue: toon(PAL.rockBlue, { snow: 1 }),
  rockRed: toon(PAL.rockRed, { snow: 1 }),
  snow: toon(PAL.snow),
};
// snow geometry should never take the painted-snow patch; plain pale colour with shaded vertex colour
MAT.snow.color.set(0xffffff);

export const terrainMaterial = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: RAMP });
terrainMaterial.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 tr;\nvarying vec2 vTr;\nvarying vec3 vTP;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n vTr = tr; vTP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec2 vTr;
varying vec3 vTP;
float h11(float n){ return fract(sin(n*12.9898)*43758.5453); }`)
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
  vec3 rc = red ? mix(redA, redB, smoothstep(0.5, 1.0, bp)*0.65) : mix(rockA, rockB, smoothstep(0.55, 1.0, bp)*0.7);
  rc *= vTr.y;
  float m = smoothstep(0.32, 0.62, vTr.x);
  diffuseColor.rgb = mix(diffuseColor.rgb, rc, m);
}`);
};
terrainMaterial.customProgramCacheKey = () => 'terrain-strata';
