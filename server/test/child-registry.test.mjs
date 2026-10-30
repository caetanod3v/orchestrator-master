// M1: rastreamento, encerramento e recuperação dos processos filhos do PLANNER e do VERIFICADOR (db.childProcesses).
// Isolamento: banco em diretório TEMPORÁRIO (ORCH_DATA_DIR antes de qualquer import), CLI FALSA (fake-cli.mjs), verificador com processo simulado
// (`node -e`), nenhum modelo, nenhum servidor real. Só são tocados processos CRIADOS POR ESTES TESTES. As "quedas" são processos auxiliares de teste
// que se matam com SIGKILL (o filho que eles iniciaram sobrevive, como no servidor real).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-childreg-'));
const DATA = path.join(tmp, 'data');
process.env.ORCH_DATA_DIR = DATA;
assert.ok(DATA.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-cli.mjs');
const url = (f) => pathToFileURL(path.join(HERE, '..', f)).href;

const store = await import('../store.js');
const { createChildRegistry, CHILD_KEY } = await import('../child-registry.js');
const { createClaudePlanner } = await import('../planner.js');
const { createVerifier } = await import('../verify.js');
const { createExecutor } = await import('../executor/index.js');
const { createCycle } = await import('../cycle.js');
const { installShutdown } = await import('../shutdown.js');
const { createProcTracker } = await import('./proc-identity.mjs');

// Identidade dos PIDs (proc-identity.mjs): o Windows reaproveita PIDs em segundos, então "o PID está vivo" pode ser OUTRO processo e encerrar "o PID registrado"
// pode matar um processo alheio. `pidAlive` aqui é verdadeiro só para o processo ORIGINAL (PID reaproveitado conta como encerrado) e o cleanup/`kill` só
// encerram o original. Quem registra um PID DEPOIS de o processo poder ter morrido passa o instante em que ele comprovadamente existia (`add(pid, startedAt)`).
const spawned = createProcTracker();
const pidAlive = (pid) => spawned.isAlive(pid);
after(async () => { spawned.cleanup(); await new Promise((r) => setTimeout(r, 700)); fs.rmSync(tmp, { recursive: true, force: true }); });

const SLEEP = 'setInterval(() => {}, 1000)';
const until = async (fn, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
const settle = (p, ms = 10_000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('não terminou a tempo')), ms))]);
const quiet = (fn) => { const q = console.error; console.error = () => {}; try { return fn(); } finally { console.error = q; } };

let db = store.load(); db.missions = [];
const diskRecords = () => JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'))[CHILD_KEY] ?? [];
const recordsOf = (kind) => store.get()[CHILD_KEY].filter((r) => r.kind === kind);
const newExecutor = () => createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
const newPlanner = (track) => createClaudePlanner({ runnerOptions: { command: process.execPath, prefixArgs: [FAKE] }, track });
/** Filho controlado pelo teste (fica vivo até ser encerrado), com a hora de início de quem o criou, como o registro do servidor. */
function sleeper() {
  const child = spawn(process.execPath, ['-e', SLEEP], { stdio: 'ignore', windowsHide: true });
  const startedAt = new Date().toISOString(); spawned.add(child.pid, startedAt); assert.notEqual(child.pid, process.pid);
  return { pid: child.pid, startedAt, exited: new Promise((r) => child.on('exit', r)) };
}
const wsDir = path.join(tmp, 'ws'); fs.mkdirSync(wsDir); fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'echo t' } }));
const item = { id: 'test', script: 'test', command: 'echo t', required: true, timeoutMs: 20_000 };
const sleepSpec = () => ({ command: process.execPath, args: ['-e', SLEEP] });
const instantSpec = () => ({ command: process.execPath, args: ['-e', '0'] });

// ---- registro (unidade) ---------------------------------------------------------------------------------------
test('track grava o PID no disco (com tipo e hora de início) e release o apaga; release é idempotente e tipo/PID inválidos são tratados', async () => {
  const reg = createChildRegistry();
  const tr = reg.track('planner', 4242, { missionId: 'm1' });
  const onDisk = diskRecords();
  assert.equal(onDisk.length, 1); assert.equal(onDisk[0].kind, 'planner'); assert.equal(onDisk[0].pid, 4242); assert.equal(onDisk[0].missionId, 'm1');
  assert.ok(Number.isFinite(Date.parse(onDisk[0].startedAt)), 'hora de início válida');
  tr.release(); tr.release();
  assert.equal(store.get()[CHILD_KEY].length, 0); assert.ok(await until(() => diskRecords().length === 0), 'a remoção também chega ao disco');
  assert.throws(() => reg.track('executor', 1), TypeError);
  for (const pid of [undefined, null, 0, -1, 1.5, '7']) { const t = reg.track('planner', pid); assert.equal(t.pid, null); t.release(); }
  assert.equal(store.get()[CHILD_KEY].length, 0, 'sem PID válido não se registra nada');
});

test('track: falha real ao gravar => lança e NÃO deixa registro em memória; registros de processos já mortos são podados', async () => {
  const bad = createChildRegistry({ store: { ...store, save() { throw Object.assign(new Error('disco'), { code: 'EIO' }); } } });
  assert.throws(() => bad.track('verifier', 4243), (e) => e.code === 'EIO');
  assert.equal(store.get()[CHILD_KEY].length, 0);
  const dead = sleeper(); spawned.kill(dead.pid); await settle(dead.exited);
  store.get()[CHILD_KEY].push({ id: 'proc_velho', kind: 'planner', pid: dead.pid, startedAt: dead.startedAt });
  const reg = createChildRegistry(); const t = reg.track('planner', process.pid);
  assert.deepEqual(store.get()[CHILD_KEY].map((r) => r.pid), [process.pid], 'o registro do processo morto saiu'); t.release();
});

// ---- Planner: rastreio no ciclo de vida da chamada -----------------------------------------------------------------
test('Planner: o PID fica registrado enquanto a CLI vive e é apagado quando ela termina (sucesso e cancelamento)', async () => {
  const reg = createChildRegistry(), planner = newPlanner(reg.track);
  const ok = await planner.decide({ prompt: 'MODE:ok', cwd: tmp });
  assert.equal(ok.error, undefined); assert.equal(store.get()[CHILD_KEY].length, 0, 'terminou: nenhum registro');

  const call = planner.decide({ prompt: 'MODE:sleep', cwd: tmp });
  assert.ok(await until(() => recordsOf('planner').length === 1), 'registrado logo após o spawn');
  const { pid, startedAt } = recordsOf('planner')[0]; spawned.add(pid, startedAt);
  assert.ok(pidAlive(pid)); assert.equal(planner.busy(), true); assert.ok(Math.abs(Date.parse(startedAt) - Date.now()) < 30_000);
  assert.ok(diskRecords().some((r) => r.pid === pid && r.kind === 'planner'), 'e já está no DISCO (sobrevive a uma queda)');
  await planner.cancel(); const r = await settle(call);
  assert.equal(r.interrupted, true); assert.equal(pidAlive(pid), false); assert.equal(store.get()[CHILD_KEY].length, 0);
  assert.equal(planner.busy(), false);
});

test('Planner: sem `track` nada é registrado (comportamento de sempre)', async () => {
  const planner = newPlanner(null); const r = await planner.decide({ prompt: 'MODE:ok', cwd: tmp });
  assert.equal(r.error, undefined); assert.equal(store.get()[CHILD_KEY].length, 0);
});

test('Planner: se o registro não puder ser gravado, a CLI é ENCERRADA e a chamada falha (nunca um filho sem rastreio)', async () => {
  let spawnedPid = null;
  const planner = newPlanner((kind, pid) => { spawnedPid = pid; spawned.add(pid); throw Object.assign(new Error('disco cheio'), { code: 'ENOSPC' }); });
  const r = await planner.decide({ prompt: 'MODE:sleep', cwd: tmp });
  assert.match(r.error, /registrar o processo do Planner \(ENOSPC\).*encerrada/); assert.ok(spawnedPid);
  assert.equal(await until(() => !pidAlive(spawnedPid)), true, 'o processo foi encerrado'); assert.equal(planner.busy(), false);
});

test('Planner: killActiveSync (saída do servidor) encerra a CLI e apaga o registro SÓ depois de o processo sumir', async () => {
  const reg = createChildRegistry(), planner = newPlanner(reg.track);
  planner.killActiveSync(); // sem chamada em curso: não faz nada
  const call = planner.decide({ prompt: 'MODE:sleep', cwd: tmp });
  assert.ok(await until(() => recordsOf('planner').length === 1)); const { pid, startedAt } = recordsOf('planner')[0]; spawned.add(pid, startedAt);
  planner.killActiveSync();
  assert.equal(pidAlive(pid), false); assert.equal(recordsOf('planner').length, 0, 'processo comprovadamente encerrado => registro apagado');
  await settle(call);
});

test('Planner: se o encerramento NÃO se confirma, o registro permanece (para o próximo boot) até o processo terminar', async () => {
  const entries = [];
  const track = (k, pid) => { const r = createChildRegistry().track(k, pid); entries.push(r); return r; };
  const fakeRunner = { // runner que "não consegue" matar o filho: o processo continua vivo
    isBusy: () => true, start: () => ({ pid: s.pid, done: new Promise((r) => { finish = r; }) }), killActiveSync() {}, stop: async () => ({ stopped: false }),
  };
  let finish; const s = sleeper();
  const planner = createClaudePlanner({ runner: fakeRunner, track });
  const call = planner.decide({ prompt: 'x', cwd: tmp });
  assert.ok(await until(() => recordsOf('planner').length === 1));
  planner.killActiveSync();
  assert.equal(pidAlive(s.pid), true); assert.equal(recordsOf('planner').length, 1, 'ainda vivo: o registro fica');
  finish({ status: 'interrupted', error: 'x' }); await settle(call);
  assert.equal(recordsOf('planner').length, 0, 'terminou: sai'); spawned.kill(s.pid); await settle(s.exited);
});

// ---- Verificador -------------------------------------------------------------------------------------------------
test('Verificador: o PID fica registrado durante a verificação e sai ao terminar (passou, cancelada e por falha de execução)', async () => {
  const reg = createChildRegistry();
  const quick = createVerifier({ spawnSpec: instantSpec, track: reg.track });
  assert.equal((await quick.run({ path: wsDir }, item)).status, 'pass'); assert.equal(store.get()[CHILD_KEY].length, 0);

  const v = createVerifier({ spawnSpec: sleepSpec, track: reg.track });
  const run = v.run({ path: wsDir }, item);
  assert.ok(await until(() => recordsOf('verifier').length === 1)); const { pid, startedAt } = recordsOf('verifier')[0]; spawned.add(pid, startedAt);
  assert.ok(pidAlive(pid)); assert.equal(v.isBusy(), true); assert.ok(diskRecords().some((r) => r.pid === pid && r.kind === 'verifier'));
  assert.equal((await v.stop()).stopped, true); const res = await settle(run);
  assert.equal(res.status, 'cancelled'); assert.equal(pidAlive(pid), false); assert.equal(store.get()[CHILD_KEY].length, 0); assert.equal(v.isBusy(), false);

  const broken = createVerifier({ spawnSpec: () => ({ command: path.join(tmp, 'nao-existe.exe'), args: [] }), track: reg.track });
  assert.equal((await broken.run({ path: wsDir }, item)).status, 'error'); assert.equal(store.get()[CHILD_KEY].length, 0, 'spawn que falha não deixa registro');
});

test('Verificador: se o registro não puder ser gravado, o processo é ENCERRADO e a verificação vira "error" (não conta como resultado)', async () => {
  let pid = null;
  const v = createVerifier({ spawnSpec: sleepSpec, track: (k, p) => { pid = p; spawned.add(p); throw Object.assign(new Error('disco'), { code: 'EIO' }); } });
  const res = await v.run({ path: wsDir }, item);
  assert.equal(res.status, 'error'); assert.match(res.reason, /registrar o processo da verificação \(EIO\)/);
  assert.equal(await until(() => !pidAlive(pid)), true, 'encerrado'); assert.equal(v.isBusy(), false, 'e o verificador fica livre');
});

test('Verificador: killActiveSync encerra a árvore e apaga o registro; sem verificação em curso não faz nada', async () => {
  const reg = createChildRegistry(), v = createVerifier({ spawnSpec: sleepSpec, track: reg.track });
  v.killActiveSync();
  const run = v.run({ path: wsDir }, item);
  assert.ok(await until(() => recordsOf('verifier').length === 1)); const { pid, startedAt } = recordsOf('verifier')[0]; spawned.add(pid, startedAt);
  v.killActiveSync();
  assert.equal(pidAlive(pid), false); assert.equal(recordsOf('verifier').length, 0); await settle(run); assert.equal(v.isBusy(), false);
});

// ---- Recuperação no boot (reclaim) ---------------------------------------------------------------------------------------
function plant(kind, s, extra = {}) { (store.get()[CHILD_KEY] ??= []).push({ id: `proc_${kind}_${s.pid}`, kind, pid: s.pid, startedAt: s.startedAt, ...extra }); store.save(); }

test('boot: filho órfão (mesma identidade) do Planner e do verificador é ENCERRADO, o registro sai e nada fica ocupado', async () => {
  for (const kind of ['planner', 'verifier']) {
    const s = sleeper(); plant(kind, s, { missionId: 'm1' });
    const executor = newExecutor(), results = createChildRegistry().reclaim({ executor });
    assert.equal(results.length, 1); assert.equal(results[0].outcome, 'killed', kind);
    assert.equal(pidAlive(s.pid), false); await settle(s.exited);
    assert.equal(store.get()[CHILD_KEY].length, 0); assert.equal(executor.isBusy(), false);
    assert.ok(store.get().activity.some((a) => a.orphan === 'killed' && a.process === kind && a.missionId === 'm1'), 'registrado na atividade');
  }
});

test('boot: a ÁRVORE inteira do filho órfão é encerrada (verificador: npm -> node)', async () => {
  const code = `const g = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'neto.pid'))}, String(g.pid)); ${SLEEP}`;
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore', windowsHide: true }); spawned.add(child.pid);
  const startedAt = new Date().toISOString(), exited = new Promise((r) => child.on('exit', r));
  assert.ok(await until(() => fs.existsSync(path.join(tmp, 'neto.pid')))); const grandchild = Number(fs.readFileSync(path.join(tmp, 'neto.pid'), 'utf8')); spawned.add(grandchild);
  plant('verifier', { pid: child.pid, startedAt });
  createChildRegistry().reclaim({ executor: newExecutor() });
  assert.equal(pidAlive(child.pid), false); assert.equal(pidAlive(grandchild), false, 'o neto também'); await settle(exited);
});

test('boot: processo já encerrado => registro limpo; PID reaproveitado por OUTRO processo NÃO é encerrado e não bloqueia', async () => {
  const dead = sleeper(); spawned.kill(dead.pid); await settle(dead.exited);
  const other = sleeper();
  plant('planner', dead); plant('verifier', { pid: other.pid, startedAt: new Date(Date.now() - 3_600_000).toISOString() }); // "o registro é de 1 h atrás": este processo é outro
  const executor = newExecutor(), results = createChildRegistry().reclaim({ executor });
  assert.deepEqual(results.map((r) => r.outcome), ['gone', 'reused']);
  assert.equal(pidAlive(other.pid), true, 'o processo alheio continua vivo'); assert.equal(executor.isBusy(), false);
  assert.equal(store.get()[CHILD_KEY].length, 0); spawned.kill(other.pid); await settle(other.exited);
});

test('boot: identidade NÃO confirmável => nada é encerrado, o EXECUTOR fica ocupado e o registro é mantido; no boot seguinte (identidade confirmável) é encerrado', async () => {
  const s = sleeper(); plant('verifier', s);
  const executor = newExecutor();
  const res = createChildRegistry({ orphanTools: { startedAtOf: () => null } }).reclaim({ executor });
  assert.equal(res[0].outcome, 'unverified'); assert.equal(pidAlive(s.pid), true, 'não foi encerrado');
  assert.equal(executor.isBusy(), true); assert.deepEqual(executor.orphanPids(), [s.pid]);
  assert.throws(() => executor.start({ missionId: 'm', taskId: 't', cwd: tmp, prompt: 'MODE:ok', onLine() {} }), (e) => e.code === 'BUSY', 'nenhuma execução nova se sobrepõe');
  assert.equal(store.get()[CHILD_KEY].length, 1, 'o registro fica para ser reavaliado'); assert.equal(diskRecords().length, 1);
  const executor2 = newExecutor(), res2 = createChildRegistry().reclaim({ executor: executor2 });
  assert.equal(res2[0].outcome, 'killed'); assert.equal(pidAlive(s.pid), false); await settle(s.exited);
  assert.equal(executor2.isBusy(), false); assert.equal(store.get()[CHILD_KEY].length, 0);
});

test('boot: falha ao encerrar (kill_failed) => executor ocupado, registro mantido e "Interromper" (executor.stop) encerra conferindo a identidade', async () => {
  const s = sleeper(); plant('planner', s);
  const executor = newExecutor();
  const res = createChildRegistry({ orphanTools: { kill: () => {}, wait: () => false } }).reclaim({ executor });
  assert.equal(res[0].outcome, 'kill_failed'); assert.equal(pidAlive(s.pid), true); assert.equal(executor.isBusy(), true); assert.equal(store.get()[CHILD_KEY].length, 1);
  const stopped = await executor.stop(); // identidade conhecida (hora de início medida no boot): encerra de verdade
  assert.equal(stopped.stopped, true, stopped.detail); await settle(s.exited); assert.equal(executor.isBusy(), false);
  createChildRegistry().reclaim({ executor: newExecutor() }); assert.equal(store.get()[CHILD_KEY].length, 0, 'o registro velho sai no boot seguinte (processo não existe mais)');
});

test('boot: com um órfão bloqueante, iniciar um ciclo é recusado (409) e volta a ser possível quando ele termina', async () => {
  const s = sleeper(); plant('verifier', s);
  const executor = newExecutor(); createChildRegistry({ orphanTools: { startedAtOf: () => null } }).reclaim({ executor });
  const d = { workspaces: [{ id: 'ws', name: 'w', path: wsDir }], missions: [{ id: 'mx', demo: false, title: 'M', workspaceId: 'ws', tasks: [] }], settings: {} };
  const cycle = createCycle({ db: d, executor, planner: { busy: () => false, decide: async () => ({ error: 'não deve ser chamado' }), cancel: async () => {} }, startTaskRun: async () => ({ ok: false, reason: 'não deve ser chamado' }) });
  const r = await cycle.start('mx', 3); assert.equal(r.status, 409); assert.match(r.error, /em andamento/); assert.equal(d.missions[0].cycle, undefined, 'nenhum ciclo foi criado');
  spawned.kill(s.pid); await settle(s.exited);
  assert.equal(executor.isBusy(), false, 'o bloqueio some sozinho quando o processo termina');
  createChildRegistry().reclaim({ executor: newExecutor() });
});

test('boot: banco antigo (sem o campo), registros malformados e lista vazia não quebram o boot', () => {
  delete store.get()[CHILD_KEY];
  assert.deepEqual(createChildRegistry().reclaim({ executor: newExecutor() }), []);
  store.get()[CHILD_KEY] = [null, 'lixo', { kind: 'planner' }, { kind: 'verifier', pid: 'x', startedAt: 'y' }];
  const executor = newExecutor();
  assert.doesNotThrow(() => quiet(() => createChildRegistry().reclaim({ executor })));
  assert.equal(executor.isBusy(), false); assert.equal(store.get()[CHILD_KEY].length, 0);
  store.get()[CHILD_KEY] = 'não é lista'; assert.doesNotThrow(() => createChildRegistry().reclaim({ executor })); assert.ok(Array.isArray(store.get()[CHILD_KEY]));
});

// ---- Queda REAL durante o Planner / a verificação (processo auxiliar morto com SIGKILL) ------------------------------------------
// No Windows o libuv põe os filhos NÃO destacados num job object que os encerra junto com o pai: um SIGKILL no auxiliar mataria também a CLI/o npm e
// o cenário "filho órfão vivo" nunca existiria. Por isso o auxiliar força `detached: true` no spawn (só nele; o código de produção não muda), que é como
// o filho sobrevive à queda do pai em POSIX ou quando escapa do job (descendentes destacados).
const PRELUDE = `import fs from 'node:fs';
  import cp from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  const realSpawn = cp.spawn; cp.spawn = (cmd, args, opts) => realSpawn(cmd, args, { ...opts, detached: true }); syncBuiltinESMExports();
  const store = await import(${JSON.stringify(url('store.js'))});
  const { createChildRegistry } = await import(${JSON.stringify(url('child-registry.js'))});
  const { createClaudePlanner } = await import(${JSON.stringify(url('planner.js'))});
  const { createVerifier } = await import(${JSON.stringify(url('verify.js'))});
  const { installShutdown } = await import(${JSON.stringify(url('shutdown.js'))});
  store.load(); const reg = createChildRegistry();
  const planner = createClaudePlanner({ runnerOptions: { command: process.execPath, prefixArgs: [${JSON.stringify(FAKE)}] }, track: reg.track });
  const verifier = createVerifier({ spawnSpec: () => ({ command: process.execPath, args: ['-e', ${JSON.stringify(SLEEP)}] }), track: reg.track });
  const when = (kind, fn) => { const iv = setInterval(() => { if (reg.pending().some((r) => r.kind === kind)) { clearInterval(iv); fn(); } }, 10); };
  const item = ${JSON.stringify(item)}, ws = { path: ${JSON.stringify(wsDir)} };`;
/** Executa o processo auxiliar (mesmo banco TEMPORÁRIO); devolve o código de saída. Antes, grava o que o processo de teste tem pendente (nunca sobrescreve o auxiliar). */
async function helper(body) {
  store.flush();
  const code = await new Promise((resolve) => { const c = spawn(process.execPath, ['--input-type=module', '-e', `${PRELUDE}\n${body}`], { stdio: 'ignore', windowsHide: true }); c.on('exit', resolve); });
  store.load(); // "reinício": relê o disco, como o servidor novo
  return code;
}
const leftover = (kind) => store.get()[CHILD_KEY].filter((r) => r.kind === kind);

test('QUEDA durante o Planner: a CLI sobrevive à queda; o boot seguinte a identifica pelo registro e a encerra', async () => {
  await helper(`planner.decide({ prompt: 'MODE:sleep', cwd: ${JSON.stringify(tmp)} }); when('planner', () => setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1500)); // espera a CLI falsa escrever e dormir: matar o pai antes dela daria EPIPE nela`);
  const [rec] = leftover('planner'); assert.ok(rec, 'o registro sobreviveu à queda (estava no disco)'); spawned.add(rec.pid, rec.startedAt);
  assert.equal(pidAlive(rec.pid), true, 'a CLI do Planner ficou órfã e viva');
  const executor = newExecutor(), res = createChildRegistry().reclaim({ executor });
  assert.equal(res[0].outcome, 'killed'); assert.equal(pidAlive(rec.pid), false); assert.equal(leftover('planner').length, 0); assert.equal(executor.isBusy(), false);
});

test('QUEDA durante a verificação: o processo sobrevive à queda; o boot seguinte o encerra (e, se a identidade for incerta, bloqueia o executor)', async () => {
  for (const uncertain of [false, true]) {
    await helper(`verifier.run(ws, item); when('verifier', () => process.kill(process.pid, 'SIGKILL'));`);
    const [rec] = leftover('verifier'); assert.ok(rec); spawned.add(rec.pid, rec.startedAt); assert.equal(pidAlive(rec.pid), true, 'o processo da verificação ficou órfão e vivo');
    const executor = newExecutor();
    const res = createChildRegistry(uncertain ? { orphanTools: { startedAtOf: () => null } } : {}).reclaim({ executor });
    if (!uncertain) { assert.equal(res[0].outcome, 'killed'); assert.equal(pidAlive(rec.pid), false); assert.equal(executor.isBusy(), false); } else {
      assert.equal(res[0].outcome, 'unverified'); assert.equal(pidAlive(rec.pid), true, 'identidade incerta: não foi encerrado'); assert.equal(executor.isBusy(), true);
      createChildRegistry().reclaim({ executor: newExecutor() }); assert.equal(pidAlive(rec.pid), false, 'confirmada a identidade no boot seguinte, é encerrado');
    }
    assert.equal(leftover('verifier').length, 0);
  }
});

test('SAÍDA NORMAL durante o Planner e a verificação: os filhos são encerrados ANTES da liberação da trava e o disco fica sem registros', async () => {
  const dir = path.join(tmp, 'lockdir'); fs.mkdirSync(dir);
  const body = `const events = [];
    process.once('exit', () => events.push('lock')); // como o listener da trava de instância (instance-lock.js), registrado ANTES do shutdown
    const lock = { release() {} };
    const owner = (name, o) => ({ killActiveSync: () => { events.push(name); o.killActiveSync(); } });
    installShutdown({ lock, executor: { killActiveSync: () => events.push('executor') }, children: [owner('planner', planner), owner('verifier', verifier)], store });
    process.on('exit', () => fs.writeFileSync(${JSON.stringify(path.join(dir, 'order.json'))}, JSON.stringify(events)));
    planner.decide({ prompt: 'MODE:sleep', cwd: ${JSON.stringify(tmp)} }); verifier.run(ws, item);
    const iv = setInterval(() => { if (reg.pending().length === 2) { clearInterval(iv); fs.writeFileSync(${JSON.stringify(path.join(dir, 'pids.json'))}, JSON.stringify(reg.pending().map((r) => ({ pid: r.pid, startedAt: r.startedAt })))); process.exit(0); } }, 10);`;
  assert.equal(await helper(body), 0);
  const procs = JSON.parse(fs.readFileSync(path.join(dir, 'pids.json'), 'utf8')); procs.forEach((p) => spawned.add(p.pid, p.startedAt)); // já mortos: vale o instante do REGISTRO, não o de agora
  assert.equal(procs.length, 2); for (const { pid } of procs) assert.equal(pidAlive(pid), false, `PID ${pid} encerrado na saída`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'order.json'), 'utf8')), ['executor', 'planner', 'verifier', 'lock']);
  assert.equal(store.get()[CHILD_KEY].length, 0, 'registros apagados e gravados no encerramento (flush)');
});

test('SAÍDA ANORMAL (código 1): os filhos também são encerrados; os registros ficam no disco e o boot seguinte os trata como "já encerrados"', async () => {
  await helper(`planner.decide({ prompt: 'MODE:sleep', cwd: ${JSON.stringify(tmp)} }); installShutdown({ lock: { release() {} }, executor: {}, children: [planner, verifier], store });
    when('planner', () => { fs.writeFileSync(${JSON.stringify(path.join(tmp, 'p.pid'))}, String(reg.pending()[0].pid)); process.exitCode = 1; process.exit(); });`);
  const pid = Number(fs.readFileSync(path.join(tmp, 'p.pid'), 'utf8')); spawned.add(pid, leftover('planner')[0]?.startedAt); // o registro (com a hora do spawn) ficou no disco
  assert.equal(pidAlive(pid), false, 'o filho foi encerrado mesmo na saída anormal'); assert.equal(leftover('planner').length, 1, 'sem flush em saída anormal: o registro ficou no disco');
  const res = createChildRegistry().reclaim({ executor: newExecutor() }); assert.equal(res[0].outcome, 'gone'); assert.equal(leftover('planner').length, 0);
});

// ---- shutdown (unidade) --------------------------------------------------------------------------------------------------------------
test('installShutdown: executor e filhos extras são encerrados na ordem, antes do flush e da trava; um que falha não impede os outros; sem `children` nada muda', () => {
  const rig = (children, killThrows) => {
    const proc = new EventEmitter(), log = [];
    const mk = (n) => ({ killActiveSync: () => { log.push(n); if (killThrows === n) throw new Error('falhou'); } });
    installShutdown({ lock: { release: () => log.push('release') }, executor: mk('executor'), children: children?.map(mk), store: { flush: () => log.push('flush') }, proc, exit: (c) => log.push(`exit:${c}`) });
    return { proc, log };
  };
  const a = rig(['planner', 'verifier']); a.proc.emit('SIGINT'); assert.deepEqual(a.log, ['executor', 'planner', 'verifier', 'flush', 'release', 'exit:130']);
  const b = rig(['planner', 'verifier'], 'planner'); quiet(() => b.proc.emit('SIGTERM')); assert.deepEqual(b.log, ['executor', 'planner', 'verifier', 'flush', 'release', 'exit:143']);
  const c = rig(undefined); c.proc.emit('exit', 0); assert.deepEqual(c.log, ['executor', 'flush']);
  const d = rig(['planner']); d.proc.emit('exit', 1); assert.deepEqual(d.log, ['executor', 'planner'], 'saída anormal: filhos encerrados, sem flush');
});
