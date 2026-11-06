// Abas de workspaces abertos + tópicos por workspace. Parte 1: rotas montadas num Express próprio (db injetado, banco TEMPORÁRIO, porta aleatória, com o apiGuard real);
// parte 2: o servidor REAL (server/index.js) como processo filho com ORCH_DATA_DIR temporário e porta livre (activate, cadastro e /api/state). A 4317 e data/ nunca são tocadas.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wstopics-'));
const dataDir = path.join(root, 'data');
process.env.ORCH_DATA_DIR = dataDir;
assert.ok(dataDir.startsWith(os.tmpdir()));
const DB_FILE = path.join(dataDir, 'db.json');
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

const { default: express } = await import('express');
const store = await import('../store.js');
const { setupWorkspaceRemoval } = await import('../workspaces.js');
const T = await import('../topics.js');
const { apiGuard } = await import('../origin-guard.js');

let db, server, base;
const disk = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const call = (url, method = 'POST', body, headers = {}) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', origin: base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (url, body) => call(url, 'POST', body);
const state = () => T.topicsState(db);

before(async () => {
  db = store.load();
  for (const id of ['w1', 'w2', 'w3']) db.workspaces.push({ id, name: id, path: path.join(root, id) });
  db.settings.activeWorkspaceId = 'w1';
  const app = express();
  app.use('/api', apiGuard);
  app.use(express.json());
  app.get('/api/state', (req, res) => res.json(T.topicsState(db)));
  setupWorkspaceRemoval(app, { db });
  T.setupWorkspaceTabs(app, { db });
  T.setupTopics(app, { db });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); server.closeAllConnections?.(); await new Promise((r) => setTimeout(r, 600)); fs.rmSync(root, { recursive: true, force: true }); });

test('banco antigo (sem os campos) carrega: o ativo entra nas abas e as listas nascem vazias', () => {
  const legacy = { settings: { activeWorkspaceId: 'w2', requireApproval: true }, workspaces: [{ id: 'w1', path: '/a' }, { id: 'w2', path: '/b' }], missions: [], activity: [] };
  assert.equal(store.validateDb(legacy), null, 'o validateDb continua aceitando o formato antigo');
  assert.deepEqual(T.topicsState(legacy), { openWorkspaceIds: ['w2'], topics: [], activeTopicIds: {} });
  const orphan = { settings: { activeWorkspaceId: 'x', openWorkspaceIds: ['w1', 'zzz', 'w1'], activeTopicIds: { w1: 'top_deadbeef' } }, workspaces: [{ id: 'w1' }], topics: [], missions: [], activity: [] };
  assert.deepEqual(T.topicsState(orphan), { openWorkspaceIds: ['w1'], topics: [], activeTopicIds: {} });
  assert.equal(orphan.settings.activeWorkspaceId, 'w1', 'ativo inexistente cai para uma aba aberta');
});

test('validTerminalSession aceita topicId opcional (top_ + 8 hex) ou null e rejeita o resto', () => {
  const ok = { id: 'ses_0123abcd', claudeSessionId: 'c', terminalId: 't', workspaceId: 'w', cwd: '/x', role: 'builder', title: 't', state: 'exited' };
  assert.equal(store.validTerminalSession(ok), true);
  assert.equal(store.validTerminalSession({ ...ok, topicId: null }), true);
  assert.equal(store.validTerminalSession({ ...ok, topicId: 'top_0123abcd' }), true);
  for (const bad of ['top_xyz', 'top_0123ABCD', 'ses_0123abcd', 7, '']) assert.equal(store.validTerminalSession({ ...ok, topicId: bad }), false, String(bad));
});

test('open/close: abas, ativo sempre na lista, vizinho assume ao fechar o ativo, idempotência e 404', async () => {
  assert.deepEqual(state().openWorkspaceIds, ['w1'] );
  let r = await post('/api/workspaces/w2/open');
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.deepEqual(j.openWorkspaceIds, ['w1', 'w2']); assert.equal(j.activeWorkspaceId, 'w1', 'abrir não troca o ativo quando já existe um');
  assert.equal((await post('/api/workspaces/w2/open')).status, 200);
  assert.deepEqual(state().openWorkspaceIds, ['w1', 'w2'], 'abrir de novo não duplica');
  await post('/api/workspaces/w3/open');
  db.settings.activeWorkspaceId = 'w2';
  j = await (await post('/api/workspaces/w2/close')).json();
  assert.deepEqual(j.openWorkspaceIds, ['w1', 'w3']); assert.equal(j.activeWorkspaceId, 'w3', 'o vizinho da aba fechada vira o ativo');
  assert.equal((await post('/api/workspaces/w2/close')).status, 200, 'fechar o já fechado é idempotente');
  await post('/api/workspaces/w3/close'); j = await (await post('/api/workspaces/w1/close')).json();
  assert.deepEqual(j.openWorkspaceIds, []); assert.equal(j.activeWorkspaceId, null, 'sem abas, o ativo é null');
  await new Promise((r2) => setTimeout(r2, 100));
  assert.deepEqual(disk().settings.openWorkspaceIds, []); assert.equal(disk().settings.activeWorkspaceId, null);
  r = await post('/api/workspaces/nao-existe/open'); assert.equal(r.status, 404); assert.match((await r.json()).error, /não encontrado/i);
  assert.equal((await post('/api/workspaces/nao-existe/close')).status, 404);
  // sem ativo, abrir faz o recém-aberto assumir
  j = await (await post('/api/workspaces/w1/open')).json(); assert.equal(j.activeWorkspaceId, 'w1');
});

test('tópicos: criar, validar título, renomear, ativar, arquivar e limite de 50 por workspace', async () => {
  let r = await post('/api/topics', { workspaceId: 'w1', title: '  Meu   tópico\u0007 ' });
  assert.equal(r.status, 201);
  const t = await r.json();
  assert.match(t.id, /^top_[0-9a-f]{8}$/); assert.equal(t.workspaceId, 'w1'); assert.equal(t.title, 'Meu tópico'); assert.ok(t.createdAt); assert.equal(t.archivedAt, undefined);
  for (const body of [{ workspaceId: 'w1' }, { workspaceId: 'w1', title: '   ' }, { workspaceId: 'w1', title: 7 }, { workspaceId: 'w1', title: 'x'.repeat(81) }]) {
    r = await post('/api/topics', body); assert.equal(r.status, 400, JSON.stringify(body)); assert.ok((await r.json()).error);
  }
  assert.equal((await post('/api/topics', { workspaceId: 'x', title: 'a' })).status, 404);
  assert.equal((await post('/api/topics', { workspaceId: 'w1', title: 'x'.repeat(80) })).status, 201, '80 caracteres é permitido');

  r = await post(`/api/topics/${t.id}/rename`, { title: ' Novo nome ' });
  assert.equal(r.status, 200); assert.equal((await r.json()).title, 'Novo nome');
  assert.equal((await post(`/api/topics/${t.id}/rename`, { title: '' })).status, 400);
  assert.equal((await post('/api/topics/top_00000000/rename', { title: 'a' })).status, 404);

  r = await post(`/api/topics/${t.id}/activate`);
  assert.equal(r.status, 200); assert.deepEqual((await r.json()).activeTopicIds, { w1: t.id });
  assert.deepEqual(state().activeTopicIds, { w1: t.id });
  assert.equal((await post('/api/topics/top_00000000/activate')).status, 404);

  r = await post(`/api/topics/${t.id}/archive`);
  assert.equal(r.status, 200); assert.ok((await r.json()).archivedAt);
  assert.deepEqual(state().activeTopicIds, {}, 'arquivar o ativo limpa o ativo do workspace');
  assert.ok(!state().topics.some((x) => x.id === t.id), 'arquivado some do /api/state');
  assert.equal((await post(`/api/topics/${t.id}/archive`)).status, 200, 'arquivar de novo é idempotente');
  assert.equal((await post(`/api/topics/${t.id}/activate`)).status, 409);
  assert.equal((await post(`/api/topics/${t.id}/rename`, { title: 'a' })).status, 409);
  assert.ok(db.topics.some((x) => x.id === t.id && x.archivedAt), 'o registro arquivado continua no banco');

  const have = db.topics.filter((x) => x.workspaceId === 'w2' && !x.archivedAt).length; assert.equal(have, 0);
  for (let i = 0; i < 50; i++) assert.equal((await post('/api/topics', { workspaceId: 'w2', title: `t${i}` })).status, 201);
  r = await post('/api/topics', { workspaceId: 'w2', title: 'a mais' }); assert.equal(r.status, 409); assert.match((await r.json()).error, /50/);
  assert.equal((await post('/api/topics', { workspaceId: 'w1', title: 'outro workspace tem cota própria' })).status, 201);
  const one = state().topics.find((x) => x.workspaceId === 'w2');
  await post(`/api/topics/${one.id}/archive`);
  assert.equal((await post('/api/topics', { workspaceId: 'w2', title: 'cabe de novo' })).status, 201, 'arquivar libera vaga');
  await new Promise((r2) => setTimeout(r2, 100));
  assert.ok(disk().topics.length >= 52);
});

test('Geral: ativa tópico, depois Geral; /api/state sem activeTopicIds[ws]; idempotente; 404; origem', async () => {
  const t = await (await post('/api/topics', { workspaceId: 'w1', title: 'para o Geral' })).json();
  await post(`/api/topics/${t.id}/activate`);
  assert.equal(state().activeTopicIds.w1, t.id);
  let r = await post('/api/workspaces/w1/topic/general');
  assert.equal(r.status, 200); assert.equal((await r.json()).activeTopicIds.w1, undefined);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).activeTopicIds.w1, undefined);
  assert.ok(db.topics.some((x) => x.id === t.id && !x.archivedAt), 'o tópico segue existindo');
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(disk().settings.activeTopicIds.w1, undefined, 'persistido');
  assert.equal((await post('/api/workspaces/w1/topic/general')).status, 200, 'idempotente');
  r = await post('/api/workspaces/nao-existe/topic/general'); assert.equal(r.status, 404); assert.match((await r.json()).error, /não encontrado/i);
  assert.equal((await fetch(`${base}/api/workspaces/w1/topic/general`, { method: 'POST' })).status, 403, 'sem Origin');
  // falha de gravação desfaz
  await post(`/api/topics/${t.id}/activate`);
  fs.mkdirSync(path.join(dataDir, 'db.json.tmp'));
  try {
    r = await post('/api/workspaces/w1/topic/general');
    assert.equal(r.status, 500); assert.match((await r.json()).error, /nada foi alterado/);
    assert.equal(db.settings.activeTopicIds.w1, t.id, 'o tópico ativo foi restaurado');
  } finally { fs.rmSync(path.join(dataDir, 'db.json.tmp'), { recursive: true, force: true }); }
});

test('teto de 200 registros por workspace: criar descarta os arquivados mais antigos; só vivos mantém o 409', async () => {
  db.workspaces.push({ id: 'w9', name: 'w9', path: path.join(root, 'w9') });
  const hex = (n) => `top_${n.toString(16).padStart(8, '0')}`;
  const mk = (n, extra) => ({ id: hex(n), workspaceId: 'w9', title: `t${n}`, createdAt: 'x', ...extra });
  db.topics = db.topics.filter((t) => t.workspaceId !== 'w9');
  for (let i = 1; i <= 150; i++) db.topics.push(mk(i, { archivedAt: `2026-01-01T00:00:${String(200 - i).padStart(3, '0')}Z` })); // i maior = arquivado mais antigo
  for (let i = 1000; i < 1050; i++) db.topics.push(mk(i));
  assert.equal(db.topics.filter((t) => t.workspaceId === 'w9').length, 200);
  let r = await post('/api/topics', { workspaceId: 'w9', title: 'cabe' });
  assert.equal(r.status, 409, 'com 50 vivos o limite de vivos vale primeiro');
  await post(`/api/topics/${hex(1000)}/archive`); // 49 vivos, 151 arquivados (total 200)
  r = await post('/api/topics', { workspaceId: 'w9', title: 'novo' });
  assert.equal(r.status, 201);
  const mine = db.topics.filter((t) => t.workspaceId === 'w9');
  assert.equal(mine.length, 200, 'total continua em 200');
  assert.ok(!mine.some((t) => t.id === hex(150)), 'o arquivado mais antigo saiu');
  assert.ok(mine.some((t) => t.id === hex(149)) && mine.some((t) => t.id === hex(1000)), 'os demais ficaram');
  assert.equal(mine.filter((t) => !t.archivedAt).length, 50);
});

test('ensureTabs descarta tópico com id malformado; commitOrRollback propaga erro que não é de gravação (sem a mensagem enganosa) e desfaz', () => {
  const d = { settings: { activeWorkspaceId: 'a' }, workspaces: [{ id: 'a' }], topics: [{ id: 'top_0123abcd', workspaceId: 'a', title: 'ok' }, { id: 'top_xyz', workspaceId: 'a', title: 'ruim' }, { id: 'top_0123ABCD', workspaceId: 'a', title: 'maiúsculo' }, { id: 'x', workspaceId: 'a', title: 'x' }] };
  assert.deepEqual(T.topicsState(d).topics.map((t) => t.id), ['top_0123abcd']);
  const res = { status() { throw new Error('não deveria responder 500 de gravação'); } };
  assert.throws(() => T.commitOrRollback(d, res, () => { d.settings.activeTopicIds.a = 'top_0123abcd'; throw new TypeError('bug'); }, 'msg'), TypeError);
  assert.deepEqual(d.settings.activeTopicIds, {}, 'rollback também no erro interno');
});

test('a checagem de origem das rotas novas é a mesma das atuais: POST sem Origin ou com Origin externo dá 403', async () => {
  for (const url of ['/api/workspaces/w1/open', '/api/workspaces/w1/close', '/api/topics', '/api/topics/top_00000000/archive']) {
    let r = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 403, `${url} sem Origin`);
    r = await call(url, 'POST', {}, { origin: 'http://evil.example' }); assert.equal(r.status, 403, `${url} Origin externo`);
  }
});

test('remover workspace tira da aba, arquiva os tópicos e esquece o tópico ativo; ativa outro quando era o ativo', async () => {
  db.settings.openWorkspaceIds = ['w1', 'w3']; db.settings.activeWorkspaceId = 'w3'; db.settings.activeTopicIds = {};
  const t = await (await post('/api/topics', { workspaceId: 'w3', title: 'do w3' })).json();
  await post(`/api/topics/${t.id}/activate`);
  const r = await call('/api/workspaces/w3', 'DELETE');
  assert.equal(r.status, 204);
  const s = state();
  assert.deepEqual(s.openWorkspaceIds, ['w1']); assert.equal(db.settings.activeWorkspaceId, 'w1');
  assert.deepEqual(s.activeTopicIds, {});
  assert.ok(!s.topics.some((x) => x.workspaceId === 'w3'));
  assert.ok(db.topics.find((x) => x.id === t.id).archivedAt, 'tópico arquivado, não apagado');
  await new Promise((r2) => setTimeout(r2, 100));
  assert.ok(!disk().settings.openWorkspaceIds.includes('w3'));
});

test('falha de gravação desfaz tudo (open/close, criar/renomear/arquivar/ativar tópico, remover workspace) e responde 500 em pt-BR', async () => {
  db.settings.openWorkspaceIds = ['w1']; db.settings.activeWorkspaceId = 'w1'; db.settings.activeTopicIds = {};
  const t = await (await post('/api/topics', { workspaceId: 'w1', title: 'estável' })).json();
  await post(`/api/topics/${t.id}/activate`);
  const before = JSON.stringify({ s: db.settings, t: db.topics, w: db.workspaces });
  fs.mkdirSync(path.join(dataDir, 'db.json.tmp')); // EISDIR: erro real, não transitório
  try {
    const attempts = [['/api/workspaces/w2/open'], ['/api/workspaces/w1/close'], ['/api/topics', { workspaceId: 'w1', title: 'novo' }], [`/api/topics/${t.id}/rename`, { title: 'outro' }], [`/api/topics/${t.id}/archive`], ['/api/topics/' + t.id + '/activate']];
    for (const [url, body] of attempts) {
      const r = await post(url, body);
      assert.equal(r.status, 500, url); assert.match((await r.json()).error, /nada foi alterado/);
      assert.equal(JSON.stringify({ s: db.settings, t: db.topics, w: db.workspaces }), before, `${url} deixou estado parcial`);
    }
    assert.equal((await call('/api/workspaces/w2', 'DELETE')).status, 500);
    assert.equal(JSON.stringify({ s: db.settings, t: db.topics, w: db.workspaces }), before, 'remoção deixou estado parcial');
  } finally { fs.rmSync(path.join(dataDir, 'db.json.tmp'), { recursive: true, force: true }); }
});

// ---------- servidor real (processo filho) ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
test('servidor real: /api/state expõe abas/tópicos/ativos; cadastrar e ativar abrem a aba; banco antigo carrega', async () => {
  const dir = path.join(root, 'boot-data'); fs.mkdirSync(dir);
  const wsDir = path.join(root, 'proj'); fs.mkdirSync(wsDir);
  const wsDir2 = path.join(root, 'proj2'); fs.mkdirSync(wsDir2);
  // banco "antigo": sem openWorkspaceIds/activeTopicIds/topics
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 1, settings: { activeWorkspaceId: 'ws_legacy01', requireApproval: true, showDemoData: false }, workspaces: [{ id: 'ws_legacy01', name: 'legado', path: wsDir, createdAt: new Date().toISOString() }], missions: [], activity: [] }));
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir };
  const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (let i = 0; i < 100 && !/FORGE API em/.test(out); i++) await Promise.race([new Promise((r) => setTimeout(r, 100)), exited]);
    assert.match(out, /FORGE API em/, out);
    const api = (u, m = 'GET', b) => fetch(`${origin}${u}`, { method: m, headers: { 'content-type': 'application/json', origin }, body: b === undefined ? undefined : JSON.stringify(b) });
    let s = await (await api('/api/state')).json();
    assert.deepEqual([s.openWorkspaceIds, s.topics, s.activeTopicIds], [['ws_legacy01'], [], {}]);
    const w2 = await (await api('/api/workspaces', 'POST', { path: wsDir2 })).json();
    s = await (await api('/api/state')).json();
    assert.deepEqual(s.openWorkspaceIds, ['ws_legacy01'], 'cadastrar com um ativo existente não abre aba'); assert.equal(s.settings.activeWorkspaceId, 'ws_legacy01', 'o ativo anterior é mantido');
    await api(`/api/workspaces/${w2.id}/activate`, 'POST');
    s = await (await api('/api/state')).json();
    assert.deepEqual(s.openWorkspaceIds, ['ws_legacy01', w2.id], 'activate abre a aba implicitamente'); assert.equal(s.activeWorkspace.id, w2.id);
    const top = await (await api('/api/topics', 'POST', { workspaceId: w2.id, title: 'Tópico real' })).json();
    await api(`/api/topics/${top.id}/activate`, 'POST');
    s = await (await api('/api/state')).json();
    assert.deepEqual(s.topics.map((x) => x.id), [top.id]); assert.deepEqual(s.activeTopicIds, { [w2.id]: top.id });
    assert.equal((await fetch(`${origin}/api/topics`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403, 'sem Origin');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).topics.length, 1, 'persistido em disco');
  } finally { child.kill(); await exited; await new Promise((r) => setTimeout(r, 300)); }
});
