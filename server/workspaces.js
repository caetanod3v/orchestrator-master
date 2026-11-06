import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './store.js';
import { dropWorkspaceTabs, snapshotTabs, restoreTabs } from './topics.js';

const UNC_ERROR = 'Caminhos de rede (UNC) não são permitidos.';
const DEVICE_ERROR = 'Caminhos de dispositivo (\\\\?\\ ou \\\\.\\) não são permitidos.';

/** Caminho de rede/dispositivo, na forma digitada ou já resolvida (`//h/s` vira `\\h\s` no Windows). Decide só pelo texto: nunca toca o disco nem a rede. */
function networkProblem(text) {
  if (/^[\\/]{2}[?.][\\/]/.test(text)) return /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(text) ? UNC_ERROR : DEVICE_ERROR;
  if (/^[\\/]{2}/.test(text) || text.startsWith('\\')) return UNC_ERROR;
  return null;
}

/** Pastas que guardam dados pessoais ou de aplicativos: um workspace igual a elas, ou ancestral delas, daria ao agente acesso a tudo isso. */
function sensitiveRoots({ home, env }) {
  const list = [];
  if (home) list.push(['a pasta do usuário', home], ['a pasta Library do usuário', path.join(home, 'Library')], ['a pasta .config do usuário', path.join(home, '.config')]);
  if (env?.APPDATA) list.push(['a pasta APPDATA', env.APPDATA]);
  if (env?.LOCALAPPDATA) list.push(['a pasta LOCALAPPDATA', env.LOCALAPPDATA]);
  return list;
}
const realOrResolved = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/** Motivo (em português) se `dir` é igual ou ancestral de uma pasta sensível; senão null. Compara por realpath (links e caixa normalizados); o Windows já ignora caixa em path.relative. */
function broadProblem(dir, { home, env }) {
  const ws = realOrResolved(dir);
  for (const [label, p] of sensitiveRoots({ home, env })) {
    const rel = path.relative(ws, realOrResolved(p));
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) return `Este diretório é amplo demais: ele é ${label} ou contém ${label}. Escolha a pasta de um projeto.`;
  }
  return null;
}

// Validação básica: caminho absoluto, existente, diretório, legível. Nada é executado.
// `opts.home`/`opts.env` existem só para testes; sem eles valem os do sistema.
export function validateDir(input, opts = {}) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Informe um caminho.' };
  const p = input.trim().replace(/^"|"$/g, '');
  if (!path.isAbsolute(p)) return { ok: false, error: 'O caminho deve ser absoluto.' };
  // Antes de qualquer fs.*: statSync em \\host\share abriria uma conexão de rede.
  const raw = networkProblem(p); if (raw) return { ok: false, error: raw };
  const resolved = path.resolve(p);
  const res = networkProblem(resolved); if (res) return { ok: false, error: res };
  if (path.parse(resolved).root === resolved) return { ok: false, error: 'Não é permitido registrar a raiz de um disco.' };
  let st;
  try { st = fs.statSync(resolved); } catch { return { ok: false, error: 'Diretório não existe.' }; }
  if (!st.isDirectory()) return { ok: false, error: 'O caminho não é um diretório.' };
  try { fs.accessSync(resolved, fs.constants.R_OK); } catch { return { ok: false, error: 'Sem permissão de leitura.' }; }
  const broad = broadProblem(resolved, { home: opts?.home ?? os.homedir(), env: opts?.env ?? process.env });
  if (broad) return { ok: false, error: broad };
  return {
    ok: true,
    path: resolved,
    hasGit: fs.existsSync(path.join(resolved, '.git')),
    hasPackageJson: fs.existsSync(path.join(resolved, 'package.json')),
  };
}

const ACTIVE_CYCLE = ['planning', 'running'];

/**
 * Motivo pelo qual o workspace NÃO pode ser removido do cadastro agora, ou null. Uma missão com execução, ciclo ativo ou ciclo
 * bloqueado (retomável) ainda depende do workspace; ciclos completed/cancelled/limit_reached não bloqueiam.
 */
export function workspaceRemovalBlocker(db, workspaceId, terminals = null) {
  // Terminal vivo do workspace ficaria órfão (invisível na grade, ocupando vaga e sem como retomar): feche-os antes.
  let live = 0; try { live = (terminals?.list?.() ?? []).filter((t) => t.workspaceId === workspaceId && t.status === 'running').length; } catch { live = 0; }
  if (live) return `Há ${live} terminal(is) aberto(s) neste workspace; feche-os antes de remover o workspace.`;
  const missions = db.missions.filter((m) => m.workspaceId === workspaceId);
  if (missions.some((m) => m.tasks.some((t) => t.status === 'running'))) return 'Há uma execução em andamento neste workspace.';
  if (missions.some((m) => ACTIVE_CYCLE.includes(m.cycle?.status))) return 'Há um ciclo em andamento neste workspace; aguarde ou cancele o ciclo antes de remover o workspace.';
  if (missions.some((m) => m.cycle?.status === 'blocked')) return 'Há um ciclo bloqueado neste workspace; cancele o ciclo antes de remover o workspace.';
  if ((db.worktrees || []).some((w) => w.workspaceId === workspaceId && w.state !== 'removed' && w.state !== 'failed')) return 'Há worktrees isolados deste workspace que ainda não foram removidos; integre ou limpe-os antes de remover o workspace.';
  return null;
}

/** DELETE /api/workspaces/:id (recebe `db` por injeção; a UI e as demais rotas não mudam). */
export function setupWorkspaceRemoval(app, { db, terminals = null, onRemoved = null }) {
  app.delete('/api/workspaces/:id', (req, res) => {
    const ws = db.workspaces.find((w) => w.id === req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace não encontrado.' });
    const why = workspaceRemovalBlocker(db, ws.id, terminals);
    if (why) return res.status(409).json({ error: why });
    const prevWorkspaces = db.workspaces, snap = snapshotTabs(db);
    try {
      db.workspaces = db.workspaces.filter((w) => w.id !== ws.id);
      dropWorkspaceTabs(db, ws.id); // tira das abas abertas e arquiva os tópicos (terminais não são tocados)
      if (db.settings.activeWorkspaceId === null && db.settings.openWorkspaceIds.length === 0) db.settings.activeWorkspaceId = db.workspaces[0]?.id ?? null; // sem aba aberta, mantém o comportamento de antes (outro cadastrado vira ativo)
      if (db.settings.activeWorkspaceId && !db.settings.openWorkspaceIds.includes(db.settings.activeWorkspaceId)) db.settings.openWorkspaceIds.push(db.settings.activeWorkspaceId);
      store.saveOrThrow();
    } catch {
      db.workspaces = prevWorkspaces; restoreTabs(db, snap);
      return res.status(500).json({ error: 'Não foi possível remover o workspace: o banco não pôde ser gravado; nada foi alterado.' });
    }
    try { onRemoved?.(ws.id); } catch { /* informativo: limpeza do histórico de conversas */ }
    store.log('workspace', `Workspace removido do cadastro: ${ws.name} (arquivos intactos)`);
    store.save();
    res.status(204).end();
  });
}

/** POST /api/workspaces/:id/rename { displayName }: nome amigável, só um rótulo visual. `name` (original), `path` e `id` nunca mudam; texto vazio (ou igual ao original) restaura o nome original. Falha ao gravar desfaz. */
export function setupWorkspaceRename(app, { db }) {
  app.post('/api/workspaces/:id/rename', (req, res) => {
    const ws = db.workspaces.find((w) => w.id === req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace não encontrado.' });
    const raw = req.body?.displayName;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return res.status(400).json({ error: 'Nome inválido.' });
    const clean = String(raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length > 80) return res.status(400).json({ error: 'O nome pode ter no máximo 80 caracteres.' });
    const before = ws.displayName;
    if (clean && clean !== ws.name) ws.displayName = clean; else delete ws.displayName;
    try { store.saveOrThrow(); } catch {
      if (before === undefined) delete ws.displayName; else ws.displayName = before;
      return res.status(500).json({ error: 'Não foi possível gravar o nome; nada foi alterado.' });
    }
    store.log('workspace', ws.displayName ? `Workspace renomeado (rótulo): ${ws.displayName}` : `Nome do workspace restaurado: ${ws.name}`, { workspaceId: ws.id });
    store.save();
    res.json(ws);
  });
}
