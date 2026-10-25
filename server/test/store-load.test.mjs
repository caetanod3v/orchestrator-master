// M5/P1: load() valida a estrutura, recupera db.json.tmp / db.json.bak e nunca faz um reset silencioso.
// Cada cenário usa um diretório TEMPORÁRIO próprio e uma instância nova do módulo (store.js?c=N); o db.json real nunca é tocado.
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-load-'));
after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

let n = 0;
/** Diretório de dados novo + módulo store novo (o caminho do banco é fixado na importação). */
async function fresh(files = {}) {
  const dir = path.join(root, `c${++n}`); fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  process.env.ORCH_DATA_DIR = dir;
  const store = await import(`../store.js?c=${n}`);
  const p = (name) => path.join(dir, name);
  return { store, dir, p, corrupt: () => fs.readdirSync(dir).filter((f) => f.includes('.corrupt-')), read: (name) => fs.readFileSync(p(name), 'utf8'), diskDb: () => JSON.parse(fs.readFileSync(p('db.json'), 'utf8')) };
}
const okDb = (marker) => ({
  version: 1, settings: { activeWorkspaceId: 'ws1', requireApproval: true, showDemoData: false, marker },
  workspaces: [{ id: 'ws1', name: 'w', path: 'C:\\projeto' }],
  missions: [{ id: 'm1', demo: false, title: 't', workspaceId: 'ws1', tasks: [{ id: 't1', status: 'completed' }], cycle: { status: 'completed', rounds: [], blocks: [], humanNotes: [] }, pastCycles: [] }],
  activity: [],
});
const json = (o) => JSON.stringify(o, null, 2);
const quiet = () => mock.method(console, 'error', () => {});
const sys = (db) => db.activity.filter((a) => a.type === 'system');

test('arquivo ausente e sem cópias: primeira execução (banco inicial, sem aviso de recuperação)', async () => {
  const t = await fresh(); quiet();
  const db = t.store.load();
  assert.ok(db.missions.length > 0 && db.missions.every((m) => m.demo)); assert.equal(sys(db).length, 0);
  assert.equal(t.corrupt().length, 0); assert.equal(t.diskDb().version, 1);
  mock.restoreAll();
});

test('db.json válido: carregado como está, sem copiar nem consultar .tmp/.bak', async () => {
  const t = await fresh({ 'db.json': json(okDb('principal')), 'db.json.tmp': json(okDb('tmp')), 'db.json.bak': json(okDb('bak')) });
  const db = t.store.load();
  assert.equal(db.settings.marker, 'principal'); assert.equal(db.activity.length, 0);
  assert.equal(t.corrupt().length, 0); assert.equal(fs.existsSync(t.p('db.json.restore')), false);
  assert.equal(JSON.parse(t.read('db.json.tmp')).settings.marker, 'tmp', 'cópias intactas');
});

test('estrutura mínima: aceita bancos antigos (sem version/pastCycles, ciclo null) e recusa o que quebraria o boot', async () => {
  const { store } = await fresh();
  const base = okDb('x');
  assert.equal(store.validateDb(base), null);
  const legado = okDb('x'); delete legado.version; delete legado.missions[0].pastCycles; legado.missions[0].cycle = null; legado.missions.push({ id: 'm2', tasks: [] });
  assert.equal(store.validateDb(legado), null, 'campos opcionais ausentes não rejeitam');
  const bad = (mut) => { const d = okDb('x'); mut(d); return store.validateDb(d); };
  for (const [nome, mut] of [
    ['settings ausente', (d) => { delete d.settings; }], ['settings array', (d) => { d.settings = []; }],
    ['missions ausente', (d) => { delete d.missions; }], ['workspaces não-lista', (d) => { d.workspaces = {}; }], ['activity ausente', (d) => { delete d.activity; }],
    ['workspace sem path', (d) => { delete d.workspaces[0].path; }], ['missão sem id', (d) => { delete d.missions[0].id; }], ['missão sem tasks', (d) => { delete d.missions[0].tasks; }],
    ['tarefa não-objeto', (d) => { d.missions[0].tasks = [null]; }], ['ciclo sem rounds', (d) => { d.missions[0].cycle = { status: 'blocked' }; }], ['ciclo não-objeto', (d) => { d.missions[0].cycle = 'x'; }],
  ]) assert.ok(bad(mut), nome);
  for (const v of [null, [], 'texto', 42, {}]) assert.ok(store.validateDb(v), JSON.stringify(v));
});

test('JSON malformado ou arquivo vazio, sem cópias: modo DEGRADADO explícito e o original preservado byte a byte', async () => {
  for (const conteudo of ['{"settings": {', '', '   \n']) {
    const t = await fresh({ 'db.json': conteudo }); quiet();
    const db = t.store.load();
    assert.equal(sys(db).length, 1); assert.match(sys(db)[0].message, /RECUPERAÇÃO DEGRADADA.*nenhuma cópia válida/); assert.equal(sys(db)[0].recovery, 'degraded');
    const kept = t.corrupt(); assert.equal(kept.length, 1, 'uma cópia de diagnóstico'); assert.equal(t.read(kept[0]), conteudo, 'conteúdo original intacto');
    assert.match(sys(db)[0].message, new RegExp(kept[0].replace(/\./g, '\\.')));
    assert.ok(t.diskDb().activity.some((a) => a.recovery === 'degraded'), 'o aviso foi gravado no banco novo');
    mock.restoreAll();
  }
});

test('JSON válido de estrutura errada (null, array, {} e sem campos essenciais): degradado, nunca aceito', async () => {
  const casos = ['null', '[]', '{}', '"texto"', json({ ...okDb('x'), missions: [{ id: 'm' }] }), json({ ...okDb('x'), settings: undefined }), json({ ...okDb('x'), activity: 'x' })];
  for (const conteudo of casos) {
    const t = await fresh({ 'db.json': conteudo }); quiet();
    const db = t.store.load();
    assert.equal(sys(db)[0]?.recovery, 'degraded', conteudo.slice(0, 40)); assert.match(sys(db)[0].message, /estrutura inválida|JSON inválido/);
    assert.equal(t.read(t.corrupt()[0]), conteudo); assert.doesNotThrow(() => t.store.validateDb(db)); assert.equal(t.store.validateDb(db), null);
    mock.restoreAll();
  }
});

test('db.json inválido + db.json.tmp válido: recupera o .tmp, preserva o inválido e registra na atividade', async () => {
  const t = await fresh({ 'db.json': '{"quebrado":', 'db.json.tmp': json(okDb('do-tmp')) }); quiet();
  const db = t.store.load();
  assert.equal(db.settings.marker, 'do-tmp'); assert.equal(db.missions[0].id, 'm1', 'o estado do .tmp, não o banco demo');
  assert.equal(sys(db).length, 1); assert.equal(sys(db)[0].recovery, 'restored'); assert.equal(sys(db)[0].source, 'db.json.tmp'); assert.match(sys(db)[0].message, /Banco recuperado de db\.json\.tmp.*db\.json estava inválido/);
  const kept = t.corrupt(); assert.equal(kept.length, 1); assert.equal(t.read(kept[0]), '{"quebrado":');
  assert.equal(t.diskDb().settings.marker, 'do-tmp', 'db.json agora é a cópia válida'); assert.ok(t.diskDb().activity.some((a) => a.recovery === 'restored'));
  assert.equal(fs.existsSync(t.p('db.json.restore')), false);
});

test('db.json inválido + .tmp inválido + .bak válido: recupera o .bak', async () => {
  const t = await fresh({ 'db.json': '[]', 'db.json.tmp': '{"meio', 'db.json.bak': json(okDb('do-bak')) }); quiet();
  const db = t.store.load();
  assert.equal(db.settings.marker, 'do-bak'); assert.equal(sys(db)[0].source, 'db.json.bak'); assert.equal(sys(db)[0].recovery, 'restored');
  assert.equal(t.read(t.corrupt()[0]), '[]'); assert.equal(t.diskDb().settings.marker, 'do-bak');
  assert.equal(JSON.parse(t.read('db.json.bak')).settings.marker, 'do-bak', 'o .bak segue intacto');
});

test('prioridade: com db.json inválido, .tmp válido vence o .bak válido', async () => {
  const t = await fresh({ 'db.json': 'lixo', 'db.json.tmp': json(okDb('tmp')), 'db.json.bak': json(okDb('bak')) }); quiet();
  assert.equal(t.store.load().settings.marker, 'tmp');
});

test('db.json AUSENTE com .tmp válido (queda entre a troca e o rename): recupera sem inventar arquivo corrompido', async () => {
  const t = await fresh({ 'db.json.tmp': json(okDb('so-tmp')) }); quiet();
  const db = t.store.load();
  assert.equal(db.settings.marker, 'so-tmp'); assert.match(sys(db)[0].message, /db\.json não existia/); assert.equal(t.corrupt().length, 0); assert.equal(t.diskDb().settings.marker, 'so-tmp');
});

test('nenhuma cópia válida (db.json, .tmp e .bak inválidos): degradado, TODOS os originais preservados e nada apagado em silêncio', async () => {
  const orig = { 'db.json': '{"a":', 'db.json.tmp': 'null', 'db.json.bak': json({ ...okDb('x'), missions: 'nao-e-lista' }) };
  const t = await fresh(orig); quiet();
  const db = t.store.load();
  assert.equal(sys(db).length, 1); assert.equal(sys(db)[0].recovery, 'degraded');
  assert.match(sys(db)[0].message, /db\.json:.*db\.json\.tmp:.*db\.json\.bak:/);
  const kept = t.corrupt(); assert.equal(kept.length, 3);
  const bytes = kept.map((f) => t.read(f)).sort();
  assert.deepEqual(bytes, Object.values(orig).sort(), 'os três conteúdos originais estão preservados');
  assert.equal(t.read('db.json.bak'), orig['db.json.bak'], 'o .bak original não foi tocado');
  assert.equal(t.store.validateDb(t.diskDb()), null);
});

test('não sobrescreve nada antes de a alternativa estar confirmada: se a troca falha, o db.json inválido e o .tmp ficam como estavam', async () => {
  const t = await fresh({ 'db.json': '{"meio', 'db.json.tmp': json(okDb('tmp')) }); quiet();
  const real = fs.copyFileSync;
  mock.method(fs, 'copyFileSync', (src, dst, ...r) => { if (String(dst).endsWith('.restore')) throw Object.assign(new Error('EIO: simulado'), { code: 'EIO' }); return real(src, dst, ...r); });
  assert.throws(() => t.store.load(), (e) => e.code === 'EIO');
  mock.restoreAll();
  assert.equal(t.read('db.json'), '{"meio', 'db.json intocado'); assert.equal(JSON.parse(t.read('db.json.tmp')).settings.marker, 'tmp', '.tmp intocado');
  assert.equal(fs.existsSync(t.p('db.json.restore')), false);
});

test('se não é possível preservar o arquivo inválido, o boot falha em vez de perder o original', async () => {
  const t = await fresh({ 'db.json': '{"meio' }); quiet();
  mock.method(fs, 'copyFileSync', () => { throw Object.assign(new Error('EACCES: simulado'), { code: 'EACCES' }); });
  assert.throws(() => t.store.load(), (e) => e.code === 'EACCES');
  mock.restoreAll();
  assert.equal(t.read('db.json'), '{"meio');
});

test('falha de LEITURA do db.json não é "arquivo inválido": tenta de novo se transitória e, se persistir, falha sem trocar por cópia antiga', async () => {
  const t = await fresh({ 'db.json': json(okDb('principal')), 'db.json.bak': json(okDb('antigo')) }); quiet();
  const real = fs.readFileSync; let calls = 0;
  mock.method(fs, 'readFileSync', (f, ...r) => { if (String(f).endsWith('db.json') && ++calls <= 2) throw Object.assign(new Error('EBUSY: simulado'), { code: 'EBUSY' }); return real(f, ...r); });
  assert.equal(t.store.load().settings.marker, 'principal', 'transitória: leu o db.json de verdade'); assert.ok(calls >= 3);
  mock.restoreAll(); quiet();

  const t2 = await fresh({ 'db.json': json(okDb('principal')), 'db.json.bak': json(okDb('antigo')) });
  const real2 = fs.readFileSync;
  mock.method(fs, 'readFileSync', (f, ...r) => { if (String(f).endsWith('db.json')) throw Object.assign(new Error('EIO: simulado'), { code: 'EIO' }); return real2(f, ...r); });
  assert.throws(() => t2.store.load(), /db\.json ilegível \(EIO\).*nada foi alterado/);
  mock.restoreAll();
  assert.equal(JSON.parse(t2.read('db.json')).settings.marker, 'principal'); assert.equal(t2.corrupt().length, 0);
});

test('o banco recuperado funciona com o restante da persistência: save() grava e um novo load() lê o mesmo estado', async () => {
  const t = await fresh({ 'db.json': 'x', 'db.json.bak': json(okDb('bak')) }); quiet();
  const db = t.store.load(); db.settings.novo = 'depois'; t.store.save();
  process.env.ORCH_DATA_DIR = t.dir;                                                    // mesma pasta, instância nova do módulo (simula um novo boot)
  const again = await import(`../store.js?c=${++n}`);
  const db2 = again.load();
  assert.equal(db2.settings.novo, 'depois'); assert.equal(db2.settings.marker, 'bak');
  assert.equal(sys(db2).filter((a) => a.recovery === 'restored').length, 1, 'o segundo boot não repete a recuperação');
});
