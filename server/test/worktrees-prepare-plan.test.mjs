// Marco E (E1): plano de preparação do ambiente do worktree. Somente leitura: nada é instalado nem executado (nenhum processo npm, nenhuma rede).
// Repositórios Git TEMPORÁRIOS reais para o fluxo do gerenciador/rota; o restante usa diretórios temporários com arquivos escritos pelo teste.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prep-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const { default: express } = await import('express');
const store = await import('../store.js');
const W = await import('../worktrees.js');
store.load(); store.saveOrThrow();
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const wr = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
let n = 0;
const MANIFEST = { name: 'x', version: '1.0.0', private: true, dependencies: { 'dep-a': '^1.0.0' }, devDependencies: { 'dep-b': '2.0.0' } };
const lockOf = (m = MANIFEST, extra = {}) => ({ name: m.name, version: m.version, lockfileVersion: 3, requires: true, packages: {
  '': { name: m.name, version: m.version, dependencies: m.dependencies, devDependencies: m.devDependencies },
  'node_modules/dep-a': { version: '1.2.0', resolved: 'https://registry.npmjs.org/dep-a/-/dep-a-1.2.0.tgz', integrity: 'sha512-x' },
  'node_modules/dep-b': { version: '2.0.0', resolved: 'https://registry.npmjs.org/dep-b/-/dep-b-2.0.0.tgz', integrity: 'sha512-y', dev: true }, ...extra } });
/** Diretório de worktree "de mentira" (só arquivos) para exercitar a função de plano isolada. */
function dirWith(files = {}) {
  const dir = path.join(tmp, `d${++n}`); fs.mkdirSync(dir);
  const all = { 'package.json': JSON.stringify(MANIFEST, null, 2), 'package-lock.json': JSON.stringify(lockOf(), null, 2), ...files };
  for (const [k, v] of Object.entries(all)) if (v !== null) wr(dir, k, typeof v === 'string' ? v : JSON.stringify(v));
  return { id: 'wt_0000000a', path: dir, branch: 'orch/wt_0000000a', baseCommit: 'a'.repeat(40), dir };
}
const refused = (r, code) => { assert.equal(r.ok, false, JSON.stringify(r.plan ?? r)); assert.equal(r.status, 409); assert.equal(r.code, code, r.error); assert.ok(r.error.length > 10); return r; };

test('E1 — plano válido: identidade, comando fixo, dependências, hashes, registry padrão e avisos; nada é escrito no worktree', () => {
  const w = dirWith(), before = fs.readdirSync(w.dir).sort();
  const r = W.planPrepare(w); assert.equal(r.ok, true, r.error); const p = r.plan;
  assert.deepEqual([p.manager, p.command, p.args], ['npm', 'npm ci --ignore-scripts --no-audit --no-fund', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']]);
  assert.deepEqual([p.worktree.id, p.worktree.branch, p.worktree.baseCommit], [w.id, w.branch, w.baseCommit]);
  assert.deepEqual(p.dependencies.items.map((x) => [x.name, x.section]), [['dep-a', 'dependencies'], ['dep-b', 'devDependencies']]); assert.equal(p.dependencies.count, 2);
  assert.match(p.manifest.sha256, /^[0-9a-f]{64}$/); assert.match(p.lockfile.sha256, /^[0-9a-f]{64}$/); assert.deepEqual([p.lockfile.version, p.lockfile.packages], [3, 3]);
  assert.deepEqual(p.npmrc, { present: false, sha256: null, registry: { url: 'https://registry.npmjs.org/', source: 'default' }, scopedRegistries: [] }); assert.deepEqual(p.resolvedHosts, ['registry.npmjs.org']);
  assert.ok(p.warnings.some((x) => /rede/.test(x)) && p.warnings.some((x) => /ignore-scripts/.test(x))); assert.match(r.digest, /^[0-9a-f]{64}$/); assert.deepEqual(r.notes, []);
  assert.deepEqual(fs.readdirSync(w.dir).sort(), before, 'nada foi criado no worktree (nem node_modules)');
  fs.mkdirSync(path.join(w.dir, 'node_modules')); assert.match(W.planPrepare(w).notes[0], /já tem node_modules/);
});

test('E1 — digest DETERMINÍSTICO e sensível a tudo que importa (identidade, manifesto, lockfile, .npmrc)', () => {
  const w = dirWith(), d0 = W.planPrepare(w).digest; assert.equal(W.planPrepare(w).digest, d0); assert.equal(W.planPrepare({ ...w }).digest, d0);
  const dig = (over) => W.planPrepare({ ...w, ...over }).digest;
  assert.notEqual(dig({ id: 'wt_0000000b' }), d0); assert.notEqual(dig({ baseCommit: 'b'.repeat(40) }), d0); assert.notEqual(dig({ branch: 'orch/wt_0000000b' }), d0);
  const w2 = dirWith(); assert.notEqual(W.planPrepare({ ...w, path: w2.dir }).digest, d0, 'outro caminho');
  const m2 = { ...MANIFEST, description: 'mudou' }; wr(w.dir, 'package.json', JSON.stringify(m2)); assert.notEqual(W.planPrepare(w).digest, d0, 'manifesto');
  wr(w.dir, 'package.json', JSON.stringify(MANIFEST, null, 2)); assert.equal(W.planPrepare(w).digest, d0, 'voltou ao mesmo conteúdo => mesmo digest');
  wr(w.dir, 'package-lock.json', JSON.stringify(lockOf(MANIFEST, { 'node_modules/dep-a/x': { version: '1.0.0' } }))); assert.notEqual(W.planPrepare(w).digest, d0, 'lockfile');
  wr(w.dir, 'package-lock.json', JSON.stringify(lockOf(), null, 2)); wr(w.dir, '.npmrc', 'fund=false\n'); const d1 = W.planPrepare(w).digest; assert.notEqual(d1, d0, '.npmrc'); wr(w.dir, '.npmrc', 'fund=true\n'); assert.notEqual(W.planPrepare(w).digest, d1);
});

test('E1 — recusas: sem package.json, sem lockfile, outro gerenciador, packageManager, workspaces, JSON/lockfile inválidos', () => {
  refused(W.planPrepare(dirWith({ 'package.json': null })), 'package_json_missing');
  refused(W.planPrepare(dirWith({ 'package-lock.json': null })), 'lockfile_missing');
  for (const f of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json']) { const r = refused(W.planPrepare(dirWith({ [f]: 'x' })), 'unsupported_manager'); assert.ok(r.error.includes(f)); }
  refused(W.planPrepare(dirWith({ 'package-lock.json': null, 'yarn.lock': '# yarn' })), 'unsupported_manager');
  refused(W.planPrepare(dirWith({ 'package.json': { ...MANIFEST, packageManager: 'pnpm@9.0.0' } })), 'unsupported_manager');
  assert.equal(W.planPrepare(dirWith({ 'package.json': { ...MANIFEST, packageManager: 'npm@10.0.0' }, 'package-lock.json': lockOf({ ...MANIFEST, packageManager: 'npm@10.0.0' }) })).ok, true);
  refused(W.planPrepare(dirWith({ 'package.json': { ...MANIFEST, workspaces: ['a'] } })), 'workspaces_unsupported');
  refused(W.planPrepare(dirWith({ 'package.json': '{ não é json' })), 'package_invalid'); refused(W.planPrepare(dirWith({ 'package.json': '[]' })), 'package_invalid');
  refused(W.planPrepare(dirWith({ 'package-lock.json': '{ não é json' })), 'lockfile_invalid');
  refused(W.planPrepare(dirWith({ 'package-lock.json': { lockfileVersion: 1, dependencies: {} } })), 'lockfile_invalid');
  refused(W.planPrepare(dirWith({ 'package-lock.json': { lockfileVersion: 3, packages: {} } })), 'lockfile_invalid');
  const link = dirWith({ 'package-lock.json': null }); fs.writeFileSync(path.join(tmp, 'alvo-lock.json'), JSON.stringify(lockOf()));
  try { fs.symlinkSync(path.join(tmp, 'alvo-lock.json'), path.join(link.dir, 'package-lock.json')); refused(W.planPrepare(link), 'file_unsafe'); } catch (e) { if (e.code !== 'EPERM') throw e; }
});

test('E1 — manifesto e lockfile INCONSISTENTES: dependência com versão diferente, a mais, a menos ou não resolvida no lock', () => {
  const m = (over) => ({ ...MANIFEST, ...over });
  let r = refused(W.planPrepare(dirWith({ 'package.json': m({ dependencies: { 'dep-a': '^9.0.0' } }) })), 'lockfile_inconsistent'); assert.match(r.error, /dependencies:dep-a/);
  r = refused(W.planPrepare(dirWith({ 'package.json': m({ dependencies: { 'dep-a': '^1.0.0', 'dep-c': '1.0.0' } }) })), 'lockfile_inconsistent'); assert.match(r.error, /dep-c/);
  refused(W.planPrepare(dirWith({ 'package.json': m({ devDependencies: {} }) })), 'lockfile_inconsistent');
  const noPkg = lockOf(); delete noPkg.packages['node_modules/dep-b']; r = refused(W.planPrepare(dirWith({ 'package-lock.json': noPkg })), 'lockfile_inconsistent'); assert.match(r.error, /não resolve: dep-b/);
});

test('E1 — .npmrc: registry https válido entra no plano; credenciais, variáveis, chaves não permitidas e URLs inválidas são recusadas SEM repetir o valor', () => {
  const ok = W.planPrepare(dirWith({ '.npmrc': '# projeto\nregistry=https://registry.exemplo.com/npm/\n@meu:registry=https://pkgs.exemplo.com/\nfund=false\n' })); assert.equal(ok.ok, true, ok.error);
  assert.deepEqual([ok.plan.npmrc.present, ok.plan.npmrc.registry, ok.plan.npmrc.scopedRegistries], [true, { url: 'https://registry.exemplo.com/npm/', source: '.npmrc' }, [{ scope: '@meu', url: 'https://pkgs.exemplo.com/' }]]);
  assert.match(ok.plan.npmrc.sha256, /^[0-9a-f]{64}$/); assert.ok(ok.plan.warnings.some((x) => /Registry diferente/.test(x)) && ok.plan.warnings.some((x) => /Registries por escopo/.test(x)) && ok.plan.warnings.some((x) => /hosts diferentes/.test(x)));
  const SEGREDO = 'SEGREDO-123-nao-vazar';
  for (const [rc, code] of [[`//registry.npmjs.org/:_authToken=${SEGREDO}\n`, 'npmrc_sensitive'], [`_auth=${SEGREDO}\n`, 'npmrc_sensitive'], [`username=u\n_password=${SEGREDO}\n`, 'npmrc_sensitive'], [`@x:registry=https://u:${SEGREDO}@h.com/\n`, 'npmrc_invalid'],
    [`registry=https://${SEGREDO}@h.com/\n`, 'npmrc_invalid'], ['registry=http://h.com/\n', 'npmrc_invalid'], ['registry=não-é-url\n', 'npmrc_invalid'], ['registry=${NPM_REGISTRY}\n', 'npmrc_not_allowed'], ['script-shell=/bin/sh\n', 'npmrc_not_allowed'], ['ignore-scripts=false\n', 'npmrc_not_allowed'],
    ['prefix=/tmp/x\n', 'npmrc_not_allowed'], ['linha sem igual\n', 'npmrc_invalid']]) {
    const r = refused(W.planPrepare(dirWith({ '.npmrc': rc })), code); assert.ok(!JSON.stringify(r).includes(SEGREDO), `o valor sensível vazou: ${rc.slice(0, 30)}`);
  }
  assert.equal(W.planPrepare(dirWith({ '.npmrc': '' })).ok, true); assert.equal(W.planPrepare(dirWith({ '.npmrc': '\n; só comentário\n' })).ok, true);
});

test('E1 — avisos para fontes não-registry e URLs não-https no lockfile; plano nunca lança com lockfile estranho', () => {
  const extra = { 'node_modules/dep-g': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/y.git#abc' }, 'node_modules/dep-h': { version: '1.0.0', resolved: 'http://registry.npmjs.org/h.tgz' }, 'node_modules/dep-l': { resolved: 'x', link: true } };
  const r = W.planPrepare(dirWith({ 'package-lock.json': lockOf(MANIFEST, extra) })); assert.equal(r.ok, true, r.error);
  assert.ok(r.plan.warnings.some((x) => /git\/link.*dep-g/.test(x))); assert.ok(r.plan.warnings.some((x) => /não são https/.test(x)));
  assert.equal(W.planPrepare(dirWith({ 'package-lock.json': lockOf(MANIFEST, { 'node_modules/estranho': 'texto', 'node_modules/nulo': null }) })).ok, true);
  assert.equal(W.planPrepare({ id: 'wt_0000000a', path: path.join(tmp, 'nao-existe'), branch: 'b', baseCommit: 'c' }).code, 'package_json_missing');
});

test('E1 — gerenciador e rota: plano de um worktree REAL parado (somente leitura, registro intacto); recusa para estados/ambientes inválidos', async () => {
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo); G(repo, 'init', '-q', '-b', 'main'); G(repo, 'config', 'core.autocrlf', 'false');
  wr(repo, 'package.json', JSON.stringify(MANIFEST, null, 2)); wr(repo, 'package-lock.json', JSON.stringify(lockOf(), null, 2)); G(repo, 'add', '-A'); G(repo, 'commit', '-q', '-m', 'base');
  const ws = { id: 'ws1', name: 'ws1', path: repo, verifications: [] }, m = { id: 'm1', workspaceId: 'ws1', tasks: [], cycle: { id: 'cy1', status: 'completed', assurance: 'verified' } };
  const db = { worktrees: [], missions: [m], workspaces: [ws] }, mgr = W.createWorktreeManager({ db, root: path.join(tmp, 'wts') });
  const rec = (await mgr.create({ mission: m, workspace: ws })).record, app = express(); app.use(express.json()); W.setupWorktrees(app, { db, manager: mgr });
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); }), base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (id) => { const r = await fetch(`${base}/api/worktrees/${id}/prepare/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json() }; };
  try {
    const snap = JSON.stringify(db.worktrees), head = G(repo, 'rev-parse', 'HEAD'), listing = fs.readdirSync(rec.path).sort();
    const a = await post(rec.id); assert.equal(a.status, 200); assert.equal(a.body.plan.worktree.id, rec.id); assert.equal(a.body.plan.worktree.baseCommit, head); assert.equal(a.body.plan.worktree.path, W.planPrepare(rec).plan.worktree.path); assert.equal(a.body.digest, W.planPrepare(rec).digest);
    assert.equal((await post(rec.id)).body.digest, a.body.digest, 'determinístico'); assert.equal(JSON.stringify(db.worktrees), snap, 'o registro não foi alterado'); assert.deepEqual(fs.readdirSync(rec.path).sort(), listing); assert.equal(G(repo, 'rev-parse', 'HEAD'), head);
    assert.equal((await post('wt_inexistente')).status, 404);
    rec.state = 'in_use'; let r = await post(rec.id); assert.deepEqual([r.status, r.body.code], [409, 'worktree_not_preparable']); rec.state = 'ready'; rec.op = { kind: 'cleanup', at: 'T' }; assert.equal((await post(rec.id)).body.code, 'worktree_not_preparable'); rec.op = null;
    rec.state = 'inconsistent'; assert.equal((await post(rec.id)).body.code, 'worktree_not_preparable'); rec.state = 'ready';
    G(rec.path, 'checkout', '-q', '-b', 'outra'); r = await post(rec.id); assert.deepEqual([r.status, r.body.code], [409, 'worktree_invalid']); assert.match(r.body.error, /branch_changed/); G(rec.path, 'checkout', '-q', rec.branch);
    fs.rmSync(path.join(rec.path, 'package-lock.json')); r = await post(rec.id); assert.deepEqual([r.status, r.body.code], [409, 'lockfile_missing']);
  } finally { srv.close(); }
});
