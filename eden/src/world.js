// Level layout: spawn → entrance snowfield (viaduct gateway) → abandoned city → snow canyon (ring) → factory gate.
import * as THREE from 'three';
import { makeStructure, frame, M, rbox } from './kit.js';
import { building, buildingAsset } from './arch_building.js';
import { ASSETS } from './assets.js';
import { viaduct, catwalk, stairs, ringGate, spireCluster } from './arch_infra.js';
import { rock, leaningSlab, container, pipeGantry, ruinWall, factoryGate, transitHall } from './arch_props.js';
import { heightAt, canyonX, canyonHalfWidthAt, addFootprint, PLATEAU_H, HALF_X } from './terrain.js';
import { rng } from './noise.js';
import { scatterWorld } from './scatter.js';
import { loadDressing, dressingWorld } from './dressing.js';

import FALLBACK_SPECS_JSON from './fallback_specs.js';
const FALLBACK_SPECS = FALLBACK_SPECS_JSON;

export async function buildWorld(scene, onProgress = () => {}) {
  const colliders = [];
  const jobs = [];            // deferred so every structure samples ground before drifts alter the terrain
  const job = (fn) => jobs.push(fn);
  const keepClear = [];       // rects (centre + half extents) that scatter props must avoid

  const put = (s) => { scene.add(s.object); colliders.push(...s.colliders); };
  const ground = (x, z) => heightAt(x, z);

  // ── buildings (door faces the street) ────────────────────────────────────────────
  const bld = (x, z, spec, opts = {}) => {
    const t0 = spec.tiers[0];
    keepClear.push({ x, z, hx: t0.w / 2 + 3, hz: t0.d / 2 + 3 });
    job(() => {
    const y = ground(x, z) - 0.9;
    put(makeStructure(buildingAsset(spec), { x, y, z, yaw: opts.yaw ?? 0, lods: [0, 120, 280, 600] }));
    const sw = opts.yaw ? t0.d : t0.w, sd = opts.yaw ? t0.w : t0.d;
    addFootprint({ x, z, hx: sw / 2 + 0.6, hz: sd / 2 + 0.6, drift: 1.0 });
    });
  };

  // street buildings: specs shared with the Blender generator (tools/buildings.json)
  const specs = ASSETS.buildingSpecs ?? FALLBACK_SPECS;
  for (const sp of specs) bld(sp.x, sp.z, sp, { yaw: ((sp.yaw ?? 0) * Math.PI) / 180 });

  // ── truss bridges from the hero towers to their neighbouring buildings (spec.bridge from tools/gen_towers.py) ──
  for (const sp of specs) {
    if (!sp.bridge) continue;
    job(() => {
      const br = sp.bridge, dir = br.dir;
      const yd = ground(sp.x, sp.z) - 0.9 + br.deck;
      const xa = sp.x + dir * br.stub_end, xb = br.end_x;
      put(makeStructure((lod, B, col) => {
        catwalk(B, lod, col, { x0: Math.min(xa, xb), x1: Math.max(xa, xb), y: yd, z: 0, width: 4.6 });
        // doorway on the neighbouring building's wall: pale frame + lintel + dark door with a lit pane (same language as the tower portal)
        const wx = xb - dir * 0.3;
        B.add('wallLight', rbox(0.9, 5.8, 5.4, 0.12, 2), M(wx, yd + 2.9, 0));
        B.add('trim', rbox(1.2, 0.55, 6.0, 0.1, 2), M(wx, yd + 6.0, 0));
        B.add('wallDark', rbox(0.5, 4.6, 4.0, 0.1, 2), M(wx - dir * 0.3, yd + 2.5, 0));
        if (lod < 2) B.add('glass', rbox(0.12, 3.9, 3.3, 0.04, 1), M(wx - dir * 0.6, yd + 2.5, 0));
      }, { x: 0, y: 0, z: br.wz, lods: [0, 140, 300, 600] }));
    });
  }

  // ── overhead bridge between the two hero buildings + stair up to it ─────────────────────────
  job(() => {
    const y = 8.6 + ground(0, 107);
    let gy = ground(-14, 125), n = 0;
    for (let k = 0; k < 3; k++) { n = Math.max(2, Math.round((y - gy) / 0.2)); gy = ground(-14, 107 + 4.7 + n * 0.36); }
    put(makeStructure((lod, B, col) => {
      catwalk(B, lod, col, { x0: -20, x1: 20, y, z: 0, width: 4.6, gaps: [{ side: 1, x0: -16.2, x1: -11.8 }] });
      stairs(B, lod, col, { x: -14, z: 4.7 + n * 0.36, y: gy, rise: y - gy, dir: Math.PI, width: 3.6 });
    }, { x: 0, y: 0, z: 107, lods: [0, 140, 300, 600] }));
  });

  // optional branch: walk-through hall west of the street (outdoor yard → indoors → outdoor)
  keepClear.push({ x: -86, z: 49, hx: 22, hz: 14 }, { x: -62, z: 49, hx: 8, hz: 8 });
  job(() => {
    const x = -86, z = 49, y = ground(x, z);
    put(makeStructure(transitHall({ L: 34, Wd: 20, H: 9.5, seed: 5 }), { x, y: y - 0.1, z, lods: [0, 120, 280, 600] }));
    addFootprint({ x, z, hx: 18.5, hz: 11, drift: 0 });
  });
  [[-64, 53, 0, 1], [-114, 40, 0, 0], [-116, 57, Math.PI / 2, 1]].forEach(([cx, cz, yaw, a], i) =>
    job(() => put(makeStructure(container({ seed: 50 + i, accent: !!a }), { x: cx, y: ground(cx, cz) - 0.1, z: cz, yaw, lods: [0, 90, 220], cull: 520 }))));

  // pipe gantry across the street, containers and ruins as cover
  job(() => put(makeStructure(pipeGantry({ span: 32, h: 11 }), { x: 0, y: ground(0, 80) - 0.3, z: 80, lods: [0, 130, 300, 600] })));
  [[10, 117, 0, 0], [-12, 100, Math.PI / 2, 1], [14, 94, 0.2, 0], [-9, 58, 0, 1], [11, 46, 0, 0]].forEach(([x, z, yaw, a], i) =>
    job(() => { const yy = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2); put(makeStructure(container({ seed: i + 1, accent: !!a }), { x, y: ground(x, z) - 0.1, z, yaw: yy, lods: [0, 90, 220], cull: 520 })); }));
  [[-14, 142, 0, 1], [16, 146, 0, 2], [-4, 36, 0, 3]].forEach(([x, z, yaw, sd]) =>
    job(() => put(makeStructure(ruinWall({ w: 16 + sd * 2, h: 10 + sd, seed: sd }), { x, y: ground(x, z), z, yaw, lods: [0, 120, 280], cull: 600 }))));

  // ── entrance viaduct: a walkable gateway over the first snowfield ──────────────────────────────
  {
    const Z = 172, DECK = 16.5, SPAN = 22, L = 3 * SPAN;
    const x0s = -165;     // piers sit at x0s + 22k; beyond |x|~150 the mesas rise above the deck, so the span ends inside them
    const nseg = 5;
    for (let i = 0; i < nseg; i++) {
      const a = x0s + i * L, b = a + L, cx = (a + b) / 2;
      job(() => {
        const gaps = [];
        // stairs land on the south edge near x=-66 (world)
        const sx = -66;
        if (sx > a && sx < b) gaps.push({ side: 1, x0: sx - 2.2 - cx, x1: sx + 2.2 - cx });
        put(makeStructure((lod, B, col) => {
          viaduct({ x0: -L / 2, x1: L / 2, deckY: DECK, span: SPAN, endPier: i === nseg - 1, gaps, ground: (lx) => ground(cx + lx, Z) })(lod, B, col);
        }, { x: cx, y: 0, z: Z, lods: [0, 90, 260, 700] }));
      });
    }
    // switchback-free long stair on the south face (world z from 213 down to 178.7)
    job(() => {
      const sx = -66, zTop = Z + 6.5 + 0.2;
      let y0 = ground(sx, zTop + 33), n = 0;
      for (let k = 0; k < 3; k++) { n = Math.max(2, Math.round((DECK - y0) / 0.2)); y0 = ground(sx, zTop + n * 0.36); }
      put(makeStructure((lod, B, col) => {
        stairs(B, lod, col, { x: 0, z: 0, y: 0, rise: DECK - y0, dir: Math.PI, width: 3.8 });
      }, { x: sx, y: y0, z: zTop + n * 0.36, lods: [0, 90, 260, 700] }));
    });
  }

  // ── canyon: ring landmark, slabs, ruins, factory gate ─────────────────────────────────────
  job(() => { const x = canyonX(-118), y = ground(x, -118); put(makeStructure(ringGate({}), { x, y: y - 0.2, z: -118, lods: [0, 150, 340, 700] })); });
  [[28, -92, 0.42, false, 1], [-32, -142, -0.36, true, 2], [-30, -66, 0.3, false, 3], [34, -150, 0.5, false, 4]].forEach(([x, z, tilt, red, sd]) =>
    job(() => put(makeStructure(leaningSlab({ w: 12 + sd, h: 30 + sd * 4, t: 5, tilt, seed: sd, red }), { x: canyonX(z) + x, y: ground(canyonX(z) + x, z) - 0.3, z, yaw: sd % 2 ? 0 : Math.PI, lods: [0, 150, 340], cull: 700 }))));
  [[-22, -30, 1], [20, -48, 2]].forEach(([x, z, sd]) =>
    job(() => put(makeStructure(ruinWall({ w: 18, h: 11, seed: sd + 4 }), { x: canyonX(z) + x, y: ground(canyonX(z) + x, z) - 0.2, z, yaw: sd === 1 ? 0 : Math.PI, lods: [0, 120, 280], cull: 600 }))));
  [[10, -10, 1], [-14, -80, 0], [12, -128, 1], [-16, -160, 0]].forEach(([x, z, a], i) =>
    job(() => put(makeStructure(container({ seed: 20 + i, accent: !!a }), { x: canyonX(z) + x, y: ground(canyonX(z) + x, z) - 0.1, z, yaw: i % 2 ? Math.PI / 2 : 0, lods: [0, 90, 220], cull: 520 }))));
  job(() => { const x = canyonX(-178), y = ground(x, -178); put(makeStructure(factoryGate({}), { x, y: y - 0.3, z: -178, lods: [0, 160, 340, 700] })); });

  // ── landmark spires: city skyline + rim silhouettes beyond the cliffs ──────────────────────────
  // needles are placed on calm ground only: search around the wished spot for the flattest footprint (no floating bases on cliff faces)
  const flatness = (x, z, r) => {
    const c = ground(x, z);
    let m = 0;
    for (let k = 0; k < 8; k++) {
      const a = k * 0.7854;
      m = Math.max(m, Math.abs(ground(x + Math.cos(a) * r, z + Math.sin(a) * r) - c), Math.abs(ground(x + Math.cos(a) * r * 0.5, z + Math.sin(a) * r * 0.5) - c));
    }
    return m;
  };
  const sr = rng(31337);
  // the hall's west exit yard and its approach lane must stay open: spires never stand inside any keep-clear rect (walk-through branch exits)
  keepClear.push({ x: -121, z: 49, hx: 22, hz: 11 });
  const inKeepClear = (x, z, rad) => keepClear.some((k) => Math.abs(x - k.x) < k.hx + rad && Math.abs(z - k.z) < k.hz + rad);
  const spire = (x0, z0, seed, count, height, spread, wide, search = 70) => {
    const pen = (x, z) => flatness(x, z, spread) + (inKeepClear(x, z, spread + wide + 4) ? 99 : 0);
    let bx = x0, bz = z0, bf = pen(x0, z0);
    for (let t = 0; t < 90 && bf > 2.2; t++) {
      const a = sr() * Math.PI * 2, d = sr() * search;
      const x = x0 + Math.cos(a) * d, z = z0 + Math.sin(a) * d;
      if (Math.abs(x) > 480 || z > 520 || z < -500) continue;
      const f = pen(x, z);
      if (f < bf) { bf = f; bx = x; bz = z; }
    }
    if (bf > 4.5) return;      // nowhere calm: skip rather than float
    keepClear.push({ x: bx, z: bz, hx: spread * 0.6 + wide, hz: spread * 0.6 + wide });      // boulders / later spires keep off the needle bases
    job(() => {
      const yy = ground(bx, bz) - 2.5;
      put(makeStructure(spireCluster({ seed, count, height, spread, wide }), { x: bx, y: yy, z: bz, lods: [0, 220, 480, 900] }));
    });
  };
  spire(96, 36, 1, 5, 125, 20, 5.5);
  spire(150, 130, 3, 6, 150, 24, 6.5);
  spire(-170, 60, 4, 5, 135, 20, 5.8);
  spire(-250, 150, 5, 4, 120, 14, 5);
  spire(250, 170, 6, 5, 130, 18, 5.5);
  spire(60, -20, 7, 3, 70, 10, 4.6);
  // mid-field needles scattered across the ground plane in front of the viaduct (composition: spires in the whole mid-ground, as in the concept)
  spire(-80, 234, 44, 4, 70, 10, 4.8, 18);
  spire(78, 228, 45, 4, 66, 10, 4.8, 18);
  {
    const r = rng(404);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + r() * 0.2;
      const d = 340 + r() * 520;
      const x = Math.cos(a) * d * 0.9, z = Math.sin(a) * d * 1.1 - 10;
      spire(x, z, 100 + i, 3 + Math.floor(r() * 4), 110 + r() * 130, 16 + r() * 14, 5 + r() * 3, 110);
    }
    for (let i = 0; i < 8; i++) { // spires standing on the canyon rim
      const z = -30 - i * 24, side = i % 2 ? 1 : -1;
      spire(canyonX(z) + side * (88 + r() * 20), z, 200 + i, 3, 70 + r() * 40, 12, 5, 40);
    }
  }

  // ── ground dressing (src/dressing.js): debris / wrecks / buried ruin pieces that fill the walking lanes ───────
  await loadDressing();
  const dress = dressingWorld({ job, put, ground, keepClear, colliders });
  console.info('dressing items ' + dress.items);

  // ── boulder scatter (src/scatter.js): hand-placed hero clusters + noise-clustered fields ───────────────
  const scat = scatterWorld({ job, put, ground, keepClear });
  console.info('scatter clusters ' + scat.clusters + ' rocks ' + scat.rocks);

  const prof = [];
  let slice = performance.now();
  for (let i = 0; i < jobs.length; i++) {
    const t = performance.now(); jobs[i](); prof.push([Math.round(performance.now() - t), i]);
    if (performance.now() - slice > 30) { onProgress((i + 1) / jobs.length); await new Promise((r) => setTimeout(r, 0)); slice = performance.now(); }
  }
  if (location.search.includes('prof')) { prof.sort((a, b) => b[0] - a[0]); console.info('slowest jobs ' + JSON.stringify(prof.slice(0, 14)) + ' total jobs ' + jobs.length); }
  return { colliders };
}
