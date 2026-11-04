// Worktrees dos terminais (panes isolados): repositórios Git REAIS e temporários, gerenciador de worktrees REAL, PTY simulado. Prova que o ciclo de vida é seguro:
// o terminal roda no worktree, a integração pelo gate estrito NUNCA vale (não há ciclo nem evidência), a limpeza só remove o que não tem trabalho a perder e a branch principal nunca muda.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-twt-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const store = await import('../store.js');
const W = await import('../worktrees.js');
const T = await import('../terminals.js');
const V = await import('../../client/src/worktree-view.js');
const db = store.load(); db.missions = []; db.workspaces = []; store.saveOrThrow();
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=teste', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
G(repo, 'init', '-q', '-b', 'main'); G(repo, 'config', 'core.autocrlf', 'false'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); G(repo, 'add', '-A'); G(repo, 'commit', '-q', '-m', 'base');
const ws = { id: 'ws1', name: 'ws1', path: repo, verifications: [] }; db.workspaces.push(ws); db.settings = { ...(db.settings ?? {}), activeWorkspaceId: 'ws1' };
const wtm = W.createWorktreeManager({ db, root: path.join(tmp, 'wts') });
let pid = 1_900_500_000; const lib = { spawn(f, a, o) { return { pid: ++pid, args: a, opts: o, onData() {}, onExit() {}, write() {}, resize() {} }; } };
const mgr = T.createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'x', args: [], viaShell: false }), killTree() {}, waitFor: () => true, worktrees: wtm });
const mainHead = () => G(repo, 'rev-parse', 'HEAD'), mainStatus = () => G(repo, 'status', '--porcelain', '-uall');

test('o terminal isolado roda no worktree próprio (missionId = id do terminal) e o helper do cliente o reconhece', async () => {
  const a = await mgr.create({ isolate: true }); assert.equal(a.ok, true, a.error);
  const rec = wtm.get(a.session.worktreeId); assert.equal(rec.missionId, a.session.id); assert.equal(a.session.cwd, rec.path); assert.notEqual(rec.path, repo);
  const items = wtm.list(); assert.equal(V.terminalWorktrees(items).length, 1); assert.equal(V.terminalWorktrees([{ ...items[0], missionId: 'm1' }]).length, 0, 'worktree de missão não entra');
  assert.equal(V.terminalWorktrees([{ ...items[0], state: 'removed' }]).length, 0, 'removido some da lista');
  assert.equal(V.worktreeView(V.terminalWorktrees(items))[0].canCleanup, false, 'com o terminal rodando o servidor marca o worktree em uso');
  mgr.close(a.session.id); assert.equal(V.worktreeView(V.terminalWorktrees(wtm.list()))[0].canCleanup, true, 'depois de encerrar a limpeza é oferecida');
  items.splice(0, items.length, ...wtm.list());
  const busy = V.markInUse(V.worktreeView(V.terminalWorktrees(items)), new Set([rec.id])); assert.deepEqual([busy[0].canCleanup, busy[0].note], [false, V.IN_USE_NOTE], 'terminal ativo: limpeza não é oferecida');
  assert.equal(V.markInUse(V.worktreeView(V.terminalWorktrees(items)), []).every((r) => r.canCleanup), true);
});

test('gate estrito intacto: um worktree de terminal NUNCA é integrável (sem ciclo nem evidência) e a branch principal não muda; sem trabalho, a limpeza funciona', async () => {
  const head0 = mainHead(), a = (await mgr.create({ isolate: true })).session, rec = wtm.get(a.worktreeId);
  fs.writeFileSync(path.join(rec.path, 'novo.txt'), 'trabalho\n'); // trabalho não commitado do agente
  assert.equal(wtm.get(rec.id).state, 'in_use', 'com o terminal rodando o worktree está em uso'); assert.equal((await wtm.cleanup(rec.id)).ok, false); assert.equal((await wtm.snapshot(rec.id)).ok, false); assert.ok(fs.existsSync(path.join(rec.path, 'novo.txt')));
  mgr.close(a.id); assert.equal(wtm.get(rec.id).state, 'finished', 'terminal encerrado: worktree parado, nada removido'); assert.ok(fs.existsSync(path.join(rec.path, 'novo.txt')));
  const c = await wtm.check(rec.id); assert.equal(c.ok, true); assert.equal(c.attempt.result, 'invalid'); const codes = c.attempt.problems.map((p) => p.code);
  assert.ok(codes.includes('cycle_missing') && codes.includes('uncommitted_changes'), codes.join(','));
  const bad = await wtm.integrate(rec.id, { digest: 'a'.repeat(32) }); assert.equal(bad.ok, false); assert.equal(bad.status, 409);
  assert.equal(mainHead(), head0, 'a branch principal não mudou'); assert.equal(mainStatus(), '', 'o workspace principal está limpo');
  // com alterações não commitadas a limpeza é recusada e o arquivo continua lá
  const refused = await wtm.cleanup(rec.id); assert.equal(refused.ok, false); assert.match(refused.error, /alteração|não commitadas/); assert.ok(fs.existsSync(path.join(rec.path, 'novo.txt')));
  // snapshot registra o trabalho NA BRANCH DO WORKTREE; ainda assim a limpeza recusa (commit não integrado) e nada é perdido
  const snap = await wtm.snapshot(rec.id, { message: 'trabalho do pane' }); assert.equal(snap.ok, true, snap.error);
  assert.equal(mainHead(), head0, 'o snapshot não toca a branch principal'); assert.match(G(repo, 'log', '--oneline', rec.branch), /trabalho do pane/);
  const refused2 = await wtm.cleanup(rec.id); assert.equal(refused2.ok, false); assert.match(refused2.error, /NÃO integrados/); assert.ok(fs.existsSync(path.join(rec.path, 'novo.txt')));
  // depois que o usuário integra com o Git (fora do app), a limpeza fica liberada e remove worktree e branch
  G(repo, 'merge', '--no-edit', rec.branch); const ok = await wtm.cleanup(rec.id); assert.equal(ok.ok, true, ok.error); assert.equal(wtm.get(rec.id).state, 'removed'); assert.ok(!fs.existsSync(rec.path));
  assert.equal(G(repo, 'branch', '--list', rec.branch), '', 'a branch integrada foi apagada');
});

test('terminal sem trabalho nenhum: a limpeza remove o worktree e a branch; encerrar o terminal não apaga nada sozinho', async () => {
  const a = (await mgr.create({ isolate: true })).session, rec = wtm.get(a.worktreeId); const head0 = mainHead();
  const closed = mgr.close(a.id); assert.equal(closed.worktreeId, rec.id); assert.ok(fs.existsSync(rec.path), 'encerrar mantém o worktree'); assert.equal(wtm.get(rec.id).state, 'finished');
  const r = await wtm.cleanup(rec.id); assert.equal(r.ok, true, r.error); assert.ok(!fs.existsSync(rec.path)); assert.equal(mainHead(), head0); assert.equal(mainStatus(), '');
});
