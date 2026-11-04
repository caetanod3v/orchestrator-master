// M2: token de sessão por boot. Unitário (consumo do ambiente, guard) + integração com o index.js REAL (via chat-boot.mjs, Planner simulado).
// SEMPRE com ORCH_DATA_DIR temporário e porta livre própria; o banco real (data/) não é tocado (o teste confere o db.json real).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { consumeApiTokenFromEnv, createTokenGuard, TOKEN_HEADER } from '../session-token.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(here, 'chat-boot.mjs');
const REAL_DB = path.resolve(here, '..', '..', 'data', 'db.json');
const stat = () => (fs.existsSync(REAL_DB) ? `${fs.statSync(REAL_DB).mtimeMs}:${fs.statSync(REAL_DB).size}` : 'ausente');
const TOKEN = 'a'.repeat(16) + 'B1_-'.repeat(8);

test('consumeApiTokenFromEnv: devolve o token e o REMOVE do ambiente; ausente => null; formato fraco/inválido => erro (nunca protege em silêncio)', () => {
  const env = { ORCH_API_TOKEN: TOKEN, OUTRA: 'x' };
  assert.equal(consumeApiTokenFromEnv(env), TOKEN); assert.equal('ORCH_API_TOKEN' in env, false, 'removido: nenhum filho o herda'); assert.equal(env.OUTRA, 'x');
  assert.equal(consumeApiTokenFromEnv({}), null); assert.equal(consumeApiTokenFromEnv({ ORCH_API_TOKEN: '' }), null);
  for (const bad of ['curto', 'a'.repeat(31), 'a'.repeat(129), `${'a'.repeat(40)} x`, `${'a'.repeat(40)}!`]) {
    const e = { ORCH_API_TOKEN: bad }; assert.throws(() => consumeApiTokenFromEnv(e), /ORCH_API_TOKEN inválido/, bad); assert.equal('ORCH_API_TOKEN' in e, false, 'mesmo inválido, sai do ambiente');
  }
});

test('createTokenGuard: métodos mutáveis e fluxos de terminal exigem o token; leituras comuns, HEAD e OPTIONS seguem', () => {
  const g = createTokenGuard(TOKEN);
  const run = ({ method = 'GET', p = '/state', token }) => {
    const headers = token === undefined ? {} : { [TOKEN_HEADER]: token }; const out = { next: false };
    const res = { status(c) { out.status = c; return this; }, json() { return this; } };
    g({ method, path: p, get: (k) => headers[k.toLowerCase()] }, res, () => { out.next = true; }); return out;
  };
  for (const [method, p] of [['GET', '/state'], ['GET', '/terminals'], ['GET', '/maestro'], ['HEAD', '/state'], ['OPTIONS', '/state']]) assert.equal(run({ method, p }).next, true, `${method} ${p} sem token`);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    assert.equal(run({ method, p: '/maestro/autonomy' }).status, 403, `${method} sem token`);
    assert.equal(run({ method, p: '/terminals/term_1/input', token: 'errado' }).status, 403, `${method} token errado`);
    assert.equal(run({ method, p: '/maestro/tasks/t/approve', token: '' }).status, 403, `${method} token vazio`);
    assert.equal(run({ method, p: '/maestro/autonomy', token: TOKEN }).next, true, `${method} com token`);
  }
  for (const p of ['/terminals/stream', '/terminals/term_1/stream', '/TERMINALS/STREAM', '/terminals/stream/']) {
    assert.equal(run({ p }).status, 403, `GET ${p} sem token`); assert.equal(run({ p, token: TOKEN }).next, true, `GET ${p} com token`);
  }
  assert.equal(run({ p: '/terminals/x/y/stream' }).next, true, 'caminho que não é o fluxo não é tratado como fluxo');
});

// ---- integração com o index.js REAL ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-session-token-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function boot(port, dir, env = {}) {
  assert.ok(dir.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário');
  const child = spawn(process.execPath, [BOOT], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))) };
}
const waitUp = async (b) => { for (let i = 0; i < 100; i++) { if (/AI Dev Orchestrator API em/.test(b.out())) return true; await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); } return false; };
const raw = (port, { method = 'GET', target, headers = {}, body }) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, text: s }));
    if (res.headers['content-type']?.includes('text/event-stream')) { resolve({ status: res.statusCode, text: '' }); req.destroy(); }
  });
  req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); }); if (data) req.write(data); req.end();
});

test('index.js real com ORCH_API_TOKEN: mutações e fluxo de terminal só com o token; leituras abertas; o token não aparece em respostas', async () => {
  const realBefore = stat();
  const dir = path.join(root, 'data'), ws = path.join(root, 'workspace'); fs.mkdirSync(dir); fs.mkdirSync(ws);
  const port = await freePort(), b = boot(port, dir, { ORCH_API_TOKEN: TOKEN }), origin = `http://127.0.0.1:${port}`;
  const call = (target, o = {}) => raw(port, { target, ...o });
  try {
    assert.ok(await waitUp(b), `servidor não subiu:\n${b.out()}`);
    const s0 = (await call('/api/state')).text;
    assert.equal((await call('/api/state')).status, 200, 'leitura comum sem token');
    // Origin e Host perfeitos (como um curl forjado de um pane), mas sem o token: recusado e nada muda
    for (const [method, p, body] of [['POST', '/api/workspaces', { name: 'x', path: ws }], ['POST', '/api/workspaces/validate', { path: ws }], ['POST', '/api/maestro/autonomy', { enabled: true }], ['POST', '/api/terminals/term_x/input', { data: 'ls\r' }], ['POST', '/api/terminals', {}], ['PUT', '/api/settings', { showDemoData: true }]]) {
      const r = await call(p, { method, body, headers: { origin } });
      assert.equal(r.status, 403, `${method} ${p} sem token`); assert.match(r.text, /Token de sessão/);
      assert.equal((await call(p, { method, body, headers: { origin, [TOKEN_HEADER]: 'x'.repeat(64) } })).status, 403, `${method} ${p} token errado`);
    }
    assert.equal((await call('/api/terminals/stream', { headers: { origin } })).status, 403, 'fluxo de terminais sem token');
    assert.equal((await call('/api/state')).text, s0, 'nada foi alterado pelas requisições recusadas');
    // com o token (como a janela do Electron): chega à rota
    assert.equal((await call('/api/workspaces/validate', { method: 'POST', body: { path: ws }, headers: { origin, [TOKEN_HEADER]: TOKEN } })).status, 200);
    assert.equal((await call('/api/terminals/stream', { headers: { origin, [TOKEN_HEADER]: TOKEN } })).status, 200, 'fluxo com token');
    // a proteção de Origin continua valendo com o token (token não substitui Origin)
    assert.equal((await call('/api/workspaces/validate', { method: 'POST', body: { path: ws }, headers: { [TOKEN_HEADER]: TOKEN } })).status, 403, 'sem Origin continua 403');
    assert.equal((await call('/api/workspaces/validate', { method: 'POST', body: { path: ws }, headers: { origin: 'http://evil.example', [TOKEN_HEADER]: TOKEN } })).status, 403);
    assert.ok(!b.out().includes(TOKEN), 'o token não vai para o log do servidor');
  } finally { b.child.kill('SIGKILL'); await b.exited; }
  assert.equal(stat(), realBefore, 'o db.json real não foi tocado');
});

test('index.js real SEM ORCH_API_TOKEN: comportamento anterior (só Host/Origin); com token inválido o boot é recusado', async () => {
  const dir = path.join(root, 'data2'), dir3 = path.join(root, 'data3'), ws = path.join(root, 'workspace2'); fs.mkdirSync(dir); fs.mkdirSync(dir3); fs.mkdirSync(ws);
  const port = await freePort(), b = boot(port, dir), origin = `http://127.0.0.1:${port}`;
  try {
    assert.ok(await waitUp(b), `servidor não subiu:\n${b.out()}`);
    assert.equal((await raw(port, { target: '/api/workspaces/validate', method: 'POST', body: { path: ws }, headers: { origin } })).status, 200, 'sem token configurado a mutação com Origin válido segue aceita');
  } finally { b.child.kill('SIGKILL'); await b.exited; }
  const bad = boot(await freePort(), dir3, { ORCH_API_TOKEN: 'curto' });
  const code = await Promise.race([bad.exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
  assert.notEqual(code, 0); assert.notEqual(code, 'timeout', 'o servidor não pode subir com token inválido'); assert.match(bad.out(), /ORCH_API_TOKEN inválido/);
});
