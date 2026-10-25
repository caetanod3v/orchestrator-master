// P6: flush() grava o que o saveSoon() deixou pendente e save() cancela o timer pendente. Diretórios TEMPORÁRIOS, uma instância nova do módulo
// por cenário; nada de dados reais. As gravações são contadas interceptando fs.writeFileSync (mesmo objeto fs usado pelo store.js).
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-flush-'));
after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

let n = 0;
async function fresh() {
  const dir = path.join(root, `c${++n}`); fs.mkdirSync(dir, { recursive: true });
  process.env.ORCH_DATA_DIR = dir;
  const store = await import(`../store.js?c=${n}`);
  const db = store.load();
  return { store, db, dir, read: (f = 'db.json') => fs.readFileSync(path.join(dir, f), 'utf8'), marca: () => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).settings.marca };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Conta as gravações do arquivo temporário do banco (cada save() grava db.json.tmp uma vez) a partir de agora. */
function countWrites() {
  const real = fs.writeFileSync, c = { n: 0 };
  mock.method(fs, 'writeFileSync', (f, ...r) => { if (String(f).endsWith('db.json.tmp')) c.n++; return real(f, ...r); });
  return c;
}
const quiet = () => mock.method(console, 'error', () => {});
const failMainRename = () => {
  const real = fs.renameSync;
  mock.method(fs, 'renameSync', (a, b, ...r) => { if (String(b).endsWith('db.json')) { const e = new Error('EIO: simulado'); e.code = 'EIO'; throw e; } return real(a, b, ...r); });
};

test('saveSoon() + flush(): grava IMEDIATAMENTE e o timer cancelado não provoca outra gravação', async () => {
  const t = await fresh(); quiet();
  t.db.settings.marca = 'linha-final'; t.store.saveSoon();
  assert.notEqual(t.marca(), 'linha-final', 'antes do flush o disco ainda não tem o estado novo');
  const w = countWrites();
  assert.equal(t.store.flush(), true);
  assert.equal(t.marca(), 'linha-final', 'gravado na hora, sem esperar os 500 ms'); assert.equal(w.n, 1);
  await sleep(700);
  assert.equal(w.n, 1, 'o timer foi cancelado: nenhuma gravação redundante depois');
  mock.restoreAll();
});

test('flush() sem pendência não escreve (nem o mtime muda) e devolve false', async () => {
  const t = await fresh(); quiet();
  t.db.settings.marca = 'a'; t.store.save();
  const before = fs.statSync(path.join(t.dir, 'db.json')).mtimeMs, bytes = t.read(), w = countWrites();
  assert.equal(t.store.flush(), false); assert.equal(t.store.flush(), false);
  assert.equal(w.n, 0); assert.equal(fs.statSync(path.join(t.dir, 'db.json')).mtimeMs, before); assert.equal(t.read(), bytes);
  t.db.settings.marca = 'b'; t.store.saveSoon(); assert.equal(t.store.flush(), true); assert.equal(t.store.flush(), false, 'depois de um flush não há mais pendência');
  mock.restoreAll();
});

test('save() cancela o saveSoon pendente: uma gravação só, não duas', async () => {
  const t = await fresh(); quiet();
  t.db.settings.marca = 'x'; t.store.saveSoon();
  const w = countWrites();
  assert.equal(t.store.save(), true);
  await sleep(700);
  assert.equal(w.n, 1, 'o timer pendente foi cancelado pelo save()'); assert.equal(t.marca(), 'x');
  mock.restoreAll();
});

test('save() que FALHA não cancela o saveSoon: a nova tentativa continua agendada e grava quando o disco volta', async () => {
  const t = await fresh(); quiet();
  t.db.settings.marca = 'persistir'; t.store.saveSoon();
  failMainRename();
  assert.throws(() => t.store.save(), (e) => e.code === 'EIO');
  mock.restoreAll(); quiet();
  await sleep(700);
  assert.equal(t.marca(), 'persistir', 'o timer que ficou agendado gravou depois');
  mock.restoreAll();
});

test('falha de escrita no flush: não lança, devolve false, registra o erro e não deixa nova tentativa pendente', async () => {
  const t = await fresh(); const log = mock.method(console, 'error', () => {});
  t.db.settings.marca = 'perdido'; t.store.saveSoon();
  const bytes = t.read();
  failMainRename();
  let r; assert.doesNotThrow(() => { r = t.store.flush(); });
  assert.equal(r, false); assert.ok(log.mock.calls.some((c) => /flush não gravou/.test(String(c.arguments[0])))); assert.equal(t.read(), bytes, 'o disco ficou como estava');
  mock.restoreAll(); quiet();
  assert.equal(t.store.flush(), false, 'nada pendente: o encerramento não fica tentando de novo');
  mock.restoreAll();
});

test('o flush preserva o backup do P3: o .bak vira o estado válido anterior e o db.json o novo', async () => {
  const t = await fresh(); quiet();
  t.db.settings.marca = 's1'; t.store.save(); const s1 = t.read();
  t.db.settings.marca = 's2'; t.store.saveSoon(); assert.equal(t.store.flush(), true);
  assert.equal(t.marca(), 's2'); assert.equal(t.read('db.json.bak'), s1, 'backup = estado anterior, byte a byte');
  assert.equal(t.store.validateDb(JSON.parse(t.read())), null); assert.equal(t.store.validateDb(JSON.parse(t.read('db.json.bak'))), null); assert.equal(t.store.backupStatus().ok, true);
  assert.deepEqual(fs.readdirSync(t.dir).filter((f) => f.endsWith('.tmp')), [], 'nenhum temporário sobrou');
  mock.restoreAll();
});
