// Proteção de Host e Origin da API local: testes unitários do guard + integração com o index.js REAL (via chat-boot.mjs, Planner simulado).
// SEMPRE com ORCH_DATA_DIR temporário e porta livre própria; nenhum modelo é chamado, nada é executado e o banco real (data/) não é tocado (o teste confere o db.json real).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAllowedHost, isAllowedOrigin, isDecisionRoute, apiGuard } from '../origin-guard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(here, 'chat-boot.mjs');
const REAL_DB = path.resolve(here, '..', '..', 'data', 'db.json');
const stat = () => (fs.existsSync(REAL_DB) ? `${fs.statSync(REAL_DB).mtimeMs}:${fs.statSync(REAL_DB).size}` : 'ausente');

test('isAllowedHost: só localhost/127.0.0.1, com porta 1-65535 canônica quando presente', () => {
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', 'localhost:4317', '127.0.0.1:5173', '127.0.0.1:65535', 'localhost:1']) assert.equal(isAllowedHost(h), true, h);
  for (const h of [undefined, null, '', 'evil.com', 'localhost.evil.com', '127.0.0.1.evil.com', 'evil.com:4317', 'localhost:', 'localhost:0', 'localhost:65536', 'localhost:99999', 'localhost:080', 'localhost:12a', 'localhost:-1', 'user@localhost', 'localhost@evil.com', 'localhost/x', ' localhost', 'localhost ', '127.1', '0.0.0.0', '[::1]', 'localhost:1:2', 'localhost, evil.com']) assert.equal(isAllowedHost(h), false, String(h));
});

test('isAllowedOrigin: parsing de URL, sem prefixos ou correspondências parciais', () => {
  for (const o of ['http://localhost:5173', 'http://127.0.0.1:4317', 'http://localhost', 'https://127.0.0.1:4317', 'HTTP://LOCALHOST:5173']) assert.equal(isAllowedOrigin(o), true, o);
  for (const o of [undefined, null, '', 'null', 'http://evil.example', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'http://localhost:5173.evil.com', 'http://evil.com/http://localhost',
    'http://localhost:5173/', 'http://localhost:5173/x', 'http://localhost:5173?x=1', 'http://127.0.0.1:1@evil.com', 'http://localhost@evil.com', 'http://user:pw@localhost:5173',
    'ftp://localhost', 'file://localhost', 'javascript:alert(1)', 'http://127.1', 'http://2130706433', 'http://localhost:80', 'http://localhost:99999', 'http://[::1]:4317', 'localhost:5173', 'http://localhost:5173, http://evil.com', ' http://localhost:5173']) assert.equal(isAllowedOrigin(o), false, String(o));
});

test('isDecisionRoute: as rotas de decisão (maiúsculas, barra final e consulta incluídas) e nenhuma outra', () => {
  for (const p of ['/api/missions/m1/cycle/approvals/ap1', '/api/missions/m1/cycle/accept-unverified', '/api/missions/m1/tasks/t1/approve', '/api/missions/m1/tasks/t1/reject', '/api/missions/m1/tasks/t1/authorize', '/api/chat/approve',
    '/api/chat/approve/', '/API/CHAT/APPROVE', '/api/chat/approve?x=1', '/api/Missions/M1/Cycle/Accept-Unverified/']) assert.equal(isDecisionRoute(p), true, p);
  for (const p of ['/api/chat/message', '/api/chat', '/api/missions/m1/cycle/start', '/api/missions/m1/cycle/resume', '/api/missions/m1/cycle/cancel', '/api/workspaces/validate', '/api/missions/m1/tasks/t1/revoke', '/api/missions/m1/tasks/t1/run', '/api/state', '/api/chat/approve/x', '/x/api/chat/approve']) assert.equal(isDecisionRoute(p), false, p);
});

test('apiGuard (middleware): Host inválido, Origin externo e Origin ausente em rota de decisão dão 403; o resto segue', () => {
  const run = ({ host = 'localhost:4317', origin, baseUrl = '/api', path: p = '/chat' }) => {
    const headers = { host, ...(origin === undefined ? {} : { origin }) }; let out = { next: false };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    apiGuard({ get: (k) => headers[k.toLowerCase()], baseUrl, path: p, originalUrl: `${baseUrl}${p}` }, res, () => { out.next = true; });
    return out;
  };
  assert.equal(run({}).next, true, 'rota comum sem Origin segue'); assert.equal(run({ origin: 'http://localhost:5173' }).next, true);
  assert.equal(run({ host: 'evil.com' }).status, 403); assert.equal(run({ host: null }).status, 403, 'Host ausente');
  assert.equal(run({ origin: 'http://evil.example' }).status, 403); assert.equal(run({ origin: '' }).status, 403, 'Origin vazio não é "ausente"');
  assert.equal(run({ path: '/chat/approve' }).status, 403, 'decisão sem Origin'); assert.equal(run({ path: '/chat/approve', origin: 'http://127.0.0.1:4317' }).next, true);
  assert.equal(run({ path: '/chat/approve', host: 'evil.com', origin: 'http://localhost:5173' }).status, 403, 'Host inválido vale mesmo com Origin legítimo');
});

// ---- integração com o index.js REAL ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-origin-guard-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function boot(port, dir) {
  assert.ok(dir.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário');
  const child = spawn(process.execPath, [BOOT], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))) };
}
const waitUp = async (b) => { for (let i = 0; i < 100; i++) { if (/AI Dev Orchestrator API em/.test(b.out())) return true; await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); } return false; };
// http cru: permite controlar Host, Origin e a forma do alvo da requisição (o fetch não deixa)
const raw = (port, { method = 'POST', target, headers = {}, body, raw: rawBody }) => new Promise((resolve, reject) => {
  const data = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body); // `raw`: corpo enviado como está (ex.: JSON malformado)
  const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, text: s }));
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});

test('index.js real: Origin obrigatório nas rotas de decisão, Host validado em toda a /api e rotas comuns preservadas', async () => {
  const realBefore = stat();
  const dir = path.join(root, 'data'), ws = path.join(root, 'workspace'); fs.mkdirSync(dir); fs.mkdirSync(ws);
  const port = await freePort(), b = boot(port, dir), legit = `http://127.0.0.1:${port}`;
  const call = (target, o = {}) => raw(port, { target, ...o, headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } });
  try {
    assert.ok(await waitUp(b), `servidor não subiu:\n${b.out()}`);
    const DECISION = ['/api/missions/m1/cycle/approvals/ap1', '/api/missions/m1/cycle/accept-unverified', '/api/missions/m1/tasks/t1/approve', '/api/missions/m1/tasks/t1/reject', '/api/missions/m1/tasks/t1/authorize', '/api/chat/approve'];
    for (const p of DECISION) {
      assert.equal((await call(p, { body: {} })).status, 403, `${p} sem Origin`);
      for (const origin of ['http://evil.example', 'null', 'http://localhost.evil.com', 'http://127.0.0.1:1@evil.com', 'http://127.1']) assert.equal((await call(p, { body: {}, headers: { origin } })).status, 403, `${p} Origin ${origin}`);
      assert.notEqual((await call(p, { body: {}, headers: { origin: legit } })).status, 403, `${p} com a origem legítima chega à rota (não é 403)`);
      assert.notEqual((await call(p, { body: {}, headers: { origin: 'http://localhost:5173' } })).status, 403, `${p} com a origem do Vite`);
    }
    // contornos de forma: maiúsculas, barra final e alvo em forma absoluta não escapam da regra
    for (const target of ['/API/CHAT/APPROVE', '/api/chat/approve/', `http://127.0.0.1:${port}/api/chat/approve`, '/api/chat/approve?x=1']) assert.equal((await call(target, { body: {} })).status, 403, target);
    // rotas que NÃO são de decisão: sem Origin continuam funcionando (Host válido); Origin externo continua barrado; Origin legítimo passa
    assert.equal((await call('/api/workspaces/validate', { body: { path: ws } })).status, 200);
    assert.equal((await call('/api/chat', { method: 'GET' })).status, 200);
    assert.equal((await call('/api/workspaces/validate', { body: { path: ws }, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call('/api/workspaces/validate', { body: { path: ws }, headers: { origin: legit } })).status, 200);
    // Host: externo, com sufixo, porta inválida e ausente são barrados em qualquer rota /api; localhost com outra porta é aceito
    for (const host of ['evil.com', 'localhost.evil.com', '127.0.0.1.evil.com:4317', 'localhost:99999', 'localhost:0']) assert.equal((await call('/api/chat', { method: 'GET', headers: { host } })).status, 403, host);
    for (const host of ['localhost', `localhost:${port}`, '127.0.0.1:5173']) assert.equal((await call('/api/chat', { method: 'GET', headers: { host } })).status, 200, host);
    assert.equal((await call('/api/chat/approve', { body: {}, headers: { host: 'evil.com', origin: legit } })).status, 403, 'Host inválido barra até a rota de decisão com Origin legítimo');
    // o guard roda ANTES do parser de JSON: Origin externo + corpo malformado é 403 (não 400 "JSON inválido"), em rota comum e de decisão; corpo malformado de origem legítima segue sendo 400
    for (const p of ['/api/workspaces/validate', '/api/chat/approve']) {
      assert.equal((await call(p, { raw: '{', headers: { origin: 'http://evil.example' } })).status, 403, `${p} Origin externo + JSON malformado`);
      assert.equal((await call(p, { raw: '{', headers: { host: 'evil.com' } })).status, 403, `${p} Host externo + JSON malformado`);
    }
    assert.equal((await call('/api/workspaces/validate', { raw: '{', headers: { origin: legit } })).status, 400, 'origem legítima com JSON malformado continua 400');
  } finally { b.child.kill('SIGKILL'); await b.exited; }
  assert.equal(stat(), realBefore, 'o db.json real não foi tocado');
});
