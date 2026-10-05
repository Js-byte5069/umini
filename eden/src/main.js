import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Terrain, heightAt } from './terrain.js';
import { createSky, SUN_DIR, FOG_COLOR } from './sky.js';
import { buildWorld } from './world.js';
import { Player } from './player.js';
import { loadAssets } from './assets.js';
import { loadScatter } from './scatter.js';

const params = new URLSearchParams(location.search);
if (params.has('shot')) document.body.classList.add('shot');

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('shot') });
const LOW = params.get('q') === 'low';
renderer.setPixelRatio(LOW ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = !params.has('ns');
renderer.shadowMap.type = params.has('pcf') ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;      // bilinear-filtered taps: no stair-stepped shadow edges

const scene = new THREE.Scene();
scene.background = FOG_COLOR;
scene.fog = new THREE.Fog(FOG_COLOR, 110, 1600);

const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 9000);

// lighting: warm key sun with hard cel terminator + strong cool ambient for blue shadows
const EXPO = parseFloat(params.get('expo') ?? '1.0');
const sun = new THREE.DirectionalLight(0xfff6ec, 2.35 * EXPO);
sun.castShadow = true;
const SM = LOW ? 2048 : 4096;
sun.shadow.mapSize.set(SM, SM);
const SH = 150;
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 700 });
sun.shadow.bias = parseFloat(params.get('bias') ?? '-0.0004');
sun.shadow.normalBias = parseFloat(params.get('nb') ?? '0.35');
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xa0bfff, 0x6f84de, 1.28 * EXPO));      // clear saturated blue shade (no lavender grey): deeper value split between lit and shaded planes
// cool bounce/fill from the shadow side (no shadows): gives forms inside cast shadow a gentle second value step
const fill = new THREE.DirectionalLight(0x9db6ff, parseFloat(params.get('fill') ?? '0.45') * EXPO);
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
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
document.getElementById('start').addEventListener('click', () => canvas.requestPointerLock());

const zones = [
  [180, '雪原入口'], [30, '废弃城区'], [-200, '雪原峡谷'],
];
const zname = document.getElementById('zname');
let lastZone = '';

// ── post: MSAA scene → ambient occlusion (painterly crease darkening) → soft bloom → grade → sRGB
const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: LOW ? 2 : 4 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
let gtao = null;
if (!params.has('noao')) {
  gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtao.updateGtaoMaterial({ radius: 3.2, distanceExponent: 1.4, thickness: 3, scale: 1.25, samples: LOW ? 8 : 16, distanceFallOff: 1.2, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  gtao.blendIntensity = 0.85;
  // the sky (dome, planet, ring, clouds) is drawn without depth in the colour pass but would be rendered as solid geometry
  // in the AO G-buffer: hide it there so far-away "surfaces" never darken the sky
  const baseOverride = gtao.overrideVisibility.bind(gtao);
  gtao.overrideVisibility = function () { baseOverride(); sky.group.visible = false; };
  composer.addPass(gtao);
}
// bloom only ever sees a clamped image with a high threshold: a lit roof facet can never flare into an isolated white blob
const bloomClamp = new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(min(c.rgb, vec3(1.3)), c.a); }',
});
if (!LOW) { composer.addPass(bloomClamp); composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.10, 0.5, 1.12)); }
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126,0.7152,0.0722));
      // cool lifted shadows, warm clean highlights (anime grade)
      c = mix(c, c * vec3(0.965,0.985,1.045) + vec3(0.0,0.002,0.006), 1.0 - smoothstep(0.0,0.5,l));
      c = mix(c, c * vec3(1.04,1.0,0.96), smoothstep(0.6,1.0,l));
      c = mix(vec3(l), c, 1.04);
      c = c / (1.0 + max(c - 0.92, 0.0) * 0.6);  // soft shoulder keeps snow from clipping                 // saturation
      vec2 d = vUv - 0.5; c *= 1.0 - dot(d,d) * 0.28;   // soft vignette
      gl_FragColor = vec4(c, 1.0);
    }`,
});
composer.addPass(grade);
composer.addPass(new OutputPass());

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

  composer.render();
  if (++frames === 3) {
    document.getElementById('load').style.opacity = 0;
    setTimeout(() => document.getElementById('load').remove(), 700);
    window.__ready = true;
  }
  requestAnimationFrame(frame);
}
frame();
window.__dbg = { player, camera, renderer, scene, heightAt, terrain, sky, composer, render: () => { sky.update(camera.position); composer.render(); }, info: () => renderer.info.render };
