import type { WebGPURenderer } from 'three/webgpu';

const batches = new WeakMap<WebGPURenderer, ComputeBatch>();

/**
 * Combine compute submissions within a synchronous section, preserving every pass.
 * Uploads and non-compute submissions flush first: moving a writeBuffer ahead of
 * an earlier dispatch would change the values that dispatch reads. In particular,
 * a readback submits its copy immediately, before mapAsync starts.
 *
 * Three.js submits each compute() separately. Keep this adapter at its public
 * compute/queue boundary, without depending on backend command encoder internals.
 * A returned promise does not extend the batch beyond this synchronous section.
 */
export function batchCompute<T>(renderer: WebGPURenderer, work: () => T): T {
  let batch = batches.get(renderer);
  if (!batch) {
    batch = new ComputeBatch(renderer);
    batches.set(renderer, batch);
  }
  return batch.run(work);
}

class ComputeBatch {
  private readonly queue: GPUQueue;
  private readonly commands: GPUCommandBuffer[] = [];
  private active = false;
  private computing = 0;
  private compute!: WebGPURenderer['compute'];
  private submit!: GPUQueue['submit'];
  private writeBuffer!: GPUQueue['writeBuffer'];
  private writeTexture!: GPUQueue['writeTexture'];
  private copyImage!: GPUQueue['copyExternalImageToTexture'];
  private workDone!: GPUQueue['onSubmittedWorkDone'];

  constructor(private readonly renderer: WebGPURenderer) {
    this.queue = (renderer.backend as unknown as { device: GPUDevice }).device.queue;
  }

  private readonly computeCommands: WebGPURenderer['compute'] = (...args) => {
    this.computing++;
    try { return this.compute.apply(this.renderer, args); }
    finally { this.computing--; }
  };
  private readonly submitCommands: GPUQueue['submit'] = commands => {
    if (this.computing) {
      // Three.js reuses its submission array, so retain the command buffers only.
      for (const command of commands) this.commands.push(command);
    } else {
      this.flush();
      this.submit.call(this.queue, commands);
    }
  };
  private readonly uploadBuffer: GPUQueue['writeBuffer'] = (...args) => {
    this.flush(); this.writeBuffer.apply(this.queue, args);
  };
  private readonly uploadTexture: GPUQueue['writeTexture'] = (...args) => {
    this.flush(); Reflect.apply(this.writeTexture, this.queue, args);
  };
  private readonly uploadImage: GPUQueue['copyExternalImageToTexture'] = (...args) => {
    this.flush(); Reflect.apply(this.copyImage, this.queue, args);
  };
  private readonly waitForWork: GPUQueue['onSubmittedWorkDone'] = () => {
    this.flush(); return this.workDone.call(this.queue);
  };

  private flush() {
    if (!this.commands.length) return;
    try { this.submit.call(this.queue, this.commands); }
    finally { this.commands.length = 0; }
  }

  run<T>(work: () => T): T {
    if (this.active) return work();
    this.active = true;
    this.compute = this.renderer.compute;
    this.submit = this.queue.submit;
    this.writeBuffer = this.queue.writeBuffer;
    this.writeTexture = this.queue.writeTexture;
    this.copyImage = this.queue.copyExternalImageToTexture;
    this.workDone = this.queue.onSubmittedWorkDone;
    this.renderer.compute = this.computeCommands;
    this.queue.submit = this.submitCommands;
    this.queue.writeBuffer = this.uploadBuffer;
    this.queue.writeTexture = this.uploadTexture;
    this.queue.copyExternalImageToTexture = this.uploadImage;
    this.queue.onSubmittedWorkDone = this.waitForWork;
    try { return work(); }
    finally {
      try { this.flush(); }
      finally {
        this.renderer.compute = this.compute;
        this.queue.submit = this.submit;
        this.queue.writeBuffer = this.writeBuffer;
        this.queue.writeTexture = this.writeTexture;
        this.queue.copyExternalImageToTexture = this.copyImage;
        this.queue.onSubmittedWorkDone = this.workDone;
        this.active = false;
      }
    }
  }
}
