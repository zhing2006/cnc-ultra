import type { GamePreferences } from '../options.ts';
import type { OriginalInterface, MenuButton } from './interface.ts';
import type { CampaignMusic } from './music.ts';

export type ControlsPage = 'game' | 'visual' | 'sound';
export interface MenuSlider {
  id: keyof GamePreferences; label: string; x: number; y: number; width: number; height: number; value: number; max: number; thumb:number; range:number; reversed?: boolean;
}

/** GAMEDLG.CPP, VISUDLG.CPP and SOUNDDLG.CPP: original 640x400 dialog coordinates. */
export function drawControls(ui: OriginalInterface, page: ControlsPage, settings: GamePreferences, music: CampaignMusic, trackOffset = 0,focus='options') {
  const buttons: MenuButton[] = [], sliders: MenuSlider[] = [];
  const button = (id: string, label: string, x: number, y: number, width: number, height = 18) => buttons.push({ id, label, x, y, width, height });
  const slider = (id: MenuSlider['id'], label: string, x: number, y: number, width: number, height: number, range = 255, reversed = false,thumb=page==='visual'?20:16) => {
    const max=range-thumb,value = Number(settings[id]); sliders.push({ id, label, x, y, width, height, max,thumb,range,reversed, value: Math.max(0,Math.min(max,reversed ? max - value : value)) });
  };
  ui.pixels.fill(255);
  if (page === 'game') {
    ui.dialog(84, 59, 464, 282); ui.caption('Game Controls',84,59,464,2);
    for (const [id, label, y] of [['gameSpeed', 'Game Speed', 143], ['scrollRate', 'Scroll Rate', 203]] as const) {
      ui.text(label, 104, y - 14, focus===id, false); ui.text('Slower', 104, y + 13, false, false);
      ui.text('Faster', 528 - ui.textWidth('Faster'), y + 13, false, false);
      slider(id, label, 104, y, 424, 12, 7, true,1);
    }
    button('controls:visual', 'Visual Controls', 124, 249, 384);
    button('controls:sound', 'Sound Controls', 124, 277, 384);
    button('options', 'Options Menu', 230, 313, 180);
  } else if (page === 'visual') {
    ui.dialog(104, 78, 432, 244); ui.caption('Visual Controls',104,78,432,10);
    for (const [i, id] of (['brightness', 'color', 'contrast', 'tint'] as const).entries()) {
      const label = id[0].toUpperCase() + id.slice(1), y = 138 + i * 22;
      ui.text(label, 306-ui.textWidth(label), y, focus===id, false); slider(id, label, 314, y, 140, 10);
    }
    button('controls:reset', 'Reset', 134, 282, 120);
    button('controls:game', 'Game Controls', 324, 282, 182);
  } else {
    ui.dialog(28, 54, 584, 292); ui.caption('Sound Controls',28,54,584,16);
    ui.text('Music Volume', 84, 110, false, false); slider('musicVolume', 'Music Volume', 322, 110, 216, 10);
    ui.text('Sound Volume', 84, 134, false, false); slider('volume', 'Sound Volume', 322, 134, 216, 10);
    music.tracks.slice(trackOffset, trackOffset + 8).forEach((track, i) => {
      button(`track:${track[0]}`,track[1],36,164+i*18,540);
      ui.track(buttons.at(-1)!,trackOffset+i+1,track[2],track[1],track[0]===music.selected);
    });
    button('tracks:previous', 'Previous tracks', 578, 164, 26, 28);buttons.at(-1)!.icon='HBTN-UP.SHP';
    button('tracks:next', 'Next tracks', 578, 280, 26, 28);buttons.at(-1)!.icon='HBTN-DN.SHP';
    button('music:stop', 'Stop', 38, 312, 32,24); buttons.at(-1)!.icon='BTN-STH.SHP';
    button('music:play', 'Play', 74, 312, 32,24); buttons.at(-1)!.icon='BTN-PLH.SHP';
    ui.text('Shuffle', 174, 295, false, false); button('music:shuffle', settings.shuffle ? 'On' : 'Off', 210, 314, 50);
    ui.text('Repeat', 316, 295, false, false); button('music:repeat', settings.repeat ? 'On' : 'Off', 360, 314, 50);
    button('options', 'Options Menu', 428, 314, 170);
  }
  for (const item of sliders) {
    for (let y = 0; y < item.height; y++) ui.pixels.fill(y === 0 ? 12 : y === item.height - 1 ? 14 : 0,
      (item.y + y) * 640 + item.x, (item.y + y) * 640 + item.x + item.width);
    const width=Math.max(4,Math.trunc(item.width*item.thumb/item.range+0.5));
    ui.box({ id: '', label: '', x: item.x + Math.min(item.width-width,Math.trunc(item.value*item.width/item.range+0.5)), y: item.y, width, height: item.height }, false, false, true);
    for(const direction of [-1,1]){const icon=direction<0?'BTN-MINS.SHP':'BTN-PLUS.SHP',size=ui.iconSize(icon);buttons.push({id:`slider:${item.id}:${direction}`,label:`${direction<0?'Decrease':'Increase'} ${item.label}`,x:direction<0?item.x-6:item.x+item.width+2,y:item.y,...size,icon});}
  }
  for (const item of buttons)if(!item.id.startsWith('track:'))ui.box(item,item.id===focus,false,true);
  return { buttons, sliders };
}
