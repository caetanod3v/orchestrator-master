// Etapa 2: `closedReason` no registro de sessão de terminal (terminals.js): por que o terminal acabou, e o encerramento GRACIOSO do servidor deixa a sessão como
// "interrupted" (estava aberta), igual a uma queda, para a restauração futura distinguir "estava aberto" de "o usuário fechou". PTY, MCP e leitor de transcrição simulados;
// ORCH_DATA_DIR temporário; nenhum Claude Code real.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-closed-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const T = await import('../terminals.js');
const { installShutdown } = await import('../shutdown.js');
const store = await import('../store.js');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const wsDir = path.join(tmp, 'ws'); fs.mkdirSync(wsDir);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakePty() {
  const spawned = []; let pid = 1_900_000_000;
  const lib = { spawn(file, args, opts) {
    const p = { pid: ++pid, args, opts, dataCb: null, exitCb: null, onData(cb) { p.dataCb = cb; }, onExit(cb) { p.exitCb = cb; }, write() {}, resize() {}, exit(code = 0) { p.exitCb({ exitCode: code }); } };
    spawned.push(p); return p;
  } };
  return { lib, spawned };
}
function world(over = {}) {
  const f = fakePty(), persisted = { n: 0 }, transcripts = new Set(); let n = 0;
  const db = over.db ?? { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }], worktrees: [] };
  const mgr = T.createTerminalManager({
    db, ptyLib: f.lib, resolveCommand: () => ({ file: 'C:/fake/claude.exe', args: [], viaShell: false }), killTree: () => {}, waitFor: over.waitFor ?? (() => true), pidIsAlive: over.pidIsAlive,
    newSessionId: () => uuid(++n), mcp: null, track: () => ({ release() {} }), inspectConfig: async () => [],
    usage: { read: () => null, has: (id) => transcripts.has(id), forget() {} }, persist: () => { persisted.n++; },
  });
  return { f, db, mgr, persisted, transcripts };
}
const open = async (w, opts = {}) => { const r = await w.mgr.create({ role: 'builder', ...opts }); assert.equal(r.ok, true, r.error); const rec = w.db.terminalSessions.at(-1); w.transcripts.add(rec.claudeSessionId); return { r, rec, p: w.f.spawned.at(-1) }; };
const hist = (w, rec) => w.mgr.history().find((h) => h.id === rec.id);

test('terminal que termina sozinho: exited + closedReason "exit"', async () => {
  const w = world(); const { rec, p } = await open(w);
  assert.equal(rec.closedReason, undefined, 'aberto: ainda sem motivo'); p.exit(0);
  assert.deepEqual([rec.state, rec.closedReason], ['exited', 'exit']); assert.equal(hist(w, rec).closedReason, 'exit');
});

test('fechado pelo usuário (close): exited + "user"; fechar de novo não muda o motivo', async () => {
  const w = world(); const { r, rec } = await open(w);
  assert.equal(w.mgr.close(r.session.id).ok, true);
  assert.deepEqual([rec.state, rec.closedReason], ['exited', 'user']); assert.equal(hist(w, rec).closedReason, 'user');
  const w2 = world(); const { r: r2, rec: rec2, p: p2 } = await open(w2); p2.exit(0); w2.mgr.close(r2.session.id);
  assert.equal(rec2.closedReason, 'exit', 'já tinha terminado sozinho: close() só remove da lista');
});

test('encerramento gracioso do servidor (killAllSync): a sessão fica "interrupted" + "shutdown", retomável e gravada; terminal já fechado não é afetado', async () => {
  const w = world(); const a = await open(w, { title: 'A' }), b = await open(w, { title: 'B' }), c = await open(w, { title: 'C' });
  w.mgr.close(c.r.session.id); b.p.exit(0); // C: fechado pelo usuário; B: terminou sozinho; A: segue aberto
  const before = w.persisted.n; w.mgr.killAllSync();
  assert.deepEqual([a.rec.state, a.rec.closedReason, a.rec.exitCode], ['interrupted', 'shutdown', null]); assert.ok(a.rec.interruptedAt); assert.ok(a.rec.endedAt); assert.ok(w.persisted.n > before, 'gravou');
  assert.deepEqual([b.rec.state, b.rec.closedReason], ['exited', 'exit']); assert.deepEqual([c.rec.state, c.rec.closedReason], ['exited', 'user']);
  const h = hist(w, a.rec); assert.deepEqual([h.state, h.closedReason, h.resumable, h.blockedReason], ['interrupted', 'shutdown', true, null]);
  // a retomada leva a sessão de volta a "running" e apaga o motivo antigo
  const res = await w.mgr.resume({ recordId: a.rec.id }); assert.equal(res.ok, true, res.error);
  assert.deepEqual([a.rec.state, a.rec.closedReason, a.rec.interruptedAt], ['running', undefined, undefined]); assert.equal(hist(w, a.rec).closedReason, null);
});

test('shutdown cuja morte do processo NÃO foi confirmada: interrupted, mas continua bloqueada para retomar (nunca dois processos na mesma transcrição)', async () => {
  const w = world({ waitFor: () => false, pidIsAlive: () => true }); const a = await open(w);
  w.mgr.killAllSync();
  assert.deepEqual([a.rec.state, a.rec.closedReason, a.rec.unconfirmedExit], ['interrupted', 'shutdown', true]);
  const h = hist(w, a.rec); assert.equal(h.resumable, false); assert.equal(h.blockedReason, 'session_active');
});

test('boot após queda: running vira interrupted + "crash"; motivo ausente ou inválido no banco vira null no histórico', () => {
  const rec = (id, over) => ({ id, terminalId: 'term_aaaaaaaa', claudeSessionId: uuid(Number(id.slice(-1)) + 1), workspaceId: 'ws', cwd: wsDir, role: 'builder', title: 't', ...over });
  const db = { settings: {}, workspaces: [], terminalSessions: [rec('ses_aaaaaaa1', { state: 'running' }), rec('ses_aaaaaaa2', { state: 'exited' }), rec('ses_aaaaaaa3', { state: 'exited', closedReason: 'inventado' })] };
  const w = world({ db });
  assert.deepEqual([db.terminalSessions[0].state, db.terminalSessions[0].closedReason], ['interrupted', 'crash']);
  assert.deepEqual(w.mgr.history().map((h) => [h.id, h.closedReason]).sort(), [['ses_aaaaaaa1', 'crash'], ['ses_aaaaaaa2', null], ['ses_aaaaaaa3', null]]);
});

test('o motivo sobrevive ao banco: save + leitura mantêm closedReason, e um valor desconhecido NÃO descarta o registro', () => {
  const db = store.load(); db.workspaces.push({ id: 'ws_t', name: 't', path: wsDir });
  const base = { terminalId: 'term_aaaaaaaa', workspaceId: 'ws_t', cwd: wsDir, role: 'builder', title: 't', state: 'interrupted' };
  db.terminalSessions = [{ id: 'ses_bbbbbbb1', claudeSessionId: uuid(1), closedReason: 'shutdown', ...base }, { id: 'ses_bbbbbbb2', claudeSessionId: uuid(2), closedReason: 'valor-futuro', ...base }];
  store.save(); const again = JSON.parse(fs.readFileSync(path.join(process.env.ORCH_DATA_DIR, 'db.json'), 'utf8'));
  assert.deepEqual(again.terminalSessions.map((r) => r.closedReason), ['shutdown', 'valor-futuro']);
  assert.equal(store.sanitizeTerminalSessions(again), 0, 'nenhum registro descartado pela validação');
});

test('fiação do desligamento: o evento exit do processo (installShutdown) deixa os terminais abertos como interrupted + "shutdown"', async () => {
  const w = world(); const a = await open(w); const proc = new EventEmitter();
  installShutdown({ lock: { release() {} }, executor: null, store: { flush() {} }, children: [{ killActiveSync: () => w.mgr.killAllSync() }], proc, exit() {} });
  proc.emit('exit', 0);
  assert.deepEqual([a.rec.state, a.rec.closedReason], ['interrupted', 'shutdown']);
});
