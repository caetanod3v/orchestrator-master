// Processo FALSO de verificação, usado só nos testes. O "script" pedido (argv[2]) define o comportamento.
import process from 'node:process';
import fs from 'node:fs';

const script = process.argv[2];
if (script === 'test') {
  console.log('testes ok');
  console.log(`CWD=${process.cwd()}`);
  console.log(`ARGS=${JSON.stringify(process.argv.slice(2))}`);
  console.log(`KEY=${process.env.ANTHROPIC_API_KEY ? 'visible' : 'hidden'}`);
  console.log(`CI=${process.env.CI}`);
  process.exit(0);
} else if (script === 'build') {
  if (fs.existsSync('BUILD_OK')) { console.log('build ok'); process.exit(0); } // cwd = workspace
  process.stderr.write('build quebrou: erro de compilação\n');
  process.exit(2);
} else if (script === 'lint') {
  setInterval(() => {}, 1000); // fica vivo até timeout/cancelamento
} else if (script === 'typecheck') {
  const chunk = 'x'.repeat(8192);
  setInterval(() => process.stdout.write(chunk), 1); // inunda a saída
} else {
  process.exit(9);
}
