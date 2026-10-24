import { Color, OrthographicCamera, Scene, WebGPURenderer } from 'three/webgpu';

// Windows 10/11 accent blue: a placeholder until the game draws something.
const BACKGROUND = 0x0078d4;

export interface Renderer {
  dispose(): void;
}

export interface RendererOptions {
  /** Called when the GPU device is lost after start. By then the renderer has stopped and released itself. */
  onDeviceLost(message: string): void;
}

/** Thrown by createRenderer when the GPU device is lost before the renderer has started. */
export class DeviceLostError extends Error {}

/**
 * Starts a WebGPU renderer on the canvas. Resolves to null when the browser has no WebGPU. Rejects
 * with DeviceLostError when the device is lost while starting, and with the original error when
 * WebGPU is there but fails to start. There is no WebGL fallback, because the simulation runs in
 * compute shaders.
 */
export async function createRenderer(canvas: HTMLCanvasElement, options: RendererOptions): Promise<Renderer | null> {
  if (!navigator.gpu || !(await navigator.gpu.requestAdapter())) return null;

  const renderer = new WebGPURenderer({ canvas, antialias: false });
  // WebGPURenderer always installs a WebGL fallback, which init() switches to when the WebGPU
  // backend fails to start, and its constructor overwrites any getFallback passed in. Clear the
  // internal field so that init() rejects instead.
  (renderer as unknown as { _getFallback: unknown })._getFallback = null;

  // init() already listens for device loss, so take the notifications over before it runs. The
  // default handler only logs, then silently skips every later frame.
  const starting: { lostMessage: string | null } = { lostMessage: null };
  let onLost = (message: string) => {
    starting.lostMessage = message;
  };
  renderer.onDeviceLost = (info) => onLost(info.message);

  let initialized = true;
  try {
    await renderer.init();
  } catch (error) {
    if (starting.lostMessage === null) throw error;
    initialized = false;
  }
  if (starting.lostMessage !== null) {
    // dispose() on a renderer whose init() failed would run init() again.
    if (initialized) renderer.dispose();
    throw new DeviceLostError(starting.lostMessage);
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

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    renderer.setAnimationLoop(null);
    renderer.dispose();
  };

  onLost = (message) => {
    stop();
    options.onDeviceLost(message);
  };

  renderer.setAnimationLoop(() => renderer.render(scene, camera));

  return { dispose: stop };
}
