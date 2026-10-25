// Trava de instância única: aquisição, recusa, recuperação de trava obsoleta e disputa. Diretórios TEMPORÁRIOS; nada de servidor,
// banco real ou porta. A vivacidade do dono é injetada (isAlive) para o resultado não depender de PIDs reais, exceto no teste de pidAlive.
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireInstanceLock, lockPathFor, pidAlive, LOCK_NAME } from '../instance-lock.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lock-'));
after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });
let n = 0;
const newDir = () => { const d = path.join(root, `d${++n}`); fs.mkdirSync(d); return d; };
const files = (d) => fs.readdirSync(d).sort();
const plant = (d, info) => fs.writeFileSync(lockPathFor(d), typeof info === 'string' ? info : JSON.stringify(info));
const LIVE = 4242, DEAD = 4243;
const alive = (pid) => pid === LIVE;
const hours = (h) => new Date(Date.now() - h * 3600_000).toISOString();

test('adquire a trava (arquivo exclusivo com pid/token) e libera só a própria, de forma idempotente', () => {
  const d = newDir(), lock = acquireInstanceLock({ dir: d, pid: LIVE, isAlive: alive });
  assert.equal(lock.ok, true); assert.equal(lock.lockPath, path.join(d, LOCK_NAME));
  const info = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
  assert.equal(info.pid, LIVE); assert.equal(info.token, lock.token); assert.ok(Date.parse(info.startedAt) <= Date.now());
  lock.release(); assert.deepEqual(files(d), []); lock.release();                                  // idempotente
  const again = acquireInstanceLock({ dir: d, pid: LIVE, isAlive: alive }); assert.equal(again.ok, true);
  const other = { pid: LIVE, startedAt: new Date().toISOString(), token: 'de-outra-instancia' };
  plant(d, other); lock.release();                                                                  // token antigo não remove a trava alheia
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPathFor(d), 'utf8')), other);
});

test('instância ativa: a segunda é recusada com mensagem clara e NADA é alterado', () => {
  const d = newDir(), first = acquireInstanceLock({ dir: d, pid: LIVE, isAlive: alive });
  const before = fs.readFileSync(first.lockPath, 'utf8'), mtime = fs.statSync(first.lockPath).mtimeMs;
  const second = acquireInstanceLock({ dir: d, pid: 777, isAlive: alive });
  assert.equal(second.ok, false); assert.equal(second.holder.pid, LIVE);
  assert.match(second.message, /outra instância do servidor em execução \(PID 4242/); assert.ok(second.message.includes(first.lockPath), 'diz qual arquivo apagar se for engano'); assert.ok(second.message.includes(d));
  assert.equal(fs.readFileSync(first.lockPath, 'utf8'), before); assert.equal(fs.statSync(first.lockPath).mtimeMs, mtime); assert.deepEqual(files(d), [LOCK_NAME]);
  assert.equal(second.release, undefined, 'quem não tem a trava não tem o que liberar');
});

test('trava ABANDONADA (dono morto) é recuperada: a nova instância assume e não sobra resíduo', () => {
  const d = newDir(); plant(d, { pid: DEAD, startedAt: new Date().toISOString(), token: 'antiga' });
  const lock = acquireInstanceLock({ dir: d, pid: LIVE, isAlive: alive });
  assert.equal(lock.ok, true); const info = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
  assert.equal(info.pid, LIVE); assert.equal(info.token, lock.token); assert.notEqual(info.token, 'antiga'); assert.deepEqual(files(d), [LOCK_NAME]);
});

test('PID reaproveitado depois de reiniciar o sistema: trava anterior ao boot é obsoleta mesmo com "dono vivo"', () => {
  const d = newDir(); plant(d, { pid: LIVE, startedAt: hours(48), token: 'de-antes-do-boot' });
  const bootTime = Date.now() - 3600_000;                                                           // sistema ligado há 1 h; a trava é de 48 h atrás
  assert.equal(acquireInstanceLock({ dir: d, pid: 999, isAlive: alive, bootTime }).ok, true);
  const d2 = newDir(); plant(d2, { pid: LIVE, startedAt: new Date().toISOString(), token: 'recente' });
  assert.equal(acquireInstanceLock({ dir: d2, pid: 999, isAlive: alive, bootTime }).ok, false, 'trava posterior ao boot e dono vivo: continua válida');
});

test('arquivo de trava ilegível: recente = outro processo ainda escrevendo (recusa); antigo = obsoleto (recupera)', () => {
  for (const conteudo of ['', '{"pid":', 'lixo', '{"pid":"x"}']) {
    const d = newDir(); plant(d, conteudo);
    const fresh = acquireInstanceLock({ dir: d, pid: LIVE, isAlive: alive });
    assert.equal(fresh.ok, false, `recente: ${JSON.stringify(conteudo)}`); assert.match(fresh.message, /sendo criada por outro processo/); assert.equal(fs.readFileSync(lockPathFor(d), 'utf8'), conteudo);
    const old = new Date(Date.now() - 60_000); fs.utimesSync(lockPathFor(d), old, old);
    const lock = acquireInstanceLock({ dir: d, pid: LIVE, isAlive: alive });
    assert.equal(lock.ok, true, `antigo: ${JSON.stringify(conteudo)}`); assert.deepEqual(files(d), [LOCK_NAME]);
  }
});

test('disputa pela troca da trava obsoleta: se outra instância assume no meio, a trava dela é devolvida e esta desiste', () => {
  const d = newDir(); plant(d, { pid: DEAD, startedAt: new Date().toISOString(), token: 'obsoleta' });
  const live = JSON.stringify({ pid: LIVE, startedAt: new Date().toISOString(), token: 'assumiu-agora' });
  const real = fs.renameSync; let swapped = false;
  mock.method(fs, 'renameSync', (from, to, ...r) => { if (!swapped && String(from).endsWith(LOCK_NAME)) { swapped = true; fs.writeFileSync(from, live); } return real(from, to, ...r); }); // a outra instância troca a trava entre a leitura e o rename
  const res = acquireInstanceLock({ dir: d, pid: 999, isAlive: alive });
  mock.restoreAll();
  assert.equal(swapped, true); assert.equal(res.ok, false); assert.match(res.message, /assumiu a trava durante a inicialização/);
  assert.equal(fs.readFileSync(lockPathFor(d), 'utf8'), live, 'a trava da instância ativa foi devolvida intacta'); assert.deepEqual(files(d), [LOCK_NAME], 'sem resíduo');
});

test('duas instâncias em sequência sobre uma trava obsoleta: só uma vence', () => {
  const d = newDir(); plant(d, { pid: DEAD, startedAt: new Date().toISOString(), token: 'obsoleta' });
  const a = acquireInstanceLock({ dir: d, pid: LIVE, isAlive: alive }), b = acquireInstanceLock({ dir: d, pid: 555, isAlive: (p) => p === LIVE || p === 555 });
  assert.equal(a.ok, true); assert.equal(b.ok, false); assert.equal(b.holder.pid, LIVE);
  assert.equal(JSON.parse(fs.readFileSync(lockPathFor(d), 'utf8')).token, a.token);
});

test('erro de E/S inesperado ao criar a trava não é engolido (nada de subir sem trava)', () => {
  const d = newDir(), real = fs.openSync;
  mock.method(fs, 'openSync', (f, ...r) => { if (String(f).endsWith(LOCK_NAME)) throw Object.assign(new Error('EACCES: simulado'), { code: 'EACCES' }); return real(f, ...r); });
  assert.throws(() => acquireInstanceLock({ dir: d, pid: LIVE, isAlive: alive }), (e) => e.code === 'EACCES');
  mock.restoreAll();
});

test('pidAlive: o próprio processo está vivo; o de um processo já encerrado não', () => {
  assert.equal(pidAlive(process.pid), true);
  const r = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(pidAlive(r.pid), false);
});
