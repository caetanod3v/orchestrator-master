// Gera build/icon.ico (vários tamanhos, PNG embutido em cada um) e build/icon.png (256) com a marca do orquestrador (maestro em pixel art, de client/src/brand-mark.mjs). Usa o Edge (headless, via CDP, perfil temporário apagado no fim) só para rasterizar o SVG.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build'); fs.mkdirSync(OUT, { recursive: true });
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) throw new Error('Edge não encontrado para rasterizar o ícone.');
const { markSvg } = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'brand-mark.mjs')).href);
const SIZES = [16, 24, 32, 48, 64, 128, 256]; // barra de tarefas, janela, atalho e instalador pedem tamanhos diferentes; cada um é rasterizado na sua escala (16 células: sempre pixels inteiros por célula)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-icon-')), port = 9344, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const pngs = new Map();
try {
  let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch { /* subindo */ } await sleep(250); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const n of SIZES) {
    await send('Emulation.setDeviceMetricsOverride', { width: n, height: n, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${markSvg({ size: n })}</body></html>`)}` }); await sleep(600);
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { x: 0, y: 0, width: n, height: n, scale: 1 } });
    pngs.set(n, Buffer.from(r.result.data, 'base64'));
  }
  ws.close();
} finally { edge.kill(); await sleep(1000); for (let i = 0; i < 5; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(800); } } }
// ICO: ICONDIR (6 bytes) + uma entrada de 16 bytes por imagem + os PNGs. Largura/altura 0 = 256.
const dir = Buffer.alloc(6 + 16 * SIZES.length); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(SIZES.length, 4);
let offset = dir.length;
SIZES.forEach((n, i) => { const o = 6 + 16 * i, png = pngs.get(n); dir.writeUInt8(n === 256 ? 0 : n, o); dir.writeUInt8(n === 256 ? 0 : n, o + 1); dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(png.length, o + 8); dir.writeUInt32LE(offset, o + 12); offset += png.length; });
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([dir, ...SIZES.map((n) => pngs.get(n))])); fs.writeFileSync(path.join(OUT, 'icon.png'), pngs.get(256));
console.log('icon.ico gerado:', SIZES.join(', '), 'px;', offset, 'bytes');
