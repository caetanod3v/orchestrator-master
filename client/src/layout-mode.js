// Modo de organização da grade de terminais (Grade, Colunas, Linhas, Foco) POR WORKSPACE. PURO + armazenamento local do navegador (conveniência desta tela; não vai ao servidor).
// Compartilhado entre o cockpit (que desenha a grade) e as Configurações (onde o usuário escolhe), por isso o estado é um módulo com assinatura, não estado de componente.
import { layoutModeId } from './env-view.js';

export const MODE_KEY = 'forge.layoutMode';
const store = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
const read = () => { try { const j = JSON.parse(store()?.getItem(MODE_KEY) || '{}'); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } };
let map = read(), snapshot = map;
const subs = new Set();

export const getModes = () => snapshot;
export const subscribeModes = (fn) => { subs.add(fn); return () => subs.delete(fn); };
/** Modo do workspace (inválido ou ausente = grade automática). */
export const modeOf = (modes, wsId) => layoutModeId(wsId ? modes?.[wsId] : undefined);
export function setModeOf(wsId, mode) {
  if (typeof wsId !== 'string' || !wsId) return;
  map = { ...map, [wsId]: layoutModeId(mode) }; snapshot = map;
  try { store()?.setItem(MODE_KEY, JSON.stringify(map)); } catch { /* sem armazenamento: vale só nesta sessão */ }
  for (const f of subs) f();
}
