// Limites do incremento D no boot: servidores REAIS (server/index.js) como processos filhos, SEMPRE com ORCH_DATA_DIR temporário e porta livre própria.
// Nenhum modelo é chamado; o banco real e o servidor ativo nunca são tocados.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-limits-boot-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
let n = 0;
const newDir = () => { const d = path.join(root, `d${++n}`); fs.mkdirSync(d); assert.ok(d.startsWith(os.tmpdir())); return d; };
function boot(port, dir, extra) {
  const base = { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir };
  for (const k of ['ORCH_PLANNER_ROUTING', 'ORCH_PLANNER_MODEL', 'ORCH_PLANNER_EFFORT', 'ORCH_CYCLE_MAX_PLANNER_CALLS', 'ORCH_CYCLE_MAX_ESTIMATED_COST_USD']) delete base[k];
  const child = spawn(process.execPath, [INDEX], { env: { ...base, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))) };
}
const waitUp = async (b) => { for (let i = 0; i < 80; i++) { if (/AI Dev Orchestrator API em/.test(b.out())) return true; await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); } return false; };

test('valor inválido em ORCH_CYCLE_MAX_PLANNER_CALLS / ORCH_CYCLE_MAX_ESTIMATED_COST_USD impede o boot ANTES de tocar em qualquer dado', async () => {
  for (const extra of [{ ORCH_CYCLE_MAX_PLANNER_CALLS: '0' }, { ORCH_CYCLE_MAX_PLANNER_CALLS: 'muitas' }, { ORCH_CYCLE_MAX_ESTIMATED_COST_USD: '-1' }, { ORCH_CYCLE_MAX_ESTIMATED_COST_USD: 'barato' }]) {
    const dir = newDir(), b = boot(await freePort(), dir, extra);
    const code = await Promise.race([b.exited, new Promise((r) => setTimeout(() => r('preso'), 15000))]);
    assert.notEqual(code, 'preso'); assert.notEqual(code, 0, `${JSON.stringify(extra)} deveria impedir o boot`);
    assert.match(b.out(), /ORCH_CYCLE_MAX_/); assert.deepEqual(fs.readdirSync(dir), [], 'nada foi criado no diretório de dados (nem trava, nem banco)');
  }
});

test('desativado (padrão), off e valores válidos sobem normalmente na porta temporária', async () => {
  for (const extra of [{}, { ORCH_CYCLE_MAX_PLANNER_CALLS: 'off', ORCH_CYCLE_MAX_ESTIMATED_COST_USD: 'off' }, { ORCH_CYCLE_MAX_PLANNER_CALLS: '12', ORCH_CYCLE_MAX_ESTIMATED_COST_USD: '2.50', ORCH_PLANNER_ROUTING: 'on' }]) {
    const dir = newDir(), port = await freePort(), b = boot(port, dir, extra);
    assert.equal(await waitUp(b), true, `não subiu com ${JSON.stringify(extra)}: ${b.out()}`);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/missions`)).status, 200);
    b.child.kill(); await b.exited;
  }
});
