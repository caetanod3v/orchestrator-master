// Renomear ambiente: só o rótulo (displayName) muda; name, path e id ficam. Persiste no disco. Banco TEMPORÁRIO; o index.js (4317, banco real) nunca é importado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wsren-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json');

const { default: express } = await import('express');
const store = await import('../store.js');
const { setupWorkspaceRename } = await import('../workspaces.js');

let db, server, base;
const disk = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const rename = (id, body) => fetch(`${base}/api/workspaces/${id}/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  db = store.load();
  db.workspaces.push({ id: 'w1', name: 'api', path: tmp });
  const app = express(); app.use(express.json());
  setupWorkspaceRename(app, { db });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); server.closeAllConnections?.(); await new Promise((r) => setTimeout(r, 600)); fs.rmSync(tmp, { recursive: true, force: true }); });

test('renomeia só o rótulo, preserva nome original, caminho e id, e persiste em disco', async () => {
  const r = await rename('w1', { displayName: '  Loja   do   Zé  ' });
  assert.equal(r.status, 200);
  const w = await r.json();
  assert.deepEqual([w.id, w.name, w.path, w.displayName], ['w1', 'api', tmp, 'Loja do Zé']);
  assert.equal(db.workspaces.length, 1, 'não duplica o ambiente');
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(disk().workspaces[0].displayName, 'Loja do Zé');
  assert.equal(disk().workspaces[0].name, 'api');
});

test('texto vazio ou igual ao original restaura o nome original', async () => {
  await rename('w1', { displayName: 'Outro' });
  assert.equal((await (await rename('w1', { displayName: '   ' })).json()).displayName, undefined);
  await rename('w1', { displayName: 'Outro' });
  assert.equal((await (await rename('w1', { displayName: 'api' })).json()).displayName, undefined);
});

test('recusa nome longo, tipo inválido e workspace inexistente; caracteres de controle viram espaço', async () => {
  assert.equal((await rename('w1', { displayName: 'x'.repeat(81) })).status, 400);
  assert.equal((await rename('w1', { displayName: 42 })).status, 400);
  assert.equal((await rename('nao-existe', { displayName: 'a' })).status, 404);
  const w = await (await rename('w1', { displayName: 'a\u0000b\u202Ec' })).json();
  assert.equal(w.displayName, 'a b c');
});
