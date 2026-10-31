import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChatView } from '../pages/Chat.jsx';
import { Glyph, Icon } from './ui.jsx';
import { DOCK, defaultDock, dockLimits, clampDock, parseDock, nextDock } from '../dock-size.js';

const KEY = 'cockpit-chat';
const read = () => { try { return localStorage.getItem(KEY) === 'open'; } catch { return false; } };
const readH = () => { try { return parseDock(localStorage.getItem(DOCK.key)); } catch { return null; } };
const writeH = (h) => { try { if (h == null) localStorage.removeItem(DOCK.key); else localStorage.setItem(DOCK.key, String(h)); } catch { /* sem armazenamento */ } };
const valueText = (h) => `Conversa com ${h} px de altura`;
const TONE = { queued: 'idle', awaiting_approval: 'awaiting', blocked: 'awaiting', running: 'active' };

/** Painel inferior do Cockpit: a mesma conversa da página Conversa (um único ChatView), recolhível. Recolhido, é um campo de entrada que convida a escrever; aberto, ocupa uma faixa e o foco vai para o campo. */
export default function ChatDock() {
  const [open, setOpen] = useState(read);
  const [phase, setPhase] = useState(null);
  const [pref, setPref] = useState(readH); // altura preferida (px) ou null = padrão; fica salva como preferência do usuário
  const [room, setRoom] = useState(null);  // espaço para corpo da conversa + canvas, medido no layout
  const dock = useRef(null), body = useRef(null), sep = useRef(null), drag = useRef(null);
  const toggle = () => setOpen((o) => { try { localStorage.setItem(KEY, o ? 'closed' : 'open'); } catch { /* sem armazenamento */ } return !o; });

  // espaço disponível para o corpo da conversa + o canvas: independe da altura atual da conversa (altura do .ck menos cabeçalho, barra, divisor e margens)
  const measureRoom = useCallback(() => {
    const d = dock.current, b = body.current, ck = d?.parentElement, head = ck?.querySelector('.ck-head'), canvas = ck?.querySelector('.ck-canvas');
    if (!d || !b || !ck || !head || !canvas || b.hidden) return null;
    // cabeçalho da missão + margens do canvas, medidos DIRETAMENTE: derivar de (.ck-main − .ck-canvas) subestima quando o canvas some (0px) e o cabeçalho transborda
    const cs = getComputedStyle(canvas), other = head.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    const chrome = d.getBoundingClientRect().height - b.getBoundingClientRect().height;
    return ck.clientHeight - other - chrome;
  }, []);
  useLayoutEffect(() => { setRoom(open ? measureRoom() : null); }, [open, measureRoom]);
  useEffect(() => {
    if (!open) return undefined;
    const ck = dock.current?.parentElement; if (!ck) return undefined;
    const upd = () => setRoom(measureRoom());
    const ro = new ResizeObserver(upd); ro.observe(ck); for (const sel of ['.ck-main', '.ck-head', '.ck-canvas']) { const el = ck.querySelector(sel); if (el) ro.observe(el); } // o cabeçalho da missão muda de altura quando a missão carrega
    window.addEventListener('resize', upd);
    return () => { ro.disconnect(); window.removeEventListener('resize', upd); };
  }, [open, measureRoom]);

  const lim = dockLimits(room ?? 4000), max = lim.max, dim = { ...DOCK, min: lim.min }; // janela baixa: o grafo tem prioridade e o piso da conversa desce (veja dockLimits)
  const base = pref ?? defaultDock(typeof window === 'undefined' ? 0 : window.innerHeight);
  const h = room == null ? base : clampDock(base, max, dim); // a preferência salva não é reescrita quando a janela encolhe: só o valor efetivo é limitado
  const commit = (n) => { setPref(n); writeH(n); };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = sep.current; try { el.setPointerCapture(e.pointerId); } catch { /* ponteiro já liberado */ }
    const l = dockLimits(measureRoom() ?? 4000);
    drag.current = { id: e.pointerId, y: e.clientY, h, max: l.max, dim: { ...DOCK, min: l.min }, cur: h };
    el.classList.add('dragging'); document.body.classList.add('dock-resizing'); el.focus();
  };
  const onPointerMove = (e) => { // durante o arraste só muda a variável CSS: nada re-renderiza a conversa a cada movimento
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    d.cur = clampDock(d.h + (d.y - e.clientY), d.max, d.dim);
    body.current.style.setProperty('--dock-h', `${d.cur}px`);
    sep.current.setAttribute('aria-valuenow', d.cur); sep.current.setAttribute('aria-valuetext', valueText(d.cur));
  };
  const endDrag = (e) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    drag.current = null; sep.current.classList.remove('dragging'); document.body.classList.remove('dock-resizing');
    try { sep.current.releasePointerCapture(e.pointerId); } catch { /* já liberado */ }
    if (d.cur !== h) commit(d.cur);
  };
  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const n = nextDock(h, e.key, { shift: e.shiftKey, max }, dim);
    if (n == null) return;
    e.preventDefault(); if (n !== h) commit(n);
  };
  useEffect(() => () => document.body.classList.remove('dock-resizing'), []);

  return (
    <section className={`chat-dock${open ? ' open' : ''}`} aria-label="Conversa com o orquestrador" ref={dock}>
      {open && (
        <div className="dock-sep" ref={sep} role="separator" aria-orientation="horizontal" tabIndex={0} aria-label="Redimensionar a conversa" aria-controls="chat-dock-body"
          aria-valuemin={lim.min} aria-valuemax={max} aria-valuenow={h} aria-valuetext={valueText(h)} title="Arraste ou use as setas (Shift: passo maior; Home e End: mínimo e máximo). Duplo clique: altura padrão."
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={onKeyDown} onDoubleClick={() => { setPref(null); writeH(null); }} />
      )}
      <button type="button" className="dock-bar" aria-expanded={open} aria-controls="chat-dock-body" onClick={toggle}>
        <span className="dock-ico" aria-hidden="true"><Icon name="chat" size={18} /></span>
        <span className="ttl">{open ? 'Conversa' : 'Descreva o que quer construir'}</span>
        {phase
          ? <span className={`status s-${phase.tone}`}><Glyph kind={TONE[phase.tone] || 'idle'} />{phase.label}</span>
          : !open && <span className="hint">Nada é executado sem a sua aprovação.</span>}
        <span className="grow" />
        <span className="tog"><span className="txt">{open ? 'Recolher' : 'Abrir'}</span><Icon name={open ? 'chevronDown' : 'chevronUp'} size={16} /></span>
      </button>
      <div id="chat-dock-body" className="dock-body" ref={body} style={{ '--dock-h': `${h}px` }} hidden={!open}><ChatView embedded visible={open} onPhase={setPhase} /></div>
    </section>
  );
}
