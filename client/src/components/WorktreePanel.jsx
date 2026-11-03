import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { worktreeView, revalidateOutcome, needsEnvironment, canOfferPrepare, planView, prepareErrorView } from '../worktree-view.js';
import { Btn, Status } from './ui.jsx';

/** Apresentação pura (testável sem rede): cada ambiente, suas tentativas e as ações que o servidor aceitaria agora. */
export function WorktreeView({ rows, busy = false, onAction = () => {}, onRevalidate = () => {}, results = {}, prep = {}, needsPrepareId = null, onPlan = () => {}, onApprove = () => {}, onDiscard = () => {}, onRefresh = () => {} }) {
  const [authorized, setAuthorized] = useState({});
  const [ack, setAck] = useState({}); // "autorizo executar" do plano: sempre desmarcado para um plano novo
  if (!rows.length) return null;
  return (
    <div className="small" data-testid="worktrees">
      <div className="k">worktrees isolados · {rows.length}</div>
      <ul className="plain">
        {rows.map((w) => (
          <li key={w.id} data-testid="worktree">
            <Status value={w.status} label={w.stateLabel} /> <span className="mono">{w.branch}</span>
            <span className="dim"> · base {w.baseLabel} · ponta {w.headLabel}{w.integratedCommit && ` · integrado em ${w.integratedCommit}`}{w.running && ` · ${w.running}`}{w.op && ` · operação: ${w.op}`}</span>
            <div className="dim mono">{w.path}</div>
            {w.baseDirty && <div className="stale">O workspace principal tinha alterações não commitadas quando o worktree foi criado: elas NÃO estão no worktree.</div>}
            {w.note && <div className="dim">{w.note}</div>}
            {w.prepare.state && (
              <div data-testid="worktree-prepare-state" data-state={w.prepare.state}>
                <span className="k">ambiente</span> <Status value={w.prepare.value} label={w.prepare.label} />
                {w.prepare.dependencies !== null && <span className="dim"> · {w.prepare.dependencies} dependência(s)</span>}
                {w.prepare.exitCode !== null && <span className="dim"> · código de saída {w.prepare.exitCode}</span>}
                {w.prepare.durationMs !== null && <span className="dim"> · {Math.round(w.prepare.durationMs / 1000)} s</span>}
                {w.prepare.reason && <div className="stale">{w.prepare.reason}</div>}
                {w.prepare.outputTail && <details><summary className="dim">saída do npm (sanitizada)</summary><pre className="mono small">{w.prepare.outputTail}</pre></details>}
              </div>
            )}
            {w.prepare.inconclusive && <div className="stale" data-testid="worktree-prepare-inconclusive">{w.prepare.inconclusiveText}{w.prepare.diagnostic && <div className="dim">diagnóstico: {w.prepare.diagnostic}</div>}</div>}
            {w.id === needsPrepareId && !w.prepare.running && <div className="dim" data-testid="worktree-needs-env">A verificação foi RECUSADA porque o ambiente do worktree não tem as dependências (checkout frio). Nada foi executado no workspace principal.</div>}
            {prep[w.id]?.phase === 'planning' && <div className="dim" data-testid="worktree-prepare-planning">Gerando o plano (nada será executado)…</div>}
            {prep[w.id]?.error && <div className="stale" data-testid="worktree-prepare-error" data-stale={prep[w.id].error.stale ? '1' : '0'}>{prep[w.id].error.text}</div>}
            {prep[w.id]?.plan && (
              <div className="form" data-testid="worktree-prepare-plan" data-phase={prep[w.id].phase}>
                <b>Plano de preparação</b> <span className="dim">(nada foi executado ainda)</span>
                <div>comando: <span className="mono" data-testid="worktree-prepare-command">{prep[w.id].plan.command}</span></div>
                <div className="dim mono">{prep[w.id].plan.worktree.path}</div>
                <details open><summary>{prep[w.id].plan.dependencyCount} dependência(s) · lockfile v{prep[w.id].plan.lockfile.version ?? '?'}, {prep[w.id].plan.lockfile.packages ?? '?'} pacotes</summary>
                  <ul className="plain">{prep[w.id].plan.dependencies.map((d) => <li key={`${d.section}:${d.name}`} className="mono">{d.name} {d.spec}<span className="dim"> · {d.section}</span></li>)}</ul>
                  {prep[w.id].plan.truncated && <div className="dim">lista truncada</div>}</details>
                <div>registry: <span className="mono">{prep[w.id].plan.registry.url}</span> <span className="dim">({prep[w.id].plan.registry.source})</span></div>
                {prep[w.id].plan.scoped.map((x) => <div key={x.scope} className="dim">registry de {x.scope}: <span className="mono">{x.url}</span></div>)}
                <div className="dim">hosts de download no lockfile: <span className="mono">{prep[w.id].plan.hosts.join(', ') || 'nenhum'}</span></div>
                {prep[w.id].plan.warnings.length > 0 && <div className="stale" data-testid="worktree-prepare-warnings"><b>Avisos e limitações</b><ul className="plain">{prep[w.id].plan.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
                {prep[w.id].plan.notes.map((x, i) => <div key={i} className="dim">{x}</div>)}
                <div className="dim">digest do plano: <span className="mono" data-testid="worktree-prepare-digest">{prep[w.id].plan.digest}</span></div>
                <label className="check"><input type="checkbox" checked={!!ack[w.id]} disabled={prep[w.id].phase !== 'planned'} onChange={(e) => setAck({ ...ack, [w.id]: e.target.checked })} />
                  Autorizo executar o comando acima neste worktree (digest {prep[w.id].plan.digest.slice(0, 12)}…)</label>
                <div className="actions">
                  <Btn kind="primary" disabled={busy || !ack[w.id] || prep[w.id].phase !== 'planned'} onClick={() => { onApprove(w.id); setAck({ ...ack, [w.id]: false }); }}>{prep[w.id].phase === 'approved' ? 'Aprovado: aguardando o servidor…' : 'Aprovar e iniciar a preparação'}</Btn>
                  <Btn disabled={busy || prep[w.id].phase !== 'planned'} onClick={() => { setAck({ ...ack, [w.id]: false }); onDiscard(w.id); }}>Descartar plano</Btn>
                </div>
              </div>
            )}
            {w.diagnostic && <div className="stale" data-testid="worktree-diagnostic">Diagnóstico: {w.diagnostic}</div>}
            {results[w.id] && <div className={results[w.id].ok ? 'dim' : 'stale'} data-testid="worktree-revalidate-result" data-kind={results[w.id].kind}>{results[w.id].text}</div>}
            {w.attempts.slice(-3).map((a) => (
              <div key={a.key} className="dim" data-testid="worktree-attempt">
                ↳ {a.kind}: <b>{a.resultLabel}</b>{a.outcomeLabel && ` · ${a.outcomeLabel}`}{a.concurrent && ' · a branch de destino andou desde a base'}
                <div>{a.evidenceLabel}</div>
                {a.conflicts.length > 0 && <div data-testid="worktree-conflicts">conflitos reais: {a.conflicts.join(', ')}</div>}
                {a.overlap.length > 0 && a.conflicts.length === 0 && <div>alterações concorrentes sobrepostas, mas combináveis: {a.overlap.join(', ')}</div>}
                {a.problems.map((p) => <div key={p.code} data-testid="worktree-problem">• {p.message}</div>)}
              </div>
            ))}
            <div className="actions">
              {canOfferPrepare(w, needsPrepareId) && !prep[w.id]?.plan && prep[w.id]?.phase !== 'planning' && <Btn disabled={busy} onClick={() => onPlan(w.id)} title="Gera o plano (somente leitura); nada é executado até você aprovar">Preparar ambiente</Btn>}
              {(w.prepare.state || prep[w.id]?.error) && <Btn disabled={busy} onClick={onRefresh} title="Relê o estado no servidor; não inicia nenhuma preparação">Consultar estado</Btn>}
              {w.canRevalidate && <Btn disabled={busy} onClick={() => onRevalidate(w.id)} title="Reconfere o registro com o Git; não apaga nem corrige nada">{busy ? 'Revalidando…' : 'Revalidar'}</Btn>}
              {w.canCheck && <Btn disabled={busy} onClick={() => onAction(w.id, 'check', {}, 'Integração checada (nada foi alterado).')}>Checar integração</Btn>}
              {w.canSnapshot && <Btn disabled={busy} onClick={() => onAction(w.id, 'snapshot', {}, 'Snapshot registrado na branch do worktree.')}>Registrar snapshot</Btn>}
              {w.canCleanup && <Btn disabled={busy} onClick={() => onAction(w.id, 'cleanup', {}, 'Worktree removido.')}>Limpar worktree</Btn>}
            </div>
            {w.authorization && (
              <div className="form" data-testid="worktree-authorize">
                <label className="check">
                  <input type="checkbox" checked={!!authorized[w.id]} onChange={(e) => setAuthorized({ ...authorized, [w.id]: e.target.checked })} />
                  Autorizo integrar {w.authorization.summary}
                </label>
                <div className="actions"><Btn kind="primary" disabled={busy || !authorized[w.id]} onClick={() => onAction(w.id, 'integrate', { digest: w.authorization.digest }, 'Integração concluída.')}>Integrar à branch de destino</Btn></div>
              </div>
            )}
            {w.history.length > 0 && <div className="dim">{w.history.map((h) => h.label).join(' → ')}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Painel da missão: lê /api/state.worktrees e chama as rotas de worktrees; cada ação é revalidada pelo servidor. */
export default function WorktreePanel({ mission }) {
  const { state, act, notify, refresh } = useStore();
  const [busy, setBusy] = useState(false);
  const [prep, setPrep] = useState({}); // por worktree: { phase: planning | planned | approved | error, plan, error } (fases só da tela; o estado real vem do servidor)
  const setP = (id, v) => setPrep((p) => { const n = { ...p }; if (v) n[id] = v; else delete n[id]; return n; });
  const [results, setResults] = useState({});
  const rows = worktreeView(state?.worktrees?.items, { missionId: mission.id });
  const onAction = async (id, op, body, ok) => {
    setBusy(true);
    try { const r = await act(async () => { await api.post(`/api/worktrees/${id}/${op}`, body); return true; }); if (r) notify(ok); } finally { setBusy(false); }
  };
  // Revalidar: um clique por vez (busy); o painel é atualizado por act() (refresh) e o resultado fica visível na linha. Erro de requisição: mantém o estado e mostra a falha.
  const onRevalidate = async (id) => {
    if (busy) return;
    setBusy(true);
    try {
      const resp = await act(() => api.post(`/api/worktrees/${id}/revalidate`, {}));
      if (resp) { const o = revalidateOutcome(resp); setResults((p) => ({ ...p, [id]: o })); notify(o.text, o.ok ? 'info' : 'error'); }
    } finally { setBusy(false); }
  };
  // E4: plano (somente leitura) -> confirmação explícita -> envio do digest aprovado. Nada de npm aqui: o servidor executa; a tela só mostra o que ele devolve.
  const onPlan = async (id) => {
    if (busy) return;
    setBusy(true); setP(id, { phase: 'planning' });
    try { const plan = planView(await api.post(`/api/worktrees/${id}/prepare/plan`, {})); setP(id, plan ? { phase: 'planned', plan } : { phase: 'error', error: prepareErrorView(new Error('O servidor devolveu um plano inválido.')) }); }
    catch (e) { setP(id, { phase: 'error', error: prepareErrorView(e) }); } finally { setBusy(false); }
  };
  const onApprove = async (id) => {
    const cur = prep[id]; if (busy || cur?.phase !== 'planned' || !cur.plan) return; // um digest só é enviado a partir do plano mostrado e com a autorização marcada
    setBusy(true); setP(id, { ...cur, phase: 'approved' });
    try { await api.post(`/api/worktrees/${id}/prepare`, { digest: cur.plan.digest }); setP(id, null); await refresh(); notify('Preparação iniciada; acompanhe o estado do ambiente.'); }
    catch (e) { setP(id, { phase: 'error', error: prepareErrorView(e) }); try { await refresh(); } catch { /* o erro acima já está na tela */ } } // plano rejeitado: o plano antigo some; um novo precisa ser gerado e aprovado de novo
    finally { setBusy(false); }
  };
  const onRefresh = async () => { try { await refresh(); } catch { /* a próxima atualização automática tenta de novo */ } };
  return <WorktreeView rows={rows} busy={busy} onAction={onAction} onRevalidate={onRevalidate} results={results} prep={prep} needsPrepareId={needsEnvironment(mission)} onPlan={onPlan} onApprove={onApprove} onDiscard={(id) => setP(id, null)} onRefresh={onRefresh} />;
}
