// Visão compacta do Maestro, PURA: só reorganiza as tarefas reais de /api/maestro (nada é inventado).
// Pendentes e falhas exigem o usuário e ganham destaque; o resto (entregue, concluída, recusada, expirada) é rotina e vira uma linha de timeline.

export const TASK_LABEL = { pending: 'aguardando você', delivered: 'entregue', done: 'concluída', rejected: 'recusada', failed: 'falhou', expired: 'expirada' };
const ROUTINE = new Set(['delivered', 'done', 'rejected', 'expired']);

/** Contagens por estado + o que merece destaque. `attention` = há decisão humana pendente ou tarefa que falhou. */
export function maestroSummary(tasks = []) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const n = (st) => list.filter((t) => t.status === st).length;
  const pending = n('pending'), failed = n('failed');
  return { total: list.length, pending, failed, delivered: n('delivered'), done: n('done'), attention: pending > 0 || failed > 0 };
}

/** Instante mais relevante da tarefa para ordenar a timeline (conclusão, decisão ou criação). */
export const taskAt = (t) => t?.doneAt || t?.decidedAt || t?.createdAt || '';

/** Linhas da timeline: tarefas que NÃO esperam o usuário, da mais recente para a mais antiga, no máximo `limit`. */
export function timelineRows(tasks = [], limit = 20) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.status !== 'pending')
    .map((t) => ({ id: t.id, status: t.status, routine: ROUTINE.has(t.status), toTitle: t.toTitle ?? '', text: String(t.summary || t.note || t.text || ''), at: taskAt(t) }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, Math.max(0, limit));
}

/** Uma linha de resumo para a faixa recolhida. */
export function collapsedLine(tasks = [], autonomous = false) {
  const s = maestroSummary(tasks);
  const parts = [];
  if (s.pending) parts.push(`${s.pending} aguardando você`);
  if (s.failed) parts.push(`${s.failed} ${s.failed === 1 ? 'falha' : 'falhas'}`);
  if (!parts.length) parts.push(s.total ? `${s.done} ${s.done === 1 ? 'concluída' : 'concluídas'} de ${s.total}` : (autonomous ? 'sem tarefas ainda' : 'nenhuma tarefa'));
  return parts.join(' · ');
}
