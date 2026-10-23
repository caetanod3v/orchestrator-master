// Fluxo encadeado, ponta a ponta no backend (sem IA, sem dados reais):
// aprovar "node --test" -> script alterado -> BLOQUEIO real -> restaurar + nova aprovação (PUT) -> retomar
// -> re-verificação aprovada -> prompt efetivamente entregue ao Planner com a linha do tempo correta.
// Verificador, rotas de aprovação, executor/ciclo e persistência são os REAIS; só o npm, o Claude e o Planner são simulados.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-flow-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir);
const pkg = path.join(wsDir, 'package.json');
const setTest = (text) => fs.writeFileSync(pkg, JSON.stringify({ name: 'orchestrator-real-test', version: '1.0.0', scripts: { test: text } }));

const { default: express } = await import('express');
const store = await import('../store.js');
const { createExecutor } = await import('../executor/index.js');
const { setupExecution } = await import('../execution.js');
const { createVerifier, setupVerification } = await import('../verify.js');
const { createCycle } = await import('../cycle.js');

let server;
after(async () => { server?.close(); server?.closeAllConnections?.(); await new Promise((r) => setTimeout(r, 800)); fs.rmSync(tmp, { recursive: true, force: true }); });

const cont = (title) => JSON.stringify({ decision: 'continue', rationale: `plano: ${title}`, task: { title, instructions: `MODE:write ${title}`, acceptance: ['conferir'] } });
const done = () => JSON.stringify({ decision: 'complete', rationale: 'verificações reais aprovadas', evidence: ['test=pass refeito pelo orquestrador'] });
const section = (p, a, b) => p.slice(p.indexOf(a), p.indexOf(b, p.indexOf(a)));

test('alterar -> bloquear -> restaurar e reaprovar -> retomar -> re-verificar: o Planner recebe a linha do tempo correta', async () => {
  const db = store.load();
  db.workspaces = [{ id: 'w1', name: 'Teste', path: wsDir }];
  const verifier = createVerifier({ spawnSpec: (s) => ({ command: process.execPath, args: [path.join(HERE, 'fake-verify.mjs'), s] }) });
  const app = express(); app.use(express.json());
  setupVerification(app, { db, verifier });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const approve = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/workspaces/w1/verifications`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ script: 'test', required: true }] }) })).status;

  setTest('node --test'); assert.equal(await approve(), 200);                  // 1. aprovação humana de "node --test"
  assert.equal(db.workspaces[0].verifications[0].command, 'node --test');
  setTest('node --test --verbose');                                              // 2. o script é alterado depois da aprovação

  const executor = createExecutor({ command: process.execPath, prefixArgs: [path.join(HERE, 'fake-cli.mjs')], args: [] });
  const { startTaskRun } = setupExecution(express(), { db, executor });
  const prompts = [];
  const answers = [cont('Alterar o script'), done()];
  const planner = { busy: () => false, cancel: async () => {}, decide: async ({ prompt }) => { prompts.push(prompt); return { text: answers.shift() }; } };
  const m = { id: 'm1', demo: false, title: 'Teste3', objective: 'Provar que o backend bloqueia a verificação até nova aprovação humana.', workspaceId: 'w1', createdAt: store.now(), tasks: [] };
  db.missions = [m];
  const cy = createCycle({ db, executor, planner, startTaskRun, verifier, listFiles: () => [] });

  assert.equal((await cy.start('m1')).status, 202); await cy.idle();
  const c = m.cycle, rep1 = c.rounds[0].report;                                  // 3. BLOQUEIO real do backend
  assert.equal(c.status, 'blocked'); assert.equal(c.blockedCode, 'verification_blocked');
  assert.equal(rep1.verifications[0].status, 'blocked');
  assert.ok(rep1.verifications[0].reason.includes('aprovado: "node --test" · atual: "node --test --verbose"'), rep1.verifications[0].reason);
  assert.equal(prompts.length, 1, 'o Planner não foi consultado sobre um problema de ambiente');

  setTest('node --test'); assert.equal(await approve(), 200);                    // 4. humano restaura o texto e reaprova
  assert.equal((await cy.resume('m1', { note: 'script restaurado e reaprovado' })).status, 202); await cy.idle();   // 5. retomada

  const rep = c.rounds[0].report;                                                // 6. re-verificação aprovada (processo real do verificador)
  assert.equal(rep.verifications[0].status, 'pass'); assert.equal(rep.verifications[0].exitCode, 0);
  assert.equal(rep.previousVerifications.length, 1); assert.equal(rep.previousVerifications[0].verifications[0].status, 'blocked');
  assert.equal(c.status, 'completed'); assert.equal(c.assurance, 'verified');

  const p = prompts[1];                                                          // 7. prompt EFETIVAMENTE entregue ao Planner
  const hist = section(p, 'HISTÓRICO:', 'ÚLTIMO RELATÓRIO');
  const old = hist.split('\n').filter((l) => /SUBSTITUÍDA/.test(l));
  assert.equal(old.length, 1, 'evidência histórica presente');
  assert.ok(old[0].includes(rep.previousVerifications[0].at), 'datada');
  assert.ok(old[0].includes('test=blocked') && old[0].includes('aprovado: "node --test" · atual: "node --test --verbose"'), 'status e motivo reais');
  assert.ok(old[0].includes('alteração do script detectada pelo backend'), 'atribuição baseada em evidência explícita');
  assert.match(old[0], /é HISTÓRICO, não é a situação atual/);
  assert.ok(hist.includes(`execução terminou em ${c.rounds[0].finishedAt}`) && hist.includes(`foram refeitas em ${rep.reverifiedAt}`), 'linha do tempo com os dois horários');
  assert.ok(new Date(rep.reverifiedAt) > new Date(c.rounds[0].finishedAt));
  const current = hist.split('\n').filter((l) => /verificações REAIS \(executadas/.test(l));
  assert.equal(current.length, 1); assert.match(current[0], /test=pass\(código 0\)/); assert.doesNotMatch(current[0], /blocked|mudou/);
  assert.match(p, /resumo \(fim da rodada/);
  assert.doesNotMatch(section(p, 'ÚLTIMO RELATÓRIO', 'Responda SOMENTE'), /previousVerifications|mudou desde/);
  assert.match(p, /script restaurado e reaprovado/, 'a orientação humana também chega');

  // 8. a regra de segurança segue valendo depois de tudo: nova alteração sem reaprovação volta a bloquear
  setTest('node --test --verbose');
  const again = await verifier.run(db.workspaces[0], db.workspaces[0].verifications[0]);
  assert.equal(again.status, 'blocked');
});
