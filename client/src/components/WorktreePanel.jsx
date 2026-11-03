import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { worktreeView } from '../worktree-view.js';
import { Btn, Status } from './ui.jsx';

/** Apresentação pura (testável sem rede): cada ambiente, suas tentativas e as ações que o servidor aceitaria agora. */
export function WorktreeView({ rows, busy = false, onAction = () => {} }) {
  const [authorized, setAuthorized] = useState({});
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
  const { state, act, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const rows = worktreeView(state?.worktrees?.items, { missionId: mission.id });
  const onAction = async (id, op, body, ok) => {
    setBusy(true);
    try { const r = await act(async () => { await api.post(`/api/worktrees/${id}/${op}`, body); return true; }); if (r) notify(ok); } finally { setBusy(false); }
  };
  return <WorktreeView rows={rows} busy={busy} onAction={onAction} />;
}
