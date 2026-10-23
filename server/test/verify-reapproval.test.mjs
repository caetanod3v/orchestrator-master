// Regressão: aprovar "node --test", alterar, restaurar, reaprovar e recarregar do disco.
// Verificador REAL (política, pinagem, leitura do package.json) com processo SIMULADO no lugar do npm.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reapp-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKEV = path.join(HERE, 'fake-verify.mjs');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir);
const pkg = path.join(wsDir, 'package.json');
const setTest = (text, extra = {}) => fs.writeFileSync(pkg, JSON.stringify({ name: 'p', scripts: { test: text, ...extra } }));
const spawnSpec = (s) => ({ command: process.execPath, args: [FAKEV, s] });

const { default: express } = await import('express');
const store = await import('../store.js');
const { createVerifier, setupVerification } = await import('../verify.js');

let db, server, base;
const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const approve = () => call('PUT', '/api/workspaces/w1/verifications', { items: [{ script: 'test', required: true }] });

before(async () => {
  db = store.load();
  db.workspaces.push({ id: 'w1', name: 'Teste', path: wsDir });
  const app = express(); app.use(express.json());
  setupVerification(app, { db, verifier: createVerifier({ spawnSpec }) });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); server.closeAllConnections?.(); await new Promise((r) => setTimeout(r, 500)); fs.rmSync(tmp, { recursive: true, force: true }); });

test('aprovar "node --test" fixa exatamente esse texto e a verificação passa', async () => {
  setTest('node --test');
  const r = await approve();
  assert.equal(r.status, 200); assert.equal(r.body[0].command, 'node --test');
  const res = await createVerifier({ spawnSpec }).run(db.workspaces[0], db.workspaces[0].verifications[0]);
  assert.equal(res.status, 'pass');
});

test('alterar -> bloqueia (com os dois textos na mensagem) -> restaurar -> volta a passar, SEM nova aprovação e com o mesmo verificador', async () => {
  const v = createVerifier({ spawnSpec });
  const item = db.workspaces[0].verifications[0];
  assert.equal((await v.run(db.workspaces[0], item)).status, 'pass');
  setTest('node --test --verbose');
  const blocked = await v.run(db.workspaces[0], item);
  assert.equal(blocked.status, 'blocked'); assert.match(blocked.reason, /mudou desde a aprovação humana/);
  assert.match(blocked.reason, /aprovado: "node --test"/); assert.match(blocked.reason, /atual: "node --test --verbose"/);
  setTest('node --test');
  assert.equal((await v.run(db.workspaces[0], item)).status, 'pass', 'o arquivo é relido a cada execução: nada fica em cache');
});

test('a comparação é exata: diferença de espaço também bloqueia (sem normalização silenciosa)', async () => {
  const v = createVerifier({ spawnSpec }); const item = db.workspaces[0].verifications[0];
  setTest('node --test '); assert.equal((await v.run(db.workspaces[0], item)).status, 'blocked');
  setTest('node  --test'); assert.equal((await v.run(db.workspaces[0], item)).status, 'blocked');
  setTest('node --test');
});

test('reaprovação humana do texto novo libera; voltar ao texto antigo passa a bloquear', async () => {
  const v = createVerifier({ spawnSpec });
  setTest('node --test --verbose');
  assert.equal((await v.run(db.workspaces[0], db.workspaces[0].verifications[0])).status, 'blocked', 'sem reaprovar, continua bloqueado');
  assert.equal((await approve()).status, 200);
  assert.equal(db.workspaces[0].verifications[0].command, 'node --test --verbose');
  assert.equal((await v.run(db.workspaces[0], db.workspaces[0].verifications[0])).status, 'pass');
  setTest('node --test');
  assert.equal((await v.run(db.workspaces[0], db.workspaces[0].verifications[0])).status, 'blocked', 'a aprovação vale para o texto aprovado, não para "o anterior"');
  assert.equal((await approve()).status, 200); // volta à aprovação de "node --test"
  assert.equal(db.workspaces[0].verifications[0].command, 'node --test');
});

test('persistência: a aprovação vai para o disco e, recarregada, continua valendo', async () => {
  setTest('node --test');
  await approve();
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.ORCH_DATA_DIR, 'db.json'), 'utf8'));
  const saved = disk.workspaces.find((w) => w.id === 'w1').verifications[0];
  assert.deepEqual([saved.script, saved.command, saved.required], ['test', 'node --test', true]);
  const reloaded = store.load(); // relê o arquivo como um reinício do servidor
  assert.notEqual(reloaded, db, 'objeto novo, vindo do disco');
  const ws = reloaded.workspaces.find((w) => w.id === 'w1');
  assert.equal((await createVerifier({ spawnSpec }).run(ws, ws.verifications[0])).status, 'pass');
  setTest('node --test --verbose');
  assert.equal((await createVerifier({ spawnSpec }).run(ws, ws.verifications[0])).status, 'blocked', 'e continua bloqueando alteração real depois de recarregar');
  setTest('node --test');
});
