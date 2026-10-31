import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Glyph, Icon, TASK_GLYPH } from './ui.jsx';
import { usePrefersReduced } from './NeuralCore.jsx';
import { taskTone, taskLabel } from '../op-state.js';
import { approvalGates, buildGraph } from '../graph.js';
import ApprovalGate from './ApprovalGate.jsx';
import { ZOOM, zoomAt, wheelFactor, fitView, initialView, centerOn, ensureVisible, panBy, stepZoom, lerpView, easeOut, sanitizeView, shouldAutoFrame } from '../viewport.js';

const num = (tasks, id) => String(tasks.findIndex((t) => t.id === id) + 1).padStart(2, '0');
const KEY = (id) => `ck-view:${id}`; // a vista (zoom e posição) é guardada por missão, só na sessão do navegador
const readSaved = (id) => { try { return sanitizeView(JSON.parse(sessionStorage.getItem(KEY(id)))); } catch { return null; } };
const writeSaved = (id, v) => { try { if (v) sessionStorage.setItem(KEY(id), JSON.stringify(v)); else sessionStorage.removeItem(KEY(id)); } catch { /* sem armazenamento */ } };

/** Posição e tamanho de `el` em coordenadas do mundo (layout puro: ignora zoom e animações de entrada). */
function layoutBox(el, root) {
  let x = 0, y = 0, n = el;
  while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

const HINT = 'Roda do mouse: zoom no cursor. Arrastar o fundo, botão do meio ou Alt + arrastar: mover. Setas: mover. + e −: zoom. 0: ajustar à tela.';

/**
 * Fluxo de trabalho da missão num canvas com zoom e navegação: a intenção no topo e as tarefas em camadas, ligadas por suas dependências reais.
 * O "mundo" (nós + conectores SVG) recebe um único transform; os conectores são medidos em coordenadas de layout, então nunca desalinham com o zoom.
 * A vista só é enquadrada sozinha enquanto o usuário não mexeu nela (e é lembrada por missão na sessão).
 */
export default function FlowGraph({ mission, selectedId, onSelect, flash, empty, locate, gateActions }) {
  const vp = useRef(null), world = useRef(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 }), content = useRef({ w: 0, h: 0 });
  const boxes = useRef(new Map());
  const touched = useRef(false), framed = useRef({ ids: '', w: 0, h: 0 });
  const anim = useRef(0), saveT = useRef(0), drag = useRef(null), pointers = useRef(new Map()), pinch = useRef(0), suppress = useRef(false);
  const missionId = useRef(null);
  const [pct, setPct] = useState(100);
  const [edges, setEdges] = useState([]);
  const reduced = usePrefersReduced();
  const tasks = mission?.tasks ?? [];
  const gates = useMemo(() => approvalGates(mission), [mission]);
  const graph = useMemo(() => buildGraph(tasks, gates), [tasks, gates]);
  const rows = graph.rows;
  const sig = graph.nodes.map((n) => `${n.id}:${n.status}:${n.deps.join('.')}`).join('|');
  const idsSig = graph.nodes.map((n) => `${n.id}:${n.deps.join('.')}`).join('|');
  missionId.current = mission?.id ?? null;

  const commit = useCallback((v) => {
    view.current = v;
    const w = world.current; if (!w) return;
    w.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    w.dataset.k = v.k.toFixed(3); w.dataset.x = v.x.toFixed(1); w.dataset.y = v.y.toFixed(1);
    setPct(Math.round(v.k * 100));
  }, []);
  const stopAnim = useCallback(() => { if (anim.current) cancelAnimationFrame(anim.current); anim.current = 0; }, []);
  const go = useCallback((to, ms = 200) => {
    stopAnim();
    if (reduced || ms <= 0) { commit(to); return; }
    const from = view.current, t0 = performance.now();
    const tick = (now) => { const t = Math.min(1, (now - t0) / ms); commit(lerpView(from, to, easeOut(t))); anim.current = t < 1 ? requestAnimationFrame(tick) : 0; };
    anim.current = requestAnimationFrame(tick);
  }, [reduced, commit, stopAnim]);
  const persist = useCallback((v) => { clearTimeout(saveT.current); saveT.current = setTimeout(() => writeSaved(missionId.current, v), 250); }, []);
  // ação do usuário: a partir daqui o enquadramento automático para de mexer na vista
  const act = useCallback((v, animate = false) => { touched.current = true; if (animate) go(v); else { stopAnim(); commit(v); } persist(v); }, [go, stopAnim, commit, persist]);

  const measure = useCallback(() => {
    const el = vp.current, w = world.current; if (!el || !w) return;
    size.current = { w: el.clientWidth, h: el.clientHeight };
    content.current = { w: w.offsetWidth, h: w.offsetHeight };
    const m = new Map(); const list = [];
    const nodes = graphRef.current.nodes;
    const box = (id) => { if (m.has(id)) return m.get(id); const n = w.querySelector(`[data-node="${id}"]`); const b = n ? layoutBox(n, w) : null; m.set(id, b); return b; };
    for (const n of nodes) {
      const to = box(n.id); if (!to) continue;
      for (const f of n.deps.length ? n.deps : ['intent']) { // sem dependências: parte da Intenção
        const a = box(f); if (!a) continue;
        list.push({ key: `${f}>${n.id}`, a: { x: a.x + a.w / 2, y: a.y + a.h }, b: { x: to.x + to.w / 2, y: to.y }, from: f === 'intent' ? 'completed' : nodes.find((x) => x.id === f)?.status, to: n.status });
      }
    }
    boxes.current = m;
    setEdges(list);
  }, []);
  const graphRef = useRef(graph); graphRef.current = graph;

  // enquadramento: ao abrir a missão (ou restaurar a vista salva) e, enquanto o usuário não mexeu, quando o grafo ou o viewport mudam de tamanho
  const frame = useCallback((animate) => {
    const s = size.current, c = content.current; if (!(s.w > 0 && c.w > 0)) return;
    framed.current = { ids: idsRef.current, w: s.w, h: s.h };
    const v = initialView(c, s);
    if (animate) go(v, 180); else { stopAnim(); commit(v); }
  }, [go, stopAnim, commit]);
  const idsRef = useRef(idsSig); idsRef.current = idsSig;

  useLayoutEffect(() => {
    if (!mission) return;
    measure();
    const saved = readSaved(mission.id);
    if (saved) { touched.current = true; stopAnim(); commit(saved); framed.current = { ids: idsSig, w: size.current.w, h: size.current.h }; } else { touched.current = false; frame(false); }
  }, [mission?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => { measure(); }, [sig, measure]);

  useEffect(() => {
    const el = vp.current, w = world.current; if (!el || !w) return undefined;
    const ro = new ResizeObserver(() => {
      measure();
      const f = framed.current, s = size.current;
      if (shouldAutoFrame({ touched: touched.current }) && (f.ids !== idsRef.current || f.w !== s.w || f.h !== s.h)) frame(false);
    });
    ro.observe(el); ro.observe(w);
    return () => ro.disconnect();
  }, [measure, frame, mission?.id]);

  // roda do mouse: zoom em torno do cursor. Ouvinte nativo não passivo, só neste elemento (inspetor, logs e conversa rolam normalmente).
  useEffect(() => {
    const el = vp.current; if (!el) return undefined;
    const onWheel = (e) => { e.preventDefault(); const r = el.getBoundingClientRect(); act(zoomAt(view.current, wheelFactor(e), e.clientX - r.left, e.clientY - r.top)); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [act, mission?.id]);

  // controles
  const zoomBy = (dir) => act(stepZoom(view.current, dir, size.current), true);
  const fit = () => { touched.current = false; writeSaved(missionId.current, null); go(fitView(content.current, size.current), 220); framed.current = { ids: idsRef.current, w: size.current.w, h: size.current.h }; };
  const centerTask = useCallback((id) => {
    const b = boxes.current.get(id); if (!b) return;
    act(centerOn(b, size.current, view.current, Math.max(view.current.k, 1.1)), true);
  }, [act]);
  useEffect(() => { if (locate?.id) centerTask(locate.id); }, [locate?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // selecionar (ou focar com o teclado) uma tarefa fora da área visível: desloca o mínimo, sem mudar o zoom
  const reveal = useCallback((id, animate) => {
    const b = boxes.current.get(id); if (!b) return;
    const v = ensureVisible(b, size.current, view.current, 24);
    if (v !== view.current) act(v, animate);
  }, [act]);
  useEffect(() => { if (selectedId) reveal(selectedId, true); }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // arraste: fundo (botão esquerdo), botão do meio ou Alt + botão esquerdo; dois dedos fazem pinça
  const onPointerDown = (e) => {
    if (e.target.closest('.cv-ctl')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    suppress.current = false; // um arraste anterior nunca deve engolir este clique
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y); drag.current = null; return;
    }
    const onNode = !!e.target.closest('.fnode');
    if (e.button === 1 || (e.button === 0 && (e.altKey || !onNode))) {
      stopAnim();
      drag.current = { id: e.pointerId, button: e.button, sx: e.clientX, sy: e.clientY, v: { ...view.current }, moved: false };
      try { vp.current.setPointerCapture(e.pointerId); } catch { /* ponteiro já liberado */ }
      vp.current.classList.add('panning');
    }
  };
  const onPointerMove = (e) => {
    const p = pointers.current.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y); if (!pinch.current || !d) return;
      const r = vp.current.getBoundingClientRect(), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      act(zoomAt(view.current, d / pinch.current, mx, my)); pinch.current = d; return;
    }
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
    if (d.moved) act(panBy(d.v, dx, dy));
  };
  const endPointer = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = 0;
    const d = drag.current;
    if (d && d.id === e.pointerId) { // só o botão esquerdo gera um clique depois do arraste (o do meio não gera)
      suppress.current = d.moved && d.button === 0; drag.current = null; vp.current.classList.remove('panning');
      try { vp.current.releasePointerCapture(e.pointerId); } catch { /* já liberado */ }
    }
  };
  const onClickCapture = (e) => { if (suppress.current) { suppress.current = false; e.stopPropagation(); e.preventDefault(); } };
  const onMouseDown = (e) => { if (e.button === 1) e.preventDefault(); }; // sem o cursor de rolagem automática do botão do meio

  // teclado (só com o foco no canvas ou num nó; nunca em campos de texto nem com Ctrl/Cmd/Alt, que são do navegador)
  const onKeyDown = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const STEP = 48;
    const map = { '+': () => zoomBy(1), '=': () => zoomBy(1), '-': () => zoomBy(-1), '_': () => zoomBy(-1), '0': fit,
      ArrowLeft: () => act(panBy(view.current, STEP, 0), true), ArrowRight: () => act(panBy(view.current, -STEP, 0), true), ArrowUp: () => act(panBy(view.current, 0, STEP), true), ArrowDown: () => act(panBy(view.current, 0, -STEP), true) };
    const fn = map[e.key]; if (!fn) return;
    e.preventDefault(); fn();
  };
  const onFocus = (e) => { const n = e.target.closest?.('[data-node]'); if (n && n.dataset.node !== 'intent') reveal(n.dataset.node, false); };

  if (!mission) return empty;
  return (
    <div className="cv" ref={vp} role="group" aria-label="Canvas do fluxo de trabalho" aria-describedby="cv-hint" tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onClickCapture={onClickCapture} onMouseDown={onMouseDown} onKeyDown={onKeyDown} onFocus={onFocus}>
      <p id="cv-hint" className="sr">{HINT}</p>
      <div className="cv-world" ref={world} key={mission.id}>
        <div className="flow">
          <svg className="flow-edges" aria-hidden="true" focusable="false">
            {edges.map((e, i) => {
              const dy = Math.max(28, (e.b.y - e.a.y) / 2);
              const d = `M${e.a.x} ${e.a.y} C${e.a.x} ${e.a.y + dy}, ${e.b.x} ${e.b.y - dy}, ${e.b.x} ${e.b.y}`;
              // conexão da tarefa em execução: azul e contínua; as que saem dela, tracejadas; concluídas, verde discreto; à espera de decisão, âmbar tracejada
              const kind = e.to === 'running' ? 'live' : e.from === 'running' ? 'next' : e.to === 'awaiting_approval' ? 'wait' : e.from === 'completed' && e.to === 'completed' ? 'done' : e.from === 'completed' ? 'ready' : 'idle';
              return <path key={e.key} d={d} pathLength="1" className={`edge ${kind}`} style={{ '--i': i }} />;
            })}
          </svg>
          <div className="flow-row">
            <div className="fnode intent" data-node="intent">
              <span className="fn-head"><span>Intenção</span>{mission.demo && <span className="demo">DEMO</span>}</span>
              <span className="fn-body"><b className="fn-title">{mission.objective || mission.title}</b>{mission.objective && <span className="fn-meta">{mission.title}</span>}</span>
            </div>
          </div>
          {rows.length === 0 && <div className="flow-row"><div className="fnode ghost"><span className="fn-body"><b className="fn-title">Nenhuma etapa ainda</b><span className="fn-meta">As tarefas aparecem aqui quando o ciclo planejar ou quando você adicionar uma em Missões.</span></span></div></div>}
          {rows.map((row, ri) => (
            <div className="flow-row" key={ri}>
              {row.map((n) => {
                if (n.kind === 'gate') return <ApprovalGate key={n.id} gate={n.gate} actions={gateActions} style={{ '--d': `${ri * 70}ms` }} />;
                const t = n.task;
                const deps = (t.dependsOn || []).filter((d) => tasks.some((x) => x.id === d));
                const meta = [deps.length ? `depois de ${deps.map((d) => num(tasks, d)).join(', ')}` : null, t.authorized ? 'execução autorizada' : null].filter(Boolean).join(' · ');
                return (
                  <button type="button" key={t.id} data-node={t.id} aria-pressed={selectedId === t.id}
                    aria-label={`Tarefa ${num(tasks, t.id)}: ${t.title}. Estado: ${taskLabel(t)}${meta ? `. ${meta}` : ''}`}
                    className={`fnode task st-${t.status} tone-${taskTone(t.status)}${selectedId === t.id ? ' sel' : ''}${flash?.has(t.id) ? ' flash' : ''}`} onClick={() => onSelect(t.id)}
                    style={{ '--d': `${ri * 70}ms` }}>
                    <span className="fn-head"><span>Tarefa {num(tasks, t.id)}</span><span className={`status s-${t.status}`}><Glyph kind={TASK_GLYPH[t.status] || 'queued'} />{taskLabel(t)}</span></span>
                    <span className="fn-body"><b className="fn-title">{t.title}</b>{meta && <span className="fn-meta">{meta}</span>}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="cv-ctl" role="toolbar" aria-label="Controles do canvas" title={HINT}>
        <button type="button" className="icon-btn" onClick={() => zoomBy(-1)} disabled={pct <= Math.round(ZOOM.min * 100)} aria-label="Diminuir o zoom"><Icon name="minus" size={16} /></button>
        <output className="cv-pct" aria-label={`Zoom ${pct}%`}>{pct}%</output>
        <button type="button" className="icon-btn" onClick={() => zoomBy(1)} disabled={pct >= Math.round(ZOOM.max * 100)} aria-label="Aumentar o zoom"><Icon name="plus" size={16} /></button>
        <span className="cv-sep" aria-hidden="true" />
        <button type="button" className="icon-btn" onClick={fit} aria-label="Ajustar o grafo à tela"><Icon name="fit" size={16} /></button>
        <button type="button" className="icon-btn" onClick={() => selectedId && centerTask(selectedId)} disabled={!selectedId} aria-label="Centralizar a tarefa selecionada"><Icon name="target" size={16} /></button>
      </div>
    </div>
  );
}
