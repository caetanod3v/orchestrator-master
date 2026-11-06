// Etapa 5: layout persistente da grade de terminais por workspace (server/layouts.js e client/src/layout-state.js).
// Parte 1: rotas num Express próprio (banco TEMPORÁRIO). Parte 2: servidor REAL reiniciado (ORCH_DATA_DIR temporário, porta livre; a 4317 e data/ nunca são tocadas).
// Parte 3: funções puras. Parte 4: o sincronizador do cliente com servidor e armazenamento simulados.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lay-'));
const dataDir = path.join(root, 'data');
process.env.ORCH_DATA_DIR = dataDir;
assert.ok(dataDir.startsWith(os.tmpdir()));
const DB_FILE = path.join(dataDir, 'db.json');
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

const { default: express } = await import('express');
const store = await import('../store.js');
const L = await import('../layouts.js');
const { apiGuard } = await import('../origin-guard.js');
const C = await import('../../client/src/layout-state.js');

let db, server, base;
const disk = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const call = (url, method = 'GET', body, headers = {}) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', origin: base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const putL = (ws, body) => call(`/api/workspaces/${ws}/layout`, 'PUT', body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (n) => `ses_${String(n).padStart(8, '0')}`; // ids de sessão válidos (ses_ + 8 hex)
const G22 = { cols: [1, 1], rows: [1, 1] };

before(async () => {
  db = store.load();
  for (const id of ['wsA', 'wsB']) db.workspaces.push({ id, name: id, path: path.join(root, id) });
  const app = express(); app.use('/api', apiGuard); app.use(express.json());
  L.setupLayouts(app, { db });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); server.closeAllConnections?.(); await sleep(600); fs.rmSync(root, { recursive: true, force: true }); });

// ---------- 1. rotas ----------
test('sem layouts salvos: GET devolve {} e não grava nada (banco antigo)', async () => {
  assert.deepEqual(await (await call('/api/layouts')).json(), { layouts: {} });
  assert.equal(Object.hasOwn(disk().settings, 'layouts'), false);
});

test('PUT grava ordem, ampliado e trilhas de UM workspace; GET devolve; o outro workspace fica intocado', async () => {
  const r = await putL('wsA', { order: [R(1), R(2), R(3)], maximized: R(2), grids: { '2x2': { cols: [1.4, 0.6], rows: [1, 1] } } }); assert.equal(r.status, 200);
  const g = (await (await call('/api/layouts')).json()).layouts;
  assert.deepEqual(g.wsA, { order: [R(1), R(2), R(3)], maximized: R(2), grids: { '2x2': { cols: [1.4, 0.6], rows: [1, 1] } } }); assert.equal(g.wsB, undefined, 'isolamento entre workspaces');
  assert.deepEqual(disk().settings.layouts.wsA.order, [R(1), R(2), R(3)]);
  await putL('wsB', { order: [R(9)] });
  assert.deepEqual((await (await call('/api/layouts')).json()).layouts.wsA.maximized, R(2), 'gravar o B não mexe no A');
});

test('PUT é parcial: grids mesclam formato a formato; maximized aceita null; order substitui', async () => {
  await putL('wsA', { grids: { '3x2': { cols: [1, 1, 1], rows: [1, 1] } } });
  let a = (await (await call('/api/layouts')).json()).layouts.wsA; assert.deepEqual(Object.keys(a.grids).sort(), ['2x2', '3x2']); assert.deepEqual(a.order, [R(1), R(2), R(3)], 'order intacto');
  await putL('wsA', { maximized: null, order: [R(3), R(1)] });
  a = (await (await call('/api/layouts')).json()).layouts.wsA; assert.deepEqual([a.maximized, a.order], [null, [R(3), R(1)]]);
});

test('valores inválidos são recusados (400 em pt-BR) e NADA muda', async () => {
  const before = JSON.stringify(disk().settings.layouts);
  const bad = [{ order: 'x' }, { order: [R(1), R(1)] }, { order: ['ses_zzzz'] }, { order: Array.from({ length: 25 }, (_, i) => R(i)) }, { maximized: 'term_abc' }, { maximized: 5 },
    { grids: [] }, { grids: { '2x2': { cols: [1, 1] } } }, { grids: { '2x2': { cols: [1, 'a'], rows: [1, 1] } } }, { grids: { '2x2': { cols: [0, 1], rows: [1, 1] } } }, { grids: { '2x2': { cols: [1, 1], rows: [1, 1], extra: 1 } } },
    { grids: { 'abc': G22 } }, { grids: { '0x2': G22 } }, { grids: { '13x1': G22 } }, { grids: { '2x2': { cols: Array(9).fill(1), rows: [1] } } }, { grids: { '2x2': { cols: [1, 500], rows: [1, 1] } } }];
  for (const b of bad) { const r = await putL('wsA', b); assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80)); assert.match((await r.json()).error, /deve|inválido|não permitid/i); }
  for (const body of [[], 'texto', null]) assert.equal((await putL('wsA', body)).status, 400);
  assert.equal(JSON.stringify(disk().settings.layouts), before);
});

test('propriedades desconhecidas (inclusive __proto__) e workspace inexistente são recusados; exige Origin válido', async () => {
  for (const b of [{ x: 1 }, { order: [], extra: true }, JSON.parse('{"__proto__":{"a":1}}'), { constructor: 1 }]) { const r = await putL('wsA', b); assert.equal(r.status, 400); assert.match((await r.json()).error, /não permitidas/); }
  assert.equal(({}).a, undefined);
  assert.equal((await putL('ws_fantasma', { order: [] })).status, 404);
  assert.equal((await fetch(`${base}/api/workspaces/wsA/layout`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
});

test('limite de formatos de grade: os mais antigos saem; layout de workspace removido é esquecido ao gravar outro', async () => {
  const keys = []; for (let c = 1; c <= 12; c++) for (const r of [1, 2]) keys.push(`${c}x${r}`);
  for (const k of keys) assert.equal((await putL('wsB', { grids: { [k]: G22 } })).status, 200);
  assert.ok(Object.keys((await (await call('/api/layouts')).json()).layouts.wsB.grids).length <= L.MAX_GRIDS);
  db.workspaces = db.workspaces.filter((w) => w.id !== 'wsB'); await putL('wsA', { maximized: null });
  assert.equal(disk().settings.layouts.wsB, undefined, 'workspace removido sai do banco'); assert.equal((await (await call('/api/layouts')).json()).layouts.wsB, undefined);
  db.workspaces.push({ id: 'wsB', name: 'wsB', path: path.join(root, 'wsB') });
});

test('banco com layouts corrompido à mão não derruba nada: GET devolve só o que for válido', async () => {
  const keep = db.settings.layouts;
  db.settings.layouts = { wsA: { order: ['x', R(1), R(1)], maximized: 7, grids: { '2x2': { cols: [1], rows: 'a' }, '1x1': { cols: [1], rows: [1] } } }, wsB: 'texto' };
  const g = (await (await call('/api/layouts')).json()).layouts; assert.deepEqual(g.wsA, { order: [R(1)], maximized: null, grids: { '1x1': { cols: [1], rows: [1] } } }); assert.equal(g.wsB, undefined, 'valor que nem é objeto: omitido');
  db.settings.layouts = 'lixo'; assert.deepEqual((await (await call('/api/layouts')).json()).layouts, {});
  db.settings.layouts = keep;
});

test('falha de gravação: 500 em pt-BR e o estado em memória fica exatamente como antes', async () => {
  const before = JSON.stringify(db.settings);
  fs.mkdirSync(path.join(dataDir, 'db.json.tmp')); // EISDIR: erro real, não transitório
  try { const r = await putL('wsA', { maximized: R(5) }); assert.equal(r.status, 500); assert.match((await r.json()).error, /nada foi alterado/); assert.equal(JSON.stringify(db.settings), before); }
  finally { fs.rmSync(path.join(dataDir, 'db.json.tmp'), { recursive: true, force: true }); }
});

// ---------- 2. servidor real: sobrevive à reinicialização ----------
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function bootReal(dir) {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [INDEX], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', r));
  for (let i = 0; i < 100 && !/FORGE API em/.test(out); i++) await Promise.race([sleep(100), exited]);
  assert.match(out, /FORGE API em/, out);
  const api = (u, m = 'GET', b) => fetch(`${origin}${u}`, { method: m, headers: { 'content-type': 'application/json', origin }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { api, stop: async () => { child.kill(); await exited; await sleep(300); } };
}
test('servidor real: o layout de cada workspace sobrevive à reinicialização; banco antigo sem layouts carrega', async () => {
  const dir = path.join(root, 'boot-data'); fs.mkdirSync(dir); fs.mkdirSync(path.join(root, 'p1')); fs.mkdirSync(path.join(root, 'p2'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 1, settings: { activeWorkspaceId: null, requireApproval: true, showDemoData: false }, workspaces: [], missions: [], activity: [] }));
  let s = await bootReal(dir), w1, w2;
  try {
    assert.deepEqual(await (await s.api('/api/layouts')).json(), { layouts: {} }, 'banco antigo: vazio, sem erro');
    w1 = (await (await s.api('/api/workspaces', 'POST', { path: path.join(root, 'p1'), name: 'p1' })).json()).id; w2 = (await (await s.api('/api/workspaces', 'POST', { path: path.join(root, 'p2'), name: 'p2' })).json()).id;
    assert.equal((await s.api(`/api/workspaces/${w1}/layout`, 'PUT', { order: [R(1), R(2)], maximized: R(1), grids: { '2x1': { cols: [0.7, 1.3], rows: [1] } } })).status, 200);
    assert.equal((await s.api(`/api/workspaces/${w2}/layout`, 'PUT', { order: [R(7)] })).status, 200);
  } finally { await s.stop(); }
  s = await bootReal(dir);
  try {
    const g = (await (await s.api('/api/layouts')).json()).layouts;
    assert.deepEqual(g[w1], { order: [R(1), R(2)], maximized: R(1), grids: { '2x1': { cols: [0.7, 1.3], rows: [1] } } }); assert.deepEqual(g[w2], { order: [R(7)], maximized: null, grids: {} });
    assert.equal((await s.api('/api/state')).status, 200);
  } finally { await s.stop(); }
});

// ---------- 3. funções puras ----------
test('orderSessions: segue a ordem salva, os desconhecidos vão depois na ordem original, estável e sem mutar', () => {
  const items = [{ recordId: R(3) }, { recordId: R(1) }, { recordId: R(9) }, { recordId: R(2) }, { recordId: null }];
  const out = C.orderSessions(items, [R(1), R(2), R(3)]); assert.deepEqual(out.map((s) => s.recordId), [R(1), R(2), R(3), R(9), null]);
  assert.deepEqual(items.map((s) => s.recordId), [R(3), R(1), R(9), R(2), null], 'não muta'); assert.deepEqual(C.orderSessions(items, undefined).map((s) => s.recordId), items.map((s) => s.recordId));
  assert.deepEqual(C.orderSessions([{ id: R(5) }, { id: R(4) }], [R(4)], (x) => x.id).map((x) => x.id), [R(4), R(5)], 'seletor de id próprio');
});
test('mergeOrder: mantém quem não está vivo (restauração), acrescenta os novos e respeita o limite', () => {
  assert.deepEqual(C.mergeOrder([R(1), R(2)], [R(3)]), [R(1), R(2), R(3)]); assert.deepEqual(C.mergeOrder([R(1), R(2)], [R(2), R(1)]), [R(1), R(2)], 'sem duplicar');
  const many = Array.from({ length: 24 }, (_, i) => R(i)); const out = C.mergeOrder(many, [R(99)]); assert.equal(out.length, 24); assert.ok(out.includes(R(99)) && !out.includes(R(0)), 'sai o mais antigo que não está visível');
  assert.deepEqual(C.mergeOrder(undefined, []), []);
});
test('sanitizeLayout e roundTracks descartam lixo e arredondam', () => {
  assert.deepEqual(C.sanitizeLayout(null), { order: [], maximized: null, grids: {} }); assert.deepEqual(C.sanitizeLayout({ order: [R(1), 'x'], maximized: 'y', grids: { '2x2': { cols: [1], rows: [] } } }), { order: [R(1)], maximized: null, grids: {} });
  assert.deepEqual(C.roundTracks([1.123456789, 0.5]), [1.1235, 0.5]);
});

// ---------- 4. sincronizador do cliente ----------
const memStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m }; };
const mkServer = (layouts = {}) => {
  const srv = { layouts: structuredClone(layouts), calls: [], down: false, status: null, delay: 0 };
  srv.get = async () => { if (srv.down) throw new TypeError('fetch failed'); return { layouts: structuredClone(srv.layouts) }; };
  srv.put = async (ws, b) => {
    srv.calls.push([ws, structuredClone(b)]); if (srv.delay) await sleep(srv.delay);
    if (srv.down) throw new TypeError('fetch failed'); if (srv.status) throw Object.assign(new Error('x'), { status: srv.status });
    const cur = srv.layouts[ws] ?? { order: [], maximized: null, grids: {} }; srv.layouts[ws] = { ...cur, ...b, grids: { ...cur.grids, ...b.grids } }; return { layout: structuredClone(srv.layouts[ws]) };
  };
  return srv;
};
const mk = (srv, st = memStorage()) => C.createLayoutSync({ get: srv.get, put: srv.put, storage: st, debounceMs: 5, retryMs: 25 });
const lay = (c, ws) => c.getSnapshot().layouts[ws] ?? C.EMPTY;

test('cliente: o servidor vence o cache; nada é enviado só por ler; ready só depois da leitura', async () => {
  const srv = mkServer({ wsA: { order: [R(1)], maximized: R(1), grids: { '1x1': G22 } } }); const c = mk(srv, memStorage());
  assert.equal(c.getSnapshot().ready, false); await c.start(); await sleep(40);
  assert.equal(c.getSnapshot().ready, true); assert.deepEqual(lay(c, 'wsA').order, [R(1)]); assert.equal(lay(c, 'wsA').maximized, R(1)); assert.equal(srv.calls.length, 0, 'nenhum PUT na leitura'); c.stop();
});
test('cliente: mudanças por workspace são enviadas (debounce: várias viram um PUT por workspace) e não vazam entre workspaces', async () => {
  const srv = mkServer(); const c = mk(srv); await c.start();
  c.actions.setMaximized('wsA', R(2)); c.actions.setOrder('wsA', [R(1), R(2)]); c.actions.setGrid('wsA', '2x1', { cols: [0.7123456, 1.3], rows: [1] }); c.actions.setMaximized('wsB', R(8));
  assert.equal(lay(c, 'wsA').maximized, R(2), 'aparece na hora'); assert.equal(lay(c, 'wsB').maximized, R(8)); assert.equal(lay(c, 'wsA').grids['2x1'].cols[0], 0.7123, 'trilhas arredondadas');
  await sleep(120); assert.equal(srv.calls.length, 2, 'um PUT por workspace'); assert.deepEqual(srv.layouts.wsA.order, [R(1), R(2)]); assert.equal(srv.layouts.wsB.maximized, R(8)); assert.equal(srv.layouts.wsB.order?.length ?? 0, 0);
  c.actions.setOrder('wsA', [R(1), R(2)]); await sleep(40); assert.equal(srv.calls.length, 2, 'igual ao atual: não envia de novo'); c.stop();
});
test('cliente: arrastar sem mudar nada (ou voltar ao padrão sem nada salvo) não grava; mudar de verdade grava uma vez', async () => {
  const srv = mkServer(); const c = mk(srv); await c.start();
  c.actions.setGrid('wsA', '2x2', { cols: [1, 1], rows: [1, 1] }); await sleep(40); assert.equal(srv.calls.length, 0, 'padrão sem nada salvo: ignorado'); assert.deepEqual(lay(c, 'wsA').grids, {});
  c.actions.setGrid('wsA', '2x2', { cols: [1.3, 0.7], rows: [1, 1] }); await sleep(60); assert.equal(srv.calls.length, 1);
  c.actions.setGrid('wsA', '2x2', { cols: [1.3, 0.7], rows: [1, 1] }); await sleep(40); assert.equal(srv.calls.length, 1, 'igual ao salvo: ignorado');
  c.actions.setGrid('wsA', '2x2', { cols: [1, 1], rows: [1, 1] }); await sleep(60); assert.equal(srv.calls.length, 2, 'voltar ao padrão QUANDO já havia salvo é uma mudança real'); assert.deepEqual(srv.layouts.wsA.grids['2x2'].cols, [1, 1]); c.stop();
});
test('cliente: ações inválidas são ignoradas (id de sessão, formato e trilhas)', async () => {
  const srv = mkServer(); const c = mk(srv); await c.start();
  c.actions.setMaximized('wsA', 'term_1'); c.actions.setGrid('wsA', 'abc', G22); c.actions.setGrid('wsA', '2x2', { cols: [], rows: [1] }); c.actions.setOrder('wsA', ['x', R(1), R(1)]); c.actions.setMaximized('ws com espaço', R(1));
  assert.deepEqual(lay(c, 'wsA'), { order: [R(1)], maximized: null, grids: {} }); assert.equal(lay(c, 'ws com espaço'), C.EMPTY); await sleep(60); assert.equal(srv.calls.length, 1); c.stop();
});
test('cliente: forget (usuário fechou o terminal) tira da ordem e desfaz o ampliado só desse terminal', async () => {
  const srv = mkServer({ wsA: { order: [R(1), R(2), R(3)], maximized: R(2), grids: {} } }); const c = mk(srv); await c.start();
  c.actions.forget('wsA', R(3)); assert.deepEqual(lay(c, 'wsA').order, [R(1), R(2)]); assert.equal(lay(c, 'wsA').maximized, R(2), 'outro terminal ampliado continua');
  c.actions.forget('wsA', R(2)); assert.deepEqual([lay(c, 'wsA').order, lay(c, 'wsA').maximized], [[R(1)], null]); await sleep(60); assert.deepEqual([srv.layouts.wsA.order, srv.layouts.wsA.maximized], [[R(1)], null]); c.stop();
});
test('cliente: NUNCA grava antes de ler o servidor; a ordem salva (com sessões interrompidas) não é apagada por uma mudança feita antes da leitura', async () => {
  const srv = mkServer({ wsA: { order: [R(1), R(2)], maximized: null, grids: {} } }); srv.down = true; const c = mk(srv); await c.start();
  c.actions.setMaximized('wsA', R(2)); await sleep(60); assert.equal(srv.calls.length, 0, 'nenhum PUT com o servidor fora'); assert.equal(c.getSnapshot().ready, false);
  srv.down = false; await sleep(150);
  assert.equal(c.getSnapshot().ready, true); assert.deepEqual(srv.layouts.wsA.order, [R(1), R(2)], 'ordem do servidor preservada'); assert.equal(srv.layouts.wsA.maximized, R(2), 'a mudança do usuário foi enviada'); c.stop();
});
test('cliente: o que o usuário mudou durante o PUT não é desfeito pela resposta', async () => {
  const srv = mkServer(); srv.delay = 40; const c = mk(srv); await c.start();
  c.actions.setMaximized('wsA', R(1)); await sleep(12); c.actions.setMaximized('wsA', R(2)); await sleep(220);
  assert.equal(lay(c, 'wsA').maximized, R(2)); assert.equal(srv.layouts.wsA.maximized, R(2)); assert.deepEqual(srv.calls.map(([, b]) => b.maximized), [R(1), R(2)], 'um PUT por vez, em ordem'); c.stop();
});
test('cliente: servidor fora usa o cache e reenvia depois; cache de outra origem (porta nova) é recuperado do servidor', async () => {
  const st = memStorage({ [C.LAYOUT_KEY]: JSON.stringify({ wsA: { order: [R(4)], maximized: R(4), grids: {} } }) });
  const srv = mkServer(); srv.down = true; const c = mk(srv, st); await c.start(); await sleep(30);
  assert.equal(lay(c, 'wsA').maximized, R(4), 'cache aplicado offline'); srv.down = false; await sleep(120);
  assert.deepEqual(srv.layouts.wsA.order, [R(4)], 'cache do navegador migrado ao servidor que não o tinha'); c.stop();
  const srv2 = mkServer({ wsA: { order: [R(5)], maximized: null, grids: {} } }); const c2 = mk(srv2, memStorage()); await c2.start(); assert.deepEqual(lay(c2, 'wsA').order, [R(5)], 'localStorage vazio: vem do servidor'); c2.stop();
});
test('cliente: PUT recusado (400) de workspace que o servidor não conhece NÃO vira laço de leitura+gravação', async () => {
  const st = memStorage({ [C.LAYOUT_KEY]: JSON.stringify({ wsNovo: { order: [R(1)], maximized: R(1), grids: {} } }) });
  const srv = mkServer(); srv.status = 400; const c = mk(srv, st); await c.start(); await sleep(300);
  assert.ok(srv.calls.length <= 3, `poucos PUTs (foram ${srv.calls.length})`); assert.equal(Object.keys(c.pending()).length, 0, 'nada ficou pendente'); assert.equal(lay(c, 'wsNovo'), C.EMPTY, 'valor recusado descartado'); c.stop();
});
test('cliente: 404 (workspace removido) esquece o layout; 5xx mantém e tenta de novo; 400 relê o servidor', async () => {
  const srv = mkServer(); const c = mk(srv); await c.start();
  srv.status = 404; c.actions.setMaximized('wsGone', R(1)); await sleep(60); assert.equal(lay(c, 'wsGone'), C.EMPTY, 'esquecido'); assert.equal(Object.keys(c.pending()).length, 0);
  srv.status = 500; c.actions.setMaximized('wsA', R(3)); await sleep(60); assert.equal(lay(c, 'wsA').maximized, R(3), 'a tela mantém'); srv.status = null; await sleep(120); assert.equal(srv.layouts.wsA.maximized, R(3));
  srv.status = 400; c.actions.setMaximized('wsA', R(6)); await sleep(60); srv.status = null; await sleep(60); assert.equal(lay(c, 'wsA').maximized, R(3), 'valor recusado: volta ao do servidor'); c.stop();
});
