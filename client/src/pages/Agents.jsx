import React from 'react';
import { useStore } from '../store.jsx';
import { Panel } from '../components/ui.jsx';
import { AgentCard } from '../components/Widgets.jsx';

const Pipe = ({ title, steps }) => (
  <div className="pipe-wrap">
    <h4>{title}</h4>
    <ol className="pipe">
      {steps.map((s, i) => <li key={i}>{s.b ? <b>{s.t}</b> : s.t}</li>)}
    </ol>
  </div>
);

export default function Agents() {
  const { agents } = useStore();
  return (
    <div className="two">
      <Panel title="Agentes">
        <div className="agent-list">{agents.map((a) => <AgentCard key={a.id} agent={a} />)}</div>
      </Panel>
      <Panel title="Como trabalham juntos">
        <Pipe title="Tarefa manual" steps={[{ t: 'Você' }, { t: 'Missão' }, { t: 'Tarefa' }, { t: 'Autorização humana' }, { t: 'Executor', b: true }, { t: 'Revisão humana' }]} />
        <Pipe title="Ciclo autônomo" steps={[{ t: 'Você inicia o ciclo' }, { t: 'Planner', b: true }, { t: 'Executor', b: true }, { t: 'Verificações reais (se aprovadas)' }, { t: 'Relatório' }, { t: 'Planner', b: true }]} />
        <p className="dim lead-p">Planner e Executor são responsabilidades separadas e usam o Claude Code instalado: o Planner sem ferramentas (só texto, validado pelo servidor) e o Executor com leitura e edição de arquivos no espaço de trabalho. O estado de cada agente vem do servidor.</p>
      </Panel>
    </div>
  );
}
