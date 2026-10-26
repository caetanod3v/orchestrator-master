import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Btn, Status, statusLabel, VERIFICATION_LABEL, DECISION_LABEL } from './ui.jsx';

const CODE = {
  planner_blocked: 'O Planner pediu intervenção humana', planner_invalid: 'Resposta do Planner inválida', planner_error: 'Falha do Planner',
  executor_failures: 'Execuções falharam em sequência', no_progress: 'Sem progresso', needs_approval: 'Permissão necessária',
  interrupted: 'Execução interrompida', verification_blocked: 'Verificação não pôde rodar', cannot_start: 'Não foi possível iniciar', restarted: 'Servidor reiniciado',
  planner_calls_limit: 'Limite de consultas ao Planner', internal_error: 'Erro interno',
};

function Round({ r }) {
  const rep = r.report;
  return (
    <details className="round">
      <summary>
        <span className="n">{String(r.n).padStart(2, '0')}</span> <span className="grow">{r.plan.title}</span>
        {r.phase === 'verifying' && <span className="s-running small">verificando…</span>}
        <Status value={r.status} />
      </summary>
      <div className="small">
        <div className="k">planejado pelo Planner</div>
        <p>{r.plan.rationale}</p>
        <p className="dim">{r.plan.instructions}</p>
        <ul className="plain">{r.plan.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
        {rep ? <>
          <div className="k">relatório do Executor ({rep.status === 'success' ? 'sucesso' : statusLabel(rep.status, true)})</div>
          <p>{rep.summary || <span className="dim">sem resumo</span>}</p>
          <div className="dim">arquivos: {rep.filesKnown ? (rep.filesChanged.map((f) => f.path).join(', ') || 'nenhum') : 'desconhecido (sem Git)'}</div>
          {rep.verifications?.length > 0 && <>
            <div className="k">verificações reais (executadas pelo orquestrador)</div>
            {rep.verifications.map((v) => (
              <div key={v.id} className={v.status === 'pass' ? 's-completed' : 's-failed'}>
                {v.command}: <b>{VERIFICATION_LABEL[v.status] || v.status}</b>{v.exitCode != null && ` · código ${v.exitCode}`} · {(v.durationMs / 1000).toFixed(1)} s{v.required && ' · obrigatória'}{v.reason && ` · ${v.reason}`}
                {v.status !== 'pass' && v.outputTail && <pre className="vout">{v.outputTail.slice(-600)}</pre>}
              </div>
            ))}
          </>}
          {rep.previousVerifications?.length > 0 && <div className="dim">verificações refeitas após retomada ({rep.previousVerifications.length} resultado(s) anterior(es) guardado(s) para auditoria)</div>}
          {rep.verificationsSkipped && <div className="dim">verificações reais não executadas: {rep.verificationsSkipped}</div>}
          <div className="dim">verificações autodeclaradas pelo Executor (confiança menor): {rep.checks.length ? rep.checks.map((c) => `${c.name}=${c.result}`).join('; ') : rep.checksReported ? 'nenhuma' : 'não reportadas'}</div>
          {rep.errors.map((e, i) => <div key={i} className="s-failed">{e}</div>)}
          {rep.blockers.map((e, i) => <div key={i} className="s-blocked">⚠ {e}</div>)}
        </> : <div className="dim">sem relatório ainda</div>}
        {r.decision && <><div className="k">decisão seguinte</div><p><b>{DECISION_LABEL[r.decision.decision] || r.decision.decision}</b>: {r.decision.rationale}</p></>}
      </div>
    </details>
  );
}

/** Ciclo autônomo da missão: iniciar com limite, acompanhar rodadas, cancelar e retomar. O servidor valida tudo. */
export default function CyclePanel({ mission }) {
  const { state, act, notify } = useStore();
  const c = mission.cycle;
  const hard = state?.settings.cycleHardMax ?? 10;
  const [max, setMax] = useState(state?.settings.cycleMaxIterations ?? 5);
  const [note, setNote] = useState('');
  const active = !!c && ['planning', 'running'].includes(c.status);
  const blocked = c?.status === 'blocked';
  const why = mission.demo ? 'Missão demonstrativa: ciclo real desabilitado.'
    : !mission.workspaceId ? 'A missão não tem espaço de trabalho.'
    : state?.executor.available === false ? 'Claude Code não encontrado.'
    : state?.executor.busy ? 'Há uma execução em andamento.' : null;

  const call = async (path, body, ok) => {
    const r = await act(async () => { await api.post(`/api/missions/${mission.id}/cycle/${path}`, body); return true; });
    if (r && ok) notify(ok);
  };

  return (
    <div className="cycle">
      <div className="row"><b className="sub">Ciclo autônomo</b>{c && <Status value={c.status} masc />}</div>
      {c && <div className="dim small">rodada {c.rounds.length} de no máximo {c.maxIterations} · consultas ao Planner: {c.plannerCalls}</div>}
      {blocked && <p className="s-blocked small">⚠ {CODE[c.blockedCode] || c.blockedCode}: {c.blockedReason}</p>}
      {c?.status === 'completed' && <div className="small"><p><b className="s-completed">Concluído</b> <span className="dim">({c.assurance === 'verified' ? 'com verificações reais obrigatórias aprovadas' : 'sem verificações reais obrigatórias: apenas evidências autodeclaradas'})</span>. {c.finalSummary}</p><ul className="plain">{(c.evidence || []).map((e) => <li key={e}>{e}</li>)}</ul></div>}
      {c?.status === 'limit_reached' && <p className="s-blocked small">Limite de rodadas atingido sem conclusão.</p>}
      {c?.status === 'cancelled' && <p className="dim small">Ciclo cancelado.</p>}

      {(!c || ['completed', 'cancelled', 'limit_reached'].includes(c.status)) && (
        <div className="form">
          <p className="dim small">O Planner decide as tarefas e o Executor as realiza sem aprovação individual. Só lê e edita arquivos no espaço de trabalho; qualquer permissão extra é negada e pausa o ciclo.</p>
          <label>Limite de rodadas (1 a {hard})
            <input type="number" min="1" max={hard} value={max} onChange={(e) => setMax(Number(e.target.value))} />
          </label>
          {why && <p className="dim small">⚠ {why}</p>}
          <Btn kind="primary" disabled={!!why} onClick={() => call('start', { maxIterations: max }, 'Ciclo iniciado.')}>▶ Iniciar ciclo autônomo</Btn>
        </div>
      )}
      {active && <div className="actions"><Btn kind="danger" onClick={() => call('cancel', {}, 'Cancelamento solicitado.')}>✕ Cancelar ciclo</Btn></div>}
      {blocked && (
        <div className="form">
          <label>Orientação para o Planner (opcional)<textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="actions">
            <Btn kind="primary" onClick={() => call('resume', { note }, 'Ciclo retomado.')}>▶ Retomar</Btn>
            <Btn kind="danger" onClick={() => call('cancel', {}, 'Ciclo cancelado.')}>✕ Cancelar ciclo</Btn>
          </div>
        </div>
      )}
      {c?.rounds.length > 0 && <div className="rounds">{c.rounds.map((r) => <Round key={r.n} r={r} />)}</div>}
    </div>
  );
}
