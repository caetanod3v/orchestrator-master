// Regressão: falha transitória de rename (EPERM/EBUSY) no Windows não pode derrubar o salvamento nem o ciclo.
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-store-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const store = await import('../store.js');
const db = store.load();
const file = path.join(process.env.ORCH_DATA_DIR, 'db.json');
const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const err = (code) => Object.assign(new Error(`${code}: simulado`), { code });
after(() => { mock.restoreAll(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('save normal grava o estado', () => {
  db.settings.marca = 'a'; assert.equal(store.save(), true);
  assert.equal(disk().settings.marca, 'a');
});

test('EPERM transitório no rename: tenta de novo e conclui sem lançar', () => {
  const real = fs.renameSync; let n = 0;
  mock.method(fs, 'renameSync', (...a) => { if (++n <= 3) throw err('EPERM'); return real(...a); });
  db.settings.marca = 'b';
  assert.equal(store.save(), true);
  assert.ok(n >= 4, `rename tentado ${n}x`); assert.equal(disk().settings.marca, 'b');
  mock.restoreAll();
});

test('rename sempre falhando: grava direto como último recurso (estado não se perde)', () => {
  mock.method(fs, 'renameSync', () => { throw err('EBUSY'); });
  db.settings.marca = 'c';
  assert.equal(store.save(), true); assert.equal(disk().settings.marca, 'c');
  mock.restoreAll();
});

test('erro que NÃO é transitório continua sendo lançado (não esconde problema real)', () => {
  mock.method(fs, 'renameSync', () => { throw err('EIO'); });
  assert.throws(() => store.save(), (e) => e.code === 'EIO');
  mock.restoreAll();
});
