// Migração dos dados do app desktop (AI Dev Orchestrator -> FORGE): desktop/migrate-userdata.cjs. Só diretórios temporários; nunca toca o %APPDATA% real.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { migrateUserData } = require('../../desktop/migrate-userdata.cjs');

const roots = [];
const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mig-'))); roots.push(d); return d; };
after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const OLD = 'AI Dev Orchestrator', NEW = 'FORGE';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
/** appData com uma instalação antiga completa: banco, backup, subpasta, trava e temporário. */
function legacy({ lock = null, files = { 'db.json': '{"workspaces":[1,2,3]}', 'db.json.bak': '{"workspaces":[1,2]}', 'sub/historico.txt': 'conversa', 'db.json.tmp': 'meio-gravado' } } = {}) {
  const appData = mk(), data = path.join(appData, OLD, 'data');
  for (const [f, t] of Object.entries(files)) put(path.join(data, f), t);
  if (lock !== null) put(path.join(data, 'server.lock'), lock);
  return { appData, data, dest: path.join(appData, NEW, 'data') };
}
const snapshot = (dir) => { const out = {}; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (out[path.relative(dir, p)] = sha(p)); } }; walk(dir); return out; };

test('sem dados antigos: nada acontece e nada é criado', () => {
  const appData = mk();
  assert.deepEqual(migrateUserData({ appData }), { status: 'none' });
  assert.deepEqual(fs.readdirSync(appData), []);
});

test('migra COPIANDO: banco, backup e subpastas chegam idênticos; trava e temporário ficam de fora; o original não muda', () => {
  const { appData, data, dest } = legacy({ lock: '{"pid":999999,"startedAt":"x","token":"t"}' });
  const before = snapshot(data);
  const r = migrateUserData({ appData, isAlive: () => false });
  assert.equal(r.status, 'migrated');
  for (const f of ['db.json', 'db.json.bak', 'sub/historico.txt']) assert.equal(sha(path.join(dest, f)), sha(path.join(data, f)), f);
  assert.ok(!fs.existsSync(path.join(dest, 'server.lock')), 'a trava não é copiada');
  assert.ok(!fs.existsSync(path.join(dest, 'db.json.tmp')), 'temporário de gravação não é copiado');
  assert.deepEqual(snapshot(data), before, 'a pasta original continua exatamente igual (inclusive a trava)');
  assert.ok(!fs.existsSync(`${dest}.migrating`), 'sem pasta de preparo sobrando');
  const marker = JSON.parse(fs.readFileSync(path.join(appData, NEW, 'migrated-from.json'), 'utf8'));
  assert.equal(marker.from, data); assert.equal(marker.db, sha(path.join(dest, 'db.json')));
});

test('tokens de terminais (mcp/) não são duplicados; loadouts e histórico sim', () => {
  const { appData, dest } = legacy({ files: { 'db.json': '{}', 'mcp/term_aaaaaaaa.json': '{"token":"segredo"}', 'loadouts/p/plugin.json': '{}', 'history/ws/r.json': '{}', 'sub/mcp/x.txt': 'nome parecido em subpasta' } });
  assert.equal(migrateUserData({ appData }).status, 'migrated');
  assert.ok(!fs.existsSync(path.join(dest, 'mcp')), 'mcp/ de topo fica de fora');
  assert.ok(fs.existsSync(path.join(dest, 'loadouts', 'p', 'plugin.json')) && fs.existsSync(path.join(dest, 'history', 'ws', 'r.json')));
  assert.ok(fs.existsSync(path.join(dest, 'sub', 'mcp', 'x.txt')), 'só a pasta mcp de TOPO é excluída');
});

test('é idempotente e nunca sobrescreve: depois de migrado, uma segunda chamada é "present" mesmo que o original mude', () => {
  const { appData, data, dest } = legacy();
  assert.equal(migrateUserData({ appData }).status, 'migrated');
  put(path.join(dest, 'db.json'), '{"novo":"banco do FORGE"}'); // o usuário já usou o app novo
  put(path.join(data, 'db.json'), '{"antigo":"alterado depois"}');
  assert.equal(migrateUserData({ appData }).status, 'present');
  assert.equal(fs.readFileSync(path.join(dest, 'db.json'), 'utf8'), '{"novo":"banco do FORGE"}');
});

test('destino que já tem banco nunca é tocado, mesmo na primeira chamada', () => {
  const { appData, data, dest } = legacy();
  put(path.join(dest, 'db.json'), '{"ja":"existe"}');
  const before = snapshot(dest), orig = snapshot(data);
  assert.equal(migrateUserData({ appData }).status, 'present');
  assert.deepEqual(snapshot(dest), before); assert.deepEqual(snapshot(data), orig);
});

test('versão anterior aberta (trava com PID vivo): bloqueia e não copia nada', () => {
  const { appData, dest } = legacy({ lock: JSON.stringify({ pid: 4242, startedAt: 'x', token: 't' }) });
  const r = migrateUserData({ appData, isAlive: (pid) => pid === 4242 });
  assert.equal(r.status, 'blocked'); assert.equal(r.pid, 4242);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.migrating`), 'nada criado');
});

test('trava velha (PID morto) ou ilegível não bloqueia', () => {
  for (const lock of [JSON.stringify({ pid: 4242, startedAt: 'x', token: 't' }), 'isto não é json', JSON.stringify({ pid: 'abc' }), '']) {
    const { appData } = legacy({ lock });
    assert.equal(migrateUserData({ appData, isAlive: () => false }).status, 'migrated', JSON.stringify(lock));
  }
});

test('só o backup (db.json.bak) já conta como dado a migrar', () => {
  const { appData, dest } = legacy({ files: { 'db.json.bak': '{"so":"backup"}' } });
  assert.equal(migrateUserData({ appData }).status, 'migrated');
  assert.equal(fs.readFileSync(path.join(dest, 'db.json.bak'), 'utf8'), '{"so":"backup"}');
});

test('pasta de dados do destino sem banco (ex.: só logs) é GUARDADA com outro nome, nunca apagada', () => {
  const { appData, dest } = legacy();
  put(path.join(dest, 'resto.txt'), 'algo');
  const r = migrateUserData({ appData, now: () => new Date('2026-11-06T12:00:00Z') });
  assert.equal(r.status, 'migrated');
  assert.ok(fs.existsSync(path.join(dest, 'db.json')));
  const kept = fs.readdirSync(path.join(appData, NEW)).filter((n) => n.startsWith('data.antes-da-migracao-'));
  assert.equal(kept.length, 1); assert.equal(fs.readFileSync(path.join(appData, NEW, kept[0], 'resto.txt'), 'utf8'), 'algo');
});

test('resto de uma tentativa interrompida (pasta de preparo) é guardado, e a migração segue', () => {
  const { appData, dest } = legacy();
  put(path.join(`${dest}.migrating`, 'meio.txt'), 'incompleto');
  assert.equal(migrateUserData({ appData, now: () => new Date('2026-11-06T12:00:00Z') }).status, 'migrated');
  const sobra = fs.readdirSync(path.join(appData, NEW)).filter((n) => n.includes('.migrating-sobra-'));
  assert.equal(sobra.length, 1); assert.ok(fs.existsSync(path.join(appData, NEW, sobra[0], 'meio.txt')));
  assert.ok(!fs.existsSync(path.join(dest, 'meio.txt')), 'o resto não vaza para o destino');
});

test('"present" vale mesmo com a versão anterior aberta (a ordem das checagens não bloqueia quem já migrou)', () => {
  const { appData, dest } = legacy({ lock: JSON.stringify({ pid: 4242, startedAt: new Date().toISOString(), token: 't' }) });
  put(path.join(dest, 'db.json'), '{"ja":"migrado"}');
  assert.equal(migrateUserData({ appData, isAlive: () => true }).status, 'present');
});

test('trava ANTERIOR ao boot do sistema (PID possivelmente reaproveitado) não bloqueia; trava recente com PID vivo bloqueia e cita o arquivo', () => {
  const boot = Date.parse('2026-11-06T08:00:00Z');
  const velha = legacy({ lock: JSON.stringify({ pid: 4242, startedAt: '2026-11-05T20:00:00Z', token: 't' }) });
  assert.equal(migrateUserData({ appData: velha.appData, isAlive: () => true, bootTime: boot }).status, 'migrated');
  const recente = legacy({ lock: JSON.stringify({ pid: 4242, startedAt: '2026-11-06T09:00:00Z', token: 't' }) });
  const r = migrateUserData({ appData: recente.appData, isAlive: () => true, bootTime: boot });
  assert.equal(r.status, 'blocked'); assert.equal(r.lock, path.join(recente.data, 'server.lock'));
});

test('links: a pasta de dados antiga que é um link é copiada pelo conteúdo real; links aninhados não são copiados nem seguidos', (t) => {
  const appData = mk(), real = path.join(appData, 'disco2', 'data'), fora = path.join(appData, 'fora');
  put(path.join(real, 'db.json'), '{"real":true}'); put(path.join(real, 'sub', 'x.txt'), 'x'); put(path.join(fora, 'segredo.txt'), 's');
  fs.mkdirSync(path.join(appData, OLD), { recursive: true });
  try { fs.symlinkSync(real, path.join(appData, OLD, 'data'), 'junction'); fs.symlinkSync(fora, path.join(real, 'atalho'), 'junction'); } catch { t.skip('sem permissão para criar links'); return; }
  const r = migrateUserData({ appData });
  assert.equal(r.status, 'migrated'); assert.deepEqual(r.skippedLinks, ['atalho']);
  const dest = path.join(appData, NEW, 'data');
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), false, 'FORGE\\data é uma cópia real, não um atalho para a original');
  assert.equal(fs.readFileSync(path.join(dest, 'db.json'), 'utf8'), '{"real":true}');
  assert.ok(!fs.existsSync(path.join(dest, 'atalho')) && fs.existsSync(path.join(fora, 'segredo.txt')));
  fs.writeFileSync(path.join(dest, 'db.json'), '{"alterado":true}'); // gravar no FORGE não pode mexer na original
  assert.equal(fs.readFileSync(path.join(real, 'db.json'), 'utf8'), '{"real":true}');
});

test('falha de cópia no meio: "error", sem destino parcial, origem intacta; o resto é guardado e a próxima tentativa migra', () => {
  const { appData, data, dest } = legacy();
  const orig = snapshot(data);
  const meio = (src, staging) => { put(path.join(staging, 'db.json'), 'pela-metade'); throw new Error('EBUSY: antivírus'); };
  const r = migrateUserData({ appData, copy: meio });
  assert.equal(r.status, 'error'); assert.match(r.error, /EBUSY/);
  assert.ok(!fs.existsSync(dest), 'o destino só aparece depois da conferência'); assert.deepEqual(snapshot(data), orig);
  assert.ok(fs.existsSync(`${dest}.migrating`), 'o resto fica na pasta de preparo');
  assert.equal(migrateUserData({ appData, now: () => new Date('2026-11-06T12:00:00Z') }).status, 'migrated');
  assert.equal(sha(path.join(dest, 'db.json')), sha(path.join(data, 'db.json')), 'o banco do destino é o original, não a cópia pela metade');
  assert.equal(fs.readdirSync(path.join(appData, NEW)).filter((n) => n.includes('.migrating-sobra-')).length, 1);
});

test('divergência de SHA na conferência (cópia corrompida) vira "error" e nada é publicado', () => {
  const { appData, dest } = legacy();
  const corrompe = (src, staging, opts) => { fs.cpSync(src, staging, opts); fs.writeFileSync(path.join(staging, 'db.json'), 'corrompido'); };
  const r = migrateUserData({ appData, copy: corrompe });
  assert.equal(r.status, 'error'); assert.match(r.error, /não confere/);
  assert.ok(!fs.existsSync(dest));
});

test('falha no meio devolve "error" e não deixa destino parcial nem altera a origem', () => {
  const { appData, data, dest } = legacy();
  const orig = snapshot(data);
  const r = migrateUserData({ appData, now: () => { throw new Error('relógio quebrou'); } });
  assert.equal(r.status, 'error'); assert.match(r.error, /relógio quebrou/);
  assert.ok(!fs.existsSync(dest), 'sem pasta de dados parcial');
  assert.deepEqual(snapshot(data), orig);
});
