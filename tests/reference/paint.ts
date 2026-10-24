import type { GameScene } from '../../src/game/scene.ts';
import type { Sprite, View } from '../../src/engine/indexed/pipeline.ts';

/**
 * Independent software oracle: CELL.CPP's cell background, then KEYFBUFF.ASM's
 * Single_Line_Trans/Ghost_Trans/Predator_Trans rules applied in original draw order.
 * Preview phases omit the original's one-time logic Frame == 0 exception.
 */
export function paint(scene: GameScene, sprites: readonly Sprite[], view: View, frame: number, logicFrame = false) {
  const image = new Uint8Array(view.width * view.height);
  const { tiles, spriteAtlas, remaps, shadowSources, shadowTable, filters } = scene.setup;
  for (let y = 0; y < view.height; y++) for (let x = 0; x < view.width; x++) {
    const wx = x + view.x, wy = y + view.y;
    const cx = Math.floor(wx / tiles.tileSize), cy = Math.floor(wy / tiles.tileSize);
    if (cx < 0 || cy < 0 || cx >= tiles.columns || cy >= tiles.rows) continue;
    const tile = tiles.cells[cy * tiles.columns + cx];
    if (tile === 0xffffffff) continue;
    const perRow = tiles.atlas.width / tiles.tileSize;
    const tx = tile % perRow * tiles.tileSize + wx % tiles.tileSize;
    const ty = Math.floor(tile / perRow) * tiles.tileSize + wy % tiles.tileSize;
    image[y * view.width + x] = tiles.atlas.pixels[ty * tiles.atlas.width + tx];
  }
  const positive = [1, 3, 2, 5, 2, 3, 4, 1];
  const negative = [-1, -3, -2, -5, -2, -4, -3, -1];
  for (const sprite of sprites) {
    let ordinal = frame % 8;
    const reverse = (!logicFrame || frame !== 0) && sprite.x + Math.floor(sprite.region.width / 2) - view.x > view.width / 2;
    for (let y = 0; y < sprite.region.height; y++) for (let x = 0; x < sprite.region.width; x++) {
      const dx = sprite.x + x - view.x, dy = sprite.y + y - view.y;
      if (dx < 0 || dy < 0 || dx >= view.width || dy >= view.height) continue;
      const source = spriteAtlas.pixels[(sprite.region.y + y) * spriteAtlas.width + sprite.region.x + x];
      if (source === 0) continue;
      const at = dy * view.width + dx;
      if (sprite.displace) {
        const sx = dx + (reverse ? negative : positive)[ordinal++ % 8], sy = dy + (reverse ? 1 : 0);
        image[at] = sx < 0 || sy < 0 || sx >= view.width || sy >= view.height ? 0 : image[sy * view.width + sx];
      } else if (sprite.filter !== undefined) {
        image[at] = (filters?.[sprite.filter] ?? scene.setup.singleUseFilter!)[image[at]];
      } else if (sprite.shadow && shadowSources[source]) {
        image[at] = remaps[sprite.remap][shadowTable[image[at]]];
      } else {
        image[at] = remaps[sprite.remap][source];
      }
    }
  }
  return image;
}
