import { useEffect, useState, useSyncExternalStore } from 'react';
import { getPrefs, setPref, subscribePrefs, DEFAULT_PREFS } from './prefs.js';
import { getUi } from './ui-state.js';
import { getLayouts } from './layout-state.js';

const mq = () => window.matchMedia?.('(prefers-reduced-motion: reduce)');
/** Preferência do sistema por menos movimento (reativa a mudanças). */
export function usePrefersReduced() {
  const [v, setV] = useState(() => !!mq()?.matches);
  useEffect(() => {
    const m = mq(); if (!m) return undefined;
    const on = () => setV(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return v;
}

/** Layout da grade de terminais por workspace: [layouts por id de workspace, ações, ready]. */
export function useLayouts() {
  const l = getLayouts();
  const snap = useSyncExternalStore(l.subscribe, l.getSnapshot, l.getSnapshot);
  return [snap.layouts, l.actions, snap.ready];
}

/** Navegação da interface sincronizada com o servidor: { sidebarCollapsed, expandedWorkspaces, status } + ações. */
export function useUi() {
  const ui = getUi();
  const snap = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
  return [snap, ui.actions];
}

/** Preferências da interface: [valores, mudar(chave, valor)]. */
export function usePrefs() {
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs, () => DEFAULT_PREFS);
  return [prefs, setPref];
}
