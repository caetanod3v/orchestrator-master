// Etapa 7: histórico de conversas próprio, por workspace (server/conversations.js). Transcripts SIMULADOS em diretório temporário; nada real é lido.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-conv-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const C = await import('../conversations.js');
const T = await import('../terminals.js');
const { default: express } = await import('express');
const { apiGuard } = await import('../origin-guard.js');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R = (n) => `ses_${String(n).padStart(8, '0')}`;
const cfg = path.join(tmp, 'claude'), proj = path.join(cfg, 'projects', 'C--x'); fs.mkdirSync(proj, { recursive: true });
let seq = 0;
const tfile = (n) => path.join(proj, `${uuid(n)}.jsonl`);
const line = (o) => `${JSON.stringify({ uuid: `u${++seq}`, timestamp: `2026-11-05T10:00:${String(seq % 60).padStart(2, '0')}.000Z`, ...o })}\n`;
const U = (t, x = {}) => line({ type: 'user', message: { role: 'user', content: t }, ...x });
const A = (t) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const mk = (name) => C.createConversationStore({ dir: path.join(tmp, name), configDir: cfg });
const rec = (n, ws = 'ws_aaaaaaaa', over = {}) => ({ id: R(n), workspaceId: ws, claudeSessionId: uuid(n), title: `Sessão ${n}`, role: 'builder', ...over });

test('messageOf: só texto de usuário e assistente; ferramentas, raciocínio, meta, sidechain e comandos locais ficam de fora', () => {
  const m = C.messageOf;
  const oi = JSON.parse(U('oi')); assert.deepEqual(m(oi), { r: 'u', t: 'oi', at: oi.timestamp });
  assert.equal(m({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } }), null);
  assert.equal(m({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }), null);
  assert.equal(m({ type: 'user', message: { content: [{ type: 'tool_result', content: 'saida' }] } }), null);
  assert.equal(m({ type: 'user', isMeta: true, message: { content: 'x' } }), null);
  assert.equal(m({ type: 'user', isSidechain: true, message: { content: 'x' } }), null);
  assert.equal(m({ type: 'user', message: { content: '<local-command-stdout>x</local-command-stdout>' } }), null);
  assert.equal(m({ type: 'ai-title', aiTitle: 'x' }), null);
  assert.equal(m({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }).t, 'a\n\nb');
  assert.match(m({ type: 'user', message: { content: 'chave sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV e Bearer abcdefghijklmnopqrstuvwxyz0123' } }).t, /^chave \[segredo omitido\] e \[segredo omitido\]$/);
  const big = m({ type: 'user', message: { content: 'x'.repeat(C.MAX_MSG_CHARS + 50) } }).t; assert.ok(big.length < C.MAX_MSG_CHARS + 30 && big.endsWith('[…cortado]'));
});

test('captura incremental: copia só o novo, título automático, contagens; repetir não duplica; linha incompleta espera', () => {
  const s = mk('h1'), r = rec(1);
  fs.writeFileSync(tfile(1), U('primeira pergunta') + A('resposta 1') + line({ type: 'ai-title', aiTitle: 'Título gerado' }) + line({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }));
  assert.deepEqual(s.sync(r), { ok: true, added: 2 });
  assert.deepEqual(s.sync(r), { ok: true, added: 0 }, 'nada novo: nada copiado');
  fs.appendFileSync(tfile(1), U('segunda') + '{"type":"assistant","message":{"content":[{"type":"te'); // última linha cortada
  assert.equal(s.sync(r).added, 1);
  fs.appendFileSync(tfile(1), 'xt","text":"completa"}]}}\n'); assert.equal(s.sync(r).added, 1, 'a linha cortada entra quando fecha');
  const [c] = s.list('ws_aaaaaaaa'); assert.deepEqual([c.id, c.title, c.aiTitle, c.user, c.assistant, c.first, c.last], [R(1), 'Sessão 1', 'Título gerado', 2, 2, 'primeira pergunta', 'completa']);
  const d = s.read('ws_aaaaaaaa', R(1)); assert.deepEqual(d.messages.map((m) => `${m.r}:${m.t}`), ['u:primeira pergunta', 'a:resposta 1', 'u:segunda', 'a:completa']); assert.equal(d.total, 4);
  assert.deepEqual(s.read('ws_aaaaaaaa', R(1), { offset: 1, limit: 2 }).messages.map((m) => m.t), ['resposta 1', 'segunda']);
});

test('independe do processo e do transcript: depois de copiada, a conversa continua legível mesmo com o transcript apagado', () => {
  const s = mk('h2'), r = rec(2); fs.writeFileSync(tfile(2), U('pergunta') + A('resposta')); s.sync(r);
  fs.rmSync(tfile(2));
  assert.deepEqual(s.sync(r), { ok: false, reason: 'sem_transcricao' });
  assert.equal(s.read('ws_aaaaaaaa', R(2)).messages.length, 2); assert.equal(s.list('ws_aaaaaaaa').length, 1);
});

test('organizado por workspace: cada lista só mostra o seu; ler com o workspace errado não acha; busca por texto', () => {
  const s = mk('h3'); fs.writeFileSync(tfile(3), U('banco de dados') + A('ok')); fs.writeFileSync(tfile(4), U('interface') + A('ok'));
  s.sync(rec(3, 'ws_aaaaaaaa')); s.sync(rec(4, 'ws_bbbbbbbb'));
  assert.deepEqual(s.list('ws_aaaaaaaa').map((x) => x.id), [R(3)]); assert.deepEqual(s.list('ws_bbbbbbbb').map((x) => x.id), [R(4)]);
  assert.equal(s.read('ws_bbbbbbbb', R(3)), null); assert.equal(s.read('ws_aaaaaaaa', R(4)), null);
  assert.deepEqual(s.list('ws_aaaaaaaa', { q: 'BANCO' }).map((x) => x.id), [R(3)]); assert.deepEqual(s.list('ws_aaaaaaaa', { q: 'interface' }), []);
  assert.deepEqual(s.list('../x'), []); assert.deepEqual(s.list('ws_zzzzzzzz'), []);
  assert.equal(s.sync(rec(3, '../fora')).ok, false, 'workspace com separador de caminho é recusado');
  assert.ok(!fs.existsSync(path.join(tmp, 'fora')));
});

test('metadado de outro workspace dentro da pasta é ignorado (integridade da origem)', () => {
  const s = mk('h4'); fs.writeFileSync(tfile(5), U('x') + A('y')); s.sync(rec(5, 'ws_aaaaaaaa'));
  fs.mkdirSync(path.join(tmp, 'h4', 'ws_bbbbbbbb'), { recursive: true }); fs.copyFileSync(path.join(tmp, 'h4', 'ws_aaaaaaaa', `${R(5)}.json`), path.join(tmp, 'h4', 'ws_bbbbbbbb', `${R(5)}.json`));
  assert.deepEqual(s.list('ws_bbbbbbbb'), []); assert.equal(s.read('ws_bbbbbbbb', R(5)), null);
});

test('queda entre a gravação do log e do resumo: o excesso do log é descartado e nada é duplicado', () => {
  const s = mk('h5'), r = rec(6); fs.writeFileSync(tfile(6), U('a') + A('b')); s.sync(r);
  fs.appendFileSync(path.join(tmp, 'h5', 'ws_aaaaaaaa', `${R(6)}.log`), '{"r":"u","t":"lixo de queda","at":null}\n'); // log à frente do resumo
  fs.appendFileSync(tfile(6), U('c'));
  s.sync(r); assert.deepEqual(s.read('ws_aaaaaaaa', R(6)).messages.map((m) => m.t), ['a', 'b', 'c']);
});

test('transcript que recomeça (menor que o já lido) refaz a cópia; limite por sessão marca truncated sem estourar', () => {
  const s = mk('h6'), r = rec(7); fs.writeFileSync(tfile(7), U('antigo 1') + A('antigo 2') + U('antigo 3')); s.sync(r);
  fs.writeFileSync(tfile(7), U('novo')); s.sync(r); assert.deepEqual(s.read('ws_aaaaaaaa', R(7)).messages.map((m) => m.t), ['novo']);
  const r2 = rec(8); const big = 'y'.repeat(15_000); let body = ''; for (let i = 0; i < 400; i++) body += U(big); fs.writeFileSync(tfile(8), body); // ~6 MB
  s.sync(r2); const d = s.read('ws_aaaaaaaa', R(8)); assert.equal(d.truncated, true); assert.ok(fs.statSync(path.join(tmp, 'h6', 'ws_aaaaaaaa', `${R(8)}.log`)).size <= C.MAX_LOG_BYTES);
});

test('retomada acrescenta à mesma conversa (mesmo registro); fork vira outra conversa do MESMO workspace', () => {
  const s = mk('h7'); fs.writeFileSync(tfile(9), U('p1') + A('r1')); s.sync(rec(9));
  fs.appendFileSync(tfile(9), U('p2') + A('r2')); s.sync(rec(9));
  fs.writeFileSync(tfile(10), U('p1') + A('r1') + U('p3')); s.sync(rec(10)); // fork: transcript novo, registro novo
  assert.deepEqual(s.read('ws_aaaaaaaa', R(9)).messages.map((m) => m.t), ['p1', 'r1', 'p2', 'r2']);
  assert.deepEqual(s.list('ws_aaaaaaaa').map((x) => x.id).sort(), [R(9), R(10)]);
});

test('rotas: lista, lê, apaga; 404 de workspace/conversa; 409 de sessão aberta; só do workspace da URL', async () => {
  const s = mk('h8'); fs.writeFileSync(tfile(11), U('olá') + A('oi')); s.sync(rec(11, 'ws_aaaaaaaa'));
  const db = { workspaces: [{ id: 'ws_aaaaaaaa' }, { id: 'ws_bbbbbbbb' }], terminalSessions: [{ id: R(11), state: 'running' }] };
  const app = express(); app.use('/api', apiGuard); app.use(express.json()); C.setupConversations(app, { db, conversations: s });
  const server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); const url = `http://127.0.0.1:${server.address().port}`;
  const call = (u, method = 'GET') => fetch(url + u, { method, headers: { origin: url } });
  try {
    assert.equal((await (await call('/api/workspaces/ws_aaaaaaaa/conversations')).json()).conversations.length, 1);
    assert.equal((await (await call('/api/workspaces/ws_bbbbbbbb/conversations')).json()).conversations.length, 0);
    assert.equal((await call('/api/workspaces/ws_nope/conversations')).status, 404);
    const one = await (await call(`/api/workspaces/ws_aaaaaaaa/conversations/${R(11)}?limit=1`)).json(); assert.equal(one.messages.length, 1); assert.equal(one.total, 2); assert.ok(!JSON.stringify(one).includes(uuid(11)), 'sem o UUID do Claude Code');
    assert.equal((await call(`/api/workspaces/ws_bbbbbbbb/conversations/${R(11)}`)).status, 404);
    assert.equal((await call('/api/workspaces/ws_aaaaaaaa/conversations/..%2Fx')).status, 404);
    assert.equal((await call(`/api/workspaces/ws_aaaaaaaa/conversations/${R(11)}`, 'DELETE')).status, 409);
    db.terminalSessions[0].state = 'exited';
    assert.equal((await call(`/api/workspaces/ws_bbbbbbbb/conversations/${R(11)}`, 'DELETE')).status, 404, 'não apaga a de outro workspace');
    assert.equal((await call(`/api/workspaces/ws_aaaaaaaa/conversations/${R(11)}`, 'DELETE')).status, 204);
    assert.equal((await call(`/api/workspaces/ws_aaaaaaaa/conversations/${R(11)}`)).status, 404);
    assert.equal((await fetch(`${url}/api/workspaces/ws_aaaaaaaa/conversations/${R(11)}`, { method: 'DELETE', headers: { origin: 'http://evil.example' } })).status, 403, 'Origin estranho é recusado');
  } finally { server.close(); server.closeAllConnections?.(); }
});

test('gancho de encerramento: o gerente de terminais copia a conversa quando a sessão termina (sem depender de processo vivo depois)', async () => {
  const s = mk('h9'); const dir = path.join(tmp, 'wsX'); fs.mkdirSync(dir);
  const db = { settings: { activeWorkspaceId: 'ws_aaaaaaaa' }, workspaces: [{ id: 'ws_aaaaaaaa', name: 'x', path: dir }], worktrees: [] };
  let p; const lib = { spawn() { p = { pid: 1_600_000_001, onData() {}, onExit(cb) { p.exitCb = cb; }, write() {}, resize() {} }; return p; } };
  const mgr = T.createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'x', args: [], viaShell: false }), killTree() {}, waitFor: () => true, newSessionId: () => uuid(20), mcp: null, track: () => ({ release() {} }), inspectConfig: async () => [], sweepMs: 0, usage: { read: () => null, has: () => true, forget() {} }, persist: () => {}, onEnd: (r) => s.sync(r) });
  const r = await mgr.create({ role: 'builder', workspaceId: 'ws_aaaaaaaa' }); assert.equal(r.ok, true, r.error);
  fs.writeFileSync(tfile(20), U('do terminal') + A('resposta'));
  p.exitCb({ exitCode: 0 });
  assert.deepEqual(s.read('ws_aaaaaaaa', db.terminalSessions[0].id).messages.map((m) => m.t), ['do terminal', 'resposta']);
  assert.equal(mgr.close(r.session.id).ok, true);
});

test('captura em segundo plano: sessões rodando são copiadas pelo temporizador e a varredura cobre as demais', async () => {
  const s = mk('h10'); fs.writeFileSync(tfile(30), U('viva')); fs.writeFileSync(tfile(31), U('interrompida'));
  const db = { workspaces: [{ id: 'ws_aaaaaaaa' }], terminalSessions: [rec(30, 'ws_aaaaaaaa', { state: 'running' }), rec(31, 'ws_aaaaaaaa', { state: 'interrupted' })] };
  let tick; const cap = C.startConversationCapture({ db, conversations: s, setTimer: (fn) => { tick = fn; return { unref() {} }; }, clearTimer() {} });
  tick(); assert.deepEqual(s.list('ws_aaaaaaaa').map((x) => x.id), [R(30)], 'o temporizador só copia as que estão rodando');
  await cap.sweep(); assert.deepEqual(s.list('ws_aaaaaaaa').map((x) => x.id).sort(), [R(30), R(31)]); cap.stop();
});
