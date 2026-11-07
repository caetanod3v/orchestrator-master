import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store.jsx';
import { systemStatus, statusLine } from '../system-status.js';

const W = 360, GAP = 6, EDGE = 8;
const GROUPS = [['failed', 'Com falha', 'err'], ['waiting', 'Aguardando você', 'warn'], ['working', 'Executando', 'work']];

/**
 * Status global do FORGE: UMA linha compacta (LED geral + ativos · executando · aguardando · falhas) que expande num painel. Substitui as pílulas da barra superior, o "N/10 terminais",
 * o "N ativos" da barra de terminais e o do rodapé da sidebar. O painel só traz o que não está visível em outro lugar: quem está executando, aguardando ou com falha (e em qual workspace),
 * as vagas de terminal e os providers. É um popover fixo na janela: encaixa na tela e fecha com clique fora ou Esc.
 */
export default function SystemStatus() {
  const { terminals, maestro, workingIds, workspaces } = useStore();
  const s = useMemo(() => systemStatus({ sessions: terminals?.sessions, workingIds, tasks: maestro?.tasks, workspaces, max: terminals?.maxSessions }), [terminals, workingIds, maestro, workspaces]);
  const [open, setOpen] = useState(false), [pos, setPos] = useState(null);
  const btn = useRef(null), pop = useRef(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btn.current?.getBoundingClientRect(); if (!r) return;
      const w = Math.min(W, window.innerWidth - EDGE * 2), left = Math.max(EDGE, Math.min(r.right - w, window.innerWidth - w - EDGE));
      setPos({ left, width: w, top: r.bottom + GAP, maxHeight: Math.min(window.innerHeight * 0.6, window.innerHeight - r.bottom - GAP - EDGE) }); // nunca passa de 60% da altura: os terminais continuam à vista
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

  const cell = (n, label, cls) => <span className={`ss-c${n > 0 ? ` has ${cls}` : ''}`}><b>{n}</b><span className="ss-l"> {label}</span></span>;
  return (
    <>
      <button type="button" ref={btn} className={`ss-btn tone-${s.tone}`} aria-haspopup="dialog" aria-expanded={open} aria-controls="ss-panel" title={`${statusLine(s)} — clique para detalhes`} onClick={() => setOpen((o) => !o)}>
        <i className="ss-led" aria-hidden="true" />
        {cell(s.ativos, s.ativos === 1 ? 'ativo' : 'ativos', 'live')}<span className="ss-sep" aria-hidden="true">·</span>
        {cell(s.executando, 'executando', 'work')}<span className="ss-sep" aria-hidden="true">·</span>
        {cell(s.aguardando, 'aguardando', 'warn')}<span className="ss-sep" aria-hidden="true">·</span>
        {cell(s.falhas, s.falhas === 1 ? 'falha' : 'falhas', 'err')}
        <span className="sr">{statusLine(s)}</span>
      </button>
      {open && (
        <div id="ss-panel" ref={pop} className="ss-panel" role="dialog" aria-label="Status do sistema" style={pos ?? { visibility: 'hidden' }}>
          <p className="ss-h"><b>Status</b><span>{statusLine(s)}</span></p>
          {GROUPS.map(([k, label, cls]) => (s.groups[k].length > 0 && (
            <section key={k} className={`ss-g ${cls}`} aria-label={label}>
              <h3><i aria-hidden="true" />{label}<span>{s.groups[k].length + s.more[k]}</span></h3>
              <ul>{s.groups[k].map((a) => <li key={a.id}><b>{a.title}</b>{a.workspace && <span className="dim"> · {a.workspace}</span>}</li>)}{s.more[k] > 0 && <li className="dim">+{s.more[k]} {s.more[k] === 1 ? 'outro' : 'outros'}</li>}</ul>
            </section>
          )))}
          {s.falhas + s.aguardando + s.executando === 0 && <p className="ss-empty dim small">{s.ativos ? 'Nenhum agente executando, aguardando ou com falha.' : 'Nenhum terminal aberto.'}</p>}
          <section className="ss-g" aria-label="Terminais">
            <h3><i aria-hidden="true" />Terminais<span>{s.max ? `${s.ativos} de ${s.max}` : s.ativos}</span></h3>
            {s.max && <p className="small dim">{s.livres} {s.livres === 1 ? 'vaga livre' : 'vagas livres'} · {s.ativos} {s.ativos === 1 ? 'ocupada' : 'ocupadas'} (todos os workspaces)</p>}
          </section>
          <section className="ss-g" aria-label="Providers">
            <h3><i aria-hidden="true" />Providers</h3>
            <ul>{s.providers.map((p) => <li key={p.id}><b>{p.label}</b><span className="dim"> · {p.available || p.total ? `${p.total} ${p.total === 1 ? 'sessão' : 'sessões'}, ${p.active} ${p.active === 1 ? 'ativa' : 'ativas'}` : 'em breve · sem integração'}</span></li>)}</ul>
          </section>
        </div>
      )}
    </>
  );
}
