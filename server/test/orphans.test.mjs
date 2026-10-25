// P4: processos filhos órfãos. Só são tocados processos CRIADOS POR ESTES TESTES (filhos `node -e setInterval`); nenhum processo do usuário,
// nenhuma CLI real, nenhum modelo. Banco TEMPORÁRIO. O `startedAt` das tarefas é o do próprio filho, como no servidor.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-orphan-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { reclaimOrphans, processStartedAt, killTreeSync, START_TOLERANCE_MS } = await import('../orphans.js');
const { pidAlive } = await import('../instance-lock.js');
const { installShutdown } = await import('../shutdown.js');

const spawned = new Set();
after(async () => { for (const pid of spawned) killTreeSync(pid); await new Promise((r) => setTimeout(r, 300)); fs.rmSync(tmp, { recursive: true, force: true }); });

const SLEEP = 'setInterval(() => {}, 1000)';
/** Filho controlado pelo teste (fica vivo até ser encerrado). */
function sleeper(code = SLEEP) {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  spawned.add(child.pid);
  assert.notEqual(child.pid, process.pid);
  const exited = new Promise((r) => child.on('exit', r));
  return { child, pid: child.pid, startedAt: new Date().toISOString(), exited, out: () => new Promise((r) => child.stdout.once('data', (d) => r(String(d).trim()))) };
}
const deadPid = async () => { const s = sleeper('0'); await s.exited; return s.pid; };
const settle = async (p, ms = 10_000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('o processo não encerrou a tempo')), ms))]);

let db, seq = 0;
db = store.load(); db.missions = [];
/** Missão com UMA tarefa "running" (o que o servidor deixa para trás ao cair) e roda o boot de setupExecution. */
function boot({ pid, startedAt, executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] }), orphanTools }) {
  const task = { id: `t${++seq}`, title: `tarefa ${seq}`, status: 'running', pid, startedAt, log: [], files: [], dependsOn: [], report: '' };
  db.missions.push({ id: `m${seq}`, demo: false, title: 'M', workspaceId: null, tasks: [task] });
  setupExecution(express(), { db, executor, orphanTools });
  return { task, executor };
}

// ---- unidade (ferramentas injetadas) ----------------------------------------------------------------
test('reclaimOrphans: gone, killed, reused, unverified e kill_failed, sem tocar no que não é comprovadamente a execução abandonada', () => {
  const T = Date.parse('2026-01-01T10:00:00Z'), calls = [];
  const make = (over) => ({ alive: () => true, startedAtOf: () => T + 1000, kill: (pid) => calls.push(pid), wait: () => true, ...over });
  const run = (c, tools) => reclaimOrphans([c], make(tools))[0];
  assert.equal(run({ pid: 10, startedAt: new Date(T).toISOString() }, { alive: () => false }).outcome, 'gone'); assert.deepEqual(calls, []);
  assert.equal(run({ pid: 11, startedAt: new Date(T).toISOString() }).outcome, 'killed'); assert.deepEqual(calls, [11]);
  const limite = run({ pid: 12, startedAt: T }, { startedAtOf: () => T + START_TOLERANCE_MS }); assert.equal(limite.outcome, 'killed', 'no limite da tolerância ainda é a mesma execução');
  calls.length = 0;
  assert.equal(run({ pid: 13, startedAt: T }, { startedAtOf: () => T + START_TOLERANCE_MS + 1 }).outcome, 'reused');
  assert.equal(run({ pid: 14, startedAt: T }, { startedAtOf: () => T - 3_600_000 }).outcome, 'reused');
  assert.equal(run({ pid: 15, startedAt: T }, { startedAtOf: () => null }).outcome, 'unverified');
  assert.equal(run({ pid: 16, startedAt: undefined }).outcome, 'unverified'); assert.equal(run({ pid: 17, startedAt: 'lixo' }).outcome, 'unverified');
  for (const pid of [null, 0, -3, 1.5, '12']) assert.equal(run({ pid, startedAt: T }).outcome, 'gone', `PID inválido não é um processo: ${pid}`);
  assert.equal(run({ pid: 19, startedAt: T }, { startedAtOf: () => null }).expectedStart, T, 'unverified com startedAt válido guarda o início esperado (confirmável depois)');
  assert.equal(run({ pid: 20, startedAt: 'lixo' }).expectedStart, null);
  assert.deepEqual(calls, [], 'nada foi encerrado nos casos não comprovados');
  assert.equal(run({ pid: 18, startedAt: T }, { wait: () => false }).outcome, 'kill_failed'); assert.deepEqual(calls, [18]);
});

// ---- processos reais controlados pelo teste -----------------------------------------------------------
test('processStartedAt: hora de criação do processo real; processo inexistente => null', async () => {
  const s = sleeper();
  const t = processStartedAt(s.pid);
  assert.ok(Math.abs(t - Date.now()) < 30_000, `hora de criação plausível (${t})`);
  assert.equal(processStartedAt(await deadPid()), null); assert.equal(processStartedAt(null), null);
  killTreeSync(s.pid); await settle(s.exited);
});

test('boot: execução órfã (mesma identidade) é encerrada, a tarefa fica interrompida sem pid e nada fica ocupado', async () => {
  const s = sleeper(); assert.equal(pidAlive(s.pid), true);
  const { task, executor } = boot({ pid: s.pid, startedAt: s.startedAt });
  assert.equal(pidAlive(s.pid), false, 'o processo órfão foi encerrado durante o boot'); await settle(s.exited);
  assert.equal(task.status, 'interrupted'); assert.equal('pid' in task, false);
  assert.ok(task.log.some((l) => /PID \d+: .*ENCERRADO/.test(l)), task.log.join(' | '));
  assert.ok(db.activity.some((a) => a.orphan === 'killed' && a.taskId === task.id));
  assert.equal(executor.isBusy(), false);
});

test('boot: a ÁRVORE inteira da execução órfã é encerrada (filho e neto)', async () => {
  const code = `const g = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: 'ignore' }); console.log(g.pid); ${SLEEP}`;
  const s = sleeper(code), grandchild = Number(await s.out()); spawned.add(grandchild);
  assert.ok(pidAlive(s.pid) && pidAlive(grandchild));
  boot({ pid: s.pid, startedAt: s.startedAt });
  assert.equal(pidAlive(s.pid), false); assert.equal(pidAlive(grandchild), false, 'o subprocesso também foi encerrado');
});

test('boot: processo já encerrado é tratado sem erro; tarefa continua interrompida e sem pid', async () => {
  const pid = await deadPid();
  const { task } = boot({ pid, startedAt: new Date().toISOString() });
  assert.equal(task.status, 'interrupted'); assert.equal('pid' in task, false); assert.ok(task.log.some((l) => /já não existia/.test(l)));
  assert.ok(db.activity.some((a) => a.orphan === 'gone' && a.taskId === task.id));
});

test('boot: PID reaproveitado por OUTRO processo (hora de criação não bate) NÃO é encerrado e não bloqueia o executor', async () => {
  const s = sleeper();
  const { task, executor } = boot({ pid: s.pid, startedAt: new Date(Date.now() - 3_600_000).toISOString() });   // "a tarefa começou há 1 h": este processo é outro
  assert.equal(pidAlive(s.pid), true, 'o processo alheio continua vivo'); assert.ok(task.log.some((l) => /outro processo|reaproveitado/.test(l)));
  assert.ok(db.activity.some((a) => a.orphan === 'reused' && a.taskId === task.id)); assert.equal(executor.isBusy(), false); assert.equal('pid' in task, false);
  killTreeSync(s.pid); await settle(s.exited);
});

test('boot: processo VIVO com identidade não confirmável não é encerrado, mas BLOQUEIA o executor e mantém o PID para ser reavaliado no próximo boot', async () => {
  const s = sleeper();
  const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const { task, m } = (() => { const b = boot({ pid: s.pid, startedAt: s.startedAt, executor, orphanTools: { startedAtOf: () => null } }); return { task: b.task, m: db.missions.at(-1) }; })();
  assert.equal(pidAlive(s.pid), true, 'não foi encerrado'); assert.ok(task.log.some((l) => /não foi possível confirmar.*bloqueadas/.test(l)));
  assert.ok(db.activity.some((a) => a.orphan === 'unverified' && a.taskId === task.id));
  assert.equal(executor.isBusy(), true, 'executor ocupado: nada novo se sobrepõe a um processo possivelmente ativo'); assert.deepEqual(executor.orphanPids(), [s.pid]);
  assert.throws(() => executor.start({ missionId: 'm', taskId: 't', cwd: tmp, prompt: 'MODE:ok', onLine() {} }), (e) => e.code === 'BUSY');
  assert.equal(task.pid, s.pid, 'o PID continua gravado na tarefa'); assert.equal(task.status, 'interrupted');
  // próximo boot (processo ainda vivo, agora a identidade PODE ser confirmada): a mesma tarefa é reavaliada e a execução abandonada é encerrada
  const executor2 = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  setupExecution(express(), { db, executor: executor2 });
  assert.equal(pidAlive(s.pid), false, 'confirmada a identidade, a órfã foi encerrada'); await settle(s.exited);
  assert.equal('pid' in task, false); assert.equal(executor2.isBusy(), false);
  assert.ok(task.log.some((l) => /ENCERRADO/.test(l))); assert.ok(m.tasks.every((t) => t.status === 'interrupted'));
});

test('boot: startedAt ausente ou inválido com processo vivo => bloqueia e nunca encerra; quando o processo termina, o bloqueio some sozinho', async () => {
  for (const startedAt of [undefined, null, 'lixo']) {
    const s = sleeper(), executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
    const { task } = boot({ pid: s.pid, startedAt, executor });
    assert.equal(pidAlive(s.pid), true, `startedAt=${startedAt}: não encerrado`); assert.equal(executor.isBusy(), true); assert.equal(task.pid, s.pid);
    const r = await executor.stop();                                                   // Interromper: sem identidade não mata e não libera
    assert.equal(r.stopped, false); assert.match(r.detail, /identidade/); assert.equal(pidAlive(s.pid), true); assert.equal(executor.isBusy(), true);
    killTreeSync(s.pid); await settle(s.exited);                                       // o humano (ou o próprio processo) encerra
    assert.equal(executor.isBusy(), false, 'processo comprovadamente encerrado: bloqueio liberado');
    assert.deepEqual(await executor.stop(), { stopped: false, detail: 'Nenhuma execução ativa.' });
  }
});

test('boot: tarefa interrompida com PID remanescente cujo processo já não existe ou é de OUTRO processo tem o PID limpo, sem bloqueio permanente', async () => {
  const dead = await deadPid(), other = sleeper();
  const mk = (pid, startedAt) => { const t = { id: `t${++seq}`, title: 'antiga', status: 'interrupted', pid, startedAt, log: [], files: [], dependsOn: [], report: '' }; db.missions.push({ id: `m${seq}`, demo: false, title: 'M', workspaceId: null, tasks: [t] }); return t; };
  const t1 = mk(dead, new Date().toISOString()), t2 = mk(other.pid, new Date(Date.now() - 3_600_000).toISOString());
  const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  setupExecution(express(), { db, executor });
  assert.equal('pid' in t1, false); assert.equal('pid' in t2, false); assert.equal(executor.isBusy(), false);
  assert.equal(pidAlive(other.pid), true, 'o processo alheio não foi tocado'); killTreeSync(other.pid); await settle(other.exited);
});

test('falha ao encerrar a órfã: o executor fica ocupado (nenhuma execução nova se sobrepõe) até Interromper encerrar de fato', async () => {
  const s = sleeper();
  const executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const { task } = boot({ pid: s.pid, startedAt: s.startedAt, executor, orphanTools: { kill: () => {}, wait: () => false } });   // o encerramento do boot "falha"
  assert.ok(task.log.some((l) => /NÃO pôde ser encerrado/.test(l))); assert.ok(db.activity.some((a) => a.orphan === 'kill_failed')); assert.equal(task.pid, s.pid, 'PID mantido para reavaliação');
  assert.equal(pidAlive(s.pid), true); assert.equal(executor.isBusy(), true, 'ocupado por causa da órfã'); assert.equal(executor.current(), null);
  assert.throws(() => executor.start({ missionId: 'm', taskId: 't', cwd: tmp, prompt: 'MODE:ok', onLine() {} }), (e) => e.code === 'BUSY');
  const r = await executor.stop();                                  // ação humana (botão Interromper): identidade conferida de novo e processo encerrado
  assert.equal(r.stopped, true); assert.match(r.detail, /servidor anterior/); await settle(s.exited);
  assert.equal(pidAlive(s.pid), false); assert.equal(executor.isBusy(), false);
  const h = executor.start({ missionId: 'm', taskId: 't', cwd: tmp, prompt: 'MODE:ok', onLine() {} }); assert.equal((await h.done).status, 'completed');   // livre de novo
});

test('órfã registrada que termina sozinha libera o executor; PID reaproveitado depois NÃO é encerrado por Interromper', async () => {
  const a = sleeper(), ex1 = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ex1.adoptOrphan(a.pid, processStartedAt(a.pid)); assert.equal(ex1.isBusy(), true);
  killTreeSync(a.pid); await settle(a.exited); assert.equal(ex1.isBusy(), false, 'a órfã morreu: executor livre sem intervenção');

  const b = sleeper(), ex2 = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ex2.adoptOrphan(b.pid, Date.now() - 3_600_000);                   // "o PID agora é de outro processo": a hora de criação não bate
  assert.equal(ex2.isBusy(), true);
  const r = await ex2.stop();
  assert.equal(pidAlive(b.pid), true, 'o processo alheio não foi encerrado'); assert.equal(r.stopped, false); assert.equal(ex2.isBusy(), false, 'e deixou de ser considerado nosso');
  killTreeSync(b.pid); await settle(b.exited);
});

test('cancelamento/Interromper encerra o filho do executor (e o resultado é "interrupted")', async () => {
  const ex = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const h = ex.start({ missionId: 'm', taskId: 't', cwd: tmp, prompt: 'MODE:sleep', onLine() {} }); spawned.add(h.pid);
  assert.equal(pidAlive(h.pid), true);
  const r = await ex.stop();
  assert.equal(r.stopped, true); assert.equal((await h.done).status, 'interrupted'); assert.equal(pidAlive(h.pid), false); assert.equal(ex.isBusy(), false);
  assert.deepEqual(await ex.stop(), { stopped: false, detail: 'Nenhuma execução ativa.' }, 'parar de novo, com o processo já encerrado, não dá erro');
});

test('killActiveSync (saída do servidor): encerra o filho ativo de forma síncrona; sem execução ativa não faz nada', async () => {
  const ex = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ex.killActiveSync();                                              // nada ativo
  const h = ex.start({ missionId: 'm', taskId: 't', cwd: tmp, prompt: 'MODE:sleep', onLine() {} }); spawned.add(h.pid);
  assert.equal(pidAlive(h.pid), true);
  ex.killActiveSync();
  await settle(h.done); assert.equal(pidAlive(h.pid), false); assert.equal(ex.isBusy(), false);
});

test('installShutdown: sinais e saída encerram o filho, liberam a trava e saem com o código certo, mesmo se encerrar o filho falhar', () => {
  const mk = (killFails = false) => {
    const proc = new EventEmitter(), log = [];
    const executor = { killActiveSync: () => { log.push('kill'); if (killFails) throw new Error('boom'); } }, lock = { release: () => log.push('release') };
    installShutdown({ lock, executor, proc, exit: (c) => log.push(`exit:${c}`) });
    return { proc, log };
  };
  const quiet = console.error; console.error = () => {};
  try {
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 143], ['SIGBREAK', 143]]) { const { proc, log } = mk(); proc.emit(sig); assert.deepEqual(log, ['kill', 'release', `exit:${code}`], sig); }
    const f = mk(true); f.proc.emit('SIGINT'); assert.deepEqual(f.log, ['kill', 'release', 'exit:130'], 'a falha ao encerrar o filho não impede liberar a trava nem sair');
    const e = mk(); e.proc.emit('exit'); assert.deepEqual(e.log, ['kill'], 'no evento exit só o filho é encerrado (a trava tem o próprio handler)');
    const none = new EventEmitter(); installShutdown({ lock: null, executor: undefined, proc: none, exit() {} }); assert.doesNotThrow(() => { none.emit('SIGTERM'); none.emit('exit'); });
  } finally { console.error = quiet; }
});

test('ponta a ponta: o servidor REAL (index.js, banco temporário) encerra no boot a execução órfã deixada por uma queda', async () => {
  const { default: net } = await import('node:net');
  const dir = fs.mkdtempSync(path.join(tmp, 'srv-')), s = sleeper();
  assert.ok(dir.startsWith(os.tmpdir()), 'o banco do teste fica no diretório temporário');
  const task = { id: 't1', title: 'órfã', status: 'running', pid: s.pid, startedAt: s.startedAt, log: [], files: [], dependsOn: [], report: '' };
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 1, settings: { activeWorkspaceId: null, requireApproval: true, showDemoData: false }, workspaces: [], activity: [], missions: [{ id: 'm1', demo: false, title: 'M', workspaceId: null, tasks: [task] }] }, null, 2));
  const port = await new Promise((r) => { const l = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = l.address(); l.close(() => r(p)); }); });
  const srv = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js')], { env: { ...process.env, ORCH_DATA_DIR: dir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  spawned.add(srv.pid); let out = ''; srv.stdout.on('data', (c) => { out += c; }); srv.stderr.on('data', (c) => { out += c; });
  try {
    await settle(new Promise((resolve, reject) => { const iv = setInterval(() => { if (/AI Dev Orchestrator API em/.test(out)) { clearInterval(iv); resolve(); } }, 25); srv.on('exit', () => { clearInterval(iv); reject(new Error(`o servidor encerrou: ${out}`)); }); }), 25_000);
    assert.equal(pidAlive(s.pid), false, 'a órfã foi encerrada pelo boot do servidor'); await settle(s.exited);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).missions[0].tasks[0];
    assert.equal(saved.status, 'interrupted'); assert.equal('pid' in saved, false); assert.ok(saved.log.some((l) => /ENCERRADO/.test(l)));
  } finally { srv.kill(); await new Promise((r) => srv.on('exit', r)); }
});

test('stop(): consulta de identidade falhando NÃO mata e NÃO libera o bloqueio (mesmo sabendo o início esperado); com a consulta funcionando, encerra', async () => {
  const s = sleeper(), real = processStartedAt(s.pid);
  const blind = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [], orphanTools: { startedAtOf: () => null } });
  blind.adoptOrphan(s.pid, real);
  const r = await blind.stop();
  assert.equal(r.stopped, false); assert.match(r.detail, new RegExp(`identidade do processo ${s.pid}`)); assert.match(r.detail, /NÃO foi encerrado/);
  assert.equal(pidAlive(s.pid), true); assert.equal(blind.isBusy(), true, 'continua bloqueando');
  const seeing = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  seeing.adoptOrphan(s.pid, real);
  assert.equal((await seeing.stop()).stopped, true); await settle(s.exited); assert.equal(seeing.isBusy(), false);
});

test('com órfã bloqueante o ciclo e a execução manual são recusados (nenhuma sobreposição) e voltam a funcionar quando ela termina', async () => {
  const { createCycle } = await import('../cycle.js');
  const s = sleeper(), executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  executor.adoptOrphan(s.pid, null);
  db.workspaces = [{ id: 'wsO', name: 'ws', path: tmp }];
  const m = { id: `mo${++seq}`, demo: false, title: 'M', objective: 'o', workspaceId: 'wsO', createdAt: store.now(), tasks: [{ id: 'tq', title: 'manual', status: 'queued', authorized: true, dependsOn: [], report: '', files: [], log: [] }] };
  db.missions.push(m);
  const { startTaskRun } = setupExecution(express(), { db, executor });
  const planner = { busy: () => false, cancel: async () => {}, decide: async () => ({ error: 'não deveria ser consultado' }) };
  const cy = createCycle({ db, executor, planner, startTaskRun, listFiles: () => [] });
  const c = await cy.start(m.id, 2);
  assert.equal(c.status, 409); assert.match(c.error, /em andamento/); assert.equal(m.cycle, undefined, 'nenhum ciclo foi criado');
  const r = await startTaskRun(m, m.tasks[0]);
  assert.equal(r.ok, false); assert.match(r.reason, /em andamento/); assert.equal(m.tasks[0].status, 'queued');
  killTreeSync(s.pid); await settle(s.exited);
  assert.equal(executor.isBusy(), false);
  const r2 = await startTaskRun(m, m.tasks[0]); assert.equal(r2.ok, true, 'processo encerrado: a execução manual volta a ser possível'); await r2.finished;
});

test('evento exit REAL: o encerramento do filho é tentado ANTES de a trava de instância ser liberada (e ela é liberada depois)', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'order-')), record = path.join(dir, 'order.json');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lockMod = pathToFileURL(path.join(here, '..', 'instance-lock.js')).href, shutMod = pathToFileURL(path.join(here, '..', 'shutdown.js')).href;
  const code = `import fs from 'node:fs';
    import { acquireInstanceLock, lockPathFor } from ${JSON.stringify(lockMod)};
    import { installShutdown } from ${JSON.stringify(shutMod)};
    const dir = ${JSON.stringify(dir)}, lock = acquireInstanceLock({ dir, autoRelease: true });
    if (!lock.ok) process.exit(9);
    // mesma ordem do servidor: a trava registra o listener de exit primeiro; depois o shutdown
    installShutdown({ lock, executor: { killActiveSync: () => fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ lockExistedWhenKilling: fs.existsSync(lockPathFor(dir)) })) } });
    process.exit(0);`;
  const code_ = await new Promise((resolve) => { const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', windowsHide: true }); spawned.add(c.pid); c.on('exit', resolve); });
  assert.equal(code_, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), { lockExistedWhenKilling: true }, 'o filho foi encerrado com a trava ainda de pé');
  assert.equal(fs.existsSync(path.join(dir, 'server.lock')), false, 'e a trava foi liberada depois');
});
