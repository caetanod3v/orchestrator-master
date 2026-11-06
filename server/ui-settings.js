// Preferências visuais e de navegação da interface (db.settings.ui): a fonte principal é o servidor, para sobreviver à troca de porta do Electron (o localStorage
// é por origem, e a origem inclui a porta). O navegador guarda só um cache. NÃO inclui layout da grade de terminais (etapa própria).
import * as store from './store.js';
import { now } from './store.js';

export const FONT_RANGE = Object.freeze({ min: 11, max: 18 });
export const MAX_NAME = 40;
export const MAX_EXPANDED = 200;
export const DEFAULT_UI = Object.freeze({ name: '', isolate: false, role: 'builder', fontSize: 13, motion: 'auto', sidebarCollapsed: false, expandedWorkspaces: {} });
const KEYS = Object.keys(DEFAULT_UI);
const ID_RE = /^(?!__proto__$)[A-Za-z0-9_-]{1,64}$/; // __proto__ fora: defesa em profundidade (hoje já não seria explorável)
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const cleanName = (s) => s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();

/** Só os ids de workspaces que existem entram no mapa de expandidos (workspace removido sai sozinho). */
const pruneExpanded = (map, db) => {
  const ids = new Set((db.workspaces ?? []).map((w) => w.id)), out = {};
  for (const [k, v] of Object.entries(map)) if (ids.has(k) && typeof v === 'boolean') out[k] = v;
  return out;
};

/** Leitura TOLERANTE do que está no banco (banco antigo, editado à mão ou corrompido nunca derruba nada): campo inválido volta ao padrão. */
export function readUi(db) {
  const r = isObj(db.settings?.ui) ? db.settings.ui : {};
  const fs = Number(r.fontSize);
  const expanded = isObj(r.expandedWorkspaces) ? Object.fromEntries(Object.entries(r.expandedWorkspaces).filter(([k, v]) => ID_RE.test(k) && typeof v === 'boolean')) : {};
  return {
    name: typeof r.name === 'string' ? cleanName(r.name).slice(0, MAX_NAME) : DEFAULT_UI.name,
    isolate: r.isolate === true,
    role: typeof r.role === 'string' && /^[a-z]{1,20}$/.test(r.role) ? r.role : DEFAULT_UI.role,
    fontSize: Number.isFinite(fs) ? Math.min(FONT_RANGE.max, Math.max(FONT_RANGE.min, Math.round(fs))) : DEFAULT_UI.fontSize,
    motion: r.motion === 'reduced' ? 'reduced' : 'auto',
    sidebarCollapsed: r.sidebarCollapsed === true,
    expandedWorkspaces: pruneExpanded(expanded, db),
  };
}

/** Validação ESTRITA do corpo do PUT (parcial): devolve { patch } ou { error }. Propriedade desconhecida ou valor fora do tipo é recusada, nunca corrigida em silêncio. */
export function validateUiPatch(b) {
  if (!isObj(b)) return { error: 'O corpo deve ser um objeto com as preferências.' };
  const extra = Object.keys(b).filter((k) => !KEYS.includes(k));
  if (extra.length) return { error: `Propriedades não permitidas: ${extra.join(', ')}.` };
  const p = {};
  if (b.name !== undefined) { if (typeof b.name !== 'string' || cleanName(b.name).length > MAX_NAME) return { error: `name deve ser um texto de até ${MAX_NAME} caracteres.` }; p.name = cleanName(b.name); }
  for (const k of ['isolate', 'sidebarCollapsed']) if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') return { error: `${k} deve ser verdadeiro ou falso.` }; p[k] = b[k]; }
  if (b.role !== undefined) { if (typeof b.role !== 'string' || !/^[a-z]{1,20}$/.test(b.role)) return { error: 'role deve ter de 1 a 20 letras minúsculas.' }; p.role = b.role; }
  if (b.fontSize !== undefined) { if (!Number.isInteger(b.fontSize) || b.fontSize < FONT_RANGE.min || b.fontSize > FONT_RANGE.max) return { error: `fontSize deve ser um inteiro de ${FONT_RANGE.min} a ${FONT_RANGE.max}.` }; p.fontSize = b.fontSize; }
  if (b.motion !== undefined) { if (b.motion !== 'auto' && b.motion !== 'reduced') return { error: 'motion deve ser "auto" ou "reduced".' }; p.motion = b.motion; }
  if (b.expandedWorkspaces !== undefined) {
    const m = b.expandedWorkspaces;
    if (!isObj(m) || Object.keys(m).length > MAX_EXPANDED) return { error: `expandedWorkspaces deve ser um objeto { idDoWorkspace: verdadeiro|falso } com até ${MAX_EXPANDED} itens.` };
    for (const [k, v] of Object.entries(m)) if (!ID_RE.test(k) || typeof v !== 'boolean') return { error: 'expandedWorkspaces só aceita ids de workspace válidos com valor verdadeiro ou falso.' };
    p.expandedWorkspaces = m;
  }
  return { patch: p };
}

/** GET /api/ui e PUT /api/ui (parcial: só os campos enviados mudam; expandedWorkspaces é mesclado chave a chave). Falha ao gravar desfaz e responde 500. */
export function setupUiSettings(app, { db }) {
  const view = () => ({ ui: readUi(db), persisted: isObj(db.settings.ui) }); // persisted=false: banco antigo/primeira execução; o cliente pode migrar o cache dele

  app.get('/api/ui', (req, res) => res.json(view()));

  app.put('/api/ui', (req, res) => {
    const v = validateUiPatch(req.body);
    if (v.error) return bad(res, v.error);
    const had = Object.hasOwn(db.settings, 'ui'), prev = db.settings.ui;
    const cur = readUi(db), next = { ...cur, ...v.patch };
    if (v.patch.expandedWorkspaces) next.expandedWorkspaces = { ...cur.expandedWorkspaces, ...v.patch.expandedWorkspaces };
    next.expandedWorkspaces = pruneExpanded(next.expandedWorkspaces, db);
    try { db.settings.ui = next; store.saveOrThrow(); } catch {
      if (had) db.settings.ui = prev; else delete db.settings.ui;
      return bad(res, 'Não foi possível gravar as preferências: o banco não pôde ser gravado; nada foi alterado.', 500);
    }
    res.json({ ui: next, persisted: true, savedAt: now() });
  });
}
