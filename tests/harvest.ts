import { withApp, type Session } from './browser.ts';

export async function checkHarvest(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    await page.evaluate(async()=>{await (await import('../tests/economy-fixture.ts')).compareRefineryQueue();});
  });
}
