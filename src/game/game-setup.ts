import type { SimulationSetup, MoveCommand } from '../engine/simulation/state.ts';
import type { GameScene } from './scene.ts';
import type { CombatSetup } from './simulation/combat-state.ts';
import type { EconomySetup } from './simulation/economy-setup.ts';

/** Prepared worlds keep scenario construction out of the renderer and simulation loop. */
export type PreparedGame =
  | { kind: 'map'; scene: GameScene }
  | { kind: 'simulation'; scene: GameScene; setup: SimulationSetup; passable: Uint8Array;
      onMapClick(cell: number): void; commands(frame: number): readonly MoveCommand[] }
  | { kind: 'combat'; scene: GameScene; setup: CombatSetup; decalStart: number; economy?: EconomySetup; faction?: number };
