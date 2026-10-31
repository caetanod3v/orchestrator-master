import React, { useRef, useState } from 'react';
import { Btn, Glyph } from './ui.jsx';

/**
 * Portão de aprovação no grafo: só existe enquanto há uma aprovação REAL pendente (ver approvalGates em graph.js).
 * Os botões chamam as mesmas ações do inspetor e do painel Ciclo (nada de regra própria); enquanto uma decisão está em curso ficam desabilitados.
 */
export default function ApprovalGate({ gate, actions, style }) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false); // trava síncrona: dois cliques antes do próximo render não enviam duas decisões
  const isTask = gate.kind === 'task';
  const run = async (fn) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await fn(); } finally { lock.current = false; setBusy(false); }
  };
  const approve = () => run(() => (isTask ? actions.approveTask(gate.taskId) : actions.approveAction(gate.approval)));
  const reject = () => run(() => (isTask ? actions.rejectTask(gate.taskId) : actions.rejectAction(gate.approval)));
  return (
    <div className="fnode gate tone-wait" data-node={gate.id} role="group" aria-label={`Aguardando sua aprovação: ${gate.title}`} style={style}>
      <span className="fn-head"><span>Portão de aprovação</span><span className="status s-awaiting_approval"><Glyph kind="awaiting" />pendente</span></span>
      <span className="fn-body">
        <b className="fn-title">Aguardando sua aprovação</b>
        <span className="fn-meta">{isTask ? `Resultado de: ${gate.title}` : `Ação proposta pelo Planner: ${gate.title}`}</span>
        <span className="gate-actions">
          <Btn kind="primary" disabled={busy} onClick={approve} aria-label={`Aprovar: ${gate.title}`}>Aprovar</Btn>
          <Btn kind="danger" disabled={busy} onClick={reject} aria-label={`Rejeitar: ${gate.title}`}>Rejeitar</Btn>
          <Btn kind="quiet sm" onClick={() => actions.details(gate)}>Detalhes</Btn>
        </span>
      </span>
    </div>
  );
}
