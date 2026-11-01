// Marco A, I2: relatório de entrega na interface. A lógica de apresentação (client/src/delivery-view.js) é PURA e é testada aqui com relatórios gerados pelo
// buildDelivery REAL do servidor (o contrato verdadeiro, não um molde inventado). Sem banco real, sem rede, sem processos.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ORCH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-deliv-view-')); // delivery.js -> cycle.js -> store.js: nunca os dados reais
after(() => fs.rmSync(process.env.ORCH_DATA_DIR, { recursive: true, force: true }));
const { buildDelivery } = await import('../delivery.js');
const { deliveryView, deliveryKey, createDeliveryLoader, attemptsText, retriesText, orchestrationNote } = await import('../../client/src/delivery-view.js');

// ---------- fixtures (formato gravado pelo servidor) ----------
const REAL_PASS = { id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null };
const EV = (level, over = {}) => ({ level, basis: level === 'verified' ? 'real_verification' : 'executor_claim_only', reasons: level === 'verified' ? [] : ['motivo gravado'], executorClaim: { status: 'success', pass: 1, fail: 0, notRun: 0, note: 'x' }, system: { verification: level === 'verified' ? 'passed' : 'failed', verifications: [], expectedFiles: null, integrity: 'clean', ...over } });
const rep = (level) => ({ status: 'success', summary: 's', filesChanged: [], filesKnown: true, checks: [], checksReported: true, errors: [], blockers: [], exitCode: 0, usage: null, verifications: [level === 'verified' ? REAL_PASS : { ...REAL_PASS, status: 'fail', exitCode: 1, reason: 'Terminou com código 1' }], verificationsSkipped: null, verificationsInterrupted: null, evidence: EV(level) });
const rnd = (n, planId, stepId, level = 'verified') => ({ n, status: 'succeeded', phase: 'done', taskId: `t${n}`, agent: 'code', ...(planId ? { planId, stepId } : {}), plan: { title: `Rodada ${n}`, rationale: 'r' }, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', report: rep(level), verification: level === 'verified' ? 'passed' : 'failed', decision: null });
const stp = (id, deps = []) => ({ id, title: `Etapa ${id}`, dependsOn: deps });
const cyc = (status, rounds, plan, over = {}) => ({ id: 'cy1', status, maxIterations: 8, rounds, plannerCalls: 1, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null, finalSummary: null, evidence: null, startedAt: 'A', finishedAt: status === 'completed' ? 'B' : null, ...(plan ? { plan } : {}), ...over });
const mis = (cycle, over = {}) => ({ id: 'mx', demo: false, title: 'Missão X', objective: 'obj', workspaceId: 'w', createdAt: 'T0', tasks: [], cycle, ...over });
const WS = { id: 'w', name: 'w', verifications: [{ script: 'test', required: true }] };
const delivery = (cycle, over) => JSON.parse(JSON.stringify(buildDelivery(mis(cycle, over), WS))); // passa pelo JSON, como na rede
const view = (cycle, over) => deliveryView(delivery(cycle, over));
const done = () => cyc('completed', [rnd(1, 'pl', 'a'), rnd(2, 'pl', 'b')], { id: 'pl', steps: [stp('a'), stp('b', ['a'])] }, { finalSummary: 'tudo certo', evidence: ['ok'] });

// ---------- apresentação ----------
test('relatório COMPLETO e verificado: concluída, garantia comprovada, etapas, evidências e verificações do contrato real', () => {
  const v = view(done());
  assert.deepEqual([v.headline.value, v.headline.label, v.headline.delivered], ['completed', 'Concluída', true]);
  assert.deepEqual([v.assurance.value, v.assurance.label, v.assurance.level], ['verified', 'Comprovada pelo sistema', 'verified']); assert.equal(v.notice, null);
  assert.deepEqual(v.steps.map((s) => [s.id, s.status, s.attempts, s.attemptsText, s.executed]), [['a', 'completed', 1, '1 tentativa', true], ['b', 'completed', 1, '1 tentativa', true]]);
  assert.equal(v.retries.used, 0); assert.equal(v.retries.text, 'Nenhuma retentativa automática neste ciclo.');
  assert.deepEqual(v.evidence.map((e) => [e.round, e.value, e.label]), [[1, 'verified', 'comprovada'], [2, 'verified', 'comprovada']]);
  assert.deepEqual(v.verifications.map((x) => [x.round, x.script, x.status, x.label, x.required, x.pass]), [[1, 'test', 'pass', 'passou', true, true], [2, 'test', 'pass', 'passou', true, true]]);
  assert.deepEqual([v.rounds, v.maxIterations], [2, 8]);
  assert.equal(v.hasLimitations, true, 'o fixture não tem o contexto gravado no encerramento: o servidor diz isso e a interface repassa');
  assert.deepEqual(v.limitations.map((l) => l.slice(0, 41)), ['Sem contexto gravado no encerramento do c'], 'a única limitação: nenhuma sobre a garantia');
});

test('relatório COM limitações: elas aparecem inteiras e a conclusão sem comprovação NÃO é apresentada como comprovada', () => {
  const v = view(cyc('completed', [rnd(1, 'pl', 'a', 'inconclusive')], { id: 'pl', steps: [stp('a')] }, { finalSummary: 'x', evidence: ['y'] }));
  assert.equal(v.headline.value, 'completed'); assert.equal(v.assurance.value, 'unverified'); assert.equal(v.assurance.label, 'Não comprovada');
  assert.equal(v.hasLimitations, true); assert.ok(v.limitations.some((l) => /Conclusão SEM garantia verificada/.test(l)), v.limitations.join('|')); assert.ok(v.assurance.reasons.some((r) => /inconclusiva/.test(r)));
  assert.match(v.notice, /SEM comprovação independente do sistema/); assert.deepEqual(v.evidence.map((e) => e.value), ['inconclusive']);
});

test('estados que NÃO são entrega: bloqueada, cancelada, limite, em andamento e falha nunca aparecem como concluídos', () => {
  const P = { id: 'pl', steps: [stp('a')] };
  const blocked = view(cyc('blocked', [rnd(1, 'pl', 'a', 'failed')], P, { blockedCode: 'planner_blocked', blockedReason: 'preciso de ajuda' }));
  assert.deepEqual([blocked.headline.value, blocked.headline.delivered, blocked.assurance.value], ['blocked', false, 'idle']); assert.match(blocked.reasons.join(' '), /planner_blocked/); assert.equal(blocked.notice, 'Não é uma entrega concluída.');
  assert.equal(blocked.steps[0].status, 'failed'); assert.equal(blocked.evidence[0].value, 'failed'); assert.equal(blocked.verifications[0].pass, false); assert.equal(blocked.verifications[0].label, 'falhou');
  assert.equal(view(cyc('cancelled', [rnd(1, 'pl', 'a')], P)).headline.value, 'cancelled'); assert.equal(view(cyc('limit_reached', [rnd(1, 'pl', 'a')], P)).headline.value, 'limit_reached');
  const run = view(cyc('running', [rnd(1, 'pl', 'a')], P)); assert.deepEqual([run.headline.value, run.headline.label, run.notice], ['running', 'Em andamento', null]);
  for (const x of [blocked, run]) assert.notEqual(x.headline.delivered, true);
  const nc = deliveryView(delivery(undefined)); assert.deepEqual([nc.headline.value, nc.headline.label, nc.headline.delivered], ['idle', 'Sem ciclo autônomo', false]);
});

test('tentativas e retentativas: contagem do contrato real, com texto correto para 0, 1, 2 e 3 tentativas', () => {
  const v = view(cyc('completed', [rnd(1, 'pl', 'a', 'failed'), rnd(2, 'pl', 'a', 'failed'), rnd(3, 'pl', 'a'), rnd(4, 'pl', 'b', 'failed'), rnd(5, 'pl', 'b')], { id: 'pl', steps: [stp('a'), stp('b', ['a']), stp('c', ['b'])] }, { finalSummary: 'x', evidence: ['y'] }));
  assert.deepEqual(v.steps.map((s) => [s.id, s.attempts, s.retries, s.attemptsText]), [['a', 3, 2, '3 tentativas (2 retentativas)'], ['b', 2, 1, '2 tentativas (1 retentativa)'], ['c', 0, 0, 'não executada']]);
  assert.equal(v.retries.used, 3); assert.equal(v.retries.text, '3 retentativas automáticas usadas neste ciclo.'); assert.equal(v.steps[2].executed, false);
  assert.equal(view(cyc('completed', [rnd(1, 'pl', 'a', 'failed'), rnd(2, 'pl', 'a')], { id: 'pl', steps: [stp('a')] })).retries.text, '1 retentativa automática usada neste ciclo.');
  assert.equal(attemptsText(1), '1 tentativa'); assert.equal(attemptsText(0), 'não executada'); assert.equal(retriesText(0), 'Nenhuma retentativa automática neste ciclo.');
});

test('servidor mais antigo / dado ausente: "não informado", nunca zero nem sucesso presumido', () => {
  const d = delivery(done()); delete d.observed.retriesUsed; d.observed.steps.forEach((s) => delete s.attempts); delete d.assurance;
  const v = deliveryView(d);
  assert.equal(v.retries.used, null); assert.equal(v.retries.text, 'retentativas automáticas: não informado pelo servidor'); assert.deepEqual(v.steps.map((s) => [s.attempts, s.attemptsText, s.retries]), [[null, 'tentativas: não informado', 0], [null, 'tentativas: não informado', 0]]);
  assert.equal(v.assurance.value, 'unverified', 'sem garantia informada = NÃO comprovada'); assert.equal(v.assurance.label, 'Não comprovada'); assert.match(v.notice, /SEM comprovação/);
  for (const bad of [-1, 1.5, '2', NaN, null]) assert.equal(attemptsText(bad), 'tentativas: não informado', String(bad));
  const d2 = delivery(done()); d2.assurance.level = 'inventado'; assert.equal(deliveryView(d2).assurance.value, 'unverified', 'nível desconhecido nunca vira comprovado');
  const d3 = delivery(done()); d3.state.code = 'inventado'; assert.deepEqual([deliveryView(d3).headline.value, deliveryView(d3).headline.delivered], ['failed', false]);
});

test('ausência e dado malformado: null / sem estado => sem modelo; listas inválidas viram vazias; nada lança', () => {
  for (const bad of [null, undefined, 7, 'x', [], {}, { state: null }]) assert.equal(deliveryView(bad), null, JSON.stringify(bad));
  const v = deliveryView({ state: { code: 'blocked', reasons: [7, 'motivo', ''] }, observed: { steps: [null, 'x', { id: 's', title: 't', status: 'queued' }] }, verified: { evidence: [null, { round: 1, level: 'estranho' }], verifications: 'não é lista' }, limitations: [null, 'limite real', 3] });
  assert.deepEqual(v.reasons, ['motivo']); assert.deepEqual(v.limitations, ['limite real']); assert.deepEqual(v.steps.map((s) => s.id), ['s']); assert.deepEqual(v.evidence.map((e) => [e.value, e.label]), [['idle', 'sem parecer']]); assert.deepEqual(v.verifications, []);
  assert.equal(v.assurance.value, 'unverified');
});

test('configuração de orquestração (/api/state.orchestration) em uma frase; ausente => null', () => {
  assert.equal(orchestrationNote({ planMode: false, stepRetries: 0, maxStepAttempts: 3, hardMaxIterations: 10 }), 'Plano em várias etapas: desligado (o Planner decide uma tarefa por vez); reparo automático de etapas: desligado.');
  assert.equal(orchestrationNote({ planMode: true, stepRetries: 2, maxStepAttempts: 3, hardMaxIterations: 10 }), 'Plano em várias etapas: ligado; reparo automático de etapas: ligado (até 2 retentativas por ciclo; até 3 tentativas por etapa).');
  assert.match(orchestrationNote({ planMode: true, stepRetries: 1, maxStepAttempts: 3 }), /até 1 retentativa por ciclo/);
  for (const bad of [undefined, null, {}, { planMode: 'on', stepRetries: 1 }, { planMode: true, stepRetries: 'x' }]) assert.equal(orchestrationNote(bad), null);
});

// ---------- quando recarregar ----------
test('deliveryKey: muda quando o relatório pode ter mudado e só então', () => {
  const base = () => mis(cyc('blocked', [rnd(1, 'pl', 'a', 'failed')], { id: 'pl', steps: [{ ...stp('a'), status: 'failed', round: 1 }] }, { blockedCode: 'planner_blocked' }));
  const k0 = deliveryKey(base()); assert.equal(typeof k0, 'string'); assert.equal(deliveryKey(base()), k0, 'determinística');
  const changed = (fn) => { const m = base(); fn(m); return deliveryKey(m); };
  for (const [label, fn] of [
    ['estado do ciclo (retomada)', (m) => { m.cycle.status = 'running'; }], ['código de bloqueio', (m) => { m.cycle.blockedCode = 'no_progress'; }], ['nova rodada (retentativa)', (m) => { m.cycle.rounds.push(rnd(2, 'pl', 'a')); }],
    ['fase da última rodada', (m) => { m.cycle.rounds[0].phase = 'verifying'; }], ['resultado da verificação', (m) => { m.cycle.rounds[0].verification = 'passed'; }], ['nível da evidência', (m) => { m.cycle.rounds[0].report.evidence.level = 'verified'; }],
    ['estado da etapa', (m) => { m.cycle.plan.steps[0].status = 'completed'; }], ['conclusão', (m) => { m.cycle.status = 'completed'; m.cycle.finishedAt = 'B'; }], ['aceitação humana', (m) => { m.cycle.acceptance = { at: 'T' }; }],
    ['revisão de integridade', (m) => { m.cycle.integrity = { pending: [{ path: 't' }] }; }], ['aprovação decidida', (m) => { m.cycle.approvals = [{ status: 'approved' }]; }], ['novo ciclo', (m) => { m.cycle.id = 'cy2'; }],
    ['re-verificação', (m) => { m.cycle.rounds[0].report.reverifiedAt = 'T'; }], ['outra missão', (m) => { m.id = 'my'; }],
  ]) assert.notEqual(changed(fn), k0, label);
  for (const [label, fn] of [
    ['linhas de log da tarefa', (m) => { m.tasks = [{ id: 't', status: 'running', log: ['a', 'b'], logTotal: 2 }]; }], ['uso de tokens', (m) => { m.cycle.plannerUsage = [{ call: 1 }]; }], ['contador de consultas', (m) => { m.cycle.plannerCalls = 9; }],
    ['título da missão', (m) => { m.title = 'outro'; }],
  ]) assert.equal(changed(fn), k0, `${label} não deve disparar nova requisição`);
  assert.equal(deliveryKey(null), null); assert.equal(deliveryKey({}), null); assert.equal(deliveryKey({ id: 'a' }) !== deliveryKey({ id: 'a', tasks: [{ id: 't', status: 'queued' }] }), true, 'sem ciclo, as tarefas manuais contam');
});

// ---------- carregador ----------
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
function harness() {
  const calls = [], defs = [], states = [];
  const loader = createDeliveryLoader({ fetchReport: (id) => { calls.push(id); const d = deferred(); defs.push(d); return d.p; }, onChange: (s) => states.push(s) });
  return { loader, calls, defs, states };
}
const tick = () => new Promise((r) => setImmediate(r));

test('carregador: carregando -> pronto; a mesma missão com a mesma chave NÃO é pedida de novo; chave nova pede, force pede', async () => {
  const h = harness();
  const p1 = h.loader.load('A', 'k1'); assert.equal(h.loader.state.status, 'loading'); assert.equal(h.loader.state.report, null); assert.deepEqual(h.calls, ['A']);
  await h.loader.load('A', 'k1'); assert.deepEqual(h.calls, ['A'], 'em andamento: sem requisição repetida');
  h.defs[0].resolve({ n: 1 }); await p1; assert.deepEqual([h.loader.state.status, h.loader.state.report, h.loader.state.missionId], ['ready', { n: 1 }, 'A']);
  await h.loader.load('A', 'k1'); assert.deepEqual(h.calls, ['A'], 'pronto com a mesma chave: sem requisição repetida');
  const p2 = h.loader.load('A', 'k2'); assert.deepEqual(h.calls, ['A', 'A'], 'a chave mudou (ciclo avançou): relê');
  assert.deepEqual([h.loader.state.status, h.loader.state.report], ['loading', { n: 1 }], 'mesma missão: mantém o relatório anterior enquanto atualiza');
  h.defs[1].resolve({ n: 2 }); await p2; assert.deepEqual(h.loader.state.report, { n: 2 });
  const p3 = h.loader.load('A', 'k2', { force: true }); assert.equal(h.calls.length, 3, 'force relê'); h.defs[2].resolve({ n: 3 }); await p3; assert.deepEqual(h.loader.state.report, { n: 3 });
});

test('carregador: TROCA de missão não mistura relatórios — o antigo some na hora e uma resposta atrasada da missão anterior é descartada', async () => {
  const h = harness();
  const pa = h.loader.load('A', 'ka'); h.defs[0].resolve({ de: 'A' }); await pa;
  const pb = h.loader.load('B', 'kb'); assert.deepEqual([h.loader.state.missionId, h.loader.state.status, h.loader.state.report], ['B', 'loading', null], 'o relatório de A não aparece em B');
  const pa2 = h.loader.load('A', 'ka2'); assert.equal(h.loader.state.missionId, 'A'); const pb2 = h.loader.load('B', 'kb'); // volta para B antes de qualquer resposta
  h.defs[2].resolve({ de: 'A-atrasado' }); await pa2; assert.equal(h.loader.state.missionId, 'B'); assert.equal(h.loader.state.report, null, 'resposta atrasada de A não sobrescreve B');
  h.defs[1].resolve({ de: 'B-velho' }); await pb; assert.equal(h.loader.state.report, null, 'resposta mais antiga de B também é descartada');
  h.defs[3].resolve({ de: 'B' }); await pb2; assert.deepEqual([h.loader.state.missionId, h.loader.state.status, h.loader.state.report], ['B', 'ready', { de: 'B' }]);
  assert.deepEqual(h.states.filter((s) => s.status === 'ready').map((s) => [s.missionId, s.report.de]), [['A', 'A'], ['B', 'B']], 'nunca houve um estado pronto com relatório da outra missão');
});

test('carregador: erro da API aparece como erro (sem relatório velho) e a nova tentativa recupera; resposta vazia é "ausente"', async () => {
  const h = harness();
  const p = h.loader.load('A', 'k1'); h.defs[0].reject(new Error('Erro 500')); await p;
  assert.deepEqual([h.loader.state.status, h.loader.state.error, h.loader.state.report], ['error', 'Erro 500', null]);
  const q = h.loader.load('A', 'k1', { force: true }); assert.equal(h.loader.state.status, 'loading'); h.defs[1].resolve({ ok: 1 }); await q; assert.deepEqual([h.loader.state.status, h.loader.state.error], ['ready', null]);
  const r = h.loader.load('A', 'k2'); h.defs[2].reject(new Error('rede caiu')); await r; assert.deepEqual([h.loader.state.status, h.loader.state.report], ['error', null], 'falha na atualização não deixa o relatório anterior passar por atual');
  const e = h.loader.load('B', 'k'); h.defs[3].resolve(null); await e; assert.deepEqual([h.loader.state.status, h.loader.state.report, h.loader.state.error], ['empty', null, null]);
  const s = h.loader.load('C', 'k'); h.defs[4].resolve('texto'); await s; assert.equal(h.loader.state.status, 'empty', 'resposta que não é um relatório = ausente');
  const t = h.loader.load('D', 'k'); h.defs[5].reject({}); await t; assert.match(h.loader.state.error, /erro desconhecido/);
});

test('carregador: sem missão volta a ocioso; dispose impede qualquer notificação posterior', async () => {
  const h = harness();
  const p = h.loader.load('A', 'k'); await h.loader.load(null, null); assert.equal(h.loader.state.status, 'idle'); h.defs[0].resolve({ a: 1 }); await p; assert.equal(h.loader.state.status, 'idle', 'resposta de antes de ficar sem missão é descartada');
  const q = h.loader.load('A', 'k2'); const n = h.states.length; h.loader.dispose(); h.defs[1].resolve({ a: 2 }); await q; await tick(); assert.equal(h.states.length, n, 'nada é notificado depois do dispose');
  await h.loader.load('A', 'k3'); assert.equal(h.calls.length, 2, 'depois do dispose nada é pedido');
});

test('atualização após mudança relevante: a sequência real do ciclo (iniciar -> falha -> retentativa -> conclusão) relê o relatório a cada passo e só nele', async () => {
  const h = harness(); const P = { id: 'pl', steps: [{ ...stp('a') }] };
  const steps = [
    mis(cyc('planning', [], P)), mis(cyc('running', [rnd(1, 'pl', 'a', 'failed')], P)), mis(cyc('running', [rnd(1, 'pl', 'a', 'failed'), rnd(2, 'pl', 'a')], P)),
    mis(cyc('completed', [rnd(1, 'pl', 'a', 'failed'), rnd(2, 'pl', 'a')], P, { finalSummary: 'x', evidence: ['y'] })),
  ];
  let i = 0;
  for (const m of steps) {
    const k = deliveryKey(m); const before = h.calls.length;
    const p = h.loader.load(m.id, k); await h.loader.load(m.id, deliveryKey({ ...m, title: 'ruído', tasks: [{ id: 'x', status: 'running', log: [`l${i}`] }] })); // ruído: mesma chave, nenhuma requisição extra
    assert.equal(h.calls.length, before + 1, `passo ${i}: exatamente uma leitura`); h.defs[h.calls.length - 1].resolve(delivery(m.cycle)); await p; i++;
  }
  const final = deliveryView(h.loader.state.report);
  assert.deepEqual([final.headline.value, final.assurance.value, final.retries.used, final.steps[0].attempts], ['completed', 'verified', 1, 2]);
});
