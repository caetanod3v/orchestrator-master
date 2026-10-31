import React, { memo, useEffect, useRef, useState } from 'react';
import { usePrefersReduced } from './NeuralCore.jsx';

/**
 * Universo espacial 3D atrás do grafo (Three.js, carregado sob demanda). Ocupa só o canvas do Cockpit, fica na camada mais baixa e não recebe eventos.
 * Não conhece a câmera, os nós nem o ChatDock: só observa o PRÓPRIO tamanho e a visibilidade. Se o WebGL não existir ou falhar, mostra um fundo estático discreto.
 * O <canvas> é criado a cada montagem (um contexto WebGL nunca é reaproveitado depois de liberado) e removido na limpeza.
 */
function Universe() {
  const host = useRef(null), engine = useRef(null);
  const reduced = usePrefersReduced();
  const reducedRef = useRef(reduced); reducedRef.current = reduced;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current; if (!el) return undefined;
    let dead = false, ro = null, io = null, canvas = null;
    (async () => {
      try {
        const { createUniverse } = await import('../universe/engine.js'); // Three.js só é baixado quando o Cockpit é aberto
        if (dead) return;
        canvas = document.createElement('canvas');
        canvas.className = 'universe-canvas'; canvas.setAttribute('aria-hidden', 'true');
        el.appendChild(canvas);
        const u = createUniverse(canvas, { reduced: reducedRef.current, onLost: () => { /* o fundo CSS continua; o motor retoma sozinho quando o contexto volta */ } });
        engine.current = u;
        const measure = () => { const r = el.getBoundingClientRect(); u.resize(r.width, r.height); };
        ro = new ResizeObserver(measure); ro.observe(el);
        io = new IntersectionObserver((es) => u.setActive(es[es.length - 1].isIntersecting)); io.observe(el);
        measure();
      } catch (e) {
        if (canvas) { canvas.remove(); canvas = null; }
        if (!dead) setFailed(true);
      }
    })();
    return () => {
      dead = true;
      ro?.disconnect(); io?.disconnect();
      engine.current?.dispose(); engine.current = null;
      canvas?.remove();
    };
  }, []);

  useEffect(() => { engine.current?.setReduced(reduced); }, [reduced]);

  return <div className="universe" ref={host} aria-hidden="true" data-fallback={failed ? 'true' : undefined} />;
}

export default memo(Universe);
