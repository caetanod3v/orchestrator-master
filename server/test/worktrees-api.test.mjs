// Marco C — servidor REAL (server/index.js via orchestration-boot.mjs) em processo filho, SEMPRE com ORCH_DATA_DIR temporário e porta livre: configuração, estado e rotas de worktrees.
// Executor = CLI falsa; nada de modelo. O servidor da 4317 e data/db.json não são tocados.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(here, 'orchestration-boot.mjs');
const REAL_DB = path.resolve(here, '..', '..', 'data', 'db.json');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-api-')));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const stat = () => (fs.existsSync(REAL_DB) ? `${fs.statSync(REAL_DB).mtimeMs}:${fs.statSync(REAL_DB).size}` : 'ausente');
const ORIGIN = 'http://localhost:5173';
let n = 0;
async function boot(data, env = {}) {
  const base = { ...process.env, ORCH_DATA_DIR: data };
  for (const k of Object.keys(base)) if (/^(ORCH_CYCLE_|ORCH_PLANNER_|ORCH_WORKTREE_|E2E_)/.test(k)) delete base[k];
  const port = await freePort(), child = spawn(process.execPath, [BOOT], { env: { ...base, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child); let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))), base: `http://127.0.0.1:${port}` };
}
const up = async (data, env) => { const b = await boot(data, env); for (let i = 0; i < 100 && !/FORGE API em/.test(b.out()); i++) await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); assert.match(b.out(), /FORGE API em/, b.out()); return b; };
const stop = async (b) => { b.child.kill(); await b.exited; };
async function call(b, p, { method = 'GET', body, origin = method === 'GET' ? undefined : ORIGIN } = {}) {
  const res = await fetch(b.base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const world = () => { const dir = path.join(root, `w${++n}`); fs.mkdirSync(dir); return dir; };

test('configuração e estado: padrão DESLIGADO; entrada inválida = 400; Origin obrigatório; ambiente trava o campo; valor gravado sobrevive ao reinício', async () => {
  const realBefore = stat(), data = world(); let b = await up(data);
  try {
    const st = (await call(b, '/api/state')).json; assert.deepEqual(st.worktrees, { isolation: { enabled: false, source: 'default' }, items: [], unregistered: [] });
    for (const body of [{ worktreeIsolation: 'on' }, { worktreeIsolation: 1 }, { worktreeIsolation: null }]) { const r = await call(b, '/api/settings', { method: 'PUT', body }); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.json.error, /worktreeIsolation/); }
    assert.equal((await call(b, '/api/settings', { method: 'PUT', body: { worktreeIsolation: true }, origin: 'http://evil.example' })).status, 403);
    assert.equal((await call(b, '/api/state')).json.worktrees.isolation.enabled, false, 'nada foi aplicado');
    assert.equal((await call(b, '/api/settings', { method: 'PUT', body: { worktreeIsolation: true } })).status, 200);
    assert.deepEqual((await call(b, '/api/state')).json.worktrees.isolation, { enabled: true, source: 'settings' });
    await stop(b); b = await up(data); assert.deepEqual((await call(b, '/api/state')).json.worktrees.isolation, { enabled: true, source: 'settings' }, 'persistido');
    await stop(b); b = await up(data, { ORCH_WORKTREE_ISOLATION: 'off' }); assert.deepEqual((await call(b, '/api/state')).json.worktrees.isolation, { enabled: false, source: 'env' });
    const locked = await call(b, '/api/settings', { method: 'PUT', body: { worktreeIsolation: true } }); assert.equal(locked.status, 409); assert.match(locked.json.error, /worktreeIsolation/);
  } finally { await stop(b); }
  const bad = await boot(world(), { ORCH_WORKTREE_ISOLATION: 'talvez' }); const code = await Promise.race([bad.exited, new Promise((r) => setTimeout(() => r('preso'), 15000))]);
  assert.notEqual(code, 'preso'); assert.notEqual(code, 0); assert.match(bad.out(), /ORCH_WORKTREE_ISOLATION/);
  assert.equal(stat(), realBefore, 'o banco real não foi tocado');
});

test('rotas de worktrees pelo servidor real: vazio, 404, Origin obrigatório nas mutações e nenhuma rota destrutiva/forçada', async () => {
  const data = world(), b = await up(data);
  try {
    assert.deepEqual((await call(b, '/api/worktrees')).json, []); assert.equal((await call(b, '/api/worktrees/wt_00000000')).status, 404);
    for (const op of ['check', 'snapshot', 'integrate', 'cleanup', 'revalidate']) {
      assert.equal((await call(b, `/api/worktrees/wt_00000000/${op}`, { method: 'POST', body: {} })).status, 404, op);
      assert.equal((await call(b, `/api/worktrees/wt_00000000/${op}`, { method: 'POST', body: {}, origin: null })).status, 403, `${op} sem Origin`);
    }
    assert.equal((await call(b, '/api/worktrees/wt_00000000', { method: 'DELETE' })).status, 404); assert.equal((await call(b, '/api/worktrees/wt_00000000/force', { method: 'POST', body: {} })).status, 404);
  } finally { await stop(b); }
});

test('RECUPERAÇÃO no boot do servidor real: registro com operação inacabada é conciliado com o Git, nada é relançado e o estado aparece em /api/state', async () => {
  const data = world(), repo = path.join(root, 'repo-boot'); fs.mkdirSync(repo);
  const G = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  G('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); G('add', '-A'); G('commit', '-q', '-m', 'base');
  let b = await up(data); await stop(b); // cria db.json
  const file = path.join(data, 'db.json'), dbj = JSON.parse(fs.readFileSync(file, 'utf8'));
  dbj.worktrees = [{ id: 'wt_aaaaaaaa', missionId: 'm', cycleId: null, workspaceId: 'w', repoPath: repo, path: path.join(root, 'sumiu', 'wt_aaaaaaaa'), branch: 'orch/wt_aaaaaaaa', baseBranch: 'main', baseCommit: G('rev-parse', 'HEAD'), state: 'creating', op: { kind: 'create', at: 'T' }, current: null, rounds: [], attempts: [], history: [] }];
  fs.writeFileSync(file, JSON.stringify(dbj, null, 2));
  b = await up(data);
  try {
    const items = (await call(b, '/api/state')).json.worktrees.items; assert.deepEqual(items.map((x) => [x.id, x.state, x.op]), [['wt_aaaaaaaa', 'failed', null]]); assert.ok(items[0].history.some((h) => h.event === 'create_interrupted_nothing_created'));
    assert.equal((await call(b, '/api/missions')).json.filter((m) => m.cycle).length, 0, 'nenhuma missão foi relançada'); assert.equal(G('branch', '--list', 'orch/*'), '');
  } finally { await stop(b); }
  const after = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(after.worktrees[0].state, 'failed', 'gravado');
});

// ---------- painel: componente React REAL renderizado (esbuild empacota; react-dom/server renderiza) ----------
test('PAINEL: worktrees, tentativas, conflitos, problemas e a autorização explícita são renderizados; texto vindo do servidor nunca vira HTML; os componentes da página compilam', async () => {
  const { createRequire } = await import('node:module');
  const CLIENT = path.resolve(here, '..', '..', 'client'), esbuild = createRequire(path.join(CLIENT, 'package.json'))('esbuild');
  const bundle = async (contents) => esbuild.build({ stdin: { contents, resolveDir: path.join(CLIENT, 'src'), loader: 'jsx' }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', absWorkingDir: CLIENT, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });
  const out = await bundle(`import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { WorktreeView } from './components/WorktreePanel.jsx'; import { worktreeView } from './worktree-view.js'; export const render = (items) => renderToStaticMarkup(React.createElement(WorktreeView, { rows: worktreeView(items) }));`);
  const file = path.join(root, 'wt-bundle.cjs'); fs.writeFileSync(file, out.outputFiles[0].text);
  const { render } = createRequire(import.meta.url)(file);
  const html = render([
    { id: 'wt_11111111', missionId: 'm', state: 'finished', branch: 'orch/wt_11111111', baseBranch: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), path: 'C:/x/wt_11111111', baseDirty: true, history: [{ at: 'T', event: 'created' }, { at: 'U', event: 'execution_finished' }],
      attempts: [{ id: 'att_1', kind: 'check', result: 'conflict', concurrent: true, conflicts: ['a.txt'], overlap: ['a.txt'], problems: [{ code: 'uncommitted_changes', message: 'tem alterações <b>x</b>' }], evidence: { round: 1, level: 'verified', match: true }, targetHead: 'c'.repeat(40), wtHead: 'b'.repeat(40) }] },
    { id: 'wt_22222222', missionId: 'm', state: 'finished', branch: 'orch/wt_22222222', baseBranch: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), path: 'C:/x/wt_22222222', history: [],
      attempts: [{ id: 'att_2', kind: 'check', result: 'mergeable', fastForward: true, concurrent: false, conflicts: [], overlap: [], problems: [], evidence: { round: 1, level: 'verified', match: true }, digest: 'd'.repeat(32), targetHead: 'a'.repeat(40), wtHead: 'b'.repeat(40) }] },
    { id: 'wt_33333333', missionId: 'm', state: 'inconsistent', branch: 'orch/wt_33333333', baseBranch: 'main', baseCommit: 'a'.repeat(40), path: 'C:/x/3', history: [], attempts: [] },
  ]);
  for (const t of ['data-testid="worktrees"', 'worktrees isolados · 3', 'orch/wt_11111111', 'conflito real', 'data-testid="worktree-conflicts"', 'conflitos reais: a.txt', 'a branch de destino andou desde a base', 'NÃO estão no worktree', 'data-testid="worktree-problem"', 'Registrar snapshot', 'inconsistente (nada foi removido)', 'Nada é corrigido nem removido']) assert.ok(html.includes(t), `faltou: ${t}`);
  assert.equal((html.match(/data-testid="worktree-authorize"/g) || []).length, 1, 'só o ambiente com checagem "pode integrar" oferece integrar'); assert.match(html, /Autorizo integrar bbbbbbb → main \(aaaaaaa\), avanço direto/); assert.match(html, /<button[^>]*disabled=""[^>]*>Integrar à branch de destino/, 'o botão só habilita depois de marcar a autorização');
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), 'o texto do servidor é texto, nunca HTML');
  assert.equal(render([]), ''); assert.equal(render(undefined), ''); assert.equal(render([null, 'x', { id: 'a', state: 'inventado' }]), '');
  // as páginas que usam os componentes novos compilam (esbuild em memória: nada é escrito em client/dist)
  for (const f of ['pages/Settings.jsx', 'components/CyclePanel.jsx']) { const r = await bundle(`import * as M from './${f}'; export default M;`); assert.ok(r.outputFiles[0].text.length > 1000, f); }
});
