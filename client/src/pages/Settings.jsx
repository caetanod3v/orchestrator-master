import React from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Panel } from '../components/ui.jsx';
import { orchestrationForm, hasActiveCycle, RETRY_CHOICES, retryChoiceLabel } from '../orchestration-view.js';
import { supervisionForm, minutesLabel, resumeLabel } from '../supervision-view.js';

export default function Settings() {
  const { state, missions, act } = useStore();
  if (!state) return null;
  const s = state.settings;
  const form = orchestrationForm(state.orchestration, { activeCycle: hasActiveCycle(missions) });
  const sform = supervisionForm(state.supervision, { activeCycle: hasActiveCycle(missions) });
  const put = (body) => act(() => api.put('/api/settings', body));
  const src = (f) => <p className="dim small">{f.sourceLabel}{f.reason && ` · ${f.reason}`}</p>;
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
      {form && (
        <Panel title="Orquestração">
          <label className="check">
            <input type="checkbox" data-testid="opt-plan" checked={form.planMode.value} disabled={form.planMode.disabled} onChange={(e) => put({ planMode: e.target.checked })} />
            Planejar em várias etapas (o Planner divide o objetivo em etapas com dependências)
          </label>
          <p className="dim small" data-testid="opt-plan-source">{form.planMode.sourceLabel}{form.planMode.reason && ` · ${form.planMode.reason}`}</p>
          <label>Retentativas automáticas por ciclo
            <select data-testid="opt-retries" value={form.stepRetries.value} disabled={form.stepRetries.disabled} onChange={(e) => put({ stepRetries: Number(e.target.value) })}>
              {RETRY_CHOICES.map((n) => <option key={n} value={n}>{retryChoiceLabel(n)}</option>)}
            </select>
          </label>
          <p className="dim small" data-testid="opt-retries-source">{form.stepRetries.sourceLabel}{form.stepRetries.reason && ` · ${form.stepRetries.reason}`}</p>
          {form.warnings.map((w) => <p key={w} className="stale" data-testid="opt-warning">{w}</p>)}
          <ul className="plain small">{form.notes.map((n) => <li key={n} className="dim">{n}</li>)}</ul>
        </Panel>
      )}
      {sform && (
        <Panel title="Supervisão">
          <label className="check">
            <input type="checkbox" data-testid="sup-enabled" checked={sform.supervisor.value} disabled={sform.supervisor.disabled} onChange={(e) => put({ supervisor: e.target.checked })} />
            Supervisão autônoma (registra cada decisão e bloqueia falha repetida)
          </label>
          {src(sform.supervisor)}
          <label>Duração total do ciclo (tempo ativo)
            <select data-testid="sup-max" value={sform.maxMinutes.value} disabled={sform.maxMinutes.disabled} onChange={(e) => put({ maxMinutes: Number(e.target.value) })}>
              {sform.maxChoices.map((n) => <option key={n} value={n}>{minutesLabel(n)}</option>)}
            </select>
          </label>
          {src(sform.maxMinutes)}
          <label>Execução sem nenhuma saída
            <select data-testid="sup-stall" value={sform.stallMinutes.value} disabled={sform.stallMinutes.disabled} onChange={(e) => put({ stallMinutes: Number(e.target.value) })}>
              {sform.stallChoices.map((n) => <option key={n} value={n}>{minutesLabel(n)}</option>)}
            </select>
          </label>
          {src(sform.stallMinutes)}
          <label>Retomada automática (falhas transitórias do Planner)
            <select data-testid="sup-resume" value={sform.autoResumes.value} disabled={sform.autoResumes.disabled} onChange={(e) => put({ autoResumes: Number(e.target.value) })}>
              {sform.resumeChoices.map((n) => <option key={n} value={n}>{resumeLabel(n)}</option>)}
            </select>
          </label>
          {src(sform.autoResumes)}
          <ul className="plain small">{sform.notes.map((n) => <li key={n} className="dim">{n}</li>)}</ul>
        </Panel>
      )}
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
