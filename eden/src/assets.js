// Blender-authored assets (see ../tools). Geometry only; materials/painting are applied in-engine.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MAT, RAMP } from './materials.js';

// structures.glb light strips / seams use the key 'glow'; they are drawn with this softer emissive (the stock hot-neon 'glow' blooms into hard blocks)
MAT.glowSoft ??= new THREE.MeshToonMaterial({ color: 0xe48272, emissive: 0xb84a48, emissiveIntensity: 0.5, gradientMap: RAMP, vertexColors: true });

export const ASSETS = { rocks: null, buildings: null, buildingSpecs: null, props: null, structs: null };

/** add a Blender prop (spire0, slab1, container0, pylon0 …) to a batch; remap swaps material keys */
export function addProp(B, name, lod, matrix, remap = {}) {
  const parts = ASSETS.props?.[name]?.[Math.min(lod, 2)];
  if (!parts) return false;
  for (const [mat, geo] of Object.entries(parts)) B.add(remap[mat] ?? mat, geo, matrix);
  return true;
}

/** add a Blender structure module (ringbase, viapier0, gate0 …) to a batch; remap swaps material keys.
 *  Modules come in 3 detail levels (lod 3 reuses level 2). Returns false when the module is not available. */
export function addStruct(B, name, lod, matrix, remap = {}) {
  const parts = ASSETS.structs?.[name]?.[Math.min(lod, 2)];
  if (!parts) return false;
  for (const [mat, geo] of Object.entries(parts)) B.add(remap[mat] ?? mat, geo, matrix);
  return true;
}

/** structures.glb stores NORMAL as int8 and COLOR_0 as ubyte (KHR_mesh_quantization): expand to plain float32 attributes */
function expandQuantized(geo) {
  const n = geo.getAttribute('normal');
  if (n && n.array.constructor !== Float32Array) {
    const f = new Float32Array(n.count * 3), v = new THREE.Vector3();
    for (let i = 0; i < n.count; i++) { v.set(n.getX(i), n.getY(i), n.getZ(i)).normalize(); f[i * 3] = v.x; f[i * 3 + 1] = v.y; f[i * 3 + 2] = v.z; }
    geo.setAttribute('normal', new THREE.BufferAttribute(f, 3));
  }
  const c = geo.getAttribute('color');
  if (c && (c.array.constructor !== Float32Array || c.itemSize !== 3)) {
    const f = new Float32Array(c.count * 3);
    for (let i = 0; i < c.count; i++) { f[i * 3] = c.getX(i); f[i * 3 + 1] = c.getY(i); f[i * 3 + 2] = c.getZ(i); }
    geo.setAttribute('color', new THREE.BufferAttribute(f, 3));
  }
}

export async function loadAssets() {
  try {
    const gltf = await new GLTFLoader().loadAsync(new URL('../assets/rocks.glb', import.meta.url).href);
    const byName = {};
    gltf.scene.traverse((o) => { if (o.isMesh) byName[o.name] = o.geometry; });
    const rocks = [];
    for (let i = 0; i < 64; i++) {
      const lods = [0, 1, 2].map((l) => byName[`rock${i}_lod${l}`]);
      if (!lods[0]) break;
      rocks.push(lods);
    }
    ASSETS.rocks = rocks.length ? rocks : null;
  } catch (e) {
    console.warn('rock assets unavailable, using procedural fallback', e);
  }
  try {
    const gltf = await new GLTFLoader().loadAsync(new URL('../assets/props.glb', import.meta.url).href);
    const lib = {};
    gltf.scene.traverse((o) => {
      const m = o.isMesh && /^(\w+?)_l(\d)_(\w+)$/.exec(o.name);
      if (m) ((lib[m[1]] ??= [{}, {}, {}])[+m[2]])[m[3]] = o.geometry;
    });
    ASSETS.props = lib;
  } catch (e) { console.warn('prop assets unavailable', e); }
  try {
    const url = (f) => new URL('../assets/' + f, import.meta.url).href;
    const specs = await (await fetch(url('buildings.json'))).json();
    const gltf = await new GLTFLoader().loadAsync(url('buildings.glb'));
    const lib = {};   // lib[id][lod][material] = geometry
    gltf.scene.traverse((o) => {
      const m = o.isMesh && /^b(\d+)_l(\d)_(\w+)$/.exec(o.name);
      if (m) ((lib[+m[1]] ??= [{}, {}, {}])[+m[2]])[m[3]] = o.geometry;
    });
    ASSETS.buildings = lib;
    ASSETS.buildingSpecs = specs.buildings;
    try {   // hero towers (tools/gen_towers.py): same b{id}_l{lod}_{material} naming, loaded into the same library
      const ts = await (await fetch(url('towers.json'))).json();
      const tg = await new GLTFLoader().loadAsync(url('towers.glb'));
      tg.scene.traverse((o) => {
        const m = o.isMesh && /^b(\d+)_l(\d)_(\w+)$/.exec(o.name);
        if (m) ((lib[+m[1]] ??= [{}, {}, {}])[+m[2]])[m[3]] = o.geometry;
      });
      ASSETS.buildingSpecs = specs.buildings.concat(ts.buildings.filter((b) => lib[b.id]));
    } catch (e) { console.warn('tower assets unavailable', e); }
  } catch (e) {
    console.warn('building assets unavailable, using procedural fallback', e);
  }
  try {   // large landmark structures: viaduct modules, ring gate, factory gate, gantry (tools/gen_structures.py)
    const gltf = await new GLTFLoader().loadAsync(new URL('../assets/structures.glb', import.meta.url).href);
    const lib = {};
    gltf.scene.traverse((o) => {
      const m = o.isMesh && /^(\w+?)_l(\d)_(\w+)$/.exec(o.name);
      if (!m) return;
      expandQuantized(o.geometry);
      ((lib[m[1]] ??= [{}, {}, {}])[+m[2]])[m[3] === 'glow' ? 'glowSoft' : m[3]] = o.geometry;
    });
    ASSETS.structs = lib;
  } catch (e) { console.warn('structure assets unavailable, using procedural fallback', e); }
}
