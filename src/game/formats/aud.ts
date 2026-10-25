/** AUD chunk framing and codecs, cross-checked against OpenRA's AudReader. */
export interface AudSound { rate: number; bits: number; channels: number; pcm: Uint8Array }
const IMA_STEPS = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const IMA_INDEX = [-1,-1,-1,-1,2,4,6,8];
const WS_DELTA = [[-2,-1,0,1],[-9,-8,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,8]];

/** The same IMA state continues across a VQA movie's SND2 chunks. */
export class ImaStream {
  private sample = 0;
  private index = 0;
  decode(bytes: Uint8Array): Uint8Array {
    const output = new Uint8Array(bytes.length * 4), view = new DataView(output.buffer);
    let at = 0;
    for (const packed of bytes) for (let half = 0; half < 2; half++) {
      const code = (packed >> (half * 4)) & 15, step = IMA_STEPS[this.index];
      const delta = ((step * (code & 7)) >> 2) + (step >> 3);
      this.sample = Math.max(-32768, Math.min(32767, this.sample + (code & 8 ? -delta : delta)));
      this.index = Math.max(0, Math.min(88, this.index + IMA_INDEX[code & 7]));
      view.setInt16(at, this.sample, true); at += 2;
    }
    return output;
  }
}

export function decodeAud(bytes: Uint8Array): AudSound {
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = input.getUint16(0, true), end = 12 + input.getUint32(2, true);
  const pcm = new Uint8Array(input.getUint32(6, true)), output = new DataView(pcm.buffer);
  const bits = bytes[10] & 2 ? 16 : 8, channels = bytes[10] & 1 ? 2 : 1, codec = bytes[11];
  if (channels !== 1 || (codec !== 1 && codec !== 99)) throw new Error('Unsupported AUD codec or channel layout');
  let at = 12, written = 0, imaSample = 0, imaIndex = 0;
  while (at < end && written < pcm.length) {
    const size = input.getUint16(at, true), decoded = input.getUint16(at + 2, true);
    if (input.getUint32(at + 4, true) !== 0xdeaf) throw new Error('Invalid AUD chunk marker');
    at += 8;
    // IMA encoders can leave the final advertised sample without a compressed nibble.
    // Like the reference reader, consume available nibbles and cap by the overall output size.
    const limit = at + size, outputEnd = codec === 99 ? Math.min(pcm.length, written + size * 4) : written + decoded;
    if (limit > bytes.length || outputEnd > pcm.length) throw new Error('AUD chunk exceeds its declared size');
    if (codec === 99) {
      while (at < limit) {
        const packed = bytes[at++];
        for (let half = 0; half < 2 && written < outputEnd; half++) {
          const code = (packed >> (half * 4)) & 15, step = IMA_STEPS[imaIndex];
          const delta = ((step * (code & 7)) >> 2) + (step >> 3);
          imaSample = Math.max(-32768, Math.min(32767, imaSample + (code & 8 ? -delta : delta)));
          imaIndex = Math.max(0, Math.min(88, imaIndex + IMA_INDEX[code & 7]));
          output.setInt16(written, imaSample, true); written += 2;
        }
      }
    } else if (size === decoded) {
      pcm.set(bytes.subarray(at, limit), written); at = limit; written = outputEnd;
    } else {
      let sample = 128;
      while (at < limit) {
        const command = bytes[at++], mode = command >> 6, count = (command & 63) + 1;
        if (mode < 2) {
          const width = mode === 0 ? 2 : 4, mask = (1 << width) - 1;
          for (let n = 0; n < count; n++) {
            const packed = bytes[at++];
            for (let shift = 0; shift < 8; shift += width) {
              sample = Math.max(0, Math.min(255, sample + WS_DELTA[mode][(packed >> shift) & mask]));
              pcm[written++] = sample;
            }
          }
        } else if (mode === 2 && (command & 32)) {
          sample += ((command & 63) << 27) >> 27; pcm[written++] = sample;
        } else if (mode === 2) {
          pcm.set(bytes.subarray(at, at + count), written); written += count; at += count; sample = bytes[at - 1];
        } else {
          pcm.fill(sample, written, written + count); written += count;
        }
      }
    }
    if (written !== outputEnd) throw new Error('AUD chunk decoded to the wrong length');
  }
  if (codec !== 99 && written !== pcm.length) throw new Error('Incomplete AUD sample');
  return { rate, bits, channels, pcm: pcm.subarray(0, written) };
}
