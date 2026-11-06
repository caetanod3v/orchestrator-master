// Layout da grade de terminais POR WORKSPACE, sincronizado com o servidor (db.settings.layouts; rotas GET /api/layouts e PUT /api/workspaces/:id/layout). PURO (sem React).
// O que se guarda: `order` (ids de SESSÃO, ses_…, na ordem em que aparecem), `maximized` (id da sessão ampliada) e `grids` (trilhas de colunas e linhas por formato, ex. "2x2").
// Terminais são identificados pelo id do REGISTRO de sessão: ele sobrevive a reinícios e à retomada; o id do terminal não.
// Mesmas regras do ui-state.js: o servidor é a fonte, o localStorage só cache; nada é gravado antes de ler o servidor; o que o usuário mudou e ainda não foi confirmado não
// é sobrescrito pela resposta; um PUT por vez; falha de rede mantém o pendente e tenta de novo; 400 descarta e relê; 404 (workspace removido) esquece o layout.
import { api } from './api.js';

export const LAYOUT_KEY = 'orch.layout.v1';
export const MAX_ORDER = 24;
const MAX_GRIDS = 16;
const REC_RE = /^ses_[0-9a-f]{8}$/;
const KEY_RE = /^([1-9]|1[0-2])x([1-9]|1[0-2])$/;
const WS_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const okTrack = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0.05 && n <= 100;
const okTracks = (a) => Array.isArray(a) && a.length >= 1 && a.length <= 8 && a.every(okTrack);
export const EMPTY = Object.freeze({ order: Object.freeze([]), maximized: null, grids: Object.freeze({}) });

/** Layout válido a partir de qualquer coisa (mesmas regras do servidor); o que for inválido é descartado. */
export function sanitizeLayout(raw) {
  const r = isObj(raw) ? raw : {};
  const order = [...new Set(Array.isArray(r.order) ? r.order.filter((x) => typeof x === 'string' && REC_RE.test(x)) : [])].slice(0, MAX_ORDER);
  const grids = {};
  if (isObj(r.grids)) for (const [k, g] of Object.entries(r.grids)) if (KEY_RE.test(k) && isObj(g) && okTracks(g.cols) && okTracks(g.rows) && Object.keys(grids).length < MAX_GRIDS) grids[k] = { cols: [...g.cols], rows: [...g.rows] };
  return { order, maximized: typeof r.maximized === 'string' && REC_RE.test(r.maximized) ? r.maximized : null, grids };
}
const sanitizeMap = (m) => (isObj(m) ? Object.fromEntries(Object.entries(m).filter(([k]) => WS_RE.test(k)).map(([k, v]) => [k, sanitizeLayout(v)])) : {});
export const roundTracks = (a) => a.map((n) => Math.round(n * 10000) / 10000);

/** Ordena `items` pela ordem salva (id do registro); os que não estão na lista vão depois, na ordem original. Estável e sem mutar. */
export function orderSessions(items, order, idOf = (s) => s.recordId) {
  const pos = new Map((order ?? []).map((id, i) => [id, i]));
  return items.map((s, i) => [s, i]).sort(([a, i], [b, j]) => (pos.get(idOf(a)) ?? Infinity) - (pos.get(idOf(b)) ?? Infinity) || i - j).map(([s]) => s);
}
/** Nova ordem salva: mantém a antiga (inclusive terminais que não estão vivos agora, para a restauração) e acrescenta os recém-abertos no fim. Passando do limite saem os mais antigos que não estão visíveis. */
export function mergeOrder(saved, visibleIds) {
  const out = [...(saved ?? [])]; for (const id of visibleIds) if (id && !out.includes(id)) out.push(id);
  const vis = new Set(visibleIds);
  for (let i = 0; i < out.length && out.length > MAX_ORDER;) { if (!vis.has(out[i])) out.splice(i, 1); else i++; }
  return out.slice(-MAX_ORDER);
}
export const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const safeStorage = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
function readCache(storage) { try { return sanitizeMap(JSON.parse(storage?.getItem(LAYOUT_KEY) ?? 'null')); } catch { return {}; } }
const mergePatch = (a = {}, b = {}) => { const o = { ...a, ...b }; if (a.grids || b.grids) o.grids = { ...a.grids, ...b.grids }; return o; };
const apply = (cur, patch) => ({ ...cur, ...patch, grids: patch.grids ? { ...cur.grids, ...patch.grids } : cur.grids });

export function createLayoutSync({ get = () => api.get('/api/layouts'), put = (id, b) => api.put(`/api/workspaces/${id}/layout`, b), storage = safeStorage(), retryMs = 5000, debounceMs = 300, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let layouts = readCache(storage);
  let afterReject = false; // depois de um 400 só se relê a verdade do servidor (remigrar reenviaria o mesmo payload recusado, em laço)
  let pending = {};           // { [workspaceId]: patch ainda não confirmado pelo servidor }
  let hydrated = false, inflight = false, loading = false, started = false, flushTimer = null, retryTimer = null;
  const subs = new Set(); let snap;
  const build = () => { snap = { layouts, ready: hydrated }; }; // ready: o servidor já foi lido (antes disso nada deve ser salvo por inferência)
  const emit = () => { build(); for (const f of subs) f(); };
  const persistLocal = () => { try { storage?.setItem(LAYOUT_KEY, JSON.stringify(layouts)); } catch { /* sem armazenamento: vale só nesta sessão */ } };
  const hasPending = () => Object.keys(pending).length > 0;
  const view = (ws) => layouts[ws] ?? EMPTY;
  const timer = (fn, ms) => { const t = setTimer(fn, ms); try { t?.unref?.(); } catch { /* sem unref */ } return t; };
  function scheduleRetry() { if (retryTimer) return; retryTimer = timer(() => { retryTimer = null; if (!hydrated) load(); else flush(); }, retryMs); } // sem leitura ainda: refaz a LEITURA (mesmo sem nada pendente)
  function scheduleFlush() { if (flushTimer) clearTimer(flushTimer); flushTimer = timer(() => { flushTimer = null; flush(); }, debounceMs); }

  /** Mudança do usuário: aparece na hora, vai ao cache e ao servidor logo depois. */
  function change(ws, patch) {
    if (!WS_RE.test(String(ws))) return;
    layouts = { ...layouts, [ws]: apply(view(ws), patch) }; persistLocal();
    pending = { ...pending, [ws]: mergePatch(pending[ws], patch) };
    emit(); scheduleFlush();
  }
  /** O servidor vence, MENOS o que o usuário mudou e ainda não foi confirmado. */
  function applyServer(ws, server) { layouts = { ...layouts, [ws]: pending[ws] ? apply(sanitizeLayout(server), pending[ws]) : sanitizeLayout(server) }; persistLocal(); }

  async function load() {
    if (loading) return; loading = true;
    try {
      const r = await get(); if (!isObj(r?.layouts)) throw new Error('resposta inválida');
      const server = sanitizeMap(r.layouts); hydrated = true;
      for (const ws of Object.keys(server)) applyServer(ws, server[ws]);
      const skipMigration = afterReject; afterReject = false;
      if (!skipMigration) for (const ws of Object.keys(layouts)) { // só no cache: migra UMA vez (workspace que o servidor não conhece será recusado com 404 e esquecido)
        if (server[ws]) continue; const l = layouts[ws]; if (!l.order.length && !l.maximized && !Object.keys(l.grids).length) continue;
        pending = { ...pending, [ws]: mergePatch({ order: [...l.order], maximized: l.maximized, grids: l.grids }, pending[ws]) };
      }
      persistLocal(); emit(); if (hasPending()) flush();
    } catch { scheduleRetry(); } finally { loading = false; }
  }

  async function flush() {
    if (flushTimer) { clearTimer(flushTimer); flushTimer = null; }
    if (!hydrated) { if (hasPending()) load(); return; } // nunca grava antes de ler o servidor
    if (inflight || !hasPending()) return;
    const ws = Object.keys(pending)[0], sending = pending[ws]; inflight = true;
    const { [ws]: _gone, ...rest } = pending; pending = rest;
    let r;
    try { r = await put(ws, sending); } catch (e) {
      inflight = false;
      if (e?.status === 404) { const { [ws]: _l, ...keep } = layouts; layouts = keep; persistLocal(); emit(); if (hasPending()) flush(); return; } // workspace removido
      if (e?.status === 400) { hydrated = false; afterReject = true; const { [ws]: _r, ...kept } = layouts; layouts = kept; persistLocal(); emit(); load(); return; } // valor recusado: descarta e relê a verdade do servidor
      pending = { ...pending, [ws]: mergePatch(sending, pending[ws]) }; scheduleRetry(); return; // rede fora do ar ou gravação falhou (5xx): mantém e tenta de novo
    }
    inflight = false;
    if (isObj(r?.layout)) { applyServer(ws, r.layout); emit(); }
    if (hasPending()) flush();
  }

  const actions = Object.freeze({
    setMaximized: (ws, recordId) => change(ws, { maximized: recordId && REC_RE.test(recordId) ? recordId : null }),
    setGrid: (ws, key, grid) => {
      if (!KEY_RE.test(key) || !okTracks(grid?.cols) || !okTracks(grid?.rows)) return;
      const g = { cols: roundTracks(grid.cols), rows: roundTracks(grid.rows) }, had = view(ws).grids[key];
      const even = (a) => a.every((n) => n === a[0]);
      if (had ? sameList(had.cols, g.cols) && sameList(had.rows, g.rows) : even(g.cols) && even(g.rows)) return; // nada mudou (ou ainda é a divisão padrão): não grava à toa
      change(ws, { grids: { [key]: g } });
    },
    setOrder: (ws, ids) => { const o = [...new Set((ids ?? []).filter((x) => REC_RE.test(x)))].slice(-MAX_ORDER); if (!sameList(o, view(ws).order)) change(ws, { order: o }); },
    /** O usuário FECHOU o terminal: sai da ordem salva e, se estava ampliado, do estado ampliado. */
    forget: (ws, recordId) => { const l = view(ws); if (!recordId) return; const patch = {}; if (l.order.includes(recordId)) patch.order = l.order.filter((x) => x !== recordId); if (l.maximized === recordId) patch.maximized = null; if (Object.keys(patch).length) change(ws, patch); },
  });
  build();
  return {
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    getSnapshot: () => snap, actions, flush, load, pending: () => ({ ...pending }),
    start() { if (started) return undefined; started = true; return load(); },
    stop() { started = false; if (flushTimer) clearTimer(flushTimer); if (retryTimer) clearTimer(retryTimer); flushTimer = retryTimer = null; },
  };
}

let instance = null;
/** Instância única da aplicação (criada sob demanda: importar este arquivo não toca em rede nem em armazenamento). */
export const getLayouts = () => (instance ??= createLayoutSync());
