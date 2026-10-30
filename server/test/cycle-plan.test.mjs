// M4: plano persistido de múltiplas etapas (execução sequencial). Banco TEMPORÁRIO, workspace TEMPORÁRIO, CLI FALSA, Planner e verificador SIMULADOS; nenhum modelo é chamado.
// Arquivo próprio (processo próprio): os últimos testes fazem save() lançar de verdade (EISDIR) e não podem colidir com gravações adiadas de outros arquivos.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-plan-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json'), BLOCK_TMP = `${DB_FILE}.tmp`; // diretório no lugar do .tmp => EISDIR (erro NÃO transitório)
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { validatePlanSteps, validateDecision, MAX_PLAN_STEPS } = await import('../cycle-schema.js');
const { planModeFromEnv, eligibleSteps, nextStep, planProblem, stepStatusFromRound } = await import('../plan.js');

let db, executor, startTaskRun, seq = 0, execStarts = 0, onStart = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(30); } return false; };
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  // conta as execuções realmente iniciadas
  const counted = new Proxy(executor, { get: (t, k) => (k === 'start' ? (o) => { execStarts++; onStart?.(); return t.start(o); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  ({ startTaskRun } = setupExecution(express(), { db, executor: counted }));
});
after(async () => { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

const step = (id, deps = [], mode = 'check') => ({ id, title: `Etapa ${id}`, instructions: `MODE:${mode} ${id}`, acceptance: ['out.txt existe com o conteúdo conferido'], dependsOn: deps });
const plan = (steps) => JSON.stringify({ decision: 'plan', rationale: 'dividir em etapas', steps });
const cont = (title) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:check ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blockedAns = () => JSON.stringify({ decision: 'blocked', rationale: 'preciso de ajuda', blockedReason: 'decisão humana' });
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
const scripted = (answers, { cost = 0.01, beforeAnswer = null } = {}) => {
  const calls = [];
  return { calls, answers, busy: () => false, cancel: async () => {},
    decide: async ({ prompt }) => { calls.push(prompt); beforeAnswer?.(calls.length); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x, usage: { costUsd: cost, turns: 1, metrics: metrics(cost) } }; } };
};
const verifier = (status = () => 'pass') => ({ isBusy: () => false, stop: async () => ({ stopped: false }),
  run: async (w, item) => { fs.rmSync(path.join(wsDir, 'out.txt'), { force: true }); /* a CLI falsa o recria: toda rodada deixa um arquivo novo (progresso), como num trabalho real */ const st = status(); return { id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status: st, exitCode: st === 'pass' ? 0 : 1, durationMs: 5, outputTail: '', truncated: false, reason: st === 'pass' ? null : 'Terminou com código 1.' }; } });
const lim = (calls = null, cost = null) => ({ maxPlannerCalls: calls, maxEstimatedCostUsd: cost });
const mkMission = () => { const m = { id: `p${++seq}`, demo: false, title: `Missão P${seq}`, objective: 'obj', workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
const mk = (planner, { limits = null, ver = verifier(), multiStep = true, persistRetryMs = [1] } = {}) => createCycle({ db, executor, planner, startTaskRun, verifier: ver, listFiles: () => ['config.json'], limits, multiStep, persistRetryMs });
async function run(answers, { max = 6, plannerOpts, ...opts } = {}) {
  const m = mkMission(), planner = scripted(answers, plannerOpts), cy = mk(planner, opts), s0 = execStarts;
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy, planner, answers, starts: () => execStarts - s0 };
}
const onDisk = (m) => JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === m.id);
const statuses = (c) => Object.fromEntries(c.plan.steps.map((s) => [s.id, s.status]));

// ---------- validação do plano ----------
test('validatePlanSteps: aceita planos válidos (inclusive em diamante) e rejeita estrutura, ids duplicados, dependências inexistentes, ciclos e plano sem etapa inicial', () => {
  const ok = validatePlanSteps([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])]);
  assert.ok(ok.ok); assert.deepEqual(ok.steps.map((s) => s.id), ['a', 'b', 'c', 'd']);
  assert.ok(validatePlanSteps([{ ...step('a'), dependsOn: undefined }]).ok, 'dependsOn ausente = sem dependências');
  const bad = (steps, re) => { const r = validatePlanSteps(steps); assert.equal(r.ok, false, JSON.stringify(steps).slice(0, 80)); assert.match(r.error, re); };
  bad('x', /deve ser uma lista/); bad([], /de 1 a \d+ etapas/); bad(Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => step(`s${i}`)), /de 1 a \d+ etapas/);
  bad([step('a'), step('a')], /id de etapa duplicado: "a"/);
  bad([step('a'), step('b', ['zzz'])], /depende de "zzz", que não existe/);
  bad([step('a'), step('b', ['b'])], /depende de si mesma/);
  bad([step('r'), step('a', ['b']), step('b', ['a'])], /dependências circulares entre as etapas: a, b/);
  bad([step('a', ['c']), step('b', ['a']), step('c', ['b'])], /nenhuma etapa pode começar/);
  bad([step('a'), step('b', ['a', 'a'])], /repete uma dependência/);
  bad([step('a'), { ...step('b'), dependsOn: 'a' }], /dependsOn deve ser uma lista/);
  bad([{ ...step('a'), permissions: ['Bash'] }], /chaves não permitidas em steps\[0\]: permissions/);
  bad([{ ...step('a'), id: 'a b' }], /\.id deve ser texto/); bad([{ ...step('a'), id: 7 }], /\.id deve ser texto/);
  bad([{ ...step('a'), title: '' }], /title" não pode ser vazio/); bad([{ ...step('a'), acceptance: [] }], /acceptance/);
  bad([{ ...step('a'), agent: 'root' }], /perfil conhecido/);
});

test('contrato do Planner: "plan" só existe com a opção ligada; desligada, o contrato é exatamente o de sempre', () => {
  const raw = plan([step('a')]);
  assert.match(validateDecision(raw).error, /chaves não permitidas: steps/); assert.match(validateDecision(JSON.stringify({ decision: 'plan', rationale: 'r' })).error, /"decision" deve ser continue \| complete \| blocked$/);
  const on = validateDecision(raw, { plan: true }); assert.ok(on.ok); assert.equal(on.value.decision, 'plan'); assert.equal(on.value.steps[0].id, 'a');
  assert.match(validateDecision(JSON.stringify({ decision: 'plan', rationale: 'r', steps: [step('a')], task: {} }), { plan: true }).error, /"plan" não aceita/);
  assert.match(validateDecision(JSON.stringify({ decision: 'plan', rationale: 'r' }), { plan: true }).error, /"steps" deve ser uma lista/);
  assert.match(validateDecision(JSON.stringify({ decision: 'complete', rationale: 'r', evidence: ['e'], steps: [step('a')] }), { plan: true }).error, /"complete" não aceita/);
  assert.deepEqual([false, false, true].map((_, i) => planModeFromEnv([{}, { ORCH_CYCLE_PLAN: ' OFF ' }, { ORCH_CYCLE_PLAN: 'on' }][i])), [false, false, true]);
  for (const v of ['1', 'true', 'sim', 'auto']) assert.throws(() => planModeFromEnv({ ORCH_CYCLE_PLAN: v }), /ORCH_CYCLE_PLAN/);
});

test('elegibilidade: só etapas sem rodada e com dependências concluídas; etapa pendente, falha ou interrupção bloqueiam as seguintes', () => {
  const rd = (n, stepId, over = {}) => ({ n, status: 'succeeded', verification: 'passed', phase: 'done', planId: 'pl', stepId, taskId: `t${n}`, ...over });
  const cyc = (rounds) => ({ plan: { id: 'pl', steps: [step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])] }, rounds });
  assert.deepEqual(eligibleSteps(cyc([])).map((s) => s.id), ['a'], 'só a raiz');
  assert.deepEqual(eligibleSteps(cyc([rd(1, 'a')])).map((s) => s.id), ['b', 'c']); assert.equal(nextStep(cyc([rd(1, 'a')])).id, 'b', 'sequencial: a primeira na ordem do plano');
  assert.deepEqual(eligibleSteps(cyc([rd(1, 'a'), rd(2, 'b')])).map((s) => s.id), ['c'], 'd espera c');
  assert.equal(nextStep(cyc([rd(1, 'a'), rd(2, 'b'), rd(3, 'c')])).id, 'd');
  assert.equal(nextStep(cyc([rd(1, 'a'), rd(2, 'b'), rd(3, 'c'), rd(4, 'd')])), null, 'tudo concluído: nada a executar');
  for (const bad of [{ status: 'failed' }, { status: 'interrupted' }, { verification: 'failed' }, { verification: 'blocked' }, { verification: 'skipped' }]) assert.deepEqual(eligibleSteps(cyc([rd(1, 'a', bad)])), [], `etapa ${JSON.stringify(bad)}: nada roda sozinho`);
  assert.deepEqual(eligibleSteps(cyc([rd(1, 'a', { status: 'running' })])), [], 'a rodada em andamento não libera ninguém');
  assert.equal(stepStatusFromRound(rd(1, 'a', { verification: undefined, phase: 'verifying' })), 'running', 'verificação em curso ainda não é concluída');
  assert.equal(stepStatusFromRound(rd(1, 'a', { verification: 'none' })), 'completed', 'sem verificações configuradas');
});

// ---------- fluxo de ponta a ponta ----------
test('plano de várias etapas: gravado ANTES da primeira execução, executado uma etapa por vez na ordem das dependências, sem consultar o Planner entre etapas', async () => {
  let atFirstStart = null; onStart = () => { atFirstStart ??= onDisk(m); };
  const m = mkMission(), planner = scripted([plan([step('s3', ['s2']), step('s2', ['s1']), step('s1'), step('s4', ['s1'])]), done()]), cy = mk(planner), s0 = execStarts;
  try { assert.equal((await cy.start(m.id, 6)).status, 202); await cy.idle(); } finally { onStart = null; }
  const c = m.cycle;
  assert.equal(c.status, 'completed', c.blockedReason); assert.equal(c.assurance, 'verified');
  assert.deepEqual(c.rounds.map((r) => r.stepId), ['s1', 's2', 's3', 's4'], 'dependências mandam, não a ordem em que o Planner listou'); assert.ok(c.rounds.every((r) => r.planId === c.plan.id));
  assert.equal(execStarts - s0, 4); assert.equal(planner.calls.length, 2, 'uma chamada para o plano e uma para concluir (não uma por etapa)'); assert.equal(c.plannerCalls, 2);
  assert.ok(atFirstStart, 'a CLI foi iniciada'); assert.equal(atFirstStart.cycle.plan.steps.length, 4, 'o plano já estava no disco quando a primeira execução começou');
  assert.deepEqual(atFirstStart.cycle.plan.steps.map((s) => s.status), ['queued', 'queued', 'running', 'queued'], 'só s1 (a raiz) tinha rodada gravada; as demais esperavam');
  assert.deepEqual(statuses(c), { s3: 'completed', s2: 'completed', s1: 'completed', s4: 'completed' }); assert.equal(c.plan.steps.find((s) => s.id === 's2').round, 2);
  const taskOf = (id) => m.tasks.find((t) => t.id === c.plan.steps.find((s) => s.id === id).taskId);
  assert.deepEqual(taskOf('s2').dependsOn, [taskOf('s1').id], 'a dependência vira dependência da tarefa (o Executor recebe o relatório dela)'); assert.deepEqual(taskOf('s1').dependsOn, []);
  assert.match(planner.calls[0], /"decision":"plan"/); assert.doesNotMatch(planner.calls[0], /PLANO ATUAL/);
  assert.match(planner.calls[1], /PLANO ATUAL .*4 de 4 etapas concluídas/); assert.match(planner.calls[1], /\[s3\] Etapa s3 \| estado: completed \(rodada 3\) \| depende de: s2/);
  const disk = onDisk(m); assert.equal(disk.cycle.status, 'completed'); assert.deepEqual(disk.cycle.plan.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed']);
  assert.ok(db.activity.some((a) => a.missionId === m.id && /Plano de 4 etapa\(s\) gravado/.test(a.message)));
});

test('compatibilidade: com a opção desligada o Planner não vê nem pode usar "plan"; com ela ligada o fluxo avulso (continue/complete) segue igual', async () => {
  const off = await run([plan([step('a')]), plan([step('a')]), blockedAns()], { multiStep: false });
  assert.equal(off.c.status, 'blocked'); assert.equal(off.c.blockedCode, 'planner_invalid'); assert.ok(!off.c.plan); assert.equal(off.starts(), 0);
  assert.match(off.c.rejections[0].problem, /chaves não permitidas: steps/); assert.doesNotMatch(off.planner.calls[0], /"decision":"plan"/);
  const legacy = await run([cont('A'), cont('B'), done()]);
  assert.equal(legacy.c.status, 'completed', legacy.c.blockedReason); assert.ok(!legacy.c.plan); assert.ok(legacy.c.rounds.every((r) => r.stepId === undefined && r.planId === undefined)); assert.equal(legacy.planner.calls.length, 3);
});

test('plano rejeitado pelo backend: dependência inexistente, ciclo e mais etapas que rodadas restantes voltam ao Planner como rejeição; nada é gravado nem executado', async () => {
  const r = await run([plan([step('a'), step('b', ['x'])]), plan([step('a'), step('b', ['c']), step('c', ['b'])]), blockedAns()], { max: 5 });
  assert.equal(r.c.blockedCode, 'planner_invalid'); assert.ok(!r.c.plan); assert.equal(r.starts(), 0); assert.match(r.c.rejections.at(-1).problem, /dependências circulares|nenhuma etapa pode começar/); assert.match(r.c.rejections[0].problem, /depende de "x", que não existe/);
  const big = await run([plan([step('a'), step('b'), step('c')]), plan([step('a'), step('b'), step('c')])], { max: 2 });
  assert.equal(big.c.blockedCode, 'planner_invalid'); assert.match(big.c.rejections[0].problem, /3 etapa\(s\), mas restam 2 rodada\(s\)/); assert.equal(big.starts(), 0);
});

test('etapa que falha ou não passa na verificação real: nenhuma outra roda sozinha, o Planner é consultado e "complete" não vale com etapas abertas', async () => {
  const f = await run([plan([step('a', [], 'fail'), step('b', ['a'])]), blockedAns()]);
  assert.deepEqual(statuses(f.c), { a: 'failed', b: 'queued' }); assert.equal(f.starts(), 1, 'b (dependente) não executou'); assert.equal(f.planner.calls.length, 2);
  assert.match(f.planner.calls[1], /\[a\] Etapa a \| estado: failed \(rodada 1\)/); assert.equal(f.c.blockedCode, 'planner_blocked');
  let n = 0; const v = await run([plan([step('a'), step('b', ['a'])]), blockedAns()], { ver: verifier(() => (++n === 1 ? 'fail' : 'pass')) });
  assert.equal(v.c.rounds[0].status, 'succeeded'); assert.equal(v.c.rounds[0].verification, 'failed'); assert.deepEqual(statuses(v.c), { a: 'failed', b: 'queued' }, 'execução ok, mas verificação real reprovada: não conta como concluída'); assert.equal(v.starts(), 1);
  const c = await run([plan([step('a', [], 'fail'), step('b', ['a'])]), cont('conserto avulso'), done(), blockedAns()]);
  assert.equal(c.c.rounds.length, 2); assert.equal(c.c.rounds[1].stepId, undefined, 'a tarefa avulsa continua possível'); assert.deepEqual(statuses(c.c), { a: 'failed', b: 'queued' });
  assert.match(c.c.rejections[0].problem, /"complete" rejeitado: o plano ainda tem etapas não concluídas \(a=failed, b=queued\)/); assert.notEqual(c.c.status, 'completed');
});

// ---------- limites, reinício, retomada e cancelamento ----------
test('limites do M3 valem dentro do plano: o orçamento bloqueia ANTES da etapa seguinte; reinício e retomada não repetem a etapa concluída', async () => {
  const r = await run([plan([step('s1'), step('s2', ['s1']), step('s3', ['s2'])]), done()], { limits: lim(null, 0.0125), plannerOpts: { cost: 0.011 } }); // 0,011 (plano) + 0,002 (s1) >= 0,0125
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'cost_budget_reached'); assert.deepEqual(statuses(r.c), { s1: 'completed', s2: 'queued', s3: 'queued' }); assert.equal(r.starts(), 1);
  const s1 = { taskId: r.c.plan.steps[0].taskId, round: JSON.stringify(r.c.rounds[0]) };
  assert.deepEqual(onDisk(r.m).cycle.plan.steps.map((s) => s.status), ['completed', 'queued', 'queued'], 'o estado do plano está no disco');
  const calls = r.planner.calls.length, starts = execStarts;
  const restarted = mk(r.planner, { limits: lim(null, 0.0125) }); restarted.recover(); await restarted.idle(); // "reinício": novo ciclo sobre o mesmo banco
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'cost_budget_reached', 'a pausa não virou ativa nem "restarted"'); assert.equal(execStarts, starts);
  const refused = await restarted.resume(r.m.id); assert.equal(refused.status, 409); assert.match(refused.error, /ESTIMADO/); assert.equal(execStarts, starts); assert.equal(r.planner.calls.length, calls);
  const raised = mk(r.planner, { limits: lim(null, 5) }); assert.equal((await raised.resume(r.m.id)).status, 202); await raised.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(execStarts - starts, 2, 'só s2 e s3 executaram'); assert.deepEqual(r.c.rounds.map((x) => x.stepId), ['s1', 's2', 's3']);
  assert.equal(r.c.plan.steps[0].taskId, s1.taskId); assert.equal(JSON.stringify(r.c.rounds[0]), s1.round, 's1 intacta'); assert.equal(r.planner.calls.length - calls, 1, 'só a chamada final de conclusão');
});

test('limite de chamadas ao Planner: o plano roda inteiro (sem consultar o Planner); a consulta final é que fica bloqueada, e a retomada exige o limite maior', async () => {
  const r = await run([plan([step('a'), step('b', ['a'])]), done()], { limits: lim(1) });
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'planner_call_cap'); assert.deepEqual(statuses(r.c), { a: 'completed', b: 'completed' }); assert.equal(r.planner.calls.length, 1);
  const starts = execStarts; assert.equal((await r.cy.resume(r.m.id)).status, 409);
  const raised = mk(r.planner, { limits: lim(5) }); assert.equal((await raised.resume(r.m.id)).status, 202); await raised.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(execStarts, starts, 'nada foi refeito');
});

test('limite de rodadas com etapas pendentes: limit_reached (M3) mantém o plano; retomar com novo limite continua na PRÓXIMA etapa, sem Planner e sem repetir', async () => {
  const r = await run([plan([step('a'), step('b', ['a']), step('c', ['b'])]), done()], { limits: lim(null, 0.0125), plannerOpts: { cost: 0.011 } }); // bloqueia depois da etapa a
  assert.deepEqual(statuses(r.c), { a: 'completed', b: 'queued', c: 'queued' });
  r.c.maxIterations = 1; // simula um teto menor que o plano (um plano novo nunca excede as rodadas restantes; isto cobre o plano gravado)
  const starts = execStarts, calls = r.planner.calls.length, raised = mk(r.planner, { limits: lim(null, 5) });
  assert.equal((await raised.resume(r.m.id)).status, 202); await raised.idle();
  assert.equal(r.c.status, 'limit_reached'); assert.equal(execStarts, starts, 'nada executou'); assert.equal(r.planner.calls.length, calls, 'o Planner não foi consultado'); assert.deepEqual(statuses(r.c), { a: 'completed', b: 'queued', c: 'queued' });
  assert.equal(onDisk(r.m).cycle.status, 'limit_reached');
  assert.equal((await raised.resume(r.m.id, { maxIterations: 3 })).status, 202); await raised.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.deepEqual(r.c.rounds.map((x) => x.stepId), ['a', 'b', 'c']); assert.equal(execStarts - starts, 2, 'só b e c'); assert.equal(r.planner.calls.length - calls, 1, 'só a conclusão');
});

test('recuperação após queda no meio de uma etapa: a etapa fica "interrupted", nada reexecuta sozinho e o Planner é consultado ao retomar', async () => {
  const t1 = { id: 'rt1', title: '[Rodada 1] Etapa a', status: 'running', authorized: true, authorizedBy: 'cycle', auto: true, dependsOn: [], report: '', files: [], log: [] };
  const m = { id: `p${++seq}`, demo: false, title: 'Queda', objective: 'o', workspaceId: 'ws', createdAt: 'T0', tasks: [t1] }; db.missions.push(m);
  m.cycle = { id: 'cyc_rt', status: 'running', maxIterations: 5, plannerCalls: 1, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null, finalSummary: null, evidence: null, cancelRequested: false, startedAt: 'T0', finishedAt: null,
    plan: { id: 'pl_rt', createdAt: 'T0', rationale: 'r', steps: [{ ...step('a'), status: 'running', round: 1, taskId: 'rt1' }, { ...step('b', ['a']), status: 'queued', round: null, taskId: null }] },
    rounds: [{ n: 1, status: 'running', taskId: 'rt1', planId: 'pl_rt', stepId: 'a', fingerprint: 'f', plan: { rationale: 'r', ...step('a') }, startedAt: 'T0', finishedAt: null, report: null, decision: null }] };
  const planner = scripted([blockedAns()]), cy = mk(planner), starts = execStarts;
  cy.recover(); await cy.idle();
  assert.equal(m.cycle.status, 'blocked'); assert.equal(m.cycle.blockedCode, 'restarted'); assert.deepEqual(statuses(m.cycle), { a: 'interrupted', b: 'queued' }); assert.equal(m.tasks[0].status, 'interrupted');
  assert.deepEqual(onDisk(m).cycle.plan.steps.map((s) => s.status), ['interrupted', 'queued']);
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.equal(execStarts, starts, 'a etapa interrompida não foi refeita automaticamente, nem a seguinte'); assert.equal(planner.calls.length, 1); assert.equal(m.cycle.blockedCode, 'planner_blocked');
  assert.match(planner.calls[0], /\[a\] Etapa a \| estado: interrupted/);
});

test('plano gravado inconsistente (dependência fora de ordem, ciclo, rodada de etapa inexistente): a retomada é recusada (409) sem mudar nada, sem executar nem consultar o Planner', async () => {
  const mkBroken = (steps, rounds) => {
    const m = { id: `p${++seq}`, demo: false, title: 'Inconsistente', objective: 'o', workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m);
    m.cycle = { id: `cyc${seq}`, status: 'blocked', maxIterations: 5, plannerCalls: 1, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [{ code: 'restarted', reason: 'x', at: 'T0' }], blockedCode: 'restarted', blockedReason: 'x', finalSummary: null, evidence: null, cancelRequested: false, startedAt: 'T0', finishedAt: null,
      plan: { id: 'pl_x', createdAt: 'T0', rationale: 'r', steps: steps.map((s) => ({ ...s, status: 'queued', round: null, taskId: null })) }, rounds };
    return m;
  };
  const rd = (n, stepId, over = {}) => ({ n, status: 'succeeded', verification: 'passed', phase: 'done', planId: 'pl_x', stepId, taskId: `tx${n}`, fingerprint: `f${n}`, plan: { rationale: 'r' }, report: { status: 'success', verifications: [] }, ...over });
  for (const [label, m, re] of [
    ['ciclo de dependências', mkBroken([step('a', ['b']), step('b', ['a']), step('c')], []), /plano gravado é inválido: dependências circulares/],
    ['etapa executada antes da dependência', mkBroken([step('a'), step('b', ['a'])], [rd(1, 'b')]), /"b" \(rodada 1\) foi executada sem a dependência "a" concluída/],
    ['rodada de etapa inexistente', mkBroken([step('a')], [rd(1, 'zzz')]), /aponta para a etapa "zzz", que não existe/],
    ['etapa executada duas vezes', mkBroken([step('a')], [rd(1, 'a'), rd(2, 'a')]), /mais de uma rodada/],
  ]) {
    const planner = scripted([done()]), cy = mk(planner), starts = execStarts;
    // M7: a retomada de um plano inconsistente é RECUSADA (409) antes de mudar qualquer coisa: o ciclo segue bloqueado, sem executar nem consultar o Planner (ver cycle-recovery.test.mjs)
    assert.match(planProblem(m.cycle), re, label); const before = JSON.stringify(m.cycle);
    const refused = await cy.resume(m.id); assert.equal(refused.status, 409, label); assert.match(refused.error, /Plano inconsistente/, label); assert.match(refused.error, re, label); await cy.idle();
    assert.equal(JSON.stringify(m.cycle), before, label); assert.equal(m.cycle.status, 'blocked', label);
    assert.equal(execStarts, starts, label); assert.equal(planner.calls.length, 0, label); assert.notEqual(m.cycle.status, 'completed');
  }
});

test('cancelamento durante uma etapa: ciclo cancelado, etapa "interrupted", as seguintes não executam e o plano não é retomável como terminal', async () => {
  const m = mkMission(), planner = scripted([plan([step('a', [], 'sleep'), step('b', ['a'])]), done()]), cy = mk(planner), s0 = execStarts;
  assert.equal((await cy.start(m.id, 5)).status, 202);
  assert.ok(await until(() => m.cycle.rounds[0]?.status === 'running' && executor.isBusy()), 'a etapa a começou');
  assert.equal((await cy.cancel(m.id)).status, 200); await cy.idle();
  assert.equal(m.cycle.status, 'cancelled'); assert.deepEqual(statuses(m.cycle), { a: 'interrupted', b: 'queued' }); assert.equal(execStarts - s0, 1);
  assert.equal((await cy.resume(m.id)).status, 409); assert.equal(onDisk(m).cycle.plan.steps[0].status, 'interrupted');
  assert.equal(executor.isBusy(), false);
});

// ---------- persistência (M2) ----------
test('persistência: se o plano não pode ser gravado, ele não existe nem é executado (rollback); depois de normalizar, a retomada o propõe de novo e segue', async () => {
  const m = mkMission(), origErr = console.error, s0 = execStarts;
  const planner = scripted([plan([step('a'), step('b', ['a'])]), plan([step('a'), step('b', ['a'])]), done()], { beforeAnswer: (n) => { if (n === 1) fs.mkdirSync(BLOCK_TMP); } }); // o disco "quebra" durante a consulta ao Planner
  const cy = mk(planner);
  try {
    console.error = () => {};
    assert.equal((await cy.start(m.id, 5)).status, 202); await cy.idle();
  } finally { console.error = origErr; fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
  const c = m.cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'persistence_failed'); assert.ok(!c.plan, 'o plano não gravado foi desfeito'); assert.ok(!c.planHistory); assert.equal(c.rounds.length, 0); assert.equal(execStarts, s0, 'nada foi executado a partir de um plano não gravado');
  assert.ok(!c.rounds.at(-1)?.decision); assert.ok(!db.activity.some((a) => a.missionId === m.id && /Plano de .* gravado/.test(a.message)));
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle(); // disco normalizado (M2): reconcilia e retoma
  assert.equal(c.status, 'completed', c.blockedReason); assert.deepEqual(c.rounds.map((r) => r.stepId), ['a', 'b']); assert.equal(onDisk(m).cycle.plan.steps.length, 2);
});

test('persistência: se o disco falha ao fechar uma etapa, a seguinte NÃO inicia; ao normalizar e retomar, só a VERIFICAÇÃO é refeita (mecanismo existente) e a execução de "a" nunca se repete', async () => {
  const m = mkMission(), origErr = console.error, s0 = execStarts;
  const planner = scripted([plan([step('a'), step('b', ['a']), step('c', ['b'])]), blockedAns()]);
  const base = verifier(); let broke = false;
  const ver = { ...base, run: async (w, item) => { const res = await base.run(w, item); if (!broke) { broke = true; fs.mkdirSync(BLOCK_TMP); } return res; } }; // o disco quebra quando a etapa "a" termina e vai ser fechada
  const cy = mk(planner, { ver });
  try {
    console.error = () => {};
    assert.equal((await cy.start(m.id, 6)).status, 202); await cy.idle();
  } finally { console.error = origErr; fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
  const c = m.cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'persistence_failed'); assert.equal(execStarts - s0, 1, 'só a etapa "a" iniciou'); assert.deepEqual(c.rounds.map((r) => r.stepId), ['a']);
  assert.deepEqual(statuses(c), { a: 'failed', b: 'queued', c: 'queued' }, 'a etapa cuja verificação não pôde ser gravada NÃO conta como concluída');
  assert.equal(planner.calls.length, 1); const taskA = c.rounds[0].taskId;
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle(); // disco normalizado (M2): reconcilia e retoma
  assert.deepEqual(c.rounds.map((r) => r.stepId), ['a', 'b', 'c'], 'cada etapa tem UMA rodada: "a" não foi executada de novo'); assert.equal(execStarts - s0, 3, 'o Executor rodou uma vez por etapa (a re-verificação não é uma execução)'); assert.equal(c.rounds[0].taskId, taskA);
  assert.ok(c.rounds[0].report.reverifiedAt, 'a verificação de "a" foi refeita antes de qualquer etapa seguinte'); assert.deepEqual(statuses(c), { a: 'completed', b: 'completed', c: 'completed' });
  assert.equal(planner.calls.length, 2, 'o Planner só foi consultado ao fim do plano'); assert.equal(c.blockedCode, 'planner_blocked'); assert.deepEqual(onDisk(m).cycle.plan.steps.map((x) => x.status), ['completed', 'completed', 'completed']);
});
