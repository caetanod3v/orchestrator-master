// Perfis declarativos de agentes do Executor (uma tabela protegida; hoje só `code`). O orquestrador escolhe o perfil por tarefa (task.agent); os
// argumentos da CLI saem DAQUI e de mais nenhum lugar. `code` é exatamente o Executor de sempre (CLAUDE_ARGS: sem Bash, sem rede, sem pedir permissão);
// novos perfis só entram aqui, com ferramentas e permissões explícitas e testadas.
import { CLAUDE_ARGS } from './executor/index.js';

export const DEFAULT_AGENT = 'code';
export const AGENTS = Object.freeze({
  code: Object.freeze({ role: 'implementa e modifica código dentro do workspace', args: Object.freeze([...CLAUDE_ARGS]) }),
});
export const AGENT_NAMES = Object.freeze(Object.keys(AGENTS));

/** O nome é um perfil cadastrado? (Object.hasOwn: `__proto__`, `constructor` e afins nunca passam.) */
export const isAgent = (name) => typeof name === 'string' && Object.hasOwn(AGENTS, name);

/** Argumentos da CLI do perfil (cópia nova a cada chamada). Sem nome = perfil padrão. Lança Error se o perfil não existe. */
export function agentArgs(name = DEFAULT_AGENT) {
  if (!isAgent(name)) throw new Error(`Perfil de agente desconhecido: ${typeof name === 'string' ? name.slice(0, 40) : typeof name}`);
  return [...AGENTS[name].args];
}
