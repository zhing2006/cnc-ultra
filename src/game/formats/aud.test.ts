import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe,it,expect } from 'vitest';
import { decodeAud } from './aud.ts';

const bytes=readFileSync(new URL('../../../assets/dev/sounds.mix',import.meta.url));
const input=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=input.getUint16(0,true),start=6+count*12;
const entries=new Map(Array.from({length:count},(_,i)=>{
  const p=6+i*12,offset=start+input.getUint32(p+4,true);
  return [input.getUint32(p,true).toString(16).padStart(8,'0'),bytes.subarray(offset,offset+input.getUint32(p+8,true))] as const;
}));
const reference=readFileSync(new URL('../../../tests/reference/openra-aud.txt',import.meta.url),'utf8')
  .split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>line.split(' '));
describe('original AUD samples',()=>{
  it.each(reference)('decodes MIX entry %s exactly like OpenRA',(id,rate,bits,channels,digest)=>{
    const decoded=decodeAud(entries.get(id)!);
    expect([decoded.rate,decoded.bits,decoded.channels]).toEqual([+rate,+bits,+channels]);
    expect(createHash('sha256').update(decoded.pcm).digest('hex')).toBe(digest);
  });
});
