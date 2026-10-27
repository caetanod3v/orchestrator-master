// Planner: usa o MESMO provedor já integrado (Claude Code CLI), mas sem nenhuma ferramenta —
// ele só recebe texto e devolve texto (JSON). Não lê nem edita arquivos, não roda comandos.
import fs from 'node:fs';
import path from 'node:path';
import { createExecutor } from './executor/index.js';
import { tierSettings } from './routing.js';

export const PLANNER_ARGS = [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
  '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'user',
  '--tools', '',
];

// Modelo e esforço SÓ do Planner (o Executor não os recebe). Sem configuração, os argumentos são exatamente PLANNER_ARGS (modelo e esforço
// padrão da CLI). Valores vêm do ambiente do servidor (ORCH_PLANNER_MODEL / ORCH_PLANNER_EFFORT), nunca de requisições, e são validados:
// o modelo precisa começar por letra ou dígito (nunca vira uma opção da CLI) e o esforço é um dos níveis que a CLI aceita (`claude --help`).
export const PLANNER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$/;

/** Argumentos do `claude` do Planner. Lança Error se modelo/esforço forem inválidos. */
export function plannerArgs({ model, effort } = {}) {
  if (model !== undefined && model !== null && model !== '' && (typeof model !== 'string' || !MODEL_RE.test(model))) throw new Error(`ORCH_PLANNER_MODEL inválido: use só letras, números e . _ : - [ ] (até 64 caracteres, começando por letra ou número).`);
  if (effort !== undefined && effort !== null && effort !== '' && !PLANNER_EFFORTS.includes(effort)) throw new Error(`ORCH_PLANNER_EFFORT inválido: use um de ${PLANNER_EFFORTS.join(', ')}.`);
  const extra = [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  const at = PLANNER_ARGS.lastIndexOf('--tools'); // as opções entram ANTES de "--tools ''" (essa opção aceita lista)
  return [...PLANNER_ARGS.slice(0, at), ...extra, ...PLANNER_ARGS.slice(at)];
}

/** Lê a configuração do Planner do ambiente do servidor (vazio = padrão da CLI). */
export const plannerConfigFromEnv = (env = process.env) => ({ model: env.ORCH_PLANNER_MODEL?.trim() || undefined, effort: env.ORCH_PLANNER_EFFORT?.trim() || undefined });

/** @returns {{ id:string, busy:()=>boolean, decide:(a:{prompt:string,cwd:string})=>Promise<{text?:string,error?:string,interrupted?:boolean}>, cancel:()=>Promise<any> }} */
export function createClaudePlanner({ model, effort, routing = 'off', runner, runnerOptions = {} } = {}) { // runnerOptions: só testes (CLI falsa)
  const args = plannerArgs({ model, effort }); // valida sempre, mesmo com um runner injetado (testes)
  runner ??= createExecutor({ args, timeoutMs: 3 * 60 * 1000, ...runnerOptions });
  // Camadas (só com routing 'on'): UM runner, argumentos por chamada. Assim o lock, o cancelamento, o timeout e a recuperação de processos são os de sempre.
  // Com routing 'off', `tier` é ignorado e a chamada é idêntica à de antes.
  // Resolução ÚNICA: os argumentos entregues ao runner e a rota registrada saem do mesmo objeto (o que se registra é o que foi aplicado).
  const resolve = (tier) => {
    if (routing !== 'on') return null;
    const name = tier === undefined ? 'standard' : tier; // sem camada (undefined) = os argumentos de sempre, que são os da camada padrão; null/outros = camada inválida
    const s = tierSettings(name, { model, effort });
    return s ? { tier: name, model: s.model ?? null, effort: s.effort ?? null, args: plannerArgs(s) } : null;
  };
  const publicRoute = (r) => (r ? { tier: r.tier, model: r.model, effort: r.effort } : undefined);
  return {
    id: 'claude-planner',
    args,
    routing,
    /** Camada, modelo e esforço que SERÃO aplicados (null = padrão da CLI); null se o roteamento está desligado ou a camada não existe. */
    describeTier: (tier) => publicRoute(resolve(tier)) ?? null,
    busy: () => runner.isBusy(),
    async decide({ prompt, cwd, onUsage, tier }) {
      let callArgs; // undefined = argumentos do runner (comportamento de sempre)
      const applied = resolve(tier);
      if (routing === 'on' && tier !== undefined) { if (!applied) return { error: `Camada do Planner desconhecida: ${String(tier).slice(0, 40)}` }; callArgs = applied.args; }
      const route = publicRoute(applied); // aditivo: só com o roteamento ligado
      let handle;
      try { handle = runner.start({ missionId: 'planner', taskId: 'planner', cwd, prompt, onLine: () => {}, onUsage, ...(callArgs ? { args: callArgs } : {}) }); } catch (e) { return { error: e.message, ...(route ? { route } : {}) }; }
      const r = await handle.done;
      // `metrics` (aditivo): tokens/modelos/limite reportados pela CLI (ver executor/stream.js); também nas falhas, que consomem tokens.
      if (r.status === 'completed' && r.result?.text) return { text: r.result.text, usage: { costUsd: r.result.costUsd, turns: r.result.turns, metrics: r.usage }, ...(route ? { route } : {}) };
      return { error: r.error || `Planner terminou com status ${r.status}`, interrupted: r.status === 'interrupted', usage: { metrics: r.usage }, ...(route ? { route } : {}) };
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
