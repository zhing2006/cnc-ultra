import { CampaignPresentation } from '../src/game/campaign/presentation.ts';
import { decodeFont } from '../src/game/formats/font.ts';
import type { FrameCallback } from '../src/engine/renderer.ts';
import { readCampaignScenario } from '../src/game/campaign/scenario.ts';
import { campaignScene } from '../src/game/campaign/scene.ts';
import { CampaignRuntime } from '../src/game/campaign/runtime.ts';
import { startPreparedGame, type Game } from '../src/game/game.ts';

/** SCENARIO.CPP writes the result onto SeenBuff, retaining the battlefield and sidebar. */
export async function campaignOutcomeBackground() {
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:960px;height:600px'; document.body.append(canvas);
  const audio = new AudioContext();
  const presentation = await CampaignPresentation.open(canvas, audio, {
    buttons() {}, status() {}, exit() {}, mission: async () => {}, error: error => { throw error; },
  });
  if (!presentation) throw new Error('WebGPU is required');
  let game: Game | undefined;
  try {
    const { assets } = presentation, archives = ['gdi/general.mix', 'general.mix'];
    const [ini, bin, files] = await Promise.all([
      assets.bytes('SCG08EB.INI', archives), assets.bytes('SCG08EB.BIN', archives), assets.mission('gdi', 'TEMPERATE'),
    ]);
    const mission = readCampaignScenario(new TextDecoder().decode(ini), bin), world = campaignScene(files, mission);
    const capture = () => {
      const image = document.createElement('canvas'); image.width = canvas.width; image.height = canvas.height;
      const context = image.getContext('2d')!; context.drawImage(canvas, 0, 0);
      return { pixels: context.getImageData(0, 0, image.width, image.height).data, data: image.toDataURL('image/png').split(',')[1] };
    };
    let captured: ((image: ReturnType<typeof capture>) => void) | undefined;
    const setFrame = presentation.renderer.setFrame.bind(presentation.renderer);
    presentation.renderer.setFrame = frame => setFrame(frame && ((width, height, time) => {
      frame(width, height, time);
      if (captured) { const resolve = captured; captured = undefined; resolve(capture()); }
    }));
    const nextImage = () => new Promise<ReturnType<typeof capture>>(resolve => { captured = resolve; });
    game = await startPreparedGame(presentation.renderer, canvas, files,
      { kind: 'combat', scene: world.scene, setup: world.setup, economy: world, decalStart: world.decalStart },
      { createEconomy: battle => new CampaignRuntime(battle, world, mission) });
    game.setPaused(true);
    const palette = world.scene.setup.palette.filter((_, index) => index % 4 !== 3).map(value => value >> 2);
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const failures: string[] = [], screenshots: { name: string; data: string }[] = [];
    for (const won of [true, false]) {
      // Draw the paused battle, then let the browser present it before changing renderers.
      game.setPaused(false); game.setPaused(true);
      const baseline = await nextImage(), before = baseline.pixels, view = game.tacticalView(), width = canvas.width;
      screenshots.push({ name: 'campaign-outcome-battlefield', data: baseline.data });
      presentation.renderer.setFrame(null);
      await frame();
      await presentation.outcome(won, palette, view, game.drawBackground);
      const result = await nextImage(), after = result.pixels;
      for (const [label, x, y, w, h] of [
        ['battlefield', 0, 16, view.width, view.height], ['sidebar', view.width, 16, 160, view.height],
      ] as const) {
        let visible = 0, changed = 0;
        for (let row = y * view.scale; row < (y + h) * view.scale; row++) for (let column = x * view.scale; column < (x + w) * view.scale; column++) {
          if (label === 'battlefield' && Math.abs(column / view.scale - view.width / 2) < 160
            && Math.abs(row / view.scale - (view.y + view.height / 2)) < 64) continue;
          const at = (row * width + column) * 4;
          if (before[at] || before[at + 1] || before[at + 2]) visible++;
          if (before[at] !== after[at] || before[at + 1] !== after[at + 1] || before[at + 2] !== after[at + 2]) changed++;
        }
        if (!visible || changed) failures.push(`${won ? 'Victory' : 'Defeat'} ${label}: ${visible} visible pixels before, ${changed} changed after`);
      }
      screenshots.push({ name: `campaign-outcome-${won ? 'win' : 'lose'}-battlefield`, data: result.data });
    }
    return { failures, screenshots };
  } finally { game?.dispose(); presentation.dispose(); await audio.close(); canvas.remove(); }
}

/** SCENARIO.CPP Do_Win/Do_Lose center both lines inside the tactical view. */
export async function campaignOutcome() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const audio = new AudioContext();
  const presentation = await CampaignPresentation.open(canvas, audio, {
    buttons() {}, status() {}, exit() {}, mission: async () => {}, error: error => { throw error; },
  });
  if (!presentation) throw new Error('WebGPU is required');
  const failures: string[] = [], screenshots: { name: string; data: string }[] = [];
  try {
    const font = decodeFont(await presentation.assets.bytes('VCR.FNT'));
    const palette = new Uint8Array(768); palette.fill(63, 15 * 3, 16 * 3);
    const renderer = presentation.renderer.three;
    presentation.renderer.setFrame(null);
    let draw!: FrameCallback;
    presentation.renderer.setFrame = frame => { if (frame) draw = frame; };
    for (const [width, height, scale, sidebar] of [
      [640, 400, 1, 160], [1280, 800, 2, 160], [1280, 800, 1, 160],
      [1280, 800, 3, 0], [1024, 600, 2, 0],
    ]) {
      canvas.style.cssText = `width:${width}px;height:${height}px`;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      renderer.setPixelRatio(1); renderer.setSize(width, height, false);
      // SIDEBAR.CPP Activate excludes the side strip and the 16-pixel tab bar.
      const view = { x: 0, y: 16, width: Math.ceil(width / scale) - sidebar, height: Math.ceil(height / scale) - 16, scale };
      const centerX = Math.trunc(view.width / 2), centerY = view.y + Math.trunc(view.height / 2);
      for (const won of [true, false]) {
        await presentation.outcome(won, palette, view, () => renderer.clear());
        renderer.clear(); draw(width, height, performance.now());
        const image = document.createElement('canvas'); image.width = width; image.height = height;
        const context = image.getContext('2d')!; context.drawImage(canvas, 0, 0);
        const pixels = context.getImageData(0, 0, width, height).data;
        const labels = ['MISSION', won ? 'ACCOMPLISHED' : 'FAILED'];
        const expected = labels.map((label, line) => {
          const glyphs = Array.from(label, ch => font.glyphs[ch.charCodeAt(0)]);
          let cursor = centerX - Math.trunc(glyphs.reduce((sum, glyph) => sum + glyph.width, 0) / 2);
          const bounds = [width, height, -1, -1];
          for (const glyph of glyphs) {
            for (let y = 0; y < glyph.height; y++) for (let x = 0; x < glyph.width; x++) if (glyph.pixels[y * glyph.width + x]) {
              const px = (cursor + x) * scale, py = (centerY - 32 + line * 30 + y) * scale;
              bounds[0] = Math.min(bounds[0], px); bounds[1] = Math.min(bounds[1], py);
              bounds[2] = Math.max(bounds[2], px + scale - 1); bounds[3] = Math.max(bounds[3], py + scale - 1);
            }
            cursor += glyph.width;
          }
          return bounds;
        });
        let top = height;
        for (let at = 0; at < pixels.length; at += 4) if (pixels[at] >= 250 && pixels[at + 1] >= 250 && pixels[at + 2] >= 250) {
          top = Math.min(top, Math.trunc(at / 4 / width));
        }
        const actual = labels.map(() => [width, height, -1, -1]);
        for (let y = top; y < height; y++) for (let x = 0; x < width; x++) {
          const at = (y * width + x) * 4;
          if (pixels[at] < 250 || pixels[at + 1] < 250 || pixels[at + 2] < 250) continue;
          const bounds = actual[y < top + 30 * scale ? 0 : 1];
          bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
          bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
        }
        const name = `campaign-outcome-${won ? 'win' : 'lose'}-${width}x${height}-${scale}x-${sidebar}`;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
        screenshots.push({ name, data: canvas.toDataURL('image/png').split(',')[1] });
      }
    }
    return { failures, screenshots };
  } finally { presentation.dispose(); await audio.close(); canvas.remove(); }
}
