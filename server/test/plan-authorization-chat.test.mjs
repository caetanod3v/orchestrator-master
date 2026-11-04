// Autorização prévia de etapas sensíveis na aprovação do plano — lado do chat: validação, repasse ao ciclo e prévia para a interface. Banco TEMPORÁRIO; ciclo SIMULADO (nenhum processo, nenhum modelo).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-planauth-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const store = await import('../store.js');
const { createChat } = await import('../chat.js');
store.load(); store.saveOrThrow();
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wsDir = path.join(tmp, 'ws'); fs.mkdirSync(wsDir);

const S = (id, over = {}) => ({ id, title: `Etapa ${id}`, instructions: `Crie ${id}.txt com o resultado`, acceptance: [`${id}.txt existe e foi gerado`], expectedFiles: [`${id}.txt`], dependsOn: [], ...over });
const STEPS = [S('ok'), S('sens', { instructions: 'Atualize o Dockerfile', expectedFiles: ['Dockerfile'] }), S('seg', { instructions: 'Adicione FOO ao .env', expectedFiles: ['.env'] }), S('proib', { instructions: 'Faça git push para o remoto' }), S('sobre', { instructions: 'Sobrescreva o index.html', expectedFiles: ['index.html'] })];
function world() {
  const db = { settings: { activeWorkspaceId: 'ws' }, workspaces: [{ id: 'ws', name: 'ws', path: wsDir }], missions: [], chat: { id: 'chat1', messages: [], proposal: { id: 'prop1', status: 'proposed', title: 'Plano', objective: 'obj', steps: STEPS, revision: 1 } } };
  const calls = []; const cycle = { start: async (id, max, opts) => { calls.push({ id, max, opts }); return { status: 202, cycle: {} }; } };
  return { db, calls, chat: createChat({ db, planner: { busy: () => false, decide: async () => ({ error: 'não usado' }) }, cycle, multiStep: true, listFiles: () => [] }) };
}

test('prévia do plano: o servidor diz quais etapas aceitam autorização prévia e por que as outras não', () => {
  const pol = Object.fromEntries(world().chat.view().proposal.policy.map((x) => [x.stepId, x]));
  assert.deepEqual([pol.ok.decision, pol.ok.preAuthorizable], ['allow', false]); assert.deepEqual([pol.sens.decision, pol.sens.preAuthorizable], ['approval_required', true]); assert.deepEqual([pol.sobre.decision, pol.sobre.preAuthorizable], ['approval_required', true]);
  assert.equal(pol.seg.preAuthorizable, false); assert.match(pol.seg.preAuthBlocked, /segredo/); assert.equal(pol.proib.decision, 'deny'); assert.equal(pol.proib.preAuthorizable, false); assert.match(pol.proib.preAuthBlocked, /proibida/);
});

test('aprovar o plano SEM selecionar nada: o ciclo recebe o plano e NENHUMA etapa autorizada', async () => {
  const w = world(), r = await w.chat.approve({ proposalId: 'prop1', maxIterations: 6 }); assert.equal(r.status, 202, r.error);
  assert.equal(w.calls.length, 1); assert.equal('authorizedSteps' in w.calls[0].opts, false); assert.equal(w.calls[0].opts.plan.steps.length, STEPS.length);
});

test('selecionar etapas elegíveis: só elas seguem ao ciclo, exatamente como escolhidas', async () => {
  const w = world(), r = await w.chat.approve({ proposalId: 'prop1', maxIterations: 6, authorizedSteps: ['sens', 'sobre'] }); assert.equal(r.status, 202, r.error); assert.deepEqual(w.calls[0].opts.authorizedSteps, ['sens', 'sobre']);
});

test('etapa inelegível (segredo, deny, sem necessidade), inexistente ou lista inválida: 4xx, a missão NÃO é criada e o ciclo NÃO é chamado; o plano continua pendente', async () => {
  for (const [auth, status, re] of [[['seg'], 409, /segredo/], [['proib'], 409, /proibida pela política/], [['ok'], 409, /não precisa de autorização/], [['sens', 'seg'], 409, /segredo/], [['zzz'], 400, /não existe neste plano/], ['sens', 400, /lista de ids/], [['sens', 'sens'], 400, /sem repetição/], [[7], 400, /lista de ids/]]) {
    const w = world(), r = await w.chat.approve({ proposalId: 'prop1', maxIterations: 6, authorizedSteps: auth }); assert.equal(r.status, status, JSON.stringify(auth)); assert.match(r.error, re); assert.equal(w.calls.length, 0); assert.equal(w.db.missions.length, 0); assert.equal(w.db.chat.proposal.status, 'proposed');
  }
  const w = world(); w.db.chat.proposal.steps = undefined; const r = await w.chat.approve({ proposalId: 'prop1', maxIterations: 6, authorizedSteps: ['sens'] }); assert.equal(r.status, 400); assert.match(r.error, /não tem etapas/); assert.equal(w.calls.length, 0);
});

test('o ciclo recusa (nada iniciado): a missão criada é desfeita e o plano volta a "proposed" (falha segura)', async () => {
  const w = world(); w.chat = createChat({ db: w.db, planner: { busy: () => false }, cycle: { start: async () => ({ status: 409, error: 'recusado pelo ciclo' }) }, multiStep: true, listFiles: () => [] });
  const r = await w.chat.approve({ proposalId: 'prop1', maxIterations: 6, authorizedSteps: ['sens'] }); assert.equal(r.status, 409); assert.equal(w.db.missions.length, 0); assert.equal(w.db.chat.proposal.status, 'proposed');
});
