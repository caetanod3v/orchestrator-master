// Rótulos puros (sem React) compartilhados pela interface e pelos testes.
// Só a apresentação: as chaves são os valores internos/da API e não mudam (também viram a classe CSS `s-<valor>`).
export const STATUS = {
  running: 'em execução', completed: 'concluída', failed: 'falhou', unverified: 'não comprovada', verified: 'comprovada', inconclusive: 'inconclusiva', queued: 'na fila',
  awaiting_approval: 'aguardando aprovação', interrupted: 'interrompida', planning: 'planejando', blocked: 'bloqueada', cancelled: 'cancelada', limit_reached: 'limite atingido', succeeded: 'bem-sucedida', not_connected: 'não conectado', idle: 'ocioso', degraded: 'degradado',
};
// Concordância: o padrão acima é feminino (missão, tarefa, rodada); o ciclo é masculino (`masc`).
const STATUS_MASC = { completed: 'concluído', interrupted: 'interrompido', blocked: 'bloqueado', cancelled: 'cancelado', succeeded: 'bem-sucedido' };
export const statusLabel = (value, masc) => (masc && STATUS_MASC[value]) || STATUS[value] || value;

// Evidência do sistema (M8): o relato do Executor nunca conclui; só a evidência independente conclui uma etapa.
export const EVIDENCE_BASIS = { real_verification: 'verificação real', expected_files: 'arquivos esperados conferidos', 'real_verification+expected_files': 'verificação real e arquivos esperados', executor_claim_only: 'só o relato do Executor' };
