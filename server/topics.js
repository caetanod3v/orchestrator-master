// Abas de workspaces abertos (settings.openWorkspaceIds), tópicos por workspace (db.topics) e o tópico ativo de cada um (settings.activeTopicIds).
// Tudo é organização visual: fechar uma aba ou arquivar um tópico NUNCA encerra terminais (este módulo nem conhece o gerenciador de terminais).
import * as store from './store.js';
import { uid, now } from './store.js';

export const MAX_TOPICS_PER_WORKSPACE = 50;
export const MAX_TOTAL_TOPICS_PER_WORKSPACE = 200; // vivos + arquivados; ao criar, os arquivados mais antigos saem para caber
export const MAX_TITLE = 80;
const TOPIC_ID = /^top_[0-9a-f]{8}$/;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/** Título limpo (sem controles, espaços colapsados) ou { error }. */
export function cleanTitle(raw) {
  if (typeof raw !== 'string') return { error: 'Informe o título do tópico.' };
  const t = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { error: 'Informe o título do tópico.' };
  if (t.length > MAX_TITLE) return { error: `O título pode ter no máximo ${MAX_TITLE} caracteres.` };
  return { title: t };
}

/**
 * Idempotente. Banco antigo (sem os campos) passa a ter listas vazias e o ativo entra na lista de abertos; entradas que apontam para workspace ou tópico
 * inexistente (ou arquivado, no caso do tópico ativo) são descartadas. Invariante: o workspace ativo está sempre em openWorkspaceIds ou é null.
 */
export function ensureTabs(db) {
  const s = db.settings;
  if (!Array.isArray(db.topics)) db.topics = [];
  db.topics = db.topics.filter((t) => isObj(t) && typeof t.id === 'string' && TOPIC_ID.test(t.id) && typeof t.workspaceId === 'string' && typeof t.title === 'string');
  const wsIds = new Set(db.workspaces.map((w) => w.id));
  const open = [];
  for (const id of Array.isArray(s.openWorkspaceIds) ? s.openWorkspaceIds : []) if (typeof id === 'string' && wsIds.has(id) && !open.includes(id)) open.push(id);
  if (typeof s.activeWorkspaceId === 'string' && wsIds.has(s.activeWorkspaceId)) { if (!open.includes(s.activeWorkspaceId)) open.push(s.activeWorkspaceId); } else s.activeWorkspaceId = open[0] ?? null;
  s.openWorkspaceIds = open;
  const active = {};
  if (isObj(s.activeTopicIds)) for (const [wsId, topicId] of Object.entries(s.activeTopicIds)) {
    const t = db.topics.find((x) => x.id === topicId);
    if (t && t.workspaceId === wsId && !t.archivedAt && wsIds.has(wsId)) active[wsId] = topicId;
  }
  s.activeTopicIds = active;
}

/** Fatia exposta em /api/state: abas abertas, tópicos não arquivados e tópico ativo por workspace. */
export function topicsState(db) {
  ensureTabs(db);
  return { openWorkspaceIds: [...db.settings.openWorkspaceIds], topics: db.topics.filter((t) => !t.archivedAt), activeTopicIds: { ...db.settings.activeTopicIds } };
}

/** Marca o workspace como aberto e ativo (usado por cadastrar/ativar). Não grava. */
export function openAndActivate(db, workspaceId) {
  ensureTabs(db);
  if (!db.settings.openWorkspaceIds.includes(workspaceId)) db.settings.openWorkspaceIds.push(workspaceId);
  db.settings.activeWorkspaceId = workspaceId;
}

/** Remoção de workspace: tira das abas, arquiva os tópicos e esquece o tópico ativo. Não grava. */
export function dropWorkspaceTabs(db, workspaceId) {
  ensureTabs(db);
  const s = db.settings, at = now();
  s.openWorkspaceIds = s.openWorkspaceIds.filter((id) => id !== workspaceId);
  for (const t of db.topics) if (t.workspaceId === workspaceId && !t.archivedAt) t.archivedAt = at;
  delete s.activeTopicIds[workspaceId];
  if (s.activeWorkspaceId === workspaceId) s.activeWorkspaceId = s.openWorkspaceIds[0] ?? null;
}

const SNAP_KEYS = ['activeWorkspaceId', 'openWorkspaceIds', 'activeTopicIds'];
/** Captura o que as rotas daqui alteram (para desfazer se a gravação falhar). */
export function snapshotTabs(db) {
  return { settings: SNAP_KEYS.map((k) => [k, Object.hasOwn(db.settings, k) ? { v: structuredClone(db.settings[k]) } : null]), topics: structuredClone(db.topics ?? []) };
}
export function restoreTabs(db, snap) {
  for (const [k, p] of snap.settings) { if (p) db.settings[k] = p.v; else delete db.settings[k]; }
  db.topics = snap.topics;
}

/**
 * Aplica `mutate` e grava com confirmação; se o disco falhar, volta EXATAMENTE ao estado anterior e responde 500. Devolve true se gravou.
 * Qualquer OUTRA exceção também desfaz o estado, mas propaga (erro interno genérico): não é falha de gravação e não leva essa mensagem.
 */
export function commitOrRollback(db, res, mutate, failMsg) {
  const snap = snapshotTabs(db);
  let persisting = false;
  try { mutate(); persisting = true; store.saveOrThrow(); return true; } catch (e) {
    restoreTabs(db, snap);
    if (!persisting || !e?.persistence) throw e;
    bad(res, `${failMsg} O banco não pôde ser gravado; nada foi alterado.`, 500);
    return false;
  }
}

/** POST /api/workspaces/:id/open|close (abas). Fechar a aba NUNCA encerra terminais. */
export function setupWorkspaceTabs(app, { db }) {
  ensureTabs(db);
  const view = (ws) => ({ workspace: ws, openWorkspaceIds: [...db.settings.openWorkspaceIds], activeWorkspaceId: db.settings.activeWorkspaceId });

  app.post('/api/workspaces/:id/open', (req, res) => {
    ensureTabs(db);
    const ws = db.workspaces.find((w) => w.id === req.params.id);
    if (!ws) return bad(res, 'Workspace não encontrado.', 404);
    const was = db.settings.openWorkspaceIds.includes(ws.id);
    if (!commitOrRollback(db, res, () => {
      if (!was) db.settings.openWorkspaceIds.push(ws.id);
      if (!db.settings.activeWorkspaceId) db.settings.activeWorkspaceId = ws.id; // sem ativo, o recém-aberto assume
    }, 'Não foi possível abrir o workspace.')) return;
    if (!was) { store.log('workspace', `Workspace aberto: ${ws.name}`, { workspaceId: ws.id }); store.saveSoon(); }
    res.json(view(ws));
  });

  app.post('/api/workspaces/:id/close', (req, res) => {
    ensureTabs(db);
    const ws = db.workspaces.find((w) => w.id === req.params.id);
    if (!ws) return bad(res, 'Workspace não encontrado.', 404);
    const open = db.settings.openWorkspaceIds, i = open.indexOf(ws.id);
    if (i < 0) return res.json(view(ws)); // já fechado: idempotente
    if (!commitOrRollback(db, res, () => {
      db.settings.openWorkspaceIds = open.filter((id) => id !== ws.id);
      if (db.settings.activeWorkspaceId === ws.id) { const rest = db.settings.openWorkspaceIds; db.settings.activeWorkspaceId = rest[i] ?? rest[i - 1] ?? rest[0] ?? null; } // vizinho da aba fechada
    }, 'Não foi possível fechar o workspace.')) return;
    store.log('workspace', `Workspace fechado (terminais mantidos): ${ws.name}`, { workspaceId: ws.id }); store.saveSoon();
    res.json(view(ws));
  });
}

/** POST /api/topics, /api/topics/:id/rename|archive|activate. */
export function setupTopics(app, { db }) {
  ensureTabs(db);
  const findTopic = (id) => db.topics.find((t) => t.id === id);
  const live = (wsId) => db.topics.filter((t) => t.workspaceId === wsId && !t.archivedAt);

  app.post('/api/topics', (req, res) => {
    ensureTabs(db);
    const ws = typeof req.body?.workspaceId === 'string' ? db.workspaces.find((w) => w.id === req.body.workspaceId) : null;
    if (!ws) return bad(res, 'Workspace não encontrado.', 404);
    const c = cleanTitle(req.body?.title);
    if (c.error) return bad(res, c.error);
    if (live(ws.id).length >= MAX_TOPICS_PER_WORKSPACE) return bad(res, `Limite de ${MAX_TOPICS_PER_WORKSPACE} tópicos por workspace; arquive algum antes de criar outro.`, 409);
    const topic = { id: uid('top'), workspaceId: ws.id, title: c.title, createdAt: now() };
    if (!commitOrRollback(db, res, () => {
      const overflow = db.topics.filter((t) => t.workspaceId === ws.id).length + 1 - MAX_TOTAL_TOPICS_PER_WORKSPACE;
      if (overflow > 0) { // descarta os arquivados mais antigos (por archivedAt) até caber
        const drop = new Set(db.topics.filter((t) => t.workspaceId === ws.id && t.archivedAt).sort((a, b) => String(a.archivedAt).localeCompare(String(b.archivedAt))).slice(0, overflow).map((t) => t.id));
        db.topics = db.topics.filter((t) => !drop.has(t.id));
      }
      db.topics.push(topic);
    }, 'Não foi possível criar o tópico.')) return;
    store.log('topic', `Tópico criado: ${topic.title}`, { workspaceId: ws.id, topicId: topic.id }); store.saveSoon();
    res.status(201).json(topic);
  });

  app.post('/api/topics/:id/rename', (req, res) => {
    ensureTabs(db);
    const t = findTopic(req.params.id);
    if (!t) return bad(res, 'Tópico não encontrado.', 404);
    if (t.archivedAt) return bad(res, 'O tópico está arquivado.', 409);
    const c = cleanTitle(req.body?.title);
    if (c.error) return bad(res, c.error);
    if (!commitOrRollback(db, res, () => { t.title = c.title; }, 'Não foi possível renomear o tópico.')) return;
    store.log('topic', `Tópico renomeado: ${t.title}`, { workspaceId: t.workspaceId, topicId: t.id }); store.saveSoon();
    res.json(t);
  });

  app.post('/api/topics/:id/archive', (req, res) => {
    ensureTabs(db);
    const t = findTopic(req.params.id);
    if (!t) return bad(res, 'Tópico não encontrado.', 404);
    if (t.archivedAt) return res.json(t); // idempotente
    if (!commitOrRollback(db, res, () => {
      t.archivedAt = now();
      if (db.settings.activeTopicIds[t.workspaceId] === t.id) delete db.settings.activeTopicIds[t.workspaceId];
    }, 'Não foi possível arquivar o tópico.')) return;
    store.log('topic', `Tópico arquivado: ${t.title}`, { workspaceId: t.workspaceId, topicId: t.id }); store.saveSoon();
    res.json(t);
  });

  // "Geral" = nenhum tópico ativo no workspace (topicId null): remove a entrada. Idempotente.
  app.post('/api/workspaces/:id/topic/general', (req, res) => {
    ensureTabs(db);
    const ws = db.workspaces.find((w) => w.id === req.params.id);
    if (!ws) return bad(res, 'Workspace não encontrado.', 404);
    if (Object.hasOwn(db.settings.activeTopicIds, ws.id) && !commitOrRollback(db, res, () => { delete db.settings.activeTopicIds[ws.id]; }, 'Não foi possível ativar o tópico Geral.')) return;
    store.log('topic', `Tópico ativo: Geral (${ws.name})`, { workspaceId: ws.id }); store.saveSoon();
    res.json({ workspaceId: ws.id, activeTopicIds: { ...db.settings.activeTopicIds } });
  });

  app.post('/api/topics/:id/activate', (req, res) => {
    ensureTabs(db);
    const t = findTopic(req.params.id);
    if (!t) return bad(res, 'Tópico não encontrado.', 404);
    if (t.archivedAt) return bad(res, 'O tópico está arquivado.', 409);
    if (!commitOrRollback(db, res, () => { db.settings.activeTopicIds[t.workspaceId] = t.id; }, 'Não foi possível ativar o tópico.')) return;
    store.log('topic', `Tópico ativo: ${t.title}`, { workspaceId: t.workspaceId, topicId: t.id }); store.saveSoon();
    res.json({ topic: t, activeTopicIds: { ...db.settings.activeTopicIds } });
  });
}
