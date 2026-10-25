import { decodeFont, type BitmapFont } from '../formats/font.ts';
import { decodeShp, type Shape } from '../formats/shp.ts';
import { decodePcx } from '../formats/pcx.ts';
import { decodeCps } from '../formats/cps.ts';
import type { CampaignAssets } from './assets.ts';

export interface MenuButton { id: string; label: string; x: number; y: number; width: number; height: number; disabled?: boolean; icon?:string }

/** Ported from MENUS.CPP, Main_Menu (Gold's seven-button menu without expansions). */
export const MAIN_MENU: MenuButton[] = [
  ['new', 'Start New Game'], ['bonus', 'Bonus Missions'], ['internet', 'Internet Game'],
  ['load', 'Load Mission'], ['multiplayer', 'Multiplayer Game'], ['intro', 'Intro & Sneak Peek'], ['exit', 'Exit Game'],
].map(([id, label], i) => ({ id, label, x: id === 'exit' ? 256 : 196, y: 50 + i * 26, width: id === 'exit' ? 126 : 250, height: 18,
  disabled: id === 'internet' || id === 'multiplayer' }));

export class OriginalInterface {
  readonly pixels = new Uint8Array(640 * 400);
  private constructor(readonly title: ReturnType<typeof decodePcx>, private readonly font: BitmapFont, private readonly texture: Shape,private readonly icons:Map<string,Shape>) {}
  static async open(assets: CampaignAssets) {
    const [title, font, texture,icons] = await Promise.all([
      assets.optionalBytes('HTITLE.PCX'), assets.bytes('GRAD6FNT.FNT'), assets.bytes('BTEXTURE.SHP', ['updatec.mix']),
      Promise.all(['OPTIONS.SHP','BTN-STH.SHP','BTN-PLH.SHP','HBTN-UP.SHP','HBTN-DN.SHP','BTN-PLUS.SHP','BTN-MINS.SHP'].map(async name=>{
        const bytes=await assets.optionalBytes(name,['updatec.mix','conquer.mix','cclocal.mix']);return [name,bytes&&decodeShp(bytes)] as const;
      })).then(entries=>new Map(entries.filter((entry):entry is readonly[string,Shape]=>!!entry[1]))),
    ]);
    if(title)return new OriginalInterface(decodePcx(title), decodeFont(font), decodeShp(texture),icons);
    // The development archives contain the original low-resolution title.
    const low=decodeCps(await assets.bytes('TITLE.CPS')),pixels=new Uint8Array(640*400);
    for(let y=0;y<400;y++)for(let x=0;x<640;x++)pixels[y*640+x]=low.pixels[(y>>1)*320+(x>>1)];
    return new OriginalInterface({pixels,palette:low.palette,width:640,height:400},decodeFont(font),decodeShp(texture),icons);
  }
  /** DIALOG.CPP, Fancy_Text_Print: gradient font with medium/bright color and no shadow. */
  textWidth(label: string) { return Array.from(label).reduce((sum, ch) => sum + this.font.glyphs[ch.charCodeAt(0)].width - 1, 0); }
  wrap(label: string, width: number) {
    const lines: string[] = [];
    for (const paragraph of label.split(/@|\r?\n/)) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        if (line && this.textWidth(`${line} ${word}`) > width) { lines.push(line); line = ''; }
        line += `${line ? ' ' : ''}${word}`;
      }
      lines.push(line);
    }
    return lines;
  }
  text(label: string, x: number, y: number, bright = false, centered = true) {
    const glyphs = Array.from(label, ch => this.font.glyphs[ch.charCodeAt(0)]);
    let cursor = Math.trunc(x - (centered ? glyphs.reduce((sum, glyph) => sum + glyph.width - 1, 0) / 2 : 0));
    for (const glyph of glyphs) {
      for (let dy = 0; dy < glyph.height; dy++) for (let dx = 0; dx < glyph.width; dx++) {
        const value = glyph.pixels[dy * glyph.width + dx];
        if (value === 1 || value >= 4) this.pixels[(y + dy) * 640 + cursor + dx] = bright ? 4 : 41;
      }
      cursor += glyph.width - 1;
    }
  }
  /** DIALOG.CPP, Draw_Box and CONQUER.CPP, CC_Texture_Fill. */
  box(button: MenuButton, focused: boolean, pressed = false) {
    if(button.icon&&this.icons.has(button.icon)){this.icon(button.icon,pressed?1:0,button.x,button.y);return;}
    const { x, y, width, height } = button, texture = this.texture;
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
      let color = button.disabled ? 12 : texture.frames[0][(dy % texture.height) * texture.width + dx % texture.width];
      if (dy === height - 1 || dx === width - 1) color = pressed ? 14 : 12;
      if (dy === 0 || dx === 0) color = pressed ? 12 : 14;
      if (dx === 0 && dy === height - 1 || dx === width - 1 && dy === 0) color = 13;
      this.pixels[(y + dy) * 640 + x + dx] = color;
    }
    this.text(button.label, x + width / 2, y + 1, focused || pressed);
  }
  iconSize(name:string){const shape=this.icons.get(name);return {width:shape?.width??6,height:shape?.height??10};}
  icon(name:string,frame:number,x:number,y:number,center=false){
    const shape=this.icons.get(name);if(!shape)return;const pixels=shape.frames[frame];if(!pixels)return;
    if(center){x-=Math.trunc(shape.width/2);y-=Math.trunc(shape.height/2);}
    for(let dy=0;dy<shape.height;dy++)for(let dx=0;dx<shape.width;dx++){const ink=pixels[dy*shape.width+dx];if(ink&&x+dx>=0&&x+dx<640&&y+dy>=0&&y+dy<400)this.pixels[(y+dy)*640+x+dx]=ink;}
  }
  /** GOPTIONS.CPP Draw_Caption, using the original ornament frames. */
  caption(label:string,x:number,y:number,width:number,kind=0){
    this.icon('OPTIONS.SHP',kind,x+12,y+11,true);this.icon('OPTIONS.SHP',kind+1,x+width-14,y+11,true);
    if(!label)return;
    this.text(label,x+width/2,y+10,true);
    const left=Math.trunc(x+(width-this.textWidth(label))/2);this.pixels.fill(3,(y+24)*640+left,(y+24)*640+left+this.textWidth(label));
  }
  track(button:MenuButton,number:number,duration:number,title:string,selected:boolean){
    for(let y=0;y<button.height;y++)this.pixels.fill(selected?140:0,(button.y+y)*640+button.x,(button.y+y)*640+button.x+button.width);
    this.text(`Track ${number}`,button.x,button.y,selected,false);
    this.text(`${Math.trunc(duration/60)}:${String(duration%60).padStart(2,'0')}`,button.x+110,button.y,selected,false);
    this.text(title,button.x+180,button.y,selected,false);
  }
  menu(buttons: readonly MenuButton[], focus = 'new') {
    this.pixels.set(this.title.pixels);
    this.dialog(170, 0, 304, 272);
    this.caption('',170,0,304);
    for (const button of buttons) this.box(button, button.id === focus);
    return this.pixels;
  }
  dialog(x: number, y: number, width: number, height: number) {
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++)
      this.pixels[(y + dy) * 640 + x + dx] = (dx === 1 || dx === width - 2) && dy > 0 && dy < height - 1 || (dy === 1 || dy === height - 2) && dx > 0 && dx < width - 1 ? 14 : 0;
  }
}
