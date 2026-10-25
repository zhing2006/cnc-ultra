import type { CampaignTrigger } from './scenario.ts';

export interface TriggerState { remaining: number; active: boolean; attachments: number; persistence: number }
export type TriggerContext = { kind: 'house'; house: string } | { kind: 'object'; id: number; house: string } | { kind: 'cell'; cell: number; house: string };
export interface TriggerHouse {
  name: string; buildings: number; units: number; factories: number; credits: number;
  buildingsLost: number; unitsLost: number; discovered: boolean;
  justBuilt?: number; evacuated?: boolean;
}

/** Ported from TRIGGER.CPP Spring and HOUSE.CPP AI. The host applies actions to the simulation. */
export class CampaignTriggers {
  readonly state: TriggerState[];
  readonly objects = new Map<number, number>();
  readonly cells = new Map<number, number>();
  nextTime = 1;
  constructor(readonly definitions: readonly CampaignTrigger[], private readonly execute: (trigger: CampaignTrigger, event: string, context: TriggerContext) => boolean,
    attachments?: { objects: readonly string[]; cells: ReadonlyMap<number, string> }, private readonly removed?: (trigger: CampaignTrigger) => void) {
    this.state = definitions.map(trigger => ({ remaining: trigger.data, active: true, persistence: trigger.persistence, attachments: trigger.house === 'None' ? 0 : 1 }));
    const attach = (references: Map<number, number>, key: number, name: string) => {
      const index = definitions.findIndex(trigger => trigger.name === name);
      if (index >= 0) { references.set(key, index); this.state[index].attachments++; }
    };
    attachments?.objects.forEach((name, id) => attach(this.objects, id, name));
    attachments?.cells.forEach((name, cell) => attach(this.cells, cell, name));
  }
  remove(name: string) {
    const index = this.definitions.findIndex(trigger => trigger.name === name.toUpperCase());
    if (index < 0 || !this.state[index].active) return;
    this.state[index].active = false;
    for (const references of [this.objects, this.cells]) for (const [key, value] of references) if (value === index) references.delete(key);
    this.removed?.(this.definitions[index]);
  }
  object(id: number, event: string, house: string) {
    const index = this.objects.get(id);
    return index !== undefined && this.spring(index, event, 0, { kind: 'object', id, house });
  }
  attachObject(id: number, name: string) {
    const index=this.definitions.findIndex(trigger=>trigger.name===name);
    if(index>=0&&this.state[index].active)this.objects.set(id,index);
  }
  cell(cell: number, house: string) {
    const index = this.cells.get(cell);
    return index !== undefined && this.definitions[index].house === house && this.spring(index, 'Player Enters', 0, { kind: 'cell', cell, house });
  }
  spring(index: number, event: string, data = 0, context: TriggerContext = { kind: 'house', house: this.definitions[index].house }) {
    const trigger = this.definitions[index], state = this.state[index];
    if (!state.active || trigger.event !== event && !(context.kind === 'object' && trigger.event === 'Any')) return false;
    if (context.kind === 'house' && context.house !== trigger.house) return false;
    if (['Credits', '# Bldgs Dstr.', '# Units Dstr.'].includes(event) && data < trigger.data) return false;
    if (event === 'Built It' && data !== trigger.data) return false;
    if (event === 'Time') {
      if (--state.remaining > 0) return false;
      state.remaining = trigger.data;
    }
    if (context.kind !== 'house' && state.persistence === 1) {
      if (context.kind === 'object') this.objects.delete(context.id); else this.cells.delete(context.cell);
      if (--state.attachments > 0) return false;
      state.persistence = 0;
    }
    const success = this.execute(trigger, event, context);
    if (success && state.persistence === 0) this.remove(trigger.name);
    else if (!success && event === 'Time') state.remaining = 1;
    return true;
  }
  tick(frame: number, houses: readonly TriggerHouse[]) {
    const timed = frame >= this.nextTime;
    if (timed) this.nextTime = frame + 90;
    // Houses own trigger lists; retain map-file order within each house.
    for (const house of houses) for (let index = 0; index < this.definitions.length; index++) {
      const trigger = this.definitions[index];
      if (!this.state[index].active || trigger.house !== house.name) continue;
      if (house.justBuilt !== undefined && this.spring(index, 'Built It', house.justBuilt)) { house.justBuilt = undefined; continue; }
      if (house.evacuated && this.spring(index, 'Civ. Evac.')) continue;
      if (this.spring(index, '# Bldgs Dstr.', house.buildingsLost) || this.spring(index, '# Units Dstr.', house.unitsLost)) continue;
      if (house.discovered && this.spring(index, 'House Discov.')) { house.discovered = false; continue; }
      if (frame > 450) {
        if (!house.buildings && this.spring(index, 'Bldgs Destr.')) continue;
        if (!house.units && this.spring(index, 'Units Destr.')) continue;
        if (!house.buildings && !house.units && this.spring(index, 'All Destr.')) continue;
      }
      if (this.spring(index, 'Credits', house.credits)) continue;
      if (timed && this.spring(index, 'Time')) continue;
      if (!house.factories) this.spring(index, 'No Factories');
    }
  }
}
