// Estados operacionais, resumo de tarefa e logs (client/src/op-state.js, funções puras). Garante que a interface só afirma o que os dados do servidor sustentam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_TONE, taskTone, taskLabel, agentState, latestExecutionFailed, classifyLogLine, logToText, logOmitted, summarizeTask, roundOf } from '../../client/src/op-state.js';

const T = (over = {}) => ({ id: 't1', title: 'Tarefa', status: 'queued', dependsOn: [], authorized: false, files: [], log: [], logTotal: 0, ...over });
const ran = (over = {}) => T({ startedAt: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T10:00:05.000Z', exitCode: 0, gitRepo: true, report: 'Feito.', ...over });

test('cada status real tem um tom, e todos os tons são distintos entre estados que o usuário precisa diferenciar', () => {
  assert.deepEqual(TASK_TONE, { queued: 'idle', running: 'run', completed: 'ok', awaiting_approval: 'wait', interrupted: 'stop', failed: 'err' });
  const tones = Object.values(TASK_TONE);
  assert.equal(new Set(tones).size, tones.length, 'ocioso, executando, concluído, aguardando, interrompido e erro nunca compartilham tom');
  assert.equal(taskTone('algo-que-o-servidor-nao-envia'), 'idle', 'status desconhecido não inventa um estado: cai no neutro');
});

test('estados dos agentes vêm de /api/agents (inclusive desconectado)', () => {
  assert.equal(agentState({ status: 'running' }), 'active');
  assert.equal(agentState({ status: 'idle', availability: 'connected' }), 'idle');
  assert.equal(agentState({ status: 'not_connected', availability: 'unavailable' }), 'disconnected', 'CLI não detectada = desconectado');
  assert.equal(agentState({ status: 'degraded' }), 'unavailable');
  assert.equal(agentState(undefined), 'unavailable');
});

test('falha da última execução: rejeição humana não conta, e uma execução posterior bem-sucedida supera a falha', () => {
  assert.equal(latestExecutionFailed([]), false);
  assert.equal(latestExecutionFailed([T({ status: 'failed', finishedAt: '2026-01-01T10:00:00Z' })]), true);
  assert.equal(latestExecutionFailed([T({ status: 'failed', rejected: true, finishedAt: '2026-01-01T10:00:00Z' })]), false);
  assert.equal(latestExecutionFailed([T({ status: 'failed', finishedAt: '2026-01-01T10:00:00Z' }), T({ id: 't2', status: 'completed', finishedAt: '2026-01-01T11:00:00Z' })]), false);
  assert.equal(latestExecutionFailed([T({ status: 'completed', finishedAt: '2026-01-01T09:00:00Z' }), T({ id: 't2', status: 'failed', finishedAt: '2026-01-01T11:00:00Z' })]), true);
});

test('resumo: tarefa que nunca rodou NÃO afirma resultado nem alterações', () => {
  const s = summarizeTask(T());
  assert.equal(s.tone, 'idle');
  assert.match(s.headline, /Ainda não executada/);
  assert.equal(s.changes.kind, 'not_run'); assert.deepEqual(s.changes.files, []);
  assert.equal(s.report, undefined); assert.equal(s.outcome, null); assert.equal(s.verification, null);
  assert.equal(s.next.action, 'authorize');
  assert.doesNotMatch(JSON.stringify(s), /nenhuma altera/i, 'não diz "nenhuma alteração" de algo que não rodou');
  assert.match(summarizeTask(T({ authorized: true })).headline, /Autorizada, mas ainda não executada/);
  assert.equal(summarizeTask(T({ authorized: true })).next.action, 'run');
  const dep = summarizeTask(T({ blockedReason: 'Dependências pendentes: 02.' }));
  assert.doesNotMatch(dep.headline, /Dependências/, 'o bloqueio não é repetido no título');
  assert.match(dep.next.text, /Dependências pendentes: 02\./, 'o motivo do bloqueio é o do servidor, palavra por palavra');
  assert.match(dep.next.text, /Autorize a execução/);
  assert.equal(summarizeTask(T({ blockedReason: 'Aguardando autorização humana para executar.' })).next.text, 'Aguardando autorização humana para executar.', 'a mensagem do servidor que já pede a autorização não é duplicada');
});

test('resumo: em execução', () => {
  const s = summarizeTask(T({ status: 'running', startedAt: '2026-01-01T10:00:00Z', gitRepo: true }));
  assert.equal(s.tone, 'run'); assert.equal(s.changes.kind, 'pending'); assert.equal(s.next.action, 'stop');
  assert.equal(s.verification, null, 'ainda não há o que verificar');
});

test('resumo: aguardando aprovação deixa claro que o resultado não foi confirmado pelo sistema', () => {
  const s = summarizeTask(ran({ status: 'awaiting_approval', files: [{ path: 'a.js', added: 3, removed: 1, status: 'M' }] }));
  assert.equal(s.tone, 'wait'); assert.equal(s.next.action, 'approve');
  assert.equal(s.verification.level, 'none'); assert.match(s.verification.text, /não foi confirmado/);
  assert.equal(s.changes.kind, 'files'); assert.equal(s.changes.files[0].path, 'a.js'); assert.match(s.changes.text, /1 arquivo alterado/);
  assert.equal(s.report, 'Feito.');
});

test('resumo: concluída — aprovada por humano x aceita no ciclo; evidência só quando existe uma rodada com evidência', () => {
  assert.match(summarizeTask(ran({ status: 'completed' })).headline, /aprovado por você/);
  assert.match(summarizeTask(ran({ status: 'completed', autoAccepted: true })).headline, /ciclo autônomo/);
  const mission = { cycle: { rounds: [{ n: 2, taskId: 't1', phase: 'done', report: { evidence: { level: 'verified', basis: 'real_verification', reasons: [] } } }] } };
  const v = summarizeTask(ran({ status: 'completed', autoAccepted: true }), { mission });
  assert.equal(v.verification.level, 'verified'); assert.match(v.verification.text, /Verificado pelo sistema/); assert.equal(v.verification.basis, 'verificação real');
  const inc = summarizeTask(ran({ status: 'completed', autoAccepted: true }), { mission: { cycle: { rounds: [{ taskId: 't1', report: { evidence: { level: 'inconclusive', reasons: ['sem arquivos esperados'] } } }] } } });
  assert.match(inc.verification.text, /não confirmado/); assert.deepEqual(inc.verification.reasons, ['sem arquivos esperados']);
  assert.equal(roundOf(mission, { id: 'outra' }), null, 'outra tarefa não herda evidência de uma rodada alheia');
  assert.equal(summarizeTask(ran({ status: 'completed', autoAccepted: true }), { mission: { cycle: { rounds: [] } } }).verification.level, 'none');
});

test('resumo: falha mostra a causa EXATA do servidor e a saída; sem causa registrada, diz isso', () => {
  const s = summarizeTask(ran({ status: 'failed', error: 'Processo terminou com código 2', exitCode: 2 }));
  assert.equal(s.tone, 'err'); assert.equal(s.outcome.text, 'Processo terminou com código 2'); assert.equal(s.outcome.exitCode, 2);
  assert.equal(s.next.action, 'authorize', 'falha de execução permite nova tentativa');
  assert.equal(summarizeTask(ran({ status: 'failed', error: null })).outcome.text, 'O servidor não registrou o motivo.');
  const p = summarizeTask(ran({ status: 'failed', error: 'x', permissionDenied: true }));
  assert.match(p.outcome.note, /permissão que não foi concedida/);
  assert.equal(summarizeTask(ran({ status: 'failed', permissionDenied: false, error: 'x' })).outcome.note, undefined);
});

test('resumo: rejeição humana não é falha de execução', () => {
  const s = summarizeTask(ran({ status: 'failed', rejected: true, error: null }));
  assert.match(s.headline, /rejeitado por você/); assert.equal(s.outcome, null, 'não há erro a mostrar'); assert.equal(s.next.action, null);
  assert.equal(s.label, 'rejeitada'); assert.equal(taskLabel({ status: 'failed', rejected: true }), 'rejeitada'); assert.equal(taskLabel({ status: 'failed' }), 'falhou', 'falha de execução continua sendo falha');
  assert.equal(s.verification, null, 'uma decisão humana não precisa do aviso de verificação');
  assert.equal(summarizeTask(ran({ status: 'failed', error: 'x' })).verification, null, 'falha de execução: nada a verificar');
});

test('resumo: interrompida é diferente de falha', () => {
  const s = summarizeTask(ran({ status: 'interrupted', error: 'O servidor foi reiniciado durante a execução.', exitCode: null }));
  assert.equal(s.tone, 'stop'); assert.notEqual(s.tone, summarizeTask(ran({ status: 'failed' })).tone);
  assert.match(s.headline, /interrompida/); assert.equal(s.outcome.text, 'O servidor foi reiniciado durante a execução.');
  assert.equal(s.details.find((d) => d.k === 'Código de saída'), undefined, 'sem código de saída, nada é inventado');
});

test('alterações: Git ausente, nenhuma detectada e arquivos já alterados antes são tratados com honestidade', () => {
  assert.equal(summarizeTask(ran({ status: 'awaiting_approval', gitRepo: false })).changes.kind, 'unknown');
  assert.match(summarizeTask(ran({ status: 'awaiting_approval', gitRepo: false })).changes.text, /não podem ser verificadas/);
  const none = summarizeTask(ran({ status: 'awaiting_approval', files: [] }));
  assert.equal(none.changes.kind, 'none'); assert.match(none.changes.text, /Git não detectou/);
  const pre = summarizeTask(ran({ status: 'awaiting_approval', dirtyBefore: true, files: [{ path: 'x', preexisting: true }] }));
  assert.match(pre.changes.note, /já tinha alterações/); assert.equal(pre.changes.files[0].preexisting, true);
  assert.match(summarizeTask(ran({ status: 'awaiting_approval', files: [{ path: 'a' }, { path: 'b' }] })).changes.text, /2 arquivos alterados/);
});

test('relatório: ausente não vira texto inventado; "Sem relatório" do servidor não é apresentado como resultado', () => {
  const s = summarizeTask(ran({ status: 'failed', report: 'Sem relatório: timeout', error: 'timeout' }));
  assert.equal(s.report, undefined); assert.equal(s.reportMissing, true);
  assert.equal(summarizeTask(T()).reportMissing, undefined, 'tarefa que nunca rodou não "perdeu" relatório');
});

test('missão demonstrativa nunca oferece ação real', () => {
  const mission = { demo: true };
  assert.equal(summarizeTask(T(), { mission }).next.action, null);
  assert.equal(summarizeTask(ran({ status: 'failed' }), { mission }).next.action, null);
  assert.match(summarizeTask(ran({ status: 'completed' }), { mission }).headline, /demonstrativo/);
});

test('detalhes técnicos: só campos presentes; duração cai para início/fim quando a CLI não reportou', () => {
  const s = summarizeTask(ran({ status: 'completed', usage: { durationMs: 1500, turns: 3, costUsd: 0.0123 }, id: 'tsk_9' }));
  const get = (k) => s.details.find((d) => d.k === k)?.v;
  assert.equal(get('Duração'), '1.5 s'); assert.equal(get('Turnos'), '3'); assert.equal(get('Custo reportado pela CLI'), 'US$ 0.0123'); assert.equal(get('Código de saída'), '0'); assert.equal(get('Identificador'), 'tsk_9');
  assert.equal(summarizeTask(ran({ status: 'completed' })).details.find((d) => d.k === 'Duração').v, '5.0 s');
  assert.equal(summarizeTask(T()).details.find((d) => d.k === 'Duração'), undefined);
});

test('o resumo não altera a tarefa recebida (dados originais intactos)', () => {
  const t = ran({ status: 'failed', error: 'e', files: [{ path: 'a', added: 1, removed: 0 }], log: ['x', '[stderr] y'], logTotal: 2 });
  const before = JSON.stringify(t);
  summarizeTask(t, { mission: { cycle: { rounds: [] } } });
  assert.equal(JSON.stringify(t), before);
});

test('logs: classificação pelo prefixo, texto completo idêntico às linhas e linhas omitidas pelo cliente', () => {
  assert.equal(classifyLogLine('[stderr] boom'), 'error');
  assert.equal(classifyLogLine('[erro de ferramenta] negado'), 'error');
  assert.equal(classifyLogLine('[aviso] workspace sujo'), 'warn');
  assert.equal(classifyLogLine('texto normal [stderr] no meio'), 'info', 'só o prefixo conta');
  assert.equal(classifyLogLine(''), 'info');
  const lines = ['a', '[stderr] b', 'c\td'];
  assert.equal(logToText(lines), 'a\n[stderr] b\nc\td', 'a cópia é exatamente o log, sem resumo nem formatação');
  assert.equal(logToText(undefined), '');
  assert.equal(logOmitted({ log: new Array(600).fill('x'), logTotal: 1500 }), 900);
  assert.equal(logOmitted({ log: ['x'], logTotal: 1 }), 0);
  assert.equal(logOmitted(null), 0);
});
