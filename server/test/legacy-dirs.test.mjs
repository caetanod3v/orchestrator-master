// Pastas de estado do modo dev (ai-dev-orchestrator -> forge): server/legacy-dirs.js. Só diretórios temporários.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const { migrateLegacyDir } = await import('../legacy-dirs.js');

const roots = [];
const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-legacy-'))); roots.push(d); return d; };
after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('origem ausente: "none", nada é criado', () => {
  const home = mk();
  assert.deepEqual(migrateLegacyDir(path.join(home, 'ai-dev-orchestrator', 'history'), path.join(home, 'forge', 'history')), { status: 'none' });
  assert.deepEqual(fs.readdirSync(home), []);
});

test('copia a árvore inteira (inclusive subpastas), cria a pasta pai e mantém a original', () => {
  const home = mk(), oldDir = path.join(home, 'ai-dev-orchestrator', 'history'), newDir = path.join(home, 'forge', 'history');
  put(path.join(oldDir, 'ws_1', 'rec_1.json'), '{"a":1}'); put(path.join(oldDir, 'ws_1', 'rec_1.log'), 'linha'); put(path.join(oldDir, 'topo.txt'), 'x');
  assert.deepEqual(migrateLegacyDir(oldDir, newDir), { status: 'migrated', skippedLinks: [] });
  for (const f of ['ws_1/rec_1.json', 'ws_1/rec_1.log', 'topo.txt']) assert.equal(sha(path.join(newDir, f)), sha(path.join(oldDir, f)), f);
  assert.ok(fs.existsSync(path.join(oldDir, 'ws_1', 'rec_1.json')), 'a original continua');
  assert.ok(!fs.existsSync(`${newDir}.migrating`));
});

test('depois de migrado (marcador gravado) é "present" e nada mais é copiado, mesmo que a original mude', () => {
  const home = mk(), oldDir = path.join(home, 'a', 'history'), newDir = path.join(home, 'forge', 'history');
  put(path.join(oldDir, 'velho.txt'), 'v');
  assert.equal(migrateLegacyDir(oldDir, newDir).status, 'migrated');
  put(path.join(oldDir, 'depois.txt'), 'd'); put(path.join(newDir, 'novo.txt'), 'n');
  assert.deepEqual(migrateLegacyDir(oldDir, newDir), { status: 'present' });
  assert.deepEqual(fs.readdirSync(newDir).sort(), ['novo.txt', 'velho.txt']);
});

test('destino criado ANTES de a cópia terminar (ex.: cópia que falhou e o servidor criou a pasta): completa o que falta SEM sobrescrever', () => {
  const home = mk(), oldDir = path.join(home, 'a', 'history'), newDir = path.join(home, 'forge', 'history');
  put(path.join(oldDir, 'ws', 'velha.json'), 'antiga'); put(path.join(oldDir, 'ws', 'igual.json'), 'DA-ANTIGA');
  put(path.join(newDir, 'ws', 'igual.json'), 'DA-NOVA'); put(path.join(newDir, 'ws', 'recente.json'), 'nova');
  const falha = migrateLegacyDir(oldDir, newDir, { copy: () => { throw new Error('EBUSY: antivírus'); } });
  assert.equal(falha.status, 'error');
  assert.ok(!fs.existsSync(`${newDir}.migrado`), 'sem marcador após falha: o próximo boot tenta de novo');
  assert.equal(migrateLegacyDir(oldDir, newDir).status, 'migrated');
  assert.equal(fs.readFileSync(path.join(newDir, 'ws', 'igual.json'), 'utf8'), 'DA-NOVA', 'nada existente é sobrescrito');
  assert.equal(fs.readFileSync(path.join(newDir, 'ws', 'velha.json'), 'utf8'), 'antiga', 'o que faltava foi completado');
  assert.equal(fs.readFileSync(path.join(newDir, 'ws', 'recente.json'), 'utf8'), 'nova');
  assert.equal(migrateLegacyDir(oldDir, newDir).status, 'present');
});

test('links: a pasta antiga que é um link é copiada pelo conteúdo real; links aninhados não são copiados (nem seguidos)', (t) => {
  const home = mk(), real = path.join(home, 'disco2', 'history'), linkDir = path.join(home, 'ai-dev-orchestrator', 'history'), newDir = path.join(home, 'forge', 'history'), fora = path.join(home, 'fora');
  put(path.join(real, 'a.txt'), 'a'); put(path.join(fora, 'segredo.txt'), 's');
  fs.mkdirSync(path.dirname(linkDir), { recursive: true });
  try { fs.symlinkSync(real, linkDir, 'junction'); fs.symlinkSync(fora, path.join(real, 'atalho'), 'junction'); } catch { t.skip('sem permissão para criar links'); return; }
  const r = migrateLegacyDir(linkDir, newDir);
  assert.equal(r.status, 'migrated'); assert.deepEqual(r.skippedLinks, ['atalho']);
  assert.equal(fs.lstatSync(newDir).isSymbolicLink(), false, 'o destino é uma pasta real, não um atalho para a original');
  assert.equal(fs.readFileSync(path.join(newDir, 'a.txt'), 'utf8'), 'a');
  assert.ok(!fs.existsSync(path.join(newDir, 'atalho')), 'link aninhado não vai para o destino');
  assert.ok(fs.existsSync(path.join(fora, 'segredo.txt')), 'o alvo do link não foi tocado');
});

test('resto de tentativa interrompida é guardado com outro nome e a cópia segue', () => {
  const home = mk(), oldDir = path.join(home, 'a', 'loadouts'), newDir = path.join(home, 'forge', 'loadouts');
  put(path.join(oldDir, 'p.json'), '{}'); put(path.join(`${newDir}.migrating`, 'meio.txt'), 'incompleto');
  assert.equal(migrateLegacyDir(oldDir, newDir, { now: () => new Date('2026-11-06T12:00:00Z') }).status, 'migrated');
  assert.ok(fs.existsSync(path.join(newDir, 'p.json')) && !fs.existsSync(path.join(newDir, 'meio.txt')));
  assert.equal(fs.readdirSync(path.join(home, 'forge')).filter((n) => n.includes('.migrating-sobra-')).length, 1);
});

test('erro inesperado vira {status:"error"} (nunca lança) e a origem não muda', () => {
  const home = mk(), oldDir = path.join(home, 'a', 'history'), newDir = path.join(home, 'forge', 'history');
  put(path.join(oldDir, 'x.txt'), 'x'); put(`${newDir}.migrating`, 'arquivo no lugar da pasta de preparo');
  const r = migrateLegacyDir(oldDir, newDir, { now: () => { throw new Error('boom'); } });
  assert.equal(r.status, 'error'); assert.match(r.error, /boom/);
  assert.equal(fs.readFileSync(path.join(oldDir, 'x.txt'), 'utf8'), 'x'); assert.ok(!fs.existsSync(newDir));
});
