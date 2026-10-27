import assert from 'node:assert/strict';
import { withApp, withInput, type Session } from './browser.ts';

export async function checkCampaignDevelopmentEntry(session:Session){
  await withApp(session,{path:'/',init:()=>{
    const original=window.fetch;
    window.fetch=async(input,init)=>{
      const response=await original(input,init);
      if(!String(input instanceof Request?input.url:input).endsWith('/data/index.json'))return response;
      const files=await response.json(),names=['conquer.mix','temperat.mix','general.mix','cclocal.mix','desert.mix','sounds.mix','speech.mix','updatec.mix','tempicnh.mix'];
      return new Response(JSON.stringify(Object.fromEntries(names.map(name=>[name,files[name]]))),{headers:{'Content-Type':'application/json'}});
    };
  }},async page=>{
    const missing:string[]=[];page.on('request',request=>{if(/\/data\/(?:update\.mix|transit\.mix|scores\.mix|(?:gdi|nod)\/)/.test(request.url()))missing.push(request.url());});
    await withInput(session,page,async()=>{
      await page.getByRole('button',{name:'Click to start',exact:true}).click();
      await page.getByRole('button',{name:'Start New Game',exact:true}).click({timeout:30000});
      await page.getByRole('button',{name:'Brotherhood of Nod',exact:true}).click({timeout:30000});
    });
    await page.locator('canvas[data-status="playing"]').waitFor({state:'attached',timeout:90000});
    assert.deepEqual(missing,[],'Development data must not request absent presentation or disc archives');
    await withInput(session,page,async()=>{
      await page.keyboard.press('Space');
      await page.getByRole('button',{name:'Game Controls',exact:true}).waitFor();
      await page.screenshot({path:'test-results/campaign-dev-entry.png'});
    });
  });
}

export async function checkCampaignEntry(session: Session) {
  await withApp(session, { path: '/', init: () => {
    const files = { bytes: new Uint8Array(), compressed: new Uint8Array(), saveName: '', suggestedName: '', writes: 0,
      saveActivated: false, loadActivated: false, deleted: [] as string[] };
    (window as any).campaignFiles = files;
    (window as any).showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => {
      files.saveActivated = navigator.userActivation.isActive;
      files.suggestedName = suggestedName;
      return { name: files.saveName || suggestedName,
        createWritable: async () => ({ write: async (bytes: Uint8Array) => { files.bytes = bytes.slice(); files.writes++; }, close: async () => {} }) };
    };
    (window as any).showOpenFilePicker = async () => {
      files.loadActivated = navigator.userActivation.isActive;
      return [{ getFile: async () => ({ arrayBuffer: async () => files.bytes.buffer }) }];
    };
    (window as any).showDirectoryPicker = async () => ({
      async *entries() { yield ['mission.cncu', { kind: 'file' }]; yield ['mission.CNCZ', { kind: 'file' }]; yield ['notes.txt', { kind: 'file' }]; },
      removeEntry: async (name: string) => { files.deleted.push(name); },
    });
  } }, async page => {
    const movieRequests: string[] = [];
    page.on('request', request => { if (request.url().includes('/movies.mix')) movieRequests.push(request.headers().range ?? 'missing'); });
    await page.getByRole('button', { name: 'Click to start' }).waitFor();
    assert.equal(await page.locator('canvas').getAttribute('data-status'), 'gate');
    await withInput(session, page, async () => {
      await page.getByRole('button', { name: 'Click to start' }).click();
      await page.locator('canvas[data-status="movie"]').waitFor({ timeout: 30000 });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Start New Game', exact: true }).waitFor({ timeout: 30000 });
      assert.equal(await page.getByRole('button', { name: 'Internet Game', exact: true }).isDisabled(), true);
      await page.screenshot({ path: 'test-results/campaign-menu.png' });
      await page.getByRole('button', { name: 'Bonus Missions', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'OK', exact: true }).isDisabled(), true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Start New Game', exact: true }).waitFor();
      // Restoring the menu can deliver pointerenter under the stationary pointer.
      // Give the keyboard target focus before testing Enter activation.
      await page.mouse.move(0,0);
      await page.getByRole('button', { name: 'Start New Game', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Global Defense Initiative', exact: true }).waitFor({ timeout: 30000 });
      await page.screenshot({ path: 'test-results/campaign-sides.png' });
      await page.getByRole('button', { name: 'Global Defense Initiative', exact: true }).click();
      await page.locator('canvas[data-status="movie"]').waitFor({ timeout: 15000 });
      // Skip the briefing, then the action movie. No Escape is sent once battlefield startup begins.
      for (let i = 0; i < 12; i++) {
        if (await page.locator('canvas').getAttribute('data-status') !== 'movie') break;
        await page.keyboard.press('Escape'); await page.waitForTimeout(250);
      }
    });
    await page.locator('canvas[data-status="playing"]').waitFor({ state: 'attached', timeout: 90000 });
    await page.screenshot({ path: 'test-results/campaign-gdi01.png' });
    await withInput(session, page, async () => {
      await page.keyboard.press('Space');
      await page.getByRole('button',{name:'Game Controls',exact:true}).waitFor();
      await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');
      await page.getByRole('slider',{name:'Game Speed',exact:true}).waitFor();
      await page.getByRole('slider',{name:'Game Speed',exact:true}).focus();await page.keyboard.press('Home');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('cnc-ultra-options')??'{}').gameSpeed??4),4,'Escape discards uncommitted Game Controls edits');
      await page.getByRole('button',{name:'Resume Mission',exact:true}).click();
      const tabs=await page.evaluate(()=>{
        const canvas=document.querySelector('canvas')!,box=canvas.getBoundingClientRect(),scale=Math.max(1,Math.floor(canvas.height/400))/devicePixelRatio;
        return {left:box.x+80*scale,right:box.right-80*scale,y:box.y+8*scale};
      });
      await page.mouse.click(tabs.right,tabs.y);
      assert.equal(await page.locator('canvas').getAttribute('data-status'),'playing');
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      await page.screenshot({path:'test-results/campaign-sidebar-hidden.png'});
      await page.evaluate(()=>document.exitPointerLock());
      await page.mouse.click(tabs.right,tabs.y);
      await page.evaluate(()=>document.exitPointerLock());
      await page.mouse.click(tabs.left,tabs.y);
      await page.getByRole('button',{name:'Game Controls',exact:true}).waitFor();
      await page.getByRole('button',{name:'Resume Mission',exact:true}).click();
      const debug = page.getByRole('dialog', { name: 'Debug', exact: true });
      assert.equal(await debug.isVisible(), false);
      await page.keyboard.press('Backquote');
      await page.getByRole('spinbutton', { name: 'Player money' }).fill('12345');
      await page.getByRole('combobox', { name: 'Player build speed' }).selectOption('10');
      await page.getByRole('combobox', { name: 'Game speed', exact: true }).selectOption('100');
      await page.getByRole('slider', { name: 'Player damage received' }).focus(); await page.keyboard.press('Home');
      await page.screenshot({ path: 'test-results/campaign-debug.png' });
      await page.keyboard.press('Backquote');
      assert.equal(await debug.isVisible(), false);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Backquote');
      assert.equal(await page.getByRole('spinbutton', { name: 'Player money' }).inputValue(), '12345');
      await page.getByRole('spinbutton', { name: 'Player money' }).fill('1');
      await page.getByRole('spinbutton', { name: 'Player money' }).click();
      assert.equal(await page.locator('canvas[data-status="options"]').count(), 1, 'Debug clicks must leave the underlying Options menu paused');
      await page.keyboard.press('Escape');
      // Escape cancels the edit and preserves the already-paused Options menu.
      await page.getByRole('button', { name: 'Game Controls', exact: true }).click();
      await page.getByRole('slider', { name: 'Scroll Rate', exact: true }).focus(); await page.keyboard.press('Home');
      await page.getByRole('button', { name: 'Sound Controls', exact: true }).click();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('cnc-ultra-options')!).scrollRate), 6);
      await page.getByRole('slider', { name: 'Music Volume', exact: true }).focus(); await page.keyboard.press('Home');
      await page.getByRole('button', { name: 'Options Menu', exact: true }).click();
      await page.getByRole('button', { name: 'Restate Mission', exact: true }).click();
      await page.getByRole('button', { name: 'Options', exact: true }).click();
      await page.getByRole('button', { name: 'Abort Mission', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Save Mission', exact: true }).click();
      await page.waitForFunction(() => (window as any).campaignFiles.bytes.length > 0, undefined, { timeout: 30000 });
      assert.equal(await page.evaluate(() => (window as any).campaignFiles.saveActivated), true);
      assert.equal(await page.evaluate(() => (window as any).campaignFiles.suggestedName), 'scg01ea.cncz');
      assert.deepEqual(await page.evaluate(() => Array.from((window as any).campaignFiles.bytes.slice(0, 4))), [80, 75, 3, 4]);
      await page.evaluate(() => {
        const files = (window as any).campaignFiles;
        files.compressed = files.bytes.slice(); files.saveName = 'mission.cncu';
      });
      await page.getByRole('button', { name: 'Save Mission', exact: true }).click();
      await page.waitForFunction(() => (window as any).campaignFiles.writes === 2);
      assert.equal(await page.evaluate(() => new TextDecoder().decode((window as any).campaignFiles.bytes.slice(0, 8))), 'CNCULTRA');
      await page.evaluate(() => { const files = (window as any).campaignFiles; files.bytes = files.compressed; });
      await page.getByRole('button', { name: 'Delete Mission', exact: true }).click();
      await page.getByRole('button', { name: 'mission.cncu', exact: true }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('button', { name: 'mission.CNCZ', exact: true }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => (window as any).campaignFiles.deleted), ['mission.cncu', 'mission.CNCZ']);
      await page.getByRole('button', { name: 'Load Mission', exact: true }).click();
      await page.locator('canvas[data-status="playing"]').waitFor({ timeout: 90000 });
      assert.equal(await page.evaluate(() => (window as any).campaignFiles.loadActivated), true);
      await page.keyboard.press('Backquote');
      await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('dialog[open] fieldset')?.disabled);
      assert.equal(await page.getByRole('spinbutton', { name: 'Player money' }).inputValue(), '12345');
      assert.equal(await page.getByRole('combobox', { name: 'Player build speed' }).inputValue(), '10');
      assert.equal(await page.getByRole('combobox', { name: 'Game speed', exact: true }).inputValue(), '100');
      assert.equal(await page.getByRole('slider', { name: 'Player damage received' }).inputValue(), '0');
      await page.keyboard.press('Escape');
    });
    assert(movieRequests.length > 0 && movieRequests.every(range => /^bytes=\d+-\d+$/.test(range)), 'Every movie archive read must be bounded');
  });
}
