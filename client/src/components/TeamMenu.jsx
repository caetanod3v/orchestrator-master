import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Btn, Icon } from './ui.jsx';
import { PRESETS, presetById, missingRoles } from '../team-view.js';

const STATE_TEXT = { working: 'executando', waiting: 'aguardando', done: 'concluído', idle: 'ocioso', failed: 'falhou', exited: 'encerrado' };
const W = 380, GAP = 6, EDGE = 8;

/**
 * Equipe do workspace: identificação compacta (ex.: "Squad ▾") que abre o gerenciamento. Consulta a composição atual, altera o preset, adiciona/remove agentes e abre
 * terminais avulsos. Nada aqui encerra processo sem confirmação; cada ação chama o que o cockpit já faz (abrir, encerrar, gravar a equipe do workspace).
 */
export default function TeamMenu({ defaultRole = 'builder', preset, saved = true, sessions, stateOf, roles, byRole, room, busy, where, onChange, onAdd, onRemove, onReset }) {
  const [open, setOpen] = useState(false), [pos, setPos] = useState(null), [role, setRole] = useState(defaultRole);
  const btn = useRef(null), pop = useRef(null);
  const team = presetById(preset);
  const live = useMemo(() => sessions.filter((s) => s.status === 'running'), [sessions]);
  const missing = useMemo(() => (team ? missingRoles(team.roles, live.map((s) => s.role)) : []), [team, live]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btn.current?.getBoundingClientRect(); if (!r) return;
      const w = Math.min(W, window.innerWidth - EDGE * 2), left = Math.max(EDGE, Math.min(r.left, window.innerWidth - w - EDGE));
      setPos({ left, width: w, top: r.bottom + GAP, maxHeight: Math.min(window.innerHeight * 0.7, window.innerHeight - r.bottom - GAP - EDGE) }); // nunca cobre mais que 70% da altura
    };
    place(); window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (!pop.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true); };
  }, [open]);

  return (
    <>
      <button type="button" ref={btn} className="tm-btn" aria-haspopup="dialog" aria-expanded={open} aria-controls="tm-panel" onClick={() => setOpen((o) => !o)}
        title={`Equipe do workspace: ${team?.label ?? 'personalizada'} (${live.length} ${live.length === 1 ? 'ativo' : 'ativos'}). Clique para gerenciar.`}>
        <Icon name="layers" size={13} /><b>{team?.label ?? 'Equipe'}</b><Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div id="tm-panel" ref={pop} className="tm-panel" role="dialog" aria-label="Gerenciar a equipe" style={pos ?? { visibility: 'hidden' }}>
          <p className="tm-h"><b>Equipe · {team?.label ?? 'personalizada'}</b><span>{where}</span></p>

          <section className="tm-s" aria-label="Composição atual">
            <h3>Composição atual<span>{live.length} {live.length === 1 ? 'ativo' : 'ativos'}{sessions.length > live.length ? ` · ${sessions.length - live.length} encerrado${sessions.length - live.length === 1 ? '' : 's'}` : ''}</span></h3>
            {sessions.length === 0 ? <p className="dim small">Nenhum agente neste workspace.</p> : (
              <ul className="tm-l">{sessions.map((s) => { const st = stateOf(s); return (
                <li key={s.id} className={`st-${st}`}>
                  <i className="tm-led" aria-hidden="true" /><span className="tm-n"><b>{s.title}</b><span className="dim"> · {byRole[s.role]?.label ?? s.role} · {STATE_TEXT[st] ?? st}</span></span>
                  <button type="button" className="tm-x" disabled={busy} onClick={() => onRemove(s)} aria-label={s.status === 'running' ? `Encerrar ${s.title}` : `Remover ${s.title}`} title={s.status === 'running' ? 'Encerrar este agente (pede confirmação)' : 'Remover da lista'}><Icon name="close" size={12} /></button>
                </li>); })}</ul>
            )}
            {missing.length > 0 && <p className="small dim tm-miss">Faltam para completar “{team.label}”: {missing.map((r) => byRole[r]?.label ?? r).join(', ')}. <button type="button" className="tm-link" disabled={busy || room < 1} onClick={() => onAdd(missing)}>Abrir {missing.length === 1 ? 'o que falta' : 'os que faltam'}</button></p>}
          </section>

          <section className="tm-s" aria-label="Adicionar agente ou terminal">
            <h3>Adicionar agente ou terminal</h3>
            <div className="tm-row">
              <label className="sr" htmlFor="tm-role">Papel do novo terminal</label>
              <select id="tm-role" className="oc-sel" value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
              <Btn disabled={busy || room < 1} onClick={() => onAdd([role])} title="Abre um terminal com este papel; entra no worktree do squad quando há um ativo"><Icon name="plus" size={12} /> Terminal</Btn>
            </div>
            {room < 1 && <p className="small dim">Limite de terminais atingido: encerre algum antes de abrir outro.</p>}
          </section>

          <section className="tm-s" aria-label="Alterar preset">
            <h3>Alterar preset</h3>
            <div className="tm-presets" role="radiogroup" aria-label="Preset da equipe">
              {PRESETS.map((p) => <button key={p.id} type="button" role="radio" aria-checked={p.id === preset} disabled={busy} className={p.id === preset ? 'on' : ''} onClick={() => { if (p.id !== preset) { setOpen(false); onChange(p.id); } }} title={p.roles.map((r) => byRole[r]?.label ?? r).join(', ')}>{p.label}<span className="dim">{p.roles.length}</span></button>)}
            </div>
            <p className="small dim">Alterar o preset nunca encerra processos: só abre o que faltar, depois de confirmar.</p>
          </section>

          {saved && <p className="tm-foot"><button type="button" className="tm-link" disabled={busy || sessions.length > 0} onClick={() => { setOpen(false); onReset(); }} title={sessions.length > 0 ? 'Disponível quando o workspace não tiver terminais: encerre-os antes' : 'Volta a mostrar os presets de configuração inicial'}>Redefinir equipe deste workspace</button></p>}
        </div>
      )}
    </>
  );
}
