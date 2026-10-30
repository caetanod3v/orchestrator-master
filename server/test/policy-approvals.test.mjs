// M9: política de execução e aprovações humanas. Banco TEMPORÁRIO, workspace TEMPORÁRIO, CLI FALSA, Planner SIMULADO; nenhum modelo é chamado.
// Arquivo próprio (processo próprio): parte dos testes faz save() lançar de verdade (EISDIR).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-policy-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const DB_FILE = path.join(process.env.ORCH_DATA_DIR, 'db.json'), BLOCK_TMP = `${DB_FILE}.tmp`;
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir }); fs.writeFileSync(path.join(wsDir, 'LEIAME.md'), 'x\n');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle, setupCycle } = await import('../cycle.js');
const { evaluateTask, actionDigest, approvalProblem } = await import('../policy.js');

let db, executor, startTaskRun, seq = 0, execStarts = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'ws', path: wsDir, verifications: [] }];
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  const counted = new Proxy(executor, { get: (t, k) => (k === 'start' ? (o) => { execStarts++; return t.start(o); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  ({ startTaskRun } = setupExecution(express(), { db, executor: counted }));
});
after(async () => { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); await sleep(800); fs.rmSync(tmp, { recursive: true, force: true }); });

const task = (title, instructions, extra = {}) => ({ title, instructions: `MODE:write ${instructions}`, acceptance: ['out.txt existe com o conteúdo conferido'], ...extra });
const cont = (t) => JSON.stringify({ decision: 'continue', rationale: `fazer ${t.title}`, task: t });
const blockedAns = () => JSON.stringify({ decision: 'blocked', rationale: 'preciso de ajuda', blockedReason: 'decisão humana' });
const scripted = (answers, { beforeAnswer = null } = {}) => {
  const calls = [];
  return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); beforeAnswer?.(calls.length); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x }; } };
};
const mkMission = () => { const m = { id: `a${++seq}`, demo: false, title: `Missão A${seq}`, objective: 'obj', workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m); return m; };
const mk = (planner) => createCycle({ db, executor, planner, startTaskRun, verifier: null, listFiles: () => ['LEIAME.md'], multiStep: false, persistRetryMs: [1] });
async function run(answers, opts = {}) {
  const m = mkMission(), planner = scripted(answers, opts), cy = mk(planner), s0 = execStarts;
  assert.equal((await cy.start(m.id, opts.max ?? 5)).status, 202); await cy.idle();
  return { m, c: m.cycle, cy, planner, starts: () => execStarts - s0 };
}
const onDisk = (m) => JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).missions.find((x) => x.id === m.id);
const SENSITIVE = () => cont(task('Adicionar dependência', 'atualize o package.json com a dependência lodash'));

// ---------- classificador ----------
test('política: exemplos de allow, approval_required e deny', () => {
  const ws = { id: 'ws', path: wsDir };
  const dec = (a) => evaluateTask({ acceptance: ['x existe'], expectedFiles: [], ...a }, { workspace: ws }).decision;
  assert.equal(dec({ title: 'Página', instructions: 'Crie index.html com um título', expectedFiles: ['index.html'] }), 'allow');
  assert.equal(dec({ title: 'Deps', instructions: 'Atualize o package.json' }), 'approval_required');
  assert.equal(dec({ title: 'Env', instructions: 'Adicione FOO ao .env' }), 'approval_required');
  assert.equal(dec({ title: 'Env', instructions: 'Documente em .env.example' }), 'allow');
  assert.equal(dec({ title: 'Reescrever', instructions: 'Reescreva do zero o README' }), 'approval_required');
  assert.equal(dec({ title: 'Push', instructions: 'Faça git push para o remoto' }), 'deny');
  assert.equal(dec({ title: 'Instalar', instructions: 'Rode npm install express' }), 'deny');
  assert.equal(dec({ title: 'Fora', instructions: 'Edite C:/Windows/system.ini' }), 'deny');
  assert.equal(dec({ title: 'Git', instructions: 'Altere .git/config' }), 'deny');
  assert.equal(dec({ title: 'Estado', instructions: 'Edite data/db.json' }), 'deny');
  assert.equal(dec({ title: 'Apagar', instructions: 'Apague os arquivos temporários' }), 'deny');
  assert.equal(dec({ title: 'Ok', instructions: 'Edite a.js, não faça commit', expectedFiles: ['a.js'] }), 'allow');
  assert.equal(dec({ title: 'Estranho', instructions: 7 }), 'deny', 'ação que não pode ser classificada nunca é autorizada em silêncio');
});

test('digest: qualquer mudança material (texto, arquivos, agente, etapa, workspace) gera outro valor', () => {
  const ws = { id: 'ws', path: wsDir }, scope = { stepId: 's1', planId: 'p1' };
  const a = { title: 'T', instructions: 'Atualize o package.json', acceptance: ['package.json lista lodash'], expectedFiles: ['package.json'] };
  const d = (x, s = scope, w = ws) => actionDigest(x, w, s, evaluateTask(x, { workspace: w }));
  const base = d(a);
  assert.equal(d({ ...a }), base);
  for (const change of [{ instructions: 'Atualize o package.json e rode npm test' }, { expectedFiles: ['package.json', 'package-lock.json'] }, { title: 'Outro' }, { agent: 'reviewer' }, { acceptance: ['outro critério verificável aqui'] }]) assert.notEqual(d({ ...a, ...change }), base, JSON.stringify(change));
  assert.notEqual(d(a, { stepId: 's2', planId: 'p1' }), base); assert.notEqual(d(a, { stepId: 's1', planId: 'p2' }), base); assert.notEqual(d(a, scope, { id: 'ws', path: `${wsDir}-x` }), base);
});

// ---------- fluxo ----------
test('1. ação permitida prossegue sem aprovação e fica auditada', async () => {
  const { c, starts } = await run([cont(task('Criar arquivo', 'crie out.txt')), blockedAns()]);
  assert.equal(starts(), 1); assert.equal(c.approvals, undefined);
  assert.equal(c.rounds[0].policy.decision, 'allow');
  assert.deepEqual(c.policyLog.map((e) => [e.decision, e.outcome, e.authorizedBy]), [['allow', 'started', 'policy']]);
});

test('2/7/9. ação sensível bloqueia ANTES de executar, persiste e continua pendente (silêncio, retomada e reinício não aprovam)', async () => {
  const { m, c, cy, planner, starts } = await run([SENSITIVE(), blockedAns()]);
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'approval_required'); assert.equal(starts(), 0, 'nada foi executado');
  assert.match(c.blockedReason, /precisa|aprovação/i); assert.match(c.blockedReason, /Nada foi executado/);
  assert.equal(c.approvals.length, 1); const a = c.approvals[0];
  assert.equal(a.status, 'pending'); assert.equal(a.rules[0].id, 'sensitive_files'); assert.ok(a.summary.what && a.summary.why.length && a.summary.impact.length);
  assert.equal(onDisk(m).cycle.approvals[0].status, 'pending', 'a solicitação foi gravada');
  assert.equal((await cy.resume(m.id, {})).status, 409, 'retomar não aprova'); assert.equal(starts(), 0);
  await sleep(150); assert.equal(c.approvals[0].status, 'pending', 'o tempo não aprova');
  const cy2 = mk(scripted([])); cy2.recover(); // reinício: o ciclo bloqueado em aprovação não é tocado
  assert.equal(c.blockedCode, 'approval_required'); assert.equal(c.approvals[0].status, 'pending'); assert.equal(planner.calls.length, 1);
});

test('3. ação proibida nunca é executada, mesmo que o Planner peça; o Planner vê o motivo', async () => {
  const { c, planner, starts } = await run([cont(task('Publicar', 'faça git push para o remoto')), blockedAns()]);
  assert.equal(starts(), 0); assert.equal(c.rounds[0].status, 'failed'); assert.equal(c.rounds[0].taskId, null);
  assert.equal(c.rounds[0].policy.outcome, 'denied'); assert.equal(c.policyLog[0].outcome, 'denied');
  assert.match(planner.calls[1], /Bloqueada pela política/); assert.equal(c.blockedCode, 'planner_blocked');
});

test('4/10. aprovação válida libera só a ação revisada, executa sem nova consulta ao Planner e não se reutiliza', async () => {
  const { m, c, cy, planner, starts } = await run([SENSITIVE(), blockedAns()]);
  const a = c.approvals[0];
  assert.equal(cy.decideApproval(m.id, a.id, { decision: 'approve', digest: 'outro' }).status, 409, 'digest diferente do apresentado');
  assert.equal(cy.decideApproval(m.id, a.id, { decision: 'talvez', digest: a.digest }).status, 400);
  assert.equal(cy.decideApproval(m.id, 'apr_x', { decision: 'approve', digest: a.digest }).status, 404);
  assert.equal(cy.decideApproval(m.id, a.id, { decision: 'approve', digest: a.digest }).status, 200);
  assert.equal(a.status, 'approved'); assert.equal(starts(), 0, 'aprovar não é executar'); assert.equal(a.decidedBy, 'user');
  assert.equal(cy.decideApproval(m.id, a.id, { decision: 'approve', digest: a.digest }).status, 409, 'duplo clique/segunda decisão');
  assert.equal((await cy.resume(m.id, {})).status, 202); await cy.idle();
  assert.equal(starts(), 1); assert.equal(planner.calls.length, 2, 'a ação aprovada rodou sem consultar o Planner de novo');
  assert.equal(a.status, 'consumed'); assert.equal(a.consumedRound, 1);
  assert.equal(c.rounds[0].approvalId, a.id); assert.equal(c.rounds[0].approvalDigest, a.digest); assert.equal(approvalProblem(c), null);
  assert.deepEqual(c.policyLog.map((e) => e.outcome), ['awaiting_approval', 'approved', 'started']);
  assert.equal(c.rounds[0].task ?? undefined, undefined);
  assert.equal(cy.decideApproval(m.id, a.id, { decision: 'approve', digest: a.digest }).status, 409, 'aprovação consumida não é reutilizável');
});

test('5. outra ação não usa a aprovação anterior (digest por ação) e a solicitação adulterada é invalidada', async () => {
  const { m, c, cy, starts } = await run([SENSITIVE(), blockedAns()]);
  const a = c.approvals[0];
  a.action.instructions += ' e também rode npm test'; // adulteração do registro pendente
  assert.equal(cy.decideApproval(m.id, a.id, { decision: 'approve', digest: a.digest }).status, 409);
  assert.equal(a.status, 'void'); assert.equal(starts(), 0);
});

test('6. rejeição impede a execução, avisa o Planner e a ação não se repete', async () => {
  const { m, c, cy, planner, starts } = await run([SENSITIVE(), blockedAns()]);
  const a = c.approvals[0];
  assert.equal(cy.decideApproval(m.id, a.id, { decision: 'reject', digest: a.digest }).status, 200); assert.equal(a.status, 'rejected');
  assert.equal((await cy.resume(m.id, {})).status, 202); await cy.idle();
  assert.equal(starts(), 0); assert.match(planner.calls[1], /Rejeitei a ação/); assert.equal(c.blockedCode, 'planner_blocked');
});

test('registro inconsistente (aprovação consumida sem a rodada, ou o inverso) bloqueia a retomada', async () => {
  const { m, c, cy } = await run([SENSITIVE(), blockedAns()]);
  const a = c.approvals[0]; cy.decideApproval(m.id, a.id, { decision: 'approve', digest: a.digest });
  a.status = 'consumed'; a.consumedRound = 1; // "consumida", mas nenhuma rodada a registra
  assert.match(approvalProblem(c), /incerto/);
  const r = await cy.resume(m.id, {}); assert.equal(r.status, 409); assert.match(r.error, /inconsistente/);
  a.status = 'approved'; delete a.consumedRound;
  c.rounds.push({ n: 1, approvalId: 'apr_zzz', approvalDigest: 'x' }); assert.match(approvalProblem(c), /ausente ou inconsistente/); c.rounds.pop();
});

test('11. cancelar uma aprovação pendente encerra o ciclo e a decisão deixa de valer', async () => {
  const { m, c, cy } = await run([SENSITIVE()]);
  const a = c.approvals[0];
  assert.equal((await cy.cancel(m.id)).status, 200); assert.equal(c.status, 'cancelled');
  assert.equal(cy.decideApproval(m.id, a.id, { decision: 'approve', digest: a.digest }).status, 409);
});

test('limite de rodadas continua valendo: uma etapa negada consome a rodada', async () => {
  const { c } = await run([cont(task('Publicar', 'faça git push')), cont(task('Criar arquivo', 'crie out.txt'))], { max: 1 });
  assert.equal(c.status, 'limit_reached'); assert.equal(c.rounds.length, 1);
});

test('rota HTTP: o estado devolvido é o registrado e a decisão exige o digest', async () => {
  const m = mkMission(), planner = scripted([SENSITIVE(), blockedAns()]), app = express(); app.use(express.json());
  const cy = setupCycle(app, { db, executor, planner, startTaskRun, verifier: null, listFiles: () => [], multiStep: false, persistRetryMs: [1] });
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  const url = (p) => `http://127.0.0.1:${srv.address().port}/api/missions/${m.id}/cycle/${p}`;
  const post = async (p, body) => { const r = await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await post('start', {})).status, 202); await cy.idle();
    const a = m.cycle.approvals[0];
    assert.equal((await post(`approvals/${a.id}`, { decision: 'approve' })).status, 409, 'sem digest');
    const ok = await post(`approvals/${a.id}`, { decision: 'approve', digest: a.digest });
    assert.equal(ok.status, 200); assert.equal(ok.body.approvals[0].status, 'approved'); assert.equal(ok.body.status, 'blocked');
  } finally { await new Promise((r) => srv.close(r)); }
});

// ---------- persistência (por último: força erros reais de gravação) ----------
test('8. sem gravar a solicitação a ação protegida não é executada (persistence_failed)', async () => {
  const { c, starts } = await run([SENSITIVE(), blockedAns()], { beforeAnswer: () => fs.mkdirSync(BLOCK_TMP, { recursive: true }) });
  fs.rmSync(BLOCK_TMP, { recursive: true, force: true });
  assert.equal(c.blockedCode, 'persistence_failed'); assert.equal(starts(), 0); assert.equal(c.approvals, undefined, 'a solicitação não gravada foi desfeita');
});

test('8. falha ao gravar a decisão: 503, continua pendente e nada executa', async () => {
  const { m, c, cy, starts } = await run([SENSITIVE(), blockedAns()]);
  const a = c.approvals[0]; fs.mkdirSync(BLOCK_TMP, { recursive: true });
  try {
    const r = cy.decideApproval(m.id, a.id, { decision: 'approve', digest: a.digest });
    assert.equal(r.status, 503); assert.equal(a.status, 'pending'); assert.equal(a.decidedAt, undefined);
    assert.equal((await cy.resume(m.id, {})).status, 409, 'ainda pendente'); assert.equal(starts(), 0);
  } finally { fs.rmSync(BLOCK_TMP, { recursive: true, force: true }); }
});
