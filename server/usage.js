// Registro persistido e evento SSE das métricas de uso reportadas pela CLI (Token Monitor, fase 2). Funções puras: quem chama dá o relógio.
//
// Regra para quem somar depois (fases seguintes): usar `final` quando existir (basis 'final'); senão `live` (provisório). NUNCA os dois:
// o `live` é a soma de mensagens distintas e o `final` é o total do evento result, que já inclui aquele consumo.
// Campo ausente é null (nunca 0). O custo é uma estimativa da CLI, não cobrança; `rateLimit` é um indicador de aviso, não saldo de tokens.

const has = (s) => !!s && (!!s.final || !!s.live || !!s.rateLimit);

/**
 * Snapshot do tracker ({ final, live, rateLimit }) -> registro persistível; null se a CLI não reportou nada (nada vira zero).
 * @param {{final:object|null, live:object|null, rateLimit:object|null}|null|undefined} snap
 * @param {{ended:boolean, at:string}} o  ended: a execução acabou (sem `final`, o `live` fica como parcial/provisório)
 */
export function usageRecord(snap, { ended, at }) {
  if (!has(snap)) return null;
  const basis = snap.final ? 'final' : snap.live ? 'live' : null;
  return { basis, provisional: basis !== 'final', ended: !!ended, final: snap.final ?? null, live: snap.live ?? null, rateLimit: snap.rateLimit ?? null, updatedAt: at };
}

// ---------- Agregação (Token Monitor, fase 3) ----------
// Tudo é DERIVADO dos registros existentes (task.tokenUsage, cycle.plannerUsage, task.usage); nada é persistido aqui.
const FIELDS = ['input', 'output', 'cacheCreation', 'cacheRead', 'costUsd'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Totais de um grupo: cada campo é a soma do que foi REPORTADO (null se ninguém reportou; nunca 0 por falta de dado). */
const blank = () => ({ input: null, output: null, cacheCreation: null, cacheRead: null, costUsd: null, entries: 0, final: 0, provisional: 0 });
const bucket = () => ({ total: blank(), byAgent: { executor: blank(), planner: blank() } });
function add(t, e) {
  for (const f of FIELDS) if (e[f] !== null) t[f] = (t[f] ?? 0) + e[f];
  t.entries++;
  if (e.basis === 'final') t.final++; else t.provisional++;
}

/**
 * Um registro (task.tokenUsage ou entrada de plannerUsage) -> UMA entrada contável, ou null se não há consumo reportado.
 * `final` SUBSTITUI o `live` da mesma execução (o live nunca é somado junto). Do final usa-se a soma de modelUsage (inclui subagentes)
 * e, campo a campo, `tokens` (agente principal) quando o modelUsage não reportou aquele campo. Sem final, o live entra como provisório (sem custo).
 */
function entryOf(rec) {
  if (!isObj(rec)) return null;
  if (isObj(rec.final)) {
    const all = rec.final.tokensAllModels, main = rec.final.tokens, pick = (f) => num(all?.[f]) ?? num(main?.[f]);
    return { basis: 'final', input: pick('input'), output: pick('output'), cacheCreation: pick('cacheCreation'), cacheRead: pick('cacheRead'), costUsd: num(rec.final.costUsd) };
  }
  if (isObj(rec.live) && isObj(rec.live.tokens)) {
    const t = rec.live.tokens;
    return { basis: 'live', input: num(t.input), output: num(t.output), cacheCreation: num(t.cacheCreation), cacheRead: num(t.cacheRead), costUsd: null };
  }
  return null;
}

/**
 * Resumo para /api/state.usage a partir das missões visíveis. Evita dupla contagem por construção: uma tarefa conta UMA vez (seu tokenUsage já é o
 * último estado: final OU live) e uma chamada do Planner conta uma vez (chave missão|ciclo|chamada, mesmo que o ciclo apareça em cycle e pastCycles).
 *
 * Campos legados (iguais aos de antes): costUsd, runs (+ durationMs), vindos de task.usage das tarefas do Executor.
 * Novos: total, byAgent, byMission, byCycle (cada um { total, byAgent } ou os totais), rateLimit (último indicador de aviso, SEPARADO do consumo)
 * e limit/remaining sempre null: nenhuma fonte oficial de limite ou saldo de tokens é lida.
 * Tarefas do Executor fora de qualquer rodada contam na missão e no total, mas em nenhum ciclo. Ciclos antigos além dos 5 guardados em pastCycles saem do resumo.
 * @returns {object|null} null se não há nenhum dado de uso
 */
export function summarizeUsage(missions) {
  const all = bucket(), mis = new Map(), cyc = new Map(), seen = new Set();
  let costUsd = null, runs = 0, durationMs = null, rl = null, rlAt = '';
  const noteLimit = (rec, agent, missionId) => {
    const r = rec?.rateLimit;
    if (!isObj(r)) return;
    const at = typeof rec.updatedAt === 'string' ? rec.updatedAt : '';
    if (rl && at < rlAt) return;
    rl = { status: typeof r.status === 'string' ? r.status : null, utilization: num(r.utilization), resetsAt: num(r.resetsAt), agent, missionId, at: at || null };
    rlAt = at;
  };

  for (const m of Array.isArray(missions) ? missions : []) {
    const cycles = [m.cycle, ...(Array.isArray(m.pastCycles) ? m.pastCycles : [])]
      .map((c, i) => (isObj(c) ? { c, key: typeof c.id === 'string' ? c.id : `#${i}` } : null)).filter(Boolean);
    const taskCycle = new Map();
    for (const { c, key } of cycles) for (const r of Array.isArray(c.rounds) ? c.rounds : []) if (isObj(r) && typeof r.taskId === 'string' && !taskCycle.has(r.taskId)) taskCycle.set(r.taskId, key);

    const count = (agent, cycleKey, e) => {
      add(all.total, e); add(all.byAgent[agent], e);
      if (!mis.has(m.id)) mis.set(m.id, { missionId: m.id, ...bucket() });
      const mb = mis.get(m.id); add(mb.total, e); add(mb.byAgent[agent], e);
      if (cycleKey !== null) {
        const k = `${m.id}\u0000${cycleKey}`;
        if (!cyc.has(k)) cyc.set(k, { missionId: m.id, cycleId: cycleKey.startsWith('#') ? null : cycleKey, ...bucket() });
        const cb = cyc.get(k); add(cb.total, e); add(cb.byAgent[agent], e);
      }
    };

    for (const t of Array.isArray(m.tasks) ? m.tasks : []) {
      if (!isObj(t)) continue;
      if (isObj(t.usage) && typeof t.usage.costUsd === 'number') { costUsd = (costUsd ?? 0) + t.usage.costUsd; runs++; }
      if (isObj(t.usage) && typeof t.usage.durationMs === 'number') durationMs = (durationMs ?? 0) + t.usage.durationMs;
      noteLimit(t.tokenUsage, 'executor', m.id);
      const e = entryOf(t.tokenUsage), k = `x|${m.id}|${t.id}`;
      if (!e || seen.has(k)) continue;
      seen.add(k); count('executor', taskCycle.get(t.id) ?? null, e);
    }
    for (const { c, key } of cycles) {
      (Array.isArray(c.plannerUsage) ? c.plannerUsage : []).forEach((p, i) => {
        noteLimit(p, 'planner', m.id);
        const e = entryOf(p), k = `p|${m.id}|${key}|${p?.call ?? `i${i}`}`;
        if (!e || seen.has(k)) return;
        seen.add(k); count('planner', key, e);
      });
    }
  }

  if (costUsd === null && all.total.entries === 0 && !rl) return null;
  return {
    costUsd, runs, durationMs,
    total: all.total, byAgent: all.byAgent,
    byMission: [...mis.values()], byCycle: [...cyc.values()],
    rateLimit: rl, limit: null, remaining: null,
  };
}

/** Payload do evento SSE `usage`: identifica agente/missão/tarefa (ou chamada do Planner) e leva só números e a etiqueta de modelo; nunca texto da conversa. */
export function usageEvent(agent, ids, record) {
  return { agent, ...ids, ...record };
}
