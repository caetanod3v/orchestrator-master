// Marco A, I1: observabilidade aditiva. (1) o relatório de entrega traz `attempts` por etapa e `retriesUsed`, DERIVADOS das rodadas gravadas; (2) /api/state.orchestration (boot real).
// Puro (sem banco) + servidores REAIS como processos filhos SEMPRE com ORCH_DATA_DIR temporário e porta livre. Nenhum modelo é chamado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.ORCH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-deliv-orch-')); // import de delivery.js -> cycle.js -> store.js: nunca os dados reais
const { buildDelivery } = await import('../delivery.js');
const { MAX_STEP_ATTEMPTS } = await import('../plan.js');
const { HARD_MAX_ITERATIONS } = await import('../cycle.js');

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-state-boot-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(process.env.ORCH_DATA_DIR, { recursive: true, force: true }); });

// ---------- fixtures ----------
const REAL_PASS = { id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null };
const EV = (level) => ({ level, basis: level === 'verified' ? 'real_verification' : 'executor_claim_only', reasons: level === 'verified' ? [] : ['motivo gravado'], executorClaim: { status: 'success', pass: 1, fail: 0, notRun: 0, note: 'x' }, system: { verification: level === 'verified' ? 'passed' : 'failed', verifications: [], expectedFiles: null, integrity: 'clean' } });
const rep = (level) => ({ status: 'success', summary: 's', filesChanged: [], filesKnown: true, checks: [], checksReported: true, errors: [], blockers: [], exitCode: 0, usage: null, verifications: [level === 'verified' ? REAL_PASS : { ...REAL_PASS, status: 'fail' }], verificationsSkipped: null, verificationsInterrupted: null, evidence: EV(level) });
const rnd = (n, planId, stepId, level = 'verified') => ({ n, status: 'succeeded', phase: 'done', taskId: `t${n}`, agent: 'code', ...(planId ? { planId, stepId } : {}), plan: { title: `Rodada ${n}`, rationale: 'r' }, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', report: rep(level), verification: level === 'verified' ? 'passed' : 'failed', decision: null });
const stp = (id, deps = []) => ({ id, title: `Etapa ${id}`, dependsOn: deps });
const cyc = (status, rounds, plan, over = {}) => ({ id: 'cy1', status, maxIterations: 8, rounds, plannerCalls: 1, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null, finalSummary: null, evidence: null, startedAt: 'A', finishedAt: status === 'completed' ? 'B' : null, ...(plan ? { plan } : {}), ...over });
const mis = (cycle, over = {}) => ({ id: 'mx', demo: false, title: 'Missão X', objective: 'obj', workspaceId: 'w', createdAt: 'T0', tasks: [], cycle, ...over });
const report = (cycle, over) => buildDelivery(mis(cycle, over), null);
const att = (r) => Object.fromEntries(r.observed.steps.map((s) => [s.id, s.attempts]));

// ---------- relatório de entrega ----------
test('etapa com UMA tentativa: attempts 1 e retriesUsed 0', () => {
  const r = report(cyc('completed', [rnd(1, 'pl', 'a')], { id: 'pl', steps: [stp('a')] }));
  assert.deepEqual(att(r), { a: 1 }); assert.equal(r.observed.retriesUsed, 0);
});

test('etapa com MÚLTIPLAS tentativas: 3 tentativas = 2 retentativas; o estado vem da última e cada tentativa conta uma vez', () => {
  const r = report(cyc('completed', [rnd(1, 'pl', 'a', 'failed'), rnd(2, 'pl', 'a', 'failed'), rnd(3, 'pl', 'a')], { id: 'pl', steps: [stp('a')] }));
  assert.deepEqual(att(r), { a: 3 }); assert.equal(r.observed.retriesUsed, 2); assert.equal(r.observed.steps[0].status, 'completed'); assert.equal(r.observed.steps[0].round, 3);
  assert.equal(r.observed.rounds.length, 3, 'a lista de rodadas continua com todas, uma vez cada'); assert.equal(MAX_STEP_ATTEMPTS, 3);
});

test('várias etapas: sem contagem cruzada; etapa nunca executada tem 0 tentativas', () => {
  const r = report(cyc('blocked', [rnd(1, 'pl', 'a'), rnd(2, 'pl', 'b', 'failed'), rnd(3, 'pl', 'b', 'failed')], { id: 'pl', steps: [stp('a'), stp('b', ['a']), stp('c', ['b'])] }));
  assert.deepEqual(att(r), { a: 1, b: 2, c: 0 }); assert.equal(r.observed.retriesUsed, 1);
  assert.equal(r.observed.steps.find((s) => s.id === 'c').executedByRound, false);
});

test('planos diferentes no mesmo ciclo: attempts é do plano ATUAL; retriesUsed soma TODOS os planos do ciclo, sem misturar etapas de mesmo id', () => {
  const rounds = [rnd(1, 'p1', 'a', 'failed'), rnd(2, 'p1', 'a', 'failed'), rnd(3, 'p2', 'a', 'failed'), rnd(4, 'p2', 'b')];
  const r = report(cyc('completed', rounds, { id: 'p2', steps: [stp('a'), stp('b')] }));
  assert.deepEqual(att(r), { a: 1, b: 1 }, 'as rodadas do plano antigo não entram nas tentativas do plano atual'); assert.equal(r.observed.retriesUsed, 1, 'a retentativa do plano antigo continua gasta no ciclo');
});

test('ciclo ANTIGO (uma rodada por etapa, sem nada de retentativa) e histórico incompleto: regra explícita, nada inventado', () => {
  const old = report(cyc('completed', [rnd(1, 'pl', 'a'), rnd(2, 'pl', 'b')], { id: 'pl', steps: [stp('a'), stp('b')] }));
  assert.deepEqual(att(old), { a: 1, b: 1 }); assert.equal(old.observed.retriesUsed, 0);
  const avulso = report(cyc('completed', [rnd(1), rnd(2)])); assert.deepEqual(avulso.observed.steps, [], 'sem plano não há etapas'); assert.equal(avulso.observed.retriesUsed, 0, 'rodadas avulsas (sem planId/stepId) nunca contam como tentativas');
  const semRound = report(cyc('blocked', [{ n: 1, status: 'succeeded' }, null, 'lixo', { n: 2, planId: 'pl' }], { id: 'pl', steps: [stp('a')] }));
  assert.deepEqual(att(semRound), { a: 0 }); assert.equal(semRound.observed.retriesUsed, 0);
  const semCiclo = buildDelivery(mis(undefined), null); assert.equal(semCiclo.observed.retriesUsed, 0);
  const arquivado = report(cyc('completed', [rnd(1, 'pl', 'a')], { id: 'pl', steps: [stp('a')] }), { pastCycles: [cyc('completed', [rnd(1, 'pl', 'a', 'failed'), rnd(2, 'pl', 'a')], { id: 'pl', steps: [stp('a')] })] });
  assert.equal(arquivado.observed.retriesUsed, 0, 'ciclos arquivados não se misturam com o atual'); assert.deepEqual(att(arquivado), { a: 1 });
});

test('o relatório continua derivado e SEM campos persistidos novos: a entrada não é alterada e o resultado só acrescenta attempts/retriesUsed', () => {
  const rounds = [rnd(1, 'pl', 'a', 'failed'), rnd(2, 'pl', 'a')], cycle = cyc('completed', rounds, { id: 'pl', steps: [stp('a')] }), m = mis(cycle);
  const before = JSON.stringify(m); const r = buildDelivery(m, null); assert.equal(JSON.stringify(m), before, 'nada foi gravado na missão nem no ciclo');
  assert.deepEqual(Object.keys(r.observed.steps[0]).sort(), ['attempts', 'dependsOn', 'executedByRound', 'id', 'round', 'status', 'title', 'uncertain'], 'só um campo novo por etapa');
  assert.ok(Object.keys(r.observed).includes('retriesUsed')); assert.equal('attempts' in m.cycle.plan.steps[0], false);
  // resultado de verificação, evidência e garantia não mudam com as tentativas: dependem só da ÚLTIMA rodada
  assert.equal(r.assurance.level, 'verified'); assert.equal(r.observed.steps[0].status, 'completed');
  const f = report(cyc('completed', [rnd(1, 'pl', 'a'), rnd(2, 'pl', 'a', 'failed')], { id: 'pl', steps: [stp('a')] })); assert.notEqual(f.assurance.level, 'verified', 'última tentativa falha: nunca verified');
});

// ---------- /api/state ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let n = 0;
async function stateWith(extra) {
  const dir = path.join(root, `d${++n}`); fs.mkdirSync(dir); assert.ok(dir.startsWith(os.tmpdir()));
  const port = await freePort(), env = { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir };
  for (const k of ['ORCH_PLANNER_ROUTING', 'ORCH_PLANNER_MODEL', 'ORCH_PLANNER_EFFORT', 'ORCH_CYCLE_MAX_PLANNER_CALLS', 'ORCH_CYCLE_MAX_ESTIMATED_COST_USD', 'ORCH_CYCLE_PLAN', 'ORCH_CYCLE_MAX_STEP_RETRIES']) delete env[k];
  const child = spawn(process.execPath, [INDEX], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (let i = 0; i < 80 && !/AI Dev Orchestrator API em/.test(out); i++) await Promise.race([new Promise((r) => setTimeout(r, 100)), exited]);
    assert.match(out, /AI Dev Orchestrator API em/, `não subiu: ${out}`);
    const res = await fetch(`http://127.0.0.1:${port}/api/state`); assert.equal(res.status, 200); return await res.json();
  } finally { child.kill(); await exited; }
}

test('/api/state.orchestration: padrão = plano e retentativas DESLIGADOS, com os limites estruturais reais; campos antigos preservados', async () => {
  const s = await stateWith({});
  assert.deepEqual(s.orchestration, { planMode: false, stepRetries: 0, maxStepAttempts: MAX_STEP_ATTEMPTS, hardMaxIterations: HARD_MAX_ITERATIONS, source: { planMode: 'default', stepRetries: 'default' } });
  assert.equal(s.orchestration.maxStepAttempts, 3); assert.equal(s.orchestration.hardMaxIterations, 10); assert.equal(s.settings.cycleHardMax, s.orchestration.hardMaxIterations, 'mesma fonte do campo antigo');
  for (const k of ['system', 'executor', 'planner', 'counts', 'persistence', 'persistenceIncident', 'settings', 'activeWorkspace', 'usage']) assert.ok(k in s, `campo antigo ${k} preservado`);
});

test('/api/state.orchestration: com ORCH_CYCLE_PLAN=on e ORCH_CYCLE_MAX_STEP_RETRIES=2 reflete os valores REAIS do servidor; off e 0 continuam desligados', async () => {
  const on = await stateWith({ ORCH_CYCLE_PLAN: 'on', ORCH_CYCLE_MAX_STEP_RETRIES: '2' });
  assert.deepEqual(on.orchestration, { planMode: true, stepRetries: 2, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'env', stepRetries: 'env' } });
  assert.deepEqual((await stateWith({ ORCH_CYCLE_PLAN: 'on', ORCH_CYCLE_MAX_STEP_RETRIES: '1' })).orchestration, { planMode: true, stepRetries: 1, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'env', stepRetries: 'env' } });
  assert.deepEqual((await stateWith({ ORCH_CYCLE_PLAN: 'off', ORCH_CYCLE_MAX_STEP_RETRIES: 'off' })).orchestration, { planMode: false, stepRetries: 0, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'env', stepRetries: 'env' } });
  assert.equal((await stateWith({ ORCH_CYCLE_MAX_STEP_RETRIES: '0' })).orchestration.stepRetries, 0);
});

// ---------- Marco D: integração (worktrees) no relatório de entrega ----------
const wt = (over = {}) => ({ id: 'wt_aaaaaaaa', missionId: 'mx', cycleId: 'cy1', state: 'finished', branch: 'orch/wt_aaaaaaaa', baseBranch: 'main', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), integratedCommit: null, attempts: [], ...over });
const done = () => cyc('completed', [rnd(1)], null);
const withWt = (list, cycle = done(), over = {}) => buildDelivery(mis(cycle, over), null, { worktrees: list });

test('Marco D: sem worktree o relatório NÃO tem "integration" e é idêntico ao contrato anterior (inclusive com registros de outras missões)', () => {
  const base = buildDelivery(mis(done()), null, { now: () => 'T' }), other = buildDelivery(mis(done()), null, { now: () => 'T', worktrees: [wt({ missionId: 'outra' }), wt({ cycleId: 'cy_x' })] });
  assert.equal('integration' in base, false); assert.deepEqual(other, base);
});

test('Marco D: ciclo concluído com trabalho ainda no worktree => integration.pending + limitação explícita; delivered, assurance e acceptance NÃO mudam', () => {
  const base = buildDelivery(mis(done()), null), r = withWt([wt()]);
  assert.equal(r.integration.status, 'pending'); assert.equal(r.integration.worktrees[0].relation, 'current'); assert.equal(r.integration.worktrees[0].integration, null);
  assert.ok(r.limitations.some((l) => /NÃO está integrado/.test(l)));
  assert.deepEqual([r.state.delivered, r.assurance, r.acceptance], [base.state.delivered, base.assurance, base.acceptance]);
});

test('Marco D: integrado — commit, digest e autorização vêm da tentativa registrada; sem tentativa, ficam null (indisponível, não inventado); sem commit NÃO é confirmado', () => {
  const att = { kind: 'integrate', outcome: 'integrated', digest: 'd'.repeat(32), authorizedBy: 'user', at: 'T9' };
  let r = withWt([wt({ state: 'integrated', integratedCommit: 'c'.repeat(40), attempts: [att] })]);
  assert.equal(r.integration.status, 'integrated'); assert.deepEqual(r.integration.worktrees[0].integration, { commit: 'c'.repeat(40), digest: 'd'.repeat(32), authorizedBy: 'user', at: 'T9' }); assert.equal(r.limitations.some((l) => /NÃO está integrado/.test(l)), false);
  r = withWt([wt({ state: 'integrated', integratedCommit: 'c'.repeat(40) })]); assert.equal(r.integration.status, 'integrated'); assert.deepEqual([r.integration.worktrees[0].integration.digest, r.integration.worktrees[0].integration.authorizedBy], [null, null]);
  r = withWt([wt({ state: 'integrated' })]); assert.equal(r.integration.status, 'blocked'); assert.match(r.integration.worktrees[0].reasons[0], /não é possível confirmar/); assert.ok(r.limitations.some((l) => /NÃO está integrado/.test(l)));
  r = withWt([wt({ state: 'removed', integratedCommit: 'c'.repeat(40) })]); assert.equal(r.integration.status, 'integrated'); r = withWt([wt({ state: 'removed' })]); assert.equal(r.integration.status, 'blocked');
});

test('Marco D: blocked — inconsistente, conflito, tentativa inesperada e diagnóstico, com a razão', () => {
  assert.equal(withWt([wt({ state: 'inconsistent' })]).integration.status, 'blocked');
  let r = withWt([wt({ attempts: [{ kind: 'check', result: 'conflict', conflicts: ['a.txt'] }] })]); assert.equal(r.integration.status, 'blocked'); assert.match(r.integration.reasons[0], /conflito em: a\.txt/);
  r = withWt([wt({ attempts: [{ kind: 'integrate', outcome: 'inconsistent' }] })]); assert.equal(r.integration.status, 'blocked');
  r = withWt([wt({ diagnostic: { code: 'inspection_failed', reason: 'git ausente', at: 'T' } })]); assert.equal(r.integration.status, 'blocked'); assert.equal(r.integration.worktrees[0].diagnostic.reason, 'git ausente'); assert.match(r.integration.reasons[0], /git ausente/);
  assert.equal(withWt([wt({ attempts: [{ kind: 'check', result: 'invalid', problems: [{ code: 'evidence_stale' }] }] })]).integration.status, 'pending', 'checagem recusada sem conflito segue pendente');
});

test('Marco D: ciclo em pastCycles — o worktree do ciclo anterior aparece como "past" e não esconde o estado do ciclo atual; worktree declarado e ausente é indisponível', () => {
  const past = { ...done(), id: 'cy_old' }, cur = { ...cyc('completed', [rnd(1)], null), id: 'cy2' };
  const r = withWt([wt({ id: 'wt_bbbbbbbb', cycleId: 'cy_old', state: 'inconsistent' }), wt({ id: 'wt_cccccccc', cycleId: 'cy2', state: 'integrated', integratedCommit: 'c'.repeat(40) })], cur, { pastCycles: [past] });
  assert.deepEqual(r.integration.worktrees.map((x) => [x.id, x.relation]), [['wt_bbbbbbbb', 'past'], ['wt_cccccccc', 'current']]); assert.equal(r.integration.status, 'integrated', 'o estado geral é o do ciclo atual');
  const lost = withWt([], { ...done(), worktreeId: 'wt_dddddddd' }); assert.equal(lost.integration.status, 'blocked'); assert.match(lost.integration.reasons[0], /não está disponível/); assert.ok(lost.limitations.some((l) => /NÃO está integrado/.test(l)));
  assert.equal(withWt([wt({ id: 'wt_eeeeeeee' })], { ...done(), worktreeId: 'wt_dddddddd' }).integration.status, 'blocked', 'ciclo que declara outro worktree não casa por semelhança');
});

test('Marco D: ciclo NÃO concluído não ganha limitação de "concluída sem integração" e o relatório tolera dado malformado', () => {
  const r = withWt([wt()], cyc('blocked', [rnd(1)], null)); assert.equal(r.state.delivered, false); assert.equal(r.limitations.some((l) => /NÃO está integrado/.test(l)), false); assert.equal(r.integration.status, 'pending');
  assert.doesNotThrow(() => withWt([null, 7, { missionId: 'mx', cycleId: 'cy1', attempts: 'x', diagnostic: 5 }]));
});
