// Campo estelar em UM único THREE.Points: buffers compactos (ver starfield-data.js) e um par de shaders que faz a deriva 3D na GPU.
// Nenhum trabalho por quadro na CPU além de atualizar alguns uniforms. O mundo é fixo; só o tempo (uT) muda.
import { BufferGeometry, BufferAttribute, ShaderMaterial, Points, Vector3, CustomBlending, OneFactor, OneMinusSrcAlphaFactor, AddEquation } from 'three';
import { UNIVERSE } from './config.js';
import { generateStarfield } from './starfield-data.js';

const VERT = /* glsl */ `
  attribute vec4 aLook;   // tamanho, brilho, fase, taxa da cintilação
  attribute vec4 aMisc;   // multiplicador de deriva, matiz, início e fim da faixa de profundidade
  uniform float uT, uAspect, uDesignAspect, uTanHalf, uPx, uRef, uTwDepth;
  uniform vec3 uDrift;
  varying float vAlpha;
  varying float vTint;
  void main() {
    float span = aMisc.w - aMisc.z;
    float dm = aMisc.x;
    // profundidade: a estrela se aproxima da câmera e, ao passar do início da faixa, reaparece no fundo dela (invisível: o brilho some nas bordas da faixa)
    float d = aMisc.z + mod(position.z - aMisc.z - uDrift.z * dm * uT, span);
    // posição lateral/vertical em unidades de mundo (fixas), mais a deriva; o campo se reescala na horizontal com a razão de aspecto do canvas
    float hh0 = position.z * uTanHalf;
    float hw0 = hh0 * uAspect;
    float wx = hw0 * 1.12;
    float wy = hh0 * 1.12;
    float x = mod(position.x * (uAspect / uDesignAspect) * hh0 + uDrift.x * dm * uT + wx, 2.0 * wx) - wx;
    float y = mod(position.y * hh0 + uDrift.y * dm * uT + wy, 2.0 * wy) - wy;
    gl_Position = projectionMatrix * vec4(x, y, -d, 1.0);

    float raw = aLook.x * clamp(sqrt(uRef / d), 1.0, 1.7) * uPx;   // tamanho aparente em pixels do dispositivo
    gl_PointSize = max(raw, 1.0);
    float thin = clamp(raw * raw, 0.4, 1.0);        // ponto menor que um pixel: perde brilho em vez de piscar
    float tw = 1.0 - uTwDepth * (0.5 + 0.5 * sin(uT * aLook.w + aLook.z));
    float depthFade = smoothstep(0.0, span * 0.1, d - aMisc.z) * (1.0 - smoothstep(span * 0.9, span, d - aMisc.z));
    float edgeFade = (1.0 - smoothstep(0.93, 1.0, abs(x) / wx)) * (1.0 - smoothstep(0.93, 1.0, abs(y) / wy)); // a costura da deriva acontece com brilho zero
    vAlpha = aLook.y * tw * thin * depthFade * edgeFade;
    vTint = aMisc.y;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uWarm;
  uniform vec3 uCool;
  varying float vAlpha;
  varying float vTint;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float a = vAlpha * pow(max(1.0 - r, 0.0), 1.4);
    if (a < 0.004) discard;
    gl_FragColor = vec4(mix(uWarm, uCool, vTint) * a, a); // alfa pré-multiplicado (o canvas é transparente sobre o fundo CSS)
  }
`;

/** Cria o objeto Points do campo estelar. `count` define a qualidade. */
export function createStarfield(count) {
  const data = generateStarfield(count);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.pos, 3));
  geometry.setAttribute('aLook', new BufferAttribute(data.look, 4));
  geometry.setAttribute('aMisc', new BufferAttribute(data.misc, 4));
  geometry.setDrawRange(0, data.count);
  const U = UNIVERSE;
  const material = new ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
    blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
    uniforms: {
      uT: { value: 0 }, uAspect: { value: 1 }, uDesignAspect: { value: U.designAspect }, uTanHalf: { value: Math.tan((U.fov * Math.PI) / 360) },
      uPx: { value: 1 }, uRef: { value: U.sizeRef }, uTwDepth: { value: U.twinkle.depth },
      uDrift: { value: new Vector3(U.drift.x, U.drift.y, U.drift.z) },
      uWarm: { value: new Vector3(...U.tint.warm) }, uCool: { value: new Vector3(...U.tint.cool) },
    },
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false; // o shader move as estrelas: a caixa calculada pela CPU não vale
  return {
    points, material, geometry, count: data.count,
    setTime: (t) => { material.uniforms.uT.value = t; },
    setAspect: (a) => { material.uniforms.uAspect.value = a; },
    setPixelRatio: (p) => { material.uniforms.uPx.value = p; },
    dispose: () => { geometry.dispose(); material.dispose(); },
  };
}
