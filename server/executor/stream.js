// Converte linhas do `claude -p --output-format stream-json` em linhas legíveis de log.
// Só traduz o que a CLI realmente emitiu; nada é inventado.

const MAX = 2000;
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX)}…` : s);
const brief = (input = {}) => input.file_path || input.path || input.pattern || input.command || '';
const asText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('') : '');

/** @returns {{lines:string[], result?:{text:string,isError:boolean,costUsd:number|null,durationMs:number|null,turns:number|null}}} */
export function formatEvent(ev) {
  const lines = [];
  if (!ev || typeof ev !== 'object') return { lines };
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
