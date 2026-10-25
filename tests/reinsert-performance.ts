import { mkdir,writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { discoverGpus,identifyGpu,launchGpu } from './gpu.ts';
import { withApp } from './browser.ts';

const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)??'current';
if(!/^[a-z0-9-]+$/.test(label))throw new Error('Invalid measurement label');
const server=await createServer({cacheDir:'node_modules/.vite-tests',server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false},logLevel:'error'});
await server.listen();const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No test port');
const baseUrl=`http://127.0.0.1:${address.port}`;console.log('Isolated measurement server:',baseUrl);
let browser=await launchGpu();const choices=await discoverGpus(browser),runs:unknown[]=[];
await mkdir('test-results',{recursive:true});
try{
  for(const vendor of ['nvidia','amd']){
    const choice=choices.find(item=>item.vendor===vendor);if(!choice)throw new Error(`No ${vendor} GPU`);
    await browser.close();browser=await launchGpu(choice,true);const gpu=await identifyGpu(browser,baseUrl,vendor);
    console.log('GPU environment:',JSON.stringify(gpu));
    await withApp({browser,baseUrl,gpu},{path:'/tests/fixture.html'},async page=>{
      const result=await page.evaluate(async()=>(await import('../tests/reinsert-fixture.ts')).measureReinsertBatches());
      runs.push({gpu,...result});console.log(JSON.stringify(result));
      await writeFile(`test-results/m5-reinsert-${label}.json`,JSON.stringify({label,runs},null,2));
    });
  }
}finally{await browser.close();await server.close();}
