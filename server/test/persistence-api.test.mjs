// M2: contrato HTTP do estado de persistência. Servidor REAL (server/index.js) como processo filho, SEMPRE com ORCH_DATA_DIR temporário e porta livre própria;
// nenhum modelo é chamado e o banco real e o servidor ativo nunca são tocados. A falha é real: um DIRETÓRIO no lugar de db.json.tmp faz o save() lançar EISDIR.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-persist-api-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function boot(port, dir) {
  assert.ok(dir.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário');
  const child = spawn(process.execPath, [INDEX], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))) };
}
const waitUp = async (b) => { for (let i = 0; i < 80; i++) { if (/AI Dev Orchestrator API em/.test(b.out())) return true; await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); } return false; };

test('/api/state: saudável => persistence.ok e incidente null; falha real de gravação => ok=false e incidente aberto; reconciliada => ok=true e o rastro permanece', async () => {
  const dir = path.join(root, 'd1'); fs.mkdirSync(dir);
  const port = await freePort(), b = boot(port, dir), base = `http://127.0.0.1:${port}`;
  try {
    assert.equal(await waitUp(b), true, `o servidor não subiu: ${b.out()}`);
    const state = async () => (await fetch(`${base}/api/state`)).json();
    const save = () => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });

    let s = await state();
    assert.equal(s.persistence.ok, true); assert.equal(s.persistence.error, null); assert.equal(s.persistenceIncident, null);
    assert.ok(s.settings && s.counts && s.executor, 'os campos existentes continuam lá');

    fs.mkdirSync(path.join(dir, 'db.json.tmp'));                       // EISDIR: erro real, não transitório
    assert.equal((await save()).status, 500, 'a gravação que falha não é apresentada como sucesso');
    s = await state();
    assert.equal(s.persistence.ok, false); assert.equal(s.persistence.error, 'EISDIR'); assert.ok(s.persistence.consecutiveFailures >= 1);
    assert.equal(s.persistenceIncident.error, 'EISDIR'); assert.equal(s.persistenceIncident.recoveredAt, null); assert.ok(s.persistenceIncident.failedAt); assert.ok(s.persistenceIncident.failures >= 1);
    assert.ok(!JSON.stringify(s.persistence).includes(root) && !JSON.stringify(s.persistenceIncident).includes(root), 'só o código do erro: nenhum caminho do disco');

    fs.rmSync(path.join(dir, 'db.json.tmp'), { recursive: true, force: true });
    assert.equal((await save()).status, 200, 'normalizado o armazenamento, a gravação volta');
    s = await state();
    assert.equal(s.persistence.ok, true); assert.equal(s.persistence.error, null);
    assert.equal(s.persistenceIncident.error, 'EISDIR', 'o incidente não é apagado pela recuperação'); assert.ok(s.persistenceIncident.recoveredAt);
  } finally { b.child.kill(); await b.exited; }
});
