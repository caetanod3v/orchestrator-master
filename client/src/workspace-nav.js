// Navegação por workspaces abertos (abas) e tópicos. PURA (sem React, sem rede): só reorganiza dados REAIS do servidor
// (/api/state: openWorkspaceIds, topics, activeTopicIds; sessões de /api/terminals; tarefas do maestro). Nada é inventado.
import { friendlyNames, failedExit } from './env-view.js';

export const MAX_TOPIC_TITLE = 60;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Tópico de uma sessão: `null` = Geral. */
export const topicIdOf = (s) => (typeof s?.topicId === 'string' && s.topicId ? s.topicId : null);

/** Contagens reais de um conjunto de sessões. `pending` = tarefas do maestro aguardando você, cujo pane de destino está no conjunto. */
export function tally(list = [], workingIds = new Set(), tasks = []) {
  const ids = new Set(list.map((s) => s.id));
  const running = list.filter((s) => s.status === 'running');
  const failed = list.filter(failedExit).length;
  const pending = tasks.filter((t) => t && t.status === 'pending' && ids.has(t.to)).length;
  return { total: list.length, running: running.length, working: running.filter((s) => workingIds.has(s.id)).length, exited: list.length - running.length, failed, pending, attention: failed > 0 || pending > 0 };
}

/** Tom do indicador: vermelho = falha de verdade; âmbar = espera por você; laranja = trabalhando; verde = rodando; senão neutro. */
export const toneOf = (c) => (c.failed ? 'err' : c.pending ? 'warn' : c.working ? 'work' : c.running ? 'live' : 'none');

/** Texto curto (tooltip/leitor de tela) do que há em um conjunto. */
export function describeTally(c) {
  const parts = [];
  if (c.running) parts.push(plural(c.running, 'agente rodando', 'agentes rodando') + (c.working ? ` (${c.working} trabalhando)` : ''));
  if (c.pending) parts.push(plural(c.pending, 'tarefa aguardando você', 'tarefas aguardando você'));
  if (c.failed) parts.push(plural(c.failed, 'terminou com falha', 'terminaram com falha'));
  return parts.join(', ') || 'sem terminais ativos';
}

/**
 * Abas dos workspaces abertos, na ordem do servidor. O ativo sempre aparece (mesmo que a lista ainda não o traga); ids desconhecidos são ignorados.
 * @returns {{id:string,name:string,path:string,active:boolean}[] & tally}
 */
export function openTabs({ workspaces = [], openWorkspaceIds, activeId = null, sessions = [], workingIds = new Set(), maestroTasks = [] } = {}) {
  const names = friendlyNames(workspaces), byId = new Map(workspaces.map((w) => [w.id, w]));
  const ids = Array.isArray(openWorkspaceIds) ? [...new Set(openWorkspaceIds)] : [];
  if (activeId && !ids.includes(activeId)) ids.push(activeId);
  return ids.filter((id) => byId.has(id)).map((id) => {
    const c = tally(sessions.filter((s) => s.workspaceId === id), workingIds, maestroTasks);
    return { id, name: names.get(id), path: byId.get(id).path, active: id === activeId, ...c, tone: toneOf(c) };
  });
}

/**
 * Último término por workspace: maior instante entre tarefas do maestro concluídas (doneAt, pelo workspace do pane de destino) e terminais encerrados (endedAt).
 * Só dados reais do servidor. @returns {Map<string,string>} workspaceId -> ISO
 */
export function finishedStamps({ sessions = [], maestroTasks = [] } = {}) {
  const wsOf = new Map(sessions.map((s) => [s.id, s.workspaceId]));
  const out = new Map();
  const bump = (ws, at) => { if (ws && typeof at === 'string' && at && (!out.has(ws) || at > out.get(ws))) out.set(ws, at); };
  for (const t of maestroTasks) if (t && t.status === 'done') bump(wsOf.get(t.to), t.doneAt);
  for (const s of sessions) if (s && s.status !== 'running') bump(s.workspaceId, s.endedAt);
  return out;
}

/** Workspaces (que não são o ativo) com término posterior ao último visto. `seen`: workspaceId -> ISO; ausente = `baseline`. */
export function unseenFinished({ stamps, seen = {}, baseline = '', activeId = null } = {}) {
  const out = new Set();
  for (const [ws, at] of stamps ?? []) if (ws !== activeId && at > (seen[ws] ?? baseline)) out.add(ws);
  return out;
}

/** Fechar a aba nunca encerra terminais: se há agentes rodando, o usuário confirma antes (eles continuam em execução). */
export function closePlan(tab) {
  if (!tab || !tab.running) return { confirm: false, message: '' };
  const n = tab.running;
  return { confirm: true, message: `Fechar a aba "${tab.name}"?\n\n${n} ${n === 1 ? 'agente continua' : 'agentes continuam'} em execução em segundo plano. Os terminais não são encerrados e voltam quando você reabrir o workspace.` };
}

/** Quem fica ativo ao fechar a aba ativa: o vizinho da direita, senão o da esquerda; `null` se era a única. */
export function neighborAfterClose(tabs, id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return null;
  return (tabs[i + 1] ?? tabs[i - 1])?.id ?? null;
}

/** Teclado do tablist (padrão WAI-ARIA): setas circulares, Home e End. Devolve o id da aba que recebe o foco, ou `null` se a tecla não navega. */
export function tabKeyTarget(ids, current, key) {
  if (!ids.length) return null;
  const i = Math.max(0, ids.indexOf(current));
  if (key === 'ArrowRight') return ids[(i + 1) % ids.length];
  if (key === 'ArrowLeft') return ids[(i - 1 + ids.length) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids.at(-1);
  return null;
}

/** Tópicos (não arquivados) de um workspace, na ordem recebida. */
export const topicsOf = (topics = [], workspaceId) => (Array.isArray(topics) ? topics : []).filter((t) => t && t.workspaceId === workspaceId && !t.archived);

/** Tópico ativo do workspace; `null` (Geral) se o id guardado não existe mais. */
export function activeTopicId(activeTopicIds, workspaceId, topics = []) {
  const v = activeTopicIds?.[workspaceId];
  return typeof v === 'string' && topicsOf(topics, workspaceId).some((t) => t.id === v) ? v : null;
}

/** Sessões de um workspace + tópico. Sessão cujo tópico não existe mais (arquivado) cai em Geral: nunca fica invisível. */
export function visibleSessions(sessions = [], workspaceId, topicId, topics = []) {
  const known = new Set(topicsOf(topics, workspaceId).map((t) => t.id));
  return sessions.filter((s) => s.workspaceId === workspaceId && (known.has(topicIdOf(s)) ? topicIdOf(s) : null) === (topicId ?? null));
}

/**
 * Linhas da sidebar: "Geral" + tópicos do workspace, cada um com indicadores reais das próprias sessões.
 * @returns {{key:string,id:string|null,title:string,general:boolean,active:boolean,tone:string}[] & tally}
 */
export function topicRows({ topics = [], workspaceId, activeTopicIds, sessions = [], workingIds = new Set(), maestroTasks = [] } = {}) {
  if (!workspaceId) return [];
  const mine = topicsOf(topics, workspaceId), active = activeTopicId(activeTopicIds, workspaceId, topics);
  return [{ id: null, title: 'Geral' }, ...mine.map((t) => ({ id: t.id, title: t.title }))].map((t) => {
    const c = tally(visibleSessions(sessions, workspaceId, t.id, topics), workingIds, maestroTasks);
    return { key: t.id ?? 'general', id: t.id, title: t.title, general: t.id === null, active: t.id === active, ...c, tone: toneOf(c) };
  });
}

/** Totais reais de todas as sessões: rodando, tarefas aguardando você e terminais que falharam. */
export function totals({ sessions = [], maestroTasks = [] } = {}) {
  const c = tally(sessions, new Set(), maestroTasks);
  return { running: c.running, waiting: c.pending, failed: c.failed };
}

/** Título de tópico: espaços colapsados, até MAX_TOPIC_TITLE; `''` se vazio. */
export const cleanTitle = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TOPIC_TITLE);

/** "workspace › tópico" (Geral quando não há tópico). */
export const breadcrumb = (wsName, topicTitle) => [wsName, topicTitle || 'Geral'].filter(Boolean).join(' › ');

