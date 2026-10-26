import { createRenderer, type Renderer } from '../../engine/renderer.ts';
import { IndexedScreen } from '../../engine/indexed/screen.ts';
import { CampaignAssets, type CampaignSide } from './assets.ts';
import { CampaignAudio } from './audio.ts';
import { MoviePlayer } from './movie.ts';
import { MAIN_MENU, OriginalInterface, type MenuButton } from './interface.ts';
import { WsaVideo } from '../formats/wsa.ts';
import { decodeFont } from '../formats/font.ts';
import { CampaignMusic, resolveTheme } from './music.ts';
import { drawControls, type ControlsPage } from './controls.ts';
import type { GamePreferences } from '../options.ts';
import type { Game } from '../game.ts';

export interface CampaignCallbacks {
  buttons(buttons: readonly MenuButton[]): void;
  status(status: string): void;
  exit(): void;
  mission(side: CampaignSide, renderer: Renderer, assets: CampaignAssets, presentation: CampaignPresentation): Promise<void>;
  error(error: unknown): void;
}

/** Original between-mission presentation; the simulation is loaded only after choosing a campaign. */
export class CampaignPresentation {
  readonly sound: CampaignAudio;
  readonly music: CampaignMusic;
  readonly movie: MoviePlayer;
  private readonly screen: IndexedScreen;
  private ui!: OriginalInterface;
  private readonly interfaceReady: Promise<void>;
  private phase = 0;
  private timer?: ReturnType<typeof setInterval>;
  private attract?: ReturnType<typeof setTimeout>;
  private selection?: (side: CampaignSide) => void;
  private dialogSelection?: (id: string) => void;
  private disposed = false;
  private paintFocus?: (id:string)=>void;
  private scoreAbort?: AbortController;
  private readonly visibility = () => {
    void (document.hidden ? this.audio.suspend() : this.audio.resume()).catch(this.callbacks.error);
  };
  private constructor(readonly renderer: Renderer, readonly assets: CampaignAssets, readonly audio: AudioContext,
    private readonly callbacks: CampaignCallbacks) {
    // Menu graphics are prepared alongside LOGO, not on the movie's startup path.
    this.interfaceReady = OriginalInterface.open(assets).then(ui => { this.ui = ui; });
    // mainMenu awaits and reports any failure; loading can finish while the movie is still playing.
    void this.interfaceReady.catch(() => {});
    this.screen = new IndexedScreen(renderer.three);
    this.sound = new CampaignAudio(audio, assets, callbacks.error);
    this.music = new CampaignMusic(this.sound, assets, callbacks.error);
    this.movie = new MoviePlayer(assets, this.screen, audio);
    this.showScreen();
    document.addEventListener('visibilitychange', this.visibility);
  }
  static async open(canvas: HTMLCanvasElement, audio: AudioContext, callbacks: CampaignCallbacks) {
    const renderer = await createRenderer(canvas, { onDeviceLost: message => callbacks.error(new Error(`WebGPU device lost: ${message}`)) });
    if (!renderer) { callbacks.status('unsupported'); return; }
    try {
      const assets = await CampaignAssets.open();
      return new CampaignPresentation(renderer, assets, audio, callbacks);
    } catch (error) { renderer.dispose(); throw error; }
  }
  private showScreen() { this.renderer.setFrame((width, height) => this.screen.draw(width, height)); }
  async start() {
    this.callbacks.status('movie');
    // INIT.CPP Play_Intro(true): installed games open with LOGO. Intro & Sneak Peek is separate.
    await this.movie.play('LOGO', 'gdi', true, false);
    if (!this.disposed) await this.mainMenu();
  }
  async mainMenu() {
    await this.interfaceReady;
    if (this.disposed) return;
    this.music.stop();
    this.clearTimers(); this.selection = undefined; this.movie.stop(); this.showScreen();
    this.screen.setOverlay(false);
    this.callbacks.status('menu'); this.callbacks.buttons(MAIN_MENU);
    this.hover('new');
    void this.sound.play('MAP1', true, true).catch(this.callbacks.error);
    // INIT.CPP SEL_TIMEOUT only starts an available attract recording. Gold's
    // disc data has no recording, so the menu stays open instead of playing a movie.
  }
  focus(id:string){if(this.paintFocus)this.paintFocus(id);else this.hover(id);}
  hover(id: string) {
    if (!MAIN_MENU.some(button => button.id === id)) return;
    this.screen.set(this.ui.menu(MAIN_MENU, id), this.ui.title.palette, 640, 400);
    this.screen.fade(1);
  }
  async command(id: string) {
    if (id.startsWith('message:') && this.dialogSelection) { this.dialogSelection(id.slice(8)); return; }
    if (this.selection && (id === 'gdi' || id === 'nod')) { this.selection(id); return; }
    if (id === 'back') { await this.mainMenu(); return; }
    if (id === 'new') { await this.chooseSide(); return; }
    if (id === 'intro') { await this.intro(); return; }
    if (id === 'exit') { this.callbacks.exit(); return; }
    if (id === 'bonus') {
      this.clearTimers(); this.callbacks.status('menu');
      // EXPAND.CPP Bonus_Dialog: Gold has none of the five bonus scenarios.
      const back = { id: 'back', label: 'Cancel', x: 456, y: 332, width: 80, height: 18 };
      const ok = { id: 'bonus-ok', label: 'OK', x: 134, y: 332, width: 50, height: 18, disabled: true };
      this.paintFocus=()=>{
        this.ui.pixels.set(this.ui.title.pixels);
        this.ui.dialog(84,38,472,324);this.ui.caption('Bonus Missions',84,38,472,2);
        this.ui.box(ok,false);this.ui.box(back,true);
        this.screen.set(this.ui.pixels,this.ui.title.palette,640,400);
      };this.paintFocus('back');this.callbacks.buttons([back,ok]);
    }
  }
  private async intro() {
    this.clearTimers(); this.callbacks.buttons([]); this.sound.stop(); this.callbacks.status('movie');
    await this.movie.play('INTRO2', 'gdi');
    // INIT.CPP Select_Game, SEL_INTRO: the optional teasers precede CC2TEASE.
    for(const name of ['TRAILER','SIZZLE','SIZZLE2','CC2TEASE']){
      if(this.disposed)return;
      if(name!=='CC2TEASE'&&!await this.assets.source(`${name}.VQA`,['gdi/movies.mix']))continue;
      await this.teaserCard('gdi');
      if(this.disposed)return;
      await this.movie.play(name,'gdi');
    }
    if (!this.disposed) await this.mainMenu();
  }
  async playMovie(name: string | undefined, side: CampaignSide, theme?: string, clearScreen=true) {
    if (!name) return false;
    this.clearTimers(); this.screen.setOverlay(false); this.showScreen(); this.music.stop();
    this.callbacks.buttons([]); this.callbacks.status('movie');
    const song=resolveTheme(theme);if(song)this.beginMusic(song);
    await this.movie.play(name, side, true, clearScreen);
    return !!song;
  }
  options(buttons: readonly MenuButton[], palette: Uint8Array) {
    this.clearTimers(); this.callbacks.status('options');
    this.paintFocus=id=>{
      this.ui.pixels.fill(255); this.ui.dialog(96, 100, 448, 200);this.ui.caption('Options',96,100,448,2);
      for(const button of buttons)this.ui.box(button,button.id===id);
      this.screen.setOverlay(true);this.screen.set(this.ui.pixels,palette,640,400);
    };this.paintFocus('resume');
    this.showScreen(); this.callbacks.buttons(buttons);
  }
  /** MSGBOX.CPP, CCMessageBox::Process: wrap the message and size the centered box from it. */
  message(text: string, choices: readonly { id: string; label: string }[], palette: Uint8Array, title = '') {
    this.clearTimers(); this.callbacks.status('dialog');
    const lines = this.ui.wrap(text, 510), width = Math.max(100, ...lines.map(line => this.ui.textWidth(line))) + 80;
    const height = lines.length * 16 + 120, x = Math.trunc((640 - width) / 2), y = Math.trunc((400 - height) / 2);
    this.ui.pixels.fill(255); this.ui.dialog(x, y, width, height);
    if (title) this.ui.text(title, 320, y + 10, true);
    lines.forEach((line, i) => this.ui.text(line, x + 40, y + 40 + i * 16, false, false));
    const buttonWidth = Math.max(60, ...choices.map(choice => this.ui.textWidth(choice.label) + 16));
    const buttons = choices.map((choice, index) => ({ ...choice, id: `message:${choice.id}`,
      x: choices.length === 1 ? Math.trunc(320 - buttonWidth / 2) : index === 0 ? x + 20 : index === choices.length - 1 ? x + width - buttonWidth - 20 : Math.trunc(320 - buttonWidth / 2),
      y: y + height - 30, width: buttonWidth, height: 20 }));
    const background=this.ui.pixels.slice();
    this.paintFocus=id=>{this.ui.pixels.set(background);for(const button of buttons)this.ui.box(button,button.id===id);this.screen.setOverlay(true);this.screen.set(this.ui.pixels,palette,640,400);};
    this.paintFocus(buttons[0].id);this.showScreen();this.callbacks.buttons(buttons);
    return new Promise<string>(resolve => { this.dialogSelection = id => { this.dialogSelection = undefined; this.callbacks.buttons([]); resolve(id); }; });
  }
  cancelDialog() { this.dialogSelection?.('cancel'); }
  savedFiles(names: readonly string[], palette: Uint8Array) {
    this.clearTimers(); this.callbacks.status('dialog');
    return new Promise<string | undefined>(resolve => {
      let page = 0;
      const draw = () => {
        this.ui.pixels.fill(255); this.ui.dialog(80, 40, 480, 320); this.ui.text('Delete Mission', 320, 50, true);
        const buttons: MenuButton[] = names.slice(page * 10, page * 10 + 10).map((name, i) => {
          let label = name;
          while (this.ui.textWidth(label) > 424) label = label.slice(0, -1);
          return { id: `message:file${page * 10 + i}`, label, x: 100, y: 82 + i * 22, width: 440, height: 18 };
        });
        buttons.push({ id: 'message:previous', label: '<', x: 100, y: 330, width: 40, height: 18, disabled: page === 0 },
          { id: 'message:cancel', label: 'Cancel', x: 245, y: 330, width: 150, height: 18 },
          { id: 'message:next', label: '>', x: 500, y: 330, width: 40, height: 18, disabled: (page + 1) * 10 >= names.length });
        for (const button of buttons) this.ui.box(button, false);
        this.screen.setOverlay(true); this.screen.set(this.ui.pixels, palette, 640, 400); this.showScreen(); this.callbacks.buttons(buttons);
      };
      this.dialogSelection = id => {
        if (id === 'previous') { page--; draw(); return; }
        if (id === 'next') { page++; draw(); return; }
        this.dialogSelection = undefined; this.callbacks.buttons([]); resolve(id === 'cancel' ? undefined : names[Number(id.slice(4))]);
      };
      draw();
    });
  }
  controls(page: ControlsPage, settings: GamePreferences, palette: Uint8Array, trackOffset = 0,focus='options') {
    this.clearTimers(); this.callbacks.status('controls');
    const result = drawControls(this.ui, page, settings, this.music, trackOffset,focus);
    this.screen.setOverlay(true); this.screen.set(this.ui.pixels, palette, 640, 400); this.showScreen();
    this.paintFocus=id=>{drawControls(this.ui,page,settings,this.music,trackOffset,id);this.screen.set(this.ui.pixels,palette,640,400);};
    this.callbacks.buttons(result.buttons); return result.sliders;
  }
  /** SCENARIO.CPP Do_Win/Do_Lose use the original VCR font, centered on the tactical view. */
  async outcome(won: boolean, palette: Uint8Array, view: ReturnType<Game['tacticalView']>, background: () => void) {
    await this.interfaceReady;
    const font = decodeFont(await this.assets.bytes('VCR.FNT'));
    this.ui.pixels.fill(255);
    for (const [index, label] of ['MISSION', won ? 'ACCOMPLISHED' : 'FAILED'].entries()) {
      let x = 320 - Math.trunc(Array.from(label).reduce((sum, ch) => sum + font.glyphs[ch.charCodeAt(0)].width, 0) / 2);
      const y = 168 + index * 30;
      for (const ch of label) {
        const glyph = font.glyphs[ch.charCodeAt(0)];
        for (let dy = 0; dy < glyph.height; dy++) for (let dx = 0; dx < glyph.width; dx++)
          if (glyph.pixels[dy * glyph.width + dx]) this.ui.pixels[(y + dy) * 640 + x + dx] = 15;
        x += glyph.width;
      }
    }
    this.screen.setOverlay(true); this.screen.set(this.ui.pixels, palette, 640, 400);
    // SCENARIO.CPP Do_Win/Do_Lose: center on the tactical view, with the
    // first line 32 pixels above its midpoint and the next line 30 pixels lower.
    const placement = {
      x: (view.x + Math.trunc(view.width / 2) - 320) * view.scale,
      y: (view.y + Math.trunc(view.height / 2) - 200) * view.scale,
      scale: view.scale,
    };
    this.renderer.setFrame((width, height) => this.screen.draw(width, height, placement, background));
    this.callbacks.status('outcome'); this.callbacks.buttons([]);
  }
  async score(side: CampaignSide, values: import('./score.ts').ScoreValues) {
    this.music.stop();
    this.clearTimers(); this.callbacks.status('score'); this.callbacks.buttons([]); this.showScreen(); this.screen.setOverlay(false);
    this.screen.fade(0);this.scoreAbort = new AbortController();
    const { ScorePresentation } = await import('./score.ts');
    await new ScorePresentation(this.assets, this.screen, this.sound, this.scoreAbort.signal, this.callbacks.error, this.callbacks.status).play(side, values);
  }
  async nextMission(side: CampaignSide, name: string, completed: number) {
    this.music.stop();this.clearTimers();this.callbacks.status('map');this.callbacks.buttons([]);this.showScreen();this.screen.setOverlay(false);
    this.screen.fade(0);this.scoreAbort=new AbortController();
    const { MapSelection }=await import('./map-selection.ts');
    return new MapSelection(this.assets,this.screen,this.sound,this.scoreAbort.signal,this.callbacks.error,this.callbacks.status).play(side,name,completed);
  }
  /** ENDING.CPP GDI_Ending / Nod_Ending, including the four satellite targets. */
  async ending(side: CampaignSide, values: import('./score.ts').ScoreValues, templeIoned: boolean) {
    if(side==='gdi'){
      await this.playMovie(templeIoned?'GDIFINB':'GDIFINA',side);
      await this.score(side,values);
      await this.playMovie(templeIoned?'GDIEND2':'GDIEND1',side);
    }else{
      await this.score(side,values);
      const { decodeCps }=await import('../formats/cps.ts');
      const { GameStrings }=await import('../formats/strings.ts');
      const [picture,palette,table,font,strings]=await Promise.all([
        this.assets.bytes('SATSEL.CPS',['transit.mix','nod/general.mix']).then(decodeCps),this.assets.bytes('SATSEL.PAL'),
        this.assets.bytes('SATSELIN.PAL'),this.assets.bytes('12GRNGRD.FNT').then(decodeFont),this.assets.bytes('CONQUER.ENG').then(bytes=>new GameStrings(bytes)),
      ]);
      await this.playMovie('NODFINAL',side,undefined,false);
      const colors=palette.map(value=>Math.min(63,value+Math.trunc(value*30/100)));
      this.screen.set(picture.pixels,colors,320,200,table);this.callbacks.status('ending');this.showScreen();
      const speech=await this.sound.play('KANEFINL',false,false,128/255),loop=await this.sound.play('LOOPIE6M',true,false,128/255);
      if(speech)await new Promise<void>(resolve=>speech.addEventListener('ended',()=>resolve(),{once:true}));
      const tan=[0,237,237,44,44,251,251,253,253,0,0,0,0,0,82,0],label=strings.get(675);
      let chosen=false;
      const choice=new Promise<string>(resolve=>{this.dialogSelection=id=>{chosen=true;resolve(id);};});
      this.callbacks.buttons([
        {id:'message:2',label:'Target 2',x:0,y:44,width:320,height:156},{id:'message:1',label:'Target 1',x:320,y:44,width:320,height:156},
        {id:'message:3',label:'Target 3',x:0,y:200,width:320,height:155},{id:'message:4',label:'Target 4',x:320,y:200,width:320,height:155},
      ]);
      let x=0;const foreground=new Uint8Array(640*400).fill(255);
      for(const character of label){if(chosen)break;const glyph=font.glyphs[character.charCodeAt(0)];for(let y=0;y<glyph.height;y++)for(let dx=0;dx<glyph.width;dx++){
        const color=glyph.pixels[y*glyph.width+dx];if(color)foreground[(360+y)*640+x+dx]=tan[color];
      }x+=12;this.screen.set(picture.pixels,colors,320,200,table);this.screen.setForeground(foreground);await new Promise(resolve=>setTimeout(resolve,1000/60));}
      const selected=await choice;this.dialogSelection=undefined;this.callbacks.buttons([]);loop?.stop();
      this.movie.preserveNextFrame();
      await this.playMovie(`NODEND${selected}`,side);
    }
    if(await this.assets.source('TRAILER.VQA',[`${side}/movies.mix`])){await this.teaserCard(side);await this.playMovie('TRAILER',side);}
    await this.teaserCard(side);await this.playMovie('CC2TEASE',side);
  }
  /** INIT.CPP / ENDING.CPP: the 199-line teaser card with quarter-second fades. */
  private async teaserCard(side:CampaignSide){
    const {decodeCps}=await import('../formats/cps.ts');
    const source=await this.assets.source('ATTRACT2.CPS',['update.mix','transit.mix',`${side}/general.mix`,'general.mix']);
    this.screen.setOverlay(false);this.showScreen();this.screen.fade(0);
    if(source){
      const page=decodeCps(await source.read(0,source.size)),pixels=new Uint8Array(640*400);
      for(let y=0;y<398;y++)for(let x=0;x<640;x++)pixels[y*640+x]=page.pixels[Math.trunc(y/2)*320+Math.trunc(x/2)];
      this.screen.set(pixels,page.palette,640,400);
      for(let step=1;step<=15&&!this.disposed;step++){this.screen.fade(step/15);await new Promise(resolve=>setTimeout(resolve,1000/60));}
    }
    await new Promise(resolve=>setTimeout(resolve,3000));
    for(let step=1;step<=15&&!this.disposed;step++){this.screen.fade(1-step/15);await new Promise(resolve=>setTimeout(resolve,1000/60));}
  }
  private async chooseSide() {
    await this.interfaceReady;
    this.clearTimers(); this.callbacks.buttons([]); this.sound.stop(); this.callbacks.status('starting');
    const phase = this.phase;
    const bytes=await this.assets.optionalBytes('CHOOSE.WSA');
    if(!bytes){
      // Keep the available missions reachable when Gold's presentation archive is absent.
      const buttons=[{id:'gdi',label:'Global Defense Initiative',x:180,y:108,width:280,height:24},
        {id:'nod',label:'Brotherhood of Nod',x:180,y:156,width:280,height:24}];
      this.screen.set(this.ui.menu(buttons,'gdi'),this.ui.title.palette,640,400);
      const choice=new Promise<CampaignSide>(resolve=>{this.selection=resolve;});
      this.callbacks.status('choosing');this.callbacks.buttons(buttons);
      const side=await choice;
      this.selection=undefined;this.callbacks.buttons([]);
      if(!this.disposed)await this.callbacks.mission(side,this.renderer,this.assets,this);
      return;
    }
    const [table,fontBytes]=await Promise.all([this.assets.bytes('SIDES.PAL'),this.assets.bytes('12GRNGRD.FNT')]);
    if (this.disposed) return;
    const animation = new WsaVideo(bytes), font = decodeFont(fontBytes), pixels = new Uint8Array(320 * 200);
    const foreground=new Uint8Array(640*400).fill(255);
    let captionCharacters=0;
    const text = (label: string, x: number, y: number, colors: number[]) => {
      x*=2;y*=2;
      for (const character of label.slice(0,captionCharacters)) {
        const glyph = font.glyphs[character.charCodeAt(0)];
        for (let dy = 0; dy < glyph.height; dy++) for (let dx = 0; dx < glyph.width; dx++) {
          const index = glyph.pixels[dy * glyph.width + dx];
          if (index) foreground[(y + dy) * 640 + x + dx] = colors[index] ?? colors[1];
        }
        x += glyph.width;
      }
    };
    let nextFrame = 0, selected: CampaignSide | undefined, spoken = false, atEnd: (() => void) | undefined;
    const endReached = () => selected !== undefined && spoken && nextFrame === (selected === 'gdi' ? 0 : 14);
    const draw = () => {
      if (endReached()) { atEnd?.(); return; }
      pixels.fill(0);
      const frame = animation.next();
      nextFrame = (nextFrame + 1) % animation.frameCount;
      captionCharacters+=3;
      for (let y = 0; y < animation.height; y++) pixels.set(frame.subarray(y * animation.width, (y + 1) * animation.width), (y + animation.y) * 320 + animation.x);
      text('GLOBAL DEFENSE INITIATIVE', 0, 180, [0,201,186,147,97,238,238,0,0,0,0,0,0,0,0,0]);
      text('BROTHERHOOD OF NOD', 180, 180, [0,168,217,218,225,212,218,0,225,0,0,0,0,0,212,0]);
      text('SELECT TRANSMISSION', 103, 190, [0,23,16,18,20,28,18,28,20,0,0,0,0,0,28,0]);
      this.screen.set(pixels, animation.palette, 320, 200, table);
      this.screen.setForeground(foreground);
    };
    const choice = new Promise<CampaignSide>(resolve => { this.selection = resolve; });
    draw(); this.timer = setInterval(draw, 50);
    // INTRO.CPP Choose_Side handles clicks throughout the animation. A slow
    // background sound read must not leave the already visible choices inactive.
    let staticSound: AudioBufferSourceNode | undefined;
    void this.sound.play('STRUGGLE',true,false,64/255).then(node => {
      if (this.disposed || this.phase !== phase) { node?.stop(); return; }
      staticSound = node;
      if (node) node.loopEnd = Math.min(node.buffer!.duration, 63 / 60);
    }).catch(this.callbacks.error);
    this.callbacks.status('choosing');
    this.callbacks.buttons([
      { id: 'gdi', label: 'Global Defense Initiative', x: 36, y: 96, width: 260, height: 204 },
      { id: 'nod', label: 'Brotherhood of Nod', x: 320, y: 96, width: 280, height: 204 },
    ]);
    const side = await choice;
    if (this.disposed) return;
    selected = side;
    this.selection = undefined; this.callbacks.buttons([]);
    const speech = await this.sound.play(side === 'gdi' ? 'GDI_SLCT' : 'NOD_SLCT');
    if (speech) await new Promise<void>(resolve => { speech.onended = () => { speech.disconnect(); resolve(); }; });
    spoken = true;
    if (!endReached()) await new Promise<void>(resolve => { atEnd = resolve; });
    staticSound?.stop(); this.clearTimers(); this.callbacks.status('movie');
    this.screen.setForeground(new Uint8Array(640*400).fill(255));
    await this.movie.play(side === 'gdi' ? 'GDI1' : 'NOD1PRE', side, true, side==='gdi',true);
    if(side==='nod')this.movie.preserveNextFrame();
    if (!this.disposed) await this.callbacks.mission(side, this.renderer, this.assets, this);
  }
  private clearTimers() { this.phase++;clearInterval(this.timer); clearTimeout(this.attract); this.timer = this.attract = undefined; this.scoreAbort?.abort(); this.scoreAbort = undefined;this.paintFocus=undefined; }
  beginMusic(theme?:string) { void this.music.start(theme).catch(this.callbacks.error); }
  dispose() { this.disposed = true; this.clearTimers(); document.removeEventListener('visibilitychange', this.visibility); this.selection?.('gdi'); this.music.stop(); this.sound.dispose(); this.movie.stop(); this.screen.dispose(); this.renderer.dispose(); }
}
