import React, { useEffect, useRef } from 'react';
import { Icon } from './ui.jsx';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Diálogo modal: foco preso, Esc ou clique fora fecham, e o foco volta ao elemento que o abriu. `data-autofocus` marca onde o foco começa. */
export default function Dialog({ title, onClose, children, size = 'md', id = 'dlg' }) {
  const box = useRef(null);
  const closeRef = useRef(onClose); closeRef.current = onClose; // a identidade de onClose muda a cada render: o efeito abaixo roda só ao abrir (senão o foco pularia durante a digitação)
  useEffect(() => {
    const opener = document.activeElement, el = box.current;
    (el.querySelector('[data-autofocus]') || el.querySelector(FOCUSABLE.split(', ').map((x) => '.oc-dialog-body ' + x).join(', ')) || el.querySelector(FOCUSABLE) || el).focus(); // o foco começa no conteúdo, não no botão de fechar
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll(FOCUSABLE)]; if (!items.length) return;
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (opener && document.contains(opener)) opener.focus?.(); };
  }, []);
  return (
    <div className="oc-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`oc-dialog oc-dialog-${size}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} ref={box} tabIndex={-1}>
        <header className="oc-dialog-head">
          <h2 id={`${id}-t`}>{title}</h2>
          <button type="button" className="oc-iconbtn" onClick={onClose} aria-label="Fechar"><Icon name="close" size={16} /></button>
        </header>
        <div className="oc-dialog-body">{children}</div>
      </div>
    </div>
  );
}
