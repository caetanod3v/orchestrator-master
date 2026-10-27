// Incremento D: limite de chamadas ao Planner e orçamento de custo ESTIMADO por ciclo. Banco TEMPORÁRIO, workspace TEMPORÁRIO, CLI FALSA, verificador SIMULADO.
// Nenhum modelo é chamado. O custo usado é o das métricas sintéticas (Planner 0.01 por chamada; Executor 0.002 por rodada, vindo da CLI falsa).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-limits-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { createRouter } = await import('../routing.js');
const { cycleLimitsFromEnv, cycleSpend, limitProblem, LIMIT_ENV } = await import('../limits.js');
const { summarizeUsage } = await import('../usage.js');

let db, executor, startTaskRun, seq = 0, execStarts = 0;
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  // Conta as execuções realmente iniciadas (prova que nenhuma começa depois de um bloqueio); o Executor em si não é alterado.
  const counted = new Proxy(executor, { get: (t, k) => (k === 'start' ? (o) => { execStarts++; return t.start(o); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  ({ startTaskRun } = setupExecution(express(), { db, executor: counted }));
});
after(async () => { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

const SIMPLE = 'No arquivo config.json, alterar o valor de timeoutMs de 1000 para 5000, sem modificar nenhuma outra chave. Critério de aceitação: a verificação obrigatória npm test passa.';
const cont = (title) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:check ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
const APPLIED = { lite: { tier: 'lite', model: 'claude-haiku-5-5', effort: 'low' }, standard: { tier: 'standard', model: null, effort: null } };
/** Planner simulado: `cost` = custo estimado por chamada; null = a CLI reportou métricas SEM custo; 'none' = nenhuma métrica. */
const scripted = (answers, { cost = 0.01 } = {}) => {
  const calls = [];
  return { calls, answers, busy: () => false, cancel: async () => {}, describeTier: (t) => APPLIED[t] ?? null,
    decide: async (a) => { calls.push({ tier: a.tier, keys: Object.keys(a).sort() }); const x = answers.shift(); const route = APPLIED[a.tier];
      if (x === undefined) return { error: 'roteiro acabou', ...(route ? { route } : {}) };
      return { text: x, usage: cost === 'none' ? { costUsd: null, turns: 1 } : { costUsd: cost, turns: 1, metrics: metrics(cost) }, ...(route ? { route } : {}) }; } };
};
const verifier = (status = 'pass') => ({ isBusy: () => false, stop: async () => ({ stopped: false }),
  run: async (w, item) => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : 1, durationMs: 5, outputTail: '', truncated: false, reason: status === 'pass' ? null : 'Terminou com código 1.' }) });
const mkMission = () => { const m = { id: `d${++seq}`, demo: false, title: `Missão D${seq}`, objective: SIMPLE, workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
const cycleOf = (m, planner, { limits = null, router = null, ver = verifier() } = {}) => createCycle({ db, executor, planner, startTaskRun, verifier: ver, listFiles: () => ['config.json'], router, limits });
async function run(answers, { limits = null, router = null, ver, max = 5, plannerOpts } = {}) {
  fs.rmSync(path.join(wsDir, 'out.txt'), { force: true });
  const m = mkMission(), planner = scripted(answers, plannerOpts), cy = cycleOf(m, planner, { limits, router, ver }), s0 = execStarts;
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy, planner, answers, starts: () => execStarts - s0 };
}
const lim = (calls = null, cost = null) => ({ maxPlannerCalls: calls, maxEstimatedCostUsd: cost });
const shape = (r) => ({ s: r.c.status, code: r.c.blockedCode, calls: r.c.plannerCalls, rej: r.c.rejections.length, rounds: r.c.rounds.length });

// ---------- configuração ----------
test('configuração: ausente, vazia e off = desativado (padrão); valores válidos são lidos', () => {
  for (const env of [{}, { [LIMIT_ENV.calls]: '', [LIMIT_ENV.cost]: '  ' }, { [LIMIT_ENV.calls]: 'off', [LIMIT_ENV.cost]: 'OFF' }]) assert.deepEqual(cycleLimitsFromEnv(env), lim());
  assert.deepEqual(cycleLimitsFromEnv({ [LIMIT_ENV.calls]: '1', [LIMIT_ENV.cost]: '0.000001' }), lim(1, 0.000001));
  assert.deepEqual(cycleLimitsFromEnv({ [LIMIT_ENV.calls]: ' 1000 ', [LIMIT_ENV.cost]: '2.50' }), lim(1000, 2.5));
  assert.deepEqual(cycleLimitsFromEnv({ [LIMIT_ENV.cost]: '100000' }), lim(null, 100000));
});

test('configuração inválida lança Error citando a variável (o servidor não sobe em vez de ignorar)', () => {
  for (const v of ['0', '-1', '1.5', '1001', 'abc', '1e3', '0x10', '10000', 'on', 'true']) assert.throws(() => cycleLimitsFromEnv({ [LIMIT_ENV.calls]: v }), new RegExp(LIMIT_ENV.calls), `calls=${v}`);
  for (const v of ['0', '0.0', '-1', '1e2', 'NaN', 'Infinity', '100000.01', '1.1234567', 'abc', '$2', '2,5', 'on']) assert.throws(() => cycleLimitsFromEnv({ [LIMIT_ENV.cost]: v }), new RegExp(LIMIT_ENV.cost), `cost=${v}`);
});

// ---------- limites desativados ----------
test('limites DESATIVADOS (sem objeto, nulls ou env vazio): comportamento anterior, inclusive com métricas ausentes ou sem custo', async () => {
  const base = await run([cont('A'), cont('B'), done()]);
  assert.equal(base.c.status, 'completed', base.c.blockedReason); assert.equal(base.c.assurance, 'verified');
  for (const limits of [lim(), cycleLimitsFromEnv({})]) { const r = await run([cont('A'), cont('B'), done()], { limits }); assert.deepEqual(shape(r), shape(base)); assert.deepEqual(r.planner.calls.map((x) => x.keys), base.planner.calls.map((x) => x.keys)); }
  for (const cost of [null, 'none']) { const r = await run([cont('A'), done()], { limits: lim(), plannerOpts: { cost } }); assert.equal(r.c.status, 'completed', `cost=${cost}`); }
});

// ---------- orçamento de custo ----------
test('o custo vem dos registros do Token Monitor, sem dupla contagem: bate com o resumo de uso do ciclo', async () => {
  const r = await run([cont('A'), cont('B'), done()], { limits: lim(null, 100) });
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  const s = cycleSpend(r.m);
  assert.ok(Math.abs(s.knownUsd - (3 * 0.01 + 2 * 0.002)) < 1e-9, `conhecido ${s.knownUsd}`); assert.deepEqual([s.plannerCalls, s.plannerUnknown, s.executorCalls, s.executorUnknown], [3, 0, 2, 0]);
  const sum = summarizeUsage([r.m]).byCycle.find((x) => x.cycleId === r.c.id);
  assert.ok(Math.abs(sum.total.costUsd - s.knownUsd) < 1e-9, 'mesmo total que o resumo do Token Monitor');
});

test('orçamento ABAIXO do limite: o ciclo segue e conclui normalmente (verificação real exigida como sempre)', async () => {
  const r = await run([cont('A'), done()], { limits: lim(null, 1) });
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.assurance, 'verified'); assert.equal(r.c.rounds[0].verification, 'passed');
});

test('orçamento EXATAMENTE no limite: a próxima chamada (Planner) não é iniciada; ligeiramente acima, é', async () => {
  const exact = await run([cont('A'), done()], { limits: lim(null, 0.012) }); // Planner 0.01 + Executor 0.002 = 0.012
  assert.equal(exact.c.status, 'blocked'); assert.equal(exact.c.blockedCode, 'cost_budget_reached'); assert.equal(exact.planner.calls.length, 1, 'a 2ª chamada ao Planner nem começou');
  assert.equal(exact.c.plannerCalls, 1); assert.equal(exact.c.rounds.length, 1); assert.notEqual(exact.c.status, 'completed'); assert.ok(!exact.c.finalSummary); assert.ok(!exact.c.assurance);
  const above = await run([cont('A'), done()], { limits: lim(null, 0.0121) });
  assert.equal(above.c.status, 'completed', above.c.blockedReason); assert.equal(above.planner.calls.length, 2);
});

test('orçamento ACIMA do limite no meio do ciclo: bloqueia ANTES de iniciar o Executor (nenhuma rodada nem processo novo)', async () => {
  const r = await run([cont('A'), done()], { limits: lim(null, 0.01) }); // o Planner sozinho já esgota
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'cost_budget_reached'); assert.equal(r.c.rounds.length, 0); assert.equal(r.m.tasks.length, 0); assert.equal(r.starts(), 0);
  assert.match(r.c.blockedReason, /ESTIMADO/); assert.match(r.c.blockedReason, /estimativa da CLI/); assert.match(r.c.blockedReason, /não .* cobrança real/);
  assert.equal(r.c.blocks.at(-1).code, 'cost_budget_reached'); assert.equal(r.planner.calls.length, 1);
});

test('custo DESCONHECIDO nunca vira zero: com o orçamento ativo, a chamada seguinte é impedida e o motivo é explícito', async () => {
  for (const cost of [null, 'none']) {
    const r = await run([cont('A'), done()], { limits: lim(null, 100), plannerOpts: { cost } }); // orçamento enorme: só a falta de custo pode bloquear
    assert.equal(r.c.status, 'blocked', `cost=${cost}`); assert.equal(r.c.blockedCode, 'cost_budget_unknown'); assert.match(r.c.blockedReason, /sem custo estimado reportado/); assert.match(r.c.blockedReason, /Planner: 1/);
    assert.equal(r.starts(), 0, 'o Executor não foi iniciado'); assert.equal(r.planner.calls.length, 1);
  }
  const off = await run([cont('A'), done()], { limits: lim(), plannerOpts: { cost: 'none' } });
  assert.equal(off.c.status, 'completed', 'sem orçamento ativo, o comportamento anterior é mantido');
});

test('cycleSpend: sem dupla contagem e sem custo inventado (dados sintéticos)', () => {
  const fin = (cost) => ({ basis: 'final', final: { tokens: { input: 1 }, tokensAllModels: { input: 1 }, costUsd: cost }, live: null });
  const live = { basis: 'live', final: null, live: { tokens: { input: 5, output: 5 } } };
  const m = { id: 'x', cycle: { id: 'c1', plannerCalls: 4, plannerUsage: [{ call: 1, ...fin(0.1) }, { call: 1, ...fin(0.1) }, { call: 2, ...live }, { call: 3, ...fin(null) }], rounds: [{ taskId: 't1' }, { taskId: 't2' }, { taskId: 't3' }, { taskId: 't4' }] },
    pastCycles: [{ id: 'old', plannerCalls: 1, plannerUsage: [{ call: 1, ...fin(50) }], rounds: [] }],
    tasks: [{ id: 't1', startedAt: 'T', usage: { costUsd: 0.5 }, tokenUsage: fin(0.5) }, { id: 't2', startedAt: 'T', tokenUsage: live }, { id: 't3', startedAt: 'T', tokenUsage: null }, { id: 't4', usage: null, tokenUsage: null }] }; // t4 nunca iniciou
  const s = cycleSpend(m);
  assert.equal(s.knownUsd, 0.6, 'planner call 1 uma vez (duplicata ignorada) + task t1 uma vez (usage legado não soma); ciclo antigo e live não contam');
  assert.deepEqual([s.plannerCalls, s.plannerUnknown, s.executorCalls, s.executorUnknown], [4, 3, 3, 2]);
  assert.equal(limitProblem(lim(null, 100), m, 'planner').code, 'cost_budget_unknown');
  assert.equal(limitProblem(lim(null, 0.6), m, 'executor').code, 'cost_budget_reached', 'alcançado tem precedência sobre desconhecido');
  assert.equal(limitProblem(lim(), m, 'planner'), null); assert.equal(limitProblem(null, m, 'planner'), null);
});

// ---------- limite de chamadas ao Planner ----------
test('limite de chamadas ao Planner: a chamada seguinte não inicia a CLI; o limite exato ainda permite concluir', async () => {
  const r = await run([cont('A'), cont('B'), done()], { limits: lim(2) });
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'planner_call_cap'); assert.equal(r.planner.calls.length, 2, 'só 2 invocações reais'); assert.equal(r.c.plannerCalls, 2);
  assert.equal(r.answers.length, 1, 'a 3ª resposta nunca foi pedida'); assert.equal(r.c.rounds.length, 2); assert.match(r.c.blockedReason, /ORCH_CYCLE_MAX_PLANNER_CALLS/);
  const exact = await run([cont('A'), done()], { limits: lim(2) });
  assert.equal(exact.c.status, 'completed', exact.c.blockedReason); assert.equal(exact.planner.calls.length, 2);
});

test('o limite conta INVOCAÇÕES reais: a nova tentativa após resposta inválida conta; rodadas e execuções do Executor não', async () => {
  const retry = await run(['lixo', cont('A'), done()], { limits: lim(1) });
  assert.equal(retry.c.status, 'blocked'); assert.equal(retry.c.blockedCode, 'planner_call_cap', 'não vira planner_invalid: a 2ª tentativa foi impedida antes da CLI');
  assert.equal(retry.planner.calls.length, 1); assert.equal(retry.c.rejections.length, 1);
  const many = await run([cont('A'), cont('B'), done()], { limits: lim(3) }); // 2 execuções do Executor + 3 chamadas ao Planner = 5 chamadas de LLM, mas só 3 contam
  assert.equal(many.c.status, 'completed', many.c.blockedReason); assert.equal(many.c.rounds.length, 2); assert.equal(many.planner.calls.length, 3);
});

test('o limite configurado não amplia nem substitui o limite existente de rodadas e consultas', async () => {
  const off = await run([cont('A'), cont('B'), cont('C'), cont('D')], { max: 2 }), on = await run([cont('A'), cont('B'), cont('C'), cont('D')], { max: 2, limits: lim(1000, 100000) });
  assert.deepEqual(shape(on), shape(off)); assert.equal(on.c.status, 'limit_reached');
});

// ---------- persistência e retomada ----------
test('retomar NÃO contorna o limite de chamadas: recusa 409 sem mutar nada nem iniciar a CLI; com o limite aumentado (reinício) retoma e conclui', async () => {
  const r = await run([cont('A'), cont('B'), done()], { limits: lim(2) });
  assert.equal(r.c.blockedCode, 'planner_call_cap');
  assert.equal(JSON.parse(JSON.stringify(r.m.cycle)).blockedCode, 'planner_call_cap', 'o motivo sobrevive à serialização (persistência)');
  const before_ = JSON.stringify(r.c), calls = r.planner.calls.length, starts = execStarts;
  const refused = await r.cy.resume(r.m.id, { note: 'tentando de novo' });
  assert.equal(refused.status, 409); assert.match(refused.error, /Limite de 2 chamada/); assert.equal(JSON.stringify(r.c), before_, 'nada mudou'); await r.cy.idle();
  assert.equal(r.planner.calls.length, calls); assert.equal(execStarts, starts);
  const again = cycleOf(r.m, r.planner, { limits: lim(2) }); assert.equal((await again.resume(r.m.id)).status, 409, 'um novo createCycle com o mesmo limite também recusa (estado vem do banco)');
  r.answers.push(done());
  const raised = cycleOf(r.m, r.planner, { limits: lim(3) });
  assert.equal((await raised.resume(r.m.id)).status, 202); await raised.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.plannerCalls, 3, 'o contador é cumulativo: não foi zerado');
});

test('retomar NÃO contorna o orçamento de custo: recusa enquanto atingido ou desconhecido; com orçamento maior retoma', async () => {
  const r = await run([cont('A'), done()], { limits: lim(null, 0.012) });
  assert.equal(r.c.blockedCode, 'cost_budget_reached');
  const before_ = JSON.stringify(r.c), calls = r.planner.calls.length;
  assert.equal((await r.cy.resume(r.m.id)).status, 409); assert.equal(JSON.stringify(r.c), before_); assert.equal(r.planner.calls.length, calls);
  const raised = cycleOf(r.m, r.planner, { limits: lim(null, 1) }); assert.equal((await raised.resume(r.m.id)).status, 202); await raised.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.assurance, 'verified');
  const u = await run([cont('A'), done()], { limits: lim(null, 100), plannerOpts: { cost: 'none' } });
  assert.equal(u.c.blockedCode, 'cost_budget_unknown'); assert.equal((await u.cy.resume(u.m.id)).status, 409, 'custo desconhecido não some ao retomar'); assert.equal(u.planner.calls.length, 1);
});

test('sem limites ativos, a retomada é a de sempre (bloqueios comuns retomam)', async () => {
  const r = await run([JSON.stringify({ decision: 'blocked', rationale: 'x', blockedReason: 'preciso de um humano' }), cont('A'), done()], { limits: lim() });
  assert.equal(r.c.blockedCode, 'planner_blocked'); assert.equal((await r.cy.resume(r.m.id)).status, 202); await r.cy.idle(); assert.equal(r.c.status, 'completed', r.c.blockedReason);
});

// ---------- compatibilidade com o roteamento ----------
test('independente do roteamento: mesmos bloqueios com roteador ligado e desligado; sem roteador nenhuma camada é enviada', async () => {
  for (const limits of [lim(2), lim(null, 0.012)]) {
    const off = await run([cont('A'), cont('B'), done()], { limits, router: null }), on = await run([cont('A'), cont('B'), done()], { limits, router: createRouter() });
    assert.deepEqual(shape(on), shape(off)); assert.equal(on.c.blockedCode, off.c.blockedCode); assert.ok(['planner_call_cap', 'cost_budget_reached'].includes(off.c.blockedCode));
    assert.equal(on.planner.calls.length, off.planner.calls.length);
    for (const x of off.planner.calls) assert.ok(!x.keys.includes('tier')); assert.ok(!('routing' in off.c));
    for (const x of on.planner.calls) assert.ok(x.keys.includes('tier'));
  }
});

// ---------- verificação e conclusão preservadas ----------
test('conclusão e verificação independente preservadas com limites ativos: "complete" com verificação reprovada continua rejeitado', async () => {
  const r = await run([cont('A'), done(), cont('B')], { limits: lim(3, 100), ver: verifier('fail') });
  assert.notEqual(r.c.status, 'completed'); assert.match(r.c.rejections[0].problem, /"complete" rejeitado: verificações reais que não passaram/); assert.ok(!r.c.assurance);
  const base = await run([cont('A'), done(), cont('B')], { ver: verifier('fail') });
  assert.deepEqual(r.c.rejections.map((x) => x.problem), base.c.rejections.map((x) => x.problem));
});

test('atingir um limite nunca conclui o ciclo: o bloqueio é distinto de "completed" e deixa um registro explícito na atividade', async () => {
  const r = await run([cont('A'), done()], { limits: lim(1) });
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'planner_call_cap'); assert.ok(!r.c.finishedAt); assert.ok(!r.c.finalSummary); assert.ok(!r.c.assurance);
  assert.ok(db.activity.some((a) => a.missionId === r.m.id && /Ciclo bloqueado \(planner_call_cap\)/.test(a.message)));
});
