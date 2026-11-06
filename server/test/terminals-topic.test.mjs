// topicId nas sessões de terminal (terminals.js): validação em POST /api/terminals, persistência, histórico, retomada/fork e isolamento por workspace.
// PTY SIMULADO (nenhum Claude real), banco em memória, ORCH_DATA_DIR temporário e porta livre (nunca a 4317).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import express from 'express';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-topic-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const T = await import('../terminals.js');
const servers = [];
after(() => { for (const s of servers) s.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const dirA = path.join(tmp, 'wsA'), dirB = path.join(tmp, 'wsB'); fs.mkdirSync(dirA); fs.mkdirSync(dirB);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakePty() {
  const spawned = []; let pid = 1_900_000_000;
  return { spawned, lib: { spawn(file, args, opts) { const p = { pid: ++pid, file, args, opts, onData() {}, onExit(cb) { p.exitCb = cb; }, write() {}, resize() {}, exit(code = 0) { p.exitCb({ exitCode: code }); } }; spawned.push(p); return p; } } };
}
function world() {
  const f = fakePty(); let n = 0;
  const db = {
    settings: { activeWorkspaceId: 'wsA' },
    workspaces: [{ id: 'wsA', name: 'A', path: dirA }, { id: 'wsB', name: 'B', path: dirB }],
    worktrees: [],
    topics: [
      { id: 'top_a1', workspaceId: 'wsA', title: 'Login' },
      { id: 'top_b1', workspaceId: 'wsB', title: 'Outro' },
      { id: 'top_old', workspaceId: 'wsA', title: 'Velho', archivedAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
  const transcripts = new Set();
  const mgr = T.createTerminalManager({
    db, ptyLib: f.lib, resolveCommand: () => ({ file: 'C:/fake/claude.exe', args: [], viaShell: false }), killTree: () => {}, waitFor: () => true,
    newSessionId: () => uuid(++n), mcp: null, track: () => ({ release() {} }), inspectConfig: async () => [], sweepMs: 0,
    usage: { read: () => null, has: (id) => transcripts.has(id), forget() {} }, persist: () => {},
  });
  return { f, db, mgr, transcripts };
}

test('sem topicId a sessão é "Geral" (null) em describe, registro e histórico', async () => {
  const w = world(); const r = await w.mgr.create({ role: 'builder' });
  assert.equal(r.ok, true, r.error); assert.equal(r.session.topicId, null);
  assert.equal(w.db.terminalSessions[0].topicId, null);
  assert.equal(w.mgr.history()[0].topicId, null); assert.equal(w.mgr.list()[0].topicId, null);
  const r2 = await w.mgr.create({ role: 'builder', topicId: null }); assert.equal(r2.session.topicId, null);
});

test('topicId válido: devolvido, gravado no registro e no histórico', async () => {
  const w = world(); const r = await w.mgr.create({ role: 'builder', topicId: 'top_a1' });
  assert.equal(r.ok, true, r.error); assert.equal(r.status, 201);
  assert.equal(r.session.topicId, 'top_a1'); assert.equal(r.session.workspaceId, 'wsA');
  assert.equal(w.db.terminalSessions[0].topicId, 'top_a1');
  assert.equal(w.mgr.history()[0].topicId, 'top_a1'); assert.equal(w.mgr.get(r.session.id).topicId, 'top_a1');
});

test('topicId inválido dá 400 em pt-BR e NÃO abre processo nem registro', async () => {
  const w = world();
  const casos = [
    [{ topicId: 'top_nao_existe' }, /não encontrado/i],
    [{ topicId: 'top_old' }, /arquivado/i],
    [{ topicId: 'top_b1' }, /outro espaço de trabalho/i], // tópico do wsB com sessão do wsA (ativo)
    [{ topicId: 42 }, /identificador/i], [{ topicId: '' }, /identificador/i], [{ topicId: { id: 'top_a1' } }, /identificador/i],
    [{ workspaceId: 'wsB', topicId: 'top_a1' }, /outro espaço de trabalho/i], // workspace explícito diferente do tópico
  ];
  for (const [o, re] of casos) {
    const r = await w.mgr.create({ role: 'builder', ...o });
    assert.equal(r.ok, false, JSON.stringify(o)); assert.equal(r.status, 400, JSON.stringify(o)); assert.equal(r.code, 'topic_invalid'); assert.match(r.error, re, JSON.stringify(o));
  }
  assert.equal(w.f.spawned.length, 0, 'nenhum processo aberto'); assert.equal(w.db.terminalSessions, undefined, 'nenhum registro criado'); assert.equal(w.mgr.count(), 0);
});

test('db sem db.topics (banco antigo): topicId vira 400, Geral continua funcionando', async () => {
  const w = world(); delete w.db.topics;
  const r = await w.mgr.create({ role: 'builder', topicId: 'top_a1' }); assert.equal(r.status, 400);
  const g = await w.mgr.create({ role: 'builder' }); assert.equal(g.ok, true);
});

test('workspaceId explícito: o diretório vem do cadastro; inexistente ou de tipo errado dá 400', async () => {
  const w = world();
  const b = await w.mgr.create({ role: 'builder', workspaceId: 'wsB', topicId: 'top_b1' });
  assert.equal(b.ok, true, b.error); assert.equal(b.session.workspaceId, 'wsB'); assert.equal(b.session.cwd, dirB); assert.equal(w.f.spawned[0].opts.cwd, dirB);
  for (const bad of ['ws_fantasma', 7, {}, ['wsA'], '']) {
    const r = await w.mgr.create({ role: 'builder', workspaceId: bad });
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.code, 'workspace_not_found');
  }
  assert.equal(w.f.spawned.length, 1, 'só o terminal válido abriu processo');
  const ativo = await w.mgr.create({ role: 'builder' }); assert.equal(ativo.session.workspaceId, 'wsA'); assert.equal(ativo.session.cwd, dirA); // sem workspaceId: o ativo, como antes
});

test('o cwd nunca vem do cliente: campos extras (cwd, path, worktreeId) são ignorados', async () => {
  const w = world();
  const r = await w.mgr.create({ role: 'builder', topicId: 'top_a1', cwd: dirB, path: dirB, worktreeId: 'wt_x' });
  assert.equal(r.ok, true, r.error); assert.equal(r.session.cwd, dirA); assert.equal(w.f.spawned[0].opts.cwd, dirA); assert.equal(r.session.worktreeId, null);
});

test('retomada e fork mantêm o topicId quando o tópico continua válido', async () => {
  const w = world(); await w.mgr.create({ role: 'builder', topicId: 'top_a1' });
  const rec = w.db.terminalSessions[0]; w.transcripts.add(rec.claudeSessionId); w.f.spawned[0].exit(0);
  const again = await w.mgr.resume({ recordId: rec.id });
  assert.equal(again.ok, true, again.error); assert.equal(again.session.topicId, 'top_a1'); assert.equal(rec.topicId, 'top_a1'); assert.equal(w.mgr.history()[0].topicId, 'top_a1');
  w.f.spawned[1].exit(0);
  const fk = await w.mgr.resume({ recordId: rec.id, fork: true });
  assert.equal(fk.ok, true, fk.error); assert.equal(fk.session.topicId, 'top_a1');
  const frec = w.db.terminalSessions.at(-1); assert.equal(frec.topicId, 'top_a1'); assert.equal(frec.forkedFrom, rec.id); assert.notEqual(frec.id, rec.id);
});

for (const [nome, muda] of [['arquivado', (db) => { db.topics.find((t) => t.id === 'top_a1').archivedAt = '2026-02-02T00:00:00.000Z'; }], ['removido', (db) => { db.topics = db.topics.filter((t) => t.id !== 'top_a1'); }], ['de outro workspace', (db) => { db.topics.find((t) => t.id === 'top_a1').workspaceId = 'wsB'; }]]) {
  test(`retomada e fork com tópico ${nome}: voltam para Geral (null) sem bloquear`, async () => {
    const w = world(); await w.mgr.create({ role: 'builder', topicId: 'top_a1' });
    const rec = w.db.terminalSessions[0]; w.transcripts.add(rec.claudeSessionId); w.f.spawned[0].exit(0); muda(w.db);
    const again = await w.mgr.resume({ recordId: rec.id });
    assert.equal(again.ok, true, again.error); assert.equal(again.session.topicId, null); assert.equal(rec.topicId, null); assert.equal(w.mgr.history()[0].topicId, null);
    assert.equal(again.session.workspaceId, 'wsA'); assert.equal(again.session.cwd, dirA);
    w.f.spawned[1].exit(0);
    const fk = await w.mgr.resume({ recordId: rec.id, fork: true });
    assert.equal(fk.ok, true, fk.error); assert.equal(fk.session.topicId, null); assert.equal(w.db.terminalSessions.at(-1).topicId, null);
  });
}

test('registro antigo sem topicId: retomada e histórico devolvem null', async () => {
  const w = world(); await w.mgr.create({ role: 'builder' });
  const rec = w.db.terminalSessions[0]; delete rec.topicId; w.transcripts.add(rec.claudeSessionId); w.f.spawned[0].exit(0);
  assert.equal(w.mgr.history()[0].topicId, null);
  const again = await w.mgr.resume({ recordId: rec.id }); assert.equal(again.ok, true, again.error); assert.equal(again.session.topicId, null);
});

test('HTTP: POST /api/terminals aceita topicId e responde 400 pt-BR para inválidos', async () => {
  const w = world(); const app = express(); app.use(express.json()); T.setupTerminals(app, { manager: w.mgr });
  app.use((err, req, res, next) => res.status(500).json({ error: String(err?.message ?? err) })); // eslint-disable-line no-unused-vars
  const srv = http.createServer(app); servers.push(srv); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (body) => { const r = await fetch(`${base}/api/terminals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const ok = await post({ role: 'builder', topicId: 'top_a1' }); assert.equal(ok.status, 201); assert.equal(ok.json.session.topicId, 'top_a1');
  const arq = await post({ role: 'builder', topicId: 'top_old' }); assert.equal(arq.status, 400); assert.match(arq.json.error, /arquivado/);
  const out = await post({ role: 'builder', topicId: 'top_b1' }); assert.equal(out.status, 400);
  const num = await post({ role: 'builder', topicId: 5 }); assert.equal(num.status, 400);
  const ws = await post({ role: 'builder', workspaceId: 'ws_fantasma' }); assert.equal(ws.status, 400); assert.match(ws.json.error, /Espaço de trabalho/);
  const wsn = await post({ role: 'builder', workspaceId: 123 }); assert.equal(wsn.status, 400);
  const geral = await post({ role: 'builder' }); assert.equal(geral.status, 201); assert.equal(geral.json.session.topicId, null);
  const list = await (await fetch(`${base}/api/terminals`)).json(); assert.equal(list.sessions.length, 2);
  w.mgr.killAllSync();
});
