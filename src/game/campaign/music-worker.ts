import { AudStreamDecoder } from '../formats/aud-stream.ts';

let decoder:AudStreamDecoder;
self.onmessage=(event:MessageEvent<{id:number;header?:Uint8Array;block?:Uint8Array}>)=>{
  const {id,header,block}=event.data;
  try{
    if(header){decoder=new AudStreamDecoder(header);self.postMessage({id,rate:decoder.rate,end:decoder.end});}
    else if(block){const samples=decoder.decode(block);self.postMessage({id,samples},{transfer:[samples.buffer]});}
  }catch(error){self.postMessage({id,error:error instanceof Error?error.message:String(error)});}
};
