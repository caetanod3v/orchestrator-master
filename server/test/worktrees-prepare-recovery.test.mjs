// Marco E (E3): recuperação de uma preparação (`op.kind === 'prepare'`) interrompida por queda/reinício. Só processos Node inofensivos CRIADOS POR ESTES TESTES; nenhum npm ci, nenhuma rede.
// A identidade de um processo continua sendo a de orphans.js: mesmo PID com hora de criação próxima da registrada. Isso NÃO prova que ele é o npm correto.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prep3-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const store = await import('../store.js');
const W = await import('../worktrees.js');
const { createChildRegistry, CHILD_KEY } = await import('../child-registry.js');
const { installShutdown } = await import('../shutdown.js');
const { createProcTracker } = await import('./proc-identity.mjs');
const { pidAlive } = await import('../instance-lock.js');
store.load(); store.saveOrThrow();
const spawned = createProcTracker();
after(async () => { spawned.cleanup(); await new Promise((r) => setTimeout(r, 700)); fs.rmSync(tmp, { recursive: true, force: true }); });

const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const wr = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const until = async (fn, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
const MANIFEST = { name: 'x', version: '1.0.0', private: true, dependencies: { 'dep-a': '^1.0.0' }, devDependencies: { 'dep-b': '2.0.0' } };
const LOCK = { name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0', dependencies: MANIFEST.dependencies, devDependencies: MANIFEST.devDependencies },
  'node_modules/dep-a': { version: '1.2.0', resolved: 'https://registry.npmjs.org/dep-a/-/dep-a-1.2.0.tgz' }, 'node_modules/dep-b': { version: '2.0.0', resolved: 'https://registry.npmjs.org/dep-b/-/dep-b-2.0.0.tgz', dev: true } } };
const FAKE_NPM = `
const fs = require('fs'), mode = process.env.E3_MODE || 'ok';
const put = (n) => { fs.mkdirSync('node_modules/' + n, { recursive: true }); fs.writeFileSync('node_modules/' + n + '/package.json', '{}'); };
(async () => {
  if (mode === 'sleep') { setInterval(() => {}, 1000); return; }
  if (mode === 'gate') { while (!fs.existsSync(process.env.E3_GATE)) await new Promise((r) => setTimeout(r, 20)); }
  put('dep-a'); put('dep-b');
})();`;
/** Filho "preparador" controlado pelo teste: vivo até ser encerrado; `startedAt` como o registro do servidor. */
function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const startedAt = new Date().toISOString(); spawned.add(child.pid, startedAt);
  return { child, pid: child.pid, startedAt, exited: new Promise((r) => child.on('exit', r)), kill: () => { try { child.kill('SIGKILL'); } catch { /* já encerrado */ } } };
}
const alive = (pid) => spawned.isAlive(pid);
let n = 0;
/** Repositório + worktree "ready" + gerenciador ligado a um child-registry (orphanTools opcionais). `crash()` deixa o registro como uma queda no meio de `prepare` deixaria. */
async function world({ orphanTools = {}, prevState = 'ready' } = {}) {
  const id = ++n, repo = path.join(tmp, `repo${id}`); fs.mkdirSync(repo); G(repo, 'init', '-q', '-b', 'main'); G(repo, 'config', 'core.autocrlf', 'false');
  wr(repo, 'package.json', JSON.stringify(MANIFEST, null, 2)); wr(repo, 'package-lock.json', JSON.stringify(LOCK, null, 2)); wr(repo, '.gitignore', 'node_modules/\n'); G(repo, 'add', '-A'); G(repo, 'commit', '-q', '-m', 'base');
  const ws = { id: `ws${id}`, name: `ws${id}`, path: repo, verifications: [] }, m = { id: `m${id}`, workspaceId: ws.id, tasks: [], cycle: { id: `cy${id}`, status: 'blocked' } };
  const db = { worktrees: [], missions: [m], workspaces: [ws] }, registry = createChildRegistry({ orphanTools });
  const gate = path.join(tmp, `gate${id}`); process.env.E3_GATE = gate;
  const counter = { n: 0 }, spawnProc = (...a) => { counter.n++; return spawn(...a); };
  const mgr = W.createWorktreeManager({ db, root: path.join(tmp, `wts${id}`), track: registry.track, children: registry, spawnProc, prepareSpec: (args) => ({ command: process.execPath, args: ['-e', FAKE_NPM, ...args] }) });
  const rec = (await mgr.create({ mission: m, workspace: ws })).record; mgr.link(rec.id, m.cycle.id); m.cycle.worktreeId = rec.id;
  const digest = (await mgr.planPrepare(rec.id)).digest;
  const approval = { id: 'apr_antiga', digest, approvedAt: 'T0', authorizedBy: 'user', consumedAt: 'T0' };
  const crash = (s, over = {}) => {
    rec.op = { kind: 'prepare', at: 'T0', prevState, digest }; rec.state = prevState;
    rec.prepare = { state: 'running', approval, command: 'npm ci --ignore-scripts --no-audit --no-fund', dependencies: 2, lockfileSha256: 'a'.repeat(64), startedAt: 'T0' };
    store.get()[CHILD_KEY] ??= []; if (s) store.get()[CHILD_KEY].push({ id: store.uid('proc'), kind: 'preparer', pid: s.pid, startedAt: s.startedAt, missionId: m.id, worktreeId: rec.id, ...over }); store.save();
  };
  return { repo, ws, m, db, mgr, rec, registry, digest, approval, crash, counter, gate, ownRecords: () => (store.get()[CHILD_KEY] ?? []).filter((r) => r.worktreeId === rec.id) };
}
const blockedEverywhere = async (w) => {
  const { mgr, rec } = w;
  assert.equal(mgr.workspaceFor(w.m), null, 'o ciclo não usa o worktree'); assert.equal((await mgr.cleanup(rec.id)).ok, false); assert.equal((await mgr.snapshot(rec.id)).ok, false);
  assert.equal((await mgr.prepare(rec.id, { digest: w.digest })).ok, false); assert.equal((await mgr.ensureFor(w.m, w.ws)).record?.id === rec.id, false, 'não reaproveitado'); assert.equal(fs.existsSync(rec.path), true);
};

test('E3 — processo COMPROVADAMENTE encerrado: "interrupted", op limpa, aprovação preservada e NUNCA reutilizada; nada é executado sozinho', async () => {
  const w = await world(), s = sleeper(); s.kill(); await s.exited; w.crash(s);
  w.registry.reclaim({}); assert.equal(w.registry.lastOutcome(w.rec.id), 'gone'); assert.equal(w.ownRecords().length, 0);
  const snapNm = fs.existsSync(path.join(w.rec.path, 'node_modules'));
  const out = await w.mgr.recover(); const r = w.rec;
  assert.deepEqual(out.unverified, []); assert.deepEqual([r.prepare.state, r.op, r.state], ['interrupted', null, 'ready']); assert.match(r.prepare.reason, /reiniciado durante a preparação.*já não existia.*não será reutilizada/); assert.ok(r.prepare.finishedAt);
  assert.deepEqual(r.prepare.approval, w.approval, 'a aprovação consumida continua registrada'); assert.ok(r.history.some((h) => h.event === 'prepare_interrupted')); assert.equal(r.diagnostic ?? null, null);
  assert.equal(w.counter.n, 0, 'recuperar nunca executa nada'); assert.equal(fs.existsSync(path.join(r.path, 'node_modules')), snapNm, 'nada foi apagado nem criado');
  assert.equal(w.mgr.environmentFor(r.id).ok, false, 'sem verificação independente não vira "pronto"');
  assert.equal(JSON.stringify((await w.mgr.recover()).settled), '[]', 'repetir não muda nada'); const v = await w.mgr.revalidate(r.id); assert.equal(v.ok, true); assert.equal(r.prepare.state, 'interrupted');
  // só uma NOVA chamada explícita executa, com uma NOVA aprovação (a antiga não é reaproveitada)
  process.env.E3_MODE = 'ok'; const nova = await w.mgr.prepare(r.id, { digest: w.digest }); assert.equal(nova.ok, true); const f = await nova.finished; assert.equal(f.status, 'ready');
  assert.notEqual(r.prepare.approval.id, 'apr_antiga'); assert.equal(w.counter.n, 1);
});

test('E3 — preparador VIVO com identidade confirmada é encerrado pelo reclaim do boot; só então o worktree é conciliado como "interrupted"', async () => {
  const w = await world(), s = sleeper(); w.crash(s);
  const early = await w.mgr.recover(); assert.equal(early.unverified.length, 1, 'ANTES do reclaim nada é liberado (ordem do boot)'); assert.equal(w.rec.op.kind, 'prepare'); assert.equal(w.rec.diagnostic.code, 'preparation_inconclusive'); assert.equal(alive(s.pid), true); await blockedEverywhere(w);
  const res = w.registry.reclaim({}); assert.equal(res.length, 1); assert.deepEqual([res[0].outcome, res[0].kind, res[0].worktreeId, res[0].missionId], ['killed', 'preparer', w.rec.id, w.m.id]); assert.ok(res[0].recordId);
  await s.exited; assert.equal(alive(s.pid), false); assert.equal(w.registry.lastOutcome(w.rec.id), 'killed');
  const out = await w.mgr.recover(); assert.deepEqual(out.unverified, []); assert.deepEqual([w.rec.prepare.state, w.rec.op], ['interrupted', null]); assert.match(w.rec.prepare.reason, /encerrado no boot/); assert.equal(w.rec.diagnostic, null);
});

test('E3 — identidade NÃO confirmada (unverified) ou kill_failed: o processo não é tocado e o worktree permanece BLOQUEADO; liberar só quando o processo terminar', async () => {
  for (const [name, tools, expected] of [['unverified', { startedAtOf: () => null }, 'unverified'], ['kill_failed', { kill: () => {} }, 'kill_failed']]) {
    const w = await world({ orphanTools: tools }), s = sleeper(); w.crash(s);
    const res = w.registry.reclaim({}); assert.equal(res[0].outcome, expected, name); assert.equal(alive(s.pid), true, 'não foi encerrado');
    const out = await w.mgr.recover(); assert.equal(out.unverified.length, 1, name); assert.equal(w.rec.op.kind, 'prepare'); assert.equal(w.rec.prepare.state, 'running'); assert.equal(w.rec.diagnostic.code, 'preparation_inconclusive'); assert.match(w.rec.diagnostic.reason, new RegExp(`PID ${s.pid}`));
    await blockedEverywhere(w);
    const v = await w.mgr.revalidate(w.rec.id); assert.equal(v.inconclusive, true); assert.equal(v.blocked.code, 'preparation_inconclusive'); assert.equal(v.prepareInterrupted, undefined); assert.equal(w.rec.op.kind, 'prepare', 'revalidar não libera por dúvida'); assert.equal(w.ownRecords().length, 1);
    // o processo termina de verdade: agora a revalidação libera (e só então)
    s.kill(); await s.exited; const ok = await w.mgr.revalidate(w.rec.id); assert.equal(ok.ok, true); assert.equal(ok.prepareInterrupted, true); assert.deepEqual([w.rec.prepare.state, w.rec.op], ['interrupted', null]); assert.equal(w.ownRecords().length, 0);
  }
});

test('E3 — PID REUTILIZADO por outro processo: o processo alheio NÃO é encerrado e a preparação é marcada interrompida (seguro liberar)', async () => {
  const w = await world(), alheio = sleeper(); w.crash(alheio, { startedAt: new Date(Date.now() - 3_600_000).toISOString() }); // o registro diz que o preparador nasceu há 1 h; o PID vivo é outro
  const res = w.registry.reclaim({}); assert.equal(res[0].outcome, 'reused'); assert.equal(alive(alheio.pid), true, 'o processo alheio continua vivo');
  const out = await w.mgr.recover(); assert.deepEqual(out.unverified, []); assert.deepEqual([w.rec.prepare.state, w.rec.op], ['interrupted', null]); assert.match(w.rec.prepare.reason, /outro processo, que não foi tocado/); assert.equal(alive(alheio.pid), true); assert.equal(w.ownRecords().length, 0);
  alheio.kill(); await alheio.exited;
});

test('E3 — `prepare` persistido SEM registro `preparer` e sem marca de PID gravado: NÃO é liberado (o npm pode ter sido iniciado antes de o PID ser gravado); fica bloqueado com preparation_inconclusive', async () => {
  const w = await world({ prevState: 'finished' }); w.crash(null); w.registry.reclaim({}); const nm = fs.existsSync(path.join(w.rec.path, 'node_modules'));
  for (let i = 0; i < 2; i++) { // repetir (outro boot / revalidar) nunca muda o veredito
    const out = await w.mgr.recover(); assert.equal(out.unverified.length, 1); assert.deepEqual(out.settled, []);
    assert.equal(w.rec.op.kind, 'prepare'); assert.equal(w.rec.prepare.state, 'running'); assert.equal(w.rec.state, 'finished'); assert.equal(w.rec.diagnostic.code, 'preparation_inconclusive'); assert.match(w.rec.diagnostic.reason, /gravar o PID.*não é possível provar/);
    const v = await w.mgr.revalidate(w.rec.id); assert.equal(v.inconclusive, true); assert.equal(v.blocked.code, 'preparation_inconclusive'); assert.equal(v.prepareInterrupted, undefined); assert.equal(w.rec.op.kind, 'prepare');
  }
  assert.deepEqual(w.rec.prepare.approval, w.approval, 'aprovação preservada'); assert.equal(w.counter.n, 0); assert.equal(fs.existsSync(path.join(w.rec.path, 'node_modules')), nm); await blockedEverywhere(w);
});

test('E3 — queda ENTRE o spawn e o registro do PID: o npm segue vivo sem nenhum registro; nada é encerrado, nada é liberado (nem depois de ele terminar, pois nada prova a identidade)', async () => {
  const w = await world(), s = sleeper(); w.crash(null); // op gravada; o processo existe, mas o PID nunca chegou ao child-registry nem a r.prepare.process
  assert.equal(w.registry.reclaim({}).length, 0, 'o reclaim não tem o que conferir');
  const out = await w.mgr.recover(); assert.equal(out.unverified.length, 1); assert.equal(w.rec.diagnostic.code, 'preparation_inconclusive'); assert.equal(alive(s.pid), true, 'nenhum processo foi tocado'); await blockedEverywhere(w);
  s.kill(); await s.exited; const again = await w.mgr.revalidate(w.rec.id); assert.equal(again.inconclusive, true); assert.equal(w.rec.op.kind, 'prepare', 'sem evidência persistida, continua bloqueado'); await blockedEverywhere(w); assert.equal(w.counter.n, 0);
});

test('E3 — com a marca de PID gravado no próprio registro e o registro do child-registry já resolvido (gone/killed/reused numa conciliação anterior): há evidência suficiente e o worktree é liberado como interrompido', async () => {
  const w = await world({ prevState: 'finished' }); w.crash(null); w.rec.prepare.process = { pid: 424242, recordedAt: 'T0' }; w.registry.reclaim({});
  const out = await w.mgr.recover(); assert.deepEqual(out.unverified, []); assert.deepEqual([w.rec.prepare.state, w.rec.state, w.rec.op], ['interrupted', 'finished', null]); assert.match(w.rec.prepare.reason, /sem registro de processo/); assert.deepEqual(w.rec.prepare.approval, w.approval); assert.deepEqual(w.rec.prepare.process, { pid: 424242, recordedAt: 'T0' });
  // mas se o registro do child-registry ainda aponta um processo vivo (identidade incerta), a marca NÃO basta: continua bloqueado
  const w3 = await world({ orphanTools: { startedAtOf: () => null } }), s3 = sleeper(); w3.crash(s3); w3.rec.prepare.process = { pid: s3.pid, recordedAt: 'T0' }; w3.registry.reclaim({});
  const o3 = await w3.mgr.recover(); assert.equal(o3.unverified.length, 1); assert.equal(w3.rec.op.kind, 'prepare'); s3.kill(); await s3.exited;
});

test('E3 — prepare() grava no registro do worktree a marca de que o PID foi registrado (evidência para a recuperação)', async () => {
  const w = await world(); fs.rmSync(w.gate, { force: true }); process.env.E3_MODE = 'gate';
  assert.equal(w.rec.prepare, undefined); const run = await w.mgr.prepare(w.rec.id, { digest: w.digest }); assert.equal(run.ok, true);
  const [reg] = w.ownRecords(); assert.ok(reg); assert.equal(w.rec.prepare.process.pid, reg.pid); assert.ok(w.rec.prepare.process.recordedAt);
  fs.writeFileSync(w.gate, 'go'); assert.equal((await run.finished).status, 'ready'); assert.equal(w.rec.prepare.process.pid, reg.pid, 'a marca permanece no resultado');
});

test('E3 — revalidate NUNCA declara sucesso com a preparação em andamento neste servidor ou sem o reclaim feito', async () => {
  const w = await world(); fs.rmSync(w.gate, { force: true }); process.env.E3_MODE = 'gate';
  const run = await w.mgr.prepare(w.rec.id, { digest: w.digest }); assert.equal(run.ok, true); assert.equal(w.ownRecords().length, 1);
  const v = await w.mgr.revalidate(w.rec.id); assert.equal(v.inconclusive, true); assert.equal(v.blocked.code, 'preparation_in_progress'); assert.equal(w.rec.op.kind, 'prepare'); assert.equal(w.rec.prepare.state, 'running'); assert.equal(w.counter.n, 1);
  const rc = await w.mgr.recover(); assert.equal(rc.unverified.length, 1, 'recover durante a execução também não libera'); assert.equal(w.rec.op.kind, 'prepare');
  fs.writeFileSync(w.gate, 'go'); assert.equal((await run.finished).status, 'ready'); assert.equal(w.ownRecords().length, 0);
  // gerenciador SEM child-registry (ou sem reclaim) não consegue provar nada
  const w2 = await world(); w2.crash(null); const bare = W.createWorktreeManager({ db: w2.db, root: path.join(tmp, 'wtsB') });
  const b = await bare.revalidate(w2.rec.id); assert.equal(b.inconclusive, true); assert.equal(b.blocked.code, 'preparation_inconclusive'); assert.equal(w2.rec.op.kind, 'prepare');
});

test('E3 — ordem do boot: o reclaim dos processos filhos vem ANTES da conciliação dos worktrees, e o gerenciador recebe o child-registry', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const iReclaim = src.indexOf('childRegistry.reclaim('), iRecover = src.indexOf('worktrees.recover()'), iCycle = src.indexOf('setupCycle(app');
  assert.ok(iReclaim > 0 && iRecover > iReclaim, 'reclaim antes de recover'); assert.ok(iRecover < iCycle, 'recover antes do ciclo ser montado'); assert.equal(src.split('worktrees.recover()').length - 1, 1);
  assert.match(src, /createWorktreeManager\(\{ db, track: childRegistry\.track, children: childRegistry \}\)/); assert.match(src, /worktreeRecovery = await worktrees\.recover\(\)/);
  assert.match(src, /installShutdown\(\{[^}]*children: \[planner, verifier, \{ killActiveSync: \(\) => worktrees\.killActiveSync\(\) \}(, \{ killActiveSync: \(\) => terminals\.killAllSync\(\) \})?\]/); // os terminais interativos também são encerrados no desligamento
});

test('E3 — encerramento normal do servidor encerra o preparador (e libera o registro); sem preparação em curso nada acontece', async () => {
  const w = await world(); w.mgr.killActiveSync(); // sem preparação: não faz nada
  process.env.E3_MODE = 'sleep'; const run = await w.mgr.prepare(w.rec.id, { digest: w.digest }); assert.equal(run.ok, true);
  const [reg] = w.ownRecords(); assert.ok(reg); assert.equal(reg.kind, 'preparer'); assert.equal(pidAlive(reg.pid), true);
  const proc = new EventEmitter(); let exited = null; installShutdown({ lock: null, executor: null, store: null, children: [{ killActiveSync: () => w.mgr.killActiveSync() }], proc, exit: (c) => { exited = c; } });
  proc.emit('exit', 0);
  assert.equal(await until(() => !pidAlive(reg.pid)), true, 'o npm (aqui, um processo inofensivo) foi encerrado'); assert.equal(w.ownRecords().length, 0, 'registro apagado só depois de o processo sumir'); void exited;
  const f = await run.finished; assert.equal(f.status, 'failed'); assert.equal(w.rec.op, null); assert.equal(w.mgr.environmentFor(w.rec.id).ok, false);
});
