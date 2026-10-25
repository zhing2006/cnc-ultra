// Independent WSA frames from the pinned OpenRA decoder; original media stays outside Git.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url), helper = new URL('refs/openra-wsa/', root);
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
    string[] names={"CHOOSE","S-GDIIN2","SCRSCN1"};
    foreach(string name in names) {
      using var file=File.OpenRead(Path.Combine(args[0],name=="CHOOSE"?"transit.mix":"gdi/general.mix"));using var reader=new BinaryReader(file);
      int count=reader.ReadUInt16();reader.ReadUInt32();int start=6+count*12;
      byte[] bytes=null;
      for(int i=0;i<count;i++) {uint id=reader.ReadUInt32();int offset=reader.ReadInt32(),size=reader.ReadInt32();if(id==Id(name+".WSA")){file.Position=start+offset;bytes=reader.ReadBytes(size);break;}}
      if(bytes==null)throw new Exception("Missing "+name);
      using var stream=new MemoryStream(bytes);using var header=new BinaryReader(stream);
      int frames=header.ReadUInt16();stream.Position=6;int width=header.ReadUInt16(),height=header.ReadUInt16(),delta=header.ReadUInt16();header.ReadUInt16();
      var offsets=new int[frames+2];for(int i=0;i<offsets.Length;i++)offsets[i]=header.ReadInt32()+768;
      var palette=header.ReadBytes(768);var pixels=new byte[width*height];var bgra=new byte[pixels.Length*4];
      // WsaVideo allocates width*height for LCW output, which is too small for CHOOSE frame 1.
      // Use the original header's Delta size with the same independent OpenRA codecs.
      for(int f=0;f<frames;f++){
        var raw=bytes.AsSpan(offsets[f],offsets[f+1]-offsets[f]).ToArray();var intermediate=new byte[Math.Max(delta,width*height)+37];
        LCWCompression.DecodeInto(raw,intermediate);XORDeltaCompression.DecodeInto(intermediate,pixels,0);
        for(int i=0;i<pixels.Length;i++){for(int c=0;c<3;c++){int value=palette[pixels[i]*3+2-c]<<2;bgra[i*4+c]=(byte)(value|(value>>6));}bgra[i*4+3]=255;}
        Console.WriteLine(name+" "+f+" "+width+" "+height+" "+Convert.ToHexString(SHA256.HashData(bgra)).ToLowerInvariant());
      }
    }
  }
}`);
execFileSync('dotnet', ['build', 'Export.csproj', '-c', 'Release', '--nologo', '-v', 'quiet'], { cwd: fileURLToPath(helper), stdio: 'inherit', windowsHide: true });
const output = execFileSync('dotnet', [fileURLToPath(new URL('bin/Release/net9.0/Export.dll', helper)), fileURLToPath(new URL('data/', root))], { encoding: 'utf8', windowsHide: true });
writeFileSync(new URL('openra-wsa.txt', import.meta.url), '# Original WSA frames (BGRA) from pinned OpenRA LCW and XOR codecs.\n' + output.replaceAll('\r\n', '\n'));
console.log(`Exported ${output.trim().split(/\r?\n/).length} WSA digests.`);
