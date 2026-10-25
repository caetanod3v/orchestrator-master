// Regressões da auditoria: ciclos duplicados, finalização com erro e verificação interrompida.
// Banco TEMPORÁRIO, CLI FALSA, Planner SIMULADO, verificador com processo falso e porta aleatória (nada real é invocado).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-robust-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-cli.mjs');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir);
const pkg = path.join(wsDir, 'package.json');
const setTest = (text) => fs.writeFileSync(pkg, JSON.stringify({ name: 'robust-test', version: '1.0.0', scripts: { test: text } }));

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor, bus } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createVerifier } = await import('../verify.js');
const { createCycle, setupCycle } = await import('../cycle.js');

const unhandled = [];
const onUnhandled = (e) => unhandled.push(e);
process.on('unhandledRejection', onUnhandled);
let db, server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
before(() => { db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }]; });
after(async () => { process.off('unhandledRejection', onUnhandled); server?.close(); server?.closeAllConnections?.(); await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

const mkMission = (id) => { const m = { id, demo: false, title: id, objective: 'obj', workspaceId: 'ws', createdAt: store.now(), tasks: [] }; db.missions.push(m); return m; };
const cont = (title, mode = 'check') => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:${mode} ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'verificações reais aprovadas', evidence: ['test=pass refeito pelo orquestrador'] });
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const a = answers.shift(); return a === undefined ? { error: 'roteiro acabou' } : { text: a }; } }; };
const coldExecutor = () => { const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] }); return { executor, ...setupExecution(express(), { db, executor }) }; };

// ---- 1. start simultâneo --------------------------------------------------------------------
test('3 start simultâneos (probe frio): exatamente um 202 e dois 409; nunca passa do limite de rodadas', async () => {
  db.missions = []; mkMission('race1');
  const { executor, startTaskRun } = coldExecutor();
  let n = 0;
  const gate = deferred(); // o 1º laço só avança depois que TODAS as respostas dos 3 start chegaram
  const planner = { busy: () => false, cancel: async () => {}, decide: async () => { await gate.promise; return { text: cont(`tarefa distinta ${++n}`) }; } };
  const app = express(); app.use(express.json());
  const cy = setupCycle(app, { db, executor, planner, startTaskRun, verifier: null });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/missions/race1/cycle/start`;
  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxIterations: 1 }) }).then((r) => r.status);
  const statuses = await Promise.all([post(), post(), post()]);
  assert.deepEqual(statuses.slice().sort(), [202, 409, 409]);
  gate.resolve();
  await cy.idle();
  const m = db.missions[0];
  assert.equal(m.cycle.rounds.length, 1, 'não pode ultrapassar maxIterations');
  assert.equal(m.cycle.status, 'limit_reached');
  assert.equal(m.tasks.length, 1);
  assert.equal(m.pastCycles, undefined, 'nenhum ciclo órfão arquivado');
  assert.equal(n, 2, 'um único laço consultou o Planner');
  server.close(); server.closeAllConnections?.(); server = null;
});

test('start em missões diferentes ao mesmo tempo: só um é aceito; o lock é liberado depois (inclusive em falha)', async () => {
  db.missions = []; mkMission('ra'); mkMission('rb');
  const { executor, startTaskRun } = coldExecutor();
  let n = 0;
  const gate = deferred();
  const planner = { busy: () => false, cancel: async () => {}, decide: async () => { await gate.promise; return { text: ++n === 1 ? cont('única') : JSON.stringify({ decision: 'blocked', rationale: 'fim', blockedReason: 'fim' }) }; } };
  const cy = createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });
  const [a, b] = await Promise.all([cy.start('ra', 1), cy.start('rb', 1)]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  gate.resolve();
  await cy.idle();
  const other = a.status === 202 ? 'rb' : 'ra';
  const again = await cy.start(other, 1);                       // a reserva foi liberada
  assert.equal(again.status, 202); await cy.idle();
  // CLI ausente: 409 e a reserva também é liberada
  const gone = createCycle({ db, executor: createExecutor({ command: 'cli-inexistente-xyz', args: [] }), planner, startTaskRun, listFiles: () => [] });
  db.missions.forEach((m) => { delete m.cycle; });
  assert.equal((await gone.start('ra')).status, 409);
  assert.equal((await gone.start('ra')).status, 409, 'não ficou "reservado" para sempre');
});

// ---- 2. finalização com erro ----------------------------------------------------------------
test('finished rejeita E o tratamento de erro também falha: nada fica "running" nem gera rejeição não tratada', async () => {
  db.missions = []; const m = mkMission('fin1');
  const { executor, startTaskRun: real } = coldExecutor();
  let arm = false;
  const listener = () => { if (arm) throw new Error('segunda exceção (evento)'); };
  bus.on('cycle', listener);
  const startTaskRun = async (mission, task) => {            // simula uma execução que ficou "running" e cuja finalização explodiu
    task.status = 'running'; task.pid = 123; arm = true;
    return { ok: true, finished: Promise.reject(new Error('finalização explodiu')) };
  };
  const cy = createCycle({ db, executor, planner: scripted([cont('x'), cont('y')]), startTaskRun, listFiles: () => [] });
  const origErr = console.error; console.error = () => {};
  try {
    assert.equal((await cy.start('fin1', 3)).status, 202); await cy.idle();
  } finally { console.error = origErr; arm = false; bus.off('cycle', listener); }
  const c = m.cycle, t = m.tasks[0], r = c.rounds[0];
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'internal_error');
  assert.equal(t.status, 'failed'); assert.match(t.error, /finalização explodiu/); assert.equal(t.pid, undefined);
  assert.equal(r.status, 'failed'); assert.equal(r.report.status, 'failed'); assert.ok(r.finishedAt);
  assert.ok(!m.tasks.some((x) => x.status === 'running') && !c.rounds.some((x) => x.status === 'running'));
  assert.deepEqual(unhandled, []);
  // o ciclo continua retomável (e o laço foi removido de loops)
  const cy2 = createCycle({ db, executor, planner: scripted([JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'humano' })]), startTaskRun: real, listFiles: () => [] });
  assert.equal((await cy2.resume('fin1')).status, 202); await cy2.idle();
  assert.equal(m.cycle.blockedCode, 'planner_blocked');
});

test('startTaskRun: erro DURANTE a finalização nunca rejeita e a tarefa termina "failed", não "running"', async () => {
  db.missions = []; const m = mkMission('fin2');
  const { startTaskRun } = coldExecutor();
  const task = { id: 'tk', title: 't', status: 'queued', authorized: true, auto: true, dependsOn: [], report: '', files: [], log: [], instructions: 'MODE:ok x', acceptance: [] };
  let store_ = [];
  Object.defineProperty(task, 'log', { configurable: true, get() { if (task.finishedAt && task.status === 'running') throw new Error('log explodiu'); return store_; }, set(v) { store_ = v; } });
  m.tasks.push(task);
  const r = await startTaskRun(m, task, { autoAccept: true });
  assert.equal(r.ok, true);
  await r.finished;                                              // não pode rejeitar
  assert.equal(task.status, 'failed'); assert.match(task.error, /Falha ao finalizar a execução: log explodiu/);
  assert.equal(task.pid, undefined); assert.ok(task.finishedAt);
  assert.deepEqual(unhandled, []);
});

// ---- 4. ajustes residuais -------------------------------------------------------------------
test('falha ANTES de a tarefa chegar a "running": fica "failed", sem autorização residual e fora da fila', async () => {
  db.missions = []; const m = mkMission('q1');
  const { executor } = coldExecutor();
  const startTaskRun = async () => { throw new Error('probe explodiu'); };
  const cy = createCycle({ db, executor, planner: scripted([cont('x')]), startTaskRun, listFiles: () => [] });
  const origErr = console.error; console.error = () => {};
  try { assert.equal((await cy.start('q1', 3)).status, 202); await cy.idle(); } finally { console.error = origErr; }
  const t = m.tasks[0], c = m.cycle;
  assert.equal(t.status, 'failed'); assert.equal(t.authorized, false); assert.match(t.error, /Falha ao iniciar a execução: probe explodiu/); assert.ok(t.finishedAt);
  assert.equal(c.rounds[0].status, 'failed'); assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'internal_error');
  assert.ok(!m.tasks.some((x) => ['queued', 'running'].includes(x.status) || x.authorized));
  assert.ok(db.activity.some((a) => a.missionId === 'q1' && /Erro interno do ciclo: probe explodiu/.test(a.message)), 'motivo registrado na atividade');
  assert.deepEqual(unhandled, []);
});

test('revalida depois do probe: missão removida, workspace removido, executor ou Planner ocupados => rejeita, sem ciclo órfão nem reserva presa', async () => {
  const real = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  let plannerBusy = false;
  const scenarios = {
    'missão removida': { status: 404, change: () => { db.missions = db.missions.filter((x) => x.id !== 'rv'); } },
    'workspace removido': { status: 409, change: () => { db.workspaces = db.workspaces.filter((w) => w.id !== 'ws'); } },
    'executor ocupado': { status: 409, change: () => { real.start({ missionId: 'x', taskId: 'y', cwd: wsDir, prompt: 'MODE:sleep', onLine() {} }); } },
    'Planner ocupado': { status: 409, change: () => { plannerBusy = true; } },
  };
  for (const [name, sc] of Object.entries(scenarios)) {
    db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }]; plannerBusy = false;
    const m = mkMission('rv');
    const gate = deferred();
    const executor = { ...real, probe: async () => { await gate.promise; return real.probe(); } };
    const { startTaskRun } = setupExecution(express(), { db, executor });
    const planner = { ...scripted([JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'fim' })]), busy: () => plannerBusy };
    const cy = createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });
    const pending = cy.start('rv', 1);                              // fica parado dentro do await do probe, com a reserva tomada
    assert.equal((await cy.start('rv', 1)).status, 409, `${name}: a reserva bloqueia concorrentes`);
    sc.change(); gate.resolve();
    const r = await pending;
    assert.equal(r.status, sc.status, `${name}: ${r.error}`);
    assert.equal(m.cycle, undefined, `${name}: nenhum ciclo criado`);
    assert.equal(m.tasks.length, 0); assert.equal(planner.calls.length, 0);
    await real.stop(); plannerBusy = false;
    if (name !== 'missão removida') {                               // a reserva foi liberada: com o estado normalizado, um novo start é aceito
      db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }];
      assert.equal((await cy.start('rv', 1)).status, 202, `${name}: reserva liberada`); await cy.idle();
    }
  }
});

test('exceção síncrona ao criar o ciclo: tudo é revertido (inclusive pastCycles), a reserva é liberada e o erro é consistente', async () => {
  db.missions = []; const m = mkMission('sx');
  const old = { id: 'cyc_old', status: 'completed', rounds: [], maxIterations: 1 }; m.cycle = old;
  const { executor, startTaskRun } = coldExecutor();
  const planner = scripted([JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'fim' })]);
  const cy = createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });
  let arm = true;
  const listener = () => { if (arm) { arm = false; throw new Error('emit explodiu'); } };
  bus.on('cycle', listener);
  const origErr = console.error; console.error = () => {};
  let r;
  try { r = await cy.start('sx', 1); } finally { console.error = origErr; bus.off('cycle', listener); }
  assert.equal(r.status, 500); assert.match(r.error, /Falha ao iniciar o ciclo: emit explodiu/);
  assert.equal(m.cycle, old, 'o ciclo anterior foi restaurado'); assert.equal(m.pastCycles, undefined);
  assert.equal(planner.calls.length, 0, 'nenhum laço foi iniciado');
  assert.ok(db.activity.some((a) => a.missionId === 'sx' && /Falha ao iniciar o ciclo \(revertido\)/.test(a.message)));
  // sem laço e sem reserva: um novo start funciona normalmente
  assert.equal((await cy.start('sx', 1)).status, 202); await cy.idle();
  assert.equal(m.cycle.blockedCode, 'planner_blocked'); assert.equal(m.pastCycles.length, 1);
});

// ---- 3. verificação interrompida ------------------------------------------------------------
const VERIF = { id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 };
function interruptedMission(id, phase = 'verifying') {
  const m = mkMission(id);
  const task = { id: `${id}_t`, title: '[Rodada 1] Criar', status: 'completed', auto: true, authorized: false, dependsOn: [], report: 'ok', files: [], log: [] };
  m.tasks.push(task);
  const partial = { id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: 'PARCIAL-ANTIGO', truncated: false, reason: null };
  const report = { status: 'success', summary: 'feito', filesChanged: [{ path: 'a.txt', status: '??', added: null, removed: null, preexisting: false }], filesKnown: true, checks: [{ name: 'a', result: 'pass', detail: '' }], checksReported: true, errors: [], blockers: [], exitCode: 0, usage: null, verifications: [partial], verificationsSkipped: null };
  m.cycle = {
    id: `${id}_c`, status: 'running', maxIterations: 3, plannerCalls: 1, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null,
    finalSummary: null, evidence: null, cancelRequested: false, startedAt: store.now(), finishedAt: null,
    rounds: [{ n: 1, status: 'succeeded', taskId: task.id, fingerprint: 'criar', plan: { rationale: 'r', title: 'Criar', instructions: 'i', acceptance: ['a'] }, startedAt: store.now(), finishedAt: store.now(), phase, report, decision: null }],
  };
  return m;
}
const realVerifier = (spawned) => createVerifier({ spawnSpec: (s) => { spawned.push(s); return { command: process.execPath, args: [path.join(HERE, 'fake-verify.mjs'), s] }; } });

test('queda durante a verificação: recover() marca como INTERROMPIDA; retomar refaz a verificação real e a antiga vira histórico', async () => {
  db.workspaces[0].verifications = [VERIF]; setTest('node --test');
  db.missions = []; const m = interruptedMission('iv1');
  const spawned = [], planner = scripted([done()]);
  const { executor, startTaskRun } = coldExecutor();
  const cy = createCycle({ db, executor, planner, startTaskRun, verifier: realVerifier(spawned), listFiles: () => [] });
  cy.recover();
  const c = m.cycle, rep = c.rounds[0].report;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'restarted');
  assert.match(rep.verificationsInterrupted, /reiniciado durante a verificação/);
  assert.equal(c.rounds[0].phase, 'done');
  assert.equal((await cy.resume('iv1')).status, 202); await cy.idle();
  assert.deepEqual(spawned, ['test'], 'a verificação real foi executada de novo');
  assert.equal(rep.verifications.length, 1);
  assert.ok(rep.verifications[0].outputTail.includes('testes ok'), 'evidência ATUAL = execução nova');
  assert.ok(!JSON.stringify(rep.verifications).includes('PARCIAL-ANTIGO'));
  assert.equal(rep.verificationsInterrupted, null);
  assert.equal(rep.previousVerifications.length, 1);
  assert.equal(rep.previousVerifications[0].verifications[0].outputTail, 'PARCIAL-ANTIGO', 'o resultado parcial foi preservado como histórico');
  const prompt = planner.calls[0];
  assert.match(prompt, /verificação anterior SUBSTITUÍDA/); assert.match(prompt, /é HISTÓRICO, não é a situação atual/);
  const last = prompt.slice(prompt.indexOf('ÚLTIMO RELATÓRIO'));
  assert.ok(!last.includes('PARCIAL-ANTIGO') && !last.includes('previousVerifications'), 'o JSON do relatório atual não carrega o histórico');
  assert.equal(c.status, 'completed'); assert.equal(c.assurance, 'verified');
});

test('rodada que terminou mas nem chegou a iniciar a verificação (phase ausente) também não vale como sucesso', async () => {
  db.workspaces[0].verifications = [VERIF]; setTest('node --test');
  db.missions = []; const m = interruptedMission('iv2', undefined);
  m.cycle.rounds[0].report.verifications = [];
  const { executor, startTaskRun } = coldExecutor();
  const cy = createCycle({ db, executor, planner: scripted([]), startTaskRun, verifier: null, listFiles: () => [] });
  cy.recover();
  assert.ok(m.cycle.rounds[0].report.verificationsInterrupted);
});

test('sem bypass: script alterado desde a aprovação mantém o bloqueio humano, nada roda e o Planner não é consultado', async () => {
  db.workspaces[0].verifications = [VERIF]; setTest('node --test --alterado');
  db.missions = []; const m = interruptedMission('iv3');
  const spawned = [], planner = scripted([done()]);
  const { executor, startTaskRun } = coldExecutor();
  const cy = createCycle({ db, executor, planner, startTaskRun, verifier: realVerifier(spawned), listFiles: () => [] });
  cy.recover();
  assert.equal((await cy.resume('iv3')).status, 202); await cy.idle();
  const c = m.cycle, rep = c.rounds[0].report;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'verification_blocked');
  assert.deepEqual(spawned, [], 'nenhum processo foi iniciado com o script não aprovado');
  assert.equal(rep.verifications[0].status, 'blocked'); assert.match(rep.verifications[0].reason, /O script mudou desde a aprovação humana/);
  assert.equal(planner.calls.length, 0);
  assert.notEqual(c.status, 'completed');
  // retomar de novo (ainda sem reaprovação) continua bloqueado
  assert.equal((await cy.resume('iv3')).status, 202); await cy.idle();
  assert.equal(c.blockedCode, 'verification_blocked'); assert.deepEqual(spawned, []); assert.equal(planner.calls.length, 0);
  setTest('node --test');
});

test('sem verificador disponível na retomada: o resultado parcial NÃO é aceito como evidência e "complete" é rejeitado', async () => {
  db.workspaces[0].verifications = [{ ...VERIF, required: false }]; setTest('node --test');
  db.missions = []; const m = interruptedMission('iv4');
  const planner = scripted([done(), done()]);
  const { executor, startTaskRun } = coldExecutor();
  const cy = createCycle({ db, executor, planner, startTaskRun, verifier: null, listFiles: () => [] });
  cy.recover();
  assert.equal((await cy.resume('iv4')).status, 202); await cy.idle();
  const c = m.cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'planner_invalid');
  assert.match(c.rejections[0].problem, /interrompidas e ainda não foram refeitas/);
  assert.match(planner.calls[0], /verificações REAIS INTERROMPIDAS/);
  assert.notEqual(m.cycle.status, 'completed');
});
