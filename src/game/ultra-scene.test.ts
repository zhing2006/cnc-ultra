import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { MixFile, MixSet } from './formats/mix.ts';
import { DATA_FILES } from './data-files.ts';
import { collectMapSamples } from './map-generator/samples.ts';
import { MOVEMENT } from './data/movement.ts';
import { BUILDINGS } from './data/buildings.ts';
import { HUNT } from './simulation/combat-state.ts';
import { ultraScene } from './ultra-scene.ts';

const mix = new MixSet([...DATA_FILES, 'tempicnh.mix', 'updatec.mix'].map(name => new MixFile(readFileSync(new URL(`../../assets/dev/${name}`, import.meta.url)))));
const samples = collectMapSamples(mix);

for (const [width, height] of [[384, 256], [512, 256], [640, 320]]) test(`deploys two complete armies with original occupancy and speed order on ${width}x${height}`, () => {
  const world = ultraScene(mix, samples, { seed: 1995, width, height }), { setup } = world;
  expect(setup.grid.width).toBe(width + 2); expect(setup.grid.height).toBe(height + 2);
  const occupied = new Set<number>();
  for (const b of world.buildings) for (const [x, y] of BUILDINGS.get(b.type)!.occupy) occupied.add(b.cell + y * setup.grid.width + x);
  for (let owner = 0; owner < 2; owner++) {
    const alive = setup.units.map((unit, id) => ({ unit, id, type: MOVEMENT[unit.type] })).filter(({ unit, type }) => unit.owner === owner && unit.health !== 0 && type.domain !== 2);
    expect(alive).toHaveLength(10000);
    const ground = alive.filter(({ unit, type }) => !unit.attached && !type.domain && type.locomotion < 5);
    let previousSpeed = Infinity, previousX = owner ? -1 : setup.grid.width;
    for (const { unit, id, type } of ground) {
      expect(world.passable[unit.cell]).toBe(1); expect(occupied.has(unit.cell)).toBe(false); occupied.add(unit.cell);
      expect(world.tiberium.amount[unit.cell]).toBe(-1);
      expect(setup.missions![id]).toBe(HUNT);
      expect(type.speed).toBeLessThanOrEqual(previousSpeed); previousSpeed = type.speed;
      const x = unit.cell % setup.grid.width;
      expect(owner ? x >= previousX : x <= previousX).toBe(true); previousX = x;
    }
    const groundX = ground.map(({ unit }) => unit.cell % setup.grid.width);
    for (const { unit } of alive.filter(({ type }) => type.domain === 1)) expect(owner ? unit.cell % setup.grid.width > Math.max(...groundX) : unit.cell % setup.grid.width < Math.min(...groundX)).toBe(true);
  }
  // Original naval movement needs water in the southern reinforcement row and at both patrol ends.
  for (const id of world.navalIds) {
    const unit = setup.units[id]; expect(world.navalMap.land[unit.cell]).toBe(2);
    if (MOVEMENT[unit.type].name === 'BOAT') {
      const row = Math.trunc(unit.cell / setup.grid.width) * setup.grid.width;
      expect(world.navalMap.land[row]).toBe(2); expect(world.navalMap.land[row + setup.grid.width - 1]).toBe(2);
    }
  }
}, 30000);
