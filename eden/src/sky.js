// Saturated blue sky dome, giant banded gas-giant with atmosphere rim and thin sweeping ring arcs, small moon,
// and cel-shaded cumulus banks along the horizon (large soft lobes, flat bellies, cool lavender undersides).
import * as THREE from 'three';
import { PAL } from './materials.js';
import { rng, makeNoise } from './noise.js';

export const SUN_DIR = new THREE.Vector3(-0.78, 0.55, 0.1).normalize();
export const FOG_COLOR = new THREE.Color(0xb3c7f4);

const GLSL_NOISE = /* glsl */ `
float sh31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float svn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(sh31(i), sh31(i+vec3(1,0,0)), f.x), mix(sh31(i+vec3(0,1,0)), sh31(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(sh31(i+vec3(0,0,1)), sh31(i+vec3(1,0,1)), f.x), mix(sh31(i+vec3(0,1,1)), sh31(i+vec3(1,1,1)), f.x), f.y), f.z); }
float sh11(float n){ return fract(sin(n * 12.9898 + 4.1) * 43758.5453); }
float sfbm(vec3 p){ return svn(p)*0.55 + svn(p*2.03+7.1)*0.3 + svn(p*4.1+3.3)*0.15; }
`;

export function createSky(scene) {
  const g = new THREE.Group();
  g.name = 'sky';
  scene.add(g);
  const N3 = makeNoise(9);

  // ── dome ────────────────────────────────────────────────────────────────────────────────────
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(6000, 48, 32),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(PAL.skyTop) },
        mid: { value: new THREE.Color(PAL.skyMid) },
        hor: { value: FOG_COLOR },
        sun: { value: SUN_DIR.clone() },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 hor; uniform vec3 sun;
        ${GLSL_NOISE}
        void main(){
          vec3 d = normalize(vP);
          float h = d.y;
          vec3 c = mix(hor, mid, smoothstep(0.0, 0.30, h));
          c = mix(c, top, smoothstep(0.20, 0.80, h));
          c = mix(hor, c, smoothstep(-0.12, 0.02, h));
          // faint paint-stroke drift in the blue so the dome never reads as a flat gradient
          float st = sfbm(vec3(d.x * 5.0, d.y * 14.0, d.z * 5.0)) - 0.5;
          c += vec3(-0.012, 0.0, 0.02) * st * smoothstep(0.05, 0.4, h);
          // soft sun-side lift
          float sd = max(dot(d, normalize(sun)), 0.0);
          c += vec3(0.05, 0.06, 0.04) * pow(sd, 6.0) * (1.0 - smoothstep(0.0, 0.6, h) * 0.4);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
  dome.renderOrder = -10;
  g.add(dome);

  // ── ringed planet (upper right, as in the concept) ───────────────────────────────────────────
  const planetDir = new THREE.Vector3(0.62, 0.42, -0.66).normalize();
  const planet = new THREE.Group();
  planet.position.copy(planetDir).multiplyScalar(4200);
  planet.lookAt(0, 0, 0);
  g.add(planet);
  const R = 1250;
  const pMat = new THREE.ShaderMaterial({
    fog: false, depthWrite: true,
    vertexShader: 'varying vec3 vN; varying vec3 vO; varying vec3 vV; void main(){ vO=position; vN=normalize(mat3(modelMatrix)*normal); vec4 wp = modelMatrix*vec4(position,1.0); vV = normalize(cameraPosition - wp.xyz); gl_Position=projectionMatrix*viewMatrix*wp;}',
    fragmentShader: `varying vec3 vN; varying vec3 vO; varying vec3 vV;
      ${GLSL_NOISE}
      void main(){
        vec3 n = normalize(vN);
        float l = dot(n, normalize(vec3(-0.75, 0.5, -0.25)));
        float lat = vO.y / ${R.toFixed(1)};
        // crisp cel bands of varying width + tone; the boundaries only drift very slowly (no wavy stripes)
        float warp = (sfbm(vec3(vO.x * 0.0012, vO.y * 0.0007, vO.z * 0.0012)) - 0.5) * 0.30;
        float bl = (lat + warp) * 7.0;
        float bi = floor(bl), bf = fract(bl);
        float tone = sh11(bi * 1.7 + 3.0);
        vec3 lit = tone < 0.30 ? vec3(0.47, 0.64, 0.97) : (tone < 0.64 ? vec3(0.66, 0.80, 1.0) : vec3(0.86, 0.93, 1.0));
        lit = mix(lit, vec3(0.95, 0.975, 1.0), (1.0 - smoothstep(0.0, 0.06, bf)) * 0.75 * step(0.45, sh11(bi * 4.3)));   // thin pale streak at some band edges
        vec3 sh = tone < 0.30 ? vec3(0.17, 0.27, 0.66) : (tone < 0.64 ? vec3(0.24, 0.37, 0.76) : vec3(0.31, 0.45, 0.85));
        float cel = smoothstep(-0.10, 0.06, l) * 0.55 + smoothstep(0.16, 0.30, l) * 0.45;
        vec3 c = mix(sh, lit, cel);
        // limb darkening toward saturated blue, with a thin bright atmosphere line on the lit edge
        float rim = pow(1.0 - abs(dot(n, normalize(vV))), 2.6);
        c = mix(c, vec3(0.34, 0.52, 0.94), smoothstep(0.30, 0.95, rim) * 0.55 * (1.0 - cel * 0.4));
        c += vec3(0.16, 0.18, 0.16) * smoothstep(0.82, 1.0, rim) * smoothstep(-0.1, 0.5, l);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), pMat);
  body.renderOrder = -9;
  planet.add(body);
  // outer atmosphere glow: camera-facing billboard (the planet group looks at the origin) with a soft falloff just outside the limb
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(R * 2 * 1.5, R * 2 * 1.5), new THREE.ShaderMaterial({
    fog: false, transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vU; void main(){ vU = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vU;
      void main(){
        float rr = length(vU) * 2.0 * 1.5;               // 1.0 at the planet limb
        float a = exp(-(rr - 1.0) * 6.0) * smoothstep(0.995, 1.03, rr);
        a *= 0.50 * (1.0 - smoothstep(1.2, 1.5, rr));
        gl_FragColor = vec4(vec3(0.72, 0.84, 1.0), a);
        #include <colorspace_fragment>
      }`,
  }));
  halo.renderOrder = -8;
  planet.add(halo);
  // rings: a broad faint veil + two thin crisp lines, tilted so they sweep across the sky as long arcs
  const ringMat = new THREE.ShaderMaterial({
    fog: false, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `varying vec3 vP;
      ${GLSL_NOISE}
      float line(float t, float c, float w, float soft){ return 1.0 - smoothstep(w, w + soft, abs(t - c)); }
      void main(){
        float r = length(vP.xy);
        float t = (r - ${(R * 1.45).toFixed(1)}) / ${(R * 1.35).toFixed(1)};
        float ang = atan(vP.y, vP.x);
        float a = line(t, 0.14, 0.04, 0.07) * 0.07 + line(t, 0.50, 0.008, 0.008) * 0.95 + line(t, 0.555, 0.016, 0.014) * 0.5 + line(t, 0.84, 0.006, 0.007) * 0.7;
        a *= smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.92, 1.0, t));
        // long tapered arcs: brightness waxes and wanes around the ring
        a *= 0.30 + 0.70 * smoothstep(0.25, 0.75, sfbm(vec3(cos(ang) * 1.6 + 3.0, sin(ang) * 1.6, t * 2.0)));
        gl_FragColor = vec4(vec3(0.97, 0.98, 1.0), a);
        #include <colorspace_fragment>
      }`,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(R * 1.45, R * 2.8, 256, 1), ringMat);
  ring.rotation.set(1.30, 0.16, 0.62);
  ring.renderOrder = -7;
  planet.add(ring);

  // ── small moon ───────────────────────────────────────────────────────────────────────────────
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(110, 48, 32),
    new THREE.ShaderMaterial({
      fog: false,
      vertexShader: 'varying vec3 vN; varying vec3 vO; void main(){ vO=position; vN=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `varying vec3 vN; varying vec3 vO; ${GLSL_NOISE}
        float crater(vec3 u, vec3 c, float r){ float d = acos(clamp(dot(u, normalize(c)), -1.0, 1.0)); return d / r; }
        void main(){
          vec3 n = normalize(vN);
          vec3 u = normalize(vO);
          // light from the upper left, nearly side-on to the viewer: a gibbous disc with a crisp curved terminator
          float l = dot(n, normalize(vec3(-0.85, 0.40, 0.30)));
          // a handful of big round craters (dark floor, bright lit rim), cel-flat
          float cr = 0.0, rimK = 0.0;
          vec3 cc[6]; float cs[6];
          cc[0] = vec3(0.30, 0.52, 0.80); cs[0] = 0.30;
          cc[1] = vec3(-0.35, 0.18, 0.92); cs[1] = 0.21;
          cc[2] = vec3(0.62, -0.20, 0.75); cs[2] = 0.17;
          cc[3] = vec3(-0.10, -0.55, 0.83); cs[3] = 0.24;
          cc[4] = vec3(0.05, 0.12, 1.0); cs[4] = 0.12;
          cc[5] = vec3(-0.62, -0.30, 0.72); cs[5] = 0.14;
          for (int i = 0; i < 6; i++) {
            float q = crater(u, cc[i], cs[i]);
            cr = max(cr, 1.0 - smoothstep(0.88, 0.94, q));
            rimK = max(rimK, smoothstep(0.84, 0.90, q) * (1.0 - smoothstep(0.96, 1.04, q)));
          }
          vec3 lit = mix(vec3(0.97, 0.98, 1.0), vec3(0.72, 0.78, 0.95), cr * 0.9);
          lit = mix(lit, vec3(1.0), rimK * 0.5);
          vec3 sh = mix(vec3(0.52, 0.62, 0.91), vec3(0.38, 0.47, 0.80), cr * 0.9);
          float cel = smoothstep(0.0, 0.035, l) * 0.62 + smoothstep(0.30, 0.38, l) * 0.38;
          vec3 c = mix(sh, lit, cel);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
  moon.position.copy(new THREE.Vector3(0.12, 0.33, -0.93).normalize()).multiplyScalar(3900);
  moon.renderOrder = -6;
  g.add(moon);

  // ── cumulus banks ───────────────────────────────────────────────────────────────────────────
  // Every lobe is an analytic ellipsoid IMPOSTOR (camera-facing quad, ray-ellipsoid solve in the fragment shader, real depth):
  // perfectly round, anti-aliased silhouettes at any size and only 2 triangles per lobe, so the clouds are never polygonal.
  const cloudMat = new THREE.ShaderMaterial({
    fog: false, alphaToCoverage: true, depthTest: false, depthWrite: false,
    uniforms: { sun: { value: SUN_DIR.clone() }, hor: { value: FOG_COLOR } },
    vertexShader: `attribute vec3 aC; attribute vec3 aS; attribute float aR; attribute vec2 aB;
      varying vec3 vPv; varying vec3 vC; varying vec3 vS; varying float vR; varying vec2 vB;
      void main(){
        vec4 cv = viewMatrix * modelMatrix * vec4(aC, 1.0);
        // tight screen-space bounding box of the projected ellipsoid (support function of the view-space covariance): little overdraw
        float cy = cos(aR), sy = sin(aR);
        mat3 A = mat3(viewMatrix) * transpose(mat3(cy, 0.0, sy, 0.0, 1.0, 0.0, -sy, 0.0, cy));
        vec3 s2 = aS * aS;
        float ex = sqrt(A[0].x * A[0].x * s2.x + A[1].x * A[1].x * s2.y + A[2].x * A[2].x * s2.z);
        float ey = sqrt(A[0].y * A[0].y * s2.x + A[1].y * A[1].y * s2.y + A[2].y * A[2].y * s2.z);
        vec4 pv = cv + vec4(position.x * ex * 1.12, position.y * ey * 1.12, 0.0, 0.0);
        vPv = pv.xyz; vC = aC; vS = aS; vR = aR; vB = aB;
        gl_Position = projectionMatrix * pv;
      }`,
    fragmentShader: `varying vec3 vPv; varying vec3 vC; varying vec3 vS; varying float vR; varying vec2 vB; uniform vec3 sun; uniform vec3 hor;
      void main(){
        // world-aligned ray (the sky group sits at the camera, so its local origin is the eye)
        vec3 D = normalize(transpose(mat3(viewMatrix)) * normalize(vPv));
        float cy = cos(vR), sy = sin(vR);
        vec3 rel = -vC;                                       // eye relative to the lobe centre
        vec3 o = vec3(cy * rel.x - sy * rel.z, rel.y, sy * rel.x + cy * rel.z) / vS;
        vec3 d = vec3(cy * D.x - sy * D.z, D.y, sy * D.x + cy * D.z) / vS;
        float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1.0;
        float r2 = dot(o, o) - b * b / a;                      // squared closest approach (unit-sphere space)
        float w = fwidth(r2) * 0.9 + 1e-4;
        float cov = 1.0 - smoothstep(1.0 - w, 1.0 + w, r2);
        if (cov <= 0.0) discard;
        float disc = max(b * b - a * c, 0.0);
        float t = (-b - sqrt(disc)) / a;
        vec3 pl = o + t * d;                                   // unit-sphere hit point
        vec3 nl = pl / vS;
        vec3 n = normalize(vec3(cy * nl.x + sy * nl.z, nl.y, -sy * nl.x + cy * nl.z));
        vec3 P = t * D;
        float vH = clamp((P.y - vB.x) / vB.y, 0.0, 1.0);
        float l = dot(n, normalize(sun));
        // 3-tone cel: clean white lit tops, pale blue half-shadow, periwinkle core shadow
        float cel = smoothstep(-0.12, 0.02, l) * 0.5 + smoothstep(0.30, 0.46, l) * 0.5;
        vec3 shade = vec3(0.60, 0.69, 0.93);
        vec3 mid = vec3(0.82, 0.88, 1.0);
        vec3 lit = vec3(1.0);
        vec3 col = cel < 0.5 ? mix(shade, mid, cel * 2.0) : mix(mid, lit, (cel - 0.5) * 2.0);
        // flat cool belly, brighter crowns
        col = mix(col, col * vec3(0.84, 0.88, 1.0), smoothstep(0.35, 0.0, vH) * 0.55);
        col = mix(col, vec3(1.0), smoothstep(0.65, 1.0, vH) * 0.20 * step(0.0, l));
        // atmospheric haze toward the horizon
        float hz = smoothstep(0.16, 0.0, normalize(P).y);
        col = mix(col, hor, hz * 0.45);
        gl_FragColor = vec4(col, cov);
        #include <colorspace_fragment>
      }`,
  });
  const cloudGroup = new THREE.Group();
  g.add(cloudGroup);
  const r = rng(77);
  const quad = new THREE.PlaneGeometry(2, 2);
  const lobes = [];
  const lobe = (cx, cy, cz, sx, sy, sz, ry, bankBase, bankH) => {
    // painter's-order key: far lobes first (depth testing at 3-5 km would z-fight at the lobe intersections)
    lobes.push({ cx, cy, cz, sx, sy, sz, ry, bankBase, bankH, key: Math.hypot(cx, cy, cz) - 0.35 * Math.max(sx, sy, sz) });
  };
  function flushBank() {}                      // lobes of every bank are merged and depth-sorted once, in finishClouds()
  function finishClouds() {
    lobes.sort((p, q) => q.key - p.key);
    const n = lobes.length;
    const C = new Float32Array(n * 3), S = new Float32Array(n * 3), R = new Float32Array(n), B = new Float32Array(n * 2);
    lobes.forEach((o, i) => { C.set([o.cx, o.cy, o.cz], i * 3); S.set([o.sx, o.sy, o.sz], i * 3); R[i] = o.ry; B.set([o.bankBase, o.bankH], i * 2); });
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('aC', new THREE.InstancedBufferAttribute(C, 3));
    geo.setAttribute('aS', new THREE.InstancedBufferAttribute(S, 3));
    geo.setAttribute('aR', new THREE.InstancedBufferAttribute(R, 1));
    geo.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 2));
    geo.instanceCount = n;
    const mesh = new THREE.Mesh(geo, cloudMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;
    cloudGroup.add(mesh);
  }
  // a bank frame: lobes are placed in bank-local (lx along the bank, lz toward the origin) coordinates
  function frame(az, elev, dist, bankBaseOff, Hgt) {
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev));
    const centre = dir.clone().multiplyScalar(dist);
    const ry = -az, cs = Math.cos(ry), sn = Math.sin(ry);
    const base = centre.y + bankBaseOff;
    return (lx, ly, lz, sx, sy, sz) => lobe(centre.x + lx * cs + lz * sn, centre.y + ly, centre.z - lx * sn + lz * cs, sx, sy, sz, ry, base, Hgt);
  }
  // little puffs sitting on the surface of a big lobe (scalloped outline: the cartoon-cumulus look)
  function puffs(place, lx, ly, lz, Rk, count, upBias) {
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2, e = (r() * 0.9 - 0.15 + upBias) * 1.2;
      const px = Math.cos(a) * Math.cos(e), py = Math.sin(e), pz = Math.sin(a) * Math.cos(e) * 0.8;
      const rr = Rk * (0.30 + 0.28 * r());
      place(lx + px * Rk * 0.9, ly + py * Rk * 0.8, lz + pz * Rk * 0.9, rr * 1.15, rr * 0.9, rr);
    }
  }
  function bank(az, elev, dist, W, Hgt) {
    const place = frame(az, elev, dist, 0, Hgt);
    const nl = 9 + Math.floor(r() * 7);
    for (let k = 0; k < nl; k++) {
      const u = (k + 0.5) / nl - 0.5;
      const env = Math.max(0.15, 1 - Math.abs(u) * 1.7);
      const Rk = Hgt * (0.30 + 0.38 * r()) * (0.55 + 0.75 * env);
      const lx = u * W * 1.5 + (r() - 0.5) * W * 0.05, ly = Rk * (0.42 + 0.35 * env * r()), lz = (r() - 0.5) * W * 0.18;
      place(lx, ly, lz, Rk * 1.35, Rk * 0.92, Rk * 1.05);
      if (r() < 0.75) place(lx + (r() - 0.5) * Rk * 0.4, Rk * (0.9 + 0.5 * env * r()), (r() - 0.5) * W * 0.1, Rk * 0.7, Rk * 0.62, Rk * 0.7);
      if (r() < 0.8) puffs(place, lx, ly, lz, Rk, 2, 0.2);
    }
    place(0, Hgt * 0.04, 0, W * 0.92, Hgt * 0.12, W * 0.19);       // flat belly
    flushBank();
  }
  // puffy cumulus: dome-shaped mounds of big overlapping lobes with a shallow flat belly (round and fluffy, not ribbons)
  function cumulus(az, elev, dist, W, Hh) {
    const place = frame(az, elev, dist, -Hh * 0.05, Hh * 1.25);
    const nl = 6 + Math.floor(r() * 4);
    for (let k = 0; k < nl; k++) {
      const u = (k + 0.5) / nl - 0.5;
      const env = Math.max(0.18, 1 - 4 * u * u);
      const Rk = Hh * (0.30 + 0.30 * env) * (0.85 + 0.3 * r());
      const lx = u * W * 1.05 + (r() - 0.5) * Rk * 0.4;
      const ly = Rk * 0.55 + env * Hh * 0.30 * r();
      place(lx, ly, (r() - 0.5) * W * 0.10, Rk * 1.18, Rk * 0.95, Rk * 1.0);
      if (env > 0.5 && r() < 0.85) place(lx * 0.75 + (r() - 0.5) * Rk * 0.4, ly + Rk * (0.62 + 0.25 * r()), (r() - 0.5) * W * 0.06, Rk * 0.72, Rk * 0.66, Rk * 0.72);
      puffs(place, lx, ly, 0, Rk, 3, 0.25);
    }
    place(0, Hh * 0.05, 0, W * 0.58, Hh * 0.17, W * 0.17);
    flushBank();
  }
  // keep clouds off the big planet's disc (angular radius ~17 deg): re-roll candidates that would hide it
  const planetAz = Math.atan2(planetDir.x, -planetDir.z);
  const offPlanet = (az, el, margin) => {
    const d = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    return d.angleTo(planetDir) > margin;
  };
  const roll = (fn, margin) => { for (let t = 0; t < 12; t++) { const [az, el] = fn(); if (offPlanet(az, el, margin)) return [az, el]; } return null; };
  // low horizon banks all round, brighter and bigger toward the planet / spawn view
  const banksN = 30;
  for (let i = 0; i < banksN; i++) {
    const az = (i / banksN) * Math.PI * 2 + (r() - 0.5) * 0.18;
    const dist = 3000 + r() * 1700;
    const elev = THREE.MathUtils.degToRad(0.5 + r() * 7.5);
    const W = 520 + r() * 900;
    bank(az, elev, dist, W, 190 + r() * 380);
  }
  // a ring of tall cumulus at 9-22 degrees so cloud always shows above the canyon rims at eye level, plus higher puffs
  for (let i = 0; i < 14; i++) {
    const pick = roll(() => [(i / 14) * Math.PI * 2 + (r() - 0.5) * 0.3, THREE.MathUtils.degToRad(8 + r() * 14)], 0.46);
    if (pick) cumulus(pick[0], pick[1], 3000 + r() * 1100, 520 + r() * 380, 250 + r() * 160);
  }
  for (let i = 0; i < 14; i++) {
    const pick = roll(() => [(i / 14) * Math.PI * 2 + (r() - 0.5) * 0.5 + 0.2, THREE.MathUtils.degToRad(22 + r() * 26)], 0.46);
    if (pick) cumulus(pick[0], pick[1], 2600 + r() * 1300, 380 + r() * 340, 170 + r() * 150);
  }
  // puffs that flank the big planet (it sits upper right of the spawn view) without covering it
  for (const [daz, el, W, Hh] of [[-50, 12, 700, 290], [46, 9, 620, 260], [-48, 32, 380, 170], [52, 30, 340, 150]]) {
    cumulus(planetAz + THREE.MathUtils.degToRad(daz), THREE.MathUtils.degToRad(el), 3300 + r() * 500, W, Hh);
  }

  finishClouds();

  return {
    group: g,
    update(camPos) { g.position.copy(camPos); },
  };
}
