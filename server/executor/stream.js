// Converte linhas do `claude -p --output-format stream-json` em linhas legíveis de log.
// Só traduz o que a CLI realmente emitiu; nada é inventado.

const MAX = 2000;
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX)}…` : s);
const brief = (input = {}) => input.file_path || input.path || input.pattern || input.command || '';
const asText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('') : '');

// ---------- Métricas de uso (tokens, custo, modelos, limite) ----------
// Só normaliza o que a CLI realmente emitiu: campo ausente é `null` (nunca 0); 0 só aparece quando a CLI reportou 0.
// Os valores de `assistant.message.usage` são PROVISÓRIOS (repetem por message.id; o output_tokens é um valor inicial) —
// os totais finais vêm só do evento `result`. O custo é uma estimativa da CLI, não cobrança.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const word = (v) => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : null);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** `usage` da API -> { input, output, cacheCreation, cacheRead } (cada um número ou null); null se não houver objeto. */
function tokensOf(u) {
  if (!isObj(u)) return null;
  return { input: num(u.input_tokens), output: num(u.output_tokens), cacheCreation: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens) };
}

/** `modelUsage` do result -> { [modelo]: { input, output, cacheCreation, cacheRead, thinking, webSearchRequests, costUsd, contextWindow, maxOutput } }; null se ausente/vazio. */
function modelsOf(mu) {
  if (!isObj(mu)) return null;
  const out = {};
  for (const [name, m] of Object.entries(mu)) {
    if (name === '__proto__' || !isObj(m)) continue;
    out[name] = {
      input: num(m.inputTokens), output: num(m.outputTokens), cacheCreation: num(m.cacheCreationInputTokens), cacheRead: num(m.cacheReadInputTokens),
      thinking: num(m.thinkingTokens), webSearchRequests: num(m.webSearchRequests), costUsd: num(m.costUSD), contextWindow: num(m.contextWindow), maxOutput: num(m.maxOutputTokens),
    };
  }
  return Object.keys(out).length ? out : null;
}

/** Soma dos modelos (inclui subagentes, ao contrário de `usage`); um campo só é número se algum modelo o reportou. */
function sumModels(models) {
  if (!models) return null;
  const sum = (f) => { const v = Object.values(models).map((m) => m[f]).filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  return { input: sum('input'), output: sum('output'), cacheCreation: sum('cacheCreation'), cacheRead: sum('cacheRead') };
}

/**
 * Extrai as métricas de UM evento do stream (puro). Devolve null se o evento não traz métricas.
 *  - assistant -> { kind:'message', messageId, subagent, provisional:true, tokens }
 *  - result    -> { kind:'final', tokens (agente principal), tokensAllModels (soma de modelUsage), costUsd, models }
 *  - rate_limit_event -> { kind:'rate_limit', status, utilization, resetsAt } (indicador de aviso da CLI; NÃO é saldo de tokens)
 */
export function extractUsage(ev) {
  if (!isObj(ev)) return null;
  if (ev.type === 'assistant') {
    const m = isObj(ev.message) ? ev.message : null;
    const tokens = tokensOf(m?.usage);
    if (!tokens) return null;
    return { kind: 'message', messageId: typeof m.id === 'string' ? m.id : null, subagent: !!ev.parent_tool_use_id, provisional: true, tokens };
  }
  if (ev.type === 'result') {
    const tokens = tokensOf(ev.usage), models = modelsOf(ev.modelUsage), costUsd = num(ev.total_cost_usd);
    if (!tokens && !models && costUsd === null) return null;
    return { kind: 'final', tokens, tokensAllModels: sumModels(models), costUsd, models };
  }
  if (ev.type === 'rate_limit_event') {
    const i = ev.rate_limit_info;
    if (!isObj(i)) return null;
    return { kind: 'rate_limit', status: word(i.status), utilization: num(i.utilization), resetsAt: num(i.resetsAt) };
  }
  return null;
}

/**
 * Acumulador de UMA execução. `live` = soma de mensagens DISTINTAS (deduplicadas por message.id, só do agente principal) e é provisório;
 * `final` = o evento result (fonte dos totais); `rateLimit` = o último evento de limite. Nunca soma o `result` com as mensagens.
 * @returns {{add:(u:object|null)=>void, snapshot:()=>{final:object|null, live:object|null, rateLimit:object|null}}}
 */
export function createUsageTracker() {
  const messages = new Map();   // message.id -> tokens da última ocorrência
  let unidentified = 0, final = null, rateLimit = null;
  return {
    /** @returns {boolean} true se o evento MUDOU o estado (mensagem repetida/idêntica, subagente e eventos sem métricas devolvem false) */
    add(u) {
      if (!u) return false;
      if (u.kind === 'message') {
        if (u.subagent) return false;
        if (u.messageId === null) { unidentified++; return true; }
        const prev = messages.get(u.messageId);
        messages.set(u.messageId, u.tokens);
        return !prev || JSON.stringify(prev) !== JSON.stringify(u.tokens);
      }
      if (u.kind !== 'final' && u.kind !== 'rate_limit') return false;
      const { kind, ...rest } = u, prev = kind === 'final' ? final : rateLimit, changed = JSON.stringify(prev) !== JSON.stringify(rest);
      if (kind === 'final') final = rest; else rateLimit = rest;
      return changed;
    },
    snapshot() {
      let live = null;
      if (messages.size || unidentified) {
        const sum = (f) => { const v = [...messages.values()].map((t) => t[f]).filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
        live = { provisional: true, messages: messages.size, unidentified, tokens: { input: sum('input'), output: sum('output'), cacheCreation: sum('cacheCreation'), cacheRead: sum('cacheRead') } };
      }
      return { final, live, rateLimit };
    },
  };
}

/** @returns {{lines:string[], usage?:object, result?:{text:string,isError:boolean,costUsd:number|null,durationMs:number|null,turns:number|null}}} */
export function formatEvent(ev) {
  const lines = [];
  if (!ev || typeof ev !== 'object') return { lines };
  const usage = extractUsage(ev);
  if (usage) return { ...formatCore(ev, lines), usage };
  return formatCore(ev, lines);
}

function formatCore(ev, lines) {
  if (ev.type === 'system' && ev.subtype === 'init') {
    lines.push(`[sessão] modelo ${ev.model ?? 'desconhecido'}${ev.cwd ? ` · cwd ${ev.cwd}` : ''}`);
  } else if (ev.type === 'assistant') {
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'text' && b.text) b.text.split('\n').forEach((l) => l.trim() && lines.push(clip(`[claude] ${l}`)));
      else if (b.type === 'tool_use') lines.push(clip(`[ferramenta] ${b.name} ${brief(b.input)}`.trim()));
    }
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'tool_result' && b.is_error) lines.push(clip(`[erro de ferramenta] ${asText(b.content)}`));
    }
  } else if (ev.type === 'result') {
    const result = {
      text: typeof ev.result === 'string' ? ev.result : '',
      isError: !!ev.is_error || (ev.subtype && ev.subtype !== 'success'),
      costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
      durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
      turns: typeof ev.num_turns === 'number' ? ev.num_turns : null,
      permissionDenials: Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0,
    };
    lines.push(`[fim] ${ev.subtype ?? 'result'}${result.turns != null ? ` · ${result.turns} turnos` : ''}${result.costUsd != null ? ` · US$ ${result.costUsd.toFixed(4)}` : ''}`);
    return { lines, result };
  }
  return { lines };
}

/** Linha de stdout: JSON do stream ou texto bruto (mantido como veio). */
export function parseLine(raw) {
  const line = raw.trim();
  if (!line) return { lines: [] };
  try { return formatEvent(JSON.parse(line)); } catch { return { lines: [clip(`[stdout] ${line}`)] }; }
}
