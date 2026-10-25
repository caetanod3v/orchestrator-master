// B4: o progresso do ciclo só conta evidência INDEPENDENTE do agente (arquivos novos, verificações REAIS aprovadas, workspace sem Git).
// Checks "pass" autodeclarados pelo Executor não evitam o bloqueio no_progress. CLIs inline temporárias, banco e workspaces
// TEMPORÁRIOS, Planner e verificador SIMULADOS: nenhuma CLI real, nenhum modelo, nenhum dado real.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-progress-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const gitWs = path.join(tmp, 'git-ws'), plainWs = path.join(tmp, 'plain-ws');
fs.mkdirSync(gitWs); execFileSync('git', ['init', '-q'], { cwd: gitWs }); fs.writeFileSync(path.join(gitWs, 'LEIAME.md'), 'x\n');
fs.mkdirSync(plainWs);                                                                      // sem .git: filesKnown = false
const counter = path.join(tmp, 'n.txt');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');

let db, seq = 0;
before(() => { db = store.load(); db.missions = []; db.workspaces = [{ id: 'git', name: 'git', path: gitWs }, { id: 'plain', name: 'plain', path: plainWs }]; });
after(async () => { await new Promise((r) => setTimeout(r, 600)); fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * CLI inline: a cada execução incrementa um contador (arquivo temporário), declara `declare(n)` checks "pass" e, se `write`,
 * cria um arquivo NOVO no workspace (cwd). O resultado final é sempre emitido (execução bem-sucedida).
 */
function cli({ declare = () => 0, write = false }) {
  const code = `process.stdin.resume(); process.stdin.on('end', () => {
    const fs = require('fs'), f = ${JSON.stringify(counter)};
    const n = (fs.existsSync(f) ? +fs.readFileSync(f, 'utf8') : 0) + 1; fs.writeFileSync(f, String(n));
    ${write ? "fs.writeFileSync('novo-' + n + '.txt', 'x');" : ''}
    const k = (${declare.toString()})(n), checks = Array.from({ length: k }, (_, i) => ({ name: 'conferi ' + i, result: 'pass', detail: 'ok' }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'feito\\n\`\`\`json\\n' + JSON.stringify({ summary: 'ok', checks }) + '\\n\`\`\`', total_cost_usd: 0.001, num_turns: 1 }));
    process.exit(0); });`;
  return createExecutor({ command: process.execPath, prefixArgs: ['-e', code], args: [] });
}
const cont = (t) => JSON.stringify({ decision: 'continue', rationale: 'r', task: { title: t, instructions: `fazer ${t}`, acceptance: ['a'] } });
const done = JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['checks do executor'] });
const planner = (answers) => ({ calls: [], busy: () => false, cancel: async () => {}, decide: async function () { this.calls.push(1); const a = answers.shift(); return a ? { text: a } : { error: 'fim do roteiro' }; } });

async function run({ executor, ws = 'git', answers, max = 4, verifier = null, verifications = [] }) {
  fs.rmSync(counter, { force: true });
  db.workspaces.find((w) => w.id === ws).verifications = verifications;
  const { startTaskRun } = setupExecution(express(), { db, executor });
  const cy = createCycle({ db, executor, planner: planner(answers), startTaskRun, verifier, listFiles: () => [] });
  const m = { id: `p${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: ws, createdAt: store.now(), tasks: [] }; db.missions.push(m);
  const origErr = console.error; console.error = () => {};
  try { assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle(); } finally { console.error = origErr; }
  return m.cycle;
}
const titles = ['A', 'B', 'C', 'D', 'E'].map((t) => cont(`Tarefa ${t}`));

test('checks autodeclarados crescentes SEM arquivos novos não evitam no_progress (a rodada 2 já bloqueia)', async () => {
  const c = await run({ executor: cli({ declare: (n) => n }), answers: [...titles] });         // rodada n declara n checks "pass"
  assert.deepEqual(c.rounds.map((r) => r.report.checks.length), [1, 2], 'o Executor realmente declarou checks crescentes');
  assert.ok(c.rounds.every((r) => r.report.filesChanged.every((f) => f.preexisting)), 'nenhum arquivo novo');
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'no_progress'); assert.equal(c.rounds.length, 2);
  assert.equal(c.consecutiveNoProgress, 2);
});

test('CONTROLE: pela regra antiga (passCount com autodeclaração) cada rodada desse cenário contaria como progresso', async () => {
  // Reconstitui a regra antiga com os dados REAIS do relatório: se este controle parar de dar "progresso", o cenário acima perdeu o sentido.
  const c = await run({ executor: cli({ declare: (n) => n }), answers: [...titles] });
  const oldPass = (r) => (r?.checks || []).filter((x) => x.result === 'pass').length + (r?.verifications || []).filter((v) => v.status === 'pass').length;
  const oldProgress = c.rounds.map((r, i) => oldPass(r.report) > oldPass(c.rounds[i - 1]?.report));
  assert.deepEqual(oldProgress, [true, true], 'pela regra antiga cada rodada contaria como progresso (e o ciclo nunca pararia aqui)');
  assert.equal(c.blockedCode, 'no_progress', 'pela regra nova para');
});

test('arquivos NOVOS continuam contando como progresso (mesmo sem declarar nada)', async () => {
  const c = await run({ executor: cli({ write: true }), answers: [...titles], max: 4 });
  assert.equal(c.rounds.length, 4); assert.equal(c.status, 'limit_reached'); assert.equal(c.consecutiveNoProgress, 0);
  assert.ok(c.rounds.every((r) => r.report.filesChanged.some((f) => !f.preexisting && /^novo-\d+\.txt$/.test(f.path))));
  for (const f of fs.readdirSync(gitWs).filter((x) => x.startsWith('novo-'))) fs.rmSync(path.join(gitWs, f));
});

test('aumento de verificações REAIS aprovadas continua contando como progresso (sem arquivos novos)', async () => {
  // rodada 1: test=pass, lint=fail (1 real pass) | rodada 2: test=pass, lint=pass (2 > 1) | rodadas 3 e 4: 2 = 2 (sem progresso) => no_progress na 4
  let round = 0;
  const verifier = { isBusy: () => false, stop: async () => ({}), run: async (w, item) => {
    if (item.script === 'test') round++;
    const status = item.script === 'lint' && round < 2 ? 'fail' : 'pass';
    return { id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status, exitCode: status === 'pass' ? 0 : 1, durationMs: 1, outputTail: '', truncated: false, reason: status === 'pass' ? null : 'falhou' }; } };
  const verifications = ['test', 'lint'].map((s) => ({ id: s, script: s, command: 'x', required: false, timeoutMs: 1000 }));
  const c = await run({ executor: cli({ declare: () => 0 }), answers: [...titles], verifier, verifications });
  assert.deepEqual(c.rounds.map((r) => r.report.verifications.filter((v) => v.status === 'pass').length), [1, 2, 2, 2]);
  assert.ok(c.rounds.every((r) => r.report.filesChanged.every((f) => f.preexisting)));
  assert.equal(c.rounds.length, 4); assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'no_progress');
});

test('conclusão com checks autodeclarados e sem verificações obrigatórias continua funcionando (rotulada self-declared)', async () => {
  const c = await run({ executor: cli({ declare: () => 1 }), answers: [cont('Única'), done] });
  assert.equal(c.status, 'completed'); assert.equal(c.assurance, 'self-declared'); assert.equal(c.rounds.length, 1);
  assert.equal(c.rounds[0].report.checks[0].result, 'pass');
});

test('workspace SEM Git mantém o comportamento atual: filesKnown=false conta sempre como progresso', async () => {
  const c = await run({ executor: cli({ declare: () => 0 }), ws: 'plain', answers: [...titles], max: 4 });
  assert.ok(c.rounds.every((r) => r.report.filesKnown === false));
  assert.equal(c.rounds.length, 4); assert.equal(c.status, 'limit_reached'); assert.equal(c.consecutiveNoProgress, 0);
});
