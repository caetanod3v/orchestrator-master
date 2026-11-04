// M3: configuração de projeto que o Claude Code executa ao abrir um pane interativo no workspace (hooks, statusLine, apiKeyHelper, servidores MCP, plugins, agentes e skills do projeto…).
// O Executor (Edit/Write) pode gravar `.claude/settings.json` fora do escopo: a rodada falha, mas o arquivo fica no disco e o próximo pane o executaria com as permissões do usuário.
// Regra: arquivo com conteúdo executável só é considerado revisado se existir no COMMIT ATUAL (HEAD) e for IDÊNTICO a ele (inclui o que já está em stage) e sem as marcas
// assume-unchanged/skip-worktree; qualquer outro caso (não versionado, ignorado, modificado, em stage, link simbólico, ilegível, fora de repositório, Git indisponível) exige confirmação
// explícita do usuário. Somente leitura: nada é corrigido nem removido.
// Limites conhecidos: (a) config versionada é tratada como revisada; (b) `.claude/commands` e `settings.json` de pastas ACIMA do workspace não são vistos; (c) comparar com o HEAD pode acionar filtros
// `clean` do repositório (configuração de um repositório hostil), no mesmo espírito do core.fsmonitor, que fica desligado; (d) entre a inspeção e a abertura do pane existe uma janela curta.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILES = Object.freeze(['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']);
// Diretórios de projeto que o Claude Code carrega e que o modelo pode acionar sozinho (agentes por delegação, skills por contexto): qualquer arquivo não versionado ou alterado pede confirmação.
export const CONFIG_DIRS = Object.freeze(['.claude/agents', '.claude/skills']);
// Chaves de settings que fazem o Claude Code executar comandos, iniciar processos ou carregar código de terceiros (model/permissões comuns não entram: não executam nada por si).
const ACTIVE_KEYS = Object.freeze(['hooks', 'statusLine', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'env', 'mcpServers', 'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'enabledPlugins', 'extraKnownMarketplaces']);
const MAX_BYTES = 256 * 1024;

const git = (cwd, args) => new Promise((resolve) => execFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, timeout: 8000, windowsHide: true, maxBuffer: 1 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (e, out) => resolve(e ? null : out)));

const isFilled = (v) => v !== undefined && v !== null && v !== false && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

/** Chaves executáveis presentes no JSON do arquivo, ou null se ele não puder ser interpretado com segurança. */
export function activeKeys(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const keys = ACTIVE_KEYS.filter((k) => isFilled(j[k]));
  if (j.permissions?.defaultMode === 'bypassPermissions') keys.push('permissions.defaultMode'); // desliga as confirmações do próprio Claude Code
  return keys;
}

/** null = revisado (no HEAD, idêntico, sem marcas); senão o motivo. */
async function notReviewed(dir, rel) {
  const inHead = await git(dir, ['ls-tree', '--name-only', 'HEAD', '--', rel]);
  if (inHead === null) return 'o Git não pôde confirmar que está versionado';
  if (!inHead.trim()) return 'não está versionado no commit atual do Git';
  const flag = await git(dir, ['ls-files', '-v', '--', rel]);
  if (flag === null || !/^H /.test(flag)) return 'está marcado no Git para ignorar alterações (assume-unchanged/skip-worktree) ou não pôde ser verificado';
  const diff = await git(dir, ['diff', '--name-only', '--no-ext-diff', 'HEAD', '--', rel]); // árvore de trabalho + stage contra o HEAD
  if (diff === null) return 'o Git não pôde comparar com o commit atual';
  return diff.trim() ? 'difere do commit atual do Git (alterado ou em stage)' : null;
}

const hasFiles = (abs) => { try { return fs.readdirSync(abs, { recursive: true, withFileTypes: true }).some((e) => !e.isDirectory()); } catch { return false; } };

/** Configuração de projeto executável que NÃO está versionada e intacta. Devolve `[{ path, why }]` (vazio = nada a confirmar). */
export async function inspectProjectConfig(dir) {
  const found = [];
  for (const rel of CONFIG_FILES) {
    const abs = path.join(dir, ...rel.split('/'));
    let st; try { st = fs.lstatSync(abs); } catch { continue; } // não existe: nada a executar
    if (st.isSymbolicLink()) { found.push({ path: rel, why: 'é um link simbólico' }); continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_BYTES) { found.push({ path: rel, why: 'arquivo grande demais para ser verificado' }); continue; }
    let keys; try { keys = activeKeys(fs.readFileSync(abs, 'utf8')); } catch { keys = null; }
    if (keys && !keys.length) continue; // legível e sem nada executável (ex.: só permissões comuns)
    const what = keys ? `contém ${keys.join(', ')}` : 'não pôde ser interpretado como JSON';
    const why = await notReviewed(dir, rel);
    if (why) found.push({ path: rel, why: `${what}; ${why}` });
  }
  for (const rel of CONFIG_DIRS) {
    const abs = path.join(dir, ...rel.split('/'));
    let st; try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) { found.push({ path: rel, why: 'é um link simbólico' }); continue; }
    if (!st.isDirectory() || !hasFiles(abs)) continue;
    const s = await git(dir, ['status', '--porcelain', '--ignored', '-uall', '--', rel]); // não versionado, ignorado, alterado ou em stage
    if (s === null) found.push({ path: rel, why: 'o Git não pôde confirmar que está versionado e intacto' });
    else if (s.trim()) found.push({ path: rel, why: 'tem arquivos não versionados, ignorados, alterados ou em stage' });
  }
  return found;
}
