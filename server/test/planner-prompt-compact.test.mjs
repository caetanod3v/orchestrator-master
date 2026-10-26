// O JSON do último relatório no prompt do Planner é COMPACTO sem perder o que decide continue/complete/blocked.
// Banco TEMPORÁRIO, CLI FALSA, Planner SIMULADO e verificador SIMULADO: nenhum modelo é chamado.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-compact-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle, plannerReportView, PASS_TAIL, FAIL_TAIL } = await import('../cycle.js');

let db, executor, startTaskRun, ws, seq = 0;
before(() => {
  db = store.load(); db.missions = []; ws = { id: 'ws', name: 'ws', path: wsDir }; db.workspaces = [ws];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

const cont = (title) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:check ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blocked = () => JSON.stringify({ decision: 'blocked', rationale: 'sem como seguir', blockedReason: 'preciso de um humano' });
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const a = answers.shift(); return a === undefined ? { error: 'roteiro acabou' } : { text: a }; } }; };
const lastJson = (prompt) => { const l = prompt.split('\n'); return JSON.parse(l[l.findIndex((x) => x.startsWith('ÚLTIMO RELATÓRIO (JSON):')) + 1]); };

const PASS_OUT = `${'.'.repeat(3600)}\n# tests 42\n# pass 42\n# fail 0`;
const FAIL_OUT = `${'.'.repeat(3000)}\nERRO-FINAL: esperado 1, recebido 2`;
const verifierWith = (status, outputTail) => ({
  isBusy: () => false, stop: async () => ({ stopped: false }),
  run: async (w, item) => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : 1, durationMs: 1234, outputTail, truncated: true, outputBytes: 9999, reason: status === 'pass' ? null : 'Terminou com código 1.' }),
});
function setup(planner, verifier) {
  ws.verifications = [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }];
  const m = { id: `c${++seq}`, demo: false, title: `Missão ${seq}`, objective: 'obj', workspaceId: 'ws', createdAt: store.now(), tasks: [] };
  db.missions.unshift(m);
  return { m, cy: createCycle({ db, executor, planner, startTaskRun, verifier, listFiles: () => [] }) };
}
const run = async (s) => { assert.equal((await s.cy.start(s.m.id, 3)).status, 202); await s.cy.idle(); return s.m.cycle; };

const sample = () => ({
  status: 'success', summary: 'feito', filesChanged: [{ path: 'a.js', status: 'M', added: 3, removed: 1, preexisting: false }], filesKnown: true,
  checks: [{ name: 'c', result: 'pass', detail: 'd' }], checksReported: true, errors: ['e1'], blockers: ['b1'], exitCode: 0, usage: { costUsd: 0.02, durationMs: 7, turns: 4 },
  verifications: [
    { id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'pass', exitCode: 0, durationMs: 50, outputTail: PASS_OUT, truncated: true, outputBytes: 3640, reason: null },
    { id: 'build', script: 'build', required: false, command: 'npm run build', source: 'backend', status: 'fail', exitCode: 1, durationMs: 60, outputTail: FAIL_OUT, truncated: true, outputBytes: 3040, reason: 'Terminou com código 1.' },
    { id: 'lint', script: 'lint', required: false, command: 'npm run lint', source: 'backend', status: 'blocked', exitCode: null, durationMs: 0, outputTail: '', truncated: false, reason: 'O script mudou desde a aprovação humana (aprovado: "a" · atual: "b"); aprove novamente em Workspaces.' },
  ],
  verificationsSkipped: null, verificationsInterrupted: null, reverifiedAt: '2026-10-23T19:56:01.685Z',
  previousVerifications: [{ at: 'x', verifications: [] }],
});

test('visão compacta: mantém tudo o que decide e remove só o que não decide nada', () => {
  const v = plannerReportView(sample());
  for (const k of ['status', 'summary', 'filesChanged', 'filesKnown', 'checks', 'checksReported', 'errors', 'blockers', 'exitCode', 'verificationsSkipped', 'verificationsInterrupted', 'reverifiedAt']) assert.ok(k in v, `mantém ${k}`);
  assert.deepEqual(v.filesChanged, sample().filesChanged); assert.deepEqual(v.checks, sample().checks); assert.deepEqual(v.errors, ['e1']); assert.deepEqual(v.blockers, ['b1']);
  assert.ok(!('usage' in v), 'custo do Executor não decide nada'); assert.ok(!('previousVerifications' in v), 'trilha de auditoria continua fora');
  const [t, b, l] = v.verifications;
  for (const x of v.verifications) {
    for (const k of ['id', 'script', 'required', 'status', 'exitCode', 'reason']) assert.ok(k in x, `${x.script} mantém ${k}`);
    for (const k of ['command', 'source', 'durationMs', 'truncated', 'outputBytes']) assert.ok(!(k in x), `${x.script} sem ${k}`);
  }
  assert.deepEqual([t.status, b.status, l.status], ['pass', 'fail', 'blocked']); assert.equal(t.exitCode, 0); assert.equal(b.exitCode, 1);
  assert.equal(l.reason, sample().verifications[2].reason, 'o motivo (inclusive "script mudou") continua na íntegra');
  assert.ok(!('outputTail' in l), 'saída vazia não vira campo');
});

test('saída das verificações: o FIM do texto, curto se passou e maior se falhou', () => {
  const [t, b] = plannerReportView(sample()).verifications;
  assert.equal(t.outputTail.length, PASS_TAIL); assert.ok(PASS_OUT.endsWith(t.outputTail)); assert.match(t.outputTail, /# pass 42\n# fail 0$/, 'o resumo dos testes (fim da saída) sobrevive');
  assert.equal(b.outputTail.length, FAIL_TAIL); assert.ok(FAIL_OUT.endsWith(b.outputTail)); assert.match(b.outputTail, /ERRO-FINAL: esperado 1, recebido 2$/, 'a pista da falha sobrevive');
  const short = plannerReportView({ ...sample(), verifications: [{ ...sample().verifications[0], outputTail: 'ok curto' }] }).verifications[0];
  assert.equal(short.outputTail, 'ok curto', 'saída pequena não é alterada');
});

test('a visão não altera o relatório gravado (só o texto do prompt)', () => {
  const rep = sample(), snapshot = JSON.stringify(rep);
  plannerReportView(rep); assert.equal(JSON.stringify(rep), snapshot);
  assert.deepEqual(plannerReportView({ status: 'failed', filesChanged: [], checks: [], errors: [], blockers: [] }).verifications, [], 'relatório sem verificações continua válido');
});

test('ciclo completo: o Planner ainda recebe a evidência, "complete" continua aceito e o prompt fica menor', async (t) => {
  const planner = scripted([cont('Criar out'), done()]);
  const s = setup(planner, verifierWith('pass', PASS_OUT));
  const c = await run(s);
  assert.equal(c.status, 'completed', c.blockedReason); assert.equal(c.assurance, 'verified', 'verificação obrigatória aprovada continua sendo a base da conclusão');
  const p = planner.calls[1], rep = lastJson(p);
  assert.equal(rep.status, 'success'); assert.ok(rep.filesChanged.some((f) => f.path === 'out.txt' && f.preexisting === false), 'arquivo criado nesta rodada continua listado');
  assert.deepEqual(rep.verifications.map((v) => [v.script, v.status, v.exitCode, v.required]), [['test', 'pass', 0, true]]);
  assert.match(rep.verifications[0].outputTail, /# pass 42/);
  assert.ok(!('usage' in rep) && !('command' in rep.verifications[0]));
  // a linha de verificações REAIS do histórico (fonte do estado atual) não mudou
  assert.match(p, /verificações REAIS \(executadas pelo orquestrador\): test=pass\(código 0\)/);
  assert.match(p, /VERIFICAÇÕES OBRIGATÓRIAS[^\n]*test/);
  const { previousVerifications, ...stored } = c.rounds[0].report;
  const sizeBefore = JSON.stringify(stored).length, sizeAfter = JSON.stringify(rep).length;
  assert.ok(sizeAfter < sizeBefore - 3000, `JSON do último relatório: ${sizeBefore} -> ${sizeAfter} caracteres`);
  t.diagnostic(`JSON do último relatório (fixture com saída de 3.640 caracteres): ${sizeBefore} -> ${sizeAfter} caracteres (-${Math.round((1 - sizeAfter / sizeBefore) * 100)}%); prompt inteiro: ${p.length + sizeBefore - sizeAfter} -> ${p.length} caracteres (-${Math.round(((sizeBefore - sizeAfter) / (p.length + sizeBefore - sizeAfter)) * 100)}%)`);
});

test('verificação que FALHOU: o Planner recebe status, código, motivo e o fim da saída', async () => {
  const planner = scripted([cont('Criar out'), blocked()]);
  const s = setup(planner, verifierWith('fail', FAIL_OUT));
  const c = await run(s);
  assert.equal(c.status, 'blocked');
  const p = planner.calls[1], v = lastJson(p).verifications[0];
  assert.deepEqual([v.status, v.exitCode, v.reason], ['fail', 1, 'Terminou com código 1.']);
  assert.match(v.outputTail, /ERRO-FINAL: esperado 1, recebido 2$/);
  assert.match(p, /test=fail\(código 1\)/); assert.match(p, /saída da primeira que não passou/);
});
