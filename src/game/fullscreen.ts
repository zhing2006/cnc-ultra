/** Keys used by the original Keyboard_Process and Handle_Team in CONQUER.CPP. */
const GAME_KEYS = [...Array.from({ length: 10 }, (_, i) => `Digit${i}`), 'F7', 'F8', 'F9', 'F10'];
interface KeyboardLock {
  lock(keys: string[]): Promise<void>;
  unlock(): void;
}

/** Browser fullscreen alone does not activate Keyboard Lock; use the Fullscreen API. */
export function fullscreenControls() {
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
  const changed = () => {
    if (!document.fullscreenElement) keyboard?.unlock();
  };
  document.addEventListener('fullscreenchange', changed);
  return {
    async toggle() {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
        // Leave Escape with the browser so it still releases the mouse and fullscreen.
        if (keyboard) await keyboard.lock(GAME_KEYS);
      }
    },
    dispose() {
      document.removeEventListener('fullscreenchange', changed);
      keyboard?.unlock();
    },
  };
}
