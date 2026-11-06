// Histórico de sessões de terminal (GET /api/terminals/history) para a tela de retomada. PURO (sem React): só organiza e rotula os dados que o servidor já devolve.
// A decisão de poder retomar é SEMPRE do servidor (`resumable`/`blockedReason`); aqui nada é inferido nem recalculado, e a retomada refaz todas as checagens lá.
export const STATE_LABEL = Object.freeze({ running: 'ativa', interrupted: 'interrompida', exited: 'encerrada' });
export const REASON_LABEL = Object.freeze({
  user: 'fechada por você', exit: 'terminou sozinha', shutdown: 'estava aberta quando o servidor foi encerrado', crash: 'estava aberta quando o servidor caiu',
});
const BLOCKED_SHORT = Object.freeze({
  session_active: 'já está aberta', transcript_missing: 'sem transcrição', workspace_missing: 'workspace removido', workspace_invalid: 'workspace inválido',
  worktree_missing: 'worktree removido', worktree_invalid: 'worktree indisponível', worktree_busy: 'worktree em uso', cwd_mismatch: 'pasta diferente', role_unknown: 'papel inexistente', invalid_record: 'registro inválido',
});
const arr = (x) => (Array.isArray(x) ? x : []);

/**
 * Linhas do histórico de UM workspace. `restore` = sessões que estavam abertas quando o servidor parou (interrompidas) e ainda podem voltar; vêm primeiro.
 * Dentro de cada grupo vale a ordem do servidor (mais recente primeiro). `topicId` (opcional) restringe ao tópico ativo; Geral (null) = sessões sem tópico.
 */
export function historyRows({ history, workspaceId, topics = [], topicId, onlyTopic = false }) {
  const title = new Map(arr(topics).map((t) => [t.id, t.title]));
  const rows = arr(history).filter((h) => h && h.workspaceId === workspaceId && (!onlyTopic || (h.topicId ?? null) === (topicId ?? null))).map((h) => ({
    id: h.id, title: String(h.title ?? ''), roleLabel: h.roleLabel ?? h.role, color: h.color ?? null, state: h.state, stateLabel: STATE_LABEL[h.state] ?? String(h.state),
    reasonLabel: REASON_LABEL[h.closedReason] ?? null, topicId: h.topicId ?? null, topicTitle: h.topicId ? (title.get(h.topicId) ?? 'tópico arquivado') : 'Geral',
    resumable: h.resumable === true, active: h.active === true, blockedCode: h.blockedReason ?? null, blockedShort: BLOCKED_SHORT[h.blockedReason] ?? null, blockedMessage: h.blockedMessage ?? null,
    resumes: Number.isInteger(h.resumes) ? h.resumes : 0, usesWorktree: !!h.worktreeId, startedAt: h.startedAt ?? null, endedAt: h.endedAt ?? null, forked: !!h.forkedFrom,
    restore: h.state === 'interrupted' && h.resumable === true,
  }));
  return { restore: rows.filter((r) => r.restore), others: rows.filter((r) => !r.restore) };
}

/** Corpo do POST /api/terminals/resume: só o id do registro (UUID, caminhos e papel vêm do banco, nunca do cliente). */
export const resumeBody = ({ recordId, fork = false, ack = false, cols = 120, rows = 32 }) => ({ recordId, fork: fork === true, cols, rows, ...(ack ? { acknowledgeProjectConfig: true } : {}) });

/** O servidor recusou por configuração executável não revisada: a tela pergunta e só repete com a confirmação explícita. */
export const needsConfigAck = (e) => e?.code === 'project_config_unreviewed';

/** Resumo de uma frase para a barra: quantas sessões estavam abertas e podem voltar. */
export const restoreSummary = (rows) => (rows.restore.length ? `${rows.restore.length} ${rows.restore.length === 1 ? 'sessão estava aberta' : 'sessões estavam abertas'} e pode${rows.restore.length === 1 ? '' : 'm'} ser retomada${rows.restore.length === 1 ? '' : 's'}` : null);

/**
 * Restauração em lote (só as que "estavam abertas" e que o servidor diz serem retomáveis; nunca fork). Respeita as vagas livres: o que não cabe fica de fora e é informado.
 * `room` = terminais ainda permitidos (limite do servidor menos os vivos).
 */
export function restorePlan(restoreRows, room) {
  const rows = arr(restoreRows).filter((r) => r && r.restore && r.resumable);
  const n = Math.max(0, Number.isFinite(room) ? Math.floor(room) : 0);
  return { open: rows.slice(0, n), skipped: rows.slice(n) };
}

/** Resume o resultado do lote: results = [{ row, ok, error?, code? }]; `skippedNoRoom` = quantas ficaram de fora por falta de vaga. */
export function batchSummary(results, skippedNoRoom = 0) {
  const ok = arr(results).filter((r) => r.ok), bad = arr(results).filter((r) => !r.ok);
  const parts = [];
  if (ok.length) parts.push(`${ok.length} ${ok.length === 1 ? 'sessão retomada' : 'sessões retomadas'}`);
  if (bad.length) parts.push(`${bad.length} ${bad.length === 1 ? 'falhou' : 'falharam'}: ${bad.map((b) => `${b.row.title} (${b.error || 'erro'})`).join('; ')}`);
  if (skippedNoRoom > 0) parts.push(`${skippedNoRoom} ${skippedNoRoom === 1 ? 'ficou' : 'ficaram'} de fora por falta de vaga (limite de terminais)`);
  return { text: parts.join(' · ') || 'Nada a restaurar.', kind: bad.length || skippedNoRoom ? 'error' : 'info', ok: ok.length, failed: bad.length };
}
