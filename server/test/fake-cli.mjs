// CLI FALSA usada somente nos testes automatizados (nunca pelo servidor real).
// Lê o prompt do stdin e se comporta conforme a diretiva "MODE:<x>" nele.
import fs from 'node:fs';

if (process.argv.includes('--version')) { console.log('0.0.0-fake (teste)'); process.exit(0); }

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  let mode = /MODE:(\w+)/.exec(input)?.[1] ?? 'ok';
  const slow = mode.startsWith('slow'); // modos slow* só atrasam (para observar a interface)
  if (slow) mode = mode.slice(4);
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: 'system', subtype: 'init', model: 'fake-model', cwd: process.cwd() });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `prompt recebido com ${input.length} caracteres` }, { type: 'tool_use', name: 'Write', input: { file_path: 'out.txt' } }] } });
  if (slow) await new Promise((r) => setTimeout(r, 2200));
  if (mode === 'sleep') { setInterval(() => {}, 1000); return; } // fica vivo até ser interrompido
  if (mode === 'write') fs.writeFileSync('out.txt', 'criado pelo teste\n');
  const block = (checks) => '```json\n' + JSON.stringify({ summary: 'resumo estruturado', checks }) + '\n```';
  if (mode === 'check') {
    fs.writeFileSync('out.txt', 'conferido\n');
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Criei out.txt e conferi o conteúdo.\n' + block([{ name: 'out.txt existe', result: 'pass', detail: 'conteúdo conferido' }]), total_cost_usd: 0.002, duration_ms: 10, num_turns: 2 });
    process.exit(0);
  }
  if (mode === 'checkfail') {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Tentei, mas a conferência falhou.\n' + block([{ name: 'conteúdo', result: 'fail', detail: 'divergente' }]), total_cost_usd: 0.002, duration_ms: 10, num_turns: 2 });
    process.exit(0);
  }
  if (mode === 'deny') {
    out({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'permissão negada: Bash(rm -rf x)' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Não consegui: o comando exige permissão.', permission_denials: [{ tool_name: 'Bash' }], total_cost_usd: 0.001, duration_ms: 5, num_turns: 1 });
    process.exit(0);
  }
  if (mode === 'fail') { process.stderr.write('falha simulada pela CLI falsa\n'); process.exit(3); }
  if (mode === 'resulterror') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'erro reportado no resultado', total_cost_usd: 0.001, duration_ms: 5, num_turns: 1 });
    process.exit(0);
  }
  if (mode === 'ok') out({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'permissão negada: Bash' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Relatório final do teste.', total_cost_usd: 0.0123, duration_ms: 42, num_turns: 2 });
  process.exit(0);
});
