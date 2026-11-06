// Persistência e retomada de sessões do Claude Code (terminals.js): PTY SIMULADO, MCP simulado, banco em memória e ORCH_DATA_DIR temporário.
// Nenhum Claude Code real é iniciado. Os argumentos esperados vêm do que foi validado com o CLI 2.1.318 (PTY real): --resume restaura histórico, prompt, nome e
// permission mode; o MCP NÃO é restaurado (credencial nova + --mcp-config + --allowedTools); --session-id com --resume exige --fork-session.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-resume-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const T = await import('../terminals.js');
const { inspectProjectConfig } = await import('../project-config.js');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const wsDir = path.join(tmp, 'ws'), wtDir = path.join(tmp, 'wt'); fs.mkdirSync(wsDir); fs.mkdirSync(wtDir);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flush = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return fn(); };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd, stdio: 'pipe' });
let repoN = 0;
/** Repositório Git REAL e temporário com um commit (a inspeção de configuração compara com o HEAD de verdade). */
function mkRepo() { const d = path.join(tmp, `repo${++repoN}`); fs.mkdirSync(d); git(d, 'init', '-q', '.'); fs.writeFileSync(path.join(d, 'a.txt'), 'x'); git(d, 'add', 'a.txt'); git(d, 'commit', '-q', '-m', 'base'); return d; }
const HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } }), MCPJSON = JSON.stringify({ mcpServers: { x: { command: 'node' } } });
const put = (d, rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
const rm = (d, rel) => fs.rmSync(path.join(d, rel), { force: true });

function fakePty({ failSpawn = false } = {}) {
  const spawned = []; let pid = 1_800_000_000;
  const lib = { spawn(file, args, opts) {
    if (failSpawn) throw new Error('spawn falhou');
    const p = { pid: ++pid, file, args, opts, written: [], dataCb: null, exitCb: null, onData(cb) { p.dataCb = cb; }, onExit(cb) { p.exitCb = cb; }, write(d) { p.written.push(d); }, resize() {}, emit(d) { p.dataCb(d); }, exit(code = 0) { p.exitCb({ exitCode: code }); } };
    spawned.push(p); return p;
  } };
  return { lib, spawned };
}

/** Mundo de teste: persistência, MCP e leitor de transcrição simulados e observáveis. */
function world(over = {}) {
  const f = over.pty ?? fakePty(), killed = [], issued = [], revoked = [], persisted = { n: 0, fail: false };
  const db = over.db ?? { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }], worktrees: [] };
  const transcripts = new Set(); let n = 0, tracked = 0;
  const mcp = over.noMcp ? null : { serverName: 'orch_x', issue: ({ terminalId }) => { issued.push(terminalId); return { configPath: path.join(tmp, `${terminalId}.json`) }; }, revoke: (id) => revoked.push(id) };
  const markInUse = [], released = []; const worktrees = { create: async () => ({ ok: true, record: { id: 'wt1', path: wtDir } }), markInUse: (id, x) => markInUse.push([id, x]), release: (id, why) => released.push([id, why]) };
  const mgr = T.createTerminalManager({
    db, ptyLib: f.lib, resolveCommand: () => ({ file: 'C:/fake/claude.exe', args: [], viaShell: false }), killTree: over.killTree ?? ((pid) => killed.push(pid)), waitFor: over.waitFor ?? (() => true), pidIsAlive: over.pidIsAlive,
    newSessionId: () => uuid(++n), mcp, worktrees, track: () => { if (over.trackFail) throw Object.assign(new Error('registro'), { code: 'EIO' }); tracked++; return { release() { tracked--; } }; }, inspectConfig: over.inspectConfig ?? (async () => { await flush(); return []; }), sweepMs: over.sweepMs ?? 0, setTimer: over.setTimer, clearTimer: over.clearTimer,
    usage: { read: () => null, has: (id) => transcripts.has(id), forget() {} }, isChildAlive: over.isChildAlive ?? null, maxRecords: over.maxRecords,
    persist: () => { persisted.n++; if (persisted.fail) throw Object.assign(new Error('disco cheio'), { code: 'ENOSPC' }); },
  });
  return { f, killed, issued, revoked, persisted, db, transcripts, mgr, markInUse, released, tracked: () => tracked };
}
/** Cria um terminal, deixa o transcript "existir" e encerra o processo: o registro fica `exited`. */
async function exited(w, opts = {}) {
  const r = await w.mgr.create({ role: 'builder', ...opts }); assert.equal(r.ok, true, r.error);
  const p = w.f.spawned.at(-1); w.transcripts.add(w.db.terminalSessions.at(-1).claudeSessionId); p.exit(0);
  return { session: r.session, rec: w.db.terminalSessions.at(-1), p };
}

test('persistência: registro criado com os metadados, sem credenciais, e atualizado quando o processo termina', async () => {
  const w = world(); const r = await w.mgr.create({ role: 'reviewer', title: 'Rev A' });
  const rec = w.db.terminalSessions[0];
  assert.match(rec.id, /^ses_[0-9a-f]{8}$/); assert.equal(r.session.recordId, rec.id);
  assert.deepEqual([rec.terminalId, rec.claudeSessionId, rec.role, rec.title, rec.workspaceId, rec.cwd, rec.worktreeId, rec.state, rec.usesMcp, rec.endedAt, rec.exitCode], [r.session.id, uuid(1), 'reviewer', 'Rev A', 'ws', wsDir, null, 'running', true, null, null]);
  assert.ok(rec.startedAt); assert.ok(w.persisted.n >= 1, 'gravou ao criar');
  const text = JSON.stringify(w.db.terminalSessions); assert.ok(!/configPath|Bearer|token|\.json"/i.test(text), 'nenhuma credencial nem caminho de credencial MCP no histórico');
  const before = w.persisted.n; w.f.spawned[0].exit(3);
  assert.deepEqual([rec.state, rec.exitCode], ['exited', 3]); assert.ok(rec.endedAt); assert.ok(w.persisted.n > before, 'gravou ao terminar');
});

test('boot: registros que ficaram "running" viram "interrupted"; dados antigos sem a lista continuam funcionando', () => {
  const db = { settings: {}, workspaces: [], terminalSessions: [{ id: 'ses_aaaaaaaa', state: 'running', claudeSessionId: uuid(9) }, { id: 'ses_bbbbbbbb', state: 'exited' }] };
  const w = world({ db });
  assert.deepEqual(db.terminalSessions.map((r) => r.state), ['interrupted', 'exited']); assert.ok(db.terminalSessions[0].interruptedAt); assert.ok(w.persisted.n >= 1, 'gravou a reclassificação');
  const old = { settings: {}, workspaces: [] }; const w2 = world({ db: old });
  assert.equal(old.terminalSessions, undefined, 'banco antigo: nada é criado sem necessidade'); assert.deepEqual(w2.mgr.history(), []);
});

test('retomada normal: --resume com o cwd original, MCP com credencial NOVA e sem repassar session-id, prompt, nome nem permission mode', async () => {
  const w = world(); const { rec, session: old } = await exited(w);
  const r = await w.mgr.resume({ recordId: rec.id }); assert.equal(r.ok, true, r.error); assert.equal(r.status, 201);
  const p = w.f.spawned.at(-1), cfg = path.join(tmp, `${r.session.id}.json`);
  assert.deepEqual(p.args, ['--resume', uuid(1), '--mcp-config', cfg, '--allowedTools', 'mcp__orch_x']);
  for (const a of ['--session-id', '--append-system-prompt', '--name', '--permission-mode', '--fork-session']) assert.ok(!p.args.includes(a), `sem ${a}`);
  assert.equal(p.opts.cwd, wsDir);
  assert.notEqual(r.session.id, old.id); assert.equal(w.issued.at(-1), r.session.id, 'credencial emitida para o terminal NOVO'); assert.ok(!w.revoked.includes(r.session.id));
  assert.equal(w.db.terminalSessions.length, 1, 'é a mesma sessão do Claude Code: o registro é reaproveitado');
  assert.deepEqual([rec.state, rec.terminalId, rec.resumes, rec.claudeSessionId, rec.endedAt, rec.exitCode], ['running', r.session.id, 1, uuid(1), null, null]);
  assert.equal(r.session.title, old.title); assert.equal(r.session.role, 'builder');
  w.f.spawned.at(-1).exit(0); assert.equal(rec.state, 'exited', 'terminar de novo atualiza o mesmo registro');
});

test('retomada sem MCP: sessão que não dependia dele não recebe argumentos de MCP nem credencial', async () => {
  const w = world({ noMcp: true }); const { rec } = await exited(w);
  assert.equal(rec.usesMcp, false); const r = await w.mgr.resume({ recordId: rec.id }); assert.equal(r.ok, true, r.error);
  assert.deepEqual(w.f.spawned.at(-1).args, ['--resume', uuid(1)]); assert.equal(w.issued.length, 0);
});

test('ambiente do filho: só CLAUDE_CODE_CHILD_SESSION é removida (na criação e na retomada); as demais CLAUDE_CODE_* ficam', async () => {
  const keep = { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'x', ELECTRON_RUN_AS_NODE: '1' };
  const old = Object.fromEntries(Object.keys(keep).map((k) => [k, process.env[k]])); Object.assign(process.env, keep);
  try {
    const w = world(); const { rec } = await exited(w); const r = await w.mgr.resume({ recordId: rec.id }); assert.equal(r.ok, true, r.error);
    for (const p of [w.f.spawned[0], w.f.spawned[1]]) {
      assert.equal(p.opts.env.CLAUDE_CODE_CHILD_SESSION, undefined, 'removida'); assert.equal(p.opts.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(p.opts.env.CLAUDE_CODE_GIT_BASH_PATH, 'C:/git/bash.exe'); assert.equal(p.opts.env.CLAUDE_CODE_ENTRYPOINT, 'cli'); assert.equal(p.opts.env.CLAUDE_CODE_SESSION_ID, 'x');
    }
  } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('recusa sessão já ativa: terminal rodando, registro "running" ou processo ainda vivo no registro de filhos (nunca dois processos no mesmo id)', async () => {
  const w = world(); const c = await w.mgr.create({ role: 'builder' }); w.transcripts.add(uuid(1)); const rec = w.db.terminalSessions[0];
  let r = await w.mgr.resume({ recordId: rec.id }); assert.deepEqual([r.ok, r.status, r.code], [false, 409, 'session_active']); assert.equal(w.f.spawned.length, 1);
  w.f.spawned[0].exit(0); // terminou: agora pode
  const w2 = world({ isChildAlive: () => true }); const e = await exited(w2); r = await w2.mgr.resume({ recordId: e.rec.id }); assert.deepEqual([r.ok, r.status, r.code], [false, 409, 'session_active']);
  assert.equal(w2.f.spawned.length, 1, 'nenhum processo novo');
  const e2 = await exited(world()); assert.equal(e2.rec.state, 'exited'); void c;
});

test('recusas de validação: id inválido ou de outro formato, registro inexistente, workspace, cwd, worktree e transcrição ausentes', async () => {
  const w = world(); const { rec } = await exited(w);
  assert.equal((await w.mgr.resume({ recordId: uuid(1) })).status, 400, 'um UUID de sessão enviado pelo cliente não é aceito');
  assert.equal((await w.mgr.resume({ recordId: 'ses_zzzzzzzz' })).status, 400); assert.equal((await w.mgr.resume({ recordId: 'ses_00000000' })).status, 404);
  assert.equal((await w.mgr.resume({})).status, 400);
  w.transcripts.clear(); let r = await w.mgr.resume({ recordId: rec.id }); assert.deepEqual([r.status, r.code], [409, 'transcript_missing']); w.transcripts.add(uuid(1));
  rec.cwd = path.join(tmp, 'outro'); r = await w.mgr.resume({ recordId: rec.id }); assert.equal(r.status, 409); assert.match(r.error, /difere do espaço de trabalho/); rec.cwd = wsDir;
  rec.workspaceId = 'sumiu'; r = await w.mgr.resume({ recordId: rec.id }); assert.equal(r.status, 409); assert.match(r.error, /espaço de trabalho desta sessão não existe/); rec.workspaceId = 'ws';
  rec.claudeSessionId = 'não-é-uuid'; r = await w.mgr.resume({ recordId: rec.id }); assert.equal(r.status, 409); rec.claudeSessionId = uuid(1);
  rec.role = 'hacker'; assert.equal((await w.mgr.resume({ recordId: rec.id })).status, 409); rec.role = 'builder';
  assert.equal(w.f.spawned.length, 1, 'nenhuma recusa abriu processo'); assert.equal(rec.state, 'exited', 'o registro não foi tocado');
  // worktree válido continua retomando (mesma regra do ciclo: workspace, estado utilizável, sem operação, pasta existente, caminho original)
  const wt = world({ db: { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }], worktrees: [{ id: 'wt1', workspaceId: 'ws', state: 'ready', path: wtDir }] } });
  const x = await exited(wt); x.rec.worktreeId = 'wt1'; x.rec.cwd = wtDir;
  r = await wt.mgr.resume({ recordId: x.rec.id }); assert.equal(r.ok, true, r.error); assert.equal(wt.f.spawned.at(-1).opts.cwd, wtDir, 'usa o caminho original do worktree'); assert.deepEqual(wt.markInUse.at(-1)[0], 'wt1'); wt.f.spawned.at(-1).exit(0);
  wt.db.worktrees = []; r = await wt.mgr.resume({ recordId: x.rec.id }); assert.equal(r.status, 409); assert.match(r.error, /worktree desta sessão não existe/);
  wt.db.worktrees = [{ id: 'wt1', workspaceId: 'ws', state: 'ready', path: path.join(tmp, 'wt-outro') }]; r = await wt.mgr.resume({ recordId: x.rec.id }); assert.equal(r.status, 409);
  wt.db.worktrees = [{ id: 'wt1', workspaceId: 'ws', state: 'ready', path: wtDir }]; x.rec.cwd = path.join(tmp, 'wt-diferente'); r = await wt.mgr.resume({ recordId: x.rec.id }); assert.equal(r.status, 409); assert.match(r.error, /caminho original/);
});

test('isolamento de worktree: de outro workspace, em estado não utilizável, com operação em andamento ou sem a pasta NÃO retomam; o válido retoma', async () => {
  const wsB = { id: 'ws2', name: 'ws2', path: wtDir };
  const w = world({ db: { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }, wsB], worktrees: [] } });
  const x = await exited(w); x.rec.worktreeId = 'wt1'; x.rec.cwd = wtDir;
  const set = (over) => { w.db.worktrees = [{ id: 'wt1', workspaceId: 'ws', state: 'ready', path: wtDir, ...over }]; };
  const tryResume = async () => { const n = w.f.spawned.length; const r = await w.mgr.resume({ recordId: x.rec.id }); return { r, spawned: w.f.spawned.length - n }; };
  set({ workspaceId: 'ws2' }); let t = await tryResume(); assert.deepEqual([t.r.status, t.r.code, t.spawned], [409, 'worktree_invalid', 0]); assert.match(t.r.error, /outro espaço de trabalho/);
  for (const state of ['removed', 'integrated', 'cleaning', 'failed', undefined]) { set({ state }); t = await tryResume(); assert.deepEqual([t.r.status, t.r.code, t.spawned], [409, 'worktree_invalid', 0], `estado ${state}`); assert.match(t.r.error, /estado utilizável/); }
  set({ op: { kind: 'snapshot' } }); t = await tryResume(); assert.deepEqual([t.r.status, t.r.code, t.spawned], [409, 'worktree_invalid', 0]); assert.match(t.r.error, /operação em andamento/);
  set({ path: path.join(tmp, 'nao-existe') }); t = await tryResume(); assert.deepEqual([t.r.status, t.spawned], [409, 0]);
  for (const state of ['ready', 'in_use', 'finished']) { set({ state }); t = await tryResume(); assert.equal(t.r.ok, true, `${state}: ${t.r.error}`); assert.equal(w.f.spawned.at(-1).opts.cwd, wtDir); w.f.spawned.at(-1).exit(0); }
  const g = await import('../worktrees.js'); assert.equal(g.worktreeProblem({ id: 'a', workspaceId: 'ws', state: 'ready', path: wtDir }, 'ws'), null); assert.equal(g.usableWorktree({ id: 'a', workspaceId: 'x', state: 'ready', path: wtDir }, 'ws'), false, 'a regra única é a mesma que o ciclo usa');
});

test('fork: UUID novo persistido como a nova sessão; registro e transcrição originais ficam intactos; MCP renovado', async () => {
  const w = world(); const { rec, session: old } = await exited(w); const snapshot = JSON.parse(JSON.stringify(rec));
  const r = await w.mgr.resume({ recordId: rec.id, fork: true }); assert.equal(r.ok, true, r.error);
  const cfg = path.join(tmp, `${r.session.id}.json`), p = w.f.spawned.at(-1);
  assert.deepEqual(p.args, ['--resume', uuid(1), '--fork-session', '--session-id', uuid(2), '--mcp-config', cfg, '--allowedTools', 'mcp__orch_x']);
  assert.deepEqual(rec, snapshot, 'o registro original não muda'); assert.equal(w.db.terminalSessions.length, 2);
  const f = w.db.terminalSessions[1]; assert.deepEqual([f.claudeSessionId, f.forkedFrom, f.state, f.terminalId, f.role, f.title, f.cwd], [uuid(2), rec.id, 'running', r.session.id, 'builder', old.title, wsDir]); assert.notEqual(f.id, rec.id);
  assert.ok(!p.args.includes('--append-system-prompt'));
  const again = await w.mgr.resume({ recordId: rec.id, fork: true }); assert.equal(again.ok, true, 'o original pode gerar outro fork'); assert.equal(w.db.terminalSessions.length, 3);
  assert.equal(w.f.spawned.at(-1).args[4], uuid(3));
});

test('rollback: falha ao gravar o histórico na retomada, no fork e na criação desfaz processo, credencial e registro; spawn que falha não altera nada', async () => {
  const w = world(); const { rec } = await exited(w); const snapshot = JSON.parse(JSON.stringify(rec)); const n0 = w.f.spawned.length;
  w.persisted.fail = true;
  let r = await w.mgr.resume({ recordId: rec.id }); assert.deepEqual([r.ok, r.status], [false, 503]); assert.match(r.error, /histórico/);
  assert.deepEqual(rec, snapshot, 'registro restaurado (inclusive campos novos removidos)'); assert.equal(w.killed.at(-1), w.f.spawned.at(-1).pid, 'processo encerrado'); assert.equal(w.revoked.at(-1), w.issued.at(-1), 'só a credencial deste terminal foi revogada');
  assert.equal(w.mgr.count(), 0); assert.equal(w.tracked(), 0, 'registro de filho liberado');
  r = await w.mgr.resume({ recordId: rec.id, fork: true }); assert.equal(r.status, 503); assert.equal(w.db.terminalSessions.length, 1, 'fork não deixou registro'); assert.deepEqual(rec, snapshot);
  r = await w.mgr.create({ role: 'scout' }); assert.equal(r.status, 503); assert.equal(w.db.terminalSessions.length, 1, 'criação não deixou registro'); assert.equal(w.f.spawned.length, n0 + 3);
  w.persisted.fail = false; r = await w.mgr.resume({ recordId: rec.id }); assert.equal(r.ok, true, 'depois da falha a retomada funciona');
  const bad = world({ pty: fakePty({ failSpawn: true }) }); bad.db.terminalSessions = [{ id: 'ses_cccccccc', terminalId: 'term_cccccccc', claudeSessionId: uuid(7), role: 'builder', title: 'x', workspaceId: 'ws', cwd: wsDir, state: 'exited', usesMcp: true }]; bad.transcripts.add(uuid(7));
  const before = JSON.stringify(bad.db.terminalSessions); r = await bad.mgr.resume({ recordId: 'ses_cccccccc' }); assert.equal(r.status, 500); assert.equal(JSON.stringify(bad.db.terminalSessions), before); assert.equal(bad.revoked.length, 1);
});

test('duas solicitações simultâneas de retomada do mesmo registro: só uma abre processo', async () => {
  const w = world(); const { rec } = await exited(w); const n0 = w.f.spawned.length;
  const [a, b] = await Promise.all([w.mgr.resume({ recordId: rec.id }), w.mgr.resume({ recordId: rec.id })]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]); const lose = a.ok ? b : a; assert.equal(lose.status, 409); assert.match(lose.error, /já está sendo retomada|já está ativa/);
  assert.equal(w.f.spawned.length, n0 + 1, 'um único processo'); assert.equal(rec.resumes, 1);
  const f = await Promise.all([w.mgr.resume({ recordId: rec.id, fork: true }), w.mgr.resume({ recordId: rec.id, fork: true })]); assert.ok(f.filter((x) => x.ok).length <= 1, 'no mesmo registro também não há dois forks simultâneos');
});

test('entrada só depois da primeira saída do terminal retomado; terminal novo não tem essa trava', async () => {
  const w = world(); const { rec } = await exited(w); const r = await w.mgr.resume({ recordId: rec.id }); const p = w.f.spawned.at(-1);
  let x = w.mgr.write(r.session.id, 'oi'); assert.deepEqual([x.ok, x.status], [false, 409]); assert.equal(p.written.length, 0);
  p.emit('Claude Code'); x = w.mgr.write(r.session.id, 'oi'); assert.equal(x.ok, true); assert.deepEqual(p.written, ['oi']);
  const n = await w.mgr.create({ role: 'builder' }); assert.equal(w.mgr.write(n.session.id, 'x').ok, true, 'criação nova: sem trava');
});

test('histórico: limite que nunca remove sessões em execução nem a origem de um fork; history() não expõe o UUID do Claude Code', async () => {
  const w = world({ maxRecords: 3 }); const a = await exited(w); await exited(w); await exited(w);
  assert.ok(w.db.terminalSessions.length <= 3); const running = await w.mgr.create({ role: 'builder' }); void running;
  assert.ok(w.db.terminalSessions.some((r) => r.state === 'running'), 'a em execução ficou'); assert.ok(w.db.terminalSessions.length <= 3);
  const h = w.mgr.history(); assert.ok(h.length >= 1); assert.ok(h.every((r) => r.claudeSessionId === undefined && /^ses_/.test(r.id)));
  const w2 = world({ maxRecords: 2 }); const o = await exited(w2); await exited(w2);
  const f = await w2.mgr.resume({ recordId: o.rec.id, fork: true }); assert.equal(f.ok, true, f.error); assert.ok(w2.db.terminalSessions.includes(o.rec), 'a origem do fork não foi removida pelo limite');
  void a;
});

test('rotas: POST /api/terminals/resume só aceita o id do registro (UUID do cliente é ignorado) e GET /api/terminals/history lista sem o UUID', async () => {
  const { default: express } = await import('express');
  const w = world(); const { rec } = await exited(w);
  const app = express(); app.use(express.json()); T.setupTerminals(app, { manager: w.mgr });
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); }), base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const post = (b) => fetch(`${base}/api/terminals/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    let r = await post({ recordId: uuid(1) }); assert.equal(r.status, 400);
    r = await post({ claudeSessionId: uuid(1), recordId: 'ses_00000000' }); assert.equal(r.status, 404);
    r = await post({ recordId: rec.id, fork: 'sim' }); assert.equal(r.status, 201, 'fork só com true: "sim" é retomada normal');
    assert.ok(!w.f.spawned.at(-1).args.includes('--fork-session'));
    const j = await (await post({ recordId: rec.id })).json(); assert.equal(j.code, 'session_active');
    const h = await (await fetch(`${base}/api/terminals/history`)).json(); assert.equal(h.sessions.length, 1); assert.equal(JSON.stringify(h).includes(uuid(1)), false);
  } finally { srv.close(); srv.closeAllConnections?.(); }
});

test('encerramento: a liberação do registro e do worktree só ocorre com a morte CONFIRMADA (taskkill que falha ou PID vivo mantêm a sessão como ativa)', async () => {
  const st = { alive: false, throwKill: false, gone: true };
  const mk = () => world({ killTree: (pid) => { if (st.throwKill) throw new Error('taskkill falhou'); }, waitFor: () => st.gone, pidIsAlive: () => st.alive });
  // A) morte confirmada: libera tudo e a sessão pode ser retomada
  let w = mk(); let c = await w.mgr.create({ role: 'builder', isolate: true }); const recA = w.db.terminalSessions[0]; w.transcripts.add(recA.claudeSessionId);
  assert.equal(w.tracked(), 1); let r = w.mgr.close(c.session.id); assert.deepEqual([r.ok, r.stillAlive], [true, false]); assert.equal(w.tracked(), 0, 'registro de filho liberado'); assert.deepEqual(w.released, [['wt1', 'terminal_ended']]);
  w.db.worktrees = [{ id: 'wt1', workspaceId: 'ws', state: 'ready', path: wtDir }]; recA.worktreeId = 'wt1'; recA.cwd = wtDir;
  let q = await w.mgr.resume({ recordId: recA.id }); assert.equal(q.ok, true, q.error); w.f.spawned.at(-1).exit(0);
  // B) taskkill falha e o processo continua vivo: nada é liberado, a retomada é recusada e o histórico diz por quê
  st.throwKill = true; st.gone = false; st.alive = true; w = mk(); c = await w.mgr.create({ role: 'builder', isolate: true }); const rec = w.db.terminalSessions[0]; w.transcripts.add(rec.claudeSessionId);
  w.db.worktrees = [{ id: 'wt1', workspaceId: 'ws', state: 'ready', path: wtDir }];
  r = w.mgr.close(c.session.id); assert.deepEqual([r.ok, r.stillAlive], [true, true]); assert.equal(w.tracked(), 1, 'registro de filho RETIDO (o próximo boot ainda reclama o processo)'); assert.deepEqual(w.released, [], 'worktree continua em uso');
  assert.equal(rec.state, 'exited'); assert.equal(rec.unconfirmedExit, true);
  q = await w.mgr.resume({ recordId: rec.id }); assert.deepEqual([q.ok, q.status, q.code], [false, 409, 'session_active']); assert.match(q.error, /não confirmou o encerramento/); assert.equal(w.f.spawned.length, 1, 'nenhum segundo processo');
  q = await w.mgr.resume({ recordId: rec.id, fork: true }); assert.equal(q.status, 409, 'o fork também espera: o original ainda pode estar escrevendo');
  let h = w.mgr.history()[0]; assert.deepEqual([h.resumable, h.blockedReason], [false, 'session_active']);
  // C) a morte é confirmada depois (pidAlive): libera e a sessão volta a ser retomável
  st.alive = false; h = w.mgr.history()[0]; assert.equal(h.resumable, true); assert.equal(w.tracked(), 0, 'liberado depois da confirmação'); assert.deepEqual(w.released, [['wt1', 'terminal_ended']]);
  q = await w.mgr.resume({ recordId: rec.id }); assert.equal(q.ok, true, q.error);
  assert.equal(rec.unconfirmedExit, undefined, 'a nova execução limpa a marca'); w.f.spawned.at(-1).exit(0);
  // D) o onExit tardio do processo que sobreviveu também libera
  st.alive = true; w = mk(); c = await w.mgr.create({ role: 'builder' }); w.mgr.close(c.session.id); assert.equal(w.tracked(), 1); st.alive = false; w.f.spawned[0].exit(0); assert.equal(w.tracked(), 0);
  // E) waitFor que lança também conta como não confirmado
  st.throwKill = false; st.alive = true; w = world({ waitFor: () => { throw new Error('timeout'); }, pidIsAlive: () => st.alive }); c = await w.mgr.create({ role: 'builder' }); assert.equal(w.mgr.close(c.session.id).stillAlive, true); assert.equal(w.tracked(), 1);
});

test('histórico: resumable/blockedReason por estado (ativa, interrompida, transcrição ausente, workspace removido, worktree inválido) sem UUID, caminhos nem terminalId', async () => {
  const db = { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }], worktrees: [{ id: 'wt1', workspaceId: 'outro', state: 'ready', path: wtDir }],
    terminalSessions: [{ id: 'ses_aaaaaaaa', terminalId: 'term_aaaaaaaa', claudeSessionId: uuid(41), role: 'builder', title: 'interrompida', workspaceId: 'ws', cwd: wsDir, state: 'running', usesMcp: true }] };
  const w = world({ db }); w.transcripts.add(uuid(41));
  const add = (id, over) => db.terminalSessions.push({ id, terminalId: 'term_bbbbbbbb', claudeSessionId: uuid(50 + db.terminalSessions.length), role: 'builder', title: id, workspaceId: 'ws', cwd: wsDir, state: 'exited', ...over });
  add('ses_00000001', {}); add('ses_00000002', {}); add('ses_00000003', { workspaceId: 'sumiu' }); add('ses_00000004', { worktreeId: 'wt1', cwd: wtDir });
  for (const r of db.terminalSessions.slice(1, 4)) if (r.id !== 'ses_00000002') w.transcripts.add(r.claudeSessionId); // o 2 fica SEM transcrição
  w.transcripts.add(db.terminalSessions[4].claudeSessionId);
  const live = await w.mgr.create({ role: 'builder' }); void live;
  const by = Object.fromEntries(w.mgr.history().map((h) => [h.id, h]));
  assert.deepEqual([by.ses_aaaaaaaa.state, by.ses_aaaaaaaa.resumable, by.ses_aaaaaaaa.blockedReason], ['interrupted', true, null], 'interrompida é retomável');
  assert.deepEqual([by.ses_00000001.resumable, by.ses_00000001.blockedReason], [true, null]);
  assert.deepEqual([by.ses_00000002.resumable, by.ses_00000002.blockedReason], [false, 'transcript_missing']);
  assert.deepEqual([by.ses_00000003.resumable, by.ses_00000003.blockedReason], [false, 'workspace_missing']);
  assert.deepEqual([by.ses_00000004.resumable, by.ses_00000004.blockedReason], [false, 'worktree_invalid']);
  const ativo = w.mgr.history().find((h) => h.active); assert.deepEqual([ativo.resumable, ativo.blockedReason], [false, 'session_active']);
  assert.ok(by.ses_00000002.blockedMessage.length > 10);
  const text = JSON.stringify(w.mgr.history()); assert.ok(!text.includes('claudeSessionId') && !text.includes(uuid(41)) && !text.includes(wsDir) && !text.includes('terminalId') && !text.includes('"cwd"'), 'nem UUID, nem caminho, nem id de processo');
  // o informativo não substitui a validação: a retomada de um bloqueado continua recusada pelo endpoint
  assert.equal((await w.mgr.resume({ recordId: 'ses_00000002' })).code, 'transcript_missing');
});

test('forkedFrom: várias gerações de fork e podas sucessivas nunca deixam vínculo para registro inexistente; o histórico segue limitado', async () => {
  const w = world({ maxRecords: 3 }); const root = (await exited(w)).rec;
  const ok = () => { const ids = new Set(w.db.terminalSessions.map((r) => r.id)); for (const r of w.db.terminalSessions) assert.ok(r.forkedFrom == null || (ids.has(r.forkedFrom) && r.forkedFrom !== r.id), `vínculo órfão: ${r.id} -> ${r.forkedFrom}`); };
  let last = root;
  for (let i = 0; i < 8; i++) {
    const r = await w.mgr.resume({ recordId: last.id, fork: true }); assert.equal(r.ok, true, r.error);
    last = w.db.terminalSessions.at(-1); assert.equal(last.forkedFrom == null, false, 'o fork recém-criado aponta para a origem (que a poda protege)'); w.transcripts.add(last.claudeSessionId); w.f.spawned.at(-1).exit(0); ok();
    assert.ok(w.db.terminalSessions.length <= 3, 'histórico limitado');
  }
  assert.ok(!w.db.terminalSessions.includes(root), 'a raiz antiga saiu'); const oldest = w.db.terminalSessions[0]; assert.equal(oldest.forkedFrom, null, 'o mais antigo que sobrou foi re-parentado para null (o ancestral sumiu)');
  // fork de uma geração do meio (com filhos): ao podar o pai, o filho herda o avô que sobrou
  const w2 = world({ maxRecords: 4 }); const a = (await exited(w2)).rec;
  const mkFork = async (from) => { const r = await w2.mgr.resume({ recordId: from.id, fork: true }); assert.equal(r.ok, true, r.error); const n = w2.db.terminalSessions.at(-1); w2.transcripts.add(n.claudeSessionId); w2.f.spawned.at(-1).exit(0); return n; };
  const b = await mkFork(a), c = await mkFork(b), d = await mkFork(c); assert.deepEqual([b.forkedFrom, c.forkedFrom, d.forkedFrom], [a.id, b.id, c.id]);
  const e = await mkFork(d); assert.equal(w2.db.terminalSessions.includes(a), false, 'a (a mais antiga) foi podada'); assert.equal(b.forkedFrom, null); assert.equal(c.forkedFrom, b.id); assert.equal(e.forkedFrom, d.id);
  // falha de gravação no fork não deixa vínculo alterado pela poda
  const w3 = world({ maxRecords: 2 }); const o = (await exited(w3)).rec; const o2 = (await exited(w3)).rec; w3.persisted.fail = true;
  const snap = JSON.stringify(w3.db.terminalSessions); const f = await w3.mgr.resume({ recordId: o2.id, fork: true }); assert.equal(f.status, 503); assert.equal(JSON.stringify(w3.db.terminalSessions), snap, 'rollback restaura inclusive os vínculos'); void o;
});

test('MCP: o nome do servidor é estável entre reinicializações (gerado uma vez, guardado no banco, sem token) e a retomada usa o mesmo nome com credencial nova', async () => {
  const M = await import('../maestro.js');
  const db = {}; let saves = 0; const a = M.stableServerName(db, { save: () => { saves++; } });
  assert.match(a, /^forge_[0-9a-f]{6}$/); assert.equal(db.mcpServerName, a); assert.equal(saves, 1);
  assert.equal(M.stableServerName(db, { save: () => { saves++; } }), a, 'segundo boot: mesmo nome'); assert.equal(saves, 1, 'nada é gravado de novo');
  db.mcpServerName = 'orchestrator'; assert.notEqual(M.stableServerName(db), 'orchestrator', 'nome previsível ou inválido é substituído por um com sufixo aleatório'); db.mcpServerName = 'x'; const n2 = M.stableServerName(db, { gen: () => 'ZZ' }); assert.match(n2, /^forge_[0-9a-f]{6}$/, 'gerador inválido cai no aleatório');
  assert.match(M.stableServerName({}, { save: () => { throw new Error('disco'); } }), /^forge_[0-9a-f]{6}$/, 'sem gravar: vale nesta execução');
  assert.notEqual(M.stableServerName({}), M.stableServerName({}), 'instalações diferentes: nomes diferentes (imprevisível para um .mcp.json hostil)');
  assert.ok(!JSON.stringify({ name: a }).match(/token|Bearer/i));
  // dois "boots": mesmo nome, terminais e tokens diferentes
  const dir = path.join(tmp, 'mcp'); const boot = () => M.createMaestro({ getTerminals: () => null, mcpDir: dir, url: 'http://127.0.0.1:1/mcp', serverName: a, lockDir: () => {} });
  const m1 = boot(); const c1 = m1.issue({ terminalId: 'term_aaaaaaaa', role: 'builder' }); const k1 = JSON.parse(fs.readFileSync(c1.configPath, 'utf8')); const m2 = boot(); const c2 = m2.issue({ terminalId: 'term_bbbbbbbb', role: 'builder' }); const k2 = JSON.parse(fs.readFileSync(c2.configPath, 'utf8'));
  assert.deepEqual(Object.keys(k1.mcpServers), [a]); assert.deepEqual(Object.keys(k2.mcpServers), [a]); assert.notEqual(k1.mcpServers[a].headers.Authorization, k2.mcpServers[a].headers.Authorization, 'credencial nova por terminal'); assert.equal(m2.serverName, a);
  // retomada: --allowedTools com o MESMO nome do histórico e credencial emitida para o terminal novo
  const w = world(); w.mgr; const w2 = (() => { const f = fakePty(); const db2 = { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', path: wsDir }] }; const issued = []; const mgr = T.createTerminalManager({ db: db2, ptyLib: f.lib, resolveCommand: () => ({ file: 'C:/fake/claude.exe', args: [], viaShell: false }), newSessionId: (() => { let n = 100; return () => uuid(++n); })(), killTree() {}, waitFor: () => true, track: () => ({ release() {} }), inspectConfig: async () => [], mcp: { serverName: a, issue: ({ terminalId }) => { issued.push(terminalId); return { configPath: path.join(tmp, `${terminalId}.json`) }; }, revoke() {} }, usage: { has: () => true, read: () => null } }); return { f, db2, mgr, issued }; })();
  const created = await w2.mgr.create({ role: 'builder' }); w2.f.spawned[0].exit(0); const rr = await w2.mgr.resume({ recordId: w2.db2.terminalSessions[0].id }); assert.equal(rr.ok, true, rr.error);
  const args = w2.f.spawned.at(-1).args; assert.equal(args[args.indexOf('--allowedTools') + 1], `mcp__${a}`); assert.deepEqual(w2.issued, [created.session.id, rr.session.id]); void w;
});

test('entrada em terminal retomado: limitação documentada — qualquer byte inicial do ConPTY já libera (não há sinal estável de "interface pronta")', async () => {
  const w = world(); const { rec } = await exited(w); const r = await w.mgr.resume({ recordId: rec.id }); const p = w.f.spawned.at(-1);
  assert.equal(w.mgr.write(r.session.id, 'a').status, 409, 'antes de qualquer saída: recusa');
  p.emit('\x1b[?9001h'); assert.equal(w.mgr.write(r.session.id, 'a').ok, true, 'depois do primeiro byte (inclusive modos de terminal do ConPTY): aceita; teclas cedo demais ficam na fila do próprio terminal');
  const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'terminals.js'), 'utf8'); assert.match(src, /LIMITAÇÃO CONHECIDA/, 'a limitação está documentada no código');
});

// ================= A1: configuração executável inspecionada SEMPRE na retomada (worktree incluído) =================
test('A1: retomada em worktree recusa .claude/settings.json ou .mcp.json NÃO versionados sem confirmação; confirmação explícita libera; versionado e intacto retoma', async () => {
  const gwt = mkRepo(); const db = { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }], worktrees: [{ id: 'wt1', workspaceId: 'ws', state: 'ready', path: gwt }], mcpServerName: 'orchestrator_abc123' };
  const w = world({ db, inspectConfig: inspectProjectConfig }); const x = await exited(w); x.rec.worktreeId = 'wt1'; x.rec.cwd = gwt;
  const tryR = async (extra = {}) => { const n = w.f.spawned.length; const r = await w.mgr.resume({ recordId: x.rec.id, ...extra }); return { r, spawned: w.f.spawned.length - n }; };
  // 0) limpo: retoma
  let t = await tryR(); assert.equal(t.r.ok, true, t.r.error); w.f.spawned.at(-1).exit(0);
  // 1) settings.json com hooks, não versionado
  put(gwt, '.claude/settings.json', HOOKS); t = await tryR(); assert.deepEqual([t.r.ok, t.r.status, t.r.code, t.spawned], [false, 409, 'project_config_unreviewed', 0]); assert.deepEqual(t.r.files.map((f) => f.path), ['.claude/settings.json']);
  assert.equal(w.mgr.history()[0].resumable, true, 'o `resumable` é só informativo: NÃO substitui a inspeção feita pelo endpoint');
  // 2) .mcp.json não versionado (settings removido)
  rm(gwt, '.claude/settings.json'); put(gwt, '.mcp.json', MCPJSON); t = await tryR(); assert.deepEqual([t.r.status, t.r.code, t.spawned], [409, 'project_config_unreviewed', 0]); assert.deepEqual(t.r.files.map((f) => f.path), ['.mcp.json']);
  // 3) confirmação explícita libera (e só dela): o nome MCP continua o mesmo
  t = await tryR({ acknowledgeProjectConfig: true }); assert.equal(t.r.ok, true, t.r.error); const args = w.f.spawned.at(-1).args; assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__orch_x'); w.f.spawned.at(-1).exit(0);
  t = await tryR(); assert.equal(t.r.status, 409, 'a confirmação vale para UMA retomada, não é gravada');
  // 4) versionado e idêntico ao HEAD: retoma sem confirmação
  put(gwt, '.claude/settings.json', HOOKS); git(gwt, 'add', '-A'); git(gwt, 'commit', '-q', '-m', 'config revisada'); t = await tryR(); assert.equal(t.r.ok, true, t.r.error); w.f.spawned.at(-1).exit(0);
  // 5) versionado mas ALTERADO depois: volta a exigir confirmação
  put(gwt, '.claude/settings.json', HOOKS.replace('echo x', 'echo y')); t = await tryR(); assert.deepEqual([t.r.status, t.r.code], [409, 'project_config_unreviewed']);
  assert.equal(db.mcpServerName, 'orchestrator_abc123', 'o nome MCP estável não foi alterado'); assert.equal((await import('../maestro.js')).stableServerName(db), 'orchestrator_abc123');
});

test('A1: workspace sem worktree mantém o comportamento (inspeciona, recusa, confirma); a criação continua protegida e `isolate` na criação não inspeciona', async () => {
  const gws = mkRepo(); const db = { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: gws }], worktrees: [] };
  const w = world({ db, inspectConfig: inspectProjectConfig }); const x = await exited(w);
  put(gws, '.claude/settings.json', HOOKS);
  let r = await w.mgr.resume({ recordId: x.rec.id }); assert.deepEqual([r.status, r.code], [409, 'project_config_unreviewed']);
  r = await w.mgr.create({ role: 'builder' }); assert.deepEqual([r.status, r.code], [409, 'project_config_unreviewed'], 'criação continua protegida');
  r = await w.mgr.resume({ recordId: x.rec.id, acknowledgeProjectConfig: true }); assert.equal(r.ok, true, r.error); w.f.spawned.at(-1).exit(0);
  rm(gws, '.claude/settings.json'); r = await w.mgr.resume({ recordId: x.rec.id }); assert.equal(r.ok, true, r.error); w.f.spawned.at(-1).exit(0);
  // criação com isolate: o worktree nasce limpo, a inspeção não roda (continua como era)
  let calls = 0; const w2 = world({ inspectConfig: async () => { calls++; return [{ path: 'x', why: 'y' }]; } });
  const c = await w2.mgr.create({ role: 'builder', isolate: true }); assert.equal(c.ok, true, c.error); assert.equal(calls, 0);
});

test('A1: depois do await da inspeção as validações rodam de novo (worktree removido ou inutilizável no intervalo NÃO abre processo)', async () => {
  const mk = (mutate) => { const db = { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }], worktrees: [{ id: 'wt1', workspaceId: 'ws', state: 'ready', path: wtDir }] }; const w = world({ db, inspectConfig: async () => { await flush(); mutate(db); return []; } }); return w; };
  for (const [name, mutate, code] of [['removido', (db) => { db.worktrees = []; }, 'worktree_missing'], ['estado inválido', (db) => { db.worktrees[0].state = 'removed'; }, 'worktree_invalid'], ['operação em andamento', (db) => { db.worktrees[0].op = { kind: 'cleanup' }; }, 'worktree_invalid'], ['de outro workspace', (db) => { db.worktrees[0].workspaceId = 'x'; }, 'worktree_invalid']]) {
    const w = mk(mutate); const x = await exited(w); x.rec.worktreeId = 'wt1'; x.rec.cwd = wtDir; const n = w.f.spawned.length;
    const r = await w.mgr.resume({ recordId: x.rec.id }); assert.deepEqual([r.status, r.code, w.f.spawned.length - n], [409, code, 0], name);
  }
});

// ================= M2: rollback com processo possivelmente vivo =================
test('M2: falha de track() — encerramento confirmado libera tudo; processo ainda vivo fica retido (lingering), bloqueia a sessão e libera quando a morte for confirmada', async () => {
  // confirmado
  let w = world({ trackFail: true }); let r = await w.mgr.create({ role: 'builder' });
  assert.deepEqual([r.ok, r.status], [false, 503]); assert.match(r.error, /não pôde ser registrado.*foi encerrado/); assert.equal(w.killed.at(-1), w.f.spawned[0].pid); assert.equal(w.revoked.at(-1), w.issued.at(-1), 'credencial revogada');
  assert.deepEqual(w.db.terminalSessions ?? [], []); assert.equal(w.mgr.count(), 0);
  // vivo: killTree falha e o PID continua
  const st = { alive: true }; w = world({ trackFail: true, killTree: () => { throw new Error('taskkill falhou'); }, waitFor: () => false, pidIsAlive: () => st.alive, sweepMs: 15 });
  r = await w.mgr.create({ role: 'builder', isolate: true }); assert.deepEqual([r.ok, r.status, r.code], [false, 503, 'exit_unconfirmed']); assert.match(r.error, /NÃO foi confirmado/);
  assert.equal(w.revoked.at(-1), w.issued.at(-1), 'a credencial é revogada mesmo sem a morte confirmada');
  assert.deepEqual(w.markInUse.map((m) => m[0]), ['wt1'], 'worktree marcado em uso: ninguém o limpa debaixo do processo'); assert.deepEqual(w.released, [], 'e NÃO é liberado enquanto o PID viver');
  await sleep(80); assert.deepEqual(w.released, [], 'continua retido com o PID vivo');
  st.alive = false; assert.ok(await until(() => w.released.length === 1), 'liberado sozinho depois da confirmação'); assert.deepEqual(w.released, [['wt1', 'terminal_ended']]);
});

test('M2: falha de persistStrict() — confirmado restaura e encerra; killTree que lança deixa o processo retido, bloqueia retomada e fork (session_active) e libera depois', async () => {
  // a) confirmado
  let w = world(); let x = await exited(w); const snap = JSON.stringify(x.rec); w.persisted.fail = true;
  let r = await w.mgr.resume({ recordId: x.rec.id }); assert.deepEqual([r.ok, r.status], [false, 503]); assert.match(r.error, /foi encerrado/); assert.equal(JSON.stringify(x.rec), snap, 'registro idêntico'); assert.equal(w.tracked(), 0); assert.equal(w.revoked.at(-1), w.issued.at(-1));
  // b) killTree lança e o PID continua vivo
  const st = { alive: true }; w = world({ killTree: () => { throw new Error('taskkill falhou'); }, waitFor: () => false, pidIsAlive: () => st.alive }); x = await exited(w); const sid = x.rec.claudeSessionId; const base = JSON.parse(JSON.stringify(x.rec)); w.persisted.fail = true;
  r = await w.mgr.resume({ recordId: x.rec.id }); assert.deepEqual([r.ok, r.status, r.code], [false, 503, 'exit_unconfirmed']); assert.match(r.error, /NÃO foi confirmado/);
  assert.deepEqual({ ...x.rec, unconfirmedExit: undefined }, { ...base, unconfirmedExit: undefined }, 'registro restaurado (só ganha a marca de saída não confirmada)'); assert.equal(x.rec.unconfirmedExit, true);
  assert.equal(w.tracked(), 1, 'registro de filho RETIDO: o próximo boot ainda reclama o processo'); assert.equal(w.revoked.at(-1), w.issued.at(-1), 'credencial revogada');
  assert.equal(w.mgr.count(), 0, 'o terminal nunca foi anunciado');
  w.persisted.fail = false; const n = w.f.spawned.length;
  r = await w.mgr.resume({ recordId: x.rec.id }); assert.deepEqual([r.status, r.code], [409, 'session_active'], 'retomar a mesma transcrição enquanto o processo pode viver: recusado'); assert.match(r.error, /não confirmou o encerramento/);
  r = await w.mgr.resume({ recordId: x.rec.id, fork: true }); assert.deepEqual([r.status, r.code], [409, 'session_active']); assert.equal(w.f.spawned.length, n, 'nenhum processo novo');
  const h = w.mgr.history().find((y) => y.id === x.rec.id); assert.deepEqual([h.resumable, h.blockedReason], [false, 'session_active']);
  // c) a morte é confirmada depois: libera o registro de filho e a sessão volta a ser retomável
  st.alive = false; r = await w.mgr.resume({ recordId: x.rec.id }); assert.equal(r.ok, true, r.error); assert.equal(w.f.spawned.at(-1).args[1], sid); assert.equal(x.rec.unconfirmedExit, undefined);
});

// ================= M3: liberação automática (varredor central) =================
test('M3: processo retido é liberado AUTOMATICAMENTE depois da morte confirmada, sem consulta ao histórico; vivo ou inconclusivo continua retido', async () => {
  let alive = true; const w = world({ sweepMs: 15, killTree: () => { throw new Error('x'); }, waitFor: () => false, pidIsAlive: () => alive });
  const c = await w.mgr.create({ role: 'builder', isolate: true }); w.mgr.close(c.session.id); assert.equal(w.tracked(), 1);
  await sleep(100); assert.equal(w.tracked(), 1, 'PID vivo: continua retido'); assert.deepEqual(w.released, []);
  alive = false; assert.ok(await until(() => w.tracked() === 0), 'liberado sozinho (nenhuma chamada a history/resume/worktrees)'); assert.deepEqual(w.released, [['wt1', 'terminal_ended']]);
  // inconclusivo: undefined, null, texto, lançar — nada disso conta como morte
  for (const answer of [() => undefined, () => null, () => 'não sei', () => { throw new Error('EPERM?'); }]) {
    const w2 = world({ sweepMs: 10, killTree: () => {}, waitFor: () => false, pidIsAlive: answer }); const c2 = await w2.mgr.create({ role: 'builder' }); w2.mgr.close(c2.session.id);
    await sleep(80); assert.equal(w2.tracked(), 1, `inconclusivo (${answer}) não libera`);
  }
});

test('M3: um temporizador central (unref), criado só quando há retidos, único para vários e limpo quando o último é liberado', async () => {
  const made = [], cleared = []; let alive = true;
  const fake = { setTimer: (fn, ms) => { const h = { fn, ms, unref() { h.unrefd = true; return h; } }; made.push(h); return h; }, clearTimer: (h) => cleared.push(h) };
  const w = world({ ...fake, sweepMs: 777, killTree: () => {}, waitFor: () => false, pidIsAlive: () => alive });
  assert.equal(made.length, 0, 'sem retidos não há temporizador'); await w.mgr.create({ role: 'builder' }); assert.equal(made.length, 0, 'terminal normal não cria temporizador');
  const a = await w.mgr.create({ role: 'builder' }), b = await w.mgr.create({ role: 'builder' }); w.mgr.close(a.session.id); w.mgr.close(b.session.id);
  assert.equal(made.length, 1, 'UM temporizador para os dois retidos'); assert.deepEqual([made[0].unrefd, made[0].ms], [true, 777]); assert.equal(w.tracked(), 3);
  made[0].fn(); assert.equal(cleared.length, 0, 'vivos: segue ligado'); alive = false; made[0].fn(); assert.equal(w.tracked(), 1, 'os dois retidos liberados (o terceiro é o terminal normal)'); assert.deepEqual(cleared, [made[0]], 'limpo ao liberar o último');
  alive = true; const c = await w.mgr.create({ role: 'builder' }); w.mgr.close(c.session.id); assert.equal(made.length, 2, 'volta a existir só quando há retido de novo'); void fake;
});

test('M3: o temporizador não mantém o processo Node vivo (processo filho com retido e PID "vivo" termina sozinho)', () => {
  const url = new URL('../terminals.js', import.meta.url).href;
  const script = `const T = await import(${JSON.stringify(url)}); const db = { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', path: ${JSON.stringify(wsDir)} }] };
    const lib = { spawn: () => ({ pid: 2100000000, onData() {}, onExit() {}, write() {}, resize() {} }) };
    const m = T.createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'x', args: [], viaShell: false }), killTree() {}, waitFor: () => false, pidIsAlive: () => true, track: () => ({ release() {} }), inspectConfig: async () => [], sweepMs: 50 });
    const r = await m.create({ role: 'builder' }); m.close(r.session.id); console.log('retido=' + (m.get(r.session.id) === null));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ORCH_DATA_DIR: path.join(tmp, 'data-child') }, timeout: 15000, encoding: 'utf8' });
  assert.match(out, /retido=true/, 'terminou por conta própria (o execFileSync estouraria o timeout se o temporizador segurasse o processo)');
});
