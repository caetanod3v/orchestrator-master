// Integração da navegação por workspaces/tópicos com terminais: servidor REAL (server/index.js) como processo filho, porta livre, ORCH_DATA_DIR temporário,
// 2 workspaces temporários (git init) e um "claude" FALSO no PATH (nenhum Claude real; a 4317 e data/ nunca são tocadas). Tudo pelo HTTP, com Origin válido.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-navint-')));
const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
const cfgDir = path.join(root, 'claude-cfg'); fs.mkdirSync(path.join(cfgDir, 'projects', 'p'), { recursive: true });
const binDir = path.join(root, 'bin'); fs.mkdirSync(binDir);
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const DB_FILE = path.join(dataDir, 'db.json');

// claude falso: fica vivo até ser encerrado (um PTY nunca fecha o stdin); ignora todos os argumentos.
fs.writeFileSync(path.join(binDir, 'keep.mjs'), 'setInterval(() => {}, 1000);\n');
fs.writeFileSync(path.join(binDir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${path.join(binDir, 'keep.mjs')}"\r\n`);

const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=teste', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const mkWs = (name) => { const d = path.join(root, name); fs.mkdirSync(d); G(d, 'init', '-q'); fs.writeFileSync(path.join(d, 'a.txt'), 'x\n'); G(d, 'add', '.'); G(d, 'commit', '-q', '-m', 'init'); return d; };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc = null, origin = null, out = '', exited = null;
async function boot() {
  const port = await freePort(); origin = `http://127.0.0.1:${port}`; out = '';
  const env = { ...process.env, PORT: String(port), ORCH_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: cfgDir, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}` };
  delete env.CLAUDE_CODE_CHILD_SESSION;
  proc = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', (c) => { out += c; }); proc.stderr.on('data', (c) => { out += c; });
  const p = proc; exited = new Promise((r) => p.on('exit', r));
  for (let i = 0; i < 150 && !/AI Dev Orchestrator API em/.test(out); i++) await Promise.race([sleep(100), exited]);
  assert.match(out, /AI Dev Orchestrator API em/, out);
}
// Encerra o filho: fecha antes os terminais (processos do claude falso) para não deixar nada vivo.
async function stop() {
  if (!proc) return;
  try { const l = await (await api('/api/terminals')).json(); for (const s of l.sessions) if (s.status === 'running') await api(`/api/terminals/${s.id}/close`, 'POST'); } catch { /* servidor já caiu */ }
  await sleep(700); // deixa o disco ser gravado
  proc.kill(); await exited; proc = null; await sleep(400);
}
const api = (u, m = 'GET', b, headers = {}) => fetch(`${origin}${u}`, { method: m, headers: { 'content-type': 'application/json', origin, ...headers }, body: b === undefined ? undefined : JSON.stringify(b) });
const J = async (u, m, b) => { const r = await api(u, m, b); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* sem corpo */ } return { status: r.status, j }; };
const state = async () => (await api('/api/state')).json();
const disk = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const terminals = async () => (await (await api('/api/terminals')).json()).sessions;

let A, B, dirA, dirB;
before(async () => {
  dirA = mkWs('wsA'); dirB = mkWs('wsB');
  await boot();
  A = (await J('/api/workspaces', 'POST', { name: 'A', path: dirA })).j; B = (await J('/api/workspaces', 'POST', { name: 'B', path: dirB })).j;
  assert.ok(A?.id && B?.id, 'workspaces cadastrados');
});
after(async () => { try { await stop(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });

test('(1) abrir/alternar/fechar workspaces e persistência das abas após reiniciar o servidor', async () => {
  let s = await state();
  assert.ok(s.openWorkspaceIds.length >= 1);
  assert.equal((await J(`/api/workspaces/${A.id}/activate`, 'POST')).status, 200);
  assert.equal((await J(`/api/workspaces/${B.id}/open`, 'POST')).status, 200);
  s = await state();
  assert.deepEqual([...s.openWorkspaceIds].sort(), [A.id, B.id].sort()); assert.equal(s.activeWorkspace.id, A.id, 'abrir não troca o ativo');
  assert.equal((await J(`/api/workspaces/${B.id}/activate`, 'POST')).status, 200);
  assert.equal((await state()).activeWorkspace.id, B.id, 'alternar');
  assert.equal((await J(`/api/workspaces/${A.id}/activate`, 'POST')).status, 200);
  await sleep(500);
  await stop(); await boot();
  s = await state();
  assert.deepEqual([...s.openWorkspaceIds].sort(), [A.id, B.id].sort(), 'abas persistidas após reinício'); assert.equal(s.activeWorkspace.id, A.id, 'ativo persistido');
  // fechar a aba do ativo: o vizinho assume; fechar a última: sem ativo
  let r = await J(`/api/workspaces/${A.id}/close`, 'POST'); assert.equal(r.status, 200); assert.deepEqual(r.j.openWorkspaceIds, [B.id]); assert.equal(r.j.activeWorkspaceId, B.id);
  await sleep(500); await stop(); await boot();
  s = await state(); assert.deepEqual(s.openWorkspaceIds, [B.id], 'fechamento persistido'); assert.equal(s.activeWorkspace.id, B.id);
  assert.equal((await J(`/api/workspaces/${A.id}/open`, 'POST')).status, 200);
  assert.equal((await J('/api/workspaces/ws_fantasma/open', 'POST')).status, 404);
});

test('(2) criar/ativar tópicos e "Geral" (topic/general) persistem após reinício', async () => {
  await J(`/api/workspaces/${A.id}/activate`, 'POST');
  const t1 = (await J('/api/topics', 'POST', { workspaceId: A.id, title: 'Login' })).j;
  const t2 = (await J('/api/topics', 'POST', { workspaceId: B.id, title: 'Outro' })).j;
  assert.match(t1.id, /^top_[0-9a-f]{8}$/);
  assert.equal((await J(`/api/topics/${t1.id}/activate`, 'POST')).status, 200);
  let s = await state(); assert.deepEqual(s.activeTopicIds, { [A.id]: t1.id }); assert.deepEqual(s.topics.map((t) => t.id).sort(), [t1.id, t2.id].sort());
  await sleep(500); await stop(); await boot();
  s = await state(); assert.deepEqual(s.activeTopicIds, { [A.id]: t1.id }, 'tópico ativo persistido'); assert.equal(s.topics.length, 2);
  const g = await J(`/api/workspaces/${A.id}/topic/general`, 'POST'); assert.equal(g.status, 200); assert.equal(g.j.activeTopicIds[A.id], undefined);
  await sleep(500); await stop(); await boot();
  s = await state(); assert.equal(s.activeTopicIds[A.id], undefined, 'Geral persistido após reinício'); assert.ok(s.topics.some((t) => t.id === t1.id), 'o tópico segue existindo');
  assert.equal((await J('/api/workspaces/ws_fantasma/topic/general', 'POST')).status, 404);
});

test('(3) isolamento: topicId de outro workspace e workspaceId inexistente dão 400, sem processo nem registro', async () => {
  const tB = (await J('/api/topics', 'POST', { workspaceId: B.id, title: 'só do B' })).j;
  const before = (await terminals()).length, recs = (disk().terminalSessions ?? []).length;
  let r = await J('/api/terminals', 'POST', { role: 'builder', workspaceId: A.id, topicId: tB.id }); assert.equal(r.status, 400); assert.match(r.j.error, /outro espaço de trabalho/i);
  r = await J('/api/terminals', 'POST', { role: 'builder', topicId: tB.id }); // ativo é o A
  assert.equal(r.status, 400, 'sem workspaceId vale o ativo (A): tópico do B é recusado');
  r = await J('/api/terminals', 'POST', { role: 'builder', workspaceId: 'ws_fantasma' }); assert.equal(r.status, 400);
  r = await J('/api/terminals', 'POST', { role: 'builder', workspaceId: A.id, topicId: 'top_00000000' }); assert.equal(r.status, 400);
  assert.equal((await terminals()).length, before, 'nenhum terminal aberto'); await sleep(400); assert.equal((disk().terminalSessions ?? []).length, recs, 'nenhum registro criado');
  // cwd/path vindos do cliente são ignorados: o cwd é sempre o do workspace pedido
  r = await J('/api/terminals', 'POST', { role: 'builder', workspaceId: A.id, cwd: dirB, path: dirB }); assert.equal(r.status, 201, JSON.stringify(r.j));
  assert.equal(path.resolve(r.j.session.cwd), path.resolve(dirA)); assert.equal(r.j.session.workspaceId, A.id);
  await J(`/api/terminals/${r.j.session.id}/close`, 'POST');
});

let tA, tB1, sA, sB;
test('(4) terminais com topicId aparecem com topicId/workspaceId corretos; fechar aba e trocar workspace/tópico NÃO os encerra', async () => {
  tA = (await J('/api/topics', 'POST', { workspaceId: A.id, title: 'Tópico A' })).j; tB1 = (await J('/api/topics', 'POST', { workspaceId: B.id, title: 'Tópico B' })).j;
  let r = await J('/api/terminals', 'POST', { role: 'builder', workspaceId: A.id, topicId: tA.id }); assert.equal(r.status, 201, JSON.stringify(r.j)); sA = r.j.session;
  r = await J('/api/terminals', 'POST', { role: 'builder', workspaceId: B.id, topicId: tB1.id }); assert.equal(r.status, 201, JSON.stringify(r.j)); sB = r.j.session;
  const geral = (await J('/api/terminals', 'POST', { role: 'builder', workspaceId: B.id })).j.session; assert.equal(geral.topicId, null);
  assert.equal(path.resolve(sB.cwd), path.resolve(dirB)); assert.equal(path.resolve(sA.cwd), path.resolve(dirA));
  const check = async (msg) => {
    const l = await terminals(), a = l.find((x) => x.id === sA.id), b = l.find((x) => x.id === sB.id), g = l.find((x) => x.id === geral.id);
    assert.ok(a && b && g, `${msg}: terminais continuam listados`);
    assert.deepEqual([a.topicId, a.workspaceId, a.status], [tA.id, A.id, 'running'], msg); assert.deepEqual([b.topicId, b.workspaceId, b.status], [tB1.id, B.id, 'running'], msg); assert.equal(g.topicId, null);
  };
  await check('após criar');
  await J(`/api/workspaces/${A.id}/activate`, 'POST'); await J(`/api/topics/${tA.id}/activate`, 'POST');
  assert.equal((await J(`/api/workspaces/${A.id}/close`, 'POST')).status, 200); await check('após fechar a aba do A');
  await J(`/api/workspaces/${B.id}/activate`, 'POST'); await J(`/api/topics/${tB1.id}/activate`, 'POST'); await check('após trocar workspace/tópico');
  await J(`/api/workspaces/${B.id}/topic/general`, 'POST'); await check('após voltar para Geral');
  const h = (await (await api('/api/terminals/history')).json()).sessions;
  assert.equal(h.find((x) => x.workspaceId === A.id && x.topicId === tA.id)?.state, 'running'); assert.equal(h.find((x) => x.topicId === tB1.id)?.workspaceId, B.id);
  await J(`/api/workspaces/${A.id}/open`, 'POST');
  await J(`/api/terminals/${geral.id}/close`, 'POST');
});

test('(5) resume/fork preserva topicId válido e vira null se o tópico foi arquivado', async () => {
  // fecha os terminais do teste anterior: só sessões encerradas podem ser retomadas
  await J(`/api/terminals/${sA.id}/close`, 'POST'); await J(`/api/terminals/${sB.id}/close`, 'POST');
  await sleep(700);
  const recs = disk().terminalSessions ?? [];
  const rA = recs.find((x) => x.topicId === tA.id), rB = recs.find((x) => x.topicId === tB1.id);
  assert.ok(rA && rB, 'registros no disco'); assert.notEqual(rA.state, 'running');
  for (const r of [rA, rB]) fs.writeFileSync(path.join(cfgDir, 'projects', 'p', `${r.claudeSessionId}.jsonl`), '{"type":"user"}\n'); // transcrição simulada
  // retomada com tópico válido
  let r = await J('/api/terminals/resume', 'POST', { recordId: rA.id }); assert.equal(r.status, 201, JSON.stringify(r.j));
  assert.deepEqual([r.j.session.topicId, r.j.session.workspaceId], [tA.id, A.id]);
  await J(`/api/terminals/${r.j.session.id}/close`, 'POST'); await sleep(500);
  // fork com tópico válido
  r = await J('/api/terminals/resume', 'POST', { recordId: rA.id, fork: true }); assert.equal(r.status, 201, JSON.stringify(r.j));
  assert.equal(r.j.session.topicId, tA.id); const fk = r.j.session; await J(`/api/terminals/${fk.id}/close`, 'POST');
  // arquiva o tópico: retomada e fork voltam para Geral (null), sem bloquear
  assert.equal((await J(`/api/topics/${tA.id}/archive`, 'POST')).status, 200); await sleep(300);
  r = await J('/api/terminals/resume', 'POST', { recordId: rA.id }); assert.equal(r.status, 201, JSON.stringify(r.j)); assert.equal(r.j.session.topicId, null); assert.equal(r.j.session.workspaceId, A.id);
  await J(`/api/terminals/${r.j.session.id}/close`, 'POST'); await sleep(500);
  r = await J('/api/terminals/resume', 'POST', { recordId: rA.id, fork: true }); assert.equal(r.status, 201, JSON.stringify(r.j)); assert.equal(r.j.session.topicId, null);
  await J(`/api/terminals/${r.j.session.id}/close`, 'POST');
  // o outro tópico (não arquivado) segue válido
  r = await J('/api/terminals/resume', 'POST', { recordId: rB.id }); assert.equal(r.status, 201, JSON.stringify(r.j)); assert.equal(r.j.session.topicId, tB1.id);
  const hist = (await (await api('/api/terminals/history')).json()).sessions;
  assert.equal(hist.find((x) => x.id === rA.id).topicId, null, 'histórico reflete o Geral');
});

test('(6) banco antigo (sem openWorkspaceIds/topics/activeTopicIds) carrega no servidor real', async () => {
  await stop();
  const wsOld = mkWs('wsOld');
  fs.writeFileSync(DB_FILE, JSON.stringify({ version: 1, settings: { activeWorkspaceId: 'ws_legacy01', requireApproval: true, showDemoData: false }, workspaces: [{ id: 'ws_legacy01', name: 'legado', path: wsOld, createdAt: new Date().toISOString() }], missions: [], activity: [] }));
  await boot();
  const s = await state();
  assert.deepEqual([s.openWorkspaceIds, s.topics, s.activeTopicIds], [['ws_legacy01'], [], {}]); assert.equal(s.activeWorkspace.id, 'ws_legacy01');
  const r = await J('/api/terminals', 'POST', { role: 'builder' }); assert.equal(r.status, 201, JSON.stringify(r.j)); assert.equal(r.j.session.topicId, null); assert.equal(r.j.session.workspaceId, 'ws_legacy01');
  assert.equal((await J('/api/terminals', 'POST', { role: 'builder', topicId: 'top_00000000' })).status, 400);
});
