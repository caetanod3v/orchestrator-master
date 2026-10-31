import React from 'react';
import { agentVisual } from '../op-state.js';

/** Marca de estado compartilhada: forma + cor + texto (a cor nunca é o único sinal). Usada pelos agentes e pelo cabeçalho do orquestrador, cada um com o seu mapeamento (op-state.js). */
export function StateMark({ tone, shape, label, className = '', hideText = false }) {
  return (
    <span className={`ag ${className}`.trim()} data-tone={tone}>
      <i className={`mark m-${shape}`} aria-hidden="true" />
      <span className={hideText ? 'sr' : 'ag-text'}>{label}</span>
    </span>
  );
}

/** Estado de um agente (/api/agents). `failed`: só para o Executor, a falha mais recente. */
export default function AgentStatus({ agent, failed = false, className }) {
  return <StateMark {...agentVisual(agent, { failed })} className={className} />;
}
