// Preferências da interface em db.settings.ui (server/ui-settings.js) e o sincronizador do cliente (client/src/ui-state.js).
// Parte 1: rotas num Express próprio (banco TEMPORÁRIO). Parte 2: servidor REAL como processo filho, reiniciado (ORCH_DATA_DIR temporário, porta livre; a 4317 e data/ nunca são tocadas).
// Parte 3: o sincronizador do cliente com servidor, armazenamento e preferências simulados (sem navegador).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ui-'));
const dataDir = path.join(root, 'data');
process.env.ORCH_DATA_DIR = dataDir;
assert.ok(dataDir.startsWith(os.tmpdir()));
const DB_FILE = path.join(dataDir, 'db.json');
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

const { default: express } = await import('express');
const store = await import('../store.js');
const U = await import('../ui-settings.js');
const { apiGuard } = await import('../origin-guard.js');
const { createUiSync, readLocal, UI_KEY, MSG } = await import('../../client/src/ui-state.js');
const P = await import('../../client/src/prefs.js');

let db, server, base;
const disk = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const call = (url, method = 'GET', body, headers = {}) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', origin: base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const put = (body) => call('/api/ui', 'PUT', body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  db = store.load();
  for (const id of ['ws_aaaaaaaa', 'ws_bbbbbbbb']) db.workspaces.push({ id, name: id, path: path.join(root, id) });
  const app = express();
  app.use('/api', apiGuard);
  app.use(express.json());
  U.setupUiSettings(app, { db });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); server.closeAllConnections?.(); await sleep(600); fs.rmSync(root, { recursive: true, force: true }); });

// ---------- 1. rotas ----------
test('banco sem settings.ui: GET devolve o padrão com persisted=false e NÃO grava nada', async () => {
  assert.equal(Object.hasOwn(db.settings, 'ui'), false);
  const r = await call('/api/ui'); assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ui: U.DEFAULT_UI, persisted: false });
  assert.equal(Object.hasOwn(disk().settings, 'ui'), false, 'ler não grava');
});

test('PUT grava (parcial) e GET devolve; o disco tem settings.ui', async () => {
  let r = await put({ fontSize: 16, sidebarCollapsed: true, name: '  Ana  ', role: 'reviewer', isolate: true, motion: 'reduced' }); assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.persisted, true); assert.equal(j.ui.name, 'Ana');
  r = await put({ expandedWorkspaces: { ws_aaaaaaaa: true } }); assert.equal(r.status, 200);
  r = await put({ expandedWorkspaces: { ws_bbbbbbbb: false } }); assert.equal(r.status, 200);
  const g = await (await call('/api/ui')).json();
  assert.deepEqual(g, { ui: { name: 'Ana', isolate: true, role: 'reviewer', fontSize: 16, motion: 'reduced', sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true, ws_bbbbbbbb: false } }, persisted: true }, 'campos não enviados ficam; expandidos são mesclados por chave');
  assert.deepEqual(disk().settings.ui, g.ui);
});

test('campos inválidos são recusados (400 em pt-BR) e NADA muda', async () => {
  const before = JSON.stringify(disk().settings.ui);
  const bad = [{ fontSize: 10 }, { fontSize: 19 }, { fontSize: 13.5 }, { fontSize: '14' }, { motion: 'turbo' }, { role: 'Builder' }, { role: 'a'.repeat(21) }, { isolate: 'sim' }, { sidebarCollapsed: 1 }, { name: 42 }, { name: 'x'.repeat(41) },
    { expandedWorkspaces: [] }, { expandedWorkspaces: { 'ws bad!': true } }, { expandedWorkspaces: { ws_aaaaaaaa: 'sim' } }, { fontSize: 15, motion: 'turbo' }];
  for (const b of bad) { const r = await put(b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match((await r.json()).error, /deve|só aceita/); }
  for (const body of [[], 'texto', null]) assert.equal((await put(body)).status, 400);
  assert.equal(JSON.stringify(disk().settings.ui), before, 'um campo inválido não deixa gravação parcial (mesmo junto de um válido)');
});

test('propriedades desconhecidas são recusadas (inclusive __proto__ e campos de layout, que são de outra etapa)', async () => {
  for (const b of [{ extra: 1 }, { fontSize: 14, outro: true }, { layout: {} }, { maximizedTerminal: 'x' }, JSON.parse('{"__proto__":{"x":1}}'), { constructor: 1 }]) {
    const r = await put(b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match((await r.json()).error, /não permitidas/);
  }
  assert.equal(({}).x, undefined, 'sem poluição de protótipo');
});

test('exige Origin válido (mesma checagem das demais rotas) e workspace removido sai do mapa de expandidos', async () => {
  const r = await fetch(`${base}/api/ui`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 403);
  assert.equal((await put({ fontSize: 14 }).then((x) => x.status)), 200);
  db.workspaces = db.workspaces.filter((w) => w.id !== 'ws_bbbbbbbb');
  const g = await (await call('/api/ui')).json(); assert.deepEqual(g.ui.expandedWorkspaces, { ws_aaaaaaaa: true });
  assert.equal((await put({ expandedWorkspaces: { ws_fantasma: true } })).status, 200);
  assert.deepEqual(disk().settings.ui.expandedWorkspaces, { ws_aaaaaaaa: true }, 'id inexistente não é gravado');
});

test('banco com settings.ui corrompido à mão não derruba nada: GET devolve o que for válido', async () => {
  const keep = db.settings.ui;
  db.settings.ui = { fontSize: 'enorme', motion: 7, role: 'X', name: 3, expandedWorkspaces: 'x', sidebarCollapsed: 'sim' };
  const j = await (await call('/api/ui')).json(); assert.deepEqual(j.ui, U.DEFAULT_UI); assert.equal(j.persisted, true);
  db.settings.ui = 'texto'; assert.deepEqual((await (await call('/api/ui')).json()).ui, U.DEFAULT_UI);
  db.settings.ui = keep;
});

test('falha de gravação: 500 em pt-BR, estado em memória exatamente como antes', async () => {
  const before = JSON.stringify(db.settings);
  fs.mkdirSync(path.join(dataDir, 'db.json.tmp')); // EISDIR: erro real, não transitório
  try {
    const r = await put({ fontSize: 18, sidebarCollapsed: false }); assert.equal(r.status, 500); assert.match((await r.json()).error, /nada foi alterado/);
    assert.equal(JSON.stringify(db.settings), before);
  } finally { fs.rmSync(path.join(dataDir, 'db.json.tmp'), { recursive: true, force: true }); }
  const fresh = { settings: {}, workspaces: [] }; // sem settings.ui antes: a falha também não deixa o campo criado
  const app = express(); app.use(express.json()); U.setupUiSettings(app, { db: fresh });
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  fs.mkdirSync(path.join(dataDir, 'db.json.tmp'));
  try { const r = await fetch(`http://127.0.0.1:${s.address().port}/api/ui`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fontSize: 12 }) }); assert.equal(r.status, 500); assert.equal(Object.hasOwn(fresh.settings, 'ui'), false); }
  finally { fs.rmSync(path.join(dataDir, 'db.json.tmp'), { recursive: true, force: true }); s.close(); s.closeAllConnections?.(); }
});

// ---------- 2. servidor real: sobrevive à reinicialização ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function bootReal(dir) {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [INDEX], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', r));
  for (let i = 0; i < 100 && !/AI Dev Orchestrator API em/.test(out); i++) await Promise.race([sleep(100), exited]);
  assert.match(out, /AI Dev Orchestrator API em/, out);
  const api = (u, m = 'GET', b) => fetch(`${origin}${u}`, { method: m, headers: { 'content-type': 'application/json', origin }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { api, stop: async () => { child.kill(); await exited; await sleep(300); } };
}
test('servidor real: preferências sobrevivem à reinicialização (em outra porta, como no Electron); banco antigo sem settings.ui carrega', async () => {
  const dir = path.join(root, 'boot-data'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 1, settings: { activeWorkspaceId: null, requireApproval: true, showDemoData: false }, workspaces: [], missions: [], activity: [] }));
  let s = await bootReal(dir);
  try {
    assert.deepEqual(await (await s.api('/api/ui')).json(), { ui: U.DEFAULT_UI, persisted: false }, 'banco antigo: padrão, sem erro');
    assert.equal((await s.api('/api/state')).status, 200, 'o restante do servidor segue normal');
    assert.equal((await s.api('/api/ui', 'PUT', { fontSize: 17, sidebarCollapsed: true, name: 'Bia', role: 'scout' })).status, 200);
  } finally { await s.stop(); }
  s = await bootReal(dir); // outra porta = outra origem: o localStorage seria outro, o servidor é o mesmo
  try {
    const g = await (await s.api('/api/ui')).json();
    assert.equal(g.persisted, true); assert.deepEqual({ f: g.ui.fontSize, c: g.ui.sidebarCollapsed, n: g.ui.name, r: g.ui.role }, { f: 17, c: true, n: 'Bia', r: 'scout' });
    assert.equal((await s.api('/api/state')).status, 200);
    assert.equal(((await (await s.api('/api/state')).json()).settings.ui).fontSize, 17, 'também visível em /api/state.settings');
  } finally { await s.stop(); }
});

// ---------- 3. sincronizador do cliente ----------
const memStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m }; };
/** Preferências simuladas com a mesma interface de prefs.js (e o mesmo sanitizePrefs). */
function fakePrefs(init = {}) {
  let cur = P.sanitizePrefs(init), sink = null; const subs = new Set();
  return { DEFAULT_PREFS: P.DEFAULT_PREFS, getPrefs: () => cur, setPrefsSink: (f) => { sink = f; }, replacePrefs: (raw) => { cur = P.sanitizePrefs(raw); for (const f of subs) f(); return cur; },
    userSet: (k, v) => { const before = cur[k]; cur = P.sanitizePrefs({ ...cur, [k]: v }); if (sink && cur[k] !== before) sink({ [k]: cur[k] }); } };
}
const mkServer = (ui = U.DEFAULT_UI, persisted = true) => {
  const srv = { ui: { ...ui }, persisted, calls: [], down: false, status: null, delay: 0 };
  srv.get = async () => { if (srv.down) throw new TypeError('fetch failed'); return { ui: { ...srv.ui }, persisted: srv.persisted }; };
  srv.put = async (b) => {
    srv.calls.push(b); if (srv.delay) await sleep(srv.delay);
    if (srv.down) throw new TypeError('fetch failed');
    if (srv.status) throw Object.assign(new Error('recusado'), { status: srv.status });
    srv.ui = { ...srv.ui, ...b, expandedWorkspaces: { ...srv.ui.expandedWorkspaces, ...b.expandedWorkspaces } }; srv.persisted = true; return { ui: { ...srv.ui }, persisted: true };
  };
  return srv;
};
const mkSync = (srv, storage, prefs, extra = {}) => createUiSync({ get: srv.get, put: srv.put, storage, prefs, debounceMs: 5, retryMs: 25, ...extra });

test('carregamento inicial: o servidor vence o cache e os padrões NUNCA são enviados de volta', async () => {
  const srv = mkServer({ ...U.DEFAULT_UI, fontSize: 17, name: 'Bia', sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true } });
  const prefs = fakePrefs(), st = memStorage(); // cache "de fábrica": padrões
  const ui = mkSync(srv, st, prefs); await ui.start();
  assert.equal(prefs.getPrefs().fontSize, 17); assert.equal(prefs.getPrefs().name, 'Bia');
  assert.equal(ui.getSnapshot().sidebarCollapsed, true); assert.deepEqual(ui.getSnapshot().expandedWorkspaces, { ws_aaaaaaaa: true });
  await sleep(60); assert.equal(srv.calls.length, 0, 'nenhum PUT na inicialização'); assert.equal(ui.getSnapshot().status.state, 'synced');
  assert.deepEqual(JSON.parse(st.m.get(UI_KEY)), { sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true } }, 'o cache passa a refletir o servidor'); ui.stop();
});

test('Electron: cache de OUTRA origem (porta nova = localStorage vazio) é recuperado do servidor', async () => {
  const srv = mkServer({ ...U.DEFAULT_UI, motion: 'reduced', role: 'reviewer', isolate: true, fontSize: 15, sidebarCollapsed: true }), prefs = fakePrefs();
  const ui = mkSync(srv, memStorage(), prefs); await ui.start();
  assert.deepEqual({ m: prefs.getPrefs().motion, r: prefs.getPrefs().role, i: prefs.getPrefs().isolate, f: prefs.getPrefs().fontSize, s: ui.getSnapshot().sidebarCollapsed }, { m: 'reduced', r: 'reviewer', i: true, f: 15, s: true }); ui.stop();
});

test('alterações do usuário são enviadas ao servidor (debounce: várias viram um PUT) e confirmadas', async () => {
  const srv = mkServer(), prefs = fakePrefs(), st = memStorage(); const ui = mkSync(srv, st, prefs); await ui.start();
  prefs.userSet('fontSize', 14); prefs.userSet('fontSize', 15); prefs.userSet('name', 'Caio'); ui.setSidebarCollapsed(true); ui.setExpanded('ws_aaaaaaaa', true); ui.setExpanded('ws_bbbbbbbb', false);
  assert.equal(ui.getSnapshot().sidebarCollapsed, true, 'a tela muda na hora'); assert.equal(ui.getSnapshot().status.state, 'saving');
  await sleep(80);
  assert.equal(srv.calls.length, 1, 'um só PUT'); assert.deepEqual(srv.calls[0], { fontSize: 15, name: 'Caio', sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true, ws_bbbbbbbb: false } });
  assert.equal(ui.getSnapshot().status.state, 'synced'); assert.equal(ui.pending && Object.keys(ui.pending()).length, 0);
  prefs.userSet('fontSize', 15); await sleep(30); assert.equal(srv.calls.length, 1, 'valor igual não gera requisição'); ui.stop();
});

test('sem corrida: o que o usuário mudou durante o PUT/leitura não é desfeito pela resposta do servidor', async () => {
  const srv = mkServer(); srv.delay = 40; const prefs = fakePrefs(); const ui = mkSync(srv, memStorage(), prefs); await ui.start();
  prefs.userSet('fontSize', 12); await sleep(12);      // PUT 1 em voo
  prefs.userSet('fontSize', 16);                       // muda enquanto o PUT 1 ainda não voltou
  await sleep(200);
  assert.equal(prefs.getPrefs().fontSize, 16, 'a resposta do PUT 1 não reverte para 12'); assert.equal(srv.ui.fontSize, 16); assert.deepEqual(srv.calls.map((c) => c.fontSize), [12, 16], 'um PUT por vez, em ordem'); ui.stop();
  // mudança ANTES de a leitura inicial voltar
  const slow = mkServer({ ...U.DEFAULT_UI, fontSize: 18 }), p2 = fakePrefs(); const base = slow.get; slow.get = async () => { await sleep(40); return base(); };
  const u2 = mkSync(slow, memStorage(), p2); const started = u2.start(); p2.userSet('fontSize', 11); await started; await sleep(80);
  assert.equal(p2.getPrefs().fontSize, 11, 'a escolha do usuário vence a leitura inicial'); assert.equal(slow.ui.fontSize, 11); u2.stop();
});

test('banco sem settings.ui: o cache do navegador é migrado UMA vez (só o que difere do padrão)', async () => {
  const srv = mkServer(U.DEFAULT_UI, false), prefs = fakePrefs({ fontSize: 16, name: 'Duda' });
  const st = memStorage({ [UI_KEY]: JSON.stringify({ sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true } }) });
  const ui = mkSync(srv, st, prefs); await ui.start(); await sleep(60);
  assert.equal(srv.calls.length, 1); assert.deepEqual(srv.calls[0], { fontSize: 16, name: 'Duda', sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true } }, 'sem padrões (role, motion, isolate) no envio');
  assert.equal(prefs.getPrefs().fontSize, 16, 'o cache não foi apagado pelos padrões do servidor'); ui.stop();
  const vazio = mkServer(U.DEFAULT_UI, false), u2 = mkSync(vazio, memStorage(), fakePrefs()); await u2.start(); await sleep(40); assert.equal(vazio.calls.length, 0, 'cache de fábrica + banco sem ui: nada é gravado'); u2.stop();
});

test('chaves antigas do localStorage (side, topics:open) são lidas como cache na primeira vez', () => {
  assert.deepEqual(readLocal(memStorage({ side: 'collapsed', 'topics:open': '{"ws_aaaaaaaa":true,"x":"n"}' })), { sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true } });
  assert.deepEqual(readLocal(memStorage({ [UI_KEY]: '{"sidebarCollapsed":false,"expandedWorkspaces":{"ws_bbbbbbbb":false}}', side: 'collapsed' })), { sidebarCollapsed: false, expandedWorkspaces: { ws_bbbbbbbb: false } }, 'a chave nova vence');
  assert.deepEqual(readLocal(memStorage({ [UI_KEY]: '{quebrado' })), { sidebarCollapsed: false, expandedWorkspaces: {} });
  assert.deepEqual(readLocal({ getItem() { throw new Error('bloqueado'); } }), { sidebarCollapsed: false, expandedWorkspaces: {} });
  assert.deepEqual(readLocal(null), { sidebarCollapsed: false, expandedWorkspaces: {} });
});

test('servidor indisponível: o cache vale como fallback, a situação é informada, nada é apagado e, quando volta, o pendente é enviado', async () => {
  const srv = mkServer({ ...U.DEFAULT_UI, fontSize: 17 }); srv.down = true;
  const prefs = fakePrefs({ fontSize: 14 }), st = memStorage({ [UI_KEY]: JSON.stringify({ sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true } }) });
  const ui = mkSync(srv, st, prefs); await ui.start();
  const s = ui.getSnapshot(); assert.equal(s.status.state, 'offline'); assert.equal(s.status.message, MSG.offline);
  assert.equal(s.sidebarCollapsed, true, 'cache local aplicado'); assert.equal(prefs.getPrefs().fontSize, 14); assert.deepEqual(s.expandedWorkspaces, { ws_aaaaaaaa: true });
  ui.setExpanded('ws_bbbbbbbb', true); prefs.userSet('role', 'scout'); await sleep(60);
  assert.equal(ui.getSnapshot().status.state, 'offline'); assert.deepEqual(JSON.parse(st.m.get(UI_KEY)).expandedWorkspaces, { ws_aaaaaaaa: true, ws_bbbbbbbb: true }, 'a mudança offline foi para o cache');
  srv.down = false; await sleep(120); // o retry automático relê o servidor e envia o pendente
  assert.equal(ui.getSnapshot().status.state, 'synced'); assert.equal(srv.ui.role, 'scout'); assert.deepEqual(srv.ui.expandedWorkspaces, { ws_bbbbbbbb: true }, 'o pendente foi enviado');
  assert.equal(prefs.getPrefs().role, 'scout'); assert.equal(prefs.getPrefs().fontSize, 17, 'o que não foi tocado vem do servidor'); ui.stop();
});

test('falha de gravação no servidor (5xx) mantém o pendente e tenta de novo; valor recusado (400) é descartado e o servidor é relido', async () => {
  const srv = mkServer(); const prefs = fakePrefs(); const ui = mkSync(srv, memStorage(), prefs); await ui.start();
  srv.status = 500; prefs.userSet('fontSize', 16); await sleep(60);
  assert.equal(ui.getSnapshot().status.state, 'error'); assert.equal(ui.getSnapshot().status.message, MSG.error); assert.equal(prefs.getPrefs().fontSize, 16, 'a tela mantém a escolha');
  srv.status = null; await sleep(120); assert.equal(srv.ui.fontSize, 16); assert.equal(ui.getSnapshot().status.state, 'synced');
  srv.status = 400; prefs.userSet('fontSize', 12); await sleep(60);
  srv.status = null; assert.equal(ui.getSnapshot().status.state === 'error' || ui.getSnapshot().status.state === 'synced', true);
  await sleep(40); assert.equal(prefs.getPrefs().fontSize, 16, 'valor recusado: volta ao que o servidor tem'); ui.stop();
});

test('revisão: servidor fora no boot + mudança do usuário NÃO grava antes de ler; ao voltar, a migração do cache vai junto (nada se perde)', async () => {
  const srv = mkServer(U.DEFAULT_UI, false); srv.down = true;
  const prefs = fakePrefs({ name: 'Eva', role: 'scout' }), st = memStorage({ [UI_KEY]: JSON.stringify({ sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true } }) });
  const ui = mkSync(srv, st, prefs); await ui.start();
  prefs.userSet('fontSize', 16); await sleep(60);
  assert.equal(srv.calls.length, 0, 'nenhum PUT antes de a leitura inicial ter dado certo'); assert.equal(srv.persisted, false);
  srv.down = false; await sleep(120);
  assert.equal(srv.calls.length, 1); assert.deepEqual(srv.calls[0], { name: 'Eva', role: 'scout', fontSize: 16, sidebarCollapsed: true, expandedWorkspaces: { ws_aaaaaaaa: true } }, 'cache + mudança num único envio');
  assert.equal(prefs.getPrefs().name, 'Eva'); assert.equal(ui.getSnapshot().sidebarCollapsed, true); ui.stop();
});

test('revisão: 400 persistente não gera laço (relê o servidor uma vez, sem remigrar)', async () => {
  const srv = mkServer(U.DEFAULT_UI, false); srv.status = 400; let gets = 0; const g = srv.get; srv.get = async () => { gets++; return g(); };
  const prefs = fakePrefs({ fontSize: 16 }); const ui = mkSync(srv, memStorage(), prefs); await ui.start(); await sleep(200);
  assert.ok(srv.calls.length <= 2 && gets <= 3, 'poucas chamadas: ' + srv.calls.length + ' PUT, ' + gets + ' GET'); assert.equal(ui.getSnapshot().status.state === 'synced' || ui.getSnapshot().status.state === 'error', true); ui.stop();
});

test('revisão: stop() remove o listener online (start/stop/start não acumula) e as ações são um objeto estável', async () => {
  const had = { add: globalThis.addEventListener, rem: globalThis.removeEventListener }, active = new Set();
  globalThis.addEventListener = (n, f) => { if (n === 'online') active.add(f); }; globalThis.removeEventListener = (n, f) => { if (n === 'online') active.delete(f); };
  try {
    const ui = mkSync(mkServer(), memStorage(), fakePrefs()); await ui.start(); assert.equal(active.size, 1); ui.stop(); assert.equal(active.size, 0);
    await ui.start(); assert.equal(active.size, 1); ui.stop();
    assert.equal(ui.actions, ui.actions); assert.equal(typeof ui.actions.setExpanded, 'function');
  } finally { globalThis.addEventListener = had.add; globalThis.removeEventListener = had.rem; if (!had.add) delete globalThis.addEventListener; if (!had.rem) delete globalThis.removeEventListener; }
});

test('revisão: __proto__ como id de workspace é recusado no PUT e ignorado no cache', async () => {
  const r = await put({ expandedWorkspaces: JSON.parse('{"__proto__":true}') }); assert.equal(r.status, 400);
  assert.deepEqual(readLocal(memStorage({ [UI_KEY]: '{"expandedWorkspaces":{"__proto__":true,"ws_aaaaaaaa":true}}' })).expandedWorkspaces, { ws_aaaaaaaa: true });
  assert.equal(({}).polluted, undefined);
});
