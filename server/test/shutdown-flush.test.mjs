// P6: ordem do encerramento FILHO -> FLUSH -> TRAVA e quando o flush NÃO deve ocorrer. Unidade com proc/store/executor falsos e, para o evento
// "exit" real, processos filhos de teste (node -e) com a trava e o store reais em diretório TEMPORÁRIO. Nenhum servidor é iniciado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installShutdown } from '../shutdown.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sdf-'));
after(() => { fs.rmSync(root, { recursive: true, force: true }); });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const url = (f) => pathToFileURL(path.join(HERE, '..', f)).href;

function rig({ flushThrows = false, killThrows = false, withStore = true } = {}) {
  const proc = new EventEmitter(), log = [];
  const executor = { killActiveSync: () => { log.push('kill'); if (killThrows) throw new Error('kill falhou'); } };
  const store = withStore ? { flush: () => { log.push('flush'); if (flushThrows) throw new Error('flush falhou'); return true; } } : undefined;
  const lock = { release: () => log.push('release') };
  installShutdown({ lock, executor, store, proc, exit: (c) => log.push(`exit:${c}`) });
  return { proc, log };
}
const quiet = (fn) => { const q = console.error; console.error = () => {}; try { return fn(); } finally { console.error = q; } };

test('sinais: ordem filho -> flush -> trava -> saída, com o código certo', () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 143], ['SIGBREAK', 143]]) {
    const { proc, log } = rig(); proc.emit(sig);
    assert.deepEqual(log, ['kill', 'flush', 'release', `exit:${code}`], sig);
  }
});

test('falha do flush (ou do encerramento do filho) não impede as etapas seguintes nem a saída', () => {
  for (const opts of [{ flushThrows: true }, { killThrows: true }, { flushThrows: true, killThrows: true }]) {
    const { proc, log } = rig(opts);
    quiet(() => proc.emit('SIGINT'));
    assert.deepEqual(log, ['kill', 'flush', 'release', 'exit:130'], JSON.stringify(opts));
  }
});

test('evento exit: com código 0 faz filho -> flush; com código diferente de 0 (queda) NÃO faz flush; sem store não quebra', () => {
  const ok = rig(); ok.proc.emit('exit', 0); assert.deepEqual(ok.log, ['kill', 'flush']);
  const sem = rig(); sem.proc.emit('exit'); assert.deepEqual(sem.log, ['kill', 'flush'], 'sem código informado é tratado como saída normal');
  const queda = rig(); queda.proc.emit('exit', 1); assert.deepEqual(queda.log, ['kill'], 'saída anormal: o estado em memória pode estar no meio de uma mutação');
  const nostore = rig({ withStore: false }); assert.doesNotThrow(() => { nostore.proc.emit('exit', 0); nostore.proc.emit('SIGTERM'); });
});

/** Processo filho de teste: trava e store REAIS (pasta temporária), saveSoon pendente e `ending`; devolve o código, a ordem registrada e o estado do disco. */
async function run(ending) {
  const dir = fs.mkdtempSync(path.join(root, 'r-')), orderFile = path.join(dir, 'order.json');
  const code = `import fs from 'node:fs';
    process.env.ORCH_DATA_DIR = ${JSON.stringify(dir)};
    const store = await import(${JSON.stringify(url('store.js'))});
    const { acquireInstanceLock, lockPathFor } = await import(${JSON.stringify(url('instance-lock.js'))});
    const { installShutdown } = await import(${JSON.stringify(url('shutdown.js'))});
    const dir = ${JSON.stringify(dir)}, order = [];
    const lock = acquireInstanceLock({ dir, autoRelease: true }); if (!lock.ok) process.exit(9);
    const db = store.load();
    process.on('exit', () => fs.writeFileSync(${JSON.stringify(orderFile)}, JSON.stringify(order)));
    const wrapped = { flush: () => { order.push({ step: 'flush', lockExists: fs.existsSync(lockPathFor(dir)) }); return store.flush(); } };
    installShutdown({ lock, executor: { killActiveSync: () => order.push({ step: 'kill', lockExists: fs.existsSync(lockPathFor(dir)) }) }, store: wrapped });
    db.settings.marca = 'linha-final'; store.saveSoon();
    ${ending}`;
  const exitCode = await new Promise((resolve) => { const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', windowsHide: true }); c.on('exit', resolve); });
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).settings.marca;
  return { exitCode, order: JSON.parse(fs.readFileSync(orderFile, 'utf8')), disk, lock: fs.existsSync(path.join(dir, 'server.lock')) };
}

test('evento exit REAL (process.exit(0)): filho -> flush com a trava ainda de pé, o log pendente vai para o disco e a trava é liberada depois', async () => {
  const r = await run('process.exit(0);');
  assert.equal(r.exitCode, 0); assert.deepEqual(r.order, [{ step: 'kill', lockExists: true }, { step: 'flush', lockExists: true }]);
  assert.equal(r.disk, 'linha-final', 'a linha pendente do saveSoon foi gravada no encerramento'); assert.equal(r.lock, false, 'e a trava foi liberada depois');
});

test('saída anormal REAL (código 1 e exceção não tratada): o filho é encerrado e a trava liberada, mas o saveSoon pendente NÃO é gravado', async () => {
  for (const ending of ['process.exitCode = 1; process.exit();', "throw new Error('queda simulada');"]) {
    const r = await run(ending);
    assert.notEqual(r.exitCode, 0, ending); assert.deepEqual(r.order, [{ step: 'kill', lockExists: true }], 'sem flush');
    assert.notEqual(r.disk, 'linha-final', 'estado possivelmente parcial não é persistido'); assert.equal(r.lock, false);
  }
});
