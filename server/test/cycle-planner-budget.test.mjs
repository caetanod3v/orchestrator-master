// B2: com o orçamento de consultas ao Planner esgotado, retomar sem ampliar maxIterations é recusado (409) sem tocar em nada;
// ampliando o limite a retomada segue e plannerCalls permanece cumulativo. Banco TEMPORÁRIO, CLI FALSA, Planner SIMULADO.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-budget-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir });

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle, HARD_MAX_ITERATIONS } = await import('../cycle.js');

let db, executor, startTaskRun, seq = 0;
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await new Promise((r) => setTimeout(r, 600)); fs.rmSync(tmp, { recursive: true, force: true }); });

const blockedAnswer = JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'preciso de um humano' });
/** Planner que sempre pede ajuda humana; `calls` conta as consultas reais. */
const alwaysBlocked = () => { const p = { calls: 0, busy: () => false, cancel: async () => {}, decide: async () => { p.calls++; return { text: blockedAnswer }; } }; return p; };
const mkMission = () => { const m = { id: `b${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: store.now(), tasks: [] }; db.missions.push(m); return m; };
const mk = (planner) => createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });
const dbBytes = () => fs.readFileSync(DB_FILE);
const dbMtime = () => fs.statSync(DB_FILE).mtimeMs;

/** Fluxo real: maxIterations=1 => orçamento 6. start + 5 retomadas gastam as 6 consultas; a 6ª retomada bate no limite sem consultar. */
async function reachLimit() {
  const m = mkMission(), planner = alwaysBlocked(), cy = mk(planner);
  assert.equal((await cy.start(m.id, 1)).status, 202); await cy.idle();
  for (let i = 0; i < 5; i++) { assert.equal((await cy.resume(m.id)).status, 202); await cy.idle(); }
  assert.equal(m.cycle.plannerCalls, 6); assert.equal(m.cycle.blockedCode, 'planner_blocked');
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();         // última retomada ainda aceita: o bloqueio anterior não era o do orçamento
  assert.equal(m.cycle.blockedCode, 'planner_calls_limit'); assert.equal(planner.calls, 6, 'a retomada que bateu no limite não consultou o Planner');
  return { m, planner, cy };
}

test('orçamento esgotado e retomada sem ampliar o limite: 409, e ciclo, histórico, atividade e banco ficam intactos', async () => {
  const { m, planner, cy } = await reachLimit();
  const cycleBefore = JSON.stringify(m.cycle), activityBefore = JSON.stringify(db.activity), diskBefore = dbBytes(), mtimeBefore = dbMtime();
  const blocksBefore = m.cycle.blocks.length;
  for (const body of [undefined, { note: 'tente de novo' }, { maxIterations: 1 }, { note: 'x', maxIterations: 1 }]) {
    const r = await cy.resume(m.id, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match(r.error, /limite de consultas ao Planner.*atingido.*aumente o limite de rodadas/i);
  }
  assert.equal(JSON.stringify(m.cycle), cycleBefore, 'ciclo inalterado (status, plannerCalls, notas, bloqueios, flags)');
  assert.equal(m.cycle.blocks.length, blocksBefore); assert.equal(m.cycle.humanNotes.length, 0); assert.equal(m.cycle.plannerCalls, 6);
  assert.equal(JSON.stringify(db.activity), activityBefore, 'nenhuma atividade nova');
  assert.equal(planner.calls, 6); assert.deepEqual(dbBytes(), diskBefore, 'db.json não foi regravado'); assert.equal(dbMtime(), mtimeBefore);
});

test('ampliando maxIterations a retomada segue: o Planner é consultado de novo e plannerCalls NÃO é zerado', async () => {
  const { m, planner, cy } = await reachLimit();
  const r = await cy.resume(m.id, { note: 'agora pode', maxIterations: 2 });         // orçamento (2+1)*3 = 9 > 6
  assert.equal(r.status, 202); await cy.idle();
  assert.equal(planner.calls, 7, 'consultou o Planner'); assert.equal(m.cycle.plannerCalls, 7, 'cumulativo: 6 + 1, nunca zerado');
  assert.equal(m.cycle.maxIterations, 2); assert.equal(m.cycle.blockedCode, 'planner_blocked'); assert.deepEqual(m.cycle.humanNotes.map((n) => n.text), ['agora pode']);
});

/** Ciclo bloqueado por planner_calls_limit com os números pedidos (sem rodar nada). */
function limitBlocked({ max, calls, code = 'planner_calls_limit', rounds = 0 }) {
  const m = mkMission();
  m.cycle = { id: `${m.id}_c`, status: 'blocked', maxIterations: max, rounds: Array.from({ length: rounds }, (_, i) => ({ n: i + 1, status: 'succeeded', taskId: 'x', plan: { title: 't' }, report: null })), plannerCalls: calls,
    consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [{ code, reason: 'r', at: 't' }], blockedCode: code, blockedReason: 'r', finalSummary: null, evidence: null, cancelRequested: false, startedAt: 't', finishedAt: null };
  return m;
}

test('fronteira do orçamento (maxIterations efetivo + 1) * 3: padrão do ciclo, valor informado e teto rígido', async () => {
  assert.equal(HARD_MAX_ITERATIONS, 10);
  const cases = [
    // [descrição, max do ciclo, plannerCalls, corpo, status esperado]
    ['sem valor: usa o max do ciclo (1 => 6), esgotado', 1, 6, undefined, 409],
    ['sem valor: max do ciclo 2 => 9, calls 9 esgotado', 2, 9, undefined, 409],
    ['sem valor: max do ciclo 2 => 9, calls 8 ainda cabe', 2, 8, undefined, 202],
    ['valor informado substitui o do ciclo: 2 => 9 com calls 6', 1, 6, { maxIterations: 2 }, 202],
    ['valor informado igual ao do ciclo continua esgotado', 1, 6, { maxIterations: 1 }, 409],
    ['teto rígido 10 => 33, calls 32 cabe', 5, 32, { maxIterations: 10 }, 202],
    ['teto rígido 10 => 33, calls 33 esgotado', 5, 33, { maxIterations: 10 }, 409],
    ['calls muito acima do orçamento', 3, 100, { maxIterations: 10 }, 409],
  ];
  for (const [name, max, calls, body, want] of cases) {
    const m = limitBlocked({ max, calls }), planner = alwaysBlocked(), cy = mk(planner);
    const r = await cy.resume(m.id, body); await cy.idle();
    assert.equal(r.status, want, name);
    if (want === 202) { assert.equal(planner.calls, 1, name); assert.equal(m.cycle.plannerCalls, calls + 1, `${name}: cumulativo`); }
    else { assert.equal(planner.calls, 0, name); assert.equal(m.cycle.plannerCalls, calls, name); assert.equal(m.cycle.blocks.length, 1, `${name}: nenhum bloco novo`); }
  }
});

test('valores inválidos continuam sendo 400 (validação existente vem antes do orçamento) e nada muda', async () => {
  for (const body of [{ maxIterations: HARD_MAX_ITERATIONS + 1 }, { maxIterations: 1.5 }, { maxIterations: '3' }, { maxIterations: -1 }, { note: 'x'.repeat(1001) }]) {
    const m = limitBlocked({ max: 1, calls: 6 }), before_ = JSON.stringify(m.cycle), cy = mk(alwaysBlocked());
    assert.equal((await cy.resume(m.id, body)).status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(JSON.stringify(m.cycle), before_);
  }
  const m = limitBlocked({ max: 3, calls: 5, rounds: 3 });                                // maxIterations abaixo das rodadas já feitas
  assert.equal((await mk(alwaysBlocked()).resume(m.id, { maxIterations: 2 })).status, 400);
});

test('a recusa vale só para planner_calls_limit: outros bloqueios retomam como antes', async () => {
  const m = limitBlocked({ max: 3, calls: 2, code: 'planner_blocked' }), planner = alwaysBlocked(), cy = mk(planner);
  assert.equal((await cy.resume(m.id, { note: 'ok' })).status, 202); await cy.idle();
  assert.equal(planner.calls, 1); assert.equal(m.cycle.plannerCalls, 3);
});
