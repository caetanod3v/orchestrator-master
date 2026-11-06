import React, { useRef } from 'react';
import { Icon } from './ui.jsx';
import { describeTally, tabKeyTarget } from '../workspace-nav.js';

/**
 * Abas dos workspaces abertos (tablist WAI-ARIA): ativa destacada, "×" fecha só a aba (os terminais continuam), "+" abre o diálogo de workspaces.
 * Teclado: setas/Home/End movem o foco (foco roving), Enter/Espaço ativam, Delete fecha a aba focada.
 */
export default function WorkspaceTabs({ tabs, onActivate, onClose, onAdd }) {
  const list = useRef(null);
  const ids = tabs.map((t) => t.id);
  const focusTab = (id) => list.current?.querySelector(`[data-tab="${CSS.escape(id)}"]`)?.focus();
  const onKey = (e, tab) => {
    if (e.key === 'Delete') { e.preventDefault(); onClose(tab); return; }
    const to = tabKeyTarget(ids, tab.id, e.key);
    if (to === null) return;
    e.preventDefault(); focusTab(to);
  };
  const stop = tabs.find((t) => t.active)?.id ?? ids[0]; // só uma aba entra na ordem de Tab; as demais por setas
  return (
    <div className="wt">
      <div className="wt-list" role="tablist" aria-label="Workspaces abertos" ref={list}>
        {tabs.map((t) => {
          const full = `${t.name}: ${describeTally(t)}${t.active ? ' (ativo)' : ''}`;
          return (
            <div key={t.id} className={`wt-item tone-${t.tone}${t.active ? ' on' : ''}`} role="presentation">
              <button type="button" role="tab" data-tab={t.id} className="wt-tab" aria-selected={t.active} aria-controls="main" tabIndex={t.id === stop ? 0 : -1} title={`${t.path}\n${describeTally(t)}`} aria-label={full}
                onClick={() => { if (!t.active) onActivate(t); }} onKeyDown={(e) => onKey(e, t)}>
                <i className="wt-dot" aria-hidden="true" />
                <span className="wt-name">{t.name}</span>
                {t.attention && <span className={`wt-n ${t.failed ? 'err' : 'warn'}`} aria-hidden="true">{t.failed + t.pending}</span>}
              </button>
              <button type="button" className="wt-x" tabIndex={-1} onClick={() => onClose(t)} aria-label={`Fechar a aba ${t.name}`} title={t.running ? `Fechar a aba (${t.running} ${t.running === 1 ? 'agente continua' : 'agentes continuam'} em execução)` : 'Fechar a aba'}><Icon name="close" size={12} /></button>
            </div>
          );
        })}
      </div>
      <button type="button" className="wt-add" onClick={onAdd} aria-label="Abrir ou adicionar workspace" title="Abrir ou adicionar workspace"><Icon name="plus" size={14} /></button>
    </div>
  );
}
