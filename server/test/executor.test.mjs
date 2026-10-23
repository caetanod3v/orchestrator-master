import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createExecutor } from '../executor/index.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
const mkExec = (o = {}) => createExecutor({ command: process.execPath, prefixArgs: [FAKE], args: [], ...o });
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-exec-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const go = (ex, mode, lines = []) => ex.start({ missionId: 'm', taskId: 't', cwd, prompt: `MODE:${mode}\ntarefa`, onLine: (l) => lines.push(l) });

test('sucesso: captura saída, resultado real e código 0', async () => {
  const ex = mkExec(); const lines = [];
  const h = go(ex, 'ok', lines);
  assert.equal(ex.isBusy(), true);
  const r = await h.done;
  assert.equal(r.status, 'completed'); assert.equal(r.exitCode, 0);
  assert.equal(r.result.text, 'Relatório final do teste.');
  assert.equal(r.result.costUsd, 0.0123);
  assert.ok(lines.some((l) => l.startsWith('[claude] prompt recebido com')), 'prompt chegou por stdin');
  assert.ok(lines.some((l) => l.includes('[erro de ferramenta] permissão negada: Bash')));
  assert.ok(lines.some((l) => l.startsWith('[ferramenta] Write out.txt')));
  assert.equal(ex.isBusy(), false);
});

test('código de saída diferente de zero: failed com stderr preservado', async () => {
  const ex = mkExec(); const lines = [];
  const r = await go(ex, 'fail', lines).done;
  assert.equal(r.status, 'failed'); assert.equal(r.exitCode, 3);
  assert.match(r.error, /código 3/);
  assert.ok(lines.includes('[stderr] falha simulada pela CLI falsa'));
});

test('exit 0 mas resultado com is_error: failed (processo iniciar não é concluir)', async () => {
  const r = await go(mkExec(), 'resulterror').done;
  assert.equal(r.status, 'failed'); assert.match(r.error, /erro reportado/);
});

test('falha ao iniciar a CLI: failed, spawnFailed e lock liberado', async () => {
  const ex = createExecutor({ command: 'cli-que-nao-existe-xyz', args: [] });
  const r = await go(ex, 'ok').done;
  assert.equal(r.status, 'failed'); assert.equal(r.spawnFailed, true);
  assert.match(r.error, /Falha ao iniciar/);
  assert.equal(ex.isBusy(), false);
});

test('execução duplicada é recusada enquanto há uma ativa', async () => {
  const ex = mkExec();
  const h = go(ex, 'sleep');
  assert.throws(() => go(ex, 'ok'), (e) => e.code === 'BUSY');
  await ex.stop(); await h.done;
  const r = await go(ex, 'ok').done; // depois de liberar, pode iniciar de novo
  assert.equal(r.status, 'completed');
});

test('interrupção: encerra o processo, status interrupted e limpa o lock', async () => {
  const ex = mkExec(); const lines = [];
  const h = go(ex, 'sleep', lines);
  await new Promise((r) => setTimeout(r, 700)); // deixa o processo subir
  assert.ok(alive(h.pid));
  const s = await ex.stop();
  assert.equal(s.stopped, true);
  const r = await h.done;
  assert.equal(r.status, 'interrupted');
  assert.equal(ex.isBusy(), false);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(alive(h.pid), false, 'processo não pode sobrar');
  assert.deepEqual(await ex.stop(), { stopped: false, detail: 'Nenhuma execução ativa.' });
});

test('tempo máximo excedido: failed e processo encerrado', async () => {
  const ex = mkExec({ timeoutMs: 800 });
  const h = go(ex, 'sleep');
  const r = await h.done;
  assert.equal(r.status, 'failed'); assert.match(r.error, /Tempo máximo/);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(alive(h.pid), false);
});
