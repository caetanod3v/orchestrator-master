import { useEffect, useState, useSyncExternalStore } from 'react';
import { getPrefs, setPref, subscribePrefs, DEFAULT_PREFS } from './prefs.js';

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

/** Preferências locais da interface: [valores, mudar(chave, valor)]. */
export function usePrefs() {
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs, () => DEFAULT_PREFS);
  return [prefs, setPref];
}
