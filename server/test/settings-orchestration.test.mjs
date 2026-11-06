// I4 (Marco A): configuração de planejamento e retentativas PELA API real. Servidor REAL (server/index.js via orchestration-boot.mjs) em processo filho, SEMPRE com ORCH_DATA_DIR temporário,
// porta livre e workspace temporário com Git; Executor = CLI falsa, Planner e verificador SIMULADOS. O servidor da 4317 e data/db.json não são tocados.
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-settings-'));
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
function boot(data, env = {}) {
  const base = { ...process.env, ORCH_DATA_DIR: data };
  for (const k of Object.keys(base)) if (/^(ORCH_CYCLE_|ORCH_PLANNER_|E2E_)/.test(k)) delete base[k];
  return freePort().then((port) => {
    const child = spawn(process.execPath, [BOOT], { env: { ...base, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
    return { child, out: () => out, exited: new Promise((r) => child.on('exit', (code) => r(code))), base: `http://127.0.0.1:${port}` };
  });
}
const waitUp = async (b) => { for (let i = 0; i < 100; i++) { if (/FORGE API em/.test(b.out())) return true; await Promise.race([new Promise((r) => setTimeout(r, 100)), b.exited]); } return false; };
const up = async (data, env) => { const b = await boot(data, env); assert.ok(await waitUp(b), `servidor não subiu:\n${b.out()}`); return b; };
const stop = async (b) => { b.child.kill(); await b.exited; };
const ORIGIN = 'http://localhost:5173';
async function call(b, p, { method = 'GET', body, origin = method === 'GET' ? undefined : ORIGIN } = {}) {
  const res = await fetch(b.base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const put = (b, body, o) => call(b, '/api/settings', { method: 'PUT', body, ...o });
const orch = async (b) => (await call(b, '/api/state')).json.orchestration;
const DEFAULTS = { planMode: false, stepRetries: 0, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'default', stepRetries: 'default' } };
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

test('padrão: plano e retentativas desligados, origem "default"; as chaves antigas de /api/state.settings continuam e não ganham planMode/stepRetries', async () => {
  const { data } = world(), realBefore = stat(), b = await up(data);
  try {
    assert.deepEqual(await orch(b), DEFAULTS);
    const s = (await call(b, '/api/state')).json.settings; assert.equal(s.cycleHardMax, 10); assert.equal(s.cycleMaxIterations, 5); assert.ok(!('planMode' in s) && !('stepRetries' in s), 'nada é gravado sem o usuário pedir');
    assert.equal((await call(b, '/api/chat')).json.planMode, false, 'o chat também enxerga o padrão');
  } finally { await stop(b); }
  assert.equal(stat(), realBefore, 'o banco real não foi tocado');
});

test('PUT /api/settings: entradas inválidas são recusadas (400) e NADA é aplicado, nem os campos válidos enviados junto', async () => {
  const { data } = world(), b = await up(data);
  try {
    for (const body of [{ planMode: 'on' }, { planMode: 1 }, { planMode: null }, { planMode: 'true' }, { stepRetries: 3 }, { stepRetries: -1 }, { stepRetries: 1.5 }, { stepRetries: '1' }, { stepRetries: null }, { stepRetries: true }, { stepRetries: [1] }, { planMode: true, stepRetries: 9 }, { showDemoData: true, planMode: 'x' }, { showDemoData: true, cycleMaxIterations: 99, planMode: true }]) {
      const r = await put(b, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.json.error, /planMode|stepRetries|cycleMaxIterations/);
    }
    assert.deepEqual(await orch(b), DEFAULTS, 'nenhuma entrada inválida mudou a configuração');
    assert.equal((await call(b, '/api/state')).json.settings.showDemoData, false, 'showDemoData enviado junto com um valor inválido também não foi aplicado');
    for (const [body, want] of [[{ planMode: true }, { planMode: true, stepRetries: 0 }], [{ stepRetries: 2 }, { planMode: true, stepRetries: 2 }], [{ planMode: false, stepRetries: 1 }, { planMode: false, stepRetries: 1 }], [{ stepRetries: 0 }, { planMode: false, stepRetries: 0 }]]) {
      const r = await put(b, body); assert.equal(r.status, 200, JSON.stringify(r.json)); const o = await orch(b); assert.deepEqual([o.planMode, o.stepRetries], [want.planMode, want.stepRetries]);
    }
    assert.deepEqual((await orch(b)).source, { planMode: 'settings', stepRetries: 'settings' }, 'valores gravados explicitamente (inclusive false e 0) têm origem "settings"');
  } finally { await stop(b); }
});

test('proteção de Origin: origem inválida e ausência de Origin em PUT são recusadas (403) e a configuração não muda', async () => {
  const { data } = world(), b = await up(data);
  try {
    const evil = await put(b, { planMode: true }, { origin: 'http://evil.example' }); assert.equal(evil.status, 403); assert.equal(evil.json.error, 'Origem não permitida.');
    const none = await put(b, { stepRetries: 2 }, { origin: null }); assert.equal(none.status, 403); assert.match(none.json.error, /só são aceitas com Origin válido/);
    assert.deepEqual(await orch(b), DEFAULTS);
    assert.equal((await put(b, { planMode: true })).status, 200, 'com a origem da interface a mesma chamada funciona'); assert.equal((await orch(b)).planMode, true);
  } finally { await stop(b); }
});

test('persistência: a configuração gravada sobrevive ao reinício do servidor (mesmo diretório) e continua com origem "settings"', async () => {
  const { data } = world(); let b = await up(data);
  try {
    assert.equal((await put(b, { planMode: true, stepRetries: 2 })).status, 200); await stop(b);
    b = await up(data);
    assert.deepEqual(await orch(b), { planMode: true, stepRetries: 2, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'settings', stepRetries: 'settings' } });
    assert.equal((await call(b, '/api/chat')).json.planMode, true, 'o chat lê a configuração persistida');
  } finally { await stop(b); }
  const disk = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8')); assert.deepEqual([disk.settings.planMode, disk.settings.stepRetries], [true, 2]);
});

test('ambiente > configurações: valores do ambiente travam o campo (409 com o motivo), a configuração gravada fica intacta e volta a valer sem a variável', async () => {
  const { data } = world(); let b = await up(data);
  try {
    assert.equal((await put(b, { planMode: false, stepRetries: 2 })).status, 200); await stop(b);
    b = await up(data, { ORCH_CYCLE_PLAN: 'on' }); // só o plano vem do ambiente
    assert.deepEqual(await orch(b), { planMode: true, stepRetries: 2, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'env', stepRetries: 'settings' } }, 'o ambiente vence só no campo que define');
    const locked = await put(b, { planMode: false }); assert.equal(locked.status, 409); assert.match(locked.json.error, /planMode é definido pelo ambiente/); assert.match(locked.json.error, /ORCH_CYCLE_PLAN/);
    const mixed = await put(b, { planMode: false, stepRetries: 1 }); assert.equal(mixed.status, 409, 'um campo travado recusa o pedido inteiro'); assert.equal((await orch(b)).stepRetries, 2, 'o campo livre enviado junto também não mudou');
    assert.equal((await put(b, { stepRetries: 1 })).status, 200, 'o campo livre continua editável'); assert.equal((await orch(b)).stepRetries, 1);
    assert.equal((await put(b, { planMode: 'x' })).status, 400, 'a validação vem antes do bloqueio por ambiente'); await stop(b);
    b = await up(data, { ORCH_CYCLE_PLAN: 'off', ORCH_CYCLE_MAX_STEP_RETRIES: '0' });
    assert.deepEqual(await orch(b), { planMode: false, stepRetries: 0, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'env', stepRetries: 'env' } }, '"off" e "0" também travam');
    assert.equal((await put(b, { stepRetries: 2 })).status, 409); await stop(b);
    b = await up(data); // sem ambiente: a configuração gravada (plano=false, retentativas=1) volta a valer
    assert.deepEqual(await orch(b), { planMode: false, stepRetries: 1, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'settings', stepRetries: 'settings' } });
  } finally { await stop(b); }
});

test('ambiente inválido continua impedindo o boot antes de tocar em qualquer dado', async () => {
  for (const env of [{ ORCH_CYCLE_PLAN: 'talvez' }, { ORCH_CYCLE_MAX_STEP_RETRIES: '3' }]) {
    const { data } = world(), b = await boot(data, env);
    const code = await Promise.race([b.exited, new Promise((r) => setTimeout(() => r('preso'), 15000))]);
    assert.notEqual(code, 'preso'); assert.notEqual(code, 0, JSON.stringify(env)); assert.match(b.out(), /ORCH_CYCLE_/); assert.deepEqual(fs.readdirSync(data), [], 'nada foi criado no diretório de dados');
  }
});

test('INTEGRAÇÃO: sem nenhuma variável de ambiente, configurar pela API (plano + 1 retentativa), recusar mudanças durante o ciclo (409) e concluir com attempts 2 e retriesUsed 1', async () => {
  const realBefore = stat(), { data, ws } = world(), b = await up(data, { E2E_VERIFY_FAILS: '1', E2E_VERIFY_DELAY_MS: '1500' });
  try {
    assert.deepEqual(await orch(b), DEFAULTS);
    const w = await call(b, '/api/workspaces', { method: 'POST', body: { path: ws } }); assert.equal(w.status, 201);
    assert.equal((await call(b, `/api/workspaces/${w.json.id}/verifications`, { method: 'PUT', body: { items: [{ script: 'test', required: true }] } })).status, 200);
    // com o plano desligado o Planner simulado devolve "plan", que o chat RECUSA: a configuração padrão de fato vale
    const off = await call(b, '/api/chat/message', { method: 'POST', body: { text: 'LANDING page para uma barbearia' } }); assert.equal(off.status, 502, 'plano desligado: a resposta "plan" é recusada');
    assert.equal((await put(b, { planMode: true, stepRetries: 1 })).status, 200);
    assert.deepEqual(await orch(b), { planMode: true, stepRetries: 1, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'settings', stepRetries: 'settings' } });
    // a mudança vale na PRÓXIMA mensagem
    const msg = await call(b, '/api/chat/message', { method: 'POST', body: { text: 'LANDING page para uma barbearia' } }); assert.equal(msg.status, 200, JSON.stringify(msg.json));
    const p = msg.json.proposal; assert.deepEqual(p.steps.map((s) => s.id), ['s1', 's2']);
    const ap = await call(b, '/api/chat/approve', { method: 'POST', body: { proposalId: p.id } }); assert.equal(ap.status, 202, JSON.stringify(ap.json)); const id = ap.json.missionId;
    // ciclo ATIVO (o verificador simulado demora): mudar a configuração é recusado e nada muda
    const during = await put(b, { stepRetries: 0 }); assert.equal(during.status, 409); assert.match(during.json.error, /ciclo em andamento/);
    assert.equal((await put(b, { planMode: false })).status, 409); assert.deepEqual([(await orch(b)).planMode, (await orch(b)).stepRetries], [true, 1]);
    const mission = await until(b, id); assert.equal(mission.cycle.status, 'completed', `${mission.cycle.blockedReason}\n${b.out()}`);
    const report = (await call(b, `/api/missions/${id}/delivery`)).json;
    assert.deepEqual([report.state.code, report.assurance.level], ['completed', 'verified']);
    assert.deepEqual(report.observed.steps.map((s) => [s.id, s.status, s.attempts]), [['s1', 'completed', 2], ['s2', 'completed', 1]]); assert.equal(report.observed.retriesUsed, 1);
    assert.deepEqual(report.verified.verifications.map((x) => [x.round, x.status]), [[1, 'fail'], [2, 'pass'], [3, 'pass']]);
    assert.deepEqual(mission.cycle.rounds.map((r) => [r.n, r.stepId]), [[1, 's1'], [2, 's1'], [3, 's2']], 'a rodada (n) é do ciclo; a tentativa é a posição entre as rodadas da etapa');
    // terminado o ciclo, a configuração volta a poder ser mudada
    assert.equal((await put(b, { stepRetries: 0 })).status, 200); assert.equal((await orch(b)).stepRetries, 0);
  } finally { await stop(b); }
  assert.equal(stat(), realBefore, 'o banco real (data/db.json) não foi tocado');
});

test('persistência atômica: se o banco não pode ser gravado, o PUT responde 500, NADA muda (nem na memória) e, com o disco de volta, a mesma chamada funciona e é gravada', async () => {
  const { data } = world(), b = await up(data), blocker = path.join(data, 'db.json.tmp');
  try {
    assert.equal((await put(b, { stepRetries: 2 })).status, 200); // estado anterior conhecido: stepRetries 2 gravado
    fs.mkdirSync(blocker); // um DIRETÓRIO no lugar do arquivo temporário: a gravação falha com erro real (EISDIR)
    const r = await put(b, { planMode: true, stepRetries: 1, showDemoData: true, cycleMaxIterations: 7 });
    assert.equal(r.status, 500); assert.match(r.json.error, /NÃO foram salvas/);
    const o = await orch(b); assert.deepEqual([o.planMode, o.stepRetries, o.source.planMode, o.source.stepRetries], [false, 2, 'default', 'settings'], 'a memória voltou ao estado anterior');
    const s = (await call(b, '/api/state')).json.settings; assert.equal(s.showDemoData, false); assert.equal(s.cycleMaxIterations, 5); assert.ok(!('planMode' in s), 'a chave que não existia antes foi removida, não deixada como undefined');
    fs.rmSync(blocker, { recursive: true, force: true });
    assert.equal((await put(b, { planMode: true, stepRetries: 1 })).status, 200); assert.deepEqual([(await orch(b)).planMode, (await orch(b)).stepRetries], [true, 1]);
  } finally { fs.rmSync(blocker, { recursive: true, force: true }); await stop(b); }
  const disk = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8')); assert.deepEqual([disk.settings.planMode, disk.settings.stepRetries], [true, 1], 'o que está no disco é o que o servidor confirmou');
});
