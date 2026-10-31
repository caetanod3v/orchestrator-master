// Distribuição DETERMINÍSTICA do campo estelar (função pura, sem Three.js nem DOM): mesma semente => mesmos buffers.
// Cada estrela é uma linha em três buffers compactos (nada de objeto por estrela):
//   pos  (x3): a, b, d0   — a e b são a posição lateral/vertical em unidades de (profundidade × tan(fov/2)); d0 é a profundidade inicial
//   look (x4): tamanho, brilho, fase e taxa da cintilação
//   misc (x4): multiplicador de deriva, matiz (0 quente .. 1 frio), início e fim da faixa de profundidade
import { UNIVERSE } from './config.js';

export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
// ruído de valor 2D barato e determinístico (grade de 16x16 com repetição) — dá "manchas" suaves de densidade
function makeNoise(rand) {
  const N = 16, g = Float32Array.from({ length: N * N }, () => rand());
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = smooth(x - xi), fy = smooth(y - yi);
    const at = (i, j) => g[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), fx), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), fx), fy);
  };
}

/** Gera `count` estrelas. Opções: seed, layers e designAspect vêm de UNIVERSE por padrão. */
export function generateStarfield(count, { seed = UNIVERSE.seed, layers = UNIVERSE.layers, designAspect = UNIVERSE.designAspect } = {}) {
  const n = Math.max(0, Math.floor(count));
  const pos = new Float32Array(n * 3), look = new Float32Array(n * 4), misc = new Float32Array(n * 4);
  const rand = mulberry32(seed), noise = makeNoise(rand);
  const [rate0, rate1] = UNIVERSE.twinkle.rate;
  // quantidade por faixa (a última absorve o arredondamento)
  const per = layers.map((l) => Math.floor(n * l.share)); per[per.length - 1] += n - per.reduce((a, b) => a + b, 0);
  let i = 0;
  layers.forEach((L, li) => {
    const anchors = []; // ~12% das estrelas nascem em pequenos grupos em torno de âncoras (aglomerados discretos)
    for (let k = 0; k < per[li]; k++, i++) {
      let a, b;
      if (anchors.length && rand() < 0.12) { // aglomerado
        const c = anchors[Math.floor(rand() * anchors.length)];
        a = c[0] + (rand() + rand() + rand() - 1.5) * 0.09 * designAspect; b = c[1] + (rand() + rand() + rand() - 1.5) * 0.09;
      } else { // densidade modulada por ruído suave (rejeição): há vazios e regiões mais densas
        for (let tries = 0; tries < 12; tries++) {
          a = (rand() * 2 - 1) * designAspect; b = rand() * 2 - 1;
          const dens = 0.35 + 0.65 * noise((a / designAspect + 1) * 2.2 + li * 3.7, (b + 1) * 2.8 + li * 1.3);
          if (rand() < dens) break;
        }
        if (anchors.length < 24 && rand() < 0.02) anchors.push([a, b]);
      }
      a = Math.max(-designAspect, Math.min(designAspect, a)); b = Math.max(-1, Math.min(1, b));
      const [d0, d1] = L.depth;
      pos[i * 3] = a; pos[i * 3 + 1] = b; pos[i * 3 + 2] = lerp(d0, d1, rand());
      // poucas estrelas fortes: o brilho e o tamanho seguem uma distribuição enviesada para baixo
      const s = rand() ** 2.4, br = rand() ** 2.0;
      look[i * 4] = lerp(L.size[0], L.size[1], s); look[i * 4 + 1] = lerp(L.bright[0], L.bright[1], br);
      look[i * 4 + 2] = rand() * Math.PI * 2; look[i * 4 + 3] = lerp(rate0, rate1, rand());
      misc[i * 4] = lerp(L.drift[0], L.drift[1], rand()); misc[i * 4 + 1] = rand() ** 1.6; misc[i * 4 + 2] = d0; misc[i * 4 + 3] = d1;
    }
  });
  return { count: n, pos, look, misc };
}
