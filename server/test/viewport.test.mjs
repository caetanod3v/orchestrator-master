// Canvas do Cockpit (client/src/viewport.js, funções puras): zoom no cursor, limites, enquadramento, centralização e navegação. Sem React, DOM, servidor ou banco.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ZOOM, clampZoom, zoomAt, wheelFactor, fitView, initialView, centerOn, isVisible, ensureVisible, panBy, stepZoom, toWorld, toScreen, sanitizeView, shouldAutoFrame, lerpView, easeOut } from '../../client/src/viewport.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const SIZE = { w: 800, h: 600 };

test('zoom positivo e negativo pela roda: sentido e magnitude', () => {
  assert.ok(wheelFactor({ deltaY: -100 }) > 1, 'roda para cima aproxima');
  assert.ok(wheelFactor({ deltaY: 100 }) < 1, 'roda para baixo afasta');
  near(wheelFactor({ deltaY: 100 }) * wheelFactor({ deltaY: -100 }), 1);
  assert.ok(wheelFactor({ deltaY: 100, deltaMode: 1 }) < wheelFactor({ deltaY: 100, deltaMode: 0 }) + 1e-12, 'linhas valem mais que pixels, mas o passo é limitado');
  assert.ok(wheelFactor({ deltaY: 1e6 }) > 0.8, 'um evento extremo não zera o zoom (passo limitado)');
  assert.ok(Math.abs(Math.log(wheelFactor({ deltaY: 3, ctrlKey: true }))) < Math.abs(Math.log(wheelFactor({ deltaY: 3 })) * 10), 'pinça: fator contínuo e pequeno');
});

test('zoom centrado no cursor: o ponto sob o cursor não se move', () => {
  const v = { x: 40, y: -20, k: 1 };
  for (const [px, py, f] of [[400, 300, 1.2], [0, 0, 1.5], [799, 10, 0.8], [123, 456, 2]]) {
    const before = toWorld(v, px, py);
    const n = zoomAt(v, f, px, py);
    const after = toScreen(n, before.x, before.y);
    near(after.x, px, 1e-6); near(after.y, py, 1e-6);
    near(n.k, clampZoom(v.k * f));
  }
});

test('limites mínimo e máximo: nunca ultrapassa e, no limite, a vista não se desloca', () => {
  let v = { x: 10, y: 10, k: 1 };
  for (let i = 0; i < 80; i++) v = zoomAt(v, 1.3, 300, 200);
  assert.equal(v.k, ZOOM.max);
  const atMax = zoomAt(v, 1.3, 500, 100);
  assert.deepEqual(atMax, v, 'já no máximo: nada muda (o cursor continua fixo)');
  for (let i = 0; i < 80; i++) v = zoomAt(v, 0.7, 300, 200);
  assert.equal(v.k, ZOOM.min);
  assert.equal(clampZoom(NaN > 0 ? 1 : 0), ZOOM.min);
  assert.equal(stepZoom({ x: 0, y: 0, k: ZOOM.max }, 1, SIZE).k, ZOOM.max);
});

test('passos dos botões: em torno do centro do viewport e reversíveis', () => {
  const v = { x: 0, y: 0, k: 1 };
  const c = toWorld(v, SIZE.w / 2, SIZE.h / 2);
  const up = stepZoom(v, 1, SIZE);
  near(up.k, ZOOM.step);
  const s = toScreen(up, c.x, c.y);
  near(s.x, SIZE.w / 2, 1e-6); near(s.y, SIZE.h / 2, 1e-6);
  near(stepZoom(up, -1, SIZE).k, 1);
});

test('ajustar à tela: usa os limites reais do conteúdo, centraliza e respeita o teto', () => {
  const big = fitView({ w: 2000, h: 1500 }, SIZE);
  assert.ok(big.k < 0.5 && big.k >= ZOOM.min);
  const c = toScreen(big, 1000, 750);
  near(c.x, SIZE.w / 2, 1e-6); near(c.y, SIZE.h / 2, 1e-6);
  assert.ok(isVisible({ x: 0, y: 0, w: 2000, h: 1500 }, SIZE, big), 'o grafo inteiro cabe');
  const small = fitView({ w: 100, h: 80 }, SIZE);
  assert.equal(small.k, ZOOM.fitMax, 'grafo pequeno amplia, mas não além do teto de enquadramento');
  assert.deepEqual(fitView({ w: 0, h: 0 }, SIZE), { x: 0, y: 0, k: 1 }, 'sem medidas: vista neutra');
  assert.ok(fitView({ w: 10000, h: 10000 }, SIZE).k === ZOOM.min, 'nunca abaixo do mínimo');
});

test('enquadramento inicial: grafo pequeno ocupa a área útil; grafo grande para no limite legível, alinhado ao topo', () => {
  const small = initialView({ w: 700, h: 500 }, SIZE);
  assert.ok(small.k >= 1 && small.k <= ZOOM.fitMax);
  const huge = initialView({ w: 1600, h: 6000 }, SIZE);
  assert.equal(huge.k, ZOOM.readable, 'não encolhe até ficar ilegível');
  assert.equal(huge.y, 16, 'começa pela raiz (topo)');
  const wide = initialView({ w: 3000, h: 6000 }, SIZE);
  assert.equal(wide.x, 16, 'mais largo que o viewport: começa à esquerda');
});

test('centralizar uma tarefa (e aproximar): o retângulo cai no centro do viewport', () => {
  const rect = { x: 900, y: 700, w: 300, h: 100 };
  const v = centerOn(rect, SIZE, { x: 0, y: 0, k: 0.5 }, 1.2);
  near(v.k, 1.2);
  const c = toScreen(v, rect.x + rect.w / 2, rect.y + rect.h / 2);
  near(c.x, SIZE.w / 2, 1e-6); near(c.y, SIZE.h / 2, 1e-6);
  assert.equal(centerOn(rect, SIZE, { x: 0, y: 0, k: 0.5 }).k, 0.5, 'sem zoom alvo, mantém o zoom atual');
  assert.equal(centerOn(rect, SIZE, { x: 0, y: 0, k: 1 }, 99).k, ZOOM.max, 'o zoom alvo também respeita o limite');
});

test('garantir visibilidade: só desloca o necessário e nunca muda o zoom', () => {
  const view = { x: 0, y: 0, k: 1 };
  const inside = { x: 100, y: 100, w: 200, h: 80 };
  assert.equal(ensureVisible(inside, SIZE, view), view, 'já visível: a mesma vista (sem salto)');
  const right = { x: 1000, y: 100, w: 200, h: 80 };
  const v = ensureVisible(right, SIZE, view);
  assert.equal(v.k, 1); assert.equal(v.y, 0, 'só o eixo necessário se move');
  assert.ok(isVisible(right, SIZE, v, 24));
  const tooBig = { x: 0, y: 0, w: 2000, h: 80 };
  const c = toScreen(ensureVisible(tooBig, SIZE, view), 1000, 40);
  near(c.x, SIZE.w / 2, 1e-6);
});

test('navegação por arraste e conversão de coordenadas', () => {
  const v = panBy({ x: 5, y: 6, k: 2 }, -30, 12);
  assert.deepEqual(v, { x: -25, y: 18, k: 2 });
  const w = toWorld(v, 100, 100);
  const s = toScreen(v, w.x, w.y);
  near(s.x, 100); near(s.y, 100);
  assert.deepEqual(lerpView({ x: 0, y: 0, k: 1 }, { x: 10, y: 20, k: 2 }, 0.5), { x: 5, y: 10, k: 1.5 });
  assert.equal(easeOut(0), 0); assert.equal(easeOut(1), 1); assert.ok(easeOut(0.5) > 0.5);
});

test('vista salva é validada; o enquadramento automático nunca sobrescreve a vista do usuário', () => {
  assert.equal(sanitizeView({ x: 'a', y: 0, k: 1 }), null);
  assert.equal(sanitizeView(null), null);
  assert.equal(sanitizeView({ x: 1, y: 2, k: Infinity }), null);
  assert.deepEqual(sanitizeView({ x: 1, y: 2, k: 99 }), { x: 1, y: 2, k: ZOOM.max });
  assert.equal(shouldAutoFrame({ touched: false }), true);
  assert.equal(shouldAutoFrame({ touched: true }), false, 'depois que o usuário mexe, mudanças de dados não reenquadram');
});
