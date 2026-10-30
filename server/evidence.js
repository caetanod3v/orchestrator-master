// Evidência independente do que o Executor diz ter feito (M8).
//
// Separa três coisas que antes se misturavam:
//   relato do Executor  : o que ele DECLARA (status, resumo, checks próprios). Não é prova.
//   verificado pelo sistema: verificações reais (verify.js), arquivos esperados conferidos no disco e integridade dos arquivos que VALIDAM o trabalho
//                          (testes e configuração), comparada por CONTEÚDO (sha256) com um estado de referência aprovado, nunca pela declaração do Executor.
//   nível               : verified | failed | inconclusive, com motivos objetivos. Só "verified" conclui uma etapa de plano.
//
// Integridade: o Executor pode editar arquivos; se mexer em testes ou configuração de validação, uma verificação real que passe NÃO prova mais nada, porque ele
// pode ter enfraquecido o que é verificado. Os nomes de arquivo só SELECIONAM o que vigiar (testes, configs, o que o script aprovado referencia); a detecção da mudança
// é por hash do conteúdo (criado, modificado, apagado), então vale também para um arquivo que já estava sujo no Git. Mudanças legítimas continuam possíveis: ficam
// pendentes até uma pessoa revisá-las (cycle.resume com approveIntegrity), e a revisão é ligada ao conteúdo exato que foi revisado.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_SCAN = 20000;       // arquivos visitados no máximo (acima disso o instantâneo é incompleto e a integridade vira "inconclusiva")
export const MAX_SENSITIVE = 500;    // arquivos vigiados no máximo
export const MAX_HASH_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 12;
export const MAX_EXPECTED = 8;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', '.turbo', '__pycache__', '.venv', 'venv', 'target']);

const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e|__mocks__|cypress|playwright)\//i;
const TEST_FILE = /[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$|_test\.go$/i;
const CONFIG_FILE = /(^|\/)(package\.json|jest\.config\.[^/]+|vitest\.config\.[^/]+|\.mocharc[^/]*|karma\.conf\.[^/]+|playwright\.config\.[^/]+|cypress\.config\.[^/]+|tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[^/]+|\.babelrc[^/]*|babel\.config\.[^/]+|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|noxfile\.py|Makefile|\.npmrc|\.nycrc[^/]*|\.c8rc[^/]*|\.gitlab-ci\.yml)$|(^|\/)\.github\/workflows\//i;
export const CATEGORY_LABEL = { test: 'arquivo de teste', config: 'configuração de validação', referenced: 'arquivo usado pelo script de verificação aprovado' };

const norm = (p) => p.split(path.sep).join('/');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Categoria de um caminho relativo (só seleciona o que vigiar; quem detecta mudança é o hash). */
export function categoryOf(rel) {
  if (CONFIG_FILE.test(rel)) return 'config';
  if (TEST_DIR.test(rel) || TEST_FILE.test(rel)) return 'test';
  return null;
}

/** Caminho relativo seguro para "arquivo esperado": dentro do workspace, sem `..`, absoluto, unidade, coringa nem diretórios internos. Devolve o caminho normalizado ou null. */
export function safeRelPath(p) {
  if (typeof p !== 'string') return null;
  const s = p.trim().replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 200 || /[\u0000-\u001f*?<>|"]/.test(s) || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split('/').filter((x) => x !== '.' && x !== '');
  if (!parts.length || parts.some((x) => x === '..') || parts[0] === '.git') return null;
  return parts.join('/');
}

/** Caminhos do workspace que o texto de um script aprovado referencia (arquivo ou diretório existente): o que o script executa é tão sensível quanto os testes. */
function referencedPaths(root, commands) {
  const refs = new Set();
  for (const cmd of commands) {
    for (const raw of String(cmd ?? '').split(/[\s;&|]+/)) {
      const t = raw.replace(/^["'`]+|["'`]+$/g, '');
      if (!t || t.startsWith('-') || /^[a-z]+:\/\//i.test(t)) continue;
      const rel = safeRelPath(t); if (!rel) continue;
      try { if (fs.existsSync(path.join(root, rel))) refs.add(rel); } catch { /* ignora */ }
    }
  }
  return refs;
}

function hashFile(abs, st) {
  try { return st.size <= MAX_HASH_BYTES ? sha(fs.readFileSync(abs)) : `big:${st.size}:${Math.round(st.mtimeMs)}`; } catch { return null; }
}

/**
 * Instantâneo do que vigiar (síncrono e limitado). `files`: { rel: { h: sha256, cat } } dos arquivos de teste/configuração/referenciados;
 * `expected`: { rel: { exists, size, h } } dos arquivos que a etapa deve produzir. `complete=false` quando algum limite foi excedido ou a leitura falhou
 * (então nada pode ser afirmado sobre a integridade).
 */
export function snapshotWorkspace(root, { commands = [], expected = [] } = {}) {
  const refs = referencedPaths(root, commands);
  const files = {};
  let scanned = 0, complete = true;
  const isRef = (rel) => { for (const r of refs) if (rel === r || rel.startsWith(`${r}/`)) return true; return false; };
  const stack = [['', 0]];
  while (stack.length && complete) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { if (dir === '') complete = false; continue; }
    for (const e of entries) {
      if (++scanned > MAX_SCAN) { complete = false; break; }
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // nunca segue link para fora do workspace
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && depth < MAX_DEPTH) stack.push([rel, depth + 1]); continue; }
      if (!e.isFile()) continue;
      const cat = categoryOf(rel) ?? (isRef(rel) ? 'referenced' : null);
      if (!cat) continue;
      if (Object.keys(files).length >= MAX_SENSITIVE) { complete = false; break; }
      const abs = path.join(root, rel);
      let st; try { st = fs.statSync(abs); } catch { complete = false; continue; }
      const h = hashFile(abs, st);
      if (h === null) complete = false; else files[rel] = { h, cat };
    }
  }
  const exp = {};
  for (const raw of expected) {
    const rel = safeRelPath(raw); if (!rel) continue;
    const abs = path.join(root, rel);
    try {
      const l = fs.lstatSync(abs);
      const real = l.isSymbolicLink() ? null : fs.realpathSync(abs), base = fs.realpathSync(root);
      const inside = real && (real === base || real.startsWith(base + path.sep));
      exp[rel] = l.isFile() && inside ? { exists: true, size: l.size, h: hashFile(abs, l) } : { exists: false, size: 0, h: null, notFile: true };
    } catch { exp[rel] = { exists: false, size: 0, h: null }; }
  }
  return { at: new Date().toISOString(), complete, scanned, files, expected: exp };
}

/** Só os hashes (o que fica gravado no ciclo como estado de referência). */
export const hashesOf = (snap) => Object.fromEntries(Object.entries(snap.files).map(([k, v]) => [k, v.h]));

/** Diferença entre dois mapas { rel: hash } (ou { rel: {h} }): arquivos criados, modificados e apagados. */
export function diffHashes(a = {}, b = {}) {
  const h = (x) => (x && typeof x === 'object' ? x.h : x);
  const out = [];
  for (const k of Object.keys(b)) { if (!(k in a)) out.push({ path: k, change: 'created', hash: h(b[k]) }); else if (h(a[k]) !== h(b[k])) out.push({ path: k, change: 'modified', hash: h(b[k]) }); }
  for (const k of Object.keys(a)) if (!(k in b)) out.push({ path: k, change: 'deleted', hash: null });
  return out.sort((x, y) => x.path.localeCompare(y.path)).map((c) => ({ ...c, category: categoryOf(c.path) ?? 'referenced' }));
}

/** Arquivos esperados: precisam existir, não vazios e ter sido CRIADOS ou ALTERADOS (hash diferente do instantâneo anterior). Sem instantâneo anterior usa `prior` (resultado anterior). */
export function checkExpected(expected, before, after, prior = []) {
  return expected.map((p) => {
    const rel = safeRelPath(p) ?? String(p);
    const a = after?.expected?.[rel], b = before?.expected?.[rel], old = prior.find((x) => x.path === rel);
    if (!a) return { path: rel, ok: false, exists: false, changed: false, reason: 'o estado do arquivo não pôde ser lido' };
    if (!a.exists) return { path: rel, ok: false, exists: false, changed: false, reason: a.notFile ? 'o caminho não é um arquivo regular dentro do workspace' : 'o arquivo não existe' };
    if (a.size === 0) return { path: rel, ok: false, exists: true, changed: false, reason: 'o arquivo está vazio' };
    // Sem instantâneo anterior (re-verificação) vale o resultado anterior; sem nenhum, "alterado" é desconhecido (null) e só a existência é conferida.
    const changed = before ? !b || !b.exists || b.h !== a.h : (old ? old.changed : null);
    return changed === false ? { path: rel, ok: false, exists: true, changed: false, size: a.size, hash: a.h, reason: 'o arquivo já existia e não foi criado nem alterado por esta etapa' } : { path: rel, ok: true, exists: true, changed, size: a.size, hash: a.h };
  });
}

/**
 * Evidência de uma rodada, calculada SÓ de dados gravados (relatório, resultado das verificações reais, arquivos esperados e integridade): pode ser
 * recalculada depois (re-verificação, revisão humana) sem repetir nada.
 * @returns {{level:'verified'|'failed'|'inconclusive', basis:string, reasons:string[], executorClaim:object, system:object}}
 */
export function buildEvidence({ report, verification, configured = 0, expectedResults = null, integrity = null }) {
  const checks = report?.checks ?? [];
  const claim = { status: report?.status ?? 'unknown', pass: checks.filter((c) => c.result === 'pass').length, fail: checks.filter((c) => c.result === 'fail').length, notRun: checks.filter((c) => c.result === 'not_run').length, note: 'relato do Executor: não é prova de conclusão' };
  const vs = (report?.verifications ?? []).map((v) => ({ script: v.script, status: v.status, required: !!v.required }));
  const system = { verification, verifications: vs, expectedFiles: expectedResults, integrity: integrity?.status ?? 'unknown' };
  const failed = [], inconclusive = [];
  if (report?.status !== 'success') failed.push(`a execução não foi bem-sucedida (${report?.status ?? 'sem relatório'})`);
  if (claim.fail > 0) failed.push('o próprio Executor reportou verificação sua com falha');
  if (verification === 'failed') failed.push(`verificação real reprovada: ${vs.filter((v) => v.status !== 'pass').map((v) => `${v.script}=${v.status}`).join(', ') || 'sem detalhes'}`);
  else if (verification === 'blocked') failed.push('verificação real bloqueada (ambiente ou aprovação): não é evidência');
  else if (verification === 'skipped') inconclusive.push(`verificação real não concluída: ${report?.verificationsInterrupted || report?.verificationsSkipped || (configured ? 'resultado ausente' : 'não executada')}`);
  if (expectedResults) for (const r of expectedResults) if (!r.ok) failed.push(`arquivo esperado "${r.path}": ${r.reason}`);
  if (integrity?.status === 'flagged') inconclusive.push(`testes ou configuração de validação foram alterados e ainda não foram revisados (${(integrity.pending ?? []).slice(0, 5).map((c) => `${c.path} ${c.change === 'created' ? 'criado' : c.change === 'deleted' ? 'apagado' : 'modificado'}`).join('; ')}${(integrity.pending ?? []).length > 5 ? '; …' : ''}): uma verificação que passa sobre testes alterados pelo Executor não prova a conclusão`);
  else if (integrity?.status === 'unknown') inconclusive.push(`integridade dos testes não verificável: ${integrity.reason ?? 'instantâneo do workspace indisponível'}`);
  const hasReal = verification === 'passed', hasFiles = !!expectedResults?.length && expectedResults.every((r) => r.ok);
  const basis = hasReal && hasFiles ? 'real_verification+expected_files' : hasReal ? 'real_verification' : hasFiles ? 'expected_files' : 'executor_claim_only';
  if (!hasReal && !hasFiles && !failed.length && !inconclusive.length) inconclusive.push('sem verificação real configurada nem arquivos esperados: só há o relato do Executor, que não é prova');
  const level = failed.length ? 'failed' : inconclusive.length ? 'inconclusive' : 'verified';
  return { level, basis, reasons: [...failed, ...inconclusive], executorClaim: claim, system };
}

// ---------- critérios de aceitação ----------
const STOP = new Set('a o as os um uma de da do das dos e em no na nos nas ao aos para por com sem que se foi fica ficou esta estao esta ser sao deve devem tudo todo toda todos todas tarefa tarefas etapa etapas codigo projeto sistema funcionalidade implementacao resultado requisitos requisito corretamente devidamente totalmente bem erros erro problemas problema conforme solicitado solicitada pedido pedida esperado esperada atende atender atendem funciona funcionam funcionando concluida concluido concluidas concluidos pronta pronto prontos prontas ok feito feita feitos feitas terminada terminado finalizada finalizado implementada implementado completo completa certo correto correta cumpre cumprir objetivo funcional'.split(' '));
const plain = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const FILELIKE = /[\w-]+\.[a-z0-9]{1,6}\b|\//i;

/** Um critério de aceitação é verificável? Rejeita vazio, curto demais e genérico ("funciona", "tarefa concluída"). Devolve o motivo ou null. A suficiência semântica real vem da evidência do sistema, não do texto. */
export function criterionProblem(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'está vazio';
  const words = plain(t).replace(/[^a-z0-9._/\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const substantive = words.filter((w) => !STOP.has(w));
  if (FILELIKE.test(t) || /`[^`]+`/.test(t)) return null;
  if (substantive.length < 2) return 'é genérico demais para ser verificado (diga o que deve existir ou mudar: arquivo, conteúdo, comportamento observável)';
  return null;
}

/** Cada etapa precisa de um caminho para evidência INDEPENDENTE: verificações reais configuradas no workspace ou arquivos esperados que o sistema confere. */
export function evidencePathProblem(steps, workspace) {
  if ((workspace?.verifications ?? []).length) return null;
  const bare = steps.filter((s) => !(s.expectedFiles?.length));
  return bare.length
    ? `o workspace não tem verificações reais configuradas e as etapas ${bare.map((s) => `"${s.id}"`).join(', ')} não declaram "expectedFiles": nada independente do Executor poderia comprovar a conclusão. Informe os arquivos que cada etapa deve criar ou alterar, ou peça (clarify/blocked) que as verificações do workspace sejam configuradas`
    : null;
}
