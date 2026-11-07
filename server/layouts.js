// Layout persistente da grade de terminais, POR WORKSPACE (db.settings.layouts[workspaceId]): a ordem dos terminais abertos, qual está maximizado e as trilhas
// (colunas e linhas) de cada formato de grade. Terminais são identificados pelo id do REGISTRO de sessão (ses_…), que é estável entre reinícios (o id do terminal não é).
// Só organização visual: nada aqui abre, fecha ou retoma terminal.
import * as store from './store.js';
import { now } from './store.js';

export const MAX_ORDER = 24;
export const MAX_GRIDS = 16;
export const MAX_TRACKS = 8;
export const TEAM_PRESETS = Object.freeze(['duo', 'squad', 'full', 'builder']); // equipe escolhida do workspace (client/src/team-view.js); só o id fica gravado
const REC_RE = /^ses_[0-9a-f]{8}$/;
const KEY_RE = /^([1-9]|1[0-2])x([1-9]|1[0-2])$/; // formato da grade: colunas x linhas
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const validTrack = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0.05 && n <= 100;
const validTracks = (a) => Array.isArray(a) && a.length >= 1 && a.length <= MAX_TRACKS && a.every(validTrack);

export const EMPTY_LAYOUT = Object.freeze({ order: [], maximized: null, grids: {} });

/** Leitura TOLERANTE do que está no banco: o que for inválido é descartado, nunca derruba nada. */
export function readLayout(raw) {
  const r = isObj(raw) ? raw : {};
  const order = [...new Set(Array.isArray(r.order) ? r.order.filter((x) => typeof x === 'string' && REC_RE.test(x)) : [])].slice(0, MAX_ORDER);
  const grids = {};
  if (isObj(r.grids)) for (const [k, g] of Object.entries(r.grids)) { if (KEY_RE.test(k) && isObj(g) && validTracks(g.cols) && validTracks(g.rows) && Object.keys(grids).length < MAX_GRIDS) grids[k] = { cols: [...g.cols], rows: [...g.rows] }; }
  const out = { order, maximized: typeof r.maximized === 'string' && REC_RE.test(r.maximized) ? r.maximized : null, grids };
  if (TEAM_PRESETS.includes(r.team)) out.team = r.team; // só aparece quando há equipe: workspaces antigos continuam com o formato de sempre
  return out;
}

/** Validação ESTRITA do corpo do PUT (parcial): devolve { patch } ou { error }. Nada é corrigido em silêncio. */
export function validateLayoutPatch(b) {
  if (!isObj(b)) return { error: 'O corpo deve ser um objeto com o layout.' };
  const extra = Object.keys(b).filter((k) => !['order', 'maximized', 'grids', 'team'].includes(k));
  if (extra.length) return { error: `Propriedades não permitidas: ${extra.join(', ')}.` };
  const p = {};
  if (b.order !== undefined) {
    if (!Array.isArray(b.order) || b.order.length > MAX_ORDER || b.order.some((x) => typeof x !== 'string' || !REC_RE.test(x)) || new Set(b.order).size !== b.order.length) return { error: `order deve ser uma lista de até ${MAX_ORDER} ids de sessão (ses_…) sem repetição.` };
    p.order = b.order;
  }
  if (b.maximized !== undefined) {
    if (b.maximized !== null && (typeof b.maximized !== 'string' || !REC_RE.test(b.maximized))) return { error: 'maximized deve ser o id de uma sessão (ses_…) ou null.' };
    p.maximized = b.maximized;
  }
  if (b.team !== undefined) {
    if (b.team !== null && !TEAM_PRESETS.includes(b.team)) return { error: `team deve ser um destes ids de equipe: ${TEAM_PRESETS.join(', ')} (ou null para limpar).` };
    p.team = b.team;
  }
  if (b.grids !== undefined) {
    if (!isObj(b.grids) || Object.keys(b.grids).length > MAX_GRIDS) return { error: `grids deve ser um objeto com até ${MAX_GRIDS} formatos.` };
    for (const [k, g] of Object.entries(b.grids)) {
      if (!KEY_RE.test(k)) return { error: `Formato de grade inválido: ${String(k).slice(0, 12)} (use colunasxlinhas, ex. 2x2).` };
      if (!isObj(g) || Object.keys(g).some((x) => x !== 'cols' && x !== 'rows') || !validTracks(g.cols) || !validTracks(g.rows)) return { error: `As trilhas de ${k} devem ser listas de 1 a ${MAX_TRACKS} números entre 0,05 e 100.` };
    }
    p.grids = b.grids;
  }
  return { patch: p };
}

/** GET /api/layouts (todos os workspaces existentes) e PUT /api/workspaces/:id/layout (parcial; grids são mesclados formato a formato). Falha ao gravar desfaz e responde 500. */
export function setupLayouts(app, { db }) {
  // Integridade: o layout de um workspace só referencia sessões DELE. Registro conhecido de outro workspace é "alheio"; id sem registro (podado/ainda não gravado) é tolerado.
  const foreignTo = (wsId) => { const s = new Set(); for (const r of Array.isArray(db.terminalSessions) ? db.terminalSessions : []) if (r && r.workspaceId !== wsId) s.add(r.id); return s; };
  const clean = (l, wsId) => { const f = foreignTo(wsId); return { ...l, order: l.order.filter((x) => !f.has(x)), maximized: l.maximized && f.has(l.maximized) ? null : l.maximized }; };
  const all = () => { if (!isObj(db.settings.layouts)) return {}; const out = {}; for (const w of db.workspaces) if (isObj(db.settings.layouts[w.id])) out[w.id] = clean(readLayout(db.settings.layouts[w.id]), w.id); return out; };

  app.get('/api/layouts', (req, res) => res.json({ layouts: all() }));

  app.put('/api/workspaces/:id/layout', (req, res) => {
    const ws = db.workspaces.find((w) => w.id === req.params.id);
    if (!ws) return bad(res, 'Workspace não encontrado.', 404);
    const v = validateLayoutPatch(req.body);
    if (v.error) return bad(res, v.error);
    const f = foreignTo(ws.id);
    if ((v.patch.order ?? []).some((x) => f.has(x)) || (v.patch.maximized && f.has(v.patch.maximized))) return bad(res, 'O layout só pode referenciar sessões deste workspace.');
    const had = Object.hasOwn(db.settings, 'layouts'), prev = db.settings.layouts;
    const cur = clean(readLayout(isObj(prev) ? prev[ws.id] : null), ws.id);
    const next = { ...cur, ...v.patch };
    if (v.patch.grids) { const g = { ...cur.grids, ...v.patch.grids }; const keys = Object.keys(g); next.grids = Object.fromEntries(keys.slice(-MAX_GRIDS).map((k) => [k, g[k]])); }
    try {
      const map = {}; for (const w of db.workspaces) if (isObj(prev) && isObj(prev[w.id])) map[w.id] = prev[w.id]; // aproveita para esquecer layout de workspace removido
      map[ws.id] = next; db.settings.layouts = map; store.saveOrThrow();
    } catch {
      if (had) db.settings.layouts = prev; else delete db.settings.layouts;
      return bad(res, 'Não foi possível gravar o layout: o banco não pôde ser gravado; nada foi alterado.', 500);
    }
    res.json({ layout: next, savedAt: now() });
  });
}
