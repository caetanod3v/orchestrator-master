// Processos no POSIX (macOS/Linux): zumbi não conta como vivo e killTreeSync encerra a árvore inteira. No Windows não há zumbi e o `taskkill /T` já mata a árvore.
// Só toca processos criados por estes testes (`node -e setInterval`).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const { pidAlive } = await import('../instance-lock.js');
const { descendantsOf, killTreeSync, waitGone } = await import('../orphans.js');

const skip = process.platform === 'win32' ? 'só se aplica ao POSIX' : false;
const SLEEP = 'setInterval(() => {}, 1000)';
const spawned = new Set();
after(() => { for (const pid of spawned) { try { process.kill(pid, 'SIGKILL'); } catch { /* já encerrado */ } } });

function sleeper(code = SLEEP) {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  spawned.add(child.pid);
  return { pid: child.pid, out: () => new Promise((r) => child.stdout.once('data', (d) => r(Number(String(d).trim())))) };
}

test('pidAlive: processo morto e ainda não recolhido pelo pai (zumbi) NÃO conta como vivo', { skip }, () => {
  const s = sleeper();
  assert.equal(pidAlive(s.pid), true);
  process.kill(s.pid, 'SIGKILL');
  // a espera síncrona bloqueia o evento que recolheria o filho: ele fica zumbi, como no waitGone de um boot real
  assert.equal(waitGone(s.pid, 3000), true, 'um zumbi já está morto');
  assert.equal(pidAlive(s.pid), false);
});

test('pidAlive: o próprio processo e um PID inexistente continuam com a resposta de sempre', { skip }, () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 22 + 12345), false);
});

test('descendantsOf: acha filhos e netos, e devolve [] para PID sem descendentes ou inválido', { skip }, async () => {
  const s = sleeper(`const g = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: 'ignore' }); console.log(g.pid); ${SLEEP}`);
  const grandchild = await s.out(); spawned.add(grandchild);
  assert.deepEqual(descendantsOf(s.pid), [grandchild]);
  assert.deepEqual(descendantsOf(grandchild), []);
  assert.deepEqual(descendantsOf(2 ** 22 + 12345), []);
  killTreeSync(s.pid);
});

test('killTreeSync: encerra o filho E o neto (sem o `/T` do Windows, a árvore é lida antes de matar)', { skip }, async () => {
  const s = sleeper(`const g = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: 'ignore' }); console.log(g.pid); ${SLEEP}`);
  const grandchild = await s.out(); spawned.add(grandchild);
  assert.ok(pidAlive(s.pid) && pidAlive(grandchild));
  killTreeSync(s.pid);
  assert.equal(waitGone(s.pid, 3000), true);
  assert.equal(waitGone(grandchild, 3000), true, 'o neto também foi encerrado');
});

test('killTreeSync: PID inválido ou inexistente não lança', { skip }, () => {
  for (const pid of [0, -1, 1.5, NaN, undefined, 2 ** 22 + 12345]) killTreeSync(pid);
});
