import { CampaignPresentation } from '../src/game/campaign/presentation.ts';
import { OriginalInterface, type MenuButton } from '../src/game/campaign/interface.ts';
import { MoviePlayer } from '../src/game/campaign/movie.ts';
import { CampaignAudio } from '../src/game/campaign/audio.ts';

/** Slow menu/sound reads must not hold the opening movie or discard a visible faction click. */
export async function campaignStartup() {
  const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:640px;height:400px'; document.body.append(canvas);
  const audio = new AudioContext();
  const open = OriginalInterface.open, play = MoviePlayer.prototype.play, sound = CampaignAudio.prototype.play;
  let releaseMenu!: () => void, requestedMenu!: () => void, releaseSound!: (node: AudioBufferSourceNode) => void, requestedSound!: () => void;
  const menuGate = new Promise<void>(resolve => { releaseMenu = resolve; }), menuStarted = new Promise<void>(resolve => { requestedMenu = resolve; });
  const soundGate = new Promise<AudioBufferSourceNode>(resolve => { releaseSound = resolve; }), soundStarted = new Promise<void>(resolve => { requestedSound = resolve; });
  let presentation: CampaignPresentation | undefined, buttons: readonly MenuButton[] = [], mission = false, stopped = false;
  const movies: string[] = [], failures: string[] = [];
  const node = { buffer: { duration: 1 }, stop() { stopped = true; } } as unknown as AudioBufferSourceNode;
  const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  try {
    OriginalInterface.open = async assets => { requestedMenu(); await menuGate; return open(assets); };
    MoviePlayer.prototype.play = async name => { movies.push(name); };
    CampaignAudio.prototype.play = (async (name: string) => {
      if (name === 'STRUGGLE') { requestedSound(); return soundGate; }
      return undefined;
    }) as typeof sound;
    const opening = CampaignPresentation.open(canvas, audio, {
      buttons: value => { buttons = value; }, status() {}, exit() {},
      mission: async () => { mission = true; }, error: error => { throw error; },
    }).then(async value => { presentation = value; if (!value) throw new Error('WebGPU is required'); await value.start(); });
    await menuStarted; await yieldTask();
    if (movies[0] !== 'LOGO') failures.push('Opening LOGO waits for unrelated main-menu assets');
    releaseMenu(); await opening;
    const choosing = presentation!.command('new');
    await soundStarted; await yieldTask();
    const ready = buttons.some(button => button.id === 'gdi');
    if (!ready) failures.push('The visible faction animation cannot be clicked until STRUGGLE loads');
    await presentation!.command('gdi'); await yieldTask();
    if (!ready) {
      releaseSound(node); await yieldTask(); await presentation!.command('gdi');
    }
    await choosing;
    if (!mission || !movies.includes('GDI1')) failures.push('The first faction click did not select its campaign');
    releaseSound(node); await yieldTask();
    if (!stopped) failures.push('A late faction background sound survived the transition to the briefing');
    return failures;
  } finally {
    releaseMenu(); releaseSound(node); presentation?.dispose();
    OriginalInterface.open = open; MoviePlayer.prototype.play = play; CampaignAudio.prototype.play = sound;
    await audio.close(); canvas.remove();
  }
}
