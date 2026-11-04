// Preferências LOCAIS da interface (nome exibido, isolamento padrão, papel padrão, fonte dos terminais, movimento). Ficam só neste navegador/app (localStorage):
// não existe conta nem servidor de perfil. Núcleo puro (sem React): o hook usePrefs está em hooks.js. Valores inválidos voltam ao padrão, nunca quebram a tela.
const KEY = 'orch.prefs.v1';
export const DEFAULT_PREFS = Object.freeze({ name: '', isolate: false, role: 'builder', fontSize: 13, motion: 'auto' });
export const FONT_RANGE = Object.freeze({ min: 11, max: 18 });

/** Aceita qualquer coisa; devolve sempre um objeto completo e válido. */
export function sanitizePrefs(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fs = Number(r.fontSize);
  return {
    name: typeof r.name === 'string' ? r.name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40) : DEFAULT_PREFS.name,
    isolate: r.isolate === true,
    role: typeof r.role === 'string' && /^[a-z]{1,20}$/.test(r.role) ? r.role : DEFAULT_PREFS.role,
    fontSize: Number.isFinite(fs) ? Math.min(FONT_RANGE.max, Math.max(FONT_RANGE.min, Math.round(fs))) : DEFAULT_PREFS.fontSize,
    motion: r.motion === 'reduced' ? 'reduced' : 'auto',
  };
}

const store = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } }; // o acesso pode lançar (janela privada, dados bloqueados)
let current = (() => { try { return sanitizePrefs(JSON.parse(store()?.getItem(KEY) ?? 'null')); } catch { return { ...DEFAULT_PREFS }; } })();
const subs = new Set();

export const getPrefs = () => current;
export const subscribePrefs = (fn) => { subs.add(fn); return () => subs.delete(fn); };
/** Muda uma preferência (valida, grava se possível e avisa quem escuta). A tela continua funcionando mesmo sem armazenamento. */
export function setPref(key, value) {
  if (!Object.hasOwn(DEFAULT_PREFS, key)) return current;
  current = sanitizePrefs({ ...current, [key]: value });
  try { store()?.setItem(KEY, JSON.stringify(current)); } catch { /* sem armazenamento: vale só nesta sessão */ }
  for (const fn of subs) fn();
  return current;
}
