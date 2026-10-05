// Atmospheric perspective: replaces three's fog chunks globally (every fog-enabled material picks this up).
// Imported for its side effect by materials.js, so it is installed before any shader compiles.
import * as THREE from 'three';

// ── atmospheric perspective: gentle start, strong far, thinner with altitude, far layers drift to lavender-blue ──
THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogY;
#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogY = cameraPosition.y + (transpose(mat3(viewMatrix)) * mvPosition.xyz).y;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogY;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  float fogD = max(vFogDepth - fogNear, 0.0);
  float fogK = 1.0 - exp(-pow(fogD / fogFar * 2.7, 1.5));
  fogK *= 1.0 - 0.45 * smoothstep(30.0, 200.0, vFogY);
  fogK = clamp(fogK, 0.0, 1.0);
  vec3 fogC = mix(fogColor, vec3(0.70, 0.75, 0.95), smoothstep(0.2, 0.8, fogK) * 0.5);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogC, fogK);
#endif`;
