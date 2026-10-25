/** SCORE.CPP, ScoreClass::Input_Name. */
export class ScoreName {
  value = '';
  cursor = 0;
  done = false;
  accept(key: string): string | undefined {
    if (key === 'Backspace' && this.cursor === 10 && this.value[10] && this.value[10] !== ' ') key = ' ';
    if (key === 'Enter') this.done = true;
    else if (key === 'Backspace') {
      this.cursor = Math.max(0, this.cursor - 1);
      this.value = this.value.slice(0, this.cursor);
    } else if (/^[ -~]$/.test(key)) {
      const character = key.toUpperCase();
      this.value = this.value.slice(0, this.cursor) + character;
      this.cursor = Math.min(10, this.cursor + 1);
      return character;
    }
  }
}
