// Maestro por MCP local: credencial por pane, permissões por papel, tarefas SEMPRE pendentes até o usuário aprovar (ou o modo autônomo, desligado por padrão e só pela rota do usuário),
// saneamento do que é escrito/lido nos terminais e as rotas HTTP (/mcp sem Origin, com Host local e token; /api/maestro com a checagem de Origin). Nenhum Claude real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-maestro-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporário */ } });
const { default: express } = await import('express');
const M = await import('../maestro.js');
const { apiGuard } = await import('../origin-guard.js');
const { createTerminalManager } = await import('../terminals.js');

const MA = 'term_aaaaaaaa', B1 = 'term_bbbbbbbb', B2 = 'term_cccccccc', RV = 'term_dddddddd';
/** Terminais simulados: registra o que foi escrito. */
function fakeTerms() {
  const panes = new Map([[MA, 'maestro'], [B1, 'builder'], [B2, 'builder'], [RV, 'reviewer']].map(([id, role]) => [id, { id, role, title: `${role}-${id.slice(5, 7)}`, status: 'running', usage: { total: 10 } }]));
  const written = [], out = new Map();
  return { panes, written, out, api: {
    get: (id) => panes.get(id) ?? null, list: () => [...panes.values()],
    write: (id, d) => { const p = panes.get(id); if (!p) return { ok: false, status: 404, error: 'Terminal não encontrado.' }; if (p.status !== 'running') return { ok: false, status: 409, error: 'O terminal já terminou.' }; written.push([id, d]); return { ok: true, status: 200 }; },
    readOutput: (id) => out.get(id) ?? '',
  } };
}
function world(over = {}) {
  const ft = fakeTerms(), timers = []; let clock = Date.parse('2026-11-03T12:00:00.000Z'); let n = 0;
  const dir = path.join(tmp, `mcp-${Math.random().toString(16).slice(2)}`);
  // uid injetado: task_ + 8 dígitos hexadecimais (formato real de store.uid)
  const m = M.createMaestro({ getTerminals: () => ft.api, mcpDir: dir, url: 'http://127.0.0.1:4999/mcp', now: () => new Date(clock).toISOString(), uid: (p) => `${p}_${String(++n).padStart(8, '0')}`, setTimer: (fn) => { timers.push(fn); return { unref() {} }; }, ...over });
  const as = (terminalId, role) => ({ terminalId, role });
  const call = (caller, name, args = {}) => m.rpc(caller, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).result;
  const text = (r) => r.content[0].text;
  return { ft, m, timers, dir, as, call, text, tick: (ms) => { clock += ms; } };
}
const tasksIn = (text) => JSON.parse(text.slice(text.indexOf('\n') + 1)); // list_tasks começa com o aviso de texto não confiável
const maestroOf = (w) => w.as(MA, 'maestro'), builderOf = (w, id = B1) => w.as(id, 'builder');

test('credencial por pane: token aleatório só em memória, arquivo de configuração com o Authorization, revogação apaga tudo; arquivos de boot anterior são removidos', () => {
  const pre = path.join(tmp, 'mcp-stale'); fs.mkdirSync(pre, { recursive: true }); fs.writeFileSync(path.join(pre, 'term_deadbeef.json'), '{}'); fs.writeFileSync(path.join(pre, 'outro.txt'), 'x');
  M.createMaestro({ getTerminals: () => ({}), mcpDir: pre, url: 'http://127.0.0.1:1/mcp' });
  assert.deepEqual(fs.readdirSync(pre), ['outro.txt'], 'só term_*.json antigos são removidos');
  const w = world(); const r = w.m.issue({ terminalId: MA, role: 'maestro' });
  const cfg = JSON.parse(fs.readFileSync(r.configPath, 'utf8')); const h = cfg.mcpServers.forge;
  assert.deepEqual([h.type, h.url], ['http', 'http://127.0.0.1:4999/mcp']); assert.match(h.headers.Authorization, /^Bearer [0-9a-f]{48}$/);
  assert.deepEqual(w.m.authenticate(h.headers.Authorization), { terminalId: MA, role: 'maestro' });
  const r2 = w.m.issue({ terminalId: B1, role: 'builder' }); assert.notEqual(JSON.parse(fs.readFileSync(r2.configPath, 'utf8')).mcpServers.forge.headers.Authorization, h.headers.Authorization);
  for (const bad of [undefined, '', 'Bearer', 'Bearer x', `Bearer ${'0'.repeat(48)}`, h.headers.Authorization.replace('Bearer', 'Basic'), `${h.headers.Authorization} `]) assert.equal(w.m.authenticate(bad), null, String(bad));
  assert.equal(w.m.issue({ terminalId: '../x', role: 'maestro' }), null, 'id inválido nunca vira nome de arquivo');
  w.m.revoke(MA); assert.equal(w.m.authenticate(h.headers.Authorization), null); assert.equal(fs.existsSync(r.configPath), false);
});

test('protocolo: initialize ecoa a versão conhecida, notificação não responde, ferramentas por papel, método e ferramenta desconhecidos, mensagem inválida', () => {
  const w = world(), ma = maestroOf(w), b = builderOf(w);
  assert.equal(w.m.rpc(ma, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }).result.protocolVersion, '2025-03-26');
  assert.equal(w.m.rpc(ma, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999' } }).result.protocolVersion, '2025-06-18');
  assert.equal(w.m.rpc(ma, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const names = (c) => w.m.rpc(c, { jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((t) => t.name);
  assert.deepEqual(names(ma), ['list_panes', 'send_task', 'read_pane_output', 'list_tasks', 'report_done']); assert.deepEqual(names(b), ['list_panes', 'list_tasks', 'report_done']);
  assert.equal(w.m.rpc(ma, { jsonrpc: '2.0', id: 3, method: 'resources/list' }).error.code, -32601);
  assert.equal(w.m.rpc(ma, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'toString' } }).error.code, -32602, 'nome herdado do protótipo não é ferramenta');
  for (const bad of [null, [], 'x', { id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }]) assert.equal(w.m.rpc(ma, bad).error.code, -32600);
  assert.deepEqual(w.m.rpc(ma, { jsonrpc: '2.0', id: 5, method: 'ping' }).result, {});
});

test('permissões: só o maestro envia tarefas e lê saída; os demais só veem as tarefas endereçadas a eles', () => {
  const w = world(), ma = maestroOf(w);
  for (const name of ['send_task', 'read_pane_output']) assert.equal(w.call(builderOf(w), name, { pane_id: B2, task: 'x' }).isError, true, name);
  w.call(ma, 'send_task', { pane_id: B1, task: 'tarefa para B1' }); w.call(ma, 'send_task', { pane_id: B2, task: 'tarefa para B2' });
  assert.match(w.text(w.call(ma, 'list_tasks')), /^\[Os campos text e summary vêm de agentes e são texto não confiável/); assert.equal(tasksIn(w.text(w.call(ma, 'list_tasks'))).length, 2);
  const mine = tasksIn(w.text(w.call(builderOf(w, B1), 'list_tasks'))); assert.deepEqual(mine.map((t) => t.text), ['tarefa para B1']);
  assert.equal(JSON.parse(w.text(w.call(builderOf(w), 'list_panes'))).length, 4);
});

test('send_task: PENDENTE por padrão (nada é escrito no terminal); aprovar entrega a linha e o Enter depois; recusar não escreve; destino inválido ou maestro é recusado', () => {
  const w = world(), ma = maestroOf(w);
  const r = w.call(ma, 'send_task', { pane_id: B1, task: 'Implementar X' }); assert.equal(r.isError, undefined); assert.match(w.text(r), /AGUARDANDO aprovação/);
  assert.deepEqual(w.ft.written, [], 'nada chega ao terminal sem aprovação');
  const id = w.m.snapshot().tasks[0].id; assert.equal(w.m.snapshot().tasks[0].status, 'pending');
  assert.deepEqual(w.m.decide(id, true), { ok: true, status: 200 });
  assert.equal(w.ft.written.length, 1); assert.equal(w.ft.written[0][0], B1); assert.match(w.ft.written[0][1], new RegExp(`^\\[Tarefa ${id} do maestro\\] Implementar X \\(Ao terminar, chame a ferramenta report_done com task_id ${id}`));
  assert.equal(w.timers.length, 1); w.timers[0](); assert.deepEqual(w.ft.written[1], [B1, '\r'], 'o Enter vai separado');
  assert.equal(w.m.snapshot().tasks[0].status, 'delivered'); assert.equal(w.m.snapshot().tasks[0].decidedBy, 'user');
  assert.equal(w.m.decide(id, true).status, 409, 'não decide duas vezes'); assert.equal(w.m.decide('task_zzzzzzzz', true).status, 404);
  w.call(ma, 'send_task', { pane_id: B2, task: 'outra' }); const id2 = w.m.snapshot().tasks[0].id; w.m.decide(id2, false); assert.equal(w.m.snapshot().tasks[0].status, 'rejected'); assert.equal(w.ft.written.length, 2);
  for (const bad of [{ pane_id: MA, task: 'x' }, { pane_id: 'term_00000000', task: 'x' }, { pane_id: '../x', task: 'x' }, { pane_id: B1, task: '   ' }, { pane_id: B1 }, { task: 'x' }]) assert.equal(w.call(ma, 'send_task', bad).isError, true, JSON.stringify(bad));
  w.ft.panes.get(RV).status = 'exited'; assert.equal(w.call(ma, 'send_task', { pane_id: RV, task: 'x' }).isError, true);
});

test('saneamento: o texto vira UMA linha sem controles nem ESC e com tamanho limitado (um agente não digita teclas especiais no terminal de outro)', () => {
  const w = world(), ma = maestroOf(w);
  w.call(ma, 'send_task', { pane_id: B1, task: 'a\r\nb\x1b[31mvermelho\x1b[0m\x03\x00\u2028c  \t d' });
  assert.equal(w.m.snapshot().tasks[0].text, 'a b vermelho c d');
  w.call(ma, 'send_task', { pane_id: B1, task: 'x'.repeat(M.MAX_TASK_TEXT + 500) }); assert.equal(w.m.snapshot().tasks[0].text.length, M.MAX_TASK_TEXT);
  w.m.decide(w.m.snapshot().tasks[0].id, true); const line = w.ft.written.at(-1)[1]; assert.ok(!/[\u0000-\u001f\u007f]/.test(line), 'a linha entregue não tem controles'); // eslint-disable-line no-control-regex
  assert.equal(M.cleanLine('\x1b]0;título\x07oi', 50), 'oi', 'sequência OSC removida');
});

test('limites: no máximo 20 pendentes; pendente expira em 10 min; pendente cujo destino acabou falha', () => {
  const w = world(), ma = maestroOf(w);
  for (let i = 0; i < M.MAX_PENDING; i++) assert.equal(w.call(ma, 'send_task', { pane_id: B1, task: `t${i}` }).isError, undefined);
  assert.match(w.text(w.call(ma, 'send_task', { pane_id: B1, task: 'a mais' })), /20 tarefas esperando/);
  w.tick(M.PENDING_TTL_MS + 1000); assert.ok(w.m.snapshot().tasks.every((t) => t.status === 'expired')); assert.equal(w.m.decide(w.m.snapshot().tasks[0].id, true).status, 409);
  w.call(ma, 'send_task', { pane_id: B2, task: 'vai falhar' }); w.ft.panes.get(B2).status = 'exited'; assert.equal(w.m.snapshot().tasks[0].status, 'failed');
});

test('maestro autônomo: desligado por padrão; ligado só pelo usuário entrega na hora (decidedBy auto) e respeita o limite por minuto; ligar não entrega o que já estava pendente', () => {
  const w = world({ autoPerMinute: 2 }), ma = maestroOf(w); assert.equal(w.m.isAutonomous(), false);
  w.call(ma, 'send_task', { pane_id: B1, task: 'antes de ligar' }); assert.equal(w.ft.written.length, 0);
  assert.equal(w.m.setAutonomous(true).autonomous, true); assert.equal(w.ft.written.length, 0, 'ligar não libera pendentes antigas');
  assert.match(w.text(w.call(ma, 'send_task', { pane_id: B1, task: 'um' })), /entregue/); assert.match(w.text(w.call(ma, 'send_task', { pane_id: B2, task: 'dois' })), /entregue/);
  assert.equal(w.ft.written.length, 2); assert.equal(w.m.snapshot().tasks.find((t) => t.text === 'um').decidedBy, 'auto');
  assert.match(w.text(w.call(ma, 'send_task', { pane_id: B1, task: 'três' })), /AGUARDANDO/); const t3 = w.m.snapshot().tasks.find((t) => t.text === 'três'); assert.equal(t3.status, 'pending'); assert.match(t3.note, /Limite de 2/);
  assert.equal(w.ft.written.length, 2, 'acima do limite volta para o usuário');
  assert.equal(w.m.setAutonomous('true').autonomous, false, 'só o booleano verdadeiro liga');
  const tools = w.m.rpc(ma, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools.map((t) => t.name); assert.ok(!tools.some((n) => /auton/i.test(n)), 'nenhuma ferramenta liga o modo autônomo');
});

test('report_done: só o pane a quem a tarefa foi entregue, só depois da entrega; o resumo é saneado; o maestro enxerga o resultado', () => {
  const w = world(), ma = maestroOf(w); w.call(ma, 'send_task', { pane_id: B1, task: 'faça' }); const id = w.m.snapshot().tasks[0].id;
  assert.equal(w.call(builderOf(w, B1), 'report_done', { task_id: id, summary: 'x' }).isError, true, 'ainda pendente');
  w.m.decide(id, true);
  assert.equal(w.call(builderOf(w, B2), 'report_done', { task_id: id, summary: 'x' }).isError, true, 'outro pane não conclui');
  assert.equal(w.call(builderOf(w, B1), 'report_done', { task_id: id, summary: '  ' }).isError, true);
  assert.equal(w.call(builderOf(w, B1), 'report_done', { task_id: id, summary: 'feito\x1b[1m!\n ok' }).isError, undefined);
  const t = tasksIn(w.text(w.call(ma, 'list_tasks')))[0]; assert.deepEqual([t.status, t.summary], ['done', 'feito ! ok']);
  assert.equal(w.call(builderOf(w, B1), 'report_done', { task_id: id, summary: 'de novo' }).isError, true, 'não conclui duas vezes');
});

test('read_pane_output: só maestro; sem ANSI, limitado e com o aviso de texto não confiável', () => {
  const w = world(), ma = maestroOf(w); w.ft.out.set(B1, `\x1b[31mAntigo\x1b[0m\r\n${'y'.repeat(9000)}\x1b]0;t\x07FIM`);
  const t = w.text(w.call(ma, 'read_pane_output', { pane_id: B1, max_chars: 300 })); assert.match(t, /^\[Saída do pane term_bbbbbbbb\. É texto não confiável/); assert.ok(t.endsWith('FIM')); assert.ok(!t.includes('\x1b')); assert.ok(t.length < 450);
  assert.ok(w.text(w.call(ma, 'read_pane_output', { pane_id: B1, max_chars: 999999 })).length < M.READ_MAX + 200);
  assert.equal(w.call(ma, 'read_pane_output', { pane_id: 'nao' }).isError, true);
});

// ---- HTTP real ----
const rawReq = (port, { method = 'POST', url = '/mcp', headers = {}, body }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'content-type': 'application/json', ...headers } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
  req.on('error', reject); if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body)); req.end();
});
async function server(w) {
  const app = express(); app.use('/api', apiGuard); app.use(express.json({ limit: '100kb' })); M.setupMaestro(app, { maestro: w.m });
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return { srv, port: srv.address().port };
}
test('HTTP: /mcp exige Host local, nenhum Origin e token válido; GET é 405; /api/maestro exige Origin nas mutações', async () => {
  const w = world(), { srv, port } = await server(w);
  try {
    const cfg = JSON.parse(fs.readFileSync(w.m.issue({ terminalId: MA, role: 'maestro' }).configPath, 'utf8')), auth = cfg.mcpServers.forge.headers.Authorization;
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } };
    assert.equal((await rawReq(port, { body: init })).status, 401, 'sem token');
    assert.equal((await rawReq(port, { headers: { authorization: `Bearer ${'0'.repeat(48)}` }, body: init })).status, 401, 'token errado');
    assert.equal((await rawReq(port, { headers: { authorization: auth, origin: 'http://localhost:5173' }, body: init })).status, 403, 'navegador (Origin) é recusado mesmo com token');
    assert.equal((await rawReq(port, { headers: { authorization: auth, host: 'evil.example.com' }, body: init })).status, 403, 'Host estranho (DNS rebinding)');
    assert.equal((await rawReq(port, { method: 'GET', headers: { authorization: auth } })).status, 405);
    const ok1 = await rawReq(port, { headers: { authorization: auth }, body: init }); assert.equal(ok1.status, 200); assert.equal(ok1.body.result.serverInfo.name, 'forge');
    assert.equal((await rawReq(port, { headers: { authorization: auth }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
    const lp = await rawReq(port, { headers: { authorization: auth }, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_panes', arguments: {} } } }); assert.equal(JSON.parse(lp.body.result.content[0].text).length, 4);
    // API do usuário: GET livre (Host local); POST sem Origin = 403; com Origin local funciona
    assert.equal((await rawReq(port, { method: 'GET', url: '/api/maestro' })).body.autonomous, false);
    assert.equal((await rawReq(port, { url: '/api/maestro/autonomy', body: { enabled: true } })).status, 403);
    assert.equal(w.m.isAutonomous(), false, 'sem Origin nada muda');
    const origin = `http://127.0.0.1:${port}`;
    assert.equal((await rawReq(port, { url: '/api/maestro/autonomy', headers: { origin }, body: { enabled: 'sim' } })).status, 400);
    assert.equal((await rawReq(port, { url: '/api/maestro/autonomy', headers: { origin }, body: { enabled: true } })).body.autonomous, true);
    w.m.setAutonomous(false); w.call(w.as(MA, 'maestro'), 'send_task', { pane_id: B1, task: 'via http' }); const tid = w.m.snapshot().tasks[0].id;
    const ap = await rawReq(port, { url: `/api/maestro/tasks/${tid}/approve`, headers: { origin }, body: {} }); assert.equal(ap.status, 200); assert.equal(ap.body.tasks[0].status, 'delivered');
    assert.equal((await rawReq(port, { url: `/api/maestro/tasks/${tid}/approve`, headers: { origin }, body: {} })).status, 409);
    w.m.revoke(MA); assert.equal((await rawReq(port, { headers: { authorization: auth }, body: init })).status, 401, 'revogado');
  } finally { srv.close(); }
});

test('integração com os terminais: o spawn leva --mcp-config e --allowedTools, e a credencial é revogada quando o terminal acaba, é encerrado ou não nasce', async () => {
  const issued = [], revoked = [];
  const mcp = { serverName: 'orchestrator', issue: ({ terminalId, role }) => { issued.push([terminalId, role]); return { configPath: `C:/x/${terminalId}.json` }; }, revoke: (id) => revoked.push(id) };
  const ws = path.join(tmp, 'ws'); fs.mkdirSync(ws, { recursive: true }); const db = { settings: { activeWorkspaceId: 'w' }, workspaces: [{ id: 'w', name: 'w', path: ws }] };
  const spawned = []; const lib = { spawn(f, a) { const p = { pid: 1_900_200_000 + spawned.length, args: a, onData(cb) { p.d = cb; }, onExit(cb) { p.e = cb; }, write() {}, resize() {} }; spawned.push(p); return p; } };
  const mk = (over = {}) => createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'x', args: [], viaShell: false }), killTree() {}, waitFor: () => true, mcp, ...over });
  const mgr = mk(); const a = await mgr.create({ role: 'maestro' }), b = await mgr.create({ role: 'builder' });
  assert.deepEqual(issued.map((x) => x[1]), ['maestro', 'builder']);
  const args = spawned[0].args; const i = args.indexOf('--mcp-config'); assert.equal(args[i + 1], `C:/x/${a.session.id}.json`); assert.deepEqual(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2), ['--allowedTools', 'mcp__orchestrator']);
  spawned[1].e({ exitCode: 0 }); assert.deepEqual(revoked, [b.session.id], 'fim do processo revoga');
  mgr.close(a.session.id); assert.deepEqual(revoked, [b.session.id, a.session.id], 'encerrar revoga');
  revoked.length = 0; const bad = mk({ ptyLib: { spawn() { throw new Error('boom'); } } }); const r = await bad.create({ role: 'builder' }); assert.equal(r.status, 500); assert.equal(revoked.length, 1, 'spawn que falha revoga');
  const bad2 = mk({ mcp: { issue() { throw new Error('disco cheio'); } } }); assert.equal((await bad2.create({})).status, 500);
  assert.equal(mgr.readOutput('term_00000000', 10), '', 'terminal inexistente: vazio');
});

// ---------- achados das revisões (código e segurança) ----------
test('saneamento Unicode: bidi, largura zero, soft hyphen, BOM e caracteres Tag são removidos do texto e da saída lida; quebras de linha da saída são mantidas', () => {
  const hidden = [0x202e, 0x2066, 0x200b, 0x00ad, 0xfeff, 0x061c, 0xE0041, 0xE0001].map((c) => String.fromCodePoint(c)).join('');
  assert.equal(M.cleanLine(`ab${hidden}cd`, 50), 'ab cd');
  const w = world(), ma = maestroOf(w);
  w.call(ma, 'send_task', { pane_id: B1, task: `faça${hidden}isto` }); assert.ok(!/\p{Cf}/u.test(w.m.snapshot().tasks[0].text));
  w.ft.out.set(B1, `linha1\nli${hidden}nha2\r\n\tfim`); const t = w.text(w.call(ma, 'read_pane_output', { pane_id: B1 }));
  assert.ok(t.endsWith('linha1\nlinha2\n\tfim'), JSON.stringify(t.slice(-40)));
});

test('entrega serializada por pane: duas tarefas ao mesmo terminal não se colam; aprovar durante a entrega dá 409 e vale depois do Enter; no modo autônomo a segunda espera o usuário', () => {
  const w = world(), ma = maestroOf(w);
  w.call(ma, 'send_task', { pane_id: B1, task: 'A' }); w.call(ma, 'send_task', { pane_id: B1, task: 'B' }); const [idB, idA] = w.m.snapshot().tasks.map((t) => t.id);
  assert.equal(w.m.decide(idA, true).ok, true); const r = w.m.decide(idB, true); assert.equal(r.status, 409); assert.match(r.error, /outra tarefa/);
  assert.equal(w.m.snapshot().tasks.find((t) => t.id === idB).status, 'pending', 'continua pendente, nada foi escrito');
  assert.equal(w.ft.written.filter((x) => x[0] === B1).length, 1); w.timers[0](); assert.equal(w.m.decide(idB, true).ok, true); assert.equal(w.ft.written.filter((x) => x[0] === B1 && x[1] !== '\r').length, 2);
  const w2 = world(), m2 = maestroOf(w2); w2.m.setAutonomous(true);
  assert.match(w2.text(w2.call(m2, 'send_task', { pane_id: B1, task: 'um' })), /entregue/); assert.match(w2.text(w2.call(m2, 'send_task', { pane_id: B1, task: 'dois' })), /AGUARDANDO/);
  const t2 = w2.m.snapshot().tasks.find((t) => t.text === 'dois'); assert.equal(t2.status, 'pending'); assert.match(t2.note, /outra tarefa/);
});

test('falhas: escrita que falha marca a tarefa como falha (usuário: 409; autônomo: erro ao maestro); tarefa entregue cujo terminal acabou vira falha; lote JSON-RPC e max_chars inválido', () => {
  const w = world(), ma = maestroOf(w); const realWrite = w.ft.api.write;
  w.call(ma, 'send_task', { pane_id: B1, task: 'x' }); const id = w.m.snapshot().tasks[0].id; w.ft.api.write = () => ({ ok: false, status: 409, error: 'O terminal não aceitou a entrada.' });
  const r = w.m.decide(id, true); assert.equal(r.status, 409); assert.equal(w.m.snapshot().tasks[0].status, 'failed'); w.m.setAutonomous(true);
  assert.equal(w.call(ma, 'send_task', { pane_id: B2, task: 'y' }).isError, true); w.ft.api.write = realWrite; w.m.setAutonomous(false);
  w.call(ma, 'send_task', { pane_id: RV, task: 'z' }); const idz = w.m.snapshot().tasks[0].id; w.m.decide(idz, true); assert.equal(w.m.snapshot().tasks[0].status, 'delivered');
  w.ft.panes.get(RV).status = 'exited'; assert.equal(w.m.snapshot().tasks[0].status, 'failed'); assert.match(w.m.snapshot().tasks[0].note, /acabou antes de concluir/);
  assert.equal(w.m.rpc(ma, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]).error.code, -32600, 'lote não é suportado');
  w.ft.out.set(B1, 'saida'); assert.match(w.text(w.call(ma, 'read_pane_output', { pane_id: B1, max_chars: 'muito' })), /^\[Saída do pane/, 'max_chars inválido usa o padrão');
});

test('histórico limitado: tarefas encerradas antigas saem de MAX_TASKS; pendentes e entregues são preservadas', () => {
  const w = world(), ma = maestroOf(w);
  for (let i = 0; i < M.MAX_TASKS + 30; i++) { w.call(ma, 'send_task', { pane_id: B1, task: `t${i}` }); w.m.decide(w.m.snapshot().tasks[0].id, false); }
  assert.equal(w.m.snapshot().tasks.length, 50, 'a tela mostra as 50 mais recentes'); assert.equal(w.m.snapshot().tasks[0].text, `t${M.MAX_TASKS + 29}`);
});

test('pasta das credenciais: restrictDir usa icacls no Windows (sem herança, só o usuário); a falha não derruba; o nome do servidor é configurável', () => {
  const calls = []; assert.equal(M.restrictDir('C:/x/mcp', { platform: 'win32', user: 'caetano', run: (...a) => calls.push(a) }), true);
  assert.deepEqual(calls[0].slice(0, 2), ['icacls', ['C:/x/mcp', '/inheritance:r', '/grant:r', 'caetano:(OI)(CI)F']]);
  assert.equal(M.restrictDir('C:/x/mcp', { platform: 'win32', user: 'u', run: () => { throw new Error('negado'); } }), false, 'falha de ACL é só um aviso');
  const locked = []; const w = world({ lockDir: (d) => locked.push(d), serverName: 'orchestrator_ab12cd' });
  w.m.issue({ terminalId: MA, role: 'maestro' }); w.m.issue({ terminalId: B1, role: 'builder' }); assert.equal(locked.length, 1, 'a pasta é restringida uma vez');
  assert.equal(w.m.serverName, 'orchestrator_ab12cd'); assert.ok(JSON.parse(fs.readFileSync(path.join(w.dir, `${MA}.json`), 'utf8')).mcpServers.orchestrator_ab12cd);
});

test('terminais: o limite vale para criações simultâneas (isolate); wrapper cmd com metacaractere no caminho abre sem a coordenação; peek é leve', async () => {
  const ws = path.join(tmp, 'ws2'); fs.mkdirSync(ws, { recursive: true }); const db = { settings: { activeWorkspaceId: 'w' }, workspaces: [{ id: 'w', name: 'w', path: ws }] };
  let n = 0; const lib = { spawn(f, a) { return { pid: 1_900_300_000 + (++n), args: a, onData() {}, onExit() {}, write() {}, resize() {} }; } };
  const slow = { create: async () => { await new Promise((r) => setTimeout(r, 40)); return { ok: true, record: { id: 'wt_aaaaaaaa', path: ws } }; } };
  const mk = (over = {}) => createTerminalManager({ db, ptyLib: lib, resolveCommand: () => ({ file: 'x', args: [], viaShell: false }), killTree() {}, waitFor: () => true, maxSessions: 2, ...over });
  const m = mk({ worktrees: slow }); const rs = await Promise.all([1, 2, 3, 4].map(() => m.create({ isolate: true })));
  assert.deepEqual(rs.map((r) => r.ok), [true, true, false, false]); assert.equal(m.count(), 2); assert.equal(new Set(m.list().map((s) => s.title)).size, 2, 'títulos distintos');
  const revoked = []; const mcp = { serverName: 'orchestrator', issue: () => ({ configPath: 'C:/a&b/x.json' }), revoke: (id) => revoked.push(id) };
  const spawned = []; const lib2 = { spawn(f, a) { spawned.push(a); return { pid: 1_900_400_000 + spawned.length, onData() {}, onExit() {}, write() {}, resize() {} }; } };
  const sh = createTerminalManager({ db, ptyLib: lib2, resolveCommand: () => ({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'claude.cmd'], viaShell: true }), killTree() {}, waitFor: () => true, mcp });
  const r = await sh.create({}); assert.equal(r.ok, true); assert.ok(!spawned[0].includes('--mcp-config'), 'sem coordenação via cmd.exe com caminho perigoso'); assert.equal(revoked.length, 1);
  assert.deepEqual(Object.keys(sh.peek(r.session.id)).sort(), ['id', 'lastOutputAt', 'role', 'status', 'title']); assert.equal(sh.peek('term_00000000'), null);
});
