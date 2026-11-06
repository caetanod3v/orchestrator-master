// Verificação REAL com processo que gera um NETO de longa duração: após timeout, cancelamento ou estouro de saída, o neto também morre e o verificador
// é liberado. O neto herda os pipes de saída (como o `sh` sob o `npm` faz): se sobreviver, o `close` nunca chega e a verificação ficaria presa.
// Roda no Windows (taskkill /T) e no POSIX (killTree de proc.js). Só encerra processos que estes testes criaram.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vtree-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');

const { createVerifier } = await import('../verify.js');
const { pidAlive } = await import('../instance-lock.js');
const { waitGone } = await import('../orphans.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRIPTS = { test: 'echo t', build: 'echo b', lint: 'echo l', typecheck: 'echo c' };

// Processo "pai": sobe o neto (herda stdout/stderr), grava o PID dele em cwd/grandchild.pid e então se comporta conforme `mode`.
const PARENT = path.join(tmp, 'parent.cjs');
fs.writeFileSync(PARENT, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const mode = process.argv[2];
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync('grandchild.pid.tmp', String(g.pid));
fs.renameSync('grandchild.pid.tmp', 'grandchild.pid');
if (mode === 'flood') { const chunk = 'x'.repeat(8192); setInterval(() => process.stdout.write(chunk), 1); }
else if (mode === 'stubborn') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); } // ignora SIGTERM: exige o SIGKILL do prazo (POSIX)
else setInterval(() => {}, 1000);
`);

const MODE = { lint: 'idle', typecheck: 'flood', build: 'stubborn' };
const spawnSpec = (script) => ({ command: process.execPath, args: [PARENT, MODE[script]] });
const item = (script, extra = {}) => ({ id: script, script, command: SCRIPTS[script], required: true, timeoutMs: 3000, ...extra });

const created = new Set(); // todo PID de neto visto: encerrado no after, aconteça o que acontecer
let n = 0;
function workspace() {
  const dir = path.join(tmp, `ws-${++n}`); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: SCRIPTS }));
  return dir;
}
async function grandchildPid(dir, ms = 8000) {
  const file = path.join(dir, 'grandchild.pid');
  for (let t = 0; t < ms; t += 50) {
    if (fs.existsSync(file)) { const pid = Number(fs.readFileSync(file, 'utf8')); if (Number.isInteger(pid) && pid > 0) { created.add(pid); return pid; } }
    await sleep(50);
  }
  assert.fail('o processo de teste não chegou a gravar o PID do neto');
}

after(async () => {
  for (const pid of created) { try { process.kill(pid, 'SIGKILL'); } catch { /* já encerrado */ } }
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const assertTreeDead = async (pid) => {
  assert.equal(waitGone(pid, 5000, pidAlive), true, `o neto ${pid} deveria ter sido encerrado junto com o filho`);
};

test('timeout: o neto morre, o resultado é "timeout" e o verificador é liberado', async () => {
  const dir = workspace();
  const v = createVerifier({ spawnSpec });
  const p = v.run({ path: dir }, item('lint', { timeoutMs: 6000 }));
  const gc = await grandchildPid(dir);
  const r = await p;
  assert.equal(r.status, 'timeout');
  assert.equal(v.isBusy(), false, 'active liberado');
  await assertTreeDead(gc);
});

test('cancelamento: stop() confirma, o neto morre e o resultado é "cancelled"', async () => {
  const dir = workspace();
  const v = createVerifier({ spawnSpec, timeoutMs: 60_000 });
  const p = v.run({ path: dir }, item('lint', { timeoutMs: 60_000 }));
  const gc = await grandchildPid(dir);
  assert.equal(v.isBusy(), true);
  const s = await v.stop();
  assert.equal(s.stopped, true, 'stop() deve confirmar o encerramento');
  const r = await p;
  assert.equal(r.status, 'cancelled');
  assert.equal(v.isBusy(), false);
  await assertTreeDead(gc);
});

test('estouro de saída: o neto morre, o resultado é "output_limit" e o verificador é liberado', async () => {
  const dir = workspace();
  const v = createVerifier({ spawnSpec, maxOutputBytes: 64 * 1024 });
  const r = await v.run({ path: dir }, item('typecheck', { timeoutMs: 30_000 }));
  assert.equal(r.status, 'output_limit');
  assert.equal(v.isBusy(), false);
  await assertTreeDead(await grandchildPid(dir));
});

test('filho que ignora o SIGTERM: o prazo escala para SIGKILL, o neto morre e o verificador é liberado', async () => {
  const dir = workspace();
  const v = createVerifier({ spawnSpec });
  const t0 = Date.now();
  const p = v.run({ path: dir }, item('build', { timeoutMs: 6000 }));
  const gc = await grandchildPid(dir);
  const r = await p;
  assert.equal(r.status, 'timeout');
  assert.ok(Date.now() - t0 < 20_000);
  assert.equal(v.isBusy(), false);
  await assertTreeDead(gc);
});

test('depois de encerrar a árvore, o mesmo verificador aceita uma nova execução', async () => {
  const dir = workspace();
  const v = createVerifier({ spawnSpec });
  const p = v.run({ path: dir }, item('lint', { timeoutMs: 6000 }));
  const gc1 = await grandchildPid(dir);
  assert.equal((await p).status, 'timeout');
  await assertTreeDead(gc1);
  fs.rmSync(path.join(dir, 'grandchild.pid'));
  const p2 = v.run({ path: dir }, item('lint', { timeoutMs: 6000 }));
  const gc2 = await grandchildPid(dir);
  assert.notEqual(gc2, gc1);
  assert.equal((await p2).status, 'timeout');
  await assertTreeDead(gc2);
});
