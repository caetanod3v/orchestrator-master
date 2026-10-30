// M3: retomada explícita de um ciclo parado por limite. Banco TEMPORÁRIO, workspace TEMPORÁRIO, CLI FALSA, Planner e verificador SIMULADOS; nenhum modelo é chamado.
// Arquivo próprio (processo próprio): o último teste faz save() lançar de verdade (EISDIR) e não pode colidir com gravações adiadas de outros arquivos.
// Cobre o que cycle-limits.test.mjs ainda não cobria: limit_reached (limite de RODADAS) retomável, persistência/reinício dessa pausa e mensagens de recusa.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-limresume-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json'), BLOCK_TMP = `${DB_FILE}.tmp`; // diretório no lugar do .tmp => EISDIR (erro NÃO transitório)
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { missionStatus } = await import('../mission-status.js');

let db, executor, startTaskRun, seq = 0, execStarts = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const counted = new Proxy(executor, { get: (t, k) => (k === 'start' ? (o) => { execStarts++; return t.start(o); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }); // conta as execuções realmente iniciadas
  ({ startTaskRun } = setupExecution(express(), { db, executor: counted }));
});
after(async () => { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

const cont = (title) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:check ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const metrics = (cost) => { const t = { input: 2, output: 100, cacheCreation: 50, cacheRead: 20 }; return { final: { tokens: t, tokensAllModels: t, costUsd: cost, models: { m: { ...t, thinking: 0, costUsd: cost } } }, live: null, rateLimit: null }; };
const scripted = (answers, { cost = 0.01 } = {}) => {
  const calls = [];
  return { calls, answers, busy: () => false, cancel: async () => {},
    decide: async () => { calls.push(1); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x, usage: cost === 'none' ? { costUsd: null, turns: 1 } : { costUsd: cost, turns: 1, metrics: metrics(cost) } }; } };
};
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }),
  run: async (w, item) => ({ id: item.id, script: item.script, required: item.required, command: `npm run ${item.script}`, source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null }) });
const lim = (calls = null, cost = null) => ({ maxPlannerCalls: calls, maxEstimatedCostUsd: cost });
const mk = (m, planner, limits = null, database = db) => createCycle({ db: database, executor, planner, startTaskRun, verifier: verifier(), listFiles: () => ['config.json'], limits });
async function run(answers, { limits = null, max = 2, plannerOpts } = {}) {
  const m = { id: `m3_${++seq}`, demo: false, title: `Missão M3 ${seq}`, objective: 'obj', workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m);
  const planner = scripted(answers, plannerOpts), cy = mk(m, planner, limits), s0 = execStarts;
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy, planner, answers, starts: () => execStarts - s0 };
}
const onDisk = (m) => JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === m.id);

test('limite de rodadas: a pausa (limit_reached) é distinta de concluído, fica gravada em disco e sobrevive a uma reinicialização sem virar ativa', async () => {
  const r = await run([cont('A'), cont('B'), cont('C'), cont('D'), done()]);
  assert.equal(r.c.status, 'limit_reached'); assert.equal(r.c.rounds.length, 2); assert.equal(r.c.plannerCalls, 3); assert.ok(r.c.finishedAt);
  assert.ok(!r.c.finalSummary && !r.c.assurance, 'pausa por limite nunca vira conclusão'); assert.equal(missionStatus(r.m), 'limit_reached');
  const disk = onDisk(r.m); assert.equal(disk.cycle.status, 'limit_reached'); assert.equal(disk.cycle.rounds.length, 2); assert.equal(disk.cycle.plannerCalls, 3); assert.equal(disk.cycle.finishedAt, r.c.finishedAt);

  // "reinício": outro createCycle sobre o banco LIDO DO DISCO; recover() não pode ativar nem bloquear de novo uma pausa por limite
  const db2 = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')), calls = r.planner.calls.length, starts = execStarts;
  const cy2 = mk(null, r.planner, null, db2); cy2.recover(); await cy2.idle();
  const m2 = db2.missions.find((x) => x.id === r.m.id);
  assert.equal(m2.cycle.status, 'limit_reached'); assert.equal(missionStatus(m2), 'limit_reached'); assert.equal(m2.cycle.finishedAt, r.c.finishedAt);
  assert.equal(r.planner.calls.length, calls, 'nenhuma chamada ao Planner por conta própria'); assert.equal(execStarts, starts, 'nenhuma execução por conta própria');
});

test('o limite de chamadas ao Planner também pausa (blocked, não ativo) e a pausa persiste e sobrevive à reinicialização', async () => {
  const r = await run([cont('A'), cont('B'), done()], { limits: lim(2), max: 5 });
  assert.equal(r.c.status, 'blocked'); assert.equal(r.c.blockedCode, 'planner_call_cap'); assert.equal(missionStatus(r.m), 'blocked');
  assert.equal(onDisk(r.m).cycle.blockedCode, 'planner_call_cap');
  const db2 = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')), calls = r.planner.calls.length, starts = execStarts;
  const cy2 = mk(null, r.planner, lim(2), db2); cy2.recover(); await cy2.idle();
  const m2 = db2.missions.find((x) => x.id === r.m.id);
  assert.equal(m2.cycle.status, 'blocked'); assert.equal(m2.cycle.blockedCode, 'planner_call_cap', 'continua pausado pelo mesmo limite (não virou "restarted" nem ativo)');
  assert.equal(r.planner.calls.length, calls); assert.equal(execStarts, starts);
});

test('limit_reached só retoma com um novo limite de rodadas explícito e maior que as rodadas feitas; recusa sem mutar nada nem chamar o Planner', async () => {
  const r = await run([cont('A'), cont('B'), cont('C'), done()]);
  const snap = JSON.stringify(r.c), calls = r.planner.calls.length, starts = execStarts;
  for (const body of [undefined, {}, { note: 'segue' }, { maxIterations: 2 }]) {
    const x = await r.cy.resume(r.m.id, body);
    assert.equal(x.status, 409, JSON.stringify(body)); assert.match(x.error, /limite de 2 rodadas \(2 feitas\)/); assert.match(x.error, /maxIterations\) maior que 2/);
  }
  assert.equal((await r.cy.resume(r.m.id, { maxIterations: 11 })).status, 400, 'acima do teto'); assert.equal((await r.cy.resume(r.m.id, { maxIterations: 1 })).status, 400, 'abaixo das rodadas feitas');
  assert.equal(JSON.stringify(r.c), snap, 'nada mudou'); assert.equal(r.planner.calls.length, calls); assert.equal(execStarts, starts);
  assert.equal((await r.cy.cancel(r.m.id)).status, 409, 'limit_reached continua sem cancelamento (já não há nada ativo)');
});

test('retomada explícita: mantém missão, histórico e rodadas concluídas, não repete nenhuma etapa, soma os contadores e conclui com verificação real', async () => {
  const r = await run([cont('A'), cont('B'), cont('C'), cont('D'), done()]);
  assert.equal(r.c.status, 'limit_reached');
  const before_ = { rounds: r.c.rounds.map((x) => ({ n: x.n, taskId: x.taskId, finishedAt: x.finishedAt, report: JSON.stringify(x.report) })), tasks: r.m.tasks.map((t) => [t.id, t.startedAt, t.status]), blocks: JSON.stringify(r.c.blocks), id: r.c.id, startedAt: r.c.startedAt };
  const starts = execStarts, calls = r.planner.calls.length;
  const res = await r.cy.resume(r.m.id, { maxIterations: 4, note: 'siga com D' });
  assert.equal(res.status, 202); assert.equal(r.c.status, 'planning'); assert.equal(r.c.finishedAt, null, 'já não é um estado final'); assert.equal(missionStatus(r.m), 'running');
  assert.equal(r.c.maxIterations, 4); assert.equal(r.c.cancelRequested, false);
  await r.cy.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.assurance, 'verified'); assert.ok(r.c.finishedAt);
  assert.equal(r.c.id, before_.id, 'mesmo ciclo'); assert.equal(r.c.startedAt, before_.startedAt); assert.equal(r.m.pastCycles, undefined, 'retomar não arquiva nem cria outro ciclo');
  assert.equal(r.c.rounds.length, 3); assert.equal(execStarts - starts, 1, 'só a rodada nova executou');
  r.c.rounds.slice(0, 2).forEach((x, i) => assert.deepEqual({ n: x.n, taskId: x.taskId, finishedAt: x.finishedAt, report: JSON.stringify(x.report) }, before_.rounds[i], `rodada ${i + 1} intacta`));
  assert.deepEqual(r.m.tasks.slice(0, 2).map((t) => [t.id, t.startedAt, t.status]), before_.tasks); assert.equal(r.m.tasks.length, 3);
  assert.equal(JSON.stringify(r.c.blocks), before_.blocks); assert.deepEqual(r.c.humanNotes.map((n) => n.text), ['siga com D']);
  assert.equal(r.c.plannerCalls, 5, 'contador cumulativo: não foi zerado'); assert.equal(r.planner.calls.length - calls, 2);
  assert.ok(db.activity.some((a) => a.missionId === r.m.id && /Ciclo retomado por um humano/.test(a.message)));
  const disk = onDisk(r.m); assert.equal(disk.cycle.status, 'completed'); assert.equal(disk.cycle.rounds.length, 3);
});

test('o limite de chamadas ao Planner continua valendo depois do limite de rodadas: a retomada é recusada até o limite ser aumentado', async () => {
  const r = await run([cont('A'), cont('B'), cont('C'), done()], { limits: lim(3) });
  assert.equal(r.c.status, 'limit_reached'); assert.equal(r.c.plannerCalls, 3);
  const snap = JSON.stringify(r.c), calls = r.planner.calls.length, starts = execStarts;
  const refused = await r.cy.resume(r.m.id, { maxIterations: 5 });
  assert.equal(refused.status, 409); assert.match(refused.error, /Limite de 3 chamada/); assert.match(refused.error, /ORCH_CYCLE_MAX_PLANNER_CALLS/); assert.match(refused.error, /reinicie o servidor/);
  assert.equal(JSON.stringify(r.c), snap, 'continua limit_reached, com finishedAt'); assert.equal(r.planner.calls.length, calls); assert.equal(execStarts, starts);
  const again = mk(r.m, r.planner, lim(3)); assert.equal((await again.resume(r.m.id, { maxIterations: 5 })).status, 409, 'um novo createCycle com o mesmo limite também recusa (o estado vem do banco)');
  const raised = mk(r.m, r.planner, lim(10));
  assert.equal((await raised.resume(r.m.id, { maxIterations: 5 })).status, 202); await raised.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(r.c.plannerCalls, 4);
});

test('orçamento de custo estimado: a recusa explica a condição, sem prometer cobrança exata; custo desconhecido não manda "aumentar"', async () => {
  const r = await run([cont('A'), cont('B'), done()], { limits: lim(null, 0.02), max: 1 }); // 0,01 + 0,002 (rodada) + 0,01 = 0,022 >= 0,02
  assert.equal(r.c.status, 'limit_reached');
  const refused = await r.cy.resume(r.m.id, { maxIterations: 3 });
  assert.equal(refused.status, 409); assert.match(refused.error, /ESTIMADO/); assert.match(refused.error, /estimativa da CLI, não a cobrança real nem um teto garantido/); assert.match(refused.error, /ORCH_CYCLE_MAX_ESTIMATED_COST_USD/); assert.equal(r.c.status, 'limit_reached');
  const raised = mk(r.m, r.planner, lim(null, 5)); r.answers.push(done());
  assert.equal((await raised.resume(r.m.id, { maxIterations: 3 })).status, 202); await raised.idle(); assert.equal(r.c.status, 'completed', r.c.blockedReason);

  const u = await run([cont('A'), done()], { limits: lim(null, 100), plannerOpts: { cost: 'none' }, max: 5 });
  assert.equal(u.c.blockedCode, 'cost_budget_unknown');
  const x = await u.cy.resume(u.m.id); assert.equal(x.status, 409);
  assert.match(x.error, /desative ORCH_CYCLE_MAX_ESTIMATED_COST_USD/); assert.doesNotMatch(x.error, /aumente ORCH_CYCLE_MAX_ESTIMATED_COST_USD/, 'aumentar o valor não resolveria custo desconhecido');
});

test('persistência: falha ao gravar a retomada não deixa o ciclo avançar (rollback a limit_reached idêntico), e depois de normalizar a retomada funciona', async () => {
  const r = await run([cont('A'), cont('B'), cont('C'), done()]);
  assert.equal(r.c.status, 'limit_reached');
  const snap = JSON.stringify(r.c), calls = r.planner.calls.length, starts = execStarts, origErr = console.error;
  fs.mkdirSync(BLOCK_TMP);                                          // save() passa a lançar EISDIR (não transitório)
  try {
    console.error = () => {};
    const failed = await r.cy.resume(r.m.id, { maxIterations: 4, note: 'não deve valer' });
    assert.equal(failed.status, 500); assert.match(failed.error, /Falha ao retomar o ciclo: .*EISDIR/);
    assert.equal(JSON.stringify(r.c), snap, 'volta a limit_reached com finishedAt, sem a nota nem o novo limite'); await r.cy.idle();
    const again = await r.cy.resume(r.m.id, { maxIterations: 4 }); // o banco segue sem gravar: 503, nada iniciado nem alterado
    assert.equal(again.status, 503); assert.match(again.error, /Nada foi iniciado nem retomado/);
    assert.equal(JSON.stringify(r.c), snap);
  } finally { console.error = origErr; fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
  assert.equal(r.planner.calls.length, calls, 'o Planner não foi consultado'); assert.equal(execStarts, starts, 'nenhuma execução iniciada');
  assert.equal((await r.cy.resume(r.m.id, { maxIterations: 4 })).status, 202); await r.cy.idle();
  assert.equal(r.c.status, 'completed', r.c.blockedReason); assert.equal(onDisk(r.m).cycle.status, 'completed');
});
