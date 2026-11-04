// Preferências locais da interface (client/src/prefs.js): validação e notificação. Sem navegador: o armazenamento não existe aqui, e a tela deve funcionar assim mesmo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePrefs, DEFAULT_PREFS, FONT_RANGE, getPrefs, setPref, subscribePrefs } from '../../client/src/prefs.js';

test('sanitizePrefs: qualquer entrada vira um objeto completo e válido', () => {
  assert.deepEqual(sanitizePrefs(null), DEFAULT_PREFS); assert.deepEqual(sanitizePrefs('x'), DEFAULT_PREFS); assert.deepEqual(sanitizePrefs([1]), DEFAULT_PREFS); assert.deepEqual(sanitizePrefs({}), DEFAULT_PREFS);
  const p = sanitizePrefs({ name: `  Ana‮\u0007 Silva ${'x'.repeat(80)}`, isolate: 'sim', role: 'Builder; rm', fontSize: '99', motion: 'turbo' });
  assert.equal(p.name.length <= 40, true); assert.ok(!/[‮\u0007]/.test(p.name), 'sem controles nem bidi'); assert.match(p.name, /^Ana/);
  assert.equal(p.isolate, false, 'só o booleano true liga'); assert.equal(p.role, DEFAULT_PREFS.role, 'papel fora do padrão ^[a-z]{1,20}$'); assert.equal(p.fontSize, FONT_RANGE.max); assert.equal(p.motion, 'auto');
  assert.equal(sanitizePrefs({ fontSize: 3 }).fontSize, FONT_RANGE.min); assert.equal(sanitizePrefs({ fontSize: 14.6 }).fontSize, 15); assert.equal(sanitizePrefs({ fontSize: 'abc' }).fontSize, DEFAULT_PREFS.fontSize);
  assert.deepEqual(sanitizePrefs({ isolate: true, role: 'reviewer', motion: 'reduced', fontSize: 16, name: 'Bia' }), { name: 'Bia', isolate: true, role: 'reviewer', fontSize: 16, motion: 'reduced' });
});

test('setPref: valida, notifica quem escuta e ignora chaves desconhecidas (funciona sem localStorage)', () => {
  let calls = 0; const off = subscribePrefs(() => { calls++; });
  setPref('fontSize', 17); assert.equal(getPrefs().fontSize, 17); assert.equal(calls, 1);
  setPref('fontSize', 500); assert.equal(getPrefs().fontSize, FONT_RANGE.max, 'valor absurdo é limitado');
  const before = getPrefs(); setPref('__proto__', { x: 1 }); setPref('constructor', 1); setPref('inexistente', 1); assert.deepEqual(getPrefs(), before, 'chave fora da lista não muda nada'); assert.equal(Object.hasOwn(getPrefs(), 'inexistente'), false);
  off(); setPref('isolate', true); assert.equal(getPrefs().isolate, true); assert.equal(calls, 2, 'depois de cancelar a inscrição ninguém é avisado');
  setPref('isolate', false); setPref('fontSize', DEFAULT_PREFS.fontSize);
});
