// M2: política de falhas de persistência. O ciclo não avança, não declara conclusão e não retoma sem o estado gravado.
// Isolamento: banco em diretório TEMPORÁRIO (ORCH_DATA_DIR antes de qualquer import), workspace temporário, CLI FALSA, Planner ROTEIRIZADO; nenhum modelo,
// nenhum servidor. As falhas são simuladas só dentro deste processo:
//   EISDIR : um DIRETÓRIO no lugar de db.json.tmp => save() LANÇA (erro real, não transitório) e o db.json antigo permanece no disco;
//   EBUSY  : rename/escrita de db.json falham sempre => esgota as tentativas transitórias do save(), que devolve false (db.json antigo permanece).
import test, { mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-persist-'));
const DATA = path.join(tmp, 'data');
process.env.ORCH_DATA_DIR = DATA;
assert.ok(DATA.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { createChildRegistry, CHILD_KEY } = await import('../child-registry.js');
const { createClaudePlanner } = await import('../planner.js');
const { createVerifier } = await import('../verify.js');
const { installShutdown } = await import('../shutdown.js');
const { createProcTracker } = await import('./proc-identity.mjs');

// Identidade dos PIDs (proc-identity.mjs): o Windows reaproveita PIDs em segundos; `pidAlive` é verdadeiro só para o processo ORIGINAL (PID reaproveitado conta
// como encerrado) e o cleanup só encerra o original: nunca um processo alheio que herdou o número. Os PIDs são registrados logo após o spawn.
const spawned = createProcTracker();
const pidAlive = (pid) => spawned.isAlive(pid);
after(async () => { mock.restoreAll(); fs.rmSync(path.join(DATA, 'db.json.tmp'), { recursive: true, force: true }); spawned.cleanup(); await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

const db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws-teste', path: wsDir }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p, ms = 30_000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), ms))]);
const quiet = () => mock.method(console, 'error', () => {});
const disk = () => JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
const diskMission = (id) => disk().missions.find((x) => x.id === id);
const TMPDIR = path.join(DATA, 'db.json.tmp');
beforeEach(() => { mock.restoreAll(); fs.rmSync(TMPDIR, { recursive: true, force: true }); }); // um caso que falha no meio não pode deixar o disco quebrado para o seguinte
/** save() passa a LANÇAR EISDIR (erro real); devolve a função que normaliza o disco. */
const eisdir = () => { fs.mkdirSync(TMPDIR, { recursive: true }); return () => fs.rmSync(TMPDIR, { recursive: true, force: true }); };
/** Gravações de db.json falham SEMPRE com EBUSY (transitório): save() esgota as tentativas e devolve false. Devolve a função que normaliza. */
function busy() {
  const rr = fs.renameSync, rw = fs.writeFileSync, boom = () => { throw Object.assign(new Error('EBUSY: simulado'), { code: 'EBUSY' }); };
  mock.method(fs, 'renameSync', (a, b, ...r) => (String(b).endsWith('db.json') ? boom() : rr(a, b, ...r)));
  mock.method(fs, 'writeFileSync', (p, ...r) => (String(p).endsWith('db.json') ? boom() : rw(p, ...r)));
  return () => mock.restoreAll();
}
const trySave = () => { try { return store.save(); } catch { return 'lançou'; } };

const cont = (title, mode = 'check') => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:${mode} ${title}`, acceptance: ['conferir o arquivo'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'objetivo atendido', evidence: ['out.txt existe e foi conferido'] });
const blocked = (why = 'fim') => JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: why });
/** Planner roteirizado: cada resposta é um texto ou uma função (efeito colateral antes de responder, por exemplo quebrar o disco). */
function scripted(answers) {
  const calls = [];
  return { calls, busy: () => false, cancel: async () => {}, decide: async () => { calls.push(1); const a = answers.shift(); if (a === undefined) return { error: 'roteiro do Planner acabou' }; return { text: typeof a === 'function' ? await a() : a }; } };
}
function rig() {
  const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] }), started = [], real = executor.start;
  executor.start = (o) => { const h = real(o); started.push(h); spawned.add(h.pid); return h; };
  const { startTaskRun } = setupExecution(express(), { db, executor });
  return { executor, started, startTaskRun };
}
let seq = 0;
const mkMission = () => { const m = { id: `m${++seq}`, demo: false, title: `M${seq}`, objective: 'objetivo', workspaceId: 'ws', createdAt: store.now(), tasks: [] }; db.missions.push(m); return m; };
const mkCycle = (r, planner, retry = [0, 0]) => createCycle({ db, executor: r.executor, planner, startTaskRun: r.startTaskRun, listFiles: () => [], persistRetryMs: retry });

// ---- saudável: nada muda ---------------------------------------------------------------------------------------------------------
test('armazenamento saudável: o ciclo conclui como sempre, nada sinaliza incidente e o disco tem o estado final', async () => {
  const r = rig(), m = mkMission(), planner = scripted([cont('A'), done()]), cy = mkCycle(r, planner);
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  assert.equal(m.cycle.status, 'completed'); assert.equal(m.cycle.blockedCode, null); assert.equal(r.started.length, 1); assert.equal(planner.calls.length, 2);
  assert.equal(diskMission(m.id).cycle.status, 'completed'); assert.ok(diskMission(m.id).cycle.finalSummary);
  assert.equal(store.persistenceStatus().ok, true); assert.equal(store.persistenceIncident(), null, 'nenhuma falha neste processo');
});

// ---- store: saveOrThrow e histórico do incidente ----------------------------------------------------------------------------------
test('store: saveOrThrow confirma; false vira PersistenceError e erro real sai marcado; o incidente sobrevive à recuperação', () => {
  quiet();
  assert.equal(store.saveOrThrow(), true);
  const heal = busy();
  assert.equal(store.save(), false, 'transitório esgotado: save() só devolve false');
  assert.throws(() => store.saveOrThrow(), (e) => e instanceof store.PersistenceError && e.persistence === true && e.code === 'EBUSY' && /EBUSY/.test(e.message));
  assert.equal(store.persistenceStatus().ok, false);
  const inc = store.persistenceIncident(); assert.equal(inc.error, 'EBUSY'); assert.ok(inc.failures >= 2); assert.equal(inc.recoveredAt, null); assert.ok(inc.failedAt);
  heal();
  assert.equal(store.saveOrThrow(), true); assert.equal(store.persistenceStatus().ok, true, 'a gravação seguinte reconcilia (grava o estado inteiro)');
  const after_ = store.persistenceIncident(); assert.equal(after_.error, 'EBUSY', 'o rastro NÃO é apagado pela recuperação'); assert.ok(after_.recoveredAt); assert.ok(after_.failures >= inc.failures);
  assert.ok(db.activity.some((a) => a.persistence === 'failed') && db.activity.some((a) => a.persistence === 'restored'));
  const fix = eisdir();
  assert.throws(() => store.saveOrThrow(), (e) => e.code === 'EISDIR' && e.persistence === true && !(e instanceof store.PersistenceError), 'erro real: o mesmo erro, só marcado');
  fix(); assert.equal(store.saveOrThrow(), true);
  mock.restoreAll();
});

// ---- ciclo: falha transitória (recuperável) -------------------------------------------------------------------------------------
test('transitória: o portão tenta de novo, o disco volta, o ciclo segue SEM duplicar a rodada e conclui; o incidente fica registrado', async () => {
  quiet();
  const r = rig(), m = mkMission(); let heal;
  const planner = scripted([async () => { heal = busy(); trySave(); setTimeout(() => heal(), 50); return cont('A'); }, done()]); // o disco falha DURANTE a consulta; volta 50 ms depois
  const cy = mkCycle(r, planner, [300, 300, 300]);
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  assert.equal(m.cycle.status, 'completed'); assert.equal(m.cycle.rounds.length, 1); assert.equal(r.started.length, 1, 'a ação não foi duplicada'); assert.equal(m.tasks.length, 1);
  assert.equal(diskMission(m.id).cycle.status, 'completed', 'o estado final está no disco');
  assert.equal(store.persistenceStatus().ok, true); const inc = store.persistenceIncident(); assert.ok(inc.recoveredAt && inc.failures >= 2);
  mock.restoreAll();
});

// ---- ciclo: falha persistente (bloqueia) --------------------------------------------------------------------------------------
test('persistente (erro real): o ciclo BLOQUEIA antes de iniciar o Executor, o disco fica com o último estado gravado e a retomada é recusada até o disco voltar', async () => {
  quiet();
  const r = rig(), m = mkMission(); let fix;
  const planner = scripted([async () => { fix = eisdir(); trySave(); return cont('A'); }, blocked('de novo')]);
  const cy = mkCycle(r, planner);
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  const c = m.cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'persistence_failed'); assert.match(c.blockedReason, /Falha de persistência.*não pôde ser gravado/);
  assert.equal(r.started.length, 0, 'o Executor NÃO foi iniciado'); assert.equal(c.rounds.length, 0); assert.equal(m.tasks.length, 0); assert.equal(planner.calls.length, 1);
  assert.equal(store.persistenceStatus().ok, false); assert.equal(diskMission(m.id).cycle.status, 'planning', 'o disco mantém o último estado gravado (nada foi declarado)');
  // não retoma enquanto o estado persistido não for reconciliado
  const snap = JSON.stringify(c), res = await cy.resume(m.id, { note: 'x' });
  assert.equal(res.status, 503); assert.match(res.error, /não está sendo gravado/); assert.equal(JSON.stringify(c), snap, 'a recusa não altera nada'); assert.equal(planner.calls.length, 1);
  fix();
  assert.equal((await cy.resume(m.id, { note: 'disco normalizado' })).status, 202); await settle(cy.idle());
  assert.equal(planner.calls.length, 2); assert.equal(c.blockedCode, 'planner_blocked', 'seguiu o fluxo normal depois de reconciliar');
  assert.ok(db.activity.some((a) => /Persistência reconciliada/.test(a.message) && a.missionId === m.id));
  assert.equal(diskMission(m.id).cycle.blockedCode, 'planner_blocked', 'e o disco acompanha');
  mock.restoreAll();
});

test('persistente (transitório ESGOTADO): depois das tentativas o ciclo bloqueia; nenhuma rodada, e o 503 vale para retomar e para iniciar outro ciclo', async () => {
  quiet();
  const r = rig(), m = mkMission(), other = mkMission(); let heal;
  const planner = scripted([async () => { heal = busy(); trySave(); return cont('A'); }, blocked('fim')]);
  const cy = mkCycle(r, planner, [0, 0]);
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  assert.equal(m.cycle.blockedCode, 'persistence_failed'); assert.equal(r.started.length, 0); assert.equal(m.cycle.rounds.length, 0);
  assert.equal((await cy.resume(m.id)).status, 503);
  const s = await cy.start(other.id, 3); assert.equal(s.status, 503); assert.equal(other.cycle, undefined, 'nenhum ciclo foi criado'); assert.equal(planner.calls.length, 1, 'o Planner não foi consultado');
  heal();
  assert.equal((await cy.resume(m.id)).status, 202); await settle(cy.idle()); assert.equal(m.cycle.blockedCode, 'planner_blocked');
  assert.equal((await cy.start(other.id, 3)).status, 202); await settle(cy.idle());
  mock.restoreAll();
});

test('conclusão NÃO gravada: o ciclo não vira "completed" (nem em memória, nem na atividade); bloqueia, e conclui depois de reconciliar', async () => {
  quiet();
  const r = rig(), m = mkMission(); let fix;
  const planner = scripted([cont('A'), async () => { fix = eisdir(); return done(); }, done()]);
  const cy = mkCycle(r, planner);
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  const c = m.cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'persistence_failed');
  assert.equal(c.finishedAt, null); assert.equal(c.finalSummary, null); assert.equal(c.evidence, null); assert.equal(c.assurance, undefined, 'o que a conclusão tinha preenchido foi desfeito');
  assert.equal(c.rounds[0].decision, null, 'a decisão "complete" não ficou registrada na rodada'); assert.ok(!db.activity.some((a) => a.missionId === m.id && /declarou a missão concluída/.test(a.message)));
  assert.notEqual(diskMission(m.id).cycle.status, 'completed'); assert.equal(m.tasks.filter((t) => t.status === 'running').length, 0);
  assert.equal((await cy.resume(m.id)).status, 503);
  fix();
  assert.equal((await cy.resume(m.id)).status, 202); await settle(cy.idle());
  assert.equal(c.status, 'completed'); assert.equal(diskMission(m.id).cycle.status, 'completed'); assert.ok(diskMission(m.id).cycle.finalSummary);
  assert.equal(r.started.length, 1, 'a rodada concluída antes da falha NÃO foi repetida');
  mock.restoreAll();
});

test('início do ciclo/retomada: sem gravação confirmada nada nasce (rollback) e o 503 explica; com o disco saudável o comportamento é o de sempre', async () => {
  quiet();
  const r = rig(), m = mkMission(), planner = scripted([blocked('fim')]), cy = mkCycle(r, planner);
  const heal = busy(); trySave();                                              // o banco já falhou; ainda não houve gravação bem-sucedida
  const res = await cy.start(m.id, 3);
  assert.equal(res.status, 503); assert.match(res.error, /Nada foi iniciado/); assert.equal(m.cycle, undefined); assert.equal(planner.calls.length, 0);
  heal();
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle()); assert.equal(m.cycle.blockedCode, 'planner_blocked');
  mock.restoreAll();
});

// ---- cancelamento e nova tentativa do Planner ------------------------------------------------------------------------------------
test('cancelar durante as tentativas de gravação: o ciclo termina "cancelled" (não vira bloqueio por persistência) e o Executor não é iniciado', async () => {
  quiet();
  const r = rig(), m = mkMission(); let heal, cy, cancelled;
  // o disco falha DURANTE a consulta; o cancelamento chega enquanto o portão espera a próxima tentativa
  const planner = scripted([async () => { heal = busy(); trySave(); setTimeout(() => { cancelled = cy.cancel(m.id); }, 50); return cont('A'); }]);
  cy = mkCycle(r, planner, [300, 300, 300]);
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  assert.equal((await settle(cancelled)).status, 200);
  const c = m.cycle;
  assert.equal(c.status, 'cancelled'); assert.equal(c.blockedCode, null, 'o cancelamento não foi trocado por um bloqueio');
  assert.equal(r.started.length, 0, 'o Executor NÃO foi iniciado'); assert.equal(c.rounds.length, 0); assert.equal(m.tasks.length, 0); assert.equal(planner.calls.length, 1);
  heal(); assert.equal(store.save(), true); assert.equal(diskMission(m.id).cycle.status, 'cancelled', 'e o estado final chega ao disco quando ele volta');
  mock.restoreAll();
});

test('Planner: erro REAL de gravação ao registrar uma resposta rejeitada vira falha de persistência (não erro interno) e o Planner não é consultado de novo', async () => {
  quiet();
  const r = rig(), m = mkMission(); let fix;
  const planner = scripted([async () => { fix = eisdir(); return 'resposta sem JSON'; }, cont('A')]);
  const cy = mkCycle(r, planner);
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  const c = m.cycle;
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'persistence_failed'); assert.equal(planner.calls.length, 1); assert.equal(r.started.length, 0);
  fix(); mock.restoreAll();
});

test('Planner: a nova tentativa só acontece com a rejeição gravada — com a gravação falhando (transitório esgotado) o ciclo bloqueia sem uma 2ª consulta; reconciliado, retoma', async () => {
  quiet();
  const r = rig(), m = mkMission(); let heal;
  const planner = scripted([async () => { heal = busy(); return 'resposta sem JSON'; }, blocked('fim')]);
  const cy = mkCycle(r, planner, [0, 0]);
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  const c = m.cycle;
  assert.equal(c.blockedCode, 'persistence_failed'); assert.equal(planner.calls.length, 1, 'nenhuma 2ª chamada (e nenhum custo) com o estado sem gravar'); assert.equal(c.rejections.length, 1);
  assert.equal(r.started.length, 0);
  heal();
  assert.equal((await cy.resume(m.id)).status, 202); await settle(cy.idle());
  assert.equal(planner.calls.length, 2); assert.equal(c.blockedCode, 'planner_blocked', 'depois de reconciliar o fluxo segue normalmente');
  mock.restoreAll();
});

test('início da execução (save()==false): o filho é ENCERRADO, a tarefa falha sem PID e o ciclo bloqueia como falha de persistência (sem contar como falha do Executor)', async () => {
  quiet();
  const r = rig(), m = mkMission(); let heal;
  const armed = async (...a) => { heal = busy(); return r.startTaskRun(...a); };    // só a gravação de DENTRO de startTaskRun falha
  const planner = scripted([cont('A', 'sleep')]);
  const cy = createCycle({ db, executor: r.executor, planner, startTaskRun: armed, listFiles: () => [], persistRetryMs: [0] });
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  const c = m.cycle, t = m.tasks[0];
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'persistence_failed'); assert.equal(c.consecutiveFailures, 0); assert.equal(c.rounds[0].status, 'failed');
  assert.equal(r.started.length, 1); assert.equal(await (async () => { for (let i = 0; i < 100 && pidAlive(r.started[0].pid); i++) await sleep(50); return pidAlive(r.started[0].pid); })(), false, 'o processo foi encerrado');
  assert.equal(t.status, 'failed'); assert.equal('pid' in t, false); assert.equal(r.executor.isBusy(), false); assert.equal(planner.calls.length, 1);
  heal(); mock.restoreAll();
});

// ---- queda com o disco falhando: último estado válido ----------------------------------------------------------------------------
// Fica ANTES dos testes do M1: o "boot" recarrega o banco (store.load()) e a variável `db` deste arquivo deixa de ser a do store; os testes do M1 só usam store.get().
test('queda durante a falha de persistência: o boot lê o último estado gravado (nunca um "concluído" não gravado), recupera como "restarted" e o .bak segue válido', async () => {
  quiet();
  const r = rig(), m = mkMission(); let fix;
  const planner = scripted([cont('A'), async () => { fix = eisdir(); return done(); }]);
  const cy = mkCycle(r, planner);
  assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle());
  assert.equal(m.cycle.blockedCode, 'persistence_failed'); assert.equal(diskMission(m.id).cycle.status, 'planning', 'o disco só tem o último estado gravado');
  // "queda": o processo morre sem conseguir gravar nada além disso; o armazenamento volta e o novo boot relê o disco
  fix(); mock.restoreAll();
  const db2 = store.load(), m2 = db2.missions.find((x) => x.id === m.id);
  assert.equal(m2.cycle.status, 'planning', 'relido como estava no disco: não existe "completed" que não foi gravado'); assert.equal(m2.cycle.finalSummary, null);
  const baked = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json.bak'), 'utf8'));
  assert.equal(store.validateDb(baked), null, 'o .bak continua sendo um estado válido');
  const executor2 = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] }), { startTaskRun } = setupExecution(express(), { db: db2, executor: executor2 });
  const cy2 = createCycle({ db: db2, executor: executor2, planner: scripted([done()]), startTaskRun, listFiles: () => [], persistRetryMs: [0, 0] });
  cy2.recover();
  assert.equal(m2.cycle.status, 'blocked'); assert.equal(m2.cycle.blockedCode, 'restarted');
  assert.equal((await cy2.resume(m.id)).status, 202); await settle(cy2.idle());
  assert.equal(m2.cycle.status, 'completed'); assert.equal(m2.cycle.rounds.length, 1, 'a rodada já feita não foi repetida'); assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).missions.find((x) => x.id === m.id).cycle.status, 'completed');
});

// ---- interação com o M1 -----------------------------------------------------------------------------------------------------------
test('M1: registro do PID com save()==false => o filho do Planner e do verificador é ENCERRADO e a operação falha (nunca um processo sem rastro no disco)', async () => {
  quiet();
  const reg = createChildRegistry();
  const wsPkg = path.join(tmp, 'pkgws'); fs.mkdirSync(wsPkg); fs.writeFileSync(path.join(wsPkg, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'echo t' } }));
  const heal = busy();
  assert.throws(() => reg.track('planner', process.pid), (e) => e.persistence === true && e.code === 'EBUSY');
  assert.equal(store.get()[CHILD_KEY].length, 0, 'nada ficou registrado em memória');
  let plannerPid = null; const planner = createClaudePlanner({ runnerOptions: { command: process.execPath, prefixArgs: [FAKE] }, track: (k, pid) => { plannerPid = pid; spawned.add(pid); return reg.track(k, pid); } });
  const pr = await planner.decide({ prompt: 'MODE:sleep', cwd: tmp });
  assert.match(pr.error, /registrar o processo do Planner \(EBUSY\)/); for (let i = 0; i < 100 && pidAlive(plannerPid); i++) await sleep(50);
  assert.equal(pidAlive(plannerPid), false); assert.equal(planner.busy(), false);
  let vpid = null; const v = createVerifier({ spawnSpec: () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }), track: (k, pid) => { vpid = pid; spawned.add(pid); return reg.track(k, pid); } });
  const vr = await v.run({ path: wsPkg }, { id: 'test', script: 'test', command: 'echo t', required: true, timeoutMs: 20_000 });
  assert.equal(vr.status, 'error'); assert.match(vr.reason, /registrar o processo da verificação/); assert.equal(pidAlive(vpid), false); assert.equal(v.isBusy(), false);
  heal(); mock.restoreAll();
});

test('M1: boot com a gravação falhando — reclaim não lança, o órfão é encerrado e, como o registro antigo ficou no disco, o boot seguinte o trata como "já encerrado"', async () => {
  quiet();
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); spawned.add(child.pid);
  const exited = new Promise((r) => child.on('exit', r)), startedAt = new Date().toISOString();
  (store.get()[CHILD_KEY] ??= []).push({ id: 'proc_o', kind: 'verifier', pid: child.pid, startedAt }); store.save();
  const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const heal = busy();
  const res = createChildRegistry().reclaim({ executor });
  assert.equal(res[0].outcome, 'killed'); await settle(exited); assert.equal(pidAlive(child.pid), false); assert.equal(executor.isBusy(), false);
  assert.equal(disk()[CHILD_KEY].length, 1, 'a remoção não chegou ao disco (gravação falhando)');
  heal(); mock.restoreAll();
  store.load();                                                                           // "boot seguinte": relê o disco
  const again = createChildRegistry().reclaim({ executor });
  assert.deepEqual(again.map((x) => x.outcome), ['gone']); assert.equal(store.get()[CHILD_KEY].length, 0); assert.equal(disk()[CHILD_KEY].length, 0);
});

test('M1: shutdown com a gravação falhando — Planner e verificador são encerrados, nada lança, o flush não impede a liberação da trava', async () => {
  quiet();
  const reg = createChildRegistry();
  const wsPkg = path.join(tmp, 'pkgws');
  let ppid = null, vpid = null;
  const planner = createClaudePlanner({ runnerOptions: { command: process.execPath, prefixArgs: [FAKE] }, track: (k, pid) => { ppid = pid; spawned.add(pid); return reg.track(k, pid); } });
  const verifier = createVerifier({ spawnSpec: () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }), track: (k, pid) => { vpid = pid; spawned.add(pid); return reg.track(k, pid); } });
  const pc = planner.decide({ prompt: 'MODE:sleep', cwd: tmp }), vc = verifier.run({ path: wsPkg }, { id: 'test', script: 'test', command: 'echo t', required: true, timeoutMs: 20_000 });
  for (let i = 0; i < 200 && !(store.get()[CHILD_KEY].length === 2); i++) await sleep(25);
  assert.equal(store.get()[CHILD_KEY].length, 2);
  const heal = busy(), proc = new EventEmitter(), log = [];
  installShutdown({ lock: { release: () => log.push('release') }, executor: { killActiveSync: () => log.push('executor') }, children: [planner, verifier], store: { flush: () => { log.push('flush'); return store.flush(); } }, proc, exit: (c) => log.push(`exit:${c}`) });
  assert.doesNotThrow(() => proc.emit('SIGTERM'));
  assert.deepEqual(log, ['executor', 'flush', 'release', 'exit:143']);
  assert.equal(pidAlive(ppid), false); assert.equal(pidAlive(vpid), false);
  assert.equal(store.get()[CHILD_KEY].length, 0, 'processos comprovadamente encerrados saem do registro em memória');
  assert.equal(disk()[CHILD_KEY].length, 2, 'o disco (que não aceitou gravar) ainda tem os registros: no próximo boot os PIDs não existem mais => "gone"');
  heal(); mock.restoreAll(); await settle(pc); await settle(vc);
});
