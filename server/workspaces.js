import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';

// Validação básica: caminho absoluto, existente, diretório, legível. Nada é executado.
export function validateDir(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Informe um caminho.' };
  const p = input.trim().replace(/^"|"$/g, '');
  if (!path.isAbsolute(p)) return { ok: false, error: 'O caminho deve ser absoluto.' };
  if (p.startsWith('\\')) return { ok: false, error: 'Caminhos de rede (UNC) não são permitidos.' };
  const resolved = path.resolve(p);
  if (path.parse(resolved).root === resolved) return { ok: false, error: 'Não é permitido registrar a raiz de um disco.' };
  let st;
  try { st = fs.statSync(resolved); } catch { return { ok: false, error: 'Diretório não existe.' }; }
  if (!st.isDirectory()) return { ok: false, error: 'O caminho não é um diretório.' };
  try { fs.accessSync(resolved, fs.constants.R_OK); } catch { return { ok: false, error: 'Sem permissão de leitura.' }; }
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
export function workspaceRemovalBlocker(db, workspaceId) {
  const missions = db.missions.filter((m) => m.workspaceId === workspaceId);
  if (missions.some((m) => m.tasks.some((t) => t.status === 'running'))) return 'Há uma execução em andamento neste workspace.';
  if (missions.some((m) => ACTIVE_CYCLE.includes(m.cycle?.status))) return 'Há um ciclo em andamento neste workspace; aguarde ou cancele o ciclo antes de remover o workspace.';
  if (missions.some((m) => m.cycle?.status === 'blocked')) return 'Há um ciclo bloqueado neste workspace; cancele o ciclo antes de remover o workspace.';
  return null;
}

/** DELETE /api/workspaces/:id (recebe `db` por injeção; a UI e as demais rotas não mudam). */
export function setupWorkspaceRemoval(app, { db }) {
  app.delete('/api/workspaces/:id', (req, res) => {
    const ws = db.workspaces.find((w) => w.id === req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace não encontrado.' });
    const why = workspaceRemovalBlocker(db, ws.id);
    if (why) return res.status(409).json({ error: why });
    db.workspaces = db.workspaces.filter((w) => w.id !== ws.id);
    if (db.settings.activeWorkspaceId === ws.id) db.settings.activeWorkspaceId = db.workspaces[0]?.id ?? null;
    store.log('workspace', `Workspace removido do cadastro: ${ws.name} (arquivos intactos)`);
    store.save();
    res.status(204).end();
  });
}
