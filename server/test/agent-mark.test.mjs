// Ícone de agente da sidebar (client/src/agent-mark.mjs): grade regular, simétrica e caminho SVG coerente com a grade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_GRID, AGENT_SIZE, agentPath } from '../../client/src/agent-mark.mjs';

test('grade 8x8 só com X e ".", sem linha torta', () => {
  assert.equal(AGENT_GRID.length, AGENT_SIZE);
  for (const row of AGENT_GRID) { assert.equal(row.length, AGENT_SIZE); assert.match(row, /^[X.]+$/); }
});

test('desenho simétrico na horizontal (parece um bichinho, não ruído) e com pixels suficientes', () => {
  for (const row of AGENT_GRID) assert.equal(row, [...row].reverse().join(''), `linha assimétrica: ${row}`);
  const filled = AGENT_GRID.join('').replaceAll('.', '').length; assert.ok(filled >= 20 && filled <= 40, `pixels cheios: ${filled}`);
});

test('agentPath: um quadrado 1x1 por pixel cheio, dentro da caixa', () => {
  const d = agentPath(), n = AGENT_GRID.join('').replaceAll('.', '').length;
  assert.equal((d.match(/M/g) || []).length, n); assert.equal((d.match(/h1v1h-1z/g) || []).length, n);
  for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) { assert.ok(Number(x) < AGENT_SIZE && Number(y) < AGENT_SIZE); assert.equal(AGENT_GRID[Number(y)][Number(x)], 'X'); }
});
