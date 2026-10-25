import { existsSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import { MixFile } from './mix.ts';
import { decodeAud } from './aud.ts';
import { AudStreamDecoder } from './aud-stream.ts';

if(existsSync('data/scores.mix'))it('streams the full No Mercy track with the original continuous IMA predictor',()=>{
  const bytes=new MixFile(readFileSync('data/scores.mix')).get('NOMERCY.AUD')!;
  const original=decodeAud(bytes),expected=new Float32Array(original.pcm.length/(original.bits/8));
  const pcm=new DataView(original.pcm.buffer,original.pcm.byteOffset,original.pcm.byteLength);
  for(let i=0;i<expected.length;i++)expected[i]=original.bits===16?pcm.getInt16(i*2,true)/32768:(original.pcm[i]-128)/128;
  const stream=new AudStreamDecoder(bytes.subarray(0,12)),hash=createHash('sha256');let samples=0,blocks=0;
  for(let at=12;at<stream.end;){const size=new DataView(bytes.buffer,bytes.byteOffset+at,8).getUint16(0,true)+8;
    const part=stream.decode(bytes.subarray(at,at+size));hash.update(new Uint8Array(part.buffer));samples+=part.length;blocks++;at+=size;}
  expect(blocks).toBeGreaterThan(100);expect(samples).toBe(expected.length);
  expect(hash.digest('hex')).toBe(createHash('sha256').update(new Uint8Array(expected.buffer)).digest('hex'));
});
