// Migração dos dados do app desktop quando o produto mudou de nome (AI Dev Orchestrator -> FORGE). Módulo puro (sem Electron), testável em qualquer sistema.
// Regras de segurança dos dados do usuário:
//   - COPIA, nunca move: a pasta original continua intacta (dá para voltar à versão anterior);
//   - só migra se o destino ainda NÃO tem banco, e nunca sobrescreve um banco existente;
//   - não migra com a versão anterior aberta (a trava do servidor aponta um processo vivo): o banco estaria sendo gravado;
//   - copia para uma pasta de preparo, confere o banco byte a byte (SHA-256) e só então renomeia: uma queda no meio não deixa um destino pela metade;
//   - nunca copia links (symlink/junction): a pasta de dados nova é SEMPRE uma cópia real, nunca um atalho para a original;
//   - qualquer resto de tentativa interrompida é guardado com outro nome, nunca apagado.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_FILES = ['db.json', 'db.json.bak'];
const BOOT_MARGIN_MS = 5000;
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const defaultAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const skipName = (name) => name === 'server.lock' || name.endsWith('.tmp'); // trava e temporários de gravação não se copiam
const hasDb = (dir) => DB_FILES.some((f) => fs.existsSync(path.join(dir, f)));

/**
 * PID vivo que segura a trava do servidor naquela pasta, ou null. Trava ilegível, de processo morto ou ANTERIOR ao boot do sistema
 * (o PID pode ter sido reaproveitado por outro programa depois de uma queda ou reinício, como faz o instance-lock do servidor) não bloqueia.
 */
function liveHolder(dataDir, { isAlive, bootTime }) {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.lock'), 'utf8')); } catch { return null; }
  const pid = info && info.pid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const started = Date.parse(info.startedAt);
  if (Number.isFinite(started) && started < bootTime - BOOT_MARGIN_MS) return null;
  return isAlive(pid) ? pid : null;
}

/**
 * @returns {{status:'none'|'present'|'migrated'|'blocked'|'error', pid?:number, lock?:string, from?:string, to?:string, skippedLinks?:string[], error?:string}}
 *  none = não há dados antigos; present = o destino já tem banco (nada a fazer); blocked = a versão anterior está aberta.
 */
function migrateUserData({ appData, from = 'AI Dev Orchestrator', to = 'FORGE', isAlive = defaultAlive, bootTime = Date.now() - os.uptime() * 1000, now = () => new Date(), copy = fs.cpSync } = {}) {
  const oldData = path.join(appData, from, 'data'), newRoot = path.join(appData, to), newData = path.join(newRoot, 'data');
  try {
    if (!hasDb(oldData)) return { status: 'none' };
    if (hasDb(newData)) return { status: 'present' };
    const pid = liveHolder(oldData, { isAlive, bootTime });
    if (pid) return { status: 'blocked', pid, lock: path.join(oldData, 'server.lock') };

    // se a pasta de dados antiga for um link (ex.: movida para outro disco), copia o CONTEÚDO real; senão o destino viraria um atalho para a original
    const srcData = fs.lstatSync(oldData).isSymbolicLink() ? fs.realpathSync(oldData) : oldData;
    fs.mkdirSync(newRoot, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const staging = `${newData}.migrating`;
    if (fs.existsSync(staging)) fs.renameSync(staging, `${staging}-sobra-${stamp}`);
    const skippedLinks = [];
    // `mcp/` guarda tokens de terminais já encerrados (o servidor os revoga e apaga a cada boot): duplicar segredos não traz nada
    const isMcp = (src) => { const rel = path.relative(srcData, src); return rel === 'mcp' || rel.startsWith(`mcp${path.sep}`); };
    const keep = (src) => {
      if (src !== srcData) { try { if (fs.lstatSync(src).isSymbolicLink()) { skippedLinks.push(path.relative(srcData, src)); return false; } } catch { return false; } }
      return !skipName(path.basename(src)) && !isMcp(src);
    };
    copy(srcData, staging, { recursive: true, filter: keep });
    for (const f of DB_FILES) { // o banco copiado tem de ser idêntico ao original
      const a = path.join(srcData, f), b = path.join(staging, f);
      if (fs.existsSync(a) && (!fs.existsSync(b) || sha(a) !== sha(b))) throw new Error(`a cópia de ${f} não confere com o original`);
    }
    if (fs.existsSync(newData)) fs.renameSync(newData, `${newData}.antes-da-migracao-${stamp}`); // pasta de dados vazia/sem banco: guardada, não apagada
    fs.renameSync(staging, newData);
    try { // a migração já está concluída: falhar só no marcador não pode desfazê-la nem impedir o app de abrir
      fs.writeFileSync(path.join(newRoot, 'migrated-from.json'), JSON.stringify({ from: oldData, at: now().toISOString(), db: fs.existsSync(path.join(newData, 'db.json')) ? sha(path.join(newData, 'db.json')) : null, skippedLinks }, null, 2));
    } catch { /* o marcador é só informativo */ }
    return { status: 'migrated', from: oldData, to: newData, skippedLinks };
  } catch (e) {
    return { status: 'error', error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { migrateUserData };
