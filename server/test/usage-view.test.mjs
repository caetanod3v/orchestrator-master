// Token Monitor, fase 4: apresentação (client/src/usage-view.js, funções puras). Sem React, servidor, banco ou CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, usageRecord } from '../usage.js';
import { DASH, fmtTokens, fmtCost, hasTotals, stateOf, totalRows, missionRows, hudText, limitView, fmtReset } from '../../client/src/usage-view.js';

const tk = (input, output, cacheCreation, cacheRead) => ({ input, output, cacheCreation, cacheRead });
const rec = (snap) => usageRecord({ final: null, live: null, rateLimit: null, ...snap }, { ended: true, at: '2026-01-01T00:00:00.000Z' });
const usage = summarizeUsage([
  { id: 'm1', title: 'Missão 1', tasks: [{ id: 't1', tokenUsage: rec({ final: { tokens: tk(1500, 20, null, 0), tokensAllModels: null, costUsd: 0.5, models: null } }) }, { id: 't2', tokenUsage: rec({ live: { provisional: true, messages: 1, unidentified: 0, tokens: tk(2, 3, null, null) } }) }] },
  { id: 'm2', tasks: [{ id: 't3', tokenUsage: rec({ live: { provisional: true, messages: 1, unidentified: 0, tokens: tk(null, null, null, null) } }) }] },
]);

test('formatação: ausente é "—", zero reportado continua 0, custo marcado como estimativa', () => {
  assert.equal(fmtTokens(null), DASH); assert.equal(fmtTokens(undefined), DASH); assert.equal(fmtTokens(NaN), DASH); assert.equal(fmtTokens('5'), DASH);
  assert.equal(fmtTokens(0), '0'); assert.equal(fmtTokens(15280), '15.280');
  assert.equal(fmtCost(null), DASH); assert.equal(fmtCost(0), 'US$ 0.0000'); assert.equal(fmtCost(0.0626048), 'US$ 0.0626');
});

test('totais do /api/state.usage: linhas geral/Planner/Executor, estado final/provisório/misto e "—" para o que ninguém reportou', () => {
  const rows = totalRows(usage);
  assert.deepEqual(rows.map((r) => r.id), ['total', 'planner', 'executor']);
  const [total, planner, executor] = rows;
  assert.equal(planner.t.entries, 0); assert.equal(fmtTokens(planner.t.input), DASH, 'Planner sem dados: —, não 0');
  assert.deepEqual(stateOf(planner.t), { kind: 'none', label: DASH });
  assert.equal(fmtTokens(executor.t.input), '1.502'); assert.equal(fmtTokens(executor.t.cacheCreation), DASH, 'cache de criação nunca reportado'); assert.equal(fmtTokens(executor.t.cacheRead), '0', '0 reportado');
  assert.deepEqual(stateOf(total.t), { kind: 'mixed', label: '1 final · 2 prov.' });
  assert.equal(stateOf({ entries: 2, final: 2, provisional: 0 }).kind, 'final'); assert.equal(stateOf({ entries: 1, final: 0, provisional: 1 }).kind, 'provisional');
  assert.equal(hudText(usage), 'ent 1.502 · saí 23');
});

test('por missão: títulos das missões, fallback para o id e missão sem dados fora da lista', () => {
  const rows = missionRows(usage, [{ id: 'm1', title: 'Missão 1' }]);
  assert.deepEqual(rows.map((r) => [r.id, r.title]), [['m1', 'Missão 1'], ['m2', 'm2']]);
  assert.equal(fmtTokens(rows[1].total.input), DASH, 'missão só com métrica desconhecida: —');
  assert.deepEqual(stateOf(rows[1].total), { kind: 'provisional', label: 'provisório' });
});

test('compatibilidade: servidor antigo (só costUsd/runs), nulo e dados ausentes não quebram nem viram zero', () => {
  for (const u of [null, undefined, { costUsd: 1, runs: 1 }, {}]) {
    assert.equal(hasTotals(u), false); assert.deepEqual(totalRows(u), []); assert.deepEqual(missionRows(u, []), []); assert.equal(hudText(u), null);
  }
  assert.equal(hudText(summarizeUsage([{ id: 'a', tasks: [{ id: 'x', tokenUsage: rec({ final: { tokens: null, tokensAllModels: null, costUsd: 0.1, models: null } }) }] }])), null, 'só custo: sem resumo de tokens');
});

test('limite: indicador separado do consumo; sem saldo, unidade assumida nem valores inventados', () => {
  assert.equal(limitView(null), null);
  const v = limitView({ status: 'allowed_warning', utilization: 0.9, resetsAt: 1792922400, agent: 'planner' });
  assert.deepEqual([v.kind, v.status, v.utilization, v.agent], ['warn', 'aviso: perto do limite', '0.9', 'Planner']);
  assert.notEqual(v.resetsAt, DASH);
  const sem = limitView({ status: 'allowed', utilization: null, resetsAt: null, agent: 'executor' });
  assert.deepEqual([sem.kind, sem.utilization, sem.resetsAt], ['ok', DASH, DASH]);
  assert.equal(limitView({ status: 'novo_status_futuro' }).kind, 'unknown');
  assert.equal(limitView({}).status, DASH);
  assert.equal(fmtReset('x'), DASH); assert.equal(fmtReset(Infinity), DASH);
  assert.ok(!('remaining' in v) && !('limit' in v));
});
