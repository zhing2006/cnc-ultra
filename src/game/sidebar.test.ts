import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DATA_FILES } from './data-files.ts';
import { MixFile, MixSet } from './formats/mix.ts';
import { Sidebar } from './sidebar.ts';
import { decodeShp } from './formats/shp.ts';
import { sidebarEconomy } from '../../tests/sidebar-fixture.ts';

const data = new MixSet([...DATA_FILES, 'tempicnh.mix'].map(name => new MixFile(readFileSync(new URL(`../../assets/dev/${name}`, import.meta.url)))));

it('advances original radar and power timers without repainting each fast-forward tick', () => {
  const { economy } = sidebarEconomy(), sidebar = new Sidebar(economy, data);
  try {
    const version = sidebar['texture'].version;
    for (let tick = 0; tick < 20; tick++) sidebar.update(false);
    // RADAR.CPP: first activation reaches frame 22, starting at frame 1 after initial update.
    expect(sidebar['radarFrame']).toBe(21);
    expect(sidebar['radarActive']).toBe(false);
    sidebar.update(false);
    expect(sidebar['radarFrame']).toBe(22);
    expect(sidebar['radarActive']).toBe(true);
    expect(sidebar['texture'].version).toBe(version);
    // POWER.CPP AI: one pixel each tick toward Power_Height(100) = 36.
    expect(sidebar['powerHeight']).toBe(22);
    sidebar.drawPixels();
    expect(sidebar['texture'].version).toBe(version + 1);
    expect(sidebar['powerHeight']).toBe(22);
    sidebar.drawPixels();
    expect(sidebar['texture'].version).toBe(version + 1);
    for (let tick = 22; tick < 36; tick++) sidebar.update(false);
    expect(sidebar['powerHeight']).toBe(36);
    expect(sidebar['powerBounce']).toBe(12);
    for (let tick = 0; tick < 11; tick++) sidebar.update(false);
    sidebar.drawPixels();
    expect(sidebar['powerBounce']).toBe(1);
    sidebar.update(false);
    expect(sidebar['powerBounce']).toBe(0);
  } finally { sidebar.dispose(); }
});

it('scrolls a cameo in six logic ticks even when intermediate frames are not drawn', () => {
  const { economy, available } = sidebarEconomy();
  available.splice(0, available.length, 'NUKE', 'PYLE', 'PROC', 'WEAP', 'HQ', 'HPAD');
  const sidebar = new Sidebar(economy, data);
  try {
    sidebar.viewport.value.set(640, 400);
    sidebar.hit(640 - 160 + 58, 384, 0);
    sidebar.update(false);
    expect(sidebar['scrollOffset'][0]).toBe(-8);
    expect(sidebar['scroll'][0]).toBe(0);
    for (let tick = 1; tick < 6; tick++) sidebar.update(false);
    sidebar.drawPixels();
    expect(sidebar['scrollOffset'][0]).toBe(0);
    expect(sidebar['scroll'][0]).toBe(1);
    expect(sidebar['scrollDirection'][0]).toBe(0);
  } finally { sidebar.dispose(); }
});

it('prepares a newly unlocked cameo before play instead of decoding during its first draw', () => {
  const { economy, available } = sidebarEconomy(), lookups: string[] = [];
  const source = { get(name: string) { lookups.push(name); return data.get(name); }, require: data.require.bind(data) } as MixSet;
  const sidebar = new Sidebar(economy, source);
  try {
    expect(lookups).toContain('PYLEICNH.TEM');
    lookups.length = 0;
    available.splice(0, available.length, 'PYLE');
    sidebar.update();
    expect(lookups).toEqual([]);
    const cameo = decodeShp(data.require('PYLEICNH.TEM'));
    for (let y = 0; y < cameo.height; y++) for (let x = 0; x < cameo.width; x++) {
      const ink = cameo.frames[0][y * cameo.width + x];
      if (ink) expect(sidebar['pixels'][(184 + y) * 160 + 18 + x]).toBe(ink);
    }
  } finally { sidebar.dispose(); }
});
