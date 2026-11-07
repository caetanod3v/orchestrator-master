// Equipe do workspace (presets). PURO: só nomes, composição e contas sobre as sessões reais; nada aqui abre ou fecha terminal.
// Os ids (duo, squad, full) vêm de antes e são os que ficam gravados; só o RÓTULO mudou (o squad de quatro agora se chama "Squad"). `builder` é o preset de um único Construtor.
export const PRESETS = Object.freeze([
  Object.freeze({ id: 'duo', label: 'Dupla', roles: Object.freeze(['builder', 'reviewer']) }),
  Object.freeze({ id: 'squad', label: 'Squad', roles: Object.freeze(['maestro', 'builder', 'builder', 'reviewer']) }),
  Object.freeze({ id: 'full', label: 'Squad de 6', roles: Object.freeze(['maestro', 'scout', 'builder', 'builder', 'builder', 'reviewer']) }),
  Object.freeze({ id: 'builder', label: 'Construtor', roles: Object.freeze(['builder']) }),
]);
export const PRESET_IDS = Object.freeze(PRESETS.map((p) => p.id));
export const isPresetId = (id) => typeof id === 'string' && PRESET_IDS.includes(id);
export const presetById = (id) => PRESETS.find((p) => p.id === id) ?? null;

/** Papéis que faltam para completar o preset, dado o que já está rodando (multiconjunto: 2 Construtores pedidos, 1 rodando = falta 1). Nunca sugere fechar nada. */
export function missingRoles(presetRoles, liveRoles) {
  const have = new Map();
  for (const r of liveRoles ?? []) have.set(r, (have.get(r) ?? 0) + 1);
  const out = [];
  for (const r of presetRoles ?? []) { const n = have.get(r) ?? 0; if (n > 0) have.set(r, n - 1); else out.push(r); }
  return out;
}

/** Papéis em excesso em relação ao preset (informativo: nunca são encerrados sozinhos). */
export function extraRoles(presetRoles, liveRoles) { return missingRoles(liveRoles, presetRoles); }

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Texto de impacto de trocar de preset, ANTES de executar. `live` = terminais ativos do workspace; `labelOf(role)` = rótulo do papel; `room` = vagas livres.
 * Trocar o preset nunca encerra processo: só abre o que falta (dentro do limite).
 */
export function changeImpact({ from, to, liveRoles = [], labelOf = (r) => r, room = Infinity }) {
  const target = presetById(to); if (!target) return null;
  const miss = missingRoles(target.roles, liveRoles), open = miss.slice(0, Math.max(0, room)), skipped = miss.length - open.length;
  const names = (list) => list.map(labelOf).join(', ');
  const lines = [from ? `Alterar a equipe de "${presetById(from)?.label ?? from}" para "${target.label}"?` : `Definir a equipe deste workspace como "${target.label}"?`];
  if (liveRoles.length) lines.push(`Os ${plural(liveRoles.length, 'terminal ativo continua', 'terminais ativos continuam')} rodando: nenhum processo, sessão ou worktree é encerrado.`);
  lines.push(open.length ? `Serão abertos ${plural(open.length, 'terminal novo', 'terminais novos')} para completar: ${names(open)}.` : 'Nenhum terminal novo é necessário.');
  if (skipped > 0) lines.push(`${plural(skipped, 'terminal não cabe', 'terminais não cabem')} no limite e ficará de fora.`);
  return { text: lines.join('\n\n'), open, skipped, needsConfirm: liveRoles.length > 0 };
}

/**
 * Equipe de um workspace sem preset gravado, a partir dos papéis dos terminais que ele já tem: se bate EXATAMENTE com um preset, é esse; senão devolve null (equipe "personalizada").
 * É só leitura: nada é gravado nem aberto. Serve para a barra não oferecer a configuração inicial a quem já tem terminais.
 */
export function inferTeam(roles = []) {
  const key = (a) => [...a].sort().join(',');
  const k = key(Array.isArray(roles) ? roles : []);
  return PRESETS.find((p) => key(p.roles) === k)?.id ?? null;
}
