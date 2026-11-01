// Supervisão autônoma do ciclo (Marco B). Módulo PURO e DETERMINÍSTICO: dado o estado gravado do ciclo, a rodada que acabou de terminar e o que o mecanismo de retentativas (plan.js) já
// calculou, recomenda UMA ação entre as que o ciclo já sabe executar. Ele não executa nada, não aprova nada, não amplia permissões e não depende do texto do Planner.
//   retry   : repetir a etapa pelo mecanismo de retentativas do Marco A (retryStep/retryCandidate); a supervisão NÃO tem outro caminho de repetição
//   replan  : falha recuperável e SEM incerteza: o Planner é consultado (como já era) com um diagnóstico factual
//   block   : risco, incerteza, falha repetida ou limite: a progressão automática para
//   complete: nada a corrigir nesta rodada; o fluxo existente avalia a conclusão. NÃO conclui nada: os gates de evidência e verificação continuam sendo os de cycle.js
// Tudo é desligado por padrão (ver resolveSupervision): sem habilitar, o ciclo se comporta exatamente como antes.
import crypto from 'node:crypto';
import { retryClass } from './plan.js';

// ---------- configuração (mesma precedência do Marco A: ambiente > configurações > padrão desligado) ----------
export const SUPERVISOR_ENV = 'ORCH_CYCLE_SUPERVISOR', MAX_MINUTES_ENV = 'ORCH_CYCLE_MAX_MINUTES', STALL_MINUTES_ENV = 'ORCH_CYCLE_STALL_MINUTES', AUTO_RESUMES_ENV = 'ORCH_CYCLE_AUTO_RESUMES';
export const MAX_MINUTES_LIMIT = 1440, STALL_MINUTES_LIMIT = 240, MAX_AUTO_RESUMES = 2;
const raw = (env, k) => String(env[k] ?? '').trim();
const off = (v) => v === '' || v.toLowerCase() === 'off' || v === '0';
function intEnv(env, k, max, what) {
  const v = raw(env, k);
  if (off(v)) return 0;
  if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > max) throw new Error(`${k} inválido: use um inteiro de 1 a ${max} (${what}), ou "off" (ou vazio, ou 0) para desativar.`);
  return Number(v);
}
export function supervisorFromEnv(env = process.env) {
  const v = raw(env, SUPERVISOR_ENV).toLowerCase();
  if (v === '' || v === 'off') return false;
  if (v === 'on') return true;
  throw new Error(`${SUPERVISOR_ENV} inválido: use "on" para ligar a supervisão (bloqueio de falha repetida e histórico de decisões), ou "off" (ou vazio) para desativar.`);
}
export const maxMinutesFromEnv = (env = process.env) => intEnv(env, MAX_MINUTES_ENV, MAX_MINUTES_LIMIT, 'minutos de duração total do ciclo');
export const stallMinutesFromEnv = (env = process.env) => intEnv(env, STALL_MINUTES_ENV, STALL_MINUTES_LIMIT, 'minutos sem saída do Executor');
export function autoResumesFromEnv(env = process.env) {
  const v = raw(env, AUTO_RESUMES_ENV);
  if (off(v)) return 0;
  if (v === '1' || v === '2') return Number(v);
  throw new Error(`${AUTO_RESUMES_ENV} inválido: use 1 ou 2 (máximo ${MAX_AUTO_RESUMES} retomadas automáticas por ciclo), ou "off" (ou vazio, ou 0) para desativar.`);
}
const intIn = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

/**
 * Configuração EFETIVA da supervisão. Por campo: ambiente (definido e não vazio) > configuração persistida (settings) > padrão (tudo desligado/0).
 * Ambiente inválido lança Error (o servidor não sobe); configuração persistida inválida é IGNORADA. `source` diz de onde veio cada valor.
 * @returns {{supervisor:boolean, maxMinutes:number, stallMinutes:number, autoResumes:number, source:Record<string,'env'|'settings'|'default'>}}
 */
export function resolveSupervision({ env = process.env, settings = {} } = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const defs = [
    ['supervisor', SUPERVISOR_ENV, supervisorFromEnv, (v) => typeof v === 'boolean', false],
    ['maxMinutes', MAX_MINUTES_ENV, maxMinutesFromEnv, (v) => intIn(v, MAX_MINUTES_LIMIT), 0],
    ['stallMinutes', STALL_MINUTES_ENV, stallMinutesFromEnv, (v) => intIn(v, STALL_MINUTES_LIMIT), 0],
    ['autoResumes', AUTO_RESUMES_ENV, autoResumesFromEnv, (v) => intIn(v, MAX_AUTO_RESUMES), 0],
  ];
  const out = { source: {} };
  for (const [key, name, parse, valid, dflt] of defs) {
    if (raw(env, name) !== '') { out[key] = parse(env); out.source[key] = 'env'; } else if (valid(s[key])) { out[key] = s[key]; out.source[key] = 'settings'; } else { out[key] = dflt; out.source[key] = 'default'; }
  }
  return out;
}

/** Minutos (configuração) -> milissegundos (o que o ciclo usa). O ciclo também aceita milissegundos diretos (testes). */
export const supervisionMs = (r) => ({ enabled: !!r?.supervisor, maxMs: (r?.maxMinutes || 0) * 60000, stallMs: (r?.stallMinutes || 0) * 60000, autoResumes: r?.autoResumes || 0 });

// ---------- assinatura de falha, perfil e tendência ----------
export const SUPERVISION_LOG_MAX = 60;
export const AUTO_RESUMABLE = Object.freeze(['planner_error', 'planner_invalid']); // transitórios do PLANNER (nenhuma execução do Executor em andamento)
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const PROFILE_FAILING_MAX = 16, PROFILE_PASSING_MAX = 8;
// razões normalizadas: caixa, números (duração, código, contagem), espaços; os nomes de arquivos e scripts continuam (são a identidade da falha)
const norm = (s) => String(s ?? '').toLowerCase().replace(/\d+(?:[.,]\d+)?\s*(?:ms|s|min|segundos?)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
const idOf = (v) => String(v?.id ?? v?.script ?? '?').slice(0, 40);

/**
 * Dica NUMÉRICA de quantas verificações internas falharam, lida do FIM da saída de um executor de testes conhecido (node --test, jest/vitest, pytest). Só serve para comparar duas
 * tentativas do MESMO script; nunca decide sozinha (a saída é produzida pelo código do projeto) e, ausente, a comparação cai para as identidades. null = não reconhecida.
 */
export function failedCountHint(tail) {
  const t = String(tail ?? '').slice(-4000);
  for (const re of [/^\s*(?:ℹ|#)\s*fail\s+(\d{1,6})\s*$/im, /^\s*Tests:\s.*?(\d{1,6})\s+failed/im, /^=+\s.*?(\d{1,6})\s+failed.*=+\s*$/im]) { const m = re.exec(t); if (m) return Number(m[1]); }
  return null;
}

/**
 * Perfil de falhas de uma rodada: identidades ESTÁVEIS das verificações reprovadas (id da verificação) e dos arquivos esperados reprovados, as aprovadas e, quando reconhecidas,
 * as dicas numéricas por verificação. Limitado em tamanho (vai para o registro da supervisão).
 */
export function failureProfile(round) {
  const rep = round?.report, vs = arr(rep?.verifications).filter(isObj);
  const failedV = vs.filter((v) => v.status && v.status !== 'pass');
  const failing = [...failedV.map(idOf), ...arr(rep?.evidence?.system?.expectedFiles).filter((f) => isObj(f) && f.ok === false).map((f) => `file:${String(f.path).slice(0, 80)}`)].sort();
  const passing = vs.filter((v) => v.status === 'pass').map(idOf).sort();
  const hints = {};
  for (const v of failedV) { const n = failedCountHint(v.outputTail); if (n !== null) hints[idOf(v)] = n; }
  return { failing: [...new Set(failing)].slice(0, PROFILE_FAILING_MAX), passing: [...new Set(passing)].slice(0, PROFILE_PASSING_MAX), hints };
}

/** Assinatura determinística (16 hex) da FALHA de uma rodada: etapa, classe, identidades reprovadas (verificações e arquivos esperados) e razões normalizadas. */
export function failureSignature(round) {
  const ev = round?.report?.evidence;
  const cls = retryClass(round) ?? (round?.status !== 'succeeded' ? `exec:${round?.status}` : `evidencia:${ev?.level ?? 'ausente'}`);
  const reasons = [...new Set(arr(ev?.reasons).map(norm))].sort();
  return crypto.createHash('sha256').update(JSON.stringify([round?.stepId ?? null, cls, failureProfile(round).failing, reasons])).digest('hex').slice(0, 16);
}

/** Assinatura de uma RECUSA da política: etapa, desfecho, decisão, regras e (nas negações) o motivo normalizado. Reescrever o texto da proposta NÃO muda a causa da recusa. */
export function refusalSignature(round) {
  const p = round?.policy ?? {}, rules = arr(p.rules).map(String).sort();
  const why = p.outcome === 'denied' ? norm(round?.report?.summary) : '';
  return crypto.createHash('sha256').update(JSON.stringify(['politica', round?.stepId ?? null, p.outcome ?? null, p.decision ?? null, rules, why])).digest('hex').slice(0, 16);
}

/**
 * Tendência da falha atual frente à anterior do mesmo escopo (etapa; avulsa = null):
 *   first     : não há falha anterior;
 *   progress  : (ambos os perfis com verificações reprovadas) menos identidades reprovadas, SEM nenhuma nova e com as que saíram agora APROVADAS (subconjunto estrito), ou as mesmas identidades com a dica numérica estritamente menor em todas;
 *   regressed : as anteriores continuam e há novas;
 *   none      : exatamente as mesmas identidades e nada melhorou;
 *   changed   : outras identidades (trocar umas reprovadas por outras NÃO é progresso, mesmo com a mesma contagem).
 */
export function trendOf(prev, cur) {
  if (!prev || !cur) return 'first';
  const P = new Set(arr(prev.failing)), C = new Set(arr(cur.failing));
  // sem perfil de verificação reprovada em um dos lados (falha de execução, evidência inconclusiva): não há o que comparar, logo nunca é progresso verificável
  if (!P.size || !C.size) return !P.size && !C.size ? 'none' : 'changed';
  const sub = [...C].every((x) => P.has(x)), sup = [...P].every((x) => C.has(x));
  if (sub && sup) {
    const ids = [...C].filter((x) => !x.startsWith('file:'));
    const ph = prev.hints ?? {}, ch = cur.hints ?? {};
    const comparable = ids.length > 0 && ids.every((x) => Number.isInteger(ph[x]) && Number.isInteger(ch[x]));
    if (comparable && ids.every((x) => ch[x] <= ph[x]) && ids.some((x) => ch[x] < ph[x]) && C.size === ids.length) return 'progress';
    return 'none';
  }
  if (sub) { // subconjunto estrito: só é progresso se cada verificação que saiu da lista de reprovadas consta como APROVADA agora (arquivos esperados não têm lista de aprovados)
    const passed = new Set(arr(cur.passing));
    return [...P].filter((x) => !C.has(x)).every((x) => x.startsWith('file:') || passed.has(x)) ? 'progress' : 'changed';
  }
  if (sup) return 'regressed';
  return 'changed';
}

/**
 * Avalia uma rodada TERMINADA (ou recusada pela política).
 * @param {{cycle:object, round:object, retry?:{step:object|null}|null, loopGuard?:boolean}} p  retry = resultado de retryCandidate com o orçamento ATUAL; loopGuard = bloqueia falha repetida
 * @returns {{action:'retry'|'replan'|'block'|'complete', code:string, observation:object, reason:string, signature:string|null, enforce:boolean, profile:object|null}}
 *   `enforce`: o ciclo deve parar por esta decisão (só a falha repetida sem progresso); nos demais bloqueios o ciclo já para pelos seus próprios caminhos e a decisão apenas os explica.
 *   A decisão é uma RECOMENDAÇÃO: o ciclo registra à parte o que de fato foi iniciado (cycle.supervision[].applied).
 */
export function superviseRound({ cycle, round, retry = null, loopGuard = false }) {
  const rep = round?.report, ev = rep?.evidence;
  const obs = (kind, extra = {}) => ({ kind, step: round?.stepId ?? null, evidence: ev?.level ?? null, execution: rep?.status ?? round?.status ?? null, ...extra });
  const mk = (action, code, kind, reason, extra = {}) => ({ action, code, observation: obs(kind, extra.obs), reason, signature: extra.signature ?? null, enforce: !!extra.enforce, profile: extra.profile ?? null });
  const history = arr(cycle?.supervision).filter((e) => e && e.round !== round?.n);
  // ---- recusa da política: barreira ABSOLUTA. O supervisor nunca libera a proposta; só decide se o Planner pode ser consultado de novo ----
  const outcome = round?.policy?.outcome;
  if (outcome === 'denied' || outcome === 'rejected') {
    const signature = refusalSignature(round), rules = arr(round.policy.rules).map(String).sort();
    const o = { outcome, decision: round.policy.decision ?? null, rules };
    const prior = controlMemory(cycle, round?.n).sigs[signature], before = prior && prior.action === 'replan' ? [prior] : []; // memória de CONTROLE (cycle.supControl), não depende da retenção do log visível
    if (loopGuard && before.length) return mk('block', 'supervisor_loop', 'recusa_repetida', `A política recusou de novo uma proposta equivalente (mesma causa, regras ${rules.join(', ') || 'sem regras registradas'}; assinatura ${signature}), já recusada na rodada ${before.at(-1).round}. Nenhuma nova consulta ao Planner: uma pessoa precisa decidir.`, { signature, enforce: true, obs: { ...o, repeatedAtRound: before.at(-1).round } });
    return mk('replan', 'policy_refused', 'politica_recusada', `A política ${outcome === 'denied' ? 'recusou' : 'não liberou (rejeitada pela pessoa)'} esta proposta (regras: ${rules.join(', ') || 'sem regras registradas'}). Ela NÃO foi nem será executada; o Planner é consultado para propor uma alternativa DIFERENTE, que também passará pela política.`, { signature, obs: o });
  }
  // ---- bloqueios: risco ou incerteza (o ciclo já para por estes caminhos; a decisão registra o porquê) ----
  if (rep?.outcomeUncertain) return mk('block', 'uncertain', 'resultado_incerto', 'O resultado desta rodada é incerto (a execução foi cortada); nada é repetido automaticamente.');
  if (round?.status === 'interrupted' || rep?.status === 'interrupted') return mk('block', 'interrupted', 'execucao_interrompida', 'A execução foi interrompida; não é sucesso e não é repetida sozinha.');
  if (arr(rep?.blockers).length) return mk('block', 'permission', 'permissao_negada', 'A execução precisou de uma permissão que não foi concedida.');
  if (round?.integrity?.status === 'flagged') return mk('block', 'integrity', 'integridade', 'Arquivos que validam o trabalho foram alterados e esperam revisão humana.');
  if (arr(rep?.verifications).some((v) => ['blocked', 'error'].includes(v?.status))) return mk('block', 'verification_env', 'verificacao_bloqueada', 'A verificação real não pôde rodar (ambiente ou aprovação).');
  // ---- sucesso comprovado: o fluxo existente avalia a conclusão ----
  if (rep?.status === 'success' && ev?.level === 'verified') return mk('complete', 'verified', 'comprovada', 'Evidência do sistema verificada; o gate de conclusão do ciclo decide o resto.');
  // ---- falha: assinatura, perfil, tendência e prevenção de loop ----
  const signature = failureSignature(round), profile = failureProfile(round);
  const prevEntry = history.filter((e) => e.profile && (e.step ?? null) === (round?.stepId ?? null)).at(-1);
  const trend = trendOf(prevEntry?.profile, profile);
  const kind = rep?.status !== 'success' ? 'execucao_falhou' : ev?.level === 'failed' ? (arr(rep?.verifications).some((v) => v?.status && v.status !== 'pass') ? 'verificacao_reprovada' : 'arquivo_esperado') : 'inconclusiva';
  const tr = { trend, failing: profile.failing.length, passing: profile.passing.length };
  const prior = controlMemory(cycle, round?.n).sigs[signature], before = prior ? [prior] : [];
  if (loopGuard && before.length && trend !== 'progress') {
    return mk('block', 'supervisor_loop', 'falha_repetida', `A mesma falha (assinatura ${signature}: ${profile.failing.join(', ') || 'sem identidades'}) já ocorreu na rodada ${before.at(-1).round} e se repetiu na rodada ${round.n} SEM progresso verificável: nova tentativa automática bloqueada. Uma pessoa precisa decidir.`, { signature, profile, enforce: true, obs: { ...tr, repeatedAtRound: before.at(-1).round } });
  }
  if (arr(cycle?.rounds).length >= (cycle?.maxIterations ?? Infinity)) return mk('block', 'limit', kind, 'Não restam rodadas neste ciclo.', { signature, profile, obs: tr });
  if (retry?.step) return mk('retry', retry.cls ?? 'retry', kind, `Falha recuperável (classe ${retry.cls}) com orçamento de retentativas: pelo mecanismo existente, tentativa ${retry.attempt}.${trend === 'progress' ? ' Houve progresso verificável desde a tentativa anterior.' : ''}`, { signature, profile, obs: { ...tr, class: retry.cls } });
  return mk('replan', 'replan', kind, 'Falha sem incerteza e fora do orçamento ou da classe de retentativa: o Planner é consultado com o diagnóstico factual.', { signature, profile, obs: tr });
}

/**
 * Memória de CONTROLE da supervisão, separada do log visível (limitado a SUPERVISION_LOG_MAX entradas): última rodada/ação por assinatura de falha (retry|replan) e retomadas automáticas gastas.
 * Lê `cycle.supControl` (persistido) e também o log, o que mantém compatíveis os ciclos gravados antes de existir `supControl`. Puro: não altera o ciclo. `exceptRound`: a rodada em avaliação não conta.
 * @returns {{sigs:Record<string,{round:number,action:'retry'|'replan'}>, resumes:number}}
 */
export function controlMemory(cycle, exceptRound = null) {
  const sigs = {}, log = arr(cycle?.supervision), ctl = isObj(cycle?.supControl) ? cycle.supControl : {};
  const put = (sig, round, action) => { if (typeof sig !== 'string' || !sig || (action !== 'retry' && action !== 'replan') || (exceptRound !== null && round === exceptRound)) return; const cur = sigs[sig]; if (!cur || !(cur.round > round)) sigs[sig] = { round, action }; };
  for (const e of log) if (isObj(e)) put(e.signature, e.round, e.action);
  for (const [k, v] of Object.entries(isObj(ctl.sigs) ? ctl.sigs : {})) if (isObj(v)) put(k, v.round, v.action);
  const fromLog = log.filter((e) => e?.action === 'resume').length, stored = Number.isInteger(ctl.resumes) && ctl.resumes > 0 ? ctl.resumes : 0;
  return { sigs, resumes: Math.max(fromLog, stored) };
}

/** Estados FINAIS do desfecho de uma decisão (`applied`): depois deles nada muda (nem volta a "iniciada"). */
export const APPLIED_FINAL = Object.freeze(['completed', 'not_applied', 'stopped', 'n/a']);
export const transitionApplied = (prev, next) => (APPLIED_FINAL.includes(prev?.state) ? prev : next);
export const CONTROL_SIGS_MAX = 100;

/** Estourou o tempo ativo do ciclo? (`activeMs` já inclui o laço em andamento.) */
export const timeExceeded = (activeMs, maxMs) => maxMs > 0 && activeMs >= maxMs;
/** Execução sem saída há tempo demais? `lastMs` = instante da última saída (ou do início). Ausência de saída NÃO prova inatividade: o chamador registra a incerteza. */
export const stallExceeded = (nowMs, lastMs, stallMs) => stallMs > 0 && Number.isFinite(lastMs) && nowMs - lastMs >= stallMs;

/**
 * Pode retomar automaticamente? Só bloqueio TRANSITÓRIO do Planner, com orçamento, sem nenhuma execução ambígua e com tudo ocioso. Qualquer dúvida => { ok:false, reason }.
 * `world`: { executorBusy, plannerBusy, runningTask, limitReason } — o que só o ciclo sabe.
 */
export function autoResumeDecision({ cycle, autoResumes, world = {} }) {
  const used = controlMemory(cycle).resumes;
  if (!(autoResumes > 0)) return { ok: false, reason: 'retomada automática desligada', used };
  if (!cycle || cycle.status !== 'blocked') return { ok: false, reason: 'o ciclo não está bloqueado', used };
  if (!AUTO_RESUMABLE.includes(cycle.blockedCode)) return { ok: false, reason: `o bloqueio "${cycle.blockedCode}" não é um bloqueio transitório do Planner`, used };
  if (cycle.cancelRequested) return { ok: false, reason: 'cancelamento pedido', used };
  if (used >= autoResumes) return { ok: false, reason: `orçamento de ${autoResumes} retomada(s) automática(s) esgotado`, used };
  if (arr(cycle.approvals).some((a) => a?.status === 'pending')) return { ok: false, reason: 'há aprovação pendente', used };
  if (arr(cycle.rounds).some((r) => r?.report?.outcomeUncertain || r?.status === 'running' || r?.status === 'interrupted')) return { ok: false, reason: 'há rodada incerta, interrompida ou em andamento: não dá para provar que nenhuma execução ambígua continua ativa', used };
  if (arr(cycle.integrity?.pending).length) return { ok: false, reason: 'há alterações em testes/configuração aguardando revisão', used };
  if (world.executorBusy || world.runningTask) return { ok: false, reason: 'há uma execução em andamento (ou processo anterior vivo)', used };
  if (world.plannerBusy) return { ok: false, reason: 'o Planner está ocupado', used };
  if (world.limitReason) return { ok: false, reason: world.limitReason, used };
  return { ok: true, reason: 'bloqueio transitório do Planner, sem execução ambígua e dentro dos limites', used };
}
