// First-person controller: pointer-lock look, walk/sprint/jump, height-field + AABB collision.
import * as THREE from 'three';
import { heightAt } from './terrain.js';
import { HALF_X, Z_START, Z_END } from './terrain.js';

const EYE = 1.7, RADIUS = 0.45, STEP = 0.62;

export class Player {
  constructor(camera, dom, colliders) {
    this.camera = camera;
    this.colliders = colliders;
    this.pos = new THREE.Vector3(0, 0, 250);
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.grounded = false;
    this.keys = new Set();
    this.locked = false;
    this.bobT = 0;
    this.dom = dom;
    addEventListener('keydown', (e) => { this.keys.add(e.code); if (e.code === 'Space') e.preventDefault(); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      document.body.classList.toggle('playing', this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * 0.0022));
    });
  }
  place(x, z, yaw = 0, pitch = 0, y) {
    this.pos.set(x, y ?? this.groundAt(x, z, 1e9), z);
    this.yaw = yaw; this.pitch = pitch;
  }
  groundAt(x, z, feet) {
    let g = heightAt(x, z);
    for (const b of this.colliders) {
      if (x > b.minX - 0.05 && x < b.maxX + 0.05 && z > b.minZ - 0.05 && z < b.maxZ + 0.05 && b.maxY <= feet + STEP && b.maxY > g) g = b.maxY;
    }
    return g;
  }
  blocked(x, z, feet) {
    for (const b of this.colliders) {
      if (b.maxY <= feet + STEP || b.minY >= feet + EYE) continue;
      const cx = Math.max(b.minX, Math.min(x, b.maxX)), cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz < RADIUS * RADIUS) return true;
    }
    return false;
  }
  tryMove(nx, nz) {
    const p = this.pos;
    const ok = (x, z) => {
      if (x < -HALF_X + 2 || x > HALF_X - 2 || z > Z_START - 8 || z < Z_END + 8) return false;
      if (this.blocked(x, z, p.y)) return false;
      const d = Math.hypot(x - p.x, z - p.z);
      if (this.grounded && d > 1e-4) {
        // terrain too steep to walk (cliff faces); stair/box steps are handled by STEP in groundAt
        const th = heightAt(x, z), tp = heightAt(p.x, p.z);
        if ((th - tp) / d > 1.3 && th > p.y + 0.02) return false;
      }
      return true;
    };
    if (ok(nx, nz)) { p.x = nx; p.z = nz; return; }
    if (ok(nx, p.z)) { p.x = nx; return; }
    if (ok(p.x, nz)) { p.z = nz; }
  }
  update(dt) {
    dt = Math.min(dt, 0.05);
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    if (k.has('ArrowLeft')) this.yaw += dt * 1.8;
    if (k.has('ArrowRight')) this.yaw -= dt * 1.8;
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = sprint ? 9.0 : 5.4;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = -sin * f + cos * s, wz = -cos * f - sin * s;
    const l = Math.hypot(wx, wz);
    if (l > 0) { wx /= l; wz /= l; }
    const accel = this.grounded ? 14 : 3.5;
    this.vel.x += (wx * speed - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wz * speed - this.vel.z) * Math.min(1, accel * dt);

    if (this.grounded && k.has('Space')) { this.vel.y = 7.4; this.grounded = false; }
    this.vel.y -= 22 * dt;

    // horizontal in sub-steps so thin colliders (rails) are not tunnelled
    const dist = Math.hypot(this.vel.x, this.vel.z) * dt;
    const steps = Math.max(1, Math.ceil(dist / 0.12));
    for (let i = 0; i < steps; i++) this.tryMove(this.pos.x + (this.vel.x * dt) / steps, this.pos.z + (this.vel.z * dt) / steps);

    this.pos.y += this.vel.y * dt;
    const g = this.groundAt(this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= g) {
      this.pos.y = g; this.vel.y = 0; this.grounded = true;
    } else if (this.grounded && this.pos.y - g < 0.35 && this.vel.y <= 0) {
      this.pos.y = g; this.vel.y = 0; // stick to descending slopes / stairs
    } else this.grounded = false;

    if (this.grounded && l > 0) this.bobT += dt * (sprint ? 11 : 8);
    const bob = this.grounded ? Math.sin(this.bobT) * 0.035 * (l > 0 ? 1 : 0) : 0;
    this.camera.position.set(this.pos.x, this.pos.y + EYE + bob, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
