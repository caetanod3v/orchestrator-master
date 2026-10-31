import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import { useCycleActions } from '../cycle-actions.js';
import { Btn, Status, Icon, statusLabel, PersistenceNote, VERIFICATION_LABEL, DECISION_LABEL, EVIDENCE_BASIS } from './ui.jsx';

const CODE = {
  planner_blocked: 'O Planner pediu intervenção humana', planner_invalid: 'Resposta do Planner inválida', planner_error: 'Falha do Planner',
  executor_failures: 'Execuções falharam em sequência', no_progress: 'Sem progresso', needs_approval: 'Permissão necessária',
  interrupted: 'Execução interrompida', verification_blocked: 'Verificação não pôde rodar', cannot_start: 'Não foi possível iniciar', restarted: 'Servidor reiniciado',
  planner_calls_limit: 'Limite de consultas ao Planner', internal_error: 'Erro interno', persistence_failed: 'Gravação em disco falhou', plan_invalid: 'Plano inconsistente',
  integrity_review: 'Testes ou configuração alterados: revisão necessária', planner_call_cap: 'Limite de chamadas ao Planner atingido', cost_budget_reached: 'Orçamento de custo estimado atingido', cost_budget_unknown: 'Orçamento de custo não verificável',
  approval_required: 'Aguardando a sua aprovação', approval_inconsistent: 'Registro de aprovações inconsistente',
};
const APPROVAL_LABEL = { pending: 'pendente', approved: 'aprovada (ainda não executada)', rejected: 'rejeitada', consumed: 'aprovada e usada', void: 'invalidada' };
// Limites configurados no servidor (ORCH_CYCLE_*): o ciclo está PAUSADO (não concluído) e só retoma depois que o limite deixar de bloquear.
const LIMIT_CODES = ['planner_call_cap', 'cost_budget_reached', 'cost_budget_unknown'];

/** Plano de etapas gravado no ciclo (M4): estado e dependências de cada etapa, etapa atual e progresso. Só leitura; quem executa e verifica é o servidor. */
function Plan({ plan, rounds }) {
  const steps = plan.steps || [];
  const done = steps.filter((s) => s.status === 'completed').length;
  const stuck = steps.some((s) => ['failed', 'interrupted', 'unverified'].includes(s.status));
  const why = (s) => (['failed', 'unverified'].includes(s.status) ? (rounds || []).find((r) => r.n === s.round)?.report?.evidence?.reasons ?? [] : []);
  return (
    <div className="small">
      <div className="k">plano · {done} de {steps.length} etapas concluídas</div>
      <ul className="plain">
        {steps.map((s) => (
          <li key={s.id}>
            <span className="n">{s.id}</span> <span className="grow">{s.title}</span> <Status value={s.status} />
            {s.dependsOn?.length > 0 && <span className="dim"> · depende de: {s.dependsOn.join(', ')}</span>}
            {s.round && <span className="dim"> · rodada {s.round}</span>}
            {s.uncertain && <span className="s-interrupted"> · resultado incerto</span>}
            {why(s).map((r, i) => <div key={i} className="dim">↳ {r}</div>)}
          </li>
        ))}
      </ul>
      {stuck && <p className="dim">Uma etapa não foi concluída (ou não pôde ser comprovada): as demais não rodam sozinhas. O Planner decide o próximo passo (novo plano, tarefa avulsa ou pedido de ajuda) ao retomar o ciclo.</p>}
    </div>
  );
}

function Round({ r }) {
  const rep = r.report;
  return (
    <details className="round">
      <summary>
        <span className="n">{String(r.n).padStart(2, '0')}</span> <span className="grow">{r.plan.title}</span>
        {r.phase === 'verifying' && <span className="status s-running"><i />verificando…</span>}
        <Status value={r.status} />
      </summary>
      <div className="small">
        <div className="k ph"><Icon name="planner" size={14} /> Planejamento · feito pelo Planner</div>
        <p>{r.plan.rationale}</p>
        <p className="dim">{r.plan.instructions}</p>
        <ul className="plain">{r.plan.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
        {rep ? <>
          <div className="k ph"><Icon name="executor" size={14} /> Execução · relatório do Executor ({rep.status === 'success' ? 'sucesso' : statusLabel(rep.status, true)})</div>
          <p>{rep.summary || <span className="dim">sem resumo</span>}</p>
          <div className="dim">arquivos: {rep.filesKnown ? (rep.filesChanged.map((f) => f.path).join(', ') || 'nenhum') : 'desconhecido (sem Git)'}</div>
          {rep.verifications?.length > 0 && <>
            <div className="k ph"><Icon name="check" size={14} /> Verificação · feita pelo orquestrador</div>
            {rep.verifications.map((v) => (
              <div key={v.id} className={v.status === 'pass' ? 's-completed' : 's-failed'}>
                {v.command}: <b>{VERIFICATION_LABEL[v.status] || v.status}</b>{v.exitCode != null && ` · código ${v.exitCode}`} · {(v.durationMs / 1000).toFixed(1)} s{v.required && ' · obrigatória'}{v.reason && ` · ${v.reason}`}
                {v.status !== 'pass' && v.outputTail && <pre className="vout">{v.outputTail.slice(-600)}</pre>}
              </div>
            ))}
          </>}
          {rep.previousVerifications?.length > 0 && <div className="dim">verificações refeitas após retomada ({rep.previousVerifications.length} resultado(s) anterior(es) guardado(s) para auditoria)</div>}
          {rep.verificationsSkipped && <div className="dim">verificações reais não executadas: {rep.verificationsSkipped}</div>}
          {rep.evidence && (
            <div data-testid="evidence">
              <div className="k ph"><Icon name="gate" size={14} /> Evidência do sistema: <Status value={rep.evidence.level} /> <span className="dim">({EVIDENCE_BASIS[rep.evidence.basis] || rep.evidence.basis})</span></div>
              <div className="dim">o Executor relatou: {rep.evidence.executorClaim.status === 'success' ? 'sucesso' : rep.evidence.executorClaim.status} <b>(declarado, não é prova)</b> · verificado pelo sistema: verificações reais = {rep.evidence.system.verification}{rep.evidence.system.expectedFiles ? ` · arquivos esperados = ${rep.evidence.system.expectedFiles.map((x) => `${x.path}: ${x.ok ? 'ok' : 'falhou'}`).join(', ')}` : ''} · integridade dos testes = {rep.evidence.system.integrity}</div>
              {rep.evidence.reasons.map((x, i) => <div key={i} className="s-blocked"><Icon name="alert" size={14} /> {x}</div>)}
            </div>
          )}
          <div className="dim">verificações autodeclaradas pelo Executor (confiança menor): {rep.checks.length ? rep.checks.map((c) => `${c.name}=${c.result}`).join('; ') : rep.checksReported ? 'nenhuma' : 'não reportadas'}</div>
          {rep.errors.map((e, i) => <div key={i} className="s-failed">{e}</div>)}
          {rep.blockers.map((e, i) => <div key={i} className="stale">{e}</div>)}
        </> : <div className="dim">sem relatório ainda</div>}
        {r.decision && <><div className="k ph"><Icon name="target" size={14} /> Decisão seguinte</div><p><b>{DECISION_LABEL[r.decision.decision] || r.decision.decision}</b>: {r.decision.rationale}</p></>}
      </div>
    </details>
  );
}

/** Ciclo autônomo da missão: iniciar com limite, acompanhar rodadas, cancelar e retomar. O servidor valida tudo. */
export default function CyclePanel({ mission }) {
  const { state } = useStore();
  const c = mission.cycle;
  const hard = state?.settings.cycleHardMax ?? 10;
  const [max, setMax] = useState(state?.settings.cycleMaxIterations ?? 5);
  const [note, setNote] = useState('');
  const active = !!c && ['planning', 'running'].includes(c.status);
  const blocked = c?.status === 'blocked';
  const [resumeMax, setResumeMax] = useState(null);
  const atRoundLimit = c?.status === 'limit_reached';
  const resumeFrom = Math.min(hard, (c?.maxIterations ?? 0) + 1); // sugestão visível: só vale se o usuário confirmar com Retomar
  const canRaise = atRoundLimit && c.rounds.length < hard;
  const why = mission.demo ? 'Missão demonstrativa: ciclo real desabilitado.'
    : !mission.workspaceId ? 'A missão não tem espaço de trabalho.'
    : state?.executor.available === false ? 'Claude Code não encontrado.'
    : state?.executor.busy ? 'Há uma execução em andamento.' : null;

  const { call, approveAction, rejectAction } = useCycleActions(mission);

  return (
    <div className="cycle">
      <div className="row"><b className="sub">Ciclo autônomo</b>{c && <Status value={c.status} masc />}</div>
      {c && <div className="dim small">rodada {c.rounds.length} de no máximo {c.maxIterations} · consultas ao Planner: {c.plannerCalls}</div>}
      {blocked && !(c.blockedCode === 'approval_required' && !(c.approvals || []).some((a) => a.status === 'pending')) && <p className="stale small">{CODE[c.blockedCode] || c.blockedCode}: {c.blockedReason}</p>}
      {blocked && c.blockedCode === 'approval_required' && !(c.approvals || []).some((a) => a.status === 'pending') && (() => {
        // o blockedReason foi gravado quando a aprovação ainda estava pendente: depois da decisão, a mensagem segue o estado REAL da solicitação
        const d = [...(c.approvals || [])].reverse().find((a) => ['approved', 'rejected'].includes(a.status));
        return <p className="stale small" data-testid="approval-decided">{d?.status === 'approved' ? `Ação aprovada, ainda não executada: "${d.action.title}". Clique em Retomar para executá-la.` : d?.status === 'rejected' ? `Ação rejeitada: "${d.action.title}" não será executada. Retome para o Planner escolher outro caminho.` : 'A solicitação foi invalidada. Retome para gerar uma nova.'}</p>;
      })()}
      {blocked && LIMIT_CODES.includes(c.blockedCode) && (
        <p className="dim small">Pausado por limite, não concluído. O limite é definido no servidor e a retomada não o altera: Retomar só é aceito depois que ele for aumentado ou desativado (ver o motivo acima); o histórico e o contador deste ciclo são mantidos. Os valores de custo são estimativas da CLI, não a cobrança real.</p>
      )}
      {blocked && c.blockedCode === 'approval_required' && (c.approvals || []).filter((a) => a.status === 'pending').map((a) => (
        <div className="small" key={a.id} data-testid="approval-request">
          <div className="k">ação que precisa da sua aprovação · {APPROVAL_LABEL[a.status]}</div>
          <p><b>{a.summary.what}</b></p>
          <div className="k">por que precisa de aprovação</div><ul className="plain">{a.summary.why.map((x, i) => <li key={i}>{x}</li>)}</ul>
          <div className="k">impacto esperado</div><ul className="plain">{a.summary.impact.map((x, i) => <li key={i}>{x}</li>)}</ul>
          <details><summary className="dim">instruções completas</summary><p className="dim">{a.action.instructions}</p></details>
          <p className="dim">A aprovação vale só para esta ação, exatamente como apresentada, e é usada uma única vez. Se algo mudar, será pedida de novo. Aprovar não executa por si só: o ciclo é retomado em seguida e a execução ainda passa pelas verificações.</p>
          <div className="actions">
            <Btn kind="primary" onClick={() => approveAction(a)}><Icon name="check" size={15} />Aprovar e continuar</Btn>
            <Btn kind="danger" onClick={() => rejectAction(a)}>Rejeitar</Btn>
          </div>
        </div>
      ))}
      {c?.approvals?.length > 0 && <div className="dim small" data-testid="approval-history">aprovações: {c.approvals.map((a) => `${a.action.title} — ${APPROVAL_LABEL[a.status]}`).join(' · ')}</div>}
      {blocked && c.blockedCode === 'integrity_review' && (
        <div className="small" data-testid="integrity-review">
          <p className="dim">O Executor mexeu em arquivos que validam o trabalho. Uma verificação que passa sobre testes alterados por ele não comprova a conclusão, então a etapa NÃO foi concluída. Se a alteração é legítima, revise-a e aprove: a aprovação vale só para o conteúdo exato que foi verificado.</p>
          <ul className="plain">{(c.integrity?.pending || []).map((p) => <li key={p.path}><code>{p.path}</code> · {({ created: 'criado', modified: 'modificado', deleted: 'apagado' })[p.change] || p.change}{p.round ? ` na rodada ${p.round}` : ''}</li>)}</ul>
          <div className="actions"><Btn kind="primary" onClick={() => call('resume', { note, approveIntegrity: true }, 'Alterações aprovadas; ciclo retomado.')}>Aprovar as alterações e retomar</Btn></div>
        </div>
      )}
      {blocked && c.blockedCode === 'persistence_failed' && (
        <div className="small">
          <p className="dim">Causas comuns: disco cheio, falta de permissão, antivírus ou arquivo em uso. Nada foi iniciado nem declarado como concluído sem estar gravado; ao corrigir o armazenamento, Retomar confirma a gravação antes de continuar.</p>
          {state?.persistenceIncident && <p className="dim"><PersistenceNote incident={state.persistenceIncident} /></p>}
        </div>
      )}
      {c?.status === 'completed' && <div className="small"><p><b className="s-completed">Concluído</b> <span className="dim">({c.assurance === 'verified' ? 'com verificações reais obrigatórias aprovadas' : 'sem verificações reais obrigatórias: apenas evidências autodeclaradas'})</span>. {c.finalSummary}</p><ul className="plain">{(c.evidence || []).map((e) => <li key={e}>{e}</li>)}</ul></div>}
      {atRoundLimit && <p className="stale small">Limite de {c.maxIterations} rodadas atingido sem conclusão ({c.rounds.length} feitas): o ciclo está pausado, não concluído.</p>}
      {atRoundLimit && (canRaise ? (
        <div className="form">
          <p className="dim small">Retomar continua este ciclo (rodadas e histórico mantidos; nada é refeito) com o novo limite abaixo, que precisa ser maior que {c.rounds.length}. Iniciar um novo ciclo, mais abaixo, começa do zero.</p>
          <label>Novo limite de rodadas ({c.rounds.length + 1} a {hard})
            <input type="number" min={c.rounds.length + 1} max={hard} value={resumeMax ?? resumeFrom} onChange={(e) => setResumeMax(Number(e.target.value))} />
          </label>
          <div className="actions"><Btn kind="primary" onClick={() => call('resume', { maxIterations: resumeMax ?? resumeFrom }, 'Ciclo retomado.')}>Retomar com este limite</Btn></div>
        </div>
      ) : <p className="dim small">Não é possível retomar: o teto de {hard} rodadas por ciclo já foi usado. Inicie um novo ciclo abaixo.</p>)}
      {c?.status === 'cancelled' && <p className="dim small">Ciclo cancelado.</p>}

      {(!c || ['completed', 'cancelled', 'limit_reached'].includes(c.status)) && (
        <div className="form">
          <p className="dim small">O Planner decide as tarefas e o Executor as realiza sem aprovação individual. Só lê e edita arquivos no espaço de trabalho; qualquer permissão extra é negada e pausa o ciclo.</p>
          <label>Limite de rodadas (1 a {hard})
            <input type="number" min="1" max={hard} value={max} onChange={(e) => setMax(Number(e.target.value))} />
          </label>
          {why && <p className="stale">{why}</p>}
          <Btn kind="primary" disabled={!!why} onClick={() => call('start', { maxIterations: max }, 'Ciclo iniciado.')}>Iniciar ciclo autônomo</Btn>
        </div>
      )}
      {active && <div className="actions"><Btn kind="danger" onClick={() => call('cancel', {}, 'Cancelamento solicitado.')}>Cancelar ciclo</Btn></div>}
      {blocked && !(c.blockedCode === 'approval_required' && (c.approvals || []).some((a) => a.status === 'pending')) && (
        <div className="form">
          <label>Orientação para o Planner (opcional)<textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="actions">
            <Btn kind="primary" onClick={() => call('resume', { note }, 'Ciclo retomado.')}>Retomar</Btn>
            <Btn kind="danger" onClick={() => call('cancel', {}, 'Ciclo cancelado.')}>Cancelar ciclo</Btn>
          </div>
        </div>
      )}
      {c?.plan?.steps?.length > 0 && <Plan plan={c.plan} rounds={c.rounds} />}
      {c?.rounds.length > 0 && <div className="rounds">{c.rounds.map((r) => <Round key={r.n} r={r} />)}</div>}
    </div>
  );
}
