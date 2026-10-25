// Token Monitor: tokens dentro da caixa do agente (client/src/usage-view.js, funções puras). Sem React, servidor, banco ou CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, usageRecord } from '../usage.js';
import { DASH, fmtTokens, hasTotals, agentTokens } from '../../client/src/usage-view.js';

const tk = (input, output, cacheCreation, cacheRead) => ({ input, output, cacheCreation, cacheRead });
const rec = (snap, at = '2026-01-01T00:00:00.000Z') => usageRecord({ final: null, live: null, rateLimit: null, ...snap }, { ended: true, at });
const fin = (tokens, costUsd = null) => ({ tokens, tokensAllModels: null, costUsd, models: null });
const live = (tokens) => ({ provisional: true, messages: 1, unidentified: 0, tokens });
const task = (id, tokenUsage) => ({ id, tokenUsage });

test('formatação: ausente é "—", zero reportado continua 0, separador pt-BR', () => {
  for (const v of [null, undefined, NaN, '5', Infinity]) assert.equal(fmtTokens(v), DASH);
  assert.equal(fmtTokens(0), '0'); assert.equal(fmtTokens(1234), '1.234');
});

test('Executor: soma entrada + saída + cache da missão; final substitui o provisório (sem contar duas vezes)', () => {
  const m = (t) => [{ id: 'm1', tasks: t }];
  // execução em andamento: só o provisório do stream
  let u = summarizeUsage(m([task('a', rec({ live: live(tk(2, 1, 100, 50)) }))]));
  assert.deepEqual(agentTokens(u, 'm1', 'executor'), { text: '153', partial: true });
  // o result chega: o total final SUBSTITUI o provisório da mesma execução (mesmo registro tem final e live)
  u = summarizeUsage(m([task('a', rec({ live: live(tk(2, 1, 100, 50)), final: fin(tk(2, 9, 100, 200)) }))]));
  assert.deepEqual(agentTokens(u, 'm1', 'executor'), { text: '311', partial: false }, '2+9+100+200 e nada do live somado');
  // ocioso: o último total continua visível, e uma 2ª tarefa soma
  u = summarizeUsage(m([task('a', rec({ final: fin(tk(2, 9, 100, 200)) })), task('b', rec({ final: fin(tk(1, 1, 0, 0)) }))]));
  assert.deepEqual(agentTokens(u, 'm1', 'executor'), { text: '313', partial: false });
  // execução interrompida sem result: parcial permanece marcada
  u = summarizeUsage(m([task('a', rec({ final: fin(tk(1, 1, 0, 0)) })), task('b', rec({ live: live(tk(7, 1, 0, 70)) }))]));
  assert.deepEqual(agentTokens(u, 'm1', 'executor'), { text: '80', partial: true });
});

test('Planner: soma das chamadas da missão; cada chamada conta uma vez; separado do Executor e de outras missões', () => {
  const missions = [
    { id: 'm1', tasks: [task('a', rec({ final: fin(tk(5, 5, 0, 0)) }))], cycle: { id: 'c1', rounds: [], plannerUsage: [{ call: 1, ...rec({ final: fin(tk(10, 20, 30, 40)) }) }, { call: 2, ...rec({ final: fin(tk(1, 1, 1, 1)) }) }] } },
    { id: 'm2', tasks: [], cycle: { id: 'c2', rounds: [], plannerUsage: [{ call: 1, ...rec({ final: fin(tk(3, 3, 3, 3)) }) }] } },
  ];
  const u = summarizeUsage(missions);
  assert.deepEqual(agentTokens(u, 'm1', 'planner'), { text: '104', partial: false });
  assert.deepEqual(agentTokens(u, 'm1', 'executor'), { text: '10', partial: false });
  assert.deepEqual(agentTokens(u, 'm2', 'planner'), { text: '12', partial: false });
  assert.deepEqual(agentTokens(u, 'm2', 'executor'), { text: DASH, partial: false }, 'Executor sem dados na missão: —');
});

test('sem métricas: "—" (nunca 0) para missão sem dados, campos nunca reportados, sem missão e servidor antigo', () => {
  const u = summarizeUsage([{ id: 'm1', tasks: [task('a', rec({ final: fin(tk(null, null, null, null), 0.5) })), task('b', rec({ live: live(tk(null, null, null, null)) }))] }, { id: 'm3', tasks: [task('z', undefined)] }]);
  assert.deepEqual(agentTokens(u, 'm1', 'executor'), { text: DASH, partial: false }, 'só custo / tudo desconhecido');
  assert.deepEqual(agentTokens(u, 'm3', 'executor'), { text: DASH, partial: false });
  assert.deepEqual(agentTokens(u, 'inexistente', 'executor'), { text: DASH, partial: false });
  assert.deepEqual(agentTokens(u, undefined, 'executor'), { text: DASH, partial: false });
  for (const old of [null, undefined, {}, { costUsd: 1, runs: 1 }]) { assert.equal(hasTotals(old), false); assert.deepEqual(agentTokens(old, 'm1', 'executor'), { text: DASH, partial: false }); }
  // um campo conhecido entre desconhecidos: soma só o que foi reportado; 0 reportado é um número válido
  const some = summarizeUsage([{ id: 'm1', tasks: [task('a', rec({ final: fin(tk(null, 7, null, null)) })), task('b', rec({ final: fin(tk(0, 0, 0, 0)) }))] }]);
  assert.deepEqual(agentTokens(some, 'm1', 'executor'), { text: '7', partial: false });
  const zero = summarizeUsage([{ id: 'm1', tasks: [task('a', rec({ final: fin(tk(0, 0, 0, 0)) }))] }]);
  assert.deepEqual(agentTokens(zero, 'm1', 'executor'), { text: '0', partial: false }, '0 reportado pela CLI continua 0');
});
