// Fluxo ÚNICO de saída dos terminais (/api/terminals/stream): o navegador só abre ~6 conexões por origem, então uma conexão por pane travava a tela (e o botão de fechar) com 7+ terminais.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tstream-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporário */ } });
const { createTerminalManager, MAX_ALL_SUBSCRIBERS } = await import('../terminals.js');
const { createTerminalStream, SCREEN_LIMIT } = await import('../../client/src/terminal-stream.js');

const ws = path.join(tmp, 'ws'); fs.mkdirSync(ws, { recursive: true });
const db = { settings: { activeWorkspaceId: 'w' }, workspaces: [{ id: 'w', name: 'w', path: ws }] };
let pid = 1_900_600_000; const ptys = [];
const lib = { spawn() { const p = { pid: ++pid, onData(cb) { p.d = cb; }, onExit(cb) { p.e = cb; }, write() {}, resize() {} }; ptys.push(p); return p; } };
const mgr = createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'x', args: [], viaShell: false }), killTree() {}, waitFor: () => true });
const fakeRes = () => { const r = new EventEmitter(); r.out = ''; r.writeHead = () => {}; r.write = (x) => { r.out += x; return true; }; r.end = () => {}; return r; };
const events = (out) => [...out.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));

test('servidor: uma conexão recebe init (com a tela atual), data, exit e closed de TODOS os terminais, inclusive os criados depois', async () => {
  const a = (await mgr.create({ role: 'builder' })).session; ptys[0].d('tela A');
  const res = fakeRes(); assert.equal(mgr.subscribeAll(res), true);
  assert.deepEqual(events(res.out).map((e) => [e.event, e.data.id, e.data.replay]), [['init', a.id, 'tela A']]);
  const b = (await mgr.create({ role: 'reviewer' })).session; assert.deepEqual(events(res.out).at(-1), { event: 'init', data: { id: b.id, session: b.id ? events(res.out).at(-1).data.session : null, replay: '' } });
  ptys[1].d('saída B'); assert.deepEqual(events(res.out).at(-1), { event: 'data', data: { id: b.id, d: 'saída B' } });
  ptys[0].e({ exitCode: 2 }); assert.equal(events(res.out).at(-1).event, 'exit'); assert.deepEqual([events(res.out).at(-1).data.id, events(res.out).at(-1).data.exitCode], [a.id, 2]);
  mgr.close(b.id); assert.deepEqual(events(res.out).at(-1), { event: 'closed', data: { id: b.id } });
  const late = fakeRes(); mgr.subscribeAll(late); assert.deepEqual(events(late.out).map((e) => e.event), ['init', 'exit'], 'quem chega depois recebe tela e fim do que já acabou');
  res.emit('close'); late.emit('close');
});

test('servidor: limite de conexões do fluxo único e limpeza quando o cliente sai', () => {
  const rs = []; for (let i = 0; i < MAX_ALL_SUBSCRIBERS; i++) { const r = fakeRes(); assert.equal(mgr.subscribeAll(r), true); rs.push(r); }
  assert.equal(mgr.subscribeAll(fakeRes()), null); rs[0].emit('close'); assert.equal(mgr.subscribeAll(fakeRes()), true);
});

// ---- cliente (função pura com EventSource injetado) ----
class FakeES { constructor(url) { this.url = url; this.l = {}; this.closed = false; FakeES.last = this; } addEventListener(n, f) { this.l[n] = f; } close() { this.closed = true; } emit(n, o) { this.l[n]?.({ data: JSON.stringify(o) }); } }

test('cliente: uma única conexão para N panes; a tela chega a quem monta depois; exit e closed; um pane com defeito não derruba os outros', () => {
  FakeES.last = null; const st = createTerminalStream({ EventSourceImpl: FakeES, url: '/x' }); const log = [];
  const sub = (id, extra = {}) => st.subscribe(id, { onReset: (t) => log.push([id, 'reset', t]), onData: (d) => log.push([id, 'data', d]), onExit: (c) => log.push([id, 'exit', c]), ...extra });
  const u1 = sub('term_aaaaaaaa'); const es = FakeES.last; assert.equal(es.url, '/x');
  for (let i = 0; i < 9; i++) sub(`term_0000000${i}`); assert.equal(FakeES.last, es, 'nenhuma conexão extra: 10 panes, 1 EventSource');
  es.emit('init', { id: 'term_aaaaaaaa', replay: 'oi' }); es.emit('data', { id: 'term_aaaaaaaa', d: ' mundo' }); assert.deepEqual(log.filter((x) => x[0] === 'term_aaaaaaaa'), [['term_aaaaaaaa', 'reset', 'oi'], ['term_aaaaaaaa', 'data', ' mundo']]);
  assert.equal(st.screenOf('term_aaaaaaaa'), 'oi mundo');
  log.length = 0; sub('term_aaaaaaaa'); assert.deepEqual(log, [['term_aaaaaaaa', 'reset', 'oi mundo']], 'pane montado depois recebe a tela já impressa');
  es.emit('exit', { id: 'term_aaaaaaaa', exitCode: 3 }); log.length = 0; sub('term_aaaaaaaa'); assert.deepEqual(log.map((x) => x[1]), ['reset', 'exit']);
  st.subscribe('term_bbbbbbbb', { onData() { throw new Error('pane quebrado'); } }); const ok = []; st.subscribe('term_bbbbbbbb', { onData: (d) => ok.push(d) }); es.emit('data', { id: 'term_bbbbbbbb', d: 'x' }); assert.deepEqual(ok, ['x']);
  es.emit('data', { id: 'term_aaaaaaaa', d: 5 }); es.l.data({ data: 'não é json' }); es.emit('data', { d: 'sem id' });
  u1(); es.emit('closed', { id: 'term_aaaaaaaa' }); assert.equal(st.screenOf('term_aaaaaaaa'), null);
  st.subscribe('term_cccccccc', {}); es.emit('init', { id: 'term_cccccccc', replay: 'z'.repeat(SCREEN_LIMIT + 50) }); es.emit('data', { id: 'term_cccccccc', d: 'FIM' }); assert.ok(st.screenOf('term_cccccccc').length <= SCREEN_LIMIT && st.screenOf('term_cccccccc').endsWith('FIM'));
  st.close(); assert.equal(es.closed, true);
});
