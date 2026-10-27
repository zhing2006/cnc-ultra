// Copyright 2025 Electronic Arts Inc. Licensed under GPL-3.0-or-later; see LICENSE.
import { areAllied } from './alliances.ts';
import { CpuUltraHunt } from './ultra-hunt.ts';
import { targetOrder } from './target-order.ts';
import { combatTypes, weapons, bullets, warheads,modifyDamage, ANIMATION_IDS } from '../data/combat.ts';
import { MOVEMENT, GROUND_SPEED } from '../data/movement.ts';
import { BUILDINGS } from '../data/buildings.ts';
import { WALLS } from '../data/overlays.ts';
import { attackRoute } from './attack-route.ts';
import { PATH_DELAY } from './navigation.ts';
import { distance, desiredFacing256, dirFacing, movePoint } from '../coord.ts';
import { randomWord } from '../../engine/simulation/fixed.ts';
import { CpuUnits, rotateFacing } from './units-cpu.ts';
import * as U from './units-state.ts';
import { prepareSpecialInfantry, finishSpecialInfantry } from './special-cpu.ts';
import { canCaptureBuilding } from '../data/abilities.ts';
import { advanceCloak, cloakContacts, uncloakUnit } from './cloak-cpu.ts';
import * as C from './combat-state.ts';
import { CpuSight } from './sight.ts';
import { DAMAGE_SCALE, scaleIncomingDamage } from '../debug.ts';
/** Ported from TURRET.CPP, Fire_Coord. Offsets are leptons, before projectile physics. */
export function firePoint(name: string, x: number, y: number, direction: number, second: number, weapon = 0, target?:readonly[number,number]): [
  number,
  number
] {
  let forward = 0, lateral = 0;
  if(BUILDINGS.has(name)){
    if(name==='OBLI')return [x-24,y-168];
    y-=48;
    if(name==='SAM'||name==='GUN')return movePoint(x,y,direction,128);
    return target?movePoint(x,y,desiredFacing256(x,y,...target),64):[x,y];
  }
  // INFANTRY.CPP, Fire_Coord: XYP_COORD(0,-5), except the flame thrower.
  if (MOVEMENT.find(t => t.name === name)?.infantry && name !== 'E4')
    y -= 53;
  if (name === 'ARTY') {
    [x, y] = movePoint(x, y, 0, 64);
    forward = 96;
  }
  if (name === 'FTNK') {
    forward = 48;
    lateral = 32;
  }
  if (name === 'HTNK') {
    [x, y] = movePoint(x, y, 0, 64);
    forward = weapon ? 8 : 192;
    lateral = weapon ? 64 : 40;
  }
  if (name === 'LTNK') {
    [x, y] = movePoint(x, y, 0, 32);
    forward = 192;
  }
  if (name === 'MTNK') {
    [x, y] = movePoint(x, y, 0, 48);
    forward = 192;
  }
  if (['APC', 'JEEP', 'BGGY'].includes(name)) {
    [x, y] = movePoint(x, y, 0, 48);
    forward = 48;
  }
  if (lateral)
    [x, y] = movePoint(x, y, direction + (second ? 64 : 192), lateral);
  return movePoint(x, y, direction, forward);
}
export class CpuCombat {
  readonly ultraHunt?: CpuUltraHunt;
  private targetCells?: Int32Array[];
  private aircraftTargets?: number[];
  private indexTargets() {
    const cells=this.setup.grid.edges.length;
    let factions=this.setup.houseCount??2;
    for(let at=0;at<this.units.length;at+=U.WORDS)factions=Math.max(factions,this.units[at+U.UOWNER]+1);
    this.targetCells=Array.from({length:factions},()=>new Int32Array(cells).fill(-1));this.aircraftTargets=[];
    for(let id=0;id<this.setup.units.length;id++){
      const at=id*U.WORDS;
      if(this.units[at+U.UHEALTH]<=0||this.units[at+U.UATTACHED])continue;
      if(this.units[at+U.UDOMAIN]===1)this.aircraftTargets.push(id);
      if(this.units[at+U.UDOMAIN]===1&&this.units[at+U.UALTITUDE]>0||WALLS[MOVEMENT[this.units[at+U.UTYPE]].name])continue;
      const cell=Math.trunc(this.units[at+1]/256)*this.setup.grid.width+Math.trunc(this.units[at]/256);
      for(let owner=0;owner<factions;owner++)if(!areAllied(this.setup,owner,this.units[at+U.UOWNER])&&this.targetCells[owner][cell]<0)this.targetCells[owner][cell]=id;
    }
  }
  humanOwner=0;
  debugDamageOwner=-1;
  debugDamageScale=DAMAGE_SCALE;
  scaleDamage(amount:number,owner:number){return scaleIncomingDamage(amount,owner,this.debugDamageOwner,this.debugDamageScale);}
  readonly movement: CpuUnits;
  readonly state: Int32Array;
  readonly projectiles: Int32Array;
  readonly sight: CpuSight;
  private readonly explosions: C.ExplosionCommand[] = [];
  queueExplosions(commands: readonly C.ExplosionCommand[]) { this.explosions.push(...commands); }
  constructor(readonly setup: C.CombatSetup) {
    this.movement = new CpuUnits(setup);
    this.sight = new CpuSight(setup.grid.width, setup.grid.height, setup.units.length, 0, setup.bounds);
    if(this.movement.routing)this.movement.routing.visible=this.sight.shadow;
    this.sight.step(this.movement.units);
    this.state = C.initialCombat(setup);
    this.projectiles = C.initialProjectiles(setup.units.length);
    if (setup.ultraHunt) this.ultraHunt = new CpuUltraHunt(this);
  }
  get frame() { return this.movement.frame; }
  get units() { return this.movement.units; }
  private buildingAt(cell:number){
    if(!this.setup.dynamicTypes&&!this.setup.units.some(unit=>MOVEMENT[unit.type].domain===2))return -1;
    for(let id=0;id<this.setup.units.length;id++){
      const at=id*U.WORDS;
      if(this.units[at+U.UDOMAIN]!==2||this.units[at+U.UHEALTH]<=0)continue;
      const origin=this.units[at+U.UORIGIN],building=BUILDINGS.get(MOVEMENT[this.units[at+U.UTYPE]].name)!;
      if(building.occupy.some(([x,y])=>origin+y*this.setup.grid.width+x===cell))return id;
    }return -1;
  }
  private point(target: number): [
    number,
    number
  ] {
    if (target >= 0)
      return [this.units[target * U.WORDS], this.units[target * U.WORDS + 1]-Math.trunc((this.units[target*U.WORDS+U.UALTITUDE]*256+12)/24)];
    const cell = -target - 2;
    return [cell % this.setup.grid.width * 256 + 128, Math.floor(cell / this.setup.grid.width) * 256 + 128];
  }
  private muzzle(id: number, which = 0) {
    const at = id * U.WORDS, c = id * C.CWORDS, type = combatTypes[this.units[at + U.UTYPE]];
    if(this.units[at+U.UDOMAIN]===2&&!['OBLI','GUN','SAM'].includes(type.name))return [this.state[c+C.CMUZZLEX],this.state[c+C.CMUZZLEY]] as [number,number];
    if(this.units[at+U.UDOMAIN]===1)return movePoint(this.units[at],this.units[at+1]-Math.trunc((this.units[at+U.UALTITUDE]*256+12)/24),this.units[at+U.UFACE],64);
    return firePoint(type.name, this.units[at], this.units[at + 1], type.turret&&this.units[at+U.UDOMAIN]!==2 ? this.state[c + C.CTURRET] : this.units[at + U.UFACE], this.state[c + C.CSECOND], which,
      this.state[c+C.CTARGET]!==-1?this.point(this.state[c+C.CTARGET]):undefined);
  }
  private updateBuildingMuzzles(){
    for(let id=0;id<this.setup.units.length;id++){
      const at=id*U.WORDS,c=id*C.CWORDS;
      if(this.units[at+U.UDOMAIN]!==2||this.units[at+U.UHEALTH]<=0)continue;
      const [x,y]=firePoint(MOVEMENT[this.units[at+U.UTYPE]].name,this.units[at],this.units[at+1],this.units[at+U.UFACE],0,0,
        this.state[c+C.CTARGET]!==-1?this.point(this.state[c+C.CTARGET]):undefined);
      this.state[c+C.CMUZZLEX]=x;this.state[c+C.CMUZZLEY]=y;
    }
  }
  private canTarget(id:number,target:number,weapon:number){
    if(target>=0&&this.units[target*U.WORDS+U.UCLOAK]===2)return false;
    if(weapon<0)return target>=0&&MOVEMENT[this.units[id*U.WORDS+U.UTYPE]].name==='E6'&&canCaptureBuilding(MOVEMENT[this.units[target*U.WORDS+U.UTYPE]].name,this.setup.campaignLevel);
    const air=target>=0&&this.units[target*U.WORDS+U.UDOMAIN]===1&&this.units[target*U.WORDS+U.UALTITUDE]>0;
    if(combatTypes[this.units[id*U.WORDS+U.UTYPE]].name==='SAM'&&!air)return false;
    return !air||!!bullets[weapons[weapon].bullet].antiAir;
  }
  private inRange(id: number, target: number, which = 0) {
    const type = combatTypes[this.units[id * U.WORDS + U.UTYPE]];
    const weapon = which ? type.secondary : type.primary;
    if(weapon<0)return false;
    const b=target>=0?BUILDINGS.get(MOVEMENT[this.units[target*U.WORDS+U.UTYPE]].name):undefined;
    return this.canTarget(id,target,weapon) && distance(...this.muzzle(id, which), ...this.point(target)) <= weapons[weapon].range+(b?(b.width+b.height)*64:0);
  }
  /** TECHNO.CPP, Greatest_Threat/Evaluate_Cell: preserve ring traversal and early exits. */
  private findTarget(id: number) {
    const u = this.units, at = id * U.WORDS, type = combatTypes[u[at + U.UTYPE]];
    const hunter=this.state[id*C.CWORDS+C.CMISSION]===C.HUNT;
    if(type.primary<0&&!(type.name==='E6'&&hunter)||type.name==='RMBO'&&!hunter&&u[at+U.UOWNER]===this.humanOwner)return -1;
    const eligible=(other:number)=>{
      const p=other*U.WORDS,t=combatTypes[u[p+U.UTYPE]];
      return !(u[at+U.UOWNER]===this.humanOwner&&u[p+U.UDOMAIN]===2&&t.primary<0)&&
        (type.name!=='RMBO'||u[p+U.UKIND]!==0||u[p+U.UDOMAIN]===2);
    };
    // FOOT.CPP Mission_Hunt; TECHNO.CPP Greatest_Threat/Evaluate_Object (non-ADVANCED).
    // CPU reference may scan all units. GPU uses a faction reduction and the score's
    // distance upper bound; current ground-layer coordinates settle equal scores.
    const localHunt = !!this.setup.ultraHunt && hunter && u[at + U.UDOMAIN] === 0 && type.name !== 'E6';
    if (hunter && !localHunt) {
      let best = -1, score = -1;
      for (let other = 0; other < this.setup.units.length; other++) {
        const p = other * U.WORDS, target = combatTypes[u[p + U.UTYPE]];
        if ((u[p + U.UHEALTH] <= 0 || u[p + U.UATTACHED] !== 0) || areAllied(this.setup, u[at + U.UOWNER], u[p + U.UOWNER]) || !target.targetable ||
          !eligible(other)||!this.setup.multiplayer&&!this.state[other * C.CWORDS + C.CSEEN] || !this.canTarget(id,other,type.primary)&&!this.canTarget(id,other,type.secondary))
          continue;
        const raw = target.risk + target.reward;
        const value = Math.max(raw ? 2 : 0, Math.floor((raw + this.state[other * C.CWORDS + C.CKILLS]) /
          Math.max(1, distance(u[at], u[at + 1], u[p], u[p + 1]))));
        if (value > score || value === score && targetOrder(u, other, best) < 0) {
          score = value;
          best = other;
        }
      }
      return best;
    }
    const width = this.setup.grid.width, height = this.setup.grid.height;
    const guardArea=this.state[id*C.CWORDS+C.CMISSION]===C.GUARD_AREA, area=guardArea||localHunt;
    const center=guardArea?this.movement.point(this.state[id*C.CWORDS+C.CGUARD_CELL]-1):[u[at],u[at+1]];
    const [mx,my]=this.muzzle(id),cx=Math.floor((mx-u[at]+center[0])/256),cy=Math.floor((my-u[at+1]+center[1])/256);
    const maximum=Math.max(weapons[type.primary].range,type.secondary<0?0:weapons[type.secondary].range),areaRange=Math.min(2560,maximum*2);
    const range=area?Math.floor(areaRange/256):Math.floor(maximum/256)+1;
    let best = -1, bestValue = -1;
    const valueOf=(other:number)=>{
      const t=combatTypes[u[other*U.WORDS+U.UTYPE]],raw=t.risk+t.reward;
      const d=distance(u[at],u[at+1],...this.point(other));
      const divisor=area?Math.trunc(d/Math.trunc(areaRange/256)):d;
      return Math.max(raw?2:0,Math.trunc((raw+this.state[other*C.CWORDS+C.CKILLS])/Math.max(1,divisor)));
    };
    const inReach=(other:number)=>area?(this.canTarget(id,other,type.primary)||this.canTarget(id,other,type.secondary))&&distance(center[0],center[1],...this.point(other))<=areaRange:
      this.inRange(id,other)||this.inRange(id,other,1);
    // TECHNO.CPP Greatest_Threat scans aircraft separately; flying aircraft never occupy ground cells.
    if([type.primary,type.secondary].some(w=>w>=0&&bullets[weapons[w].bullet].antiAir))for(const other of this.aircraftTargets??this.setup.units.map((_,id)=>id)){
      const p=other*U.WORDS;
      if(u[p+U.UDOMAIN]!==1||u[p+U.UHEALTH]<=0||u[p+U.UATTACHED]||areAllied(this.setup, u[at+U.UOWNER], u[p+U.UOWNER])||!eligible(other)||!combatTypes[u[p+U.UTYPE]].targetable||!inReach(other))continue;
      const value=valueOf(other);if(value>bestValue){best=other;bestValue=value;}
    }
    const visit = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= width || y >= height)
        return;
      // A cell's first enemy is deterministic, independent of GPU insertion order.
      let candidate = this.targetCells?.[u[at+U.UOWNER]][y*width+x]??-1;
      if (!this.targetCells) for (let other = 0; other < this.setup.units.length; other++) {
        const p = other * U.WORDS;
        if ((u[p + U.UHEALTH] > 0 && u[p + U.UATTACHED] === 0) && !areAllied(this.setup, u[at + U.UOWNER], u[p + U.UOWNER]) &&
          !WALLS[MOVEMENT[u[p+U.UTYPE]].name]&&(u[p+U.UDOMAIN]!==1||u[p+U.UALTITUDE]===0)&&
          Math.floor(u[p] / 256) === x && Math.floor(u[p + 1] / 256) === y) {
          candidate = other;
          break;
        }
      }
      // BUILDING.CPP Greatest_Threat: human defenses omit THREAT_BUILDINGS.
      if (candidate >= 0 && eligible(candidate)&&combatTypes[u[candidate*U.WORDS+U.UTYPE]].targetable&&
        (this.setup.multiplayer||u[at+U.UOWNER]!==0||this.state[candidate*C.CWORDS+C.CSEEN])&&
        !(u[at+U.UDOMAIN]===2 && u[at+U.UOWNER]===this.humanOwner && u[candidate*U.WORDS+U.UDOMAIN]===2)
        && inReach(candidate)&&valueOf(candidate)>bestValue)
        best = candidate;
    };
    for (let r = 1; r < range; r++) {
      for (let x = -r; x <= r; x++) {
        visit(cx + x, cy - r);
        visit(cx + x, cy + r);
      }
      for (let y = -r + 1; y < r; y++) {
        visit(cx - r, cy + y);
        visit(cx + r, cy + y);
      }
      if (best >= 0 && (r === Math.floor(range / 4) || r === Math.floor(range / 2)))
        break;
    }
    return best;
  }
  private approach(id: number, target: number) {
    const u = this.units, at = id * U.WORDS, type = combatTypes[u[at + U.UTYPE]];
    // DRIVE.CPP, Approach_Target: computer crushers overrun nearby infantry;
    // flame tanks retain their weapon approach.
    if (this.movement.goals[id] < 0 && this.units[at + U.UOWNER] !== this.humanOwner && type.crusher && type.primary !== 6 &&
      target >= 0 && this.units[target * U.WORDS + U.UKIND] && distance(this.units[at], this.units[at + 1], ...this.point(target)) < 0x180) {
      const [x, y] = this.point(target);
      this.movement.goals[id] = Math.floor(y / 256) * this.setup.grid.width + Math.floor(x / 256);
      this.movement.pathGoals[id] = -1;
      return;
    }
    if (type.primary < 0 || this.movement.goals[id] >= 0 || this.inRange(id, target))
      return;
    // Ported from FOOT.CPP, Approach_Target: seek a firing position inside maximum range.
    const [tx, ty] = this.point(target), dir = desiredFacing256(tx, ty, u[at], u[at + 1]);
    const max = Math.max(weapons[type.primary].range, type.secondary < 0 ? 0 : weapons[type.secondary].range) - 0xB7;
    let goal = Math.floor(ty / 256) * this.setup.grid.width + Math.floor(tx / 256), found = false;
    for (let r = max; r > 128 && !found; r -= 256)
      for (const angle of [0, 8, -8, 16, -16, 24, -24, 32, -32, 48, -48, 64, -64]) {
        const [x, y] = movePoint(tx, ty, dir + angle, r), xx = Math.floor(x / 256), yy = Math.floor(y / 256);
        if (xx < 0 || yy < 0 || xx >= this.setup.grid.width || yy >= this.setup.grid.height)
          continue;
        const cell = yy * this.setup.grid.width + xx;
        if (distance(x, y, tx, ty) < r && this.setup.grid.edges[cell] && this.movement.occupancy[cell * 5] === 0) {
          goal = cell;
          found = true;
          break;
        }
      }
    this.movement.goals[id] = goal;
    this.movement.pathGoals[id] = -1;
  }
  /** Bounded replacement for dynamic-obstacle search in FINDPATH.CPP, Find_Path. */
  private recoverApproach(id: number, target: number) {
    const u = this.units, s = this.state, at = id * U.WORDS, c = id * C.CWORDS;
    const type = combatTypes[u[at + U.UTYPE]], moving = MOVEMENT[u[at + U.UTYPE]];
    if (type.primary < 0 || this.inRange(id, target)) {
      s[c + C.CLOCAL_ROUTE] = 0;
      s[c + C.CLOCAL_DEST] = -1;
      s[c + C.CROUTE_LENGTH] = 0;
      return false;
    }
    // Travelling armies still use normal movement recovery. Search locally only when
    // the unit is near the firing line, where stationary attackers can fill its approach.
    const close = distance(u[at], u[at + 1], ...this.point(target)) <= weapons[type.primary].range + 512;
    if (!s[c + C.CLOCAL_ROUTE] && !close)
      return false;
    const failed = u[at + U.UWAIT] > 0 || u[at + U.URETRIES] < 10 ||
      s[c + C.CAPPROACH_GOAL] >= 0 && this.movement.goals[id] < 0;
    if (!s[c + C.CLOCAL_ROUTE] && !failed)
      return false;
    s[c + C.CLOCAL_ROUTE] = 1;
    if (u[at + U.UDEST] >= 0 || this.movement.goals[id] >= 0 && !failed || s[c + C.CLOCAL_WAIT])
      return true;
    const start = u[at + U.UCELL], [tx, ty] = this.point(target);
    const targetCell = Math.floor(ty / 256) * this.setup.grid.width + Math.floor(tx / 256);
    if (s[c + C.CROUTE_TARGET] !== targetCell) {
      s[c + C.CROUTE_LENGTH] = 0;
      s[c + C.CLOCAL_DEST] = -1;
      s[c + C.CROUTE_TARGET] = targetCell;
    }
    if (s[c + C.CLOCAL_DEST] === start)
      s[c + C.CLOCAL_DEST] = -1;
    let destination = s[c + C.CLOCAL_DEST];
    const enter = (cell: number) => {
      if (!GROUND_SPEED[this.setup.land[cell]][moving.locomotion])
        return false;
      let free = 0;
      for (let slot = 0; slot < 5; slot++) {
        const owner = this.movement.occupancy[cell * 5 + slot];
        if (!owner || owner === id + 1)
          free++;
      }
      return moving.infantry ? free > 0 : free === 5;
    };
    if (destination >= 0 && !enter(destination)) {
      s[c + C.CLOCAL_DEST] = destination = -1;
      s[c + C.CROUTE_LENGTH] = 0;
    }
    const towards = destination >= 0 ? this.movement.point(destination) : [tx, ty];
    const cursor = s[c + C.CROUTE_CURSOR];
    const cached = cursor > 0 && cursor < s[c + C.CROUTE_LENGTH] && s[c + C.CROUTE_PATH + cursor - 1] === start
      ? s[c + C.CROUTE_PATH + cursor] : -1;
    let route;
    if (cached >= 0 && enter(cached)) {
      route = { step: cached, destination, path: [] };
      s[c + C.CROUTE_CURSOR]++;
    }
    else {
      route = attackRoute(this.setup.grid, start, enter, cell => {
        if (destination >= 0)
          return cell === destination;
        const [x, y] = this.movement.point(cell);
        const direction = desiredFacing256(x, y, tx, ty);
        return distance(...firePoint(type.name, x, y, direction, s[c + C.CSECOND]), tx, ty) <= weapons[type.primary].range;
      }, cell => {
        const [x, y] = this.movement.point(cell);
        return distance(x, y, towards[0], towards[1]);
      });
      s[c + C.CROUTE_LENGTH] = Math.min(C.ROUTE_STEPS, route.path.length);
      s[c + C.CROUTE_CURSOR] = 1;
      for (let i = 0; i < s[c + C.CROUTE_LENGTH]; i++)
        s[c + C.CROUTE_PATH + i] = route.path[i];
    }
    const first = route.step;
    s[c + C.CLOCAL_DEST] = route.destination;
    this.movement.goals[id] = first === start ? -1 : first;
    this.movement.pathGoals[id] = this.movement.goals[id] >= 0 ? U.DIRECT_STEP : -1;
    u[at + U.UWAIT] = 0;
    u[at + U.URETRIES] = 10;
    u[at + U.UROUTE] = -1;
    u[at + U.USTALLED] = 0;
    s[c + C.CLOCAL_WAIT] = first < 0 ? PATH_DELAY : 0;
    return true;
  }
  /** Remaster UNIT.CPP / INFANTRY.CPP Enter_Idle_Mode under USE_RA_AI, at the default maximum IQ. */
  private idleMission(id:number){
    const at=id*U.WORDS;
    return this.setup.multiplayer&&this.units[at+U.UOWNER]!==this.humanOwner&&this.units[at+U.UDOMAIN]===0&&combatTypes[this.units[at+U.UTYPE]].primary>=0?C.GUARD_AREA:C.GUARD;
  }
  private resetObstructionRoute(id:number){
    const u=this.units,s=this.state,at=id*U.WORDS,c=id*C.CWORDS;
    this.movement.pathGoals[id]=-1;
    s[c+C.CLOCAL_ROUTE]=s[c+C.CLOCAL_WAIT]=s[c+C.CROUTE_LENGTH]=0;
    s[c+C.CLOCAL_DEST]=s[c+C.CAPPROACH_GOAL]=-1;s[c+C.CSCAN]=0;
    u[at+U.UWAIT]=0;u[at+U.URETRIES]=10;u[at+U.UROUTE]=-1;
  }
  private targetGone(target:number){
    if(target<0)return target===-1;
    const u=this.units,at=target*U.WORDS;
    return u[at+U.UHEALTH]<=0||u[at+U.UATTACHED]!==0||u[at+U.UCLOAK]===2||
      Math.trunc(u[at+U.UCLOAK_EVENT]/8)===this.frame+1&&(u[at+U.UCLOAK_EVENT]&1)!==0;
  }
  /** DRIVE.CPP Start_Of_Move / INFANTRY.CPP AI; FOOT.CPP Override_Mission and Restore_Mission. */
  private obstruction(id:number){
    const u=this.units,s=this.state,at=id*U.WORDS,c=id*C.CWORDS,other=u[at+U.UOBSTRUCTION]-1;
    const type=combatTypes[u[at+U.UTYPE]];
    if(other>=0&&type.primary>=0&&!areAllied(this.setup, u[at+U.UOWNER], u[other*U.WORDS+U.UOWNER])){
      const wall=WALLS[MOVEMENT[u[other*U.WORDS+U.UTYPE]].name];
      const warhead=warheads[bullets[weapons[type.primary].bullet].warhead];
      if(!wall||u[at+U.UOWNER]!==this.humanOwner&&(warhead.wall||wall.wood&&warhead.wood)){
        if(u[other*U.WORDS+U.UHEALTH]<=0){
          if(s[c+C.CMISSION]===C.MOVE&&this.movement.goals[id]<0)this.movement.goals[id]=u[at+U.UOBSTRUCTION_GOAL];
        }else if(!this.targetGone(other)&&other!==s[c+C.CTARGET]){
          s[c+C.CSUSPENDED_MISSION]=s[c+C.CMISSION]+1;
          s[c+C.CSUSPENDED_TARGET]=s[c+C.CTARGET];
          s[c+C.CSUSPENDED_GOAL]=s[c+C.CLOCAL_ROUTE]&&s[c+C.CLOCAL_DEST]>=0?s[c+C.CLOCAL_DEST]:u[at+U.UOBSTRUCTION_GOAL];
          s[c+C.CSUSPENDED_ABILITY]=u[at+U.UABILITY_MODE];u[at+U.UABILITY_MODE]=0;
          s[c+C.CMISSION]=C.ATTACK;s[c+C.CTARGET]=other;this.movement.goals[id]=-1;
          this.resetObstructionRoute(id);
        }
      }
    }
    const suspended=s[c+C.CSUSPENDED_TARGET];
    if(s[c+C.CSUSPENDED_MISSION]&&suspended>=0&&this.targetGone(suspended)){s[c+C.CSUSPENDED_MISSION]=0;s[c+C.CSUSPENDED_TARGET]=-1;}
    const target=s[c+C.CTARGET];
    if(s[c+C.CSUSPENDED_MISSION]&&(this.targetGone(target)||target>=0&&areAllied(this.setup, u[at+U.UOWNER], u[target*U.WORDS+U.UOWNER]))){
      s[c+C.CMISSION]=s[c+C.CSUSPENDED_MISSION]-1;s[c+C.CTARGET]=s[c+C.CSUSPENDED_TARGET];
      this.movement.goals[id]=s[c+C.CSUSPENDED_GOAL];u[at+U.UABILITY_MODE]=s[c+C.CSUSPENDED_ABILITY];
      s[c+C.CSUSPENDED_MISSION]=0;this.resetObstructionRoute(id);
    }
  }
  /** Ported from TECHNO.CPP/TURRET.CPP/TARCOM.CPP AI, and FOOT.CPP Mission_Guard. */
  private randomAnimate(id:number){
    // Ported from INFANTRY.CPP Random_Animate, called by FOOT.CPP Guard/Hunt.
    const u=this.units,s=this.state,at=id*U.WORDS,c=id*C.CWORDS,type=combatTypes[u[at+U.UTYPE]];
    if(!u[at+U.UKIND]||u[at+U.UDEST]>=0||s[c+C.CPRONE]||s[c+C.CACTION]||s[c+C.CFIRE]>=0)return;
    const scatter=()=>{if(this.movement.goals[id]<0&&this.movement.scatter(id)>=0)s[c+C.CMISSION]=C.MOVE;};
    if(type.fraidy&&u[at+U.UOWNER]!==this.humanOwner&&s[c+C.CFEAR]>10){scatter();return;}
    const pick=(stream:number,size:number)=>randomWord(this.setup.seed,this.frame+1,id,stream)%size;
    const action=(value:number)=>{if(type.actions[value*3+1]&&[0,9,10].includes(s[c+C.CACTION])){s[c+C.CACTION]=value;s[c+C.CSTAGE]=0;}};
    if(type.name==='C10'&&pick(710,4)===0)action(10);
    const choice=pick(711,56);
    if(choice===10)action(28);else if(choice===11)action(30);else if(choice===12)action(27);else if(choice===13)action(29);
    else if(choice<=4){
      if(choice===1)action(9);else if(choice===2)action(10);
      u[at+U.UFACE]=u[at+U.UDESIRED]=pick(712,8)*32;
      if(choice===1&&type.name==='MOEBIUS'&&s[c+C.CSEEN]&&pick(713,20)===0)s[c+C.CIDLE_VOICE]=(this.frame+1)*4+1+pick(714,2);
      if(choice===2&&type.name==='RMBO'&&u[at+U.UOWNER]===this.humanOwner&&pick(713,3)===0)s[c+C.CIDLE_VOICE]=(this.frame+1)*4+3;
    }else if(choice<=9&&type.fraidy&&u[at+U.UOWNER]!==this.humanOwner)scatter();
  }
  private prepare() {
    const u = this.units, s = this.state;
    // CELL.CPP Occupy_Down; TECHNO.CPP Per_Cell_Process. Partial shroud edge
    // cells are IsVisible too, even before Map_Cell marks them fully mapped.
    for (let id = 0; id < this.setup.units.length; id++)
      if (!s[id * C.CWORDS + C.CSEEN] && u[id * U.WORDS + U.UHEALTH] > 0) {
        const cell = Math.floor(u[id * U.WORDS + 1] / 256) * this.setup.grid.width + Math.floor(u[id * U.WORDS] / 256);
        if (this.sight.mapped[cell] || this.sight.shadow[cell] !== -2)
          s[id * C.CWORDS + C.CSEEN] = 1;
      }
    for (let id = 0; id < this.setup.units.length; id++) {
      const at = id * U.WORDS, c = id * C.CWORDS, type = combatTypes[u[at + U.UTYPE]], moving = MOVEMENT[u[at + U.UTYPE]];
      if ((u[at + U.UHEALTH] <= 0 || u[at + U.UATTACHED] !== 0))
        continue;
      this.obstruction(id);
      if (s[c + C.CARM])
        s[c + C.CARM]--;
      if (s[c + C.CLOCAL_WAIT])
        s[c + C.CLOCAL_WAIT]--;
      // INFANTRY.CPP AI: Nikoomba never recovers; armed civilians reload on recovery.
      if (s[c + C.CFEAR] && type.name !== 'C10') {
        s[c + C.CFEAR]--;
        if (!s[c+C.CFEAR] && !s[c+C.CAMMO] && type.primary >= 0) s[c+C.CAMMO]=type.ammo;
      }
      // INFANTRY.CPP, AI; SPECIAL.H defaults IsDefenderAdvantage to true.
      const canLieDown = s[c + C.CPRONE] || (u[at + U.UDEST] < 0 && this.movement.goals[id] < 0);
      // MasterDoControls refuses DO_LIE_DOWN until a victory gesture finishes.
      const gesturing=s[c+C.CACTION]>=27&&s[c+C.CACTION]<=30;
      const prone = gesturing ? s[c+C.CPRONE] : moving.infantry && canLieDown && s[c + C.CFEAR] >= 10 ? 1 : 0;
      if (prone !== s[c + C.CPRONE]) {
        s[c + C.CACTION] = prone ? 5 : 7;
        s[c + C.CSTAGE] = 0;
      }
      else if (s[c + C.CACTION]) {
        s[c + C.CSTAGE]++;
        if (s[c + C.CSTAGE] >= type.actions[s[c + C.CACTION] * 3 + 1] * (s[c + C.CACTION] === 7 ? 3 : 2))
          s[c + C.CACTION] = 0;
      }
      s[c + C.CPRONE] = prone;
      if (moving.infantry)
        u[at + U.USPEED] = prone ? type.fraidy && type.name !== 'E5' ? 510 : 127 : 255;
      // INFANTRY.CPP AI calls Scatter(true): Coord(1), not forced=true.
      // Scatter excludes human units under SPECIAL.H's default IsScatter=false.
      if (type.fraidy && u[at + U.UOWNER] !== this.humanOwner && s[c + C.CFEAR] > 10 && !s[c + C.CACTION] &&
        u[at + U.UDEST] < 0 && this.movement.goals[id] < 0) {
        const dx=u[at]-1, dy=u[at+1];
        // FACING8.ASM Desired_Facing8 from (1,0); on-map coordinates are positive.
        const facing=Math.min(dx,dy)<((Math.max(dx,dy)+1)>>1) ? (dx>=dy?2:4) : 3;
        this.movement.scatter(id, facing);
        if (this.movement.goals[id] >= 0)
          s[c + C.CMISSION] = C.MOVE;
      }
      // INFANTRY.CPP AI / MasterDoControls: gestures cannot interrupt another
      // gesture or getting up. The comment is still emitted when Do_Action refuses.
      if (s[c+C.CSTOKED] && s[c+C.CCOMMENT]<=this.frame+1 && this.movement.goals[id]<0 && !prone) {
        s[c+C.CSTOKED]=0;
        s[c+C.CCELEBRATED]=this.frame+1;
        s[c+C.CTAUNT]=randomWord(this.setup.seed,this.frame+1,id,101)%4;
        if (!s[c+C.CACTION]) {
          s[c+C.CACTION]=randomWord(this.setup.seed,this.frame+1,id,100)%2 ? 29 : 27;
          s[c+C.CSTAGE]=0;
          s[c+C.CFIRE]=-1;
        }
      }
      if (s[c+C.CACTION]>=27&&s[c+C.CACTION]<=30) u[at+U.UWAIT]=Math.max(u[at+U.UWAIT],2);
      if (type.name === 'MLRS' && s[c + C.CAMMO] < type.ammo && u[at + U.UDEST] < 0) {
        if (s[c + C.CRELOAD] > 0)
          s[c + C.CRELOAD]--;
        if (!s[c + C.CRELOAD]) {
          s[c + C.CAMMO]++;
          if (s[c + C.CAMMO] < type.ammo)
            s[c + C.CRELOAD] = 450;
        }
      }
      if (s[c + C.CFIRE] >= 0) {
        s[c + C.CFIRE]++;
        const action = s[c + C.CPRONE] ? 8 : 4;
        if (s[c + C.CFIRE] >= type.actions[action * 3 + 1])
          s[c + C.CFIRE] = -1;
      }
      if (s[c + C.CFIRE] >= 0 && moving.infantry)
        u[at + U.UWAIT] = 2;
      s[c + C.CTURRET] = rotateFacing(s[c + C.CTURRET], s[c + C.CTURN], moving.rotation + 1);
      s[c + C.CROTATING] = s[c + C.CTURRET] !== s[c + C.CTURN] ? 1 : 0;
      let target = s[c + C.CTARGET];
      if (this.targetGone(target)) target = -1;
      // FOOT.CPP Mission_Attack / Enter_Idle_Mode; do not inherit pursuit when
      // the explicit target ceases to exist.
      if (target === -1 && s[c + C.CMISSION] === C.ATTACK) {
        // UNIT.CPP / INFANTRY.CPP Enter_Idle_Mode preserves a valid NavCom.
        // Local recovery stores the final firing position separately from its next step.
        if (s[c+C.CLOCAL_ROUTE] && s[c+C.CLOCAL_DEST]>=0) {
          this.movement.goals[id]=s[c+C.CLOCAL_DEST];
          this.movement.pathGoals[id]=-1;
        }
        s[c + C.CMISSION] = this.movement.goals[id]>=0 ? C.MOVE : this.idleMission(id);
      }
      // UNIT.CPP / INFANTRY.CPP Enter_Idle_Mode: a retained TarCom takes priority on arrival.
      if (s[c + C.CMISSION] === C.MOVE && this.movement.goals[id] < 0)
        s[c + C.CMISSION] = target !== -1 ? C.ATTACK : this.idleMission(id);
      if (s[c + C.CSCAN])
        s[c + C.CSCAN]--;
      // FOOT.CPP Mission_Guard_Area keeps an archive position and scans from there.
      if(s[c+C.CMISSION]===C.GUARD_AREA&&s[c+C.CSCAN]===0){
        if(!s[c+C.CGUARD_CELL])s[c+C.CGUARD_CELL]=u[at+U.UCELL]+1;
        const home=s[c+C.CGUARD_CELL]-1,d=distance(u[at],u[at+1],...this.movement.point(home));
        const leash=Math.max(weapons[type.primary]?.range??0,weapons[type.secondary]?.range??0)+256;
        if(this.movement.goals[id]<0&&(d>leash||target===-1&&d>512)){
          target=-1;this.movement.goals[id]=home;this.movement.pathGoals[id]=-1;
        }
      }
      // TECHNO.CPP Target_Something_Nearby(THREAT_RANGE).
      if (s[c + C.CSCAN] === 0 && s[c + C.CMISSION] === C.GUARD && target !== -1 &&
        !this.inRange(id, target) && !this.inRange(id, target, 1))
        target = -1;
      // FOOT.CPP Mission_Move: computer ground units retain a valid TarCom
      // while travelling, and search THREAT_RANGE every TICKS_PER_SECOND + 3.
      const moveScan = s[c+C.CMISSION] === C.MOVE && u[at+U.UOWNER] !== this.humanOwner && u[at+U.UDOMAIN] === 0;
      if (s[c + C.CSCAN] === 0 && (s[c + C.CMISSION] !== C.MOVE || moveScan) && ![C.SLEEP,C.STICKY,C.AMBUSH].includes(s[c+C.CMISSION])) {
        const searching=target===-1;
        if (searching) {
          target = this.findTarget(id);
          if (this.setup.ultraHunt && target >= 0 && s[c+C.CMISSION]===C.HUNT && this.movement.pathGoals[id]===U.DIRECT_STEP) {
            this.movement.goals[id]=-1; this.movement.pathGoals[id]=-1; u[at+U.UROUTE]=-1;
          }
        }
        s[c + C.CSCAN] = moveScan ? 18 : s[c+C.CMISSION]===C.GUARD_AREA&&searching&&target!==-1?1:s[c + C.CMISSION] === C.HUNT ? 20 : 15 + randomWord(this.setup.seed, this.frame + 1, id, 50) % 5;
        if(target===-1&&(s[c+C.CMISSION]===C.GUARD||s[c+C.CMISSION]===C.HUNT))this.randomAnimate(id);
      }
      if([9,10].includes(s[c+C.CACTION])&&(target!==-1||this.movement.goals[id]>=0||u[at+U.UDEST]>=0))s[c+C.CACTION]=0;
      if(type.name==='E6'&&target>=0&&(s[c+C.CMISSION]===C.HUNT||s[c+C.CMISSION]===C.ATTACK)&&!u[at+U.UABILITY_MODE]&&canCaptureBuilding(MOVEMENT[u[target*U.WORDS+U.UTYPE]].name,this.setup.campaignLevel)){
        u[at+U.UABILITY_TARGET]=target+1;u[at+U.UABILITY_MODE]=1;u[at+U.UABILITY_ENTRY]=u[at+U.UABILITY_ORIGIN]=0;
        s[c+C.CMISSION]=C.MOVE;target=-1;
      }
      s[c + C.CTARGET] = target;
      if (target !== -1) {
        if (!moving.domain && s[c + C.CMISSION] >= C.ATTACK && !this.recoverApproach(id, target))
          this.approach(id, target);
        s[c + C.CAPPROACH_GOAL] = this.movement.goals[id];
        const dir = desiredFacing256(u[at], u[at + 1], ...this.point(target));
        if (type.turret && moving.domain!==2) {
          s[c + C.CTURN] = type.lockTurret && this.movement.goals[id] >= 0 ? u[at + U.UFACE] : dir;
          // TARCOM.CPP, FIRE_FACING; TURRET.CPP, Ok_To_Move.
          if (type.lockTurret && u[at + U.UDEST] < 0 && this.movement.goals[id] < 0)
            u[at + U.UDESIRED] = dir;
        }
        else if (type.name!=='SAM' && type.name!=='A10' && u[at + U.UDEST] < 0 && this.movement.goals[id] < 0)
          u[at + U.UDESIRED] = type.name === 'FTNK' ? dirFacing(dir) * 32 : dir;
      }
      else {
        s[c + C.CTURN] = !type.lockTurret && this.movement.goals[id] >= 0 ?
          desiredFacing256(u[at], u[at + 1], ...this.movement.point(this.movement.goals[id])) : u[at + U.UFACE];
        s[c + C.CLOCAL_ROUTE] = 0;
        s[c + C.CAPPROACH_GOAL] = -1;
        s[c + C.CROUTE_LENGTH] = 0;
      }
      if (type.lockTurret && u[at + U.UDEST] < 0 && this.movement.goals[id] >= 0 && s[c + C.CTURRET] !== u[at + U.UFACE])
        u[at + U.UWAIT] = Math.max(u[at + U.UWAIT], 2);
      // UNIT.CPP, AI: the Mammoth regenerates only below half strength.
      if (type.name === 'HTNK' && (this.frame + 1) % 16 === 0 && u[at + U.UHEALTH] < moving.strength / 2)
        u[at + U.UHEALTH]++;
      if(moving.domain===2)this.defense(id);
    }
  }
  /** BUILDING.CPP AI and Mission_Attack: turret rotation, charging and retractable SAM. */
  private defense(id:number){
    const u=this.units,s=this.state,at=id*U.WORDS,c=id*C.CWORDS,name=MOVEMENT[u[at+U.UTYPE]].name;
    this.movement.goals[id]=-1;this.movement.pathGoals[id]=-1;
    if(!s[c+C.CACTIVE]){s[c+C.CTARGET]=-1;return;}
    u[at+U.UFACE]=rotateFacing(u[at+U.UFACE],u[at+U.UDESIRED],name==='SAM'?15:12);
    const target=s[c+C.CTARGET];
    if(name==='OBLI')s[c+C.CCHARGE]=target!==-1&&s[c+C.CPOWER]>=256?Math.min(61,s[c+C.CCHARGE]+1):0;
    if(name!=='SAM')return;
    const state=s[c+C.CSAM];
    if(state===1||state===7)s[c+C.CCHARGE]++;
    if(s[c+C.CSTIMER]>0&&--s[c+C.CSTIMER]>0)return;
    s[c+C.CSTIMER]=1;
    const valid=target>=0&&u[target*U.WORDS+U.UDOMAIN]===1&&u[target*U.WORDS+U.UALTITUDE]>0;
    if(state===0){if(valid){s[c+C.CSAM]=1;s[c+C.CCHARGE]=0;}}
    else if(state===1){if(s[c+C.CCHARGE]>=30){u[at+U.UFACE]=u[at+U.UDESIRED]=0;s[c+C.CSAM]=valid?2:7;s[c+C.CCHARGE]=0;}}
    else if(state===2||state===4){
      if(!valid){s[c+C.CTARGET]=-1;s[c+C.CSAM]=6;s[c+C.CSTIMER]=15;}
      else if(u[at+U.UFACE]===u[at+U.UDESIRED]){const dir=desiredFacing256(u[at],u[at+1],...this.point(target));if(dir!==u[at+U.UFACE])u[at+U.UDESIRED]=dir;else s[c+C.CSAM]++;}
    }else if(state===3||state===5){
      if(!valid||!this.inRange(id,target)){s[c+C.CTARGET]=-1;s[c+C.CSAM]=6;}
      else if(Math.abs(((desiredFacing256(u[at],u[at+1],...this.point(target))-u[at+U.UFACE]+128)&255)-128)>8)s[c+C.CSAM]--;
    }else if(state===6){if(u[at+U.UFACE]===u[at+U.UDESIRED]){if(u[at+U.UFACE]===0){s[c+C.CSAM]=7;s[c+C.CCHARGE]=0;}else u[at+U.UDESIRED]=0;}}
    else if(state===7&&s[c+C.CCHARGE]>=30){s[c+C.CSAM]=0;s[c+C.CCHARGE]=0;s[c+C.CSTIMER]=15;}
  }
  private fire(id: number) {
    const u = this.units, s = this.state, at = id * U.WORDS, c = id * C.CWORDS;
    if ((u[at + U.UHEALTH] <= 0 || u[at + U.UATTACHED] !== 0))
      return;
    const type = combatTypes[u[at + U.UTYPE]], target = s[c + C.CTARGET];
    if (target >= 0 && (u[target * U.WORDS + U.UHEALTH] <= 0 || u[target * U.WORDS + U.UATTACHED] !== 0)) {
      s[c + C.CTARGET] = -1;
      return;
    }
    if (type.primary < 0 || target === -1 || s[c + C.CAMMO] === 0 && type.name !== 'A10')
      return;
    const infantry = u[at + U.UKIND] !== 0;
    const desired = desiredFacing256(u[at], u[at + 1], ...this.point(target));
    const domain=u[at+U.UDOMAIN];
    const dir = type.turret&&domain!==2 ? s[c + C.CTURRET] : u[at + U.UFACE];
    // TARCOM.CPP, AI tries the secondary after any primary Can_Fire failure.
    const canFire = (which: number) => {
      const weapon = which ? type.secondary : type.primary;
      // AIRCRAFT.CPP Mission_Hunt calls Fire_At directly every five ticks.
      if (type.name === 'A10') return weapon >= 0 && !!s[c + C.CACTIVE];
      if (weapon < 0 || s[c + C.CARM] || u[at+U.UCLOAK]!==0 || !this.inRange(id, target, which))
        return false;
      const bullet = bullets[weapons[weapon].bullet];
      if(domain===2)return !!s[c+C.CACTIVE]&&(!type.turret||(dir===u[at+U.UDESIRED]&&Math.abs(((desired-dir+128)&255)-128)<=8))
        &&(type.name!=='ATWR'||s[c+C.CPOWER]>=256)&&(type.name!=='OBLI'||s[c+C.CCHARGE]>=61)
        &&(type.name!=='SAM'||s[c+C.CSAM]===3||s[c+C.CSAM]===5);
      if(domain===1)return u[at+U.UALTITUDE]===24&&!!s[c+C.CACTIVE];
      let diff = Math.abs(((desired - dir + 128) & 255) - 128);
      if (type.name === 'FTNK' && dirFacing(desired) === dirFacing(dir))
        diff = 0;
      if (bullet.homing)
        diff >>= 2;
      return diff < 8 && (!type.lockTurret && !!type.turret || this.movement.goals[id] < 0) &&
        (!!bullet.homing || !type.turret || !s[c + C.CROTATING]);
    };
    const which = !infantry && !canFire(0) ? 1 : 0;
    if (!infantry && !canFire(which))
      return;
    const w = which ? type.secondary : type.primary, weapon = weapons[w], bullet = bullets[weapon.bullet];
    let launch = false;
    if (infantry) {
      if (s[c + C.CFIRE] < 0 && !s[c + C.CACTION] && !s[c + C.CARM] && u[at + U.UDEST] < 0 && this.inRange(id, target, which)) {
        s[c + C.CFIRE] = 0;
        s[c + C.CSHOT] = 0;
        u[at + U.UFACE] = u[at + U.UDESIRED] = dirFacing(desired) * 32;
      }
      launch = s[c + C.CFIRE] === (s[c + C.CPRONE] ? type.proneLaunch : type.launch) && !s[c + C.CSHOT];
    }
    else
      launch = true;
    if (!launch)
      return;
    const b = (id * C.SHOTS_PER_UNIT + s[c + C.CCURSOR]) * C.BWORDS, p = this.projectiles;
    if (p[b + C.BACTIVE])
      throw new Error('Projectile capacity exceeded');
    s[c + C.CCURSOR] = (s[c + C.CCURSOR] + 1) % C.SHOTS_PER_UNIT;
    const [fx, fy] = bullet.dropping ? [u[at], u[at+1]] : this.muzzle(id, which);
    let [tx, ty] = this.point(target), direction = bullet.homing || bullet.dropping ? dir : desiredFacing256(fx, fy, tx, ty);
    // BULLET.CPP, Unlimbo: spread is keyed to the object and tick, as required by the constitution.
    if (u[at + U.UDEST] >= 0 || bullet.inaccurate || ((target < -1 || u[target * U.WORDS + U.UKIND]) && (bullet.warhead === 2 || bullet.fueled))) {
      if (bullet.homing || bullet.arcing) {
        const spread = Math.min(weapon.bullet === 11 ? 128 : 512, Math.floor(distance(fx, fy, tx, ty) / (weapon.bullet === 11 ? 4 : 3)));
        direction = (direction + randomWord(this.setup.seed, this.frame, id, 51) % 11 - 5) & 255;
        [tx, ty] = movePoint(tx, ty, randomWord(this.setup.seed, this.frame, id, 52) & 255, randomWord(this.setup.seed, this.frame, id, 53) % (spread + 1));
      }
      else
        [tx, ty] = movePoint(tx, ty, direction, randomWord(this.setup.seed, this.frame, id, 53) % 257);
      // BULLET.CPP Unlimbo: clamp scattered impacts to either weapon's range.
      const range = Math.max(weapons[type.primary].range, type.secondary < 0 ? 0 : weapons[type.secondary].range);
      const excess = distance(fx, fy, tx, ty) - range;
      if (distance(...this.muzzle(id), tx, ty) > weapons[type.primary].range &&
        (type.secondary < 0 || distance(...this.muzzle(id, 1), tx, ty) > weapons[type.secondary].range))
        [tx, ty] = movePoint(tx, ty, desiredFacing256(tx, ty, fx, fy), excess);
    }
    p.fill(0, b, b + C.BWORDS);
    p[b] = bullet.invisible && bullet.speed === 255 ? tx : fx;
    p[b + 1] = bullet.invisible && bullet.speed === 255 ? ty : fy;
    p[b + C.BTARGET] = target;
    p[b + C.BTYPE] = weapon.bullet;
    p[b + C.BDAMAGE] = weapon.damage;
    p[b + C.BACTIVE] = 1;
    p[b + C.BFACE] = p[b + C.BDESIRED] = direction;
    const d = distance(p[b], p[b + 1], tx, ty);
    const speed = bullet.arcing ? Math.max(25, bullet.speed + (d >> 5)) : bullet.speed === 255 ? 0 : bullet.speed;
    p[b + C.BSPEED] = (speed * (bullet.dropping ? 40 : 255) + 128) >> 8;
    p[b + C.BTIMER] = Math.min(255, Math.max(bullet.arming, bullet.range || Math.floor(d / bullet.speed) + 4));
    p[b + C.BARM] = target>=0&&u[target*U.WORDS+U.UDOMAIN]===1?0:bullet.arming;
    p[b + C.BTO_X] = tx;
    p[b + C.BTO_Y] = ty;
    p[b + C.BPROXIMITY] = d;
    p[b + C.BALTITUDE] = bullet.dropping ? 256 : bullet.arcing ? 1 : 0;
    p[b + C.BRISER] = bullet.arcing ? Math.max(10, Math.floor(Math.floor(d / 2) / (speed + 1)) * 3) : 0;
    p[b + C.BEXPLODED] = -1;
    p[b + C.BSOURCE] = id;
    p[b + C.BFIRE_X] = fx;
    p[b + C.BFIRE_Y] = fy;
    // TECHNO.CPP, Fire_At: directional effects follow Fire_Direction, not the bullet.
    p[b + C.BFIRE_FACE] = type.turret&&domain!==2 ? s[c + C.CTURRET] : u[at + U.UFACE];
    p[b + C.BWEAPON] = w;
    p[b + C.BBORN] = this.frame;
    s[c + C.CARM] = s[c + C.CSECOND] ? weapons[type.primary].rof + 3 : 9;
    if(domain===1)s[c+C.CARM]=Math.trunc(s[c+C.CARM]/2);
    if(type.name==='OBLI')s[c+C.CCHARGE]=0;
    if(type.name==='SAM'){if(s[c+C.CSAM]===3)s[c+C.CSAM]=4;else{s[c+C.CSAM]=6;s[c+C.CSTIMER]=45;}}
    if (type.twoShooter)
      s[c + C.CSECOND] ^= 1;
    if (s[c + C.CAMMO] > 0)
      s[c + C.CAMMO]--;
    // INFANTRY.CPP Fire_At: an empty pistol sends civilians running for cover.
    if(type.fraidy&&!s[c+C.CAMMO]){
      s[c+C.CFEAR]=255;
      if(s[c+C.CMISSION]===C.ATTACK||s[c+C.CMISSION]===C.HUNT)s[c+C.CMISSION]=C.GUARD;
    }
    if (type.name === 'MLRS' && !s[c + C.CRELOAD])
      s[c + C.CRELOAD] = 450;
    s[c + C.CLAST_FIRE] = this.frame;
    s[c + C.CSHOT] = 1;
    if (target >= 0 && u[target * U.WORDS + U.UOWNER] === 0)
      s[c + C.CSEEN] = 1;
  }
  /** Ported from BULLET.CPP AI, FLY.CPP Physics and FUSE.CPP Fuse_Checkup. */
  private fly() {
    const p = this.projectiles;
    for (let b = 0; b < p.length; b += C.BWORDS) {
      p[b + C.BIMPACT] = 0;
      p[b + C.BTRAIL_TICK] = -1;
      if (!p[b + C.BACTIVE])
        continue;
      const type = bullets[p[b + C.BTYPE]];
      let target=p[b+C.BTARGET];
      // BULLET.CPP AI emits smoke at the old position on alternate updates.
      if (type.smoke && (this.frame - p[b + C.BBORN]) % 2 === 1) {
        p[b + C.BTRAIL_X] = p[b];
        p[b + C.BTRAIL_Y] = p[b + 1];
        p[b + C.BTRAIL_TICK] = this.frame;
      }
      let forced = false;
      if (type.arcing) {
        p[b + C.BALTITUDE] += p[b + C.BRISER];
        forced = p[b + C.BALTITUDE] <= 0;
        if (p[b + C.BRISER] > -100)
          p[b + C.BRISER] -= 3;
      }
      if (type.dropping) {
        p[b + C.BALTITUDE] += p[b + C.BRISER]; forced = p[b + C.BALTITUDE] <= 0;
        if (p[b + C.BRISER] > -100) p[b + C.BRISER]--;
      }
      if (type.homing && (this.frame & 1) && target >= 0 && this.units[target * U.WORDS + U.UHEALTH] > 0)
        p[b + C.BDESIRED] = desiredFacing256(p[b], p[b + 1], ...this.point(target));
      p[b + C.BFACE] = rotateFacing(p[b + C.BFACE], p[b + C.BDESIRED], type.rotation);
      const actual = p[b + C.BACCUM] + p[b + C.BSPEED];
      p[b + C.BACCUM] = actual % 10;
      let [x, y] = movePoint(p[b], p[b + 1], p[b + C.BFACE], actual - actual % 10);
      if (x < 0 || y < 0 || x >= this.setup.grid.width * 256 || y >= this.setup.grid.height * 256) {
        p[b + C.BACTIVE] = 0;
        continue;
      }
      if(!type.high){const cell=Math.trunc(y/256)*this.setup.grid.width+Math.trunc(x/256),wall=this.buildingAt(cell);
        if(wall>=0&&WALLS[MOVEMENT[this.units[wall*U.WORDS+U.UTYPE]].name]?.high){forced=true;x=p[b]=cell%this.setup.grid.width*256+128;y=p[b+1]=Math.trunc(cell/this.setup.grid.width)*256+128;}}
      if(type.antiAir&&target>=0&&this.units[target*U.WORDS+U.UDOMAIN]===1&&distance(p[b],p[b+1],...this.point(target))<128){
        forced=true;p[b+C.BDAMAGE]+=Math.trunc(p[b+C.BDAMAGE]/(p[b+C.BTYPE]===7?3:2));
      }
      let explode = forced;
      if (!forced && !type.dropping) {
        if (p[b + C.BTIMER])
          p[b + C.BTIMER]--;
        if (p[b + C.BARM])
          p[b + C.BARM]--;
        else {
          const d = distance(x, y, p[b + C.BTO_X], p[b + C.BTO_Y]);
          explode = !p[b + C.BTIMER] || d < 16 || d < 256 && d > p[b + C.BPROXIMITY];
          p[b + C.BPROXIMITY] = d;
        }
      }
      if (explode) {
        if (!forced && !type.arcing && !type.homing) {
          p[b] = p[b + C.BTO_X];
          p[b + 1] = p[b + C.BTO_Y];
        }
        p[b + C.BACTIVE] = 0;
        p[b + C.BIMPACT] = 1;
        p[b + C.BEXPLODED] = this.frame;
      }
      else {
        p[b] = x;
        p[b + 1] = y;
        if (p[b + C.BTYPE] === 1 && p[b + C.BDAMAGE] > 5)
          p[b + C.BDAMAGE]--;
      }
    }
  }
  private damage(id: number, raw: number, warhead: number, x: number, y: number, source: number) {
    const at = id * U.WORDS, c = id * C.CWORDS, u = this.units, s = this.state, type = combatTypes[u[at + U.UTYPE]];
    if ((u[at + U.UHEALTH] <= 0 || u[at + U.UATTACHED] !== 0) || type.immune || id === source)
      return 0;
    if(WALLS[type.name])return 0;
    const cell=Math.trunc(y/256)*this.setup.grid.width+Math.trunc(x/256);
    const direct=u[at+U.UDOMAIN]===2&&this.buildingAt(cell)===id;
    const d = direct?0:distance(x, y, u[at], u[at + 1]);
    if (d >= 384 || !direct&&(Math.abs(Math.floor(x / 256) - Math.floor(u[at] / 256)) > 1 || Math.abs(Math.floor(y / 256) - Math.floor(u[at + 1] / 256)) > 1))
      return 0;
    if(u[at+U.UDOMAIN]===1){if(warhead===1)raw*=2;if(u[at+U.UALTITUDE]>0)raw=Math.trunc(raw/2);}
    if(type.name==='BOAT'&&warhead===4)raw=u[at+U.UHEALTH]*3;
    if(type.name==='SAM'&&s[c+C.CSAM]===0)raw=Math.trunc(raw/2)+1;
    // BUILDING.CPP Take_Damage: the campaign Temple is vulnerable to the ion cannon.
    if(this.setup.campaignLevel!==undefined&&type.name==='TMPL'&&warhead===5)raw+=Math.trunc(raw/2);
    let damage = modifyDamage(s[c + C.CPRONE] ? raw >> 1 : raw, warhead, type.armor, d);
    if (damage && type.name === 'E4')
      damage += modifyDamage(5, warhead, type.armor, d);
    return damage;
  }
  /** COMBAT.CPP, Explosion_Damage: center first, then compass order, capped at 32 objects. */
  private victims(x: number, y: number, source: number) {
    const result: number[] = [], cx = Math.floor(x / 256), cy = Math.floor(y / 256);
    for (const [dx, dy] of [[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]) {
      for (let id = 0; id < this.setup.units.length; id++) {
        const at = id * U.WORDS;
        const cell=(cy+dy)*this.setup.grid.width+cx+dx,building=this.units[at+U.UDOMAIN]===2;
        if (id !== source && !result.includes(id) && (this.units[at + U.UHEALTH] > 0 && this.units[at + U.UATTACHED] === 0) && this.units[at+U.UALTITUDE]<16 &&
          (building?this.buildingAt(cell)===id:Math.floor(this.units[at] / 256) === cx + dx && Math.floor(this.units[at + 1] / 256) === cy + dy))
          result.push(id);
        if (result.length === 32)
          return result;
      }
    }
    return result;
  }
  /** Damage sums commute; the lowest projectile index owns simultaneous-hit attribution. */
  private resolve() {
    const u = this.units, s = this.state, p = this.projectiles, deaths: number[] = [];
    const totals = new Int32Array(this.setup.units.length), causes = new Int32Array(totals.length).fill(-1);
    for (let b = 0; b < p.length; b += C.BWORDS)
      if (p[b + C.BIMPACT]) {
        const target=p[b+C.BTARGET];
        if(target>=0&&u[target*U.WORDS+U.UDOMAIN]===1&&u[target*U.WORDS+U.UALTITUDE]>=16){
          if(u[target*U.WORDS+U.UHEALTH]>0&&distance(p[b],p[b+1],...this.point(target))<128){
            const damage=modifyDamage(Math.trunc(p[b+C.BDAMAGE]/2),bullets[p[b+C.BTYPE]].warhead,combatTypes[u[target*U.WORDS+U.UTYPE]].armor,0);
            if(damage&&causes[target]<0)causes[target]=b;totals[target]+=damage;
          }
          continue;
        }
        const wallId=this.buildingAt(Math.trunc(p[b+1]/256)*this.setup.grid.width+Math.trunc(p[b]/256));
        if(wallId>=0){const wall=WALLS[MOVEMENT[u[wallId*U.WORDS+U.UTYPE]].name],warhead=warheads[bullets[p[b+C.BTYPE]].warhead],raw=p[b+C.BDAMAGE];
          if(wall&&(warhead.wall||wall.wood&&warhead.wood)&&(raw>=wall.points||randomWord(this.setup.seed,this.frame,b/C.BWORDS,195)%(wall.points+1)<raw)){
            totals[wallId]++;if(causes[wallId]<0)causes[wallId]=b;
          }}
        for (const id of this.victims(p[b], p[b + 1], p[b + C.BSOURCE])) {
          const d = this.damage(id, p[b + C.BDAMAGE], bullets[p[b + C.BTYPE]].warhead, p[b], p[b + 1], p[b + C.BSOURCE]);
          if (d && causes[id] < 0)
            causes[id] = b;
          totals[id] += d;
        }
      }
    for (const [index, blast] of this.explosions.entries()) {
      if (blast.frame !== this.frame) throw new Error('Explosion must resolve on its recorded tick');
      for (const id of this.victims(blast.x, blast.y, blast.source)) {
        const d = this.damage(id, blast.damage, blast.warhead, blast.x, blast.y, blast.source);
        if (d && causes[id] < 0) causes[id] = p.length + index;
        totals[id] += d;
      }
      const wallId=this.buildingAt(Math.trunc(blast.y/256)*this.setup.grid.width+Math.trunc(blast.x/256));
      if(wallId>=0){const wall=WALLS[MOVEMENT[u[wallId*U.WORDS+U.UTYPE]].name],wh=warheads[blast.warhead];
        if(wall&&(wh.wall||wall.wood&&wh.wood)&&(blast.damage>=wall.points||randomWord(this.setup.seed,this.frame,p.length/C.BWORDS+index,195)%(wall.points+1)<blast.damage)){
          totals[wallId]++;if(causes[wallId]<0)causes[wallId]=p.length+index;
        }
      }
    }
    for (let id = 0; id < totals.length; id++){
      const at=id*U.WORDS;
      if(u[at+U.UBOMB_TICK]===this.frame&&u[at+U.UHEALTH]>0){
        u[at+U.UBOMB_TICK]=0;const source=u[at+U.UBOMB_SOURCE]-1;
        this.injure(id,this.damage(id,5000,3,u[at],u[at+1],source),3,source,deaths);
      }
      if (totals[id]&&u[at+U.UHEALTH]>0) {
        const b = causes[id], blast = b >= p.length ? this.explosions[b-p.length] : undefined;
        this.injure(id, totals[id], blast?.warhead ?? bullets[p[b + C.BTYPE]].warhead, blast?.source ?? p[b + C.BSOURCE], deaths);
      }
    }
    this.explosions.length = 0;
    // UNIT.CPP/INFANTRY.CPP, Take_Damage: secondary explosions finish in the same tick.
    for (let i = 0; i < deaths.length; i++) {
      const id = deaths[i], at = id * U.WORDS, c = id * C.CWORDS, type = combatTypes[u[at + U.UTYPE]];
      const raw = type.explosion === ANIMATION_IDS.ANIM_NAPALM3 ? 200 : type.name === 'E2' ? 30 : ['E4', 'E5'].includes(type.name) ? 80 : 0;
      const warhead = type.explosion === ANIMATION_IDS.ANIM_NAPALM3 || type.name === 'E4' ? 3 : 1;
      if (raw)
        for (const other of this.victims(u[at], u[at + 1], type.name === 'FTNK' ? s[c + C.CKILLER] : -1)) {
          const source = type.name === 'FTNK' ? s[c + C.CKILLER] : -1;
          const d = this.damage(other, raw, warhead, u[at], u[at + 1], source);
          if (d)
            this.injure(other, d, warhead, source, deaths);
        }
    }
    this.movement.occupy();
    for (const dead of deaths.sort((a, b) => a - b))
      this.survivor(dead);
    this.movement.occupy();
    for (let id = 0; id < this.setup.units.length; id++) {
      const parent = this.setup.crewParents?.[id] ?? -1;
      if (parent >= 0 && s[parent * C.CWORDS + C.CDEATH] === this.frame && u[id * U.WORDS + U.UHEALTH] > 0)
        this.scatterSurvivor(id);
    }
  }
  private injure(id: number, amount: number, warhead: number, source: number, deaths: number[]) {
    const u = this.units, s = this.state, at = id * U.WORDS, c = id * C.CWORDS;
    const received=amount>0;
    amount=this.scaleDamage(amount,u[at+U.UOWNER]);
    if(amount===0&&!received)return;
    const wall=WALLS[MOVEMENT[u[at+U.UTYPE]].name];if(wall){s[c+C.CWALL]+=amount;amount=s[c+C.CWALL]>=wall.levels?u[at+U.UHEALTH]:0;}
    if(u[at+U.UDOMAIN]===2&&amount>0)s[c+C.CWARHEAD]=warhead;
    if(received){s[c+C.CHIT_FRAME]=this.frame;s[c+C.CHIT_SOURCE]=source+1;}
    if(amount>0&&u[at+U.UCLOAK]===2){u[at+U.UCLOAK]=1;u[at+U.UCLOAK_STAGE]=19;}
    u[at + U.UHEALTH] = Math.max(0, u[at + U.UHEALTH] - amount);
    if (u[at + U.UHEALTH] === 0) {
      s[c + C.CDEATH] = this.frame;
      s[c + C.CWARHEAD] = warhead;
      s[c + C.CKILLER] = source;
      s[c + C.CTARGET] = -1;
      s[c + C.CFIRE] = -1;
      this.movement.goals[id] = this.movement.pathGoals[id] = -1;
      u[at + U.UDEST] = u[at + U.UMIDDLE] = u[at + U.UTRACK] = u[at + U.UJUMP] = -1;
      u[at + U.UDESIRED] = u[at + U.UFACE];
      deaths.push(id);
    }
    else {
      if (u[at + U.UKIND] && amount>0) {
        // INFANTRY.CPP Take_Damage; INFANTRY.H FEAR_*.
        const fear = s[c + C.CFEAR], type = combatTypes[u[at + U.UTYPE]];
        s[c + C.CFEAR] = source >= 0 && fear < 100 ? (type.fraidy ? 200 : 100) :
          Math.min(255, fear + (u[at + U.UHEALTH] * 2 > MOVEMENT[u[at + U.UTYPE]].strength ? 2 : 10));
        s[c + C.CFIRE] = -1;
      }
      // BUILDING.CPP Take_Damage, with the default IsSmartDefense option disabled.
      if(u[at+U.UDOMAIN]===2){
        if(source>=0&&MOVEMENT[u[at+U.UTYPE]].name!=='SAM'&&!areAllied(this.setup, u[at+U.UOWNER], u[source*U.WORDS+U.UOWNER])
          &&combatTypes[u[at+U.UTYPE]].primary>=0&&(s[c+C.CTARGET]===-1||!this.inRange(id,s[c+C.CTARGET]))){
          if(u[at+U.UOWNER]!==this.humanOwner&&u[source*U.WORDS+U.UDOMAIN]!==1){s[c+C.CTARGET]=source;s[c+C.CMISSION]=C.ATTACK;}
          else if(u[at+U.UFACE]===u[at+U.UDESIRED])u[at+U.UDESIRED]=randomWord(this.setup.seed,this.frame,id,196)%256;
        }
        return;
      }
      // FOOT.CPP, Take_Damage: human guards retaliate only in range; computer guards may pursue.
      if(source>=0&&s[c+C.CMISSION]===C.STICKY)s[c+C.CMISSION]=this.idleMission(id);
      if (source >= 0 && !areAllied(this.setup, u[at + U.UOWNER], u[source * U.WORDS + U.UOWNER]) &&
        combatTypes[u[at + U.UTYPE]].primary >= 0 && [C.GUARD,C.ATTACK,C.GUARD_AREA,C.AMBUSH].includes(s[c+C.CMISSION]) &&
        (s[c + C.CTARGET] === -1 || u[at + U.UOWNER] !== this.humanOwner && !this.inRange(id, s[c + C.CTARGET]))) {
        if (u[at + U.UOWNER] !== this.humanOwner || this.inRange(id, source)) {
          s[c + C.CTARGET] = source;
          if (u[at + U.UOWNER] !== this.humanOwner)
            s[c + C.CMISSION] = C.HUNT;
        }
      }
    }
  }
  /** TECHNO.CPP Record_The_Kill; INFANTRY.CPP Made_A_Kill; CREW.H Made_A_Kill. */
  private recordKills() {
    const credits=new Int32Array(this.setup.units.length), s=this.state;
    for(let dead=0;dead<credits.length;dead++) {
      const c=dead*C.CWORDS, killer=s[c+C.CKILLER];
      if(s[c+C.CDEATH]===this.frame && killer>=0) credits[killer]++;
    }
    for(let id=0;id<credits.length;id++) {
      const count=credits[id];
      if(!count) continue;
      const c=id*C.CWORDS, old=s[c+C.CKILLS], type=combatTypes[this.units[id*U.WORDS+U.UTYPE]];
      if(this.units[id*U.WORDS+U.UKIND]) {
        let excited=type.name==='RMBO';
        // All same-tick kills share a delay. Enumerate per-source kill ordinals,
        // never the order in which GPU atomics or victim invocations happened.
        for(let i=0;i<count && !excited;i++)
          excited=randomWord(this.setup.seed,this.frame,id,80+i)%6<((old+i)&0xffff);
        if(excited) {s[c+C.CSTOKED]=1;s[c+C.CCOMMENT]=this.frame+30;}
      }
      s[c+C.CKILLS]=(old+count)&0xffff;
    }
  }
  /** UNIT.CPP, Take_Damage: armed crews produce E1; unarmed crews produce a technician. */
  private survivor(dead: number) {
    const u = this.units, at = dead * U.WORDS, type = combatTypes[u[at + U.UTYPE]];
    if (!type.crew || type.transport || randomWord(this.setup.seed, this.frame, dead, 60) % 2)
      return;
    const id = this.setup.crewParents?.indexOf(dead) ?? -1;
    if (id < 0)
      return;
    const start = id * U.WORDS, c = id * C.CWORDS, cell = Math.floor(u[at + 1] / 256) * this.setup.grid.width + Math.floor(u[at] / 256);
    let slot = -1;
    for (let i = 0; i < 5; i++)
      if (!this.movement.occupancy[cell * 5 + i]) {
        slot = i;
        break;
      }
    if (slot < 0)
      return;
    const point = this.movement.point(cell, slot);
    u[start] = point[0];
    u[start + 1] = point[1];
    u[start + U.UCELL] = cell;
    u[start + U.USLOT] = slot;
    u[start + U.UHEALTH] = 5 + randomWord(this.setup.seed, this.frame, dead, 61) % (Math.floor(MOVEMENT[u[start + U.UTYPE]].strength / 2) - 4);
    u[start + U.UFLAGS] = /^C\d+$/.test(MOVEMENT[u[start + U.UTYPE]].name) ? U.TECHNICIAN : 0;
    this.state[c + C.CMISSION] = u[start + U.UOWNER] === this.humanOwner ? C.GUARD : C.HUNT;
    this.movement.occupancy[cell * 5 + slot] = id + 1;
  }
  private scatterSurvivor(id: number) {
    const cell = this.units[id * U.WORDS + U.UCELL];
    // Scatter to an adjacent unoccupied cell, retaining original speed and reservation rules.
    const x = cell % this.setup.grid.width, y = Math.floor(cell / this.setup.grid.width);
    for (const [dx, dy] of [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]) {
      const xx = x + dx, yy = y + dy, next = yy * this.setup.grid.width + xx;
      if (xx >= 0 && yy >= 0 && xx < this.setup.grid.width && yy < this.setup.grid.height && this.setup.grid.edges[next] && !this.movement.occupancy[next * 5])
        this.movement.goals[id] = next;
    }
  }
  /** UNIT.CPP, Per_Cell_Process and DRIVE.CPP, Overrun_Square. */
  private afterMove() {
    const u = this.units, s = this.state;
    const crushed = new Set<number>();
    for (let vehicle = 0; vehicle < this.setup.units.length; vehicle++) {
      const source = vehicle * U.WORDS, cell = u[source + U.UOVERRUN_CELL];
      if (cell < 0 || u[source + U.UHEALTH] <= 0)
        continue;
      const type = combatTypes[u[source + U.UTYPE]];
      if (['ARTY', 'MLRS', 'MSAM'].includes(type.name) && this.movement.goals[vehicle] < 0)
        s[vehicle * C.CWORDS + C.CARM] = 18;
      if (!type.crusher)
        continue;
      for (let id = 0; id < this.setup.units.length; id++) {
        const at = id * U.WORDS, c = id * C.CWORDS;
        if (!u[at + U.UKIND] || (u[at + U.UHEALTH] <= 0 || u[at + U.UATTACHED] !== 0) || areAllied(this.setup, u[source + U.UOWNER], u[at + U.UOWNER]))
          continue;
        if (Math.floor(u[at + 1] / 256) * this.setup.grid.width + Math.floor(u[at] / 256) !== cell)
          continue;
        if (distance(u[at], u[at + 1], u[source + U.UOVERRUN_X], u[source + U.UOVERRUN_Y]) >= 0x80)
          continue;
        if(crushed.has(id))continue;
        crushed.add(id);
        u[at + U.UHEALTH] -= this.scaleDamage(u[at+U.UHEALTH],u[at+U.UOWNER]);
        if(u[at+U.UHEALTH]>0)continue;
        s[c + C.CDEATH] = this.frame;
        s[c + C.CWARHEAD] = C.CRUSHED;
        s[c + C.CKILLER] = vehicle;
        s[c + C.CHIT_FRAME] = this.frame; s[c + C.CHIT_SOURCE] = vehicle + 1;
        s[c + C.CTARGET] = s[c + C.CFIRE] = -1;
        this.movement.goals[id] = this.movement.pathGoals[id] = -1;
        u[at + U.UDEST] = u[at + U.UMIDDLE] = u[at + U.UTRACK] = u[at + U.UJUMP] = -1;
        u[at + U.UDESIRED] = u[at + U.UFACE];
        uncloakUnit(u,vehicle,this.frame);
      }
    }
  }
  /** Post-movement phase, shared by normal ticks and recorded cell-crossing checks. */
  resolveStep() {
    this.afterMove();
    finishSpecialInfantry(this);cloakContacts(this,(id,target)=>this.inRange(id,target));
    for (let id = 0; id < this.setup.units.length; id++)
      this.fire(id);
    this.fly();
    this.resolve();
    this.recordKills();
    this.sight.step(this.units);
  }
  step(commands: readonly (U.UnitCommand | C.AttackCommand)[] = []) {
    prepareSpecialInfantry(this);advanceCloak(this);
    this.indexTargets();
    this.updateBuildingMuzzles();
    this.prepare();
    this.updateBuildingMuzzles();
    this.ultraHunt?.update();
    this.ultraHunt?.advance();
    this.movement.step();
    this.resolveStep();
    for (const command of commands) {
      if (command.frame !== this.frame)
        throw new Error('Commands must be submitted on their recorded tick');
      for (const id of command.ids) {
        const at = id * U.WORDS, c = id * C.CWORDS;
        if (this.units[at + U.UHEALTH] <= 0)
          continue;
        const type=combatTypes[this.units[at+U.UTYPE]],target=command.target??-1;
        if(command.kind!=='scatter')this.units[at+U.USCATTER_GOAL]=0;
        let special=command.kind==='capture'?1:command.kind==='sabotage'?2:0;
        if(command.kind==='attack'&&target>=0&&this.units[target*U.WORDS+U.UDOMAIN]===2){
          const name=MOVEMENT[this.units[target*U.WORDS+U.UTYPE]].name;
          if(type.name==='E6'&&canCaptureBuilding(name,this.setup.campaignLevel)&&!areAllied(this.setup, this.units[at+U.UOWNER], this.units[target*U.WORDS+U.UOWNER]))special=1;
          if(type.name==='RMBO')special=2;
        }
        if(command.kind==='attack'&&target>=0&&type.name==='E6'&&MOVEMENT[this.units[target*U.WORDS+U.UTYPE]].name==='TRAN')special=1;
        if(special===1&&(type.name!=='E6'||target<0||areAllied(this.setup, this.units[at+U.UOWNER], this.units[target*U.WORDS+U.UOWNER])))continue;
        const attack=!special&&(command.kind==='attack'||command.kind==='attack-ground');
        // INFANTRY.CPP, What_Action: an unarmed engineer cannot attack an allied building.
        if(attack&&type.name==='E6')continue;
        if(attack && (type.name==='SAM' || this.units[at+U.UDOMAIN]===1 && type.primary<0))continue;
        if(this.units[at+U.UDOMAIN]===0)this.units[at+U.UFLAGS]|=U.PLAYER_ORDER;
        this.state[c + C.CTARGET] = attack ? command.kind === 'attack' ? command.target! : -command.target! - 2 : -1;
        this.units[at+U.UABILITY_MODE]=special;this.units[at+U.UABILITY_TARGET]=special?command.target!+1:0;
        if(special===2)this.state[c+C.CSABOTAGE]=this.frame;
        this.units[at+U.UABILITY_ENTRY]=0;this.units[at+U.UABILITY_ORIGIN]=0;
        this.state[c + C.CMISSION] = attack ? C.ATTACK : command.kind === 'move'||special ? C.MOVE : C.GUARD;
        this.state[c+C.CSUSPENDED_MISSION]=0;this.units[at+U.UOBSTRUCTION]=0;
        this.state[c + C.CSCAN] = 0;
        this.state[c + C.CAPPROACH_GOAL] = -1;
        this.state[c + C.CLOCAL_ROUTE] = 0;
        this.state[c + C.CLOCAL_WAIT] = 0;
        this.state[c + C.CLOCAL_DEST] = -1;
        this.state[c + C.CROUTE_LENGTH] = 0;
        this.state[c + C.CFIRE] = -1;
        this.movement.goals[id] = command.kind === 'move' ? command.target! : -1;
        this.movement.pathGoals[id] = -1;
        if (command.kind === 'scatter')
          this.movement.scatter(id);
        this.units[at + U.UWAIT] = 0;
        this.units[at + U.URETRIES] = 10;
        this.units[at + U.UROUTE] = -1;
      }
    }
  }
  buffers() { return [...this.movement.buffers(), this.state, this.projectiles, this.sight.mapped, ...(this.ultraHunt?.buffers()??[])]; }
}
