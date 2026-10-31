// Estado operacional do Cockpit (funções puras, sem React): deriva tom, resumo e modo do núcleo SOMENTE de dados que o servidor já fornece.
// Regra de integridade: nada aqui inventa causa, arquivo, resultado ou garantia. O que não está nos dados vira "não confirmado" ou é omitido.

import { statusLabel, EVIDENCE_BASIS } from './labels.js';

/**
 * Tom de cada status de tarefa/rodada (o mesmo significado de cor em todo o produto; a classe CSS é `s-<status>`):
 * idle = cinza (na fila, não executada) | run = azul | ok = verde | wait = âmbar | stop = cinza-azulado | err = vermelho.
 */
export const TASK_TONE = Object.freeze({ queued: 'idle', running: 'run', completed: 'ok', awaiting_approval: 'wait', interrupted: 'stop', failed: 'err' });
export const taskTone = (status) => TASK_TONE[status] ?? 'idle';
/** Rótulo do estado de uma tarefa. Um resultado REJEITADO por humano (status `failed` + `rejected`) é uma decisão, não uma falha de execução: o rótulo diz isso. */
export const taskLabel = (task) => (task.status === 'failed' && task.rejected ? 'rejeitada' : statusLabel(task.status));

/** Estado de um agente (/api/agents). `not_connected` é o que o servidor devolve quando a CLI não foi detectada. */
export function agentState(agent) {
  if (!agent) return 'unavailable';
  if (agent.status === 'running') return 'active';
  if (agent.status === 'idle') return 'idle';
  if (agent.status === 'not_connected' || agent.availability === 'disconnected') return 'disconnected';
  return 'unavailable';
}

/** Ciclo da missão parado numa ação que espera aprovação humana (M9): dado real do servidor, nunca inferido. */
export const cycleApprovalPending = (m) => m?.cycle?.status === 'blocked' && m.cycle.blockedCode === 'approval_required' && (m.cycle.approvals || []).some((a) => a?.status === 'pending');

/** A execução MAIS RECENTE falhou (e não foi uma rejeição humana)? Uma execução posterior bem-sucedida supera a falha. */
export function latestExecutionFailed(tasks) {
  const at = (t) => t.finishedAt || '';
  const failed = tasks.filter((t) => t.status === 'failed' && !t.rejected).map(at).sort().at(-1);
  const other = tasks.filter((t) => t.status !== 'failed' && t.finishedAt).map(at).sort().at(-1) ?? '';
  return failed !== undefined && failed >= other;
}

/**
 * Modo do Neural Core a partir do estado REAL (nada de temporizadores): executor ocupado ou tarefa rodando > planner ocupado > erro > decisão pendente > ocioso.
 * `executing` e `planning` são atividade; `awaiting` é espera por humano; `error` é a última execução ter falhado; o resto é repouso.
 */
export function coreMode({ executorBusy = false, runningTasks = 0, plannerBusy = false, pending = 0, failed = false } = {}) {
  if (executorBusy || runningTasks > 0) return 'executing';
  if (plannerBusy) return 'planning';
  if (failed) return 'error';
  if (pending > 0) return 'awaiting';
  return 'idle';
}

export const CORE_LABEL = Object.freeze({
  idle: 'Ocioso', planning: 'Planner trabalhando', executing: 'Executando', awaiting: 'Aguardando decisão humana', error: 'Falha na última execução',
});

// ---------- logs ----------
/** Classe de uma linha de log pelo prefixo que o servidor/Executor grava. Só marca o que o próprio prefixo diz. */
export function classifyLogLine(line) {
  if (/^\[(stderr|erro)/i.test(line)) return 'error';
  if (/^\[(aviso|warn)/i.test(line)) return 'warn';
  return 'info';
}
/** Texto completo para copiar: exatamente as linhas recebidas, na ordem, uma por linha (nada é resumido nem alterado). */
export const logToText = (lines) => (lines || []).join('\n');
/** Quantas linhas anteriores o cliente não guarda (o servidor entrega só o final do log). */
export const logOmitted = (task) => Math.max(0, (task?.logTotal || 0) - (task?.log?.length || 0));

// ---------- resumo da tarefa ----------
const EVIDENCE_NOTE = {
  verified: 'Verificado pelo sistema (não só pelo relato do Executor).',
  failed: 'A verificação do sistema não confirmou o resultado.',
  inconclusive: 'Resultado não confirmado: a verificação do sistema foi inconclusiva.',
};

/** Rodada do ciclo que gerou a tarefa (a evidência independente mora no relatório da rodada). */
export const roundOf = (mission, task) => mission?.cycle?.rounds?.find((r) => r.taskId === task?.id) ?? null;

const dur = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

/**
 * Resumo de uma tarefa para o inspetor. Responde: o que aconteceu, qual foi o resultado, houve alteração, o que o usuário precisa fazer.
 * Cada afirmação sai de um campo do servidor; sem campo, o texto diz que não há confirmação.
 */
export function summarizeTask(task, { mission = null, busy = false } = {}) {
  const st = task.status;
  const ran = !!task.startedAt;
  const demo = !!mission?.demo;
  const round = roundOf(mission, task);
  const evidence = round?.report?.evidence ?? null;
  const out = { status: st, tone: taskTone(st), label: taskLabel(task), headline: '', outcome: null, verification: null, changes: null, next: null, details: [] };

  // --- o que aconteceu ---
  if (st === 'queued') {
    out.headline = task.authorized ? 'Autorizada, mas ainda não executada.' : 'Ainda não executada.';
  } else if (st === 'running') {
    out.headline = 'Em execução agora.';
  } else if (st === 'awaiting_approval') {
    out.headline = 'Execução terminada; o resultado aguarda a sua revisão.';
  } else if (st === 'completed') {
    out.headline = task.autoAccepted ? 'Concluída no ciclo autônomo; o relatório foi enviado ao Planner.' : demo ? 'Concluída (dado demonstrativo).' : 'Concluída: o resultado foi aprovado por você.';
  } else if (st === 'failed') {
    out.headline = task.rejected ? 'Resultado rejeitado por você.' : 'A execução falhou.';
  } else if (st === 'interrupted') {
    out.headline = 'Execução interrompida antes de terminar.';
  } else {
    out.headline = statusLabel(st);
  }

  // --- resultado ---
  const cause = task.error ? String(task.error) : null;
  if ((st === 'failed' && !task.rejected) || st === 'interrupted') {
    out.outcome = { kind: 'error', text: cause ?? 'O servidor não registrou o motivo.', exitCode: task.exitCode ?? null };
    if (task.permissionDenied) out.outcome.note = 'A execução precisou de uma permissão que não foi concedida (negada automaticamente).';
  }
  if (task.report && !String(task.report).startsWith('Sem relatório')) out.report = String(task.report);
  else if (ran && st !== 'running') out.reportMissing = true;

  // --- verificação (só com dado real) ---
  if (evidence) {
    out.verification = { level: evidence.level, text: EVIDENCE_NOTE[evidence.level] ?? 'Resultado não confirmado.', basis: EVIDENCE_BASIS[evidence.basis] ?? null, reasons: Array.isArray(evidence.reasons) ? evidence.reasons : [] };
  } else if (ran && (st === 'awaiting_approval' || st === 'completed')) {
    out.verification = { level: 'none', text: 'Sem verificação independente: o relatório é do próprio Executor e o resultado não foi confirmado pelo sistema.', basis: null, reasons: [] };
  }

  // --- alterações ---
  const files = Array.isArray(task.files) ? task.files : [];
  if (!ran) out.changes = { kind: 'not_run', text: 'Nada foi executado, então não há alterações a mostrar.', files: [] };
  else if (st === 'running') out.changes = { kind: 'pending', text: 'As alterações são conferidas pelo Git quando a execução termina.', files: [] };
  else if (task.gitRepo === false) out.changes = { kind: 'unknown', text: 'O espaço de trabalho não usa Git: as alterações não podem ser verificadas.', files: [] };
  else if (files.length) out.changes = { kind: 'files', text: `${files.length} ${files.length === 1 ? 'arquivo alterado' : 'arquivos alterados'} segundo o Git.`, files: files.map((f) => ({ path: f.path, added: f.added ?? null, removed: f.removed ?? null, status: f.status ?? null, preexisting: !!f.preexisting })) };
  else out.changes = { kind: 'none', text: 'O Git não detectou alterações ao fim da execução.', files: [] };
  if (task.dirtyBefore) out.changes.note = 'O espaço de trabalho já tinha alterações não confirmadas antes desta execução.';

  // --- próxima ação (espelha os botões reais; o servidor revalida tudo) ---
  const retry = (st === 'failed' || st === 'interrupted') && !task.rejected;
  if (st === 'queued' && !task.authorized) {
    const why = task.blockedReason && !demo ? task.blockedReason : null; // o motivo do servidor, palavra por palavra
    out.next = { action: demo ? null : 'authorize', text: demo ? 'Missão demonstrativa: não há execução real.' : why && /autoriza/i.test(why) ? why : [why, 'Autorize a execução para poder iniciá-la.'].filter(Boolean).join(' ') };
  }
  else if (st === 'queued') out.next = { action: 'run', text: task.blockedReason ? `Ainda não pode rodar: ${task.blockedReason}` : busy ? 'Há outra execução em andamento; aguarde para iniciar.' : 'Inicie a execução ou revogue a autorização.' };
  else if (st === 'running') out.next = { action: 'stop', text: 'Aguarde o término ou interrompa a execução.' };
  else if (st === 'awaiting_approval') out.next = { action: 'approve', text: 'Revise o resultado e aprove ou rejeite.' };
  else if (retry) out.next = { action: demo ? null : 'authorize', text: demo ? 'Missão demonstrativa.' : 'Autorize uma nova tentativa, se quiser repetir.' };
  else out.next = { action: null, text: 'Nenhuma ação necessária.' };

  // --- detalhes técnicos ---
  const d = out.details;
  if (task.agent) d.push({ k: 'Perfil do agente', v: String(task.agent) });
  if (task.startedAt) d.push({ k: 'Iniciada', at: task.startedAt });
  if (task.finishedAt) d.push({ k: 'Terminou', at: task.finishedAt });
  if (task.exitCode !== undefined && task.exitCode !== null) d.push({ k: 'Código de saída', v: String(task.exitCode), mono: true });
  if (task.usage?.durationMs != null) d.push({ k: 'Duração', v: dur(task.usage.durationMs) });
  else if (task.startedAt && task.finishedAt) d.push({ k: 'Duração', v: dur(Date.parse(task.finishedAt) - Date.parse(task.startedAt)) });
  if (task.usage?.turns != null) d.push({ k: 'Turnos', v: String(task.usage.turns) });
  if (task.usage?.costUsd != null) d.push({ k: 'Custo reportado pela CLI', v: `US$ ${Number(task.usage.costUsd).toFixed(4)}` });
  if (task.permissionDenied) d.push({ k: 'Permissão negada', v: 'sim' });
  if (task.dependsOn?.length) d.push({ k: 'Depende de', v: `${task.dependsOn.length} ${task.dependsOn.length === 1 ? 'tarefa' : 'tarefas'}` });
  if (round) d.push({ k: 'Rodada do ciclo', v: `${round.n}${round.phase === 'verifying' ? ' (verificando)' : ''}` });
  if (task.id) d.push({ k: 'Identificador', v: task.id, mono: true });
  return out;
}

// ---------- marca visual dos agentes e do orquestrador ----------
/**
 * Visual de um AGENTE (Planner ou Executor) a partir do estado ATUAL que o servidor informa (/api/agents) e, só para o Executor, da falha mais recente.
 * Quatro tons no máximo: inativo (cinza), executando (âmbar), erro (vermelho). Não existe "concluído" para agentes: o verde é só de tarefas concluídas, e um
 * agente ocioso nunca parece concluído por causa de uma execução anterior. `failed` só é considerado quando o agente não está executando nem desconectado.
 */
export function agentVisual(agent, { failed = false } = {}) {
  const s = agentState(agent);
  if (s === 'active') return { tone: 'running', shape: 'disc', label: 'executando' };
  if (!agent) return { tone: 'inactive', shape: 'dash', label: 'sem dados' };
  if (s === 'disconnected') return { tone: 'inactive', shape: 'dash', label: 'desconectado' };
  if (s === 'unavailable') return { tone: 'inactive', shape: 'dash', label: 'indisponível' };
  if (failed) return { tone: 'error', shape: 'tri', label: 'erro' };
  return { tone: 'inactive', shape: 'ring', label: 'inativo' };
}

/**
 * Visual do ORQUESTRADOR (o modo de coreMode). É outra coisa que os agentes: usa tons próprios e os rótulos de sempre, em especial
 * "Aguardando decisão humana" em âmbar com losango quando há decisão pendente. Só a marca (forma + cor + texto) é compartilhada com os agentes.
 */
export function orchestratorVisual(mode) {
  const label = CORE_LABEL[mode] ?? CORE_LABEL.idle;
  if (mode === 'planning' || mode === 'executing') return { tone: 'orch-run', shape: 'half', label };
  if (mode === 'awaiting') return { tone: 'wait', shape: 'diamond', label };
  if (mode === 'error') return { tone: 'error', shape: 'tri', label };
  return { tone: 'inactive', shape: 'ring', label };
}
