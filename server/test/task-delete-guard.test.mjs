// DELETE de tarefa: tarefas referenciadas por rodadas de ciclo (atual ou anterior) não podem ser removidas, em qualquer status.
// Servidor real (server/index.js via chat-boot.mjs) sobre banco TEMPORÁRIO semeado, porta livre própria; nada real é tocado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-task-del-'));
const dir = path.join(root, 'data'); fs.mkdirSync(dir);
process.env.ORCH_DATA_DIR = dir;
const store = await import('../store.js');
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 500)); fs.rmSync(root, { recursive: true, force: true }); });

const mkTask = (id, status, extra = {}) => ({ id, title: `tarefa ${id}`, status, authorized: false, dependsOn: [], report: '', files: [], log: [], ...extra });
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('tarefa referenciada por rodada não é removida; sem referência continua removível', async () => {
  const db = store.load();
  const statuses = ['completed', 'failed', 'queued', 'awaiting_approval'];
  const refTasks = statuses.map((s) => mkTask(`r-${s}`, s));
  db.missions = [{
    id: 'mis', demo: false, title: 'Missão', objective: 'obj', workspaceId: null, createdAt: store.now(),
    tasks: [...refTasks, mkTask('past', 'completed'), mkTask('livre', 'completed'), mkTask('dep', 'queued', { dependsOn: ['livre'] }), mkTask('dep2', 'queued', { dependsOn: ['r-completed'] })],
    cycle: { id: 'cyc1', status: 'done', maxIterations: 5, rounds: [...refTasks.map((t, i) => ({ n: i + 1, status: 'done', taskId: t.id })), { n: 5, status: 'failed', taskId: null }] }, // taskId nulo = rodada bloqueada pela política: não referencia tarefa
    pastCycles: [{ id: 'cyc0', status: 'done', rounds: [{ n: 1, status: 'done', taskId: 'past' }] }],
  }];
  store.save();

  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(here, 'chat-boot.mjs')], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (let i = 0; i < 100 && !/AI Dev Orchestrator API em/.test(out); i++) await Promise.race([new Promise((r) => setTimeout(r, 100)), exited]);
    assert.match(out, /AI Dev Orchestrator API em/, `servidor não subiu:\n${out}`);
    const del = async (tid) => { const r = await fetch(`${base}/api/missions/mis/tasks/${tid}`, { method: 'DELETE', headers: { origin: 'http://localhost:5173' } }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const tasks = async () => (await (await fetch(`${base}/api/missions`)).json()).find((m) => m.id === 'mis').tasks.map((t) => t.id);

    for (const s of statuses) { const r = await del(`r-${s}`); assert.equal(r.status, 409, `status ${s}`); assert.match(r.body.error, /rodada de ciclo/); }
    assert.equal((await del('past')).status, 409, 'rodada de ciclo anterior também protege');
    assert.equal((await del('nao-existe')).status, 404);
    assert.equal((await del('livre')).status, 204, 'sem referência: removida');
    const dependsOf = async (id) => (await (await fetch(`${base}/api/missions`)).json()).find((m) => m.id === 'mis').tasks.find((t) => t.id === id).dependsOn;
    assert.deepEqual(await dependsOf('dep2'), ['r-completed'], 'exclusão recusada (409) não mexe em dependsOn');
    assert.equal((await del('dep2')).status, 204, 'rodada com taskId nulo não trava a exclusão de outras tarefas');
    const left = await tasks();
    assert.ok(!left.includes('livre')); assert.ok(left.includes('r-completed') && left.includes('past') && left.includes('r-queued'));
    assert.deepEqual((await (await fetch(`${base}/api/missions`)).json()).find((m) => m.id === 'mis').tasks.find((t) => t.id === 'dep').dependsOn, [], 'dependência da removida é limpa');
  } finally { child.kill(); await exited; }
});
