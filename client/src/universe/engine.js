// Renderer e ciclo de vida do universo: WebGLRenderer + câmera em perspectiva + laço de quadros que só roda quando há o que mostrar.
// Não conhece React. O componente (Universe.jsx) decide quando está visível/ativo; aqui ficam o laço, o tempo e a limpeza.
import { WebGLRenderer, PerspectiveCamera, Scene } from 'three';
import { UNIVERSE, QUALITY_KEY, pickQuality } from './config.js';
import { createStarfield } from './starfield.js';

const readOverride = () => { try { return localStorage.getItem(QUALITY_KEY) || undefined; } catch { return undefined; } };

/**
 * Cria o universo sobre `canvas`. Lança se o WebGL não estiver disponível (o chamador mostra o fundo estático).
 * Opção: onLost (contexto perdido). A deriva é ambiente e fica SEMPRE ativa: não segue prefers-reduced-motion (decisão de produto); só pausa com a aba oculta, fora da tela ou sem tamanho.
 * Estado legível no DOM (diagnóstico): canvas.dataset.state = running | paused | lost | disposed; frames = quadros desenhados; stars; quality.
 */
export function createUniverse(canvas, { onLost } = {}) {
  const override = readOverride();
  if (override === 'off') throw new Error('universo desligado (preferência)');
  const renderer = new WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  const gl = renderer.getContext();
  let software = false;
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    software = !!ext && /swiftshader|llvmpipe|software/i.test(String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)));
  } catch { /* sem a extensão: segue sem a heurística */ }
  const level = pickQuality({
    override, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, width: window.innerWidth,
    softwareRenderer: software, saveData: !!navigator.connection?.saveData,
  });
  const Q = UNIVERSE.quality[level];
  const pixelRatio = Math.min(window.devicePixelRatio || 1, Q.dpr);
  renderer.setPixelRatio(pixelRatio);

  const scene = new Scene();
  const camera = new PerspectiveCamera(UNIVERSE.fov, 1, UNIVERSE.near, UNIVERSE.far);
  const field = createStarfield(Q.count);
  field.setPixelRatio(pixelRatio);
  scene.add(field.points);

  let width = 0, height = 0, active = false, lost = false, disposed = false;
  let raf = 0, last = 0, time = UNIVERSE.staticTime, frames = 0;
  const interval = 1000 / UNIVERSE.fps;
  canvas.dataset.stars = String(field.count); canvas.dataset.quality = level; canvas.dataset.frames = '0';

  const draw = () => { field.setTime(time); renderer.render(scene, camera); frames++; canvas.dataset.frames = String(frames); };
  const canAnimate = () => !disposed && !lost && active && width > 0 && height > 0 && !document.hidden;
  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    if (now - last < interval - 1) return; // deriva lenta: no máximo `fps` quadros por segundo
    time += Math.min((now - last) / 1000, 0.1); last = now; // o tempo só avança enquanto roda (pausar não "pula" a cena)
    draw();
  };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const sync = () => {
    if (disposed) return;
    if (canAnimate()) { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } canvas.dataset.state = 'running'; return; }
    stop();
    canvas.dataset.state = lost ? 'lost' : 'paused';
  };

  const onVisibility = () => sync();
  const onContextLost = (e) => { e.preventDefault(); lost = true; sync(); onLost?.(); };
  const onContextRestored = () => { lost = false; if (width > 0) draw(); sync(); };
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  sync(); // estado inicial legível (paused até haver tamanho e visibilidade)

  return {
    level, count: field.count, software,
    /** Tamanho CSS do canvas (do ResizeObserver). Não regenera o campo: só reescala a projeção. */
    resize(w, h) {
      w = Math.max(0, Math.round(w)); h = Math.max(0, Math.round(h));
      if (w === width && h === height) return;
      width = w; height = h;
      if (w > 0 && h > 0) {
        renderer.setSize(w, h, false); // false: o CSS do canvas (100% x 100%) manda no tamanho de exibição
        camera.aspect = w / h; camera.updateProjectionMatrix(); field.setAspect(camera.aspect);
        if (!raf && !lost) draw(); // parado ou estático: redesenha uma vez para não ficar esticado ou vazio
      }
      sync();
    },
    /** A cena está na tela? (IntersectionObserver do componente) */
    setActive(v) { if (active === !!v) return; active = !!v; if (active && !raf && width > 0 && !lost) draw(); sync(); },
    dispose() {
      if (disposed) return; disposed = true; stop();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      scene.remove(field.points); field.dispose(); renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* contexto já liberado */ }
      canvas.dataset.state = 'disposed';
    },
  };
}
