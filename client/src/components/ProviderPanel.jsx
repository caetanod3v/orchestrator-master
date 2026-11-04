import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store.jsx';
import { providerSummary } from '../env-view.js';
import { Icon } from './ui.jsx';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const W = 300, GAP = 6, EDGE = 8;

function Body({ rows, sessions }) {
  const live = rows.filter((r) => r.available || r.total > 0), soon = rows.filter((r) => !r.available && r.total === 0);
  const active = live.reduce((n, r) => n + r.active, 0);
  return (
    <>
      <p className="oc-pop-h"><b>Agentes</b><span>{plural(active, 'ativo', 'ativos')} · todos os ambientes</span></p>
      {sessions.length === 0 && <p className="oc-pop-empty">Nenhuma sessão registrada.</p>}
      {live.map((r) => (
        <section key={r.id} className="oc-pop-prov" aria-label={r.label}>
          <h3><Icon name="terminal" size={13} />{r.label}<span>{plural(r.total, 'sessão', 'sessões')}</span></h3>
          <dl>
            <div className="work"><dt>Trabalhando</dt><dd>{r.working}</dd></div>
            <div className="ok"><dt>Ociosas</dt><dd>{r.idle}</dd></div>
            <div className="err"><dt>Com falha</dt><dd>{r.failed}</dd></div>
          </dl>
          {r.exited > 0 && <p className="oc-pop-off">{plural(r.exited, 'encerrada', 'encerradas')} (não contam como ativas)</p>}
        </section>
      ))}
      {soon.map((r) => <p key={r.id} className="oc-pop-soon"><Icon name="terminal" size={13} />{r.label}<span>em breve · sem integração</span></p>)}
    </>
  );
}

/** Indicador "N ativos" que abre o painel de agentes por provider (sessões reais, todos os ambientes). Sem espaço fixo: o painel é um popover fixo na janela, que se
 *  encaixa na tela (abre para cima se o gatilho está na metade de baixo) e fecha com clique fora ou Esc. Esc é capturado antes da gaveta da sidebar. */
export default function AgentsPopover({ className = '', title, tone = 'none', children }) {
  const { terminals, workingIds } = useStore();
  const sessions = terminals?.sessions ?? [];
  const rows = useMemo(() => providerSummary(sessions, workingIds), [sessions, workingIds]);
  const [open, setOpen] = useState(false), [pos, setPos] = useState(null);
  const btn = useRef(null), pop = useRef(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btn.current?.getBoundingClientRect(); if (!r) return;
      const w = Math.min(W, window.innerWidth - EDGE * 2), vh = window.innerHeight;
      const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - w - EDGE));
      setPos(r.top > vh / 2 ? { left, width: w, bottom: vh - r.top + GAP, maxHeight: r.top - GAP - EDGE } : { left, width: w, top: r.bottom + GAP, maxHeight: vh - r.bottom - GAP - EDGE });
    };
    place(); window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (!pop.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', down); document.addEventListener('keydown', key, true);
    pop.current?.focus();
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true); };
  }, [open]);

  return (
    <>
      <button type="button" ref={btn} className={`oc-agents-btn ${className}`} aria-haspopup="dialog" aria-expanded={open} title={title ?? 'Agentes por provider'} onClick={() => setOpen((o) => !o)}><i className={`oc-ind tone-${tone}`} aria-hidden="true" />{children}<span className="oc-agents-chev" aria-hidden="true"><Icon name="chevronUp" size={13} /></span></button>
      {open && <div ref={pop} className="oc-pop" role="dialog" aria-label="Agentes por provider" tabIndex={-1} style={pos ?? { visibility: 'hidden' }}><Body rows={rows} sessions={sessions} /></div>}
    </>
  );
}
