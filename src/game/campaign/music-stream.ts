import { BufferedSource,type ByteSource } from '../formats/remote-mix.ts';

interface DecodedBlock {rate?:number;end?:number;samples?:Float32Array;error?:string}

/** A bounded audio-clock queue: compressed ranges, worker decode, small AudioBuffers. */
export class MusicStream extends EventTarget {
  private readonly abort=new AbortController();
  private readonly worker=new Worker(new URL('./music-worker.ts',import.meta.url),{type:'module'});
  private readonly source:BufferedSource;
  private readonly nodes=new Set<AudioBufferSourceNode>();
  private readonly requests=new Map<number,{resolve:(value:DecodedBlock)=>void;reject:(error:Error)=>void}>();
  private requestId=0;
  private cursor=0;
  private complete=false;
  private ended=false;
  private failure?:Error;
  private readonly gain:GainNode;
  readonly ready:Promise<void>;
  private rejectStart!:(error:unknown)=>void;
  constructor(private readonly context:AudioContext,source:ByteSource,private readonly output:AudioNode,
    private readonly loop:boolean,private readonly onError:(error:unknown)=>void,volume=1){
    super();this.source=new BufferedSource(source,64*1024);
    this.gain=context.createGain();this.gain.gain.value=volume;this.gain.connect(output);
    this.worker.onmessage=(event:MessageEvent<DecodedBlock&{id:number}>)=>{
      const pending=this.requests.get(event.data.id);if(!pending)return;this.requests.delete(event.data.id);
      if(event.data.error)pending.reject(new Error(event.data.error));else pending.resolve(event.data);
    };
    this.worker.onerror=event=>{const error=this.failure=new Error(event.message);for(const pending of this.requests.values())pending.reject(error);this.requests.clear();};
    let started=false,resolveStart!:()=>void;
    this.ready=new Promise<void>((resolve,reject)=>{resolveStart=resolve;this.rejectStart=reject;});
    void this.pump(()=>{started=true;resolveStart();}).catch(error=>{
      const stopped=this.abort.signal.aborted;this.rejectStart(error);this.stop();if(started&&!stopped)this.onError(error);
    });
  }
  private decode(data:{header?:Uint8Array;block?:Uint8Array}){
    if(this.abort.signal.aborted)return Promise.reject(new DOMException('Music stopped','AbortError'));
    if(this.failure)return Promise.reject(this.failure);
    return new Promise<DecodedBlock>((resolve,reject)=>{
      const id=++this.requestId;this.requests.set(id,{resolve,reject});
      const bytes=data.header??data.block!;
      this.worker.postMessage({id,...data},[bytes.buffer]);
    });
  }
  private wait(milliseconds?:number){
    return new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);this.abort.signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,milliseconds??Math.min(250,Math.max(1,(this.cursor-this.context.currentTime-1)*1000)));
      this.abort.signal.addEventListener('abort',done,{once:true});
    });
  }
  private async pump(ready:()=>void){
    const signal=this.abort.signal;
    do{
      const header=(await this.source.read(0,12,signal)).slice();
      const format=await this.decode({header});const rate=format.rate!,end=format.end!;
      let offset=12;
      while(offset<end&&!signal.aborted){
        while(this.cursor-this.context.currentTime>1&&!signal.aborted)await this.wait();
        if(signal.aborted)return;
        const chunk=await this.source.read(offset,8,signal),size=new DataView(chunk.buffer,chunk.byteOffset,chunk.byteLength).getUint16(0,true);
        const block=(await this.source.read(offset,8+size,signal)).slice();offset+=8+size;
        const {samples}=await this.decode({block});
        for(let at=0;at<samples!.length&&!signal.aborted;at+=4096){
          while(this.cursor-this.context.currentTime>1&&!signal.aborted)await this.wait();
          if(signal.aborted)return;
          const part=samples!.subarray(at,at+4096),buffer=this.context.createBuffer(1,part.length,rate);
          buffer.copyToChannel(part as Float32Array<ArrayBuffer>,0);
          const node=this.context.createBufferSource();node.buffer=buffer;node.connect(this.gain);this.nodes.add(node);
          node.onended=()=>{node.disconnect();this.nodes.delete(node);this.finish();};
          this.cursor=Math.max(this.cursor,this.context.currentTime+0.04);node.start(this.cursor);this.cursor+=part.length/rate;ready();
        }
      }
    }while(this.loop&&!signal.aborted);
    this.complete=true;ready();this.finish();
  }
  private finish(){
    if(!this.complete||this.nodes.size||this.abort.signal.aborted||this.ended)return;
    this.ended=true;this.worker.terminate();this.gain.disconnect();this.dispatchEvent(new Event('ended'));
  }
  async fadeOut(seconds=1){
    const start=this.context.currentTime,end=start+seconds;
    this.gain.gain.cancelScheduledValues(start);this.gain.gain.setValueAtTime(this.gain.gain.value,start);this.gain.gain.linearRampToValueAtTime(0,end);
    while(!this.ended&&!this.abort.signal.aborted&&this.context.currentTime<end)await this.wait(Math.min(100,Math.max(1,(end-this.context.currentTime)*1000)));
  }
  stop(){
    if(this.abort.signal.aborted)return;
    this.abort.abort();this.worker.terminate();
    const error=new DOMException('Music stopped','AbortError');this.rejectStart(error);for(const pending of this.requests.values())pending.reject(error);this.requests.clear();
    for(const node of this.nodes){node.onended=null;node.stop();node.disconnect();}this.nodes.clear();
    this.gain.disconnect();
  }
}
