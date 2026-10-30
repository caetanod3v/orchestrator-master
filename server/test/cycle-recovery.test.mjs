// M7: retomada confiável da execução. Cada cenário parte de um banco GRAVADO no disco (como o servidor o deixa ao cair) e percorre a sequência real do boot:
// store.load -> setupExecution (processos órfãos, tarefas "running") -> cycle.recover; depois a retomada humana (resume) com o fluxo de execução existente.
// Banco TEMPORÁRIO, workspace TEMPORÁRIO, CLI FALSA, Planner e verificador SIMULADOS; os únicos processos criados são filhos `node -e` deste teste. Nenhum modelo é chamado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-recovery-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json'), BLOCK_TMP = `${DB_FILE}.tmp`; // diretório no lugar do .tmp => EISDIR (erro NÃO transitório)
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { syncPlan, planProblem } = await import('../plan.js');
const { DEFAULT_AGENT } = await import('../agents.js');
const { killTreeSync } = await import('../orphans.js');
const { pidAlive } = await import('../instance-lock.js');

let db, executor, startTaskRun, execStarts = 0, verifierRuns = 0, seq = 0;
const spawned = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(() => { db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }, { id: 'ws0', name: 'ws0', path: wsDir }]; store.saveOrThrow(); });
after(async () => { for (const pid of spawned) killTreeSync(pid); fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

/** Filho controlado pelo teste (fica vivo até ser encerrado): o "processo anterior" de uma execução interrompida. */
function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  spawned.add(child.pid); return { pid: child.pid, startedAt: new Date().toISOString(), exited: new Promise((r) => child.on('exit', r)) };
}

/** Sequência do boot de verdade, sobre o que está NO DISCO: o banco é relido, o executor é novo e o setupExecution trata as tarefas e os processos órfãos. */
function boot({ orphanTools } = {}) {
  db = store.load();
  const real = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [], orphanTools });
  executor = new Proxy(real, { get: (t, k) => (k === 'start' ? (o) => { execStarts++; return t.start(o); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  ({ startTaskRun } = setupExecution(express(), { db, executor, orphanTools }));
}
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
const scripted = (answers, { cost = 0.01, onCall = null } = {}) => {
  const calls = [];
  return { calls, busy: () => false, cancel: async () => {},
    decide: async ({ prompt }) => { calls.push(prompt); onCall?.(calls.length); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x, usage: { costUsd: cost, turns: 1, metrics: metrics(cost) } }; } };
};
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }),
  run: async (w, item) => { verifierRuns++; fs.rmSync(path.join(wsDir, 'out.txt'), { force: true }); return { id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null }; } });
const mk = (planner, { limits = null, multiStep = true } = {}) => createCycle({ db, executor, planner, startTaskRun, verifier: verifier(), listFiles: () => ['config.json'], limits, multiStep, persistRetryMs: [1] });
/** Banco relido + ciclo recuperado, como num boot. */
function restart(planner, opts = {}) { boot(opts); const cy = mk(planner, opts); cy.recover(); return cy; }

const step = (id, deps = []) => ({ id, title: `Etapa ${id}`, instructions: `MODE:check ${id}`, acceptance: ['out.txt existe com o conteúdo conferido'], dependsOn: deps });
const cont = (title) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:check ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blockedAns = () => JSON.stringify({ decision: 'blocked', rationale: 'preciso de ajuda', blockedReason: 'decisão humana' });

// ---- fixtures: o que o servidor deixa no disco ----
const REAL_PASS = { id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null };
const report = (over = {}) => ({ status: 'success', summary: 'ok', filesChanged: [{ path: 'out.txt', status: 'A', added: 1, removed: 0, preexisting: false }], filesKnown: true, checks: [{ name: 'x', result: 'pass', detail: '' }], checksReported: true, errors: [], blockers: [], exitCode: 0, usage: null, verifications: [REAL_PASS], verificationsSkipped: null, verificationsInterrupted: null, ...over });
const task = (id, status, over = {}) => ({ id, title: `[Rodada] ${id}`, status, authorized: false, authorizedBy: 'cycle', auto: true, instructions: 'MODE:check', acceptance: ['conferir'], dependsOn: [], report: status === 'completed' ? 'Relatório.\n```json\n{"summary":"ok","checks":[{"name":"x","result":"pass","detail":""}]}\n```' : '', files: [], log: [], agent: DEFAULT_AGENT,
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: status === 'running' ? null : '2026-01-01T00:01:00.000Z', exitCode: status === 'completed' ? 0 : null, error: null, ...over });
const round = (n, stepId, taskId, over = {}) => ({ n, status: 'succeeded', taskId, fingerprint: `f${n}`, agent: DEFAULT_AGENT, plan: { rationale: 'r', title: `Etapa ${stepId}`, instructions: `MODE:check ${stepId}`, acceptance: ['conferir'] }, planId: 'pl', stepId, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', report: report(), verification: 'passed', phase: 'done', decision: null, ...over });
const runningRound = (n, stepId, taskId) => round(n, stepId, taskId, { status: 'running', finishedAt: null, report: null, verification: undefined, phase: undefined });
/** Missão com ciclo gravado no disco. `steps` ausente = ciclo sem plano (modo legado). */
function seed({ status = 'running', steps, rounds, tasks, ws = 'ws', cycle = {} }) {
  const id = `r${++seq}`, m = { id, demo: false, title: id, objective: 'obj', workspaceId: ws, createdAt: 'T0', tasks };
  m.cycle = { id: `cyc_${id}`, status, maxIterations: 6, plannerCalls: 1, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null, finalSummary: null, evidence: null, cancelRequested: false, startedAt: 'T0', finishedAt: null, rounds,
    ...(steps ? { plan: { id: 'pl', createdAt: 'T0', rationale: 'r', steps: steps.map((s) => ({ ...s, status: 'queued', round: null, taskId: null })) } } : {}), ...cycle };
  if (steps) syncPlan(m.cycle);
  db.missions.push(m); store.saveOrThrow(); return m;
}
const live = (id) => db.missions.find((x) => x.id === id);
const onDisk = (id) => JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === id);
const statuses = (c) => Object.fromEntries(c.plan.steps.map((s) => [s.id, s.status]));
const snap = (c) => JSON.stringify(c);
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

// ---------- 1, 2, 3, 5, 11: queda no meio de um plano ----------
test('queda no meio de uma etapa: concluídas e suas evidências intactas, a interrompida fica com resultado INCERTO, nada é refeito e só o Planner é consultado (uma vez)', async () => {
  const ta = task('ta', 'completed'), tb = task('tb', 'running', { pid: 999999 });
  const ra = round(1, 'a', 'ta'), rb = runningRound(2, 'b', 'tb');
  const m = seed({ steps: [step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])], rounds: [ra, rb], tasks: [ta, tb] });
  const ra0 = JSON.stringify(ra), starts = execStarts, planner = scripted([blockedAns()]);
  const cy = restart(planner), c = live(m.id).cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'restarted'); assert.deepEqual(statuses(c), { a: 'completed', b: 'interrupted', c: 'queued', d: 'queued' });
  assert.equal(JSON.stringify(c.rounds[0]), ra0, 'a etapa concluída e a evidência dela não foram tocadas');
  assert.equal(c.rounds[1].status, 'interrupted'); assert.equal(c.rounds[1].report.status, 'interrupted');
  assert.equal(c.rounds[1].report.filesKnown, false, 'sem relatório final não dá para afirmar que nenhum arquivo mudou'); assert.match(c.rounds[1].report.outcomeUncertain, /efeitos.*desconhecid|desconhecid.*efeitos/i);
  assert.equal(c.plan.steps.find((s) => s.id === 'b').uncertain, true); assert.ok(!c.plan.steps.find((s) => s.id === 'a').uncertain);
  assert.match(c.blockedReason, /concluídas: a/); assert.match(c.blockedReason, /incerto.*: b/i); assert.match(c.blockedReason, /na fila: c, d/);
  assert.deepEqual(onDisk(m.id).cycle.plan.steps.map((s) => s.status), ['completed', 'interrupted', 'queued', 'queued'], 'o estado recuperado está no disco');
  assert.equal(execStarts, starts, 'recuperar não executa nada');
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.equal(execStarts, starts, 'a etapa interrompida não foi refeita e c/d não rodaram "por cima" dela'); assert.equal(planner.calls.length, 1, 'sem etapa elegível segura: exatamente uma consulta ao Planner');
  assert.match(planner.calls[0], /\[b\] Etapa b \| estado: interrupted/); assert.match(planner.calls[0], /RESULTADO INCERTO/); assert.match(planner.calls[0], /arquivos alterados: desconhecido/);
  assert.equal(c.blockedCode, 'planner_blocked'); assert.equal(c.plannerCalls, 2); assert.equal(c.rounds.length, 2);
});

test('queda entre etapas (nada em andamento): a retomada segue pela próxima etapa elegível, na ordem das dependências, SEM consultar o Planner e sem repetir a concluída', async () => {
  const ta = task('ta', 'completed'), ra = round(1, 'a', 'ta');
  const m = seed({ steps: [step('d', ['b', 'c']), step('b', ['a']), step('a'), step('c', ['a'])], rounds: [ra], tasks: [ta] });
  const ra0 = JSON.stringify(ra), starts = execStarts, v0 = verifierRuns, planner = scripted([done()]);
  const cy = restart(planner), c = live(m.id).cycle;
  assert.equal(c.blockedCode, 'restarted'); assert.deepEqual(statuses(c), { d: 'queued', b: 'queued', a: 'completed', c: 'queued' }); assert.ok(!c.plan.steps.some((s) => s.uncertain), 'nada incerto: só faltava começar');
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.deepEqual(c.rounds.map((r) => r.stepId), ['a', 'b', 'c', 'd'], 'dependências mandam: b e c depois de a; d depois de b e c'); assert.equal(execStarts - starts, 3, 'só b, c e d executaram'); assert.equal(verifierRuns - v0, 3);
  assert.equal(JSON.stringify(c.rounds[0]), ra0, 'a etapa concluída é a mesma, byte a byte'); assert.equal(c.plan.steps.find((s) => s.id === 'a').taskId, 'ta');
  assert.equal(planner.calls.length, 1, 'o Planner só foi consultado ao fim do plano'); assert.equal(c.status, 'completed', c.blockedReason); assert.equal(c.plannerCalls, 2);
});

test('dependências: com uma etapa interrompida nada que dependa dela (nem etapa independente) roda sozinho; plano gravado com etapa executada antes da dependência é bloqueado', async () => {
  const ta = task('ta', 'completed'), tb = task('tb', 'interrupted');
  const m = seed({ status: 'blocked', cycle: { blockedCode: 'restarted', blockedReason: 'x' }, steps: [step('a'), step('b', ['a']), step('c', ['b']), step('e')], rounds: [round(1, 'a', 'ta'), round(2, 'b', 'tb', { status: 'interrupted', verification: 'skipped', report: report({ status: 'interrupted', verifications: [] }) })], tasks: [ta, tb] });
  const starts = execStarts, planner = scripted([blockedAns()]), cy = restart(planner), c = live(m.id).cycle;
  assert.deepEqual(statuses(c), { a: 'completed', b: 'interrupted', c: 'queued', e: 'queued' });
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle(); assert.equal(execStarts, starts, 'nem "c" (depende de b) nem "e" (independente) rodaram'); assert.equal(planner.calls.length, 1);
  const t1 = task('t1', 'completed'), t2 = task('t2', 'completed');
  const bad = seed({ steps: [step('a'), step('b', ['a'])], rounds: [round(1, 'b', 't1'), round(2, 'a', 't2')], tasks: [t1, t2] });
  const cy2 = restart(scripted([done()])); const bc = live(bad.id).cycle;
  assert.equal(bc.blockedCode, 'plan_invalid'); assert.match(bc.blockedReason, /"b" \(rodada 1\) foi executada sem a dependência "a" concluída/); assert.equal(execStarts, starts);
  const refused = await cy2.resume(bad.id); assert.equal(refused.status, 409); assert.match(refused.error, /Plano inconsistente/); assert.equal(execStarts, starts);
});

// ---------- 10: o efeito aconteceu, o resultado não foi persistido ----------
test('o Executor TERMINOU (tarefa gravada como concluída) mas a rodada não foi atualizada: o resultado é aproveitado, só a verificação real é refeita e a execução NUNCA se repete', async () => {
  const ta = task('ta', 'completed'), ra = runningRound(1, 'a', 'ta');
  const m = seed({ steps: [step('a'), step('b', ['a'])], rounds: [ra], tasks: [ta] });
  const starts = execStarts, v0 = verifierRuns, planner = scripted([done()]);
  const cy = restart(planner), c = live(m.id).cycle, r = c.rounds[0];
  assert.equal(r.status, 'succeeded', 'a tarefa gravada como concluída vale: não vira "interrupted"'); assert.equal(r.report.status, 'success'); assert.equal(r.taskId, 'ta');
  assert.match(r.report.verificationsInterrupted, /reiniciado antes/); assert.equal(r.verification, 'skipped'); assert.equal(c.plan.steps[0].status, 'failed', 'sem verificação real a etapa NÃO conta como concluída');
  assert.ok(!r.report.outcomeUncertain, 'o resultado da execução é conhecido (está gravado na tarefa)'); assert.equal(c.blockedCode, 'restarted');
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.equal(c.rounds[0].taskId, 'ta'); assert.ok(c.rounds[0].report.reverifiedAt, 'a verificação real foi refeita'); assert.equal(verifierRuns - v0, 2, 'verificação de a (refeita) e de b');
  assert.equal(execStarts - starts, 1, 'o Executor só rodou para a etapa b; a etapa a não foi executada de novo'); assert.deepEqual(c.rounds.map((x) => x.stepId), ['a', 'b']);
  assert.equal(planner.calls.length, 1, 'a retomada não consultou o Planner antes de b'); assert.equal(c.status, 'completed', c.blockedReason);
});

test('o Executor foi encerrado no meio da escrita (tarefa "running" com PID): resultado e arquivos DESCONHECIDOS, nada é refeito sozinho; uma tarefa que nunca chegou a iniciar NÃO é marcada como incerta', async () => {
  const s = sleeper();
  const t1 = task('t1', 'running', { pid: s.pid, startedAt: s.startedAt });
  const m = seed({ ws: 'ws0', rounds: [runningRound(1, undefined, 't1')], tasks: [t1] });
  delete m.cycle.rounds[0].stepId; delete m.cycle.rounds[0].planId; store.saveOrThrow();
  const planner = scripted([blockedAns()]), starts = execStarts, cy = restart(planner), c = live(m.id).cycle;
  assert.equal(pidAlive(s.pid), false, 'o processo anterior, comprovadamente a execução abandonada, foi encerrado no boot'); await s.exited;
  assert.equal(c.rounds[0].status, 'interrupted'); assert.equal(c.rounds[0].report.filesKnown, false); assert.match(c.rounds[0].report.outcomeUncertain, /desconhecid/i); assert.ok(!c.plan, 'ciclo legado: nenhum plano é criado');
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle(); assert.equal(execStarts, starts); assert.equal(planner.calls.length, 1); assert.match(planner.calls[0], /RESULTADO INCERTO/);
  const never = task('tn', 'queued', { authorized: true, startedAt: undefined, finishedAt: null }); delete never.startedAt;
  const m2 = seed({ ws: 'ws0', rounds: [runningRound(1, undefined, 'tn')], tasks: [never] }); delete m2.cycle.rounds[0].stepId; delete m2.cycle.rounds[0].planId; store.saveOrThrow();
  restart(scripted([])); const r2 = live(m2.id).cycle.rounds[0];
  assert.equal(r2.status, 'interrupted'); assert.ok(!r2.report.outcomeUncertain, 'a execução nunca começou: não há incerteza sobre efeitos'); assert.notEqual(r2.report.filesKnown, false);
});

test('recover() é idempotente: um segundo boot sobre o estado já recuperado não muda nada, não duplica atividade nem bloqueios', () => {
  const t = task('ti', 'running', { pid: 999999 });
  const m = seed({ steps: [step('a')], rounds: [runningRound(1, 'a', 'ti')], tasks: [t] });
  restart(scripted([])); const first = snap(live(m.id).cycle), acts = db.activity.length, blocks = live(m.id).cycle.blocks.length;
  restart(scripted([])); assert.equal(snap(live(m.id).cycle), first); assert.equal(live(m.id).cycle.blocks.length, blocks); assert.equal(db.activity.length, acts);
});

// ---------- 4: processo anterior ainda ativo ----------
test('processo anterior AINDA ATIVO (identidade não confirmável): a retomada é recusada com explicação, nada muda nem é executado, e ela volta a funcionar quando o processo termina', async () => {
  const s = sleeper();
  const t1 = task('t1', 'running', { pid: s.pid, startedAt: s.startedAt });
  const m = seed({ steps: [step('a'), step('b', ['a'])], rounds: [runningRound(1, 'a', 't1')], tasks: [t1] });
  const planner = scripted([blockedAns()]), starts = execStarts, cy = restart(planner, { orphanTools: { startedAtOf: () => null } }); // consulta de identidade falha: não se mata nem se libera
  const c = live(m.id).cycle;
  assert.equal(pidAlive(s.pid), true, 'sem confirmar a identidade, nada é encerrado'); assert.equal(executor.isBusy(), true); assert.equal(c.blockedCode, 'restarted'); assert.equal(c.rounds[0].status, 'interrupted');
  const before = snap(c), acts = db.activity.length;
  const r = await cy.resume(m.id); assert.equal(r.status, 409); assert.match(r.error, new RegExp(`${s.pid}`)); assert.match(r.error, /ainda (pode estar|está) ativo/i);
  assert.equal(snap(c), before, 'estado intacto: nenhuma nota, bloqueio, contador ou limite alterado'); assert.equal(db.activity.length, acts); assert.equal(planner.calls.length, 0); assert.equal(execStarts, starts);
  assert.equal((await cy.start(m.id, 3)).status, 409, 'um novo ciclo também é recusado');
  killTreeSync(s.pid); await s.exited;
  assert.equal(executor.isBusy(), false); assert.equal((await cy.resume(m.id)).status, 202); await cy.idle(); assert.equal(planner.calls.length, 1); assert.equal(execStarts, starts, 'mesmo com o processo encerrado, a etapa interrompida não é refeita');
});

// ---------- 6: falha de persistência durante a recuperação ----------
test('disco falhando no BOOT: a recuperação não derruba o servidor, o estado recuperado fica só em memória, a retomada é recusada (503) sem avançar e, com o disco de volta, retoma sem repetir', async () => {
  const ta = task('ta', 'completed'), tb = task('tb', 'running', { pid: 999999 });
  const m = seed({ steps: [step('a'), step('b', ['a'])], rounds: [round(1, 'a', 'ta'), runningRound(2, 'b', 'tb')], tasks: [ta, tb] });
  const planner = scripted([blockedAns()]), starts = execStarts; fs.mkdirSync(BLOCK_TMP);
  let cy, c, before, r;
  try { // o disco fica quebrado de propósito durante o boot e a tentativa de retomada; o finally o conserta mesmo se uma asserção falhar
  await quiet(() => { assert.doesNotThrow(() => { cy = restart(planner); }, 'erro real de gravação no boot não pode impedir o servidor de subir'); });
  c = live(m.id).cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'restarted'); assert.deepEqual(statuses(c), { a: 'completed', b: 'interrupted' }); assert.equal(store.persistenceStatus().ok, false);
  assert.equal(onDisk(m.id).cycle.status, 'running', 'o disco ainda guarda o estado anterior à recuperação (um novo boot recupera de novo, sem perda)');
  before = snap(c); r = await quiet(() => cy.resume(m.id));
  assert.equal(r.status, 503); assert.match(r.error, /não está sendo gravado/); assert.equal(snap(c), before); assert.equal(planner.calls.length, 0); assert.equal(execStarts, starts);
  } finally { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.equal(store.persistenceStatus().ok, true); assert.equal(execStarts, starts, 'a etapa b não foi refeita'); assert.equal(planner.calls.length, 1);
  assert.notEqual(onDisk(m.id).cycle.status, 'running', 'o estado recuperado foi reconciliado no disco antes de seguir');
});

// ---------- 7, 11: contadores e limites ----------
test('contadores e limites sobrevivem à queda: chamadas, rodadas e custo continuam cumulativos; o limite vale na retomada (recusa antes de qualquer mudança) e nada é zerado', async () => {
  const ta = task('ta', 'completed', { tokenUsage: { basis: 'final', ended: true, tokens: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 }, costUsd: 0.002 } }), tb = task('tb', 'running', { pid: 999999 });
  const usage = [1, 2].map((call) => ({ call, ended: true, basis: 'final', costUsd: 0.01, tokens: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } }));
  const m = seed({ steps: [step('a'), step('b', ['a'])], rounds: [round(1, 'a', 'ta'), runningRound(2, 'b', 'tb')], tasks: [ta, tb], cycle: { plannerCalls: 2, plannerUsage: usage, consecutiveFailures: 1 } });
  const planner = scripted([blockedAns()]), cy = restart(planner, { limits: { maxPlannerCalls: 2, maxEstimatedCostUsd: null } }), c = live(m.id).cycle;
  assert.equal(c.plannerCalls, 2); assert.equal(c.plannerUsage.length, 2); assert.equal(c.rounds.length, 2); assert.equal(c.maxIterations, 6);
  const before = snap(c), r = await cy.resume(m.id);
  assert.equal(r.status, 409); assert.match(r.error, /Limite de 2 chamada\(s\) ao Planner/); assert.match(r.error, /ORCH_CYCLE_MAX_PLANNER_CALLS/); assert.equal(snap(c), before, 'recusa sem mudar nada (nem contadores, nem notas)'); assert.equal(planner.calls.length, 0);
  const cy2 = mk(planner, { limits: { maxPlannerCalls: 3, maxEstimatedCostUsd: null } }); // o operador aumentou o limite e reiniciou
  assert.equal((await cy2.resume(m.id)).status, 202); await cy2.idle();
  assert.equal(c.plannerCalls, 3, 'cumulativo: 2 antes da queda + 1 agora'); assert.equal(c.plannerUsage.length, 3); assert.equal(planner.calls.length, 1); assert.equal(c.rounds.length, 2);
  const cy3 = mk(scripted([]), { limits: { maxPlannerCalls: 3, maxEstimatedCostUsd: null } }); assert.equal((await cy3.resume(m.id)).status, 409, 'o limite continua valendo depois da retomada');
});

test('chamada ao Planner EM VOO: a contagem já está no disco quando a chamada começa (uma queda no meio não deixa o limite subcontado)', async () => {
  const m = seed({ ws: 'ws0', rounds: [], tasks: [], cycle: { status: 'blocked', blockedCode: 'restarted', blockedReason: 'x', plannerCalls: 0 } });
  let seenOnDisk = null; const planner = scripted([blockedAns()], { onCall: () => { seenOnDisk = onDisk(m.id).cycle.plannerCalls; } }), cy = restart(planner);
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.equal(seenOnDisk, 1, 'no instante da chamada o disco já dizia "1 chamada feita"'); assert.equal(live(m.id).cycle.plannerCalls, 1);
});

// ---------- 8: planos inválidos ----------
test('plano gravado inválido ou adulterado: o boot bloqueia como plan_invalid, a retomada é recusada de forma explícita (nada muda), o cancelamento continua possível e o histórico é mantido', async () => {
  const ta = task('ta', 'completed');
  const broken = (steps, rounds = [], extra = {}) => { const m = seed({ steps: [step('a')], rounds, tasks: [ta], cycle: extra }); m.cycle.plan.steps = steps; store.saveOrThrow(); return m; };
  const cases = [
    ['ciclo de dependências', broken([{ ...step('a', ['b']), status: 'queued' }, { ...step('b', ['a']), status: 'queued' }, step('c')]), /dependências circulares/],
    ['lista de etapas com item nulo', broken([null, step('a')]), /plano gravado é inválido/],
    ['etapa sem campos obrigatórios', broken([{ id: 'a' }]), /plano gravado é inválido/],
    ['rodada aponta para etapa inexistente', broken([step('a')], [round(1, 'zzz', 'ta')]), /aponta para a etapa "zzz"/],
    ['etapa executada duas vezes', broken([step('a')], [round(1, 'a', 'ta'), round(2, 'a', 'ta')]), /mais de uma rodada/],
  ];
  const mBad = seed({ steps: [step('a')], rounds: [], tasks: [] }); mBad.cycle.plan = 'lixo'; store.saveOrThrow(); cases.push(['plano que não é um objeto', mBad, /estrutura esperada/]);
  const planner = scripted([done()]), starts = execStarts, cy = restart(planner);
  for (const [label, m, re] of cases) {
    const c = live(m.id).cycle, copy = snap(c);
    assert.equal(c.status, 'blocked', label); assert.equal(c.blockedCode, 'plan_invalid', label); assert.match(c.blockedReason, re, label); assert.match(planProblem(c), re, label);
    const r = await cy.resume(m.id); assert.equal(r.status, 409, label); assert.match(r.error, /Plano inconsistente/, label); assert.equal(snap(c), copy, `${label}: a recusa não muda o estado`);
    const k = await cy.cancel(m.id); assert.equal(k.status, 200, label); assert.equal(c.status, 'cancelled', label); assert.equal(c.rounds.length, copy.length && JSON.parse(copy).rounds.length, label);
  }
  assert.equal(execStarts, starts); assert.equal(planner.calls.length, 0, 'nenhum plano inválido consulta o Planner nem executa');
});

// ---------- 9: cancelamento e estados bloqueados ----------
test('cancelamento pedido antes da queda é respeitado no boot (o ciclo termina "cancelled", nunca vira retomável); estados bloqueados e terminais não são mexidos nem retomados sozinhos', async () => {
  const t1 = task('t1', 'running', { pid: 999999 });
  const mc = seed({ steps: [step('a'), step('b', ['a'])], rounds: [runningRound(1, 'a', 't1')], tasks: [t1], cycle: { cancelRequested: true } });
  const keep = (status, over = {}) => seed({ status, steps: [step('a'), step('b', ['a'])], rounds: [round(1, 'a', `k${seq}`)], tasks: [task(`k${seq}`, 'completed')], cycle: over });
  const lr = keep('limit_reached', { finishedAt: '2026-01-01T00:02:00.000Z', maxIterations: 1 }), pf = keep('blocked', { blockedCode: 'persistence_failed', blockedReason: 'disco' });
  const cb = keep('blocked', { blockedCode: 'cost_budget_reached', blockedReason: 'orçamento' }), cn = keep('cancelled', { finishedAt: '2026-01-01T00:02:00.000Z' }), cd = keep('completed', { finishedAt: '2026-01-01T00:02:00.000Z', finalSummary: 'ok' });
  const before = Object.fromEntries([lr, pf, cb, cn, cd].map((x) => [x.id, snap(x.cycle)]));
  const planner = scripted([]), starts = execStarts, cy = restart(planner), c = live(mc.id).cycle;
  assert.equal(c.status, 'cancelled', 'o pedido de cancelamento gravado não é desfeito pela recuperação'); assert.ok(c.finishedAt); assert.equal(c.rounds[0].status, 'interrupted'); assert.equal(statusesOf(c).a, 'interrupted');
  assert.equal((await cy.resume(mc.id)).status, 409, 'cancelado é terminal');
  for (const x of [lr, pf, cb, cn, cd]) assert.equal(snap(live(x.id).cycle), before[x.id], `${x.cycle.status}/${x.cycle.blockedCode}: o boot não toca nem retoma sozinho`);
  assert.equal((await cy.resume(lr.id)).status, 409, 'limit_reached só retoma com um novo maxIterations explícito'); assert.match((await cy.resume(lr.id)).error, /novo limite de rodadas/);
  assert.equal((await cy.resume(cn.id)).status, 409); assert.equal((await cy.resume(cd.id)).status, 409);
  assert.equal((await cy.resume(cb.id)).status, 202, 'bloqueio sem limite ativo: a retomada humana funciona como sempre'); await cy.idle();
  assert.equal(execStarts - starts, 1, 'só a etapa b (na fila) executou; a etapa a, já concluída, não'); assert.deepEqual(live(cb.id).cycle.rounds.map((r) => r.stepId), ['a', 'b']);
});
const statusesOf = (c) => { syncPlan(c); return statuses(c); };

// ---------- 12: modo legado (ORCH_CYCLE_PLAN desligado) ----------
test('modo legado (sem plano, ORCH_CYCLE_PLAN desligado): a queda segue o fluxo de sempre — bloqueio "restarted", retomada consulta o Planner e uma tarefa avulsa nova; nenhum plano é criado', async () => {
  const ta = task('ta', 'completed'), tb = task('tb', 'running', { pid: 999999 });
  const strip = (r) => { delete r.stepId; delete r.planId; return r; };
  const m = seed({ ws: 'ws0', rounds: [strip(round(1, 'a', 'ta')), strip(runningRound(2, 'b', 'tb'))], tasks: [ta, tb] });
  const planner = scripted([cont('refazer com cuidado'), done()]), starts = execStarts, cy = restart(planner, { multiStep: false }), c = live(m.id).cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'restarted'); assert.ok(!c.plan); assert.equal(c.rounds[1].status, 'interrupted'); assert.equal(c.rounds[1].report.filesKnown, false);
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.equal(c.status, 'completed', c.blockedReason); assert.equal(planner.calls.length, 2); assert.equal(execStarts - starts, 1, 'só a tarefa nova que o Planner pediu'); assert.equal(c.rounds.length, 3); assert.ok(!c.plan); assert.ok(c.rounds.every((r) => r.planId === undefined));
  assert.equal(c.rounds[0].taskId, 'ta'); assert.match(planner.calls[0], /RESULTADO INCERTO/);
});
