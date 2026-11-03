// Marco E (E2): aprovação e execução controlada da preparação. NENHUM teste executa npm ci real nem acessa a rede: o "npm" é um script node inofensivo injetado por `prepareSpec`,
// que só cria node_modules/<dep>/package.json no cwd e grava o que viu (cwd, argumentos, ambiente) para o teste conferir. Repositórios e banco TEMPORÁRIOS.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prep2-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json');
const { default: express } = await import('express');
const store = await import('../store.js');
const W = await import('../worktrees.js');
const { createChildRegistry } = await import('../child-registry.js');
store.load(); store.saveOrThrow();
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const wr = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const MANIFEST = { name: 'x', version: '1.0.0', private: true, dependencies: { 'dep-a': '^1.0.0' }, devDependencies: { 'dep-b': '2.0.0' } };
const LOCK = { name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0', dependencies: MANIFEST.dependencies, devDependencies: MANIFEST.devDependencies },
  'node_modules/dep-a': { version: '1.2.0', resolved: 'https://registry.npmjs.org/dep-a/-/dep-a-1.2.0.tgz' }, 'node_modules/dep-b': { version: '2.0.0', resolved: 'https://registry.npmjs.org/dep-b/-/dep-b-2.0.0.tgz', dev: true } } };
// "npm" falso: grava o que viu em E2_OUT; E2_MODE: ok | gate (espera o arquivo E2_GATE) | fail | incomplete | sleep
const FAKE_NPM = `
const fs = require('fs'), mode = process.env.E2_MODE || 'ok';
fs.writeFileSync(process.env.E2_OUT, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^npm_|^NODE_OPTIONS$|^NODE_PATH$|token|secret|proxy/i.test(k))),
  ci: process.env.CI, userrc: fs.readFileSync(process.env.npm_config_userconfig, 'utf8'), globalrc: fs.readFileSync(process.env.npm_config_globalconfig, 'utf8'), userrcPath: process.env.npm_config_userconfig }));
const put = (n) => { fs.mkdirSync('node_modules/' + n, { recursive: true }); fs.writeFileSync('node_modules/' + n + '/package.json', '{}'); };
(async () => {
  if (mode === 'gate') { while (!fs.existsSync(process.env.E2_GATE)) await new Promise((r) => setTimeout(r, 20)); }
  if (mode === 'sleep') { setInterval(() => {}, 1000); return; }
  if (mode === 'leak') { console.error('GET https://usr:S3cretPw@registry.example/x falhou; proxy=http://puser:ppass99@proxy.local:8080; echo tok-abc123456; //registry/:_authToken=XYZSECRET1'); process.exit(7); }
  if (mode === 'fail') { console.error('boom: falha simulada'); process.exit(3); }
  put('dep-a'); if (mode !== 'incomplete') put('dep-b');
})();`;
let n = 0;
function setup({ track = true, spawnCount = { n: 0 }, prepareTimeoutMs, maxOutputBytes } = {}) {
  const id = ++n, repo = path.join(tmp, `repo${id}`); fs.mkdirSync(repo); G(repo, 'init', '-q', '-b', 'main'); G(repo, 'config', 'core.autocrlf', 'false');
  wr(repo, 'package.json', JSON.stringify(MANIFEST, null, 2)); wr(repo, 'package-lock.json', JSON.stringify(LOCK, null, 2)); wr(repo, '.gitignore', 'node_modules/\n'); G(repo, 'add', '-A'); G(repo, 'commit', '-q', '-m', 'base');
  const ws = { id: `ws${id}`, name: `ws${id}`, path: repo, verifications: [] }, m = { id: `m${id}`, workspaceId: ws.id, tasks: [], cycle: { id: `cy${id}`, status: 'completed', assurance: 'verified' } };
  const db = { worktrees: [], missions: [m], workspaces: [ws] }, registry = createChildRegistry();
  const out = path.join(tmp, `out${id}.json`), gate = path.join(tmp, `gate${id}`);
  process.env.E2_OUT = out; process.env.E2_GATE = gate;
  const spawnProc = (...a) => { spawnCount.n++; spawnCount.last = a; return spawn(...a); };
  const mgr = W.createWorktreeManager({ db, root: path.join(tmp, `wts${id}`), track: track ? registry.track : null, prepareSpec: (args) => ({ command: process.execPath, args: ['-e', FAKE_NPM, ...args] }), spawnProc, prepareTimeoutMs, maxOutputBytes });
  return { repo, ws, m, db, mgr, registry, out, gate, spawnCount, seen: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}
const mkWt = async (w) => { const r = await w.mgr.create({ mission: w.m, workspace: w.ws }); assert.equal(r.ok, true, r.error); w.mgr.link(r.record.id, w.m.cycle.id); return r.record; };
const planOf = async (w, rec) => { const p = await w.mgr.planPrepare(rec.id); assert.equal(p.ok, true, p.error); return p.digest; };
const go = async (w, rec, mode = 'ok', digest) => { process.env.E2_MODE = mode; digest ??= await planOf(w, rec); return w.mgr.prepare(rec.id, { digest }); };
const refused = (r, code, status = 409) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.status, status); assert.equal(r.code, code, r.error); return r; };

test('E2 — aprovação e execução bem-sucedidas: 202, processo registrado no child-registry, aprovação consumida e gravada, resultado verificado por environmentFor', async () => {
  const w = setup(), rec = await mkWt(w); assert.equal(w.mgr.environmentFor(rec.id).ok, false);
  const digest = await planOf(w, rec); fs.rmSync(w.gate, { force: true });
  const r = await go(w, rec, 'gate', digest); assert.equal(r.ok, true); assert.equal(r.status, 202);
  // durante a execução: operação marcada, estado persistido, PID no registro de filhos
  assert.deepEqual([rec.op.kind, rec.prepare.state, rec.prepare.approval.digest, rec.prepare.approval.authorizedBy], ['prepare', 'running', digest, 'user']); assert.ok(rec.prepare.approval.consumedAt);
  const onDisk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); assert.ok(Array.isArray(onDisk.childProcesses));
  const ch = w.registry.pending().filter((x) => x.kind === 'preparer'); assert.equal(ch.length, 1); assert.deepEqual([ch[0].worktreeId, ch[0].missionId], [rec.id, w.m.id]); assert.ok(Number.isInteger(ch[0].pid));
  fs.writeFileSync(w.gate, 'go'); const f = await r.finished;
  assert.deepEqual([f.status, f.exitCode], ['ready', 0]); assert.equal(rec.op, null); assert.equal(rec.state, 'ready'); assert.equal(w.mgr.environmentFor(rec.id).ok, true); assert.equal(w.mgr.environmentFor(rec.id).code, 'prepared');
  const p = rec.prepare; assert.deepEqual([p.state, p.exitCode, p.dependencies, p.reason, p.command], ['ready', 0, 2, null, 'npm ci --ignore-scripts --no-audit --no-fund']); assert.ok(p.durationMs >= 0); assert.equal(p.approval.digest, digest); assert.match(p.lockfileSha256, /^[0-9a-f]{64}$/);
  assert.equal(w.registry.pending().filter((x) => x.kind === 'preparer').length, 0, 'registro do filho liberado ao terminar'); assert.ok(rec.history.some((h) => h.event === 'prepare_approved') && rec.history.some((h) => h.event === 'prepare_ready'));
  assert.equal(fs.existsSync(path.join(w.repo, 'node_modules')), false, 'nada foi instalado no workspace principal');
});

test('E2 — digest incorreto, malformado ou plano ALTERADO depois de aprovado: recusa sem iniciar processo', async () => {
  const w = setup(), rec = await mkWt(w), digest = await planOf(w, rec);
  refused(await w.mgr.prepare(rec.id, { digest: 'a'.repeat(64) }), 'digest_mismatch'); assert.equal((await w.mgr.prepare(rec.id, { digest: 'xyz' })).status, 400); assert.equal((await w.mgr.prepare(rec.id, {})).status, 400); assert.equal((await w.mgr.prepare('wt_inexistente', { digest })).status, 404);
  // lockfile alterado no worktree depois de gerar o plano
  const lk = path.join(rec.path, 'package-lock.json'), orig = fs.readFileSync(lk, 'utf8'); wr(rec.path, 'package-lock.json', JSON.stringify({ ...LOCK, requires: false })); refused(await w.mgr.prepare(rec.id, { digest }), 'digest_mismatch'); fs.writeFileSync(lk, orig);
  wr(rec.path, '.npmrc', 'fund=false\n'); refused(await w.mgr.prepare(rec.id, { digest }), 'digest_mismatch'); fs.rmSync(path.join(rec.path, '.npmrc'));
  wr(rec.path, '.npmrc', '//registry.npmjs.org/:_authToken=SEGREDO-XYZ\n'); const r = refused(await w.mgr.prepare(rec.id, { digest }), 'npmrc_sensitive'); assert.ok(!JSON.stringify(r).includes('SEGREDO-XYZ')); fs.rmSync(path.join(rec.path, '.npmrc'));
  assert.equal(w.spawnCount.n, 0, 'nenhum processo foi iniciado'); assert.equal(rec.op, null); assert.equal(rec.prepare, undefined); assert.equal(fs.existsSync(path.join(rec.path, 'node_modules')), false);
});

test('E2 — a aprovação vale UMA vez: depois de preparado, repetir o mesmo digest não executa de novo; durante a execução, nem uma segunda chamada', async () => {
  const w = setup(), rec = await mkWt(w), digest = await planOf(w, rec); fs.rmSync(w.gate, { force: true });
  const a = await go(w, rec, 'gate', digest); assert.equal(a.ok, true);
  refused(await w.mgr.prepare(rec.id, { digest }), 'preparation_in_progress'); assert.equal(w.spawnCount.n, 1);
  fs.writeFileSync(w.gate, 'go'); assert.equal((await a.finished).status, 'ready');
  refused(await w.mgr.prepare(rec.id, { digest }), 'environment_already_prepared'); assert.equal(w.spawnCount.n, 1, 'um único processo no total');
});

test('E2 — falha de PERSISTÊNCIA antes do spawn: nada é executado e o registro volta exatamente ao que era', async () => {
  const w = setup(), rec = await mkWt(w), digest = await planOf(w, rec);
  fs.mkdirSync(`${DB_FILE}.tmp`); let r;
  try { r = await w.mgr.prepare(rec.id, { digest }); } finally { fs.rmSync(`${DB_FILE}.tmp`, { recursive: true, force: true }); }
  refused(r, 'persistence_failed', 503); assert.match(r.error, /NÃO foi iniciada/); assert.equal(w.spawnCount.n, 0); assert.equal(rec.op, null); assert.equal(rec.prepare, undefined); assert.equal(rec.state, 'ready'); assert.equal(fs.existsSync(path.join(rec.path, 'node_modules')), false);
  store.saveOrThrow(); const ok = await go(w, rec, 'ok', digest); assert.equal(ok.ok, true); assert.equal((await ok.finished).status, 'ready'); // e depois funciona
});

test('E2 — falha do processo, timeout e saída excessiva: registra "failed", node_modules NÃO é apagado e a verificação continua bloqueada', async () => {
  let w = setup(), rec = await mkWt(w), r = await go(w, rec, 'fail'); let f = await r.finished;
  assert.deepEqual([f.status, f.exitCode], ['failed', 3]); assert.match(rec.prepare.reason, /código 3/); assert.match(rec.prepare.outputTail, /boom/); assert.equal(rec.op, null); assert.equal(rec.state, 'ready'); assert.equal(w.mgr.environmentFor(rec.id).ok, false); assert.ok(rec.history.some((h) => h.event === 'prepare_failed'));
  assert.equal(w.registry.pending().filter((x) => x.kind === 'preparer').length, 0);
  // nova tentativa explícita (nova chamada = nova aprovação) depois da falha funciona
  r = await go(w, rec, 'ok'); assert.equal((await r.finished).status, 'ready');
  w = setup({ prepareTimeoutMs: 400 }); rec = await mkWt(w); r = await go(w, rec, 'sleep'); f = await r.finished; assert.equal(f.status, 'failed'); assert.match(rec.prepare.reason, /tempo máximo/); assert.equal(rec.op, null);
  w = setup({ maxOutputBytes: 10 }); rec = await mkWt(w); r = await go(w, rec, 'fail'); f = await r.finished; assert.equal(f.status, 'failed');
  // node_modules parcial deixado por uma falha permanece intacto
  w = setup(); rec = await mkWt(w); wr(rec.path, 'node_modules/dep-a/package.json', '{}'); wr(rec.path, 'node_modules/marca.txt', 'não apagar'); r = await go(w, rec, 'fail'); await r.finished;
  assert.equal(fs.readFileSync(path.join(rec.path, 'node_modules', 'marca.txt'), 'utf8'), 'não apagar'); assert.equal(w.mgr.environmentFor(rec.id).ok, false);
});

test('E2 — exit code 0 com ambiente INCOMPLETO: falha, com o motivo; a verificação continua bloqueada', async () => {
  const w = setup(), rec = await mkWt(w), r = await go(w, rec, 'incomplete'), f = await r.finished;
  assert.deepEqual([f.status, f.exitCode], ['failed', 0]); assert.match(rec.prepare.reason, /ambiente ficou incompleto.*dep-b/); assert.equal(w.mgr.environmentFor(rec.id).ok, false); assert.equal(rec.prepare.state, 'failed');
});

test('E2 — isolamento: cwd é o worktree real, argumentos FIXOS, ambiente limpo (sem npm_*, segredos, NODE_OPTIONS) e configs do npm vazias e do orquestrador', async () => {
  const w = setup(), rec = await mkWt(w), saved = { ...process.env };
  Object.assign(process.env, { npm_config_registry: 'https://evil.example/', npm_config_ignore_scripts: 'false', npm_config_userconfig: '/etc/meu.npmrc', NPM_TOKEN: 'tok-secreto', MEU_SECRET: 'x', NODE_OPTIONS: '--no-warnings', NODE_PATH: '/x', npm_lifecycle_event: 'test' });
  let r; try { r = await go(w, rec, 'ok'); } finally { for (const k of ['npm_config_registry', 'npm_config_ignore_scripts', 'npm_config_userconfig', 'NPM_TOKEN', 'MEU_SECRET', 'NODE_OPTIONS', 'NODE_PATH', 'npm_lifecycle_event']) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } }
  await r.finished; const s = w.seen();
  assert.equal(fs.realpathSync.native(s.cwd), fs.realpathSync.native(rec.path)); assert.notEqual(fs.realpathSync.native(s.cwd), fs.realpathSync.native(w.repo)); assert.deepEqual(s.argv, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(s.env.npm_config_ignore_scripts, 'true'); assert.equal(s.env.npm_config_registry, undefined); assert.equal(s.env.NPM_TOKEN, undefined); assert.equal(s.env.MEU_SECRET, undefined); assert.equal(s.env.NODE_OPTIONS, undefined); assert.equal(s.env.NODE_PATH, undefined); assert.equal(s.env.npm_lifecycle_event, undefined); assert.equal(s.ci, '1');
  assert.deepEqual([s.userrc, s.globalrc], ['', '']); assert.notEqual(s.env.npm_config_userconfig, '/etc/meu.npmrc'); assert.ok(s.env.npm_config_userconfig.startsWith(os.tmpdir()), 'config vazia do orquestrador'); assert.equal(fs.existsSync(s.userrcPath), false, 'a pasta temporária foi removida');
  assert.deepEqual(w.spawnCount.last[2].stdio, ['ignore', 'pipe', 'pipe']); assert.equal(w.spawnCount.last[2].shell, false);
});

test('E2 — concorrência e bloqueios: com ciclo ativo, estado/ambiente inválido ou preparação em curso nada executa; durante a execução cleanup/snapshot/integração/uso do worktree ficam bloqueados', async () => {
  const w = setup(), rec = await mkWt(w), digest = await planOf(w, rec);
  w.m.cycle.status = 'running'; refused(await w.mgr.prepare(rec.id, { digest }), 'cycle_active'); w.m.cycle.status = 'planning'; refused(await w.mgr.prepare(rec.id, { digest }), 'cycle_active'); w.m.cycle.status = 'blocked';
  rec.state = 'in_use'; refused(await w.mgr.prepare(rec.id, { digest }), 'worktree_not_preparable'); rec.state = 'inconsistent'; refused(await w.mgr.prepare(rec.id, { digest }), 'worktree_not_preparable'); rec.state = 'ready';
  rec.op = { kind: 'cleanup', at: 'T' }; refused(await w.mgr.prepare(rec.id, { digest }), 'worktree_not_preparable'); rec.op = null;
  G(rec.path, 'checkout', '-q', '-b', 'outra'); refused(await w.mgr.prepare(rec.id, { digest }), 'worktree_invalid'); G(rec.path, 'checkout', '-q', rec.branch);
  assert.equal(w.spawnCount.n, 0);
  // durante a execução
  fs.rmSync(w.gate, { force: true }); w.m.cycle.status = 'completed'; const a = await go(w, rec, 'gate', digest); assert.equal(a.ok, true);
  const cl = await w.mgr.cleanup(rec.id); assert.deepEqual([cl.ok, cl.status], [false, 409]); assert.match(cl.error, /operação/); assert.equal(fs.existsSync(rec.path), true);
  const sn = await w.mgr.snapshot(rec.id); assert.equal(sn.ok, false); assert.equal((await w.mgr.integrate(rec.id, { digest: 'a'.repeat(32) })).ok, false);
  const ck = await w.mgr.check(rec.id); assert.ok(ck.attempt.problems.some((p) => p.code === 'operation_in_progress')); w.m.cycle.worktreeId = rec.id; assert.equal(w.mgr.workspaceFor(w.m), null, 'o ciclo não usa o worktree enquanto prepara');
  const ens = await w.mgr.ensureFor(w.m, w.ws); assert.notEqual(ens.record?.id, rec.id, 'não reaproveita um worktree em operação');
  // outra preparação (outro worktree) enquanto uma roda
  const other = await mkWt(w), od = await planOf(w, other); refused(await w.mgr.prepare(other.id, { digest: od }), 'preparation_in_progress');
  fs.writeFileSync(w.gate, 'go'); assert.equal((await a.finished).status, 'ready'); assert.equal(rec.op, null);
  assert.equal(w.spawnCount.n, 1);
});

test('E2 — falha ao registrar o processo no child-registry: o filho é encerrado e a preparação falha (nunca fica vivo sem registro)', async () => {
  const w = setup({ track: false }); const failing = W.createWorktreeManager({ db: w.db, root: path.join(tmp, 'wtsx'), track: () => { throw Object.assign(new Error('disco'), { code: 'EIO' }); }, prepareSpec: (args) => ({ command: process.execPath, args: ['-e', FAKE_NPM, ...args] }) });
  const rec = await mkWt({ ...w, mgr: failing }); process.env.E2_MODE = 'sleep'; const d = (await failing.planPrepare(rec.id)).digest;
  const r = await failing.prepare(rec.id, { digest: d }); assert.equal(r.ok, true); const f = await r.finished; assert.equal(f.status, 'failed'); assert.match(rec.prepare.reason, /registrar o processo/); assert.equal(rec.op, null); assert.equal(failing.environmentFor(rec.id).ok, false);
});

test('E2 — rota: só o digest vem do cliente (campos extras ignorados); 202 ao iniciar, erros claros ao recusar', async () => {
  const w = setup(), rec = await mkWt(w), app = express(); app.use(express.json()); W.setupWorktrees(app, { db: w.db, manager: w.mgr });
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); }), base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, b) => { const r = await fetch(`${base}/api/worktrees/${rec.id}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json() }; };
  try {
    process.env.E2_MODE = 'ok'; const plan = await post('/prepare/plan'); assert.equal(plan.status, 200);
    let r = await post('/prepare', {}); assert.equal(r.status, 400); r = await post('/prepare', { digest: 'b'.repeat(64) }); assert.deepEqual([r.status, r.body.code], [409, 'digest_mismatch']);
    r = await post('/prepare', { digest: plan.body.digest, command: 'rm -rf /', args: ['--force'], cwd: '/', env: { X: '1' } }); assert.equal(r.status, 202); assert.equal(r.body.started, true); assert.equal(r.body.worktree.prepare.state, 'running');
    assert.deepEqual(w.spawnCount.last[1].slice(2), ['ci', '--ignore-scripts', '--no-audit', '--no-fund']); assert.equal(fs.realpathSync.native(w.spawnCount.last[2].cwd), fs.realpathSync.native(rec.path));
    const t0 = Date.now(); while (rec.op && Date.now() - t0 < 15000) await new Promise((q) => setTimeout(q, 25)); assert.equal(rec.prepare.state, 'ready');
    r = await post('/prepare', { digest: plan.body.digest }); assert.deepEqual([r.status, r.body.code], [409, 'environment_already_prepared']);
  } finally { srv.close(); }
});

const SEGREDOS = ['S3cretPw', 'ppass99', 'tok-abc123456', 'XYZSECRET1', 'SPWD99'];
const noLeak = (text, what) => { for (const x of SEGREDOS) assert.ok(!String(text).includes(x), `${what}: vazou "${x}"`); };
const PROXIES = { HTTP_PROXY: 'http://puser:ppass99@proxy.local:8080', HTTPS_PROXY: 'http://puser:ppass99@proxy.local:8080', ALL_PROXY: 'http://puser:ppass99@proxy.local:8080', NO_PROXY: 'localhost', http_proxy: 'http://puser:ppass99@proxy.local:8080', NPM_TOKEN: 'tok-abc123456' };
const withEnv = async (extra, fn) => { const saved = {}; for (const k of Object.keys(extra)) { saved[k] = process.env[k]; process.env[k] = extra[k]; } try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };

test('V1/V2 — as quatro variáveis de proxy (e o token) NÃO chegam ao processo de preparação', async () => {
  const w = setup(), rec = await mkWt(w);
  const r = await withEnv(PROXIES, () => go(w, rec, 'ok')); await r.finished;
  const s = w.seen(); assert.deepEqual(Object.keys(s.env).filter((k) => /proxy|token/i.test(k)), [], JSON.stringify(Object.keys(s.env)));
});

test('V1/V2 — outputTail e reason são sanitizados ANTES de gravar: nem o banco em disco, nem o registro, nem o describe, nem a resposta da rota têm os segredos', async () => {
  const w = setup(), rec = await mkWt(w), app = express(); app.use(express.json()); W.setupWorktrees(app, { db: w.db, manager: w.mgr });
  const srv = await new Promise((res) => { const sv = app.listen(0, '127.0.0.1', () => res(sv)); }), base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const plan = await (await fetch(`${base}/api/worktrees/${rec.id}/prepare/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    process.env.E2_MODE = 'leak';
    const post = await withEnv(PROXIES, async () => { const rr = await fetch(`${base}/api/worktrees/${rec.id}/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ digest: plan.digest }) }); const t0 = Date.now(); while (rec.op && Date.now() - t0 < 15000) await new Promise((q) => setTimeout(q, 25)); return rr; });
    const body = await post.text(); assert.equal(post.status, 202); noLeak(body, 'resposta 202');
    assert.deepEqual([rec.prepare.state, rec.prepare.exitCode], ['failed', 7]); assert.match(rec.prepare.outputTail, /\*\*\*@registry\.example/); assert.match(rec.prepare.outputTail, /_authToken=\*\*\*/); assert.match(rec.prepare.outputTail, /GET https:\/\//, 'o resto da mensagem continua legível');
    noLeak(rec.prepare.outputTail, 'outputTail'); noLeak(rec.prepare.reason, 'reason'); noLeak(JSON.stringify(rec), 'registro em memória'); noLeak(fs.readFileSync(DB_FILE, 'utf8'), 'db.json persistido');
    noLeak(JSON.stringify(w.mgr.describe(rec)), 'describe'); noLeak(JSON.stringify(w.mgr.list()), 'list (/api/state.worktrees)');
    noLeak(await (await fetch(`${base}/api/worktrees/${rec.id}`)).text(), 'GET /api/worktrees/:id'); noLeak(await (await fetch(`${base}/api/worktrees`)).text(), 'GET /api/worktrees');
    // dado legado/gravado sem sanitizar: o describe ainda sanitiza
    rec.prepare = { ...rec.prepare, outputTail: 'x https://u:S3cretPw@h/ y', reason: 'falhou token=XYZSECRET1' }; const d = w.mgr.describe(rec); noLeak(JSON.stringify(d.prepare), 'describe de dado legado'); assert.match(d.prepare.outputTail, /https:\/\/\*\*\*@h\//);
  } finally { srv.close(); }
});

test('V1/V2 — mensagem de spawnError é sanitizada antes de gravar', async () => {
  const w = setup(), rec = await mkWt(w);
  const m2 = W.createWorktreeManager({ db: w.db, root: path.join(tmp, 'wtsE'), prepareSpec: () => ({ command: 'orch-no-such-https://user:SPWD99@host/bin', args: [] }) });
  const d = (await m2.planPrepare(rec.id)).digest, r = await m2.prepare(rec.id, { digest: d }); assert.equal(r.ok, true); const f = await r.finished;
  assert.equal(f.status, 'failed'); assert.match(rec.prepare.reason, /falha ao iniciar o npm/); noLeak(rec.prepare.reason, 'reason do spawnError'); noLeak(f.reason, 'resultado de finished'); noLeak(fs.readFileSync(DB_FILE, 'utf8'), 'db.json'); noLeak(JSON.stringify(m2.describe(rec)), 'describe');
  assert.equal(W.redactSecrets('https://a:b@h/ e http://tok@h2/ _auth=zzz password: abc', ['segredo-literal']), 'https://***@h/ e http://***@h2/ _auth=*** password: ***'); assert.equal(W.redactSecrets('ok segredo-literal', ['segredo-literal']), 'ok ***');
  const once = W.redactSecrets('https://a:b@h/ token=x'); assert.equal(W.redactSecrets(once), once, 'idempotente');
});
