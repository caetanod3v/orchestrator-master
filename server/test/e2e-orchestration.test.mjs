// I3 (Marco A): o fluxo COMPLETO pela API real — chat -> plano de 2 etapas -> aprovação -> ciclo -> falha recuperável da verificação -> retentativa -> conclusão verificada ->
// relatório de entrega — com o servidor REAL (server/index.js via orchestration-boot.mjs) em processo filho. Executor = CLI falsa, Planner e verificador SIMULADOS: nenhum modelo,
// nenhum processo de verificação real. SEMPRE com ORCH_DATA_DIR temporário, porta livre e workspace temporário com Git. O servidor da porta 4317 e data/db.json não são tocados.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(here, 'orchestration-boot.mjs');
const REAL_DB = path.resolve(here, '..', '..', 'data', 'db.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const stat = () => (fs.existsSync(REAL_DB) ? `${fs.statSync(REAL_DB).mtimeMs}:${fs.statSync(REAL_DB).size}` : 'ausente');
let n = 0;
/** Diretório de dados e workspace (com Git e um package.json com o script de teste) exclusivos deste cenário, dentro do temporário. */
function world() {
  const base = path.join(root, `w${++n}`), data = path.join(base, 'data'), ws = path.join(base, 'workspace');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(ws); assert.ok(data.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário');
  execFileSync('git', ['init', '-q'], { cwd: ws }); fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'alvo', scripts: { test: 'node -e 0' } }));
  return { data, ws };
}
/** Servidor real em processo filho. `env` entra por cima de um ambiente SEM nenhuma variável ORCH_CYCLE_* herdada: o padrão do servidor é o que se testa quando nada é passado. */
function boot(port, data, env = {}) {
  const base = { ...process.env, PORT: String(port), ORCH_DATA_DIR: data };
  for (const k of Object.keys(base)) if (/^(ORCH_CYCLE_|ORCH_PLANNER_|E2E_)/.test(k)) delete base[k];
  const child = spawn(process.execPath, [BOOT], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))), base: `http://127.0.0.1:${port}` };
}
const waitUp = async (b) => { for (let i = 0; i < 100; i++) { if (/AI Dev Orchestrator API em/.test(b.out())) return true; await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); } return false; };
const stop = async (b) => { b.child.kill(); await b.exited; };
const ORIGIN = 'http://localhost:5173';
async function call(b, p, { method = 'GET', body, origin = method === 'GET' ? undefined : ORIGIN } = {}) {
  const res = await fetch(b.base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const TERMINAL = ['completed', 'blocked', 'cancelled', 'limit_reached'];
async function until(b, id, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const m = (await call(b, `/api/missions/${id}`)).json;
    if (m?.cycle && TERMINAL.includes(m.cycle.status)) return m;
    if (Date.now() - t0 > ms) assert.fail(`o ciclo não terminou em ${ms} ms (estado: ${m?.cycle?.status}):\n${b.out()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
/** Percorre o fluxo real: cadastra e aprova a verificação do workspace, conversa no chat, recebe o plano de 2 etapas e o aprova. Devolve o id da missão já com o ciclo terminado/bloqueado. */
async function runMission(b, ws) {
  assert.ok(await waitUp(b), `servidor não subiu:\n${b.out()}`);
  const w = await call(b, '/api/workspaces', { method: 'POST', body: { path: ws } }); assert.equal(w.status, 201);
  const v = await call(b, `/api/workspaces/${w.json.id}/verifications`, { method: 'PUT', body: { items: [{ script: 'test', required: true }] } }); assert.equal(v.status, 200); assert.deepEqual(v.json.map((x) => [x.script, x.required]), [['test', true]]);
  const msg = await call(b, '/api/chat/message', { method: 'POST', body: { text: 'LANDING page para uma barbearia' } });
  assert.equal(msg.status, 200); const p = msg.json.proposal; assert.equal(p.status, 'proposed'); assert.deepEqual(p.steps.map((s) => [s.id, s.dependsOn]), [['s1', []], ['s2', ['s1']]]);
  assert.deepEqual((await call(b, '/api/missions')).json.filter((m) => !m.demo), [], 'conversar não cria missão real nem ciclo');
  const ap = await call(b, '/api/chat/approve', { method: 'POST', body: { proposalId: p.id } }); assert.equal(ap.status, 202, JSON.stringify(ap.json)); assert.ok(ap.json.missionId);
  return { id: ap.json.missionId, mission: await until(b, ap.json.missionId) };
}
const strip = (r) => { const { generatedAt, ...rest } = r; return rest; };

test('A — falha recuperável da verificação, UMA retentativa e conclusão verificada, pelo fluxo real da API; C — configuração e relatório coerentes; D — persistem após reinício; E — Origin', async () => {
  const realBefore = stat(), { data, ws } = world(), port = await freePort();
  let a = boot(port, data, { ORCH_CYCLE_PLAN: 'on', ORCH_CYCLE_MAX_STEP_RETRIES: '1', E2E_VERIFY_FAILS: '1' }), report, state;
  try {
    const { id, mission } = await runMission(a, ws);
    assert.equal(mission.cycle.status, 'completed', `${mission.cycle.blockedReason}\n${a.out()}`);
    // o ciclo concluiu, mas a entrega só vale pelo que o servidor comprova: confere o RELATÓRIO, a garantia e as evidências
    const d = await call(a, `/api/missions/${id}/delivery`); assert.equal(d.status, 200); report = d.json;
    assert.equal(report.state.code, 'completed'); assert.equal(report.state.delivered, true); assert.equal(report.assurance.level, 'verified'); assert.deepEqual(report.assurance.reasons, ['evidência do sistema da última rodada: verified']);
    assert.deepEqual(report.observed.steps.map((s) => [s.id, s.status, s.attempts, s.executedByRound]), [['s1', 'completed', 2, true], ['s2', 'completed', 1, true]]);
    assert.equal(report.observed.retriesUsed, 1); assert.equal(report.cycle.rounds, 3);
    assert.deepEqual(report.observed.rounds.map((r) => [r.n, r.stepId, r.status, r.executed]), [[1, 's1', 'succeeded', true], [2, 's1', 'succeeded', true], [3, 's2', 'succeeded', true]]);
    assert.deepEqual(report.verified.evidence.map((e) => [e.round, e.level, e.realVerification]), [[1, 'failed', 'failed'], [2, 'verified', 'passed'], [3, 'verified', 'passed']], 'a evidência da tentativa 1 continua falha; a retentativa tem a sua própria');
    assert.deepEqual(report.verified.verifications.map((x) => [x.round, x.script, x.status, x.required]), [[1, 'test', 'fail', true], [2, 'test', 'pass', true], [3, 'test', 'pass', true]]);
    assert.deepEqual(report.verified.missing, []);
    for (const e of report.verified.evidence.filter((x) => x.level === 'verified')) assert.deepEqual(e.expectedFiles.map((f) => f.ok), [true]);
    assert.ok(fs.existsSync(path.join(ws, 'index.html')) && fs.existsSync(path.join(ws, 'style.css')), 'os arquivos esperados existem no workspace');
    // C — a configuração publicada e o relatório contam a mesma história
    state = (await call(a, '/api/state')).json;
    assert.deepEqual(state.orchestration, { planMode: true, stepRetries: 1, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'env', stepRetries: 'env' } });
    assert.equal(report.observed.retriesUsed, state.orchestration.stepRetries, 'o orçamento de 1 retentativa foi usado por inteiro');
    assert.ok(report.observed.steps.every((s) => s.attempts <= state.orchestration.maxStepAttempts)); assert.ok(report.cycle.rounds <= state.orchestration.hardMaxIterations); assert.ok(report.cycle.rounds <= report.cycle.maxIterations);
    assert.equal(report.observed.rounds.filter((r) => r.stepId === 's1').length, report.observed.steps.find((s) => s.id === 's1').attempts, 'attempts = rodadas da etapa no relatório');
    assert.equal(mission.cycle.rounds.filter((r) => r.stepId === 's1').length, 2); assert.equal(mission.cycle.rounds.length, report.cycle.rounds);
    // E — Origin: origem inválida e ausência de Origin em método mutável são recusadas; nada é alterado
    const before = (await call(a, '/api/chat')).json;
    const evil = await call(a, '/api/chat/message', { method: 'POST', body: { text: 'oi' }, origin: 'http://evil.example' }); assert.equal(evil.status, 403); assert.equal(evil.json.error, 'Origem não permitida.');
    const none = await call(a, '/api/chat/message', { method: 'POST', body: { text: 'oi' }, origin: null }); assert.equal(none.status, 403); assert.match(none.json.error, /só são aceitas com Origin válido/);
    const del = await call(a, `/api/missions/${id}`, { method: 'DELETE', origin: 'http://evil.example' }); assert.equal(del.status, 403);
    assert.deepEqual((await call(a, '/api/chat')).json, before, 'as requisições recusadas não alteraram o chat'); assert.equal((await call(a, `/api/missions/${id}`)).status, 200, 'a missão continua existindo');
    assert.equal((await call(a, '/api/state', { origin: 'http://evil.example' })).status, 403, 'Origin inválido é recusado até em leituras');
    // D — reinício REAL sobre o mesmo diretório de dados
    await stop(a);
    a = boot(await freePort(), data, { ORCH_CYCLE_PLAN: 'on', ORCH_CYCLE_MAX_STEP_RETRIES: '1', E2E_VERIFY_FAILS: '1' });
    assert.ok(await waitUp(a), `servidor reiniciado não subiu:\n${a.out()}`);
    const again = await call(a, `/api/missions/${id}/delivery`); assert.equal(again.status, 200);
    assert.deepEqual(strip(again.json), strip(report), 'o relatório depois do reinício é o mesmo (só o instante de geração muda)');
    assert.equal((await call(a, `/api/missions/${id}`)).json.cycle.status, 'completed', 'o ciclo concluído não foi reaberto nem repetido');
    assert.deepEqual((await call(a, '/api/state')).json.orchestration, state.orchestration);
    assert.equal(fs.readdirSync(ws).filter((f) => f.endsWith('.html') || f.endsWith('.css')).length, 2, 'nada foi executado de novo no workspace');
  } finally { await stop(a); }
  assert.equal(stat(), realBefore, 'o banco real (data/db.json) não foi tocado');
});

test('B — retentativas desligadas (padrão): a mesma falha NÃO é repetida, o ciclo bloqueia e a garantia não é verificada; a configuração publicada diz isso', async () => {
  const realBefore = stat(), { data, ws } = world(), b = boot(await freePort(), data, { ORCH_CYCLE_PLAN: 'on', E2E_VERIFY_FAILS: '1' }); // sem ORCH_CYCLE_MAX_STEP_RETRIES
  try {
    const { id, mission } = await runMission(b, ws);
    assert.equal(mission.cycle.status, 'blocked'); assert.equal(mission.cycle.blockedCode, 'planner_blocked'); assert.equal(mission.cycle.rounds.length, 1, 'uma única rodada: nada foi repetido');
    const report = (await call(b, `/api/missions/${id}/delivery`)).json;
    assert.deepEqual([report.state.code, report.state.delivered, report.assurance.level], ['blocked', false, 'not_applicable']); assert.notEqual(report.assurance.level, 'verified');
    assert.deepEqual(report.observed.steps.map((s) => [s.id, s.status, s.attempts]), [['s1', 'failed', 1], ['s2', 'queued', 0]]); assert.equal(report.observed.retriesUsed, 0);
    assert.deepEqual(report.verified.evidence.map((e) => [e.round, e.level]), [[1, 'failed']]); assert.deepEqual(report.verified.verifications.map((x) => [x.round, x.status]), [[1, 'fail']]);
    assert.match(report.state.reasons.join(' '), /planner_blocked/);
    assert.ok(!fs.existsSync(path.join(ws, 'style.css')), 'a etapa seguinte não rodou');
    const st = (await call(b, '/api/state')).json;
    assert.deepEqual(st.orchestration, { planMode: true, stepRetries: 0, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'env', stepRetries: 'default' } }); assert.equal(report.observed.retriesUsed, st.orchestration.stepRetries);
  } finally { await stop(b); }
  assert.equal(stat(), realBefore, 'o banco real (data/db.json) não foi tocado');
});
