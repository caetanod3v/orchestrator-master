// B3: código de saída 0 SEM o evento `result` nunca é "completed". CLIs inline temporárias (node -e), banco TEMPORÁRIO,
// workspace TEMPORÁRIO e Planner SIMULADO: nenhuma CLI real, nenhum modelo, nenhum dado real.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-noresult-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { createClaudePlanner } = await import('../planner.js');

let db, seq = 0;
before(() => { db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }]; });
after(async () => { await new Promise((r) => setTimeout(r, 600)); fs.rmSync(tmp, { recursive: true, force: true }); });

/** CLI inline: lê o prompt até o fim do stdin, executa `body` (que pode escrever no stdout) e sai com código 0. `--version` também sai com 0. */
const cli = (body = '') => createExecutor({ command: process.execPath, prefixArgs: ['-e', `process.stdin.resume(); process.stdin.on('end', () => { ${body} process.exit(0); });`], args: [] });
const RESULT = (text) => `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(text)}, total_cost_usd: 0.001, num_turns: 1 }));`;
const run = (ex, lines = []) => ex.start({ missionId: 'm', taskId: 't', cwd: wsDir, prompt: 'tarefa', onLine: (l) => lines.push(l) }).done;
const NO_RESULT = /não emitiu o resultado final/;

test('código 0 sem nenhuma saída: failed, sem resultado, com mensagem clara e lock liberado', async () => {
  const ex = cli(''), r = await run(ex);
  assert.equal(r.status, 'failed'); assert.equal(r.exitCode, 0); assert.equal(r.result, null); assert.match(r.error, NO_RESULT);
  assert.equal(ex.isBusy(), false);
});

test('código 0 só com texto bruto (sem evento result): failed; o texto continua visível no log', async () => {
  const lines = [], r = await run(cli("console.log('olá, isto não é JSON');"), lines);
  assert.equal(r.status, 'failed'); assert.equal(r.result, null); assert.match(r.error, NO_RESULT);
  assert.ok(lines.some((l) => l.includes('olá, isto não é JSON')), 'a saída bruta não é descartada');
});

test('código 0 com eventos intermediários, mas sem result, também é failed', async () => {
  const body = "console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm' })); console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'trabalhando' }] } }));";
  const r = await run(cli(body));
  assert.equal(r.status, 'failed'); assert.match(r.error, NO_RESULT);
});

test('código 0 com result válido: completed (comportamento preservado)', async () => {
  const r = await run(cli(RESULT('Relatório final.')));
  assert.equal(r.status, 'completed'); assert.equal(r.error, null); assert.equal(r.result.text, 'Relatório final.');
});

test('código 0 com result de TEXTO VAZIO: continua completed (decisão: result presente comprova o fim)', async () => {
  const r = await run(cli(RESULT('')));
  assert.equal(r.status, 'completed'); assert.equal(r.result.text, ''); assert.equal(r.error, null);
});

test('as demais saídas não mudaram: result com is_error, código ≠ 0 e timeout continuam failed; interrupção continua interrupted', async () => {
  const isErr = await run(cli("console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'quebrou' }));"));
  assert.equal(isErr.status, 'failed'); assert.match(isErr.error, /A CLI reportou erro: quebrou/);
  const code3 = await run(createExecutor({ command: process.execPath, prefixArgs: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(3));"], args: [] }));
  assert.equal(code3.status, 'failed'); assert.match(code3.error, /código 3/); assert.doesNotMatch(code3.error, NO_RESULT);
  const slow = createExecutor({ command: process.execPath, prefixArgs: ['-e', 'setInterval(() => {}, 1000)'], args: [], timeoutMs: 400 });
  const timed = await run(slow); assert.equal(timed.status, 'failed'); assert.match(timed.error, /Tempo máximo/);
  const sleeper = createExecutor({ command: process.execPath, prefixArgs: ['-e', 'setInterval(() => {}, 1000)'], args: [] });
  const h = sleeper.start({ missionId: 'm', taskId: 't', cwd: wsDir, prompt: 'x', onLine() {} });
  await sleeper.stop(); assert.equal((await h.done).status, 'interrupted');
});

test('execução manual (startTaskRun): sem result a tarefa vira failed, não awaiting_approval; com result segue para revisão', async () => {
  const mission = { id: `mm${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', tasks: [] }; db.missions.push(mission);
  const mkTask = () => { const t = { id: `t${++seq}`, title: 'Tarefa', status: 'queued', authorized: true, dependsOn: [], report: '', files: [], log: [] }; mission.tasks.push(t); return t; };
  for (const [body, status] of [['', 'failed'], [RESULT('Feito.'), 'awaiting_approval']]) {
    const executor = cli(body), { startTaskRun } = setupExecution(express(), { db, executor });
    const task = mkTask();
    const r = await startTaskRun(mission, task); assert.equal(r.ok, true); await r.finished;
    assert.equal(task.status, status);
    if (status === 'failed') { assert.match(task.error, NO_RESULT); assert.match(task.report, /^Sem relatório: /); assert.equal(task.usage, null); assert.equal(task.exitCode, 0); }
  }
});

test('ciclo: a falha entra no relatório e no Planner, conta em consecutiveFailures e duas seguidas bloqueiam (executor_failures)', async () => {
  const mission = { id: `mc${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: store.now(), tasks: [] }; db.missions.push(mission);
  const executor = cli(''), { startTaskRun } = setupExecution(express(), { db, executor });
  const prompts = [], titles = ['Primeira', 'Segunda', 'Terceira'];
  const planner = { busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { prompts.push(prompt); return { text: JSON.stringify({ decision: 'continue', rationale: 'r', task: { title: `${titles.shift()} tarefa`, instructions: 'i', acceptance: ['a'] } }) }; } };
  const cy = createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });
  assert.equal((await cy.start(mission.id, 5)).status, 202); await cy.idle();
  const c = mission.cycle;
  assert.equal(c.rounds.length, 2); assert.deepEqual(c.rounds.map((r) => r.status), ['failed', 'failed']);
  assert.equal(c.rounds[0].report.status, 'failed'); assert.ok(c.rounds[0].report.errors.some((e) => NO_RESULT.test(e)), 'o erro está no relatório');
  assert.equal(mission.tasks.every((t) => t.status === 'failed'), true);
  assert.equal(c.consecutiveFailures, 2); assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'executor_failures');
  assert.equal(prompts.length, 2, 'depois da 2ª falha seguida o Planner não é consultado');
  const hist = prompts[1].slice(prompts[1].indexOf('HISTÓRICO:'));
  assert.match(hist, /execução: failed \| erros: .*não emitiu o resultado final/);
  assert.doesNotMatch(hist, /execução: success/);
});

test('Planner: saída com código 0 sem result é erro (não decisão)', async () => {
  const planner = createClaudePlanner({ runner: cli('') });
  const r = await planner.decide({ prompt: 'p', cwd: wsDir });
  assert.match(r.error, NO_RESULT); assert.equal(r.text, undefined);
});
