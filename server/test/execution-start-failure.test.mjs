// F1 do P7: se registrar o início da execução falhar (store.save() lançando) DEPOIS de o processo filho ter sido iniciado, o filho não pode ficar
// rodando sem acompanhamento. Só são criados/encerrados processos DESTES testes (a CLI falsa em modo "sleep"); banco TEMPORÁRIO; Express local
// em porta aleatória. O servidor real nunca é tocado.
import test, { mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-startfail-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir });
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { pidAlive } = await import('../instance-lock.js');
const { killTreeSync } = await import('../orphans.js');

const unhandled = [], spawned = new Set();
const onUnhandled = (e) => unhandled.push(e);
process.on('unhandledRejection', onUnhandled);
let db, seq = 0, server, base;
before(() => { db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }]; });
after(async () => { process.off('unhandledRejection', onUnhandled); mock.restoreAll(); for (const pid of spawned) killTreeSync(pid); server?.close(); server?.closeAllConnections?.(); await new Promise((r) => setTimeout(r, 600)); fs.rmSync(tmp, { recursive: true, force: true }); });

/** Executor real (CLI falsa) que registra o PID e o handle de cada start(). */
function rig() {
  const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] }), started = [], realStart = executor.start;
  executor.start = (o) => { const h = realStart(o); started.push(h); spawned.add(h.pid); return h; };
  return { executor, started };
}
const mkTask = (mode = 'sleep') => ({ id: `t${++seq}`, title: `tarefa ${seq}`, status: 'queued', authorized: true, dependsOn: [], report: '', files: [], log: [], instructions: `MODE:${mode} teste` });
const mkMission = (tasks = []) => { const m = { id: `m${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: '2026-01-01T00:00:00.000Z', tasks }; db.missions.push(m); return m; };
const quiet = () => mock.method(console, 'error', () => {});
/** save() passa a lançar um erro REAL de disco (EIO) — o 1º save de startTaskRun é o que vem logo depois de o processo existir. */
const failSave = () => { const real = fs.renameSync; mock.method(fs, 'renameSync', (a, b, ...r) => { if (String(b).endsWith('db.json')) { const e = new Error('EIO: simulado'); e.code = 'EIO'; throw e; } return real(a, b, ...r); }); };
const settle = (p, ms = 10_000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), ms))]);

test('startTaskRun: save() lançando depois de iniciar o filho => o processo é ENCERRADO, o executor liberado e a tarefa fica "failed" sem PID; o erro original sobe', async () => {
  quiet();
  const { executor, started } = rig(), { startTaskRun } = setupExecution(express(), { db, executor });
  const t = mkTask(), m = mkMission([t]);
  failSave();
  await assert.rejects(() => startTaskRun(m, t), (e) => e.code === 'EIO');
  mock.restoreAll();
  assert.equal(started.length, 1, 'o processo chegou a ser iniciado'); const { pid, done } = started[0];
  assert.equal(pidAlive(pid), false, 'e foi encerrado: não sobrou filho sem acompanhamento');
  assert.equal((await settle(done)).status, 'interrupted', 'a finalização do executor foi concluída (listeners e estado limpos)');
  assert.equal(executor.isBusy(), false); assert.equal(executor.current(), null);
  assert.equal(t.status, 'failed'); assert.equal(t.authorized, false); assert.equal('pid' in t, false); assert.ok(t.finishedAt); assert.match(t.error, /Falha ao registrar o início da execução \(EIO\); o processo foi encerrado/);
  assert.deepEqual(unhandled, []);
  // o executor continua utilizável: uma execução normal logo em seguida funciona
  const t2 = mkTask('ok'); m.tasks.push(t2);
  const r = await startTaskRun(m, t2); assert.equal(r.ok, true); await settle(r.finished); assert.equal(t2.status, 'awaiting_approval');
  mock.restoreAll();
});

test('rota /run: 500 estruturado (P7), servidor vivo e nenhum filho sem acompanhamento', async () => {
  quiet();
  const { executor, started } = rig(), app = express(); app.use(express.json());
  setupExecution(app, { db, executor });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = `http://127.0.0.1:${server.address().port}`;
  const t = mkTask(), m = mkMission([t]);
  failSave();
  const res = await fetch(`${base}/api/missions/${m.id}/tasks/${t.id}/run`, { method: 'POST' });
  mock.restoreAll(); quiet();
  assert.equal(res.status, 500); assert.deepEqual(await res.json(), { error: 'Erro interno.' });
  assert.equal(started.length, 1); assert.equal(pidAlive(started[0].pid), false); assert.equal(executor.isBusy(), false); assert.equal(t.status, 'failed');
  assert.equal((await fetch(`${base}/api/missions/inexistente/tasks/x/run`, { method: 'POST' })).status, 404, 'o servidor continua respondendo');
  assert.deepEqual(unhandled, []);
  mock.restoreAll();
});

test('ciclo: a falha no início da rodada bloqueia o ciclo (falha de persistência, M2), a rodada e a tarefa ficam "failed" e o filho é encerrado', async () => {
  quiet();
  const { executor, started } = rig(), { startTaskRun } = setupExecution(express(), { db, executor });
  const calls = [];
  const planner = { busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); return calls.length === 1 ? { text: JSON.stringify({ decision: 'continue', rationale: 'r', task: { title: 'Longa', instructions: 'MODE:sleep longa', acceptance: ['a'] } }) } : { error: 'não deveria ser consultado' }; } };
  const armed = async (...a) => { failSave(); return startTaskRun(...a); };                     // só a gravação de DENTRO de startTaskRun passa a falhar (as anteriores do ciclo funcionam)
  const cy = createCycle({ db, executor, planner, startTaskRun: armed, listFiles: () => [] });
  const m = mkMission();
  try { assert.equal((await cy.start(m.id, 3)).status, 202); await settle(cy.idle()); } finally { mock.restoreAll(); }
  const c = m.cycle, t = m.tasks[0];
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'persistence_failed'); assert.equal(c.rounds[0].status, 'failed'); assert.equal(t.status, 'failed'); assert.equal('pid' in t, false); // M2: antes 'internal_error' (genérico)
  assert.equal(started.length, 1); assert.equal(pidAlive(started[0].pid), false, 'o filho não ficou rodando com o ciclo bloqueado'); assert.equal(executor.isBusy(), false);
  assert.equal(calls.length, 1, 'o Planner não foi consultado de novo'); assert.deepEqual(unhandled, []);
});

test('sem falha de gravação o início da execução é idêntico ao de antes (task running com PID, finalização ligada)', async () => {
  quiet();
  const { executor, started } = rig(), { startTaskRun } = setupExecution(express(), { db, executor });
  const t = mkTask('sleep'), m = mkMission([t]);
  const r = await startTaskRun(m, t);
  assert.equal(r.ok, true); assert.equal(t.status, 'running'); assert.equal(t.pid, started[0].pid); assert.equal(pidAlive(t.pid), true);
  assert.equal((await executor.stop()).stopped, true); await settle(r.finished);
  assert.equal(t.status, 'interrupted'); assert.equal('pid' in t, false); assert.equal(pidAlive(started[0].pid), false);
  mock.restoreAll();
});

// ---- encerramento NÃO confirmado: o PID real fica na tarefa para a recuperação de órfãs (P4) -------------------------------------------------
test('executor.stop() sem confirmar (stopped:false) e processo vivo: PID mantido na tarefa, executor ocupado (sem execução concorrente), erro original lançado', async () => {
  quiet();
  const { executor, started } = rig(), { startTaskRun } = setupExecution(express(), { db, executor });
  const realStop = executor.stop; executor.stop = async () => ({ stopped: false, detail: 'O processo não confirmou o encerramento em 8 s.' });   // o processo segue vivo
  const t = mkTask(), m = mkMission([t]), other = mkTask('ok'); m.tasks.push(other);
  failSave();
  await assert.rejects(() => startTaskRun(m, t), (e) => e.code === 'EIO');
  mock.restoreAll(); quiet();
  const { pid } = started[0];
  assert.equal(pidAlive(pid), true, 'o processo continua vivo (o encerramento não foi confirmado)');
  assert.equal(t.status, 'failed'); assert.equal(t.authorized, false); assert.equal(t.pid, pid, 'o PID real foi preservado'); assert.ok(t.startedAt, 'e o startedAt, necessário para confirmar a identidade'); assert.ok(t.finishedAt);
  assert.match(t.error, /EIO.*NÃO foi confirmado.*PID \d+ mantido/);
  assert.equal(executor.isBusy(), true, 'o executor continua ocupado até o processo terminar');
  const r = await startTaskRun(m, other); assert.equal(r.ok, false); assert.match(r.reason, /em andamento/, 'nenhuma execução concorrente');
  assert.throws(() => executor.start({ missionId: m.id, taskId: other.id, cwd: wsDir, prompt: 'x', onLine() {} }), (e) => e.code === 'BUSY');
  assert.deepEqual(unhandled, []);
  // o próximo salvamento bem-sucedido grava o PID e a recuperação de órfãs (P4) identifica e encerra o processo depois de um reinício
  store.save();
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.ORCH_DATA_DIR, 'db.json'), 'utf8')).missions.find((x) => x.id === m.id).tasks.find((x) => x.id === t.id);
  assert.equal(onDisk.pid, pid); assert.equal(onDisk.status, 'failed');
  const { reclaimOrphans } = await import('../orphans.js');
  const [res] = reclaimOrphans([{ pid: onDisk.pid, startedAt: onDisk.startedAt }]);
  assert.equal(res.outcome, 'killed', 'identidade confirmada pela hora de criação: o processo é encerrado pela recuperação'); assert.equal(pidAlive(pid), false);
  await settle(started[0].done); executor.stop = realStop; assert.equal(executor.isBusy(), false);
  mock.restoreAll();
});

test('executor.stop() lançando: o fallback killActiveSync é tentado e, com o processo ainda vivo, o PID é mantido', async () => {
  quiet();
  const { executor, started } = rig(), { startTaskRun } = setupExecution(express(), { db, executor });
  const fallback = []; executor.stop = async () => { throw new Error('stop quebrou'); }; executor.killActiveSync = () => { fallback.push('kill'); };   // o fallback "não adianta"
  const t = mkTask(), m = mkMission([t]);
  failSave();
  await assert.rejects(() => startTaskRun(m, t), (e) => e.code === 'EIO');
  mock.restoreAll();
  const { pid } = started[0];
  assert.deepEqual(fallback, ['kill']); assert.equal(pidAlive(pid), true); assert.equal(t.pid, pid); assert.equal(t.status, 'failed'); assert.equal(t.authorized, false); assert.equal(executor.isBusy(), true);
  killTreeSync(pid); await settle(started[0].done); assert.equal(executor.isBusy(), false);
});

test('stopped:false mas o processo JÁ terminou: não há o que recuperar, o PID é removido e o executor está livre', async () => {
  quiet();
  const { executor, started } = rig(), { startTaskRun } = setupExecution(express(), { db, executor });
  executor.stop = async () => { killTreeSync(started[0].pid); await settle(started[0].done); return { stopped: false, detail: 'Nenhuma execução ativa.' }; };   // morreu sozinho, mas o stop() não reporta "stopped"
  const t = mkTask(), m = mkMission([t]);
  failSave();
  await assert.rejects(() => startTaskRun(m, t), (e) => e.code === 'EIO');
  mock.restoreAll();
  assert.equal(pidAlive(started[0].pid), false); assert.equal('pid' in t, false); assert.equal(t.status, 'failed'); assert.match(t.error, /o processo foi encerrado/); assert.equal(executor.isBusy(), false);
});
