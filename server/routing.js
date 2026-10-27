// Roteamento de modelo/esforço do Planner.
//
// Camadas do Planner:
//   lite     claude-haiku-5-5, esforço low
//   standard o que já existe: ORCH_PLANNER_MODEL / ORCH_PLANNER_EFFORT (vazios = padrão da CLI)
// O roteamento fica DESLIGADO por padrão (ORCH_PLANNER_ROUTING=off): sem ele nada deste módulo é usado e o comportamento é o de sempre.
// O roteador só decide QUEM responde; nunca o que é aceito (validação, regras de conclusão e verificações continuam no cycle.js).
//
// ---- Incremento B ----------------------------------------------------------------------------------------------------------------------------
// 1) SELEÇÃO INICIAL (pickInitialTier, função pura, só com dados disponíveis ANTES da 1ª chamada; nenhuma chamada ao modelo).
//    `lite` exige TODAS as evidências abaixo (uma só nunca basta: nem "há verificação" nem "o texto é curto" provam simplicidade);
//    qualquer dúvida, falta de evidência ou marcador de risco => `standard`:
//      a. há ao menos uma verificação REAL OBRIGATÓRIA aprovada no espaço de trabalho (a conclusão fica protegida pelo backend);
//      b. nenhum histórico: sem ciclos anteriores, sem orientação humana, sem rodadas, sem rejeições, até LITE_LIMITS.maxIterations rodadas;
//      c. o enunciado é curto (30 a 400 caracteres, até 3 frases) e tem um critério de aceitação explícito (critério, aceitação, teste, npm test…);
//      d. o enunciado NOMEIA de 1 a 2 arquivos concretos (alvo explícito e escopo pequeno);
//      e. nenhum marcador de ambiguidade ou de risco: mudança abrangente (refatorar, migrar, reescrever, todos os…), dependência de fonte externa
//         ao enunciado (conforme…, de acordo com…, segundo o…), investigação (investigar, descobrir…), pergunta (?), linguagem vaga (talvez,
//         se possível, a definir, por exemplo, etc…);
//      f. nenhuma contradição SINTÁTICA (a mesma expressão com dois valores diferentes, como add(2,2) retorna 4 e add(2,2) retorna 5);
//      g. espaço de trabalho pequeno (até LITE_LIMITS.listing entradas na listagem de 2 níveis).
//    LIMITE CONHECIDO: contradições semânticas (que exigem entender o domínio, como "soma aritmética" x "add(2,2) retorna 5") NÃO são detectáveis
//    sem um modelo e não bloqueiam o `lite`; a proteção nesses casos é a regra de conclusão do backend e o escalonamento por rejeição.
// 2) ESCALONAMENTO POR REJEIÇÃO: se uma resposta do Planner for rejeitada pelas validações existentes e a chamada usou `lite`, a tentativa seguinte
//    (a que já existe em askPlanner; nenhuma chamada extra) usa `standard`. No máximo uma vez por ciclo; depois, `standard` até o fim do ciclo.
//    Se a rota já era `standard`, nada muda. O estado fica em cycle.routing (persistido: sobrevive a bloqueio, retomada e reinício).
//
// ---- Incremento C ----------------------------------------------------------------------------------------------------------------------------
// 3) ESCALONAMENTO POR SINAL OBSERVÁVEL (escalationSignal, pura; só dados que o ciclo já persiste; nenhuma chamada extra). Vale só para `lite` ainda
//    não escalonado, na 1ª tentativa de uma consulta (a rejeição segue a regra 2). Mesmo estado, mesmo teto (um escalonamento por ciclo, sem downgrade).
//    Sinais usados:
//      sem_progresso   o ciclo foi bloqueado por `no_progress` (2 rodadas seguidas sem progresso, critério do próprio backend) e as 2 últimas rodadas
//                      TERMINARAM com sucesso (não foram falhas do Executor). Os contadores zeram na retomada; o bloqueio persistido é a evidência.
//      limite_rodadas  perto do limite (>= ESCALATION.minRounds rodadas e resta no máximo ESCALATION.roundsLeft) E a última rodada terminou com sucesso mas SEM progresso
//                      (cycle.consecutiveNoProgress >= 1: o contador que o ciclo já mantém). Só o tamanho do ciclo não basta: com progresso consistente fica em lite.
//    Sinais DELIBERADAMENTE fora:
//      falhas do Executor  (executor_failures, falha isolada): o código não distingue falha transitória (CLI, rede, permissão) de plano ruim; escalonar o
//                          Planner por isso seria especulação. Falha isolada não muda a rota.
//      repetição de tarefa já é rejeitada por semanticProblem e, portanto, escalona pela regra 2 (não há sinal novo a criar).
//      bloqueio pedido pelo Planner (`planner_blocked`) ou verificação reprovada: decisões/resultados corretos, não evidência de insuficiência.
//      orçamento de consultas (plannerCalls): cada consulta repetida já é uma rejeição, tratada pela regra 2.

export const TIERS = Object.freeze({ lite: Object.freeze({ model: 'claude-haiku-5-5', effort: 'low' }) });
export const TIER_NAMES = Object.freeze(['lite', 'standard']);

/** Limites da seleção inicial (incluídos). */
export const LITE_LIMITS = Object.freeze({ objectiveMin: 30, objectiveMax: 400, sentences: 3, files: 2, listing: 60, maxIterations: 5 });

/** ORCH_PLANNER_ROUTING: vazio/off = desligado (padrão); on = ligado. Qualquer outro valor lança Error (o servidor não sobe). */
export function routingFromEnv(env = process.env) {
  const v = (env.ORCH_PLANNER_ROUTING ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return 'off';
  if (v === 'on') return 'on';
  throw new Error('ORCH_PLANNER_ROUTING inválido: use off ou on.');
}

/** { model, effort } de uma camada (`standard` = a configuração existente do ambiente); null se a camada não existe. */
export function tierSettings(tier, standard = {}) {
  if (tier === 'standard') return { model: standard.model, effort: standard.effort };
  return Object.hasOwn(TIERS, tier) ? { ...TIERS[tier] } : null;
}

// ---------- sinais (somente leitura; nada é inventado) ----------
const FILE_RE = /(?:[\w@.-]+\/)*[\w@-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md|txt|css|html|py|yml|yaml|toml|sh)\b/gi;
const ACCEPT_RE = /crit[ée]rio|aceita[cç][aã]o|npm test|\btestes?\b|\bpassa(?:r|m)?\b/i;
const AMBIGUITY = [
  [/refator|migra[rç]|reescre|redesenh|arquitet|reestrutur/i, 'mudança abrangente (refatorar, migrar, reescrever)'],
  [/\b(?:todos|todas)\s+(?:os|as)\b|\btod[oa]s?\s+(?:o|a)\s+(?:projeto|código|repositório|sistema|workspace|espaço)/i, 'escopo amplo (todos os…, todo o projeto)'],
  [/conforme|de acordo com|segundo\s+(?:o|a|os|as)\b|basead[oa] em|seguindo\s+(?:o|a)\b/i, 'depende de fonte externa ao enunciado'],
  [/investig|diagnostic|descobr|pesquis|averigu/i, 'investigação (a causa não é conhecida)'],
  [/\?/, 'contém pergunta'],
  [/\b(?:talvez|se poss[ií]vel|a definir|a combinar|a confirmar|tbd|ou ent[aã]o|e\/ou|pode ser|algo como|por exemplo)\b|\betc\b/i, 'linguagem vaga'],
];
// "<expressão> retorna|devolve|deve ser|vale|= <valor>": a mesma expressão com valores diferentes é uma contradição sintática
const CLAIM_RE = /([A-Za-z_][\w.]*(?:\([^()]*\))?)\s*(?:retorna|devolve|deve\s+(?:ser|valer|retornar)|vale|=)\s*"?([^\s,;)"']+)/gi;

function claimsConflict(text) {
  const seen = new Map(), out = new Set();
  for (const m of text.matchAll(CLAIM_RE)) {
    const key = m[1].replace(/\s+/g, '').toLowerCase(), val = m[2].replace(/[.:]+$/, '').toLowerCase();
    if (seen.has(key) && seen.get(key) !== val) out.add(key); else if (!seen.has(key)) seen.set(key, val);
  }
  return [...out];
}

/**
 * Sinais disponíveis antes da 1ª chamada ao Planner (puro; não altera nada do que recebe).
 * @param {{mission:object, cycle:object, workspace:object, listing:string[]}} ctx
 */
export function extractSignals({ mission, cycle, workspace, listing } = {}) {
  const text = typeof mission?.objective === 'string' ? mission.objective.trim() : '';
  const files = [...new Set((text.match(FILE_RE) || []).map((f) => f.toLowerCase()))];
  return {
    objectiveChars: text.length,
    sentences: text.split(/[.!?;]+(?:\s+|$)/).map((s) => s.trim()).filter(Boolean).length,
    files: files.slice(0, 6), fileCount: files.length,
    acceptance: ACCEPT_RE.test(text),
    ambiguity: AMBIGUITY.filter(([re]) => re.test(text)).map(([, label]) => label),
    contradictions: claimsConflict(text),
    requiredVerification: (workspace?.verifications || []).some((v) => v?.required === true),
    history: { pastCycles: mission?.pastCycles?.length || 0, humanNotes: cycle?.humanNotes?.length || 0, rounds: cycle?.rounds?.length || 0, rejections: cycle?.rejections?.length || 0 },
    listing: Array.isArray(listing) ? listing.length : 0,
    maxIterations: cycle?.maxIterations ?? null,
  };
}

/**
 * Seleção inicial determinística. `lite` só se TODAS as evidências valerem; senão `standard` com o primeiro motivo e a lista completa do que falhou.
 * @returns {{tier:'lite'|'standard', reason:string, signals:object}}
 */
export function pickInitialTier(ctx) {
  const s = extractSignals(ctx), L = LITE_LIMITS, failed = [];
  const need = (ok, code, why) => { if (!ok) failed.push({ code, why }); };
  need(s.objectiveChars > 0, 'objetivo_ausente', 'a missão não tem objetivo escrito (nada comprova que a tarefa é simples)');
  need(s.requiredVerification, 'sem_verificacao_obrigatoria', 'não há verificação real obrigatória aprovada (a conclusão dependeria só de evidência autodeclarada)');
  need(!(s.history.pastCycles || s.history.humanNotes || s.history.rounds || s.history.rejections), 'historico', 'há histórico (ciclos anteriores, orientação humana, rodadas ou rejeições)');
  need(s.maxIterations === null || s.maxIterations <= L.maxIterations, 'limite_rodadas', `o limite de rodadas (${s.maxIterations}) indica trabalho mais longo (máximo ${L.maxIterations})`);
  need(s.objectiveChars === 0 || s.objectiveChars >= L.objectiveMin, 'objetivo_curto', `o objetivo tem menos de ${L.objectiveMin} caracteres (pouca informação)`);
  need(s.objectiveChars <= L.objectiveMax, 'objetivo_longo', `o objetivo tem mais de ${L.objectiveMax} caracteres`);
  need(s.sentences <= L.sentences, 'muitas_frases', `o objetivo tem mais de ${L.sentences} frases`);
  need(s.fileCount >= 1, 'sem_arquivo_nomeado', 'o objetivo não nomeia o arquivo alvo');
  need(s.fileCount <= L.files, 'muitos_arquivos', `o objetivo nomeia mais de ${L.files} arquivos (alteração abrangente)`);
  need(s.acceptance, 'sem_criterio_aceitacao', 'o objetivo não traz um critério de aceitação explícito');
  for (const label of s.ambiguity) need(false, 'ambiguidade', label);
  for (const key of s.contradictions) need(false, 'contradicao', `requisitos contraditórios para ${key}`);
  need(s.listing <= L.listing, 'workspace_grande', `o espaço de trabalho tem mais de ${L.listing} entradas na listagem`);
  const signals = { ...s, failed: failed.map((f) => f.code) };
  if (failed.length) return { tier: 'standard', reason: `standard: ${failed[0].why}${failed.length > 1 ? ` (+${failed.length - 1} outro(s) motivo(s))` : ''}`, signals };
  return { tier: 'lite', reason: 'lite: verificação obrigatória aprovada, sem histórico, enunciado curto com critério de aceitação, 1 a 2 arquivos nomeados e nenhum marcador de ambiguidade', signals };
}

const clip = (s, n) => String(s ?? '').slice(0, n);

/** Limites do sinal `limite_rodadas` (incluídos). */
export const ESCALATION = Object.freeze({ minRounds: 2, roundsLeft: 1 });

/**
 * Sinal observável de que a camada `lite` não está conduzindo o ciclo (puro; lê só o ciclo recebido). null = nenhum sinal.
 * @returns {{code:'sem_progresso'|'limite_rodadas', why:string}|null}
 */
export function escalationSignal(cycle) {
  const rounds = Array.isArray(cycle?.rounds) ? cycle.rounds : [], last = Array.isArray(cycle?.blocks) ? cycle.blocks.at(-1) : null;
  if (last?.code === 'no_progress' && rounds.length >= 2 && rounds.slice(-2).every((r) => r?.report?.status === 'success')) {
    return { code: 'sem_progresso', why: 'as 2 últimas rodadas foram bem-sucedidas, mas sem progresso (o ciclo foi bloqueado por falta de progresso)' };
  }
  const max = cycle?.maxIterations;
  if (Number.isInteger(max) && rounds.length >= ESCALATION.minRounds && rounds.length >= max - ESCALATION.roundsLeft && cycle?.consecutiveNoProgress >= 1 && rounds.at(-1)?.report?.status === 'success') {
    return { code: 'limite_rodadas', why: `${rounds.length} rodadas sem concluir, a última sem progresso, e o limite é ${max}` };
  }
  return null;
}

/**
 * Roteador: seleção inicial (1ª chamada do ciclo) e escalonamento por rejeição. Puro: devolve o novo estado em `state` e quem chama o guarda
 * em cycle.routing (a máquina de estados lê só o `cycle.routing` recebido).
 *   cycle.routing = { tier, escalated, escalatedAtCall?, initial: { tier, reason, signals } }
 * @returns {{tier:string, reason:string, signals:object, state:object}}
 */
export function createRouter() {
  return {
    pick({ mission, cycle, workspace, listing, retryAfterRejection = false, rejection = null, call = null } = {}) {
      const st = cycle?.routing;
      if (!st || !TIER_NAMES.includes(st.tier)) {
        const sel = pickInitialTier({ mission, cycle, workspace, listing });
        return { tier: sel.tier, reason: sel.reason, signals: sel.signals, state: { tier: sel.tier, escalated: false, initial: { tier: sel.tier, reason: sel.reason, signals: sel.signals } } };
      }
      if (st.tier === 'lite' && !st.escalated && retryAfterRejection) {
        return {
          tier: 'standard', reason: 'escalonado de lite para standard: a resposta anterior do Planner foi rejeitada pelas validações do backend',
          signals: { from: 'lite', trigger: 'rejeição', rejection: clip(rejection, 160) },
          state: { ...st, tier: 'standard', escalated: true, escalatedAtCall: call },
        };
      }
      if (st.tier === 'lite' && !st.escalated) {
        const sig = escalationSignal(cycle);
        if (sig) {
          return {
            tier: 'standard', reason: `escalonado de lite para standard: ${sig.why}`,
            signals: { from: 'lite', trigger: sig.code },
            state: { ...st, tier: 'standard', escalated: true, escalatedAtCall: call, trigger: sig.code },
          };
        }
      }
      const why = st.escalated ? 'já escalonado neste ciclo (no máximo um escalonamento)' : st.tier === 'standard' && retryAfterRejection ? 'já era a camada inicial (não há para onde escalonar)' : 'nenhuma rejeição a tratar';
      return { tier: st.tier, reason: `mantido ${st.tier}: ${why}`, signals: {}, state: st };
    },
  };
}
