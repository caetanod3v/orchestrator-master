import fs from 'node:fs';
import path from 'node:path';

// Validação básica: caminho absoluto, existente, diretório, legível. Nada é executado.
export function validateDir(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Informe um caminho.' };
  const p = input.trim().replace(/^"|"$/g, '');
  if (!path.isAbsolute(p)) return { ok: false, error: 'O caminho deve ser absoluto.' };
  if (p.startsWith('\\')) return { ok: false, error: 'Caminhos de rede (UNC) não são permitidos.' };
  const resolved = path.resolve(p);
  if (path.parse(resolved).root === resolved) return { ok: false, error: 'Não é permitido registrar a raiz de um disco.' };
  let st;
  try { st = fs.statSync(resolved); } catch { return { ok: false, error: 'Diretório não existe.' }; }
  if (!st.isDirectory()) return { ok: false, error: 'O caminho não é um diretório.' };
  try { fs.accessSync(resolved, fs.constants.R_OK); } catch { return { ok: false, error: 'Sem permissão de leitura.' }; }
  return {
    ok: true,
    path: resolved,
    hasGit: fs.existsSync(path.join(resolved, '.git')),
    hasPackageJson: fs.existsSync(path.join(resolved, 'package.json')),
  };
}
