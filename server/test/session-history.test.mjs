// Etapa 3: lógica pura da tela de histórico de sessões (client/src/session-history.js). A decisão de retomar é sempre do servidor; aqui só se organiza e rotula.
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRows, resumeBody, needsConfigAck, restoreSummary, STATE_LABEL, REASON_LABEL } from '../../client/src/session-history.js';

const h = (id, over = {}) => ({ id, role: 'builder', roleLabel: 'Construtor', color: '#a3e635', title: id, workspaceId: 'ws1', topicId: null, worktreeId: null, state: 'exited', startedAt: '2026-11-05T10:00:00Z', endedAt: null, exitCode: 0,
  usesMcp: true, resumes: 0, forkedFrom: null, active: false, resumable: true, blockedReason: null, blockedMessage: null, closedReason: 'exit', ...over });
const topics = [{ id: 'top_aaaaaaaa', workspaceId: 'ws1', title: 'Login' }];

test('só o workspace pedido; interrompidas e retomáveis vão para "restore" (primeiro); a ordem do servidor é mantida em cada grupo', () => {
  const r = historyRows({ workspaceId: 'ws1', topics, history: [h('ses_00000001'), h('ses_00000002', { state: 'interrupted', closedReason: 'crash' }), h('ses_00000003', { workspaceId: 'ws2' }), h('ses_00000004', { state: 'interrupted', closedReason: 'shutdown' }), h('ses_00000005')] });
  assert.deepEqual(r.restore.map((x) => x.id), ['ses_00000002', 'ses_00000004']); assert.deepEqual(r.others.map((x) => x.id), ['ses_00000001', 'ses_00000005']);
  assert.equal(r.restore[0].reasonLabel, REASON_LABEL.crash); assert.equal(r.restore[1].reasonLabel, REASON_LABEL.shutdown); assert.equal(r.restore[0].stateLabel, STATE_LABEL.interrupted);
});

test('interrompida mas BLOQUEADA pelo servidor não entra em "restore", e a mensagem do servidor é repassada sem reinterpretar', () => {
  const r = historyRows({ workspaceId: 'ws1', history: [h('ses_00000001', { state: 'interrupted', resumable: false, blockedReason: 'transcript_missing', blockedMessage: 'A transcrição desta sessão não foi encontrada: não há o que retomar.' })] });
  assert.equal(r.restore.length, 0); const x = r.others[0];
  assert.deepEqual([x.resumable, x.blockedCode, x.blockedShort, x.blockedMessage], [false, 'transcript_missing', 'sem transcrição', 'A transcrição desta sessão não foi encontrada: não há o que retomar.']);
});

test('filtro por tópico: Geral = sem tópico; título do tópico, "Geral" e tópico arquivado/desconhecido', () => {
  const history = [h('ses_00000001'), h('ses_00000002', { topicId: 'top_aaaaaaaa' }), h('ses_00000003', { topicId: 'top_bbbbbbbb' })];
  const all = historyRows({ workspaceId: 'ws1', topics, history }).others; assert.deepEqual(all.map((x) => x.topicTitle), ['Geral', 'Login', 'tópico arquivado']);
  assert.deepEqual(historyRows({ workspaceId: 'ws1', topics, history, topicId: 'top_aaaaaaaa', onlyTopic: true }).others.map((x) => x.id), ['ses_00000002']);
  assert.deepEqual(historyRows({ workspaceId: 'ws1', topics, history, topicId: null, onlyTopic: true }).others.map((x) => x.id), ['ses_00000001']);
  assert.equal(historyRows({ workspaceId: 'ws1', topics, history, topicId: 'top_aaaaaaaa' }).others.length, 3, 'sem onlyTopic mostra tudo do workspace');
});

test('dados malformados ou ausentes nunca quebram: lista vazia, campos com padrão, rótulos desconhecidos', () => {
  for (const history of [undefined, null, 'x', {}, [null, 5, 'a']]) assert.deepEqual(historyRows({ workspaceId: 'ws1', history }), { restore: [], others: [] });
  const x = historyRows({ workspaceId: 'ws1', history: [{ id: 'ses_00000009', workspaceId: 'ws1', state: 'novo-estado', closedReason: 'inventado', resumes: 'muitas', worktreeId: 'wt1', forkedFrom: 'ses_00000001', active: true }] }).others[0];
  assert.deepEqual([x.stateLabel, x.reasonLabel, x.resumes, x.usesWorktree, x.forked, x.active, x.resumable, x.title], ['novo-estado', null, 0, true, true, true, false, '']);
});

test('resumeBody: só o id do registro, fork e tamanho; confirmação explícita só quando pedida; nunca UUID, caminho nem papel', () => {
  assert.deepEqual(resumeBody({ recordId: 'ses_00000001' }), { recordId: 'ses_00000001', fork: false, cols: 120, rows: 32 });
  assert.deepEqual(resumeBody({ recordId: 'ses_00000001', fork: true, ack: true }), { recordId: 'ses_00000001', fork: true, cols: 120, rows: 32, acknowledgeProjectConfig: true });
  assert.equal(resumeBody({ recordId: 'x', fork: 'sim' }).fork, false, 'só o booleano true liga o fork'); assert.equal(Object.hasOwn(resumeBody({ recordId: 'x', ack: 1 }), 'acknowledgeProjectConfig'), true);
  assert.deepEqual(Object.keys(resumeBody({ recordId: 'x' })).sort(), ['cols', 'fork', 'recordId', 'rows']);
});

test('needsConfigAck e restoreSummary', () => {
  assert.equal(needsConfigAck({ code: 'project_config_unreviewed' }), true); assert.equal(needsConfigAck({ code: 'session_active' }), false); assert.equal(needsConfigAck(null), false);
  const mk = (n) => ({ restore: Array.from({ length: n }, (_, i) => i), others: [] });
  assert.equal(restoreSummary(mk(0)), null); assert.match(restoreSummary(mk(1)), /^1 sessão estava aberta e pode ser retomada$/); assert.match(restoreSummary(mk(3)), /^3 sessões estavam abertas e podem ser retomadas$/);
});

import { restorePlan, batchSummary } from '../../client/src/session-history.js';
test('restorePlan: só interrompidas retomáveis, na ordem; respeita as vagas e informa o que ficou de fora; vaga negativa ou inválida = nada', () => {
  const r = (id, over = {}) => ({ id, title: id, restore: true, resumable: true, ...over });
  const rows = [r('a'), r('b'), r('c'), r('x', { restore: false }), r('y', { resumable: false })];
  assert.deepEqual(restorePlan(rows, 10).open.map((x) => x.id), ['a', 'b', 'c']); assert.equal(restorePlan(rows, 10).skipped.length, 0);
  const p = restorePlan(rows, 2); assert.deepEqual([p.open.map((x) => x.id), p.skipped.map((x) => x.id)], [['a', 'b'], ['c']]);
  for (const room of [0, -3, NaN, undefined, null]) assert.deepEqual(restorePlan(rows, room).open, []);
  assert.deepEqual(restorePlan(undefined, 5), { open: [], skipped: [] }); assert.equal(restorePlan(rows, 2.9).open.length, 2);
});

test('batchSummary: sucesso simples é informativo; falhas e falta de vaga viram erro com os títulos', () => {
  const row = (t) => ({ title: t });
  assert.deepEqual(batchSummary([{ row: row('a'), ok: true }, { row: row('b'), ok: true }]), { text: '2 sessões retomadas', kind: 'info', ok: 2, failed: 0 });
  const s = batchSummary([{ row: row('a'), ok: true }, { row: row('b'), ok: false, error: 'sem transcrição' }], 1);
  assert.equal(s.kind, 'error'); assert.match(s.text, /1 sessão retomada · 1 falhou: b \(sem transcrição\) · 1 ficou de fora por falta de vaga/);
  assert.equal(batchSummary([], 0).text, 'Nada a restaurar.');
});
