// Level layout: spawn → entrance snowfield (viaduct gateway) → abandoned city → snow canyon (ring) → factory gate.
import * as THREE from 'three';
import { makeStructure, frame, M } from './kit.js';
import { building, buildingAsset } from './arch_building.js';
import { ASSETS } from './assets.js';
import { viaduct, catwalk, stairs, ringGate, spireCluster } from './arch_infra.js';
import { rock, leaningSlab, container, pipeGantry, ruinWall, factoryGate, transitHall } from './arch_props.js';
import { heightAt, canyonX, canyonHalfWidthAt, addFootprint, PLATEAU_H, HALF_X } from './terrain.js';
import { rng } from './noise.js';

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
  for (const sp of specs) bld(sp.x, sp.z, sp, {});

  // ── overhead bridge between the two hero buildings + stair up to it ─────────────────────────
  job(() => {
    const y = 8.6 + ground(0, 107);
    put(makeStructure((lod, B, col) => {
      catwalk(B, lod, col, { x0: -20, x1: 20, y, z: 0, width: 4.6, gaps: [{ side: 1, x0: -16.2, x1: -11.8 }] });
      stairs(B, lod, col, { x: -14, z: 2.3 + 15.3, y: ground(-14, 125), rise: y - ground(-14, 125), dir: Math.PI, width: 3.6 });
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
    const x0s = -253;
    const nseg = 8;
    for (let i = 0; i < nseg; i++) {
      const a = x0s + i * L, b = a + L, cx = (a + b) / 2;
      job(() => {
        const gaps = [];
        // stairs land on the south edge near x=-66 (world)
        const sx = -66;
        if (sx > a && sx < b) gaps.push({ side: 1, x0: sx - 2.2 - cx, x1: sx + 2.2 - cx });
        put(makeStructure((lod, B, col) => {
          viaduct({ x0: -L / 2, x1: L / 2, deckY: DECK, span: SPAN, endPier: i === nseg - 1, gaps, ground: (lx) => ground(cx + lx, Z) })(lod, B, col);
        }, { x: cx, y: 0, z: Z, lods: [0, 150, 330, 700] }));
      });
    }
    // switchback-free long stair on the south face (world z from 213 down to 178.7)
    job(() => {
      const sx = -66, zTop = Z + 6.5 + 0.2;
      const y0 = ground(sx, zTop + 33);
      put(makeStructure((lod, B, col) => {
        stairs(B, lod, col, { x: 0, z: 0, y: 0, rise: DECK + 0.0 - y0, dir: Math.PI, width: 3.8 });
      }, { x: sx, y: y0, z: zTop + (DECK - y0) / 0.2 * 0.36, lods: [0, 150, 330, 700] }));
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
  const spire = (x, z, seed, count, height, spread, wide, y) => job(() => {
    const yy = ground(x, z) - 2.5;
    put(makeStructure(spireCluster({ seed, count, height, spread, wide }), { x, y: yy, z, lods: [0, 220, 480, 900] }));
  });
  spire(96, 36, 1, 5, 125, 20, 5.5);
  spire(-112, 140, 2, 4, 105, 16, 5);
  spire(150, 130, 3, 6, 150, 24, 6.5);
  spire(-170, 60, 4, 5, 135, 20, 5.8);
  spire(-250, 150, 5, 4, 120, 14, 5);
  spire(250, 170, 6, 5, 130, 18, 5.5);
  spire(60, -20, 7, 3, 70, 10, 4.6);
  {
    const r = rng(404);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + r() * 0.2;
      const d = 340 + r() * 520;
      const x = Math.cos(a) * d * 0.9, z = Math.sin(a) * d * 1.1 - 10;
      spire(x, z, 100 + i, 3 + Math.floor(r() * 4), 110 + r() * 130, 16 + r() * 14, 5 + r() * 3);
    }
    for (let i = 0; i < 8; i++) { // spires standing on the canyon rim
      const z = -30 - i * 24, side = i % 2 ? 1 : -1;
      spire(canyonX(z) + side * (88 + r() * 20), z, 200 + i, 3, 70 + r() * 40, 12, 5);
    }
  }

  // ── sculpted rocks: scatter for cover, hand-keyed by region ─────────────────────────────────
  {
    const r = rng(2024);
    const tryPlace = (xMin, xMax, zMin, zMax, n, sizeMin, sizeMax, redP) => {
      for (let i = 0, ok = 0; ok < n && i < n * 12; i++) {
        const x = xMin + r() * (xMax - xMin), z = zMin + r() * (zMax - zMin);
        const y = ground(x, z);
        if (y > 3 + (z < 20 ? -40 : 0) && y > ground(x + 3, z) + 6) continue;
        // keep the central route readable, avoid overlapping buildings
        if (keepClear.some((k) => Math.abs(x - k.x) < k.hx && Math.abs(z - k.z) < k.hz)) continue;
        if (z > 36 && z < 140 && Math.abs(x) < 20) continue;
        if (z < 48 && z > -195 && Math.abs(x - canyonX(z)) < 15) continue;   // keep the canyon route open
        if (Math.abs(x) < 8 && z > 150 && z < 250 && r() < 0.8) continue;
        const sz = sizeMin + r() * (sizeMax - sizeMin) * r();
        const sd = Math.floor(r() * 1e5);
        job(() => {
          const g = ground(x, z);
          put(makeStructure(rock({ seed: sd, size: sz, red: r() < redP, planes: 5 + Math.floor(r() * 4) }), { x, y: g - sz * 0.15, z, yaw: r() * 6.28, lods: [0, 90, 220], cull: 480, cast: sz > 4 }));
        });
        ok++;
      }
    };
    tryPlace(-150, 150, 180, 262, 70, 1.4, 6.5, 0.35);   // entrance field
    for (const [x, z, sz, red] of [[-16, 236, 5.2, true], [20, 222, 4.4, false], [-34, 204, 3.6, true], [30, 252, 3.2, false], [-6, 196, 3, true]])
      job(() => put(makeStructure(rock({ seed: Math.floor(x * 7 + z), size: sz, red, planes: 7 }), { x, y: ground(x, z) - sz * 0.2, z, yaw: x, lods: [0, 90, 220], cull: 520 })));
    tryPlace(-110, 110, 40, 140, 10, 1.5, 3.2, 0.3);     // city rubble
    for (let z = 20; z > -190; z -= 20) tryPlace(canyonX(z) - 38, canyonX(z) + 38, z - 10, z + 10, 3, 1.8, 6.5, 0.4); // canyon floor
    for (let z = 20; z > -190; z -= 22) { // outcrops hugging the walls
      tryPlace(canyonX(z) - 56, canyonX(z) - 36, z - 11, z + 11, 1, 5, 11, 0.5);
      tryPlace(canyonX(z) + 36, canyonX(z) + 56, z - 11, z + 11, 1, 5, 11, 0.5);
    }
    // massive sculpted buttresses breaking up the canyon contour lines
    for (let z = 12; z > -190; z -= 34) for (const side of [-1, 1]) {
      const x = canyonX(z) + side * (canyonHalfWidthAt(z) + 3 + r() * 9);
      const sz = 12 + r() * 12, sd = Math.floor(r() * 1e5), red = r() < 0.4;
      job(() => put(makeStructure(rock({ seed: sd, size: sz, red, planes: 7, flat: 0.8, squash: 1.1 }), { x, y: ground(x, z) - sz * 0.35, z: z + (r() - 0.5) * 12, yaw: r() * 6.28, lods: [0, 120, 260], cull: 700 })));
    }
  }

  const prof = [];
  let slice = performance.now();
  for (let i = 0; i < jobs.length; i++) {
    const t = performance.now(); jobs[i](); prof.push([Math.round(performance.now() - t), i]);
    if (performance.now() - slice > 30) { onProgress((i + 1) / jobs.length); await new Promise((r) => setTimeout(r, 0)); slice = performance.now(); }
  }
  if (location.search.includes('prof')) { prof.sort((a, b) => b[0] - a[0]); console.info('slowest jobs ' + JSON.stringify(prof.slice(0, 14)) + ' total jobs ' + jobs.length); }
  return { colliders };
}
