import type { IndexedScreen } from '../../engine/indexed/screen.ts';
import { VqaVideo, vqpTable } from '../formats/vqa.ts';
import type { CampaignAssets, CampaignSide } from './assets.ts';

const BLACK_PIXEL=new Uint8Array(1),BLACK_PALETTE=new Uint8Array(768);

/** Original VQA audio clock, indexed frames and Gold's horizontal palette interpolation. */
export class MoviePlayer {
  private controller?: AbortController;
  private preserve = false;
  private readonly nodes = new Set<AudioBufferSourceNode>();
  constructor(private readonly assets: CampaignAssets, private readonly screen: IndexedScreen, private readonly audio: AudioContext) {}
  stop() {
    this.controller?.abort(); this.controller = undefined;
    for (const node of this.nodes) node.stop();
    this.nodes.clear();
  }
  preserveNextFrame() { this.preserve = true; }
  async play(name: string, side: CampaignSide, skippable = true, clearScreen = true, preserveScreen = false): Promise<void> {
    this.stop();
    preserveScreen ||= this.preserve; this.preserve = false;
    const controller = this.controller = new AbortController(), { signal } = controller;
    const waitUntil = (time: number) => new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const poll = () => {
        if (signal.aborted || this.audio.currentTime >= time) { done(); return; }
        timer = setTimeout(poll, Math.min(100, Math.max(1, (time - this.audio.currentTime) * 1000)));
      };
      signal.addEventListener('abort', done, { once: true }); poll();
    });
    const escape = (event: KeyboardEvent) => { if (skippable && event.key === 'Escape') { event.preventDefault(); this.stop(); } };
    window.addEventListener('keydown', escape);
    try {
      const data = await this.assets.movie(name, side);
      if (!data || signal.aborted) return;
      // CONQUER.CPP Play_Movie: a quarter-second palette fade, except when the
      // next movie continues the current image (Choose_Side and Nod_Ending).
      if (!preserveScreen) {
        const start = this.audio.currentTime, brightness = this.screen.fadeLevel;
        for (let step = 1; step <= 15 && !signal.aborted; step++) {
          this.screen.fade(brightness * (1 - step / 15)); await waitUntil(start + step / 60);
        }
        if (signal.aborted) return;
        this.screen.set(BLACK_PIXEL, BLACK_PALETTE, 1, 1); this.screen.fade(1);
      }
      const video = await VqaVideo.open(data.source, signal);
      let table: Uint8Array = new Uint8Array(65536), lastPalette = -1;
      let audioEnd = this.audio.currentTime + 0.12, frameTime = audioEnd;
      for (let frame; !signal.aborted && (frame = await video.next(signal)); frameTime += 1 / video.fps) {
        // Keep at most a small audio lookahead, including the movie's initial pre-roll chunk.
        if (frameTime < this.audio.currentTime - 0.1) { frameTime = this.audio.currentTime; audioEnd = Math.max(audioEnd, frameTime); }
        for (const bytes of frame.audio) {
          const samples = bytes.length / (video.sampleBits / 8) / video.channels;
          const buffer = this.audio.createBuffer(video.channels, samples, video.sampleRate);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let channel = 0; channel < video.channels; channel++) {
            const output = buffer.getChannelData(channel);
            for (let i = 0; i < samples; i++) output[i] = video.sampleBits === 16
              ? view.getInt16((i * video.channels + channel) * 2, true) / 32768
              : (bytes[i * video.channels + channel] - 128) / 128;
          }
          const node = this.audio.createBufferSource(); node.buffer = buffer; node.connect(this.audio.destination);
          this.nodes.add(node); node.onended = () => { this.nodes.delete(node); node.disconnect(); };
          node.start(audioEnd); audioEnd += samples / video.sampleRate;
        }
        await waitUntil(frameTime);
        if (signal.aborted) return;
        if (frame.paletteIndex !== lastPalette) {
          lastPalette = frame.paletteIndex;
          if (data.palette) table = vqpTable(data.palette, lastPalette);
          else for (let a = 0; a < 256; a++) table.fill(a, a * 256, (a + 1) * 256);
        }
        this.screen.set(frame.pixels, frame.palette, video.width, video.height, table, 0, Math.trunc((200 - video.height) / 2));
        this.screen.fade(1);
      }
      if (!signal.aborted) await waitUntil(audioEnd);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      window.removeEventListener('keydown', escape);
      if(clearScreen||signal.aborted){this.screen.set(BLACK_PIXEL,BLACK_PALETTE,1,1);this.screen.fade(1);}
      if (this.controller === controller) this.stop();
    }
  }
}
