import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { withApp, type Session } from './browser.ts';

async function compose() {
  const { createRenderer } = await import('../src/engine/renderer.ts');
  const { PalettePipeline } = await import('../src/engine/indexed/pipeline.ts');
  const { loadData } = await import('../src/game/data-files.ts');
  const { buildScene } = await import('../src/game/scene.ts');
  const { buildPreview } = await import('../src/game/preview.ts');
  const { overlapFixture, OVERLAP_ORDER } = await import('../tests/visual-fixture.ts');
  const { paint } = await import('../tests/reference/paint.ts');
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;width:16px;height:16px;visibility:hidden';
  document.body.append(canvas);
  const renderer = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!renderer) throw new Error('no WebGPU');
  const mix = await loadData(true);
  const failures: string[] = [];
  let comparisons = 0;
  try {
    const overlap = buildScene(mix, overlapFixture());
    if (JSON.stringify(overlap.objects.map(o => o.key)) !== JSON.stringify(OVERLAP_ORDER)) failures.push('object sort order');
    const gallery = buildPreview(mix, { group: 'cloak', theater: 'TEMPERATE', house: 'BadGuy', facing: 0, buildingState: 'intact', cloak: 'normal' });
    const cases = [
      { scene: overlap, views: [{ x: 160, y: 90, width: 120, height: 130 }], frames: [0] },
      { scene: gallery.scene, views: [{ x: 0, y: 0, width: gallery.width, height: gallery.height },
        { x: 112, y: 152, width: 436, height: 245 },
        { x: 360, y: 140, width: 260, height: 290 }], frames: [0, 1, 2, 3, 4, 5, 6, 7] },
    ];
    for (const item of cases) {
      const pipeline = new PalettePipeline(renderer.three, { ...item.scene.setup, spriteCapacity: item.scene.sprites.length });
      try {
        pipeline.setSprites(item.scene.sprites);
        for (const view of item.views) for (const frame of item.frames) {
          pipeline.setTime(frame * 1000 / 15 + 0.01);
          const readback = pipeline.readIndices(view);
          const expected = paint(item.scene, item.scene.sprites, view, frame);
          const gpu = await readback;
          const at = gpu.findIndex((value, i) => value !== expected[i]);
          if (at >= 0) failures.push(`frame ${frame}, view ${view.x},${view.y}: pixel ${at % view.width},${Math.floor(at / view.width)} is ${gpu[at]}, expected ${expected[at]}`);
          comparisons++;
        }
      } finally {
        pipeline.dispose();
      }
    }
  } finally {
    renderer.dispose();
    canvas.remove();
  }
  return { failures, comparisons };
}

/** Screenshots are checked for exact integer blocks, not recorded as golden images. */
async function nearestBlocks(data: { png: string; scale: number }) {
  const response = await fetch(`data:image/png;base64,${data.png}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  const { data: pixels } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const rgba = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
  let mismatches = 0;
  const colors = new Set<number>();
  // Only scaled screenshots need block checks; the 1x screenshot checks map margins below.
  if (data.scale > 1) for (let top = 0; top < bitmap.height; top += data.scale) {
    for (let left = 0; left < bitmap.width; left += data.scale) {
      const expected = rgba[top * bitmap.width + left];
      colors.add(expected);
      const bottom = Math.min(top + data.scale, bitmap.height);
      const right = Math.min(left + data.scale, bitmap.width);
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        if (rgba[y * bitmap.width + x] !== expected) mismatches++;
      }
    }
  }
  const lit = (x: number, y: number) => {
    const at = (y * bitmap.width + x) * 4;
    return pixels[at] !== 0 || pixels[at + 1] !== 0 || pixels[at + 2] !== 0;
  };
  const columns = Array.from({ length: bitmap.width }, (_, x) => lit(x, Math.floor(bitmap.height / 2)));
  const rows = Array.from({ length: bitmap.height }, (_, y) => lit(Math.floor(bitmap.width / 2), y));
  const margins = { left: columns.indexOf(true), right: bitmap.width - columns.lastIndexOf(true) - 1,
    top: rows.indexOf(true), bottom: bitmap.height - rows.lastIndexOf(true) - 1 };
  bitmap.close();
  return { mismatches, colors: colors.size, margins };
}

/** Observe the next actual game frame without exposing a test interface in the application. */
async function gameView() {
  const { PalettePipeline } = await import('../src/engine/indexed/pipeline.ts');
  return new Promise<{ x: number; y: number; width: number; height: number; scale: number }>(resolve => {
    const render = PalettePipeline.prototype.render;
    PalettePipeline.prototype.render = function (view, scale) {
      PalettePipeline.prototype.render = render;
      render.call(this, view, scale);
      resolve({ ...view, scale });
    };
  });
}

async function checkCamera(page: Page) {
  // The shared page is 720 pixels high, so starts at 1x. Continue with keyboard zoom and screenshots.
  // Startup can finish before the first animation frame has initialized the camera scale.
  await page.evaluate(gameView);
  for (const scale of [2, 3]) {
    await page.keyboard.press('=');
    assert.equal((await page.evaluate(gameView)).scale, scale);
    const png = (await page.screenshot()).toString('base64');
    const blocks = await page.evaluate(nearestBlocks, { png, scale });
    assert.equal(blocks.mismatches, 0, `every ${scale}x block must be a single original pixel`);
    assert(blocks.colors > 20, 'the zoomed scene must contain the original art');
  }

  await page.setViewportSize({ width: 1600, height: 1600 });
  await page.evaluate(gameView);
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  const wideView = await page.evaluate(gameView);
  assert.equal(wideView.scale, 1);
  const wideImage = await page.evaluate(nearestBlocks, { png: (await page.screenshot()).toString('base64'), scale: 1 });
  // scg08eb's playable area is 56 × 59 original 24-pixel cells.
  assert.deepEqual(wideImage.margins, { left: 128, right: 128, top: 92, bottom: 92 },
    'the playable map should be centered when it fits inside the game window');

  const pointer = { x: 1000, y: 900 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.wheel(0, -120);
  const firstDetent = await page.evaluate(gameView);
  assert.equal(firstDetent.scale, 1, 'one wheel detent should not yet change the zoom');
  await page.mouse.wheel(0, -120);
  const zoomed = await page.evaluate(gameView);
  assert.equal(zoomed.scale, 2, 'two wheel detents should change the zoom by one level');
  assert.equal(zoomed.x + pointer.x / zoomed.scale, wideView.x + pointer.x,
    'wheel zoom should keep the same world point under the pointer after centering');
  assert.equal(zoomed.y + pointer.y / zoomed.scale, wideView.y + pointer.y);
  await page.setViewportSize({ width: 1280, height: 720 });
}

export function checkOriginalVisuals(session: Session) {
  return withApp(session, {}, async page => {
    await page.locator('canvas[data-status="running"]').waitFor({ state: 'attached' });
    // The offscreen index checks have their own targets and do not change the game view. Run them
    // while the same page exercises the camera, and finish both before navigating to the preview.
    const results = await Promise.allSettled([
      page.evaluate(compose).then(result => {
        assert.equal(result.comparisons, 25);
        assert.deepEqual(result.failures, [], 'original sprite order and all cloaking phases, including clipped sprites');
      }),
      checkCamera(page),
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'rendering or camera checks failed');

    // Continue on the same browser page into the standalone preview and exercise each kind of asset.
    await page.goto(`${session.baseUrl}/?preview=assets`);
    // The preview compiles its own renderer while the acceptance simulation is also using the GPU.
    await page.locator('canvas[data-status="preview"]').waitFor({ state: 'attached', timeout: 30000 });
    assert.equal(await page.locator('[data-asset-name]').count(), 47);
    await page.getByLabel('Scale', { exact: true }).selectOption('1');
    const centered = await page.locator('canvas').evaluate(canvas => {
      const view = canvas.closest('.scroll')!;
      const rect = canvas.getBoundingClientRect();
      const bounds = view.getBoundingClientRect();
      return { left: rect.left - bounds.left, right: bounds.left + view.clientWidth - rect.right,
        pixelLeft: rect.left * devicePixelRatio };
    });
    assert(Math.abs(centered.left - centered.right) <= 1, 'a small gallery should be centered in the scroll viewport');
    assert.equal(centered.pixelLeft, Math.round(centered.pixelLeft), 'centering should preserve physical pixel alignment');
    await page.getByLabel('Scale', { exact: true }).selectOption('4');
    const overflowing = await page.locator('canvas').evaluate(canvas => {
      const view = canvas.closest('.scroll')!;
      return canvas.getBoundingClientRect().left - view.getBoundingClientRect().left;
    });
    assert.equal(overflowing, 16, 'an overflowing gallery should start at the scroll viewport padding');
    await page.getByLabel('Scale', { exact: true }).selectOption('1');
    await page.getByLabel('House', { exact: true }).selectOption('BadGuy');
    await page.getByLabel('Facing', { exact: true }).selectOption('64');
    await page.getByLabel('Category', { exact: true }).selectOption('buildings');
    await page.getByLabel('Building state', { exact: true }).selectOption('damaged');
    await page.locator('[data-asset-name="PROC"]').waitFor();
    await page.getByLabel('Theater', { exact: true }).selectOption('DESERT');
    await page.locator('[data-asset-name="V37"]').waitFor();
    await page.getByLabel('Building state', { exact: true }).selectOption('ruined');
    await page.getByLabel('Category', { exact: true }).selectOption('cloak');
    await page.locator('[data-asset-name="hidden"]').waitFor();
    assert.equal(await page.locator('[data-asset-name]').count(), 6);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.getByRole('alert').count(), 0);
  });
}
