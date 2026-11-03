// Worktrees Git isolados, detecção de conflitos e integração controlada (Marco C).
// Cada execução autorizada do ciclo roda em um worktree próprio (branch `orch/<id>`), nunca na branch nem no workspace principal. O módulo:
//   - registra cada ambiente em db.worktrees (identificador, caminho, branch, commit-base, ciclo, estado) com um histórico estruturado e um DIÁRIO da operação em andamento;
//   - só roda comandos Git com argumentos FIXOS (sem shell, sem hooks, sem rede: nunca push/fetch/--force);
//   - detecta conflitos com `git merge-tree --write-tree` (só grava objetos: não toca em refs, índice nem working tree da branch de destino);
//   - integra apenas com autorização explícita e verificável (digest da checagem), evidência do ciclo e destino limpo: ou a branch avança por inteiro (`merge --ff-only`), ou nada muda;
//   - limpa apenas por chamada explícita e nunca descarta trabalho não integrado;
//   - recupera após queda SEM relançar missões e sem remover nada;
//   - separa SEMPRE "o Git respondeu que algo é inválido/sujo" de "o Git não pôde responder" (ausente, tempo esgotado, saída ilegível): o segundo caso nunca vale como limpo,
//     nunca invalida registros por si só e nunca autoriza uma ação destrutiva; o registro fica bloqueado com a razão até o Git voltar a responder.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './store.js';
import { asyncRoute } from './async-route.js';
import { resolveNpmCli } from './verify.js';
import { killTreeSync, waitGone } from './orphans.js';

// ---------- configuração (ambiente > configurações > padrão DESLIGADO) ----------
export const WORKTREE_ENV = 'ORCH_WORKTREE_ISOLATION';
export function resolveWorktreeIsolation({ env = process.env, settings = {} } = {}) {
  const v = String(env[WORKTREE_ENV] ?? '').trim().toLowerCase();
  if (v === 'on') return { enabled: true, source: 'env' };
  if (v === 'off') return { enabled: false, source: 'env' };
  if (v !== '') throw new Error(`${WORKTREE_ENV} inválido: use "on" para executar cada ciclo em um worktree isolado, ou "off" (ou vazio) para desativar.`);
  if (typeof settings?.worktreeIsolation === 'boolean') return { enabled: settings.worktreeIsolation, source: 'settings' };
  return { enabled: false, source: 'default' };
}

// ---------- Git: argumentos fixos, sem shell, sem hooks, sem prompts ----------
const NO_HOOKS = path.join(os.tmpdir(), 'orch-no-hooks-dir'); // diretório que não existe: hooks do repositório nunca rodam por causa do orquestrador
const BASE_ARGS = ['-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'gc.auto=0', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false'];
const IDENT = { GIT_AUTHOR_NAME: 'AI Dev Orchestrator', GIT_AUTHOR_EMAIL: 'orchestrator@localhost', GIT_COMMITTER_NAME: 'AI Dev Orchestrator', GIT_COMMITTER_EMAIL: 'orchestrator@localhost' };
const GIT_ENV_SCRUB = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
/** Nunca rejeita: devolve { code, out, err, failed, timedOut }. `failed` = o Git NÃO pôde responder (não encontrado no PATH, tempo esgotado, saída além do limite): o resultado é DESCONHECIDO (code -1),
 *  diferente de um código de saída ≠ 0, que é uma resposta válida do Git ("não é um repositório", "não é ancestral"...). */
export function git(cwd, args, { env = null, timeout = 30000 } = {}) {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env ?? {}) };
  for (const k of GIT_ENV_SCRUB) if (!env || !(k in env)) delete e[k];
  return new Promise((resolve) => execFile('git', [...BASE_ARGS, ...args], { cwd, env: e, timeout, windowsHide: true, maxBuffer: 16 << 20, encoding: 'utf8' },
    (err, stdout, stderr) => {
      const failed = !!err && typeof err.code !== 'number';
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: stdout || '', err: String(stderr || err?.message || '').trim(), failed, timedOut: failed && err.killed === true });
    }));
}
const lines = (s) => String(s).split(/\r?\n/).filter(Boolean);
const clip = (s, n = 300) => String(s ?? '').slice(0, n);
/** Motivo curto de uma consulta ao Git que não pôde ser concluída. */
const why = (x) => (x?.timedOut ? 'tempo esgotado' : clip(x?.err, 120) || 'falha ao executar o Git');
const PORCELAIN_LINE = /^[ MTADRCU?!]{2} \S/; // formato de `git status --porcelain=v1`: duas colunas de estado, um espaço e o caminho

// Um comando Git por vez em cada repositório (index.lock) e uma integração por vez.
const locks = new Map();
const withLock = (key, fn) => { const prev = locks.get(key) ?? Promise.resolve(); const run = prev.then(fn, fn); locks.set(key, run.catch(() => {})); return run; };

const norm = (p) => { const r = path.resolve(String(p)).replace(/\\/g, '/'); return process.platform === 'win32' ? r.toLowerCase() : r; };
const samePath = (a, b) => norm(a) === norm(b);
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const BRANCH_RE = /^orch\/wt_[0-9a-f]{8}$/, ID_RE = /^wt_[0-9a-f]{8}$/, SHA_RE = /^[0-9a-f]{40,64}$/;
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/; // nome de pacote npm válido (impede "../" e caminhos absolutos)

export const WT_STATES = Object.freeze(['creating', 'ready', 'in_use', 'finished', 'integrated', 'failed', 'inconsistent', 'removed']);
const USABLE = ['ready', 'in_use', 'finished'];
const MAX_HISTORY = 100, MAX_ATTEMPTS = 20, MAX_ROUNDS = 20;

/** Repositório do workspace: precisa ser a RAIZ do worktree PRINCIPAL, com HEAD em uma branch e ao menos um commit. `unknown: true` = o Git não pôde responder. */
async function resolveRepo(wsPath, run = git) {
  const p = real(wsPath);
  if (!p) return { error: 'o workspace não existe' };
  const unknown = (x) => ({ error: `não foi possível consultar o Git (${why(x)})`, unknown: true });
  const r = await run(p, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir', '--is-bare-repository']);
  if (r.failed) return unknown(r);
  if (r.code !== 0) return { error: 'o workspace não é um repositório Git' };
  const [top, gitDir, common, bare] = lines(r.out);
  if (bare === 'true') return { error: 'repositório bare não é suportado' };
  if (!samePath(real(path.resolve(p, top)) ?? top, p)) return { error: 'o workspace precisa ser a raiz do repositório Git' };
  if (!samePath(path.resolve(p, gitDir), path.resolve(p, common))) return { error: 'o workspace é ele mesmo um worktree vinculado; use o repositório principal' };
  const b = await run(p, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (b.failed) return unknown(b);
  if (b.code !== 0 || !b.out.trim()) return { error: 'HEAD destacado: o worktree precisa partir de uma branch' };
  const c = await run(p, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (c.failed) return unknown(c);
  if (c.code !== 0 || !SHA_RE.test(c.out.trim())) return { error: 'o repositório ainda não tem nenhum commit' };
  return { path: p, key: norm(p), commonDir: path.resolve(p, common), branch: b.out.trim(), commit: c.out.trim() };
}

/** Árvore (objeto Git) do CONTEÚDO atual do worktree, incluindo arquivos novos e respeitando .gitignore, via índice temporário: não mexe no índice nem em refs. */
export async function treeOf(wtPath) {
  const idx = path.join(os.tmpdir(), `orch-idx-${crypto.randomUUID()}`), env = { GIT_INDEX_FILE: idx };
  try {
    if ((await git(wtPath, ['read-tree', 'HEAD'], { env })).code !== 0) return null;
    if ((await git(wtPath, ['add', '-A', '--', '.'], { env })).code !== 0) return null;
    const w = await git(wtPath, ['write-tree'], { env });
    return w.code === 0 && SHA_RE.test(w.out.trim()) ? w.out.trim() : null;
  } finally { try { fs.rmSync(idx, { force: true }); } catch { /* temporário */ } }
}

// ---------- Marco E (E1): PLANO de preparação do ambiente do worktree (somente leitura; nada é instalado nem executado) ----------
// O plano descreve o `npm ci` FUTURO a partir SÓ dos arquivos versionados do worktree (nunca do workspace principal) e tem um digest que cobre tudo o que importa
// (identidade do worktree, manifesto, lockfile, .npmrc efetivo, comando fixo). Qualquer coisa fora do que é suportado é RECUSADA com motivo explícito.
export const PREPARE_ARGS = Object.freeze(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
const OTHER_LOCKS = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json'];
const NPMRC_ALLOWED = new Set(['fund', 'audit', 'engine-strict', 'loglevel']); // chaves inofensivas; `registry` e `@escopo:registry` são tratadas à parte
const NPMRC_SENSITIVE = /^\/\/|_auth|password|token|username/i;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const refusal = (code, error) => ({ ok: false, status: 409, code, error });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Lê um arquivo da raiz do worktree: precisa ser arquivo comum (nunca link) e pequeno. */
function readRoot(dir, name, max) {
  const f = path.join(dir, name); let st;
  try { st = fs.lstatSync(f); } catch { return { missing: true }; }
  if (!st.isFile() || st.isSymbolicLink()) return { unsafe: true };
  if (st.size > max) return { tooBig: true };
  try { return { buf: fs.readFileSync(f) }; } catch { return { unreadable: true }; }
}
/** .npmrc do PROJETO: só registry (https, sem credenciais) e poucas chaves inofensivas. Credenciais, variáveis de ambiente e qualquer outra chave => recusa (o valor nunca é repetido). */
function parseNpmrc(text) {
  const out = { registry: null, scoped: [] };
  const url = (v) => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash ? u.href : null; } catch { return null; } };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const i = line.indexOf('='); if (i < 1) return { error: refusal('npmrc_invalid', 'O .npmrc tem uma linha que não é "chave=valor"; nada foi planejado.') };
    const key = line.slice(0, i).trim(), val = line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
    if (NPMRC_SENSITIVE.test(key)) return { error: refusal('npmrc_sensitive', 'O .npmrc do projeto contém configuração de credencial (valor omitido); credenciais nunca fazem parte do plano. Remova-a do arquivo versionado.') };
    if (/\$\{/.test(val)) return { error: refusal('npmrc_not_allowed', 'O .npmrc usa variável de ambiente; o resultado dependeria da máquina e não é reproduzível.') };
    const scope = /^(@[a-z0-9-~][a-z0-9-._~]*):registry$/.exec(key);
    if (key === 'registry' || scope) {
      const u = url(val); if (!u) return { error: refusal('npmrc_invalid', `O registry do .npmrc (${scope ? scope[1] : 'padrão'}) não é uma URL https válida sem credenciais (valor omitido).`) };
      if (scope) out.scoped.push({ scope: scope[1], url: u }); else out.registry = u;
    } else if (!NPMRC_ALLOWED.has(key)) return { error: refusal('npmrc_not_allowed', `O .npmrc usa uma chave não permitida ("${clip(key, 40)}"); só registry, @escopo:registry, fund, audit, engine-strict e loglevel são aceitas.`) };
  }
  out.scoped.sort((a, b) => a.scope.localeCompare(b.scope));
  return out;
}
/** Plano a partir do DIRETÓRIO do worktree. `id` identifica o worktree no digest. Nunca lança; nunca escreve. */
export function planPrepare({ id, path: dir, branch, baseCommit }) {
  try { return planPrepareUnsafe({ id, dir, branch, baseCommit }); } catch (e) { return refusal('plan_failed', `Não foi possível montar o plano (${clip(e?.message, 80)}); nada foi planejado.`); }
}
function planPrepareUnsafe({ id, dir, branch, baseCommit }) {
  const mf = readRoot(dir, 'package.json', 1 << 20);
  if (mf.missing) return refusal('package_json_missing', 'O worktree não tem package.json na raiz; não há o que preparar.');
  if (mf.unsafe || mf.tooBig || mf.unreadable) return refusal('file_unsafe', 'O package.json da raiz não é um arquivo comum legível de tamanho razoável.');
  for (const n of OTHER_LOCKS) if (fs.existsSync(path.join(dir, n))) return refusal('unsupported_manager', `Encontrado "${n}": só npm (package-lock.json) é suportado; nenhum outro gerenciador é usado como substituto.`);
  let pkg; try { pkg = JSON.parse(mf.buf.toString('utf8')); } catch { return refusal('package_invalid', 'O package.json não é um JSON válido.'); }
  if (!isObj(pkg)) return refusal('package_invalid', 'O package.json não é um objeto.');
  if (typeof pkg.packageManager === 'string' && !/^npm@/.test(pkg.packageManager)) return refusal('unsupported_manager', `O package.json declara packageManager "${clip(pkg.packageManager, 40)}"; só npm é suportado.`);
  if (pkg.workspaces !== undefined) return refusal('workspaces_unsupported', 'Projetos com "workspaces" ainda não são suportados na preparação.');
  const lk = readRoot(dir, 'package-lock.json', 64 << 20);
  if (lk.missing) return refusal('lockfile_missing', 'Falta o package-lock.json na raiz: sem lockfile a instalação não é reproduzível e nada foi planejado.');
  if (lk.unsafe || lk.tooBig || lk.unreadable) return refusal('file_unsafe', 'O package-lock.json não é um arquivo comum legível de tamanho razoável.');
  let lock; try { lock = JSON.parse(lk.buf.toString('utf8')); } catch { return refusal('lockfile_invalid', 'O package-lock.json não é um JSON válido.'); }
  if (!isObj(lock) || ![2, 3].includes(lock.lockfileVersion) || !isObj(lock.packages) || !isObj(lock.packages[''])) return refusal('lockfile_invalid', 'O package-lock.json precisa ter lockfileVersion 2 ou 3 com a seção "packages".');
  // consistência manifesto x lockfile (o que o `npm ci` exige), sem instalar nada
  const map = (o, k) => (isObj(o?.[k]) ? o[k] : {});
  const root = lock.packages[''], diff = [];
  for (const s of ['dependencies', 'devDependencies', 'optionalDependencies']) { const a = map(pkg, s), b = map(root, s); for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[n] !== b[n]) diff.push(`${s}:${clip(n, 60)}`); }
  if (diff.length) return refusal('lockfile_inconsistent', `O package-lock.json não corresponde ao package.json (${diff.slice(0, 5).join(', ')}${diff.length > 5 ? ', …' : ''}); atualize o lockfile e versione-o.`);
  const items = [];
  for (const s of ['dependencies', 'devDependencies']) for (const [n, spec] of Object.entries(map(pkg, s))) items.push({ name: n, spec: clip(spec, 120), section: s });
  items.sort((a, b) => a.name.localeCompare(b.name) || a.section.localeCompare(b.section));
  const absent = items.filter((x) => !isObj(lock.packages[`node_modules/${x.name}`])).map((x) => x.name);
  if (absent.length) return refusal('lockfile_inconsistent', `O package-lock.json não resolve: ${absent.slice(0, 5).join(', ')}.`);
  // .npmrc do projeto (opcional)
  const rc = readRoot(dir, '.npmrc', 64 << 10);
  let npmrc = { present: false, sha256: null, registry: { url: DEFAULT_REGISTRY, source: 'default' }, scopedRegistries: [] };
  if (rc.unsafe || rc.tooBig || rc.unreadable) return refusal('file_unsafe', 'O .npmrc não é um arquivo comum legível de tamanho razoável.');
  if (rc.buf) { const p = parseNpmrc(rc.buf.toString('utf8')); if (p.error) return p.error; npmrc = { present: true, sha256: sha256(rc.buf), registry: p.registry ? { url: p.registry, source: '.npmrc' } : npmrc.registry, scopedRegistries: p.scoped }; }
  // hosts de onde o lockfile manda baixar
  const hosts = new Set(), odd = new Set(); let nonHttps = false;
  const nameOf = (k) => k.replace(/^.*node_modules\//, '');
  for (const [k, v] of Object.entries(lock.packages)) {
    if (!isObj(v)) continue;
    if (typeof v.resolved === 'string') { try { const u = new URL(v.resolved); hosts.add(u.host); if (u.protocol !== 'https:') nonHttps = true; if (/^git/.test(u.protocol) || /^git\+/.test(v.resolved)) odd.add(nameOf(k)); } catch { odd.add(nameOf(k)); } }
    if (v.link === true) odd.add(nameOf(k));
  }
  const warnings = ['Usa a rede: o `npm ci` baixa código de terceiros.', 'Roda com --ignore-scripts: scripts de instalação não são executados; pacotes que dependem deles (build nativo) podem ficar incompletos.'];
  const defHost = new URL(npmrc.registry.url).host;
  if (npmrc.registry.source !== 'default') warnings.push(`Registry diferente do padrão: ${npmrc.registry.url}`);
  if (npmrc.scopedRegistries.length) warnings.push(`Registries por escopo: ${npmrc.scopedRegistries.map((x) => `${x.scope} → ${x.url}`).join(', ')}`);
  if ([...hosts].some((h) => h !== defHost && !npmrc.scopedRegistries.some((x) => new URL(x.url).host === h))) warnings.push('O lockfile baixa de hosts diferentes do registry configurado.');
  if (nonHttps) warnings.push('O lockfile contém URLs que não são https.');
  if (odd.size) warnings.push(`Dependências de fonte não-registry (git/link): ${[...odd].sort().slice(0, 5).join(', ')}.`);
  const plan = {
    v: 1, worktree: { id, path: norm(dir), branch, baseCommit }, manager: 'npm', args: [...PREPARE_ARGS], command: `npm ${PREPARE_ARGS.join(' ')}`,
    manifest: { sha256: sha256(mf.buf) }, lockfile: { name: 'package-lock.json', version: lock.lockfileVersion, packages: Object.keys(lock.packages).length, sha256: sha256(lk.buf) },
    dependencies: { count: items.length, items }, npmrc, resolvedHosts: [...hosts].sort(), warnings,
  };
  const digest = sha256(JSON.stringify(plan));
  const notes = fs.existsSync(path.join(dir, 'node_modules')) ? ['O worktree já tem node_modules: o `npm ci` o removeria e reinstalaria (o plano não apaga nada).'] : [];
  return { ok: true, plan, digest, notes };
}

// ---------- Marco E (E2): execução CONTROLADA da preparação (só com o digest aprovado) ----------
// Comando e argumentos são FIXOS (PREPARE_ARGS); nada vem do cliente nem do agente. O processo roda no worktree, com ambiente limpo e configuração do npm neutralizada.
const PREPARE_TIMEOUT_MS = 600_000, PREPARE_MAX_OUTPUT = 256 * 1024, PREPARE_TAIL = 1500;
const SECRET_ENV = /key|token|secret|passw|credential|auth/i;
const PROXY_ENV = /^(http_proxy|https_proxy|all_proxy|no_proxy)$/i; // proxies do ambiente nunca valem na preparação (podem carregar credenciais)
/** Remove credenciais de um texto ANTES de ele ser gravado ou exibido: userinfo de URLs (scheme://usuario:senha@host), pares _authToken/_auth/password/token=valor e os VALORES literais de `secrets` (proxy, tokens do ambiente). Idempotente. */
export function redactSecrets(text, secrets = []) {
  let s = String(text ?? '');
  for (const v of [...secrets].filter((x) => typeof x === 'string' && x.length >= 4).sort((a, b) => b.length - a.length)) s = s.split(v).join('***');
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1***@').replace(/((?:_auth(?:token)?|_password|password|token)\s*[=:]\s*)[^\s,;]+/gi, '$1***');
}
const defaultPrepareSpec = (args) => { const cli = resolveNpmCli(); return cli ? { command: process.execPath, args: [cli, ...args] } : null; }; // node + npm-cli.js: sem shell
/** Ambiente LIMPO: sem segredos, sem NENHUMA npm_* (config, lifecycle, package), sem NODE_OPTIONS/NODE_PATH; configuração de usuário e global do npm apontam para arquivos VAZIOS do orquestrador. */
function prepareEnv(cfgDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k) && !PROXY_ENV.test(k) && !/^npm_/i.test(k) && !/^(NODE_OPTIONS|NODE_PATH|INIT_CWD|PREFIX)$/i.test(k)) env[k] = v;
  return { ...env, CI: '1', npm_config_ignore_scripts: 'true', npm_config_userconfig: path.join(cfgDir, 'user.npmrc'), npm_config_globalconfig: path.join(cfgDir, 'global.npmrc'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', NO_UPDATE_NOTIFIER: '1' };
}

/** `runGit` existe para os testes injetarem falhas do Git (ausente, tempo esgotado, saída inválida); o servidor usa sempre o Git real. */
export function createWorktreeManager({ db, root = null, now = store.now, runGit = git, track = null, children = null, prepareSpec = defaultPrepareSpec, spawnProc = spawn, prepareTimeoutMs = PREPARE_TIMEOUT_MS, maxOutputBytes = PREPARE_MAX_OUTPUT } = {}) {
  db.worktrees ??= [];
  const G = runGit;
  const all = () => db.worktrees;
  const get = (id) => all().find((w) => w.id === id) ?? null;
  const rootFor = (repoPath) => root ?? path.join(path.dirname(repoPath), `${path.basename(repoPath)}.orch-worktrees`);
  const mission = (r) => db.missions.find((m) => m.id === r.missionId) ?? null;

  /** Registro estruturado e LIMITADO (recuperável do banco) + linha na atividade. */
  function audit(r, event, detail = {}) {
    r.history = [...(r.history ?? []), { at: now(), event, ...detail }].slice(-MAX_HISTORY); r.updatedAt = now();
    try { store.log('worktree', `Worktree ${r.id} (${event})${detail.reason ? `: ${clip(detail.reason, 160)}` : ''}`, { missionId: r.missionId, worktreeId: r.id }); } catch { /* sem banco carregado */ }
  }
  const saveSoft = () => { try { return store.save() !== false; } catch { return false; } };
  const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
  /** Primeira inspeção inconclusiva (o Git não respondeu) de uma lista de problemas, ou null. */
  const unknownOf = (problems) => problems.find((p) => p.inconclusive)?.message ?? null;

  /** Identidade e estado do ambiente: caminho, repositório, branch e commit-base. Só leitura.
   *  Problemas DEFINITIVOS vêm de respostas do Git (ou do disco); consultas que o Git não conseguiu responder viram UM problema `inspection_failed` com `inconclusive: true`
   *  e nunca geram os problemas definitivos que dependeriam delas (um Git ausente não prova que o worktree é inválido). */
  async function inspect(r) {
    const problems = [], add = (code, message) => problems.push({ code, message }), unknown = [];
    const ask = async (cwd, args) => { const x = await G(cwd, args); if (x.failed) unknown.push(`${args[0]}: ${why(x)}`); return x; };
    const end = () => { if (unknown.length) problems.push({ code: 'inspection_failed', inconclusive: true, message: `a inspeção do Git não pôde ser concluída (${unknown.join('; ')})` }); return problems; };
    if (!ID_RE.test(String(r.id)) || !BRANCH_RE.test(String(r.branch))) add('identity', 'identificador ou branch fora do padrão do orquestrador');
    if (!fs.existsSync(r.path)) { add('path_missing', 'a pasta do worktree não existe mais'); return end(); }
    const repoReal = real(r.repoPath);
    if (!repoReal) { add('repo_missing', 'o repositório do workspace não existe mais'); return end(); }
    const t = await ask(r.path, ['rev-parse', '--show-toplevel', '--git-common-dir']);
    if (t.failed) return end();
    if (t.code !== 0) { add('not_a_worktree', 'a pasta não é mais um worktree Git'); return end(); }
    const [top, common] = lines(t.out);
    if (!samePath(real(path.resolve(r.path, top)) ?? top, real(r.path) ?? r.path)) add('not_a_worktree', 'a raiz Git da pasta não é o worktree registrado');
    const mainCommon = await ask(repoReal, ['rev-parse', '--git-common-dir']);
    if (!mainCommon.failed && !samePath(path.resolve(r.path, common ?? ''), path.resolve(repoReal, lines(mainCommon.out)[0] ?? ''))) add('wrong_repository', 'o worktree pertence a outro repositório');
    const b = await ask(r.path, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (!b.failed && b.out.trim() !== r.branch) add('branch_changed', `a branch do worktree mudou (esperada ${r.branch}, atual ${b.out.trim() || 'HEAD destacado'})`);
    const list = await ask(repoReal, ['worktree', 'list', '--porcelain']);
    if (!list.failed) {
      const reg = list.out.split(/\r?\n\r?\n/).some((blk) => { const ls = lines(blk); return ls.some((l) => l.startsWith('worktree ') && samePath(l.slice(9), r.path)) && ls.includes(`branch refs/heads/${r.branch}`); });
      if (!reg) add('not_registered', 'o Git não tem este worktree registrado com a branch esperada');
    }
    if (SHA_RE.test(String(r.baseCommit))) { const anc = await ask(r.path, ['merge-base', '--is-ancestor', r.baseCommit, 'HEAD']); if (!anc.failed && anc.code !== 0) add('base_not_ancestor', 'o commit-base deixou de ser ancestral do HEAD do worktree'); }
    return end();
  }

  /** ÚNICO ponto que interpreta `git status`: limpo, sujo ou DESCONHECIDO. Falha de execução, tempo esgotado, código ≠ 0 ou saída fora do formato porcelain (inclusive truncada)
   *  são "unknown": nunca "clean". Quem decide integrar, registrar snapshot, reaproveitar ou limpar precisa tratar "unknown" como bloqueio. */
  async function dirtyState(dir) {
    const s = await G(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
    const unknown = (reason) => ({ state: 'unknown', files: [], reason });
    if (s.failed) return unknown(s.timedOut ? 'o git status excedeu o tempo' : `o git status não pôde ser executado (${why(s)})`);
    if (s.code !== 0) return unknown(`o git status terminou com código ${s.code}${s.err ? `: ${clip(s.err, 120)}` : ''}`);
    const out = String(s.out ?? '');
    if (out && !out.endsWith('\n')) return unknown('a saída do git status veio incompleta');
    const files = lines(out);
    if (files.some((l) => !PORCELAIN_LINE.test(l))) return unknown('a saída do git status não está no formato esperado');
    return { state: files.length ? 'dirty' : 'clean', files, reason: null };
  }
  const unknownText = (st) => `não foi possível determinar o estado do Git (${st.reason})`;
  /** { known, head }: `known: false` = o Git não respondeu; `known: true, head: null` = respondeu que não há commit. */
  const probeHead = async (dir) => {
    const h = await G(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    if (h.failed) return { known: false, head: null, reason: why(h) };
    const v = h.out.trim();
    return { known: true, head: h.code === 0 && SHA_RE.test(v) ? v : null, reason: null };
  };
  const headOf = async (dir) => (await probeHead(dir)).head;

  /** Ciclo ligado ao worktree: o atual da missão OU um dos anteriores (mission.pastCycles), sempre pela identidade gravada (o id do ciclo em worktree.cycleId). Nunca por semelhança.
   *  Um ciclo que declara OUTRO worktree (cycle.worktreeId diferente) nunca vale; ciclos sem esse campo seguem aceitos como antes. */
  function cycleOf(r) {
    const m = mission(r);
    if (!m || typeof r.cycleId !== 'string' || !r.cycleId) return null;
    const hit = [m.cycle, ...(Array.isArray(m.pastCycles) ? m.pastCycles : [])].find((c) => c && typeof c === 'object' && c.id === r.cycleId);
    return hit && (hit.worktreeId === undefined || hit.worktreeId === r.id) ? hit : null;
  }

  // ---------- criação ----------
  async function create({ mission: m, workspace }) {
    if (!m?.id || !workspace?.path) return fail(400, 'Missão ou workspace ausente.');
    const repo = await resolveRepo(workspace.path, G);
    if (repo.error) return fail(409, `Worktree não criado: ${repo.error}.`);
    return withLock(repo.key, async () => {
      const cur = await resolveRepo(workspace.path, G); // revalida DENTRO do lock: outra operação pode ter mudado a branch
      if (cur.error) return fail(409, `Worktree não criado: ${cur.error}.`);
      const id = store.uid('wt'), branch = `orch/${id}`, dir = rootFor(cur.path), wtPath = path.join(dir, id);
      if (!BRANCH_RE.test(branch) || !ID_RE.test(id)) return fail(500, 'Identificador de worktree inesperado.');
      if (!norm(wtPath).startsWith(`${norm(dir)}/`) || fs.existsSync(wtPath)) return fail(409, 'O caminho do worktree é inválido ou já existe.');
      if (samePath(wtPath, cur.path) || norm(wtPath).startsWith(`${norm(cur.path)}/`)) return fail(409, 'O worktree não pode ficar dentro do workspace principal.');
      const baseDirty = (await dirtyState(cur.path)).state !== 'clean'; // informativo: na dúvida (estado desconhecido) o aviso "base com alterações" é mantido
      const r = { id, missionId: m.id, cycleId: null, workspaceId: workspace.id, repoPath: cur.path, path: wtPath, branch, baseBranch: cur.branch, baseCommit: cur.commit, headCommit: cur.commit, baseDirty,
        state: 'creating', op: { kind: 'create', at: now() }, current: null, rounds: [], attempts: [], history: [], integratedCommit: null, createdAt: now(), updatedAt: now() };
      all().push(r); audit(r, 'create_started', { base: cur.commit.slice(0, 12), baseBranch: cur.branch });
      try { store.saveOrThrow(); } catch (e) { all().pop(); return fail(503, `O banco não pôde ser gravado (${e?.code || e?.message || 'erro'}); nenhum worktree foi criado.`); }
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return abortCreate(r, `não foi possível criar a pasta de worktrees (${e.code || e.message})`, false); }
      const add = await G(cur.path, ['worktree', 'add', '-b', branch, wtPath, cur.commit]);
      if (add.code !== 0) return abortCreate(r, `git worktree add falhou: ${clip(add.err, 200)}`, true);
      const problems = await inspect(r);
      if (problems.length) return abortCreate(r, `o worktree criado não passou na validação: ${problems.map((p) => p.code).join(', ')}`, true);
      r.state = 'ready'; r.op = null; audit(r, 'created', { path: wtPath, branch });
      try { store.saveOrThrow(); } catch (e) { return fail(503, `O worktree foi criado, mas o banco não pôde ser gravado (${e?.code || e?.message || 'erro'}); a recuperação do próximo boot o concilia.`, { record: r }); }
      return { ok: true, record: r, created: true };
    });
  }
  /** Falha na criação: desfaz SÓ o que esta própria operação criou (worktree novo, ainda no commit-base e COMPROVADAMENTE limpo). Qualquer dúvida (inclusive estado do Git desconhecido) => 'inconsistent', sem apagar nada. */
  async function abortCreate(r, reason, mayHaveCreated) {
    let removed = !mayHaveCreated || !fs.existsSync(r.path);
    if (!removed) {
      const clean = (await dirtyState(r.path)).state === 'clean' && (await headOf(r.path)) === r.baseCommit;
      if (clean && (await G(r.repoPath, ['worktree', 'remove', r.path])).code === 0) { removed = true; await G(r.repoPath, ['branch', '-d', r.branch]); }
    }
    r.op = null; r.state = removed ? 'failed' : 'inconsistent'; audit(r, removed ? 'create_failed' : 'create_failed_leftovers', { reason });
    saveSoft();
    return fail(409, `Worktree não criado: ${reason}.${removed ? '' : ' Restos foram mantidos para inspeção (nada foi apagado).'}`, { record: r });
  }

  /** Reaproveita SÓ um ambiente da mesma missão, ainda sem ciclo, pronto, com a mesma base do repositório e que passa na validação; senão cria um novo.
   *  Se o estado do candidato não puder ser determinado (Git sem resposta), NÃO reaproveita e NÃO cria outro: recusa. */
  async function ensureFor(m, workspace) {
    const repo = await resolveRepo(workspace.path, G);
    if (repo.error) return fail(409, `Worktree não criado: ${repo.error}.`);
    for (const r of all()) {
      if (r.op || r.missionId !== m.id || r.workspaceId !== workspace.id || r.cycleId !== null || r.state !== 'ready' || r.baseCommit !== repo.commit || r.baseBranch !== repo.branch) continue;
      const problems = await inspect(r), unk = unknownOf(problems);
      if (unk) return fail(409, `Worktree não reaproveitado: ${unk}.`);
      if (problems.length) continue;
      const head = await probeHead(r.path); if (!head.known) return fail(409, `Worktree não reaproveitado: não foi possível ler o HEAD (${head.reason}).`);
      const st = await dirtyState(r.path); if (st.state === 'unknown') return fail(409, `Worktree não reaproveitado: ${unknownText(st)}.`);
      if (head.head === r.baseCommit && st.state === 'clean') { audit(r, 'reused'); saveSoft(); return { ok: true, record: r, created: false }; }
    }
    return create({ mission: m, workspace });
  }

  /** E1: plano de preparação (somente leitura; não altera o registro nem o worktree). Só para ambientes parados e íntegros no Git. */
  async function planPrepareFor(id) {
    const r = get(id); if (!r) return fail(404, 'Worktree não encontrado.');
    if (r.op || !['ready', 'finished'].includes(r.state)) return refusal('worktree_not_preparable', `O worktree está em "${r.state}"${r.op ? ` (operação ${r.op.kind} em andamento)` : ''}; o plano só vale com ele parado.`);
    const problems = await inspect(r);
    if (problems.length) return refusal('worktree_invalid', `O worktree não passou na validação (${problems.map((p) => p.code).join(', ')}); nada foi planejado.`);
    return planPrepare(r);
  }

  // ---------- E2: aprovação + execução da preparação ----------
  let preparing = null; // id do worktree em preparação (uma por vez neste servidor)
  let activeChild = null; // { pid, tracked } do preparador em execução (para o encerramento do servidor)
  /** Saída do servidor: encerra o npm da preparação (no Windows com a árvore; em POSIX só o PID principal) e só apaga o registro se o processo sumiu. */
  function killActiveSync() {
    const a = activeChild; if (!a?.pid) return;
    try { killTreeSync(a.pid); } catch { /* melhor esforço */ }
    if (waitGone(a.pid, 1500) && a.tracked) { try { a.tracked.release(); } catch { /* idem */ } a.tracked = null; }
  }
  /** Executa `npm ci` FIXO no worktree se (e só se) o plano ATUAL tem o digest recebido. Devolve 202 assim que o processo foi iniciado e registrado; `finished` resolve ao terminar. */
  async function prepare(id, { digest } = {}) {
    const r = get(id); if (!r) return fail(404, 'Worktree não encontrado.');
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return fail(400, 'A preparação exige o digest do plano devolvido por prepare/plan.');
    return withLock(norm(r.repoPath), async () => {
      const no = (code, error, status = 409) => ({ ok: false, status, code, error, record: r });
      if (preparing) return no('preparation_in_progress', `Já há uma preparação em andamento (${preparing}); aguarde terminar. Nada foi executado.`);
      if (r.op || !['ready', 'finished'].includes(r.state)) return no('worktree_not_preparable', `O worktree está em "${r.state}"${r.op ? ` (operação ${r.op.kind} em andamento)` : ''}; nada foi executado.`);
      if (['planning', 'running'].includes(mission(r)?.cycle?.status)) return no('cycle_active', 'O ciclo desta missão está ativo; aguarde terminar. Nada foi executado.');
      const problems = await inspect(r);
      if (problems.length) return no('worktree_invalid', `O worktree não passou na validação (${problems.map((p) => p.code).join(', ')}); nada foi executado.`);
      const p = planPrepare(r); // RECALCULADO agora: o que vale é o plano de agora, nunca um guardado
      if (!p.ok) return no(p.code, p.error);
      if (p.digest !== digest) return no('digest_mismatch', 'A aprovação não corresponde ao plano atual (algo mudou depois de aprovado). Gere o plano de novo; nada foi executado.');
      if (environmentFor(r.id).ok) return no('environment_already_prepared', 'O ambiente do worktree já está preparado (ou o projeto não precisa de dependências); nada foi executado.');
      const spec = prepareSpec([...PREPARE_ARGS]);
      if (!spec) return no('npm_unavailable', 'O npm não foi encontrado junto ao Node; nada foi executado.');
      // aprovação CONSUMIDA e gravada ANTES de qualquer processo; se não gravar, nada roda e tudo volta ao que era
      const keep = { op: r.op, prepare: r.prepare, history: r.history, updatedAt: r.updatedAt }, at = now();
      r.op = { kind: 'prepare', at, prevState: r.state, digest }; r.prepare = { state: 'running', approval: { id: store.uid('apr'), digest, approvedAt: at, authorizedBy: 'user', consumedAt: at }, command: p.plan.command, dependencies: p.plan.dependencies.count, lockfileSha256: p.plan.lockfile.sha256, startedAt: at };
      audit(r, 'prepare_approved', { digest: digest.slice(0, 12), dependencies: p.plan.dependencies.count });
      try { store.saveOrThrow(); } catch (e) { Object.assign(r, keep); if (keep.prepare === undefined) delete r.prepare; return no('persistence_failed', `O banco não pôde ser gravado (${e?.code || e?.message || 'erro'}); a preparação NÃO foi iniciada.`, 503); }
      const prevState = r.op.prevState, t0 = Date.now();
      const secrets = Object.entries(process.env).filter(([k, v]) => (SECRET_ENV.test(k) || PROXY_ENV.test(k)) && typeof v === 'string' && v.length >= 4).map(([, v]) => v); // valores do ambiente que nunca podem ir para o banco
      const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prep-env-'));
      let tracked = null, done = false, state = { timedOut: false, overflow: false, bytes: 0, tail: '' };
      preparing = r.id;
      let resolveFinished; const finished = new Promise((res) => { resolveFinished = res; });
      const conclude = ({ exitCode = null, spawnError = null, trackError = null } = {}) => {
        if (done) return; done = true;
        activeChild = null;
        try { tracked?.release(); } catch { /* informativo */ }
        try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* temporário do orquestrador */ }
        let status = 'failed', reason = null;
        if (trackError) reason = `não foi possível registrar o processo (${trackError}); ele foi encerrado`;
        else if (spawnError) reason = `falha ao iniciar o npm: ${clip(spawnError.message, 160)}`;
        else if (state.timedOut) reason = `tempo máximo excedido (${Math.round(prepareTimeoutMs / 1000)} s)`;
        else if (state.overflow) reason = `a saída excedeu ${maxOutputBytes} bytes; processo encerrado`;
        else if (exitCode !== 0) reason = `npm ci terminou com código ${exitCode}`;
        else { const env = environmentFor(r.id); if (env.ok) status = 'ready'; else reason = `npm ci terminou com código 0, mas o ambiente ficou incompleto: ${env.reason}`; }
        // sanitizado ANTES de gravar: o banco, /api/state e as respostas nunca recebem credenciais
        r.prepare = { ...r.prepare, state: status, finishedAt: now(), durationMs: Date.now() - t0, exitCode, reason: reason === null ? null : redactSecrets(reason, secrets), outputTail: clip(redactSecrets(state.tail.trim().slice(-PREPARE_TAIL), secrets), PREPARE_TAIL) };
        r.op = null; r.state = prevState; preparing = null; // falha: node_modules NÃO é apagado e a verificação continua bloqueada (environmentFor)
        audit(r, status === 'ready' ? 'prepare_ready' : 'prepare_failed', { reason: r.prepare.reason ?? undefined, exitCode });
        saveSoft(); resolveFinished({ status, reason: r.prepare.reason, exitCode });
      };
      let child;
      try {
        fs.writeFileSync(path.join(cfgDir, 'user.npmrc'), ''); fs.writeFileSync(path.join(cfgDir, 'global.npmrc'), '');
        child = spawnProc(spec.command, spec.args, { cwd: real(r.path) ?? r.path, shell: false, windowsHide: true, env: prepareEnv(cfgDir), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { conclude({ spawnError: e }); return { ok: true, status: 202, record: r, finished }; }
      child.on('error', (e) => conclude({ spawnError: e }));
      try { tracked = track?.('preparer', child.pid, { missionId: r.missionId, worktreeId: r.id }) ?? null; } catch (e) { // filho sem registro não pode ficar vivo
        try { killTreeSync(child.pid); waitGone(child.pid, 2000); } catch { /* melhor esforço */ }
        conclude({ trackError: e?.code || e?.message || 'erro' }); return { ok: true, status: 202, record: r, finished };
      }
      activeChild = { pid: child.pid, tracked };
      if (tracked?.pid) { r.prepare = { ...r.prepare, process: { pid: child.pid, recordedAt: now() } }; saveSoft(); } // evidência no PRÓPRIO registro de que o PID foi gravado no child-registry (sem ela, uma queda depois do spawn e antes do registro não é distinguível de "nunca iniciou")
      const timer = setTimeout(() => { state.timedOut = true; try { killTreeSync(child.pid); } catch { /* o 'close' conclui */ } }, prepareTimeoutMs);
      const feed = (chunk) => { state.bytes += chunk.length; state.tail = (state.tail + chunk.toString('utf8')).slice(-PREPARE_TAIL * 2); if (state.bytes > maxOutputBytes && !state.overflow) { state.overflow = true; try { killTreeSync(child.pid); } catch { /* idem */ } } };
      child.stdout?.on('data', feed); child.stderr?.on('data', feed);
      child.on('close', (code) => { clearTimeout(timer); conclude({ exitCode: code }); });
      return { ok: true, status: 202, record: r, finished };
    });
  }

  const link = (id, cycleId) => { const r = get(id); if (!r) return false; r.cycleId = cycleId; audit(r, cycleId ? 'linked' : 'unlinked', { cycleId }); return true; };

  /** Workspace EFETIVO da missão: o worktree do ciclo (quando há) ou o cadastrado. Ciclo com worktree que deixou de ser utilizável => null (falha fechada, nunca o workspace principal). */
  function workspaceFor(m) {
    const ws = db.workspaces.find((w) => w.id === m.workspaceId);
    const id = m.cycle?.worktreeId;
    if (!id || !ws) return ws;
    const r = get(id);
    if (!r || r.workspaceId !== ws.id || !USABLE.includes(r.state) || r.op || !fs.existsSync(r.path)) return null;
    return { ...ws, path: r.path, worktreeId: r.id };
  }

  /** Ambiente de execução das VERIFICAÇÕES REAIS no worktree (só leitura do disco, sem Git, sem rede, sem instalar nada).
   *  O worktree é um checkout frio: `node_modules` e demais arquivos ignorados NÃO acompanham o repositório e nunca são copiados do workspace principal.
   *  Sem dependências declaradas o projeto roda como está; com dependências, só roda se o ambiente foi preparado EXPLICITAMENTE no próprio worktree
   *  (um `node_modules` real, dentro dele, com cada dependência declarada instalada). Caso contrário a verificação é RECUSADA (nunca executada no workspace principal).
   *  Limite honesto: confere a presença das dependências declaradas, não a versão instalada. */
  function environmentFor(id) {
    const r = get(id), no = (code, reason) => ({ ok: false, code, reason });
    if (!r) return no('worktree_unknown', 'o worktree do ciclo não está registrado; a verificação não foi executada (nunca roda no workspace principal)');
    let pkg;
    try { const f = path.join(r.path, 'package.json'); if (!fs.existsSync(f)) return { ok: true, code: 'no_package' }; pkg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { ok: true, code: 'package_unreadable' }; } // o verificador relata package.json ausente/ilegível com a mensagem dele
    const names = (k) => Object.keys(pkg?.[k] && typeof pkg[k] === 'object' && !Array.isArray(pkg[k]) ? pkg[k] : {});
    const required = [...new Set([...names('dependencies'), ...names('devDependencies')])];
    if (!required.length) return { ok: true, code: 'no_dependencies' };
    const how = `Prepare o ambiente de forma explícita, fora do orquestrador: em "${r.path}" instale as dependências do projeto (por exemplo "npm ci --ignore-scripts", que usa a rede) e retome o ciclo. Nada foi copiado do workspace principal e a verificação não foi executada.`;
    const bad = required.find((n) => !NPM_NAME_RE.test(n));
    if (bad) return no('package_invalid', `o package.json declara um nome de dependência inválido ("${clip(bad, 60)}"); a verificação não foi executada.`);
    const nm = path.join(r.path, 'node_modules');
    let st; try { st = fs.lstatSync(nm); } catch { return no('dependencies_not_prepared', `o worktree não tem node_modules (checkout frio), mas o projeto declara ${required.length} dependência(s). ${how}`); }
    if (!st.isDirectory() || st.isSymbolicLink()) return no('node_modules_not_isolated', `o node_modules do worktree não é uma pasta própria dele (link ou arquivo); ele nunca é aceito, para que a verificação não use nem altere o workspace principal. ${how}`);
    const realNm = real(nm), realWt = real(r.path);
    if (!realNm || !realWt || !norm(realNm).startsWith(`${norm(realWt)}/`)) return no('node_modules_not_isolated', `o node_modules do worktree resolve para fora dele; a verificação não foi executada. ${how}`);
    const missing = required.filter((n) => !fs.existsSync(path.join(nm, ...n.split('/'), 'package.json')));
    if (missing.length) return no('dependencies_incomplete', `faltam ${missing.length} dependência(s) no node_modules do worktree (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}). ${how}`);
    return { ok: true, code: 'prepared' };
  }

  // ---------- rastreamento da execução ----------
  function markInUse(id, { round, taskId }) {
    const r = get(id); if (!r || !USABLE.includes(r.state)) return false;
    r.state = 'in_use'; r.current = { round, taskId, at: now() }; audit(r, 'execution_started', { round, taskId }); saveSoft(); return true;
  }
  async function noteRound(id, { round, status, level }) {
    const r = get(id); if (!r) return false;
    const tree = await treeOf(r.path), head = await headOf(r.path);
    r.rounds = [...r.rounds, { n: round, status: clip(status, 30), level: level ?? null, tree, at: now() }].slice(-MAX_ROUNDS);
    r.headCommit = head ?? r.headCommit; r.current = null;
    if (r.state === 'in_use') r.state = 'finished';
    audit(r, 'execution_finished', { round, status, evidence: level ?? null, tree: tree ? tree.slice(0, 12) : null }); saveSoft(); return true;
  }

  /** O laço do ciclo terminou (concluído, bloqueado ou cancelado) com o ambiente ainda "em uso": a execução não vai mais terminar sozinha. O resultado dela é DESCONHECIDO, então vira uma rodada interrompida (nunca evidência). Sem Git; nada é removido. */
  function release(id, reason = 'loop_ended') {
    const r = get(id); if (!r || r.state !== 'in_use') return false;
    const cur = r.current; r.current = null; r.state = 'finished';
    r.rounds = [...r.rounds, { n: cur?.round ?? null, status: 'interrupted', level: 'interrupted', tree: null, at: now() }].slice(-MAX_ROUNDS);
    audit(r, 'execution_released', { round: cur?.round ?? null, reason }); saveSoft(); return true;
  }

  // ---------- avaliação (conflitos + condições de integração) ----------
  /** Só leitura sobre a branch de destino: merge-tree grava objetos, nunca refs, índice ou working tree. */
  async function assess(r) {
    const problems = [], add = (code, message) => problems.push({ code, message });
    const a = { result: 'invalid', problems, concurrent: false, ffPossible: false, overlap: [], conflicts: [], targetHead: null, wtHead: null, mergeTree: null, contentTree: null, evidence: { round: null, level: null, match: false }, digest: null };
    if (!['ready', 'finished'].includes(r.state)) add('state_not_integrable', `o worktree está em "${r.state}"`);
    if (r.op) add('operation_in_progress', `há uma operação em andamento (${r.op.kind})`);
    const c = cycleOf(r); // I2: o ciclo atual OU um anterior da MESMA missão, pela identidade registrada
    if (!c) add('cycle_missing', 'o ciclo que gerou este worktree não está mais ligado à missão');
    else if (c.status !== 'completed' || c.assurance !== 'verified') add('cycle_not_verified', `o ciclo precisa estar concluído com garantia "verified" (estado ${c.status}, garantia ${c.assurance ?? 'nenhuma'})`);
    const insp = await inspect(r); for (const p of insp) add(p.code, p.message);
    const repo = await resolveRepo(r.repoPath, G);
    if (repo.error) add('target_invalid', repo.error);
    else {
      if (repo.branch !== r.baseBranch) add('target_branch_changed', `o workspace principal agora está na branch "${repo.branch}", não em "${r.baseBranch}"`);
      const tgt = await dirtyState(repo.path);
      if (tgt.state === 'dirty') add('target_dirty', 'o workspace principal tem alterações não commitadas; a integração só ocorre com ele limpo');
      else if (tgt.state === 'unknown') add('target_state_unknown', `${unknownText(tgt)}; a integração só ocorre com o workspace principal comprovadamente limpo`);
      a.targetHead = repo.commit;
    }
    if (insp.some((p) => ['path_missing', 'not_a_worktree', 'wrong_repository', 'repo_missing', 'identity'].includes(p.code))) return finish(r, a);
    a.wtHead = await headOf(r.path);
    const wt = await dirtyState(r.path), dirty = wt.state === 'dirty';
    if (dirty) add('uncommitted_changes', 'o worktree tem alterações não commitadas; registre um snapshot antes de integrar');
    else if (wt.state === 'unknown') add('worktree_state_unknown', `${unknownText(wt)}; o conteúdo do worktree não pode ser comprovado`);
    a.contentTree = dirty ? await treeOf(r.path) : wt.state === 'unknown' ? null : ((await G(r.path, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'])).out.trim() || null);
    if (a.wtHead && a.wtHead === r.baseCommit && wt.state === 'clean') add('nothing_to_integrate', 'o worktree não tem nenhuma alteração em relação à base');
    const last = r.rounds.at(-1);
    if (!last) add('evidence_missing', 'nenhuma rodada deste worktree tem evidência registrada');
    else {
      a.evidence = { round: last.n, level: last.level, match: !!last.tree && last.tree === a.contentTree };
      if (last.level !== 'verified') add('evidence_missing', `a última rodada tem evidência "${last.level ?? 'ausente'}", não "verified"`);
      else if (!a.evidence.match && wt.state !== 'unknown') add('evidence_stale', 'o conteúdo do worktree mudou depois da última rodada verificada');
    }
    if (!repo.error && repo.branch === r.baseBranch && a.wtHead && a.targetHead) {
      a.concurrent = a.targetHead !== r.baseCommit;
      a.ffPossible = (await G(repo.path, ['merge-base', '--is-ancestor', a.targetHead, a.wtHead])).code === 0;
      const mt = await G(repo.path, ['merge-tree', '--write-tree', '--no-messages', '--name-only', a.targetHead, a.wtHead]);
      const ls = lines(mt.out);
      if (mt.code === 0 && SHA_RE.test(ls[0] ?? '')) a.mergeTree = ls[0];
      else if (mt.code === 1) { a.conflicts = [...new Set(ls.slice(1))].slice(0, 50); if (SHA_RE.test(ls[0] ?? '')) a.mergeTree = ls[0]; }
      else add('merge_check_failed', `não foi possível calcular a integração: ${clip(mt.err, 160)}`);
      if (a.concurrent) {
        const side = async (to) => new Set(lines((await G(repo.path, ['diff', '--name-only', r.baseCommit, to])).out));
        const [theirs, mine] = [await side(a.targetHead), await side(a.wtHead)];
        a.overlap = [...mine].filter((f) => theirs.has(f)).slice(0, 50);
      }
    }
    return finish(r, a);
  }
  function finish(r, a) {
    a.result = a.conflicts.length ? 'conflict' : a.problems.length || !a.mergeTree ? 'invalid' : 'mergeable';
    if (a.mergeTree && a.result !== 'invalid' || a.result === 'conflict') a.digest = crypto.createHash('sha256').update(JSON.stringify([r.id, r.repoPath, r.baseBranch, a.targetHead, a.wtHead, a.mergeTree, a.contentTree, r.cycleId, r.rounds.at(-1)?.n ?? null])).digest('hex').slice(0, 32);
    return a;
  }
  const attemptOf = (kind, a, extra = {}) => ({ id: store.uid('att'), at: now(), kind, result: a.result, concurrent: a.concurrent, fastForward: a.ffPossible, overlap: a.overlap, conflicts: a.conflicts, problems: a.problems.map((p) => ({ code: p.code, message: clip(p.message, 200) })),
    targetHead: a.targetHead, wtHead: a.wtHead, mergeTree: a.mergeTree, digest: a.result === 'mergeable' ? a.digest : null, evidence: a.evidence, ...extra });
  const keepAttempt = (r, att) => { r.attempts = [...r.attempts, att].slice(-MAX_ATTEMPTS); };

  async function check(id) {
    const r = get(id); if (!r) return fail(404, 'Worktree não encontrado.');
    return withLock(norm(r.repoPath), async () => {
      const a = await assess(r), att = attemptOf('check', a);
      keepAttempt(r, att); audit(r, 'integration_checked', { result: a.result, conflicts: a.conflicts.length, problems: a.problems.map((p) => p.code) }); saveSoft();
      return { ok: true, record: r, attempt: att };
    });
  }

  /** Registra o trabalho do worktree em um commit NA BRANCH DO WORKTREE (nunca na branch de destino). Ação explícita. */
  async function snapshot(id, { message = '' } = {}) {
    const r = get(id); if (!r) return fail(404, 'Worktree não encontrado.');
    return withLock(norm(r.repoPath), async () => {
      if (!['ready', 'finished'].includes(r.state) || r.op) return fail(409, `O worktree está em "${r.state}"${r.op ? ` (operação ${r.op.kind} em andamento)` : ''}; o snapshot só vale com o worktree parado.`);
      const mm = mission(r); if (['planning', 'running'].includes(mm?.cycle?.status)) return fail(409, 'O ciclo desta missão está ativo; aguarde terminar.');
      const problems = await inspect(r); if (problems.length) return fail(409, `O worktree não passou na validação: ${problems.map((p) => p.code).join(', ')}.`);
      const st = await dirtyState(r.path);
      if (st.state === 'unknown') return fail(409, `Snapshot não registrado: ${unknownText(st)}. Nada foi alterado.`);
      if (st.state === 'clean') return fail(409, 'Não há alterações para registrar.');
      if ((await G(r.path, ['add', '-A', '--', '.'])).code !== 0) return fail(500, 'git add falhou no worktree.');
      const text = clip(String(message).replace(/[\r\n]+/g, ' ').trim(), 200) || `Trabalho do ciclo ${r.cycleId ?? ''} (worktree ${r.id})`;
      const c = await G(r.path, ['commit', '--no-verify', '-q', '-m', text], { env: IDENT });
      if (c.code !== 0) return fail(409, `O commit no worktree falhou: ${clip(c.err, 200)}`);
      r.headCommit = await headOf(r.path); audit(r, 'snapshot', { head: r.headCommit?.slice(0, 12) }); saveSoft();
      return { ok: true, record: r };
    });
  }

  // ---------- integração ----------
  async function integrate(id, { digest, authorizedBy = 'user' } = {}) {
    const r = get(id); if (!r) return fail(404, 'Worktree não encontrado.');
    if (typeof digest !== 'string' || !/^[0-9a-f]{32}$/.test(digest)) return fail(400, 'A integração exige a autorização explícita (digest) devolvida por uma checagem recente.');
    return withLock(norm(r.repoPath), async () => {
      const a = await assess(r);
      const refuse = (status, error) => { const att = attemptOf('integrate', a, { outcome: 'refused', refusal: clip(error, 300), authorizedBy }); keepAttempt(r, att); audit(r, 'integration_refused', { reason: error }); saveSoft(); return fail(status, error, { record: r, attempt: att }); };
      if (a.result === 'conflict') return refuse(409, `Integração recusada: há conflitos (${a.conflicts.join(', ') || 'sem lista'}). A branch de destino não foi alterada.`);
      if (a.result !== 'mergeable') return refuse(409, `Integração recusada: ${a.problems.map((p) => p.message).join('; ') || 'estado não integrável'}. A branch de destino não foi alterada.`);
      if (a.digest !== digest) return refuse(409, 'Integração recusada: a autorização não corresponde ao estado atual (algo mudou depois da checagem). Refaça a checagem.');
      if (!r.attempts.some((x) => x.kind === 'check' && x.result === 'mergeable' && x.digest === digest)) return refuse(409, 'Integração recusada: não há checagem registrada com este digest.');
      let newCommit = a.wtHead;
      if (!a.ffPossible) {
        const ct = await G(r.repoPath, ['commit-tree', a.mergeTree, '-p', a.targetHead, '-p', a.wtHead, '-m', `Integra ${r.branch} em ${r.baseBranch} (ciclo ${r.cycleId})`], { env: IDENT });
        if (ct.code !== 0 || !SHA_RE.test(ct.out.trim())) return refuse(409, `Integração recusada: não foi possível montar o commit de integração (${clip(ct.err, 160)}). A branch de destino não foi alterada.`);
        newCommit = ct.out.trim();
      }
      const att = attemptOf('integrate', a, { outcome: 'started', authorizedBy, newCommit });
      r.op = { kind: 'integrate', at: now(), oldHead: a.targetHead, newCommit, branch: r.baseBranch, prevState: r.state }; keepAttempt(r, att); audit(r, 'integration_started', { from: a.targetHead.slice(0, 12), to: newCommit.slice(0, 12) });
      try { store.saveOrThrow(); } catch (e) { r.op = null; r.attempts = r.attempts.filter((x) => x !== att); return fail(503, `O banco não pôde ser gravado (${e?.code || e?.message || 'erro'}); a integração NÃO foi iniciada e a branch de destino não foi alterada.`, { record: r }); }
      const mg = await G(r.repoPath, ['merge', '--ff-only', '--no-edit', newCommit]);
      const head = await headOf(r.repoPath), after = await dirtyState(r.repoPath), dirtyAfter = after.state === 'dirty' ? after.files.length : after.state === 'unknown' ? null : 0; // null = não comprovado
      const prev = r.op.prevState; r.op = null;
      if (head === newCommit && dirtyAfter === 0) { r.state = 'integrated'; r.integratedCommit = newCommit; att.outcome = 'integrated'; audit(r, 'integrated', { commit: newCommit.slice(0, 12) }); saveSoft(); return { ok: true, record: r, attempt: att }; }
      if (head === a.targetHead && dirtyAfter === 0) { att.outcome = 'failed_unchanged'; att.error = clip(mg.err, 300); r.state = prev; audit(r, 'integration_failed_unchanged', { reason: mg.err }); saveSoft(); return fail(409, `A integração falhou e a branch de destino ficou exatamente como estava: ${clip(mg.err, 200)}`, { record: r, attempt: att }); }
      r.state = 'inconsistent'; att.outcome = 'inconsistent'; att.error = clip(mg.err, 300); audit(r, 'integration_inconsistent', { reason: `HEAD ${head?.slice(0, 12) ?? 'ilegível'} fora do esperado; alterações pendentes: ${dirtyAfter ?? `não comprovadas (${after.reason})`}` }); saveSoft();
      return fail(500, 'A integração terminou em um estado INESPERADO da branch de destino; nada foi desfeito automaticamente. Inspecione o repositório antes de qualquer outra ação.', { record: r, attempt: att });
    });
  }

  // ---------- limpeza (só explícita e nunca destrutiva) ----------
  async function cleanup(id) {
    const r = get(id); if (!r) return fail(404, 'Worktree não encontrado.');
    return withLock(norm(r.repoPath), async () => {
      if (r.state === 'removed') return fail(409, 'Este worktree já foi removido.');
      if (['creating', 'in_use'].includes(r.state) || r.op) return fail(409, `O worktree está em uso ou em operação (${r.op?.kind ?? r.state}); nada foi removido.`);
      if (['planning', 'running'].includes(mission(r)?.cycle?.status) && r.cycleId === mission(r)?.cycle?.id) return fail(409, 'O ciclo deste worktree está ativo; nada foi removido.');
      if (!fs.existsSync(r.path)) return fail(409, 'A pasta do worktree não existe; revalide para registrar a inconsistência. Nada foi alterado.');
      const problems = await inspect(r);
      if (problems.length) return fail(409, `O worktree não passou na validação (${problems.map((p) => p.code).join(', ')}); por segurança nada foi removido.`);
      const st = await dirtyState(r.path);
      if (st.state === 'unknown') return fail(409, `${unknownText(st)}; por segurança nada foi removido.`);
      if (st.state === 'dirty') return fail(409, `O worktree tem ${st.files.length} alteração(ões) não commitadas; nada foi removido.`);
      const hp = await probeHead(r.path);
      if (!hp.known) return fail(409, `Não foi possível ler o HEAD do worktree (${hp.reason}); por segurança nada foi removido.`);
      const head = hp.head;
      const tgt = await G(r.repoPath, ['rev-parse', '--verify', '-q', `refs/heads/${r.baseBranch}^{commit}`]);
      if (tgt.failed) return fail(409, `Não foi possível ler a branch de destino (${why(tgt)}); por segurança nada foi removido.`);
      const anc = head && tgt.code === 0 ? await G(r.repoPath, ['merge-base', '--is-ancestor', head, tgt.out.trim()]) : null;
      if (anc?.failed) return fail(409, `Não foi possível comparar o worktree com a branch de destino (${why(anc)}); por segurança nada foi removido.`);
      if (!anc || anc.code !== 0) return fail(409, 'O worktree tem commits NÃO integrados à branch de destino; nada foi removido.');
      r.op = { kind: 'cleanup', at: now(), prevState: r.state }; audit(r, 'cleanup_started');
      try { store.saveOrThrow(); } catch (e) { r.op = null; return fail(503, `O banco não pôde ser gravado (${e?.code || e?.message || 'erro'}); nada foi removido.`); }
      const rm = await G(r.repoPath, ['worktree', 'remove', r.path]); // SEM --force: recusa se houver qualquer alteração
      const prev = r.op.prevState; r.op = null;
      if (rm.code !== 0 && fs.existsSync(r.path)) { r.state = prev; audit(r, 'cleanup_refused', { reason: rm.err }); saveSoft(); return fail(409, `O Git recusou a remoção: ${clip(rm.err, 200)}. Nada foi removido.`, { record: r }); }
      const br = await G(r.repoPath, ['branch', '-d', r.branch]); // -d: só apaga a branch se estiver integrada
      r.state = 'removed'; audit(r, 'removed', { branchDeleted: br.code === 0 }); saveSoft();
      return { ok: true, record: r, branchDeleted: br.code === 0 };
    });
  }

  // ---------- revalidação e recuperação explícitas ----------
  /** Revalida a identidade/estado de UM ambiente. Nunca remove nem corrige nada no Git.
   *  - estado normal: um problema DEFINITIVO marca 'inconsistent'; uma inspeção que o Git não conseguiu concluir NÃO altera o estado (só registra o diagnóstico);
   *  - operação inacabada de um boot em que o Git não respondeu: é conciliada agora, com o mesmo critério do boot;
   *  - 'inconsistent': tenta a recuperação (`reconcile`), que só avança com o Git confirmando identidade e estado. */
  async function revalidate(id) {
    const r = get(id); if (!r) return fail(404, 'Worktree não encontrado.');
    return withLock(norm(r.repoPath), async () => {
      if (r.state === 'removed') return { ok: true, record: r, problems: [] };
      if (r.op) {
        const wasPrepare = r.op.kind === 'prepare', s = await settle(r);
        if (s.unverified) { const code = s.code ?? 'inspection_failed'; diag(r, code, s.unverified); saveSoft(); return { ok: true, record: r, problems: [], inconclusive: true, blocked: { code, reason: s.unverified, inconclusive: true } }; } // nunca declara sucesso com a preparação inconclusiva
        r.diagnostic = null; saveSoft(); return { ok: true, record: r, problems: [], ...(wasPrepare ? { prepareInterrupted: true } : {}) };
      }
      if (r.state === 'creating') return { ok: true, record: r, problems: [] };
      if (r.state === 'inconsistent') return reconcile(r);
      const problems = await inspect(r), unk = unknownOf(problems), definite = problems.filter((p) => !p.inconclusive);
      if (definite.length) { r.state = 'inconsistent'; r.diagnostic = null; audit(r, 'inconsistent', { reason: definite.map((p) => p.code).join(', ') }); saveSoft(); }
      else if (unk) { diag(r, 'inspection_failed', unk); saveSoft(); return { ok: true, record: r, problems, inconclusive: true, blocked: { code: 'inspection_failed', reason: unk, inconclusive: true } }; }
      else if (r.diagnostic) { r.diagnostic = null; saveSoft(); }
      return { ok: true, record: r, problems };
    });
  }
  const diag = (r, code, reason) => { r.diagnostic = { at: now(), code, reason: clip(reason, 300) }; };

  /** Linha de integração conhecida do registro (para conferir no Git): o commit que a integração criou e a ponta do destino de antes. */
  const integrationMarker = (r) => {
    const att = [...(r.attempts ?? [])].reverse().find((x) => x?.kind === 'integrate' && x.newCommit && ['started', 'inconsistent', 'integrated'].includes(x.outcome));
    const newCommit = r.integratedCommit || att?.newCommit || null;
    return newCommit ? { newCommit, oldHead: att?.targetHead ?? null } : null;
  };

  /** Recuperação EXPLÍCITA de um registro 'inconsistent'. Não confia só no banco: o Git real precisa confirmar (1) a identidade do worktree (caminho, repositório, branch, registro e base),
   *  (2) o estado do worktree e (3) quando houve integração, que o destino contém o commit integrado (ou está exatamente onde estava), limpo.
   *  Qualquer dúvida mantém o registro bloqueado com a razão. Nunca apaga branch, pasta nem commit e nunca usa --force. */
  async function reconcile(r) {
    const problems = await inspect(r);
    const block = (code, reason, inconclusive = false) => {
      diag(r, code, reason); r.diagnostic.inconclusive = inconclusive; audit(r, 'recovery_blocked', { reason: `${code}: ${reason}` }); saveSoft();
      return { ok: true, record: r, problems, recovered: false, inconclusive, blocked: { code, reason: clip(reason, 300), inconclusive } };
    };
    const unk = unknownOf(problems);
    if (unk) return block('inspection_failed', unk, true);
    if (problems.length) return block('still_invalid', `o registro continua inválido no Git (${problems.map((p) => p.code).join(', ')}); nada foi alterado`);
    const repo = await resolveRepo(r.repoPath, G);
    if (repo.error) return block(repo.unknown ? 'inspection_failed' : 'target_invalid', repo.error, !!repo.unknown);
    if (repo.branch !== r.baseBranch) return block('target_branch_changed', `o workspace principal está na branch "${repo.branch}", não em "${r.baseBranch}"`);
    const wt = await dirtyState(r.path); if (wt.state === 'unknown') return block('inspection_failed', unknownText(wt), true);
    const hp = await probeHead(r.path); if (!hp.known) return block('inspection_failed', `não foi possível ler o HEAD do worktree (${hp.reason})`, true);
    if (!hp.head) return block('head_unreadable', 'o worktree não tem um HEAD válido');
    let to = null;
    const marker = integrationMarker(r);
    if (marker) {
      if (!SHA_RE.test(marker.newCommit)) return block('integration_unverifiable', 'o commit de integração registrado é inválido');
      const tg = await dirtyState(repo.path);
      if (tg.state === 'unknown') return block('inspection_failed', unknownText(tg), true);
      if (tg.state === 'dirty') return block('target_dirty', 'o workspace principal tem alterações pendentes depois de uma integração incerta; resolva-as manualmente (nada foi alterado)');
      const has = await G(repo.path, ['merge-base', '--is-ancestor', marker.newCommit, repo.commit]);
      if (has.failed) return block('inspection_failed', `não foi possível conferir a integração (${why(has)})`, true);
      if (has.code === 0) to = 'integrated';
      else if (!(marker.oldHead && repo.commit === marker.oldHead)) return block('target_head_unexpected', `o HEAD do destino (${repo.commit.slice(0, 12)}) não contém a integração registrada nem é o anterior a ela; inspecione o repositório`);
    }
    if (!to) to = (r.cycleId || (r.rounds ?? []).length || hp.head !== r.baseCommit || wt.state === 'dirty') ? 'finished' : 'ready';
    const keep = { state: r.state, current: r.current, rounds: r.rounds, integratedCommit: r.integratedCommit, diagnostic: r.diagnostic, history: r.history, updatedAt: r.updatedAt };
    const from = r.state;
    if (r.current) { r.rounds = [...(r.rounds ?? []), { n: r.current.round ?? null, status: 'interrupted', level: 'interrupted', tree: null, at: now() }].slice(-MAX_ROUNDS); r.current = null; } // a execução registrada nunca terminou: sem evidência
    r.state = to; r.diagnostic = null; if (to === 'integrated') r.integratedCommit = marker.newCommit;
    audit(r, 'recovered', { reason: `verificado no Git: de ${from} para ${to}`, from, to });
    try { store.saveOrThrow(); } catch (e) { Object.assign(r, keep); return fail(503, `O banco não pôde ser gravado (${e?.code || e?.message || 'erro'}); o registro continua inconsistente.`, { record: r }); }
    return { ok: true, record: r, problems: [], recovered: true, recoveredTo: to };
  }

  // ---------- recuperação no boot: nunca relança missões, nunca remove nada ----------
  /** Concilia UM registro com o Git real. Devolve { unverified: razão } quando o Git não pôde responder: nesse caso o registro NÃO é alterado (a operação inacabada continua registrada
   *  e o estado fica como estava) e a conciliação pode ser repetida depois (boot seguinte ou revalidação). */
  async function settle(r) {
    if (r.op?.kind === 'create') {
      const problems = await inspect(r), be = await G(r.repoPath, ['rev-parse', '--verify', '-q', `refs/heads/${r.branch}`]);
      const unk = unknownOf(problems) ?? (be.failed ? `não foi possível consultar a branch (${why(be)})` : null);
      if (unk) return { unverified: unk };
      const branchExists = be.code === 0;
      r.op = null;
      if (!problems.length) { r.state = 'ready'; audit(r, 'create_completed_after_restart'); }
      else if (!fs.existsSync(r.path) && !branchExists) { r.state = 'failed'; audit(r, 'create_interrupted_nothing_created'); }
      else { r.state = 'inconsistent'; audit(r, 'create_interrupted_partial', { reason: problems.map((p) => p.code).join(', ') }); }
    } else if (r.op?.kind === 'integrate') {
      const hp = await probeHead(r.repoPath);
      if (!hp.known) return { unverified: `não foi possível ler o HEAD do destino (${hp.reason})` };
      const head = hp.head, op = r.op; r.op = null;
      if (head && head === op.newCommit) { r.state = 'integrated'; r.integratedCommit = op.newCommit; const att = r.attempts.find((x) => x.newCommit === op.newCommit && x.outcome === 'started'); if (att) att.outcome = 'integrated'; audit(r, 'integration_completed_after_restart', { commit: op.newCommit.slice(0, 12) }); }
      else if (head && head === op.oldHead) { r.state = op.prevState ?? 'finished'; const att = r.attempts.find((x) => x.newCommit === op.newCommit && x.outcome === 'started'); if (att) att.outcome = 'interrupted_unchanged'; audit(r, 'integration_interrupted_unchanged'); }
      else { r.state = 'inconsistent'; audit(r, 'integration_interrupted_unknown_head', { reason: `HEAD ${head?.slice(0, 12) ?? 'ilegível'}` }); }
    } else if (r.op?.kind === 'cleanup') {
      const op = r.op; r.op = null;
      if (!fs.existsSync(r.path)) { r.state = 'removed'; audit(r, 'cleanup_completed_after_restart'); }
      else { r.state = op.prevState ?? 'finished'; audit(r, 'cleanup_interrupted_kept'); }
    } else if (r.op?.kind === 'prepare') {
      // E3: preparação interrompida por queda/reinício. O worktree só é liberado se o child-registry (já conferido no boot, ANTES desta conciliação) não tem mais nenhum
      // preparador vivo ou de identidade incerta para ele. Na dúvida, op e bloqueio ficam. A aprovação consumida é preservada e nunca reaproveitada.
      if (preparing === r.id) return { unverified: 'a preparação está em andamento neste servidor; aguarde terminar', code: 'preparation_in_progress' };
      if (!children?.check || children.reclaimed?.() !== true) return { unverified: 'os processos preparadores registrados ainda não foram conferidos; a preparação pode estar em execução', code: 'preparation_inconclusive' };
      const st = children.check(r.id);
      if (st.blocking.length) return { unverified: `o processo preparador (PID ${st.blocking.map((x) => x.pid).join(', ')}) pode ainda estar ativo (${st.blocking.map((x) => x.outcome).join(', ')}); o worktree continua bloqueado e nada foi liberado`, code: 'preparation_inconclusive' };
      const how = children.lastOutcome?.(r.id) ?? st.released[0]?.outcome ?? null, op = r.op;
      // FAIL-CLOSED: a op é gravada ANTES do spawn e o PID só é registrado DEPOIS dele. Sem registro nem marca de PID gravado, o servidor pode ter caído nessa janela com o npm já em execução: ausência de registro NÃO prova que nada foi iniciado.
      if (!r.prepare?.process && !st.released.length && !how) return { unverified: 'não há registro do processo preparador: o servidor pode ter caído depois de iniciar o npm e antes de gravar o PID, então não é possível provar que ele não existe; o worktree continua bloqueado', code: 'preparation_inconclusive' };
      const HOW = { killed: 'o processo preparador foi encerrado no boot', gone: 'o processo preparador já não existia', reused: 'o PID gravado pertencia a outro processo, que não foi tocado' };
      r.prepare = { ...(r.prepare ?? {}), state: 'interrupted', finishedAt: now(), exitCode: null, reason: redactSecrets(`o servidor foi reiniciado durante a preparação (${HOW[how] ?? 'sem registro de processo'}); o resultado não pôde ser comprovado e a aprovação anterior não será reutilizada`) };
      r.op = null; r.state = ['ready', 'finished'].includes(op.prevState) ? op.prevState : 'ready';
      audit(r, 'prepare_interrupted', { reason: r.prepare.reason });
    } else if (r.state === 'in_use') {
      // a execução foi interrompida pela queda: o resultado é DESCONHECIDO; a evidência dessa rodada nunca vale
      const cur = r.current; r.current = null; r.state = 'finished';
      r.rounds = [...r.rounds, { n: cur?.round ?? null, status: 'interrupted', level: 'interrupted', tree: null, at: now() }].slice(-MAX_ROUNDS);
      audit(r, 'execution_interrupted_by_restart', { round: cur?.round ?? null });
    } else if (['ready', 'finished', 'integrated'].includes(r.state)) {
      const problems = await inspect(r), definite = problems.filter((p) => !p.inconclusive), unk = unknownOf(problems);
      if (definite.length) { r.state = 'inconsistent'; audit(r, 'inconsistent', { reason: definite.map((p) => p.code).join(', ') }); } // só o que o Git (ou o disco) provou
      else if (unk) return { unverified: unk }; // o Git não respondeu: não prova nada
    }
    return {};
  }

  async function recover() {
    const out = { settled: [], inconsistent: [], unregistered: [], unverified: [] };
    for (const r of all()) {
      if (r.state === 'removed') continue;
      try {
        const from = r.state, s = await settle(r);
        if (s.unverified) { out.unverified.push({ id: r.id, reason: s.unverified }); diag(r, s.code ?? 'inspection_failed', s.unverified); continue; }
        if (r.diagnostic) r.diagnostic = null;
        if (r.state !== from) out.settled.push({ id: r.id, from, to: r.state });
        if (r.state === 'inconsistent') out.inconsistent.push(r.id);
      } catch (e) { out.inconsistent.push(r.id); try { audit(r, 'recover_error', { reason: e?.message }); } catch { /* informativo */ } }
    }
    if (out.unverified.length) try { store.log('worktree', `Worktrees não verificados no boot porque o Git não respondeu: ${out.unverified.map((u) => u.id).join(', ')} (registros mantidos como estavam; use "revalidar" quando o Git voltar).`); } catch { /* informativo */ }
    // ambientes do orquestrador que o Git conhece e o banco não: só informados
    const known = new Set(all().map((w) => w.branch));
    for (const repoPath of new Set(all().map((w) => w.repoPath))) {
      if (!real(repoPath)) continue;
      const list = await G(repoPath, ['worktree', 'list', '--porcelain']);
      if (list.failed) continue;
      for (const blk of list.out.split(/\r?\n\r?\n/)) {
        const ls = lines(blk), br = ls.find((l) => l.startsWith('branch refs/heads/orch/wt_'))?.slice(18), wt = ls.find((l) => l.startsWith('worktree '))?.slice(9);
        if (br && !known.has(br)) out.unregistered.push({ repoPath, path: wt, branch: br });
      }
    }
    if (out.unregistered.length) try { store.log('worktree', `Worktrees do orquestrador conhecidos pelo Git, mas ausentes do banco: ${out.unregistered.map((u) => u.branch).join(', ')} (nada foi alterado).`); } catch { /* informativo */ }
    saveSoft();
    return out;
  }

  const describe = (r) => ({ id: r.id, missionId: r.missionId, cycleId: r.cycleId, workspaceId: r.workspaceId, path: r.path, branch: r.branch, baseBranch: r.baseBranch, baseCommit: r.baseCommit, headCommit: r.headCommit,
    integratedCommit: r.integratedCommit ?? null, state: r.state, op: r.op ? { kind: r.op.kind, at: r.op.at } : null, current: r.current, baseDirty: !!r.baseDirty, diagnostic: r.diagnostic ?? null, prepare: r.prepare ? { ...r.prepare, reason: r.prepare.reason == null ? null : redactSecrets(r.prepare.reason), outputTail: r.prepare.outputTail == null ? r.prepare.outputTail : redactSecrets(r.prepare.outputTail) } : null, rounds: (r.rounds ?? []).slice(-5), attempts: (r.attempts ?? []).slice(-5), history: (r.history ?? []).slice(-20), createdAt: r.createdAt, updatedAt: r.updatedAt });
  const list = ({ missionId = null } = {}) => all().filter((r) => !missionId || r.missionId === missionId).map(describe);

  return { create, ensureFor, planPrepare: planPrepareFor, prepare, killActiveSync, link, get, list, describe, workspaceFor, environmentFor, markInUse, noteRound, release, check, snapshot, integrate, cleanup, revalidate, recover, inspect };
}

// ---------- API ----------
export function setupWorktrees(app, { db, manager }) {
  const reply = (res, ok, extra = () => ({})) => (r) => (r.ok ? res.status(ok).json({ ...extra(r), worktree: manager.describe(r.record) }) : res.status(r.status).json({ error: r.error, ...(r.record ? { worktree: manager.describe(r.record) } : {}), ...(r.attempt ? { attempt: r.attempt } : {}) }));
  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
  app.get('/api/worktrees', (req, res) => res.json(manager.list({ missionId: typeof req.query.missionId === 'string' ? req.query.missionId : null })));
  app.get('/api/worktrees/:id', (req, res) => { const r = manager.get(req.params.id); return r ? res.json(manager.describe(r)) : res.status(404).json({ error: 'Worktree não encontrado.' }); });
  app.post('/api/worktrees/:id/check', asyncRoute(async (req, res) => reply(res, 200, (r) => ({ attempt: r.attempt }))(await manager.check(req.params.id))));
  app.post('/api/worktrees/:id/snapshot', asyncRoute(async (req, res) => reply(res, 200)(await manager.snapshot(req.params.id, { message: body(req).message }))));
  app.post('/api/worktrees/:id/integrate', asyncRoute(async (req, res) => reply(res, 200, (r) => ({ attempt: r.attempt }))(await manager.integrate(req.params.id, { digest: body(req).digest, authorizedBy: 'user' }))));
  app.post('/api/worktrees/:id/cleanup', asyncRoute(async (req, res) => reply(res, 200, (r) => ({ branchDeleted: r.branchDeleted }))(await manager.cleanup(req.params.id))));
  // E1: somente leitura (nada é gravado nem executado); devolve o plano e o digest, ou a recusa com o código e o motivo.
  app.post('/api/worktrees/:id/prepare/plan', asyncRoute(async (req, res) => {
    const r = await manager.planPrepare(req.params.id);
    if (r.ok) return res.json({ plan: r.plan, digest: r.digest, notes: r.notes });
    return res.status(r.status).json({ error: r.error, ...(r.code ? { code: r.code } : {}) });
  }));
  // E2: só o digest do plano vem do cliente; comando, argumentos, caminho e ambiente são do servidor. 202 = processo iniciado e registrado (o resultado fica em worktree.prepare).
  app.post('/api/worktrees/:id/prepare', asyncRoute(async (req, res) => {
    const r = await manager.prepare(req.params.id, { digest: body(req).digest });
    if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.record ? { worktree: manager.describe(r.record) } : {}) });
    return res.status(202).json({ started: true, worktree: manager.describe(r.record) });
  }));
  app.post('/api/worktrees/:id/revalidate', asyncRoute(async (req, res) => reply(res, 200, (r) => ({ problems: r.problems, recovered: !!r.recovered, recoveredTo: r.recoveredTo ?? null, inconclusive: !!r.inconclusive, blocked: r.blocked ?? null }))(await manager.revalidate(req.params.id))));
}
