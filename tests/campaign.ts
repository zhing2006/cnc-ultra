import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { withApp, withInput, type Session } from './browser.ts';

export async function checkCampaignOutcome(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    for (const check of ['campaignOutcome', 'campaignOutcomeBackground'] as const) {
      const result = await page.evaluate(async check => (await import('../tests/campaign-outcome-fixture.ts'))[check](), check);
      for (const image of result.screenshots) await writeFile(`test-results/${image.name}.png`, Buffer.from(image.data, 'base64'));
      assert.deepEqual(result.failures, []);
    }
  });
}

export async function checkCampaignStartup(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    assert.deepEqual(await page.evaluate(async () => (await import('../tests/campaign-startup-fixture.ts')).campaignStartup()), []);
  });
}

export async function checkCampaignRendering(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    for (const delivery of ['infantry', 'vehicle'] as const) {
      const result = await page.evaluate(async delivery => (await import('../tests/campaign-rendering-fixture.ts')).campaignRendering(delivery), delivery);
      for (const image of result.screenshots) await writeFile(`test-results/${image.name}.png`, Buffer.from(image.data, 'base64'));
      assert.deepEqual(result.failures, [], `${delivery} transport rendering`);
    }
  });
}

export async function checkCampaignRouting(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    assert(await page.evaluate(async()=>(await import('../tests/campaign-routing-fixture.ts')).campaignRouting()));
  });
}

export async function checkCampaignTheaters(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    const result=await page.evaluate(async()=>(await import('../tests/campaign-theaters-fixture.ts')).campaignTheaters());
    assert.deepEqual(result,['WINTER','DESERT']);
  });
}

export async function checkCampaignAudio(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    const result=await page.evaluate(async()=>(await import('../tests/campaign-audio-fixture.ts')).streamedCampaignMusic());
    assert(result.maximumFrames<=4096&&result.buffers>=2);
    console.log(`Worker music decode: at most ${result.maximumFrames} samples per main-thread AudioBuffer`);
  });
}

export async function checkCampaignAI(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    const result=await page.evaluate(async()=>(await import('../tests/campaign-ai-fixture.ts')).campaignAI());
    assert(result.rebuilt>0&&result.mustered&&result.infantry>=5);
  });
}

export async function checkCampaignRescue(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    const result=await page.evaluate(async()=>(await import('../tests/campaign-rescue-fixture.ts')).campaignRescue());
    assert.deepEqual(result,{crateCredits:2000,winner:0});
  });
}

export async function checkCampaignRules(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    const result=await page.evaluate(async()=>(await import('../tests/campaign-rules-fixture.ts')).campaignRules());
    assert.deepEqual(result,{bombs:10,reinforcements:16});
  });
}

export async function checkCampaignReinforcements(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    const result=await page.evaluate(async()=>(await import('../tests/campaign-simulation-fixture.ts')).checkCampaignTransportTeams());
    assert.deepEqual(result,{members:4,passengers:3});
  });
}

export async function checkCampaignMap(session: Session) {
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    for(const [side,name,mask,color,expected] of [
      ['gdi','SCG01EA','CLICK_E.CPS',149,'SCG02EA'],
      ['nod','SCB12EA','CLICK_SA.CPS',131,'SCB13EC'],
    ] as const){
      const task=page.evaluate(async({side,name})=>{
        const {CampaignPresentation}=await import('../src/game/campaign/presentation.ts');
        const canvas=document.createElement('canvas');canvas.style.cssText='width:100vw;height:100vh';document.body.append(canvas);
        const audio=new AudioContext(),presentation=await CampaignPresentation.open(canvas,audio,{
          buttons(){},status:value=>{canvas.dataset.status=value;},exit(){},mission:async()=>{},error:error=>{throw error;},
        });
        if(!presentation)throw new Error('WebGPU is required');
        try{return await presentation.nextMission(side,name,Number(name.slice(3,5)));}
        finally{presentation.dispose();await audio.close();canvas.remove();}
      },{side,name});
      void task.catch(()=>{});
      await Promise.race([task,page.locator('canvas[data-status="map-select"]').waitFor({timeout:60000})]);
      const point=await page.evaluate(async({mask,color})=>{
        const {CampaignAssets}=await import('../src/game/campaign/assets.ts');const {decodeCps}=await import('../src/game/formats/cps.ts');
        const assets=await CampaignAssets.open(),pixels=decodeCps(await assets.bytes(mask)).pixels,index=pixels.indexOf(color);
        if(index<0)throw new Error('Original country click mask is missing');
        const scale=Math.floor(Math.min(innerWidth*devicePixelRatio/640,innerHeight*devicePixelRatio/400));
        return {x:((innerWidth*devicePixelRatio-640*scale)/2+(index%320*2+1)*scale)/devicePixelRatio,
          y:((innerHeight*devicePixelRatio-400*scale)/2+(Math.trunc(index/320)*2+1)*scale)/devicePixelRatio};
      },{mask,color});
      await withInput(session,page,()=>page.mouse.click(point.x,point.y));
      await Promise.race([task,page.locator('canvas[data-status="map-continue"]').waitFor({timeout:30000})]);
      await page.screenshot({path:`test-results/campaign-map-${side}.png`});
      await withInput(session,page,()=>page.keyboard.press('Enter'));assert.equal(await task,expected);
    }
  });
}

export async function checkCampaignState(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    const result = await page.evaluate(async () => (await import('../tests/campaign-state-fixture.ts')).checkSavedSimulation());
    assert.equal(result.frame, 245);
    console.log(`Campaign save continuation: ${result.buffers} simulation buffers, ${result.saveBytes} file bytes`);
  });
}

export async function checkCampaignSimulation(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    const result = await page.evaluate(async () => (await import('../tests/campaign-simulation-fixture.ts')).checkCampaignSimulation());
    assert.equal(result.frame, 600);
    assert(result.teams > 0, 'The original first-mission attack team must exist');
    console.log(`Campaign simulation: transports match CPU through 900 ticks; first-mission save continues to ${result.frame}`);
  });
}

export async function checkCampaignScore(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    for(const side of ['gdi','nod'] as const){
    const score=side==='gdi'?178:179;
    const task = page.evaluate(async ({side,score}) => {
      const { CampaignPresentation } = await import('../src/game/campaign/presentation.ts');
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:100vw;height:100vh'; document.body.append(canvas);
      const audio = new AudioContext();
      const presentation = await CampaignPresentation.open(canvas, audio, {
        buttons() {}, status: value => { canvas.dataset.status = value; }, exit() {}, mission: async () => {},
        error: error => { throw error; },
      });
      if (!presentation) throw new Error('WebGPU is required');
      try {
        await presentation.score(side, { leadership: 85, efficiency: 65, total: score, minutes: 6, credits: 1300, level: 1,
          losses: [{ units: 2, buildings: 0 }, { units: 10, buildings: 3 }, {units:3,buildings:2}] });
        return JSON.parse(localStorage.getItem('cnc-ultra-fame')!);
      } finally { presentation.dispose(); await audio.close();canvas.remove(); }
    },{side,score});
    void task.catch(()=>{});
    // Count-up, casualty graphs and credits finish before accepting the player's name.
    await Promise.race([task,page.locator('canvas[data-status="score-name"]').waitFor({ timeout: 60000 })]);
    await withInput(session, page, async () => {
      if(side==='gdi'){await page.keyboard.type('abcdefghijk');await page.keyboard.press('Backspace');await page.keyboard.type('z');}
      else await page.keyboard.type(`${side} test`);
      await page.screenshot({ path: `test-results/campaign-score-${side}.png` });
      await page.keyboard.press('Enter');
    });
    assert.deepEqual((await task)[0], { name: side==='gdi'?'ABCDEFGHIJZ':`${side.toUpperCase()} TEST`, score, level: 1 });
    }
  });
}

export async function checkCampaignVictory(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    const result = await page.evaluate(async () => (await import('../tests/campaign-victory-fixture.ts')).playFirstMission());
    assert.equal(result.result, 0);
    console.log(`Original GDI first mission: won at tick ${result.frame}, trained ${result.trained}, reinforcement notices ${result.reinforcements.length}`);
  });
}

export async function checkCampaignAssets(session: Session) {
  await withApp(session, { path: '/tests/fixture.html' }, async page => {
    const result = await page.evaluate(async () => {
      const index = await (await fetch('../data/index.json')).json();
      const names = ['gdi/movies.mix', 'nod/movies.mix'].filter(name => name in index);
      const records = [];
      for (const name of names) {
        const response = await fetch(`../data/${name}`, { headers: { Range: 'bytes=0-5' } });
        records.push({ name, size: index[name], status: response.status, length: (await response.arrayBuffer()).byteLength, range: response.headers.get('Content-Range') });
      }
      const suffix = await fetch('../data/conquer.mix', { headers: { Range: 'bytes=-8' } });
      return { records, suffix: { status: suffix.status, bytes: (await suffix.arrayBuffer()).byteLength } };
    });
    for (const record of result.records) {
      assert.equal(record.status, 206); assert.equal(record.length, 6);
      assert.equal(record.range, `bytes 0-5/${record.size}`);
    }
    if (session.acceptance) assert.equal(result.records.length, 2, 'Campaign acceptance requires both original movie discs');
    assert.deepEqual(result.suffix, { status: 206, bytes: 8 });
  });
}
