import { Color, OrthographicCamera, Scene, WebGPURenderer } from 'three/webgpu';

// Windows 10/11 accent blue: a placeholder until the game draws something.
const BACKGROUND = 0x0078d4;

export interface Renderer {
  dispose(): void;
}

/**
 * Starts a WebGPU renderer on the canvas. Resolves to null when the browser has no WebGPU:
 * there is no WebGL fallback, because the simulation runs in compute shaders.
 */
export async function createRenderer(canvas: HTMLCanvasElement): Promise<Renderer | null> {
  if (!navigator.gpu || !(await navigator.gpu.requestAdapter())) return null;

  const renderer = new WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  // WebGPURenderer silently switches to its WebGL backend when WebGPU fails to start.
  if (!('isWebGPUBackend' in renderer.backend)) {
    renderer.dispose();
    return null;
  }

  const scene = new Scene();
  scene.background = new Color(BACKGROUND);
  const camera = new OrthographicCamera();

  const resize = () => {
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  renderer.setAnimationLoop(() => renderer.render(scene, camera));

  return {
    dispose() {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
    },
  };
}
