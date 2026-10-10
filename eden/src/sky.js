// Painterly anime sky: saturated blue vertical gradient with a soft pale haze horizon and faint high cirrus strokes, a giant pale
// ringed planet that is mostly sky-coloured (soft swirled bands, bright limb, veiled by the horizon haze), thin tapered orbital
// arcs, a small moon, and large piled cumulus banks (lobed ellipsoid impostors: bright white tops, pale lavender-blue bellies).
// Colours below are authored as sRGB hex through THREE.Color (-> linear uniforms); the haze colour at the horizon is the same
// colour atmosphere.js fades far geometry into, so distant silhouettes dissolve into the sky.
import * as THREE from 'three';
import { rng } from './noise.js';
import { HAZE } from './atmosphere.js';

export const SUN_DIR = HAZE.sun.clone();
export const FOG_COLOR = new THREE.Color(0xbbd0f8);

const GLSL_NOISE = /* glsl */ `
float sh31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float svn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(sh31(i), sh31(i+vec3(1,0,0)), f.x), mix(sh31(i+vec3(0,1,0)), sh31(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(sh31(i+vec3(0,0,1)), sh31(i+vec3(1,0,1)), f.x), mix(sh31(i+vec3(0,1,1)), sh31(i+vec3(1,1,1)), f.x), f.y), f.z); }
float sfbm(vec3 p){ return svn(p)*0.55 + svn(p*2.03+7.1)*0.3 + svn(p*4.1+3.3)*0.15; }
`;

// the dome shares the haze model: the same sun glow / elevation tint as the fog chunk, so far silhouettes meet the sky seamlessly
const HAZE_GLSL = /* glsl */ `
vec3 hazeAt(vec3 d, vec3 hor){
  float up = smoothstep(0.0, 0.5, d.y);
  vec3 c = mix(hor, vec3(${HAZE.zenithBlue.map((v) => v.toFixed(4)).join(', ')}), up * 0.55);
  float s = pow(max(dot(d, vec3(${HAZE.sun.x.toFixed(4)}, ${HAZE.sun.y.toFixed(4)}, ${HAZE.sun.z.toFixed(4)})), 0.0), 5.0);
  return c + vec3(0.060, 0.052, 0.022) * s * (1.0 - up * 0.6);
}
`;

const col = (hex) => new THREE.Color(hex);

export function createSky(scene) {
  const g = new THREE.Group();
  g.name = 'sky';
  scene.add(g);

  // ── dome ────────────────────────────────────────────────────────────────────────────────────
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(6000, 48, 32),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        cTop: { value: col(0x2f66dc) },
        cMid: { value: col(0x4c88ec) },
        cLow: { value: col(0x7fb0f6) },
        hor: { value: FOG_COLOR },
        sun: { value: SUN_DIR.clone() },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; uniform vec3 cTop; uniform vec3 cMid; uniform vec3 cLow; uniform vec3 hor; uniform vec3 sun;
        ${GLSL_NOISE}
        ${HAZE_GLSL}
        void main(){
          vec3 d = normalize(vP);
          float h = d.y;
          // deep zenith -> rich mid blue -> bright low blue -> pale hazy horizon
          vec3 c = mix(hazeAt(d, hor), cLow, smoothstep(0.0, 0.11, h));
          c = mix(c, cMid, smoothstep(0.07, 0.36, h));
          c = mix(c, cTop, smoothstep(0.30, 0.95, h));
          c = mix(hazeAt(d, hor), c, smoothstep(-0.05, 0.0, h));
          // high, thin painted cirrus: long horizontal soft wisps, only mid-sky, only barely lighter than the blue
          float az = atan(d.x, -d.z);
          vec2 q = vec2(az * 2.0, h * 10.0);
          float w1 = sfbm(vec3(q * 0.8, 1.7)) - 0.5;
          float st = svn(vec3(q.x + w1 * 3.0, q.y * 2.6 + w1 * 2.0, 5.0));
          float wisp = smoothstep(0.58, 0.82, st) * smoothstep(0.06, 0.22, h) * (1.0 - smoothstep(0.36, 0.70, h));
          c = mix(c, vec3(0.42, 0.62, 0.97), wisp * 0.20);
          // very faint large-scale tonal drift so the blue is never a pure gradient
          float dr = sfbm(vec3(az * 1.3, h * 3.0, 9.0)) - 0.5;
          c += vec3(-0.004, 0.0, 0.010) * dr * smoothstep(0.05, 0.4, h);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
  dome.renderOrder = -10;
  g.add(dome);

  // ── ringed planet (upper right, as in the concept) ───────────────────────────────────────────
  const planetDir = new THREE.Vector3(0.62, 0.50, -0.60).normalize();
  const PLANET_ANG = Math.asin(2000 / 4200);
  const planet = new THREE.Group();
  planet.position.copy(planetDir).multiplyScalar(4200);
  planet.lookAt(0, 0, 0);
  g.add(planet);
  const R = 2000;
  const pMat = new THREE.ShaderMaterial({
    fog: false, depthWrite: true,
    uniforms: {
      sun: { value: SUN_DIR.clone() }, hor: { value: FOG_COLOR },
      cNight: { value: col(0x6a9aea) }, cDay: { value: col(0xa6c1f8) }, cDeep: { value: col(0x8199dc) },
      cStreak: { value: col(0xdbe6fb) }, cLimb: { value: col(0xe9f0fd) },
    },
    vertexShader: 'varying vec3 vN; varying vec3 vO; varying vec3 vV; varying vec3 vW; void main(){ vO=position; vN=normalize(mat3(modelMatrix)*normal); vec4 wp = modelMatrix*vec4(position,1.0); vV = normalize(cameraPosition - wp.xyz); vW = wp.xyz - cameraPosition; gl_Position=projectionMatrix*viewMatrix*wp;}',
    fragmentShader: `varying vec3 vN; varying vec3 vO; varying vec3 vV; varying vec3 vW;
      uniform vec3 sun; uniform vec3 hor; uniform vec3 cNight; uniform vec3 cDay; uniform vec3 cDeep; uniform vec3 cStreak; uniform vec3 cLimb;
      ${GLSL_NOISE}
      void main(){
        vec3 n = normalize(vN);
        vec3 v = normalize(vV);
        float ndv = clamp(dot(n, v), 0.0, 1.0);
        float l = dot(n, normalize(sun));
        // soft banded swirls following the globe: a tilted pole gives curved latitude arcs that sweep like the concept
        vec3 u = normalize(vO);
        vec3 ax = normalize(vec3(0.58, 0.80, 0.30));
        vec3 e1 = normalize(vec3(0.0, 0.0, 1.0) - ax * ax.z);
        vec3 e2 = cross(ax, e1);
        float lat = dot(u, ax);
        float lon = atan(dot(u, e2), dot(u, e1));
        float w1 = sfbm(vec3(u * 2.2 + 1.3)) - 0.5;
        float w2 = sfbm(vec3(u * 5.0 + 9.1)) - 0.5;
        float s1 = svn(vec3(lon * 1.7 + w1 * 2.4, lat * 13.0 + w1 * 4.5, 2.0));
        float s2 = svn(vec3(lon * 3.0 + w2 * 2.8, lat * 29.0 + w2 * 5.0, 6.0));
        float streak = smoothstep(0.50, 0.72, s1) * 0.85 + smoothstep(0.58, 0.80, s2) * 0.45;
        float deep = smoothstep(0.52, 0.78, sfbm(vec3(u * 3.4 + vec3(0.0, lat * 2.0, 4.0))));
        float day = smoothstep(-0.30, 0.55, l);
        vec3 c = mix(cNight, cDay, day);
        c = mix(c, cDeep, deep * (0.25 + 0.35 * day));
        c = mix(c, cStreak, clamp(streak, 0.0, 1.0) * (0.10 + 0.62 * day));
        // atmosphere rim: crisp pale line on the lit limb, only a hint of it on the shadow side
        float rim = pow(1.0 - ndv, 3.0);
        c = mix(c, cLimb, smoothstep(0.55, 0.98, rim) * (0.25 + 0.75 * smoothstep(-0.25, 0.45, l)));
        // the horizon haze (and cloud banks) veil the lower part of the disc
        float el = normalize(vW).y;
        c = mix(c, hor, smoothstep(0.22, 0.02, el) * 0.75);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), pMat);
  body.renderOrder = -9;
  planet.add(body);
  // sky layers that must blend are drawn in the OPAQUE pass (custom blending, not `transparent`) so the cloud banks, which are
  // opaque-pass geometry, always cover them: rings and glow sit behind the clouds as they should
  const skyBlend = { transparent: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation };
  // outer atmosphere glow: camera-facing billboard (the planet group looks at the origin) with a soft falloff just outside the limb
  const RS = R / Math.cos(PLANET_ANG);                     // silhouette radius of the sphere in the plane through its centre
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(RS * 2 * 1.5, RS * 2 * 1.5), new THREE.ShaderMaterial({
    fog: false, depthWrite: false, depthTest: false, ...skyBlend,
    vertexShader: 'varying vec2 vU; void main(){ vU = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vU;
      void main(){
        float rr = length(vU) * 2.0 * 1.5;               // 1.0 at the planet limb
        float a = exp(-(rr - 1.0) * 7.0) * smoothstep(0.995, 1.025, rr);
        a *= 0.42 * (1.0 - smoothstep(1.15, 1.5, rr));
        gl_FragColor = vec4(vec3(0.72, 0.84, 1.0), a);
        #include <colorspace_fragment>
      }`,
  }));
  halo.renderOrder = -8;
  planet.add(halo);
  // rings: slender tapered arcs. The ring is a flat ELLIPSE painted on the planet's screen-facing plane (squashed and rolled), not a
  // real tilted disc: all of it stays at the planet's depth, so no part swings toward the camera. The lower half passes in front of
  // the planet, the upper half behind it (discarded inside the disc). Each streak has its own radius, width and angular window;
  // width and opacity taper to a point at both ends, so they read as long sweeping brush strokes rather than uniform stripes.
  const ringMat = new THREE.ShaderMaterial({
    fog: false, depthWrite: false, depthTest: false, side: THREE.DoubleSide, ...skyBlend,
    uniforms: { uPsi: { value: 0.34 }, uSquash: { value: 0.30 } },
    vertexShader: 'varying vec2 vP; void main(){ vP=position.xy / ' + R.toFixed(1) + '; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `varying vec2 vP; uniform float uPsi; uniform float uSquash;
      ${GLSL_NOISE}
      const float PI = 3.14159265;
      // c: ellipse semi-major (in planet radii), w: half width (planet radii, measured across the stroke), a0..a1: angular window
      // (radians along the ellipse), s: edge softness (fraction of w)
      float streak(float er, float g, float ang, float c, float w, float a0, float a1, float s){
        float u = (ang - a0) / (a1 - a0);
        if (u <= 0.0 || u >= 1.0) return 0.0;
        float env = pow(sin(PI * u), 0.65);                 // 0 at both tips, ~1 across the middle
        float ww = w * (0.16 + 0.84 * env);
        float d = abs(er - c) / g;
        return (1.0 - smoothstep(ww * (1.0 - s), ww, d)) * env;
      }
      void main(){
        vec2 p = vP;
        float cs = cos(uPsi), sn = sin(uPsi);
        vec2 u = vec2(cs * p.x + sn * p.y, -sn * p.x + cs * p.y);
        vec2 ue = vec2(u.x, u.y / uSquash);
        float er = length(ue);
        float g = length(vec2(u.x, u.y / (uSquash * uSquash))) / max(er, 1e-4);     // |grad er|: converts er offsets to perpendicular distance
        float ang = atan(ue.y, ue.x);
        if (u.y > 0.0 && length(p) < 1.14) discard;           // the far half of the ring is hidden behind the planet
        float a = 0.0;
        a = max(a, streak(er, g, ang, 2.20, 0.085, 1.75, 3.00, 0.95) * 0.24);    // broad pale veil
        a = max(a, streak(er, g, ang, 2.02, 0.013, 1.95, 3.05, 0.65) * 0.95);   // bright thin line (inner)
        a = max(a, streak(er, g, ang, 2.13, 0.022, 1.80, 3.08, 0.85) * 0.80);    // soft thicker line
        a = max(a, streak(er, g, ang, 2.34, 0.011, 2.05, 3.02, 0.60) * 0.80);   // outer thin line
        a = max(a, streak(er, g, ang, 2.50, 0.007, 2.20, 2.94, 0.55) * 0.55);   // faint far line
        a *= 0.72 + 0.28 * smoothstep(0.25, 0.75, sfbm(vec3(cos(ang) * 2.0 + 3.0, sin(ang) * 2.0, er * 3.0)));
        if (a <= 0.002) discard;
        gl_FragColor = vec4(vec3(0.95, 0.97, 1.0), a);
        #include <colorspace_fragment>
      }`,
  });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(R * 5.4, R * 5.4), ringMat);
  ring.renderOrder = -7;
  planet.add(ring);

  // ── small moon ───────────────────────────────────────────────────────────────────────────────
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(190, 48, 32),
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
          // a handful of big round craters (soft lavender floor, bright lit rim), cel-flat
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
            cr = max(cr, 1.0 - smoothstep(0.70, 0.98, q));
            rimK = max(rimK, smoothstep(0.84, 0.90, q) * (1.0 - smoothstep(0.96, 1.04, q)));
          }
          vec3 lit = mix(vec3(0.95, 0.97, 1.0), vec3(0.78, 0.84, 0.98), cr * 0.55);
          lit = mix(lit, vec3(1.0), rimK * 0.20);
          vec3 sh = mix(vec3(0.48, 0.60, 0.92), vec3(0.40, 0.50, 0.85), cr * 0.55);
          float cel = smoothstep(0.0, 0.05, l) * 0.62 + smoothstep(0.30, 0.40, l) * 0.38;
          vec3 c = mix(sh, lit, cel);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
  moon.position.copy(new THREE.Vector3(0.12, 0.33, -0.93).normalize()).multiplyScalar(3900);
  moon.renderOrder = -6;
  g.add(moon);

  // ── cumulus piles ───────────────────────────────────────────────────────────────────────────
  // Each pile is ONE card (a world-space quad on the tangent plane of the sky sphere, facing the viewer). Its body is a cluster of
  // 35-60 spheres kept in a data texture; the fragment shader ray-resolves the cluster as a union (the scalloped, cauliflower
  // outline), blends the sphere normals with a soft maximum (so the shading reads as one billowing mass instead of separate balls),
  // and paints it with a soft 3-tone cel: bright white tops, pale lavender half-shade, blue-lavender belly, soft lavender creases.
  const cloudMat = new THREE.ShaderMaterial({
    fog: false, alphaToCoverage: true, depthTest: false, depthWrite: false,
    uniforms: { sun: { value: SUN_DIR.clone() }, hor: { value: FOG_COLOR }, tLobes: { value: null } },
    vertexShader: `attribute vec3 aC; attribute vec3 aX; attribute vec3 aY; attribute vec2 aHalf; attribute vec2 aLobe; attribute vec2 aMeta;
      varying vec2 vP; varying vec3 vD; varying vec3 vAx; varying vec3 vAy; varying vec2 vLobe; varying vec2 vMeta;
      void main(){
        vec2 pl = position.xy * aHalf;
        vec3 w = aC + aX * pl.x + aY * pl.y;
        vP = pl; vD = w; vAx = aX; vAy = aY; vLobe = aLobe; vMeta = aMeta;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: `precision highp sampler2D;
      varying vec2 vP; varying vec3 vD; varying vec3 vAx; varying vec3 vAy; varying vec2 vLobe; varying vec2 vMeta;
      uniform vec3 sun; uniform vec3 hor; uniform sampler2D tLobes;
      ${GLSL_NOISE}
      void main(){
        float H = vMeta.y;
        float aa = max(length(fwidth(vP)), 1e-3);
        int start = int(vLobe.x + 0.5), count = int(vLobe.y + 0.5);
        float beta = 1.0 / (0.16 * H);                          // softness of the normal blend between neighbouring lobes
        float cov = 0.0, m = -1e9, wsum = 0.0, z1 = -1e9, z2 = -1e9;
        vec3 nsum = vec3(0.0);
        for (int j = 0; j < 128; j++) {
          if (j >= count) break;
          int idx = start + j;
          vec4 Lb = texelFetch(tLobes, ivec2(idx & 255, idx >> 8), 0);
          vec2 dv = vP - Lb.xy;
          float d2 = dot(dv, dv);
          float r = Lb.w;
          float edge = r - sqrt(d2);
          cov = max(cov, clamp(edge / aa + 0.5, 0.0, 1.0));
          if (edge > -aa) {
            float hz = sqrt(max(r * r - d2, 0.0));
            float z = Lb.z + hz;
            vec3 nr = vec3(dv, hz) / r;
            float w;
            if (z > m) { float s = exp(beta * (m - z)); wsum *= s; nsum *= s; m = z; w = 1.0; }
            else w = exp(beta * (z - m));
            wsum += w; nsum += w * nr;
            if (z > z1) { z2 = z1; z1 = z; } else if (z > z2) { z2 = z; }
          }
        }
        if (cov <= 0.0) discard;
        vec3 nrm = normalize(nsum / max(wsum, 1e-4));
        // card frame: x right, y up (tilted by elevation), z toward the viewer. Light: the sun, wrapped so that every pile is
        // front-lit from the upper left whatever its azimuth (back-lit piles would otherwise turn grey)
        vec3 az = cross(vAx, vAy);
        vec3 sc = vec3(dot(sun, vAx), dot(sun, vAy), dot(sun, az));
        vec3 Lc = normalize(vec3(sc.x * 0.8, 0.70 + 0.30 * sc.y, 0.40 + 0.3 * sc.z));
        vec3 pw = vec3(vP, 0.0) * (6.0 / H);
        nrm = normalize(nrm + 0.30 * (vec3(svn(pw), svn(pw + 11.3), svn(pw + 23.7)) - 0.5));
        float l = dot(nrm, Lc);
        float cel = smoothstep(-0.18, 0.06, l) * 0.5 + smoothstep(0.24, 0.52, l) * 0.5;
        vec3 shade = vec3(0.58, 0.69, 0.96);
        vec3 mid = vec3(0.84, 0.90, 1.0);
        vec3 lit = vec3(1.0, 0.995, 0.985);
        vec3 col = cel < 0.5 ? mix(shade, mid, cel * 2.0) : mix(mid, lit, (cel - 0.5) * 2.0);
        // soft lavender creases where two puffs meet
        float crease = (z2 > -1e8) ? smoothstep(0.16, 0.0, (z1 - z2) / (0.10 * H)) : 0.0;
        col = mix(col, shade * vec3(0.92, 0.95, 1.0), crease * 0.16 * (1.0 - 0.8 * smoothstep(0.1, 0.5, l)));
        // belly: the base of the pile turns blue-lavender, crowns stay bright
        float vH = clamp((vP.y - vMeta.x) / H, 0.0, 1.0);
        col = mix(col, vec3(0.44, 0.58, 0.93), smoothstep(0.38, 0.0, vH) * 0.55);
        col = mix(col, vec3(1.0), smoothstep(0.62, 1.0, vH) * 0.22 * smoothstep(0.0, 0.3, l));
        // atmospheric haze toward the horizon
        float hz = smoothstep(0.20, 0.0, normalize(vD).y);
        col = mix(col, hor, hz * 0.55);
        gl_FragColor = vec4(col, cov);
        #include <colorspace_fragment>
      }`,
  });
  const cloudGroup = new THREE.Group();
  g.add(cloudGroup);
  const r = rng(77);
  const quad = new THREE.PlaneGeometry(2, 2);
  const lobeData = [];                        // x, y, z, r per lobe (card-centred coordinates)
  const piles = [];
  // A pile grown like a cauliflower: a few big seed lobes on a flat base, then children are budded off the upper-front
  // surface of existing lobes (smaller each generation), so the silhouette is a scallop of ever smaller round puffs.
  function pile(az, elev, dist, W, H, count) {
    const L = [];
    // skyline envelope: 2-3 towering heads of different height over a lower shoulder
    const nPk = 2 + Math.floor(r() * 2);
    const pk = [];
    for (let i = 0; i < nPk; i++) pk.push({ u: (r() - 0.5) * 0.8, h: 0.55 + 0.45 * r(), w: 0.10 + 0.12 * r() });
    pk[0].h = 1.0;
    const env = (u) => { let e = 0.30; for (const q of pk) e = Math.max(e, q.h * Math.exp(-Math.pow((u - q.u) / q.w, 2))); return e; };
    // caps: lobes whose tops follow the skyline (the outline), each budding smaller puffs on its upper-front surface
    const nCap = Math.max(5, Math.round(W / (H * 0.40)));
    for (let i = 0; i < nCap; i++) {
      const u = (i + 0.5) / nCap - 0.5 + (r() - 0.5) * 0.4 / nCap;
      const T = H * env(u);
      const Rc = Math.min(T * (0.30 + 0.10 * r()), H * 0.36) * (0.85 + 0.3 * r());
      const c = { x: u * W, y: T - Rc * 0.82, z: (r() - 0.5) * Rc * 0.4, R: Rc };
      L.push(c);
      const nb = 1 + (r() < 0.6 ? 1 : 0) + (r() < 0.25 ? 1 : 0);
      for (let k = 0; k < nb; k++) {
        const rc = Rc * (0.50 + 0.25 * r());
        const a = (0.12 + 0.76 * r()) * Math.PI;
        const reach = Rc * 0.80 + rc * 0.30;
        L.push({ x: c.x + Math.cos(a) * reach * 1.1, y: Math.min(c.y + Math.sin(a) * reach * 0.9, T - rc * 0.55), z: c.z + rc * (0.2 + 0.4 * r()), R: rc });
      }
    }
    // body: fill the volume under the skyline with big lobes (the mass of the pile), flat-based
    const nFill = Math.max(4, Math.round(count * 0.35));
    for (let i = 0; i < nFill; i++) {
      const u = (r() - 0.5) * 0.92;
      const T = H * env(u);
      const Rf = Math.max(H * 0.14, Math.min(T * 0.36, H * 0.34)) * (0.8 + 0.4 * r());
      const yMax = T - Rf * 1.1;
      L.push({ x: u * W, y: Math.max(Rf * 0.9, yMax * (0.15 + 0.7 * r())), z: (r() - 0.35) * Rf * 0.5, R: Rf });
    }
    // flat base: wide low lobes so the bottom of the pile reads as one flat cloud base
    const nBase = Math.max(3, Math.round(W / (H * 0.7)));
    for (let i = 0; i < nBase; i++) {
      const u = (i + 0.5) / nBase - 0.5;
      const Rb = H * (0.17 + 0.05 * r()) * Math.min(1, 0.4 + env(u) * 1.2);
      L.push({ x: u * W * 0.95, y: Rb * 0.9, z: Rb * 0.45 + (r() - 0.5) * Rb * 0.3, R: Rb });
    }
    // bbox -> card
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const c of L) { x0 = Math.min(x0, c.x - c.R); x1 = Math.max(x1, c.x + c.R); y0 = Math.min(y0, c.y - c.R); y1 = Math.max(y1, c.y + c.R); }
    const pad = H * 0.04;
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev));
    const zA = dir.clone().negate();
    const xA = new THREE.Vector3(0, 1, 0).cross(zA).normalize();
    const yA = zA.clone().cross(xA).normalize();
    const C = dir.clone().multiplyScalar(dist).addScaledVector(xA, cx).addScaledVector(yA, cy);
    const start = lobeData.length / 4;
    for (const c of L) lobeData.push(c.x - cx, c.y - cy, c.z, c.R);
    piles.push({ C, xA, yA, hw: (x1 - x0) / 2, hh: (y1 - y0) / 2, start, count: L.length, base: 0 - cy, H, key: dist });
  }
  function finishClouds() {
    piles.sort((p, q) => q.key - p.key);                 // far piles first (painter's order, no depth test)
    const n = piles.length;
    const C = new Float32Array(n * 3), X = new Float32Array(n * 3), Y = new Float32Array(n * 3);
    const Hf = new Float32Array(n * 2), Lb = new Float32Array(n * 2), M = new Float32Array(n * 2);
    piles.forEach((o, i) => {
      C.set(o.C.toArray(), i * 3); X.set(o.xA.toArray(), i * 3); Y.set(o.yA.toArray(), i * 3);
      Hf.set([o.hw, o.hh], i * 2); Lb.set([o.start, o.count], i * 2); M.set([o.base, o.H], i * 2);
    });
    const nL = lobeData.length / 4, TW = 256, TH = Math.ceil(nL / TW);
    const tex = new Float32Array(TW * TH * 4);
    tex.set(lobeData);
    const lt = new THREE.DataTexture(tex, TW, TH, THREE.RGBAFormat, THREE.FloatType);
    lt.minFilter = lt.magFilter = THREE.NearestFilter; lt.generateMipmaps = false; lt.needsUpdate = true;
    cloudMat.uniforms.tLobes.value = lt;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('aC', new THREE.InstancedBufferAttribute(C, 3));
    geo.setAttribute('aX', new THREE.InstancedBufferAttribute(X, 3));
    geo.setAttribute('aY', new THREE.InstancedBufferAttribute(Y, 3));
    geo.setAttribute('aHalf', new THREE.InstancedBufferAttribute(Hf, 2));
    geo.setAttribute('aLobe', new THREE.InstancedBufferAttribute(Lb, 2));
    geo.setAttribute('aMeta', new THREE.InstancedBufferAttribute(M, 2));
    geo.instanceCount = n;
    const mesh = new THREE.Mesh(geo, cloudMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;
    cloudGroup.add(mesh);
    console.info('sky: ' + n + ' cloud piles, ' + nL + ' lobes');
  }
  // keep clouds off the big planet's disc: re-roll candidates that would hide it
  const planetAz = Math.atan2(planetDir.x, -planetDir.z);
  const offPlanet = (az, el, margin) => {
    const d = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    return d.angleTo(planetDir) > margin;
  };
  const roll = (fn, margin) => { for (let t = 0; t < 12; t++) { const [az, el] = fn(); if (offPlanet(az, el, margin)) return [az, el]; } return null; };
  const rad = THREE.MathUtils.degToRad;
  // great horizon piles all round (the canyon rim hides the lowest few degrees, so they stand tall)
  const nBig = 20;
  for (let i = 0; i < nBig; i++) {
    const pick = roll(() => [(i / nBig) * Math.PI * 2 + (r() - 0.5) * 0.22, rad(2.5 + r() * 5)], PLANET_ANG + 0.10);
    if (pick) pile(pick[0], pick[1], 3200 + r() * 1200, 1500 + r() * 1500, 700 + r() * 700, 30 + Math.floor(r() * 14));
  }
  // medium piles higher up
  for (let i = 0; i < 12; i++) {
    const pick = roll(() => [(i / 12) * Math.PI * 2 + (r() - 0.5) * 0.5 + 0.2, rad(14 + r() * 16)], PLANET_ANG + 0.12);
    if (pick) pile(pick[0], pick[1], 3000 + r() * 1300, 560 + r() * 520, 230 + r() * 200, 16 + Math.floor(r() * 8));
  }
  // piles that veil the planet's lower limb / flank it
  pile(planetAz + rad(-6), rad(3.0), 3500, 2000, 900, 40);
  pile(planetAz + rad(36), rad(5.0), 3600, 1800, 800, 36);
  pile(planetAz - rad(46), rad(8.0), 3400, 1700, 760, 34);

  finishClouds();

  return {
    group: g,
    update(camPos) { g.position.copy(camPos); },
  };
}
