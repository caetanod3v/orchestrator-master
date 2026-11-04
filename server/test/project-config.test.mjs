// M3: configuração executável do projeto (hooks, statusLine, MCP do projeto…) que um pane interativo executaria. Repositórios Git TEMPORÁRIOS; PTY simulado; nada real é executado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-projcfg-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const store = await import('../store.js');
const { inspectProjectConfig, activeKeys } = await import('../project-config.js');
const T = await import('../terminals.js');
store.load(); store.saveOrThrow();
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const git = (cwd, ...a) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'safe.directory=*', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'ignore' });
let n = 0;
function repo(files = {}, { commit = true } = {}) {
  const d = path.join(tmp, `r${++n}`); fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
  put('README.md', 'x'); for (const [rel, text] of Object.entries(files)) put(rel, text);
  if (commit) { git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init'); }
  return { d, put };
}
const HOOKS = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'calc.exe' }] }] } });

test('activeKeys: só chaves que executam algo; vazio/permissões não contam; JSON inválido => null', () => {
  assert.deepEqual(activeKeys(HOOKS), ['hooks']);
  assert.deepEqual(activeKeys(JSON.stringify({ permissions: { allow: ['Read'] }, model: 'x', hooks: {}, env: {}, mcpServers: {} })), []);
  assert.deepEqual(activeKeys(JSON.stringify({ statusLine: { type: 'command', command: 'x' }, env: { A: '1' }, apiKeyHelper: 'h' })), ['statusLine', 'apiKeyHelper', 'env']);
  assert.deepEqual(activeKeys(JSON.stringify({ enabledPlugins: { 'p@m': true }, extraKnownMarketplaces: { m: { source: 'x' } }, permissions: { defaultMode: 'bypassPermissions' } })), ['enabledPlugins', 'extraKnownMarketplaces', 'permissions.defaultMode']);
  for (const bad of ['', '{', '[]', 'null', '"x"']) assert.equal(activeKeys(bad), null, bad);
});

test('inspectProjectConfig: sem arquivos, ou só permissões, não pede confirmação', async () => {
  assert.deepEqual(await inspectProjectConfig(repo().d), []);
  assert.deepEqual(await inspectProjectConfig(repo({ '.claude/settings.local.json': JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }) }, { commit: false }).d), [], 'sem conteúdo executável, mesmo não versionado');
});

test('inspectProjectConfig: hooks VERSIONADOS e intactos são tratados como revisados; modificados, não versionados ou ignorados exigem confirmação', async () => {
  const ok = repo({ '.claude/settings.json': HOOKS, '.mcp.json': JSON.stringify({ mcpServers: { a: { command: 'x' } } }) });
  assert.deepEqual(await inspectProjectConfig(ok.d), [], 'versionados e intactos');
  ok.put('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'evil' }] }] } }));
  const mod = await inspectProjectConfig(ok.d); assert.deepEqual(mod.map((f) => f.path), ['.claude/settings.json']); assert.match(mod[0].why, /hooks.*difere do commit atual/);
  const fresh = repo({ 'src/a.js': '1' }); fresh.put('.claude/settings.json', HOOKS); fresh.put('.mcp.json', JSON.stringify({ mcpServers: { b: { command: 'y' } } }));
  const un = await inspectProjectConfig(fresh.d); assert.deepEqual(un.map((f) => f.path), ['.claude/settings.json', '.mcp.json']); assert.match(un[0].why, /não está versionado no commit atual/);
  const ign = repo({ '.gitignore': '.claude/settings.local.json\n' }); ign.put('.claude/settings.local.json', JSON.stringify({ env: { X: '1' } }));
  assert.deepEqual((await inspectProjectConfig(ign.d)).map((f) => f.path), ['.claude/settings.local.json'], 'arquivo ignorado pelo Git não conta como revisado');
});

test('inspectProjectConfig: JSON ilegível e pasta fora de repositório falham fechado', async () => {
  const bad = repo({}, { commit: false }); bad.put('.mcp.json', '{ não é json');
  assert.match((await inspectProjectConfig(bad.d))[0].why, /não pôde ser interpretado/);
  const plain = path.join(tmp, 'sem-git'); fs.mkdirSync(path.join(plain, '.claude'), { recursive: true }); fs.writeFileSync(path.join(plain, '.claude', 'settings.json'), HOOKS);
  const r = await inspectProjectConfig(plain); assert.equal(r.length, 1); assert.match(r[0].why, /Git/);
});

test('terminais: pane sem isolamento é RECUSADO (409 project_config_unreviewed, nada iniciado) até a confirmação; com ela abre; isolate não exige', async () => {
  const x = repo({ 'src/a.js': '1' }); x.put('.claude/settings.json', HOOKS);
  const spawned = []; const lib = { spawn(f, a, o) { const p = { pid: 1_900_000_000 + spawned.length, onData() {}, onExit() {}, write() {}, resize() {} }; spawned.push(p); return p; } };
  const db = { settings: { activeWorkspaceId: 'w' }, workspaces: [{ id: 'w', name: 'w', path: x.d }] };
  const mgr = T.createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'C:/fake/claude.exe', args: [], viaShell: false }), killTree: () => {}, waitFor: () => true });
  const r1 = await mgr.create({ role: 'builder' });
  assert.deepEqual([r1.ok, r1.status, r1.code], [false, 409, 'project_config_unreviewed']); assert.equal(r1.files[0].path, '.claude/settings.json'); assert.match(r1.error, /settings\.json/); assert.equal(spawned.length, 0, 'nenhum processo foi iniciado');
  assert.equal((await mgr.create({ role: 'builder', acknowledgeProjectConfig: 'true' })).code, 'project_config_unreviewed', 'só o booleano true confirma');
  const r2 = await mgr.create({ role: 'builder', acknowledgeProjectConfig: true }); assert.equal(r2.ok, true); assert.equal(spawned.length, 1);
  mgr.killAllSync();
});

test('contornos: alteração já em STAGE, arquivo novo só no índice, assume-unchanged e skip-worktree NÃO contam como revisados (comparação é com o HEAD)', async () => {
  const bad = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'evil' }] }] } });
  const staged = repo({ '.claude/settings.json': HOOKS }); staged.put('.claude/settings.json', bad); git(staged.d, 'add', '.claude/settings.json');
  const s = await inspectProjectConfig(staged.d); assert.deepEqual(s.map((f) => f.path), ['.claude/settings.json']); assert.match(s[0].why, /difere do commit atual/, 'modificado e em stage');
  const added = repo({ 'src/a.js': '1' }); added.put('.mcp.json', JSON.stringify({ mcpServers: { x: { command: 'y' } } })); git(added.d, 'add', '.mcp.json');
  assert.match((await inspectProjectConfig(added.d))[0].why, /não está versionado no commit atual/, 'novo, só no índice');
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const h = repo({ '.claude/settings.json': HOOKS }); git(h.d, 'update-index', flag, '.claude/settings.json'); h.put('.claude/settings.json', bad);
    const r = await inspectProjectConfig(h.d); assert.equal(r.length, 1, flag); assert.match(r[0].why, /assume-unchanged|skip-worktree/, flag);
  }
  const nohead = repo({}, { commit: false }); nohead.put('.claude/settings.json', HOOKS); git(nohead.d, 'add', '-A');
  assert.equal((await inspectProjectConfig(nohead.d)).length, 1, 'repositório sem commit algum: nada é "revisado"');
});

test('.claude/agents e .claude/skills: versionados e intactos passam; não versionados, ignorados ou em stage pedem confirmação; pasta vazia não', async () => {
  const ok = repo({ '.claude/agents/a.md': '---\nname: a\n---\n', '.claude/skills/s/SKILL.md': 'x' }); assert.deepEqual(await inspectProjectConfig(ok.d), []);
  ok.put('.claude/agents/novo.md', '---\nname: novo\nhooks: {}\n---\n');
  assert.deepEqual((await inspectProjectConfig(ok.d)).map((f) => f.path), ['.claude/agents'], 'arquivo novo não versionado');
  git(ok.d, 'add', '.claude/agents/novo.md'); assert.deepEqual((await inspectProjectConfig(ok.d)).map((f) => f.path), ['.claude/agents'], 'em stage sem commit');
  const sk = repo({ 'src/a.js': '1' }); sk.put('.claude/skills/x/SKILL.md', 'x'); assert.deepEqual((await inspectProjectConfig(sk.d)).map((f) => f.path), ['.claude/skills']);
  const ign = repo({ '.gitignore': '.claude/agents/\n' }); ign.put('.claude/agents/z.md', 'x'); assert.deepEqual((await inspectProjectConfig(ign.d)).map((f) => f.path), ['.claude/agents'], 'ignorado pelo Git');
  const empty = repo({}); fs.mkdirSync(path.join(empty.d, '.claude', 'agents'), { recursive: true }); assert.deepEqual(await inspectProjectConfig(empty.d), []);
});
