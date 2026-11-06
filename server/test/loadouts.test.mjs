// Loadouts (server/loadouts.js): skills padrão por papel entregues como plugin de sessão (--plugin-dir). Banco TEMPORÁRIO, PTY simulado, nenhum Claude real,
// nenhuma escrita no workspace nem em data/ (ORCH_DATA_DIR temporário e porta livre).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-loadouts-')));
const dataDir = path.join(root, 'data');
process.env.ORCH_DATA_DIR = dataDir;
const store = await import('../store.js');
const L = await import('../loadouts.js');
const T = await import('../terminals.js');
const { claudeProvider } = await import('../providers/claude.js');
const { apiGuard } = await import('../origin-guard.js');

let server, base, db;
const outDir = path.join(root, 'plugins');
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(root, { recursive: true, force: true }); });
const call = (url, method = 'GET', body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
const frontmatter = (text) => { const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text); return m && { name: m[1], description: JSON.parse(m[2]) }; };

before(async () => {
  db = store.load();
  const app = express(); app.use('/api', apiGuard); app.use(express.json());
  L.setupLoadouts(app, { loadouts: L.createLoadouts({ db, dir: outDir }) });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

// ---------- catálogo ----------
test('catálogo: os papéis são exatamente os do Cockpit e todo id padrão existe', () => {
  assert.deepEqual([...L.LOADOUT_ROLES].sort(), T.roleIds().sort(), 'um papel novo em ROLES precisa de loadout (e vice-versa)');
  for (const [role, ids] of Object.entries(L.ROLE_DEFAULTS)) {
    assert.ok(ids.length >= 1 && ids.length <= L.MAX_SKILLS_PER_ROLE, role);
    assert.equal(new Set(ids).size, ids.length, `${role}: ids repetidos`);
    for (const id of ids) assert.ok(L.isSkillId(id), `${role}: ${id} não está no catálogo`);
  }
});

test('catálogo: cada skill tem id válido igual ao nome, descrição útil e corpo não vazio, sem caractere de controle', () => {
  for (const [id, s] of Object.entries(L.SKILLS)) {
    assert.match(id, L.SKILL_ID_RE); assert.equal(s.name, id);
    assert.ok(s.description.length >= 40 && s.description.length <= 600, `${id}: descrição com ${s.description.length} caracteres`);
    assert.ok(s.body.length >= 200, `${id}: corpo curto demais`);
    assert.doesNotMatch(`${s.name}${s.description}${s.body}`, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, `${id}: caractere de controle`);
  }
  assert.ok(Object.isFrozen(L.SKILLS) && Object.isFrozen(L.ROLE_DEFAULTS));
});

test('cada papel recebe a skill do seu papel e o protocolo do squad; o maestro delega e o batedor só lê', () => {
  assert.ok(L.ROLE_DEFAULTS.maestro.includes('delegar-com-clareza') && L.ROLE_DEFAULTS.builder.includes('implementar-em-passos-pequenos'));
  assert.ok(L.ROLE_DEFAULTS.reviewer.includes('revisar-alteracoes') && L.ROLE_DEFAULTS.scout.includes('mapear-codigo'));
  for (const ids of Object.values(L.ROLE_DEFAULTS)) assert.ok(ids.includes('protocolo-do-squad'));
  assert.match(L.SKILLS['mapear-codigo'].body, /Somente leitura/);
});

// ---------- seleção ----------
test('skillsFor: padrão sem configuração; a escolha do usuário vale; id inválido, repetido e papel desconhecido são tolerados', () => {
  assert.deepEqual(L.skillsFor('builder', {}), [...L.ROLE_DEFAULTS.builder]);
  assert.deepEqual(L.skillsFor('builder', undefined), [...L.ROLE_DEFAULTS.builder]);
  assert.deepEqual(L.skillsFor('builder', { loadouts: { builder: { skills: ['relato-de-conclusao'] } } }), ['relato-de-conclusao']);
  assert.deepEqual(L.skillsFor('builder', { loadouts: { builder: { skills: [] } } }), [], 'lista vazia escolhida pelo usuário é respeitada');
  assert.deepEqual(L.skillsFor('builder', { loadouts: { builder: { skills: ['x', '__proto__', 7, null, 'relato-de-conclusao', 'relato-de-conclusao', '../x'] } } }), ['relato-de-conclusao']);
  assert.deepEqual(L.skillsFor('builder', { loadouts: { builder: 'lixo' } }), [...L.ROLE_DEFAULTS.builder], 'registro malformado volta ao padrão');
  for (const role of ['nope', '__proto__', 'constructor', '', null, undefined]) assert.deepEqual(L.skillsFor(role, {}), []);
});

// ---------- plugin gerado ----------
test('pluginFiles: plugin.json válido com o nome squad e um SKILL.md por skill, com frontmatter que volta ao original', () => {
  const files = L.pluginFiles('builder', L.ROLE_DEFAULTS.builder);
  const manifest = JSON.parse(files['.claude-plugin/plugin.json']);
  assert.equal(manifest.name, 'squad'); assert.match(manifest.version, /^\d+\.\d+\.\d+$/); assert.match(manifest.description, /builder/);
  assert.deepEqual(Object.keys(files).sort(), ['.claude-plugin/plugin.json', ...L.ROLE_DEFAULTS.builder.map((id) => `skills/${id}/SKILL.md`)].sort());
  for (const id of L.ROLE_DEFAULTS.builder) {
    const fm = frontmatter(files[`skills/${id}/SKILL.md`]);
    assert.ok(fm, id); assert.equal(fm.name, id); assert.equal(fm.description, L.SKILLS[id].description, 'a descrição com aspas e dois-pontos sobrevive ao YAML');
    assert.ok(files[`skills/${id}/SKILL.md`].includes(L.SKILLS[id].body));
  }
});

test('materialize: grava o plugin numa pasta com hash, é idempotente, não deixa temporário e muda de pasta quando a seleção muda', () => {
  const a = L.materialize(outDir, 'builder', L.ROLE_DEFAULTS.builder);
  assert.ok(a.startsWith(outDir) && path.basename(a).startsWith('builder-'));
  assert.ok(fs.existsSync(path.join(a, '.claude-plugin', 'plugin.json')) && fs.existsSync(path.join(a, 'skills', 'relato-de-conclusao', 'SKILL.md')));
  assert.equal(L.materialize(outDir, 'builder', L.ROLE_DEFAULTS.builder), a, 'mesma seleção, mesma pasta');
  const b = L.materialize(outDir, 'builder', ['relato-de-conclusao']);
  assert.notEqual(b, a); assert.ok(fs.existsSync(path.join(a, 'skills', 'implementar-em-passos-pequenos')), 'a pasta antiga (sessões abertas) continua intacta');
  assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.includes('.tmp-')), []);
  assert.equal(L.materialize(outDir, 'builder', []), null, 'sem skills não há pacote');
  assert.equal(L.materialize(outDir, 'nope', ['relato-de-conclusao']), null);
});

test('materialize: gravações simultâneas do mesmo plugin terminam com UMA pasta completa', async () => {
  const dir = path.join(root, 'conc');
  const dirs = await Promise.all(Array.from({ length: 8 }, async () => L.materialize(dir, 'scout', L.ROLE_DEFAULTS.scout)));
  assert.equal(new Set(dirs).size, 1);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(dirs[0])]);
});

test('materialize: nunca escreve fora da pasta de destino (os caminhos vêm só de ids do catálogo)', () => {
  const files = L.pluginFiles('builder', ['protocolo-do-squad']);
  for (const rel of Object.keys(files)) { assert.ok(!path.isAbsolute(rel) && !rel.split('/').includes('..'), rel); }
});

// ---------- API ----------
test('GET /api/loadouts: catálogo e o que cada papel recebe, com o MCP forge', async () => {
  const r = await call('/api/loadouts'); assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j.roles).sort(), [...L.LOADOUT_ROLES].sort());
  assert.deepEqual(j.roles.maestro.skills, [...L.ROLE_DEFAULTS.maestro]); assert.equal(j.roles.maestro.customized, false); assert.deepEqual(j.roles.maestro.mcp, ['forge']);
  assert.deepEqual(j.catalog.skills.map((s) => s.id).sort(), Object.keys(L.SKILLS).sort()); assert.equal(j.catalog.mcp[0].id, 'forge'); assert.equal(j.catalog.mcp[0].builtin, true);
  assert.equal(j.limits.maxSkillsPerRole, L.MAX_SKILLS_PER_ROLE);
});

test('PUT /api/loadouts: grava a escolha do papel, devolve a visão nova, sobrevive ao disco e reset volta ao padrão', async () => {
  const r = await call('/api/loadouts', 'PUT', { role: 'reviewer', skills: ['revisar-alteracoes'] }); assert.equal(r.status, 200);
  const j = await r.json(); assert.deepEqual(j.roles.reviewer.skills, ['revisar-alteracoes']); assert.equal(j.roles.reviewer.customized, true); assert.match(j.appliesTo, /abertos a partir de agora/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')).settings.loadouts, { reviewer: { skills: ['revisar-alteracoes'] } });
  assert.deepEqual(db.settings.loadouts.reviewer.skills, ['revisar-alteracoes']);
  const back = await (await call('/api/loadouts', 'PUT', { role: 'reviewer', reset: true })).json();
  assert.deepEqual(back.roles.reviewer.skills, [...L.ROLE_DEFAULTS.reviewer]); assert.equal(back.roles.reviewer.customized, false);
  assert.equal(Object.hasOwn(db.settings.loadouts, 'reviewer'), false);
});

test('PUT /api/loadouts: corpo inválido é recusado com 400 e nada muda', async () => {
  const before = JSON.stringify(db.settings);
  const bad = [[], {}, { role: 'builder' }, { role: 'nope', skills: [] }, { role: '__proto__', skills: [] }, { role: 'builder', skills: 'a' }, { role: 'builder', skills: ['inexistente'] },
    { role: 'builder', skills: ['relato-de-conclusao', 'relato-de-conclusao'] }, { role: 'builder', skills: ['../../etc/passwd'] }, { role: 'builder', skills: Array(L.MAX_SKILLS_PER_ROLE + 1).fill('relato-de-conclusao') },
    { role: 'builder', skills: [], extra: 1 }, { role: 'builder', reset: false }, { role: 'builder', reset: true, skills: [] }, { role: 'builder', skills: [{ id: 'x' }] }];
  for (const b of bad) { const r = await call('/api/loadouts', 'PUT', b); assert.equal(r.status, 400, JSON.stringify(b)); assert.ok(typeof (await r.json()).error === 'string'); }
  assert.equal(JSON.stringify(db.settings), before);
});

test('PUT /api/loadouts: sem Origin válido a chamada é recusada (mesma proteção do resto da API)', async () => {
  const r = await fetch(`${base}/api/loadouts`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ role: 'builder', reset: true }) });
  assert.equal(r.status, 403);
});

test('PUT /api/loadouts: falha ao gravar o banco desfaz tudo (500, estado em memória como antes)', async () => {
  const before = JSON.stringify(db.settings);
  fs.mkdirSync(path.join(dataDir, 'db.json.tmp')); // EISDIR: erro de gravação real
  try {
    const r = await call('/api/loadouts', 'PUT', { role: 'builder', skills: ['relato-de-conclusao'] }); assert.equal(r.status, 500); assert.match((await r.json()).error, /nada foi alterado/);
    assert.equal(JSON.stringify(db.settings), before);
  } finally { fs.rmSync(path.join(dataDir, 'db.json.tmp'), { recursive: true, force: true }); }
});

// ---------- terminais ----------
function world(loadouts) {
  const spawned = []; let pid = 1_900_000_000, n = 0;
  const lib = { spawn(file, args, opts) { const p = { pid: ++pid, file, args, opts, onData() {}, onExit(cb) { p.exitCb = cb; }, write() {}, resize() {}, exit(code = 0) { p.exitCb({ exitCode: code }); } }; spawned.push(p); return p; } };
  const ws = path.join(root, `ws${Math.random().toString(16).slice(2)}`); fs.mkdirSync(ws, { recursive: true });
  const wdb = { settings: { activeWorkspaceId: 'ws1' }, workspaces: [{ id: 'ws1', name: 'W', path: ws }], worktrees: [], topics: [] };
  const mgr = T.createTerminalManager({ db: wdb, ptyLib: lib, loadouts, resolveCommand: () => ({ file: '/fake/claude', args: [], viaShell: false }), killTree: () => {}, waitFor: () => true,
    newSessionId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, mcp: null, track: () => ({ release() {} }), inspectConfig: async () => [], sweepMs: 0,
    usage: { read: () => null, has: () => true, forget() {} }, persist: () => {} });
  return { spawned, wdb, mgr, ws };
}
const pluginArg = (args) => { const i = args.indexOf('--plugin-dir'); return i < 0 ? null : args[i + 1]; };

test('terminal novo: cada papel abre com --plugin-dir apontando para as skills do próprio papel, fora do workspace', async () => {
  const w = world(L.createLoadouts({ db: { settings: {} }, dir: path.join(root, 'term') }));
  for (const role of L.LOADOUT_ROLES) {
    const r = await w.mgr.create({ role }); assert.equal(r.ok, true, r.error);
    const dir = pluginArg(w.spawned.at(-1).args); assert.ok(dir, role);
    assert.ok(!dir.startsWith(w.ws), 'o plugin fica fora do workspace do usuário');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')).sort(), [...L.ROLE_DEFAULTS[role]].sort(), role);
  }
  assert.deepEqual(fs.readdirSync(w.ws), [], 'nada foi escrito no workspace');
});

test('terminal novo: a escolha do usuário vale e --plugin-dir vem antes dos argumentos de MCP (variádicos)', async () => {
  const sdb = { settings: { loadouts: { builder: { skills: ['relato-de-conclusao'] } } } };
  const w = world(L.createLoadouts({ db: sdb, dir: path.join(root, 'term2') }));
  await w.mgr.create({ role: 'builder' });
  assert.deepEqual(fs.readdirSync(path.join(pluginArg(w.spawned[0].args), 'skills')), ['relato-de-conclusao']);
  const args = claudeProvider.paneArgs({ mode: 'new', prompt: 'P', label: 'L', sessionId: 's', pluginDir: '/p', mcp: { configPath: '/m.json', serverName: 'o' } });
  assert.ok(args.indexOf('--plugin-dir') < args.indexOf('--mcp-config') && args.indexOf('--plugin-dir') < args.indexOf('--allowedTools'));
  assert.deepEqual(args.slice(args.indexOf('--plugin-dir'), args.indexOf('--plugin-dir') + 2), ['--plugin-dir', '/p']);
});

test('retomada e fork: o plugin do papel é passado de novo (ele não faz parte da sessão gravada)', async () => {
  const w = world(L.createLoadouts({ db: { settings: {} }, dir: path.join(root, 'term3') }));
  await w.mgr.create({ role: 'reviewer' }); w.spawned[0].exit(0);
  const rec = w.wdb.terminalSessions[0];
  const again = await w.mgr.resume({ recordId: rec.id }); assert.equal(again.ok, true, again.error);
  assert.deepEqual(w.spawned[1].args.slice(0, 2), ['--resume', rec.claudeSessionId]);
  assert.ok(pluginArg(w.spawned[1].args).includes('reviewer-'));
  w.spawned[1].exit(0);
  const fork = await w.mgr.resume({ recordId: rec.id, fork: true }); assert.equal(fork.ok, true, fork.error);
  assert.ok(w.spawned[2].args.includes('--fork-session') && pluginArg(w.spawned[2].args));
});

test('falha ao montar o plugin NÃO impede o terminal: abre sem --plugin-dir', async () => {
  const boom = { pluginDirFor() { throw new Error('disco cheio'); } };
  const w = world(boom); const r = await w.mgr.create({ role: 'builder' });
  assert.equal(r.ok, true, r.error); assert.equal(pluginArg(w.spawned[0].args), null);
  const none = world({ pluginDirFor: () => null }); await none.mgr.create({ role: 'builder' }); assert.equal(pluginArg(none.spawned[0].args), null);
  const off = world(null); await off.mgr.create({ role: 'builder' }); assert.equal(pluginArg(off.spawned[0].args), null, 'sem loadouts injetados nada muda');
});

test('wrapper .cmd (Windows) com caminho de plugin que quebraria a linha de comando: o plugin é omitido, o terminal abre', async () => {
  const w = world({ pluginDirFor: () => 'C:/a&b/plugins/builder-x' });
  const wm = T.createTerminalManager({ db: w.wdb, ptyLib: { spawn: (f, a, o) => { const p = { pid: 1_900_100_001, file: f, args: a, opts: o, onData() {}, onExit() {}, write() {}, resize() {} }; w.spawned.push(p); return p; } }, loadouts: { pluginDirFor: () => 'C:/a&b/plugins/builder-x' },
    resolveCommand: () => ({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'C:/x/claude.cmd'], viaShell: true }), killTree: () => {}, waitFor: () => true, mcp: null, track: () => ({ release() {} }), inspectConfig: async () => [], sweepMs: 0,
    usage: { read: () => null, has: () => true, forget() {} }, persist: () => {} });
  const r = await wm.create({ role: 'builder' }); assert.equal(r.ok, true, r.error);
  assert.equal(pluginArg(w.spawned.at(-1).args), null);
});
