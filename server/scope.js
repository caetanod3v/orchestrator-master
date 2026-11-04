// Escopo autorizado de uma rodada x o que mudou DE FATO (hash do conteúdo). Complementa a política (policy.js), que só avalia o escopo DECLARADO da etapa: o Executor tem
// ferramentas de edição de arquivos e nada impede, em execução, que ele mexa num arquivo sensível ou de segredo que a etapa não declarou. Aqui isso é detectado DEPOIS da rodada.
//
// Só as categorias que a política trata como sensíveis (arquivos que mudam o que o projeto instala/executa) e de segredo são vigiadas, por HASH: o conteúdo nunca é lido para
// fora desta função nem gravado (para segredos, só o nome do arquivo e o tipo de mudança aparecem). Um arquivo comum fora do escopo NÃO é desvio (o comportamento atual é mantido).
//
// Autorizado = arquivos declarados em expectedFiles da etapa + os arquivos que uma aprovação humana concedida para ESSA ação cobriu (subjects das regras sensitive_files/secret_files).
// Uma simples menção a um arquivo no texto da etapa NÃO autoriza nada.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MAX_SCAN, MAX_HASH_BYTES, SKIP_DIRS, safeRelPath } from './evidence.js';
import { isSecretPath, isSensitivePath } from './policy.js';

const MAX_DEPTH = 12, MAX_WATCHED = 500;

const kindOf = (rel) => (isSecretPath(rel) ? 'secret' : isSensitivePath(rel) ? 'sensitive' : null);
const hashOf = (abs, st) => { try { return st.size <= MAX_HASH_BYTES ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : `big:${st.size}:${Math.round(st.mtimeMs)}`; } catch { return null; } };

/** Instantâneo { complete, files: { rel: { h, kind } } } dos arquivos sensíveis/de segredo do workspace (síncrono, limitado, sem seguir links). null se o workspace não pôde ser lido. */
export function scopeSnapshot(root) {
  try {
    const files = {}; let scanned = 0, complete = true;
    const stack = [['', 0]];
    while (stack.length && complete) {
      const [dir, depth] = stack.pop();
      let entries;
      try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { if (dir === '') return null; complete = false; continue; }
      for (const e of entries) {
        if (++scanned > MAX_SCAN) { complete = false; break; }
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && depth < MAX_DEPTH) stack.push([rel, depth + 1]); continue; }
        if (!e.isFile()) continue;
        const kind = kindOf(rel); if (!kind) continue;
        if (Object.keys(files).length >= MAX_WATCHED) { complete = false; break; }
        const abs = path.join(root, rel); let st; try { st = fs.statSync(abs); } catch { complete = false; continue; }
        const h = hashOf(abs, st); if (h === null) complete = false; else files[rel] = { h, kind };
      }
    }
    return { complete, files };
  } catch { return null; }
}

/**
 * Compara antes e depois contra o escopo autorizado.
 * @returns {{status:'clean'|'exceeded'|'unknown', files:{path:string, change:'created'|'modified'|'deleted', category:'secret'|'sensitive'}[], changed:number, authorized:string[], reason?:string}}
 *   `files` = SÓ os desvios (fora do escopo), sem conteúdo. `unknown` = não foi possível ver tudo: nunca se afirma que não houve desvio.
 */
export function scopeCheck({ before, after, expected = [], approvedSubjects = [] }) {
  const authorized = [...new Set([...expected, ...approvedSubjects].map((p) => safeRelPath(String(p ?? '').replace(/^\.\//, ''))).filter(Boolean))].sort();
  if (!before || !after) return { status: 'unknown', files: [], changed: 0, authorized, reason: 'não foi possível ler o workspace antes e depois da execução' };
  if (!before.complete || !after.complete) return { status: 'unknown', files: [], changed: 0, authorized, reason: 'o workspace tem arquivos demais (ou ilegíveis) para vigiar os arquivos sensíveis com segurança' };
  const allowed = new Set(authorized), changes = [];
  for (const [p, v] of Object.entries(after.files)) { if (!(p in before.files)) changes.push({ path: p, change: 'created', category: v.kind }); else if (before.files[p].h !== v.h) changes.push({ path: p, change: 'modified', category: v.kind }); }
  for (const [p, v] of Object.entries(before.files)) if (!(p in after.files)) changes.push({ path: p, change: 'deleted', category: v.kind });
  const out = changes.filter((c) => !allowed.has(c.path)).sort((a, b) => a.path.localeCompare(b.path));
  return { status: out.length ? 'exceeded' : 'clean', files: out.slice(0, 50), changed: changes.length, authorized };
}
