// P7: ENOENT (pasta de dados ausente x temporário ausente), estado de persistência observável e callback do saveSoon protegido.
// Diretórios TEMPORÁRIOS, uma instância nova do módulo por cenário; nada de dados reais.
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pers-'));
const uncaught = [];
const onUncaught = (e) => uncaught.push(e);
process.on('uncaughtException', onUncaught);
after(() => { process.off('uncaughtException', onUncaught); mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

let n = 0;
async function fresh() {
  const dir = path.join(root, `c${++n}`); fs.mkdirSync(dir, { recursive: true });
  process.env.ORCH_DATA_DIR = dir;
  const store = await import(`../store.js?c=${n}`);
  const db = store.load();
  return { store, db, dir, read: (f = 'db.json') => fs.readFileSync(path.join(dir, f), 'utf8'), has: (f) => fs.existsSync(path.join(dir, f)) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (code) => Object.assign(new Error(`${code}: simulado`), { code });
const errors = () => mock.method(console, 'error', () => {});
const system = (db, tag) => db.activity.filter((a) => a.type === 'system' && a.persistence === tag);
/** rename que falha (código dado) quando o DESTINO termina com `suffix`; `times` limita quantas vezes (Infinity = sempre). Conta as chamadas. */
function failRename(suffix, code, times = Infinity) {
  const real = fs.renameSync, c = { calls: 0, failed: 0 };
  mock.method(fs, 'renameSync', (a, b, ...r) => { if (String(b).endsWith(suffix)) { c.calls++; if (c.failed < times) { c.failed++; throw err(code); } } return real(a, b, ...r); });
  return c;
}

test('ENOENT com a PASTA de dados ausente: recria a pasta, grava na hora (sem a espera de ~540 ms) e o backup volta a funcionar', async () => {
  const t = await fresh(); errors();
  t.db.settings.marca = 'a'; t.store.save();
  fs.rmSync(t.dir, { recursive: true, force: true });                         // a pasta de dados desapareceu com o servidor ligado
  t.db.settings.marca = 'b';
  const t0 = Date.now(), ok = t.store.save(), elapsed = Date.now() - t0;
  assert.equal(ok, true); assert.ok(elapsed < 300, `sem retries lentos (${elapsed} ms)`);
  assert.equal(JSON.parse(t.read()).settings.marca, 'b'); assert.equal(t.store.persistenceStatus().ok, true); assert.equal(t.has('db.json.tmp'), false);
  const antes = t.read(); t.db.settings.marca = 'c'; t.store.save();            // o .bak foi embora com a pasta: a próxima mudança o recria com o estado anterior
  assert.equal(t.read('db.json.bak'), antes); assert.equal(t.store.validateDb(JSON.parse(t.read('db.json.bak'))), null);
  mock.restoreAll();
});

test('ENOENT com a pasta ausente e NÃO recriável: falha rápida, estado visível, uma única mensagem e recuperação quando a pasta volta', async () => {
  const t = await fresh(); const log = errors();
  fs.rmSync(t.dir, { recursive: true, force: true });
  const realMk = fs.mkdirSync; mock.method(fs, 'mkdirSync', (p, ...r) => { if (String(p) === t.dir) throw err('EACCES'); return realMk(p, ...r); });
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) assert.equal(t.store.save(), false);
  assert.ok(Date.now() - t0 < 400, 'três salvamentos falhos sem esperas síncronas acumuladas');
  const st = t.store.persistenceStatus();
  assert.equal(st.ok, false); assert.equal(st.error, 'EACCES'); assert.equal(st.consecutiveFailures, 3); assert.ok(st.failedAt);
  assert.ok(!JSON.stringify(st).includes(t.dir), 'o estado não expõe caminhos internos');
  assert.equal(log.mock.calls.filter((c) => /FALHA DE PERSISTÊNCIA/.test(String(c.arguments[0]))).length, 1, 'a falha persistente não inunda o console');
  assert.equal(system(t.db, 'failed').length, 1, 'e gera uma única atividade');
  mock.restoreAll(); errors();                                                  // a pasta pode ser recriada de novo
  assert.equal(t.store.save(), true);
  const ok = t.store.persistenceStatus();
  assert.deepEqual([ok.ok, ok.error, ok.failedAt, ok.consecutiveFailures], [true, null, null, 0]); assert.ok(ok.lastOkAt);
  assert.equal(system(t.db, 'restored').length, 1); assert.equal(system(t.db, 'failed').length, 1);
  mock.restoreAll();
});

test('ENOENT só no arquivo TEMPORÁRIO (a pasta existe): tentativas curtas e limitadas, não as 8 com esperas longas', async () => {
  const t = await fresh(); errors();
  t.db.settings.marca = 'x';
  let c = failRename('db.json', 'ENOENT', 1);                                    // some uma vez e volta
  let t0 = Date.now(); assert.equal(t.store.save(), true); assert.equal(c.calls, 2); assert.ok(Date.now() - t0 < 200);
  assert.equal(JSON.parse(t.read()).settings.marca, 'x'); mock.restoreAll(); errors();
  t.db.settings.marca = 'y';
  c = failRename('db.json', 'ENOENT');                                           // some sempre: no máximo 3 tentativas e depois a escrita direta
  t0 = Date.now(); assert.equal(t.store.save(), true); assert.equal(c.calls, 3, 'limitado a 3 tentativas'); assert.ok(Date.now() - t0 < 300);
  assert.equal(JSON.parse(t.read()).settings.marca, 'y', 'a escrita direta de último recurso persistiu o estado');
  mock.restoreAll();
});

test('ENOENT no rename do BACKUP (pasta existe): tentativas curtas, o banco é gravado e o status do backup mostra a falha', async () => {
  const t = await fresh(); errors();
  t.db.settings.marca = 's1'; t.store.save();
  t.db.settings.marca = 's2';
  const c = failRename('db.json.bak', 'ENOENT');
  assert.equal(t.store.save(), true); assert.equal(c.calls, 3); assert.equal(JSON.parse(t.read()).settings.marca, 's2');
  assert.equal(t.store.backupStatus().ok, false); assert.equal(t.store.backupStatus().error, 'ENOENT'); assert.equal(t.store.persistenceStatus().ok, true, 'a persistência principal está saudável');
  mock.restoreAll();
});

test('callback do saveSoon: falha de disco não vira exceção não tratada; o estado mostra a falha e a próxima gravação se recupera', async () => {
  const t = await fresh(); errors();
  t.db.settings.marca = 'p1'; t.store.saveSoon();
  failRename('db.json', 'EIO');
  await sleep(700);
  assert.deepEqual(uncaught, [], 'nenhuma exceção não tratada'); const st = t.store.persistenceStatus();
  assert.equal(st.ok, false); assert.equal(st.error, 'EIO'); assert.ok(st.consecutiveFailures >= 1);
  mock.restoreAll(); errors();
  t.db.settings.marca = 'p2'; t.store.saveSoon();
  await sleep(700);
  assert.equal(JSON.parse(t.read()).settings.marca, 'p2'); assert.equal(t.store.persistenceStatus().ok, true); assert.equal(system(t.db, 'restored').length, 1);
  assert.deepEqual(uncaught, []);
  mock.restoreAll();
});

test('transições do estado: falhas (lançando) contam e anunciam uma vez; o sucesso limpa e anuncia uma vez; o contrato de save() não muda', async () => {
  const t = await fresh(); const log = errors();
  assert.deepEqual(t.store.persistenceStatus(), { ok: true, error: null, failedAt: null, consecutiveFailures: 0, lastOkAt: t.store.persistenceStatus().lastOkAt });
  failRename('db.json', 'EIO');
  for (let i = 0; i < 3; i++) assert.throws(() => t.store.save(), (e) => e.code === 'EIO');   // erro real continua sendo LANÇADO
  let st = t.store.persistenceStatus(); assert.equal(st.ok, false); assert.equal(st.error, 'EIO'); assert.equal(st.consecutiveFailures, 3);
  assert.equal(log.mock.calls.filter((c) => /FALHA DE PERSISTÊNCIA/.test(String(c.arguments[0]))).length, 1); assert.equal(system(t.db, 'failed').length, 1);
  mock.restoreAll(); errors();
  assert.equal(t.store.save(), true); st = t.store.persistenceStatus();
  assert.deepEqual([st.ok, st.error, st.failedAt, st.consecutiveFailures], [true, null, null, 0]); assert.equal(system(t.db, 'restored').length, 1);
  assert.equal(t.store.save(), true); assert.equal(system(t.db, 'restored').length, 1, 'salvar de novo não repete o anúncio');
  // falha total sem exceção (escrita direta de último recurso também falha): devolve false e marca a falha
  const real = fs.writeFileSync; mock.method(fs, 'writeFileSync', (f, ...r) => { if (String(f).includes('db.json')) throw err('EBUSY'); return real(f, ...r); });
  assert.equal(t.store.save(), false); assert.equal(t.store.persistenceStatus().error, 'EBUSY');
  mock.restoreAll();
});

test('/api/state expõe o estado de persistência (verificação estática: o index.js não pode ser importado sem iniciar o servidor)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8');
  const handler = src.slice(src.indexOf("app.get('/api/state'"), src.indexOf("// ---------- Workspaces"));
  assert.ok(handler.includes('persistence: store.persistenceStatus()'), 'o handler de /api/state inclui o campo aditivo "persistence"');
  assert.ok(handler.includes('settings:') && handler.includes('counts:'), 'e os campos existentes continuam lá');
});
