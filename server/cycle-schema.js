// Validação ESTRITA de tudo que o Planner devolve e de tudo que o Executor reporta.
// O Planner só pode escolher entre `continue`, `complete` e `blocked`; qualquer chave desconhecida
// (permissions, command, cwd, authorized, allowTools…) invalida a resposta inteira.

import { isAgent, AGENT_NAMES } from './agents.js';

export const DECISIONS = ['continue', 'complete', 'blocked'];
export const PLAN_DECISION = 'plan'; // M4: só é aceita com `validateDecision(raw, { plan: true })` (ORCH_CYCLE_PLAN=on); sem isso o contrato é o de sempre
const TOP_KEYS = ['decision', 'rationale', 'task', 'evidence', 'blockedReason'];
const TASK_KEYS = ['title', 'instructions', 'acceptance', 'agent']; // agent: opcional (perfil de agents.js); ausente = perfil padrão, resolvido por quem executa
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/** Extrai um objeto JSON do texto: texto puro, bloco ```json ou primeiro {...} balanceado. */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'resposta vazia' };
  const t = text.trim();
  const tries = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) tries.push(fence[1].trim());
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  for (const c of tries) { try { const v = JSON.parse(c); if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v }; } catch { /* tenta o próximo */ } }
  return { ok: false, error: 'não foi encontrado um objeto JSON válido' };
}

export const str = (v, name, min, max) => {
  if (typeof v !== 'string') return `"${name}" deve ser texto`;
  const s = v.trim();
  if (s.length < min) return `"${name}" não pode ser vazio`;
  if (s.length > max) return `"${name}" excede ${max} caracteres`;
  if (CTRL.test(s)) return `"${name}" contém caracteres de controle`;
  return null;
};
export const list = (v, name, minN, maxN, maxLen) => {
  if (!Array.isArray(v)) return `"${name}" deve ser uma lista`;
  if (v.length < minN || v.length > maxN) return `"${name}" deve ter de ${minN} a ${maxN} itens`;
  for (const x of v) { const e = str(x, `${name}[]`, 1, maxLen); if (e) return e; }
  return null;
};

// ---------- Plano de múltiplas etapas (M4) ----------
export const MAX_PLAN_STEPS = 10;
const STEP_KEYS = ['id', 'title', 'instructions', 'acceptance', 'dependsOn', 'agent'];
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * Valida a lista de etapas de um plano (a do Planner e, de novo, a que já está gravada): estrutura, ids únicos, dependências existentes,
 * sem auto-dependência nem ciclos e pelo menos uma etapa sem dependências (a única que pode começar). Não aceita chaves desconhecidas.
 * @returns {{ok:true, steps:object[]} | {ok:false, error:string}}
 */
export function validatePlanSteps(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: '"steps" deve ser uma lista' };
  if (raw.length < 1 || raw.length > MAX_PLAN_STEPS) return { ok: false, error: `"steps" deve ter de 1 a ${MAX_PLAN_STEPS} etapas` };
  const steps = [], ids = new Set();
  for (const [i, x] of raw.entries()) {
    const at = `steps[${i}]`;
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, error: `${at} deve ser um objeto` };
    const extra = Object.keys(x).filter((k) => !STEP_KEYS.includes(k));
    if (extra.length) return { ok: false, error: `chaves não permitidas em ${at}: ${extra.join(', ')}` };
    if (typeof x.id !== 'string' || !STEP_ID.test(x.id)) return { ok: false, error: `${at}.id deve ser texto de 1 a 32 caracteres (letras, números, "_" ou "-")` };
    if (ids.has(x.id)) return { ok: false, error: `id de etapa duplicado: "${x.id}"` };
    ids.add(x.id);
    const e = str(x.title, `${at}.title`, 1, 200) || str(x.instructions, `${at}.instructions`, 1, 4000) || list(x.acceptance, `${at}.acceptance`, 1, 8, 300);
    if (e) return { ok: false, error: e };
    if (x.agent !== undefined && !isAgent(x.agent)) return { ok: false, error: `"${at}.agent" deve ser um perfil conhecido (${AGENT_NAMES.join(' | ')})` };
    const deps = x.dependsOn ?? [];
    if (!Array.isArray(deps) || deps.length > MAX_PLAN_STEPS - 1 || deps.some((d) => typeof d !== 'string')) return { ok: false, error: `${at}.dependsOn deve ser uma lista de ids de etapas` };
    if (new Set(deps).size !== deps.length) return { ok: false, error: `${at}.dependsOn repete uma dependência` };
    steps.push({ id: x.id, title: x.title.trim(), instructions: x.instructions.trim(), acceptance: x.acceptance.map((a) => a.trim()), dependsOn: [...deps], ...(x.agent !== undefined ? { agent: x.agent } : {}) });
  }
  for (const st of steps) {
    for (const d of st.dependsOn) {
      if (d === st.id) return { ok: false, error: `a etapa "${st.id}" depende de si mesma` };
      if (!ids.has(d)) return { ok: false, error: `a etapa "${st.id}" depende de "${d}", que não existe no plano` };
    }
  }
  const left = new Map(steps.map((st) => [st.id, new Set(st.dependsOn)]));
  if (![...left.values()].some((d) => d.size === 0)) return { ok: false, error: 'nenhuma etapa pode começar: todas têm dependências' };
  for (let moved = true; moved && left.size;) { // elimina, em ondas, as etapas cujas dependências já foram eliminadas; o que sobra está em ciclo
    moved = false;
    for (const [id, d] of left) if (d.size === 0) { left.delete(id); for (const o of left.values()) o.delete(id); moved = true; }
  }
  if (left.size) return { ok: false, error: `dependências circulares entre as etapas: ${[...left.keys()].join(', ')}` };
  return { ok: true, steps };
}

/** @returns {{ok:true, value:object} | {ok:false, error:string}} */
export function validateDecision(raw, { plan = false } = {}) {
  const j = extractJson(raw);
  if (!j.ok) return j;
  const d = j.value;
  const allowed = plan ? [...TOP_KEYS, 'steps'] : TOP_KEYS, decisions = plan ? [...DECISIONS, PLAN_DECISION] : DECISIONS;
  const extra = Object.keys(d).filter((k) => !allowed.includes(k));
  if (extra.length) return { ok: false, error: `chaves não permitidas: ${extra.join(', ')}` };
  if (!decisions.includes(d.decision)) return { ok: false, error: `"decision" deve ser ${decisions.join(' | ')}` };
  let e = str(d.rationale, 'rationale', 1, 1500);
  if (e) return { ok: false, error: e };
  const out = { decision: d.decision, rationale: d.rationale.trim() };

  if (d.decision === 'continue') {
    if (!d.task || typeof d.task !== 'object' || Array.isArray(d.task)) return { ok: false, error: '"continue" exige o objeto "task"' };
    const tx = Object.keys(d.task).filter((k) => !TASK_KEYS.includes(k));
    if (tx.length) return { ok: false, error: `chaves não permitidas em "task": ${tx.join(', ')}` };
    e = str(d.task.title, 'task.title', 1, 200) || str(d.task.instructions, 'task.instructions', 1, 4000) || list(d.task.acceptance, 'task.acceptance', 1, 8, 300);
    if (e) return { ok: false, error: e };
    if (d.task.agent !== undefined && !isAgent(d.task.agent)) return { ok: false, error: `"task.agent" deve ser um perfil conhecido (${AGENT_NAMES.join(' | ')})` };
    if (d.evidence !== undefined || d.blockedReason !== undefined || d.steps !== undefined) return { ok: false, error: '"continue" não aceita "evidence", "steps" nem "blockedReason"' };
    out.task = { title: d.task.title.trim(), instructions: d.task.instructions.trim(), acceptance: d.task.acceptance.map((x) => x.trim()), ...(d.task.agent !== undefined ? { agent: d.task.agent } : {}) };
  } else if (d.decision === PLAN_DECISION) {
    if (d.task !== undefined || d.evidence !== undefined || d.blockedReason !== undefined) return { ok: false, error: '"plan" não aceita "task", "evidence" nem "blockedReason"' };
    const p = validatePlanSteps(d.steps);
    if (!p.ok) return { ok: false, error: p.error };
    out.steps = p.steps;
  } else if (d.decision === 'complete') {
    if (d.task !== undefined || d.blockedReason !== undefined || d.steps !== undefined) return { ok: false, error: '"complete" não aceita "task", "steps" nem "blockedReason"' };
    e = list(d.evidence, 'evidence', 1, 10, 500);
    if (e) return { ok: false, error: e };
    out.evidence = d.evidence.map((x) => x.trim());
  } else {
    if (d.task !== undefined || d.evidence !== undefined || d.steps !== undefined) return { ok: false, error: '"blocked" não aceita "task", "steps" nem "evidence"' };
    e = str(d.blockedReason, 'blockedReason', 1, 1000);
    if (e) return { ok: false, error: e };
    out.blockedReason = d.blockedReason.trim();
  }
  return { ok: true, value: out };
}

/** Impressão digital normalizada de uma tarefa, para detectar repetição. */
export const fingerprint = (task) => `${task.title}\n${task.instructions}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Lê o bloco JSON de relatório do Executor (summary + checks). Tolerante; nunca inventa resultado. */
export function parseExecutorReport(text) {
  const empty = { found: false, summary: '', checks: [] };
  if (typeof text !== 'string') return empty;
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (const f of fences.reverse()) {
    try {
      const o = JSON.parse(f[1]);
      const checks = (Array.isArray(o.checks) ? o.checks : []).slice(0, 20).map((c) => ({
        name: String(c?.name ?? '').slice(0, 200),
        result: ['pass', 'fail', 'not_run'].includes(c?.result) ? c.result : 'not_run',
        detail: String(c?.detail ?? '').slice(0, 300),
      })).filter((c) => c.name);
      return { found: true, summary: typeof o.summary === 'string' ? o.summary.slice(0, 1500) : '', checks };
    } catch { /* bloco inválido: ignora */ }
  }
  return empty;
}
