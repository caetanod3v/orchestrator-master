// Formatação de tokens e custo dos panes (cliente, funções puras): ausente é "—", nunca zero; custo do squad só quando todos os panes têm custo.
import test from 'node:test';
import assert from 'node:assert/strict';
const V = await import('../../client/src/usage-view.js');

const u = (total, costUsd, extra = {}) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, turns: 1, model: 'm', costUsd, ...extra });

test('pane: sem uso = "—"; com uso mostra tokens, custo (ou "—") e detalhamento', () => {
  assert.deepEqual(V.paneUsage(null).tokens, '—'); assert.equal(V.paneUsage(null).cost, '—');
  const a = V.paneUsage(u(12345, 0.0123)); assert.equal(a.tokens, '12.345'); assert.match(a.cost, /US\$/); assert.match(a.title, /Entrada 12\.345/);
  assert.equal(V.paneUsage(u(5, null)).cost, '—');
  assert.equal(V.paneUsage(u(0, 0)).tokens, '0', 'zero real é zero');
});

test('squad: soma tokens; custo só se todos os panes com consumo têm custo; custo parcial nunca vira total', () => {
  assert.deepEqual(V.squadUsage([]), { tokens: '—', cost: '—', panes: 0, partialCost: false });
  assert.deepEqual(V.squadUsage([{ usage: null }, {}]).panes, 0);
  const all = V.squadUsage([{ usage: u(100, 0.01) }, { usage: u(200, 0.02) }, { usage: null }]); assert.equal(all.tokens, '300'); assert.equal(all.panes, 2); assert.match(all.cost, /0,03/); assert.equal(all.partialCost, false);
  const part = V.squadUsage([{ usage: u(100, 0.01) }, { usage: u(200, null) }]); assert.equal(part.tokens, '300'); assert.equal(part.cost, '—'); assert.equal(part.partialCost, true);
  assert.equal(V.squadUsage(undefined).panes, 0);
});
