// CLI FALSA só para os testes: devolve como "resultado" os argumentos que recebeu. Nunca chama modelo.
if (process.argv.includes('--version')) { console.log('0.0.0-fake-argv (teste)'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(args), total_cost_usd: 0, duration_ms: 1, num_turns: 1 })}\n`);
  process.exit(0);
});
