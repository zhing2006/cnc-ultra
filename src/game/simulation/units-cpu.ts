// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { areAllied } from './alliances.ts';
import { CpuFlowFields, FIELD_WORDS } from '../../engine/simulation/flow.ts';
import { DIRECTIONS, UNREACHABLE } from '../../engine/simulation/state.ts';
import { checksum, randomWord } from '../../engine/simulation/fixed.ts';
import { desiredFacing256, dirFacing, distance, movePoint } from '../coord.ts';
import { MOVEMENT, GROUND_SPEED,movementType } from '../data/movement.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { combatTypes } from '../data/combat.ts';
import { TRACKS, TRACK_CONTROL, RAW_TRACKS } from '../data/tracks.ts';
import { INFANTRY_SPOTS } from './map.ts';
import { entryPoint, entrySpot, freeSpot } from './infantry-spots.ts';
import { cellFacing, pathDestination, reachablePrefix, PATH_DELAY } from './navigation.ts';
import * as S from './units-state.ts';
import { CpuCampaignRouting } from './campaign-routing.ts';
/** Ported from FACING.H, Difference, and FACING.CPP, Rotation_Adjust. */
export function rotateFacing(current: number, desired: number, rate: number) {
  const difference = ((desired - current + 128) & 255) - 128;
  return (current + Math.sign(difference) * Math.min(Math.abs(difference), Math.min(127, rate))) & 255;
}
export class CpuUnits {
  readonly routing?:CpuCampaignRouting;
  readonly units: Int32Array;
  readonly goals: Int32Array;
  /** Basic_Path's effective destination, separate from the player's NavCom. */
  readonly pathGoals: Int32Array;
  readonly occupancy: Int32Array;
  readonly flow: CpuFlowFields;
  private readonly shimmers=new Set<number>();
  frame = 0;
  constructor(readonly setup: S.UnitsSetup) {
    this.units = S.initialUnits(setup);
    this.goals = new Int32Array(setup.units.length).fill(-1);
    this.pathGoals = new Int32Array(setup.units.length).fill(-1);
    this.occupancy = new Int32Array(setup.grid.edges.length * 5);
    this.routing=setup.campaignRouting?new CpuCampaignRouting(setup,this.units,this.pathGoals):undefined;
    this.flow = new CpuFlowFields(setup.grid, setup.units.length,this.routing?.policy);
    this.occupy();
  }
  point(cell: number, slot = 0): [
    number,
    number
  ] {
    return [cell % this.setup.grid.width * 256 + INFANTRY_SPOTS[slot][0], Math.floor(cell / this.setup.grid.width) * 256 + INFANTRY_SPOTS[slot][1]];
  }
  occupy() {
    this.occupancy.fill(0);
    const u = this.units;
    // Buildings reserve their complete footprint before docked ground objects.
    for(let id=0;id<this.goals.length;id++){
      const at=id*S.WORDS;
      if(u[at+S.UHEALTH]<=0||u[at+S.UDOMAIN]!==2)continue;
      for(const [x,y] of BUILDINGS.get(MOVEMENT[u[at+S.UTYPE]].name)!.occupy){
        const cell=u[at+S.UORIGIN]+y*this.setup.grid.width+x;
        for(let slot=0;slot<5;slot++)this.occupancy[cell*5+slot]=id+1;
      }
    }
    // UNIT.CPP, Can_Enter_Cell: a vehicle reserving a crushable cell still blocks
    // another vehicle. Keep its reservation even while enemy infantry remain alive.
    for (const infantry of [true, false]) for (let id = 0; id < this.goals.length; id++) {
      const at = id * S.WORDS;
        if (u[at + S.UHEALTH] <= 0 || u[at + S.UATTACHED] || u[at+S.UDOMAIN]===2 || !!u[at + S.UKIND] !== infantry || u[at + S.UDOMAIN] === 1 && (u[at + S.UALTITUDE] >= 16||u[at+S.UTYPE]===movementType('C17')||u[at+S.UTYPE]===movementType('A10'))) continue;
      for (const offset of [S.UCELL, S.UDEST, S.UMIDDLE]) {
        // INFANTRY.CPP, Start_Driver releases the old spot when reserving headto.
        if (offset === S.UCELL && u[at + S.UKIND] && u[at + S.UDEST] >= 0) continue;
        const cell = u[at + offset];
        if (cell < 0)
          continue;
        const slot = u[at + (offset === S.UCELL ? S.USLOT : S.UDSLOT)];
        for (let j = 0; j < 5; j++)
          if (!u[at + S.UKIND] || slot === j)
            this.occupancy[cell * 5 + j] = id + 1;
      }
    }
  }
  private free(cell: number, id: number) {
    const at = id * S.WORDS;
    // UNIT.CPP Can_Enter_Cell: the scripted gunboat patrol always permits entry.
    if (this.units[at + S.UTYPE] === movementType('BOAT')) return 0;
    const infantry = this.units[at + S.UKIND];
    let mask = 0;
    for (let slot = 0; slot < 5; slot++) {
      const owner = this.occupancy[cell * 5 + slot];
      const other = (owner - 1) * S.WORDS;
      const crushable = owner > 0 && combatTypes[this.units[at + S.UTYPE]].crusher &&
        this.units[other + S.UKIND] && !areAllied(this.setup, this.units[at + S.UOWNER], this.units[other + S.UOWNER]);
      if (owner && !crushable && !areAllied(this.setup, this.units[at + S.UOWNER], this.units[other + S.UOWNER])) return -1;
      if (!owner || owner === id + 1 || crushable)
        mask |= 1 << slot;
    }
    return infantry ? freeSpot(mask, entrySpot(this.units[at], this.units[at + 1], ...this.point(cell)), randomWord(this.setup.seed, this.frame, id, 2) % 4) : mask === 31 ? 0 : -1;
  }
  private neighbor(cell: number, dir: number) {
    return this.setup.grid.edges[cell] & (1 << dir) ? cell + DIRECTIONS[dir][1] * this.setup.grid.width + DIRECTIONS[dir][0] : -1;
  }
  private next(cell: number, goal: number,id:number) {
    const field = goal < 0 ? -1 : this.flow.lookup[this.routing?.key(id,goal)??goal];
    if(field<0||!this.flow.fields[field*FIELD_WORDS+1])return -1;
    const cells=this.setup.grid.edges.length,value=this.flow.next[field*cells+cell];return value>=cells?value-cells:value;
  }
  private overrun(at: number) {
    if (this.units[at + S.UKIND]) return;
    this.units[at + S.UOVERRUN_CELL] = Math.floor(this.units[at + 1] / 256) * this.setup.grid.width + Math.floor(this.units[at] / 256);
    this.units[at + S.UOVERRUN_X] = this.units[at];
    this.units[at + S.UOVERRUN_Y] = this.units[at + 1];
  }
  /** Ported from DRIVE.CPP, Smooth_Turn and While_Moving; INFANTRY.CPP, AI. */
  private advance(id: number, addSpeed = true) {
    const u = this.units;
    const at = id * S.WORDS;
    const type = MOVEMENT[u[at + S.UTYPE]];
    if (u[at + S.UDEST] < 0)
      return;
    if (type.infantry) {
      u[at + S.UWALK]++;
      if (distance(u[at], u[at + 1], u[at + S.UHEAD_X], u[at + S.UHEAD_Y]) < 16)
        this.arrive(id);
      else {
        const dir = desiredFacing256(u[at], u[at + 1], u[at + S.UHEAD_X], u[at + S.UHEAD_Y]);
        [u[at], u[at + 1]] = movePoint(u[at], u[at + 1], dir, (type.speed * (u[at + S.USPEED] || 255) + 128) >> 8);
      }
      return;
    }
    // Ported from COORDA.ASM, Fixed_To_Cardinal: round before converting to leptons.
    let actual = u[at + S.UACCUM] + (addSpeed ? ((type.speed * u[at + S.USPEED] + 128) >> 8) : 0);
    const control = TRACK_CONTROL[u[at + S.UTRACK]];
    const track = TRACKS[control[0]];
    // DISPLAY.H defines PIXEL_LEPTON_W as integer 256 / 24, independently of track offsets.
    while (actual > 10) {
      actual -= 10;
      const step = u[at + S.UTRACK_STEP];
      const point = track[step];
      if ((!point[0] && !point[1]) && step) {
        this.arrive(id);
        actual = 0;
        break;
      }
      let [x, y, dir] = point;
      if (control[3] & 1) {
        [x, y] = [y, x];
        dir = 192 - dir;
      }
      if (control[3] & 2) {
        x = -x;
        dir = -dir;
      }
      if (control[3] & 4) {
        y = -y;
        dir = 128 - dir;
      }
      u[at] = u[at + S.UHEAD_X] + x;
      u[at + 1] = u[at + S.UHEAD_Y] + y;
      u[at + S.UFACE] = u[at + S.UDESIRED] = dir & 255;
      u[at + S.UTRACK_STEP]++;
      if (step === RAW_TRACKS[control[0]][2]) {
        // DRIVE.CPP, While_Moving / Per_Cell_Process(false): release the cell behind the curve.
        u[at + S.UCELL] = Math.floor(u[at + 1] / 256) * this.setup.grid.width + Math.floor(u[at] / 256);
        this.overrun(at);
      }
      // Ported from DRIVE.CPP, While_Moving: reserve the next cell before changing tracks.
      if (step === RAW_TRACKS[control[0]][0]) {
        const following = this.next(u[at + S.UDEST], this.pathGoals[id],id);
        if (following >= 0) {
          const face = dirFacing(desiredFacing256(...this.point(u[at + S.UDEST]), ...this.point(following)));
          const candidate = dirFacing(control[2]) * 8 + face;
          const raw = TRACK_CONTROL[candidate][0];
          if (face !== dirFacing(control[2]) && raw >= 0 && RAW_TRACKS[raw][1]) {
            u[at + S.UJUMP] = following;
            u[at + S.UJUMP_TRACK] = candidate;
            break;
          }
        }
      }
    }
    u[at + S.UACCUM] = actual;
  }
  private arrive(id: number) {
    const u = this.units;
    const at = id * S.WORDS;
    // Ported from FOOT.CPP, Per_Cell_Process: the first arrival ends unloading.
    u[at + S.UFLAGS] &= ~S.UNLOADING;
    u[at] = u[at + S.UHEAD_X];
    u[at + 1] = u[at + S.UHEAD_Y];
    u[at + S.UCELL] = u[at + S.UDEST];
    this.overrun(at);
    u[at + S.USLOT] = u[at + S.UDSLOT];
    u[at + S.UDEST] = -1;
    u[at + S.UMIDDLE] = -1;
    u[at + S.UTRACK] = -1;
    u[at + S.UTRACK_STEP] = 0;
    u[at + S.UWALK] = 0;
    if (this.goals[id] === u[at + S.UCELL])
      this.goals[id] = -1;
    if (this.pathGoals[id] === u[at + S.UCELL]) this.pathGoals[id] = -1;
  }
  scatter(id: number, facing?: number) {
    const at = id * S.WORDS;
    const cell = this.units[at + S.UCELL];
    let start = facing ?? dirFacing(this.units[at + S.UFACE]);
    if (this.units[at + S.UKIND]) {
      const x = this.units[at] % 256;
      const y = this.units[at + 1] % 256;
      if (facing === undefined && (x !== 128 || y !== 128))
        start = dirFacing(desiredFacing256(128, 128, x, y));
      start = (start + randomWord(this.setup.seed, this.frame, id, 1) % 5 + 6) & 7;
    }
    // Ported from UNIT.CPP / INFANTRY.CPP, Scatter: choose a free adjacent cell.
    let destination=-1;
    for (let i = 0; i < 8; i++) {
      const other = this.neighbor(cell, (start + i) & 7);
      if (other >= 0 && this.free(other, id) >= 0)
        this.goals[id] = destination = other;
    }
    this.units[at + S.UROUTE] = -1;
    this.units[at + S.USTALLED] = 0;
    this.pathGoals[id] = -1;
    if(destination>=0)this.units[at+S.USCATTER_GOAL]=destination+1;
    return destination;
  }
  /** UNIT.CPP / INFANTRY.CPP Can_Enter_Cell: opposing occupiers are MOVE_DESTROYABLE. */
  private recordObstruction(id:number,cell:number){
    const u=this.units,at=id*S.WORDS;
    for(let slot=0;slot<5;slot++){
      const occupant=this.occupancy[cell*5+slot],other=(occupant-1)*S.WORDS;
      if(occupant&&!areAllied(this.setup, u[at+S.UOWNER], u[other+S.UOWNER])&&!(combatTypes[u[at+S.UTYPE]].crusher&&u[other+S.UKIND])){
        // MOVE_CLOAK is a contact, not a request to attack an invisible blocker.
        if(u[other+S.UCLOAK]===2)this.shimmers.add(occupant-1);
        else{u[at+S.UOBSTRUCTION]=occupant;u[at+S.UOBSTRUCTION_GOAL]=this.goals[id];}
        return;
      }
    }
  }
  /** Ported from DRIVE.CPP, Start_Of_Move, and INFANTRY.CPP, AI; FOOT.H PATH_RETRY/PATH_DELAY. */
  private failedPath(id: number) {
    const at = id * S.WORDS;
    this.units[at + S.UWAIT] = PATH_DELAY;
    if (this.units[at + S.URETRIES] === 0 || distance(this.units[at], this.units[at + 1], ...this.point(this.goals[id])) < 0x280)
      this.goals[id] = -1;
    else
      this.units[at + S.URETRIES]--;
  }
  /** Ported from DRIVE.CPP, Start_Of_Move; INFANTRY.CPP, AI; UNIT.CPP, Can_Enter_Cell. */
  step(commands: readonly S.UnitCommand[] = []) {
    this.frame++;this.shimmers.clear();
    for (let id = 0; id < this.goals.length; id++) {
      if (this.goals[id] < 0 || this.units[id*S.WORDS+S.UDOMAIN]) this.pathGoals[id] = -1;
      else if (this.pathGoals[id] === -1) this.pathGoals[id] = pathDestination(this.setup, this.units, this.occupancy, id, this.goals[id]);
    }
    this.routing?.step(this.flow);
    this.flow.step(this.routing?.goals??this.pathGoals);
    const u = this.units;
    const rotated = new Uint8Array(this.goals.length);
    const wasDriving = new Uint8Array(this.goals.length);
    const prefixPending=new Uint8Array(this.goals.length),prefixFailed=new Uint8Array(this.goals.length),cells=this.setup.grid.edges.length;
    for (let id = 0; id < this.goals.length; id++) {
      const at = id * S.WORDS;
      const type = MOVEMENT[u[at + S.UTYPE]];
      u[at + S.UOVERRUN_CELL] = -1;
      u[at + S.UOBSTRUCTION] = 0;
      u[at + S.UJUMP] = -1;
      u[at + S.UJUMP_TRACK] = -1;
      if (u[at + S.UDOMAIN]) continue;
      if (u[at + S.UWAIT] > 0)
        u[at + S.UWAIT]--;
      wasDriving[id] = u[at + S.UDEST] >= 0 ? 1 : 0;
      if (wasDriving[id])
        this.advance(id);
      else if (u[at + S.UFACE] !== u[at + S.UDESIRED] && !(type.name==='APC'&&u[at+S.UDOOR])) {
        u[at + S.UFACE] = rotateFacing(u[at + S.UFACE], u[at + S.UDESIRED], type.rotation);
        rotated[id] = 1;
        if (!u[at + S.UROTATED])
          u[at + S.UROTATED] = this.frame;
      }
    }
    this.occupy();
    for(let id=0;id<this.goals.length;id++){
      const at=id*S.WORDS,goal=this.goals[id],path=this.pathGoals[id],source=u[at+S.UCELL],key=this.routing?.key(id,path)??path,field=path<0?-1:this.flow.lookup[key];
      if(goal<0||u[at+S.UHEALTH]<=0||u[at+S.UATTACHED]||u[at+S.UDOMAIN]||u[at+S.UDEST]>=0||u[at+S.UWAIT]||field<0||!this.flow.fields[field*FIELD_WORDS+1])continue;
      if(key>=cells&&this.flow.distance[field*cells+source]===UNREACHABLE){prefixPending[id]=1;}
      else if(path===source&&goal!==source){
        const prefix=reachablePrefix(this.setup,source,goal,this.flow.distance,field*cells);
        if(prefix>=0){this.pathGoals[id]=prefix;prefixPending[id]=1;}else{this.pathGoals[id]=-1;prefixFailed[id]=1;}
      }else if(this.flow.distance[field*cells+source]===UNREACHABLE){
        // Probe the source region using the same bounded field cache; no CPU map readback is needed on the GPU.
        this.pathGoals[id]=source;prefixPending[id]=1;
      }
    }
    const proposals: {
      id: number;
      cell: number;
      middle: number;
      slot: number;
      track: number;
      jump: boolean;
      approach?: number;
    }[] = [];
    const previousGoals = this.goals.slice();
    const claims = new Int32Array(this.occupancy.length).fill(0x7fffffff);
    const scatter = new Set<number>();
    for (let id = 0; id < this.goals.length; id++) {
      const at = id * S.WORDS;
      const goal = this.goals[id];
      const type = MOVEMENT[u[at + S.UTYPE]];
      if (u[at + S.UHEALTH] <= 0 || u[at + S.UATTACHED] || u[at + S.UDOMAIN]) continue;
      if (u[at + S.UJUMP] >= 0) {
        const cell = u[at + S.UJUMP];
        if (this.free(cell, id) >= 0) {
          proposals.push({ id, cell, middle: -1, slot: 0, track: u[at + S.UJUMP_TRACK], jump: true });
          for (let slot = 0; slot < 5; slot++)
            claims[cell * 5 + slot] = Math.min(claims[cell * 5 + slot], id);
        }else this.recordObstruction(id,cell);
        continue;
      }
      if (prefixPending[id] || goal < 0 || (type.name==='APC'&&u[at+S.UDOOR]) || rotated[id] || u[at + S.UDEST] >= 0 || u[at + S.UWAIT] || (type.infantry && wasDriving[id]))
        continue;
      const field = prefixFailed[id]?this.flow.lookup[u[at+S.UCELL]]:this.pathGoals[id] < 0 ? -1 : this.flow.lookup[this.routing?.key(id,this.pathGoals[id])??this.pathGoals[id]];
      const direct=this.pathGoals[id]===S.DIRECT_STEP;
      if (!direct && (field < 0 || !this.flow.fields[field * FIELD_WORDS + 1])) continue;
      let cell = direct ? goal : u[at + S.UROUTE] >= 0 ? u[at + S.UROUTE] : this.next(u[at + S.UCELL], this.pathGoals[id],id);
      if (cell < 0) {
        if (field >= 0 && this.flow.fields[field * FIELD_WORDS + 1]){
          const source=u[at+S.UCELL];
          if(goal!==source){const [dx,dy]=DIRECTIONS[cellFacing(source,goal,this.setup.grid.width)];this.recordObstruction(id,source+dy*this.setup.grid.width+dx);}
          this.failedPath(id);
        }
        continue;
      }
      const from = this.point(u[at + S.UCELL]);
      const to = this.point(cell);
      const dir = dirFacing(desiredFacing256(...from, ...to));
      if (!type.infantry && u[at + S.UFACE] !== dir * 32) {
        u[at + S.UDESIRED] = dir * 32;
        u[at + S.UACCUM] = 0;
        continue;
      }
      let slot = this.free(cell, id);
      let middle = -1;
      let track = dir * 8 + dir;
      if (slot < 0) {
        this.recordObstruction(id,cell);
        const blockers = new Set(Array.from(this.occupancy.subarray(cell * 5, cell * 5 + 5)).filter(x => x && x !== id + 1));
        // Ported from UNIT.CPP, Can_Enter_Cell: nearby opposing traffic returns MOVE_NO.
        const headOn = Array.from(blockers).some(x => {
          const other = (x - 1) * S.WORDS;
          return areAllied(this.setup, u[at + S.UOWNER], u[other + S.UOWNER]) && previousGoals[x - 1] >= 0 &&
            dirFacing(u[at + S.UFACE]) === (dirFacing(u[other + S.UFACE]) ^ 4) && distance(u[at], u[at + 1], u[other], u[other + 1]) <= 0x1ff;
        });
        const moving = !headOn && Array.from(blockers).some(x => u[(x - 1) * S.WORDS + S.UDEST] >= 0 || previousGoals[x - 1] >= 0);
        if (distance(u[at], u[at + 1], ...this.point(goal)) < 512) {
          this.goals[id] = -1;
          continue;
        }
        if (moving) {
          // Replan a flow route after a full path-delay interval without progress.
          u[at + S.USTALLED] = Math.min(PATH_DELAY, u[at + S.USTALLED] + 1);
          if (u[at + S.USTALLED] < PATH_DELAY) continue;
        }
        // DRIVE.CPP, Start_Of_Move: MOVE_TEMP asks stationary allies to scatter.
        // It must not become an endless series of successful detours around them.
        if (!moving && !headOn) {
          for (const blocker of blockers)
            if (areAllied(this.setup, u[at + S.UOWNER], u[(blocker - 1) * S.WORDS + S.UOWNER])) scatter.add(blocker - 1);
          u[at + S.UROUTE] = -1;
          this.failedPath(id);
          continue;
        }
        const base = field * this.setup.grid.edges.length;
        let alternative = -1;
        let best = 0x7fffffff;
        for (let d = 0; d < 8; d++) {
          const other = this.neighbor(u[at + S.UCELL], d);
          // A one-step detour must make progress in the shared distance field.
          // Otherwise its reverse is equally eligible on the next tick.
          if (other < 0 || this.free(other, id) < 0 || this.flow.next[base+other]>=cells || this.flow.distance[base + other] >= this.flow.distance[base + u[at + S.UCELL]])
            continue;
          const cost = this.flow.distance[base + other] + (d & 1 ? 362 : 256);
          if (cost < best) {
            best = cost;
            alternative = other;
          }
        }
        if (alternative < 0) {
          u[at + S.UROUTE] = -1;
          if (headOn) this.failedPath(id);
          else u[at + S.UWAIT] = PATH_DELAY;
          continue;
        }
        cell = alternative;
        slot = this.free(cell, id);
        u[at + S.UROUTE] = cell;
        const face = dirFacing(desiredFacing256(...from, ...this.point(cell)));
        track = face * 8 + face;
        if (!type.infantry && u[at + S.UFACE] !== face * 32) {
          u[at + S.UDESIRED] = face * 32;
          continue;
        }
      }
      else if (!type.infantry) {
        const following = this.next(cell, this.pathGoals[id],id);
        if (following >= 0) {
          const nextdir = dirFacing(desiredFacing256(...to, ...this.point(following)));
          const candidate = dir * 8 + nextdir;
          if (TRACK_CONTROL[candidate][0] >= 0 && (TRACK_CONTROL[candidate][3] & 8)) {
            if (this.free(following, id) >= 0) {
              middle = cell;
              cell = following;
              track = candidate;
            }
          }
        }
      }
      proposals.push({ id, cell, middle, slot, track, jump: false });
      if (!type.infantry)
        for (const c of [cell, middle])
          if (c >= 0)
            for (let s = 0; s < 5; s++)
              claims[c * 5 + s] = Math.min(claims[c * 5 + s], id);
    }
    // Closest_Free_Spot queries the approach cell, but masks the backed-up
    // coordinate to choose the physical stopping cell (which may be the source).
    for (const p of proposals) if (u[p.id * S.WORDS + S.UKIND]) {
      const at = p.id * S.WORDS;
      const head = entryPoint(u[at], u[at + 1], ...this.point(p.cell));
      p.approach = p.cell;
      p.cell = Math.floor(head[1] / 256) * this.setup.grid.width + Math.floor(head[0] / 256);
      p.slot = -1;
    }
    // Reserve departures first, then reuse their vacated spots for short steps
    // within the source cell. Both stages belong to the same logical tick.
    for (let pass = 0; pass < 2; pass++) {
      for (const p of proposals) if (p.cell >= 0 && p.approach !== undefined && (pass || p.cell !== u[p.id * S.WORDS + S.UCELL])) {
        let mask = 0, hostile = false;
        const at = p.id * S.WORDS;
        for (let slot = 0; slot < 5; slot++) {
          const owner = this.occupancy[p.cell * 5 + slot], queried = this.occupancy[p.approach * 5 + slot];
          const claim = claims[p.cell * 5 + slot];
          if(owner&&!areAllied(this.setup, u[at+S.UOWNER], u[(owner-1)*S.WORDS+S.UOWNER])||queried&&!areAllied(this.setup, u[at+S.UOWNER], u[(queried-1)*S.WORDS+S.UOWNER])||
            claim<p.id&&!areAllied(this.setup, u[at+S.UOWNER], u[claim*S.WORDS+S.UOWNER]))hostile=true;
          const progress = distance(...this.point(p.cell, slot), ...this.point(p.approach)) < distance(u[at], u[at + 1], ...this.point(p.approach));
          if (progress && (!owner || owner === p.id + 1) && (!queried || queried === p.id + 1) && claims[p.cell * 5 + slot] > p.id)
            mask |= 1 << slot;
        }
        p.slot = freeSpot(hostile ? 0 : mask, entrySpot(u[at], u[at + 1], ...this.point(p.approach)), randomWord(this.setup.seed, this.frame, p.id, 2) % 4);
        if (p.slot >= 0)
          claims[p.cell * 5 + p.slot] = p.id;
      }
      for (const p of proposals) {
        const at = p.id * S.WORDS;
        const type = MOVEMENT[u[at + S.UTYPE]];
        if (p.cell < 0 || p.slot < 0)
          continue;
        if ([p.cell, p.middle].some(c => c >= 0 && [0, 1, 2, 3, 4].some(s => (!type.infantry || s === p.slot) && claims[c * 5 + s] !== p.id)))
          continue;
        if (p.jump) {
          u[at + S.UMIDDLE] = u[at + S.UDEST];
          u[at + S.UDEST] = p.cell;
          u[at + S.UTRACK] = p.track;
          u[at + S.UCELL] = Math.floor(u[at + 1] / 256) * this.setup.grid.width + Math.floor(u[at] / 256);
          u[at + S.UTRACK_STEP] = RAW_TRACKS[TRACK_CONTROL[p.track][0]][1];
          [u[at + S.UHEAD_X], u[at + S.UHEAD_Y]] = this.point(p.cell);
          p.cell = -1;
          continue;
        }
        // Ported from DRIVE.CPP, Start_Of_Move; INFANTRY.CPP, Start_Driver.
        u[at + S.UROUTE] = p.approach !== undefined && p.cell !== p.approach ? p.approach : -1;
        u[at + S.USTALLED] = 0;
        u[at + S.URETRIES] = 10;
        u[at + S.UDEST] = p.cell;
        u[at + S.UMIDDLE] = p.middle;
        u[at + S.UDSLOT] = p.slot;
        u[at + S.UTRACK] = p.track;
        u[at + S.UTRACK_STEP] = 0;
        [u[at + S.UHEAD_X], u[at + S.UHEAD_Y]] = this.point(p.cell, p.slot);
        if (!u[at + S.USTARTED])
          u[at + S.USTARTED] = this.frame;
        if (type.infantry) {
          u[at + S.UFACE] = u[at + S.UDESIRED] = dirFacing(desiredFacing256(u[at], u[at + 1], u[at + S.UHEAD_X], u[at + S.UHEAD_Y])) * 32;
          u[at + S.UWALK] = 0;
        }
        else {
          let speed = GROUND_SPEED[this.setup.land[p.middle < 0 ? p.cell : p.middle]][type.locomotion];
          if (type.name === 'BOAT') speed = 255;
          if (u[at + S.UHEALTH] < (type.strength >> 1))
            speed -= speed >> 2;
          u[at + S.USPEED] = speed;
          this.advance(p.id);
        }
        p.cell = -1;
      }
      if (!pass) {
        this.occupy();
        claims.fill(0x7fffffff);
      }
    }
    for (const p of proposals) if (p.cell >= 0 && p.approach !== undefined) {
      // A failed subcell reservation is not a successful zero-length path.
      const at = p.id * S.WORDS;
      let moving = false;
      for (const cell of [p.cell, p.approach]) for (let slot = 0; slot < 5; slot++) {
        const owner = this.occupancy[cell * 5 + slot] - 1;
        if (owner < 0 || owner === p.id) continue;
        if (previousGoals[owner] >= 0) moving = true;
        else if (areAllied(this.setup, u[at + S.UOWNER], u[owner * S.WORDS + S.UOWNER])) scatter.add(owner);
      }
      if (moving && distance(u[at], u[at + 1], ...this.point(this.goals[p.id])) >= 0x280) u[at + S.UWAIT] = PATH_DELAY;
      else this.failedPath(p.id);
    }
    for (let id = 0; id < this.goals.length; id++)
      if (u[id * S.WORDS + S.UJUMP] >= 0) {
        this.advance(id, false);
        u[id * S.WORDS + S.UJUMP] = -1;
        u[id * S.WORDS + S.UJUMP_TRACK] = -1;
      }
    this.occupy();
    for(const id of this.shimmers){
      const at=id*S.WORDS;
      if(u[at+S.UHEALTH]>0&&u[at+S.UCLOAK]===2){u[at+S.UCLOAK]=1;u[at+S.UCLOAK_STAGE]=19;}
    }
    for (const id of scatter)
      if (this.goals[id] < 0)
        this.scatter(id);
    // Ported from CONQUER.CPP, Main_Loop / QUEUE.CPP, Queue_AI_Normal: commands execute after Logic.AI.
    for (const command of commands) {
      if (command.frame !== this.frame)
        throw new Error('Commands must be submitted on their recorded tick');
      for (let id = 0; id < this.goals.length; id++)
        if (command.ids.includes(id)) {
          const at = id * S.WORDS;
          if (u[at + S.UHEALTH] <= 0)
            continue;
          u[at+S.UOBSTRUCTION]=0;
          if(u[at+S.UDOMAIN]===0)u[at+S.UFLAGS]|=S.PLAYER_ORDER;
          if (command.kind === 'scatter')
            this.scatter(id);
          else {
            u[at+S.USCATTER_GOAL]=0;
            this.goals[id] = command.kind === 'stop' ? -1 : command.target!;
            this.pathGoals[id] = -1;
            u[at + S.USTALLED] = 0;
            u[at + S.UROUTE] = -1;
            u[at + S.UWAIT] = 0;
            u[at + S.URETRIES] = 10;
            u[at + S.USTARTED] = 0;
            u[at + S.UROTATED] = 0;
          }
        }
    }
  }
  buffers() {
    return [new Int32Array([this.frame, this.setup.seed]), this.units, this.goals, this.occupancy, ...this.flow.buffers(), this.pathGoals,...(this.routing?[this.routing.layout.data,this.routing.goals]:[])];
  }
  checksum() {
    return checksum(this.buffers());
  }
}
