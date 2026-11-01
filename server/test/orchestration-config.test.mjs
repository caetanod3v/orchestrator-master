// I4 (Marco A): configuração de planejamento e retentativas. (1) precedência ambiente > configurações > padrão; (2) módulo puro da interface; (3) leitura a cada mensagem do chat e a cada
// laço do ciclo (em processo, executor = CLI falsa, Planner e verificador SIMULADOS). Banco e workspace TEMPORÁRIOS. Nenhum modelo é chamado; os dados reais não são tocados.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-orchcfg-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir); execFileSync('git', ['init', '-q'], { cwd: wsDir });
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createCycle } = await import('../cycle.js');
const { createChat } = await import('../chat.js');
const { resolveOrchestration, MAX_STEP_RETRIES } = await import('../plan.js');
const view = await import('../../client/src/orchestration-view.js');

let db, executor, startTaskRun, seq = 0, verCalls = 0, verFail = () => false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(() => {
  db = store.load(); db.missions = []; db.workspaces = [{ id: 'ws', name: 'barbearia', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 60000 }] }]; db.settings.activeWorkspaceId = 'ws'; store.saveOrThrow();
  executor = createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [] });
  ({ startTaskRun } = setupExecution(express(), { db, executor }));
});
after(async () => { await sleep(500); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- 1. precedência ----------
test('resolveOrchestration: padrão tudo desligado; configurações valem sem ambiente; o ambiente vence; origem por campo', () => {
  assert.deepEqual(resolveOrchestration({ env: {}, settings: {} }), { planMode: false, stepRetries: 0, source: { planMode: 'default', stepRetries: 'default' } });
  assert.deepEqual(resolveOrchestration({ env: {} }), { planMode: false, stepRetries: 0, source: { planMode: 'default', stepRetries: 'default' } }, 'sem settings');
  assert.deepEqual(resolveOrchestration({ env: {}, settings: { planMode: true, stepRetries: 2 } }), { planMode: true, stepRetries: 2, source: { planMode: 'settings', stepRetries: 'settings' } });
  assert.deepEqual(resolveOrchestration({ env: {}, settings: { planMode: false, stepRetries: 0 } }).source, { planMode: 'settings', stepRetries: 'settings' }, 'false e 0 gravados são "settings", não "default"');
  // ambiente > configurações, campo a campo
  assert.deepEqual(resolveOrchestration({ env: { ORCH_CYCLE_PLAN: 'off' }, settings: { planMode: true, stepRetries: 2 } }), { planMode: false, stepRetries: 2, source: { planMode: 'env', stepRetries: 'settings' } });
  assert.deepEqual(resolveOrchestration({ env: { ORCH_CYCLE_MAX_STEP_RETRIES: '0' }, settings: { planMode: true, stepRetries: 2 } }), { planMode: true, stepRetries: 0, source: { planMode: 'settings', stepRetries: 'env' } }, '"0" no ambiente também é ambiente');
  assert.deepEqual(resolveOrchestration({ env: { ORCH_CYCLE_PLAN: 'on', ORCH_CYCLE_MAX_STEP_RETRIES: '1' }, settings: { planMode: false, stepRetries: 2 } }), { planMode: true, stepRetries: 1, source: { planMode: 'env', stepRetries: 'env' } });
  assert.deepEqual(resolveOrchestration({ env: { ORCH_CYCLE_MAX_STEP_RETRIES: 'off' } }).source, { planMode: 'default', stepRetries: 'env' }, '"off" também é ambiente');
  // variável vazia = ausente
  assert.deepEqual(resolveOrchestration({ env: { ORCH_CYCLE_PLAN: '  ', ORCH_CYCLE_MAX_STEP_RETRIES: '' }, settings: { planMode: true } }), { planMode: true, stepRetries: 0, source: { planMode: 'settings', stepRetries: 'default' } });
});

test('resolveOrchestration: ambiente inválido lança Error; configuração persistida inválida (banco editado) é ignorada e vale o padrão', () => {
  for (const env of [{ ORCH_CYCLE_PLAN: 'talvez' }, { ORCH_CYCLE_MAX_STEP_RETRIES: '3' }, { ORCH_CYCLE_MAX_STEP_RETRIES: '-1' }, { ORCH_CYCLE_MAX_STEP_RETRIES: 'x' }]) assert.throws(() => resolveOrchestration({ env, settings: { planMode: true, stepRetries: 1 } }), /ORCH_CYCLE_/, JSON.stringify(env));
  for (const settings of [{ planMode: 'true', stepRetries: 3 }, { planMode: 1, stepRetries: -1 }, { planMode: null, stepRetries: 1.5 }, { stepRetries: '1' }, null, 'x', []]) {
    assert.deepEqual(resolveOrchestration({ env: {}, settings }), { planMode: false, stepRetries: 0, source: { planMode: 'default', stepRetries: 'default' } }, JSON.stringify(settings));
  }
  assert.equal(MAX_STEP_RETRIES, 2);
});

// ---------- 2. interface (módulo puro) ----------
const O = (over = {}, src = {}) => ({ planMode: false, stepRetries: 0, maxStepAttempts: 3, hardMaxIterations: 10, source: { planMode: 'default', stepRetries: 'default', ...src }, ...over });

test('orchestrationForm: valores, origem e desabilitação — ambiente trava o controle com o motivo; ciclo ativo desabilita; sem dado do servidor => null', () => {
  const f = view.orchestrationForm(O());
  assert.deepEqual([f.planMode.value, f.planMode.source, f.planMode.locked, f.planMode.disabled, f.planMode.reason], [false, 'default', false, false, null]); assert.equal(f.planMode.sourceLabel, 'padrão (desligado)');
  assert.deepEqual([f.stepRetries.value, f.stepRetries.disabled], [0, false]); assert.deepEqual(f.warnings, []); assert.equal(f.maxStepAttempts, 3);
  const env = view.orchestrationForm(O({ planMode: true, stepRetries: 1 }, { planMode: 'env' }));
  assert.deepEqual([env.planMode.locked, env.planMode.disabled, env.planMode.sourceLabel], [true, true, 'definido pelo ambiente do servidor']); assert.match(env.planMode.reason, /ORCH_CYCLE_PLAN.*altere o ambiente do servidor e reinicie/);
  assert.deepEqual([env.stepRetries.locked, env.stepRetries.disabled, env.stepRetries.reason], [false, false, null], 'só o campo definido pelo ambiente é travado');
  const set = view.orchestrationForm(O({ planMode: true, stepRetries: 2 }, { planMode: 'settings', stepRetries: 'settings' })); assert.equal(set.stepRetries.sourceLabel, 'definido nas configurações');
  const busy = view.orchestrationForm(O(), { activeCycle: true }); assert.deepEqual([busy.planMode.disabled, busy.stepRetries.disabled, busy.planMode.locked], [true, true, false]); assert.match(busy.planMode.reason, /ciclo em andamento/);
  const both = view.orchestrationForm(O({}, { planMode: 'env' }), { activeCycle: true }); assert.match(both.planMode.reason, /ORCH_CYCLE_PLAN/, 'o ambiente é o motivo principal');
  for (const bad of [undefined, null, {}, { planMode: 'on', stepRetries: 1 }, { planMode: true, stepRetries: 'x' }, []]) assert.equal(view.orchestrationForm(bad), null);
  assert.equal(view.orchestrationForm(O({}, { planMode: 'inventado' })).planMode.source, 'default', 'origem desconhecida nunca vira "ambiente"');
});

test('aviso de configuração sem efeito: retentativas > 0 com o plano desligado; custo e ausência de rollback sempre explicados', () => {
  const w = view.orchestrationForm(O({ planMode: false, stepRetries: 2 }, { stepRetries: 'settings' }));
  assert.equal(w.warnings.length, 1); assert.match(w.warnings[0], /só valem para etapas de um plano.*desligado.*não têm efeito/);
  for (const o of [O({ planMode: true, stepRetries: 2 }), O({ planMode: false, stepRetries: 0 }), O({ planMode: true, stepRetries: 0 })]) assert.deepEqual(view.orchestrationForm(o).warnings, []);
  assert.equal(view.retriesWithoutPlan(O({ planMode: false, stepRetries: 1 })), true); assert.equal(view.retriesWithoutPlan(O({ planMode: true, stepRetries: 1 })), false); assert.equal(view.retriesWithoutPlan(null), false);
  const notes = view.orchestrationForm(O()).notes.join('\n');
  assert.match(notes, /nova execução do Executor.*custo adicionais/); assert.match(notes, /Não existe rollback automático/); assert.match(notes, /um ciclo em andamento não é alterado/);
  assert.deepEqual(view.RETRY_CHOICES, [0, 1, 2]); assert.equal(view.retryChoiceLabel(0), '0 — desligadas (padrão)'); assert.equal(view.retryChoiceLabel(1), '1 retentativa por ciclo'); assert.equal(view.retryChoiceLabel(2), '2 retentativas por ciclo');
  assert.equal(view.hasActiveCycle([{ cycle: { status: 'completed' } }, { cycle: { status: 'blocked' } }, {}]), false, 'bloqueado/terminado não é ativo'); assert.equal(view.hasActiveCycle([{ cycle: { status: 'planning' } }]), true); assert.equal(view.hasActiveCycle([{ cycle: { status: 'running' } }]), true); assert.equal(view.hasActiveCycle(undefined), false);
});

test('tentativa x rodada: a rodada é do ciclo, a tentativa é da etapa ("tentativa k de 3" só com mais de uma rodada na etapa)', () => {
  const R = (n, planId, stepId) => ({ n, planId, stepId });
  const a = view.roundAttempts([R(1, 'p', 'a'), R(2, 'p', 'a'), R(3, 'p', 'b'), R(4, 'p', 'a'), { n: 5 }, null, R(6, 'q', 'a')]);
  assert.deepEqual(a, { 1: { stepId: 'a', attempt: 1, total: 3 }, 2: { stepId: 'a', attempt: 2, total: 3 }, 3: { stepId: 'b', attempt: 1, total: 1 }, 4: { stepId: 'a', attempt: 3, total: 3 }, 6: { stepId: 'a', attempt: 1, total: 1 } }, 'planos diferentes não se misturam; avulsas ficam de fora');
  assert.deepEqual(view.roundAttempts(undefined), {}); assert.equal(view.attemptLabel(2, 3), 'tentativa 2 de 3'); assert.equal(view.attemptLabel(1, undefined), 'tentativa 1 de 3'); assert.equal(view.attemptLabel(2, 0), 'tentativa 2 de 3');
  const plan = { id: 'p' }; assert.equal(view.stepAttempts(plan, [R(1, 'p', 'a'), R(2, 'p', 'a'), R(3, 'q', 'a')], 'a'), 2); assert.equal(view.stepAttempts(plan, [], 'a'), 0); assert.equal(view.stepAttempts(null, [R(1, 'p', 'a')], 'a'), 0);
});

// ---------- 3. chat: lido a cada mensagem ----------
const J = (o) => JSON.stringify(o);
const ctx = () => ({ goal: 'Landing page', confirmed: ['quer uma landing'], assumptions: [], open: [] });
const planReply = () => J({ kind: 'plan', message: 'Plano.', title: 'Landing', objective: 'Criar a landing.', context: ctx(), steps: [{ id: 's1', title: 'Etapa s1', instructions: 'MODE:produce FILE:index.html Criar', acceptance: ['index.html existe'], expectedFiles: ['index.html'], dependsOn: [] }] });
const readyReply = () => J({ kind: 'ready', message: 'Entendi.', title: 'Landing', objective: 'Criar a landing.', context: ctx() });
const scripted = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { calls.push(prompt); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x }; } }; };

test('chat: a configuração é lida a CADA mensagem — a mudança vale só para as próximas e o prompt/validação da mesma mensagem concordam', async () => {
  db.missions = []; delete db.chat; let on = false;
  const planner = scripted([readyReply(), planReply(), planReply(), planReply(), readyReply()]);
  const chat = createChat({ db, planner, cycle: { start: async () => { throw new Error('não deve iniciar'); } }, multiStep: () => on, listFiles: () => [] });
  assert.equal(chat.view().planMode, false);
  const r1 = await chat.message('Quero uma landing page.'); assert.equal(r1.status, 200, r1.error); assert.equal(r1.chat.proposal.kind, 'ready'); assert.match(planner.calls[0], /\{"kind":"ready"/); assert.doesNotMatch(planner.calls[0], /\{"kind":"plan"/);
  on = true; assert.equal(chat.view().planMode, true, 'a visão já reflete a nova configuração');
  const r2 = await chat.message('Quero uma landing page.'); assert.equal(r2.status, 200, r2.error); assert.equal(r2.chat.proposal.kind, 'plan'); assert.equal(r2.chat.proposal.steps.length, 1); assert.match(planner.calls[1], /\{"kind":"plan"/);
  on = false;
  const r3 = await chat.message('Ajuste a landing.'); assert.equal(r3.status, 502, 'com o plano desligado, uma resposta "plan" do Planner é recusada (2 tentativas)'); assert.equal(planner.calls.length, 4); assert.equal(chat.view().proposal.kind, 'plan', 'a proposta anterior não é trocada em silêncio');
  const r4 = await chat.message('Ajuste a landing.'); assert.equal(r4.status, 200, r4.error); assert.equal(r4.chat.proposal.kind, 'ready');
  assert.equal(db.missions.length, 0, 'nenhuma mensagem inicia ciclo');
});

// ---------- 4. ciclo: instantâneo no início de cada laço ----------
const verifier = () => ({ isBusy: () => false, stop: async () => ({ stopped: false }), run: async (w, item) => { verCalls++; const bad = verFail(verCalls); return { id: item.id, script: item.script, required: !!item.required, command: `npm run ${item.script}`, source: 'backend', status: bad ? 'fail' : 'pass', exitCode: bad ? 1 : 0, durationMs: 5, outputTail: bad ? 'falhou' : '', truncated: false, reason: bad ? 'código 1' : null }; } });
const step = (id, file) => ({ id, title: `Etapa ${id}`, instructions: `MODE:produce FILE:${file} ${id}`, acceptance: [`${file} existe e foi gerado nesta etapa`], expectedFiles: [file], dependsOn: [] });
const planAns = (file) => J({ decision: 'plan', rationale: 'um passo', steps: [step('a', file)] });
const done = () => J({ decision: 'complete', rationale: 'ok', evidence: ['verificação real aprovada'] });
const blocked = () => J({ decision: 'blocked', rationale: 'ajuda', blockedReason: 'decisão humana' });
const cycPlanner = (answers) => { const calls = []; return { calls, busy: () => false, cancel: async () => {}, describeTier: () => null, decide: async ({ prompt }) => { calls.push(prompt); const x = answers.shift(); return x === undefined ? { error: 'roteiro acabou' } : { text: x }; } }; };
async function runCycle(planner, conf, { max = 6 } = {}) {
  for (const f of fs.readdirSync(wsDir)) if (f !== '.git') fs.rmSync(path.join(wsDir, f), { recursive: true, force: true });
  const m = { id: `o${++seq}`, demo: false, title: `M${seq}`, objective: 'obj', workspaceId: 'ws', createdAt: 'T0', tasks: [] }; db.missions.push(m);
  const cy = createCycle({ db, executor, planner, startTaskRun, verifier: verifier(), listFiles: () => [], multiStep: conf.multiStep, stepRetries: conf.stepRetries, persistRetryMs: [1] });
  assert.equal((await cy.start(m.id, max)).status, 202); await cy.idle(); return m;
}

test('ciclo: a configuração é um INSTANTÂNEO do laço — mudar no meio NÃO altera a execução em andamento, e o próximo ciclo usa o valor novo', async () => {
  let retries = 1; const conf = { multiStep: () => true, stepRetries: () => retries };
  // ciclo 1: começa com 1 retentativa; o valor é trocado para 0 durante a verificação da 1ª tentativa; a retentativa AINDA acontece
  verCalls = 0; verFail = (k) => { if (k === 1) retries = 0; return k === 1; };
  const m1 = await runCycle(cycPlanner([planAns('a.txt'), done()]), conf);
  assert.equal(m1.cycle.status, 'completed'); assert.equal(m1.cycle.rounds.length, 2, 'a retentativa ocorreu apesar da mudança no meio'); assert.deepEqual(m1.cycle.rounds.map((r) => r.stepId), ['a', 'a']);
  // ciclo 2: o valor atual (0) vale desde o início: a mesma falha NÃO é repetida
  verCalls = 0; verFail = (k) => k === 1;
  const m2 = await runCycle(cycPlanner([planAns('b.txt'), blocked()]), conf);
  assert.equal(m2.cycle.rounds.length, 1, 'sem retentativa'); assert.equal(m2.cycle.blockedCode, 'planner_blocked');
  // ciclo 3: volta a 1 antes de iniciar: vale
  retries = 1; verCalls = 0; verFail = (k) => k === 1;
  const m3 = await runCycle(cycPlanner([planAns('c.txt'), done()]), conf); assert.equal(m3.cycle.status, 'completed'); assert.equal(m3.cycle.rounds.length, 2);
});

test('ciclo: planMode é lido a cada laço — com o modo desligado o prompt do Planner não oferece "plan"; ligado, oferece; valores fixos (booleano/número) continuam funcionando', async () => {
  verCalls = 0; verFail = () => false;
  const pOff = cycPlanner([J({ decision: 'blocked', rationale: 'x', blockedReason: 'y' })]); await runCycle(pOff, { multiStep: () => false, stepRetries: () => 2 });
  assert.doesNotMatch(pOff.calls[0], /"decision":"plan"/);
  const pOn = cycPlanner([J({ decision: 'blocked', rationale: 'x', blockedReason: 'y' })]); await runCycle(pOn, { multiStep: () => true, stepRetries: () => 0 });
  assert.match(pOn.calls[0], /"decision":"plan"/);
  const fixed = cycPlanner([planAns('f.txt'), done()]); verFail = (k) => k === 1;
  const m = await runCycle(fixed, { multiStep: true, stepRetries: 1 }); assert.equal(m.cycle.rounds.length, 2, 'booleano e número fixos (como nos testes antigos) seguem valendo');
  assert.match(fixed.calls[1] ?? '', /POR CICLO/, 'o prompt informa o orçamento de retentativas efetivo');
});
