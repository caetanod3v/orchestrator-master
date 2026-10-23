import React from 'react';
import { useStore } from '../store.jsx';
import { Panel } from '../components/ui.jsx';
import { AgentCard } from '../components/Widgets.jsx';

export default function Agents() {
  const { agents } = useStore();
  return (
    <div className="two">
      <Panel title="Agentes">
        {agents.map((a) => <AgentCard key={a.id} agent={a} />)}
      </Panel>
      <Panel title="Arquitetura">
        <p className="mono small">usuário → missão → <b>planner</b> → tarefas → aprovação humana → <b>executor</b> → relatório → planner → …</p>
        <p className="dim">Planejador e executor são responsabilidades separadas. A camada de execução (<span className="mono">server/executor</span>) define o contrato e já detecta o Claude Code, mas não executa nada nesta fase. Nenhum agente está ativo.</p>
      </Panel>
    </div>
  );
}
