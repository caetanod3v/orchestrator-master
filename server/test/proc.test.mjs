// killTree (server/proc.js): os dois ramos (Windows e POSIX) são exercitados por injeção de platform/execFile/descendantsOf/kill,
// então o ramo POSIX é coberto também no Windows. Nenhum processo real é criado nem encerrado aqui.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { killTree, GRACE_MS } = await import('../proc.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = Symbol('pending');
const settled = (p, ms = 80) => Promise.race([p.then(() => 'resolved'), sleep(ms).then(() => pending)]);

/** Filho falso: registra os sinais recebidos; `onKill(sig, child)` decide se ele "sai". */
function fakeChild({ pid = 4242, exitCode = null, signalCode = null, onKill = () => {}, killThrows = false } = {}) {
  const c = new EventEmitter();
  Object.assign(c, { pid, exitCode, signalCode, signals: [] });
  c.kill = (sig) => { c.signals.push(sig); if (killThrows) throw new Error('ESRCH'); onKill(sig, c); return true; };
  return c;
}
const exitNow = (c) => { c.exitCode = 0; c.emit('exit', 0, null); };

function posixTools({ subs = [301, 302], killThrows = false } = {}) {
  const log = [];
  return {
    log,
    opts: {
      platform: 'linux',
      descendantsOf: (pid) => { log.push(['descendants', pid]); return subs; },
      kill: (pid, sig) => { log.push(['kill', pid, sig]); if (killThrows) throw new Error('ESRCH'); },
      execFile: () => assert.fail('execFile não deve ser usado no POSIX'),
    },
  };
}

// ---- Windows ----------------------------------------------------------------------------
test('win32: usa taskkill /T /F no PID e resolve quando o taskkill termina', async () => {
  const calls = [];
  let done;
  const child = fakeChild({ pid: 777 });
  const p = killTree(child, {
    platform: 'win32',
    execFile: (file, args, o, cb) => { calls.push({ file, args, o }); done = cb; },
    descendantsOf: () => assert.fail('descendantsOf não é usado no Windows'),
    kill: () => assert.fail('process.kill não é usado no Windows'),
  });
  assert.equal(await settled(p), pending, 'só resolve depois do taskkill');
  done(null);
  await p;
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [['taskkill', ['/PID', '777', '/T', '/F']]]);
  assert.equal(calls[0].o.windowsHide, true);
  assert.deepEqual(child.signals, [], 'o filho não recebe sinal POSIX');
});

test('win32: erro do taskkill (processo já encerrado) não rejeita', async () => {
  await killTree(fakeChild(), { platform: 'win32', execFile: (f, a, o, cb) => cb(new Error('não encontrado')) });
});

// ---- POSIX ------------------------------------------------------------------------------
test('POSIX: filho que já saiu (código ou sinal) não é morto de novo e os descendentes nem são lidos', async () => {
  for (const state of [{ exitCode: 0 }, { exitCode: null, signalCode: 'SIGTERM' }]) {
    const t = posixTools();
    const child = fakeChild(state);
    await killTree(child, t.opts);
    assert.deepEqual(child.signals, []);
    assert.deepEqual(t.log, [], 'o PID pode ter sido reaproveitado: nada é lido nem enviado');
  }
});

test('POSIX: lê os descendentes ANTES do SIGTERM e resolve no exit do filho (sem esperar o prazo)', async () => {
  const t = posixTools();
  const child = fakeChild({ pid: 500, onKill: (sig, c) => { t.log.push(['child.kill', sig]); if (sig === 'SIGTERM') setImmediate(() => exitNow(c)); } });
  const t0 = Date.now();
  await killTree(child, t.opts);
  assert.ok(Date.now() - t0 < 1000, 'não esperou os 3 s');
  assert.deepEqual(t.log.slice(0, 2), [['descendants', 500], ['child.kill', 'SIGTERM']]);
  assert.deepEqual(child.signals, ['SIGTERM'], 'SIGKILL só no fallback');
});

test('POSIX: não resolve enquanto o filho não sair', async () => {
  const child = fakeChild();
  const p = killTree(child, { ...posixTools().opts, graceMs: 5000 });
  assert.equal(await settled(p), pending);
  exitNow(child);
  await p;
});

test('POSIX: varredura pós-exit mata os descendentes que sobraram (netos seguram os pipes)', async () => {
  const t = posixTools({ subs: [301, 302, 303] });
  const child = fakeChild({ onKill: (sig, c) => { if (sig === 'SIGTERM') setImmediate(() => exitNow(c)); } });
  await killTree(child, t.opts);
  assert.deepEqual(t.log.filter((e) => e[0] === 'kill'), [301, 302, 303].map((p) => ['kill', p, 'SIGKILL']));
});

test('POSIX: filho que ignora o SIGTERM -> após o prazo, SIGKILL nele e nos descendentes', async () => {
  const t = posixTools();
  const child = fakeChild(); // nunca sai sozinho
  const t0 = Date.now();
  await killTree(child, { ...t.opts, graceMs: 60 });
  assert.ok(Date.now() - t0 >= 50, 'esperou o prazo antes de escalar');
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(t.log.filter((e) => e[0] === 'kill'), [['kill', 301, 'SIGKILL'], ['kill', 302, 'SIGKILL']]);
});

test('POSIX: o exit cancela o prazo (sem SIGKILL tardio nem varredura dupla)', async () => {
  const t = posixTools();
  const child = fakeChild({ onKill: (sig, c) => { if (sig === 'SIGTERM') setImmediate(() => exitNow(c)); } });
  await killTree(child, { ...t.opts, graceMs: 60 });
  await sleep(150); // passa o prazo original
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(t.log.filter((e) => e[0] === 'kill').length, 2, 'varreu uma única vez');
});

test('POSIX: sem descendentes (ou leitura que falhou = []) só o filho é encerrado', async () => {
  const t = posixTools({ subs: [] });
  const child = fakeChild({ onKill: (sig, c) => setImmediate(() => exitNow(c)) });
  await killTree(child, t.opts);
  assert.deepEqual(t.log.filter((e) => e[0] === 'kill'), []);
});

test('POSIX: descendente já morto (kill lança) ou child.kill que lança não rejeitam nem travam', async () => {
  const a = posixTools({ killThrows: true });
  const c1 = fakeChild({ onKill: (sig, c) => setImmediate(() => exitNow(c)) });
  await killTree(c1, a.opts);
  assert.equal(a.log.filter((e) => e[0] === 'kill').length, 2, 'tentou todos mesmo com erro no primeiro');

  const b = posixTools();
  const c2 = fakeChild({ killThrows: true });
  await killTree(c2, { ...b.opts, graceMs: 40 }); // o prazo conclui
  assert.deepEqual(c2.signals, ['SIGTERM', 'SIGKILL']);
});

test('win32: filho que JÁ saiu não recebe taskkill (o PID pode ter sido reaproveitado por outro processo)', async () => {
  for (const state of [{ exitCode: 0 }, { exitCode: null, signalCode: 'SIGKILL' }]) {
    let called = false;
    await killTree(fakeChild(state), { platform: 'win32', execFile: () => { called = true; } });
    assert.equal(called, false, JSON.stringify(state));
  }
});

test('POSIX: a varredura dos descendentes acontece UMA vez (prazo e exit não varrem de novo um PID que pode ter sido reaproveitado)', async () => {
  const t = posixTools({ subs: [301] });
  const c = fakeChild(); // ignora SIGTERM: o prazo dispara o SIGKILL e a varredura
  const p = killTree(c, { ...t.opts, graceMs: 30 });
  await p;
  exitNow(c); // o exit chega depois do prazo
  await sleep(10);
  assert.equal(t.log.filter((e) => e[0] === 'kill' && e[1] === 301).length, 1);
});

test('prazo padrão é de 3 s', () => { assert.equal(GRACE_MS, 3000); });
