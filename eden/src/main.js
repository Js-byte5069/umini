import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Terrain, heightAt } from './terrain.js';
import { createSky, SUN_DIR, FOG_COLOR } from './sky.js';
import { buildWorld } from './world.js';
import { Player } from './player.js';
import { loadAssets } from './assets.js';
import { loadScatter } from './scatter.js';

const params = new URLSearchParams(location.search);
if (params.has('shot')) document.body.classList.add('shot');
const pf = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('shot') });
const LOW = params.get('q') === 'low';
const NOPOST = params.has('nopost');                 // &nopost: plain scene render (no AO / bloom / grade / paint pass) for A/B comparison
const NOPAINT = params.has('nopaint');               // &nopaint: keep AO / bloom / grade, drop the painterly smoothing + banding
renderer.setPixelRatio(LOW ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = !params.has('ns');
renderer.shadowMap.type = params.has('pcf') ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;      // bilinear-filtered taps: no stair-stepped shadow edges

const scene = new THREE.Scene();
scene.background = FOG_COLOR;
// atmospheric perspective (see atmosphere.js): near = clear distance, far = haze length scale
scene.fog = new THREE.Fog(FOG_COLOR, pf('fn', 24), pf('ff', 420));

const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 9000);

// ── lighting rig: anime light ──────────────────────────────────────────────────────────────────
// KEY: one clean, warm-neutral sun with a crisp-but-soft shadow terminator. SHADE: a strong cool blue sky/ground ambient so shadowed
// planes are saturated pale blue-violet (never grey or black), plus a shadowless cool bounce from the shadow side that gives forms
// inside cast shadow a second, gentler value step. Three tonal regions (light / midtone / shadow) therefore read at every scale.
const EXPO = pf('expo', 1.0);
const sun = new THREE.DirectionalLight(0xfff4e6, pf('sun', 2.35) * EXPO);
sun.castShadow = true;
const SM = LOW ? 2048 : 4096;
sun.shadow.mapSize.set(SM, SM);
const SH = 150;
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 700 });
sun.shadow.bias = pf('bias', -0.0004);
sun.shadow.normalBias = pf('nb', 0.35);
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xa0bfff, 0x6f84de, pf('hemi', 1.65) * EXPO));      // clear saturated blue shade (no lavender grey)
const fill = new THREE.DirectionalLight(0x9db6ff, pf('fill', 0.45) * EXPO);
fill.position.set(0.78, 0.38, -0.30);
scene.add(fill);

const sky = createSky(scene);
const terrain = new Terrain(scene);
const loadEl = document.getElementById('load');
await loadAssets();
await loadScatter();
const t0 = performance.now();
const world = await buildWorld(scene, (p) => { loadEl.textContent = 'LOADING ' + Math.round(p * 100) + '%'; });
console.info('world built in ' + Math.round(performance.now() - t0) + ' ms, colliders ' + world.colliders.length);
terrain.primeNear(new THREE.Vector3(0, 0, 250));
await terrain.primeRestAsync((p) => { loadEl.textContent = 'LOADING TERRAIN ' + Math.round(p * 100) + '%'; });

const player = new Player(camera, canvas, world.colliders);
player.place(0, 250, 0, 0.0);

// debug / screenshot camera: ?cam=x,z,yaw(deg),pitch(deg)[,y]
if (params.has('cam')) {
  const [x, z, yaw, pitch, y] = params.get('cam').split(',').map(Number);
  player.place(x, z, (yaw * Math.PI) / 180, ((pitch || 0) * Math.PI) / 180, y);
}
if (params.has('fov')) { camera.fov = +params.get('fov'); camera.updateProjectionMatrix(); }

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  if (finalPass) finalPass.uniforms.uPx.value.set(1 / (innerWidth * renderer.getPixelRatio()), 1 / (innerHeight * renderer.getPixelRatio()));
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
document.getElementById('start').addEventListener('click', () => canvas.requestPointerLock());

const zones = [
  [180, '雪原入口'], [30, '废弃城区'], [-200, '雪原峡谷'],
];
const zname = document.getElementById('zname');
let lastZone = '';

// ── post: MSAA scene → ambient occlusion → soft bloom → one final pass (edge softening, painterly value banding, grade, dither, sRGB)
const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: LOW ? 2 : 4 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
let gtao = null;
if (!params.has('noao')) {
  gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtao.updateGtaoMaterial({ radius: pf('aor', 3.2), distanceExponent: 1.4, thickness: 3, scale: pf('aos', 1.25), samples: LOW ? 8 : 16, distanceFallOff: 1.2, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  gtao.blendIntensity = pf('aoi', 0.85);
  // AO is a near-field depth cue: it fades out with distance (aerial perspective owns the far field, so far spires and rims are never
  // darkened by contact shadows that the haze would have washed out) and never touches the sky (depth 1)
  Object.assign(gtao.blendMaterial.uniforms, { tDepth: { value: gtao.depthTexture }, uNear: { value: camera.near }, uFar: { value: camera.far }, uFade: { value: new THREE.Vector2(70, 340) } });
  gtao.blendMaterial.fragmentShader = `uniform float intensity; uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform float uNear; uniform float uFar; uniform vec2 uFade; varying vec2 vUv;
    void main(){
      vec4 texel = texture2D(tDiffuse, vUv);
      float d = texture2D(tDepth, vUv).x;
      float dist = uNear * uFar / (uFar - (uFar - uNear) * d);
      float fade = 1.0 - smoothstep(uFade.x, uFade.y, dist);
      gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, intensity * fade), texel.a);
    }`;
  gtao.blendMaterial.needsUpdate = true;
  // the sky (dome, planet, ring, clouds) is drawn without depth in the colour pass but would be rendered as solid geometry
  // in the AO G-buffer: hide it there so far-away "surfaces" never darken the sky
  const baseOverride = gtao.overrideVisibility.bind(gtao);
  gtao.overrideVisibility = function () { baseOverride(); sky.group.visible = false; };
  composer.addPass(gtao);
}
// bloom only ever sees a clamped image with a threshold: a lit roof facet can never flare into an isolated white blob; the glow is wide and soft
const bloomClamp = new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(min(c.rgb, vec3(1.3)), c.a); }',
});
if (!LOW) { composer.addPass(bloomClamp); composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), pf('bloom', 0.10), pf('bloomr', 0.5), pf('bloomt', 1.12))); }

// Final pass: everything display-referred happens here, in this order
//   1. edge softening  (FXAA-style directional smoothing: shader / terminator aliasing + edge crawl, ~1 px, detail kept)
//   2. painterly flatten (very light range-weighted 3x3 smoothing: kills micro-variation inside colour planes, keeps real edges)
//   3. grade: soft shoulder, stylised value curve, cool lifted shadows, warm clean highlights, controlled saturation
//   4. soft value banding (barely visible, preserves gradients), vignette, dither, sRGB encode
const finalPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uPx: { value: new THREE.Vector2(1 / (innerWidth * renderer.getPixelRatio()), 1 / (innerHeight * renderer.getPixelRatio())) },
    uPaint: { value: NOPAINT ? 0 : pf('paint', 1.0) },
    uFlat: { value: NOPAINT ? 0 : pf('flat', 0.30) },
    uContrast: { value: pf('contrast', 0.15) },
    uSat: { value: pf('sat', 1.07) },
    uBand: { value: NOPAINT ? 0 : pf('band', 0.16) },
    uVig: { value: pf('vig', 0.26) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uPx; uniform float uPaint, uFlat, uContrast, uSat, uBand, uVig; varying vec2 vUv;
    const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
    vec3 srgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    vec3 tap(vec2 o){ return texture2D(tDiffuse, vUv + o * uPx).rgb; }
    float lg(vec3 c){ return dot(sqrt(max(c, 0.0)), vec3(0.299, 0.587, 0.114)); }     // luma in ~gamma space (edge detection)
    void main(){
      vec3 m = tap(vec2(0.0));
      vec3 c = m;
      if (uPaint > 0.0) {
        vec3 nw = tap(vec2(-1.0, -1.0)), ne = tap(vec2(1.0, -1.0)), sw = tap(vec2(-1.0, 1.0)), se = tap(vec2(1.0, 1.0));
        float lM = lg(m), lNW = lg(nw), lNE = lg(ne), lSW = lg(sw), lSE = lg(se);
        float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
        float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
        vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
        float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
        dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + dirReduce), -2.5, 2.5);
        vec3 a = 0.5 * (tap(dir * (1.0 / 3.0 - 0.5)) + tap(dir * (2.0 / 3.0 - 0.5)));
        vec3 b = a * 0.5 + 0.25 * (tap(dir * -0.5) + tap(dir * 0.5));
        float lB = lg(b);
        vec3 aa = (lB < lMin || lB > lMax) ? a : b;
        // only act on real edges (low-contrast areas stay untouched); the strength follows the local contrast
        float edge = smoothstep(0.03, 0.12, lMax - lMin);
        c = mix(m, aa, edge);
        // painterly flatten: range-weighted average of the 4 diagonal taps already fetched + the filtered centre
        if (uFlat > 0.0) {
          float lc = lg(c);
          vec4 dl = (vec4(lNW, lNE, lSW, lSE) - lc) / 0.045;
          vec4 wv = exp(-dl * dl);
          float wNW = wv.x, wNE = wv.y, wSW = wv.z, wSE = wv.w;
          vec3 acc = c * 1.6 + nw * wNW + ne * wNE + sw * wSW + se * wSE;
          c = mix(c, acc / (1.6 + wNW + wNE + wSW + wSE), uFlat);
        }
      }
      // soft shoulder keeps the snow from clipping; all values stay linear until the very end
      c = c / (1.0 + max(c - 0.92, 0.0) * 0.6);
      vec3 g = srgb(c);                                      // display-referred from here on
      float gl = dot(g, LUM);
      // stylised value curve: gentle S (deeper darks, cleaner lights), hue preserved
      float gl2 = gl + uContrast * (smoothstep(0.0, 1.0, gl) - gl);
      g *= gl2 / max(gl, 1e-4);
      gl = dot(g, LUM);
      // cool lifted shadows, warm clean highlights
      g = mix(g, g * vec3(0.945, 0.975, 1.065), 1.0 - smoothstep(0.06, 0.55, gl));
      g = mix(g, g * vec3(1.035, 1.004, 0.958), smoothstep(0.62, 0.98, gl));
      g += vec3(0.008, 0.012, 0.030) * (1.0 - smoothstep(0.0, 0.32, gl));      // blacks lift to navy, never black
      // controlled saturation: richer mid / dark colours, whites stay white
      gl = dot(g, LUM);
      g = mix(vec3(gl), g, mix(uSat, 1.0, smoothstep(0.58, 0.96, gl)));
      // barely-visible painterly value banding: soft steps, gradients preserved
      if (uBand > 0.0) {
        float s = gl * 9.0;
        float q = (floor(s) + smoothstep(0.30, 0.70, fract(s))) / 9.0;
        g *= mix(1.0, q / max(gl, 1e-3), uBand * (1.0 - smoothstep(0.80, 0.96, gl)));
      }
      vec2 d = vUv - 0.5; g *= 1.0 - dot(d, d) * uVig;
      // triangular dither: no banding in the sky gradient
      float n1 = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453), n2 = fract(sin(dot(gl_FragCoord.xy + 17.3, vec2(39.3468, 11.135))) * 24634.6345);
      g += (n1 + n2 - 1.0) / 255.0;
      gl_FragColor = vec4(clamp(g, 0.0, 1.0), 1.0);
    }`,
});
if (!NOPOST) composer.addPass(finalPass);

const clock = new THREE.Clock();
let frames = 0;
function frame() {
  const dt = clock.getDelta();
  player.update(dt);
  terrain.update(player.pos);
  sky.update(camera.position);

  // shadow frustum follows the player, snapped to texel grid to avoid shimmer
  const texel = (SH * 2) / SM;
  const sx = Math.round(camera.position.x / texel) * texel, sz = Math.round(camera.position.z / texel) * texel;
  sun.target.position.set(sx, camera.position.y * 0.5, sz);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 350);
  sun.target.updateMatrixWorld();

  const z = player.pos.z;
  const zn = z > 150 ? '雪原入口' : z > -5 ? '废弃城区' : '雪原峡谷';
  if (zn !== lastZone) { lastZone = zn; zname.innerHTML = '伊甸星 · <b>' + zn + '</b>'; }

  if (NOPOST) renderer.render(scene, camera); else composer.render();
  if (++frames === 3) {
    document.getElementById('load').style.opacity = 0;
    setTimeout(() => document.getElementById('load').remove(), 700);
    window.__ready = true;
  }
  requestAnimationFrame(frame);
}
frame();
window.__dbg = { player, camera, renderer, scene, heightAt, terrain, sky, composer, finalPass, sun, render: () => { sky.update(camera.position); if (NOPOST) renderer.render(scene, camera); else composer.render(); }, info: () => renderer.info.render };
