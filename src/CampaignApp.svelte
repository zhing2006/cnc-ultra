<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { CampaignPresentation } from './game/campaign/presentation.ts';
  import type { CampaignSession, CampaignCarry } from './game/campaign/session.ts';
  import type { CampaignSide } from './game/campaign/assets.ts';
  import type { MenuButton } from './game/campaign/interface.ts';
  import { pickLoad, pickSave, pickSaveDirectory } from './game/campaign/save-file.ts';
  import { DEFAULT_PREFERENCES, adjustGamePalette, readPreferences, savePreferences, type GamePreferences } from './game/options.ts';
  import type { ControlsPage, MenuSlider } from './game/campaign/controls.ts';
  import DebugMenu from './game/DebugMenu.svelte';
  import { completedMission } from './game/campaign/progression.ts';

  let canvas: HTMLCanvasElement;
  let status = $state('gate'), message = $state(''), buttons = $state<readonly MenuButton[]>([]);
  let placement = $state('');
  let settings = $state(readPreferences()), sliders = $state<MenuSlider[]>([]);
  let controlsPage: ControlsPage = 'game', trackOffset = 0;
  let gameDraft={gameSpeed:4,scrollRate:4},focused='';
  let presentation: CampaignPresentation | undefined, audio: AudioContext | undefined;
  let session = $state<CampaignSession>();
  let unmounted = false, outcomeStarted = false;

  const optionsButtons: MenuButton[] = [
    ...[['load', 'Load Mission'], ['save', 'Save Mission'], ['delete', 'Delete Mission'], ['controls', 'Game Controls'], ['quit', 'Abort Mission']].map(([id, label], i) => ({ id, label, x: 230, y: 142 + i * 20, width: 180, height: 18 })),
    { id: 'resume', label: 'Resume Mission', x: 106, y: 270, width: 180, height: 18 },
    { id: 'brief', label: 'Restate Mission', x: 354, y: 270, width: 180, height: 18 },
  ];

  function fail(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    console.error(error); message = error instanceof Error ? error.message : String(error); status = 'failed';
  }
  async function progress(value: string) {
    status = 'starting'; message = value; await tick();
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }
  async function start() {
    status = 'starting'; message = 'Preparing the game';
    audio = new AudioContext(); await audio.resume();
    try {
      const { CampaignPresentation } = await import('./game/campaign/presentation.ts');
      const created = await CampaignPresentation.open(canvas, audio, {
        buttons: value => { buttons = value;if(!value.some(button=>button.id===focused))focused=value.find(button=>button.id==='resume')?.id??value[0]?.id??''; }, status: value => { status = value; if (value !== 'controls') sliders = []; }, exit,
        error: fail, mission: side => beginMission(side),
      });
      if (unmounted) { created?.dispose(); return; }
      presentation = created; created?.sound.setVolume(settings.musicVolume, settings.volume); await created?.start();
    } catch (error) { fail(error); }
  }
  function exit() {
    session?.dispose(); session = undefined; presentation?.dispose(); presentation = undefined;
    void audio?.close(); audio = undefined; buttons = []; status = 'gate';
  }
  async function beginMission(side: CampaignSide, saved?: Uint8Array, restart = false, next?: { name: string; carry: CampaignCarry }) {
    if (!presentation) return;
    const name = next?.name ?? (restart ? session?.name : undefined), carry = next?.carry ?? (restart ? session?.carry : undefined);
    session?.dispose(); session = undefined; outcomeStarted = false; buttons = [];
    const { CampaignSession } = await import('./game/campaign/session.ts');
    session = await CampaignSession.start(presentation.renderer, canvas, presentation.assets, presentation, side,
      { saved, name, restart, carry, progress, outcome: winner => { void finish(winner).catch(fail); }, options: openOptions });
    if (unmounted) { session.dispose(); return; }
    applyPreferences();
    status = 'playing';
  }
  function openOptions() {
    if (!session || status !== 'playing') return;
    session.game.setPaused(true); void document.exitPointerLock();
    showOptions();
  }
  function palette() { return adjustGamePalette(session!.runtime.world.scene.setup.palette, settings).filter((_, index) => index % 4 !== 3).map(value => value >> 2); }
  function showOptions() { presentation!.options(optionsButtons, palette()); }
  function applyPreferences() {
    session?.game.setPreferences(settings); presentation?.sound.setVolume(settings.musicVolume, settings.volume);
    if (presentation) { presentation.music.repeat = settings.repeat; presentation.music.shuffle = settings.shuffle; }
  }
  function showControls(page: ControlsPage = controlsPage,reset=page!==controlsPage||status!=='controls') {
    if(reset){gameDraft={gameSpeed:settings.gameSpeed,scrollRate:settings.scrollRate};focused=page==='game'?'gameSpeed':page==='visual'?'brightness':`track:${presentation!.music.selected}`;}
    controlsPage = page;const focus=focused;
    sliders = presentation!.controls(page,{...settings,...gameDraft},palette(),trackOffset,focus);focused=focus;
  }
  function commitControls(){
    if(status==='controls'&&controlsPage==='game'){settings={...settings,...gameDraft};savePreferences(settings);applyPreferences();}
  }
  function changePreference(slider: MenuSlider, value: number) {
    value=Math.max(0,Math.min(slider.max,value));
    const next=slider.reversed?slider.max-value:value;
    if(slider.id==='gameSpeed'||slider.id==='scrollRate')gameDraft[slider.id]=next;
    else{settings[slider.id]=next as never;savePreferences(settings);applyPreferences();if(slider.id==='volume')void presentation!.sound.play('BEEPY3').catch(fail);}
    showControls();
  }
  function focusControl(id:string,keyboard=false){
    focused=id;presentation?.focus(id);
    if(keyboard){const element=Array.from(document.querySelectorAll<HTMLElement>('[data-command]')).find(element=>element.dataset.command===id);element?.focus();}
  }
  async function finish(winner: number) {
    if (!session || !presentation || outcomeStarted) return;
    outcomeStarted = true;
    const current = session;
    await presentation.outcome(winner === 0, palette());
    const speech = await presentation.sound.play(winner === 0 ? 'ACCOM1' : 'FAIL1');
    await new Promise(resolve => setTimeout(resolve, Math.max(3000, (speech?.buffer?.duration ?? 0) * 1000)));
    await presentation.playMovie(winner === 0 ? current.runtime.mission.movies.win : current.runtime.mission.movies.lose, current.side);
    if (winner === 0) {
      let completed=Number(current.name.slice(3,5));
      if(completed===(current.side==='gdi'?15:13)){
        await presentation.ending(current.side,current.score(),current.runtime.templeIoned);
        session?.dispose();session=undefined;await presentation.mainMenu();return;
      }
      await presentation.score(current.side, current.score());
      completed=completedMission(current.side,completed,current.runtime.sabotaged);
      const carry=await current.nextCarry(),name=await presentation.nextMission(current.side,current.name,completed);
      await beginMission(current.side,undefined,false,{name,carry});
    }
    else {
      const answer = await presentation.message('Would you like to replay the mission?', [{ id: 'yes', label: 'Yes' }, { id: 'cancel', label: 'No' }], palette());
      if (answer === 'yes') await beginMission(current.side, undefined, true);
      else { session?.dispose(); session = undefined; await presentation.mainMenu(); }
    }
  }
  async function command(id: string) {
    try {
      if(id.startsWith('slider:')){const [,name,direction]=id.split(':'),slider=sliders.find(slider=>slider.id===name);if(slider)changePreference(slider,slider.value+Number(direction));return;}
      if (id === 'controls') { showControls('game'); return; }
      if (id === 'options') { commitControls();if(controlsPage==='sound'&&!settings.musicVolume)presentation!.music.stop();showOptions(); return; }
      if (id.startsWith('controls:')) {
        commitControls();
        if (id === 'controls:reset') {
          for (const key of ['brightness', 'color', 'contrast', 'tint'] as const) settings[key] = DEFAULT_PREFERENCES[key];
          savePreferences(settings); applyPreferences(); showControls();
        } else showControls(id.slice(9) as ControlsPage);
        return;
      }
      if (id.startsWith('tracks:')) { trackOffset = Math.max(0, Math.min(presentation!.music.tracks.length - 8, trackOffset + (id === 'tracks:next' ? 8 : -8))); showControls(); return; }
      if (id.startsWith('track:')) { presentation!.music.selected = id.slice(6); showControls(); return; }
      if (id.startsWith('music:')) {
        const music = presentation!.music;
        if (id === 'music:play') void music.queue(music.selected).catch(fail);
        else if (id === 'music:stop') void music.queue().catch(fail);
        else { const key = id === 'music:repeat' ? 'repeat' : 'shuffle'; settings[key] = !settings[key]; savePreferences(settings); applyPreferences(); }
        showControls(); return;
      }
      if (id === 'load') {
        const saved = await pickLoad(); await beginMission(session?.side ?? 'gdi', saved); return;
      }
      if (id === 'save' && session) {
        const handle = await pickSave(`${session.name.toLowerCase()}.cncu`), bytes = await session.save();
        const stream = await handle.createWritable(); await stream.write(bytes as Uint8Array<ArrayBuffer>); await stream.close(); return;
      }
      if (id === 'delete' && session) {
        const directory = await pickSaveDirectory();
        const names: string[] = [];
        for await (const [name, handle] of directory.entries()) if (handle.kind === 'file' && name.toLowerCase().endsWith('.cncu')) names.push(name);
        names.sort();
        while (names.length) {
          const name = await presentation!.savedFiles(names, palette());
          if (!name) break;
          const answer = await presentation!.message(`Delete ${name}?`, [{ id: 'delete', label: 'Delete' }, { id: 'cancel', label: 'Cancel' }], palette(), 'Delete Mission');
          if (answer === 'delete') { await directory.removeEntry(name); names.splice(names.indexOf(name), 1); }
        }
        showOptions(); return;
      }
      if (id === 'resume' && session) { buttons = []; status = 'playing'; session.game.setPaused(false); return; }
      if (id === 'restart' && session) { await beginMission(session.side, undefined, true); return; }
      if (id === 'brief' && session) {
        const movies = session.runtime.mission.movies;
        const hasBrief = movies.brief && await presentation!.assets.source(`${movies.brief}.VQA`, [`${session.side}/movies.mix`]);
        const hasAction=movies.action&&await presentation!.assets.source(`${movies.action}.VQA`,[`${session.side}/movies.mix`]);
        const choices=hasBrief||hasAction?[{id:'video',label:'Video'},{id:'cancel',label:'Options'}]:[{id:'cancel',label:'OK'}];
        const answer = session.briefing ? await presentation!.message(session.briefing, choices, palette(), 'Mission Objective') : 'video';
        if (answer === 'cancel'||!hasBrief&&!hasAction) { showOptions(); return; }
        await presentation!.playMovie(hasBrief ? movies.brief : movies.action, session.side);
        presentation!.beginMusic();
        buttons = []; status = 'playing'; session.game.setPaused(false); return;
      }
      if (id === 'quit' && session) {
        const answer = await presentation!.message('Abort this mission?', [{ id: 'abort', label: 'Abort' }, { id: 'restart', label: 'Restart' }, { id: 'cancel', label: 'Cancel' }], palette());
        if (answer === 'cancel') { showOptions(); return; }
        if (answer === 'restart') { await beginMission(session.side, undefined, true); return; }
        session.dispose(); session = undefined; await presentation!.mainMenu(); return;
      }
      if (['menu', 'score-continue'].includes(id)) {
        session?.dispose(); session = undefined; await presentation?.mainMenu(); return;
      }
      await presentation?.command(id);
    } catch (error) { fail(error); }
  }
  onMount(() => {
    const resize = () => {
      const ratio = devicePixelRatio, fit = Math.min(innerWidth * ratio / 640, innerHeight * ratio / 400);
      const scale = (fit >= 1 ? Math.floor(fit) : fit) / ratio;
      placement = `left:${Math.floor((innerWidth * ratio - 640 * scale * ratio) / 2) / ratio}px;top:${Math.floor((innerHeight * ratio - 400 * scale * ratio) / 2) / ratio}px;transform:scale(${scale});`;
    };
    const key = (event: KeyboardEvent) => {
      if(event.ctrlKey||event.metaKey||event.altKey)return;
      if(event.code==='Space'&&status==='playing'){event.preventDefault();openOptions();return;}
      if(status==='controls'&&controlsPage==='sound'){
        if(event.code==='Space'){event.preventDefault();void command('music:play');return;}
        const direction=event.key==='ArrowUp'?-1:event.key==='ArrowDown'?1:event.key==='PageUp'?-8:event.key==='PageDown'?8:0;
        if(direction){event.preventDefault();const music=presentation!.music,index=Math.max(0,Math.min(music.tracks.length-1,music.tracks.findIndex(track=>track[0]===music.selected)+direction));if(music.tracks[index]){music.selected=music.tracks[index][0];trackOffset=Math.floor(index/8)*8;focused=`track:${music.selected}`;showControls();}return;}
      }
      if(['options','menu','dialog','controls'].includes(status)){
        const choices=[...sliders.map(slider=>slider.id),...buttons.filter(button=>!button.disabled&&!button.id.startsWith('slider:')).map(button=>button.id)];
        if(event.key==='ArrowUp'||event.key==='ArrowDown'){
          event.preventDefault();const index=Math.max(0,choices.indexOf(focused)),next=(index+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;
          if(choices[next])focusControl(choices[next],true);return;
        }
        const slider=sliders.find(slider=>slider.id===focused);
        if(slider&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){event.preventDefault();changePreference(slider,slider.value+(event.key==='ArrowRight'?1:-1)*slider.thumb);return;}
        if(event.key==='Enter'){
          event.preventDefault();if(slider){if(controlsPage==='game')void command('options');}else if(focused)void command(focused);return;
        }
      }
      if (event.key !== 'Escape') return;
      if (status === 'playing') openOptions();
      else if(status==='menu'&&buttons.some(button=>button.id==='back'))void command('back');
      else if (status === 'options') void command('resume');
      else if (status === 'dialog') presentation?.cancelDialog();
      else if (status === 'controls') {if(controlsPage==='visual')showControls('game');else{if(controlsPage==='sound'&&!settings.musicVolume)presentation!.music.stop();showOptions();}}
    };
    const outside=(event:PointerEvent)=>{
      if(document.querySelector('dialog[open]'))return;
      if(status!=='options'&&!(status==='controls'&&controlsPage!=='game'))return;
      const layer=document.querySelector('.original-controls')!.getBoundingClientRect(),x=(event.clientX-layer.x)*640/layer.width,y=(event.clientY-layer.y)*400/layer.height;
      const box=status==='options'?[96,100,448,200]:controlsPage==='visual'?[104,78,432,244]:[28,54,584,292];
      if(event.button===2||event.button===0&&(x<box[0]||y<box[1]||x>=box[0]+box[2]||y>=box[1]+box[3])){event.preventDefault();event.stopPropagation();if(status==='options')void command('resume');else if(controlsPage==='visual')showControls('game');else void command('options');}
    };
    const context=(event:Event)=>{if(status==='options'||status==='controls')event.preventDefault();};
    resize(); window.addEventListener('resize', resize); window.addEventListener('keydown', key);window.addEventListener('pointerdown',outside,true);window.addEventListener('contextmenu',context);
    return () => { unmounted = true; window.removeEventListener('resize', resize); window.removeEventListener('keydown', key);window.removeEventListener('pointerdown',outside,true);window.removeEventListener('contextmenu',context);exit(); };
  });
</script>

<canvas bind:this={canvas} data-status={status} aria-label="Command and Conquer"></canvas>
<DebugMenu game={['playing', 'options', 'controls'].includes(status) ? session?.game : undefined} />
{#if status === 'gate'}
  <div class="gate"><div><p class="brand">C&amp;C ULTRA</p><h1>Command &amp; Conquer</h1><button class="start" onclick={start}>Click to start</button></div></div>
{:else if status === 'starting'}
  <div class="loading" role="status"><p data-loading-stage>{message}</p></div>
{:else if status === 'unsupported'}
  <div class="notice">This browser does not support WebGPU. Open the page in a recent Chrome or Edge.</div>
{:else if status === 'failed'}
  <div class="notice"><p>{message}</p><button onclick={exit}>Return</button></div>
{/if}
<div class="original-controls" style={placement}>
  {#each sliders as slider (slider.id)}
    <input class="original-slider" type="range" data-command={slider.id} onfocus={()=>focusControl(slider.id)} aria-label={slider.label} min="0" max={slider.max} step="1" value={slider.value}
      style={`left:${slider.x}px;top:${slider.y}px;width:${slider.width}px;height:${slider.height}px`}
      oninput={event => changePreference(slider, Number(event.currentTarget.value))} />
  {/each}
  {#each buttons as button (button.id)}
    <button class="original-button" data-command={button.id} aria-label={button.label} disabled={button.disabled} title={button.disabled && button.id !== 'bonus-ok' ? '敬请期待' : undefined}
      style={`left:${button.x}px;top:${button.y}px;width:${button.width}px;height:${button.height}px`}
      onfocus={() => focusControl(button.id)}
      onpointerenter={() => focusControl(button.id)} onclick={() => command(button.id)}>{button.label}</button>
  {/each}
</div>
{#if status === 'gate' || status === 'menu'}
  <nav aria-label="Development modes"><a href="?demo=match">Skirmish</a><a href="?render=map">Rendering test</a><a href="?preview=assets">Asset preview</a></nav>
{/if}

<style>
  canvas { display: block; width: 100%; height: 100%; }
  .gate, .notice, .loading { position: fixed; inset: 0; display: grid; place-content: center; text-align: center; background: #0b1118; }
  .brand { color: #e4be69; letter-spacing: 0.2em; font-size: 12px; }
  h1 { font-weight: 500; font-size: 32px; }
  .start, .notice button { padding: 12px 24px; background: #d5b468; color: #0b1118; border: 0; cursor: pointer; font: inherit; }
  .original-controls { position: fixed; width: 640px; height: 400px; transform-origin: top left; pointer-events: none; }
  .original-button { position: absolute; padding: 0; border: 0; background: transparent; color: transparent; pointer-events: auto; cursor: pointer; }
  .original-button:focus-visible { outline: 1px solid #8bc655; outline-offset: 2px; }
  .original-button:disabled { cursor: default; }
  .original-slider { position: absolute; margin: 0; opacity: 0; pointer-events: auto; cursor: pointer; }
  .loading { background: #050706; color: #b8c4b5; }
  .notice { padding: 40px; }
  nav { position: fixed; bottom: 12px; left: 16px; display: flex; gap: 20px; font-size: 12px; }
  nav a { color: #93a0b0; text-decoration: none; }
</style>
