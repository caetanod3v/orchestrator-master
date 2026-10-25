// B5: round.status descreve a EXECUÇÃO; round.verification descreve as verificações REAIS (none | passed | failed | blocked | skipped).
// CLI FALSA, verificador e Planner SIMULADOS, banco e workspace TEMPORÁRIOS: nenhum dado real, nenhum modelo.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rverif-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle, verificationOutcome, roundVerification } = await import('../cycle.js');

let db, executor, startTaskRun, ws, seq = 0;
before(() => {
  db = store.load(); db.missions = []; ws = { id: 'ws', name: 'ws', path: wsDir }; db.workspaces = [ws];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

const cont = (title, mode = 'write') => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:${mode} ${title}`, acceptance: ['conferir'] } });
const done = JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificações reais aprovadas'] });
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const a = answers.shift(); return a === undefined ? { error: 'roteiro acabou' } : { text: a }; } }; };
/** `plan`: status por chamada (item a item); `onRun(item, n)` permite observar o estado no meio da verificação. */
function fakeVerifier(plan, onRun) {
  let n = 0;
  return { isBusy: () => false, stop: async () => ({ stopped: false }), run: async (w, item) => {
    const status = plan.shift() ?? 'pass'; onRun?.(item, ++n);
    return { id: item.id, script: item.script, required: !!item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : null, durationMs: 5, outputTail: status === 'fail' ? 'FAIL' : '', truncated: false, reason: ['pass'].includes(status) ? null : `motivo ${status}` };
  } };
}
const items = (...scripts) => scripts.map((s) => ({ id: s, script: s, command: 'x', required: true, timeoutMs: 1000 }));
async function go({ answers, verifier, verifications = items('test') }) {
  fs.rmSync(path.join(wsDir, 'out.txt'), { force: true }); ws.verifications = verifications;
  const m = { id: `v${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: store.now(), tasks: [] }; db.missions.push(m);
  const planner = scripted(answers), cy = createCycle({ db, executor, planner, startTaskRun, verifier, listFiles: () => [] });
  assert.equal((await cy.start(m.id, 4)).status, 202); await cy.idle();
  return { m, c: m.cycle, planner, cy };
}

test('pass => passed; round.status continua "succeeded" (execução)', async () => {
  const { c } = await go({ answers: [cont('A'), done], verifier: fakeVerifier(['pass']) });
  assert.equal(c.rounds[0].status, 'succeeded'); assert.equal(c.rounds[0].verification, 'passed'); assert.equal(c.status, 'completed');
});

test('fail => failed, mas round.status segue "succeeded" e o relatório da execução segue "success"; a rodada seguinte corrige', async () => {
  const { c } = await go({ answers: [cont('A'), cont('B'), done], verifier: fakeVerifier(['fail', 'pass']) });
  assert.deepEqual(c.rounds.map((r) => [r.status, r.verification]), [['succeeded', 'failed'], ['succeeded', 'passed']]);
  assert.equal(c.rounds[0].report.status, 'success'); assert.equal(c.status, 'completed');
});

test('blocked e error => blocked (o ciclo bloqueia para um humano, como antes)', async () => {
  for (const status of ['blocked', 'error']) {
    const { c } = await go({ answers: [cont('A'), done], verifier: fakeVerifier([status]) });
    assert.equal(c.rounds[0].verification, 'blocked', status); assert.equal(c.rounds[0].status, 'succeeded');
    assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'verification_blocked');
  }
});

test('timeout e output_limit => failed (não bloqueiam o ciclo; o Planner corrige)', async () => {
  for (const status of ['timeout', 'output_limit']) {
    const { c } = await go({ answers: [cont('A'), JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'x' })], verifier: fakeVerifier([status]) });
    assert.equal(c.rounds[0].verification, 'failed', status); assert.equal(c.blockedCode, 'planner_blocked');
  }
});

test('várias verificações: blocked precede failed; failed precede passed', async () => {
  let r = await go({ answers: [cont('A')], verifier: fakeVerifier(['pass', 'fail']), verifications: items('test', 'lint') });
  assert.equal(r.c.rounds[0].verification, 'failed');
  r = await go({ answers: [cont('A')], verifier: fakeVerifier(['fail', 'blocked']), verifications: items('test', 'lint') });
  assert.equal(r.c.rounds[0].verification, 'blocked');
  r = await go({ answers: [cont('A'), done], verifier: fakeVerifier(['pass', 'pass']), verifications: items('test', 'lint') });
  assert.equal(r.c.rounds[0].verification, 'passed');
});

test('sem verificações configuradas => none; verificador indisponível => skipped; execução que falhou => skipped', async () => {
  let r = await go({ answers: [cont('A'), done], verifier: null, verifications: [] });
  assert.equal(r.c.rounds[0].verification, 'none'); assert.equal(r.c.rounds[0].status, 'succeeded');
  r = await go({ answers: [cont('A'), JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'x' })], verifier: null });
  assert.equal(r.c.rounds[0].verification, 'skipped'); assert.match(r.c.rounds[0].report.verificationsSkipped, /verificador não está disponível/);
  r = await go({ answers: [cont('A', 'fail'), JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'x' })], verifier: fakeVerifier(['pass']) });
  assert.equal(r.c.rounds[0].status, 'failed'); assert.equal(r.c.rounds[0].verification, 'skipped'); assert.match(r.c.rounds[0].report.verificationsSkipped, /execução não foi bem-sucedida/);
  r = await go({ answers: [cont('A', 'fail'), JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'x' })], verifier: fakeVerifier([]), verifications: [] });
  assert.equal(r.c.rounds[0].verification, 'none', 'execução falhou, mas nada estava configurado');
});

test('cancelar no MEIO da fila inicial (1ª de 2 verificações) => skipped; a fila completa continua dando passed', async () => {
  const run = async (cancelDuringFirst) => {
    fs.rmSync(path.join(wsDir, 'out.txt'), { force: true }); ws.verifications = items('test', 'lint');
    const m = { id: `v${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: store.now(), tasks: [] }; db.missions.push(m);
    let cancelling = null, cy;
    const verifier = fakeVerifier(['pass', 'pass'], (item) => { if (cancelDuringFirst && item.script === 'test') cancelling = cy.cancel(m.id); });
    cy = createCycle({ db, executor, planner: scripted([cont('A'), done]), startTaskRun, verifier, listFiles: () => [] });
    assert.equal((await cy.start(m.id, 4)).status, 202); await cy.idle(); await cancelling;
    return m.cycle;
  };
  const cancelled = await run(true);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.rounds[0].report.verifications.map((v) => [v.script, v.status]), [['test', 'pass']], 'só a 1ª verificação chegou a rodar');
  assert.equal(cancelled.rounds[0].status, 'succeeded'); assert.equal(cancelled.rounds[0].verification, 'skipped'); assert.equal(roundVerification(cancelled.rounds[0]), 'skipped');
  const complete = await run(false);                                   // controle: a mesma fila inteira aprovada
  assert.equal(complete.rounds[0].report.verifications.length, 2); assert.equal(complete.rounds[0].verification, 'passed'); assert.equal(complete.status, 'completed');
});

test('fila incompleta só rebaixa para skipped quando não há resultado de maior precedência', () => {
  const rep = (...st) => ({ status: 'success', verifications: st.map((status) => ({ script: 's', status })), verificationsSkipped: null });
  assert.equal(verificationOutcome(rep('pass'), 2), 'skipped');
  assert.equal(verificationOutcome(rep('fail'), 2), 'failed'); assert.equal(verificationOutcome(rep('timeout'), 3), 'failed');
  assert.equal(verificationOutcome(rep('blocked'), 2), 'blocked'); assert.equal(verificationOutcome(rep('pass', 'error'), 3), 'blocked');
  assert.equal(verificationOutcome(rep('pass', 'pass'), 2), 'passed'); assert.equal(verificationOutcome(rep('pass'), 1), 'passed');
  assert.equal(verificationOutcome(rep('pass'), undefined), 'passed', 'sem "configured" (rodadas históricas) nada muda');
  assert.equal(verificationOutcome({ status: 'success', verifications: [], verificationsSkipped: null }), 'none', 'nada configurado nem executado continua none');
  assert.equal(verificationOutcome({ status: 'success', verifications: [], verificationsSkipped: null }, 0), 'none');
});

test('re-verificação após retomada: o campo é recalculado (blocked -> skipped durante -> passed) e o status da rodada não muda', async () => {
  const seen = [];
  const verifier = fakeVerifier(['blocked', 'pass'], (item, n) => { if (n === 2) seen.push(roundVerification(m.cycle.rounds[0])); });
  const { m, c, planner, cy } = await go({ answers: [cont('A'), done], verifier });
  assert.equal(c.blockedCode, 'verification_blocked'); assert.equal(c.rounds[0].verification, 'blocked'); assert.equal(planner.calls.length, 1);
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.deepEqual(seen, ['skipped'], 'durante a re-verificação os resultados antigos já não valem');
  assert.equal(c.rounds[0].verification, 'passed'); assert.equal(c.rounds[0].status, 'succeeded'); assert.equal(c.status, 'completed');
  assert.equal(c.rounds[0].report.previousVerifications[0].verifications[0].status, 'blocked', 'o histórico de auditoria é preservado');
});

test('fail real na retomada: reverificação que ainda falha vira failed (não esconde o resultado)', async () => {
  const { m, c, cy } = await go({ answers: [cont('A'), JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'x' }), JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'y' })], verifier: fakeVerifier(['error', 'fail']) });
  assert.equal(c.rounds[0].verification, 'blocked');
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.equal(c.rounds[0].verification, 'failed');
});

test('rodadas históricas (sem o campo): derivadas na LEITURA, sem gravar nem reinterpretar o estado persistido; recover() não as altera', async () => {
  const rep = (over) => ({ status: 'success', verifications: [], verificationsSkipped: null, ...over });
  const v = (status) => ({ script: 'test', status });
  const cases = [
    [rep({}), 'none'], [rep({ verificationsSkipped: 'x' }), 'skipped'], [rep({ verifications: [v('pass')] }), 'passed'], [rep({ verifications: [v('fail')] }), 'failed'],
    [rep({ verifications: [v('blocked')] }), 'blocked'], [rep({ verifications: [v('timeout')] }), 'failed'], [rep({ verifications: [v('cancelled')] }), 'skipped'],
    [rep({ verifications: [v('pass')], verificationsInterrupted: 'queda' }), 'skipped'],
  ];
  for (const [report, want] of cases) {
    const round = { n: 1, status: 'succeeded', report }, before_ = JSON.stringify(round);
    assert.equal(roundVerification(round), want); assert.equal(JSON.stringify(round), before_, 'leitura não grava'); assert.equal('verification' in round, false);
  }
  assert.equal(roundVerification({ n: 1, status: 'failed', report: null }), 'none'); assert.equal(roundVerification(undefined), 'none');
  assert.equal(roundVerification({ verification: 'failed', report: rep({}) }), 'failed', 'o campo gravado vale quando existe');
  assert.equal(roundVerification({ verification: 'passed', report: rep({ verificationsInterrupted: 'q' }) }), 'skipped', 'interrupção posterior invalida o valor gravado');
  assert.equal(verificationOutcome(rep({}), 2), 'skipped', 'configurado e sem resultados: skipped');

  // recover() sobre ciclo histórico: nada de campo novo, status da rodada preservado
  const m = { id: `h${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', tasks: [{ id: 't', status: 'completed', auto: true, authorized: false, dependsOn: [], report: '', files: [], log: [] }] };
  m.cycle = { id: 'c', status: 'running', maxIterations: 3, plannerCalls: 1, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null, cancelRequested: false, startedAt: 't', finishedAt: null,
    rounds: [{ n: 1, status: 'succeeded', taskId: 't', fingerprint: 'f', plan: { title: 't', instructions: 'i', acceptance: ['a'] }, report: rep({ verifications: [v('pass')] }), phase: 'done', decision: null }] };
  db.missions.push(m); ws.verifications = items('test');
  createCycle({ db, executor, planner: scripted([]), startTaskRun, verifier: null, listFiles: () => [] }).recover();
  assert.equal(m.cycle.status, 'blocked'); assert.equal(m.cycle.rounds[0].status, 'succeeded'); assert.equal('verification' in m.cycle.rounds[0], false);
  assert.equal(roundVerification(m.cycle.rounds[0]), 'passed');
});
