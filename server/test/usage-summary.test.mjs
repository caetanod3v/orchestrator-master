// Token Monitor, fase 3: agregação de task.tokenUsage + cycle.plannerUsage (função pura; nenhum servidor, banco, workspace ou CLI é usado).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeUsage, usageRecord } from '../usage.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const tk = (input, output, cacheCreation, cacheRead) => ({ input, output, cacheCreation, cacheRead });
const fin = (tokens, costUsd, all = null) => ({ tokens, tokensAllModels: all, costUsd, models: null });
const live = (tokens) => ({ provisional: true, messages: 1, unidentified: 0, tokens });
const rec = (snap, at = '2026-01-01T00:00:00.000Z') => usageRecord({ final: null, live: null, rateLimit: null, ...snap }, { ended: true, at });
const task = (id, tokenUsage, usage) => ({ id, status: 'completed', ...(tokenUsage !== undefined ? { tokenUsage } : {}), ...(usage ? { usage } : {}) });

function missions() {
  const c2plan = [
    { call: 1, ...rec({ final: fin(tk(10, 20, 30, 40), 0.1) }) },
    { call: 2, ...rec({ live: live(tk(1, 2, 3, 4)), rateLimit: { status: 'allowed_warning', utilization: 0.9, resetsAt: 200 } }, '2026-01-01T00:00:05.000Z') },
  ];
  const c2 = { id: 'c2', rounds: [{ taskId: 't1' }, { taskId: 't2' }], plannerUsage: c2plan };
  const c1 = { id: 'c1', rounds: [{ taskId: 't0' }], plannerUsage: [{ call: 1, ...rec({ final: fin(tk(100, 200, 300, 400), 0.5) }) }] };
  return [
    {
      id: 'm1', cycle: c2, pastCycles: [c1, { ...c2 }],                                  // o ciclo c2 também aparece em pastCycles (cópia): não pode contar de novo
      tasks: [
        task('t0', rec({ final: fin(tk(1000, 2000, 3000, 4000), 1.5, tk(1100, 2100, 3000, 4000)) }), { costUsd: 1.5, durationMs: 50, turns: 1 }),
        task('t1', rec({ final: fin(null, 0.25) }), { costUsd: 0.25, durationMs: 10, turns: 1 }),
        task('t2', rec({ live: live(tk(5, 6, null, 8)), rateLimit: { status: 'allowed', utilization: null, resetsAt: 100 } }, '2026-01-01T00:00:01.000Z')),
        task('t3', rec({ final: fin(tk(7, 7, 7, 7), null), live: live(tk(999, 999, 999, 999)) })),   // final E live da mesma execução: vale só o final
        task('t4', undefined, { costUsd: 0.75, durationMs: 100, turns: 1 }),                       // tarefa antiga: sem tokenUsage
      ],
    },
    { id: 'm2', cycle: null, tasks: [task('z', undefined)] },                                      // missão sem nenhum dado
  ];
}

test('agregação: total, por agente, missão e ciclo; final substitui live; sem dupla contagem; null preservado', () => {
  const u = summarizeUsage(missions());
  // legado intacto (task.usage das tarefas do Executor)
  close(u.costUsd, 2.5); assert.equal(u.runs, 3); assert.equal(u.durationMs, 160);

  const ex = u.byAgent.executor;     // t0 (soma de modelUsage), t1 (só custo), t2 (live), t3 (só o final)
  assert.deepEqual([ex.input, ex.output, ex.cacheCreation, ex.cacheRead], [1112, 2113, 3007, 4015]);
  close(ex.costUsd, 1.75); assert.deepEqual([ex.entries, ex.final, ex.provisional], [4, 3, 1]);

  const pl = u.byAgent.planner;      // c2: chamada 1 final + chamada 2 live; c1: chamada 1 final; a cópia de c2 não conta
  assert.deepEqual([pl.input, pl.output, pl.cacheCreation, pl.cacheRead], [111, 222, 333, 444]);
  close(pl.costUsd, 0.6); assert.deepEqual([pl.entries, pl.final, pl.provisional], [3, 2, 1]);

  assert.deepEqual([u.total.input, u.total.output, u.total.cacheCreation, u.total.cacheRead], [1223, 2335, 3340, 4459]);
  close(u.total.costUsd, 2.35); assert.deepEqual([u.total.entries, u.total.final, u.total.provisional], [7, 5, 2]);

  assert.deepEqual(u.byMission.map((m) => m.missionId), ['m1'], 'missão sem dados não aparece');
  assert.deepEqual(u.byMission[0].total, u.total);

  const byCycle = Object.fromEntries(u.byCycle.map((c) => [c.cycleId, c]));
  assert.deepEqual(Object.keys(byCycle).sort(), ['c1', 'c2']);
  assert.deepEqual([byCycle.c2.byAgent.executor.input, byCycle.c2.byAgent.executor.output, byCycle.c2.byAgent.executor.cacheCreation, byCycle.c2.byAgent.executor.cacheRead], [5, 6, null, 8], 'cacheCreation desconhecido continua null');
  close(byCycle.c2.byAgent.executor.costUsd, 0.25); assert.equal(byCycle.c2.byAgent.executor.entries, 2);
  assert.deepEqual([byCycle.c2.byAgent.planner.input, byCycle.c2.byAgent.planner.entries], [11, 2]);
  assert.deepEqual([byCycle.c1.byAgent.executor.input, byCycle.c1.byAgent.planner.input], [1100, 100]);
  assert.equal(byCycle.c1.total.entries, 2);
  const inCycles = u.byCycle.reduce((n, c) => n + c.total.entries, 0);
  assert.equal(inCycles, 6, 'a tarefa manual t3 (fora de qualquer rodada) conta na missão e no total, mas em nenhum ciclo');
});

test('limite fica separado do consumo; não há saldo nem limite inventados', () => {
  const u = summarizeUsage(missions());
  assert.deepEqual(u.rateLimit, { status: 'allowed_warning', utilization: 0.9, resetsAt: 200, agent: 'planner', missionId: 'm1', at: '2026-01-01T00:00:05.000Z' }, 'o indicador mais recente, de qualquer agente');
  assert.equal(u.limit, null); assert.equal(u.remaining, null);
  assert.ok(!JSON.stringify(u.total).includes('allowed'), 'o status do limite não entra nos totais');
});

test('ausência de dados: nada vira zero; só limite, só legado e registros antigos', () => {
  assert.equal(summarizeUsage([]), null);
  assert.equal(summarizeUsage(undefined), null);
  assert.equal(summarizeUsage([{ id: 'a', cycle: null, tasks: [task('x', undefined), { id: 'y', usage: null }] }]), null, 'tarefas antigas sem nenhum dado');

  const onlyLimit = summarizeUsage([{ id: 'a', tasks: [task('x', rec({ rateLimit: { status: 'allowed', utilization: null, resetsAt: 9 } }))] }]);
  assert.equal(onlyLimit.total.entries, 0); assert.equal(onlyLimit.total.input, null); assert.equal(onlyLimit.total.costUsd, null);
  assert.equal(onlyLimit.costUsd, null); assert.equal(onlyLimit.rateLimit.resetsAt, 9); assert.equal(onlyLimit.rateLimit.utilization, null);

  const legacy = summarizeUsage([{ id: 'a', tasks: [task('x', undefined, { costUsd: 0.5, durationMs: 4, turns: 1 })] }]);   // como antes: { costUsd, runs }
  close(legacy.costUsd, 0.5); assert.equal(legacy.runs, 1); assert.equal(legacy.total.entries, 0); assert.equal(legacy.total.output, null);

  const zero = summarizeUsage([{ id: 'a', tasks: [task('x', rec({ final: fin(tk(0, 0, 0, 0), 0) }))] }]);
  assert.deepEqual([zero.total.input, zero.total.costUsd, zero.total.entries], [0, 0, 1], '0 reportado pela CLI continua 0');
});

test('/api/state usa o resumo e mantém os campos existentes (verificação estática: o index.js não pode ser importado sem iniciar o servidor)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8');
  const handler = src.slice(src.indexOf("app.get('/api/state'"), src.indexOf('// ---------- Workspaces'));
  assert.ok(handler.includes('usage: summarizeUsage(visibleMissions(), db.chat)')); // M5: o 2º argumento é o consumo do chat ainda sem missão
  assert.ok(handler.includes('persistence: store.persistenceStatus()') && handler.includes('counts:') && handler.includes('activeWorkspace'));
});
