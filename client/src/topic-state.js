// Expandir/recolher das pastas de workspace na sidebar. PURO (storage injetável): só a preferência de exibição vive no navegador;
// os tópicos e o tópico ativo continuam vindo do servidor (/api/state), sem segunda fonte de estado.
export const OPEN_KEY = 'topics:open';

/** Lê { [workspaceId]: boolean } do texto salvo; texto inválido ou de outro formato => {}. */
export function parseOpenMap(raw) {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'boolean'));
  } catch { return {}; }
}
export function loadOpenMap(storage = globalThis.localStorage) {
  try { return parseOpenMap(storage?.getItem(OPEN_KEY)); } catch { return {}; }
}
export function saveOpenMap(map, storage = globalThis.localStorage) {
  try { storage?.setItem(OPEN_KEY, JSON.stringify(map)); } catch { /* sem armazenamento: vale só nesta sessão */ }
}
/** Sem escolha salva, só o workspace ativo começa expandido. */
export const isExpanded = (map, workspaceId, active) => (typeof map?.[workspaceId] === 'boolean' ? map[workspaceId] : !!active);
