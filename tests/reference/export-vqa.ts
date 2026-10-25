// Independent movie frame and PCM digests from the pinned OpenRA decoder. No media is committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url), helper = new URL('refs/openra-vqa/', root);
mkdirSync(helper, { recursive: true });
writeFileSync(new URL('Export.csproj', helper), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup><ItemGroup>
${['OpenRA.Game', 'OpenRA.Mods.Common', 'OpenRA.Mods.Cnc'].map(name => `<Reference Include="${name}"><HintPath>../source/openra/bin/${name}.dll</HintPath></Reference>`).join('\n')}
</ItemGroup></Project>`);
writeFileSync(new URL('Program.cs', helper), `using System;
using System.IO;
using System.Security.Cryptography;
using OpenRA.Mods.Cnc.FileFormats;
class Export {
  static uint Id(string name) {
    byte[] text=System.Text.Encoding.ASCII.GetBytes(name.ToUpperInvariant()); uint hash=0;
    for(int i=0;i<text.Length;i+=4) {uint word=0;for(int j=0;j<4 && i+j<text.Length;j++)word|=(uint)text[i+j]<<(8*j);hash=((hash<<1)|(hash>>31))+word;}
    return hash;
  }
  static void Main(string[] args) {
    using var file=File.OpenRead(args[0]);using var reader=new BinaryReader(file);
    int count=reader.ReadUInt16();reader.ReadUInt32();int start=6+count*12;
    string[] names={"LOGO","INTRO2","GDI1","LANDING","CONSYARD","GAMEOVER"};
    foreach(string name in names) {
      file.Position=6;byte[] bytes=null;
      for(int i=0;i<count;i++) {uint id=reader.ReadUInt32();int offset=reader.ReadInt32(),size=reader.ReadInt32();if(id==Id(name+".VQA")){file.Position=start+offset;bytes=reader.ReadBytes(size);break;}}
      if(bytes==null)throw new Exception("Missing "+name);
      using var stream=new MemoryStream(bytes);var movie=new VqaVideo(stream,false);
      string hash(byte[] data)=>Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
      Console.WriteLine(name+" audio "+movie.SampleRate+" "+movie.SampleBits+" "+movie.AudioChannels+" "+hash(movie.AudioData));
      for(int f=0;f<movie.FrameCount;f++){Console.WriteLine(name+" "+f+" "+movie.Width+" "+movie.Height+" "+hash(movie.CurrentFrameData));movie.AdvanceFrame();}
    }
  }
}`);
execFileSync('dotnet', ['build', 'Export.csproj', '-c', 'Release', '--nologo', '-v', 'quiet'], { cwd: fileURLToPath(helper), stdio: 'inherit', windowsHide: true });
const output = execFileSync('dotnet', [fileURLToPath(new URL('bin/Release/net9.0/Export.dll', helper)),
  fileURLToPath(new URL('refs/cnc-gold/gdi/movies.mix', root))], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
writeFileSync(new URL('openra-vqa.txt', import.meta.url), '# Original GDI movie frames (BGRA) and PCM from pinned OpenRA VqaVideo.\n' + output.replaceAll('\r\n', '\n'));
console.log(`Exported ${output.trim().split(/\r?\n/).length} movie digests.`);
