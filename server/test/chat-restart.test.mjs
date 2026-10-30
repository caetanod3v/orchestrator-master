// M5: o histórico do chat e a proposta pendente sobrevivem a um REINÍCIO REAL do servidor (processo encerrado à força e novo processo sobre o mesmo banco).
// Servidor real (server/index.js via chat-boot.mjs), SEMPRE com ORCH_DATA_DIR temporário e porta livre própria. Planner simulado: nenhum modelo é chamado,
// nada é aprovado nem executado. O banco real (data/) e o servidor ativo não são tocados (o teste confere que o db.json real não mudou).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(here, 'chat-boot.mjs');
const REAL_DB = path.resolve(here, '..', '..', 'data', 'db.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chat-restart-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function boot(port, dir) {
  assert.ok(dir.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário');
  const child = spawn(process.execPath, [BOOT], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir, ORCH_CYCLE_PLAN: 'on' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))) };
}
const waitUp = async (b) => { for (let i = 0; i < 100; i++) { if (/AI Dev Orchestrator API em/.test(b.out())) return true; await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); } return false; };
const call = async (base, p, body) => { const res = await fetch(base + p, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => ({})) }; };
const stat = () => (fs.existsSync(REAL_DB) ? `${fs.statSync(REAL_DB).mtimeMs}:${fs.statSync(REAL_DB).size}` : 'ausente');

test('reinício real: mensagens e proposta pendente voltam intactas, o Planner recebe o contexto anterior e nenhuma missão ou ciclo é criado', async () => {
  const realBefore = stat();
  const dir = path.join(root, 'data'), ws = path.join(root, 'workspace'); fs.mkdirSync(dir); fs.mkdirSync(ws);
  const portA = await freePort(), a = boot(portA, dir), baseA = `http://127.0.0.1:${portA}`;
  let before_;
  try {
    assert.ok(await waitUp(a), `servidor A não subiu:\n${a.out()}`);
    assert.equal((await call(baseA, '/api/workspaces', { path: ws })).status, 201);
    for (const text of ['oi', 'AMBIGUO: quero um site', 'LANDING page para uma barbearia']) assert.equal((await call(baseA, '/api/chat/message', { text })).status, 200, text);
    before_ = (await call(baseA, '/api/chat')).json;
    assert.equal(before_.messages.length, 6); assert.deepEqual(before_.messages.filter((m) => m.role === 'assistant').map((m) => m.kind), ['reply', 'clarify', 'plan']);
    assert.equal(before_.proposal.status, 'proposed'); assert.deepEqual(before_.proposal.steps.map((s) => s.id), ['s1', 's2']); assert.equal(before_.planMode, true);
  } finally { a.child.kill('SIGKILL'); await a.exited; } // encerramento forçado: sem shutdown limpo, o que vale é o que já estava gravado
  const portB = await freePort(), b = boot(portB, dir), baseB = `http://127.0.0.1:${portB}`;
  try {
    assert.ok(await waitUp(b), `servidor B não subiu:\n${b.out()}`);
    const after_ = (await call(baseB, '/api/chat')).json;
    assert.deepEqual(after_.messages, before_.messages, 'as mensagens voltaram idênticas'); assert.deepEqual(after_.proposal, before_.proposal, 'a proposta pendente voltou idêntica'); assert.equal(after_.workspace.name, before_.workspace.name);
    const next = await call(baseB, '/api/chat/message', { text: 'e agora, o que falta?' });
    assert.equal(next.status, 200); assert.match(next.json.messages.at(-1).text, /Histórico visto: 6 mensagens/, 'o Planner recebeu o contexto anterior depois do reinício');
    assert.equal(next.json.proposal.id, before_.proposal.id, 'uma conversa simples não troca a proposta');
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    assert.equal(disk.missions.filter((m) => !m.demo).length, 0, 'nenhuma missão real'); assert.ok(!disk.missions.some((m) => m.cycle), 'nenhum ciclo'); assert.equal(disk.chat.proposal.status, 'proposed');
  } finally { b.child.kill(); await b.exited; }
  assert.equal(stat(), realBefore, 'o banco real (data/db.json) não foi tocado');
});
