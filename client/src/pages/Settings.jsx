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
        <label className="check"><input type="checkbox" checked disabled /> Exigir aprovação humana antes de cada tarefa (fixo)</label>
        <p className="dim small">Dados em <span className="mono">data/db.json</span>. API somente em 127.0.0.1.</p>
      </Panel>
      <Panel title="Segurança">
        <ul className="plain small">
          <li>Sem execução arbitrária de comandos: apenas <span className="mono">claude --version</span> e <span className="mono">git status</span> (somente leitura), com argumentos fixos.</li>
          <li>Sem <span className="mono">--dangerously-skip-permissions</span> ou equivalentes.</li>
          <li>Sem commits ou push automáticos.</li>
          <li>Requisições de origens externas ao localhost são recusadas.</li>
          <li>Executor: <b>{state.executor.available ? `Claude Code ${state.executor.version}` : 'não detectado'}</b>, não conectado.</li>
        </ul>
      </Panel>
    </div>
  );
}
