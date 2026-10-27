// Perfis de agentes (agents.js) e o campo opcional task.agent na validação de decisões. Puro: sem processos, banco ou modelo.
import test from 'node:test';
import assert from 'node:assert/strict';

const { AGENTS, AGENT_NAMES, DEFAULT_AGENT, agentArgs, isAgent } = await import('../agents.js');
const { CLAUDE_ARGS } = await import('../executor/index.js');
const { validateDecision } = await import('../cycle-schema.js');

const dec = (task) => JSON.stringify({ decision: 'continue', rationale: 'r', task: { title: 't', instructions: 'i', acceptance: ['a'], ...task } });

test('perfil `code`: argumentos EXATAMENTE iguais aos do Executor de sempre (CLAUDE_ARGS), sem ferramenta ou permissão nova', () => {
  assert.deepEqual(agentArgs('code'), CLAUDE_ARGS); assert.deepEqual(agentArgs(), CLAUDE_ARGS, 'sem nome = perfil padrão');
  assert.equal(DEFAULT_AGENT, 'code'); assert.deepEqual([...AGENT_NAMES], ['code']);
  const i = CLAUDE_ARGS.indexOf('--tools'); assert.equal(agentArgs('code')[i + 1], 'Read,Edit,Write,Glob,Grep');
  assert.ok(!agentArgs('code').some((a) => /dangerously|bypass/i.test(a)));
  assert.equal(agentArgs('code')[agentArgs('code').indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('a tabela é protegida e cada chamada devolve uma cópia nova (mutar o resultado não altera o perfil)', () => {
  assert.ok(Object.isFrozen(AGENTS) && Object.isFrozen(AGENTS.code) && Object.isFrozen(AGENTS.code.args));
  const a = agentArgs('code'); a.push('--x'); a[0] = 'mudou';
  assert.deepEqual(agentArgs('code'), CLAUDE_ARGS);
  assert.throws(() => { AGENTS.review = {}; }, TypeError);
  assert.throws(() => { AGENTS.code.args.push('--x'); }, TypeError);
});

test('nomes desconhecidos, tipos inválidos e nomes especiais são rejeitados (nunca resolvem por herança de protótipo)', () => {
  for (const n of ['review', 'research', 'test', 'CODE', 'code ', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype', null, 0, 5, true, {}, ['code']]) {
    assert.equal(isAgent(n), false, String(n)); assert.throws(() => agentArgs(n), /Perfil de agente desconhecido/, String(n));
  }
  assert.equal(isAgent('code'), true);
});

test('validateDecision: `task.agent` ausente = resposta antiga, intacta (sem campo novo); `code` é aceito', () => {
  const old = validateDecision(dec({}));
  assert.equal(old.ok, true); assert.deepEqual(old.value.task, { title: 't', instructions: 'i', acceptance: ['a'] }); assert.ok(!('agent' in old.value.task));
  const code = validateDecision(dec({ agent: 'code' })); assert.equal(code.ok, true); assert.equal(code.value.task.agent, 'code');
});

test('validateDecision: perfis desconhecidos e tipos inválidos são rejeitados pelo mecanismo existente; as demais validações não mudam', () => {
  for (const agent of ['review', 'Code', '', ' code', '__proto__', 'constructor', null, 0, 1, true, false, ['code'], { name: 'code' }]) {
    const r = validateDecision(dec({ agent })); assert.equal(r.ok, false, JSON.stringify(agent)); assert.match(r.error, /task\.agent/);
  }
  assert.match(validateDecision(dec({ tools: 'Bash' })).error, /chaves não permitidas em "task": tools/, 'chaves desconhecidas continuam proibidas');
  assert.match(validateDecision(dec({ permissions: 'all', agent: 'code' })).error, /permissions/);
  assert.equal(validateDecision(dec({ title: '' })).ok, false); assert.equal(validateDecision(dec({ acceptance: [] })).ok, false);
  assert.match(validateDecision(JSON.stringify({ decision: 'complete', rationale: 'r', evidence: ['e'], task: { agent: 'code' } })).error, /não aceita "task"/);
});
