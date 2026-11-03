// Marco C — o ciclo real (executor = CLI falsa; Planner e verificador SIMULADOS) executando em worktrees isolados, e a regressão do comportamento sem isolamento.
// Repositórios, banco e workspace TEMPORÁRIOS; nenhum modelo, nenhuma missão real.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wtc-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const W = await import('../worktrees.js');

const db = store.load(); db.missions = []; db.workspaces = []; store.saveOrThrow();
const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
const mgr = W.createWorktreeManager({ db, root: path.join(tmp, 'wts') });
const { startTaskRun } = setupExecution(express(), { db, executor, workspaceOf: (m) => mgr.workspaceFor(m) });
after(async () => { await new Promise((r) => setTimeout(r, 300)); fs.rmSync(tmp, { recursive: true, force: true }); });

const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
let seq = 0, verPaths = [];
function repo({ git = true } = {}) {
  const dir = path.join(tmp, `r${++seq}`); fs.mkdirSync(dir);
  if (git) { G(dir, 'init', '-q', '-b', 'main'); G(dir, 'config', 'core.autocrlf', 'false'); fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n'); G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', 'base'); }
  const ws = { id: `ws${seq}`, name: `ws${seq}`, path: dir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] };
  db.workspaces.push(ws); const m = { id: `m${seq}`, demo: false, title: `M${seq}`, objective: 'obj', workspaceId: ws.id, createdAt: 'T0', tasks: [] }; db.missions.push(m);
  return { dir, ws, m, status: () => (git ? G(dir, 'status', '--porcelain', '-uall') : ''), head: () => G(dir, 'rev-parse', 'HEAD') };
}
const J = (o) => JSON.stringify(o);
const planner = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, describeTier: () => null, decide: async ({ prompt }) => { calls.push(prompt); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x, usage: { costUsd: 0.01, turns: 1 } }; } }; };
const step = (id, file, mode = 'produce') => ({ id, title: `Etapa ${id}`, instructions: `MODE:${mode} FILE:${file} ${id}`, acceptance: [`${file} existe e foi gerado nesta etapa`], expectedFiles: [file], dependsOn: [] });
const planAns = (...steps) => J({ decision: 'plan', rationale: 'dividir', steps });
const done = () => J({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blockedAns = () => J({ decision: 'blocked', rationale: 'ajuda', blockedReason: 'decisão humana' });
const cont = (title, instructions) => J({ decision: 'continue', rationale: title, task: { title, instructions, acceptance: ['o resultado existe'] } });
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }), run: async (w, item) => { verPaths.push(w.path); return { id: item.id, script: item.script, required: !!item.required, command: `npm run ${item.script}`, source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null }; } });
const mkCycle = (pl, { isolation = true, manager = mgr } = {}) => createCycle({ db, executor, planner: pl, startTaskRun, verifier: verifier(), listFiles: () => [], multiStep: true, stepRetries: 0, worktrees: manager, worktreeIsolation: isolation, persistRetryMs: [1] });
async function run(r, answers, opts = {}) {
  verPaths = []; const pl = planner(answers), cy = mkCycle(pl, opts); const res = await cy.start(r.m.id, 6); await cy.idle();
  return { res, c: r.m.cycle, pl, cy, rec: r.m.cycle?.worktreeId ? mgr.get(r.m.cycle.worktreeId) : null };
}

test('com isolamento: o ciclo roda NO worktree (arquivo, verificação e cwd), o principal não muda; depois snapshot -> checagem -> integração autorizada -> limpeza', async () => {
  const r = repo(), head = r.head();
  const x = await run(r, [planAns(step('a', 'a.txt')), done()]);
  assert.equal(x.res.status, 202); assert.equal(x.c.status, 'completed', `${x.c.blockedCode}: ${x.c.blockedReason}`); assert.equal(x.c.assurance, 'verified'); assert.ok(x.rec, 'ciclo ligado a um worktree');
  assert.equal(x.rec.cycleId, x.c.id); assert.equal(x.rec.missionId, r.m.id); assert.equal(x.rec.state, 'finished'); assert.equal(x.rec.baseCommit, head); assert.equal(x.rec.current, null);
  assert.equal(fs.existsSync(path.join(x.rec.path, 'a.txt')), true, 'o Executor escreveu no worktree'); assert.equal(fs.existsSync(path.join(r.dir, 'a.txt')), false, 'e NÃO no workspace principal');
  assert.equal(r.status(), ''); assert.equal(r.head(), head); assert.equal(G(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.deepEqual([...new Set(verPaths)], [x.rec.path], 'a verificação real também rodou no worktree');
  assert.deepEqual(x.rec.rounds.map((q) => [q.n, q.status, q.level]), [[1, 'succeeded', 'verified']]); assert.ok(x.rec.rounds[0].tree, 'árvore Git do conteúdo verificado');
  assert.ok(x.rec.history.some((h) => h.event === 'execution_started') && x.rec.history.some((h) => h.event === 'execution_finished') && x.rec.history.some((h) => h.event === 'linked'));
  // nada integra sozinho: o ciclo terminou e o principal segue intacto
  const unc = await mgr.check(x.rec.id); assert.ok(unc.attempt.problems.some((p) => p.code === 'uncommitted_changes'), 'precisa de snapshot explícito');
  assert.equal((await mgr.snapshot(x.rec.id)).ok, true); const chk = await mgr.check(x.rec.id); assert.equal(chk.attempt.result, 'mergeable', JSON.stringify(chk.attempt.problems)); assert.equal(chk.attempt.evidence.match, true);
  assert.equal(r.head(), head, 'checagem não altera o destino');
  const i = await mgr.integrate(x.rec.id, { digest: chk.attempt.digest }); assert.equal(i.ok, true, i.error); assert.equal(fs.existsSync(path.join(r.dir, 'a.txt')), true); assert.equal(r.status(), '');
  assert.equal((await mgr.cleanup(x.rec.id)).ok, true); assert.equal(fs.existsSync(x.rec.path), false);
});

test('SEM isolamento (padrão): comportamento de sempre — roda no workspace principal e nada de worktree é criado nem gravado no ciclo', async () => {
  const r = repo(), before = db.worktrees.length;
  const x = await run(r, [planAns(step('a', 'a.txt')), done()], { isolation: false });
  assert.equal(x.c.status, 'completed'); assert.equal(fs.existsSync(path.join(r.dir, 'a.txt')), true); assert.equal(x.rec, null); assert.equal('worktreeId' in x.c, false); assert.equal(db.worktrees.length, before);
  assert.deepEqual([...new Set(verPaths)], [r.dir]);
  const noMgr = repo(), y = await (async () => { const pl = planner([planAns(step('a', 'a.txt')), done()]), cy = createCycle({ db, executor, planner: pl, startTaskRun, verifier: verifier(), listFiles: () => [], multiStep: true }); await cy.start(noMgr.m.id, 6); await cy.idle(); return noMgr.m.cycle; })();
  assert.equal(y.status, 'completed', 'sem o gerenciador (createCycle antigo) tudo continua igual');
});

test('isolamento ligado mas o worktree NÃO pode ser criado: o ciclo nem começa e nada roda no workspace principal', async () => {
  const r = repo({ git: false }); const before = db.worktrees.length, starts = db.activity.length;
  const x = await run(r, [planAns(step('a', 'a.txt')), done()]);
  assert.equal(x.res.status, 409); assert.match(x.res.error, /Worktree não criado.*Nada foi iniciado/); assert.equal(r.m.cycle, undefined); assert.equal(x.pl.calls.length, 0); assert.equal(fs.existsSync(path.join(r.dir, 'a.txt')), false); assert.equal(db.worktrees.length, before);
  assert.ok(db.activity.length >= starts);
  const off = W.createWorktreeManager({ db }); const z = repo(); const pl = planner([]), cy = createCycle({ db, executor, planner: pl, startTaskRun, verifier: verifier(), listFiles: () => [], multiStep: true, worktrees: null, worktreeIsolation: true });
  assert.equal((await cy.start(z.m.id, 6)).status, 409, 'isolamento ligado sem gerenciador: recusa'); assert.equal(z.m.cycle, undefined); assert.ok(off);
});

test('o worktree sumiu depois de o ciclo bloquear: a retomada é RECUSADA (nunca cai no workspace principal) e volta a funcionar quando o ambiente volta', async () => {
  const r = repo(), x = await run(r, [blockedAns()]); assert.equal(x.c.blockedCode, 'planner_blocked'); assert.ok(x.rec);
  fs.renameSync(x.rec.path, `${x.rec.path}.fora`);
  const cy = mkCycle(planner([blockedAns()])), bad = await cy.resume(r.m.id); assert.equal(bad.status, 409); assert.match(bad.error, /Workspace inválido/); assert.equal(r.m.cycle.status, 'blocked');
  fs.renameSync(`${x.rec.path}.fora`, x.rec.path); const ok = await cy.resume(r.m.id); assert.equal(ok.status, 202); await cy.idle(); assert.equal(r.status(), '');
});

test('o ambiente isolado respeita a política: uma ação que aponta para o workspace PRINCIPAL (fora do worktree) é negada e nada é executado', async () => {
  const r = repo(), target = `${r.dir.replace(/\\/g, '/')}/invasor.txt`;
  const x = await run(r, [cont('Mexer no principal', `Edite ${target}`), blockedAns()]);
  assert.equal(x.c.rounds[0].policy.outcome, 'denied'); assert.ok(x.c.rounds[0].policy.rules.includes('outside_workspace'), JSON.stringify(x.c.rounds[0].policy)); assert.equal(x.c.rounds[0].taskId, null, 'nada foi executado');
  assert.equal(fs.existsSync(path.join(r.dir, 'invasor.txt')), false); assert.equal(r.status(), '');
});

test('evidência insuficiente no worktree (arquivo esperado não produzido): o ciclo não conclui e a integração é recusada', async () => {
  const r = repo(), x = await run(r, [planAns(step('a', 'a.txt', 'nofile')), blockedAns()]);
  assert.notEqual(x.c.status, 'completed'); const c = await mgr.check(x.rec.id);
  assert.notEqual(c.attempt.result, 'mergeable'); assert.ok(c.attempt.problems.some((p) => ['evidence_missing', 'cycle_not_verified'].includes(p.code)), JSON.stringify(c.attempt.problems));
  const i = await mgr.integrate(x.rec.id, { digest: 'a'.repeat(32) }); assert.equal(i.ok, false); assert.equal(r.status(), '');
});

test('reinício no meio da execução: o registro é conciliado (execução interrompida, evidência invalidada) e nenhum ciclo é relançado', async () => {
  const r = repo(), x = await run(r, [planAns(step('a', 'a.txt')), done()]); assert.equal(x.c.status, 'completed');
  x.rec.state = 'in_use'; x.rec.current = { round: 2, taskId: 'tx', at: 'T' }; // queda durante uma 2ª rodada
  const m2 = W.createWorktreeManager({ db, root: path.join(tmp, 'wts') }), out = await m2.recover();
  assert.deepEqual(out.settled.find((s) => s.id === x.rec.id), { id: x.rec.id, from: 'in_use', to: 'finished' }); assert.equal(x.rec.rounds.at(-1).level, 'interrupted'); assert.equal(x.c.status, 'completed', 'o ciclo não foi tocado');
  await m2.snapshot(x.rec.id); const c = await m2.check(x.rec.id); assert.notEqual(c.attempt.result, 'mergeable', 'a última rodada é a interrompida: sem evidência válida');
});

test('ciclo CANCELADO no meio da execução: o worktree não fica "em uso" para sempre — vira rodada interrompida (sem evidência), não integra e, sem trabalho, pode ser limpo', async () => {
  const r = repo(), pl = planner([planAns(step('a', 'a.txt', 'sleep')), done()]), cy = mkCycle(pl); verPaths = [];
  assert.equal((await cy.start(r.m.id, 6)).status, 202);
  const t0 = Date.now(); while (!(r.m.cycle?.worktreeId && mgr.get(r.m.cycle.worktreeId)?.state === 'in_use') && Date.now() - t0 < 15000) await new Promise((q) => setTimeout(q, 25));
  const rec = mgr.get(r.m.cycle.worktreeId); assert.equal(rec.state, 'in_use'); assert.equal(rec.current.round, 1);
  assert.equal((await mgr.cleanup(rec.id)).status, 409, 'em uso: nada é removido');
  assert.equal((await cy.cancel(r.m.id)).status, 200); await cy.idle();
  assert.equal(r.m.cycle.status, 'cancelled'); assert.equal(rec.state, 'finished'); assert.equal(rec.current, null); assert.deepEqual([rec.rounds.at(-1).status, rec.rounds.at(-1).level, rec.rounds.at(-1).tree], ['interrupted', 'interrupted', null]);
  assert.ok(rec.history.some((h) => h.event === 'execution_released' && h.reason === 'cancelled'));
  const c = await mgr.check(rec.id); assert.notEqual(c.attempt.result, 'mergeable'); assert.ok(c.attempt.problems.some((p) => p.code === 'evidence_missing'));
  assert.equal(r.status(), ''); assert.equal((await mgr.cleanup(rec.id)).ok, true, 'sem trabalho a perder: limpeza explícita funciona'); assert.equal(fs.existsSync(rec.path), false);
});
