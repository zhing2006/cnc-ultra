import { mkdir,writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { discoverGpus,identifyGpu,launchGpu } from './gpu.ts';
import { withApp } from './browser.ts';

const drawing=process.argv.includes('--drawing');
const counts=(process.argv.find(arg=>arg.startsWith('--counts='))?.slice(9)??'64,20000').split(',').map(Number);
const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)??'current';
if(!/^[a-z0-9-]+$/.test(label))throw new Error('Invalid measurement label');
const server=await createServer({cacheDir:'node_modules/.vite-tests',server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false},logLevel:'error'});await server.listen();
const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No test port');
const baseUrl=`http://127.0.0.1:${address.port}`;console.log('Isolated measurement server:',baseUrl);
let browser=await launchGpu();const choices=await discoverGpus(browser),runs:unknown[]=[];
await mkdir('test-results',{recursive:true});
try{
  for(const vendor of ['nvidia','amd']){
    const choice=choices.find(item=>item.vendor===vendor);if(!choice)throw new Error(`No ${vendor} GPU`);
    await browser.close();browser=await launchGpu(choice,true);const gpu=await identifyGpu(browser,baseUrl,vendor);console.log('GPU environment:',JSON.stringify(gpu));
    await withApp({browser,baseUrl,gpu},{path:'/tests/fixture.html'},async page=>{
      const profiler=await page.context().newCDPSession(page);await profiler.send('Profiler.enable');await profiler.send('Profiler.setSamplingInterval',{interval:100});
      await page.exposeFunction('startEconomyProfile',()=>profiler.send('Profiler.start'));
      await page.exposeFunction('stopEconomyProfile',async()=>{
        const {profile}=await profiler.send('Profiler.stop');
        await writeFile(`test-results/m5-cpu-${label}-${vendor}.cpuprofile`,JSON.stringify(profile));
        const totals=new Map<number,number>();for(let i=0;i<(profile.samples?.length??0);i++){const id=profile.samples![i];totals.set(id,(totals.get(id)??0)+(profile.timeDeltas?.[i]??0));}
        const hot=profile.nodes.map(n=>({name:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber+1,selfMs:(totals.get(n.id)??0)/1000})).sort((a,b)=>b.selfMs-a.selfMs).slice(0,12);
        console.log('CPU profile, ten ticks:',JSON.stringify(hot));
        await writeFile(`test-results/m5-cpu-${label}-${vendor}.json`,JSON.stringify({gpu,ticks:10,hot},null,2));
      });
      for(const count of counts){
        console.log(`Measuring ${vendor}, ${count} actors`);
        const result=await page.evaluate(async({count,drawing})=>(await import('../tests/economy-performance-fixture.ts')).measureEconomyGpu(count,drawing),{count,drawing});
        const massAir=await page.evaluate(async()=>(await import('../tests/coordination-fixture.ts')).compareMassAirCoordination(true));
        runs.push({gpu,...result,massAir});console.log(JSON.stringify({count:result.count,gpuMs:result.gpuMs,cpuMs:result.cpuMs,dispatches:result.dispatches,layerBurstGpuMs:result.layerBurstGpuMs,massAir,compileMs:result.compileMs}));
        await writeFile(`test-results/m5-performance-${label}.json`,JSON.stringify({label,runs},null,2));
      }
    });
  }
}finally{await browser.close();await server.close();}
