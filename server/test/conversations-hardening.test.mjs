// Etapa 7, correções da revisão independente: apagar durável, offsets em bytes, limite de tamanho, redação, symlink, limpeza por workspace, corrida de criação e topicId.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-convh-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const C = await import('../conversations.js');
const T = await import('../terminals.js');
const S = await import('../store.js');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R = (n) => `ses_${String(n).padStart(8, '0')}`;
const cfg = path.join(tmp, 'claude'), proj = path.join(cfg, 'projects', 'C--x'); fs.mkdirSync(proj, { recursive: true });
const tfile = (n) => path.join(proj, `${uuid(n)}.jsonl`);
let seq = 0;
const line = (o) => `${JSON.stringify({ uuid: `u${++seq}`, timestamp: '2026-11-05T10:00:00.000Z', ...o })}\n`;
const U = (t) => line({ type: 'user', message: { role: 'user', content: t } });
const A = (t) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const mk = (name) => C.createConversationStore({ dir: path.join(tmp, name), configDir: cfg });
const WS = 'ws_aaaaaaaa';
const rec = (n, over = {}) => ({ id: R(n), workspaceId: WS, claudeSessionId: uuid(n), title: `S${n}`, role: 'builder', ...over });
const msgs = (s, n) => s.read(WS, R(n))?.messages.map((m) => m.t);

test('apagar é durável: nem a varredura nem uma nova captura trazem de volta o que já existia; o que for escrito depois entra', async () => {
  const s = mk('d1'); fs.writeFileSync(tfile(1), U('segredo antigo') + A('resposta antiga')); s.sync(rec(1));
  assert.equal(s.remove(WS, R(1)), true); assert.deepEqual(s.list(WS), []);
  const db = { workspaces: [{ id: WS }], terminalSessions: [rec(1, { state: 'exited' })] };
  const cap = C.startConversationCapture({ db, conversations: s, setTimer: () => ({ unref() {} }), clearTimer() {} }); await cap.sweep(); cap.stop();
  assert.deepEqual(s.list(WS), [], 'a varredura do boot não recria a conversa apagada');
  s.sync(rec(1)); assert.deepEqual(s.list(WS), [], 'nem a captura seguinte');
  fs.appendFileSync(tfile(1), U('depois de apagar') + A('resposta nova')); s.sync(rec(1)); // sessão retomada depois
  assert.deepEqual(msgs(s, 1), ['depois de apagar', 'resposta nova'], 'só o novo');
});

test('apagar: se a marca não puder ser gravada, nada é apagado e o erro chega à rota', () => {
  const s = mk('d2'); fs.writeFileSync(tfile(2), U('a') + A('b')); s.sync(rec(2));
  fs.mkdirSync(path.join(tmp, 'd2', WS, `${R(2)}.del`)); // a marca não pode ser criada (já existe um diretório com esse nome)
  assert.throws(() => s.remove(WS, R(2))); assert.deepEqual(msgs(s, 2), ['a', 'b'], 'a conversa continua lá');
});

test('offset em bytes: UTF-8 inválido no transcript não desloca a leitura seguinte; acentos e emoji passam inteiros', () => {
  const s = mk('b1'); const bad = Buffer.concat([Buffer.from(U('ola ')).subarray(0, -3), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]); // linha com bytes inválidos (JSON quebrado: ignorada)
  fs.writeFileSync(tfile(3), Buffer.concat([Buffer.from(U('ação 🚀 ok')), bad, Buffer.from(A('resposta ✓'))]));
  s.sync(rec(3)); fs.appendFileSync(tfile(3), U('depois')); const r = s.sync(rec(3));
  assert.equal(r.added, 1, 'a linha acrescentada depois dos bytes inválidos é copiada'); assert.deepEqual(msgs(s, 3), ['ação 🚀 ok', 'resposta ✓', 'depois']);
});

test('read corta em bytes: linha de log ainda não confirmada (queda) não aparece, mesmo com acentos', () => {
  const s = mk('b2'); fs.writeFileSync(tfile(4), U('canção') + A('é')); s.sync(rec(4));
  fs.appendFileSync(path.join(tmp, 'b2', WS, `${R(4)}.log`), '{"r":"u","t":"não confirmada","at":null}\n');
  assert.deepEqual(msgs(s, 4), ['canção', 'é']);
});

test('limite de tamanho: depois de cheio a cópia para (sem lacunas no meio), não reparseia o resto e marca truncated', () => {
  const s = mk('t1'); const big = 'y'.repeat(15_000); let body = ''; for (let i = 0; i < 400; i++) body += U(big);
  body += U('pequena depois do limite'); fs.writeFileSync(tfile(5), body); s.sync(rec(5));
  const d = s.read(WS, R(5), { limit: 200 }); assert.equal(d.truncated, true); assert.ok(!msgs(s, 5).includes('pequena depois do limite'), 'nada depois do limite entra (sem lacuna)');
  const before = s.read(WS, R(5)).total; fs.appendFileSync(tfile(5), U('mais uma')); assert.equal(s.sync(rec(5)).added, 0); assert.equal(s.read(WS, R(5)).total, before);
});

test('sem novidade não regrava o resumo; a conversa vazia não aparece na lista', () => {
  const s = mk('w1'); fs.writeFileSync(tfile(6), U('a') + A('b')); s.sync(rec(6));
  const f = path.join(tmp, 'w1', WS, `${R(6)}.json`), t0 = fs.statSync(f).mtimeMs, body0 = fs.readFileSync(f, 'utf8');
  for (let i = 0; i < 3; i++) s.sync(rec(6)); assert.equal(fs.readFileSync(f, 'utf8'), body0, 'resumo idêntico: não regravado');
  assert.equal(fs.statSync(f).mtimeMs, t0);
  fs.writeFileSync(tfile(7), line({ type: 'ai-title', aiTitle: 'só título' })); s.sync(rec(7)); assert.deepEqual(s.list(WS).map((x) => x.id), [R(6)], 'sem mensagens: fora da lista');
});

test('redação: chaves comuns, JWT, senha em URL e atribuições; título gerado e timestamp enorme não escapam', () => {
  const r = C.redact;
  for (const t of ['sk-proj-abcdefghijklmnopqrstuvwx', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz', 'xoxb-1234567890-abcdefghij', `AIza${'a'.repeat(35)}`, `npm_${'a'.repeat(36)}`, 'sk_live_abcdefghijklmnop', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'ghp_' + 'a'.repeat(36)]) assert.equal(r(`x ${t} y`), 'x [segredo omitido] y', t);
  assert.equal(r('postgres://admin:hunter22pass@host/db'), 'postgres://admin:[segredo omitido]@host/db');
  assert.match(r('DB_PASSWORD=supersecret123 e api_key: "abcdefgh12345"'), /^DB_PASSWORD=\[segredo omitido\] e api_key: "\[segredo omitido\]"$/);
  assert.equal(r('texto normal sem segredo, token curto: abc'), 'texto normal sem segredo, token curto: abc');
  const s = mk('r1'); fs.writeFileSync(tfile(8), line({ type: 'ai-title', aiTitle: 'usar sk-ant-api03-ABCDEFGHIJKLMNOPQRST' }) + line({ type: 'user', timestamp: 'x'.repeat(5000), message: { content: 'oi' } }));
  s.sync(rec(8)); const c = s.list(WS)[0]; assert.equal(c.aiTitle, 'usar [segredo omitido]'); assert.ok((c.lastAt ?? '').length <= 40 && (s.read(WS, R(8)).messages[0].at ?? null) === null);
  const huge = C.messageOf({ type: 'user', message: { content: 'z'.repeat(2_000_000) } }); assert.ok(huge.t.length < C.MAX_MSG_CHARS + 20);
});

test('symlink no lugar do transcript é ignorado', (t) => {
  const s = mk('l1'); const real = path.join(tmp, 'outro.jsonl'); fs.writeFileSync(real, U('de outro arquivo') + A('x'));
  try { fs.symlinkSync(real, tfile(9)); } catch (e) { t.skip(`sem permissão para criar symlink (${e.code})`); return; }
  assert.deepEqual(s.sync(rec(9)), { ok: false, reason: 'sem_transcricao' }); assert.deepEqual(s.list(WS), []);
});

test('workspace removido leva a pasta das conversas; a captura ignora registros de workspace que não existe mais', async () => {
  const s = mk('x1'); fs.writeFileSync(tfile(10), U('a') + A('b')); s.sync(rec(10)); assert.equal(s.list(WS).length, 1);
  assert.equal(s.removeWorkspace(WS), true); assert.deepEqual(s.list(WS), []); assert.ok(!fs.existsSync(path.join(tmp, 'x1', WS)));
  const db = { workspaces: [], terminalSessions: [rec(10, { state: 'running' })] };
  let tick; const cap = C.startConversationCapture({ db, conversations: s, setTimer: (fn) => { tick = fn; return { unref() {} }; }, clearTimer() {} });
  tick(); await cap.sweep(); cap.stop(); assert.ok(!fs.existsSync(path.join(tmp, 'x1', WS)), 'não recria a pasta');
  assert.equal(s.removeWorkspace('../fora'), false);
});

test('criação x remoção: workspace removido durante a preparação do terminal NÃO gera terminal nem registro', async () => {
  const dir = path.join(tmp, 'wsr'); fs.mkdirSync(dir);
  const db = { settings: { activeWorkspaceId: WS }, workspaces: [{ id: WS, name: 'x', path: dir }], worktrees: [] };
  let spawned = 0; const lib = { spawn() { spawned++; return { pid: 1_500_000_001, onData() {}, onExit() {}, write() {}, resize() {} }; } };
  const mgr = T.createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'x', args: [], viaShell: false }), killTree() {}, waitFor: () => true, newSessionId: () => uuid(40), mcp: null, track: () => ({ release() {} }), sweepMs: 0, usage: { read: () => null, has: () => true, forget() {} }, persist: () => {},
    inspectConfig: async () => { await new Promise((r) => setImmediate(r)); db.workspaces = []; return []; } });
  const r = await mgr.create({ role: 'builder', workspaceId: WS });
  assert.equal(r.ok, false); assert.equal(r.code, 'workspace_not_found'); assert.equal(spawned, 0); assert.equal(db.terminalSessions, undefined);
});

test('banco: topicId inválido num registro não derruba a sessão (vira null); formato válido é mantido', () => {
  const base = { claudeSessionId: uuid(1), terminalId: 'term_x', workspaceId: WS, cwd: '/x', role: 'builder', title: 't', state: 'exited' };
  const d = { terminalSessions: [{ ...base, id: R(1), topicId: 'lixo' }, { ...base, id: R(2), topicId: 'top_0123abcd' }, { ...base, id: R(3), topicId: 42 }] };
  assert.equal(S.sanitizeTerminalSessions(d), 0); assert.deepEqual(d.terminalSessions.map((r) => r.topicId), [null, 'top_0123abcd', null]);
});
