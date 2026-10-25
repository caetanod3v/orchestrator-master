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
  if (mode === 'fixbuild') fs.writeFileSync('BUILD_OK', 'x\n'); // faz o build do fake-verify passar
  const block = (checks) => '```json\n' + JSON.stringify({ summary: 'resumo estruturado', checks }) + '\n```';
  if (mode === 'usagepartial') { // reporta uso e fica vivo SEM emitir result (para testar interrupção/falha com métricas parciais)
    out({ type: 'assistant', message: { id: 'msg_P', content: [{ type: 'text', text: 'p' }], usage: { input_tokens: 7, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 70 } } });
    setInterval(() => {}, 1000); return;
  }
  if (mode === 'usage') { // métricas sintéticas no formato do stream real (sem textos nem ids reais)
    const u = (i, o, cc, cr) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, service_tier: 'standard' });
    out({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'a' }], usage: u(2, 1, 100, 50) } });
    out({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', name: 'Read', input: {} }], usage: u(2, 1, 100, 50) } }); // mesma resposta repetida
    out({ type: 'assistant', parent_tool_use_id: 'toolu_x', message: { id: 'msg_S', content: [], usage: u(999, 999, 999, 999) } });     // subagente: fora do live
    out({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: 'b' }], usage: u(3, 1, 0, 150) } });
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792922400 } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Relatório de uso.', total_cost_usd: 0.05, duration_ms: 7, num_turns: 2,
      usage: { ...u(5, 9, 100, 200), output_tokens_details: { thinking_tokens: 0 } },
      modelUsage: { 'modelo-sintetico': { inputTokens: 5, outputTokens: 9, cacheReadInputTokens: 200, cacheCreationInputTokens: 100, webSearchRequests: 0, costUSD: 0.05, contextWindow: 1000000, maxOutputTokens: 128000, thinkingTokens: 0 } } });
    process.exit(0);
  }
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
