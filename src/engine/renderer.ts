import { LinearSRGBColorSpace, NoToneMapping, Vector2, WebGPURenderer } from 'three/webgpu';

/** Draws one frame. width and height are the canvas size in device pixels. */
export type FrameCallback = (width: number, height: number, time: number) => void;

export interface Renderer {
  readonly three: WebGPURenderer;
  /** Sets what to draw on every animation frame, or null to draw nothing. */
  setFrame(frame: FrameCallback | null): void;
  dispose(): void;
}

export interface RendererOptions {
  /** Called when the GPU device is lost after start. By then the renderer has stopped and released itself. */
  onDeviceLost(message: string): void;
}

/** Thrown by createRenderer when the GPU device is lost before the renderer has started. */
export class DeviceLostError extends Error {}

/** Startup only: wait until submitted preparation and the first frame have reached the GPU. */
export async function finishGpuSetup(renderer: WebGPURenderer) {
  const backend = renderer.backend as unknown as { device: GPUDevice };
  await backend.device.queue.onSubmittedWorkDone();
}

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

  // Colors leave the shaders as they are: palette colors are already what the screen should show, so
  // no color space conversion or tone mapping may touch them.
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.setClearColor(0x000000, 0);

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

  let frame: FrameCallback | null = null;
  const drawingBuffer = new Vector2();
  renderer.setAnimationLoop((time) => {
    const size = renderer.getDrawingBufferSize(drawingBuffer);
    frame?.(size.x, size.y, time);
  });

  return {
    three: renderer,
    setFrame(callback) {
      frame = callback;
    },
    dispose: stop,
  };
}
