import type { Renderer } from '../../engine/renderer.ts';
import { startPreparedGame, type Game, type GameState } from '../game.ts';
import { readCampaignScenario, readBriefing } from './scenario.ts';
import { campaignScene } from './scene.ts';
import { CampaignRuntime } from './runtime.ts';
import type { CampaignAssets, CampaignSide } from './assets.ts';
import type { CampaignPresentation } from './presentation.ts';
import { decodeSave, encodeSave } from './save-file.ts';
import type { DebugState } from '../debug.ts';
import { carryCredits } from './progression.ts';
import { MOVEMENT } from '../data/movement.ts';
import { WALLS } from '../data/overlays.ts';

export interface CampaignCarry { credits: number; nukeSpent: boolean; nukePieces?: number; sabotaged?: string; debug?: Omit<DebugState, 'money'> }

export interface CampaignSave {
  campaign: 'original'; side: CampaignSide; name: string;
  game: Omit<GameState, 'buffers'>;
  rules: ReturnType<CampaignRuntime['saveCampaign']>;
  carry?: CampaignCarry;
}

export class CampaignSession {
  private constructor(readonly game: Game, readonly runtime: CampaignRuntime, readonly name: string, readonly side: CampaignSide, readonly briefing: string, readonly carry?: CampaignCarry) {}
  static async start(renderer: Renderer, canvas: HTMLCanvasElement, assets: CampaignAssets, presentation: CampaignPresentation,
    side: CampaignSide, options: { name?: string; saved?: Uint8Array; restart?: boolean; carry?: CampaignCarry; progress(message: string): void | Promise<void>; outcome(winner: number): void; options(): void }) {
    const saved = options.saved ? decodeSave<CampaignSave>(options.saved) : undefined;
    const name = saved?.metadata.name ?? options.name ?? (side === 'gdi' ? 'SCG01EA' : 'SCB01EA');
    side = saved?.metadata.side ?? side;
    if (!/^SC[GB]\d{2}[EW][A-Z]$/i.test(name) || !['gdi', 'nod'].includes(side) || saved && saved.metadata.campaign !== 'original') throw new Error('This is not an original campaign save.');
    await options.progress('Loading mission data');
    const archives = [`${side}/general.mix`, 'general.mix'];
    const [ini, bin] = await Promise.all([assets.bytes(`${name}.INI`, archives), assets.bytes(`${name}.BIN`, archives)]);
    const mission = readCampaignScenario(new TextDecoder('latin1').decode(ini), bin);
    const carry = saved?.metadata.carry ?? options.carry;
    const number = Number(name.slice(3, 5));
    if (number <= 15) mission.buildLevel = number;
    if(carry){
      // INI.CPP Read_Scenario_Ini: Credits only; the percentage is fixed 8.8, then rounded.
      mission.houses.find(house=>house.name===mission.player)!.credits+=carryCredits(carry.credits,mission.carryOverMoney,mission.carryOverCap);
      if(side==='gdi'&&number===7&&carry.sabotaged){
        const index=mission.scenario.buildings.findIndex(building=>building.house!==mission.player&&building.type===carry.sabotaged);
        if(index>=0){mission.scenario.buildings.splice(index,1);mission.objectTriggers.splice(mission.scenario.units.length+mission.scenario.infantry.length+index,1);}
        const node=mission.base.findIndex(node=>node.type===carry.sabotaged);if(node>=0)mission.base.splice(node,1);
      }
    }
    const files = assets.mission(side, mission.scenario.theater);
    let transitionMusic=false;
    if (!saved) {
      if (number !== 1 || side === 'gdi') await presentation.playMovie(mission.movies.intro, side);
      if (!options.restart && (number > 1 || side === 'nod')) await presentation.playMovie(mission.movies.brief, side, undefined, number !== 1);
      transitionMusic=await presentation.playMovie(mission.movies.action, side, mission.theme);
    }
    const data = await files;
    await options.progress('Preparing the battlefield');
    const world = campaignScene(data, mission);
    let runtime!: CampaignRuntime;
    const game = await startPreparedGame(renderer, canvas, data, { kind: 'combat', scene: world.scene, setup: world.setup, economy: world, decalStart: world.decalStart }, {
      createEconomy: battle => runtime = new CampaignRuntime(battle, world, mission), onProgress: options.progress, onOutcome: options.outcome, onOptions: options.options,
    });
    if (saved) { game.loadState({ ...saved.metadata.game, buffers: saved.buffers }); runtime.loadCampaign(saved.metadata.rules); game.setPaused(false); }
    else if(carry){
      runtime.supers.charges[0].nuke.spent=carry.nukeSpent;
      runtime.nukePieces[0]=carry.nukePieces??(carry.nukeSpent?0:7);
      if(carry.debug){game.setPaused(true);game.applyDebugState({...carry.debug,money:runtime.houses[0].economy.money});game.setPaused(false);}
    }
    if(!transitionMusic)presentation.beginMusic(mission.theme);
    return new CampaignSession(game, runtime, name, side, readBriefing(name, new TextDecoder('latin1').decode(ini), new TextDecoder('latin1').decode(data.get('MISSION.INI'))), carry);
  }
  async save() {
    const { buffers, ...game } = await this.game.saveState();
    const metadata: CampaignSave = { campaign: 'original', side: this.side, name: this.name, game, rules: this.runtime.saveCampaign(), carry: this.carry };
    return encodeSave({ metadata, buffers });
  }
  score() {
    const house = this.runtime.houses[0];
    let remaining = 0;
    // SCORE.CPP counts Logic objects; placed walls become overlays, not sentient buildings.
    for (let type = 0; type < this.runtime.inventory.length / this.runtime.houses.length; type++)
      if (!WALLS[MOVEMENT[type].name]) remaining += this.runtime.inventory[type];
    remaining = Math.max(1, remaining);
    const good = this.runtime.houses[this.side === 'gdi' ? 0 : 1];
    // SCORE.CPP uses GDI losses in this denominator even when the player is Nod.
    const leadership = Math.min(100, (100 * Math.trunc(remaining * 256 / (remaining + good.lost + good.buildingsLost)) + 128) >> 8);
    const fraction = Math.max(1, Math.trunc((house.economy.money + 1) * 256 / (house.economy.harvested + this.runtime.world.credits + 1)));
    const efficiency = Math.min(100, (100 * fraction + 128) >> 8);
    return { leadership, efficiency, total: Math.max(1, Math.trunc((leadership * 40 + 4600 + efficiency * 14) / 100)) * (this.runtime.mission.buildLevel + 1),
      minutes: Math.trunc(this.runtime.frame / 900) + 1, credits: house.economy.money,
      level: Number(this.name.slice(3, 5)), losses: this.runtime.houses.map(h => ({ units: h.lost, buildings: h.buildingsLost })) };
  }
  async nextCarry(): Promise<CampaignCarry> {
    const {money: _money,...debug}=await this.game.readDebugState();
    return {credits:this.runtime.houses[0].economy.credits,nukeSpent:this.runtime.supers.charges[0].nuke.spent,nukePieces:this.runtime.nukePieces[0],sabotaged:this.runtime.sabotaged,
      ...(debug.buildSpeed!==1||debug.gameSpeed!==1||debug.damageScale!==1000?{debug}:{})};
  }
  dispose() { this.game.dispose(); }
}
