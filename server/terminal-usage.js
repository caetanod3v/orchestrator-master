// Tokens e custo de cada terminal do Claude Code, lidos do transcript (JSONL) que o próprio Claude Code grava em <configDir>/projects/<projeto>/<session-id>.jsonl.
// O servidor fixa o `--session-id` de cada pane, então o arquivo é identificado sem adivinhar: nada vem do cliente nem de texto do transcript.
//
// Regras de honestidade:
//   - tokens são os que a CLI reportou em `message.usage`. A mesma mensagem aparece em várias linhas (uma por bloco de conteúdo) com o MESMO id: conta uma vez (a última vence);
//   - custo = tokens x TABELA DE PREÇOS DO USUÁRIO (<dados>/pricing.json). Não há preços embutidos: sem tabela ou sem o modelo na tabela, o custo é `null` (a tela mostra "—"), nunca zero;
//   - leitura incremental (só o que foi acrescentado ao arquivo) e somente leitura; arquivo ausente = `null`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_READ = 8 * 1024 * 1024; // por leitura: um transcript enorme é consumido em fatias, sem travar o servidor
const PRICE_FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Pasta de configuração do Claude Code: CLAUDE_CONFIG_DIR ou ~/.claude. */
export const claudeConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Lê a tabela { "prefixo-do-modelo": { input, output, cacheWrite, cacheRead } } em USD por MILHÃO de tokens. Inválida ou ausente = {} (sem custo). */
export function normalizePrices(raw) {
  const out = {};
  for (const [model, p] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!p || typeof p !== 'object' || !PRICE_FIELDS.some((f) => Number.isFinite(p[f]) && p[f] >= 0)) continue;
    out[model] = Object.fromEntries(PRICE_FIELDS.map((f) => [f, num(p[f])]));
  }
  return out;
}
export function loadPrices(file) { try { return normalizePrices(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return {}; } }
const priceFor = (prices, model) => { let best = null; for (const k of Object.keys(prices)) if (typeof model === 'string' && model.startsWith(k) && (best === null || k.length > best.length)) best = k; return best ? prices[best] : null; };

export function createUsageReader({ configDir = claudeConfigDir(), pricesFile = null, prices = null, missMs = 2000 } = {}) {
  const misses = new Map(); // sessionId -> instante até o qual não procurar de novo (o arquivo só aparece depois da primeira resposta)
  const files = new Map(); // sessionId -> { file, offset, byMsg: Map<id, {model, input, output, cacheWrite, cacheRead}>, pending: string }
  let normalizedInjected = null;
  let priceCache = { mtime: -1, table: {} };
  const table = () => {
    if (prices) return normalizedInjected ??= normalizePrices(prices);
    if (!pricesFile) return {};
    try { const m = fs.statSync(pricesFile).mtimeMs; if (m !== priceCache.mtime) priceCache = { mtime: m, table: loadPrices(pricesFile) }; } catch { priceCache = { mtime: -1, table: {} }; }
    return priceCache.table;
  };

  function locate(sessionId) {
    const root = path.join(configDir, 'projects');
    let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
    for (const d of dirs) { if (!d.isDirectory()) continue; const f = path.join(root, d.name, `${sessionId}.jsonl`); try { if (fs.statSync(f).isFile()) return f; } catch { /* próximo projeto */ } }
    return null;
  }

  function ingest(st) {
    let size; try { size = fs.statSync(st.file).size; } catch { return; }
    if (size < st.offset) { st.offset = 0; st.pending = ''; st.byMsg.clear(); } // arquivo recomeçou
    if (size === st.offset) return;
    const len = Math.min(size - st.offset, MAX_READ), buf = Buffer.alloc(len);
    let fd; try { fd = fs.openSync(st.file, 'r'); fs.readSync(fd, buf, 0, len, st.offset); } catch { return; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* já fechado */ } }
    st.offset += len;
    const text = st.pending + buf.toString('utf8'), cut = text.lastIndexOf('\n');
    st.pending = cut < 0 ? text : text.slice(cut + 1); // a última linha pode estar incompleta: fica para a próxima leitura
    if (cut < 0) return;
    for (const line of text.slice(0, cut).split('\n')) {
      if (!line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o?.message, u = m?.usage;
      if (o?.type !== 'assistant' || !u || typeof u !== 'object') continue;
      const key = typeof m.id === 'string' ? m.id : o.uuid;
      if (!key) continue;
      if (m.model === '<synthetic>' || !(num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens))) continue; // mensagens sintéticas (erro/interrupção) e sem consumo não têm preço nem tokens
      st.byMsg.set(key, { model: typeof m.model === 'string' ? m.model : null, input: num(u.input_tokens), output: num(u.output_tokens), cacheWrite: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens) });
    }
  }

  /** @returns {null | {input:number, output:number, cacheWrite:number, cacheRead:number, total:number, turns:number, model:string|null, costUsd:number|null}} */
  function read(sessionId) {
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;
    let st = files.get(sessionId);
    if (!st) { if ((misses.get(sessionId) ?? 0) > Date.now()) return null; const file = locate(sessionId); if (!file) { misses.set(sessionId, Date.now() + missMs); return null; } misses.delete(sessionId); st = { file, offset: 0, byMsg: new Map(), pending: '' }; files.set(sessionId, st); }
    ingest(st);
    // Subagentes (ferramenta Task) gravam em <sessão>/subagents/*.jsonl: também são consumo do pane
    st.subs ??= new Map(); const subDir = path.join(path.dirname(st.file), sessionId, 'subagents');
    try { for (const n of fs.readdirSync(subDir)) { if (!/^[\w.-]+\.jsonl$/.test(n)) continue; const f = path.join(subDir, n); if (!st.subs.has(f)) st.subs.set(f, { file: f, offset: 0, byMsg: new Map(), pending: '' }); } } catch { /* sem subagentes */ }
    for (const sub of st.subs.values()) ingest(sub);
    const all = [st, ...st.subs.values()];
    const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, prc = table(); let cost = 0, costKnown = all.some((x) => x.byMsg.size > 0), model = null, turns = 0;
    for (const e of all.flatMap((x) => [...x.byMsg.values()])) {
      turns++;
      for (const f of PRICE_FIELDS) t[f] += e[f];
      if (e.model) model = e.model;
      const p = priceFor(prc, e.model);
      if (p) cost += (e.input * p.input + e.output * p.output + e.cacheWrite * p.cacheWrite + e.cacheRead * p.cacheRead) / 1e6; else costKnown = false;
    }
    return { ...t, total: t.input + t.output + t.cacheWrite + t.cacheRead, turns, model, costUsd: costKnown ? Math.round(cost * 1e6) / 1e6 : null };
  }
  return { read, forget: (sessionId) => { misses.delete(sessionId); return files.delete(sessionId); } };
}
