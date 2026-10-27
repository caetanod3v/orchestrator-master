// Validação ESTRITA de tudo que o Planner devolve e de tudo que o Executor reporta.
// O Planner só pode escolher entre `continue`, `complete` e `blocked`; qualquer chave desconhecida
// (permissions, command, cwd, authorized, allowTools…) invalida a resposta inteira.

import { isAgent, AGENT_NAMES } from './agents.js';

export const DECISIONS = ['continue', 'complete', 'blocked'];
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

const str = (v, name, min, max) => {
  if (typeof v !== 'string') return `"${name}" deve ser texto`;
  const s = v.trim();
  if (s.length < min) return `"${name}" não pode ser vazio`;
  if (s.length > max) return `"${name}" excede ${max} caracteres`;
  if (CTRL.test(s)) return `"${name}" contém caracteres de controle`;
  return null;
};
const list = (v, name, minN, maxN, maxLen) => {
  if (!Array.isArray(v)) return `"${name}" deve ser uma lista`;
  if (v.length < minN || v.length > maxN) return `"${name}" deve ter de ${minN} a ${maxN} itens`;
  for (const x of v) { const e = str(x, `${name}[]`, 1, maxLen); if (e) return e; }
  return null;
};

/** @returns {{ok:true, value:object} | {ok:false, error:string}} */
export function validateDecision(raw) {
  const j = extractJson(raw);
  if (!j.ok) return j;
  const d = j.value;
  const extra = Object.keys(d).filter((k) => !TOP_KEYS.includes(k));
  if (extra.length) return { ok: false, error: `chaves não permitidas: ${extra.join(', ')}` };
  if (!DECISIONS.includes(d.decision)) return { ok: false, error: `"decision" deve ser ${DECISIONS.join(' | ')}` };
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
    if (d.evidence !== undefined || d.blockedReason !== undefined) return { ok: false, error: '"continue" não aceita "evidence" nem "blockedReason"' };
    out.task = { title: d.task.title.trim(), instructions: d.task.instructions.trim(), acceptance: d.task.acceptance.map((x) => x.trim()), ...(d.task.agent !== undefined ? { agent: d.task.agent } : {}) };
  } else if (d.decision === 'complete') {
    if (d.task !== undefined || d.blockedReason !== undefined) return { ok: false, error: '"complete" não aceita "task" nem "blockedReason"' };
    e = list(d.evidence, 'evidence', 1, 10, 500);
    if (e) return { ok: false, error: e };
    out.evidence = d.evidence.map((x) => x.trim());
  } else {
    if (d.task !== undefined || d.evidence !== undefined) return { ok: false, error: '"blocked" não aceita "task" nem "evidence"' };
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
