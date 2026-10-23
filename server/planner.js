// Planner: usa o MESMO provedor já integrado (Claude Code CLI), mas sem nenhuma ferramenta —
// ele só recebe texto e devolve texto (JSON). Não lê nem edita arquivos, não roda comandos.
import fs from 'node:fs';
import path from 'node:path';
import { createExecutor } from './executor/index.js';

export const PLANNER_ARGS = [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
  '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'user',
  '--tools', '',
];

/** @returns {{ id:string, busy:()=>boolean, decide:(a:{prompt:string,cwd:string})=>Promise<{text?:string,error?:string,interrupted?:boolean}>, cancel:()=>Promise<any> }} */
export function createClaudePlanner({ runner = createExecutor({ args: PLANNER_ARGS, timeoutMs: 3 * 60 * 1000 }) } = {}) {
  return {
    id: 'claude-planner',
    busy: () => runner.isBusy(),
    async decide({ prompt, cwd }) {
      let handle;
      try { handle = runner.start({ missionId: 'planner', taskId: 'planner', cwd, prompt, onLine: () => {} }); } catch (e) { return { error: e.message }; }
      const r = await handle.done;
      if (r.status === 'completed' && r.result?.text) return { text: r.result.text, usage: { costUsd: r.result.costUsd, turns: r.result.turns } };
      return { error: r.error || `Planner terminou com status ${r.status}`, interrupted: r.status === 'interrupted' };
    },
    cancel: () => runner.stop(),
  };
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__', '.idea', '.vscode']);

/** Lista (somente nomes) o conteúdo do workspace até 2 níveis, para dar contexto ao Planner. Nunca lê arquivos. */
export function listWorkspace(root, { maxEntries = 120 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxEntries) return;
      if (SKIP.has(it.name) || it.isSymbolicLink()) continue;
      const rel = path.relative(root, path.join(dir, it.name)).replace(/\\/g, '/');
      out.push(it.isDirectory() ? `${rel}/` : rel);
      if (it.isDirectory() && depth < 2) walk(path.join(dir, it.name), depth + 1);
    }
  };
  walk(root, 1);
  return out;
}
