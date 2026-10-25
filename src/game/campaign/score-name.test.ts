import { expect, it } from 'vitest';
import { ScoreName } from './score-name.ts';

it('erases the final full-name cell before moving the cursor back, as SCORE.CPP Input_Name does', () => {
  const name = new ScoreName();
  for (const key of 'abcdefghijk') name.accept(key);
  expect(name.value).toBe('ABCDEFGHIJK');
  name.accept('Backspace');
  expect(name.cursor).toBe(10);
  expect(name.value).toBe('ABCDEFGHIJ ');
  name.accept('z');
  expect(name.value).toBe('ABCDEFGHIJZ');
  name.accept('Backspace'); name.accept('Backspace');
  expect(name.value).toBe('ABCDEFGHI');
  expect(name.cursor).toBe(9);
  name.accept('Enter');
  expect(name.done).toBe(true);
});
