import { useEffect, useState, useSyncExternalStore } from 'react';
import { getPrefs, setPref, subscribePrefs, DEFAULT_PREFS } from './prefs.js';
import { getUi } from './ui-state.js';
import { getLayouts } from './layout-state.js';
import { getModes, subscribeModes, modeOf, setModeOf } from './layout-mode.js';
import { readAutoRestore, writeAutoRestore } from './session-history.js';

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

/** Modo de organização da grade do workspace: [modo, mudar(modo)]. Compartilhado entre o cockpit e as Configurações. */
export function useLayoutMode(wsId) {
  const modes = useSyncExternalStore(subscribeModes, getModes, getModes);
  return [modeOf(modes, wsId), (m) => setModeOf(wsId, m)];
}

// Restauração automática das sessões: preferência local (padrão ligada), compartilhada pelo cockpit (que restaura) e pelas Configurações (onde se liga e desliga).
let autoOn = readAutoRestore(); const autoSubs = new Set();
const subAuto = (f) => { autoSubs.add(f); return () => autoSubs.delete(f); };
export function useAutoRestore() {
  const on = useSyncExternalStore(subAuto, () => autoOn, () => true);
  return [on, (v) => { autoOn = !!v; writeAutoRestore(autoOn); for (const f of autoSubs) f(); }];
}
