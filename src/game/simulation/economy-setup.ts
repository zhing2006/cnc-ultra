import type { GameScene } from '../scene.ts';
import type { CombatSetup } from './combat-state.ts';
import type { TiberiumSetup } from './tiberium-cpu.ts';

export interface InitialBuilding { id: number; type: string; cell: number; owner: number; faction: number }

/** Map and initial state supplied by a scenario, independently of its loading or UI. */
export interface EconomySetup {
  scene: GameScene;
  setup: CombatSetup;
  passable: Uint8Array;
  basePassable: Uint8Array;
  baseLand: Uint8Array;
  buildable: Int32Array;
  playable: Int32Array;
  tiberium: TiberiumSetup;
  buildings: InitialBuilding[];
  credits: number;
  houses?: readonly [{ faction: number; credits: number }, { faction: number; credits: number }];
  oreStart: number;
  bibStart: number;
  decalStart: number;
}
