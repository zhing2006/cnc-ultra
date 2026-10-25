/** OPTIONS.CPP Load_Settings: values exposed by the original controls dialogs. */
export interface GamePreferences {
  gameSpeed: number; scrollRate: number; volume: number; musicVolume: number;
  brightness: number; color: number; contrast: number; tint: number; shuffle: boolean; repeat: boolean;
}
export const DEFAULT_PREFERENCES: Readonly<GamePreferences> = {
  gameSpeed: 4, scrollRate: 4, volume: 160, musicVolume: 255,
  brightness: 128, color: 128, contrast: 128, tint: 128, shuffle: false, repeat: false,
};
export function readPreferences(): GamePreferences {
  try { return { ...DEFAULT_PREFERENCES, ...JSON.parse(localStorage.getItem('cnc-ultra-options') ?? '{}') }; }
  catch { return { ...DEFAULT_PREFERENCES }; }
}
export function savePreferences(value: GamePreferences) {
  try { localStorage.setItem('cnc-ultra-options', JSON.stringify(value)); } catch { /* Session settings still apply without browser storage. */ }
}

// Ported from Nyerguds WIN32LIB/MISC/LIB.CPP, Convert_RGB_To_HSV and Convert_HSV_To_RGB.
const roundedDivide=(value:number,divisor:number)=>Math.trunc(value/divisor)+Number(value%divisor>=((divisor+1)>>1));
function rgbToHsv(red:number,green:number,blue:number){
  const r=roundedDivide(red*255,63),g=roundedDivide(green*255,63),b=roundedDivide(blue*255,63);
  const value=Math.max(r,g,b),minimum=Math.min(r,g,b),range=value-minimum,saturation=value?roundedDivide(range*255,value):0;
  let hue=0;
  if(saturation){
    const r1=roundedDivide((value-r)*255,range),g1=roundedDivide((value-g)*255,range),b1=roundedDivide((value-b)*255,range);
    hue=value===r?(minimum===g?5*255+b1:255-g1):value===g?(minimum===b?255+r1:3*255-b1):(minimum===r?3*255+g1:5*255-r1);
    hue=roundedDivide(hue,6);
  }
  return [hue,saturation,value];
}
function hsvToRgb(hue:number,saturation:number,value:number){
  const h=hue*6,f=h%255,values=[0,value,value,
    roundedDivide(value*(255-roundedDivide(saturation*f,255)),255),
    roundedDivide(value*(255-saturation),255),roundedDivide(value*(255-saturation),255),
    roundedDivide(value*(255-roundedDivide(saturation*(255-f),255)),255)];
  let index=Math.trunc(h/255);const next=()=>{index+=index>4?-4:2;return roundedDivide(values[index]*63,255);};
  const r=next(),b=next(),g=next();return [r,g,b];
}

/** OPTIONS.CPP Adjust_Palette: original six-bit palette and integer HSV rounding. */
export function adjustGamePalette(source: Uint8Array, options: GamePreferences) {
  const result = source.slice();
  if (['brightness', 'contrast', 'color', 'tint'].every(key => options[key as keyof GamePreferences] === 128)) return result;
  const clamp = (value: number) => Math.min(255, Math.max(0, Math.trunc(value)));
  const brightness = 64 + ((options.brightness * 128 + 128) >> 8), contrast = 64 + ((options.contrast * 128 + 128) >> 8);
  for (let index = 0; index < 255; index++) {
    const [h,s,v]=rgbToHsv(source[index*4]>>2,source[index*4+1]>>2,source[index*4+2]>>2);
    const bright=clamp(v*brightness/128),value=Math.min(255,Math.max(0,Math.trunc((bright-128)*contrast/128)+128));
    const channels=hsvToRgb(clamp(h*options.tint/128),clamp(s*options.color/128),value);
    for(let channel=0;channel<3;channel++)result[index*4+channel]=channels[channel]<<2;
  }
  return result;
}
