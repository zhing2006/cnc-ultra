import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { withApp, withInput, type Session } from './browser.ts';

export async function checkUltraPerformance(session:Session){
  await session.performanceReady;
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    await page.setViewportSize({width:1920,height:1080});
    await page.evaluate(async()=>{await (await import('../tests/ultra-performance-fixture.ts')).mountUltraPreview();});
    await page.locator('canvas[data-status="ultra"]').waitFor({timeout:120000});
    await withInput(session,page,async()=>{
      await page.locator('canvas').click({position:{x:20,y:20}});
      await page.waitForFunction(()=>document.pointerLockElement?.tagName==='CANVAS');
      await page.evaluate(()=>document.exitPointerLock());
    });
    const opening=await page.evaluate(async()=>(await import('../tests/ultra-performance-fixture.ts')).measureUltraFrames());
    await page.getByRole('button',{name:'10×',exact:true}).click();
    await page.waitForFunction(tick=>Number(document.querySelector('footer')?.textContent?.match(/Tick (\d+)/)?.[1])>=tick,
      process.argv.includes('--deep')?1800:400,{timeout:120000});
    await page.getByRole('button',{name:'1×',exact:true}).click();
    const battle=await page.evaluate(async()=>(await import('../tests/ultra-performance-fixture.ts')).measureUltraFrames());
    await page.screenshot({path:'test-results/m8-front.png'});
    const gpu=await page.evaluate(async()=>(await import('../tests/ultra-performance-fixture.ts')).measureUltraGpu());
    await writeFile('test-results/m8-performance.json',JSON.stringify({environment:session.gpu,viewport:[1920,1080],speed:1,opening,battle,gpu},null,2));
    console.log(`M8 performance: ${JSON.stringify({opening,battle,gpu})}`);
    if(session.gpu?.vendor==='nvidia'){
      assert(opening.fps>=60,`Ultra opening rendered ${opening.fps.toFixed(1)} FPS`);
      assert(battle.fps>=60,`Ultra battle rendered ${battle.fps.toFixed(1)} FPS`);
      assert(opening.simulationSpeed>=.95&&battle.simulationSpeed>=.95,'Ultra 1x playback must sustain the original logic frequency');
    }
  });
}
