// B1: remover um workspace é recusado enquanto uma missão dele tem execução, ciclo ativo ou ciclo bloqueado.
// A rota é montada com `setupWorkspaceRemoval` num Express próprio (porta aleatória, db injetado, banco TEMPORÁRIO);
// o index.js (porta 4317, banco real) nunca é importado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wsrm-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json');

const { default: express } = await import('express');
const store = await import('../store.js');
const { workspaceRemovalBlocker, setupWorkspaceRemoval } = await import('../workspaces.js');

let db, server, base;
const diskDb = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const del = (id) => fetch(`${base}/api/workspaces/${id}`, { method: 'DELETE' });

before(async () => {
  db = store.load();
  const app = express();
  setupWorkspaceRemoval(app, { db });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); server.closeAllConnections?.(); await new Promise((r) => setTimeout(r, 600)); fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
/** Cria um workspace e (opcionalmente) uma missão dele com o ciclo/tarefa pedidos. */
function setup({ cycle, taskStatus, other } = {}) {
  const id = `ws${++seq}`;
  db.workspaces.push({ id, name: `W${seq}`, path: tmp });
  if (cycle || taskStatus) db.missions.push({ id: `m${seq}`, demo: false, title: 't', workspaceId: id, tasks: taskStatus ? [{ id: 'k', status: taskStatus }] : [], ...(cycle ? { cycle: { status: cycle } } : {}) });
  if (other) db.missions.push({ id: `o${seq}`, demo: false, title: 'outra', workspaceId: other, tasks: [], cycle: { status: 'running' } });
  return id;
}

test('regra pura: só planning, running, blocked e tarefa running bloqueiam; estados terminais e sem ciclo não', () => {
  const rule = (m) => workspaceRemovalBlocker({ missions: [{ workspaceId: 'w', tasks: [], ...m }] }, 'w');
  for (const s of ['planning', 'running']) assert.match(rule({ cycle: { status: s } }), /ciclo em andamento/, s);
  assert.match(rule({ cycle: { status: 'blocked' } }), /ciclo bloqueado.*cancele/);
  for (const s of ['completed', 'cancelled', 'limit_reached']) assert.equal(rule({ cycle: { status: s } }), null, s);
  assert.equal(rule({}), null, 'missão sem ciclo');
  assert.match(rule({ tasks: [{ status: 'running' }] }), /execução em andamento/, 'tarefa running sem ciclo');
  assert.match(rule({ tasks: [{ status: 'running' }], cycle: { status: 'completed' } }), /execução em andamento/, 'tarefa running mesmo com ciclo terminal');
  assert.equal(rule({ tasks: [{ status: 'completed' }, { status: 'failed' }, { status: 'queued' }] }), null);
  assert.equal(workspaceRemovalBlocker({ missions: [{ workspaceId: 'outro', tasks: [{ status: 'running' }], cycle: { status: 'running' } }] }, 'w'), null, 'outro workspace não interfere');
  assert.equal(workspaceRemovalBlocker({ missions: [] }, 'w'), null);
});

test('rota: 409 com mensagem clara e NADA muda para planning, running e blocked', async () => {
  for (const [cycle, msg] of [['planning', /ciclo em andamento/], ['running', /ciclo em andamento/], ['blocked', /ciclo bloqueado.*cancele/]]) {
    const id = setup({ cycle });
    const r = await del(id);
    assert.equal(r.status, 409, cycle); assert.match((await r.json()).error, msg, cycle);
    assert.ok(db.workspaces.some((w) => w.id === id), `${cycle}: continua cadastrado`);
  }
});

test('rota: 409 também para tarefa running sem ciclo e para tarefa running com ciclo terminal', async () => {
  for (const o of [{ taskStatus: 'running' }, { taskStatus: 'running', cycle: 'completed' }]) {
    const id = setup(o);
    const r = await del(id);
    assert.equal(r.status, 409); assert.match((await r.json()).error, /execução em andamento/);
    assert.ok(db.workspaces.some((w) => w.id === id));
  }
});

test('rota: 204, remove, persiste, ajusta o workspace ativo e registra a atividade para completed, cancelled, limit_reached e sem ciclo', async () => {
  for (const cycle of ['completed', 'cancelled', 'limit_reached', undefined]) {
    const keep = setup();                                            // outro workspace para virar o ativo
    const id = setup({ cycle, taskStatus: 'completed' });
    db.settings.activeWorkspaceId = id;
    const r = await del(id);
    assert.equal(r.status, 204, String(cycle));
    assert.ok(!db.workspaces.some((w) => w.id === id), 'removido da memória');
    assert.notEqual(db.settings.activeWorkspaceId, id, 'o workspace ativo deixou de apontar para o removido');
    assert.ok(db.activity.some((a) => a.type === 'workspace' && /Workspace removido do cadastro: W\d+ \(arquivos intactos\)/.test(a.message)));
    const disk = diskDb();
    assert.ok(!disk.workspaces.some((w) => w.id === id), 'removido do disco (db TEMPORÁRIO)'); assert.ok(disk.workspaces.some((w) => w.id === keep));
  }
});

test('rota: workspace inexistente => 404; ciclo ativo de OUTRO workspace não bloqueia', async () => {
  const r = await del('ws_nao_existe');
  assert.equal(r.status, 404); assert.match((await r.json()).error, /não encontrado/);
  const busy = setup({ cycle: 'running' });
  const free = setup({ other: busy });                               // a missão em ciclo `running` pertence a `busy`, não a `free`
  assert.equal((await del(free)).status, 204);
  assert.ok(db.workspaces.some((w) => w.id === busy), 'o workspace em uso não foi tocado');
  assert.equal((await del(busy)).status, 409);
});

test('depois de cancelar o ciclo bloqueado, a exclusão passa (fluxo pedido pela decisão de produto)', async () => {
  const id = setup({ cycle: 'blocked' });
  assert.equal((await del(id)).status, 409);
  db.missions.find((m) => m.workspaceId === id).cycle.status = 'cancelled';
  assert.equal((await del(id)).status, 204);
});
