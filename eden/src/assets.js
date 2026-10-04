// Blender-authored assets (see ../tools). Geometry only; materials/painting are applied in-engine.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const ASSETS = { rocks: null, buildings: null, buildingSpecs: null };

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
  } catch (e) {
    console.warn('building assets unavailable, using procedural fallback', e);
  }
}
