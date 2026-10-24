import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { withApp,type Session } from './browser.ts';

export async function checkUnits(session:Session){
  await withApp(session,{},async page=>{
    page.setDefaultTimeout(15000);
    const measured=await page.evaluate(async()=> (await import('../tests/units-fixture.ts')).compareUnits());
    console.log(`M3 environment: Chromium ${session.browser.version()}, ${JSON.stringify(measured)}`);
    writeFileSync('test-results/m3-measurement.json',JSON.stringify({browser:session.browser.version(),...measured},null,2));
    await page.goto(`${session.baseUrl}/?demo=units`);
    await page.locator('canvas[data-status="running"]').waitFor({state:'attached'});
    await page.evaluate(async()=>{
      const {GpuUnits}=await import('../src/game/simulation/units-gpu.ts');
      const {GpuSelection}=await import('../src/game/simulation/selection.ts');
      const {PalettePipeline}=await import('../src/engine/indexed/pipeline.ts');
      const {UnitVoices}=await import('../src/game/voices.ts');
      const scope=window as unknown as {unitTest:{simulation?:InstanceType<typeof GpuUnits>;selection?:InstanceType<typeof GpuSelection>;view?:{x:number;y:number;width:number;height:number};scale:number;voices:number}};
      scope.unitTest={scale:1,voices:0};
      const apply=GpuSelection.prototype.apply;GpuSelection.prototype.apply=function(command){scope.unitTest.selection=this;return apply.call(this,command);};
      const step=GpuUnits.prototype.step;GpuUnits.prototype.step=function(commands){scope.unitTest.simulation=this;return step.call(this,commands);};
      const render=PalettePipeline.prototype.render;PalettePipeline.prototype.render=function(view,scale){scope.unitTest.view=view;scope.unitTest.scale=scale;return render.call(this,view,scale);};
      const play=UnitVoices.prototype.play;UnitVoices.prototype.play=function(...args){scope.unitTest.voices++;return play.apply(this,args);};
    });
    await page.waitForFunction(()=>!!(window as unknown as {unitTest:{simulation?:unknown}}).unitTest.simulation);
    await page.keyboard.press('n');
    await page.waitForFunction(()=>(window as unknown as {unitTest:{voices:number}}).unitTest.voices>0);
    await page.keyboard.press('Alt+Enter');
    await page.waitForFunction(()=>!!document.fullscreenElement);
    await page.keyboard.press('Control+1');
    await page.keyboard.press('n');
    await page.keyboard.press('1');
    const selected=await page.evaluate(async()=>{
      const {GpuUnits}=await import('../src/game/simulation/units-gpu.ts');
      const {GpuSelection}=await import('../src/game/simulation/selection.ts');
      const scope=(window as unknown as {unitTest:{simulation:InstanceType<typeof GpuUnits>;selection:InstanceType<typeof GpuSelection>}}).unitTest;
      const state=new Int32Array(await scope.simulation.renderer.getArrayBufferAsync(scope.selection.state));
      return Array.from({length:scope.simulation.setup.units.length},(_,i)=>i).filter(i=>state[i]);
    });
    assert.deepEqual(selected,[0],'original Ctrl+1 / 1 group assignment and recall');
    await page.keyboard.press('Alt+Enter');await page.waitForFunction(()=>!document.fullscreenElement);
    const destination=await page.evaluate(async()=>{
      const scope=(window as unknown as {unitTest:{simulation:{setup:{grid:{width:number;edges:Uint32Array}}};view:{x:number;y:number;width:number;height:number};scale:number}}).unitTest;
      const {view,scale,simulation}=scope;
      for(let yy=Math.floor(view.height*0.7);yy>120;yy-=24)for(let xx=Math.floor(view.width*0.7);xx>200;xx-=24){
        const x=Math.floor((view.x+xx)/24),y=Math.floor((view.y+yy)/24),cell=y*simulation.setup.grid.width+x;
        if(x>=0&&y>=0&&simulation.setup.grid.edges[cell])return{x:xx*scale/devicePixelRatio,y:yy*scale/devicePixelRatio,cell};
      }throw new Error('No visible destination');
    });
    await page.locator('canvas').click({position:{x:destination.x,y:destination.y}});
    await page.waitForFunction(()=>!!document.pointerLockElement);
    await page.evaluate(()=>new Promise<void>(resolve=>setTimeout(resolve,180)));
    await page.mouse.click(destination.x,destination.y);
    await page.waitForFunction(async(cell)=>{
      const scope=(window as unknown as {unitTest:{simulation:{snapshot():Promise<Int32Array[]>}}}).unitTest;
      return (await scope.simulation.snapshot())[2][0]===cell;
    },destination.cell);
    await page.evaluate(()=>document.exitPointerLock());
    await page.getByRole('button',{name:'Sight',exact:true}).click();
    await page.getByRole('button',{name:'Flow field',exact:true}).click();
    await page.getByRole('button',{name:'Pause',exact:true}).click();
    const paused=await page.locator('[data-tick]').textContent();
    await page.evaluate(()=>new Promise<void>(resolve=>setTimeout(resolve,180)));
    assert.equal(await page.locator('[data-tick]').textContent(),paused);
    await page.screenshot({path:'test-results/m3-units.png'});
  });
}
