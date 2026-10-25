// P5: autorização residual de tarefa de ciclo depois de uma queda. Fixtures de banco, CLI FALSA, Planner SIMULADO e diretórios TEMPORÁRIOS:
// nenhum servidor real, nenhum processo real é criado ou encerrado (o PID do cenário P4 é fictício e as ferramentas de órfãos são injetadas).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-p5-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution, blockedReason } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { runBlockers, authorizeBlockers } = await import('../executor/policy.js');
const { validateDir } = await import('../workspaces.js');

let db, seq = 0;
before(() => { db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir }]; });
after(async () => { await new Promise((r) => setTimeout(r, 600)); fs.rmSync(tmp, { recursive: true, force: true }); });

const T0 = '2026-01-01T00:00:00.000Z';
const task = (over = {}) => ({ id: `t${++seq}`, title: `Tarefa ${seq}`, status: 'queued', authorized: true, authorizedBy: 'cycle', auto: true, dependsOn: [], report: '', files: [], log: [], instructions: 'i', acceptance: ['a'], ...over });
const round = (t, over = {}) => ({ n: 1, status: 'running', taskId: t.id, fingerprint: `f${seq}`, plan: { rationale: 'r', title: t.title, instructions: 'i', acceptance: ['a'] }, startedAt: T0, finishedAt: null, report: null, decision: null, ...over });
const cycleOf = (status, rounds, over = {}) => ({ id: `cyc${++seq}`, status, maxIterations: 3, plannerCalls: 1, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null, finalSummary: null, evidence: null, cancelRequested: false, startedAt: T0, finishedAt: null, rounds, ...over });
const mission = (tasks, cycle) => { const m = { id: `m${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'ws', createdAt: T0, tasks, ...(cycle ? { cycle } : {}) }; db.missions.push(m); return m; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const disk = (m) => JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === m.id);
const acts = (t) => db.activity.filter((a) => a.taskId === t.id && /interrompida antes de iniciar/.test(a.message));
const newExec = () => createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const a = answers.shift(); return a === undefined ? { error: 'roteiro acabou' } : { text: a }; } }; };
/** Cada teste parte de um banco vazio (sem PIDs nem tarefas de outros testes). `boot: true` roda também o setupExecution (P4) com a startTaskRun real. */
const reset = () => { db.missions = []; db.activity = []; };
function setup(planner = scripted([]), { boot = false } = {}) {
  const executor = newExec(), { startTaskRun } = boot ? setupExecution(express(), { db, executor }) : { startTaskRun: async () => ({ ok: false, reason: 'não usado neste teste' }) };
  const cy = createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });
  return { executor, startTaskRun, cy };
}
const isNormalized = (t) => t.status === 'interrupted' && t.authorized === false && /reiniciado antes de a execução começar/.test(t.error) && !!t.finishedAt && t.log.some((l) => /autorização do ciclo foi revogada/.test(l));

test('queda na janela do início da rodada: tarefa automática queued/autorizada vira interrupted, rodada e ciclo seguem a recuperação existente', () => {
  reset();
  const t = task(), m = mission([t], cycleOf('running', [round(t)]));
  const { cy } = setup(); cy.recover();
  assert.ok(isNormalized(t), JSON.stringify(t)); assert.equal(t.startedAt, undefined, 'campos que não precisam mudar não foram tocados');
  const r = m.cycle.rounds[0];
  assert.equal(r.status, 'interrupted'); assert.equal(r.phase, 'done'); assert.ok(r.finishedAt); assert.equal(r.report.status, 'interrupted'); assert.ok(r.report.errors.some((e) => /reiniciado antes de a execução começar/.test(e)), 'o relatório da rodada reflete a tarefa normalizada');
  assert.equal(m.cycle.status, 'blocked'); assert.equal(m.cycle.blockedCode, 'restarted');
  assert.equal(acts(t).length, 1, 'uma atividade coerente com as existentes'); assert.equal(acts(t)[0].type, 'execution'); assert.equal(acts(t)[0].agent, 'executor');
  const d = disk(m).tasks[0]; assert.equal(d.status, 'interrupted'); assert.equal(d.authorized, false); assert.equal(disk(m).cycle.blockedCode, 'restarted');
});

test('resíduos legados em ciclos blocked, cancelled, completed e limit_reached são limpos no boot; o resto do ciclo não muda', () => {
  reset();
  for (const status of ['blocked', 'cancelled', 'completed', 'limit_reached']) {
    const done = task({ status: 'completed', authorized: false, report: 'ok' }), t = task();
    const m = mission([done, t], cycleOf(status, [round(done, { status: 'succeeded', finishedAt: T0 })], status === 'blocked' ? { blockedCode: 'planner_blocked', blockedReason: 'x' } : { finishedAt: T0 }));
    const cycleBefore = clone(m.cycle), doneBefore = clone(done);
    const { cy } = setup(); cy.recover();
    assert.ok(isNormalized(t), status); assert.deepEqual(m.cycle, cycleBefore, `${status}: ciclo e rodadas intactos`); assert.deepEqual(done, doneBefore);
    assert.equal(acts(t).length, 1, status); assert.equal(disk(m).tasks[1].authorized, false, `${status}: gravado no disco (mesmo sem ciclo ativo)`);
  }
  const semCiclo = task(), m2 = mission([semCiclo]);                              // tarefa automática de missão sem ciclo (dado antigo)
  setup().cy.recover(); assert.ok(isNormalized(semCiclo)); assert.equal(m2.cycle, undefined);
});

test('preservação: manuais, automáticas em outros estados e tarefas com PID (P4) não são alteradas', () => {
  reset();
  const keep = {
    manualAutorizada: task({ auto: undefined, authorizedBy: undefined }), automaticaNaoAutorizada: task({ authorized: false }),
    completed: task({ status: 'completed', authorized: false }), failed: task({ status: 'failed', authorized: false, error: 'x' }), interrupted: task({ status: 'interrupted', authorized: false, error: 'y' }),
    aguardando: task({ status: 'awaiting_approval', authorized: false }), running: task({ status: 'running', authorized: false }), comPid: task({ pid: 4242, startedAt: T0 }),
  };
  const m = mission(Object.values(keep), cycleOf('blocked', [], { blockedCode: 'planner_blocked' }));
  const before = clone(m.tasks), actsBefore = db.activity.length;
  setup().cy.recover();
  assert.equal(JSON.stringify(m.tasks), JSON.stringify(before), 'nenhum campo de nenhuma delas mudou'); assert.equal(db.activity.length, actsBefore, 'nenhuma atividade nova');
  assert.equal(keep.manualAutorizada.authorized, true, 'a autorização humana de tarefa manual persiste');
});

test('autorização EXPLÍCITA de um humano (authorizedAt) em tarefa automática queued permanece intacta: sem alteração, sem atividade e sem timestamp novo', () => {
  reset();
  const humana = task({ authorizedAt: '2026-02-02T10:00:00.000Z' }), residuo = task();                    // a 1ª foi reautorizada pelo usuário; a 2ª é resíduo genuíno do ciclo
  const m = mission([humana, residuo], cycleOf('blocked', [round(humana, { status: 'interrupted', finishedAt: T0 })], { blockedCode: 'planner_blocked' }));
  const humanaAntes = JSON.stringify(humana);
  setup().cy.recover();
  assert.equal(JSON.stringify(humana), humanaAntes, 'nenhum campo mudou, inclusive status, authorized, authorizedAt, log e (ausência de) finishedAt');
  assert.equal(humana.status, 'queued'); assert.equal(humana.authorized, true); assert.equal(humana.authorizedAt, '2026-02-02T10:00:00.000Z'); assert.equal(humana.finishedAt, undefined);
  assert.equal(acts(humana).length, 0, 'nenhuma atividade para a autorização humana'); assert.ok(isNormalized(residuo), 'o resíduo genuíno do ciclo continua sendo normalizado');
  assert.equal(acts(residuo).length, 1);
  // a autorização humana continua valendo depois de recover() repetido e já está gravada no disco
  setup().cy.recover(); assert.equal(JSON.stringify(humana), humanaAntes);
  const d = disk(m).tasks[0]; assert.equal(d.authorized, true); assert.equal(d.authorizedAt, '2026-02-02T10:00:00.000Z'); assert.equal(d.status, 'queued');
  // e, como antes, ela é executável (a decisão foi do usuário, não do ciclo)
  const args = { mission: m, task: humana, workspace: db.workspaces[0], validateDir, busy: false, cliAvailable: true };
  assert.equal(runBlockers(args), null);
});

test('idempotência: recover() repetido (e em outra instância do ciclo) não muda nada nem duplica atividades', () => {
  reset();
  const t = task(), m = mission([t], cycleOf('running', [round(t)]));
  setup().cy.recover();
  const snap = clone(db.missions), n = db.activity.length, diskBefore = fs.readFileSync(DB_FILE, 'utf8');
  setup().cy.recover(); setup().cy.recover();
  assert.deepEqual(db.missions, snap); assert.equal(db.activity.length, n); assert.equal(acts(t).length, 1);
  assert.equal(m.cycle.blocks.filter((b) => b.code === 'restarted').length, 1, 'e o ciclo já bloqueado não é bloqueado de novo');
  assert.equal(fs.readFileSync(DB_FILE, 'utf8'), diskBefore, 'nada novo gravado');
});

test('a tarefa normalizada não pode ser executada por acidente (runBlockers, blockedReason, startTaskRun); antes da correção ela seria executável', async () => {
  reset();
  const t = task(), m = mission([t], cycleOf('blocked', [round(t, { status: 'interrupted', finishedAt: T0 })], { blockedCode: 'restarted' }));
  const { executor, startTaskRun, cy } = setup(undefined, { boot: true });
  const args = (task_) => ({ mission: m, task: task_, workspace: db.workspaces[0], validateDir, busy: false, cliAvailable: true });
  assert.equal(runBlockers(args(t)), null, 'CONTROLE: o resíduo, como estava gravado, passava por todas as checagens (a UI mostraria "Executar")');
  cy.recover();
  assert.match(runBlockers(args(t)), /Autorize uma nova tentativa/); assert.ok(blockedReason(db, executor, m, t), 'a API mostra o motivo e o botão Executar fica desabilitado');
  const r = await startTaskRun(m, t); assert.equal(r.ok, false); assert.match(r.reason, /Autorize uma nova tentativa/); assert.equal(t.status, 'interrupted'); assert.equal(executor.isBusy(), false);
  assert.equal(authorizeBlockers({ mission: m, task: t }), null, 'a política de autorização humana não mudou: uma nova tentativa explícita continua possível');
});

test('ordem do boot com o P4: setupExecution (órfãs) primeiro, recover() depois; a tarefa com PID segue com o P4 e o P5 não interfere nem encerra nada', () => {
  reset();
  const kills = [], orphanTools = { alive: (pid) => pid === 4242424, startedAtOf: () => null, kill: (pid) => kills.push(pid) };   // PID fictício: nenhum processo real é consultado
  const running = task({ status: 'running', authorized: false, pid: 4242424, startedAt: new Date().toISOString() }), residual = task();
  const m = mission([running, residual], cycleOf('running', [round(residual)]));
  const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [], orphanTools });
  const { startTaskRun } = setupExecution(express(), { db, executor, orphanTools });          // 1) P4
  assert.equal(running.status, 'interrupted'); assert.equal(running.pid, 4242424, 'identidade não confirmada: PID mantido'); assert.equal(executor.isBusy(), true); assert.deepEqual(executor.orphanPids(), [4242424]);
  assert.equal(residual.status, 'queued', 'o P4 não tocou na tarefa sem PID');
  const afterP4 = clone(running);
  createCycle({ db, executor, planner: scripted([]), startTaskRun, listFiles: () => [] }).recover();   // 2) P5 (mesma ordem do index.js)
  assert.ok(isNormalized(residual)); assert.deepEqual(running, afterP4, 'a tarefa com PID não foi alterada pelo P5');
  assert.deepEqual(kills, [], 'nenhum processo foi encerrado'); assert.equal(executor.isBusy(), true, 'o bloqueio de órfã do P4 continua'); assert.equal(m.cycle.blockedCode, 'restarted');
});

test('retomada do ciclo depois da recuperação: segue com uma NOVA tarefa e a residual nunca é executada', async () => {
  reset();
  const t = task(), m = mission([t], cycleOf('running', [round(t)]));
  const executor = newExec(), starts = [], realStart = executor.start;
  executor.start = (o) => { starts.push(o.taskId); return realStart(o); };
  const { startTaskRun } = setupExecution(express(), { db, executor });
  const planner = scripted([JSON.stringify({ decision: 'continue', rationale: 'r', task: { title: 'Nova tarefa', instructions: 'MODE:check nova', acceptance: ['a'] } }), JSON.stringify({ decision: 'blocked', rationale: 'r', blockedReason: 'fim' })]);
  const cy = createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });
  cy.recover(); assert.equal(m.cycle.status, 'blocked');
  assert.equal((await cy.resume(m.id)).status, 202); await cy.idle();
  const c = m.cycle;
  assert.equal(c.rounds.length, 2); assert.equal(c.rounds[0].status, 'interrupted'); assert.equal(c.rounds[1].status, 'succeeded');
  const fresh = m.tasks.find((x) => x.id === c.rounds[1].taskId);
  assert.deepEqual(starts, [fresh.id], 'só a tarefa nova foi iniciada'); assert.notEqual(fresh.id, t.id);
  assert.ok(isNormalized(t), 'a residual continua interrompida, sem autorização e sem log de execução'); assert.equal(t.log.length, 1);
  assert.match(planner.calls[0], /\[rodada 1\] tarefa: .*\n  execução: interrupted/, 'o Planner vê a rodada 1 como interrompida');
});
