import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';
import { Panel, Empty } from './ui.jsx';

// Skills e MCPs que cada papel do Cockpit recebe sozinho ao abrir um terminal (server/loadouts.js). A fonte da verdade é o servidor: aqui só se lê o catálogo e se
// liga/desliga skill por papel. Vale para terminais abertos DEPOIS da mudança (um terminal já aberto mantém o pacote com que nasceu).
const ROLE_LABEL = { maestro: 'Maestro', builder: 'Construtor', reviewer: 'Revisor', scout: 'Batedor' };

const Switch = ({ checked, onChange, label, disabled }) => (
  <label className="oc-switch"><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span className="oc-switch-track" aria-hidden="true"><i /></span><span className="sr">{label}</span></label>
);

export default function LoadoutPanel() {
  const { notify } = useStore();
  const [data, setData] = useState(null), [role, setRole] = useState('builder'), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);

  const load = useCallback(async () => { try { setData(await api.get('/api/loadouts')); setFailed(false); } catch { setFailed(true); } }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (body) => {
    setBusy(true);
    try { setData(await api.put('/api/loadouts', body)); } catch (e) { notify(e.message, 'error'); await load(); } finally { setBusy(false); }
  };

  if (failed) return <Panel title="Skills e MCPs por papel"><Empty>Não foi possível carregar. <button type="button" className="btn sm" onClick={load}>Tentar de novo</button></Empty></Panel>;
  if (!data) return <Panel title="Skills e MCPs por papel"><Empty>Carregando…</Empty></Panel>;

  const roles = Object.keys(data.roles), cur = data.roles[role] ?? data.roles[roles[0]], active = new Set(cur.skills);
  const toggle = (id, on) => {
    const next = data.catalog.skills.map((s) => s.id).filter((x) => (x === id ? on : active.has(x)));
    save({ role, skills: next });
  };

  return (
    <Panel title="Skills e MCPs por papel" right={cur.customized ? <span className="oc-pill">personalizado</span> : <span className="oc-pill ok">padrão</span>}>
      <p className="dim lead-p">Cada papel já abre com estas skills, sem você configurar nada. Elas ficam num pacote gerado pelo servidor fora do seu projeto e valem para os terminais abertos a partir de agora.</p>
      <div className="lo-tabs" role="tablist" aria-label="Papel">
        {roles.map((r) => <button key={r} type="button" role="tab" aria-selected={r === role} className="lo-tab" onClick={() => setRole(r)}>{ROLE_LABEL[r] ?? r}</button>)}
      </div>
      <h4 className="lo-h">Skills</h4>
      <ul className="lo-list">
        {data.catalog.skills.map((s) => (
          <li key={s.id} className={active.has(s.id) ? 'on' : ''}>
            <div className="lo-t"><b className="mono">{s.id}</b><span className="dim small">{s.description}</span></div>
            <Switch checked={active.has(s.id)} disabled={busy} onChange={(v) => toggle(s.id, v)} label={`${s.id} para ${ROLE_LABEL[role] ?? role}`} />
          </li>
        ))}
      </ul>
      <h4 className="lo-h">MCPs</h4>
      <ul className="lo-list">
        {data.catalog.mcp.filter((m) => cur.mcp.includes(m.id)).map((m) => (
          <li key={m.id} className="on"><div className="lo-t"><b>{m.label}</b><span className="dim small">{m.description}</span></div><span className="oc-pill ok">automático</span></li>
        ))}
      </ul>
      <p className="dim small lo-note">Servidores MCP de terceiros não são ligados sozinhos: cada um executa código no seu computador e alguns precisam de conta ou de rede.</p>
      {cur.customized && <button type="button" className="btn sm" disabled={busy} onClick={() => save({ role, reset: true })}>Restaurar o padrão deste papel</button>}
    </Panel>
  );
}
