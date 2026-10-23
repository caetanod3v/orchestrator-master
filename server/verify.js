// Verificações REAIS (testes/build/lint) executadas pelo BACKEND no workspace autorizado.
// O modelo continua sem shell: a evidência vem de um processo que o servidor iniciou e mediu.
//
// Regras fixas (nada disso vem do cliente nem do agente):
//  - só `npm run <script>` com <script> em ALLOWED_SCRIPTS e aprovado por um humano em Workspaces;
//  - o texto do script é fixado na aprovação: se o package.json mudar, a verificação NÃO roda;
//  - sem shell na nossa chamada (node + npm-cli.js), cwd = raiz do workspace validado, sem hooks pre/post;
//  - ambiente sem segredos, timeout, limite de saída e encerramento da árvore de processos.
// Limite honesto: `npm run` executa código do projeto (inclusive o que o Executor editou).
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { validateDir } from './workspaces.js';
import * as store from './store.js';

export const ALLOWED_SCRIPTS = ['test', 'build', 'lint', 'typecheck'];
export const MAX_ITEMS = 4;
export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PKG_BYTES = 1_000_000;
const TAIL_CHARS = 4000;
const SECRET_ENV = /key|token|secret|passw|credential|auth/i;

const inside = (root, p) => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
export const isInside = inside;

/** Lê SÓ o package.json da raiz do workspace (sem seguir link para fora) e devolve os scripts de texto. */
export function inspectProject(root) {
  const file = path.join(root, 'package.json');
  try {
    if (!fs.existsSync(file)) return { ok: false, error: 'O workspace não tem package.json na raiz.' };
    const real = fs.realpathSync(file);
    if (!inside(fs.realpathSync(root), real)) return { ok: false, error: 'package.json aponta para fora do workspace.' };
    if (fs.statSync(real).size > MAX_PKG_BYTES) return { ok: false, error: 'package.json grande demais.' };
    const json = JSON.parse(fs.readFileSync(real, 'utf8'));
    const scripts = {};
    for (const [k, v] of Object.entries(json.scripts && typeof json.scripts === 'object' ? json.scripts : {})) if (typeof v === 'string') scripts[k] = v;
    return { ok: true, scripts };
  } catch (e) { return { ok: false, error: `package.json inválido: ${e.message}` }; }
}

export function resolveNpmCli() {
  const bin = path.dirname(process.execPath);
  return [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => fs.existsSync(p)) || null;
}

const defaultSpec = (script) => {
  const cli = resolveNpmCli();
  // --ignore-scripts: não roda pre/post hooks (scripts não aprovados); o script pedido roda normalmente.
  return cli ? { command: process.execPath, args: [cli, 'run', script, '--ignore-scripts'] } : null;
};

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) env[k] = v;
  return { ...env, CI: '1', NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
}

function killTree(child) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    else { child.kill('SIGKILL'); resolve(); }
  });
}

/** `spawnSpec` só existe para os testes; o servidor usa sempre o npm real. */
export function createVerifier({ timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = 256 * 1024, spawnSpec = defaultSpec } = {}) {
  let active = null;

  async function run(workspace, item) {
    const script = item?.script;
    const base = { id: item?.id ?? script, script, required: !!item?.required, command: `npm run ${script}`, source: 'backend' };
    const stop = (status, reason, extra = {}) => ({ ...base, status, reason, exitCode: null, durationMs: 0, outputTail: '', truncated: false, ...extra });
    if (active) return stop('error', 'Outra verificação já está em andamento.');
    if (!ALLOWED_SCRIPTS.includes(script)) return stop('blocked', `O script "${script}" não está na lista permitida.`);
    const v = validateDir(workspace?.path);
    if (!v.ok) return stop('error', `Workspace inválido: ${v.error}`);
    const proj = inspectProject(v.path);
    if (!proj.ok) return stop('error', proj.error);
    if (proj.scripts[script] === undefined) return stop('blocked', `O script "${script}" não existe mais no package.json.`);
    if (proj.scripts[script] !== item.command) return stop('blocked', 'O script mudou desde a aprovação humana; aprove novamente em Workspaces.');
    const spec = spawnSpec(script);
    if (!spec) return stop('error', 'npm não foi encontrado junto ao Node.');

    const limit = Math.min(Math.max(Number(item.timeoutMs) || timeoutMs, 1000), 600_000);
    const t0 = Date.now();
    const state = { cancelled: false, timedOut: false, overflow: false, bytes: 0, tail: '' };
    let child;
    try {
      child = spawn(spec.command, spec.args, { cwd: v.path, shell: false, windowsHide: true, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return stop('error', `Falha ao iniciar o processo: ${e.message}`); }
    active = { child, state };

    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { state.timedOut = true; killTree(child); }, limit);
      const feed = (chunk) => {
        state.bytes += chunk.length;
        state.tail = (state.tail + chunk.toString('utf8')).slice(-TAIL_CHARS);
        if (state.bytes > maxOutputBytes && !state.overflow) { state.overflow = true; killTree(child); }
      };
      child.stdout.on('data', feed); child.stderr.on('data', feed);
      const finish = (exitCode, spawnError) => {
        if (done) return; done = true; clearTimeout(timer); active = null;
        child.removeAllListeners(); child.stdout.removeAllListeners(); child.stderr.removeAllListeners(); child.on('error', () => {});
        const res = { ...base, exitCode, durationMs: Date.now() - t0, outputTail: state.tail.trim(), truncated: state.bytes > TAIL_CHARS, outputBytes: state.bytes };
        if (spawnError) return resolve({ ...res, status: 'error', reason: `Falha ao iniciar: ${spawnError.message}` });
        if (state.cancelled) return resolve({ ...res, status: 'cancelled', reason: 'Verificação cancelada.' });
        if (state.timedOut) return resolve({ ...res, status: 'timeout', reason: `Tempo máximo excedido (${Math.round(limit / 1000)} s).` });
        if (state.overflow) return resolve({ ...res, status: 'output_limit', reason: `A saída excedeu ${maxOutputBytes} bytes; processo encerrado.` });
        resolve(exitCode === 0 ? { ...res, status: 'pass', reason: null } : { ...res, status: 'fail', reason: `Terminou com código ${exitCode}.` });
      };
      child.on('error', (e) => finish(null, e));
      child.on('close', (code) => finish(code));
    });
  }

  async function stopActive() {
    if (!active) return { stopped: false, detail: 'Nenhuma verificação ativa.' };
    const a = active; a.state.cancelled = true;
    await killTree(a.child);
    for (let i = 0; i < 50 && active === a; i++) await new Promise((r) => setTimeout(r, 100));
    return active === a ? { stopped: false, detail: 'O processo não confirmou o encerramento.' } : { stopped: true, detail: 'Verificação interrompida.' };
  }

  return { run, stop: stopActive, isBusy: () => !!active };
}

/** Rotas de aprovação humana das verificações de um workspace. O servidor lê o package.json; o cliente só escolhe nomes. */
export function setupVerification(app, { db, verifier }) {
  const find = (id) => db.workspaces.find((w) => w.id === id);
  const bad = (res, code, msg) => res.status(code).json({ error: msg });

  app.get('/api/workspaces/:id/verifications', (req, res) => {
    const ws = find(req.params.id);
    if (!ws) return bad(res, 404, 'Workspace não encontrado.');
    const v = validateDir(ws.path);
    const proj = v.ok ? inspectProject(v.path) : { ok: false, error: v.error };
    const configured = ws.verifications || [];
    res.json({
      npmAvailable: !!resolveNpmCli(), allowed: ALLOWED_SCRIPTS, error: proj.ok ? null : proj.error, configured,
      detected: proj.ok ? ALLOWED_SCRIPTS.filter((s) => proj.scripts[s] !== undefined).map((s) => {
        const c = configured.find((x) => x.script === s);
        return { script: s, command: proj.scripts[s], approved: !!c, required: !!c?.required, changedSinceApproval: !!c && c.command !== proj.scripts[s] };
      }) : [],
    });
  });

  app.put('/api/workspaces/:id/verifications', (req, res) => {
    const ws = find(req.params.id);
    if (!ws) return bad(res, 404, 'Workspace não encontrado.');
    if (db.missions.some((m) => m.workspaceId === ws.id && m.cycle && ['planning', 'running'].includes(m.cycle.status))) return bad(res, 409, 'Há um ciclo ativo neste workspace; aguarde ou cancele antes de alterar as verificações.');
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length > MAX_ITEMS) return bad(res, 400, `"items" deve ser uma lista de até ${MAX_ITEMS} itens.`);
    const v = validateDir(ws.path);
    if (!v.ok) return bad(res, 409, `Workspace inválido: ${v.error}`);
    const proj = inspectProject(v.path);
    if (!proj.ok) return bad(res, 409, proj.error);
    const out = []; const seen = new Set();
    for (const it of items) {
      if (!it || typeof it !== 'object' || typeof it.script !== 'string' || !ALLOWED_SCRIPTS.includes(it.script)) return bad(res, 400, `Script não permitido. Permitidos: ${ALLOWED_SCRIPTS.join(', ')}.`);
      if (seen.has(it.script)) return bad(res, 400, `Script repetido: ${it.script}.`);
      if (proj.scripts[it.script] === undefined) return bad(res, 400, `O script "${it.script}" não existe no package.json.`);
      let timeoutMs = DEFAULT_TIMEOUT_MS;
      if (it.timeoutSec !== undefined) { if (!Number.isInteger(it.timeoutSec) || it.timeoutSec < 10 || it.timeoutSec > 600) return bad(res, 400, 'timeoutSec deve ser inteiro entre 10 e 600.'); timeoutMs = it.timeoutSec * 1000; }
      seen.add(it.script);
      // o texto do script vem do disco (servidor), nunca do cliente
      out.push({ id: it.script, script: it.script, command: proj.scripts[it.script], required: it.required === true, timeoutMs, approvedAt: store.now() });
    }
    ws.verifications = out;
    store.log('workspace', `Verificações reais do workspace "${ws.name}": ${out.map((x) => `${x.script}${x.required ? '*' : ''}`).join(', ') || 'nenhuma'}`, { workspaceId: ws.id });
    store.save();
    res.json(ws.verifications);
  });
  return { verifier };
}
