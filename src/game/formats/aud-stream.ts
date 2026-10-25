import { decodeAud,ImaStream } from './aud.ts';

/** AUD block decoder. IMA predictor state survives chunk boundaries. */
export class AudStreamDecoder {
  readonly rate:number;
  readonly bits:number;
  readonly channels:number;
  readonly end:number;
  readonly totalBytes:number;
  private readonly codec:number;
  private readonly ima=new ImaStream();
  private written=0;
  constructor(private readonly header:Uint8Array){
    const view=new DataView(header.buffer,header.byteOffset,header.byteLength);
    this.rate=view.getUint16(0,true);this.end=12+view.getUint32(2,true);this.totalBytes=view.getUint32(6,true);
    this.bits=header[10]&2?16:8;this.channels=header[10]&1?2:1;this.codec=header[11];
    if(this.channels!==1||![1,99].includes(this.codec))throw new Error('Unsupported AUD codec or channel layout');
  }
  decode(block:Uint8Array){
    const view=new DataView(block.buffer,block.byteOffset,block.byteLength),size=view.getUint16(0,true),decoded=view.getUint16(2,true);
    if(view.getUint32(4,true)!==0xdeaf||block.length!==size+8)throw new Error('Invalid AUD chunk');
    let pcm:Uint8Array;
    if(this.codec===99)pcm=this.ima.decode(block.subarray(8)).subarray(0,this.totalBytes-this.written);
    else{
      const bytes=new Uint8Array(12+block.length);bytes.set(this.header);bytes.set(block,12);
      const header=new DataView(bytes.buffer);header.setUint32(2,block.length,true);header.setUint32(6,decoded,true);
      pcm=decodeAud(bytes).pcm;
    }
    this.written+=pcm.length;
    const samples=new Float32Array(pcm.length/(this.bits/8)),data=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);
    for(let i=0;i<samples.length;i++)samples[i]=this.bits===16?data.getInt16(i*2,true)/32768:(pcm[i]-128)/128;
    return samples;
  }
}
