// Consistência entre estado da missão, do ciclo, da rodada e da execução (Planner SIMULADO, CLI FALSA).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-states-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace');
fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { missionStatus, taskDerivedStatus } = await import('../mission-status.js');

let db, executor, startTaskRun, seq = 0;
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cont = (title, mode) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:${mode} ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação aprovada no relatório'] });
const blocked = () => JSON.stringify({ decision: 'blocked', rationale: 'sem como seguir', blockedReason: 'preciso de um humano' });
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const a = answers.shift(); return a === undefined ? { error: 'roteiro acabou' } : { text: a }; } }; };

before(() => {
  db = store.load();
  db.workspaces.push({ id: 'ws', name: 'ws', path: wsDir });
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

const mkMission = () => {
  fs.rmSync(path.join(wsDir, 'out.txt'), { force: true });
  const m = { id: `s${++seq}`, demo: false, title: `Missão ${seq}`, objective: 'obj', workspaceId: 'ws', createdAt: store.now(), tasks: [] };
  db.missions.unshift(m); return m;
};
const mkCycle = (p) => createCycle({ db, executor, planner: p, startTaskRun, listFiles: () => [] });
const EXPECTED = { planning: 'running', running: 'running', blocked: 'blocked', cancelled: 'cancelled', limit_reached: 'limit_reached', completed: 'completed' };

/** Invariantes que valem em QUALQUER ponto de repouso do ciclo. */
function consistent(m) {
  const c = m.cycle, active = ['planning', 'running'].includes(c.status);
  assert.ok(c.rounds.length <= c.maxIterations, 'rodadas <= limite');
  c.rounds.forEach((r, i) => {
    assert.equal(r.n, i + 1);
    const t = m.tasks.find((x) => x.id === r.taskId);
    assert.ok(t, `tarefa da rodada ${r.n} existe`);
    if (!active) assert.notEqual(r.status, 'running', 'sem rodada "running" fora de ciclo ativo');
    if (r.status === 'succeeded') { assert.equal(t.status, 'completed'); assert.equal(r.report.status, 'success'); }
    if (r.status === 'failed') { assert.equal(t.status, 'failed'); assert.equal(r.report.status, 'failed'); }
    if (r.status === 'interrupted') { assert.equal(t.status, 'interrupted'); assert.equal(r.report.status, 'interrupted'); }
  });
  if (!active) { assert.ok(!m.tasks.some((t) => t.status === 'running'), 'nenhuma tarefa running'); assert.equal(executor.isBusy(), false); }
  if (c.status === 'completed') { assert.equal(c.rounds.at(-1).status, 'succeeded'); assert.ok(c.evidence?.length && c.finalSummary); }
  if (c.status === 'blocked') assert.ok(c.blockedCode && c.blockedReason);
  if (['completed', 'cancelled', 'limit_reached'].includes(c.status)) assert.ok(c.finishedAt);
  assert.equal(missionStatus(m), EXPECTED[c.status], `missão deve refletir o ciclo (${c.status})`);
}
async function go(p, max) { const m = mkMission(), cy = mkCycle(p); assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle(); return { m, cy, c: m.cycle }; }

test('missionStatus: o ciclo manda; "completed" só quando o ciclo concluiu', () => {
  const allDone = [{ status: 'completed', auto: true }, { status: 'completed', auto: true }];
  for (const [cs, want] of [['planning', 'running'], ['running', 'running'], ['blocked', 'blocked'], ['cancelled', 'cancelled'], ['limit_reached', 'limit_reached'], ['completed', 'completed']]) {
    assert.equal(missionStatus({ tasks: allDone, cycle: { status: cs } }), want, cs);
  }
  assert.equal(missionStatus({ tasks: [{ status: 'completed' }] }), 'completed', 'fluxo manual intacto');
  assert.equal(missionStatus({ tasks: [{ status: 'failed' }, { status: 'completed' }] }), 'failed');
  assert.equal(missionStatus({ tasks: [] }), 'queued');
  assert.equal(taskDerivedStatus([{ status: 'interrupted' }]), 'interrupted');
  // falha intermediária tratada pelo Planner não reprova um ciclo concluído
  assert.equal(missionStatus({ tasks: [{ status: 'failed', auto: true }, { status: 'completed', auto: true }], cycle: { status: 'completed' } }), 'completed');
  // mas uma tarefa MANUAL pendente depois do ciclo continua visível
  assert.equal(missionStatus({ tasks: [{ status: 'completed', auto: true }, { status: 'queued' }], cycle: { status: 'completed' } }), 'queued');
});

test('completed: ciclo concluído com evidência', async () => {
  const { m, c } = await go(scripted([cont('Criar', 'write'), cont('Conferir', 'check'), done()]));
  assert.equal(c.status, 'completed'); consistent(m);
});

test('blocked: tarefas concluídas, mas missão "blocked"', async () => {
  const { m, c } = await go(scripted([cont('Criar', 'write'), blocked()]));
  assert.equal(c.status, 'blocked'); assert.equal(m.tasks[0].status, 'completed');
  assert.equal(missionStatus(m), 'blocked'); consistent(m);
});

test('limit_reached: tarefas concluídas, mas missão "limit_reached"', async () => {
  const { m, c } = await go(scripted([cont('Um', 'write'), cont('Dois', 'check'), cont('Três', 'write')]), 2);
  assert.equal(c.status, 'limit_reached'); assert.ok(m.tasks.every((t) => t.status === 'completed'));
  assert.equal(missionStatus(m), 'limit_reached'); consistent(m);
});

test('cancelled durante o PLANEJAMENTO (caso do bug: tarefas todas concluídas)', async () => {
  let release;
  const calls = []; const answers = [cont('Criar', 'write')];
  const p = {
    calls, busy: () => false,
    decide: ({ prompt }) => { calls.push(prompt); return answers.length ? Promise.resolve({ text: answers.shift() }) : new Promise((r) => { release = r; }); },
    cancel: async () => release?.({ error: 'cancelado', interrupted: true }),
  };
  const m = mkMission(), cy = mkCycle(p);
  await cy.start(m.id);
  assert.equal(await until(() => typeof release === 'function'), true, 'rodada 1 terminou e o Planner está pensando');
  assert.equal(m.tasks[0].status, 'completed');
  await cy.cancel(m.id); await cy.idle();
  assert.equal(m.cycle.status, 'cancelled'); assert.equal(missionStatus(m), 'cancelled'); consistent(m);
});

test('cancelled durante a EXECUÇÃO: rodada e tarefa "interrupted"', async () => {
  const m = mkMission(), cy = mkCycle(scripted([cont('Longa', 'sleep'), done()]));
  await cy.start(m.id);
  assert.equal(await until(() => executor.isBusy()), true); await sleep(600);
  await cy.cancel(m.id); await cy.idle();
  assert.equal(m.cycle.status, 'cancelled'); assert.equal(m.cycle.rounds[0].status, 'interrupted'); consistent(m);
});

test('retomada após planner_blocked, executor_failures e no_progress', async () => {
  // planner_blocked -> resume -> concluído
  let { m, cy, c } = await go(scripted([blocked(), cont('Conferir', 'check'), done()]));
  assert.equal(c.blockedCode, 'planner_blocked'); consistent(m);
  assert.equal((await cy.resume(m.id, { note: 'tente assim' })).status, 202); await cy.idle();
  assert.equal(c.status, 'completed'); assert.equal(c.blocks.length, 1); consistent(m);

  // executor_failures -> resume zera contador e permite recuperar
  ({ m, cy, c } = await go(scripted([cont('F1', 'fail'), cont('F2', 'fail'), cont('Corrigir', 'check'), done()])));
  assert.equal(c.blockedCode, 'executor_failures'); assert.equal(c.consecutiveFailures, 2); consistent(m);
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  assert.equal(c.consecutiveFailures, 0); assert.equal(c.status, 'completed'); consistent(m);

  // no_progress -> resume
  ({ m, cy, c } = await go(scripted([cont('P1', 'plain'), cont('P2', 'plain'), cont('P3', 'check'), done()])));
  assert.equal(c.blockedCode, 'no_progress'); consistent(m);
  assert.equal((await cy.resume(m.id, { maxIterations: 5 })).status, 202); await cy.idle();
  assert.equal(c.status, 'completed'); assert.equal(c.consecutiveNoProgress, 0); consistent(m);
});

test('resume não pode elevar o limite acima do teto nem abaixo das rodadas já feitas', async () => {
  const { m, cy, c } = await go(scripted([cont('A', 'write'), blocked()]));
  assert.equal(c.status, 'blocked');
  assert.equal((await cy.resume(m.id, { maxIterations: 11 })).status, 400);
  assert.equal((await cy.resume(m.id, { maxIterations: 0 })).status, 400);
  assert.equal(c.status, 'blocked', 'pedido inválido não altera o estado');
});

test('estados terminais: não retomam nem cancelam de novo; novo ciclo arquiva o anterior', async () => {
  const { m, cy, c } = await go(scripted([cont('A', 'write'), cont('B', 'check'), done(), blocked()]));
  assert.equal(c.status, 'completed');
  assert.equal((await cy.resume(m.id)).status, 409); assert.equal((await cy.cancel(m.id)).status, 409);
  const first = c.id;
  assert.equal((await cy.start(m.id)).status, 202); await cy.idle();
  assert.notEqual(m.cycle.id, first); assert.equal(m.pastCycles.length, 1); assert.equal(m.pastCycles[0].id, first);
  assert.equal(m.cycle.status, 'blocked'); assert.equal(missionStatus(m), 'blocked');
  assert.equal(m.tasks.length, 2, 'tarefas anteriores preservadas'); consistent(m);
});

test('fluxo manual não é afetado: missão sem ciclo continua derivada das tarefas', () => {
  const m = mkMission(); m.tasks.push({ id: 'x', status: 'completed', dependsOn: [] });
  assert.equal(missionStatus(m), 'completed');
  m.tasks.push({ id: 'y', status: 'awaiting_approval', dependsOn: [] });
  assert.equal(missionStatus(m), 'awaiting_approval');
});
