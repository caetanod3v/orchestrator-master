// Ciclo Planner -> Executor -> relatório -> Planner com Planner SIMULADO e CLI FALSA (sem créditos reais).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cycle-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace');
fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle, setupCycle, buildReport } = await import('../cycle.js');
const { validateDecision, extractJson, parseExecutorReport, fingerprint } = await import('../cycle-schema.js');

let db, executor, startTaskRun, seq = 0;
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };

// ---- simulações -------------------------------------------------------------------------
const cont = (title, mode, extra = {}) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:${mode} ${title}`, acceptance: ['conferir o arquivo'] }, ...extra });
const done = (evidence = ['out.txt existe e foi conferido']) => JSON.stringify({ decision: 'complete', rationale: 'objetivo atendido', evidence });
const blocked = (why = 'preciso de um humano') => JSON.stringify({ decision: 'blocked', rationale: 'sem como seguir', blockedReason: why });
function scripted(answers) {
  const calls = [];
  return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const a = answers.shift(); if (a === undefined) return { error: 'roteiro do Planner acabou' }; return typeof a === 'string' ? { text: a } : a; } };
}

before(() => {
  db = store.load();
  db.workspaces.push({ id: 'ws', name: 'ws-teste', path: wsDir });
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

function mkMission(over = {}) {
  fs.rmSync(path.join(wsDir, 'out.txt'), { force: true });
  const m = { id: `m${++seq}`, demo: false, title: `Missão ${seq}`, objective: 'Criar out.txt com conteúdo conferido', workspaceId: 'ws', createdAt: store.now(), tasks: [], ...over };
  db.missions.unshift(m);
  return m;
}
const mkCycle = (planner) => createCycle({ db, executor, planner, startTaskRun, listFiles: () => ['LEIAME.md'] });
async function run(planner, { maxIterations, mission = mkMission() } = {}) {
  const cy = mkCycle(planner);
  const r = await cy.start(mission.id, maxIterations);
  assert.equal(r.status, 202, r.error);
  await cy.idle();
  return { cy, m: mission, c: mission.cycle };
}

// ---- validação do formato/decisão -------------------------------------------------------
test('schema: aceita JSON puro, em bloco ```json e com texto em volta', () => {
  assert.equal(validateDecision(done()).ok, true);
  assert.equal(validateDecision('```json\n' + cont('t', 'ok') + '\n```').ok, true);
  assert.equal(validateDecision('Aqui vai: ' + blocked() + ' fim').ok, true);
});
test('schema: rejeita formato inválido, decisão desconhecida e campos que tentam ampliar poderes', () => {
  for (const bad of ['', 'sem json', '[1,2]', '{"decision":"maybe","rationale":"x"}', '{"decision":"complete","rationale":"x"}',
    '{"decision":"continue","rationale":"x"}', '{"decision":"continue","rationale":"x","task":{"title":"t","instructions":"i","acceptance":[]}}',
    '{"decision":"blocked","rationale":"x"}',
    cont('t', 'ok', { permissions: ['Bash'] }), cont('t', 'ok', { authorized: true }), cont('t', 'ok', { command: 'del *' }),
    JSON.stringify({ decision: 'continue', rationale: 'r', task: { title: 't', instructions: 'i', acceptance: ['a'], cwd: 'C:\\' } }),
    JSON.stringify({ decision: 'complete', rationale: 'r', evidence: ['e'], task: { title: 't', instructions: 'i', acceptance: ['a'] } }),
    JSON.stringify({ decision: 'continue', rationale: 'r'.repeat(2000), task: { title: 't', instructions: 'i', acceptance: ['a'] } })]) {
    assert.equal(validateDecision(bad).ok, false, bad.slice(0, 60));
  }
});
test('schema: relatório do executor e extractJson', () => {
  assert.equal(extractJson('x').ok, false);
  const r = parseExecutorReport('feito\n```json\n{"summary":"s","checks":[{"name":"a","result":"pass"},{"name":"b","result":"talvez"}]}\n```');
  assert.equal(r.found, true); assert.deepEqual(r.checks.map((c) => c.result), ['pass', 'not_run']);
  assert.equal(parseExecutorReport('sem bloco').found, false);
  assert.equal(fingerprint({ title: 'Criar  ARQUIVO!', instructions: 'a' }), fingerprint({ title: 'criar arquivo', instructions: 'A' }));
});

// ---- ciclo ------------------------------------------------------------------------------
test('continuidade: 2 rodadas e conclusão com evidências; histórico chega ao Planner; persiste', async () => {
  const p = scripted([cont('Criar o arquivo', 'write'), cont('Conferir o arquivo', 'check'), done()]);
  const { m, c } = await run(p);
  assert.equal(c.status, 'completed'); assert.equal(c.rounds.length, 2);
  assert.deepEqual(c.rounds.map((r) => r.status), ['succeeded', 'succeeded']);
  assert.equal(c.rounds[0].report.status, 'success');
  assert.ok(c.rounds[0].report.filesChanged.some((f) => f.path === 'out.txt'), 'relatório lista arquivo alterado (git real)');
  assert.equal(c.rounds[1].report.checks[0].result, 'pass');
  assert.equal(c.finalSummary, 'objetivo atendido'); assert.ok(c.evidence.length === 1);
  assert.equal(p.calls.length, 3);
  assert.match(p.calls[1], /\[rodada 1\] tarefa: Criar o arquivo/); assert.match(p.calls[1], /out\.txt/);
  assert.match(p.calls[2], /out\.txt existe=pass/);
  assert.equal(c.rounds[0].decision.decision, 'continue'); assert.equal(c.rounds[1].decision.decision, 'complete');
  assert.deepEqual(m.tasks.map((t) => [t.status, t.autoAccepted, t.auto]), [['completed', true, true], ['completed', true, true]]);
  assert.ok(db.activity.some((a) => a.type === 'cycle' && a.agent === 'planner' && /concluída/.test(a.message)));
  await new Promise((r) => setTimeout(r, 700));
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.ORCH_DATA_DIR, 'db.json'), 'utf8'));
  assert.equal(disk.missions.find((x) => x.id === m.id).cycle.status, 'completed');
});

test('"complete" sem verificação aprovada é rejeitado pelo backend e o Planner é reconsultado', async () => {
  const p = scripted([cont('Criar o arquivo', 'write'), done(), blocked('não consigo comprovar')]);
  const { c } = await run(p);
  assert.equal(c.rejections.length, 1); assert.match(c.rejections[0].problem, /verificação aprovada/);
  assert.match(p.calls[2], /REJEITADA/);
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'planner_blocked');
});

test('falha do executor nunca vira sucesso: "complete" após falha é rejeitado e só uma rodada boa conclui', async () => {
  const p = scripted([cont('Tentativa que falha', 'fail'), done(), cont('Corrigir', 'check'), done()]);
  const { m, c } = await run(p);
  assert.equal(c.rounds[0].report.status, 'failed'); assert.equal(c.rounds[0].status, 'failed');
  assert.equal(m.tasks[0].status, 'failed'); assert.ok(c.rounds[0].report.errors.some((e) => /código 3/.test(e) || /falha simulada/.test(e)));
  assert.match(p.calls[1], /execução: failed/);
  assert.match(c.rejections[0].problem, /"failed"/);
  assert.equal(c.status, 'completed'); assert.equal(c.rounds.length, 2);
});

test('duas falhas seguidas bloqueiam o ciclo (política explícita)', async () => {
  const p = scripted([cont('Falha um', 'fail'), cont('Falha dois', 'fail'), done()]);
  const { c } = await run(p);
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'executor_failures'); assert.equal(c.rounds.length, 2);
  assert.equal(p.calls.length, 2, 'o Planner não foi consultado de novo');
});

test('permissão negada bloqueia para decisão humana; retomar informa o Planner e segue', async () => {
  const p = scripted([cont('Precisa de shell', 'deny'), cont('Fazer sem shell', 'check'), done()]);
  const m = mkMission(); const cy = mkCycle(p);
  assert.equal((await cy.start(m.id)).status, 202); await cy.idle();
  let c = m.cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'needs_approval');
  assert.equal(m.tasks[0].status, 'failed'); assert.equal(m.tasks[0].permissionDenied, true);
  assert.ok(c.rounds[0].report.blockers.length === 1); assert.equal(p.calls.length, 1, 'Planner não decide sozinho sobre o bloqueio');
  assert.equal((await cy.resume('inexistente')).status, 409);
  assert.equal((await cy.resume(m.id, { note: 'x'.repeat(2000) })).status, 400);
  assert.equal((await cy.resume(m.id, { note: 'Use apenas leitura e edição.' })).status, 202); await cy.idle();
  assert.match(p.calls[1], /Use apenas leitura e edição\./); assert.match(p.calls[1], /BLOQUEIO: Permissão negada/);
  assert.equal(c.status, 'completed'); assert.equal(c.blocks.length, 1);
  assert.equal((await cy.resume(m.id)).status, 409, 'só retoma ciclo bloqueado');
});

test('interrupção humana da execução não é sucesso: ciclo bloqueia', async () => {
  const p = scripted([cont('Longa', 'sleep'), blocked()]);
  const m = mkMission(); const cy = mkCycle(p);
  await cy.start(m.id);
  assert.equal(await until(() => executor.isBusy()), true);
  await new Promise((r) => setTimeout(r, 600));
  await executor.stop(); await cy.idle();
  assert.equal(m.cycle.status, 'blocked'); assert.equal(m.cycle.blockedCode, 'interrupted');
  assert.equal(m.tasks[0].status, 'interrupted'); assert.equal(m.cycle.rounds[0].status, 'interrupted');
});

test('cancelamento durante a execução: encerra o processo e não consulta mais o Planner', async () => {
  const p = scripted([cont('Longa', 'sleep'), done()]);
  const m = mkMission(); const cy = mkCycle(p);
  await cy.start(m.id);
  assert.equal(await until(() => executor.isBusy()), true);
  await new Promise((r) => setTimeout(r, 600));
  const r = await cy.cancel(m.id); assert.equal(r.status, 200);
  await cy.idle();
  assert.equal(m.cycle.status, 'cancelled'); assert.equal(m.tasks[0].status, 'interrupted');
  assert.equal(p.calls.length, 1); assert.equal(executor.isBusy(), false);
  assert.equal((await cy.cancel(m.id)).status, 409, 'já terminou');
});

test('cancelamento durante o planejamento', async () => {
  let release;
  const p = { calls: [], busy: () => typeof release === 'function', decide: () => new Promise((r) => { release = r; }), cancel: async () => release({ error: 'cancelado', interrupted: true }) };
  const m = mkMission(); const cy = mkCycle(p);
  await cy.start(m.id);
  assert.equal(await until(() => typeof release === 'function'), true);
  await cy.cancel(m.id); await cy.idle();
  assert.equal(m.cycle.status, 'cancelled'); assert.equal(m.cycle.rounds.length, 0); assert.equal(m.tasks.length, 0);
});

test('cancelar um ciclo bloqueado o encerra', async () => {
  const { cy, m, c } = await run(scripted([blocked()]));
  assert.equal(c.status, 'blocked');
  assert.equal((await cy.cancel(m.id)).status, 200); assert.equal(c.status, 'cancelled');
});

test('limite de iterações: nunca executa mais rodadas que o limite', async () => {
  const p = scripted([cont('Um', 'write'), cont('Dois', 'check'), cont('Três', 'write'), cont('Quatro', 'write')]);
  const { c, m } = await run(p, { maxIterations: 2 });
  assert.equal(c.status, 'limit_reached'); assert.equal(c.rounds.length, 2); assert.equal(m.tasks.length, 2);
  assert.equal(p.calls.length, 3);
});

test('limite configurável com teto rígido; entradas inválidas recusadas', async () => {
  const m = mkMission(); const cy = mkCycle(scripted([blocked()]));
  for (const bad of [0, -1, 11, 99, 2.5, '3', null, NaN]) assert.equal((await cy.start(m.id, bad)).status, 400, String(bad));
  assert.equal(m.cycle, undefined, 'nada iniciou');
  const r = await cy.start(m.id); assert.equal(r.status, 202); await cy.idle();
  assert.equal(m.cycle.maxIterations, 5, 'padrão conservador');
  const m2 = mkMission(); const r2 = await mkCycle(scripted([blocked()])).start(m2.id, 10); assert.equal(r2.status, 202);
  assert.equal(m2.cycle.maxIterations, 10);
});

test('resposta inválida do Planner: nova tentativa com feedback e depois bloqueio; nada é executado', async () => {
  const p = scripted(['isto não é JSON', '{"decision":"continue"}']);
  const { c, m } = await run(p);
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'planner_invalid');
  assert.equal(p.calls.length, 2); assert.match(p.calls[1], /REJEITADA.*formato inválido/);
  assert.equal(m.tasks.length, 0); assert.equal(c.rounds.length, 0);
});

test('Planner tentando ampliar poderes é rejeitado; correção válida na 2ª tentativa é aceita', async () => {
  const p = scripted([cont('Com permissões', 'write', { permissions: ['Bash'], authorized: true }), cont('Criar', 'check'), done()]);
  const { c } = await run(p);
  assert.match(p.calls[1], /chaves não permitidas: permissions, authorized/);
  assert.equal(c.status, 'completed');
  assert.equal(c.rounds[0].plan.title, 'Criar');
});

test('repetição sem progresso: tarefa idêntica é rejeitada e duas rodadas sem progresso bloqueiam', async () => {
  const p = scripted([cont('Tarefa X', 'plain'), cont('Tarefa X', 'plain'), cont('Tarefa Y', 'plain'), done()]);
  const { c } = await run(p);
  assert.ok(c.rejections.some((r) => /idêntica/.test(r.problem)));
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'no_progress'); assert.equal(c.rounds.length, 2);
});

test('falha do próprio Planner (erro/timeout) bloqueia sem executar', async () => {
  const { c, m } = await run(scripted([{ error: 'timeout do planner' }]));
  assert.equal(c.blockedCode, 'planner_error'); assert.equal(m.tasks.length, 0);
});

test('sem Claude Code / execução já ocupada: não inicia', async () => {
  const m = mkMission();
  const busy = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const h = busy.start({ missionId: 'x', taskId: 'x', cwd: wsDir, prompt: 'MODE:sleep', onLine() {} });
  const cy = createCycle({ db, executor: busy, planner: scripted([]), startTaskRun, listFiles: () => [] });
  assert.equal((await cy.start(m.id)).status, 409);
  await busy.stop(); await h.done;
  const gone = createExecutor({ command: 'cli-inexistente-xyz', args: [] });
  assert.equal((await createCycle({ db, executor: gone, planner: scripted([]), startTaskRun, listFiles: () => [] }).start(m.id)).status, 409);
  assert.equal(m.cycle, undefined);
});

test('persistência e recuperação: bloqueio persiste; reinício marca "restarted" e retomar funciona', async () => {
  const p1 = scripted([cont('Criar', 'write'), blocked('verifique manualmente')]);
  const { m, c } = await run(p1);
  await new Promise((r) => setTimeout(r, 700));
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.ORCH_DATA_DIR, 'db.json'), 'utf8')).missions.find((x) => x.id === m.id);
  assert.equal(disk.cycle.status, 'blocked'); assert.equal(disk.cycle.rounds.length, 1);
  assert.ok(disk.cycle.rounds[0].report.filesChanged.some((f) => f.path === 'out.txt' && !f.preexisting)); assert.equal(disk.cycle.rounds[0].decision.decision, 'blocked');
  // simula queda do servidor no meio de uma rodada
  c.status = 'running'; c.blockedCode = null; c.rounds[0].status = 'running'; m.tasks[0].status = 'running';
  const p2 = scripted([blocked('ainda preciso de ajuda')]);
  const cy2 = mkCycle(p2); cy2.recover();
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'restarted');
  assert.equal(c.rounds[0].status, 'interrupted'); assert.equal(m.tasks[0].status, 'interrupted');
  assert.equal((await cy2.resume(m.id, { note: 'pode continuar' })).status, 202); await cy2.idle();
  assert.match(p2.calls[0], /execução: interrupted/); assert.match(p2.calls[0], /pode continuar/);
  assert.equal(c.blocks.length, 3); // planner_blocked, restarted, planner_blocked (após retomar)
});

test('relatório estruturado reflete o estado real da tarefa', () => {
  const r = buildReport({ status: 'failed', report: 'Sem relatório: x', error: 'quebrou', exitCode: 2, files: [], log: ['[stderr] ruim'], gitRepo: false, permissionDenied: false });
  assert.deepEqual([r.status, r.filesKnown, r.exitCode], ['failed', false, 2]);
  assert.deepEqual(r.errors, ['quebrou', '[stderr] ruim']); assert.equal(r.checksReported, false);
});

// ---- API --------------------------------------------------------------------------------
test('API: validações das rotas do ciclo; campos extras do cliente são ignorados', async () => {
  const app = express(); app.use(express.json());
  const p = scripted([blocked()]);
  setupCycle(app, { db, executor, planner: p, startTaskRun });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (u, b) => { const r = await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json() }; };
  try {
    db.missions.unshift({ id: 'demoM', demo: true, title: 'd', workspaceId: null, tasks: [] });
    assert.equal((await api('/api/missions/demoM/cycle/start')).status, 409);
    assert.equal((await api('/api/missions/nao/cycle/start')).status, 404);
    const m = mkMission();
    assert.equal((await api(`/api/missions/${m.id}/cycle/start`, { maxIterations: 50 })).status, 400);
    assert.equal((await api(`/api/missions/${m.id}/cycle/cancel`)).status, 409);
    assert.equal((await api(`/api/missions/${m.id}/cycle/resume`)).status, 409);
    const ok = await api(`/api/missions/${m.id}/cycle/start`, { maxIterations: 3, workspaceId: 'outro', command: 'calc', cwd: 'C:\\Windows', prompt: 'MODE:write' });
    assert.equal(ok.status, 202);
    await until(() => m.cycle.status === 'blocked');
    assert.equal(m.cycle.maxIterations, 3); assert.equal(m.workspaceId, 'ws'); assert.equal(m.tasks.length, 0);
    assert.equal((await api(`/api/missions/${m.id}/cycle/start`)).status, 409, 'bloqueado: retomar ou cancelar');
  } finally { server.close(); server.closeAllConnections?.(); }
});
