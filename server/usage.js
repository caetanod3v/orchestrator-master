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

/** Payload do evento SSE `usage`: identifica agente/missão/tarefa (ou chamada do Planner) e leva só números e a etiqueta de modelo; nunca texto da conversa. */
export function usageEvent(agent, ids, record) {
  return { agent, ...ids, ...record };
}
