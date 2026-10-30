import React from 'react';

// Só a apresentação: as chaves são os valores internos/da API e não mudam (também viram a classe CSS `s-<valor>`).
export const STATUS = {
  running: 'em execução', completed: 'concluída', failed: 'falhou', unverified: 'não comprovada', verified: 'comprovada', inconclusive: 'inconclusiva', queued: 'na fila',
  awaiting_approval: 'aguardando aprovação', interrupted: 'interrompida', planning: 'planejando', blocked: 'bloqueada', cancelled: 'cancelada', limit_reached: 'limite atingido', succeeded: 'bem-sucedida', not_connected: 'não conectado', idle: 'ocioso', degraded: 'degradado',
};
// Concordância: o padrão acima é feminino (missão, tarefa, rodada); o ciclo é masculino (`masc`).
const STATUS_MASC = { completed: 'concluído', interrupted: 'interrompido', blocked: 'bloqueado', cancelled: 'cancelado', succeeded: 'bem-sucedido' };
export const statusLabel = (value, masc) => (masc && STATUS_MASC[value]) || STATUS[value] || value;

// Tipos de evento da Atividade (a chave é o `type` gravado pelo servidor).
export const TYPE_LABEL = {
  mission: 'missão', task: 'tarefa', approval: 'aprovação', rejection: 'rejeição', workspace: 'espaço de trabalho',
  settings: 'configurações', system: 'sistema', execution: 'execução', cycle: 'ciclo', chat: 'conversa',
};
export const typeLabel = (type) => TYPE_LABEL[type] || type;

// Resultado de uma verificação real e decisão do Planner, como o servidor os registra.
export const VERIFICATION_LABEL = {
  pass: 'passou', fail: 'falhou', error: 'erro', cancelled: 'cancelada', timeout: 'tempo esgotado', output_limit: 'saída acima do limite',
};
// Evidência do sistema (M8): o relato do Executor nunca conclui; só a evidência independente conclui uma etapa.
export const EVIDENCE_BASIS = { real_verification: 'verificação real', expected_files: 'arquivos esperados conferidos', 'real_verification+expected_files': 'verificação real e arquivos esperados', executor_claim_only: 'só o relato do Executor' };
export const DECISION_LABEL = { continue: 'continuar', complete: 'concluir', blocked: 'bloquear', plan: 'planejar etapas' };

export const Status = ({ value, masc }) => (
  <span className={`status s-${value}`}><i />{statusLabel(value, masc)}</span>
);

export const DemoTag = ({ title = 'Dado demonstrativo, não real' }) => <span className="demo" title={title}>DEMO</span>;

export const Panel = ({ title, right, children, className = '', demo }) => (
  <section className={`panel ${className}`}>
    <header><h3>{title}{demo && <DemoTag />}</h3><div className="right">{right}</div></header>
    <div className="body">{children}</div>
  </section>
);

export const Empty = ({ children }) => <div className="empty">{children}</div>;

export const Btn = ({ kind = '', ...p }) => <button className={`btn ${kind}`} {...p} />;

export const Progress = ({ done, total }) => (
  <div className="progress" title={`${done}/${total}`} role="progressbar" aria-label="Progresso das tarefas" aria-valuemin={0} aria-valuemax={Math.max(total, 1)} aria-valuenow={done}>
    <div style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
  </div>
);

export const fmtTime = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });

/** Último incidente de gravação do servidor (/api/state.persistenceIncident): só o código do erro, quando começou, quantas falhas e se a gravação já voltou. */
export const PersistenceNote = ({ incident }) => (incident ? (
  <span>
    Incidente de gravação: erro <b>{incident.error}</b> desde {fmtTime(incident.failedAt)} · {incident.failures} {incident.failures === 1 ? 'falha' : 'falhas'} ·{' '}
    {incident.recoveredAt ? `gravação restabelecida em ${fmtTime(incident.recoveredAt)}` : 'a gravação ainda não voltou'}
  </span>
) : null);

export function taskBlocked(task, tasks) {
  return task.dependsOn.some((d) => tasks.find((t) => t.id === d)?.status !== 'completed');
}
