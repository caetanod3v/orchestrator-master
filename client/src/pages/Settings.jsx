import React from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Panel } from '../components/ui.jsx';

export default function Settings() {
  const { state, act } = useStore();
  if (!state) return null;
  const s = state.settings;
  return (
    <div className="two">
      <Panel title="Configurações locais">
        <label className="check">
          <input type="checkbox" checked={s.showDemoData} onChange={(e) => act(() => api.put('/api/settings', { showDemoData: e.target.checked }))} />
          Exibir missão demonstrativa
        </label>
        <label className="check"><input type="checkbox" checked disabled /> Exigir aprovação humana antes de cada tarefa manual (fixo)</label>
        <p className="dim small">No ciclo autônomo, a aprovação humana é iniciar o ciclo (com limite de rodadas); as tarefas do ciclo não pedem aprovação individual.</p>
        <p className="dim small">Dados em <span className="mono">data/db.json</span>. API somente em 127.0.0.1.</p>
      </Panel>
      <Panel title="Segurança">
        <ul className="plain small rules">
          <li>Sem execução arbitrária de comandos. O servidor executa, com argumentos fixos e sem usar shell na chamada: <span className="mono">claude --version</span> (detecção); <span className="mono">claude -p</span> (Planner, sem ferramentas, e Executor, com as ferramentas Read, Edit, Write, Glob e Grep; Bash e acesso à web não estão entre elas); <span className="mono">git status</span> e <span className="mono">git diff --numstat</span> (somente leitura); e <span className="mono">npm run test|build|lint|typecheck</span>, só para scripts aprovados por um humano em Espaços de trabalho e cujo texto não mudou desde a aprovação; a chamada do servidor não usa shell, mas o npm executa o conteúdo do script (código do projeto, inclusive o que o Executor editou). Também usa utilitários do sistema para identificar e encerrar o processo de uma execução.</li>
          <li>Sem <span className="mono">--dangerously-skip-permissions</span> ou equivalentes; pedidos de permissão do Claude Code são negados automaticamente.</li>
          <li>Alcance das restrições do Claude Code: valem para as ferramentas disponíveis. Planner e Executor carregam as configurações de usuário (<span className="mono">--setting-sources user</span>) e o orquestrador não desativa hooks, então hooks definidos nessa configuração podem executar comandos. Para servidores MCP, é passado <span className="mono">--strict-mcp-config</span> sem <span className="mono">--mcp-config</span>, o que, segundo a documentação da CLI, ignora as demais configurações de MCP.</li>
          <li>O orquestrador não faz commit nem push (as ferramentas do Executor não incluem shell).</li>
          <li>Requisições de origens externas ao localhost são recusadas.</li>
          <li>Executor: <b>{state.executor.available ? `Claude Code ${state.executor.version} detectado` : 'Claude Code não detectado no PATH'}</b>.</li>
        </ul>
      </Panel>
    </div>
  );
}
