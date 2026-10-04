// Seeded gradient noise (2D / 3D) + helpers. Deterministic so the world is identical every run.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeNoise(seed = 1) {
  const r = rng(seed);
  const p = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];

  const g2 = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;

  function n2(x, y) {
    const X = Math.floor(x), Y = Math.floor(y);
    const xf = x - X, yf = y - Y;
    const xi = X & 255, yi = Y & 255;
    const d = (h, dx, dy) => { const g = g2[h & 7]; return g[0] * dx + g[1] * dy; };
    const aa = p[p[xi] + yi], ba = p[p[xi + 1] + yi];
    const ab = p[p[xi] + yi + 1], bb = p[p[xi + 1] + yi + 1];
    const u = fade(xf), v = fade(yf);
    return lerp(
      lerp(d(aa, xf, yf), d(ba, xf - 1, yf), u),
      lerp(d(ab, xf, yf - 1), d(bb, xf - 1, yf - 1), u), v) * 0.9;
  }

  function n3(x, y, z) {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const xf = x - X, yf = y - Y, zf = z - Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const gr = (h, a, b, c) => {
      h &= 15;
      const u = h < 8 ? a : b;
      const v = h < 4 ? b : (h === 12 || h === 14 ? a : c);
      return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
    };
    const A = p[xi] + yi, AA = p[A] + zi, AB = p[A + 1] + zi;
    const B = p[xi + 1] + yi, BA = p[B] + zi, BB = p[B + 1] + zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    return lerp(
      lerp(lerp(gr(p[AA], xf, yf, zf), gr(p[BA], xf - 1, yf, zf), u),
        lerp(gr(p[AB], xf, yf - 1, zf), gr(p[BB], xf - 1, yf - 1, zf), u), v),
      lerp(lerp(gr(p[AA + 1], xf, yf, zf - 1), gr(p[BA + 1], xf - 1, yf, zf - 1), u),
        lerp(gr(p[AB + 1], xf, yf - 1, zf - 1), gr(p[BB + 1], xf - 1, yf - 1, zf - 1), u), v), w) * 0.95;
  }

  function fbm2(x, y, oct = 4, lac = 2, gain = 0.5) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) { s += n2(x * f, y * f) * a; n += a; a *= gain; f *= lac; }
    return s / n;
  }
  function fbm3(x, y, z, oct = 4, lac = 2, gain = 0.5) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) { s += n3(x * f, y * f, z * f) * a; n += a; a *= gain; f *= lac; }
    return s / n;
  }
  return { n2, n3, fbm2, fbm3 };
}

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
