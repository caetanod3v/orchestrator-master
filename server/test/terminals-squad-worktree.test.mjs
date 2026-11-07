// Um worktree por SQUAD: o 1º terminal cria, os outros entram nele (worktreeId). Repositório Git REAL e temporário, gerenciador de worktrees REAL, PTY simulado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sqwt-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const store = await import('../store.js');
const W = await import('../worktrees.js');
const T = await import('../terminals.js');
const db = store.load(); db.missions = []; db.workspaces = []; store.saveOrThrow();
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=teste', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const mkRepo = (name) => { const r = path.join(tmp, name); fs.mkdirSync(r); G(r, 'init', '-q', '-b', 'main'); G(r, 'config', 'core.autocrlf', 'false'); fs.writeFileSync(path.join(r, 'a.txt'), 'a\n'); G(r, 'add', '-A'); G(r, 'commit', '-q', '-m', 'base'); return r; };
const repo = mkRepo('repo'), repo2 = mkRepo('repo2');
db.workspaces.push({ id: 'ws1', name: 'ws1', path: repo, verifications: [] }, { id: 'ws2', name: 'ws2', path: repo2, verifications: [] });
db.settings = { ...(db.settings ?? {}), activeWorkspaceId: 'ws1' };
const wtm = W.createWorktreeManager({ db, root: path.join(tmp, 'wts') });
let pid = 1_900_700_000; const lib = { spawn(f, a, o) { return { pid: ++pid, args: a, opts: o, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; } };
const mgr = T.createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'x', args: [], viaShell: false }), killTree() {}, waitFor: () => true, worktrees: wtm, transcriptExists: () => true });

/** Abre um squad como a tela faz: o 1º cria o worktree, os demais entram nele. */
async function squad(n, workspaceId = 'ws1') {
  const first = await mgr.create({ isolate: true, workspaceId }); assert.equal(first.ok, true, first.error);
  const rest = await Promise.all(Array.from({ length: n - 1 }, () => mgr.create({ isolate: true, workspaceId, squadId: first.session.squadId })));
  for (const r of rest) assert.equal(r.ok, true, r.error);
  return [first.session, ...rest.map((r) => r.session)];
}

test('squad de 4 = UM worktree: mesmo caminho, mesmo registro, em uso enquanto algum terminal roda', async () => {
  const before = wtm.list().length, s = await squad(4);
  assert.equal(wtm.list().length, before + 1, 'só um worktree novo para os 4 terminais');
  assert.equal(new Set(s.map((x) => x.worktreeId)).size, 1); assert.equal(new Set(s.map((x) => x.cwd)).size, 1); assert.equal(s[0].cwd, wtm.get(s[0].worktreeId).path);
  assert.equal(wtm.get(s[0].worktreeId).state, 'in_use');
  assert.ok(db.terminalSessions.filter((r) => r.worktreeId === s[0].worktreeId).every((r) => r.sharedWorktree === true), 'sessões do squad marcadas como compartilhadas');
  for (const x of s) mgr.close(x.id);
});

test('o worktree só volta a "terminado" quando o ÚLTIMO terminal do squad sai; nada é removido', async () => {
  const s = await squad(3), id = s[0].worktreeId; fs.writeFileSync(path.join(wtm.get(id).path, 'novo.txt'), 'trabalho\n');
  mgr.close(s[0].id); assert.equal(wtm.get(id).state, 'in_use', 'ainda há 2 terminais nele');
  mgr.close(s[1].id); assert.equal(wtm.get(id).state, 'in_use');
  mgr.close(s[2].id); assert.equal(wtm.get(id).state, 'finished');
  assert.ok(fs.existsSync(path.join(wtm.get(id).path, 'novo.txt')), 'o trabalho do squad continua lá');
});

test('compartilhar só vale com a chave de squad emitida pelo servidor, de terminal ATIVO do mesmo workspace; o cliente não escolhe worktree', async () => {
  const s = await squad(2), key = s[0].squadId;
  assert.ok(key && s.every((x) => x.squadId === key), 'o squad todo tem a mesma chave');
  let r = await mgr.create({ workspaceId: 'ws2', isolate: true, squadId: key }); assert.equal(r.status, 409); assert.equal(r.code, 'squad_workspace', 'de outro workspace');
  r = await mgr.create({ isolate: true, squadId: 'sq_inventado' }); assert.equal(r.status, 409); assert.equal(r.code, 'squad_not_found');
  r = await mgr.create({ isolate: true, squadId: 42 }); assert.equal(r.status, 400); assert.equal(r.code, 'squad_invalid');
  r = await mgr.create({ isolate: true, squadId: '' }); assert.equal(r.status, 400);
  r = await mgr.create({ isolate: true, worktreeId: s[0].worktreeId }); assert.equal(r.ok, true); assert.notEqual(r.session.worktreeId, s[0].worktreeId, 'worktreeId vindo do cliente é ignorado: nasce um worktree próprio');
  mgr.close(r.session.id);
  for (const x of s) mgr.close(x.id);
  r = await mgr.create({ isolate: true, squadId: key }); assert.equal(r.status, 409); assert.equal(r.code, 'squad_not_found', 'ninguém ativo: não se anexa a um worktree parado');
  assert.equal(mgr.count(), 0, 'nenhum terminal nasceu nas recusas');
});

test('terminal avulso continua com worktree PRÓPRIO; sem isolate, roda no workspace', async () => {
  const before = wtm.list().length, a = await mgr.create({ isolate: true }), b = await mgr.create({ isolate: true }), c = await mgr.create({});
  assert.equal(wtm.list().length, before + 2); assert.notEqual(a.session.worktreeId, b.session.worktreeId);
  assert.equal(c.session.worktreeId, null); assert.equal(c.session.cwd, repo);
  for (const x of [a, b, c]) mgr.close(x.session.id);
});

test('retomar um terminal do squad com os irmãos rodando é permitido (compartilhado); um avulso ocupado continua recusando', async () => {
  const s = await squad(2), rid = (sid) => db.terminalSessions.find((r) => r.terminalId === sid).id;
  const recA = rid(s[0].id); mgr.close(s[0].id);
  const back = await mgr.resume({ recordId: recA }); assert.equal(back.ok, true, back.error); assert.equal(back.session.worktreeId, s[1].worktreeId); assert.equal(back.session.cwd, s[1].cwd);
  mgr.close(back.session.id); mgr.close(s[1].id);
  const solo = (await mgr.create({ isolate: true })).session, soloRec = rid(solo.id);
  const dup = await mgr.resume({ recordId: soloRec }); assert.equal(dup.ok, false, 'a sessão já está ativa'); mgr.close(solo.id);
});
