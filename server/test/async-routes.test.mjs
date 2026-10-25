// P7: rotas assíncronas (3 do ciclo, /run e /stop) devolvem 500 estruturado quando algo lança, sem rejeição não tratada e sem derrubar o processo.
// Express LOCAL em porta aleatória (o index.js/servidor real nunca é importado), banco TEMPORÁRIO, executor com métodos substituídos.
import test, { mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-routes-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir });
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { setupCycle } = await import('../cycle.js');
const { asyncRoute } = await import('../async-route.js');

const unhandled = [];
const onUnhandled = (e) => unhandled.push(e);
process.on('unhandledRejection', onUnhandled);
let db, server, base, executor, seq = 0;
const T0 = '2026-01-01T00:00:00.000Z';

before(async () => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const app = express(); app.use(express.json());
  const { startTaskRun } = setupExecution(app, { db, executor });
  setupCycle(app, { db, executor, planner: { busy: () => false, cancel: async () => {}, decide: async () => ({ error: 'não usado' }) }, startTaskRun, verifier: null });
  app.post('/teste/lanca-depois-de-responder', asyncRoute(async (req, res) => { res.status(200).write('parcial'); throw new Error('depois dos cabeçalhos'); }));
  app.post('/teste/lanca-sincrono', asyncRoute(() => { throw new Error('síncrono'); }));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { process.off('unhandledRejection', onUnhandled); mock.restoreAll(); server.close(); server.closeAllConnections?.(); await new Promise((r) => setTimeout(r, 600)); fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const quiet = () => mock.method(console, 'error', () => {});
const blockedMission = (over = {}) => {
  const m = { id: `m${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: T0, tasks: [],
    cycle: { id: `c${seq}`, status: 'blocked', maxIterations: 3, plannerCalls: 1, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [{ code: 'planner_blocked', reason: 'x', at: T0 }], blockedCode: 'planner_blocked', blockedReason: 'x', finalSummary: null, evidence: null, cancelRequested: false, startedAt: T0, finishedAt: null, rounds: [], ...over } };
  db.missions.push(m); return m;
};
const expect500 = async (res) => {
  assert.equal(res.status, 500); assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json(); assert.deepEqual(body, { error: 'Erro interno.' }); assert.ok(!JSON.stringify(body).includes(tmp), 'a resposta não vaza caminhos internos');
};
const stillAlive = async () => assert.equal((await post('/api/missions/inexistente/cycle/start')).status, 404, 'o servidor continua respondendo normalmente');
const failDbRename = () => { const real = fs.renameSync; mock.method(fs, 'renameSync', (a, b, ...r) => { if (String(b).endsWith('db.json')) { const e = new Error('EIO: simulado'); e.code = 'EIO'; throw e; } return real(a, b, ...r); }); };

test('cancel de ciclo bloqueado com save() lançando (end -> emit -> save): 500 estruturado, sem rejeição não tratada, servidor vivo', async () => {
  quiet(); const m = blockedMission();
  failDbRename();
  await expect500(await post(`/api/missions/${m.id}/cycle/cancel`));
  mock.restoreAll();
  assert.deepEqual(unhandled, []); await stillAlive();
});

test('start com o executor rejeitando (probe) e resume com ciclo corrompido (sem humanNotes): 500 estruturado nos dois', async () => {
  quiet();
  const realProbe = executor.probe; executor.probe = async () => { throw new Error('probe explodiu'); };
  const idle = { id: `m${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: T0, tasks: [] }; db.missions.push(idle);
  try { await expect500(await post(`/api/missions/${idle.id}/cycle/start`, { maxIterations: 2 })); } finally { executor.probe = realProbe; }
  const bad = blockedMission(); delete bad.cycle.humanNotes;
  await expect500(await post(`/api/missions/${bad.id}/cycle/resume`));
  mock.restoreAll();
  assert.deepEqual(unhandled, []); await stillAlive();
  // e depois do erro a reserva de início foi liberada: um start normal volta a funcionar (aqui recusado só por validação, sem travar)
  assert.equal((await post(`/api/missions/${idle.id}/cycle/start`, { maxIterations: 99 })).status, 400);
});

test('/run (startTaskRun rejeita) e /stop (executor.stop rejeita): 500 estruturado e servidor vivo', async () => {
  quiet();
  const task = { id: `t${++seq}`, title: 'tarefa', status: 'queued', authorized: true, dependsOn: [], report: '', files: [], log: [] };
  const m = { id: `m${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: T0, tasks: [task] }; db.missions.push(m);
  const realProbe = executor.probe, realStop = executor.stop;
  executor.probe = async () => { throw new Error('probe explodiu'); };
  try { await expect500(await post(`/api/missions/${m.id}/tasks/${task.id}/run`)); } finally { executor.probe = realProbe; }
  executor.stop = async () => { throw new Error('stop explodiu'); };
  try { await expect500(await post('/api/execution/stop')); } finally { executor.stop = realStop; }
  mock.restoreAll();
  assert.deepEqual(unhandled, []); await stillAlive();
});

test('respostas normais e códigos existentes preservados (400, 404, 409 e /stop 200)', async () => {
  const none = { id: `m${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: T0, tasks: [] }; db.missions.push(none);
  assert.equal((await post('/api/missions/inexistente/cycle/start')).status, 404);
  assert.equal((await post(`/api/missions/${none.id}/cycle/start`, { maxIterations: 99 })).status, 400);
  assert.equal((await post(`/api/missions/${none.id}/cycle/cancel`)).status, 409); assert.equal((await post(`/api/missions/${none.id}/cycle/resume`)).status, 409);
  assert.equal((await post(`/api/missions/${none.id}/tasks/nao-existe/run`)).status, 404);
  const stop = await post('/api/execution/stop'); assert.equal(stop.status, 200); assert.deepEqual(await stop.json(), { stopped: false, detail: 'Nenhuma execução ativa.' });
  assert.deepEqual(unhandled, []);
});

test('asyncRoute: erro depois de começar a responder não gera segunda resposta nem pendura; erro síncrono também vira 500', async () => {
  quiet();
  const r = await post('/teste/lanca-depois-de-responder'); assert.equal(r.status, 200); assert.equal(await r.text(), 'parcial');
  await expect500(await post('/teste/lanca-sincrono'));
  mock.restoreAll(); assert.deepEqual(unhandled, []); await stillAlive();
});
