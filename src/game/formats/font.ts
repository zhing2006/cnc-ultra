export interface FontGlyph { width:number; height:number; pixels:Uint8Array }
export interface BitmapFont { height:number; glyphs:FontGlyph[] }

/** FONT.H/TEXTPRNT.ASM: absolute character offsets and low-nibble-first scanlines. */
export function decodeFont(data:Uint8Array):BitmapFont {
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const word=(at:number)=>view.getUint16(at,true);
  const info=word(4),offsets=word(6),widths=word(8),heights=word(12),height=data[info+4];
  const glyphs=Array.from({length:256},(_,code)=>{
    const width=data[widths+code]??0,top=data[heights+code*2]??0,rows=data[heights+code*2+1]??0;
    const pixels=new Uint8Array(width*height),start=word(offsets+code*2);
    for(let y=0;y<rows&&y+top<height;y++)for(let x=0;x<width;x++){
      const packed=data[start+y*Math.ceil(width/2)+(x>>1)];pixels[(y+top)*width+x]=(packed>>((x&1)*4))&15;
    }
    return {width,height,pixels};
  });
  return {height,glyphs};
}
