// Saturated blue sky dome, giant ringed planet, small moon and cel-shaded cumulus.
import * as THREE from 'three';
import { PAL, RAMP } from './materials.js';
import { rng } from './noise.js';

export const SUN_DIR = new THREE.Vector3(-0.78, 0.55, 0.1).normalize();
export const FOG_COLOR = new THREE.Color(0xa9c3f4);

export function createSky(scene) {
  const g = new THREE.Group();
  g.name = 'sky';
  scene.add(g);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(6000, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(PAL.skyTop) },
        mid: { value: new THREE.Color(PAL.skyMid) },
        hor: { value: FOG_COLOR },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 hor;
        void main(){
          float h = normalize(vP).y;
          vec3 c = mix(hor, mid, smoothstep(0.0, 0.28, h));
          c = mix(c, top, smoothstep(0.22, 0.85, h));
          c = mix(hor, c, smoothstep(-0.12, 0.02, h));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
  dome.renderOrder = -10;
  g.add(dome);

  // ringed planet (upper right, as in the concept)
  const planetDir = new THREE.Vector3(0.62, 0.42, -0.66).normalize();
  const planet = new THREE.Group();
  planet.position.copy(planetDir).multiplyScalar(4200);
  planet.lookAt(0, 0, 0);
  g.add(planet);
  const R = 1250;
  const pMat = new THREE.ShaderMaterial({
    fog: false, depthWrite: false,
    uniforms: { sun: { value: SUN_DIR.clone() } },
    vertexShader: 'varying vec3 vN; varying vec3 vO; void main(){ vO=position; vN=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `varying vec3 vN; varying vec3 vO; uniform vec3 sun;
      void main(){
        float l = dot(normalize(vN), normalize(vec3(-0.75,0.5,-0.2)));
        float band = 0.5 + 0.5*sin(vO.y*0.012 + sin(vO.x*0.004)*1.2);
        vec3 lit = mix(vec3(0.55,0.70,0.98), vec3(0.70,0.82,1.0), band*0.5);
        vec3 sh  = mix(vec3(0.26,0.38,0.78), vec3(0.32,0.45,0.84), band*0.5);
        float cel = smoothstep(-0.02, 0.06, l);
        // soft atmosphere rim
        float rim = pow(1.0 - abs(dot(normalize(vN), vec3(0.0,0.0,1.0))), 3.0);
        vec3 c = mix(sh, lit, cel) + rim*0.08;
        gl_FragColor = vec4(c,1.0);
        #include <colorspace_fragment>
      }`,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), pMat);
  planet.add(body);
  // rings: two thin translucent bands, tilted so they sweep across the sky
  const ringMat = new THREE.ShaderMaterial({
    fog: false, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vU; varying vec3 vP; void main(){ vU=uv; vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `varying vec2 vU; varying vec3 vP;
      void main(){
        float r = length(vP.xy);
        float t = (r - 1500.0) / 1350.0;
        float a = smoothstep(0.0,0.06,t) * (1.0 - smoothstep(0.82,1.0,t));
        a *= 0.55 + 0.45*step(0.5, fract(t*3.0+0.15));
        a *= 0.5;
        gl_FragColor = vec4(vec3(0.93,0.96,1.0), a);
        #include <colorspace_fragment>
      }`,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1500, 2850, 256, 1), ringMat);
  ring.rotation.set(1.2, 0.18, 0.5);
  planet.add(ring);

  // small moon
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(110, 48, 32),
    new THREE.MeshToonMaterial({ color: 0xe9efff, gradientMap: RAMP, fog: false, emissive: 0x6c86c8, emissiveIntensity: 0.55 }));
  moon.position.copy(new THREE.Vector3(0.12, 0.33, -0.93).normalize()).multiplyScalar(3900);
  g.add(moon);

  // cumulus: clustered spheres, cel lit so tops are white and bellies cool blue
  const cloudMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP, fog: false, emissive: 0x7f9fe0, emissiveIntensity: 0.35 });
  const r = rng(77);
  const clouds = new THREE.Group();
  const unit = new THREE.SphereGeometry(1, 28, 18);
  for (let i = 0; i < 34; i++) {
    const ang = r() * Math.PI * 2;
    const dist = 1500 + r() * 2200;
    const cl = new THREE.Group();
    const n = 5 + Math.floor(r() * 6);
    const base = 70 + r() * 90;
    for (let k = 0; k < n; k++) {
      const s = base * (0.5 + r() * 0.7) * (1 - Math.abs(k - n / 2) / n * 0.7);
      const m = new THREE.Mesh(unit, cloudMat);
      m.position.set((k - n / 2) * base * 0.8, s * 0.25 * r(), (r() - 0.5) * base * 0.6);
      m.scale.set(s, s * 0.78, s * 0.9);
      cl.add(m);
    }
    cl.position.set(Math.cos(ang) * dist, 160 + r() * 520, Math.sin(ang) * dist);
    cl.rotation.y = r() * 6;
    clouds.add(cl);
  }
  g.add(clouds);

  return {
    group: g,
    update(camPos) { g.position.copy(camPos); },
  };
}
