import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { copyDataFile } from '../refs/prepare-data.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'cnc-prepare-data-'));
  directories.push(directory);
  return directory;
}

test('Copied read-only disc files allow installer replacements', async () => {
  const directory = await temporaryDirectory();
  const source = join(directory, 'disc-cclocal.mix');
  const destination = join(directory, 'cclocal.mix');
  const disc = Buffer.from([0, 1, 255, 128]);
  const installer = Buffer.from([128, 0, 255, 2, 1]);
  await writeFile(source, disc);
  await chmod(source, 0o400);

  await copyDataFile(source, destination);
  expect(await readFile(destination)).toEqual(disc);
  await writeFile(destination, installer);
  expect(await readFile(destination)).toEqual(installer);
  expect(await readFile(source)).toEqual(disc);
});

test('Repeated data preparation replaces existing read-only files', async () => {
  const directory = await temporaryDirectory();
  const source = join(directory, 'disc-general.mix');
  const destination = join(directory, 'general.mix');
  const original = Buffer.from([1, 0, 255, 2]);
  const replacement = Buffer.from([3, 128, 0, 255, 4]);
  await writeFile(source, replacement);
  await chmod(source, 0o400);
  await writeFile(destination, original);
  await chmod(destination, 0o400);

  await copyDataFile(source, destination);
  expect(await readFile(destination)).toEqual(replacement);
  await copyDataFile(source, destination);
  expect(await readFile(destination)).toEqual(replacement);
  expect(await readFile(source)).toEqual(replacement);
});
