// Rocks, factory gate, leaning slabs, containers, pipe gantry, ruined wall.
import * as THREE from 'three';
import { M, rbox, cyl, strut, loft, extrude, slabWithHoles, sculptRock, snowPillow, snowTint, frame, roundRectPath } from './kit.js';
import { building } from './arch_building.js';
import { railing } from './arch_infra.js';
import { rng } from './noise.js';
import { ASSETS } from './assets.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** sculpted boulder / outcrop with plump snow on its top */
export function rock({ seed = 1, size = 3, red = false, flat = 0.7, planes = 6, squash = 0.75, snowCap = true }) {
  return (lod, B, col) => {
    const r = rng(seed + 1);
    const rx = size * (0.8 + r() * 0.5), rz = size * (0.8 + r() * 0.5), ry = size * squash * (0.8 + r() * 0.5);
    const lib = ASSETS.rocks;
    if (lib) {
      // Blender-sculpted rock (≈20k tris at LOD0, baked AO); unit rock spans ~[-1,1]
      const geo = lib[((seed % lib.length) + lib.length) % lib.length][Math.min(lod, 2)];
      B.add(red ? 'rockRed' : 'rockBlue', geo, M(0, ry * 0.18, 0, 0, r() * 6.28, 0, rx, ry, rz));
    } else {
      const seg = [44, 28, 18, 12][lod];
      const g = sculptRock(seed, { rx, ry, rz, planes, seg, topFlat: flat, k: 5 + r() * 2, rough: 0.1 });
      B.add(red ? 'rockRed' : 'rockBlue', g, M(0, ry * 0.18, 0, 0, r() * 6.28, 0));
    }
    if (snowCap && lod < 2 && size > 1.6)
      B.add('snow', snowPillow(rx * 1.25, rz * 1.25, ry * 0.2 + 0.25, { seed, seg: 14, bury: 0.5 }), M(0, ry * flat * 0.88 + ry * 0.16, 0), { noAO: true, tint: snowTint(seed) });
    const m = Math.max(rx, rz) * 0.55;
    if (size > 2.2) col(-m, -1, -m, m, ry * 0.7, m);
  };
}

/** big leaning concrete slab (as in the fallen-megastructure concept): tilted rbox with segmented face + snow */
export function leaningSlab({ w = 14, h = 40, t = 6, tilt = 0.5, seed = 1, red = false }) {
  return (lod, B, col) => {
    const m = M(0, 0, 0, 0, 0, tilt);
    B.add(red ? 'accent' : 'wall', rbox(w, h, t, 0.7, lod === 0 ? 4 : 2), M(0, h / 2 * Math.cos(tilt), 0, 0, 0, tilt).multiply(new THREE.Matrix4().identity()));
    const nseg = lod === 0 ? 4 : 1;
    if (lod < 2)
      for (let i = 0; i < nseg; i++) {
        const y = h * (0.15 + i * 0.2) - h / 2;
        const mm = M(0, h / 2 * Math.cos(tilt), 0, 0, 0, tilt).multiply(new THREE.Matrix4().makeTranslation(0, y + h * 0.1, t / 2 + 0.2));
        B.add(red ? 'accentDark' : 'wallLight', rbox(w - 1.6, h * 0.16, 0.5, 0.2, 2), mm);
        B.add('trim', rbox(w + 0.6, 0.5, t + 0.5, 0.15, 2), M(0, h / 2 * Math.cos(tilt), 0, 0, 0, tilt).multiply(new THREE.Matrix4().makeTranslation(0, y + h * 0.2, 0)));
      }
    // buried foot + snow drift
    if (lod < 2) B.add('snow', snowPillow(w * 1.8, t * 3.4, 2.4, { seed, seg: 18, bury: 1.8 }), M(0, -0.5, 0), { noAO: true, tint: snowTint(seed) });
    const hx = Math.sin(tilt) * h * 0.5;
    col(-w / 2 - hx * 0.2, -1, -t, w / 2, 4.2, t);
  };
}

export function container({ seed = 1, accent = false }) {
  return (lod, B, col) => {
    const L = 6.1, W = 2.5, H = 2.6;
    B.add(accent ? 'accentDark' : 'metal', rbox(L, H, W, 0.1, 2), M(0, H / 2 + 0.1, 0));
    if (lod < 2) {
      for (let i = -3; i <= 3; i++) {
        B.add(accent ? 'accent' : 'wallLight', rbox(0.14, H - 0.3, W + 0.14, 0.05, 1), M(i * 0.8, H / 2 + 0.1, 0));
      }
      B.add('trim', rbox(L + 0.1, 0.18, W + 0.1, 0.06, 1), M(0, H + 0.1, 0));
      B.add('snow', snowPillow(L - 0.2, W - 0.1, 0.35, { seed, seg: 10, bury: 0.2 }), M(0, H + 0.12, 0), { noAO: true, tint: snowTint(seed) });
    }
    col(-L / 2, 0, -W / 2, L / 2, H + 0.2, W / 2);
  };
}

/** overhead pipe gantry spanning the street (walk under it) */
export function pipeGantry({ span = 30, h = 11, depth = 7 }) {
  return (lod, B, col) => {
    const hs = span / 2;
    for (const sx of [-1, 1]) {
      // twin braced legs
      for (const sz of [-1, 1]) {
        B.add('wall', loft([
          { y: -1.5, rx: 1.35, rz: 1.35, n: 4.4 }, { y: h * 0.5, rx: 0.95, rz: 0.95, n: 4.2 }, { y: h, rx: 0.8, rz: 0.8, n: 4 },
        ].map((s) => ({ ...s, ox: sx * hs, oz: sz * depth / 2 })), { seg: lod === 0 ? 28 : 14 }));
        B.add('wallDark', rbox(3.2, 1.2, 3.2, 0.3, 3), M(sx * hs, 0.1, sz * depth / 2));
        col(sx * hs - 1.2, -1, sz * depth / 2 - 1.2, sx * hs + 1.2, h, sz * depth / 2 + 1.2);
      }
      if (lod < 2) B.add('snow', snowPillow(6, depth + 4, 0.9, { seed: sx + 4, seg: 12, bury: 0.4 }), M(sx * hs, -0.2, 0), { noAO: true, tint: snowTint(sx) });
      if (lod === 0) // X bracing between the two legs of a portal
        B.add('metal', strut(V(sx * hs, 1.0, -depth / 2), V(sx * hs, h - 1.4, depth / 2), 0.14, 8)),
        B.add('metal', strut(V(sx * hs, 1.0, depth / 2), V(sx * hs, h - 1.4, -depth / 2), 0.14, 8));
    }
    // deck beams + walkway
    for (const sz of [-1, 1]) B.add('wall', rbox(span + 3, 1.3, 1.1, 0.2, 3), M(0, h + 0.65, sz * depth / 2));
    B.add('deck', rbox(span + 2.2, 0.3, depth - 0.4, 0.08, 2), M(0, h + 1.35, 0));
    if (lod < 2) {
      for (let x = -hs; x <= hs; x += 4.4) B.add('metal', rbox(0.3, 0.6, depth, 0.08, 1), M(x, h - 0.1, 0));
      // pipes: big trunk + small runs, with flange rings and orange valve wheels
      const radii = [0.62, 0.45, 0.32];
      radii.forEach((rr, i) => {
        const z = (i - 1) * 1.7;
        B.add(i === 0 ? 'trim' : 'wallLight', new THREE.CylinderGeometry(rr, rr, span + 3, lod === 0 ? 32 : 14).rotateZ(Math.PI / 2), M(0, h + 2.4 + (i === 0 ? 0.2 : 0), z));
        if (lod === 0)
          for (let x = -hs + 2; x < hs; x += 5.5)
            B.add('metal', new THREE.CylinderGeometry(rr + 0.12, rr + 0.12, 0.28, 24).rotateZ(Math.PI / 2), M(x, h + 2.4 + (i === 0 ? 0.2 : 0), z));
      });
      if (lod === 0) {
        B.add('accent', new THREE.TorusGeometry(0.7, 0.09, 8, 28), M(-6, h + 3.55, 0, Math.PI / 2, 0, 0));
        B.add('accent', new THREE.TorusGeometry(0.55, 0.08, 8, 28), M(8, h + 3.3, -1.7, Math.PI / 2, 0, 0));
        railing(B, 0, () => {}, V(-hs, h + 1.5, -depth / 2 + 0.2), V(hs, h + 1.5, -depth / 2 + 0.2), 1.1, false);
        railing(B, 0, () => {}, V(-hs, h + 1.5, depth / 2 - 0.2), V(hs, h + 1.5, depth / 2 - 0.2), 1.1, false);
      }
      B.add('snow', snowPillow(span * 0.9, depth * 0.55, 0.45, { seed: 3, seg: 22, bury: 0.2 }), M(0, h + 1.5, 0), { noAO: true, tint: snowTint(2) });
    }
  };
}

/** collapsed arcade wall: pilasters, arch with voussoir ring, banded courses, broken crown and rubble */
export function ruinWall({ w = 16, h = 9, t = 2.4, seed = 1 }) {
  return (lod, B, col) => {
    const r = rng(seed * 13 + 1);
    const s = new THREE.Shape();
    s.moveTo(-w / 2, -1.2); s.lineTo(w / 2, -1.2);
    s.lineTo(w / 2, h * 0.84);
    s.quadraticCurveTo(w * 0.42, h * (0.98 + r() * 0.06), w * 0.28, h * 0.86);
    s.quadraticCurveTo(w * 0.17, h * 0.68, w * 0.05, h * 0.8);
    s.quadraticCurveTo(-w * 0.08, h * 0.95, -w * 0.22, h * 0.74);
    s.quadraticCurveTo(-w * 0.34, h * 0.6, -w * 0.44, h * 0.72);
    s.lineTo(-w / 2, h * 0.7); s.closePath();
    const hole = new THREE.Path();
    const ax = w * 0.19, ay1 = h * 0.52;
    hole.moveTo(-ax, 0); hole.lineTo(-ax, ay1 - ax); hole.absarc(0, ay1 - ax, ax, Math.PI, 0, true); hole.lineTo(ax, 0); hole.closePath();
    s.holes.push(hole);
    B.add('wall', extrude(s, t, 0.2, lod === 0 ? 20 : 8, 2, true), M(0, 0, -t / 2));
    if (lod < 2) {
      // arch ring (extruded half annulus) standing proud of both faces
      const ring = new THREE.Shape();
      const ro = ax + 0.9, ri = ax;
      ring.absarc(0, 0, ro, 0, Math.PI, false); ring.absarc(0, 0, ri, Math.PI, 0, true); ring.closePath();
      B.add('wallLight', extrude(ring, t + 0.7, 0.14, lod === 0 ? 24 : 10, 2), M(0, ay1 - ax, -(t + 0.7) / 2));
      for (const sx of [-1, 1]) {
        B.add('wallLight', rbox(1.5, ay1 - ax + 0.4, t + 0.7, 0.2, 2), M(sx * (ax + 0.75), (ay1 - ax) / 2 - 0.1, 0));
        B.add('wallLight', rbox(1.7, h * 0.7, t + 0.7, 0.22, 2), M(sx * (w / 2 - 0.85), h * 0.35, 0));
      }
      B.add('wallDark', rbox(w + 0.6, 1.1, t + 0.8, 0.22, 3), M(0, 0.35, 0));
      B.add('trim', rbox(w - 3.4, 0.4, t + 0.5, 0.12, 2), M(0, h * 0.5, 0));
      // rubble beside it
      const rr = rng(seed + 9);
      for (let i = 0; i < 5; i++) {
        const sz = 0.5 + rr() * 1.1;
        B.add('wall', rbox(sz * 1.6, sz, sz * 1.2, 0.15, 2), M((rr() - 0.5) * w * 1.4, sz * 0.3, (rr() > 0.5 ? 1 : -1) * (t / 2 + 0.6 + rr() * 2), 0, rr() * 3, rr() * 0.4));
      }
      B.add('snow', snowPillow(w * 0.55, t * 1.7, 0.8, { seed, seg: 12, bury: 0.5 }), M(w * 0.2 - 0.0, h * 0.78, 0), { noAO: true, tint: snowTint(seed) });
      B.add('snow', snowPillow(w * 1.7, t * 5.4, 1.5, { seed: seed + 1, seg: 16, bury: 1.0 }), M(0, -0.3, 0), { noAO: true, tint: snowTint(seed + 1) });
    }
    col(-w / 2, -1, -t / 2, -ax - 1.4, h * 0.7, t / 2);
    col(ax + 1.4, -1, -t / 2, w / 2, h * 0.7, t / 2);
  };
}

/** Factory gate: sealed hangar door framed by pilasters, slit windows and heavy wings. End of the built section. */
export function factoryGate({ span = 112 }) {
  return (lod, B, col) => {
    const W = 46, Hh = 34, D = 9, dw = 11.5, dh = 17.5;
    const door = new THREE.Path();
    door.moveTo(-dw, 0); door.lineTo(-dw, dh - dw * 0.5); door.quadraticCurveTo(-dw, dh, -dw * 0.5, dh); door.lineTo(dw * 0.5, dh);
    door.quadraticCurveTo(dw, dh, dw, dh - dw * 0.5); door.lineTo(dw, 0); door.closePath();
    const s = new THREE.Shape();
    roundRectPath(s, -W / 2, -1, W / 2, Hh, 1.2);
    s.holes.push(door);
    // slit windows flanking the upper wall
    const slits = [];
    if (lod < 2)
      for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) {
        const cx = sx * (dw + 4.5 + i * 3.4);
        slits.push([cx - 0.7, 21.5, cx + 0.7, 29, 0.5]);
      }
    for (const h of slits) s.holes.push(roundRectPath(new THREE.Path(), h[0], h[1], h[2], h[3], h[4]));
    B.add('wall', extrude(s, D, 0.25, lod === 0 ? 12 : 5, 1, false), M(0, 0, -D / 2));
    B.add('glass', rbox(W - 1, Hh - 1, 0.4, 0.1, 1), M(0, Hh / 2, -D / 2 + 0.55));
    // door frame trim
    const frameShape = (() => {
      const o = new THREE.Shape(); roundRectPath(o, -dw - 1.8, -0.5, dw + 1.8, dh + 1.8, 1.8);
      const h2 = new THREE.Path();
      h2.moveTo(-dw, -0.6); h2.lineTo(-dw, dh - dw * 0.5); h2.quadraticCurveTo(-dw, dh, -dw * 0.5, dh); h2.lineTo(dw * 0.5, dh);
      h2.quadraticCurveTo(dw, dh, dw, dh - dw * 0.5); h2.lineTo(dw, -0.6); h2.closePath(); o.holes.push(h2); return o;
    })();
    B.add('wallLight', extrude(frameShape, 1.3, 0.2, lod === 0 ? 10 : 4, 2), M(0, 0, D / 2 - 0.1));
    // two heavy door leaves with inset panels, orange hazard bands, and a thin glowing seam
    for (const sx of [-1, 1]) {
      const cx = sx * (dw / 2 + 0.05);
      B.add('metal', rbox(dw - 0.2, dh - 0.4, 1.6, 0.2, 2), M(cx, dh / 2, -1.6));
      B.add('metal', rbox(dw - 1.4, 2.6, 1.6, 0.6, 3), M(cx, dh - 0.9 + 0.4 - 0.4, -1.6));
      if (lod < 2) {
        for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++)
          B.add('wallDark', rbox((dw - 1.6) / 2 - 0.3, 3.2, 0.3, 0.1, 2), M(cx + (c - 0.5) * ((dw - 1.6) / 2), 2.4 + r * 3.7, -0.7));
        B.add('accent', rbox(dw - 0.9, 0.9, 0.34, 0.1, 2), M(cx, 0.9, -0.66));
        B.add('accent', rbox(dw - 0.9, 0.9, 0.34, 0.1, 2), M(cx, dh * 0.5, -0.66));
      }
    }
    B.add('glow', rbox(0.34, dh - 3.2, 0.3, 0.1, 1), M(0, dh / 2 - 0.4, -0.7));
    // pilasters, horizontal bands, cornice
    if (lod < 3) {
      for (const sx of [-1, 1]) for (const px of [dw + 2.4, W / 2 - 2.2]) {
        B.add('trim', rbox(2.2, Hh - 3, 0.9, 0.25, 3), M(sx * px, (Hh - 3) / 2 + 0.2, D / 2 + 0.3));
        B.add('wallLight', rbox(2.9, 1.0, 1.2, 0.25, 2), M(sx * px, Hh - 2.4, D / 2 + 0.35));
      }
      B.add('trim', rbox(W + 0.8, 0.9, D + 0.8, 0.25, 2), M(0, 9.5, 0));
      B.add('trim', rbox(W + 1.2, 1.4, D + 1.2, 0.3, 3), M(0, Hh - 0.4, 0));
      B.add('wallLight', rbox(W - 0.4, 1.4, 1.0, 0.3, 2), M(0, Hh + 0.7, D / 2 - 0.9));
      B.add('wallLight', rbox(W - 0.4, 1.4, 1.0, 0.3, 2), M(0, Hh + 0.7, -D / 2 + 0.9));
      for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) B.add('accent', rbox(2.6, 4.4, 0.7, 0.2, 3), M(sx * (dw + 8.6 + k * 0), 3.4 + k * 5.4, D / 2 + 0.85));
    }
    if (lod < 2) B.add('snow', snowPillow(W - 2.5, D - 2.4, 1.1, { seed: 8, seg: 20, bury: 0.6 }), M(0, Hh + 0.0, 0), { noAO: true, tint: snowTint(1) });
    col(-W / 2, -1, -D / 2, -dw, Hh, D / 2);
    col(dw, -1, -D / 2, W / 2, Hh, D / 2);
    col(-dw, -1, -D / 2, dw, Hh, -D / 2 + 3);
    for (const sx of [-1, 1]) {
      const F = frame(B, col, sx * (W / 2 + (span - W) / 4), 0, 0, 0);
      building({ seed: 11 + sx, roof: 'vents', tiers: [
        { w: (span - W) / 2, d: 26, h: 24, blank: 0.4, bay: 5.2, accent: [{ face: 'z+', x: -(span - W) / 8, w: 5 }, { face: 'z+', x: (span - W) / 8, w: 5 }] },
      ] })(lod, F.B, F.col);
    }
  };
}

/** Walk-through transit hall: openings at both ends (±x), interior pillars, roof ribs, glowing ceiling strips. */
export function transitHall({ L = 34, Wd = 20, H = 9.5, seed = 1 }) {
  return (lod, B, col) => {
    const hw = Wd / 2, T = 1.5;
    // floor
    B.add('deck', rbox(L + 2, 1.9, Wd + 2, 0.15, 2), M(0, -0.45, 0));
    col(-L / 2 - 1, -1.5, -hw - 1, L / 2 + 1, 0.5, hw + 1);
    if (lod < 2) {
      for (let x = -L / 2 + 2; x < L / 2; x += 4) B.add('wallDark', rbox(0.16, 0.05, Wd - 1, 0.02, 1), M(x, 0.5, 0));
      for (const sx of [-1, 1]) {
        B.add('trim', rbox(1.4, 0.26, 12.4, 0.08, 1), M(sx * (L / 2 + 1.7), 0.14, 0));
        col(sx * (L / 2 + 1.0), -1, -6.2, sx * (L / 2 + 2.4), 0.26, 6.2);
      }
    }
    // long walls: through-slits closed by a glass sheet, framed
    const slits = [];
    for (let x = -L / 2 + 3.2; x < L / 2 - 2; x += 4.4) slits.push([x - 0.9, 3.2, x + 0.9, 7.2, 0.5]);
    for (const sz of [-1, 1]) {
      const wallGeo = slabWithHoles(L, H, T, lod < 2 ? slits.map((h) => h.slice()) : [], { bevel: 0.1, curveSegments: lod === 0 ? 4 : 2 });
      // slab spans x∈[-L/2, L/2] about 0; thickness along +z → place with outward z
      B.add('wall', wallGeo, M(0, 0, sz > 0 ? hw - T : -hw, 0, 0, 0));
      B.add('glass', rbox(L - 1, H - 2, 0.2, 0.05, 1), M(0, H / 2, sz * (hw - T + 0.35)));
      if (lod < 2) {
        B.add('trim', rbox(L + 0.8, 0.6, T + 0.8, 0.15, 2), M(0, 2.2, sz * (hw - T / 2)));
        B.add('trim', rbox(L + 1.0, 0.9, T + 1.0, 0.2, 2), M(0, H + 0.1, sz * (hw - T / 2)));
        for (let x = -L / 2 + 1.0; x <= L / 2 - 0.9; x += 4.4) B.add('wallLight', rbox(0.9, H - 0.4, T + 0.5, 0.2, 2), M(x, H / 2, sz * (hw - T / 2)));
      }
      col(-L / 2, -1, sz > 0 ? hw - T : -hw, L / 2, H, sz > 0 ? hw : -hw + T);
    }
    // end walls with a big arched opening
    const dw = 5.2, dh = 6.6;
    for (const sx of [-1, 1]) {
      const s = new THREE.Shape();
      roundRectPath(s, -hw, -1, hw, H + 0.6, 0.6);
      const door = new THREE.Path();
      door.moveTo(-dw, 0); door.lineTo(-dw, dh - dw * 0.7); door.quadraticCurveTo(-dw, dh, -dw * 0.4, dh); door.lineTo(dw * 0.4, dh);
      door.quadraticCurveTo(dw, dh, dw, dh - dw * 0.7); door.lineTo(dw, 0); door.closePath();
      s.holes.push(door);
      B.add('wall', extrude(s, T, 0.12, lod === 0 ? 10 : 4, 1, false), M(sx * L / 2, 0, 0, 0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, 0).multiply(new THREE.Matrix4().makeTranslation(0, 0, -T)));
      if (lod < 2) {
        // door surround + orange lintel slabs
        const o = new THREE.Shape(); roundRectPath(o, -dw - 1.1, -0.5, dw + 1.1, dh + 1.1, 1.0);
        const h2 = new THREE.Path();
        h2.moveTo(-dw, -0.6); h2.lineTo(-dw, dh - dw * 0.7); h2.quadraticCurveTo(-dw, dh, -dw * 0.4, dh); h2.lineTo(dw * 0.4, dh);
        h2.quadraticCurveTo(dw, dh, dw, dh - dw * 0.7); h2.lineTo(dw, -0.6); h2.closePath(); o.holes.push(h2);
        B.add('wallLight', extrude(o, 0.8, 0.14, lod === 0 ? 8 : 3, 2), M(sx * (L / 2 + 0.0), 0, 0, 0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, 0));
        const ry = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
        B.add('accent', rbox(2.4, 1.4, 0.7, 0.2, 2), M(sx * (L / 2 + 0.55), dh + 1.5, 0, 0, ry, 0));
        for (const sz of [-1, 1]) {
          B.add('trim', rbox(1.4, H - 0.6, 0.9, 0.25, 3), M(sx * (L / 2 + 0.3), (H - 0.6) / 2, sz * (dw + 2.6), 0, ry, 0));
          B.add('trim', rbox(1.4, H - 0.6, 0.9, 0.25, 3), M(sx * (L / 2 + 0.3), (H - 0.6) / 2, sz * (hw - 0.8), 0, ry, 0));
          for (let k = 0; k < 2; k++) B.add('accent', rbox(2.6, 2.6, 0.5, 0.18, 3), M(sx * (L / 2 + 0.25), 1.8 + k * 3.1, sz * ((dw + hw - 0.8) / 2 + 0.1), 0, ry, 0));
        }
        B.add('trim', rbox(Wd + 0.8, 0.5, 0.9, 0.15, 2), M(sx * (L / 2 + 0.3), 3.0, 0, 0, ry, 0));
      }
      col(sx * L / 2 - (sx > 0 ? T : 0), -1, -hw, sx * L / 2 + (sx > 0 ? 0 : T), H, -dw - 0.8);
      col(sx * L / 2 - (sx > 0 ? T : 0), -1, dw + 0.8, sx * L / 2 + (sx > 0 ? 0 : T), H, hw);
    }
    // roof slab + arched ribs
    B.add('wallLight', rbox(L + 1.4, 1.1, Wd + 1.4, 0.3, 3), M(0, H + 0.55, 0));
    if (lod < 2) {
      for (let x = -L / 2 + 3; x < L / 2; x += 6) {
        const rib = new THREE.Shape();
        rib.moveTo(-hw + T, 0); rib.lineTo(hw - T, 0); rib.lineTo(hw - T, 1.1); rib.absarc(0, 1.1 - 4.2, hw - T, 0.0, Math.PI, false);
        rib.lineTo(-hw + T, 0);
        // ceiling rib as a shallow arch band under the roof
        const band = new THREE.Shape();
        band.moveTo(-hw + T, 0); band.lineTo(-hw + T, 1.0); band.quadraticCurveTo(0, 3.4, hw - T, 1.0); band.lineTo(hw - T, 0); band.quadraticCurveTo(0, 2.1, -hw + T, 0);
        B.add('wall', extrude(band, 0.8, 0.1, lod === 0 ? 10 : 4, 1, false), M(x, H - 1.2, 0, 0, Math.PI / 2, 0).multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.4)));
      }
      B.add('snow', snowPillow(L - 1.5, Wd - 1.5, 1.0, { seed, seg: 24, bury: 0.8 }), M(0, H + 1.0, 0), { noAO: true, tint: snowTint(seed) });
      // ceiling light strips + interior pillars
      for (const sz of [-1, 1]) B.add('glow', rbox(L - 4, 0.22, 0.5, 0.08, 1), M(0, H - 0.5, sz * 3.2));
      for (let x = -L / 2 + 6; x < L / 2 - 3; x += 6)
        for (const sz of [-1, 1]) {
          B.add('trim', loft([
            { y: 0, rx: 0.9, rz: 0.9, n: 4.4, ox: x, oz: sz * 4.6 }, { y: H * 0.5, rx: 0.62, rz: 0.62, n: 4.2, ox: x, oz: sz * 4.6 },
            { y: H - 0.3, rx: 0.9, rz: 0.9, n: 4.4, ox: x, oz: sz * 4.6 },
          ], { seg: lod === 0 ? 24 : 12 }));
          B.add('accent', rbox(1.25, 0.5, 1.25, 0.12, 2), M(x, 1.4, sz * 4.6));
          col(x - 0.9, 0, sz * 4.6 - 0.9, x + 0.9, H, sz * 4.6 + 0.9);
        }
    }
  };
}
