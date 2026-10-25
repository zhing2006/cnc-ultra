import assert from 'node:assert/strict';
import { withApp, withInput, pollCheck, type Session } from './browser.ts';
import type { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import { observeStartup,type StartupProbe } from './startup.ts';
import { writeFileSync } from 'node:fs';

const measured=async<T>(name:string,check:()=>Promise<T>)=>{const started=performance.now();try{return await check();}finally{console.log(`M5 ${name}: ${((performance.now()-started)/1000).toFixed(1)}s`);}};

export async function checkEconomy(session:Session) {
  await withApp(session,{path:'/tests/fixture.html',init:observeStartup},async page=>{
    assert.equal(await measured('Tiberium and flight',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareTiberium())),192);
    assert.equal(await measured('Occupied and reserved helipads',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareAircraftProduction())),true);
    assert.equal(await measured('Repeated factory exits',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareFactoryExits())),true);
    assert.equal(await measured('Repair radio ordering',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareServiceContacts())),true);
    assert.equal(await measured('Busy refinery queue',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareRefineryQueue())),true);
    assert.equal(await measured('Simultaneous ore impacts',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareTiberiumBlasts())),true);
    assert.equal(await measured('Structural damage',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareStructuralDamage())),true);
    assert.equal(await measured('Creation and blocked exits',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareLifecycle())),true);
    assert.equal(await measured('Rectangular economy map',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareEconomicMap())),true);
    assert.equal(await measured('Mixed air and ground hunt',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareMixedHunt())),true);
    if(session.acceptance){
      assert.equal(await measured('Harvest cycle',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareEconomy())),700);
      assert.equal(await measured('Defense cycle',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareDefenses())),true);
      assert.equal(await measured('Attack and rearm',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareAircraftOperations())),true);
      assert.equal(await measured('Transport and delivery',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareTransports())),true);
      assert.equal(await measured('Repair and factory exits',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareServices())),true);
      const openings=[];
      for(const faction of [1,2]){
        const result=await measured(`Faction ${faction} opening`,()=>page.evaluate(async faction=>(await import('../tests/economy-fixture.ts')).playEconomyOpening(faction),faction));
        assert.ok(result.harvested>=700);openings.push(result);
      }
      writeFileSync('test-results/m5-measurement.json',JSON.stringify({gpu:session.gpu,browser:session.browser.version(),renderingMeasured:false,openings},null,2));
    }
  });
  await checkEconomyControls(session);
}

export async function checkEconomyControls(session:Session){
  await withApp(session,{path:'/?demo=units',init:observeStartup},async page=>{
    page.setDefaultTimeout(30000);
    await page.locator('canvas[data-status="running"]').waitFor({state:'attached'});
    await withInput(session,page,async()=>{
      await page.evaluate(async()=>{
        const {GpuUnits}=await import('../src/game/simulation/units-gpu.ts');
        const {GpuSelection}=await import('../src/game/simulation/selection.ts');
        const scope=window as unknown as {airTest:{movement?:InstanceType<typeof GpuUnits>;selection?:InstanceType<typeof GpuSelection>;id:number}};
        scope.airTest={id:-1};
        const step=GpuUnits.prototype.step;GpuUnits.prototype.step=function(commands){scope.airTest.movement=this;return step.call(this,commands);};
        const apply=GpuSelection.prototype.apply;GpuSelection.prototype.apply=function(command){scope.airTest.selection=this;return apply.call(this,command);};
      });
      await page.waitForFunction(()=>!!(window as unknown as {airTest:{movement?:unknown}}).airTest.movement);
      await page.keyboard.press('n');
      const selected=await page.evaluate(async()=>{
        const {MOVEMENT}=await import('../src/game/data/movement.ts');
        const U=await import('../src/game/simulation/units-state.ts');
        const {GpuUnits}=await import('../src/game/simulation/units-gpu.ts');
        const {GpuSelection}=await import('../src/game/simulation/selection.ts');
        const scope=(window as unknown as {airTest:{movement:InstanceType<typeof GpuUnits>;selection:InstanceType<typeof GpuSelection>;id:number}}).airTest;
        const state=new Int32Array(await scope.movement.renderer.getArrayBufferAsync(scope.movement.units));
        const id=scope.movement.setup.units.findIndex(unit=>MOVEMENT[unit.type].name==='ORCA');scope.id=id;
        scope.selection.apply({action:'point',x:state[id*U.WORDS],y:state[id*U.WORDS+1]});
        const result=await scope.selection.read();
        const cell=state[id*U.WORDS+U.UCELL],width=scope.movement.setup.grid.width;
        const destination=Array.from(scope.movement.setup.passable!.keys()).find(c=>scope.movement.setup.passable![c]&&Math.abs(c%width-cell%width)===3&&Math.trunc(c/width)===Math.trunc(cell/width));
        if(destination===undefined)throw new Error('No aircraft move destination');
        scope.selection.apply({action:'point',x:destination%width*256+128,y:Math.trunc(destination/width)*256+128});
        return {selected:result[0],id};
      });
      assert.equal(selected.selected,selected.id,'an aircraft can be selected with the original point command');
      await pollCheck(()=>page.evaluate(async()=>{
        const {WORDS,UALTITUDE}=await import('../src/game/simulation/units-state.ts');
        const {GpuUnits}=await import('../src/game/simulation/units-gpu.ts');
        const scope=(window as unknown as {airTest:{movement:InstanceType<typeof GpuUnits>;id:number}}).airTest;
        const state=new Int32Array(await scope.movement.renderer.getArrayBufferAsync(scope.movement.units));
        return state[scope.id*WORDS+UALTITUDE]>0;
      }),'the commanded aircraft must take off');
      await page.screenshot({path:'test-results/m5-aircraft-demo.png'});
    });
    await page.goto(`${session.baseUrl}/?demo=buildings`);
    // Startup includes driver compilation; keep its deadline separate from gameplay waits.
    await measured('Buildings demo startup',()=>page.locator('canvas[data-status="running"]').waitFor({state:'attached',timeout:60000}));
    await page.evaluate(async()=>{
      const {EconomyRuntime}=await import('../src/game/simulation/economy-runtime.ts');
      const begin=EconomyRuntime.prototype.beginTick;
      EconomyRuntime.prototype.beginTick=function(){(window as unknown as {buildingTest:EconomyRuntime}).buildingTest=this;return begin.call(this);};
    });
    await page.waitForFunction(()=>!!(window as unknown as {buildingTest?:unknown}).buildingTest);
    await withInput(session,page,async()=>{
      await page.locator('summary').click();
      await page.getByRole('button',{name:'Ore density',exact:true}).click();
      assert.equal(await page.getByRole('button',{name:'Ore density',exact:true}).getAttribute('aria-pressed'),'true');
      await page.locator('canvas').click({position:{x:900,y:500}});
      await page.keyboard.press('h');
      await page.waitForFunction(()=>{
        const economy=(window as unknown as {buildingTest:EconomyRuntime}).buildingTest;return economy.selected===economy.scene.mcv;
      });
      await page.keyboard.press('d');
      await page.waitForFunction(()=>{
        const economy=(window as unknown as {buildingTest:EconomyRuntime}).buildingTest;return economy.buildings.get(economy.scene.mcv)?.active;
      });
      await page.evaluate(()=>document.exitPointerLock());
      await page.evaluate(()=>{(window as unknown as {buildingTest:EconomyRuntime}).buildingTest.choose('NUKE');});
      for(const speed of [10,100]){
        await page.getByRole('button',{name:`×${speed}`,exact:true}).click();
        await page.waitForFunction(speed=>(window as unknown as {buildingTest:EconomyRuntime}).buildingTest.productionSpeed===speed,speed);
        assert.equal(await page.getByRole('button',{name:`×${speed}`,exact:true}).getAttribute('aria-pressed'),'true');
      }
      await page.waitForFunction(()=>!!(window as unknown as {buildingTest:EconomyRuntime}).buildingTest.queues.items.get('building')?.complete);
      assert.equal(await page.evaluate(()=>(window as unknown as {buildingTest:EconomyRuntime}).buildingTest.house.money),99700,'accelerated construction charges the original power-plant price');
      await page.getByRole('button',{name:'×1',exact:true}).click();
      await page.waitForFunction(()=>(window as unknown as {buildingTest:EconomyRuntime}).buildingTest.productionSpeed===1);
      await page.getByRole('button',{name:'Start reinforcements',exact:true}).click();
      assert.equal(await page.getByRole('button',{name:'Stop reinforcements',exact:true}).getAttribute('aria-pressed'),'true');
      const probe=await page.evaluate(()=>(window as unknown as {startupProbe:StartupProbe}).startupProbe);
      assert.deepEqual(probe.latePipelines,[],'the building demo must compile its simulation before accepting input');
      writeFileSync('test-results/m5-startup.json',JSON.stringify({gpu:session.gpu,...probe},null,2));
      await page.screenshot({path:'test-results/m5-buildings-demo.png'});
    });
  });
}

export async function checkTransport(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    assert.equal(await measured('APC boarding, driving and unloading',()=>page.evaluate(async()=>(await import('../tests/transport-fixture.ts')).compareApcTransport())),true);
    assert.equal(await measured('Aircraft exploration',()=>page.evaluate(async()=>(await import('../tests/transport-fixture.ts')).compareAircraftSight())),true);
    assert.equal(await measured('APC and Chinook door shapes',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareAircraftDrawing())),true);
    if(session.acceptance)assert.equal(await measured('Chinook transport regression',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareTransports(['chinook']))),true);
  });
}

export async function checkCoordination(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    assert.equal(await measured('Ground layer transitions',()=>page.evaluate(async large=>(await import('../tests/coordination-fixture.ts')).compareGroundTransitions(large),session.acceptance)),true);
    assert.equal(await measured('Aircraft radio ordering',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareAirCoordination())),true);
    assert.equal(await measured('Mass aircraft coordination',()=>page.evaluate(async()=>(await import('../tests/coordination-fixture.ts')).compareMassAirCoordination())),true);
  });
}

export async function checkCompaction(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    assert.equal(await measured('Free slots and laser compaction',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareCompactOutputs())),true);
    assert.equal(await measured('Building fire and debris',()=>page.evaluate(async()=>(await import('../tests/economy-fixture.ts')).compareBuildingEffects())),true);
  });
}
