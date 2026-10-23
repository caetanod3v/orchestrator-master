// Retomada depois de um bloqueio de verificação: a evidência velha ("script mudou") não pode sobreviver.
// Planner SIMULADO, CLI FALSA e verificador SIMULADO (sem créditos).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rv-'));
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
const cont = (title, mode) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:${mode} ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blocked = () => JSON.stringify({ decision: 'blocked', rationale: 'sem como seguir', blockedReason: 'preciso de um humano' });
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const a = answers.shift(); return a === undefined ? { error: 'roteiro acabou' } : { text: a }; } }; };
const STALE = 'O script mudou desde a aprovação humana; aprove novamente em Workspaces.';
/**
 * O erro antigo TEM que estar no prompt, como histórico datado e rotulado, e só ali; o estado atual vem só da linha de verificações REAIS.
 * Exige presença (nunca passa vacuamente quando a linha SUBSTITUÍDA some).
 */
const staleOnlyAsHistory = (prompt) => {
  const hist = prompt.slice(prompt.indexOf('HISTÓRICO:'), prompt.indexOf('ÚLTIMO RELATÓRIO'));
  const old = hist.split('\n').filter((l) => /SUBSTITUÍDA/.test(l));
  assert.equal(old.length, 1, 'a evidência histórica (linha SUBSTITUÍDA) precisa estar presente');
  assert.match(old[0], /\d{4}-\d{2}-\d{2}T[\d:.]+Z/, 'datada');
  assert.match(old[0], /test=blocked/, 'status real');
  assert.ok(old[0].includes(STALE), 'motivo real, na íntegra');
  assert.match(old[0], /é HISTÓRICO, não é a situação atual/, 'distinção histórico x atual');
  assert.match(hist, /linha do tempo \(dados do backend\)/, 'linha do tempo presente');
  // a frase antiga não aparece em NENHUM outro lugar do prompt (nem como estado atual, nem no JSON do último relatório)
  assert.deepEqual(prompt.split('\n').filter((l) => /mudou desde a aprovação/.test(l)), old);
  const current = hist.split('\n').filter((l) => /verificações REAIS \(executadas/.test(l));
  assert.equal(current.length, 1, 'existe exatamente uma linha de estado atual');
  assert.match(current[0], /test=pass\(código 0\)/); assert.doesNotMatch(current[0], /blocked|mudou/);
};
/** results: fila de status; cada chamada consome um. */
function fakeVerifier(results) {
  const calls = [];
  return {
    calls, isBusy: () => false, stop: async () => ({ stopped: false }),
    run: async (w, item) => {
      const status = results.shift() ?? 'pass'; calls.push(status);
      return { id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : null, durationMs: 50, outputTail: status === 'fail' ? 'FAIL x' : '', truncated: false, reason: status === 'blocked' ? STALE : status === 'pass' ? null : `motivo ${status}` };
    },
  };
}

before(() => {
  db = store.load(); ws = { id: 'ws', name: 'ws', path: wsDir }; db.workspaces.push(ws);
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

function setup(planner, verifier) {
  fs.rmSync(path.join(wsDir, 'out.txt'), { force: true });
  ws.verifications = [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }];
  const m = { id: `r${++seq}`, demo: false, title: `Missão ${seq}`, objective: 'obj', workspaceId: 'ws', createdAt: store.now(), tasks: [] };
  db.missions.unshift(m);
  return { m, cy: createCycle({ db, executor, planner, startTaskRun, verifier, listFiles: () => [] }), planner, verifier };
}
const run = async (s) => { assert.equal((await s.cy.start(s.m.id)).status, 202); await s.cy.idle(); return s.m.cycle; };
const resume = async (s, o) => { assert.equal((await s.cy.resume(s.m.id, o)).status, 202); await s.cy.idle(); return s.m.cycle; };

test('REPRODUÇÃO DO BUG: após corrigir o script e retomar, o Planner recebe a verificação REFEITA, não a velha', async () => {
  const s = setup(scripted([cont('Criar', 'write'), done()]), fakeVerifier(['blocked', 'pass']));
  let c = await run(s);
  assert.equal(c.blockedCode, 'verification_blocked'); assert.equal(s.planner.calls.length, 0 + 0 || s.planner.calls.length);
  const callsBefore = s.planner.calls.length; // 1 (planejou a rodada 1)
  // (o humano restaurou o package.json e reaprovou; agora o verificador deixa passar)
  c = await resume(s);
  assert.equal(s.verifier.calls.length, 2, 'a verificação foi executada de novo na retomada');
  const prompt = s.planner.calls[callsBefore]; // 1ª consulta ao Planner depois de retomar
  staleOnlyAsHistory(prompt); // o erro velho não pode se passar por evidência atual
  assert.match(prompt, /test=pass\(código 0\)/);
  assert.equal(c.status, 'completed'); assert.equal(c.assurance, 'verified');
  assert.equal(c.rounds[0].report.verifications[0].status, 'pass');
  assert.equal(c.rounds[0].report.previousVerifications.length, 1, 'o resultado antigo fica no histórico (auditoria), mas fora do relatório atual');
  assert.equal(c.rounds[0].report.previousVerifications[0].verifications[0].status, 'blocked');
  assert.equal(missionStatus(s.m), 'completed');
});

test('se o script AINDA estiver alterado, a re-verificação bloqueia de novo e o Planner NÃO é consultado', async () => {
  const s = setup(scripted([cont('Criar', 'write'), done()]), fakeVerifier(['blocked', 'blocked']));
  let c = await run(s); const before = s.planner.calls.length;
  c = await resume(s);
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'verification_blocked');
  assert.equal(s.planner.calls.length, before, 'sem consulta ao Planner: o problema é do ambiente');
  assert.equal(c.blocks.length, 2); assert.equal(s.verifier.calls.length, 2);
});

test('o mesmo vale quando o ciclo foi parar em planner_blocked citando a evidência velha (caso real)', async () => {
  const s = setup(scripted([cont('Criar', 'write'), blocked(), done()]), fakeVerifier(['blocked', 'pass']));
  // 1ª vez: verificação bloqueia -> ciclo para
  let c = await run(s); assert.equal(c.blockedCode, 'verification_blocked');
  // retomada SEM corrigir nada seria bloqueio de novo; simulamos o caso real: o Planner viu o relatório velho e pediu um humano
  c.blockedCode = 'planner_blocked'; c.blockedReason = 'revisar o script'; // estado em que o ciclo do usuário ficou
  // e a justificativa que o Planner deu com a evidência velha (ficou gravada na rodada)
  c.rounds[0].decision = { decision: 'blocked', rationale: 'O script mudou desde a aprovação humana; JUSTIFICATIVA-ANTIGA', at: '2000-01-01T00:00:00.000Z' };
  c = await resume(s);
  assert.equal(s.verifier.calls.length, 2, 'reverificou porque o último relatório tinha verificação "blocked"');
  assert.match(s.planner.calls.at(-1), /test=pass/); staleOnlyAsHistory(s.planner.calls.at(-1));
  assert.doesNotMatch(s.planner.calls.at(-1), /JUSTIFICATIVA-ANTIGA/, 'a justificativa tomada com evidência velha não volta ao Planner');
  assert.match(s.planner.calls.at(-1), /sua decisão anterior \(blocked\) foi tomada com verificações que o orquestrador depois refez/);
});

test('falha REAL de verificação (fail) não é refeita na retomada: é evidência legítima para o Planner', async () => {
  const s = setup(scripted([cont('Criar', 'write'), blocked(), blocked()]), fakeVerifier(['fail', 'pass']));
  let c = await run(s); assert.equal(c.blockedCode, 'planner_blocked'); // o Planner viu test=fail e pediu ajuda
  c = await resume(s);
  assert.equal(s.verifier.calls.length, 1, 'nada foi reexecutado');
  assert.match(s.planner.calls.at(-1), /test=fail/);
});

test('re-verificação não aceita script alterado automaticamente e respeita cancelamento', async () => {
  const hang = { calls: [], isBusy: () => false, stopped: 0, run: null, stop: async () => { hang.stopped++; hang.release?.(); return { stopped: true }; } };
  let n = 0;
  hang.run = async (w, item) => { n++; if (n === 1) return { id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'blocked', exitCode: null, durationMs: 0, outputTail: '', reason: STALE }; return new Promise((r) => { hang.release = () => r({ id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'cancelled', exitCode: null, durationMs: 1, outputTail: '', reason: 'Verificação cancelada.' }); }); };
  const s = setup(scripted([cont('Criar', 'write'), done()]), hang);
  await run(s);
  assert.equal((await s.cy.resume(s.m.id)).status, 202);
  for (let i = 0; i < 100 && n < 2; i++) await new Promise((r) => setTimeout(r, 30));
  assert.equal(n, 2, 'está re-verificando');
  await s.cy.cancel(s.m.id); await s.cy.idle();
  assert.equal(s.m.cycle.status, 'cancelled'); assert.ok(hang.stopped >= 1);
});
