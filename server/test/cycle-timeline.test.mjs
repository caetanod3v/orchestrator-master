// Linha do tempo das verificações no prompt do Planner (regressão da "inconsistência" da missão Teste3).
// Estado-fixture no formato do ciclo real; Planner e verificador SIMULADOS; o prompt analisado é o que createCycle
// efetivamente entrega a planner.decide(). Nenhum dado real é lido ou escrito.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tl-'));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
const wsDir = path.join(tmp, 'workspace'); fs.mkdirSync(wsDir);
const FAKEV = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-verify.mjs');
const store = await import('../store.js');
const { createCycle, isScriptChangeBlock, SCRIPT_CHANGE_REASON } = await import('../cycle.js');
const { createVerifier } = await import('../verify.js');

after(async () => { await new Promise((r) => setTimeout(r, 600)); fs.rmSync(tmp, { recursive: true, force: true }); });

const ROUND_END = '2026-10-23T18:45:52.488Z', REVERIFIED = '2026-10-23T19:56:01.685Z';
const TAMPER_REASON = 'O script mudou desde a aprovação humana (aprovado: "node --test" · atual: "node --test --verbose"); aprove novamente em Workspaces.';
const TAG = 'alteração do script detectada pelo backend';
const verification = (status, extra = {}) => ({ id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status, exitCode: status === 'pass' ? 0 : null, durationMs: 835, outputTail: status === 'pass' ? '> orchestrator-real-test@1.0.0 test\n> node --test\n\n✔ ok' : '', truncated: false, reason: status === 'pass' ? null : TAMPER_REASON, ...extra });
const tamperBlocked = () => verification('blocked');

function fixture(previous) {
  const db = store.load();
  db.workspaces = [{ id: 'ws', name: 'Teste', path: wsDir, verifications: [{ id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 120000 }] }];
  const m = {
    id: 'm1', demo: false, title: 'Teste3', objective: 'Alterar o script de teste e provar que o backend bloqueia a verificação até nova aprovação humana.', workspaceId: 'ws', createdAt: ROUND_END,
    tasks: [{ id: 't1', title: '[Rodada 1] Alterar o script', status: 'completed', auto: true, dependsOn: [], report: '', files: [], log: [] }],
    cycle: {
      id: 'c1', status: 'blocked', maxIterations: 5, plannerCalls: 2, consecutiveFailures: 0, consecutiveNoProgress: 0, humanNotes: [], rejections: [], cancelRequested: false, startedAt: ROUND_END, finishedAt: null,
      blockedCode: 'planner_blocked', blockedReason: 'revisar', blocks: [{ code: 'verification_blocked', reason: 'x', at: ROUND_END }, { code: 'planner_blocked', reason: 'y', at: REVERIFIED }],
      finalSummary: null, evidence: null,
      rounds: [{
        n: 1, status: 'succeeded', taskId: 't1', fingerprint: 'f', startedAt: ROUND_END, finishedAt: ROUND_END, decision: null,
        plan: { rationale: 'r', title: 'Alterar o script', instructions: 'Altere o script test', acceptance: ['script diferente'] },
        report: {
          status: 'success', summary: "scripts.test alterado de 'node --test' para 'node --test --verbose'.", filesChanged: [], filesKnown: false,
          checks: [{ name: 'scripts.test difere do original', result: 'pass', detail: '' }, { name: 'Backend bloqueou o ciclo', result: 'not_run', detail: 'fora do meu alcance' }], checksReported: true,
          errors: [], blockers: [], exitCode: 0, usage: null,
          verifications: [verification('pass')], verificationsSkipped: null,
          reverifiedAt: REVERIFIED, previousVerifications: previous.length ? [{ at: REVERIFIED, verifications: previous }] : [],
        },
      }],
    },
  };
  db.missions = [m];
  return { db };
}
/** Prompt EFETIVAMENTE entregue ao Planner depois de retomar (nada é executado: a verificação já está atual). */
async function promptAfterResume(previous = [tamperBlocked()]) {
  const { db } = fixture(previous);
  let prompt = '';
  const planner = { busy: () => false, cancel: async () => {}, decide: async ({ prompt: p }) => { prompt = p; return { text: JSON.stringify({ decision: 'blocked', rationale: 'x', blockedReason: 'x' }) }; } };
  let reran = 0;
  const verifier = { run: async () => { reran++; throw new Error('não deveria rodar: a verificação já está atual'); }, stop: async () => ({}), isBusy: () => false };
  const cy = createCycle({ db, executor: { isBusy: () => false, stop: async () => ({}), current: () => null }, planner, startTaskRun: async () => ({ ok: false }), verifier, listFiles: () => [] });
  assert.equal((await cy.resume('m1')).status, 202); await cy.idle();
  assert.equal(reran, 0, 'a retomada não refaz verificação que já está atual');
  assert.ok(prompt.length > 0, 'o Planner foi consultado');
  return prompt;
}
const section = (p, start, end) => p.slice(p.indexOf(start), p.indexOf(end, p.indexOf(start)));

/**
 * Exige a evidência histórica NO prompt (nunca passa vacuamente): exatamente uma linha SUBSTITUÍDA, datada, com status e
 * motivo reais, distinguindo histórico de estado atual, e a atribuição de "alteração detectada" SOMENTE quando `tagged`.
 */
function assertHistoricalEvidence(prompt, { status, reason, tagged }) {
  const hist = section(prompt, 'HISTÓRICO:', 'ÚLTIMO RELATÓRIO');
  assert.ok(hist.length > 'HISTÓRICO:'.length, 'seção HISTÓRICO presente');
  const old = hist.split('\n').filter((l) => /SUBSTITUÍDA/.test(l));
  assert.equal(old.length, 1, 'a evidência histórica (linha SUBSTITUÍDA) precisa estar presente');
  const line = old[0];
  assert.match(line, new RegExp(REVERIFIED.slice(0, 19)), 'datada');
  assert.ok(line.includes(`test=${status}`), `status real (${status})`);
  assert.ok(line.includes(reason), 'motivo real, na íntegra');
  assert.match(line, /é HISTÓRICO, não é a situação atual/, 'distinção histórico x atual');
  if (tagged) assert.ok(line.includes(TAG), 'atribuição só com evidência explícita'); else assert.ok(!line.includes(TAG) && !/detectad/.test(line), 'sem atribuição de detecção');
  assert.doesNotMatch(prompt, /a detecção funcionou|isto prova que o backend/, 'nenhuma afirmação genérica de sucesso da detecção');
  // o estado atual vem de UMA linha e não mistura o resultado antigo
  const current = hist.split('\n').filter((l) => /verificações REAIS \(executadas/.test(l));
  assert.equal(current.length, 1); assert.match(current[0], /test=pass\(código 0\)/); assert.ok(!current[0].includes('blocked') && !current[0].includes(reason.slice(0, 20)));
}

test('o relatório do fim da rodada e a verificação refeita aparecem COM horários e explicados', async () => {
  const hist = section(await promptAfterResume(), 'HISTÓRICO:', 'ÚLTIMO RELATÓRIO');
  assert.match(hist, new RegExp(`execução terminou em ${ROUND_END.replace(/[.]/g, '\\.')}`), 'quando a rodada terminou');
  assert.match(hist, new RegExp(`verificações REAIS foram refeitas em ${REVERIFIED.replace(/[.]/g, '\\.')}`), 'quando a verificação foi refeita');
  assert.match(hist, /só ocorre depois que um humano retoma o ciclo/);
  assert.match(hist, /resumo \(fim da rodada[^)]*\): scripts\.test alterado/, 'o resumo é rotulado como do fim da rodada');
  assert.match(hist, /autodeclaradas pelo Executor[^\n]*fim da rodada/, 'o mesmo vale para as autodeclaradas');
});

test('adulteração comprovada: status, motivo real e atribuição explícita, como histórico datado', async () => {
  assertHistoricalEvidence(await promptAfterResume([tamperBlocked()]), { status: 'blocked', reason: TAMPER_REASON, tagged: true });
});

test('outro bloqueio (script removido): mostra status e motivo reais, SEM atribuir detecção de adulteração', async () => {
  const reason = 'O script "test" não existe mais no package.json.';
  assertHistoricalEvidence(await promptAfterResume([verification('blocked', { reason })]), { status: 'blocked', reason, tagged: false });
});

test('erro de ambiente (npm ausente): mostra status e motivo reais, SEM atribuição', async () => {
  const reason = 'npm não foi encontrado junto ao Node.';
  assertHistoricalEvidence(await promptAfterResume([verification('error', { reason })]), { status: 'error', reason, tagged: false });
});

test('sem evidência explícita não há atribuição: fonte não-backend, frase fora do início e status diferente de blocked', async () => {
  const phrase = `${SCRIPT_CHANGE_REASON}; (aprovado: "x" · atual: "y")`;
  const cases = [
    { v: verification('blocked', { source: 'self', reason: phrase }), status: 'blocked', reason: phrase },                                   // não veio do backend
    { v: verification('blocked', { source: undefined, reason: phrase }), status: 'blocked', reason: phrase },                               // sem fonte
    { v: verification('blocked', { reason: `Aviso: ${phrase}` }), status: 'blocked', reason: `Aviso: ${phrase}` },                          // frase no meio do texto
    { v: verification('fail', { reason: phrase, exitCode: 1 }), status: 'fail', reason: phrase },                                           // não é "blocked"
  ];
  for (const c of cases) assertHistoricalEvidence(await promptAfterResume([c.v]), { status: c.status, reason: c.reason, tagged: false });
});

test('CONTROLE NEGATIVO: o verificador de evidência FALHA quando a linha SUBSTITUÍDA está ausente (o teste não passa vacuamente)', async () => {
  const semAnterior = await promptAfterResume([]);
  assert.throws(() => assertHistoricalEvidence(semAnterior, { status: 'blocked', reason: TAMPER_REASON, tagged: true }), /linha SUBSTITUÍDA|precisa estar presente/);
  const comLinha = await promptAfterResume([tamperBlocked()]);
  const semLinha = comLinha.split('\n').filter((l) => !/SUBSTITUÍDA/.test(l)).join('\n');
  assert.throws(() => assertHistoricalEvidence(semLinha, { status: 'blocked', reason: TAMPER_REASON, tagged: true }));
  assert.throws(() => assertHistoricalEvidence(comLinha.replace('test=blocked', 'test=pass'), { status: 'blocked', reason: TAMPER_REASON, tagged: true }), 'status adulterado é detectado');
  assert.throws(() => assertHistoricalEvidence(comLinha.replace(TAMPER_REASON, 'motivo omitido'), { status: 'blocked', reason: TAMPER_REASON, tagged: true }), 'motivo ausente é detectado');
  assert.throws(() => assertHistoricalEvidence(comLinha.replace('é HISTÓRICO, não é a situação atual', ''), { status: 'blocked', reason: TAMPER_REASON, tagged: true }), 'falta da distinção histórico x atual é detectada');
  assert.throws(() => assertHistoricalEvidence(comLinha, { status: 'blocked', reason: TAMPER_REASON, tagged: false }), 'atribuição indevida é detectada');
});

test('o JSON do último relatório continua sem a trilha de auditoria; as regras explicam como ler "SUBSTITUÍDA"', async () => {
  const p = await promptAfterResume();
  const json = section(p, 'ÚLTIMO RELATÓRIO', 'Responda SOMENTE');
  assert.doesNotMatch(json, /previousVerifications|mudou desde/);
  assert.match(json, /"reverifiedAt":"2026-10-23T19:56:01\.685Z"/);
  assert.match(p, /SUBSTITUÍDA.*(história|histórico)/is);
});

test('isScriptChangeBlock: só resultado do backend, blocked, com a frase no INÍCIO do motivo', () => {
  const ok = verification('blocked');
  assert.equal(isScriptChangeBlock(ok), true);
  for (const v of [verification('pass'), verification('fail', { reason: TAMPER_REASON }), verification('blocked', { source: 'self' }), verification('blocked', { source: undefined }),
    verification('blocked', { reason: `x ${TAMPER_REASON}` }), verification('blocked', { reason: null }), verification('blocked', { reason: 42 }), verification('error', { reason: TAMPER_REASON }), null, undefined]) {
    assert.equal(isScriptChangeBlock(v), false, JSON.stringify(v)?.slice(0, 80));
  }
});

test('GUARDA CONTRA DERIVA: a mensagem REAL de verify.js é reconhecida; outros bloqueios reais não são', async () => {
  const dir = path.join(tmp, 'proj'); fs.mkdirSync(dir);
  const write = (scripts) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts }));
  const v = createVerifier({ spawnSpec: (s) => ({ command: process.execPath, args: [FAKEV, s] }) });
  const item = { id: 'test', script: 'test', command: 'node --test', required: true, timeoutMs: 20000 };
  write({ test: 'node --test --verbose' });
  const tamper = await v.run({ path: dir }, item);
  assert.equal(tamper.status, 'blocked'); assert.equal(isScriptChangeBlock(tamper), true, `motivo real: ${tamper.reason}`);
  write({ build: 'x' });
  const removed = await v.run({ path: dir }, item);
  assert.equal(removed.status, 'blocked'); assert.equal(isScriptChangeBlock(removed), false, removed.reason);
  const notAllowed = await v.run({ path: dir }, { ...item, id: 'start', script: 'start' });
  assert.equal(notAllowed.status, 'blocked'); assert.equal(isScriptChangeBlock(notAllowed), false, notAllowed.reason);
  write({ test: 'node --test' });
  assert.equal((await v.run({ path: dir }, item)).status, 'pass', 'restaurado: volta a passar');
});
