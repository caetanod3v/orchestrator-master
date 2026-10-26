// Incremento A de ponta a ponta: servidores REAIS (server/index.js) como processos filhos, SEMPRE com ORCH_DATA_DIR temporário e porta livre própria.
// Nenhum Claude/modelo é chamado (o boot só consulta `claude --version` quando /api/state é lido); o banco real nunca é tocado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-routing-boot-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let n = 0;
const newDir = () => { const d = path.join(root, `d${++n}`); fs.mkdirSync(d); assert.ok(d.startsWith(os.tmpdir())); return d; };
function boot(env) {
  const port = env.PORT; const dir = env.ORCH_DATA_DIR;
  const base = { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir }; for (const k of ['ORCH_PLANNER_ROUTING', 'ORCH_PLANNER_MODEL', 'ORCH_PLANNER_EFFORT']) delete base[k];
  const child = spawn(process.execPath, [INDEX], { env: { ...base, ...env.extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return { child, exited, out: () => out };
}
const waitUp = async (b, port) => { for (let i = 0; i < 80; i++) { if (/AI Dev Orchestrator API em/.test(b.out())) return true; await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); } return false; };

test('valor inválido em ORCH_PLANNER_ROUTING impede o boot ANTES de tocar em qualquer dado', async () => {
  for (const v of ['maybe', '1', 'true']) {
    const dir = newDir(), port = await freePort();
    const b = boot({ PORT: port, ORCH_DATA_DIR: dir, extra: { ORCH_PLANNER_ROUTING: v } });
    const code = await Promise.race([b.exited, new Promise((r) => setTimeout(() => r('preso'), 15000))]);
    assert.notEqual(code, 'preso'); assert.notEqual(code, 0, `ORCH_PLANNER_ROUTING=${v} deveria impedir o boot`);
    assert.match(b.out(), /ORCH_PLANNER_ROUTING/);
    assert.deepEqual(fs.readdirSync(dir), [], 'nada foi criado no diretório de dados (nem trava, nem banco)');
  }
});

test('desligado (padrão), off e on sobem normalmente e respondem na própria porta temporária', async () => {
  for (const extra of [{}, { ORCH_PLANNER_ROUTING: 'off' }, { ORCH_PLANNER_ROUTING: 'on' }, { ORCH_PLANNER_ROUTING: 'on', ORCH_PLANNER_MODEL: 'claude-haiku-5-5', ORCH_PLANNER_EFFORT: 'low' }]) {
    const dir = newDir(), port = await freePort();
    const b = boot({ PORT: port, ORCH_DATA_DIR: dir, extra });
    assert.equal(await waitUp(b, port), true, `não subiu com ${JSON.stringify(extra)}: ${b.out()}`);
    const r = await fetch(`http://127.0.0.1:${port}/api/missions`); assert.equal(r.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'server.lock')), 'a trava de instância fica no diretório temporário');
    b.child.kill(); await b.exited;
  }
});
