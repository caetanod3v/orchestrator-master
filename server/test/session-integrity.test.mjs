// Etapa 6: integridade das sessões — cada sessão preserva o workspace de origem na criação, retomada, fork, encerramento e reinício.
// PTY SIMULADO, banco em memória e ORCH_DATA_DIR temporário (nada real é tocado).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-integ-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const T = await import('../terminals.js');
const store = await import('../store.js');
const { workspaceRemovalBlocker } = await import('../workspaces.js');
const { default: express } = await import('express');
const L = await import('../layouts.js');
const { apiGuard } = await import('../origin-guard.js');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const dirA = path.join(tmp, 'wsA'), dirB = path.join(tmp, 'wsB'); fs.mkdirSync(dirA); fs.mkdirSync(dirB);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakePty() {
  const spawned = []; let pid = 1_700_000_000;
  const lib = { spawn(file, args, opts) { const p = { pid: ++pid, args, opts, dataCb: null, exitCb: null, onData(cb) { p.dataCb = cb; }, onExit(cb) { p.exitCb = cb; }, write() {}, resize() {}, exit(code = 0) { p.exitCb({ exitCode: code }); } }; spawned.push(p); return p; } };
  return { lib, spawned };
}
const mkDb = () => ({ settings: { activeWorkspaceId: 'wsB' }, workspaces: [{ id: 'wsA', name: 'A', path: dirA }, { id: 'wsB', name: 'B', path: dirB }], worktrees: [] });
/** Gerente de terminais sobre um banco (compartilhável entre "execuções" para simular reinício). */
function boot(db, pty = fakePty(), nStart = 0) {
  let n = nStart; const transcripts = new Set(); for (const r of db.terminalSessions ?? []) transcripts.add(r.claudeSessionId);
  const mgr = T.createTerminalManager({ db, ptyLib: pty.lib, resolveCommand: () => ({ file: 'C:/fake/claude.exe', args: [], viaShell: false }), killTree() {}, waitFor: () => true,
    newSessionId: () => uuid(++n), mcp: null, worktrees: null, track: () => ({ release() {} }), inspectConfig: async () => [], sweepMs: 0,
    usage: { read: () => null, has: (id) => transcripts.has(id), forget() {} }, persist: () => {} });
  return { mgr, pty, transcripts };
}
const wsOf = (db, id) => db.terminalSessions.find((r) => r.id === id).workspaceId;

test('o workspace da sessão vem do pedido, não do workspace ativo; retomada e fork o preservam mesmo com outro workspace ativo', async () => {
  const db = mkDb(); const w = boot(db);
  const r = await w.mgr.create({ role: 'builder', workspaceId: 'wsA' }); assert.equal(r.ok, true, r.error);
  assert.equal(r.session.workspaceId, 'wsA'); assert.equal(db.settings.activeWorkspaceId, 'wsB', 'o ativo é outro');
  assert.equal(w.pty.spawned.at(-1).opts.cwd, dirA);
  const rec = db.terminalSessions[0]; w.transcripts.add(rec.claudeSessionId); w.pty.spawned.at(-1).exit(0);
  const res = await w.mgr.resume({ recordId: rec.id }); assert.equal(res.ok, true, res.error);
  assert.equal(res.session.workspaceId, 'wsA'); assert.equal(rec.workspaceId, 'wsA'); assert.equal(w.pty.spawned.at(-1).opts.cwd, dirA, 'retoma no diretório do workspace de origem');
  w.pty.spawned.at(-1).exit(0);
  const fk = await w.mgr.resume({ recordId: rec.id, fork: true }); assert.equal(fk.ok, true, fk.error);
  const frec = db.terminalSessions.find((x) => x.id === fk.session.recordId);
  assert.deepEqual([fk.session.workspaceId, frec.workspaceId, frec.cwd, frec.forkedFrom, w.pty.spawned.at(-1).opts.cwd], ['wsA', 'wsA', dirA, rec.id, dirA]);
  assert.equal(wsOf(db, rec.id), 'wsA', 'a original continua no mesmo workspace');
  w.pty.spawned.at(-1).exit(0);
  assert.ok(w.mgr.history().every((h) => h.workspaceId === 'wsA'), 'o histórico mostra tudo em wsA');
});

test('encerrar (pelo usuário ou sozinho) não muda o workspace do registro; reinício real do banco (JSON) mantém tudo e retoma no lugar certo', async () => {
  const db = mkDb(); const w = boot(db);
  const a = await w.mgr.create({ role: 'builder', workspaceId: 'wsA' }), b = await w.mgr.create({ role: 'reviewer', workspaceId: 'wsB' });
  assert.equal(w.mgr.close(a.session.id).ok, true); // fechado pelo usuário
  const recA = db.terminalSessions[0], recB = db.terminalSessions[1];
  assert.deepEqual([recA.workspaceId, recA.closedReason, recA.state], ['wsA', 'user', 'exited']);
  assert.deepEqual([recB.workspaceId, recB.state], ['wsB', 'running']);
  // queda do servidor: o banco é reaberto a partir do JSON gravado, num gerente novo
  const db2 = JSON.parse(JSON.stringify(db)); db2.settings.activeWorkspaceId = 'wsA';
  const w2 = boot(db2, fakePty(), 10);
  assert.deepEqual(db2.terminalSessions.map((r) => [r.id === recA.id ? 'A' : 'B', r.workspaceId, r.state]), [['A', 'wsA', 'exited'], ['B', 'wsB', 'interrupted']]);
  const rb = await w2.mgr.resume({ recordId: recB.id }); assert.equal(rb.ok, true, rb.error);
  assert.deepEqual([rb.session.workspaceId, w2.pty.spawned.at(-1).opts.cwd], ['wsB', dirB], 'wsB retoma em wsB mesmo com wsA ativo');
  const ra = await w2.mgr.resume({ recordId: recA.id }); assert.equal(ra.ok, true, ra.error);
  assert.deepEqual([ra.session.workspaceId, w2.pty.spawned.at(-1).opts.cwd], ['wsA', dirA]);
});

test('nunca migra para outro workspace: registro com cwd de outro workspace, workspace removido ou caminho trocado não retomam nem fazem fork', async () => {
  const db = mkDb(); const w = boot(db);
  const r = await w.mgr.create({ role: 'builder', workspaceId: 'wsA' }); const rec = db.terminalSessions[0]; w.transcripts.add(rec.claudeSessionId); w.pty.spawned.at(-1).exit(0);
  rec.workspaceId = 'wsB'; // adulteração: o registro aponta para B, mas o diretório gravado é o de A
  for (const fork of [false, true]) { const x = await w.mgr.resume({ recordId: rec.id, fork }); assert.equal(x.ok, false); assert.equal(x.code, 'cwd_mismatch'); }
  rec.workspaceId = 'wsA'; db.workspaces = db.workspaces.filter((x) => x.id !== 'wsA');
  const gone = await w.mgr.resume({ recordId: rec.id }); assert.equal(gone.code, 'workspace_missing');
  db.workspaces.push({ id: 'wsA2', name: 'A', path: dirA }); // mesmo diretório recadastrado = OUTRO workspace: a sessão não é adotada
  const again = await w.mgr.resume({ recordId: rec.id }); assert.equal(again.code, 'workspace_missing'); assert.equal(rec.workspaceId, 'wsA');
  assert.equal(r.ok, true);
});

test('workspace com terminal aberto não pode ser removido; depois de fechar, pode', async () => {
  const db = mkDb(); const w = boot(db);
  const r = await w.mgr.create({ role: 'builder', workspaceId: 'wsA' });
  assert.match(workspaceRemovalBlocker({ ...db, missions: [] }, 'wsA', w.mgr) ?? '', /terminal/);
  assert.equal(workspaceRemovalBlocker({ ...db, missions: [] }, 'wsB', w.mgr), null, 'o outro workspace não é afetado');
  w.pty.spawned.at(-1).exit(0); // terminou sozinho (ainda listado, mas não rodando)
  assert.equal(workspaceRemovalBlocker({ ...db, missions: [] }, 'wsA', w.mgr), null);
  assert.equal(r.ok, true);
});

test('banco: forkedFrom que cruza workspaces é descartado na leitura; o mesmo workspace permanece', () => {
  const rec = (id, ws, forkedFrom) => ({ id, claudeSessionId: uuid(1), terminalId: 'term_x', workspaceId: ws, cwd: '/x', role: 'builder', title: 't', state: 'exited', forkedFrom });
  const d = { terminalSessions: [rec('ses_00000001', 'wsA', null), rec('ses_00000002', 'wsA', 'ses_00000001'), rec('ses_00000003', 'wsB', 'ses_00000001')] };
  store.sanitizeTerminalSessions(d);
  assert.deepEqual(d.terminalSessions.map((r) => r.forkedFrom), [null, 'ses_00000001', null]);
});

test('layout: só referencia sessões do próprio workspace (PUT recusa as de outro; GET ignora as que já estavam gravadas)', async () => {
  const db = store.load();
  db.workspaces.push({ id: 'wsA', name: 'A', path: dirA }, { id: 'wsB', name: 'B', path: dirB });
  const R = (n) => `ses_${String(n).padStart(8, '0')}`;
  const base = { claudeSessionId: uuid(1), terminalId: 'term_x', cwd: '/x', role: 'builder', title: 't', state: 'exited' };
  db.terminalSessions = [{ ...base, id: R(1), workspaceId: 'wsA' }, { ...base, id: R(2), workspaceId: 'wsA' }, { ...base, id: R(3), workspaceId: 'wsB' }];
  const app = express(); app.use('/api', apiGuard); app.use(express.json()); L.setupLayouts(app, { db });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const url = `http://127.0.0.1:${server.address().port}`;
  const call = (u, method = 'GET', body) => fetch(url + u, { method, headers: { 'content-type': 'application/json', origin: url }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await call('/api/workspaces/wsA/layout', 'PUT', { order: [R(1), R(3)] })).status, 400, 'R(3) é de wsB');
    assert.equal((await call('/api/workspaces/wsA/layout', 'PUT', { maximized: R(3) })).status, 400);
    assert.equal((await call('/api/workspaces/wsA/layout', 'PUT', { order: [R(2), R(1), 'ses_0000ffff'], maximized: R(1) })).status, 200, 'sessão de wsA e id sem registro (podado) passam');
    db.settings.layouts.wsB = { order: [R(1), R(3)], maximized: R(1), grids: {} }; // gravado antes desta regra
    const got = (await (await call('/api/layouts')).json()).layouts;
    assert.deepEqual([got.wsB.order, got.wsB.maximized], [[R(3)], null]);
    assert.deepEqual(got.wsA.order, [R(2), R(1), 'ses_0000ffff']);
  } finally { server.close(); server.closeAllConnections?.(); }
});
