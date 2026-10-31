// Item A: status unificado dos agentes (client/src/op-state.js: agentVisual, orchestratorVisual) e cores dos tokens. Funções puras, sem React nem servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { agentVisual, orchestratorVisual, agentState, CORE_LABEL } from '../../client/src/op-state.js';

const AGENT_TONES = new Set(['inactive', 'running', 'error']);

test('agentes: só o estado ATUAL real (executando, inativo, desconectado, erro); nunca "concluído"', () => {
  assert.deepEqual(agentVisual({ status: 'running' }), { tone: 'running', shape: 'disc', label: 'executando' });
  assert.deepEqual(agentVisual({ status: 'idle', availability: 'connected' }), { tone: 'inactive', shape: 'ring', label: 'inativo' });
  assert.deepEqual(agentVisual({ status: 'not_connected', availability: 'unavailable' }), { tone: 'inactive', shape: 'dash', label: 'desconectado' });
  assert.deepEqual(agentVisual({ status: 'idle' }, { failed: true }), { tone: 'error', shape: 'tri', label: 'erro' });
  assert.deepEqual(agentVisual(undefined), { tone: 'inactive', shape: 'dash', label: 'sem dados' });
  assert.equal(agentVisual({ status: 'degraded' }).label, 'indisponível');
  for (const a of [{ status: 'running' }, { status: 'idle' }, { status: 'not_connected' }, undefined]) for (const failed of [false, true]) {
    const v = agentVisual(a, { failed });
    assert.ok(AGENT_TONES.has(v.tone), `tom de agente inesperado: ${v.tone}`);
    assert.doesNotMatch(v.label, /conclu/i, 'agente nunca aparece como concluído');
  }
});

test('um agente ocioso não parece concluído nem com erro por causa de execuções antigas: só `failed` explícito mostra erro', () => {
  assert.equal(agentVisual({ status: 'idle' }).tone, 'inactive', 'sem falha informada: inativo');
  assert.equal(agentVisual({ status: 'idle' }, { failed: false }).label, 'inativo');
});

test('prioridade: executando vence erro; desconectado vence erro (sem CLI não há "falha da última execução" a mostrar)', () => {
  assert.equal(agentVisual({ status: 'running' }, { failed: true }).tone, 'running');
  assert.equal(agentVisual({ status: 'not_connected' }, { failed: true }).label, 'desconectado');
});

test('o visual dos agentes é coerente com o estado bruto (agentState)', () => {
  assert.equal(agentState({ status: 'running' }), 'active');
  assert.equal(agentState({ status: 'not_connected' }), 'disconnected');
  assert.equal(agentVisual({ status: 'running' }).tone === 'running', agentState({ status: 'running' }) === 'active');
});

test('orquestrador: mantém a semântica própria (não vira estado de agente) e os rótulos de sempre', () => {
  const aw = orchestratorVisual('awaiting');
  assert.deepEqual(aw, { tone: 'wait', shape: 'diamond', label: 'Aguardando decisão humana' });
  assert.equal(aw.label, CORE_LABEL.awaiting);
  assert.equal(orchestratorVisual('executing').tone, 'orch-run');
  assert.equal(orchestratorVisual('planning').tone, 'orch-run');
  assert.equal(orchestratorVisual('error').label, 'Falha na última execução');
  assert.equal(orchestratorVisual('idle').tone, 'inactive');
  assert.equal(orchestratorVisual('desconhecido').label, CORE_LABEL.idle, 'modo desconhecido cai no repouso, sem inventar estado');
  // "executando" do orquestrador NÃO usa o tom âmbar dos agentes, e a decisão pendente tem tom próprio
  assert.notEqual(orchestratorVisual('executing').tone, agentVisual({ status: 'running' }).tone);
  assert.ok(!AGENT_TONES.has('wait') && !AGENT_TONES.has('orch-run'));
});

// ---- contraste dos tons (lê os tokens reais; guarda contra regressão) ----
const css = fs.readFileSync(new URL('../../client/src/tokens.css', import.meta.url), 'utf8');
const tokens = Object.fromEntries([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const resolve = (name, depth = 0) => { let v = tokens[name]; const ref = v?.match(/^var\((--[\w-]+)\)$/); return ref && depth < 5 ? resolve(ref[1], depth + 1) : v; };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
const ratio = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('tokens dos agentes resolvem para cores reais e mantêm contraste AA (≥ 4,5:1) em todas as superfícies de texto', () => {
  const surfaces = ['--bg', '--surface', '--canvas', '--raise', '--raise2'].map((n) => [n, resolve(n)]);
  for (const t of ['--ag-idle', '--ag-run', '--ag-err', '--run', '--warn']) {
    const c = resolve(t);
    assert.match(c, /^#[0-9a-f]{6}$/i, `${t} não resolveu para uma cor: ${c}`);
    for (const [n, s] of surfaces) assert.ok(ratio(c, s) >= 4.5, `${t} sobre ${n}: ${ratio(c, s).toFixed(2)}:1`);
  }
  assert.equal(resolve('--ag-run'), resolve('--warn'), 'executando = âmbar');
  assert.equal(resolve('--ag-idle'), resolve('--muted'), 'inativo = cinza');
  assert.equal(resolve('--ag-err'), resolve('--err'), 'erro = vermelho');
  assert.notEqual(resolve('--ag-run'), resolve('--ok'), 'verde fica reservado a tarefas concluídas');
});
