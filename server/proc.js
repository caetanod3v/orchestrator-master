// Encerramento assíncrono da ÁRVORE de um processo filho, compartilhado pelo executor e pelo verificador.
// Windows: `taskkill /T /F` mata a árvore. POSIX não tem `/T`: sem matar os netos, eles seguram os pipes, o evento `close` do filho nunca chega e
// quem espera (verificação, execução) fica preso. Por isso a árvore é lida antes de matar o pai.
import { execFile as nodeExecFile } from 'node:child_process';
import { descendantsOf as defaultDescendantsOf } from './orphans.js';

export const GRACE_MS = 3000;

/**
 * Resolve quando o encerramento terminou (nunca rejeita).
 * `opts` existe para os testes exercitarem o ramo POSIX no Windows (e vice-versa); o servidor usa sempre os padrões.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{platform?:string, execFile?:Function, descendantsOf?:(pid:number)=>number[], kill?:(pid:number, signal:string)=>void, graceMs?:number}} [opts]
 */
export function killTree(child, { platform = process.platform, execFile = nodeExecFile, descendantsOf = defaultDescendantsOf, kill = (pid, sig) => process.kill(pid, sig), graceMs = GRACE_MS } = {}) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(); // já saiu: nada a encerrar (e o PID pode até ter sido reaproveitado por outro processo, que o `taskkill /T /F` mataria)
    if (platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    const subs = descendantsOf(child.pid); // lidos antes: sem o pai os subprocessos passam a ser do init e não se acha mais a relação
    let swept = false; // uma varredura só: depois do prazo o `exit` chega de novo, e um PID já morto poderia ter sido reaproveitado
    const sweep = () => { if (swept) return; swept = true; for (const p of subs) { try { kill(p, 'SIGKILL'); } catch { /* já encerrado */ } } };
    // Resolve quando o filho SAI (não depois de um tempo fixo): o SIGTERM costuma bastar. Se não sair em 3 s, SIGKILL nele e nos subprocessos.
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* já encerrado */ } sweep(); resolve(); }, graceMs);
    child.once('exit', () => { clearTimeout(timer); sweep(); resolve(); }); // subprocessos que sobraram do filho encerrado também morrem
    try { child.kill('SIGTERM'); } catch { /* já encerrado: o 'exit' ou o prazo concluem */ }
  });
}
