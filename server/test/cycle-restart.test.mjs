// M7: queda REAL no meio de uma etapa de um plano. Servidor real (server/index.js via cycle-boot.mjs) como processo filho, porta livre e ORCH_DATA_DIR temporários; o Executor é a CLI FALSA
// (um processo real, que SOBREVIVE à morte do servidor no Windows) e o Planner é simulado: nenhum modelo é chamado. O servidor A é encerrado à força no meio da etapa s2; o servidor B sobe
// sobre o mesmo banco: encerra o processo órfão (identidade conferida), recupera o plano e, na retomada humana, não repete s1 nem s2 e só consulta o Planner. O banco real (data/) não é tocado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pidAlive } from '../instance-lock.js';
import { killTreeSync } from '../orphans.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(here, 'cycle-boot.mjs');
const REAL_DB = path.resolve(here, '..', '..', 'data', 'db.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cycle-restart-'));
const children = new Set(), strays = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } for (const pid of strays) killTreeSync(pid); await new Promise((r) => setTimeout(r, 500)); fs.rmSync(root, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function boot(port, dir) {
  assert.ok(dir.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário');
  const child = spawn(process.execPath, [BOOT], { env: { ...process.env, PORT: String(port), ORCH_DATA_DIR: dir, ORCH_CYCLE_PLAN: 'on' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))) };
}
const waitUp = async (b) => { for (let i = 0; i < 200; i++) { if (/AI Dev Orchestrator API em/.test(b.out())) return true; await Promise.race([sleep(100), b.exited]); } return false; };
const call = async (base, p, body) => { const res = await fetch(base + p, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => ({})) }; };
const stat = () => (fs.existsSync(REAL_DB) ? `${fs.statSync(REAL_DB).mtimeMs}:${fs.statSync(REAL_DB).size}` : 'ausente');
const statuses = (c) => c.plan.steps.map((s) => `${s.id}:${s.status}`);

test('queda real no meio da etapa s2: o processo órfão é encerrado, s1 fica concluída e intacta, s2 interrompida com resultado incerto, e a retomada não repete nada nem passa dos limites', async () => {
  const realBefore = stat();
  const dir = path.join(root, 'data'), ws = path.join(root, 'workspace'); fs.mkdirSync(dir); fs.mkdirSync(ws);
  const portA = await freePort(), a = boot(portA, dir), baseA = `http://127.0.0.1:${portA}`;
  let missionId, s1Before, orphanPid;
  try {
    assert.ok(await waitUp(a), `servidor A não subiu:\n${a.out()}`);
    assert.equal((await call(baseA, '/api/workspaces', { path: ws })).status, 201);
    missionId = (await call(baseA, '/api/missions', { title: 'Plano com queda', objective: 'três etapas' })).json.id; assert.ok(missionId);
    assert.equal((await call(baseA, `/api/missions/${missionId}/cycle/start`, { maxIterations: 6 })).status, 202);
    const m = await until(async () => { const x = (await call(baseA, `/api/missions/${missionId}`)).json; const t = x.tasks?.[1]; return x.cycle?.rounds?.length === 2 && x.cycle.rounds[1].status === 'running' && t?.status === 'running' && t.pid ? x : null; });
    assert.ok(m, `a etapa s2 não chegou a executar:\n${a.out()}`);
    assert.deepEqual(statuses(m.cycle), ['s1:completed', 's2:running', 's3:queued']); s1Before = JSON.stringify(m.cycle.rounds[0]); orphanPid = m.tasks[1].pid; strays.add(orphanPid);
    assert.equal(m.cycle.plannerCalls, 1); assert.equal(m.tasks.length, 2);
  } finally { a.child.kill('SIGKILL'); await a.exited; } // queda: sem encerramento limpo, o que vale é o que já estava gravado
  assert.equal(pidAlive(orphanPid), true, 'a CLI da etapa s2 sobreviveu à queda do servidor (é o cenário de processo órfão)');

  const portB = await freePort(), b = boot(portB, dir), baseB = `http://127.0.0.1:${portB}`;
  try {
    assert.ok(await waitUp(b), `servidor B não subiu:\n${b.out()}`);
    assert.equal(pidAlive(orphanPid), false, 'o boot encerrou o processo órfão (a identidade bateu com a da execução abandonada)');
    const x = (await call(baseB, `/api/missions/${missionId}`)).json, c = x.cycle;
    assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'restarted'); assert.deepEqual(statuses(c), ['s1:completed', 's2:interrupted', 's3:queued']);
    assert.equal(c.plan.steps[1].uncertain, true); assert.equal(c.rounds[1].report.filesKnown, false); assert.match(c.rounds[1].report.outcomeUncertain, /desconhecid/);
    assert.match(c.blockedReason, /concluídas: s1/); assert.match(c.blockedReason, /incerto.*: s2/i); assert.match(c.blockedReason, /na fila: s3/);
    assert.equal(JSON.stringify(c.rounds[0]), s1Before, 's1: a evidência gravada não foi tocada pela recuperação'); assert.equal(c.plannerCalls, 1, 'o contador sobreviveu à queda'); assert.equal(x.tasks.length, 2, 'nada foi executado no boot');
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).missions.find((y) => y.id === missionId);
    assert.deepEqual(disk.cycle.plan.steps.map((s) => s.status), ['completed', 'interrupted', 'queued'], 'o estado recuperado está no disco'); assert.equal(disk.tasks[1].status, 'interrupted'); assert.equal('pid' in disk.tasks[1], false, 'o PID foi limpo depois de encerrado');

    assert.equal((await call(baseB, `/api/missions/${missionId}/cycle/resume`, {})).status, 202);
    const end = await until(async () => { const y = (await call(baseB, `/api/missions/${missionId}`)).json; return y.cycle.status === 'blocked' && y.cycle.blockedCode === 'planner_blocked' ? y : null; });
    assert.ok(end, `a retomada não terminou:\n${b.out()}`);
    assert.deepEqual(statuses(end.cycle), ['s1:completed', 's2:interrupted', 's3:queued']); assert.equal(end.cycle.rounds.length, 2, 'nenhuma rodada nova: s2 não foi refeita e s3 não rodou por cima dela'); assert.equal(end.tasks.length, 2);
    assert.equal(JSON.stringify(end.cycle.rounds[0]), s1Before, 's1 não foi refeita nem alterada pela retomada'); assert.equal(end.cycle.plannerCalls, 2, 'cumulativo: 1 antes da queda + 1 na retomada');
    assert.equal(end.cycle.blocks.filter((k) => k.code === 'restarted').length, 1);
  } finally { b.child.kill(); await b.exited; }
  assert.equal(stat(), realBefore, 'o banco real (data/db.json) não foi tocado');
});
