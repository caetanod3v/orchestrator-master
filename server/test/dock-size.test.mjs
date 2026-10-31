// Item C: altura da conversa e divisor (client/src/dock-size.js). Funções puras, sem React nem DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCK, defaultDock, dockLimits, maxDock, clampDock, parseDock, nextDock } from '../../client/src/dock-size.js';

test('padrão: 36% da janela entre 280 e 420px (igual ao CSS de antes)', () => {
  assert.equal(defaultDock(900), 324);
  assert.equal(defaultDock(500), 280);
  assert.equal(defaultDock(2000), 420);
  assert.equal(defaultDock(NaN), 320);
});

test('limites com espaço: de min até o que deixa o mínimo ao grafo', () => {
  assert.deepEqual(dockLimits(700), { min: DOCK.min, max: 700 - DOCK.graphMin });
  assert.equal(maxDock(700), 700 - DOCK.graphMin);
  assert.deepEqual(dockLimits(400), { min: DOCK.min, max: DOCK.min }, 'cabem exatamente os dois mínimos');
  assert.deepEqual(dockLimits(undefined), { min: DOCK.min, max: DOCK.min });
});

test('janela baixa: o grafo tem prioridade; a conversa cede até o piso, depois o grafo cede até o seu piso; nada fica negativo', () => {
  const sum = (room) => { const l = dockLimits(room); return { ...l, graph: room - l.max }; };
  assert.equal(sum(399).max, 199); assert.equal(sum(399).graph, DOCK.graphMin, 'logo abaixo de 400: a conversa cede 1px por vez e o grafo mantém 200');
  assert.equal(sum(320).max, DOCK.panelFloor, 'com 320 a conversa chegou ao piso (120)');
  assert.equal(sum(291).max, DOCK.panelFloor); assert.equal(sum(291).graph, 171, '560px de janela: grafo com 171px (antes 91)');
  assert.equal(sum(320).graph, 200, 'com 320 o grafo ainda tem 200');
  assert.equal(sum(200).max, 120); assert.equal(sum(200).graph, DOCK.graphFloor, '420px de janela: grafo no piso de 80px (antes 0)');
  assert.equal(sum(150).max, 70); assert.equal(sum(150).graph, DOCK.graphFloor, 'abaixo do piso somado: a conversa cede de novo');
  for (const r of [0, 40, 80, 100, 119, 150, 199, 200, 250, 319, 320, 399, 400, 401, 900]) {
    const l = dockLimits(r); assert.ok(l.max >= 0 && l.min >= 0 && l.min <= l.max, 'valores válidos em room=' + r);
    assert.ok(r - l.max >= Math.min(r, DOCK.graphFloor) - 1e-9, 'o grafo nunca fica abaixo do piso (ou fica com todo o espaço) em room=' + r);
  }
  assert.deepEqual(dockLimits(-50), { min: 0, max: 0 }, 'espaço negativo: conversa 0, nunca negativa');
  const tight = dockLimits(250); assert.equal(tight.min, tight.max, 'modo apertado: o divisor não ajusta (min = max)');
});

test('janela baixa e volta: o valor efetivo é derivado; a preferência não entra nem é reescrita', () => {
  const pref = 360;
  const eff = (room) => { const l = dockLimits(room); return clampDock(pref, l.max, { ...DOCK, min: l.min }); };
  assert.equal(eff(700), 360); assert.equal(eff(291), 120); assert.equal(eff(700), 360, 'espaço de volta: restaura a preferência');
  assert.equal(pref, 360);
});

test('altura efetiva: sempre dentro de [mínimo, máximo]; preferência fora do intervalo é limitada sem ser reescrita', () => {
  assert.equal(clampDock(100, 500), DOCK.min);
  assert.equal(clampDock(900, 500), 500);
  assert.equal(clampDock(333.4, 500), 333);
  assert.equal(clampDock(400, 150), DOCK.min, 'máximo menor que o mínimo: vale o mínimo');
  assert.equal(clampDock(NaN, 500), DOCK.min);
});

test('valor salvo: corrompido, negativo, abaixo do mínimo ou absurdo vira null (usa o padrão)', () => {
  assert.equal(parseDock('340'), 340);
  assert.equal(parseDock('340.6'), 341);
  for (const bad of [null, undefined, '', 'abc', '-5', '0', '199', '99999', 'Infinity', 'NaN']) assert.equal(parseDock(bad), null, String(bad));
});

test('teclado: setas movem 24px (Shift 96), PageUp/Down 96, Home/End vão aos limites; subir o divisor aumenta a conversa', () => {
  const o = { max: 500 };
  assert.equal(nextDock(300, 'ArrowUp', o), 324);
  assert.equal(nextDock(300, 'ArrowDown', o), 276);
  assert.equal(nextDock(300, 'ArrowUp', { ...o, shift: true }), 396);
  assert.equal(nextDock(300, 'ArrowDown', { ...o, shift: true }), 204);
  assert.equal(nextDock(300, 'PageUp', o), 396);
  assert.equal(nextDock(300, 'PageDown', o), 204);
  assert.equal(nextDock(300, 'Home', o), DOCK.min);
  assert.equal(nextDock(300, 'End', o), 500);
});

test('teclado: nunca ultrapassa os limites e ignora teclas que não são do divisor', () => {
  assert.equal(nextDock(490, 'ArrowUp', { max: 500 }), 500);
  assert.equal(nextDock(210, 'ArrowDown', { max: 500 }), DOCK.min);
  assert.equal(nextDock(300, 'a', { max: 500 }), null);
  assert.equal(nextDock(300, 'Tab', { max: 500 }), null);
  assert.equal(nextDock(300, 'Enter', { max: 500 }), null, 'sem padrão informado, Enter não faz nada');
  assert.equal(nextDock(300, 'Enter', { max: 500, def: 324 }), 324);
  assert.equal(nextDock(300, 'Enter', { max: 250, def: 324 }), 250, 'o padrão também respeita o máximo');
});
