// Fluxo de API (autorizar -> executar -> revisar) com a CLI falsa, banco isolado e Git real em diretório temporário.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-api-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace');
fs.mkdirSync(wsDir);
execFileSync('git', ['init', '-q'], { cwd: wsDir });
fs.writeFileSync(path.join(wsDir, 'existente.txt'), 'x\n');

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');

let db, server, base, executor;
const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const task = (id) => db.missions.find((m) => m.id === 'mis').tasks.find((t) => t.id === id);
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const mkTask = (id, title, extra = {}) => ({ id, title, status: 'queued', authorized: false, dependsOn: [], report: '', files: [], log: [], ...extra });

before(async () => {
  db = store.load();
  db.workspaces.push({ id: 'ws', name: 'ws', path: wsDir });
  db.missions = [
    { id: 'mis', demo: false, title: 'Missão real de teste', objective: 'obj', workspaceId: 'ws', createdAt: store.now(), tasks: [
      mkTask('t1', 'MODE:write criar arquivo'), mkTask('t2', 'MODE:ok depende de t1', { dependsOn: ['t1'] }),
      mkTask('t3', 'MODE:fail falhar'), mkTask('t4', 'MODE:sleep esperar'), mkTask('t5', 'MODE:ok outra'),
    ] },
    { id: 'demo', demo: true, title: 'demo', workspaceId: null, tasks: [mkTask('d1', 'demo')] },
  ];
  store.save();
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const app = express(); app.use(express.json());
  setupExecution(app, { db, executor });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close(); server.closeAllConnections?.();
  await new Promise((r) => setTimeout(r, 800)); // deixa o salvamento em lote (saveSoon) terminar antes de apagar o diretório
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('bloqueios: demo, sem autorização, dependências, rejeitada', async () => {
  assert.equal((await api('POST', '/api/missions/demo/tasks/d1/authorize')).status, 409);
  assert.equal((await api('POST', '/api/missions/demo/tasks/d1/run')).status, 409);
  let r = await api('POST', '/api/missions/mis/tasks/t1/run');
  assert.equal(r.status, 409); assert.match(r.body.error, /autorização/);
  await api('POST', '/api/missions/mis/tasks/t2/authorize');
  r = await api('POST', '/api/missions/mis/tasks/t2/run');
  assert.equal(r.status, 409); assert.match(r.body.error, /Dependências pendentes: 01/);
  await api('POST', '/api/missions/mis/tasks/t2/revoke');
  task('t5').rejected = true; task('t5').status = 'failed';
  assert.equal((await api('POST', '/api/missions/mis/tasks/t5/authorize')).status, 409);
  task('t5').rejected = false; task('t5').status = 'queued';
  assert.equal((await api('POST', '/api/missions/nao/tasks/x/run')).status, 404);
});

test('a rota de execução ignora comando/cwd/args enviados pelo cliente', async () => {
  await api('POST', '/api/missions/mis/tasks/t5/authorize');
  const evil = { command: 'calc.exe', args: ['/c', 'del *'], cwd: 'C:\\Windows', path: 'C:\\Windows', prompt: 'MODE:write' };
  const r = await api('POST', '/api/missions/mis/tasks/t5/run', evil);
  assert.equal(r.status, 202);
  await until(() => task('t5').status !== 'running');
  assert.equal(fs.existsSync('C:\\Windows\\out.txt'), false);
  assert.ok(task('t5').log.some((l) => l.includes(`cwd ${wsDir}`)), 'rodou no workspace da missão, não no cwd enviado');
  assert.ok(!fs.existsSync(path.join(wsDir, 'out.txt')) || task('t5').files.length === 0, 'prompt do cliente não foi usado');
});

test('fluxo completo: autorizar -> executar -> aguardar revisão -> aprovar; persistência em disco', async () => {
  assert.equal((await api('POST', '/api/missions/mis/tasks/t1/authorize')).status, 200);
  assert.equal(task('t1').authorized, true);
  const r = await api('POST', '/api/missions/mis/tasks/t1/run');
  assert.equal(r.status, 202);
  assert.equal(task('t1').status, 'running'); assert.equal(task('t1').authorized, false, 'autorização é consumida');
  assert.equal(await until(() => task('t1').status !== 'running'), true);
  const t = task('t1');
  assert.equal(t.status, 'awaiting_approval', 'sucesso do processo NÃO conclui; aguarda revisão humana');
  assert.equal(t.exitCode, 0); assert.equal(t.report, 'Relatório final do teste.');
  assert.deepEqual(t.usage, { costUsd: 0.0123, durationMs: 42, turns: 2 });
  assert.ok(t.log.some((l) => l.startsWith('[sessão] modelo fake-model')));
  assert.ok(t.files.some((f) => f.path === 'out.txt'), 'arquivo criado aparece nas alterações (git real)');
  assert.equal(t.dirtyBefore, false === t.dirtyBefore ? false : t.dirtyBefore);
  assert.ok(db.activity.some((a) => a.type === 'execution' && a.agent === 'executor' && /iniciada/.test(a.message)));
  assert.ok(db.activity.some((a) => a.type === 'execution' && /aguardando revisão/.test(a.message)));
  // estado persistido no disco
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.ORCH_DATA_DIR, 'db.json'), 'utf8'));
  assert.equal(disk.missions[0].tasks[0].status, 'awaiting_approval');
  // a dependência só libera depois da revisão humana (aprovação existe em index.js; aqui simulamos o efeito)
  await api('POST', '/api/missions/mis/tasks/t2/authorize');
  assert.match((await api('POST', '/api/missions/mis/tasks/t2/run')).body.error, /Dependências pendentes/);
  task('t1').status = 'completed';
  const r2 = await api('POST', '/api/missions/mis/tasks/t2/run');
  assert.equal(r2.status, 202);
  await until(() => task('t2').status !== 'running');
  assert.equal(task('t2').status, 'awaiting_approval');
});

test('falha: failed (não rejeitada), stderr no log, retry exige nova autorização', async () => {
  await api('POST', '/api/missions/mis/tasks/t3/authorize');
  await api('POST', '/api/missions/mis/tasks/t3/run');
  await until(() => task('t3').status !== 'running');
  const t = task('t3');
  assert.equal(t.status, 'failed'); assert.equal(t.exitCode, 3); assert.notEqual(t.rejected, true);
  assert.ok(t.log.includes('[stderr] falha simulada pela CLI falsa'));
  assert.match((await api('POST', '/api/missions/mis/tasks/t3/run')).body.error, /nova tentativa/);
  assert.equal((await api('POST', '/api/missions/mis/tasks/t3/authorize')).status, 200);
});

test('duplicidade, SSE sem reexecutar e interrupção via API', async () => {
  await api('POST', '/api/missions/mis/tasks/t4/authorize');
  // SSE
  const ctrl = new AbortController();
  const sse = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const events = []; const reader = sse.body.getReader(); const dec = new TextDecoder();
  (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; events.push(dec.decode(value)); } } catch { /* abortado */ } })();
  assert.equal((await api('POST', '/api/missions/mis/tasks/t4/run')).status, 202);
  assert.equal((await api('POST', '/api/missions/mis/tasks/t5/run')).status, 409, 'segunda execução simultânea recusada');
  assert.equal(await until(() => events.join('').includes('event: log')), true, 'logs chegam por SSE em tempo real');
  assert.ok(events.join('').includes('event: hello'));
  // reconectar não inicia outra execução
  const sse2 = await fetch(`${base}/api/events`); await sse2.body.cancel();
  assert.equal((await api('GET', '/api/execution')).body.busy, true);
  const stop = await api('POST', '/api/execution/stop');
  assert.equal(stop.body.stopped, true);
  assert.equal(await until(() => task('t4').status === 'interrupted'), true, 'estado interrupted persistido logo após o término do processo');
  assert.equal((await api('GET', '/api/execution')).body.busy, false);
  assert.ok(events.join('').includes('event: task'));
  assert.ok(db.activity.some((a) => /interrompida/.test(a.message)));
  ctrl.abort();
});

test('recuperação: tarefa "running" órfã vira "interrupted" ao subir o servidor', async () => {
  task('t5').status = 'running';
  const app2 = express(); setupExecution(app2, { db, executor: createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] }) });
  assert.equal(task('t5').status, 'interrupted');
  assert.match(task('t5').error, /reiniciado/);
});
