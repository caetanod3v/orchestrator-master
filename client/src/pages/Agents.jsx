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
        <p className="mono small flow">manual: usuário → missão → tarefa → autorização humana → <b>Executor</b> → revisão humana</p>
        <p className="mono small flow">ciclo autônomo: usuário inicia o ciclo → <b>Planner</b> → <b>Executor</b> → verificações reais (se aprovadas) → relatório → Planner → …</p>
        <p className="dim">Planner e Executor são responsabilidades separadas e usam o Claude Code instalado: o Planner sem ferramentas (só texto, validado pelo servidor) e o Executor com leitura e edição de arquivos no espaço de trabalho. O estado de cada agente vem do servidor.</p>
      </Panel>
    </div>
  );
}
