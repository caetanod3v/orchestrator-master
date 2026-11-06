// Registro de provedores de agentes (CLIs). Hoje só o Claude Code; o Codex entra aqui como um segundo adaptador, sem mexer no terminals.js.
//
// Interface de um provedor (tudo fixo no servidor; nada vem do cliente):
//   id          : identificador estável, gravado nas sessões ('claude')
//   label       : nome para a interface
//   resolve()   : { file, args, viaShell } da CLI no PATH, ou null se não estiver instalada
//   paneArgs()  : argumentos do terminal interativo para new | resume | fork (ver claude.js)
import { claudeProvider } from './claude.js';

export const DEFAULT_PROVIDER = 'claude';
const PROVIDERS = Object.freeze({ [claudeProvider.id]: claudeProvider });

export const providerIds = () => Object.keys(PROVIDERS);
/** O id é um provedor cadastrado? (Object.hasOwn: `__proto__`, `constructor` e afins nunca passam.) */
export const isProvider = (id) => typeof id === 'string' && Object.hasOwn(PROVIDERS, id);
/** Provedor pelo id; sem id (sessões antigas, gravadas antes de existir o campo) vale o padrão. Lança Error se o id não existe. */
export function getProvider(id = DEFAULT_PROVIDER) {
  if (!isProvider(id)) throw new Error(`Provedor desconhecido: ${typeof id === 'string' ? id.slice(0, 40) : typeof id}`);
  return PROVIDERS[id];
}
export { claudeProvider };
