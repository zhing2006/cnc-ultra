// Extract original files without decoding or converting them. Downloads are pinned by fetch.sh/ps1.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const refs = dirname(fileURLToPath(import.meta.url));
const destination = resolve(refs, '../data');
const archives = [
  ['gdi95.iso', 'c90b284d30ae48f7a2f5a92e7d70915f3c5562d9e8a149db920a6a6378c98462', 'gdi'],
  ['nod95.iso', '721df01b8d5bb11f39223232589b6d992d4d8a34539849d026030cc31c959b2a', 'nod'],
] as const;
const tar = process.env.TAR ?? (process.platform === 'linux' ? 'bsdtar' : 'tar');
function run(args: string[]) {
  const result = spawnSync(tar, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${tar} failed: ${result.stderr}`);
  return result.stdout;
}
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest('hex');
}

export async function copyDataFile(source: string, destination: string) {
  // ISO entries can be read-only; reruns and SETUP.Z replacements need writable copies.
  const mode = ((await stat(source)).mode & 0o777) | 0o200;
  if (existsSync(destination)) await chmod(destination, mode);
  await copyFile(source, destination);
  await chmod(destination, mode);
}

// Run the pinned reference decoder as a tool; no OpenRA code or library enters the application.
async function extractInstaller(archive: string, output: string) {
  const openra = join(refs, 'source', 'openra');
  if (!existsSync(join(openra, 'bin', 'OpenRA.Mods.Common.dll'))) {
    const result = spawnSync('dotnet', ['build', 'OpenRA.Mods.Common/OpenRA.Mods.Common.csproj', '-c', 'Release',
      `-p:TargetPlatform=${process.platform === 'win32' ? 'win-x64' : 'unix-generic'}`], { cwd: openra, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Building the pinned OpenRA installer decoder failed.');
  }
  const helper = join(refs, 'installer-export');
  await mkdir(helper, { recursive: true });
  await writeFile(join(helper, 'Export.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup><ItemGroup>
<Reference Include="OpenRA.Game"><HintPath>../source/openra/bin/OpenRA.Game.dll</HintPath></Reference>
<Reference Include="OpenRA.Mods.Common"><HintPath>../source/openra/bin/OpenRA.Mods.Common.dll</HintPath></Reference>
</ItemGroup></Project>`);
  await writeFile(join(helper, 'Program.cs'), `using System;
using System.IO;
using System.Text;
using OpenRA.Mods.Common.FileFormats;
class Export {
  static void Main(string[] args) {
    using var input = File.OpenRead(args[0]);
    using var reader = new BinaryReader(input);
    input.Position = 12; int count = reader.ReadUInt16();
    input.Position = 51; input.Position = reader.ReadUInt32();
    for (int i = 0; i < count; i++) {
      input.Position += 7; reader.ReadUInt32(); long offset = reader.ReadUInt32();
      input.Position += 14; string name = Encoding.ASCII.GetString(reader.ReadBytes(reader.ReadByte()));
      input.Position += 13; long next = input.Position;
      string extension = Path.GetExtension(name).ToLowerInvariant();
      if (extension == ".mix" || extension == ".vqa" || extension == ".vqp") {
        if (Path.GetFileName(name) != name) throw new InvalidDataException("Unsafe installer path");
        input.Position = offset;
        using var target = File.Create(Path.Combine(args[1], name.ToLowerInvariant()));
        Blast.Decompress(input, target);
        Console.WriteLine("Extracted installer/" + name.ToLowerInvariant());
      }
      input.Position = next;
    }
  }
}`);
  for (const args of [
    ['build', join(helper, 'Export.csproj'), '-c', 'Release', '--nologo', '-v', 'quiet'],
    [join(helper, 'bin/Release/net9.0/Export.dll'), archive, output],
  ]) {
    const result = spawnSync('dotnet', args, { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Installer extraction needs the .NET 9 SDK and the built pinned OpenRA reference (see refs/README.md).');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Verify every source before touching an existing data installation.
  for (const [name, sha256] of archives) {
    const path = join(refs, 'downloads', name);
    if (await digest(path) !== sha256) throw new Error(`Checksum mismatch: ${name}. Run refs/fetch.sh or refs/fetch.ps1 first.`);
  }
  await mkdir(destination, { recursive: true });
  const staging = await mkdtemp(join(destination, '.extract-'));
  try {
    for (const [name, , disc] of archives) {
      const source = join(refs, 'downloads', name);
      const entries = run(['-tf', source]).split(/\r?\n/).filter(entry => {
        const plain = entry.replace(/^\.\//, '');
        if (disc === 'nod') return /^(general|movies)\.mix$/i.test(plain);
        return /^[^/]+\.(mix|vqa|vqp)$/i.test(plain) || /^install\/cclocal\.mix$/i.test(plain);
      });
      if (!entries.length) throw new Error(`No game files found in ${name}`);
      const temporary = join(staging, disc);
      await mkdir(temporary);
      run(['-xf', source, '-C', temporary, ...entries]);
      const copy = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) { await copy(path); continue; }
          if (!entry.isFile()) throw new Error(`Unexpected archive entry: ${path}`);
          const filename = entry.name.toLowerCase();
          const target = /^(general|movies)\.mix$/.test(filename)
            ? join(destination, disc) : destination;
          await mkdir(target, { recursive: true });
          await copyDataFile(path, join(target, filename));
          // The static map demonstrations use GDI's general.mix at the original common URL.
          if (disc === 'gdi' && filename === 'general.mix') await copyDataFile(path, join(destination, filename));
          console.log(`Extracted ${disc}/${filename}`);
        }
      };
      await copy(temporary);
      if (disc === 'gdi') {
        run(['-xf', source, '-C', temporary, 'INSTALL/SETUP.Z']);
        await extractInstaller(join(temporary, 'INSTALL', 'SETUP.Z'), destination);
      }
    }
  } finally {
    const absolute = resolve(staging);
    if (!absolute.startsWith(destination + sep) || !absolute.slice(destination.length + 1).startsWith('.extract-'))
      throw new Error('Refusing to remove an extraction directory outside data/');
    await rm(absolute, { recursive: true, force: true });
  }
  const manifest: Record<string, number> = {};
  for (const prefix of ['', 'gdi/', 'nod/']) for (const entry of await readdir(join(destination, prefix), { withFileTypes: true })) {
    if (entry.isFile() && /\.(mix|vqa|vqp)$/.test(entry.name) && entry.name !== 'local.mix')
      manifest[prefix + entry.name] = (await stat(join(destination, prefix, entry.name))).size;
  }
  await writeFile(join(destination, 'index.json'), JSON.stringify(manifest));
}
