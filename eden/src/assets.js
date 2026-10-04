// Blender-authored assets (see ../tools). Geometry only; materials/painting are applied in-engine.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const ASSETS = { rocks: null };

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
}
