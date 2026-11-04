// Marco B — supervisão pela API REAL. Servidor REAL (server/index.js via orchestration-boot.mjs) em processo filho, SEMPRE com ORCH_DATA_DIR temporário, porta livre e workspace temporário com Git;
// Executor = CLI falsa, Planner e verificador SIMULADOS. O servidor da 4317 e data/db.json não são tocados. Também renderiza o painel de decisões (componente React real) para provar a exibição.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT = path.join(here, 'orchestration-boot.mjs');
const CLIENT = path.resolve(here, '..', '..', 'client');
const REAL_DB = path.resolve(here, '..', '..', 'data', 'db.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sup-e2e-'));
const children = new Set();
after(async () => { for (const c of children) { try { c.kill(); } catch { /* já encerrado */ } } await new Promise((r) => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const stat = () => (fs.existsSync(REAL_DB) ? `${fs.statSync(REAL_DB).mtimeMs}:${fs.statSync(REAL_DB).size}` : 'ausente');
let n = 0;
function world() {
  const base = path.join(root, `w${++n}`), data = path.join(base, 'data'), ws = path.join(base, 'workspace');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(ws); assert.ok(data.startsWith(os.tmpdir()), 'o banco do teste tem que ficar no diretório temporário');
  execFileSync('git', ['init', '-q'], { cwd: ws }); fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'alvo', scripts: { test: 'node -e 0' } }));
  return { data, ws };
}
async function boot(data, env = {}) {
  const base = { ...process.env, ORCH_DATA_DIR: data };
  for (const k of Object.keys(base)) if (/^(ORCH_CYCLE_|ORCH_PLANNER_|E2E_)/.test(k)) delete base[k];
  const port = await freePort(), child = spawn(process.execPath, [BOOT], { env: { ...base, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))), base: `http://127.0.0.1:${port}` };
}
const waitUp = async (b) => { for (let i = 0; i < 100; i++) { if (/AI Dev Orchestrator API em/.test(b.out())) return true; await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); } return false; };
const up = async (data, env) => { const b = await boot(data, env); assert.ok(await waitUp(b), `servidor não subiu:\n${b.out()}`); return b; };
const stop = async (b) => { b.child.kill(); await b.exited; };
const ORIGIN = 'http://localhost:5173';
async function call(b, p, { method = 'GET', body, origin = method === 'GET' ? undefined : ORIGIN } = {}) {
  const res = await fetch(b.base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const put = (b, body, o) => call(b, '/api/settings', { method: 'PUT', body, ...o });
const sup = async (b) => (await call(b, '/api/state')).json.supervision;
const DEFAULTS = { supervisor: false, maxMinutes: 0, stallMinutes: 0, autoResumes: 0, source: { supervisor: 'default', maxMinutes: 'default', stallMinutes: 'default', autoResumes: 'default' } };
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
/** Cadastra o workspace, aprova a verificação, conversa, aprova o plano de 2 etapas e espera o ciclo parar. */
async function runMission(b, ws) {
  const w = await call(b, '/api/workspaces', { method: 'POST', body: { path: ws } }); assert.equal(w.status, 201);
  assert.equal((await call(b, `/api/workspaces/${w.json.id}/verifications`, { method: 'PUT', body: { items: [{ script: 'test', required: true }] } })).status, 200);
  const msg = await call(b, '/api/chat/message', { method: 'POST', body: { text: 'LANDING page para uma barbearia' } }); assert.equal(msg.status, 200, JSON.stringify(msg.json));
  const ap = await call(b, '/api/chat/approve', { method: 'POST', body: { proposalId: msg.json.proposal.id } }); assert.equal(ap.status, 202, JSON.stringify(ap.json));
  return { id: ap.json.missionId, mission: await until(b, ap.json.missionId) };
}

test('API: padrão tudo desligado; entradas inválidas = 400 sem aplicar nada; Origin; ambiente trava o campo (409); valores gravados sobrevivem ao reinício', async () => {
  const realBefore = stat(), { data } = world(); let b = await up(data);
  try {
    assert.deepEqual(await sup(b), DEFAULTS);
    for (const body of [{ supervisor: 'on' }, { supervisor: 1 }, { maxMinutes: 1441 }, { maxMinutes: -1 }, { maxMinutes: 1.5 }, { maxMinutes: '5' }, { stallMinutes: 241 }, { stallMinutes: null }, { autoResumes: 3 }, { autoResumes: true }, { autoResumes: 1, showDemoData: true, maxMinutes: 9999 }]) {
      const r = await put(b, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.json.error, /supervisor|maxMinutes|stallMinutes|autoResumes/);
    }
    assert.deepEqual(await sup(b), DEFAULTS, 'nada foi aplicado'); assert.equal((await call(b, '/api/state')).json.settings.showDemoData, false);
    assert.equal((await put(b, { supervisor: true }, { origin: 'http://evil.example' })).status, 403); assert.equal((await put(b, { supervisor: true }, { origin: null })).status, 403); assert.deepEqual(await sup(b), DEFAULTS);
    assert.equal((await put(b, { supervisor: true, maxMinutes: 30, stallMinutes: 5, autoResumes: 2 })).status, 200);
    assert.deepEqual(await sup(b), { supervisor: true, maxMinutes: 30, stallMinutes: 5, autoResumes: 2, source: { supervisor: 'settings', maxMinutes: 'settings', stallMinutes: 'settings', autoResumes: 'settings' } });
    assert.equal((await put(b, { maxMinutes: 0, autoResumes: 0 })).status, 200); assert.deepEqual([(await sup(b)).maxMinutes, (await sup(b)).autoResumes, (await sup(b)).source.maxMinutes], [0, 0, 'settings'], '0 gravado é "settings", não "default"');
    await stop(b); b = await up(data);
    assert.deepEqual(await sup(b), { supervisor: true, maxMinutes: 0, stallMinutes: 5, autoResumes: 0, source: { supervisor: 'settings', maxMinutes: 'settings', stallMinutes: 'settings', autoResumes: 'settings' } }, 'persistido');
    await stop(b); b = await up(data, { ORCH_CYCLE_MAX_MINUTES: '10', ORCH_CYCLE_SUPERVISOR: 'off' });
    assert.deepEqual(await sup(b), { supervisor: false, maxMinutes: 10, stallMinutes: 5, autoResumes: 0, source: { supervisor: 'env', maxMinutes: 'env', stallMinutes: 'settings', autoResumes: 'settings' } }, 'o ambiente vence só nos campos que define');
    const locked = await put(b, { maxMinutes: 20 }); assert.equal(locked.status, 409); assert.match(locked.json.error, /maxMinutes é definido pelo ambiente.*ORCH_CYCLE_/);
    assert.equal((await put(b, { stallMinutes: 2, supervisor: true })).status, 409, 'um campo travado recusa o pedido inteiro'); assert.equal((await sup(b)).stallMinutes, 5);
    assert.equal((await put(b, { stallMinutes: 2 })).status, 200); assert.equal((await sup(b)).stallMinutes, 2);
  } finally { await stop(b); }
  for (const env of [{ ORCH_CYCLE_SUPERVISOR: 'talvez' }, { ORCH_CYCLE_MAX_MINUTES: '1441' }, { ORCH_CYCLE_STALL_MINUTES: 'x' }, { ORCH_CYCLE_AUTO_RESUMES: '3' }]) {
    const { data: d } = world(), bad = await boot(d, env), code = await Promise.race([bad.exited, new Promise((r) => setTimeout(() => r('preso'), 15000))]);
    assert.notEqual(code, 'preso'); assert.notEqual(code, 0, JSON.stringify(env)); assert.match(bad.out(), /ORCH_CYCLE_/); assert.deepEqual(fs.readdirSync(d), [], 'o boot falhou antes de criar qualquer dado');
  }
  assert.equal(stat(), realBefore, 'o banco real não foi tocado');
});

test('FLUXO A — falha recuperável até conclusão verificada, tudo configurado PELA API: o supervisor recomenda retry, a retentativa passa e as decisões ficam gravadas e visíveis', async () => {
  const realBefore = stat(), { data, ws } = world(); let b = await up(data, { E2E_VERIFY_FAILS: '1' });
  try {
    assert.equal((await put(b, { planMode: true, stepRetries: 1, supervisor: true })).status, 200);
    const { id, mission } = await runMission(b, ws);
    assert.equal(mission.cycle.status, 'completed', `${mission.cycle.blockedReason}\n${b.out()}`);
    assert.deepEqual(mission.cycle.supervision.map((e) => [e.round, e.step, e.action, e.code]), [[1, 's1', 'retry', 'R1'], [2, 's1', 'complete', 'verified'], [3, 's2', 'complete', 'verified']]);
    assert.equal(mission.cycle.supervision[0].reason.includes('mecanismo existente'), true); assert.deepEqual(mission.cycle.supervision.map((e) => e.budget.retriesUsed), [0, 1, 1]);
    assert.ok(mission.cycle.supervision.every((e) => /^[0-9a-f]{16}$/.test(e.signature ?? '0123456789abcdef') && e.at && e.reason), 'cada decisão é completa');
    const report = (await call(b, `/api/missions/${id}/delivery`)).json;
    assert.deepEqual([report.state.code, report.assurance.level, report.observed.retriesUsed], ['completed', 'verified', 1]); assert.deepEqual(report.observed.steps.map((s) => [s.id, s.attempts]), [['s1', 2], ['s2', 1]]);
    assert.deepEqual(report.verified.evidence.map((e) => [e.round, e.level]), [[1, 'failed'], [2, 'verified'], [3, 'verified']], 'a supervisão não enfraqueceu a evidência: a conclusão veio dos gates de sempre');
    // reinício: o histórico volta idêntico e nada é refeito
    const before = JSON.stringify(mission.cycle.supervision); await stop(b); b = await up(data, { E2E_VERIFY_FAILS: '1' });
    const again = (await call(b, `/api/missions/${id}`)).json; assert.equal(JSON.stringify(again.cycle.supervision), before); assert.equal(again.cycle.rounds.length, 3); assert.equal(again.cycle.status, 'completed');
  } finally { await stop(b); }
  assert.equal(stat(), realBefore, 'o banco real não foi tocado');
});

test('FLUXO B — falha REPETIDA até o bloqueio: a retentativa falha igual => supervisor_loop, SEM uma terceira execução, nem depois de reiniciar', async () => {
  const realBefore = stat(), { data, ws } = world(); let b = await up(data, { ORCH_CYCLE_PLAN: 'on', ORCH_CYCLE_MAX_STEP_RETRIES: '1', ORCH_CYCLE_SUPERVISOR: 'on', E2E_VERIFY_FAILS: '2' });
  try {
    assert.deepEqual((await sup(b)).source.supervisor, 'env');
    const { id, mission } = await runMission(b, ws);
    assert.equal(mission.cycle.status, 'blocked'); assert.equal(mission.cycle.blockedCode, 'supervisor_loop'); assert.match(mission.cycle.blockedReason, /mesma falha.*rodada 1.*rodada 2/);
    assert.equal(mission.cycle.rounds.length, 2, 'exatamente duas execuções'); assert.deepEqual(mission.cycle.supervision.map((e) => [e.round, e.action, e.code]), [[1, 'retry', 'R1'], [2, 'block', 'supervisor_loop']]);
    assert.equal(mission.cycle.supervision[0].signature, mission.cycle.supervision[1].signature);
    const report = (await call(b, `/api/missions/${id}/delivery`)).json;
    assert.deepEqual([report.state.code, report.state.delivered, report.assurance.level], ['blocked', false, 'not_applicable']); assert.deepEqual(report.observed.steps.map((s) => [s.id, s.status, s.attempts]), [['s1', 'failed', 2], ['s2', 'queued', 0]]);
    assert.deepEqual(report.verified.verifications.map((x) => [x.round, x.status]), [[1, 'fail'], [2, 'fail']]); assert.ok(!fs.existsSync(path.join(ws, 'style.css')), 'a etapa seguinte nunca rodou');
    await new Promise((r) => setTimeout(r, 1500)); assert.equal((await call(b, `/api/missions/${id}`)).json.cycle.rounds.length, 2, 'nada rodou depois do bloqueio');
    const snap = JSON.stringify((await call(b, `/api/missions/${id}`)).json.cycle); await stop(b);
    b = await up(data, { ORCH_CYCLE_PLAN: 'on', ORCH_CYCLE_MAX_STEP_RETRIES: '1', ORCH_CYCLE_SUPERVISOR: 'on', E2E_VERIFY_FAILS: '2' });
    await new Promise((r) => setTimeout(r, 1000)); assert.equal(JSON.stringify((await call(b, `/api/missions/${id}`)).json.cycle), snap, 'a recuperação não alterou o ciclo, não retomou e não executou nada');
  } finally { await stop(b); }
  assert.equal(stat(), realBefore, 'o banco real não foi tocado');
});

// ---------- painel: componente React REAL renderizado (esbuild empacota; react-dom/server renderiza) ----------
test('PAINEL: o histórico de supervisão é renderizado com ação, motivo, observação, assinatura e orçamento; sem decisões não renderiza nada', async () => {
  const esbuild = createRequire(path.join(CLIENT, 'package.json'))('esbuild');
  const entry = `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import Log from './components/SupervisionLog.jsx'; export const render = (entries) => renderToStaticMarkup(React.createElement(Log, { entries }));`;
  const out = await esbuild.build({ stdin: { contents: entry, resolveDir: path.join(CLIENT, 'src'), loader: 'jsx' }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', absWorkingDir: CLIENT, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });
  const file = path.join(root, 'supervision-log-bundle.cjs'); fs.writeFileSync(file, out.outputFiles[0].text);
  const { render } = createRequire(import.meta.url)(file);
  const html = render([
    { at: 'T', round: 1, step: 's1', observation: { kind: 'verificacao_reprovada' }, action: 'retry', code: 'R1', reason: 'Falha recuperável (classe R1) com orçamento', signature: 'abc123def4567890', budget: { retriesUsed: 0, retriesMax: 1, plannerCalls: 1, activeMinutes: 0.5 } },
    { at: 'T', round: 2, step: 's1', observation: { kind: 'falha_repetida', repeatedAtRound: 1 }, action: 'block', code: 'supervisor_loop', reason: 'A mesma falha se repetiu <b>x</b>', signature: 'abc123def4567890', budget: { retriesUsed: 1, retriesMax: 1 } },
    { at: 'T', round: 2, observation: { kind: 'sem_saida', uncertain: true }, action: 'block', code: 'stalled', reason: 'sem saída' }, { at: 'T', round: 3, action: 'resume', code: 'auto_resume', reason: 'Retomada automática 1 de 2', budget: { autoResumes: 0, autoResumesMax: 2 } },
    { at: 'T', round: 4, observation: { kind: 'verificacao_reprovada', trend: 'progress' }, action: 'retry', code: 'R1', reason: 'houve progresso', applied: { state: 'not_applied', by: 'retry_blocker', reason: 'o Git mudou <i>y</i>' } },
    { at: 'T', round: 5, observation: { kind: 'politica_recusada' }, action: 'replan', code: 'policy_refused', reason: 'recusada', applied: { state: 'completed', by: 'planner', result: { decision: 'continue' } } },
  ]);
  assert.match(html, /data-testid="supervision"/); assert.match(html, /supervisão · 6 decisões/); assert.equal((html.match(/data-testid="supervision-entry"/g) || []).length, 6);
  for (const t of ['data-testid="supervision-trend"', 'progresso verificável', 'data-testid="supervision-applied"', 'NÃO aplicada', 'por retry_blocker', 'proposta recusada pela política', 'o Planner decidiu: continue']) assert.ok(html.includes(t), `faltou no painel: ${t}`);
  assert.ok(html.includes('&lt;i&gt;y&lt;/i&gt;') && !html.includes('<i>y</i>'), 'o desfecho também é texto, nunca HTML'); assert.equal((html.match(/data-testid="supervision-applied"/g) || []).length, 2, 'só entradas com desfecho informado');
  for (const t of ['repetir (retentativa)', 'bloquear', 'retomada automática', 'verificação real reprovada', 'falha repetida', 'execução sem saída', '(estado real desconhecido)', 'etapa s1', 'Falha recuperável (classe R1) com orçamento', 'assinatura da falha abc123def4567890', 'retentativas 0/1 · consultas ao Planner 1 · tempo ativo 0.5 min', 'retentativas 1/1', 'retomadas automáticas 0/2']) assert.ok(html.includes(t), `faltou no painel: ${t}`);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), 'o motivo é texto, nunca HTML');
  assert.match(html, /class="status s-blocked"/); assert.match(html, /class="status s-unverified"/); assert.match(html, /class="status s-running"/);
  assert.equal(render([]), ''); assert.equal(render(undefined), ''); assert.equal(render([null, 'x', { action: 5 }]), '', 'entradas malformadas não renderizam nada');
});
