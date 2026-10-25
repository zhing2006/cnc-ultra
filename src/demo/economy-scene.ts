import type { MixSet } from '../game/formats/mix.ts';
import { skirmishScene } from '../game/skirmish-scene.ts';

/** One MCV on SCM01EA; only the building sandbox adds extra starting cash. */
export function economyScene(mix: MixSet, buildingDemo = true, capacity = 512) {
  return skirmishScene(mix, { seed: 0x1995, starts: [0], credits: buildingDemo ? 100000 : 10000, capacity });
}
