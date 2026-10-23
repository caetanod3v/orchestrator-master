// Ciclo + verificações reais: Planner SIMULADO, CLI FALSA e verificador SIMULADO (sem créditos).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cv-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace');
fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { missionStatus } = await import('../mission-status.js');

let db, executor, startTaskRun, ws, seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(30); } return false; };
const cont = (title, mode) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:${mode} ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificações reais aprovadas no relatório'] });
const blocked = () => JSON.stringify({ decision: 'blocked', rationale: 'sem como seguir', blockedReason: 'preciso de um humano' });
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const a = answers.shift(); return a === undefined ? { error: 'roteiro acabou' } : { text: a }; } }; };
/** results: lista de status ('pass'|'fail'|...) consumidos em ordem, ou função (item,n)=>status */
function fakeVerifier(results) {
  const calls = []; let stops = 0, release = null;
  const mk = (item, status, tail = '') => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : status === 'fail' ? 2 : null, durationMs: 1234, outputTail: tail, truncated: false, reason: status === 'pass' ? null : `motivo ${status}` });
  return {
    calls, get stops() { return stops; }, isBusy: () => false,
    run: async (w, item) => {
      calls.push(item.id);
      if (results === 'hang') return new Promise((r) => { release = () => r(mk(item, 'cancelled')); });
      const s = typeof results === 'function' ? results(item, calls.length) : results.shift() ?? 'pass';
      return mk(item, s, s === 'fail' ? 'FAIL tests/x.test.js: esperado 1, recebeu 2' : 'ok');
    },
    stop: async () => { stops++; release?.(); return { stopped: !!release, detail: 'x' }; },
  };
}

before(() => {
  db = store.load();
  ws = { id: 'ws', name: 'ws', path: wsDir };
  db.workspaces.push(ws);
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

const verifs = (...specs) => specs.map(([script, required]) => ({ id: script, script, command: `x-${script}`, required, timeoutMs: 60000 }));
function setup(planner, verifier, config) {
  fs.rmSync(path.join(wsDir, 'out.txt'), { force: true });
  ws.verifications = config;
  const m = { id: `v${++seq}`, demo: false, title: `Missão ${seq}`, objective: 'obj', workspaceId: 'ws', createdAt: store.now(), tasks: [] };
  db.missions.unshift(m);
  const cy = createCycle({ db, executor, planner, startTaskRun, verifier, listFiles: () => [] });
  return { m, cy, planner, verifier };
}
async function go(s, max) { assert.equal((await s.cy.start(s.m.id, max)).status, 202); await s.cy.idle(); return s.m.cycle; }

test('verificação obrigatória aprovada: relatório traz a evidência real e o ciclo conclui como "verified"', async () => {
  const s = setup(scripted([cont('Criar', 'write'), done()]), fakeVerifier(['pass']), verifs(['test', true]));
  const c = await go(s);
  assert.equal(c.status, 'completed'); assert.equal(c.assurance, 'verified');
  const v = c.rounds[0].report.verifications[0];
  assert.deepEqual([v.script, v.status, v.exitCode, v.source, v.command, v.durationMs], ['test', 'pass', 0, 'backend', 'npm run test', 1234]);
  assert.equal(c.rounds[0].phase, 'done');
  assert.match(s.planner.calls[1], /verificações REAIS \(executadas pelo orquestrador\): test=pass\(código 0\)/);
  assert.match(s.planner.calls[0], /VERIFICAÇÕES OBRIGATÓRIAS .*: test/);
  assert.ok(s.m.tasks[0].log.some((l) => /^\[verificação\] npm run test -> pass \(código 0\) em 1\.2 s/.test(l)), 'evidência no terminal');
});

test('verificação obrigatória FALHA: Planner não pode concluir; corrige e só conclui com a nova rodada aprovada', async () => {
  const s = setup(scripted([cont('Criar', 'write'), done(), cont('Corrigir o teste', 'check'), done()]), fakeVerifier(['fail', 'pass']), verifs(['test', true]));
  const c = await go(s);
  assert.equal(c.rounds[0].report.verifications[0].status, 'fail');
  assert.equal(c.rounds[0].report.status, 'success', 'a execução do agente foi ok; a verificação é que falhou');
  assert.match(c.rejections[0].problem, /verificações reais que não passaram: test=fail/);
  assert.match(s.planner.calls[1], /saída da primeira que não passou: FAIL tests\/x\.test\.js/);
  assert.equal(c.status, 'completed'); assert.equal(c.rounds.length, 2); assert.equal(c.rounds[1].report.verifications[0].status, 'pass');
});

test('autodeclaração do Executor NÃO substitui a verificação obrigatória', async () => {
  // MODE:check => o modelo declara "pass", mas a verificação real falha
  const s = setup(scripted([cont('Conferir', 'check'), done(), blocked()]), fakeVerifier(['fail']), verifs(['test', true]));
  const c = await go(s);
  assert.equal(c.rounds[0].report.checks[0].result, 'pass', 'autodeclarado = pass');
  assert.match(c.rejections[0].problem, /test=fail/);
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'planner_blocked');
});

test('relatório SEM verificação executada nunca vira sucesso (verificador ausente)', async () => {
  const s = setup(scripted([cont('Conferir', 'check'), done(), blocked()]), null, verifs(['test', true]));
  const c = await go(s);
  assert.equal(c.rounds[0].report.verifications.length, 0); assert.match(c.rounds[0].report.verificationsSkipped, /não está disponível/);
  assert.match(c.rejections[0].problem, /obrigatória não executada nesta rodada: test/);
  assert.notEqual(c.status, 'completed');
});

test('execução do agente falhou: verificações não rodam e "complete" é rejeitado', async () => {
  const v = fakeVerifier(['pass']);
  const s = setup(scripted([cont('Quebra', 'fail'), done(), blocked()]), v, verifs(['test', true]));
  const c = await go(s);
  assert.equal(v.calls.length, 0); assert.match(c.rounds[0].report.verificationsSkipped, /não foi bem-sucedida/);
  assert.match(c.rejections[0].problem, /"failed"/);
});

test('timeout e saída excessiva contam como NÃO aprovados e informam o Planner', async () => {
  for (const status of ['timeout', 'output_limit']) {
    const s = setup(scripted([cont('Criar', 'write'), done(), blocked()]), fakeVerifier([status]), verifs(['build', true]));
    const c = await go(s);
    assert.match(c.rejections[0].problem, new RegExp(`build=${status}`));
    assert.match(s.planner.calls[1], new RegExp(`build=${status}`));
    assert.notEqual(c.status, 'completed');
  }
});

test('verificação opcional que falha também impede a conclusão', async () => {
  const s = setup(scripted([cont('Criar', 'write'), done(), blocked()]), fakeVerifier((i) => (i.script === 'lint' ? 'fail' : 'pass')), verifs(['test', true], ['lint', false]));
  const c = await go(s);
  assert.deepEqual(c.rounds[0].report.verifications.map((v) => [v.script, v.status]), [['test', 'pass'], ['lint', 'fail']]);
  assert.match(c.rejections[0].problem, /lint=fail/);
});

test('verificação que não pode rodar (script alterado/npm ausente) bloqueia o ciclo para um humano', async () => {
  for (const status of ['blocked', 'error']) {
    const p = scripted([cont('Criar', 'write'), done()]);
    const s = setup(p, fakeVerifier([status]), verifs(['test', true]));
    const c = await go(s);
    assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'verification_blocked'); assert.match(c.blockedReason, new RegExp(`motivo ${status}`));
    assert.equal(p.calls.length, 1, 'o Planner não decide sozinho sobre um problema de ambiente');
    assert.equal(missionStatus(s.m), 'blocked');
  }
});

test('cancelar durante a verificação interrompe o processo e termina "cancelled"', async () => {
  const v = fakeVerifier('hang');
  const s = setup(scripted([cont('Criar', 'write'), done()]), v, verifs(['test', true]));
  await s.cy.start(s.m.id);
  assert.equal(await until(() => v.calls.length === 1), true);
  assert.equal(s.m.cycle.rounds[0].phase, 'verifying');
  await s.cy.cancel(s.m.id); await s.cy.idle();
  assert.equal(s.m.cycle.status, 'cancelled'); assert.ok(v.stops >= 1, 'verifier.stop() foi chamado');
  assert.equal(s.planner.calls.length, 1); assert.equal(missionStatus(s.m), 'cancelled');
});

test('sem verificações configuradas: comportamento anterior (autodeclarado) e rotulado "self-declared"', async () => {
  const v = fakeVerifier(['pass']);
  const s = setup(scripted([cont('Conferir', 'check'), done()]), v, []);
  const c = await go(s);
  assert.equal(c.status, 'completed'); assert.equal(c.assurance, 'self-declared'); assert.equal(v.calls.length, 0);
});

test('só verificações opcionais configuradas: ainda exige evidência (aprovada) para concluir', async () => {
  const s = setup(scripted([cont('Criar', 'plain'), done(), blocked()]), fakeVerifier(['fail']), verifs(['lint', false]));
  const c = await go(s);
  assert.match(c.rejections[0].problem, /lint=fail/);
  assert.notEqual(c.status, 'completed');
});

test('primeira verificação bloqueada/com erro interrompe as seguintes (nada mais roda no projeto suspeito)', async () => {
  const v = fakeVerifier((item) => (item.script === 'test' ? 'blocked' : 'pass'));
  const s = setup(scripted([cont('Criar', 'write'), done()]), v, verifs(['test', true], ['build', true]));
  const c = await go(s);
  assert.deepEqual(v.calls, ['test'], 'build não foi executado');
  assert.equal(c.rounds[0].report.verifications.length, 1); assert.equal(c.blockedCode, 'verification_blocked');
});
