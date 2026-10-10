// Atmospheric perspective: replaces three's fog chunks globally (every fog-enabled material picks this up).
// Imported for its side effect by materials.js, so it is installed before any shader compiles.
//
// This is NOT a flat colour mix. Per pixel it integrates a height-aware haze along the view ray and applies it as
//   1. aerial desaturation  (far colours lose chroma first),
//   2. in-scatter toward a haze colour that matches the sky dome at the same view elevation (silhouettes dissolve into the horizon),
//      slightly bluer when looking up, slightly warmer toward the sun,
//   3. thicker haze low (valley / ground haze) and thinner with altitude,
// so foreground stays crisp and saturated (< ~40 m untouched), the midground lightens, and the far rim / spires merge with the sky.
// Tuned through THREE.Fog: fogNear = clear distance, fogFar = haze length scale (distance of ~63% haze at the reference altitude).
import * as THREE from 'three';

const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const num = (k, d) => (q.has(k) ? parseFloat(q.get(k)) : d);
const F = (v) => v.toFixed(4);

// shared with sky.js (the dome paints the same haze colour at the horizon)
export const HAZE = {
  zenithBlue: [0.30, 0.50, 0.93],             // linear colour hazy rays drift to when looking up (matches the dome's lower sky)
  sun: new THREE.Vector3(-0.78, 0.55, 0.1).normalize(),
  power: num('hzp', 1.18),                    // growth exponent of the haze with distance
  heightScale: num('hzh', 110),               // m: haze thins out with altitude on this scale
  groundK: num('hzg', 0.32),                  // extra low-lying haze (valley fog) at distance
  groundScale: num('hzgs', 34),               // m
  desat: num('hzd', 0.30),                    // chroma lost at full haze
  cloudShade: num('csh', 0.85),               // strength of the big soft cloud-shadow patches on lit ground (0 = off)
};

THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying vec3 vFogV;
#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogV = mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec3 vFogV;
  float fgH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float fgN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(fgH(i), fgH(i + vec2(1.0, 0.0)), f.x), mix(fgH(i + vec2(0.0, 1.0)), fgH(i + vec2(1.0, 1.0)), f.x), f.y); }
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  {
    float fgDist = length(vFogV);
    vec3 fgW = transpose(mat3(viewMatrix)) * vFogV;               // world-space offset camera -> fragment
    vec3 fgR = fgW / max(fgDist, 1e-3);
    float fgYm = cameraPosition.y + fgW.y * 0.5;                  // mean altitude of the ray
    float fgYf = cameraPosition.y + fgW.y;                        // altitude of the fragment
    float fgD = max(fgDist - fogNear, 0.0);
    float fgTau = pow(fgD / fogFar, ${F(HAZE.power)});
    fgTau *= 0.46 + 0.80 * exp(-max(fgYm, 0.0) / ${F(HAZE.heightScale)});
    float fgK = 1.0 - exp(-fgTau);
    // valley / ground haze: low fragments far away sink further into the haze (bases of far spires and mesas go pale first)
    float fgG = ${F(HAZE.groundK)} * exp(-max(fgYf, 0.0) / ${F(HAZE.groundScale)}) * smoothstep(70.0, 420.0, fgDist);
    fgK = 1.0 - (1.0 - fgK) * (1.0 - fgG);
    fgK = clamp(fgK, 0.0, 1.0);
    // haze colour: the dome's horizon colour, drifting bluer with elevation and a touch warmer / brighter toward the sun
    float fgUp = smoothstep(0.0, 0.5, fgR.y);
    vec3 fgC = mix(fogColor, vec3(${F(HAZE.zenithBlue[0])}, ${F(HAZE.zenithBlue[1])}, ${F(HAZE.zenithBlue[2])}), fgUp * 0.55);
    float fgS = pow(max(dot(fgR, vec3(${F(HAZE.sun.x)}, ${F(HAZE.sun.y)}, ${F(HAZE.sun.z)})), 0.0), 5.0);
    fgC += vec3(0.060, 0.052, 0.022) * fgS * (1.0 - fgUp * 0.6);
    vec3 fgIn = gl_FragColor.rgb;
    float fgL = dot(fgIn, vec3(0.2126, 0.7152, 0.0722));
    // big soft cloud-shadow patches: broken light / shade regions across the land (the shadows of the sky's cumulus piles, cast along
    // the sun direction so walls and ground agree). Only the lit, bright surfaces react (a surface already in shade has no sun to lose),
    // cool and gentle, and they fade away with distance where the haze takes over.
    #if ${HAZE.cloudShade > 0 ? 1 : 0}
    {
      vec3 fgP = cameraPosition + fgW;
      vec2 fgCp = fgP.xz + vec2(${F(HAZE.sun.x / HAZE.sun.y)}, ${F(HAZE.sun.z / HAZE.sun.y)}) * (800.0 - fgP.y);
      float fgCs = fgN(fgCp * 0.0050) * 0.60 + fgN(fgCp * 0.0135 + 7.3) * 0.40;
      float fgCm = smoothstep(0.50, 0.70, fgCs) * smoothstep(0.30, 0.80, fgL) * (1.0 - smoothstep(260.0, 720.0, fgDist));
      fgIn *= mix(vec3(1.0), vec3(0.870, 0.920, 1.020), fgCm * ${F(HAZE.cloudShade)});
    }
    #endif
    fgIn = mix(fgIn, vec3(fgL), fgK * ${F(HAZE.desat)});          // aerial desaturation
    gl_FragColor.rgb = mix(fgIn, fgC, fgK);
  }
#endif`;
