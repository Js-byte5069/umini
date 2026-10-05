// Buildings: stacked tiers with real recessed windows (2-layer facade shells), pilasters, trims, cornices,
// segmented orange slabs, parapets, roof equipment and plump snow on every ledge.
import * as THREE from 'three';
import { M, rbox, cyl, strut, slabWithHoles, snowPillow, snowTint } from './kit.js';
import { rng } from './noise.js';
import { ASSETS } from './assets.js';

const FACE = 1.1;                 // total facade shell thickness (backing 0.5 + skin 0.5 + glass gap 0.1)
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** face frame: returns matrix placing local (x along face, y up, z outward) on the core surface */
function faceMatrix(face, cw, cd, y0, extraZ = 0) {
  switch (face) {
    case 'z+': return M(0, y0, cd / 2 + extraZ, 0, 0, 0);
    case 'z-': return M(0, y0, -cd / 2 - extraZ, 0, Math.PI, 0);
    case 'x+': return M(cw / 2 + extraZ, y0, 0, 0, Math.PI / 2, 0);
    default: return M(-cw / 2 - extraZ, y0, 0, 0, -Math.PI / 2, 0);
  }
}
const mulOff = (face, cw, cd, y0, dz, ox = 0, oy = 0) => {
  // matrix placing a local (ox, oy, dz) offset on a face
  const m = faceMatrix(face, cw, cd, y0, 0);
  return m.multiply(new THREE.Matrix4().makeTranslation(ox, oy, dz));
};

function layoutFace(W, H, o, r, withDoor) {
  const gf = o.gf ?? 6.0, fh = o.fh ?? 5.2;
  const nf = Math.max(0, Math.floor((H - gf - 1.6) / fh));
  const margin = 2.2;
  const usable = W - margin * 2;
  const nc = Math.max(1, Math.round(usable / (o.bay ?? 5.6)));
  const bw = usable / nc;
  const winP = o.windows ?? 0.1;
  const back = [], skin = [], pil = [];
  const rows = nf + 1;
  for (let f = 0; f < rows; f++) {
    const base = f === 0 ? 0 : gf + (f - 1) * fh;
    const rh = f === 0 ? gf : fh;
    for (let c = 0; c < nc; c++) {
      const cx = -W / 2 + margin + (c + 0.5) * bw;
      if (withDoor && f === 0 && Math.abs(cx) < 3.2) continue;
      if (r() < winP) {
        // tall slit window (through both layers) inside a stepped frame
        const ww = bw * 0.26, y0 = base + rh * 0.2, y1 = base + rh * 0.8;
        back.push([cx - ww / 2, y0, cx + ww / 2, y1, 0.2]);
        skin.push([cx - ww / 2 - 0.35, y0 - 0.35, cx + ww / 2 + 0.35, y1 + 0.35, 0.3]);
      } else {
        // large recessed panel: reads as segmented slate wall
        skin.push([cx - bw * 0.44, base + 0.55, cx + bw * 0.44, base + rh - 0.55, 0.35]);
      }
    }
  }
  if (withDoor) {
    back.push([-2.0, 0, 2.0, 5.2, 0.3]);
    skin.push([-2.3, 0, 2.3, 5.6, 0.4]);
  }
  for (let c = 1; c < nc; c++) pil.push(-W / 2 + margin + c * bw);
  return { back, skin, pil, nf, gf, fh };
}

/** two door leaves set into the entrance recess: slab, raised panels, vision slit, push bars, kick plates (the recess is no longer a blind dark rectangle) */
function doorLeaves(B, lod, face, cw, cd, y0) {
  for (const sx of [-1, 1]) {
    B.add('metal', rbox(1.9, 5.0, 0.36, 0.06, 2), mulOff(face, cw, cd, y0, 0.3, sx * 0.98, 2.6));
    if (lod > 0) continue;
    B.add('wall', rbox(1.45, 1.75, 0.1, 0.04, 1), mulOff(face, cw, cd, y0, 0.5, sx * 0.98, 1.75));
    B.add('wall', rbox(1.45, 1.55, 0.1, 0.04, 1), mulOff(face, cw, cd, y0, 0.5, sx * 0.98, 3.75));
    B.add('glass', rbox(0.32, 0.9, 0.06, 0.02, 1), mulOff(face, cw, cd, y0, 0.55, sx * 0.98, 4.5));
    B.add('accentDark', rbox(1.7, 0.5, 0.06, 0.02, 1), mulOff(face, cw, cd, y0, 0.5, sx * 0.98, 0.45));
    B.add('trim', cyl(0.045, 0.045, 0.9, 8).rotateZ(Math.PI / 2), mulOff(face, cw, cd, y0, 0.62, sx * 0.55, 2.4));
  }
  B.add('trim', rbox(0.12, 5.0, 0.08, 0.02, 1), mulOff(face, cw, cd, y0, 0.5, 0, 2.6));
}

function buildFace(B, lod, face, cw, cd, y0, H, o, r, withDoor) {
  const W = face[0] === 'z' ? cw + 2 * FACE : cd;
  if (lod >= 2) return;
  const L = layoutFace(W, H, o, r, withDoor);
  const detail = lod === 0;
  // glass sheet lies on the core surface, visible through the window holes
  B.add('glass', rbox(W - 0.6, H - 0.6, 0.1, 0.03, 1), mulOff(face, cw, cd, y0, 0.05, 0, H / 2));
  const backHoles = L.back;
  const skinHoles = detail ? L.skin : L.skin.filter((h) => (h[3] - h[1]) > 1.5 && h[2] - h[0] > 2.4);
  B.add('wallDark', slabWithHoles(W, H, 0.5, backHoles, { bevel: 0.04, curveSegments: detail ? 3 : 1 }),
    mulOff(face, cw, cd, y0, 0.1));
  B.add('wall', slabWithHoles(W, H, 0.5, skinHoles, { bevel: 0.06, curveSegments: detail ? 3 : 1 }),
    mulOff(face, cw, cd, y0, 0.6));
  if (withDoor) doorLeaves(B, lod, face, cw, cd, y0);
  if (!detail) return;
  // pilasters between bay groups
  for (const px of L.pil) {
    B.add('trim', rbox(1.1, H - 0.8, 0.7, 0.2, 3), mulOff(face, cw, cd, y0, FACE + 0.28, px, H / 2));
    B.add('wallLight', rbox(1.5, 0.7, 1.0, 0.2, 2), mulOff(face, cw, cd, y0, FACE + 0.38, px, H - 0.5));
  }
  // exposed vertical pipe run with clamps
  if (H > 14) {
    const px = L.pil[0] !== undefined ? L.pil[0] + 1.1 : 0;
    B.add('metal', cyl(0.3, 0.3, H - 3, 14), mulOff(face, cw, cd, y0, FACE + 0.8, px, H / 2));
    for (let y = 3; y < H - 2; y += 4.5) B.add('trim', cyl(0.45, 0.45, 0.35, 14), mulOff(face, cw, cd, y0, FACE + 0.8, px, y));
  }
  // side gallery: deck, rails and wall brackets
  if (H > 18 && W > 12 && lod === 0 && face !== 'z-') {
    const gy = Math.min(H * 0.42, 16), gl = Math.min(W * 0.55, 16);
    B.add('deck', rbox(gl, 0.34, 2.6, 0.08, 2), mulOff(face, cw, cd, y0, FACE + 1.3, W * 0.12, gy));
    for (let k = 0; k <= 4; k++) {
      const x = W * 0.12 - gl / 2 + 0.4 + (gl - 0.8) * k / 4;
      B.add('metal', strut(V(x, gy - 0.2, FACE + 2.4), V(x, gy - 1.9, FACE + 0.1), 0.09, 6), faceMatrix(face, cw, cd, y0));
      B.add('metal', cyl(0.05, 0.05, 1.05, 6), mulOff(face, cw, cd, y0, FACE + 2.5, x, gy + 0.55));
    }
    B.add('trim', rbox(gl, 0.09, 0.09, 0.03, 1), mulOff(face, cw, cd, y0, FACE + 2.5, W * 0.12, gy + 1.1));
  }
}

function accentSlabs(B, lod, o, cw, cd, y0, H) {
  for (const a of o.accent ?? []) {
    // tall fin built from stacked modules (4-5 m, seam every module), two columns when wide; each module has a chamfered frame and a raised inner plate
    const segH = lod === 0 ? 4.4 : 7.0, gap = 0.26;
    const fw = a.w * 1.25, ncol = lod === 0 && fw >= 5 ? 2 : 1, cwid = (fw - 0.28 * (ncol - 1)) / ncol;
    for (let c = 0; c < ncol; c++) {
      let y = (a.from ?? 1.2) + (c ? segH * 0.5 : 0);
      const to = Math.min(a.to ?? H - 1.6, H - 0.8);
      const ux = (a.x ?? 0) - fw / 2 + cwid / 2 + c * (cwid + 0.28);
      while (y < to - 1) {
        const sh = Math.min(segH, to - y);
        B.add('accent', rbox(cwid, sh - gap, 0.7, 0.18, lod === 0 ? 3 : 1), mulOff(a.face, cw, cd, y0, FACE + 0.22, ux, y + sh / 2));
        if (lod === 0 && sh > 2.4)
          B.add(c ? 'accent' : 'accentDark', rbox(cwid - 1.1, sh - gap - 1.1, 0.16, 0.06, 2), mulOff(a.face, cw, cd, y0, FACE + 0.62, ux, y + sh / 2));
        y += sh;
      }
    }
  }
}

function roofGear(B, lod, kind, w, d, y, seed) {
  if (lod > 1) return;
  const r = rng(seed);
  if (kind === 'tank') {
    const x = (r() - 0.5) * w * 0.3, z = (r() - 0.5) * d * 0.3;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('metal', cyl(0.14, 0.14, 2.2, 10), M(x + sx * 1.5, y + 1.1, z + sz * 1.5));
    B.add('trim', cyl(2.5, 2.5, 3.2, 40), M(x, y + 3.8, z));
    const dome = new THREE.SphereGeometry(2.5, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    B.add('trim', dome, M(x, y + 5.4, z, 0, 0, 0, 1, 0.5, 1));
    B.add('metal', cyl(2.62, 2.62, 0.28, 40), M(x, y + 3.0, z));
    B.add('metal', cyl(2.62, 2.62, 0.28, 40), M(x, y + 4.7, z));
  } else if (kind === 'antenna') {
    const x = (r() - 0.5) * w * 0.4, z = (r() - 0.5) * d * 0.4;
    B.add('metal', cyl(0.18, 0.32, 9, 12), M(x, y + 4.5, z));
    B.add('trim', rbox(2.4, 0.18, 0.18, 0.05, 1), M(x, y + 7.2, z));
    B.add('trim', rbox(1.6, 0.16, 0.16, 0.05, 1), M(x, y + 8.2, z));
    B.add('accent', new THREE.SphereGeometry(0.3, 16, 12), M(x, y + 9.2, z));
    B.add('wall', rbox(3.4, 2.2, 3.0, 0.3, 3), M(x + 3.5, y + 1.1, z + 1));
  } else {
    for (let i = 0; i < 3; i++) {
      const x = (r() - 0.5) * w * 0.55, z = (r() - 0.5) * d * 0.55;
      B.add('metal', cyl(0.7, 0.8, 2.2 + r() * 1.2, 20), M(x, y + 1.3, z));
      B.add('wallLight', cyl(1.0, 1.0, 0.25, 20), M(x, y + 2.5 + r() * 0.5, z));
    }
    B.add('wall', rbox(4.2, 2.8, 3.4, 0.35, 3), M(w * 0.18, y + 1.4, -d * 0.2));
  }
}

/**
 * Multi-tier building. o = { tiers:[{w,d,h,ox?,oz?,accent?,gf?,fh?,bay?}], door:'z+', roof:'tank'|'antenna'|'vents', seed }
 * Local origin = ground at footprint centre. Returns nothing; fills batch + local colliders.
 */
export function building(o) {
  return (lod, B, col) => {
    const r = rng(o.seed ?? 3);
    let y0 = -0.0;
    const tiers = o.tiers;
    tiers.forEach((t, ti) => {
      const w = t.w, d = t.d, H = t.h, ox = t.ox ?? 0, oz = t.oz ?? 0;
      const cw = w - 2 * FACE, cd = d - 2 * FACE;
      const sub = new THREE.Matrix4().makeTranslation(ox, 0, oz);
      // everything for a tier is built around its own centre then offset: use a tiny child batch trick
      const T = new TierBatch(B, sub);
      T.add('wallDark', rbox(cw, H, cd, 0.3, 3), M(0, y0 + H / 2, 0));
      for (const face of ['z+', 'z-', 'x+', 'x-']) {
        const door = ti === 0 && o.door === face;
        buildFace(T, lod, face, cw, cd, y0, H, t, r, door);
      }
      accentSlabs(T, lod, t, cw, cd, y0, H);
      if (lod < 2) {
        // cornice + parapet
        T.add('trim', rbox(w + 0.9, 0.85, d + 0.9, 0.2, 3), M(0, y0 + H - 0.2, 0));
        const pt = 0.7, ph = 1.0, px = w / 2 - 0.15, pz = d / 2 - 0.15;
        T.add('wallLight', rbox(w - 0.1, ph, pt, 0.2, 2), M(0, y0 + H + 0.65, pz - pt / 2));
        T.add('wallLight', rbox(w - 0.1, ph, pt, 0.2, 2), M(0, y0 + H + 0.65, -pz + pt / 2));
        T.add('wallLight', rbox(pt, ph, d - 2 * pt - 0.1, 0.2, 2), M(px - pt / 2, y0 + H + 0.65, 0));
        T.add('wallLight', rbox(pt, ph, d - 2 * pt - 0.1, 0.2, 2), M(-px + pt / 2, y0 + H + 0.65, 0));
        // horizontal trim bands every third floor
        if (lod === 0) {
          const gf = t.gf ?? 6.0, fh = t.fh ?? 5.2;
          for (let y = gf + fh * 2 - 0.1; y < H - 3; y += fh * 3)
            T.add('trim', rbox(w + 0.45, 0.42, d + 0.45, 0.12, 2), M(0, y0 + y, 0));
        }
        // snow
        const up = tiers[ti + 1];
        if (!up) {
          T.add('snow', snowPillow(w - 2.2, d - 2.2, 0.9, { seed: ti + 3, seg: lod === 0 ? 22 : 12, bury: 0.9 }), M(0, y0 + H + 0.1, 0), { noAO: true, tint: snowTint(ti) });
        } else {
          const gx = (w - up.w) / 2 - Math.abs((up.ox ?? 0) - ox) * 0.0, gz = (d - up.d) / 2;
          if (gz > 2.2) {
            T.add('snow', snowPillow(w - 2.2, gz - 0.9, 0.95, { seed: ti * 5 + 1, seg: 16, bury: 0.8 }), M(0, y0 + H + 0.05, d / 2 - gz / 2 - 0.1), { noAO: true, tint: snowTint(ti + 1) });
            T.add('snow', snowPillow(w - 2.2, gz - 0.9, 0.95, { seed: ti * 5 + 2, seg: 16, bury: 0.8 }), M(0, y0 + H + 0.05, -d / 2 + gz / 2 + 0.1), { noAO: true, tint: snowTint(ti + 2) });
          }
        }
      }
      // plinth & entrance
      if (ti === 0 && lod < 2) {
        const pw = w + 0.9, pd = d + 0.9;
        T.add('wallDark', rbox(pw, 1.5, pd, 0.25, 3), M(0, -0.1, 0));
        if (o.door) {
          const side = o.door;
          // steps in front of the door
          const horiz = side[0] === 'z';
          const sgn = side[1] === '+' ? 1 : -1;
          for (let s = 0; s < 3; s++) {
            const off = (horiz ? d : w) / 2 + 0.2 + (2 - s) * 0.8 + 0.6;
            const m = horiz ? M(0, 0.2 * s + 0.1, sgn * off) : M(sgn * off, 0.2 * s + 0.1, 0);
            T.add('trim', rbox(horiz ? 5.4 : 1.6, 0.2 * (s + 1) + 0.4, horiz ? 1.6 : 5.4, 0.08, 2), m);
          }
        }
      }
      if (ti === tiers.length - 1) roofGear(T, lod, o.roof ?? 'vents', w, d, y0 + H + 0.3, (o.seed ?? 3) + ti);
      col(ox - w / 2, y0, oz - d / 2, ox + w / 2, y0 + H + 1.2, oz + d / 2);
      y0 += H;
    });
  };
}

/** adds to a parent batch through an extra translation */
class TierBatch {
  constructor(B, m) { this.B = B; this.m = m; }
  add(key, geo, matrix, o) {
    const mm = matrix ? this.m.clone().multiply(matrix) : this.m;
    this.B.add(key, geo, mm, o);
    return this;
  }
}


/** Blender-authored buildings (tools/gen_buildings.py): facade recesses, fins, galleries, wings, roof gear and modelled snow all come
 *  from the GLB; collision comes from spec.cols (building-local AABBs computed by the generator) or, failing that, from the tier boxes.
 *  The GLB stores NORMAL as int8 / COLOR_0 as ubyte (KHR_mesh_quantization): normals are expanded to float32 once per geometry. */
const _plain = new WeakMap();
const WEAR_FLAT = 0.78, WEAR_TINT = 1 / (0.58 + 0.42 * WEAR_FLAT);   // flat surfaces keep their brightness, convex edges end up ~10% lighter
const WEAR_COL = new THREE.Color(WEAR_TINT, WEAR_TINT, WEAR_TINT);
function plainGeo(geo, wear) {
  const key = wear ? 1 : 0;
  let m = _plain.get(geo);
  if (m && m[key]) return m[key];
  let g = geo;
  const n = geo.getAttribute('normal'), p = geo.getAttribute('position');
  const qpos = p && p.array.constructor !== Float32Array;            // int16 in 1/128 m
  if ((n && n.array.constructor !== Float32Array) || qpos) {
    g = new THREE.BufferGeometry();
    if (geo.index) g.setIndex(geo.index);
    for (const k of Object.keys(geo.attributes)) if (k !== 'normal' && k !== 'position') g.setAttribute(k, geo.attributes[k]);
    if (qpos) {
      const f = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { f[i * 3] = p.getX(i) / 128; f[i * 3 + 1] = p.getY(i) / 128; f[i * 3 + 2] = p.getZ(i) / 128; }
      g.setAttribute('position', new THREE.BufferAttribute(f, 3));
    } else g.setAttribute('position', p);
    if (n && n.array.constructor !== Float32Array) {
      const f = new Float32Array(n.count * 3), v = new THREE.Vector3();
      for (let i = 0; i < n.count; i++) { v.set(n.getX(i), n.getY(i), n.getZ(i)).normalize(); f[i * 3] = v.x; f[i * 3 + 1] = v.y; f[i * 3 + 2] = v.z; }
      g.setAttribute('normal', new THREE.BufferAttribute(f, 3));
    } else if (n) g.setAttribute('normal', n);
  }
  const c = geo.getAttribute('color');
  if (wear && c && c.itemSize >= 2) {
    // COLOR_0 = (baked AO, edge wear 0.5 neutral .. 1 convex edge, 0, 1): fold the wear into the AO the Batch understands
    if (g === geo) g = geo.clone();
    const f = new Float32Array(c.count * 3);
    for (let i = 0; i < c.count; i++) {
      const w = Math.max(0, (c.getY(i) - 0.5) * 2);
      f[i * 3] = c.getX(i) * (WEAR_FLAT + (1 - WEAR_FLAT) * w);
    }
    g.setAttribute('color', new THREE.BufferAttribute(f, 3));
  }
  if (!m) _plain.set(geo, (m = [null, null]));
  m[key] = g;
  return g;
}

export function buildingAsset(spec) {
  const lib = ASSETS.buildings?.[spec.id];
  if (!lib) return building(spec);
  return (lod, B, col) => {
    const parts = lib[Math.min(lod, 2)];
    for (const [mat, geo] of Object.entries(parts))
      B.add(mat, plainGeo(geo, mat !== 'snow'), null, mat === 'snow' ? { noAO: true, tint: snowTint(spec.id) } : { tint: WEAR_COL });
    if (spec.cols) { for (const b of spec.cols) col(b[0], b[1], b[2], b[3], b[4], b[5]); return; }
    let y0 = 0;
    for (const t of spec.tiers) {
      const ox = t.ox ?? 0, oz = t.oz ?? 0;
      col(ox - t.w / 2, y0, oz - t.d / 2, ox + t.w / 2, y0 + t.h + 1.2, oz + t.d / 2);
      y0 += t.h;
    }
  };
}
