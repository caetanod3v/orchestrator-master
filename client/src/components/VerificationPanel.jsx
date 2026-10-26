import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Btn } from './ui.jsx';

/** Aprovação humana das verificações reais (npm run test/build/lint/typecheck) de um workspace. */
export default function VerificationPanel({ workspace }) {
  const { act, notify } = useStore();
  const [info, setInfo] = useState(null);
  const [sel, setSel] = useState({}); // script -> { on, required }
  const load = async () => {
    try {
      const d = await api.get(`/api/workspaces/${workspace.id}/verifications`);
      setInfo(d);
      setSel(Object.fromEntries(d.detected.map((x) => [x.script, { on: x.approved, required: x.required }])));
    } catch (e) { setInfo({ error: e.message, detected: [], configured: [] }); }
  };
  useEffect(() => { load(); }, [workspace.id]);

  const save = async () => {
    const items = Object.entries(sel).filter(([, v]) => v.on).map(([script, v]) => ({ script, required: v.required }));
    const r = await act(async () => { await api.put(`/api/workspaces/${workspace.id}/verifications`, { items }); return true; });
    if (r) { notify('Verificações aprovadas.'); load(); }
  };

  if (!info) return <div className="dim small">Lendo package.json…</div>;
  return (
    <div className="cycle" data-testid="verification-panel">
      <div className="row"><b className="sub">Verificações reais</b><span className="dim small">{workspace.name}</span></div>
      <p className="dim small">
        O orquestrador roda <span className="mono">npm run &lt;script&gt;</span> neste espaço de trabalho depois de cada rodada bem-sucedida do ciclo e registra comando, código de saída e duração.
        ⚠ Isso executa código do projeto, inclusive arquivos que o Executor editou; aprove somente scripts em que você confia.
        O texto do script fica fixado: se o <span className="mono">package.json</span> mudar, a verificação não roda até você aprovar de novo.
      </p>
      {info.error && <p className="s-failed small">{info.error}</p>}
      {!info.npmAvailable && <p className="s-failed small">npm não encontrado junto ao Node: nenhuma verificação poderá rodar.</p>}
      {!info.error && info.detected.length === 0 && <p className="dim small">Nenhum script permitido ({info.allowed?.join(', ')}) no package.json.</p>}
      {info.detected.map((d) => (
        <div key={d.script} className="vrow">
          <label className="check">
            <input type="checkbox" checked={!!sel[d.script]?.on} onChange={(e) => setSel({ ...sel, [d.script]: { ...sel[d.script], on: e.target.checked } })} />
            <span className="mono">{d.script}</span>
          </label>
          <label className="check small">
            <input type="checkbox" disabled={!sel[d.script]?.on} checked={!!sel[d.script]?.required} onChange={(e) => setSel({ ...sel, [d.script]: { ...sel[d.script], required: e.target.checked } })} />
            obrigatória para concluir
          </label>
          <div className="mono small dim">{d.command}</div>
          {d.changedSinceApproval && <div className="s-blocked small">⚠ o script mudou desde a aprovação: salve para aprovar o texto atual (até lá ele não roda)</div>}
        </div>
      ))}
      <div className="actions"><Btn kind="primary" onClick={save} disabled={!info.npmAvailable}>Salvar aprovação</Btn><Btn onClick={load}>Reler package.json</Btn></div>
    </div>
  );
}
