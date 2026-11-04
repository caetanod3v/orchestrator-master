// Resultado final da missão derivado do relatório de entrega (registros gravados), nunca gravado: estável e sem duplicatas. Relatórios reais do buildDelivery. Sem rede, sem modelo, sem missão real.
// (A interface de conversa que exibia essa mensagem foi removida; o módulo do servidor fica disponível para o maestro/terminais.)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chatres-')));
process.env.ORCH_DATA_DIR = path.join(tmp, 'data');
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const { buildDelivery } = await import('../delivery.js');
const { resultMessageOf, threadOf } = await import('../result-message.js');

const REAL_PASS = { id: 'test', script: 'test', required: true, command: 'npm run test', source: 'backend', status: 'pass', exitCode: 0, durationMs: 5, outputTail: '', truncated: false, reason: null };
const EV = (level) => ({ level, basis: level === 'verified' ? 'real_verification' : 'executor_claim_only', reasons: level === 'verified' ? [] : ['motivo gravado'], executorClaim: { status: 'success', pass: 1, fail: 0, notRun: 0, note: 'x' }, system: { verification: level === 'verified' ? 'passed' : 'failed', verifications: [], expectedFiles: null, integrity: 'clean' } });
const rep = (level, files) => ({ status: 'success', summary: 's', filesChanged: files, filesKnown: true, checks: [], checksReported: true, errors: [], blockers: [], exitCode: 0, usage: null, verifications: [level === 'verified' ? REAL_PASS : { ...REAL_PASS, status: 'fail', exitCode: 1, reason: 'Terminou com código 1' }], verificationsSkipped: null, verificationsInterrupted: null, evidence: EV(level) });
const rnd = (n, planId, stepId, level = 'verified', files = []) => ({ n, status: 'succeeded', phase: 'done', taskId: `t${n}`, agent: 'code', ...(planId ? { planId, stepId } : {}), plan: { title: `Rodada ${n}`, rationale: 'r' }, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', report: rep(level, files), verification: level === 'verified' ? 'passed' : 'failed', decision: null });
const stp = (id) => ({ id, title: `Etapa ${id}`, dependsOn: [] });
const cyc = (status, rounds, plan, over = {}) => ({ id: 'cy1', status, maxIterations: 8, rounds, plannerCalls: 1, humanNotes: [], rejections: [], blocks: [], blockedCode: null, blockedReason: null, finalSummary: null, evidence: null, startedAt: 'A', finishedAt: ['completed', 'cancelled', 'limit_reached'].includes(status) ? 'B' : null, ...(plan ? { plan } : {}), ...over });
const mis = (cycle, over = {}) => ({ id: 'mx', demo: false, title: 'Landing page', objective: 'obj', workspaceId: 'w', createdAt: 'T0', tasks: [], origin: 'chat', conversation: [{ id: 'msg_1', role: 'user', text: 'Quero uma landing page', at: 'T' }, { id: 'msg_2', role: 'assistant', kind: 'reply', text: 'Combinado, vou preparar o plano.', at: 'T' }], cycle, ...over });
const WS = { id: 'w', name: 'w', verifications: [{ script: 'test', required: true }] };
const FILES = [{ path: 'index.html', status: '??', added: 10, removed: 0 }, { path: 'style.css', status: ' M', added: 3, removed: 1 }, { path: 'antigo.txt', status: ' D' }, { path: 'ja-sujo.txt', status: ' M', preexisting: true }];
const full = (cycle, over) => { const m = mis(cycle, over), r = JSON.parse(JSON.stringify(buildDelivery(m, WS))); return { m, r, msg: resultMessageOf(r, m) }; };
const ok = () => cyc('completed', [rnd(1, 'pl', 'a', 'verified', FILES), rnd(2, 'pl', 'b')], { id: 'pl', steps: [stp('a'), stp('b')] }, { finalSummary: 'tudo certo' });

test('Resultado: missão concluída E comprovada => "completed", com resumo, arquivos criados/modificados e verificações reais', () => {
  const { msg } = full(ok()); assert.equal(msg.outcome, 'completed'); assert.equal(msg.role, 'assistant'); assert.equal(msg.kind, 'result'); assert.match(msg.text, /^Missão concluída\./);
  assert.ok(msg.summary.some((l) => /evidência do sistema da última rodada confirma/.test(l))); assert.ok(msg.summary.some((l) => /Etapas concluídas: 2 de 2/.test(l))); assert.ok(msg.summary.some((l) => /Rodadas executadas: 2/.test(l))); assert.ok(msg.summary.some((l) => /Verificações reais da última rodada: test passou/.test(l)));
  assert.deepEqual(msg.files, [{ path: 'antigo.txt', change: 'apagado' }, { path: 'index.html', change: 'criado' }, { path: 'style.css', change: 'modificado' }], 'só o que a execução tocou; o que já estava alterado antes fica de fora');
  assert.match(msg.text, /Arquivos criados ou modificados: antigo\.txt, index\.html, style\.css\./); assert.equal(msg.filesTotal, 3); assert.ok(msg.pending.every((p) => !/SEM garantia|não concluída/.test(p)), 'nenhuma pendência de garantia ou etapa'); assert.ok(msg.pending.some((p) => /já estavam alterados antes/.test(p)), 'limitações reais do relatório são repassadas'); assert.equal(msg.stoppedBy, null);
  assert.ok(msg.summary.some((l) => l.includes('Resumo do Planner (declaração, não prova): tudo certo')), 'o que o Planner declarou vem marcado como declaração');
  assert.ok(!full(cyc('completed', [rnd(1)], null)).msg.summary.some((l) => /Resumo do Planner/.test(l)), 'sem resumo gravado nada é inventado');
});

test('Resultado: concluída SEM comprovação do sistema => "partial" (nunca "concluída"); a razão e as limitações do relatório são listadas', () => {
  const { msg } = full(cyc('completed', [rnd(1, 'pl', 'a', 'failed', FILES)], { id: 'pl', steps: [stp('a')] }));
  assert.equal(msg.outcome, 'partial'); assert.match(msg.text, /^Missão parcialmente concluída\./); assert.ok(msg.summary.some((l) => /NÃO conseguiu comprová-la/.test(l))); assert.ok(msg.pending.some((p) => /SEM garantia verificada/.test(p))); assert.match(msg.text, /Pendências e limitações:/);
});

test('Resultado: parou/cancelada/limite — com progresso é "partial", sem nenhum resultado é "failed"; bloqueio mostra o motivo e aguarda decisão', () => {
  let { msg } = full(cyc('blocked', [rnd(1, 'pl', 'a', 'verified', FILES)], { id: 'pl', steps: [stp('a'), stp('b')] }, { blockedCode: 'needs_approval', blockedReason: 'precisa da sua decisão' }));
  assert.equal(msg.outcome, 'partial'); assert.equal(msg.stoppedBy, 'blocked'); assert.ok(msg.summary[0].includes('aguarda uma decisão sua (needs_approval)')); assert.ok(msg.pending.some((p) => /precisa da sua decisão/.test(p))); assert.ok(msg.pending.some((p) => /Etapa "Etapa b" não concluída/.test(p)));
  ({ msg } = full(cyc('cancelled', [], null))); assert.equal(msg.outcome, 'failed'); assert.match(msg.text, /não foi concluída \(falhou\)/); assert.match(msg.text, /Nenhum arquivo alterado foi registrado/);
  ({ msg } = full(cyc('limit_reached', [rnd(1, null, null, 'failed', FILES)], null))); assert.equal(msg.outcome, 'partial'); assert.equal(msg.stoppedBy, 'limit_reached');
});

test('Resultado: sem mensagem enquanto a missão não terminou (em andamento, sem ciclo, demonstrativa) ou com dado inválido', () => {
  for (const c of [cyc('running', [rnd(1)], null), cyc('planning', [], null)]) assert.equal(full(c).msg, null, c.status);
  assert.equal(full(null).msg, null); assert.equal(full(ok(), { demo: true }).msg, null); for (const bad of [null, {}, { state: {} }, 'x']) assert.equal(resultMessageOf(bad, {}), null);
});

test('Resultado: id ESTÁVEL (reler/atualizar não duplica); novo término ou novo bloqueio gera outro id; nada é gravado na missão', () => {
  const a = full(ok()), b = full(ok()); assert.equal(a.msg.id, b.msg.id); assert.match(a.msg.id, /^result:cy1:B$/); const snap = JSON.stringify(a.m); resultMessageOf(a.r, a.m); assert.equal(JSON.stringify(a.m), snap, 'não grava nada');
  const t1 = threadOf(a.m, a.r), t2 = threadOf(a.m, a.r); assert.deepEqual(t1, t2); assert.equal(t1.messages.length, 2, 'a conversa da missão não ganha a mensagem final (ela é derivada)'); assert.equal(t1.result.id, a.msg.id);
  const blk = (n) => full(cyc('blocked', Array.from({ length: n }, (_, i) => rnd(i + 1, null, null, 'verified', FILES)), null, { blockedCode: 'x', blockedReason: 'r' })).msg.id; assert.notEqual(blk(1), blk(2));
});

test('Resultado: sem segredos nem dados brutos; limites de tamanho; thread sem relatório devolve só a conversa', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ path: `f${String(i).padStart(2, '0')}.txt`, status: '??' })), { msg } = full(cyc('completed', [rnd(1, null, null, 'verified', many)], null));
  assert.equal(msg.files.length, 15); assert.equal(msg.filesTotal, 40); assert.match(msg.text, /e mais 25\./); assert.ok(!JSON.stringify(msg).includes('outputTail'));
  const t = threadOf(mis(ok()), null); assert.equal(t.result, null); assert.equal(t.messages.length, 2); assert.deepEqual(t.messages.map((m) => m.role), ['user', 'assistant']); assert.equal(threadOf({ id: 'x' }, null).messages.length, 0);
});
