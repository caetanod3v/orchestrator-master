// Universo espacial do Cockpit (client/src/universe/*): distribuição determinística do campo estelar e escolha de qualidade.
// Só as partes puras (sem Three.js, DOM nem WebGL): o renderer é validado no navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UNIVERSE, pickQuality } from '../../client/src/universe/config.js';
import { generateStarfield, mulberry32 } from '../../client/src/universe/starfield-data.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('config: pelo menos 3 faixas de profundidade distintas e sem sobreposição; participações somam 1', () => {
  const L = UNIVERSE.layers;
  assert.ok(L.length >= 3);
  assert.ok(Math.abs(sum(L.map((l) => l.share)) - 1) < 1e-9);
  const bands = [...L].sort((a, b) => a.depth[0] - b.depth[0]);
  for (let i = 1; i < bands.length; i++) assert.ok(bands[i - 1].depth[1] <= bands[i].depth[0], 'faixas não se sobrepõem');
  assert.ok(bands[0].depth[0] > UNIVERSE.near && bands.at(-1).depth[1] < UNIVERSE.far, 'tudo dentro do frustum');
  assert.ok(UNIVERSE.quality.high.count >= 5000, 'milhares de partículas no nível alto');
  assert.ok(UNIVERSE.quality.low.count >= 1000);
});

test('PRNG e campo estelar são determinísticos (mesma semente => mesmos buffers) e a semente importa', () => {
  const a = mulberry32(7), b = mulberry32(7); for (let i = 0; i < 20; i++) assert.equal(a(), b());
  const f1 = generateStarfield(2000), f2 = generateStarfield(2000), f3 = generateStarfield(2000, { seed: 99 });
  assert.deepEqual(Array.from(f1.pos.slice(0, 600)), Array.from(f2.pos.slice(0, 600)));
  assert.deepEqual(Array.from(f1.look), Array.from(f2.look));
  assert.notDeepEqual(Array.from(f1.pos.slice(0, 600)), Array.from(f3.pos.slice(0, 600)));
});

test('campo estelar: contagem exata, valores finitos e dentro dos limites; cada estrela pertence à sua faixa', () => {
  for (const n of [0, 1, 7, 1900, 6400]) {
    const f = generateStarfield(n);
    assert.equal(f.count, n); assert.equal(f.pos.length, n * 3); assert.equal(f.look.length, n * 4); assert.equal(f.misc.length, n * 4);
  }
  const f = generateStarfield(6400), A = UNIVERSE.designAspect;
  for (const arr of [f.pos, f.look, f.misc]) for (const v of arr) assert.ok(Number.isFinite(v));
  const perBand = new Map();
  for (let i = 0; i < f.count; i++) {
    const a = f.pos[i * 3], b = f.pos[i * 3 + 1], d = f.pos[i * 3 + 2], lo = f.misc[i * 4 + 2], hi = f.misc[i * 4 + 3];
    assert.ok(Math.abs(a) <= A && Math.abs(b) <= 1);
    assert.ok(d >= lo && d <= hi, 'profundidade inicial dentro da faixa');
    const size = f.look[i * 4], br = f.look[i * 4 + 1], tint = f.misc[i * 4 + 1];
    assert.ok(size > 0.3 && size < 3 && br > 0.1 && br <= 1 && tint >= 0 && tint <= 1);
    perBand.set(lo, (perBand.get(lo) || 0) + 1);
  }
  assert.equal(perBand.size, UNIVERSE.layers.length, 'as três faixas existem');
  for (const L of UNIVERSE.layers) assert.ok(Math.abs(perBand.get(L.depth[0]) / f.count - L.share) < 0.01, `participação da faixa ${L.id}`);
});

test('campo estelar: partículas distantes menores e mais discretas que as próximas; brilho enviesado para baixo', () => {
  const f = generateStarfield(6400), mean = (xs) => sum(xs) / xs.length;
  const by = {}; for (let i = 0; i < f.count; i++) (by[f.misc[i * 4 + 2]] ||= []).push(i);
  const keys = Object.keys(by).map(Number).sort((a, b) => a - b); // da mais próxima para a mais distante
  const sizeOf = (k) => mean(by[k].map((i) => f.look[i * 4])), brightOf = (k) => mean(by[k].map((i) => f.look[i * 4 + 1]));
  assert.ok(sizeOf(keys[0]) > sizeOf(keys[1]) && sizeOf(keys[1]) > sizeOf(keys[2]), 'tamanho cresce com a proximidade');
  assert.ok(brightOf(keys[0]) > brightOf(keys[2]));
  assert.ok(by[keys[0]].length < by[keys[2]].length, 'poucas estrelas próximas');
  const sizes = Array.from({ length: f.count }, (_, i) => f.look[i * 4]).sort((a, b) => a - b);
  assert.ok(sizes[Math.floor(f.count * 0.5)] < 1.1, 'a maioria é pequena');
});

test('campo estelar: distribuição irregular (aglomerados e vazios), não uma grade nem puro uniforme', () => {
  const f = generateStarfield(6400), G = 16, cells = new Array(G * G).fill(0);
  for (let i = 0; i < f.count; i++) { const gx = Math.min(G - 1, Math.floor(((f.pos[i * 3] / UNIVERSE.designAspect + 1) / 2) * G)), gy = Math.min(G - 1, Math.floor(((f.pos[i * 3 + 1] + 1) / 2) * G)); cells[gy * G + gx]++; }
  const m = sum(cells) / cells.length, variance = sum(cells.map((c) => (c - m) ** 2)) / cells.length;
  assert.ok(variance > m * 1.5, `mais dispersão que um processo uniforme de Poisson (var ${variance.toFixed(1)} vs média ${m.toFixed(1)})`);
  assert.ok(Math.min(...cells) < m * 0.6 && Math.max(...cells) > m * 1.4, 'há regiões rarefeitas e densas');
  const uniq = new Set(Array.from(f.pos.filter((_, i) => i % 3 === 2)).map((d) => d.toFixed(3))); assert.ok(uniq.size > 5000, 'profundidades quase todas distintas');
});

test('qualidade: substituição manual vence; software e dispositivos limitados caem de nível; padrão é alto', () => {
  assert.equal(pickQuality({}), 'high');
  assert.equal(pickQuality({ cores: 12, memory: 16, width: 1920 }), 'high');
  assert.equal(pickQuality({ override: 'off', cores: 12 }), 'off');
  assert.equal(pickQuality({ override: 'medium', softwareRenderer: true }), 'medium');
  assert.equal(pickQuality({ override: 'inválido', cores: 12 }), 'high');
  assert.equal(pickQuality({ softwareRenderer: true, cores: 16 }), 'low');
  assert.equal(pickQuality({ saveData: true }), 'low');
  assert.equal(pickQuality({ cores: 2 }), 'low');
  assert.equal(pickQuality({ cores: 4 }), 'medium');
  assert.equal(pickQuality({ cores: 8, memory: 8, width: 390 }), 'medium');
});
