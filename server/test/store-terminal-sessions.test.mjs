// Histórico de sessões de terminal no banco (db.terminalSessions): ida e volta e validação TOLERANTE. Um registro malformado nunca invalida o banco inteiro.
// Cada cenário usa diretório TEMPORÁRIO próprio e módulo novo (store.js?c=N); o db.json real nunca é tocado.
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tsess-'));
after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

let n = 0;
async function fresh(files = {}) {
  const dir = path.join(root, `c${++n}`); fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  process.env.ORCH_DATA_DIR = dir;
  const store = await import(`../store.js?c=${n}`);
  return { store, dir, file: path.join(dir, 'db.json'), disk: () => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')) };
}
const base = () => ({ version: 1, settings: { activeWorkspaceId: 'ws1', requireApproval: true, showDemoData: false }, workspaces: [{ id: 'ws1', name: 'w', path: 'C:\\projeto' }], missions: [], activity: [] });
const rec = (id, over = {}) => ({ id, terminalId: 'term_aaaaaaaa', claudeSessionId: '00000000-0000-4000-8000-000000000001', role: 'builder', title: 't', workspaceId: 'ws1', cwd: 'C:\\projeto', worktreeId: null, usesMcp: true, state: 'exited', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', exitCode: 0, resumes: 0, forkedFrom: null, ...over });
const quiet = () => mock.method(console, 'error', () => {});

test('ida e volta: registros válidos salvos são recarregados íntegros (inclusive forkedFrom)', async () => {
  const a = await fresh(); const db = a.store.load();
  db.terminalSessions = [rec('ses_00000001'), rec('ses_00000002', { claudeSessionId: '00000000-0000-4000-8000-000000000002', forkedFrom: 'ses_00000001', state: 'interrupted', interruptedAt: '2026-01-01T00:02:00.000Z' })];
  a.store.saveOrThrow();
  assert.deepEqual(a.disk().terminalSessions, db.terminalSessions);
  quiet(); const b = await fresh({ 'db.json': fs.readFileSync(a.file, 'utf8') }); const again = b.store.load();
  assert.deepEqual(again.terminalSessions, db.terminalSessions, 'mesmos registros depois de recarregar'); assert.equal(again.version, 1);
});

test('registro inválido é ignorado SOZINHO: o restante do banco e os demais registros ficam disponíveis (sem cair para o backup)', async () => {
  const d = base(); d.terminalSessions = [
    rec('ses_00000001'), null, 'lixo', 42, { id: 'ses_00000002' }, rec('nao-e-id'), rec('ses_00000003', { state: 'explodiu' }), rec('ses_00000004', { claudeSessionId: 7 }),
    rec('ses_00000005', { forkedFrom: 'ses_99999999' }), rec('ses_00000006', { forkedFrom: 'ses_00000001' }), rec('ses_00000001', { title: 'duplicado' }),
  ];
  const errors = []; mock.method(console, 'error', (m) => errors.push(String(m)));
  const a = await fresh({ 'db.json': JSON.stringify(d) }); const db = a.store.load();
  assert.deepEqual(db.terminalSessions.map((r) => r.id), ['ses_00000001', 'ses_00000005', 'ses_00000006'], 'só os válidos (e o primeiro de cada id)');
  assert.equal(db.terminalSessions.find((r) => r.id === 'ses_00000005').forkedFrom, null, 'vínculo para registro inexistente é zerado');
  assert.equal(db.terminalSessions.find((r) => r.id === 'ses_00000006').forkedFrom, 'ses_00000001');
  assert.equal(db.workspaces[0].id, 'ws1'); assert.equal(db.settings.activeWorkspaceId, 'ws1');
  assert.ok(errors.some((e) => /histórico de terminais/.test(e)), 'o descarte é anunciado'); assert.ok(!errors.some((e) => /recuperado de/.test(e)), 'o banco NÃO foi trocado por backup');
  assert.ok(!fs.readdirSync(a.dir).some((f) => f.includes('.corrupt-')), 'nenhum db.json corrompido preservado: o arquivo era válido');
  a.store.saveOrThrow(); assert.deepEqual(a.disk().terminalSessions.map((r) => r.id), ['ses_00000001', 'ses_00000005', 'ses_00000006'], 'o que foi descartado não volta ao disco');
});

test('terminalSessions que nem é lista vira lista vazia; banco antigo sem o campo continua intacto; as outras estruturas seguem validadas', async () => {
  quiet(); let a = await fresh({ 'db.json': JSON.stringify({ ...base(), terminalSessions: { nao: 'lista' } }) }); assert.deepEqual(a.store.load().terminalSessions, []);
  const old = base(); a = await fresh({ 'db.json': JSON.stringify(old) }); const db = a.store.load(); assert.equal(db.terminalSessions, undefined, 'nada é criado em bancos antigos'); assert.equal(db.workspaces.length, 1);
  // a validação das demais estruturas continua estrita: workspace sem path invalida o db.json e dispara a recuperação
  const bad = base(); bad.workspaces = [{ id: 'x' }]; bad.terminalSessions = [rec('ses_00000001')];
  const mod = await import('../store.js?c=' + (++n)); assert.match(mod.validateDb(bad) ?? '', /workspace sem id\/path/); assert.equal(mod.validateDb({ ...base(), terminalSessions: [null] }), null, 'registro nulo no histórico NÃO invalida o banco');
});

test('validTerminalSession / sanitizeTerminalSessions: exigem só o que a retomada usa', async () => {
  const s = await import('../store.js?c=' + (++n));
  assert.equal(s.validTerminalSession(rec('ses_0000abcd')), true); for (const k of ['claudeSessionId', 'terminalId', 'workspaceId', 'cwd', 'role', 'title']) assert.equal(s.validTerminalSession(rec('ses_0000abcd', { [k]: undefined })), false, k);
  assert.equal(s.validTerminalSession(rec('SES_0000abcd')), false); assert.equal(s.validTerminalSession(rec('ses_0000abcd', { state: 'x' })), false);
  assert.equal(s.sanitizeTerminalSessions({}), 0); assert.equal(s.sanitizeTerminalSessions(null), 0);
  const d = { terminalSessions: [rec('ses_00000001'), { id: 1 }] }; assert.equal(s.sanitizeTerminalSessions(d), 1); assert.equal(d.terminalSessions.length, 1);
});
