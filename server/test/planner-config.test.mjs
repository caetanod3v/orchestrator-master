// Configuração de modelo/esforço SÓ do Planner. CLI FALSA (devolve os argumentos recebidos); nenhum modelo é chamado.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_ARGV = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-argv-cli.mjs');
const { PLANNER_ARGS, PLANNER_EFFORTS, plannerArgs, plannerConfigFromEnv, createClaudePlanner } = await import('../planner.js');
const { CLAUDE_ARGS } = await import('../executor/index.js');

test('sem configuração, os argumentos do Planner são exatamente os de antes (modelo e esforço padrão da CLI)', () => {
  assert.deepEqual(plannerArgs(), PLANNER_ARGS);
  assert.deepEqual(plannerArgs({ model: '', effort: '' }), PLANNER_ARGS);
  assert.equal(PLANNER_ARGS.includes('--model') || PLANNER_ARGS.includes('--effort'), false);
});

test('com configuração, --model e --effort entram ANTES de --tools e o resto continua igual', () => {
  const a = plannerArgs({ model: 'claude-haiku-5-5', effort: 'low' });
  const i = a.indexOf('--model');
  assert.deepEqual(a.slice(i, i + 4), ['--model', 'claude-haiku-5-5', '--effort', 'low']);
  assert.deepEqual(a.slice(-2), ['--tools', ''], 'o Planner continua SEM ferramentas');
  assert.deepEqual(a.filter((x) => !['--model', 'claude-haiku-5-5', '--effort', 'low'].includes(x)), PLANNER_ARGS, 'nenhum outro argumento mudou');
  assert.deepEqual(plannerArgs({ effort: 'medium' }).slice(-4), ['--effort', 'medium', '--tools', '']);
  assert.deepEqual(plannerArgs({ model: 'sonnet[1m]' }).slice(-4), ['--model', 'sonnet[1m]', '--tools', '']);
});

test('valores inválidos são recusados (nada vira opção da CLI nem passa por shell)', () => {
  for (const model of ['--dangerously-skip-permissions', '-x', 'a b', 'x;y', 'm\nn', '$(id)', 'a'.repeat(65), 7]) assert.throws(() => plannerArgs({ model }), /ORCH_PLANNER_MODEL/, String(model));
  for (const effort of ['ultra', 'LOW', '--model', 'low;x', 3]) assert.throws(() => plannerArgs({ effort }), /ORCH_PLANNER_EFFORT/, String(effort));
  for (const effort of PLANNER_EFFORTS) assert.doesNotThrow(() => plannerArgs({ effort }));
});

test('o ambiente do servidor vira configuração (espaços e vazio = padrão da CLI)', () => {
  assert.deepEqual(plannerConfigFromEnv({}), { model: undefined, effort: undefined });
  assert.deepEqual(plannerConfigFromEnv({ ORCH_PLANNER_MODEL: '  ', ORCH_PLANNER_EFFORT: '' }), { model: undefined, effort: undefined });
  assert.deepEqual(plannerConfigFromEnv({ ORCH_PLANNER_MODEL: ' claude-haiku-5-5 ', ORCH_PLANNER_EFFORT: 'low' }), { model: 'claude-haiku-5-5', effort: 'low' });
  assert.throws(() => createClaudePlanner(plannerConfigFromEnv({ ORCH_PLANNER_EFFORT: 'ultra' })), /ORCH_PLANNER_EFFORT/, 'valor inválido impede criar o Planner (o boot falha em vez de ignorar)');
});

test('o Executor não é afetado: seus argumentos não têm modelo nem esforço', () => {
  assert.equal(CLAUDE_ARGS.includes('--model') || CLAUDE_ARGS.includes('--effort'), false);
  createClaudePlanner({ model: 'claude-haiku-5-5', effort: 'low' });
  assert.equal(CLAUDE_ARGS.includes('--model') || CLAUDE_ARGS.includes('--effort'), false, 'criar um Planner configurado não altera os argumentos do Executor');
});

test('o runner PADRÃO do Planner recebe de fato os argumentos configurados (processo real = CLI falsa)', async () => {
  const run = async (cfg) => {
    const planner = createClaudePlanner({ ...cfg, runnerOptions: { command: process.execPath, prefixArgs: [FAKE_ARGV] } });
    const r = await planner.decide({ prompt: 'p', cwd: process.cwd() });
    assert.equal(r.error, undefined, r.error);
    const received = JSON.parse(r.text);
    assert.deepEqual(received, planner.args, 'a CLI recebeu exatamente planner.args');
    return received;
  };
  const cfg = await run({ model: 'claude-haiku-5-5', effort: 'low' });
  assert.deepEqual(cfg.slice(cfg.indexOf('--model'), cfg.indexOf('--model') + 4), ['--model', 'claude-haiku-5-5', '--effort', 'low']);
  assert.deepEqual(await run({}), PLANNER_ARGS);
});
