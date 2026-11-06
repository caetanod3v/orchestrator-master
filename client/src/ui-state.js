// Sincronização das preferências visuais e de navegação com o servidor (db.settings.ui, rotas GET/PUT /api/ui). PURO (sem React; tudo injetável para os testes).
// Regras:
//  - o SERVIDOR é a fonte principal: o localStorage é só cache (e fallback se o servidor estiver fora), porque no Electron a porta muda a cada abertura e o localStorage é por origem;
//  - na inicialização o cache NUNCA é enviado como "padrão": só vai ao servidor o que o usuário mudou (pendente) ou, uma única vez, o cache de quem ainda não tem settings.ui (migração);
//  - o que o servidor devolve não sobrescreve o que o usuário mudou e ainda não foi confirmado (pendente);
//  - um PUT por vez, mudanças em sequência viram um só (debounce); falha de rede/gravação mantém o pendente e tenta de novo; só erro 400 (valor recusado) descarta e relê o servidor.
import { api } from './api.js';
import * as P from './prefs.js';

export const UI_KEY = 'orch.ui.v1'; // cache de { sidebarCollapsed, expandedWorkspaces } (as preferências do usuário têm o cache próprio em prefs.js)
const LEGACY_SIDE = 'side', LEGACY_OPEN = 'topics:open'; // chaves antigas: lidas uma vez para não perder o que o usuário já tinha
const PREF_KEYS = Object.keys(P.DEFAULT_PREFS);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const ID_RE = /^(?!__proto__$)[A-Za-z0-9_-]{1,64}$/;
const MAX_EXPANDED = 200; // o mesmo teto do servidor: um cache maior nunca vira um PUT que o servidor recusa
const boolMap = (m) => (isObj(m) ? Object.fromEntries(Object.entries(m).filter(([k, v]) => ID_RE.test(k) && typeof v === 'boolean').slice(-MAX_EXPANDED)) : {});
const safeStorage = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };

export const MSG = Object.freeze({
  offline: 'Servidor indisponível: as preferências estão salvas só neste navegador e serão enviadas quando ele voltar.',
  error: 'Não foi possível salvar as preferências no servidor; elas ficam neste navegador e o envio será tentado de novo.',
  rejected: 'O servidor recusou uma preferência; o valor salvo no servidor foi restaurado.',
});

/** Cache local das preferências de navegação (nova chave; na falta dela, as chaves antigas). Qualquer falha de leitura vira o padrão. */
export function readLocal(storage) {
  const out = { sidebarCollapsed: false, expandedWorkspaces: {} };
  try {
    const raw = storage?.getItem(UI_KEY);
    if (raw) { const v = JSON.parse(raw); return { sidebarCollapsed: v?.sidebarCollapsed === true, expandedWorkspaces: boolMap(v?.expandedWorkspaces) }; }
    out.sidebarCollapsed = storage?.getItem(LEGACY_SIDE) === 'collapsed';
    const old = storage?.getItem(LEGACY_OPEN); if (old) out.expandedWorkspaces = boolMap(JSON.parse(old));
  } catch { /* cache ilegível: padrão */ }
  return out;
}

export function createUiSync({ get = () => api.get('/api/ui'), put = (b) => api.put('/api/ui', b), storage = safeStorage(), prefs = P, retryMs = 5000, debounceMs = 300, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let local = readLocal(storage);
  let pending = {};                // mudanças do usuário ainda não confirmadas pelo servidor
  let inflight = false, hydrated = false, started = false, loading = false, afterReject = false, flushTimer = null, retryTimer = null, onlineFn = null;
  let status = { state: 'loading', message: null };   // loading | synced | saving | offline | error
  const subs = new Set();
  let snap = null;
  const build = () => { snap = { sidebarCollapsed: local.sidebarCollapsed, expandedWorkspaces: local.expandedWorkspaces, status }; };
  const emit = () => { build(); for (const f of subs) f(); };
  const persistLocal = () => { try { storage?.setItem(UI_KEY, JSON.stringify(local)); } catch { /* sem armazenamento: vale só nesta sessão */ } };
  const setStatus = (state, message = null) => { status = { state, message }; };
  const hasPending = () => Object.keys(pending).length > 0;
  const merge = (a, b) => { const o = { ...a, ...b }; if (a.expandedWorkspaces || b.expandedWorkspaces) o.expandedWorkspaces = { ...a.expandedWorkspaces, ...b.expandedWorkspaces }; return o; };

  /** Aplica o que o servidor tem, MENOS o que o usuário mudou e ainda não foi confirmado. */
  function applyServer(ui) {
    const view = merge(ui, pending);
    prefs.replacePrefs(Object.fromEntries(PREF_KEYS.map((k) => [k, view[k]])));
    local = { sidebarCollapsed: view.sidebarCollapsed === true, expandedWorkspaces: boolMap(view.expandedWorkspaces) };
    persistLocal();
  }
  function scheduleRetry() { if (retryTimer) return; retryTimer = setTimer(() => { retryTimer = null; if (!hydrated) load(); else flush(); }, retryMs); try { retryTimer?.unref?.(); } catch { /* sem unref */ } }
  function scheduleFlush() { if (flushTimer) clearTimer(flushTimer); flushTimer = setTimer(() => { flushTimer = null; flush(); }, debounceMs); try { flushTimer?.unref?.(); } catch { /* sem unref */ } }

  /** Registra uma mudança do usuário: cache local na hora, servidor logo depois. */
  function change(patch) {
    if (patch.sidebarCollapsed !== undefined) local = { ...local, sidebarCollapsed: patch.sidebarCollapsed === true };
    if (patch.expandedWorkspaces) local = { ...local, expandedWorkspaces: { ...local.expandedWorkspaces, ...boolMap(patch.expandedWorkspaces) } };
    persistLocal();
    pending = merge(pending, patch);
    if (status.state === 'synced') setStatus('saving');
    emit(); scheduleFlush();
  }

  async function load() {
    if (loading) return; loading = true; // uma leitura por vez
    try {
      const r = await get();
      if (!isObj(r?.ui)) throw new Error('resposta inválida');
      hydrated = true;
      const skipMigration = afterReject; afterReject = false; // depois de um 400 só se relê a verdade do servidor: remigrar reenviaria o mesmo payload recusado, em laço
      if (r.persisted !== true && !skipMigration) { // banco sem settings.ui (antigo ou primeira execução): migra UMA vez o que o usuário já tinha neste navegador; valores padrão não são enviados
        const mine = { ...prefs.getPrefs(), ...local }, def = { ...P.DEFAULT_PREFS, sidebarCollapsed: false };
        const mig = {};
        for (const k of [...PREF_KEYS, 'sidebarCollapsed']) if (mine[k] !== def[k] && pending[k] === undefined) mig[k] = mine[k];
        const open = Object.fromEntries(Object.entries(local.expandedWorkspaces).filter(([k]) => pending.expandedWorkspaces?.[k] === undefined));
        if (Object.keys(open).length) mig.expandedWorkspaces = open;
        pending = merge(mig, pending);
      }
      applyServer(r.ui);
      setStatus(hasPending() ? 'saving' : 'synced');
      emit();
      if (hasPending()) flush();
    } catch {
      setStatus('offline', MSG.offline); emit(); scheduleRetry(); // o cache continua valendo; nada é apagado
    } finally { loading = false; }
  }

  async function flush() {
    if (flushTimer) { clearTimer(flushTimer); flushTimer = null; }
    if (!hydrated) { if (hasPending()) load(); return; } // NUNCA grava antes de ler o servidor: o primeiro PUT num banco sem settings.ui o criaria só com o que mudou e a migração do cache se perderia (load() envia o pendente ao terminar)
    if (inflight || !hasPending()) return;
    inflight = true; const sending = pending; pending = {};
    let r;
    try { r = await put(sending); } catch (e) {
      inflight = false;
      if (e?.status === 400) { setStatus('error', `${MSG.rejected} (${e.message})`); emit(); hydrated = false; afterReject = true; load(); return; } // valor recusado: descarta e relê a verdade do servidor
      pending = merge(sending, pending); // rede fora do ar ou gravação falhou (5xx): mantém e tenta de novo
      setStatus(e?.status ? 'error' : 'offline', e?.status ? MSG.error : MSG.offline); emit(); scheduleRetry(); return;
    }
    inflight = false;
    if (isObj(r?.ui)) applyServer(r.ui);
    setStatus(hasPending() ? 'saving' : 'synced'); emit();
    if (hasPending()) flush();
  }

  build();
  const actions = Object.freeze({ // objeto ÚNICO: estável entre renderizações (useCallback/memo de quem usa)
    setSidebarCollapsed: (v) => change({ sidebarCollapsed: v === true }),
    setExpanded: (id, v) => { if (ID_RE.test(String(id))) change({ expandedWorkspaces: { [id]: v === true } }); },
  });
  return {
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    getSnapshot: () => snap,
    /** Liga as preferências do usuário (prefs.js) a este sincronizador e lê o servidor. Idempotente. */
    start() {
      if (started) return; started = true;
      prefs.setPrefsSink(change);
      onlineFn = () => { if (!hydrated) load(); else flush(); };
      try { globalThis.addEventListener?.('online', onlineFn); } catch { /* sem window */ }
      return load();
    },
    stop() { started = false; prefs.setPrefsSink(null); try { if (onlineFn) globalThis.removeEventListener?.('online', onlineFn); } catch { /* sem window */ } onlineFn = null; if (flushTimer) clearTimer(flushTimer); if (retryTimer) clearTimer(retryTimer); flushTimer = retryTimer = null; },
    actions,
    setSidebarCollapsed: actions.setSidebarCollapsed, setExpanded: actions.setExpanded,
    flush, load,
    pending: () => ({ ...pending }),
  };
}

let instance = null;
/** Instância única da aplicação (criada sob demanda: importar este arquivo não toca em rede nem em armazenamento). */
export const getUi = () => (instance ??= createUiSync());
