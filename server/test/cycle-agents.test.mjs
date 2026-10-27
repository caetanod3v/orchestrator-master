// Perfis de agentes no ciclo: argumentos REAIS enviados à CLI (CLI falsa que devolve o argv), rejeição de perfis inválidos sem iniciar a CLI,
// persistência e compatibilidade. Banco TEMPORÁRIO, workspace TEMPORÁRIO, verificador SIMULADO. Nenhum modelo é chamado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agents-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE_ARGV = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-argv-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor, CLAUDE_ARGS } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { createRouter } = await import('../routing.js');
const { summarizeUsage } = await import('../usage.js');

const RUNNER_ARGS = ['--padrao-do-runner']; // o executor de teste tem argumentos próprios: só o perfil pode fazer a CLI receber CLAUDE_ARGS
let db, executor, startTaskRun, starts = 0, seq = 0;
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE_ARGV], args: RUNNER_ARGS });
  const counted = new Proxy(executor, { get: (t, k) => (k === 'start' ? (o) => { starts++; return t.start(o); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  ({ startTaskRun } = setupExecution(express(), { db, executor: counted }));
});
after(async () => { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

const task = (title, extra = {}) => ({ title, instructions: `faça ${title}`, acceptance: ['conferir'], ...extra });
const cont = (title, extra) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: task(title, extra) });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
const APPLIED = { lite: { tier: 'lite', model: 'claude-haiku-5-5', effort: 'low' }, standard: { tier: 'standard', model: null, effort: null } };
const scripted = (answers) => {
  const calls = [];
  return { calls, answers, busy: () => false, cancel: async () => {}, describeTier: (t) => APPLIED[t] ?? null,
    decide: async (a) => { calls.push({ tier: a.tier, keys: Object.keys(a).sort() }); const x = answers.shift(); const route = APPLIED[a.tier];
      return x === undefined ? { error: 'roteiro acabou' } : { text: x, usage: { costUsd: 0.01, turns: 1, metrics: metrics(0.01) }, ...(route ? { route } : {}) }; } };
};
const verifier = (status = 'pass') => ({ isBusy: () => false, stop: async () => ({ stopped: false }),
  run: async (w, item) => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : 1, durationMs: 5, outputTail: '', truncated: false, reason: status === 'pass' ? null : 'Terminou com código 1.' }) });
const mkMission = () => { const m = { id: `a${++seq}`, demo: false, title: `Missão A${seq}`, objective: 'objetivo', workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
const cycleOf = (m, planner, o = {}) => createCycle({ db, executor, planner, startTaskRun, verifier: o.ver ?? verifier(), listFiles: () => ['LEIAME.md'], router: o.router ?? null, limits: o.limits ?? null });
async function run(answers, o = {}) {
  const m = mkMission(), planner = scripted(answers), cy = cycleOf(m, planner, o), s0 = starts;
  assert.equal((await cy.start(m.id, o.max ?? 4)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy, planner, answers, starts: () => starts - s0 };
}
const argvOf = (t) => JSON.parse(t.report);

test('sem `agent` na resposta: a tarefa usa `code`, a CLI recebe exatamente CLAUDE_ARGS e task.agent/round.agent ficam gravados', async () => {
  const r = await run([cont('A'), done()]);
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.assurance, 'verified');
  assert.equal(r.m.tasks[0].agent, 'code'); assert.equal(r.c.rounds[0].agent, 'code'); assert.ok(!('agent' in r.c.rounds[0].plan), 'o plano guarda só o que o Planner enviou');
  assert.deepEqual(argvOf(r.m.tasks[0]), CLAUDE_ARGS, 'o perfil, não os argumentos do runner de teste, definiu a chamada');
  const saved = JSON.parse(JSON.stringify(r.m)); assert.equal(saved.tasks[0].agent, 'code'); assert.equal(saved.cycle.rounds[0].agent, 'code');
  assert.equal(store.validateDb({ ...structuredClone(db), missions: [saved] }), null);
});

test('`agent: "code"` explícito: mesmo resultado, e o plano registra o que o Planner pediu', async () => {
  const r = await run([cont('A', { agent: 'code' }), done()]);
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.rounds[0].plan.agent, 'code'); assert.equal(r.m.tasks[0].agent, 'code'); assert.deepEqual(argvOf(r.m.tasks[0]), CLAUDE_ARGS);
});

test('perfil desconhecido ou tipo inválido: rejeitado pelo mecanismo existente, a CLI NÃO inicia e a nova tentativa segue o fluxo de sempre', async () => {
  for (const agent of ['review', '__proto__', 'constructor', 'toString', 5, null, ['code'], '']) {
    const r = await run([cont('A', { agent }), cont('B'), done()]);
    assert.equal(r.c.status, 'completed', `${JSON.stringify(agent)}: ${r.c.blockedReason}`);
    assert.equal(r.c.rejections.length, 1); assert.match(r.c.rejections[0].problem, /^formato inválido: .*task\.agent/); assert.equal(r.c.plannerCalls, 3);
    assert.equal(r.starts(), 1, 'a CLI só iniciou para a tarefa válida'); assert.equal(r.c.rounds.length, 1); assert.equal(r.m.tasks.length, 1);
  }
  const r = await run([cont('A', { agent: 'review' }), cont('B', { agent: 'research' }), done()]);
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'planner_invalid'); assert.equal(r.starts(), 0); assert.equal(r.m.tasks.length, 0); assert.equal(r.c.rounds.length, 0);
  assert.equal(r.planner.calls.length, 2, 'duas tentativas, como sempre: nenhuma a mais');
});

test('defesa em profundidade: startTaskRun recusa uma tarefa com perfil inválido SEM iniciar a CLI nem tomar o lock', async () => {
  const m = mkMission(), s0 = starts;
  for (const [i, agent] of ['review', '__proto__', 'constructor', null, 7, {}].entries()) {
    const t = { id: `t${seq}_${i}`, title: 'x', status: 'queued', authorized: true, dependsOn: [], log: [], agent }; m.tasks.push(t);
    const res = await startTaskRun(m, t); assert.equal(res.ok, false, String(agent)); assert.match(res.reason, /Perfil de agente desconhecido/); assert.equal(t.status, 'queued');
  }
  assert.equal(starts, s0); assert.equal(executor.isBusy(), false);
});

test('tarefa MANUAL (sem `agent`) não muda: a CLI recebe os argumentos do próprio runner', async () => {
  const m = mkMission(), t = { id: 'tm', title: 'manual', status: 'queued', authorized: true, dependsOn: [], log: [], acceptance: [], instructions: 'x' }; m.tasks.push(t);
  const res = await startTaskRun(m, t); assert.equal(res.ok, true, res.reason); await res.finished;
  assert.deepEqual(argvOf(t), RUNNER_ARGS); assert.ok(!('agent' in t));
});

test('compatibilidade: ciclo/tarefas/rodadas ANTIGOS (sem `agent`) continuam válidos, retomam e entram no resumo de uso', async () => {
  const r = await run([JSON.stringify({ decision: 'blocked', rationale: 'x', blockedReason: 'preciso de um humano' })]);
  assert.equal(r.c.blockedCode, 'planner_blocked');
  r.answers.push(cont('A'), done()); await r.cy.resume(r.m.id); await r.cy.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason);
  const old = structuredClone(r.m); for (const t of old.tasks) delete t.agent; for (const x of old.cycle.rounds) delete x.agent; // como um banco anterior a esta mudança
  assert.equal(store.validateDb({ ...structuredClone(db), missions: [JSON.parse(JSON.stringify(old))] }), null);
  assert.deepEqual(summarizeUsage([old]), summarizeUsage([r.m]), 'o Token Monitor não depende de `agent`');
  const m2 = mkMission(); m2.tasks = old.tasks; m2.cycle = { ...old.cycle, status: 'blocked', blockedCode: 'planner_blocked', blockedReason: 'x', finishedAt: null, blocks: [], maxIterations: 4 };
  const cy2 = cycleOf(m2, scripted([cont('B2'), done()]));
  assert.equal((await cy2.resume(m2.id)).status, 202); await cy2.idle(); assert.equal(m2.cycle.status, 'completed', m2.cycle.blockedReason);
  assert.equal(m2.tasks.at(-1).agent, 'code', 'a rodada nova do ciclo antigo já nasce com o perfil');
});

test('mecanismos preservados com perfis: roteamento ligado, limite de chamadas, orçamento e "complete" com verificação reprovada', async () => {
  const on = await run([cont('A', { agent: 'code' }), done()], { router: createRouter() });
  assert.equal(on.c.status, 'completed', on.c.blockedReason); assert.ok(on.planner.calls.every((x) => x.keys.includes('tier'))); assert.deepEqual(argvOf(on.m.tasks[0]), CLAUDE_ARGS);
  const cap = await run([cont('A'), cont('B'), done()], { limits: { maxPlannerCalls: 1, maxEstimatedCostUsd: null } });
  assert.equal(cap.c.blockedCode, 'planner_call_cap'); assert.equal(cap.starts(), 1, 'nenhuma execução depois do bloqueio'); assert.equal((await cap.cy.resume(cap.m.id)).status, 409);
  const budget = await run([cont('A'), done()], { limits: { maxPlannerCalls: null, maxEstimatedCostUsd: 0.01 } });
  assert.equal(budget.c.blockedCode, 'cost_budget_reached'); assert.equal(budget.starts(), 0, 'o orçamento impede o Executor ANTES de iniciar');
  const bad = await run([cont('A'), done(), cont('B')], { ver: verifier('fail') });
  assert.notEqual(bad.c.status, 'completed'); assert.match(bad.c.rejections[0].problem, /verificações reais que não passaram/); assert.ok(!bad.c.assurance);
});
