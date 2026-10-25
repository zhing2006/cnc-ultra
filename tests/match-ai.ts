import { withApp,type Session } from './browser.ts';
export async function checkMatchAI(session:Session){
  await withApp(session,{path:'/tests/fixture.html'},async page=>{
    await page.evaluate(async()=>{const {checkMatchAI}=await import('../tests/match-ai-fixture.ts');await checkMatchAI();});
  });
}
