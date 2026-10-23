// Verificações reais do backend: processos SIMULADOS (sem créditos) + um teste com o npm real num projeto temporário.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-verify-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKEV = path.join(HERE, 'fake-verify.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createVerifier, setupVerification, inspectProject, isInside, resolveNpmCli, ALLOWED_SCRIPTS } = await import('../verify.js');

const SCRIPTS = { test: 'echo t', build: 'echo b', lint: 'echo l', typecheck: 'echo c', start: 'node evil.js', postinstall: 'node steal.js' };
const mkProject = (dir, scripts = SCRIPTS) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts })); return dir; };
const wsDir = mkProject(path.join(tmp, 'workspace'));
const item = (script, extra = {}) => ({ id: script, script, command: SCRIPTS[script], required: true, timeoutMs: 20000, ...extra });
const spied = () => { const calls = []; return { calls, spawnSpec: (s) => { calls.push(s); return { command: process.execPath, args: [FAKEV, s] }; } }; };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

before(() => { process.env.ANTHROPIC_API_KEY = 'segredo-que-nao-pode-vazar'; });
after(async () => { delete process.env.ANTHROPIC_API_KEY; await new Promise((r) => setTimeout(r, 500)); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- leitura do projeto -----------------------------------------------------------------
test('inspectProject: só scripts de texto; erros claros', () => {
  const ok = inspectProject(wsDir);
  assert.equal(ok.ok, true); assert.equal(ok.scripts.test, 'echo t');
  const odd = mkProject(path.join(tmp, 'odd'), { test: 'ok', bad: 123, worse: { a: 1 } });
  assert.deepEqual(inspectProject(odd).scripts, { test: 'ok' });
  assert.match(inspectProject(path.join(tmp, 'vazio')).error, /package\.json/);
  fs.mkdirSync(path.join(tmp, 'vazio')); assert.equal(inspectProject(path.join(tmp, 'vazio')).ok, false);
  fs.mkdirSync(path.join(tmp, 'ruim')); fs.writeFileSync(path.join(tmp, 'ruim', 'package.json'), '{nao json');
  assert.match(inspectProject(path.join(tmp, 'ruim')).error, /inválido/);
});

test('isInside: ".." e caminhos absolutos fora da raiz não passam', () => {
  const root = path.join(tmp, 'r');
  assert.equal(isInside(root, path.join(root, 'a', 'b')), true);
  assert.equal(isInside(root, root), false);
  assert.equal(isInside(root, path.join(root, '..', 'x')), false);
  assert.equal(isInside(root, path.join(tmp, 'outro')), false);
  assert.equal(isInside(root, 'C:\\Windows'), false);
});

test('package.json que é link para fora do workspace é recusado (quando o SO permite criar o link)', (t) => {
  const outside = path.join(tmp, 'fora.json'); fs.writeFileSync(outside, '{"scripts":{"test":"rm -rf /"}}');
  const dir = path.join(tmp, 'linkado'); fs.mkdirSync(dir);
  try { fs.symlinkSync(outside, path.join(dir, 'package.json')); } catch { return t.skip('sem permissão para criar symlink neste Windows'); }
  const r = inspectProject(dir);
  assert.equal(r.ok, false); assert.match(r.error, /fora do workspace/);
});

// ---- runner (processo simulado) ---------------------------------------------------------
test('comando permitido com sucesso: evidência real (comando, código, duração, saída)', async () => {
  const s = spied(); const v = createVerifier({ spawnSpec: s.spawnSpec });
  const r = await v.run({ path: wsDir }, item('test'));
  assert.equal(r.status, 'pass'); assert.equal(r.exitCode, 0); assert.equal(r.source, 'backend');
  assert.equal(r.command, 'npm run test'); assert.ok(r.durationMs >= 0 && typeof r.durationMs === 'number');
  assert.match(r.outputTail, /testes ok/);
  assert.ok(same(/CWD=(.*)/.exec(r.outputTail)[1], wsDir), 'cwd fixado ao workspace');
  assert.match(r.outputTail, /KEY=hidden/, 'segredos não vazam para o processo');
  assert.match(r.outputTail, /CI=1/);
  assert.deepEqual(s.calls, ['test']); assert.equal(v.isBusy(), false);
});

test('código de saída diferente de zero: fail, nunca pass', async () => {
  const r = await createVerifier({ spawnSpec: spied().spawnSpec }).run({ path: wsDir }, item('build'));
  assert.equal(r.status, 'fail'); assert.equal(r.exitCode, 2); assert.match(r.outputTail, /build quebrou/); assert.match(r.reason, /código 2/);
});

test('timeout: status "timeout", processo encerrado, lock liberado', async () => {
  const v = createVerifier({ spawnSpec: spied().spawnSpec });
  const t0 = Date.now();
  const r = await v.run({ path: wsDir }, item('lint', { timeoutMs: 1000 }));
  assert.equal(r.status, 'timeout'); assert.match(r.reason, /Tempo máximo/); assert.ok(Date.now() - t0 < 8000);
  assert.equal(v.isBusy(), false);
});

test('cancelamento: stop() encerra o processo e devolve "cancelled"', async () => {
  const v = createVerifier({ spawnSpec: spied().spawnSpec });
  const p = v.run({ path: wsDir }, item('lint'));
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(v.isBusy(), true);
  const s = await v.stop();
  assert.equal(s.stopped, true);
  const r = await p;
  assert.equal(r.status, 'cancelled'); assert.equal(v.isBusy(), false);
  assert.deepEqual(await v.stop(), { stopped: false, detail: 'Nenhuma verificação ativa.' });
});

test('saída excessiva: processo encerrado, "output_limit", cauda limitada', async () => {
  const v = createVerifier({ spawnSpec: spied().spawnSpec, maxOutputBytes: 100_000 });
  const r = await v.run({ path: wsDir }, item('typecheck'));
  assert.equal(r.status, 'output_limit'); assert.ok(r.outputBytes >= 100_000); assert.ok(r.outputTail.length <= 4000); assert.equal(r.truncated, true);
  assert.equal(v.isBusy(), false);
});

test('comando/script não permitido: bloqueado e NENHUM processo é iniciado', async () => {
  const s = spied(); const v = createVerifier({ spawnSpec: s.spawnSpec });
  for (const script of ['start', 'postinstall', 'install', 'test && calc', '../test', 'test;rm -rf', '', undefined, 'TEST', 'test\nstart']) {
    const r = await v.run({ path: wsDir }, { id: 'x', script, command: 'node evil.js', required: true });
    assert.equal(r.status, 'blocked', String(script));
  }
  assert.equal(s.calls.length, 0, 'spawn nunca foi chamado');
});

test('script alterado depois da aprovação humana (ex.: pelo Executor) NÃO roda', async () => {
  const dir = mkProject(path.join(tmp, 'tamper'));
  const s = spied(); const v = createVerifier({ spawnSpec: s.spawnSpec });
  const approved = item('test');
  assert.equal((await v.run({ path: dir }, approved)).status, 'pass');
  mkProject(dir, { ...SCRIPTS, test: 'node -e "require(\'child_process\').exec(\'calc\')"' });
  const r = await v.run({ path: dir }, approved);
  assert.equal(r.status, 'blocked'); assert.match(r.reason, /mudou desde a aprovação/);
  mkProject(dir, { build: 'x' });
  assert.match((await v.run({ path: dir }, approved)).reason, /não existe mais/);
  assert.equal(s.calls.length, 1, 'só a primeira execução (aprovada) iniciou processo');
});

test('cwd e argumentos NÃO podem ser forçados pelo item/agente', async () => {
  const s = spied(); const v = createVerifier({ spawnSpec: s.spawnSpec });
  const evil = { ...item('test'), cwd: 'C:\\Windows', args: ['--prefix', 'C:\\'], env: { X: '1' }, spawnSpec: 'calc.exe', shell: true };
  const r = await v.run({ path: wsDir, cwd: 'C:\\Windows' }, evil);
  assert.equal(r.status, 'pass');
  assert.ok(same(/CWD=(.*)/.exec(r.outputTail)[1], wsDir));
  assert.match(r.outputTail, /ARGS=\["test"\]/, 'argumentos fixos montados pelo servidor');
});

test('workspace inválido ou sem package.json: "error" claro, nunca pass', async () => {
  const s = spied(); const v = createVerifier({ spawnSpec: s.spawnSpec });
  for (const p of [path.join(tmp, 'nao-existe'), 'relativo/x', undefined, tmp + '\\.\\..\\..\\Windows\\nada']) {
    const r = await v.run({ path: p }, item('test'));
    assert.equal(r.status, 'error', String(p));
  }
  fs.mkdirSync(path.join(tmp, 'sempkg'));
  assert.match((await v.run({ path: path.join(tmp, 'sempkg') }, item('test'))).reason, /package\.json/);
  assert.equal(s.calls.length, 0);
});

test('uma verificação por vez', async () => {
  const v = createVerifier({ spawnSpec: spied().spawnSpec });
  const p = v.run({ path: wsDir }, item('lint'));
  await new Promise((r) => setTimeout(r, 400));
  const second = await v.run({ path: wsDir }, item('test'));
  assert.equal(second.status, 'error'); assert.match(second.reason, /em andamento/);
  await v.stop(); await p;
});

test('npm indisponível: "error", nunca pass', async () => {
  const r = await createVerifier({ spawnSpec: () => null }).run({ path: wsDir }, item('test'));
  assert.equal(r.status, 'error'); assert.match(r.reason, /npm/);
});

// ---- npm REAL em projeto temporário (sem créditos de IA) ---------------------------------
test('npm real: pass, fail, cwd correto e hooks pre/post NÃO executam', { skip: !resolveNpmCli() && 'npm não encontrado' }, async () => {
  const dir = path.join(tmp, 'real');
  const S = {
    test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(3)"', lint: 'node -e "console.log(\'CWD=\'+process.cwd())"',
    pretest: 'node -e "require(\'fs\').writeFileSync(\'PRE_RAN\',\'x\')"', typecheck: 'node -e "console.log(process.env.ANTHROPIC_API_KEY||\'sem-chave\')"',
  };
  mkProject(dir, S);
  const v = createVerifier();
  const mk = (script) => ({ id: script, script, command: S[script], required: true, timeoutMs: 60000 });
  const pass = await v.run({ path: dir }, mk('test'));
  assert.equal(pass.status, 'pass', pass.outputTail); assert.equal(pass.exitCode, 0);
  assert.equal(fs.existsSync(path.join(dir, 'PRE_RAN')), false, 'pretest não pode rodar (--ignore-scripts)');
  const fail = await v.run({ path: dir }, mk('build'));
  assert.equal(fail.status, 'fail'); assert.equal(fail.exitCode, 3);
  const cwd = await v.run({ path: dir }, mk('lint'));
  assert.ok(same(/^CWD=(.*)$/m.exec(cwd.outputTail)[1].trim(), dir), cwd.outputTail);
  const env = await v.run({ path: dir }, mk('typecheck'));
  assert.match(env.outputTail, /sem-chave/);
});

// ---- rotas de aprovação humana ----------------------------------------------------------
let server, base, db;
const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
test('rotas: detectar mostra só scripts permitidos; aprovar fixa o texto lido do disco', async () => {
  db = store.load(); db.workspaces.push({ id: 'w1', name: 'w1', path: wsDir }); db.missions = [];
  const app = express(); app.use(express.json());
  setupVerification(app, { db, verifier: createVerifier({ spawnSpec: spied().spawnSpec }) });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = `http://127.0.0.1:${server.address().port}`;
  try {
    const d = await call('GET', '/api/workspaces/w1/verifications');
    assert.deepEqual(d.body.detected.map((x) => x.script), ALLOWED_SCRIPTS.filter((s) => SCRIPTS[s]));
    assert.ok(!d.body.detected.some((x) => ['start', 'postinstall'].includes(x.script)));
    assert.equal((await call('GET', '/api/workspaces/nao/verifications')).status, 404);

    const ok = await call('PUT', '/api/workspaces/w1/verifications', { items: [{ script: 'test', required: true, command: 'rm -rf /', timeoutSec: 30 }, { script: 'build' }] });
    assert.equal(ok.status, 200);
    assert.equal(ok.body[0].command, 'echo t', 'o texto vem do package.json, não do cliente');
    assert.deepEqual(ok.body.map((x) => [x.script, x.required, x.timeoutMs]), [['test', true, 30000], ['build', false, 120000]]);
    assert.ok(db.activity.some((a) => /Verificações reais/.test(a.message)));

    // adulteração depois da aprovação aparece na detecção
    mkProject(wsDir, { ...SCRIPTS, test: 'echo adulterado' });
    const d2 = await call('GET', '/api/workspaces/w1/verifications');
    assert.equal(d2.body.detected.find((x) => x.script === 'test').changedSinceApproval, true);
    mkProject(wsDir, SCRIPTS);
  } finally { /* servidor segue para os próximos testes */ }
});

test('rotas: entradas inválidas são recusadas e nada muda', async () => {
  const before = JSON.stringify(db.workspaces[0].verifications);
  const bad = [
    { items: 'test' }, { items: [{ script: 'start' }] }, { items: [{ script: 'postinstall' }] }, { items: [{ script: '../test' }] },
    { items: [{ script: 'test && calc' }] }, { items: [{ script: 'inexistente' }] }, { items: [{ script: 'test' }, { script: 'test' }] },
    { items: [null] }, { items: [{ script: 'test', timeoutSec: 5 }] }, { items: [{ script: 'test', timeoutSec: 9999 }] }, { items: [{ script: 'test', timeoutSec: '30' }] },
    { items: ['test', 'build', 'lint', 'typecheck', 'x'].map((script) => ({ script })) }, {},
  ];
  for (const b of bad) assert.equal((await call('PUT', '/api/workspaces/w1/verifications', b)).status, 400, JSON.stringify(b).slice(0, 60));
  assert.equal(JSON.stringify(db.workspaces[0].verifications), before);
  assert.equal((await call('PUT', '/api/workspaces/nao/verifications', { items: [] })).status, 404);
});

test('rotas: não altera a lista durante um ciclo ativo; lista vazia remove tudo', async () => {
  db.missions.push({ id: 'm', workspaceId: 'w1', tasks: [], cycle: { status: 'running' } });
  assert.equal((await call('PUT', '/api/workspaces/w1/verifications', { items: [] })).status, 409);
  db.missions = [];
  assert.equal((await call('PUT', '/api/workspaces/w1/verifications', { items: [] })).status, 200);
  assert.deepEqual(db.workspaces[0].verifications, []);
  server.close(); server.closeAllConnections?.();
});
