// M5/P3: db.json.bak guarda o último estado VÁLIDO anterior ao db.json atual. Só muda depois de o db.json novo estar gravado, só recebe
// estados válidos e é trocado por rename atômico. Diretórios TEMPORÁRIOS e uma instância nova do módulo por cenário; nada de dados reais.
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bak-'));
after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

let n = 0;
async function fresh(files = {}) {
  const dir = path.join(root, `c${++n}`); fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  process.env.ORCH_DATA_DIR = dir;
  const store = await import(`../store.js?c=${n}`);
  const p = (name) => path.join(dir, name);
  return { store, dir, p, read: (name) => fs.readFileSync(p(name), 'utf8'), has: (name) => fs.existsSync(p(name)), list: () => fs.readdirSync(dir).sort() };
}
const quiet = () => mock.method(console, 'error', () => {});
const err = (code) => Object.assign(new Error(`${code}: simulado`), { code });
const okDb = (marker) => ({ version: 1, settings: { activeWorkspaceId: null, requireApproval: true, showDemoData: false, marker }, workspaces: [], missions: [], activity: [] });
const json = (o) => JSON.stringify(o, null, 2);
const valid = (store, text) => store.validateDb(JSON.parse(text)) === null;
/** rename falha quando o DESTINO termina com `suffix` */
const failRename = (suffix, code) => { const real = fs.renameSync; mock.method(fs, 'renameSync', (a, b, ...r) => { if (String(b).endsWith(suffix)) throw err(code); return real(a, b, ...r); }); };

test('primeiro salvamento: db.json válido, ainda sem backup (não havia estado anterior)', async () => {
  const t = await fresh(); quiet();
  t.store.load();
  assert.ok(valid(t.store, t.read('db.json'))); assert.equal(t.has('db.json.bak'), false);
  assert.deepEqual(t.store.backupStatus().ok, true);
  mock.restoreAll();
});

test('salvamentos sucessivos: o .bak é sempre o estado válido ANTERIOR, byte a byte, e o db.json é o novo', async () => {
  const t = await fresh(); quiet();
  const db = t.store.load();
  for (const marker of ['um', 'dois', 'tres', 'quatro']) {
    const previous = t.read('db.json');
    db.settings.marker = marker; assert.equal(t.store.save(), true);
    assert.equal(JSON.parse(t.read('db.json')).settings.marker, marker);
    assert.equal(t.read('db.json.bak'), previous, `.bak == db.json anterior (${marker})`); assert.ok(valid(t.store, t.read('db.json.bak')));
  }
  assert.equal(t.list().filter((f) => f.includes('.tmp')).length, 0, 'nenhum temporário sobrou'); assert.equal(t.store.backupStatus().ok, true);
  mock.restoreAll();
});

test('o primeiro salvamento depois de CARREGAR um banco existente preserva exatamente o que foi carregado', async () => {
  const original = json(okDb('carregado'));
  const t = await fresh({ 'db.json': original });
  const db = t.store.load(); assert.equal(t.has('db.json.bak'), false, 'carregar não cria backup');
  db.settings.marker = 'alterado'; t.store.save();
  assert.equal(t.read('db.json.bak'), original); assert.equal(JSON.parse(t.read('db.json')).settings.marker, 'alterado');
});

test('salvar de novo sem mudança de estado não troca um backup útil por uma cópia do estado atual', async () => {
  const t = await fresh(); quiet();
  const db = t.store.load();
  db.settings.marker = 'a'; t.store.save(); const a = t.read('db.json');
  db.settings.marker = 'b'; t.store.save();
  assert.equal(t.read('db.json.bak'), a);
  for (let i = 0; i < 3; i++) t.store.save();                       // nada mudou
  assert.equal(t.read('db.json.bak'), a, 'o backup continua sendo o estado anterior ao atual');
  mock.restoreAll();
});

test('falha ao ATUALIZAR o backup (rename/escrita): o db.json novo é gravado, o .bak antigo fica intacto e válido, e o status mostra a falha', async () => {
  for (const [nome, install] of [
    ['rename com erro real (EIO)', () => failRename('.bak', 'EIO')],
    ['rename transitório persistente (EBUSY)', () => failRename('.bak', 'EBUSY')],
    ['escrita do temporário do backup (ENOSPC)', () => { const real = fs.writeFileSync; mock.method(fs, 'writeFileSync', (f, ...r) => { if (String(f).endsWith('.bak.tmp')) throw err('ENOSPC'); return real(f, ...r); }); }],
  ]) {
    const t = await fresh(); quiet();
    const db = t.store.load();
    db.settings.marker = 's1'; t.store.save(); const s0 = t.read('db.json.bak'), s1 = t.read('db.json');
    install();
    db.settings.marker = 's2';
    assert.equal(t.store.save(), true, `${nome}: o banco foi persistido`);
    assert.equal(JSON.parse(t.read('db.json')).settings.marker, 's2');
    assert.equal(t.read('db.json.bak'), s0, `${nome}: o backup anterior não foi tocado`); assert.ok(valid(t.store, t.read('db.json.bak')));
    assert.equal(t.has('db.json.bak.tmp'), false, `${nome}: sem resíduo`);
    const st = t.store.backupStatus(); assert.equal(st.ok, false); assert.match(st.error, /EIO|EBUSY|ENOSPC/);
    mock.restoreAll(); quiet();
    db.settings.marker = 's3'; assert.equal(t.store.save(), true);     // volta ao normal: o backup é retomado a partir do estado válido anterior
    assert.equal(t.store.backupStatus().ok, true); assert.equal(JSON.parse(t.read('db.json.bak')).settings.marker, 's2');
    assert.notEqual(t.read('db.json.bak'), s1);
    mock.restoreAll();
  }
});

test('falha no salvamento PRINCIPAL: não reporta sucesso, o db.json e o backup ficam como estavam e o próximo salvamento é consistente', async () => {
  const t = await fresh(); quiet();
  const db = t.store.load();
  db.settings.marker = 's1'; t.store.save(); db.settings.marker = 's2'; t.store.save();
  const main = t.read('db.json'), bak = t.read('db.json.bak');
  failRename('db.json', 'EIO');                                     // erro real no rename principal (o do .bak não é afetado: destino diferente)
  db.settings.marker = 's3';
  assert.throws(() => t.store.save(), (e) => e.code === 'EIO');
  assert.equal(t.read('db.json'), main, 'db.json intocado'); assert.equal(t.read('db.json.bak'), bak, 'backup intocado (só muda depois do principal)');
  mock.restoreAll(); quiet();
  assert.equal(t.store.save(), true);                                 // s3 ainda está na memória
  assert.equal(JSON.parse(t.read('db.json')).settings.marker, 's3'); assert.equal(t.read('db.json.bak'), main, 'o backup é o estado válido que estava no disco');
  mock.restoreAll();
});

test('falha total da gravação (inclusive o último recurso): save() devolve false, nada muda no disco e o backup não é tocado', async () => {
  const t = await fresh(); quiet();
  const db = t.store.load();
  db.settings.marker = 's1'; t.store.save(); db.settings.marker = 's2'; t.store.save();
  const main = t.read('db.json'), bak = t.read('db.json.bak'), status = t.store.backupStatus();
  const real = fs.writeFileSync; mock.method(fs, 'writeFileSync', (f, ...r) => { if (String(f).includes('db.json')) throw err('EBUSY'); return real(f, ...r); });
  db.settings.marker = 's3';
  assert.equal(t.store.save(), false);
  mock.restoreAll();
  assert.equal(t.read('db.json'), main); assert.equal(t.read('db.json.bak'), bak); assert.deepEqual(t.store.backupStatus(), status);
});

test('o backup nunca recebe estado inválido: um estado em memória quebrado é gravado no db.json, mas o .bak guarda o último VÁLIDO', async () => {
  const t = await fresh(); quiet();
  const db = t.store.load();
  db.settings.marker = 'bom'; t.store.save(); const bom = t.read('db.json');
  const missions = db.missions; db.missions = null;                  // estado inválido (bug hipotético)
  assert.equal(t.store.save(), true);
  assert.equal(t.read('db.json.bak'), bom, 'o último estado válido virou o backup');
  assert.ok(!valid(t.store, t.read('db.json')), 'o db.json contém o estado quebrado (comportamento de gravação inalterado)');
  t.store.save(); assert.equal(t.read('db.json.bak'), bom, 'salvar de novo o estado inválido não mexe no backup');
  db.missions = missions; db.settings.marker = 'recuperado'; t.store.save();
  assert.equal(t.read('db.json.bak'), bom, 'o backup continua sendo o estado válido anterior');
  mock.restoreAll();
});

test('recuperação a partir do .bak: com o db.json quebrado, o próximo boot volta ao estado válido anterior e registra a recuperação', async () => {
  const t = await fresh(); quiet();
  const db = t.store.load();
  db.settings.marker = 'bom'; t.store.save(); const bom = t.read('db.json');
  db.settings.marker = 'ultimo'; t.store.save();                      // .bak == 'bom'
  fs.writeFileSync(t.p('db.json'), '{"queda no meio da escrita');    // simula arquivo principal corrompido
  process.env.ORCH_DATA_DIR = t.dir;
  const again = await import(`../store.js?c=${++n}`);
  const db2 = again.load();
  assert.equal(db2.settings.marker, 'bom'); assert.equal(db2.activity.find((a) => a.recovery === 'restored').source, 'db.json.bak');
  assert.ok(t.list().some((f) => f.includes('.corrupt-')), 'o arquivo quebrado foi preservado');
  assert.equal(JSON.parse(t.read('db.json')).settings.marker, 'bom'); assert.ok(valid(again, t.read('db.json')));
  assert.equal(t.read('db.json.bak'), bom, 'o .bak segue válido e igual ao estado de que se recuperou');
  mock.restoreAll();
});

test('recuperação a partir do .tmp passa a ser também o backup (cópia válida e mais nova), e a partir do .bak não regrava o .bak', async () => {
  const bak = json(okDb('antigo')), tmp = json(okDb('mais-novo'));
  const t = await fresh({ 'db.json': 'x', 'db.json.tmp': tmp, 'db.json.bak': bak }); quiet();
  t.store.load();
  assert.equal(JSON.parse(t.read('db.json')).settings.marker, 'mais-novo'); assert.equal(t.read('db.json.bak'), tmp);
  const t2 = await fresh({ 'db.json': 'x', 'db.json.bak': bak });
  const before = fs.statSync(t2.p('db.json.bak')).mtimeMs;
  t2.store.load();
  assert.equal(t2.read('db.json.bak'), bak); assert.equal(fs.statSync(t2.p('db.json.bak')).mtimeMs, before, 'o .bak de origem não foi regravado');
  mock.restoreAll();
});
