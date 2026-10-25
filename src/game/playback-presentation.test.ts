import { expect, it } from 'vitest';
import { PlaybackPresentation } from './playback-presentation.ts';

it('caps fast-forward drawing independently of a 180 Hz display', () => {
  const frames = new PlaybackPresentation();
  frames.configure(100, false);
  let drawn = 0;
  for (let frame = 0; frame < 180; frame++) if (frames.draw(frame * 1000 / 180)) drawn++;
  expect(drawn).toBe(60);
  frames.configure(1, false);
  for (let frame = 0; frame < 180; frame++) expect(frames.draw(frame * 1000 / 180)).toBe(true);
});

it('reduces drawing under sustained slow simulation and restores it without single-sample oscillation', () => {
  const frames = new PlaybackPresentation();
  frames.configure(100, false);
  frames.sample(8); expect(frames.limit).toBe(60);
  frames.sample(8); expect(frames.limit).toBe(30);
  frames.sample(8); frames.sample(8); expect(frames.limit).toBe(15);
  frames.sample(14); frames.sample(14); expect(frames.limit).toBe(15);
  frames.sample(14); frames.sample(14); expect(frames.limit).toBe(30);
  frames.configure(100, true); expect(frames.limit).toBe(0);
  expect(frames.draw(1000)).toBe(true); expect(frames.draw(1001)).toBe(true);
});

it('draws one current frame after a stall rather than replaying missed frames', () => {
  const frames = new PlaybackPresentation();
  frames.configure(10, false);
  expect(frames.draw(0)).toBe(true);
  expect(frames.draw(10000)).toBe(true);
  expect(frames.draw(10001)).toBe(false);
  expect(frames.draw(10000 + 1000 / 60)).toBe(true);
});
