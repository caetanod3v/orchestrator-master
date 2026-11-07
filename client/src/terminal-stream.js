// Uma única conexão SSE (/api/terminals/stream) para a saída de TODOS os terminais. O navegador limita ~6 conexões por origem: uma por pane travava a tela com 7+ terminais.
// Guarda a tela atual de cada terminal (limitada) para o pane que monta depois dos primeiros dados receber o que já foi impresso. Sem React; o EventSource é injetável nos testes.

export const SCREEN_LIMIT = 400_000;
export const REPLAY_QUIET_MS = 5000;
/**
 * O terminal já vive há tempo suficiente para que as PERGUNTAS gravadas na saída (identificação, posição do cursor, foco) sejam passado: o Claude Code não espera mais resposta a elas.
 * Ao reconstruir a tela de um terminal assim, o xterm não pode responder de novo: as respostas chegariam ao Claude Code vivo como teclas. Terminal recém-criado continua respondendo.
 */
export const isOld = (startedAt, now = Date.now()) => { const t = Date.parse(startedAt); return Number.isFinite(t) && now - t > REPLAY_QUIET_MS; };

export function createTerminalStream({ url = '/api/terminals/stream', EventSourceImpl = globalThis.EventSource } = {}) {
  const screens = new Map();   // id -> texto já impresso (cauda)
  const exited = new Map();    // id -> código de saída
  const subs = new Map();      // id -> Set<{ onReset, onData, onExit }>
  let es = null, closed = false;
  const each = (id, fn) => { for (const s of subs.get(id) ?? []) { try { fn(s); } catch { /* um pane com defeito não derruba os outros */ } } };
  const parse = (e) => { try { const m = JSON.parse(e.data); return m && typeof m.id === 'string' ? m : null; } catch { return null; } };
  const clip = (t) => (t.length > SCREEN_LIMIT ? t.slice(-SCREEN_LIMIT) : t);

  function open() {
    if (es || closed || !EventSourceImpl) return;
    es = new EventSourceImpl(url);
    es.addEventListener('init', (e) => { const m = parse(e); if (!m) return; screens.set(m.id, clip(String(m.replay ?? ''))); exited.delete(m.id); each(m.id, (s) => s.onReset?.(screens.get(m.id))); });
    es.addEventListener('data', (e) => { const m = parse(e); if (!m || typeof m.d !== 'string') return; screens.set(m.id, clip((screens.get(m.id) ?? '') + m.d)); each(m.id, (s) => s.onData?.(m.d)); });
    es.addEventListener('exit', (e) => { const m = parse(e); if (!m) return; exited.set(m.id, m.exitCode ?? null); each(m.id, (s) => s.onExit?.(m.exitCode ?? null)); });
    es.addEventListener('closed', (e) => { const m = parse(e); if (!m) return; screens.delete(m.id); exited.delete(m.id); });
  }

  /** Inscreve um pane. Se já há tela guardada, `onReset` recebe-a na hora (e `onExit`, se o processo já acabou). Devolve a função de cancelar. */
  function subscribe(id, handlers) {
    open();
    if (!subs.has(id)) subs.set(id, new Set());
    subs.get(id).add(handlers);
    if (screens.has(id)) handlers.onReset?.(screens.get(id));
    if (exited.has(id)) handlers.onExit?.(exited.get(id));
    return () => { subs.get(id)?.delete(handlers); if (!subs.get(id)?.size) subs.delete(id); };
  }
  const close = () => { closed = true; try { es?.close(); } catch { /* já fechado */ } es = null; subs.clear(); screens.clear(); exited.clear(); };
  return { subscribe, close, screenOf: (id) => screens.get(id) ?? null };
}
