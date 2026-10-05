// Railings, stairs, catwalks, viaducts, ring gate, spires, factory gate and props.
import * as THREE from 'three';
import { M, rbox, cyl, strut, loft, extrude, slabWithHoles, ringShape, roundRectPath, snowPillow, snowTint, frame } from './kit.js';
import { rng, lerp, makeNoise } from './noise.js';
import { ASSETS, addProp, addStruct } from './assets.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ── snow drifts ──────────────────────────────────────────────────────────────────────────────────
const DN = makeNoise(4242);
/** One continuous, smooth snow drift made of overlapping soft bumps (no straight edges, no vertical lip, no pad).
 *  lumps: [[cx, cz, rx, rz, height, rot?]] in the structure's local xz plane; the surface sinks into a buried skirt past its rim so it melts into
 *  whatever terrain it stands on. Vertices outside the drift are dropped, so cost follows the real footprint. */
export function snowDrift(lumps, { seed = 1, cell = 0.55, bury = 1.0, warp = 0.2, rough = 0.06, cap = 8000 } = {}) {
  const SLOPE = 0.7, skirt = bury / SLOPE;          // past its rim the surface keeps falling at a gentle slope (a snow bank), so it meets uneven ground softly
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const [cx, cz, rx, rz] of lumps) {
    const e = Math.max(rx, rz) * (1 + warp * 0.8) + 0.3 + skirt;
    x0 = Math.min(x0, cx - e); x1 = Math.max(x1, cx + e); z0 = Math.min(z0, cz - e); z1 = Math.max(z1, cz + e);
  }
  const W = x1 - x0, D = z1 - z0;
  cell = Math.max(cell, Math.sqrt((W * D) / cap));
  const nx = Math.max(6, Math.ceil(W / cell)), nz = Math.max(6, Math.ceil(D / cell));
  const sx = W / nx, sz = D / nz;
  const heightAt = (x, z) => {
    let H = 0, dmin = 1e9;
    const w = 1 + warp * DN.fbm2(x * 0.21 + seed * 7.3, z * 0.21 + seed * 3.1, 2);
    for (const [cx, cz, rx, rz, h, rot = 0] of lumps) {
      const c = Math.cos(rot), s = Math.sin(rot), dx = x - cx, dz = z - cz;
      const u = (dx * c + dz * s) / rx, v = (-dx * s + dz * c) / rz;
      const d = Math.hypot(u, v) * w;
      if (d < 1) { const q = 1 - d * d; H += h * q * (0.5 + 0.5 * q); }          // finite slope at the rim: crisp, straight contact with the ground instead of a jagged shallow-angle intersection
      else dmin = Math.min(dmin, (d - 1) * Math.sqrt(rx * rz));
    }
    if (H > 0) return H * (1 + rough * DN.fbm2(x * 0.9 + seed * 1.7, z * 0.9 + seed * 5.3, 2));
    return -Math.min(bury, dmin * SLOPE);
  };
  const Hs = new Float32Array((nx + 1) * (nz + 1)), pos = [], map = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) Hs[j * (nx + 1) + i] = heightAt(x0 + i * sx, z0 + j * sz);
  const keep = (i, j) => Hs[j * (nx + 1) + i] > -bury + 1e-4;
  const idx = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (!(keep(i, j) || keep(i + 1, j) || keep(i, j + 1) || keep(i + 1, j + 1))) continue;
    const q = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]].map(([a, b]) => {
      const k = b * (nx + 1) + a;
      if (map[k] < 0) { map[k] = pos.length / 3; pos.push(x0 + a * sx, Hs[k], z0 + b * sz); }
      return map[k];
    });
    idx.push(q[0], q[2], q[1], q[1], q[2], q[3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** a continuous wavy drift lying along a straight run a..b (local x) at lateral position z: used along deck edges and parapets */
export function runDrift(a, b, z, rz, h, seed, { step = 4.6, wob = 0.45, rot = 0.18 } = {}) {
  const l = b - a, n = Math.max(1, Math.ceil(l / step)), st = l / n, r = rng(Math.floor(Math.abs(seed) * 100) + 17);
  const lumps = [];
  for (let i = 0; i < n; i++)
    lumps.push([a + (i + 0.5) * st + (r() - 0.5) * st * 0.25, z + (r() - 0.5) * wob, st * (0.74 + r() * 0.2), rz * (0.8 + r() * 0.4), h * (0.62 + r() * 0.7), (r() - 0.5) * rot]);
  return snowDrift(lumps, { seed: seed + 3, cell: 0.65, bury: 0.5, warp: 0.14 });
}

/** a soft cap of snow sitting on a flat top of size w x d (centre at the origin, base at y = 0): rounded outline, a slight lean toward +x */
export function snowCap(w, d, h, seed = 1, o = {}) {
  return snowDrift([[w * 0.03, 0, w * 0.5, d * 0.5, h], [-w * 0.2, d * 0.1, w * 0.3, d * 0.34, h * 0.55]], { seed, bury: 0.3, warp: 0.16, ...o });
}

// ── railing ──────────────────────────────────────────────────────────────────
export function railing(B, lod, col, a, b, h = 1.15, solid = true) {
  const len = a.distanceTo(b);
  if (len < 0.01) return;
  if (lod <= 1) {
    const n = Math.max(1, Math.round(len / 1.7));
    for (let i = 0; i <= n; i++) {
      const p = a.clone().lerp(b, i / n);
      B.add('metal', cyl(0.05, 0.065, h, 8), M(p.x, p.y + h / 2, p.z));
      if (lod === 0) B.add('trim', new THREE.SphereGeometry(0.085, 10, 8), M(p.x, p.y + h + 0.02, p.z));
    }
    B.add('trim', strut(a.clone().add(V(0, h, 0)), b.clone().add(V(0, h, 0)), 0.065, lod === 0 ? 10 : 6));
    if (lod === 0) {
      B.add('metal', strut(a.clone().add(V(0, h * 0.52, 0)), b.clone().add(V(0, h * 0.52, 0)), 0.035, 6));
      B.add('metal', strut(a.clone().add(V(0, h * 0.2, 0)), b.clone().add(V(0, h * 0.2, 0)), 0.035, 6));
    }
  }
  if (solid) col(Math.min(a.x, b.x) - 0.07, a.y, Math.min(a.z, b.z) - 0.07, Math.max(a.x, b.x) + 0.07, a.y + h, Math.max(a.z, b.z) + 0.07);
}

/** a few extra treads below the first step (flight foot): when the terrain at the foot is lower than the height the flight was built from,
 *  the first real tread would be out of step reach; these treads are buried (invisible) on flat ground and give a way on where it dips. */
const FOOT_STEPS = 6;
function footSteps(F, lod, width, sh, run) {
  for (let i = -FOOT_STEPS; i < 0; i++) {
    const top = sh * (i + 1) - 0.06;                       // a hair below the first tread's base level: no z-fighting with the ground it is buried in
    F.col(-width / 2, -4, run * i, width / 2, top, run * (i + 1));
    if (lod < 3) F.B.add('trim', rbox(width, top + 4, run + 0.04, 0.05, 1), M(0, (top - 4) / 2, run * i + run / 2));
  }
}

// ── stairs: ascend along local +z starting at z=0 ───────────────────────────────────────────────
export function stairs(B, lod, col, o) {
  const { step = 0.2, run = 0.36 } = o;
  if (ASSETS.structs?.stairstep && Math.abs(run - 0.36) < 1e-6 && Math.abs(step - 0.2) < 1e-6) return stairsAsset(B, lod, col, o);
  return stairsProc(B, lod, col, o);
}

// Blender stair parts (tools/gen_structures.py): bevelled tread + riser per step, stringer cap beams with handrails (6-step and 1-step units),
// buttress fins on the retaining walls. Solid fill under the flight (rooted 4 m below the base) so it never floats on uneven terrain.
function stairsAsset(B, lod, col, { x = 0, z = 0, y = 0, rise, width = 3.4, dir = 0, step = 0.2, run = 0.36 }) {
  const n = Math.max(2, Math.round(rise / step));
  const sh = rise / n, L = n * run;
  const F = frame(B, col, x, y, z, dir);
  for (let i = 0; i < n; i++) F.col(-width / 2, -4, run * i, width / 2, sh * (i + 1), run * (i + 1));
  footSteps(F, lod, width, sh, run);
  const sy = sh / 0.2, sx = width / 3.4;
  const wedge = (top0, top1, t, bevel) => {
    const s = new THREE.Shape();
    s.moveTo(0, -4); s.lineTo(L, -4); s.lineTo(L, top1); s.lineTo(0, top0); s.closePath();
    return extrude(s, t, bevel, 3, 2);
  };
  // retaining walls + core fill
  const wt = 0.42;
  const wall = wedge(0.3, rise + 0.3, wt, lod < 2 ? 0.05 : 0.0);
  for (const sg of [-1, 1]) F.B.add('wall', wall, M(sg > 0 ? width / 2 + wt : -width / 2, 0, 0, 0, -Math.PI / 2, 0));
  F.B.add('wall', wedge(-0.04, rise - 0.04, width, 0), M(width / 2, 0, 0, 0, -Math.PI / 2, 0));
  if (lod >= 2) { F.B.add('trim', wedge(0, rise, width - 0.2, 0), M(width / 2 - 0.1, 0.02, 0, 0, -Math.PI / 2, 0)); return; }
  // treads
  for (let i = 0; i < n; i++) addStruct(F.B, 'stairstep', lod, M(0, sh * i, run * i, 0, 0, 0, sx, sy, 1));
  // stringer caps + handrails
  const n6 = Math.floor(n / 6);
  for (const [sg, nm] of [[1, 'a'], [-1, 'b']]) {
    for (let u = 0; u < n6; u++) addStruct(F.B, 'stairrun6' + nm, lod, M(sg * width / 2, sh * 6 * u, run * 6 * u, 0, 0, 0, 1, sy, 1));
    for (let i = n6 * 6; i < n; i++) addStruct(F.B, 'stairrun1' + nm, lod, M(sg * width / 2, sh * i, run * i, 0, 0, 0, 1, sy, 1));
  }
  // buttress fins on the outer wall faces
  const ks = sh / run;
  for (let u = 0; u * 6 * run + 1.08 < L - 0.5; u++) {
    const zf = run * 6 * u + 1.08, H = 0.3 + ks * zf - 0.95 + 4;
    addStruct(F.B, 'stairfin', lod, M(width / 2 + wt, -4, zf, 0, 0, 0, 1, H, 1));
    addStruct(F.B, 'stairfin', lod, M(-(width / 2 + wt), -4, zf, 0, Math.PI, 0, 1, H, 1));
  }
}

function stairsProc(B, lod, col, { x = 0, z = 0, y = 0, rise, width = 3.4, dir = 0, step = 0.2, run = 0.36, rails = true }) {
  const n = Math.max(2, Math.round(rise / step));
  const sh = rise / n, L = n * run;
  const F = frame(B, col, x, y, z, dir);
  for (let i = 0; i < n; i++) {
    const top = sh * (i + 1);
    F.B.add('trim', rbox(width, top + 4, run + 0.04, 0.06, 2), M(0, (top - 4) / 2, run * i + run / 2));
    F.col(-width / 2, -4, run * i, width / 2, top, run * (i + 1));
  }
  footSteps(F, lod, width, sh, run);
  if (lod < 2) {
    // side stringer walls (sloped wedge, bevelled)
    const s = new THREE.Shape();
    s.moveTo(0, -4); s.lineTo(L, -4); s.lineTo(L, rise + 0.55); s.lineTo(0, 0.55); s.closePath();
    const wedge = extrude(s, 0.38, 0.07, 3, 2);
    for (const sx of [-1, 1])
      F.B.add('wallLight', wedge, M(sx > 0 ? width / 2 + 0.38 : -width / 2, 0, 0, 0, -Math.PI / 2, 0));
    if (rails) for (const sx of [-1, 1]) {
      const a = V(sx * (width / 2 - 0.1), 0.05, 0), b = V(sx * (width / 2 - 0.1), rise + 0.05, L);
      F.B.add('trim', strut(a.clone().add(V(0, 1.05, 0)), b.clone().add(V(0, 1.05, 0)), 0.06, lod === 0 ? 10 : 6));
      if (lod === 0) {
        F.B.add('metal', strut(a.clone().add(V(0, 0.5, 0)), b.clone().add(V(0, 0.5, 0)), 0.03, 6));
        for (let i = 0; i <= n; i += 3) F.B.add('metal', cyl(0.045, 0.055, 1.05, 8), M(a.x, sh * i + 0.55, run * i));
      }
    }
  }
}

/** Landing platform at a parapet/rail gap (stair opening): a flush slab reaching LAND_L past the deck edge, so a flight whose top tread
 *  stops a little short of the deck (flight length depends on the terrain it starts from) still connects without a hole to fall into. */
const LAND_L = 2.7;
function landings(F, lod, y, z, width, gaps) {
  for (const g of gaps) {
    const sz = g.side, gw = g.x1 - g.x0, cx = (g.x0 + g.x1) / 2;
    const z0 = z + sz * (width / 2 - 0.3), zc = z0 + sz * LAND_L / 2;
    if (lod < 3) {
      F.B.add('wallDark', rbox(gw - 0.25, 0.46, LAND_L, 0.1, 2), M(cx, y - 0.26, zc));
      F.B.add('deck', rbox(gw - 0.55, 0.08, LAND_L - 0.3, 0.025, 1), M(cx, y - 0.045, zc));
      F.B.add('trim', rbox(gw - 0.15, 0.1, 0.34, 0.05, 1), M(cx, y - 0.08, z0 + sz * (LAND_L - 0.1)));        // nosing toward the stair
    }
    if (lod < 2) for (const sx of [-1, 1]) railing(F.B, lod, F.col, V(cx + sx * (gw / 2 - 0.2), y, z0), V(cx + sx * (gw / 2 - 0.2), y, z0 + sz * (LAND_L - 0.2)), 1.05, true);
    F.col(g.x0 + 0.1, y - 0.6, Math.min(z0, z0 + sz * LAND_L), g.x1 - 0.1, y, Math.max(z0, z0 + sz * LAND_L));
  }
}

// ── catwalk along local x, deck top at y=0 ─────────────────────────────────────────────────────
export function catwalk(B, lod, col, o) {
  if (ASSETS.structs?.cwbay && o.width === 4.6) return catwalkAsset(B, lod, col, o);
  return catwalkProc(B, lod, col, o);
}

// Blender truss bay (deck planks, I-beam side members, Warren truss with gussets, cross beams) + rail modules, tiled along x.
function catwalkAsset(B, lod, col, { x0, x1, y, z = 0, width = 4.6, solidRails = true, yaw = 0, tx = 0, tz = 0, gaps = [] }) {
  const F = frame(B, col, tx, 0, tz, yaw);
  const len = x1 - x0;
  const nb = Math.max(1, Math.round(len / 2.6)), bl = len / nb;
  F.col(x0, y - 0.6, z - width / 2, x1, y, z + width / 2);
  landings(F, lod, y, z, width, gaps);
  for (let i = 0; i < nb; i++) addStruct(F.B, 'cwbay', lod, M(x0 + (i + 0.5) * bl, y, z, 0, i % 2 ? Math.PI : 0, 0, bl / 2.6, 1, 1));
  if (lod < 2) {   // soft snow drifts piled along the deck edges
    for (const sz of [-1, 1]) {
      const mine = gaps.filter((g) => g.side === sz).map((g) => [g.x0, g.x1]);
      for (const [a, b] of cut(x0, x1, mine)) if (b - a > 3) F.B.add('snow', runDrift(a + 0.6, b - 0.6, z + sz * (width / 2 - 0.9), 0.85, 0.42, a * 0.07 + sz * 3, { step: 5.5 }), M(0, y + 0.02, 0), { noAO: true, tint: snowTint(Math.round(a) + (sz > 0 ? 1 : 0)) });
    }
  }
  for (const sz of [-1, 1]) {
    const mine = gaps.filter((g) => g.side === sz).map((g) => [g.x0, g.x1]);
    const zr = z + sz * (width / 2 - 0.12);
    for (const [a, b] of cut(x0, x1, mine)) {
      const l = b - a, n = Math.max(1, Math.round(l / 2.6)), w = l / n;
      if (lod < 2) for (let i = 0; i < n; i++) addStruct(F.B, 'cwrail', lod, M(a + (i + 0.5) * w, y, zr, 0, 0, 0, w / 2.6, 1, 1));
      if (solidRails) F.col(a, y, zr - 0.07, b, y + 1.12, zr + 0.07);
    }
  }
}

function catwalkProc(B, lod, col, { x0, x1, y, z = 0, width = 4.4, truss = true, solidRails = true, yaw = 0, tx = 0, tz = 0, gaps = [] }) {
  const F = frame(B, col, tx, 0, tz, yaw);
  const len = x1 - x0, cx = (x0 + x1) / 2;
  F.B.add('deck', rbox(len, 0.38, width, 0.1, 3), M(cx, y - 0.19, z));
  F.col(x0, y - 0.6, z - width / 2, x1, y, z + width / 2);
  landings(F, lod, y, z, width, gaps);
  if (lod < 2) for (let x = x0 + 2.4; x < x1 - 1; x += 2.4) F.B.add('wallDark', rbox(0.14, 0.06, width - 0.9, 0.02, 1), M(x, y + 0.01, z));
  for (const sz of [-1, 1]) {
    F.B.add('wallLight', rbox(len, 0.62, 0.34, 0.1, 2), M(cx, y - 0.31, z + sz * (width / 2 - 0.1)));
    const mine = gaps.filter((g) => g.side === sz).map((g) => [g.x0, g.x1]);
    for (const [a, b] of cut(x0, x1, mine))
      railing(F.B, lod, F.col, V(a, y, z + sz * (width / 2 - 0.12)), V(b, y, z + sz * (width / 2 - 0.12)), 1.12, solidRails);
  }
  if (lod < 2) {
    const nb = Math.max(2, Math.round(len / 2.6));
    for (let i = 0; i <= nb; i++) {
      const x = x0 + (len * i) / nb;
      F.B.add('metal', rbox(0.28, 0.34, width - 0.1, 0.06, 1), M(x, y - 0.55, z));
    }
    if (truss && lod === 0) {
      const dp = Math.min(2.2, len * 0.08 + 1.2);
      for (const sz of [-1, 1]) {
        const zz = z + sz * (width / 2 - 0.2);
        F.B.add('metal', rbox(len, 0.26, 0.26, 0.06, 1), M(cx, y - 0.7 - dp, zz));
        for (let i = 0; i < nb; i++) {
          const xa = x0 + (len * i) / nb, xb = x0 + (len * (i + 1)) / nb;
          const up = i % 2 === 0;
          F.B.add('metal', strut(V(xa, up ? y - 0.7 : y - 0.7 - dp, zz), V(xb, up ? y - 0.7 - dp : y - 0.7, zz), 0.1, 8));
        }
      }
    }
  }
}

// ── viaduct segment: along local x, deck top at world height deckY (local y == world y) ────────────
function cut(x0, x1, gaps = []) {
  let segs = [[x0, x1]];
  for (const g of gaps) {
    const out = [];
    for (const [a, b] of segs) {
      if (g[1] <= a || g[0] >= b) { out.push([a, b]); continue; }
      if (g[0] > a) out.push([a, g[0]]);
      if (g[1] < b) out.push([g[1], b]);
    }
    segs = out;
  }
  return segs.filter(([a, b]) => b - a > 0.2);
}

/** x0..x1 local (centred on the structure origin), deck top at world height deckY (structure y = 0).
 *  gaps: [{side:-1|1, x0, x1}] openings in the parapet (stair landings). Piers sit at x0 + k*span. */
export function viaduct(o) {
  return ASSETS.structs?.viaspan && (o.width ?? 13) === 13 && (o.span ?? 22) === 22 ? viaductAsset(o) : viaductProc(o);
}

// Blender modules (tools/gen_structures.py): arcade span (deck, slim edge beam, tall elliptical arches), open balustrade, lamp, pier head / shaft / foot / tie.
const PIER_COLZ = 5.1, PIER_HEAD = 7.4;      // PIER_HEAD must match gen_structures.py
const hash01 = (n) => { const q = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return q - Math.floor(q); };

function viaductAsset({ x0, x1, deckY, width = 13, span = 22, ground, gaps = [], endPier = false }) {
  return (lod, B, col) => {
    const len = x1 - x0, hw = width / 2;
    const nSpan = Math.max(1, Math.round(len / span));
    const top = deckY - 2.8;
    col(x0, deckY - 1.0, -hw, x1, deckY, hw);
    for (let k = 0; k < nSpan; k++) addStruct(B, 'viaspan', lod, M(x0 + span * (k + 0.5), deckY, 0));
    // parapets (tiled 5.5 m modules, stretched to fill each run between stair openings) + lamps + deck snow
    for (const sz of [-1, 1]) {
      const mine = gaps.filter((g) => g.side === sz).map((g) => [g.x0, g.x1]);
      for (const [a, b] of cut(x0, x1, mine)) {
        const l = b - a, n = Math.max(1, Math.round(l / 5.5)), w = l / n;
        for (let i = 0; i < n; i++) addStruct(B, 'viarail', lod, M(a + (i + 0.5) * w, deckY, sz * (hw - 0.45), 0, 0, 0, w / 5.5, 1, 1));
        col(a, deckY, sz * (hw - 0.9), b, deckY + 1.35, sz * hw);
        if (lod < 2) B.add('snow', runDrift(a, b, sz * (hw - 1.75), 1.3, 0.45, a * 0.1 + sz * 7), M(0, deckY + 0.02, 0), { noAO: true, tint: snowTint(Math.round(a * 0.1) + (sz > 0 ? 1 : 0)) });
      }
    }
    if (lod < 2) for (let k = 0; k < nSpan; k++) for (const sz of [-1, 1]) {
      const x = x0 + span * (k + 0.5);
      if (gaps.some((g) => g.side === sz && x > g.x0 - 1.5 && x < g.x1 + 1.5)) continue;
      addStruct(B, 'vialamp', lod, M(x, deckY + 1.3, sz * (hw - 0.5), 0, sz > 0 ? 0 : Math.PI, 0));
    }
    // piers: head (cap beam + portal arch + upper columns), stretched shaft, flared footing
    for (let px = x0; px < x1 + (endPier ? 0.01 : -0.01); px += span) {
      const g = ground(px);
      if (g > top + 1.5) continue;                                   // buried in a mesa
      const orange = Math.round((px - x0) / span) % 2 === 0;
      const remap = orange ? {} : { accent: 'wallLight' };
      const hs = hash01(g * 3.17 + Math.round(px) * 0.013);          // deterministic per-pier variety (some piers half buried in drifts)
      addStruct(B, 'viahead', lod, M(px, top, 0), remap);
      if (hs > 0.8 && ASSETS.props?.spire0 && !(gaps.length && gaps.some((g) => Math.abs(px - (g.x0 + g.x1) / 2) < 12))) {
        // a needle tower grows out of this pier through the deck edge: breaks the long horizontal line like the concept's spires
        const sd = hs > 0.9 ? 1 : -1, H = 40 + (hs - 0.8) * 230, tz = sd * 6.2;
        addProp(B, `spire${Math.floor(hs * 977) % 8}`, lod, M(px, deckY - 1.5, tz, 0, hs * 40, 0, 0.24, H / 100, 0.24));
        col(px - 1.8, deckY - 1, tz - 1.8, px + 1.8, deckY + H * 0.4, tz + 1.8);
      }
      const hb = top - PIER_HEAD, yFoot = Math.min(g + 1.6, hb - 0.2), len = hb - yFoot;
      for (const sz of [-1, 1]) {
        const zc = sz * PIER_COLZ;
        if (len > 0.25) addStruct(B, 'viashaft', lod, M(px, hb, zc, 0, 0, 0, 1, len / 10, 1), remap);
        if (len > 9 && lod < 2) addStruct(B, 'viatie', lod, M(px, hb - len * 0.45, 0));
        addStruct(B, 'viafoot', lod, M(px, yFoot, zc));
        if (lod < 2) {
          const big = hs < 0.22 ? 1.9 : 1;                           // buried piers: drift climbs well up the shaft
          B.add('snow', snowDrift([
            [0, 0, 4.4 * (big > 1 ? 1.2 : 1), 4.2 * (big > 1 ? 1.2 : 1), 1.45 * big], [2.9 * (sz > 0 ? -1 : 1), 1.2 * sz, 3.4, 2.4, 0.85 * big, 0.5 * sz],
            [-1.8 * (sz > 0 ? -1 : 1), -2.6 * sz, 2.6, 2.0, 0.7 * big, -0.4], [0.6, 3.2 * sz, 2.8, 1.8, 0.55],
          ], { seed: px * 0.13 + zc, cell: lod === 0 ? 0.7 : 1.2, bury: 1.9 }), M(px, yFoot - 1.78, zc), { noAO: true, tint: snowTint(Math.round(px)) });
        }
        col(px - 1.8, g - 1, zc - 1.5, px + 1.8, top, zc + 1.5);
      }
    }
  };
}

function viaductProc({ x0, x1, deckY, width = 13, span = 22, ground, gaps = [], endPier = false, solidRails = true }) {
  return (lod, B, col) => {
    const len = x1 - x0, cx = (x0 + x1) / 2;
    const hw = width / 2;
    B.add('deck', rbox(len, 0.9, width, 0.14, 3), M(cx, deckY - 0.45, 0));
    col(x0, deckY - 1.0, -hw, x1, deckY, hw);
    for (const sz of [-1, 1]) {
      const mine = gaps.filter((g) => g.side === sz).map((g) => [g.x0, g.x1]);
      for (const [a, b] of cut(x0, x1, mine)) {
        const l = b - a, c = (a + b) / 2;
        B.add('wallLight', rbox(l, 1.15, 0.9, 0.18, 3), M(c, deckY + 0.58, sz * (hw - 0.45)));
        B.add('trim', rbox(l, 0.3, 1.1, 0.12, 2), M(c, deckY + 1.2, sz * (hw - 0.5)));
        col(a, deckY, sz * (hw - 0.9), b, deckY + 1.35, sz * hw);
        if (lod === 0) {
          const panels = Math.max(1, Math.floor(l / 5.5));
          for (let i = 0; i < panels; i++) {
            const x = a + (i + 0.5) * (l / panels);
            B.add('wallDark', rbox(Math.max(0.5, l / panels - 1.3), 0.55, 0.12, 0.05, 1), M(x, deckY + 0.6, sz * (hw - 0.02)));
          }
        }
        if (lod < 2) {
          const n = Math.max(1, Math.ceil(l / 9));
          for (let i = 0; i < n; i++) {
            const w = l / n;
            B.add('snow', snowPillow(w * 0.92, 2.1, 0.55, { seed: i + sz * 7 + a * 0.1, seg: 12, bury: 0.4 }), M(a + (i + 0.5) * w, deckY + 0.02, sz * (hw - 1.9)), { noAO: true, tint: snowTint(i + (sz > 0 ? 1 : 0)) });
          }
        }
      }
    }
    if (lod < 2) {
      for (let x = x0 + 5.5; x < x1; x += 5.5) B.add('wallDark', rbox(0.22, 0.08, width - 3.4, 0.03, 1), M(x, deckY + 0.02, 0));
      for (const sz of [-1, 1]) B.add('accentDark', rbox(len, 0.07, 0.3, 0.03, 1), M(cx, deckY + 0.02, sz * (hw - 3.0)));
    }
    // underside: longitudinal box girders + cross ribs
    for (const sz of [-1, 0, 1]) B.add('wall', rbox(len, 1.9, 1.5, 0.18, 3), M(cx, deckY - 1.85, sz * (hw - 2.2)));
    if (lod < 2) for (let x = x0 + 1.2; x < x1; x += 3.6) B.add('wallDark', rbox(0.5, 1.2, width - 1.0, 0.08, 1), M(x, deckY - 1.4, 0));
    if (lod === 0)
      for (let x = x0 + span / 2; x < x1; x += span) {
        for (const sz of [-1, 1]) {
          if (gaps.some((g) => g.side === sz && x > g.x0 - 1 && x < g.x1 + 1)) continue;
          B.add('accent', rbox(0.55, 1.15, 0.4, 0.1, 2), M(x, deckY + 1.9, sz * (hw - 0.5)));
          B.add('metal', cyl(0.09, 0.12, 3.2, 8), M(x, deckY + 2.6, sz * (hw - 0.5)));
        }
      }
    for (let px = x0; px < x1 + (endPier ? 0.01 : -0.01); px += span) {
      const g = ground(px);
      const top = deckY - 2.8;
      pier(B, lod, col, px, g, top, hw, Math.max(1, top - g));
    }
  };
}

function pier(B, lod, col, px, g, top, hw, h) {
  // cap beam
  B.add('wall', rbox(3.6, 1.7, hw * 2 - 1.4, 0.3, 3), M(px, top - 0.85, 0));
  B.add('trim', rbox(4.1, 0.4, hw * 2 - 1.0, 0.14, 2), M(px, top - 1.55, 0));
  const colsZ = [-(hw - 2.6), hw - 2.6];
  for (const z of colsZ) {
    const sec = [
      { y: g - 1.5, rx: 2.2, rz: 2.6, n: 4.4 }, { y: g + 0.6, rx: 1.75, rz: 2.15, n: 4.2 },
      { y: g + h * 0.35, rx: 1.25, rz: 1.55, n: 4 }, { y: top - 1.7, rx: 1.45, rz: 1.8, n: 4 },
    ];
    sec.forEach((s) => { s.oz = z; s.ox = px; });
    B.add('wall', loft(sec, { seg: lod === 0 ? 32 : lod === 1 ? 22 : 14 }));
    // base footing, flared and buried
    B.add('wallDark', rbox(5.0, 1.5, 5.8, 0.4, 3), M(px, g + 0.05, z));
    if (lod < 2) B.add('snow', snowPillow(8.4, 8.6, 1.5, { seed: px * 0.13 + z, seg: 16, bury: 0.8 }), M(px, g - 0.1, z), { noAO: true, tint: snowTint(Math.round(px)) });
    col(px - 1.6, g - 1, z - 2.0, px + 1.6, top, z + 2.0);
  }
  // portal arch between the two columns (smooth curved geometry)
  if (lod < 2) {
    const zin = colsZ[1] - 1.3, archTop = top - 1.8;
    const yb = g + Math.min(h * 0.38, h - 3.2);
    if (archTop - yb > 3) {
      const rr = zin, cy = archTop - rr * 0.55;
      const s = new THREE.Shape();
      s.moveTo(-zin, yb); s.lineTo(zin, yb); s.lineTo(zin, cy);
      s.absarc(0, cy, zin, 0, Math.PI, false);
      s.lineTo(-zin, yb);
      const hole = new THREE.Path();
      const inner = zin - 1.5;
      hole.moveTo(-inner, yb - 0.01); hole.lineTo(-inner, cy); hole.absarc(0, cy, inner, Math.PI, 0, true); hole.lineTo(inner, yb - 0.01); hole.closePath();
      s.holes.push(hole);
      const arch = extrude(s, 1.7, 0.1, lod === 0 ? 12 : 6, 2);
      B.add('wallLight', arch, M(px - 0.85, 0, 0, 0, Math.PI / 2, 0));
    }
  }
}

// ── giant ring landmark: the ring plane faces local +z ────────────────────────────────────────────
export function ringGate(opts = {}) {
  return ASSETS.structs?.ringbase ? ringGateAsset(opts) : ringGateProc(opts);
}

// Blender-modelled ring (tools/gen_structures.py): revolved body with an annular trough, 32 segmented face panels per side,
// structural clamps, conduits and cradle pedestals. Ring centre at (0, cy, 0), ring plane faces local +z, opening walk-through.
const _ra = new THREE.Matrix4(), _rf = new THREE.Matrix4().makeRotationY(Math.PI);
function ringM(cy, a, back = false, tx = 0, ty = 0, tz = 0) {
  const m = new THREE.Matrix4().makeTranslation(tx, cy + ty, tz);
  m.multiply(_ra.makeRotationZ(back ? a + Math.PI : a));
  if (back) m.multiply(_rf);
  return m;
}
function ringGateAsset({ cy = 11.2 }) {
  const rIn = 12.2, rOut = 17, depth = 7;
  return (lod, B, col) => {
    addStruct(B, 'ringbase', lod, M(0, cy, 0));
    const N = 32;
    const accentMap = { wallLight: 'accent', wall: 'accentDark' };
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const orange = i % 8 !== 3;
      for (const back of [false, true]) {
        if (lod < 2) addStruct(B, 'ringpanel', lod, ringM(cy, a, back), orange ? accentMap : {});
        else if (orange) addStruct(B, 'ringpanel', lod, ringM(cy, a, back), { wallLight: 'accent' });
      }
      if (lod < 2) { addStruct(B, 'ringliner', lod, ringM(cy, a)); addStruct(B, 'ringouter', lod, ringM(cy, a)); }
    }
    for (let i = 0; i < 8; i++) addStruct(B, 'ringclamp', lod, ringM(cy, (i / 8) * Math.PI * 2 + Math.PI / 8));
    addStruct(B, 'ringcrown', lod, ringM(cy, Math.PI / 2));
    if (lod < 2) for (const a of [Math.PI * 0.62, Math.PI * 1.25, Math.PI * 0.12]) addStruct(B, 'ringduct', lod, ringM(cy, a));
    // pedestal blocks flanking the opening + snow on their caps
    const chord = Math.sqrt(rIn * rIn - cy * cy);
    for (const sx of [-1, 1]) {
      const px = sx * (chord + 4.6);
      addStruct(B, 'ringped', lod, M(px, 0, 0, 0, sx > 0 ? 0 : Math.PI, 0));
      if (lod < 2) B.add('snow', snowCap(7.4, depth + 4.4, 1.1, 5 + sx), M(px, 4.05, 0), { noAO: true, tint: snowTint(sx) });
      col(px - 3.75, -2, -(depth + 6) / 2, px + 3.75, 3.2, (depth + 6) / 2);
    }
    // lower arc: collision approximated by two solid sectors beside the opening
    col(-rOut - 1, -3, -depth / 2 - 1, -chord, cy * 0.7, depth / 2 + 1);
    col(chord, -3, -depth / 2 - 1, rOut + 1, cy * 0.7, depth / 2 + 1);
  };
}

function ringGateProc({ rOut = 17, rIn = 12.2, cy = 11.2 }) {
  return (lod, B, col) => {
    const arc = [192, 128, 72, 40][lod];
    const depth = 7;
    const body = ringShape(rOut, rIn);
    const g = extrude(body.shape, depth, 0.28, arc, lod === 0 ? 4 : 2);
    // base body (dark), outer & inner flanges (light), segmented panels (accents every 4th)
    B.add('wall', g, M(0, cy, -depth / 2));
    if (lod < 3) {
      B.add('wallLight', extrude(ringShape(rOut + 0.9, rOut - 0.4).shape, 1.0, 0.18, arc, 3), M(0, cy, depth / 2 - 0.05));
      B.add('wallLight', extrude(ringShape(rOut + 0.9, rOut - 0.4).shape, 1.0, 0.18, arc, 3), M(0, cy, -depth / 2 - 0.95));
      B.add('wallDark', extrude(ringShape(rIn + 0.15, rIn - 1.0).shape, depth + 1.0, 0.16, arc, 3), M(0, cy, -depth / 2 - 0.5));
    }
    const N = lod === 0 ? 40 : lod === 1 ? 32 : 24;
    if (lod < 3)
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2 + 0.015, a1 = ((i + 1) / N) * Math.PI * 2 - 0.015;
        const accent = i % 5 === 2;
        for (const side of [-1, 1]) {
          const sector = ringShape(rOut - 0.25, rIn + 1.0, a0, a1).shape;
          const p = extrude(sector, 0.45, 0.1, lod === 0 ? 10 : 4, 2);
          B.add(accent ? 'accent' : 'wallLight', p, M(0, cy, side > 0 ? depth / 2 + 0.55 : -depth / 2 - 1.0));
        }
        if (lod === 0 && !accent) {
          const am = (a0 + a1) / 2, rm = (rOut + rIn) / 2 + 0.2;
          B.add('wallDark', rbox(2.2, 0.35, 0.5, 0.1, 2), M(Math.cos(am) * rm, cy + Math.sin(am) * rm, depth / 2 + 1.0, 0, 0, am + Math.PI / 2));
        }
      }
    // structural joints / clamps + a few mechanical interfaces
    if (lod < 3)
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const rm = (rOut + rIn) / 2;
        const x = Math.cos(a) * rm, y = cy + Math.sin(a) * rm;
        B.add('metal', rbox(3.6, 2.2, depth + 2.8, 0.45, 3), M(x, y, 0, 0, 0, a));
        if (lod === 0) {
          B.add('trim', rbox(3.0, 0.5, depth + 3.1, 0.18, 2), M(x, y, 0, 0, 0, a));
          for (const sz of [-1, 1]) B.add('metal', cyl(0.5, 0.5, 0.5, 16), M(x + Math.cos(a) * 0.9, y + Math.sin(a) * 0.9, sz * (depth / 2 + 1.5), Math.PI / 2, 0, 0));
        }
      }
    // pedestal blocks flanking the opening and the cradle that holds the buried lower arc
    const chord = Math.sqrt(rIn * rIn - cy * cy);
    for (const sx of [-1, 1]) {
      B.add('wallDark', rbox(7.5, 3.2, depth + 6, 0.5, 3), M(sx * (chord + 4.6), 1.4, 0));
      if (lod < 3) B.add('wall', rbox(6.2, 1.2, depth + 5, 0.35, 3), M(sx * (chord + 4.6), 3.5, 0));
      if (lod < 2) B.add('snow', snowPillow(8, depth + 5, 1.25, { seed: 5 + sx, seg: 16, bury: 0.6 }), M(sx * (chord + 4.6), 4.0, 0), { noAO: true, tint: snowTint(sx) });
      col(sx * (chord + 4.6) - 3.75, -2, -(depth + 6) / 2, sx * (chord + 4.6) + 3.75, 3.2, (depth + 6) / 2);
    }
    // lower arc: collision approximated by two solid sectors beside the opening
    col(-rOut - 1, -3, -depth / 2 - 1, -chord, cy * 0.7, depth / 2 + 1);
    col(chord, -3, -depth / 2 - 1, rOut + 1, cy * 0.7, depth / 2 + 1);
  };
}

// ── needle spires: clusters of tapered, stepped obelisks with orange facet slabs ──────────────────────
export function spireCluster({ seed = 1, count = 4, height = 90, spread = 16, wide = 7 }) {
  if (ASSETS.props?.spire0) return spireClusterAsset({ seed, count, height, spread, wide });
  return spireClusterProc({ seed, count, height, spread, wide });
}

/** snow drifted around the foot of a spire cluster: a soft mound per needle plus a low skirt (structure origin sits 2.5 below the terrain) */
function spireSnow(B, lod, lumps, seed) {
  if (lod >= 2) return;
  B.add('snow', snowDrift(lumps, { seed, cell: lod === 0 ? 2.0 : 3.4, bury: 2.2, warp: 0.22 }), M(0, 2.35, 0), { noAO: true, tint: snowTint(seed) });
}

function spireClusterAsset({ seed, count, height, spread, wide }) {
  return (lod, B, col) => {
    const r = rng(seed), rd = rng(seed + 99);
    const lumps = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + r(), d = i === 0 ? 0 : spread * (0.55 + r() * 0.6);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const H = height * (i === 0 ? 1 : 0.4 + r() * 0.45);
      const w = wide * (i === 0 ? 1 : 0.55 + r() * 0.3);
      const variant = Math.floor(r() * 8);
      addProp(B, `spire${(variant + seed) % 8}`, lod, M(x, 0, z, 0, r() * 6.28, 0, w / 6, H / 100, w / 6));
      col(x - w, -5, z - w * 0.8, x + w, H * 0.9, z + w * 0.8);
      lumps.push([x, z, w * 3.0, w * 2.6, 1.5 + w * 0.12, rd() * 3], [x + w * 1.2, z - w * 0.8, w * 5.4, w * 3.4, 0.75, rd() * 3]);
    }
    spireSnow(B, lod, lumps, seed);
  };
}

function spireClusterProc({ seed = 1, count = 4, height = 90, spread = 16, wide = 7 }) {
  return (lod, B, col) => {
    const r = rng(seed);
    const seg = [44, 30, 22, 14][lod], rd = rng(seed + 99);
    const lumps = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + r(), d = i === 0 ? 0 : spread * (0.55 + r() * 0.6);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const H = height * (i === 0 ? 1 : 0.4 + r() * 0.45);
      const w = wide * (i === 0 ? 1 : 0.55 + r() * 0.3);
      const lean = (r() - 0.5) * 0.05;
      const tiers = 3 + Math.floor(H / 30);
      const tipH = H * 0.2, shaftH = H - tipH;
      const sec = [{ y: -6, rx: w * 1.3, rz: w * 1.1, n: 4.8 }, { y: 0, rx: w * 1.1, rz: w * 0.95, n: 4.8 }];
      for (let k = 0; k <= tiers; k++) {
        const t0 = k / tiers, t1 = Math.min(1, (k + 1) / tiers);
        const f0 = 1 - 0.58 * t0, f1 = 1 - 0.58 * Math.min(1, t1 - 0.04);
        if (k > 0) sec.push({ y: t0 * shaftH, rx: w * f0 * 1.07, rz: w * 0.84 * f0 * 1.07, n: 5, ox: lean * t0 * shaftH });   // collar ledge
        if (k > 0) sec.push({ y: t0 * shaftH + 1.2, rx: w * f0, rz: w * 0.84 * f0, n: 4.6, ox: lean * t0 * shaftH });
        if (k < tiers) sec.push({ y: (k + 1) * shaftH / tiers - 1.5, rx: w * f1, rz: w * 0.84 * f1, n: 4.6, ox: lean * (k + 1) * shaftH / tiers });
      }
      const top = sec[sec.length - 1];
      for (let q = 1; q <= 9; q++) {
        const t = q / 9, shrink = Math.pow(1 - t, 0.8);
        sec.push({ y: shaftH + t * tipH, rx: top.rx * shrink + 0.01, rz: top.rz * shrink + 0.01, n: 4 - t * 1.2, ox: lean * (shaftH + t * tipH) });
      }
      const shaft = loft(sec, { seg });
      shaft.translate(x, 0, z);
      B.add('wall', shaft);
      if (lod < 2)
        for (const sx of [-1, 1])
          B.add('wallLight', loft([
            { y: -4, rx: 2.2, rz: w * 0.42, n: 4, ox: sx * (w * 1.05) },
            { y: H * 0.14, rx: 0.9, rz: w * 0.3, n: 4, ox: sx * (w * 0.93) },
            { y: H * 0.26, rx: 0.15, rz: w * 0.2, n: 4, ox: sx * (w * 0.72) },
          ], { seg: 22 }), M(x, 0, z));
      if (lod < 3)
        for (const sz of [-1, 1]) {
          let y = H * 0.08;
          while (y < shaftH * 0.86) {
            const h2 = Math.min(H * 0.15, shaftH * 0.86 - y);
            const t0 = y / shaftH, t1 = (y + h2) / shaftH;
            const wTop = w * (1 - 0.58 * t1) * 0.46, wBot = w * (1 - 0.58 * t0) * 0.46;
            const zf = w * 0.84 * (1 - 0.58 * (t0 + t1) / 2) + 0.1;
            B.add('accent', loft([
              { y, rx: wBot, rz: 0.5, n: 4, ox: lean * y, oz: sz * zf },
              { y: y + h2 - 0.5, rx: wTop, rz: 0.5, n: 4, ox: lean * (y + h2), oz: sz * zf },
            ], { seg: lod === 0 ? 16 : 10 }), M(x, 0, z));
            y += h2 + 0.6;
          }
        }
      col(x - w, -5, z - w * 0.8, x + w, H * 0.9, z + w * 0.8);
      lumps.push([x, z, w * 3.0, w * 2.6, 1.5 + w * 0.12, rd() * 3], [x + w * 1.2, z - w * 0.8, w * 5.4, w * 3.4, 0.75, rd() * 3]);
    }
    spireSnow(B, lod, lumps, seed);
  };
}
