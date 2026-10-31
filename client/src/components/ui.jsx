import React from 'react';

import { STATUS, statusLabel, EVIDENCE_BASIS } from '../labels.js';
export { STATUS, statusLabel, EVIDENCE_BASIS };

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
export const DECISION_LABEL = { continue: 'continuar', complete: 'concluir', blocked: 'bloquear', plan: 'planejar etapas' };

export const Status = ({ value, masc, label }) => (
  <span className={`status s-${value}`}><i />{label ?? statusLabel(value, masc)}</span>
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

// Glifo de cada estado: a forma (não só a cor) diz o que é. Ver .glyph em styles.css. `done` é um check desenhado.
export const GLYPH = { active: 'g-run', idle: 'g-ring', live: 'g-ring', awaiting: 'g-diamond', disconnected: 'g-dash', unavailable: 'g-dash', error: 'g-tri', done: 'g-ok', interrupted: 'g-sq', queued: 'g-dring' };
export const Glyph = ({ kind }) => (kind === 'done'
  ? <svg className="glyph g-ok" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 6.4l2.6 2.6L10 3.4" /></svg>
  : <i className={`glyph ${GLYPH[kind] || 'g-ring'}`} aria-hidden="true" />);
// estado de uma tarefa/etapa -> glifo
export const TASK_GLYPH = { completed: 'done', running: 'active', awaiting_approval: 'awaiting', failed: 'error', interrupted: 'interrupted', queued: 'queued', verified: 'done', unverified: 'awaiting' };

/** Uma barra segmentada: um trecho por tarefa, colorido pelo estado real. O texto ao lado repete a contagem, então a cor só reforça. */
const SEG = { completed: 'done', running: 'run', awaiting_approval: 'wait', failed: 'fail', interrupted: 'fail' };
export const TaskSegments = ({ tasks }) => (
  <div className="segs" role="img" aria-label={`${tasks.filter((t) => t.status === 'completed').length} de ${tasks.length} tarefas concluídas`}>
    {tasks.map((t) => <span key={t.id} className={`seg ${SEG[t.status] || ''}`} title={`${t.title}: ${statusLabel(t.status)}`} />)}
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

// Ícones de traço único (24x24), usados em toda a interface. Decorativos (aria-hidden): o texto ao lado sempre diz o mesmo.
const ICONS = {
  menu: 'M4 7h16M4 12h16M4 17h16', close: 'M6 6l12 12M18 6L6 18', plus: 'M12 5v14M5 12h14', send: 'M12 19V5M5 12l7-7 7 7', check: 'M5 12l5 5 9-10',
  chevronUp: 'M6 15l6-6 6 6', chevronDown: 'M6 9l6 6 6-6', chevronRight: 'M9 6l6 6-6 6', chevronsUpDown: 'M8 9l4-4 4 4M8 15l4 4 4-4', stop: 'M7 7h10v10H7z', alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4', panel: 'M4 5h16v14H4zM9 5v14', info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6', xCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6', alertCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5v5M12 16h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2', paperclip: 'M20 12l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8', play: 'M8 5.5l11 6.5-11 6.5z', arrowRight: 'M5 12h14M13 6l6 6-6 6',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z', cockpit: 'M4 4h7v8H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 14h7v6H4z',
  missions: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', agents: 'M12 4a3.2 3.2 0 1 0 0 6.4A3.2 3.2 0 0 0 12 4zM5 20a7 7 0 0 1 14 0',
  workspace: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  planner: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17c7 0 2-10 8-10', executor: 'M4 6l6 6-6 6M12 18h8',
  gate: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM9 12l2 2 4-4', queue: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  task: 'M5 5h14v14H5zM9 12l2 2 4-4', minus: 'M5 12h14', fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', copy: 'M9 9h10v10H9zM5 15V5h10',
};
export const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={ICONS[name]} /></svg>
);

/** Ciclo da missão parado numa ação que espera aprovação humana (M9): dado real do servidor, nunca inferido. */
export const cycleApprovalPending = (m) => m?.cycle?.status === 'blocked' && m.cycle.blockedCode === 'approval_required' && (m.cycle.approvals || []).some((a) => a?.status === 'pending');
