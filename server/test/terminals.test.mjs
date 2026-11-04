// Terminais interativos (PTY) do Claude Code: lógica com PTY SIMULADO (nenhum processo real é morto: o encerramento é injetado), rotas HTTP/SSE, o boot real do servidor
// (checagem de Host/Origin) e uma parte com PTY de VERDADE (node-pty) provando dois terminais em paralelo, independentes. O Claude Code real nunca é executado aqui.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-term-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const { default: express } = await import('express');
const store = await import('../store.js');
const T = await import('../terminals.js');
const { createChildRegistry, CHILD_KEY } = await import('../child-registry.js');
const { pidAlive } = await import('../instance-lock.js');
store.load(); store.saveOrThrow();
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já saiu */ } } await new Promise((r) => setTimeout(r, 500)); fs.rmSync(tmp, { recursive: true, force: true }); });

const wsDir = path.join(tmp, 'ws'); fs.mkdirSync(wsDir);
const mkDb = () => ({ settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); } return false; };

/** PTY simulado: o que o gerenciador escreveu/redimensionou fica registrado; `emit(d)` simula a saída; `exit(code)` simula o fim. */
function fakePty() {
  const spawned = []; let pid = 1_900_000_000;
  const lib = { spawn(file, args, opts) {
    const p = { pid: ++pid, file, args, opts, written: [], resized: [], dataCb: null, exitCb: null, onData(cb) { p.dataCb = cb; }, onExit(cb) { p.exitCb = cb; }, write(d) { p.written.push(d); }, resize(c, r) { p.resized.push([c, r]); }, emit(d) { p.dataCb(d); }, exit(code = 0) { p.exitCb({ exitCode: code }); } };
    spawned.push(p); return p;
  } };
  return { lib, spawned };
}
const fakeRes = () => { const r = new EventEmitter(); r.out = ''; r.ended = false; r.head = null; r.writeHead = (s, h) => { r.head = { s, h }; }; r.write = (x) => { r.out += x; return true; }; r.end = () => { r.ended = true; }; return r; };
const events = (out) => [...out.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
function world(over = {}) {
  const f = fakePty(), killed = [], db = mkDb(), registry = createChildRegistry(); let n = 0;
  const mgr = T.createTerminalManager({ db, ptyLib: f.lib, resolveCommand: () => ({ file: 'C:/fake/claude.exe', args: [], viaShell: false }), track: registry.track, killTree: (pid) => killed.push(pid), waitFor: () => true, newSessionId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, ...over });
  return { f, killed, db, registry, mgr };
}

test('criar: comando e argumentos FIXOS por papel (o cliente só escolhe o papel), cwd do workspace, ambiente limpo e PID no child-registry', async () => {
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const w = world(); let r; try { r = await w.mgr.create({ role: 'reviewer', title: 'Rev; rm -rf /', cols: 100, rows: 30 }); } finally { delete process.env.ELECTRON_RUN_AS_NODE; }
  assert.equal(r.ok, true, r.error); assert.equal(r.status, 201); const s = r.session, p = w.f.spawned[0];
  assert.match(s.id, /^term_[0-9a-f]{8}$/); assert.deepEqual([s.role, s.roleLabel, s.status, s.cols, s.rows], ['reviewer', 'Revisor', 'running', 100, 30]); assert.equal(s.title, 'Rev rm -rf'.replace(/ /g, ' ')); assert.ok(!/[;&|<>^%"]/.test(s.title), 'título só com letras, números e _.-');
  assert.equal(p.file, 'C:/fake/claude.exe'); assert.deepEqual(p.args, ['--append-system-prompt', T.ROLES.reviewer.prompt, '--name', s.title, '--session-id', '00000000-0000-4000-8000-000000000001']); assert.equal(s.usage, null, 'sem leitor de uso: null'); assert.equal(p.opts.cwd, wsDir); assert.equal(p.opts.useConpty, true);
  assert.equal(p.opts.env.ELECTRON_RUN_AS_NODE, undefined); assert.equal(p.opts.env.TERM, 'xterm-256color'); assert.equal(s.pid, p.pid);
  const reg = store.get()[CHILD_KEY].filter((x) => x.kind === 'terminal'); assert.equal(reg.length, 1); assert.deepEqual([reg[0].pid, reg[0].terminalId], [p.pid, s.id]);
  for (const k of T.roleIds()) assert.ok(!/[&|<>^%"]/.test(T.ROLES[k].prompt), `prompt de ${k} sem caracteres de shell (wrapper .cmd)`);
});

test('criar: recusas claras (papel inválido, sem espaço de trabalho, workspace inválido, sem Claude Code, sem módulo, limite de sessões) e spawn que falha', async () => {
  let w = world(); let r = await w.mgr.create({ role: 'hacker' }); assert.deepEqual([r.status, /Papel inválido/.test(r.error)], [400, true]);
  w = world(); w.db.settings.activeWorkspaceId = null; r = await w.mgr.create({}); assert.equal(r.status, 409); assert.match(r.error, /espaço de trabalho/);
  w = world(); w.db.workspaces[0].path = path.join(tmp, 'nao-existe'); r = await w.mgr.create({}); assert.equal(r.status, 409); assert.match(r.error, /inválido/);
  w = world({ resolveCommand: () => null }); r = await w.mgr.create({}); assert.equal(r.status, 409); assert.match(r.error, /PATH/);
  w = world({ ptyLib: { spawn() { throw new Error('boom'); } } }); r = await w.mgr.create({}); assert.equal(r.status, 500); assert.match(r.error, /boom/);
  w = world({ maxSessions: 2 }); assert.equal((await w.mgr.create({})).ok, true); assert.equal((await w.mgr.create({})).ok, true); r = await w.mgr.create({}); assert.equal(r.status, 409); assert.match(r.error, /Limite de 2/); assert.equal(w.mgr.count(), 2);
});

test('PARALELISMO: várias sessões simultâneas e independentes — entrada, saída, tamanho e encerramento de uma não afetam as outras', async () => {
  const w = world(); const ids = []; for (const role of ['maestro', 'builder', 'reviewer', 'scout']) { const r = await w.mgr.create({ role }); assert.equal(r.ok, true); ids.push(r.session.id); }
  assert.equal(w.mgr.count(), 4); assert.equal(new Set(w.f.spawned.map((p) => p.pid)).size, 4); assert.deepEqual(w.f.spawned.map((p) => p.args[1]), ['maestro', 'builder', 'reviewer', 'scout'].map((k) => T.ROLES[k].prompt));
  w.mgr.write(ids[1], 'pwd\r'); w.mgr.resize(ids[2], 150, 40); assert.deepEqual(w.f.spawned.map((p) => p.written), [[], ['pwd\r'], [], []]); assert.deepEqual(w.f.spawned.map((p) => p.resized), [[], [], [[150, 40]], []]);
  w.f.spawned[0].emit('saída do maestro'); w.f.spawned[3].emit('saída do batedor'); const r0 = fakeRes(), r3 = fakeRes(); w.mgr.subscribe(ids[0], r0); w.mgr.subscribe(ids[3], r3);
  assert.equal(events(r0.out)[0].data.replay, 'saída do maestro'); assert.equal(events(r3.out)[0].data.replay, 'saída do batedor');
  w.f.spawned[1].exit(0); assert.deepEqual(w.mgr.list().map((s) => s.status), ['running', 'exited', 'running', 'running']); assert.equal(w.mgr.count(), 3);
  assert.equal(w.mgr.write(ids[1], 'x').status, 409); assert.equal(w.mgr.write(ids[0], 'ainda vivo').ok, true);
  w.mgr.close(ids[2]); assert.deepEqual(w.killed, [w.f.spawned[2].pid]); assert.equal(w.mgr.count(), 2); assert.equal(w.mgr.get(ids[2]), null);
});

test('entrada e redimensionamento: validados (texto 1..64 KB sem byte nulo; cols/rows limitados); terminal inexistente = 404', async () => {
  const w = world(), { session: s } = await w.mgr.create({});
  for (const bad of ['', 7, null, 'a'.repeat(T.MAX_INPUT + 1), 'a\0b']) assert.equal(w.mgr.write(s.id, bad).status, 400, String(bad).slice(0, 10));
  assert.equal(w.mgr.write(s.id, '\x03').ok, true, 'Ctrl+C é entrada válida'); assert.equal(w.mgr.write('term_00000000', 'x').status, 404); assert.equal(w.mgr.write('../x', 'x').status, 404);
  assert.deepEqual(w.mgr.resize(s.id, 9999, 1).session && [w.mgr.get(s.id).cols, w.mgr.get(s.id).rows], [400, 5]); assert.equal(w.mgr.resize(s.id, 'a', 'b').status, 400); assert.equal(w.mgr.resize('term_00000000', 80, 24).status, 404);
});

test('saída: buffer limitado (reposição para recarregar a página sem perder a tela), SSE com init/data/exit, limite de conexões e 404', async () => {
  const w = world(), { session: s } = await w.mgr.create({}), p = w.f.spawned[0];
  p.emit('linha 1\r\n'); const a = fakeRes(); assert.equal(w.mgr.subscribe(s.id, a), true);
  assert.deepEqual([a.head.s, a.head.h['content-type'], a.head.h['cache-control']], [200, 'text/event-stream; charset=utf-8', 'no-cache, no-transform']);
  p.emit('linha 2\r\n'); const ev = events(a.out); assert.deepEqual(ev.map((e) => e.event), ['init', 'data']); assert.equal(ev[0].data.replay, 'linha 1\r\n'); assert.equal(ev[0].data.session.id, s.id); assert.equal(ev[1].data.d, 'linha 2\r\n');
  p.exit(3); assert.deepEqual(events(a.out).at(-1), { event: 'exit', data: { exitCode: 3, endedAt: w.mgr.get(s.id).endedAt } }); assert.equal(w.mgr.get(s.id).exitCode, 3);
  const late = fakeRes(); w.mgr.subscribe(s.id, late); assert.deepEqual(events(late.out).map((e) => e.event), ['init', 'exit'], 'quem chega depois do fim recebe o final e a tela');
  const w2 = world(), { session: s2 } = await w2.mgr.create({}); const chunk = 'x'.repeat(100_000); for (let i = 0; i < 8; i++) w2.f.spawned[0].emit(chunk); const r2 = fakeRes(); w2.mgr.subscribe(s2.id, r2);
  const replay = events(r2.out)[0].data.replay.length; assert.ok(replay <= T.BUFFER_BYTES + chunk.length && replay >= T.BUFFER_BYTES - chunk.length, `buffer limitado (${replay})`); assert.equal(w2.mgr.get(s2.id).bytes, 800_000, 'o total impresso continua contado');
  const w3 = world(), { session: s3 } = await w3.mgr.create({}); for (let i = 0; i < T.MAX_SUBSCRIBERS; i++) assert.equal(w3.mgr.subscribe(s3.id, fakeRes()), true); assert.equal(w3.mgr.subscribe(s3.id, fakeRes()), null); assert.equal(w3.mgr.subscribe('term_00000000', fakeRes()), false);
});

test('encerrar: mata o processo (com a árvore), libera o registro, fecha as conexões e devolve o worktree sem apagá-lo; falha ao registrar o PID encerra o processo', async () => {
  const w = world(), { session: s } = await w.mgr.create({}), res = fakeRes(); w.mgr.subscribe(s.id, res);
  assert.equal(store.get()[CHILD_KEY].filter((x) => x.terminalId === s.id).length, 1); const c = w.mgr.close(s.id);
  assert.deepEqual([c.ok, c.wasRunning, c.closed], [true, true, s.id]); assert.deepEqual(w.killed, [s.pid]); assert.equal(res.ended, true); assert.equal(store.get()[CHILD_KEY].filter((x) => x.terminalId === s.id).length, 0, 'registro do filho liberado'); assert.equal(w.mgr.close(s.id).status, 404);
  const bad = world({ track: () => { throw Object.assign(new Error('disco'), { code: 'EIO' }); } }); const r = await bad.mgr.create({}); assert.equal(r.status, 503); assert.match(r.error, /encerrado/); assert.deepEqual(bad.killed, [bad.f.spawned[0].pid]); assert.equal(bad.mgr.list().length, 0);
  const k = world(); await k.mgr.create({}); await k.mgr.create({}); k.f.spawned[0].exit(0); k.mgr.killAllSync(); assert.deepEqual(k.killed, [k.f.spawned[1].pid], 'só os que ainda rodam são encerrados no desligamento'); assert.equal(k.mgr.count(), 0);
});

test('isolamento: com `isolate` o pane roda num worktree PRÓPRIO (módulo de worktrees); sem módulo ou com falha, recusa e nada é iniciado', async () => {
  const calls = [], wt = { create: async (a) => { calls.push(a); return { ok: true, record: { id: 'wt_aaaaaaaa', path: path.join(tmp, 'wt-a') } }; } };
  const w = world({ worktrees: wt }); const r = await w.mgr.create({ isolate: true }); assert.equal(r.ok, true); assert.equal(w.f.spawned[0].opts.cwd, path.join(tmp, 'wt-a')); assert.equal(r.session.worktreeId, 'wt_aaaaaaaa'); assert.equal(calls[0].mission.id, r.session.id); assert.equal(calls[0].workspace.id, 'ws');
  const none = world(); let x = await none.mgr.create({ isolate: true }); assert.equal(x.status, 409); assert.equal(none.f.spawned.length, 0);
  const bad = world({ worktrees: { create: async () => ({ ok: false, status: 409, error: 'o workspace não é um repositório Git' }) } }); x = await bad.mgr.create({ isolate: true }); assert.equal(x.status, 409); assert.match(x.error, /Isolamento não criado.*Git/); assert.equal(bad.f.spawned.length, 0);
  const plain = world({ worktrees: wt }); await plain.mgr.create({}); assert.equal(plain.f.spawned[0].opts.cwd, wsDir, 'sem isolate usa o workspace'); assert.equal(calls.length, 1);
});

test('resolveClaude: acha claude.exe no PATH (arquivo real, sem shell); wrapper .cmd passa pelo cmd.exe; ausente = null', () => {
  const d = path.join(tmp, 'bin'); fs.mkdirSync(d, { recursive: true });
  assert.equal(T.resolveClaude({ env: { PATH: d }, platform: 'win32' }), null); fs.writeFileSync(path.join(d, 'claude.cmd'), '@echo off');
  let r = T.resolveClaude({ env: { PATH: d, ComSpec: 'C:/Windows/System32/cmd.exe' }, platform: 'win32' }); assert.deepEqual([r.viaShell, r.file, r.args.slice(0, 3)], [true, 'C:/Windows/System32/cmd.exe', ['/d', '/s', '/c']]);
  fs.writeFileSync(path.join(d, 'claude.exe'), 'MZ'); r = T.resolveClaude({ env: { PATH: `${path.join(tmp, 'vazio')}${path.delimiter}${d}` }, platform: 'win32' }); assert.deepEqual([r.viaShell, path.basename(r.file), r.args], [false, 'claude.exe', []], 'o .exe tem prioridade sobre o wrapper');
  assert.equal(T.resolveClaude({ env: { PATH: d }, platform: 'linux' }), null);
});

// ---------- rotas HTTP + SSE reais ----------
test('rotas: criar (201), listar, SSE com reposição, entrada, redimensionar, encerrar — e erros em JSON', async () => {
  const w = world(), app = express(); app.use(express.json({ limit: '100kb' })); T.setupTerminals(app, { manager: w.mgr });
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); }), base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, b) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json() }; };
  try {
    let r = await post('/api/terminals', { role: 'hacker' }); assert.deepEqual([r.status, /Papel/.test(r.body.error)], [400, true]);
    r = await post('/api/terminals', { role: 'builder', title: 'Meu pane', command: 'rm -rf /', args: ['x'], cwd: '/', file: 'cmd.exe' }); assert.equal(r.status, 201); const id = r.body.session.id; assert.equal(w.f.spawned[0].file, 'C:/fake/claude.exe', 'comando, args e cwd do cliente são ignorados'); assert.equal(w.f.spawned[0].opts.cwd, wsDir);
    const list = await (await fetch(`${base}/api/terminals`)).json(); assert.deepEqual([list.sessions.length, list.maxSessions, list.roles.map((x) => x.id)], [1, T.MAX_SESSIONS, T.roleIds()]);
    w.f.spawned[0].emit('olá do pane');
    const ctl = new AbortController(), sse = await fetch(`${base}/api/terminals/${id}/stream`, { signal: ctl.signal }); assert.equal(sse.status, 200); assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    const reader = sse.body.getReader(), dec = new TextDecoder(); let acc = ''; const read = async (re) => { for (let i = 0; i < 40 && !re.test(acc); i++) { const { value, done } = await reader.read(); if (done) break; acc += dec.decode(value, { stream: true }); } };
    await read(/olá do pane/); assert.match(acc, /event: init/); assert.match(acc, /"replay":"olá do pane"/); w.f.spawned[0].emit('ao vivo'); await read(/ao vivo/); assert.match(acc, /event: data\ndata: \{"d":"ao vivo"\}/);
    assert.deepEqual((await post(`/api/terminals/${id}/input`, { data: 'ls\r' })).status, 200); assert.deepEqual(w.f.spawned[0].written, ['ls\r']); assert.equal((await post(`/api/terminals/${id}/input`, { data: 5 })).status, 400);
    r = await post(`/api/terminals/${id}/resize`, { cols: 90, rows: 20 }); assert.deepEqual([r.status, r.body.session.cols, r.body.session.rows], [200, 90, 20]);
    ctl.abort(); r = await post(`/api/terminals/${id}/close`); assert.deepEqual([r.status, r.body.closed, r.body.wasRunning], [200, id, true]); assert.equal((await post(`/api/terminals/${id}/close`)).status, 404); assert.equal((await fetch(`${base}/api/terminals/${id}/stream`)).status, 404);
  } finally { srv.close(); }
});

// ---------- o servidor REAL: toda a proteção de Host/Origin da API vale para os terminais ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
test('servidor real: criar terminal sem Origin é recusado (403); com Origin e sem workspace, 409 claro; a listagem funciona — nenhum processo é iniciado', async () => {
  const port = await freePort(), dir = fs.mkdtempSync(path.join(tmp, 'boot-')), INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
  const child = spawn(process.execPath, [INDEX], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir }, stdio: 'ignore', windowsHide: true }); children.add(child);
  const base = `http://127.0.0.1:${port}`; let up = false; for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/api/terminals`)).status === 200; } catch { /* subindo */ } if (!up) await sleep(250); }
  assert.ok(up, 'o servidor subiu');
  const list = await (await fetch(`${base}/api/terminals`)).json(); assert.deepEqual([list.sessions, list.roles.length], [[], 4]);
  let r = await fetch(`${base}/api/terminals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 403, 'sem Origin, uma requisição mutável é recusada');
  r = await fetch(`${base}/api/terminals`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' }); assert.equal(r.status, 403);
  r = await fetch(`${base}/api/terminals`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' }); assert.equal(r.status, 409); assert.match((await r.json()).error, /espaço de trabalho/);
  const hostStatus = await new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port, path: '/api/terminals', headers: { host: 'evil.example' } }, (resp) => { resp.resume(); resolve(resp.statusCode); }); q.on('error', () => resolve(0)); q.end(); }); assert.notEqual(hostStatus, 200, 'Host estranho não é aceito');
  // /mcp: nunca cai no fallback do SPA (o cliente MCP espera 405/401, não HTML); sem token, 401; com Origin, 403
  r = await fetch(`${base}/mcp`); assert.equal(r.status, 405); assert.doesNotMatch(String(r.headers.get('content-type')), /html/);
  r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }); assert.equal(r.status, 401);
  r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' }); assert.equal(r.status, 403);
  child.kill();
});

// ---------- PTY de VERDADE (node-pty): dois terminais em paralelo, independentes ----------
const REAL = (() => { try { return !!createRequireSafe(); } catch { return false; } })();
function createRequireSafe() { return fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'node-pty', 'lib', 'index.js')); }
test('PTY real: dois terminais simultâneos recebem teclas, imprimem só o que é seu, redimensionam e são encerrados sem deixar processo', { skip: !REAL && 'node-pty não instalado' }, async () => {
  const script = (name) => `process.stdin.setRawMode&&process.stdin.setRawMode(true);process.stdout.write('PRONTO-${name} cols='+process.stdout.columns+'\\r\\n');process.stdin.on('data',d=>{process.stdout.write('${name} RECEBEU '+JSON.stringify(String(d))+'\\r\\n')});setInterval(()=>{},1000)`;
  let n = 0; const db = mkDb(), registry = createChildRegistry();
  const mgr = T.createTerminalManager({ db, track: registry.track, resolveCommand: () => ({ file: process.execPath, args: ['-e', script(['AAA', 'BBB'][n++]), '--'], viaShell: false }) });
  const a = await mgr.create({ role: 'builder', cols: 90, rows: 20 }), b = await mgr.create({ role: 'scout', cols: 110, rows: 24 }); assert.equal(a.ok, true, a.error); assert.equal(b.ok, true, b.error);
  const out = { a: '', b: '' }; const ra = fakeRes(), rb = fakeRes(); mgr.subscribe(a.session.id, ra); mgr.subscribe(b.session.id, rb);
  const text = (r) => events(r.out).map((e) => e.data.d ?? e.data.replay ?? '').join(''); out.get = () => [text(ra), text(rb)];
  assert.ok(await until(() => /PRONTO-AAA cols=90/.test(text(ra)) && /PRONTO-BBB cols=110/.test(text(rb))), `saídas iniciais: ${JSON.stringify(out.get()).slice(0, 200)}`);
  assert.equal(mgr.count(), 2); assert.ok(pidAlive(a.session.pid) && pidAlive(b.session.pid)); assert.notEqual(a.session.pid, b.session.pid);
  assert.equal(mgr.write(a.session.id, 'so-para-A').ok, true); assert.ok(await until(() => /AAA RECEBEU "so-para-A"/.test(text(ra)))); assert.ok(!/so-para-A/.test(text(rb)), 'o terminal B não recebeu nada do A');
  assert.equal(mgr.write(b.session.id, 'so-para-B').ok, true); assert.ok(await until(() => /BBB RECEBEU "so-para-B"/.test(text(rb)))); assert.ok(!/so-para-B/.test(text(ra)));
  assert.equal(mgr.resize(a.session.id, 130, 40).session.cols, 130);
  const pa = a.session.pid, pb = b.session.pid; mgr.close(a.session.id); assert.ok(await until(() => !pidAlive(pa)), 'A encerrado'); assert.ok(pidAlive(pb), 'B continua vivo'); assert.equal(mgr.count(), 1);
  mgr.killAllSync(); assert.ok(await until(() => !pidAlive(pb)), 'B encerrado'); assert.equal(store.get()[CHILD_KEY].filter((x) => x.kind === 'terminal').length, 0, 'registros liberados');
});
