import { expect, it } from 'vitest';
import { gridEdges } from '../../engine/simulation/state.ts';
import { movementType } from '../data/movement.ts';
import { CpuSight } from './sight.ts';
import { initialUnits, WORDS, UX, UY, UTYPE, UGENERATION } from './units-state.ts';

it('keeps each house exploration separate and retains terrain after its MCV leaves', () => {
  const width = 32, height = 12;
  const cells = [5 * width + 4, 5 * width + 26];
  const units = initialUnits({ grid: gridEdges(width, height, new Uint8Array(width * height).fill(1)),
    land: new Uint8Array(width * height), seed: 1995,
    units: cells.map((cell, owner) => ({ cell, owner, type: movementType('MCV') })),
  });
  const sights = [0, 1].map(owner => new CpuSight(width, height, 2, owner));
  for (const [owner, sight] of sights.entries()) {
    sight.step(units);
    // UNIT.CPP Look only reveals for the owning player. UDATA.CPP gives the MCV radius 2;
    // MAP.CPP Sight_From uses max(dx,dy) + min(dx,dy)/2 with integer truncation.
    for (let cell = 0; cell < width * height; cell++) {
      const dx = Math.abs(cell % width - cells[owner] % width), dy = Math.abs(Math.trunc(cell / width) - 5);
      expect(sight.current[cell], `house ${owner}, cell ${cell}`).toBe(Number(Math.max(dx, dy) + Math.trunc(Math.min(dx, dy) / 2) <= 2));
    }
    expect(sight.mapped[cells[owner]]).toBe(1);
    expect(sight.mapped[cells[1 - owner]]).toBe(0);
  }
  units[WORDS + UX] = 16 * 256 + 128;
  units[WORDS + UY] = 5 * 256 + 128;
  sights.forEach(sight => sight.step(units));
  expect(sights[1].mapped[cells[1]]).toBe(1);
  expect(sights[1].current[cells[1]]).toBe(0);
  expect(sights[1].mapped[5 * width + 16]).toBe(1);
  expect(sights[0].mapped[5 * width + 16]).toBe(0);
});

it('waits for a reinforcement to enter the playable map before revealing its footprint', () => {
  const width = 20, height = 12, cell = 5 * width + 3;
  const units = initialUnits({ grid: gridEdges(width, height, new Uint8Array(width * height).fill(1)),
    land: new Uint8Array(width * height), seed: 1995, units: [{ cell, type: movementType('MCV') }],
  });
  const sight = new CpuSight(width, height, 1, 0, { x: 4, y: 3, width: 12, height: 6 });
  sight.step(units);
  // MAP.CPP Sight_From applies In_Radar to the source, not to each destination cell.
  expect(sight.mapped.some(Boolean)).toBe(false);
  expect(sight.current.some(Boolean)).toBe(false);
  units[UX] += 256;
  sight.step(units);
  expect(sight.mapped[cell + 1]).toBe(1);
  expect(sight.mapped[cell]).toBe(1);
});

it('reveals the larger footprint of a new actor reusing a slot and center cell', () => {
  const width = 20, height = 12, cell = 6 * width + 8;
  const units = initialUnits({ grid: gridEdges(width, height, new Uint8Array(width * height).fill(1)),
    land: new Uint8Array(width * height), seed: 1995, units: [{ cell, type: movementType('E1') }],
  });
  const sight = new CpuSight(width, height, 1);
  sight.step(units);
  expect(sight.mapped[cell + 3]).toBe(0);
  units[UTYPE] = movementType('MTNK');
  units[UGENERATION]++;
  sight.step(units);
  // UDATA.CPP gives the medium tank sight 3; UNIT.CPP Look must reveal it on arrival.
  expect(sight.current[cell + 3]).toBe(1);
  expect(sight.mapped[cell + 3]).toBe(1);
});
