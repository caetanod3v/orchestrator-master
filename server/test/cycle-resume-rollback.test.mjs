// Falha durante a retomada (resume) ou o início (begin): rollback completo, sem ciclo "planning" órfão e sem perder histórico.
// Arquivo próprio (processo próprio): o teste de erro de persistência não transitório faz save() lançar de verdade e não pode
// colidir com gravações adiadas (saveSoon) de outros testes. Banco TEMPORÁRIO, CLI falsa e Planner simulado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-resume-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir);
const BLOCK_TMP = path.join(process.env.ORCH_DATA_DIR, 'db.json.tmp'); // diretório no lugar do .tmp => EISDIR (erro NÃO transitório)

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor, bus } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');

let db, executor, startTaskRun;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); await sleep(600); fs.rmSync(tmp, { recursive: true, force: true }); });

const blockedAnswer = (why = 'fim') => JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: why });
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const a = answers.shift(); return a === undefined ? { error: 'roteiro acabou' } : { text: a }; } }; };
const mk = (planner) => createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });

/** Missão com um ciclo BLOQUEADO, histórico e contadores não triviais (o que a retomada altera). */
function blockedMission(id) {
  const task = { id: `${id}_t`, title: '[Rodada 1] x', status: 'completed', auto: true, authorized: false, dependsOn: [], report: 'ok', files: [], log: [] };
  const report = { status: 'success', summary: 's', filesChanged: [{ path: 'a', status: '??', added: null, removed: null, preexisting: false }], filesKnown: true, checks: [], checksReported: false, errors: [], blockers: [], exitCode: 0, usage: null, verifications: [], verificationsSkipped: null, verificationsInterrupted: null };
  const m = { id, demo: false, title: id, objective: 'o', workspaceId: 'ws', createdAt: store.now(), tasks: [task] };
  m.cycle = {
    id: `${id}_c`, status: 'blocked', maxIterations: 3, plannerCalls: 2, consecutiveFailures: 1, consecutiveNoProgress: 1, humanNotes: [{ at: store.now(), text: 'nota antiga' }], rejections: [],
    blocks: [{ code: 'planner_blocked', reason: 'preciso de um humano', at: store.now() }], blockedCode: 'planner_blocked', blockedReason: 'preciso de um humano',
    finalSummary: null, evidence: null, cancelRequested: true, startedAt: store.now(), finishedAt: null,
    rounds: [{ n: 1, status: 'succeeded', taskId: task.id, fingerprint: 'x', plan: { rationale: 'r', title: 'x', instructions: 'i', acceptance: ['a'] }, startedAt: store.now(), finishedAt: store.now(), phase: 'done', report, decision: { decision: 'blocked', rationale: 'r', at: store.now() } }],
  };
  db.missions.push(m);
  return m;
}
const snapshot = (m) => JSON.stringify(m.cycle);

async function failingResume(m, cy, arm, body) {
  const origErr = console.error; console.error = () => {};
  try { return await cy.resume(m.id, body); } finally { console.error = origErr; arm.off?.(); }
}

test('resume: falha em emit() (evento) => 500, volta a "blocked" idêntico ao anterior, sem laço e sem perder histórico', async () => {
  const m = blockedMission('r1'), before_ = snapshot(m);
  const planner = scripted([blockedAnswer('de novo')]);
  const cy = mk(planner);
  let armed = true;
  const listener = () => { if (armed) { armed = false; throw new Error('emit explodiu'); } };
  bus.on('cycle', listener);
  const r = await failingResume(m, cy, { off: () => bus.off('cycle', listener) }, { note: 'orientação nova', maxIterations: 6 });
  assert.equal(r.status, 500); assert.match(r.error, /Falha ao retomar o ciclo: emit explodiu/);
  assert.equal(snapshot(m), before_, 'estado do ciclo idêntico ao de antes da tentativa (inclusive notas, bloqueio, contadores e flags)');
  assert.equal(m.cycle.status, 'blocked'); assert.equal(m.cycle.cancelRequested, true);
  assert.equal(planner.calls.length, 0, 'nenhum laço foi iniciado');
  assert.ok(db.activity.some((a) => a.missionId === 'r1' && /Falha ao retomar o ciclo \(revertido\)/.test(a.message)));
  // continua retomável, sem reserva ou laço residual: a retomada seguinte funciona e aplica a orientação
  assert.equal((await cy.resume('r1', { note: 'orientação nova', maxIterations: 6 })).status, 202); await cy.idle();
  assert.equal(m.cycle.maxIterations, 6); assert.deepEqual(m.cycle.humanNotes.map((n) => n.text), ['nota antiga', 'orientação nova']);
  assert.equal(planner.calls.length, 1); assert.equal(m.cycle.blockedCode, 'planner_blocked');
  assert.equal(m.cycle.blocks.length, 2, 'o histórico de bloqueios anterior foi preservado');
});

test('resume: erro de persistência NÃO transitório em save() => rollback, nada órfão, e recupera quando o disco volta', async () => {
  const m = blockedMission('r2'), before_ = snapshot(m);
  const planner = scripted([blockedAnswer('de novo')]);
  const cy = mk(planner);
  fs.mkdirSync(BLOCK_TMP);                                          // save() passa a lançar EISDIR (não é EPERM/EBUSY: não há nova tentativa)
  let r;
  try { r = await failingResume(m, cy, {}, { note: 'x' }); } finally { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
  assert.equal(r.status, 500); assert.match(r.error, /Falha ao retomar o ciclo: .*EISDIR/);
  assert.equal(snapshot(m), before_);
  assert.equal(planner.calls.length, 0);
  assert.equal((await cy.resume('r2', { note: 'x' })).status, 202); await cy.idle();   // disco normalizado: retoma normalmente
  assert.equal(planner.calls.length, 1); assert.deepEqual(m.cycle.humanNotes.map((n) => n.text), ['nota antiga', 'x']);
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.ORCH_DATA_DIR, 'db.json'), 'utf8')).missions.find((x) => x.id === 'r2');
  assert.equal(disk.cycle.status, 'blocked'); assert.equal(disk.cycle.humanNotes.length, 2);
});

test('begin (start): erro de persistência NÃO transitório => 500, ciclo anterior e pastCycles restaurados, reserva liberada', async () => {
  const m = blockedMission('b1'); m.cycle.status = 'completed'; m.cycle.blockedCode = null;
  const before_ = snapshot(m);
  const planner = scripted([blockedAnswer('fim')]);
  const cy = mk(planner);
  fs.mkdirSync(BLOCK_TMP);
  let r;
  const origErr = console.error; console.error = () => {};
  try { r = await cy.start('b1', 2); } finally { console.error = origErr; fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
  assert.equal(r.status, 500); assert.match(r.error, /Falha ao iniciar o ciclo: .*EISDIR/);
  assert.equal(snapshot(m), before_); assert.equal(m.pastCycles, undefined); assert.equal(planner.calls.length, 0);
  assert.equal((await cy.start('b1', 2)).status, 202); await cy.idle();
  assert.equal(m.pastCycles.length, 1); assert.equal(m.cycle.blockedCode, 'planner_blocked');
});

test('regras preservadas: retomada inválida e cancelamento de ciclo bloqueado continuam como antes', async () => {
  const m = blockedMission('p1');
  const cy = mk(scripted([]));
  assert.equal((await cy.resume('p1', { maxIterations: 0 })).status, 400);       // abaixo das rodadas já feitas
  assert.equal((await cy.resume('p1', { maxIterations: 99 })).status, 400);      // acima do teto
  assert.equal((await cy.resume('p1', { note: 'x'.repeat(1001) })).status, 400);
  assert.equal(m.cycle.status, 'blocked'); assert.equal(m.cycle.humanNotes.length, 1);
  assert.equal((await cy.cancel('p1')).status, 200);
  assert.equal(m.cycle.status, 'cancelled');
  assert.equal((await cy.resume('p1')).status, 409);                             // terminal: não retoma
});
