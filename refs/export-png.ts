// Exports OpenRA's decoding of the original shape and template files as reference images for the
// format tests, and writes their digests to tests/reference/openra.txt.
//
// The PNGs stay in refs/openra-png/, one directory per file, for anyone who wants to look at a frame;
// only the digests are committed. OpenRA is built from refs/source/openra/ first if it has not been
// built yet, which needs the .NET SDK (6 or later; OpenRA targets net6.0).
//
//   node refs/export-png.ts

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { INFANTRY } from '../src/game/data/infantry.ts';
import { TEMPLATES, THEATER_TEMPERATE } from '../src/game/data/templates.ts';
import { UNITS } from '../src/game/data/units.ts';
import { DESERT_DATA_FILES } from '../src/game/data-files.ts';
import { BUILDINGS } from '../src/game/data/buildings.ts';
import { TERRAIN } from '../src/game/data/terrain.ts';
import { OVERLAYS } from '../src/game/data/overlays.ts';
import { SMUDGES } from '../src/game/data/smudges.ts';
import { AIRCRAFT } from '../src/game/data/aircraft.ts';
import { resolve } from 'node:path';
import { MixFile, MixSet } from '../src/game/formats/mix.ts';
import { framesDigest, PNG_DIRECTORY, REFERENCE_FILE, type ReferenceFormat } from '../tests/reference/digest.ts';
import { readIndexedPng } from '../tests/reference/png.ts';

const root = new URL('../', import.meta.url);
const openra = fileURLToPath(new URL('refs/source/openra/', root));
const output = fileURLToPath(PNG_DIRECTORY);
const run = promisify(execFile);

if (!existsSync(openra)) throw new Error('refs/source/openra/ is missing; run refs/fetch.ps1 or refs/fetch.sh first');
if (!existsSync(`${openra}bin/OpenRA.Utility.dll`) || !existsSync(`${openra}bin/OpenRA.Mods.Cnc.dll`)) {
  const platform = process.platform === 'win32' ? 'win-x64' : 'unix-generic';
  for (const project of ['OpenRA.Utility/OpenRA.Utility.csproj', 'OpenRA.Mods.Cnc/OpenRA.Mods.Cnc.csproj']) {
    execFileSync('dotnet', ['build', project, '-c', 'Release', `-p:TargetPlatform=${platform}`], {
      cwd: openra, stdio: 'inherit',
    });
  }
}

// OpenRA's --png skips padding when a trimmed frame happens to have its original dimensions,
// even if its origin moved. This shifts edge-touching art one pixel. Correct only that export
// condition; its independent format decoders are unchanged. Restore the reference source after
// compiling the command, including when compilation fails.
const exporter = `${openra}OpenRA.Mods.Common/UtilityCommands/ConvertSpriteToPngCommand.cs`;
const exporterSource = readFileSync(exporter, 'utf8');
const paddingCondition = 'if (frameSize != frame.Size)';
if (!exporterSource.includes(paddingCondition)) throw new Error('the pinned OpenRA PNG exporter has changed');
try {
  writeFileSync(exporter, exporterSource.replace(paddingCondition,
    'if (frameSize != frame.Size || offset.X != 0 || offset.Y != 0)'));
  execFileSync('dotnet', ['build', 'OpenRA.Mods.Common/OpenRA.Mods.Common.csproj', '-c', 'Release',
    `-p:TargetPlatform=${process.platform === 'win32' ? 'win-x64' : 'unix-generic'}`], { cwd: openra, stdio: 'inherit' });
} finally {
  writeFileSync(exporter, exporterSource);
}

const mix = new MixSet(DESERT_DATA_FILES.map((name) => new MixFile(readFileSync(new URL(`assets/dev/${name}`, root)))));

// Every temperate template, every vehicle and infantry shape, and the mouse pointers. OpenRA's cnc mod
// reads keyframed shapes and templates; only its ra mod reads the older shape library of MOUSE.SHP.
const jobs: { name: string; format: ReferenceFormat; mod: string }[] = [];
const temperate = TEMPLATES.filter((type) => type.theaters & THEATER_TEMPERATE);
for (const name of new Set(temperate.map((type) => `${type.name}.TEM`))) jobs.push({ name, format: 'tem', mod: 'cnc' });
for (const name of [...UNITS.keys(), ...INFANTRY.keys()]) jobs.push({ name: `${name}.SHP`, format: 'shp', mod: 'cnc' });
for (const suffix of ['TEM', 'DES']) {
  for (const type of BUILDINGS.values()) jobs.push({ name: `${type.name}.${type.theater ? suffix : 'SHP'}`, format: 'shp', mod: 'cnc' });
  for (const type of OVERLAYS.values()) jobs.push({ name: `${type.name}.${type.theater ? suffix : 'SHP'}`, format: 'shp', mod: 'cnc' });
  for (const name of [...TERRAIN.keys(), ...SMUDGES]) jobs.push({ name: `${name}.${suffix}`, format: 'shp', mod: 'cnc' });
}
for (const name of [...AIRCRAFT, 'WAKE', 'WEAP2', 'LROTOR', 'RROTOR']) jobs.push({ name: `${name}.SHP`, format: 'shp', mod: 'cnc' });
jobs.push({ name: 'CLEAR1.DES', format: 'tem', mod: 'cnc' });
jobs.push({ name: 'MOUSE.SHP', format: 'shapes', mod: 'ra' });
const present = [...new Map(jobs.filter((job) => mix.get(job.name)).map(job => [job.name, job])).values()];

if (resolve(output) !== resolve(fileURLToPath(new URL('refs/openra-png/', root)))) {
  throw new Error('the export directory must be refs/openra-png/');
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const palette = `${output}temperat.pal`;
writeFileSync(palette, mix.require('TEMPERAT.PAL'));

const environment = { ...process.env, ENGINE_DIR: openra, DOTNET_ROLL_FORWARD: 'Major' };
const queue = [...present];
await Promise.all(Array.from({ length: availableParallelism() }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const name = job.name.toLowerCase();
    const directory = `${output}${name}/`;
    mkdirSync(directory);
    writeFileSync(`${directory}${name}`, mix.require(job.name));
    const utility = `${openra}bin/OpenRA.Utility.dll`;
    await run('dotnet', [utility, job.mod, '--png', name, palette], { cwd: directory, env: environment });
  }
}));

const lines = present.map((job) => {
  const name = job.name.toLowerCase();
  const prefix = name.slice(0, name.lastIndexOf('.'));
  const directory = `${output}${name}/`;
  const files = readdirSync(directory).filter((file) => file.startsWith(`${prefix}-`) && file.endsWith('.png')).sort();
  // ShpTDSprite.TrimmedFrame gives fully transparent frames a zero size, and --png omits them.
  // Restore only those omitted frames, using the original header's common frame size and count.
  const source = mix.require(job.name);
  const header = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const count = job.format === 'shp' ? header.getUint16(0, true) : files.length;
  const frames = Array.from({ length: count }, (_, index) => {
    const file = `${directory}${prefix}-${String(index).padStart(4, '0')}.png`;
    if (existsSync(file)) return readIndexedPng(readFileSync(file));
    if (job.format !== 'shp') throw new Error(`${name}: OpenRA skipped frame ${index}`);
    const width = header.getUint16(6, true), height = header.getUint16(8, true);
    return { width, height, pixels: new Uint8Array(width * height) };
  });
  return `${name} ${job.format} ${frames.length} ${framesDigest(frames)}`;
});
writeFileSync(REFERENCE_FILE, [
  '# Digests of OpenRA\'s --png export of the original files in assets/dev/, written by refs/export-png.ts.',
  '# PNG padding preserves nonzero frame offsets; fully transparent SHP frames retain the header dimensions.',
  '# Each line: file, format, frame count, SHA-256 over every frame\'s width, height and palette indices.',
  ...lines,
  '',
].join('\n'));
console.log(`exported ${present.length} files to refs/openra-png/ and wrote tests/reference/openra.txt`);
