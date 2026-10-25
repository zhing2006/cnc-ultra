import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { loop as Loop } from '../../engine/simulation/loop.ts';
import { Fn, If, int, storage, uniform, ivec2, select,instanceIndex } from 'three/tsl';
import { releaseStorage } from '../../engine/simulation/resources.ts';
import { intMax } from '../../engine/simulation/integer-nodes.ts';
import { distance, movePoint } from '../coord.ts';
import { combatTypes, weapons } from '../data/combat.ts';
import { MOVEMENT, movementType } from '../data/movement.ts';
import { canCaptureBuilding } from '../data/abilities.ts';
import { unitDistance } from '../simulation/units-nodes.ts';
import type { GpuCombat } from '../simulation/combat-gpu.ts';
import { firePoint, type CpuCombat } from '../simulation/combat-cpu.ts';
import * as U from '../simulation/units-state.ts';
import * as C from '../simulation/combat-state.ts';
import { areAllied, alliedOwners } from '../simulation/alliances.ts';
import { TeamRetreatPlanner } from './team-retreat.ts';

/** TEAM.CPP Took_Damage: retain an armed target that can already hit the team's center. */
export function retaliationTarget(battle:CpuCombat,members:readonly number[],target:number,suicide=false){
  if(suicide||!members.length||battle.units[members.at(-1)!*U.WORDS+U.UDOMAIN]===1)return target;
  const u=battle.units,c=battle.state,width=battle.setup.grid.width;
  const alive=members.filter(id=>u[id*U.WORDS+U.UHEALTH]>0&&!u[id*U.WORDS+U.UATTACHED]);
  if(!alive.length)return target;
  const x=Math.trunc(alive.reduce((sum,id)=>sum+u[id*U.WORDS+U.UCELL]%width,0)/alive.length)*256+128;
  const y=Math.trunc(alive.reduce((sum,id)=>sum+Math.trunc(u[id*U.WORDS+U.UCELL]/width),0)/alive.length)*256+128;
  for(const id of members){
    const s=id*C.CWORDS,source=c[s+C.CHIT_SOURCE]-1;
    if(c[s+C.CHIT_FRAME]!==battle.frame||source<0||members.includes(source)||u[source*U.WORDS+U.UHEALTH]<=0)continue;
    if(target>=0){
      const at=target*U.WORDS,p=target*C.CWORDS,type=combatTypes[u[at+U.UTYPE]],dir=type.turret&&u[at+U.UDOMAIN]!==2?c[p+C.CTURRET]:u[at+U.UFACE];
      const point=u[at+U.UDOMAIN]===2?[c[p+C.CMUZZLEX],c[p+C.CMUZZLEY]]:u[at+U.UDOMAIN]===1?movePoint(u[at],u[at+1]-Math.trunc((u[at+U.UALTITUDE]*256+12)/24),dir,64):firePoint(type.name,u[at],u[at+1],dir,c[p+C.CSECOND]);
      if(type.primary>=0&&distance(point[0],point[1],x,y)<=weapons[type.primary].range)continue;
    }
    target=source;
  }
  return target;
}

const TYPE_WORDS=9;
export const TEAM_TARGET_WORDS=6;
function fireOffsets(name:string){
  // TURRET.CPP Fire_Coord, primary weapon: upward offset, forward distance, lateral distance.
  if(name==='HTNK')return [64,192,40];if(name==='FTNK')return [0,48,32];
  if(name==='ARTY')return [64,96,0];if(name==='LTNK')return [32,192,0];if(name==='MTNK')return [48,192,0];
  if(['APC','JEEP','BGGY'].includes(name))return [48,48,0];return [0,0,0];
}

/** TEAM.CPP Coordinate_Attack: the leader chooses a mobile target for the whole team. */
export function teamTarget(battle: CpuCombat, leader: number, mode = 0) {
  if(mode<0)return -1;
  const u = battle.units, c = battle.state, at = leader * U.WORDS;
  const eligible = (id: number) => {
    const p = id * U.WORDS;
    const domain = u[p + U.UDOMAIN], civilian = /^(C\d+|CHAN|DELPHI|MOEBIUS)$/.test(combatTypes[u[p + U.UTYPE]]?.name ?? '');
    const category = mode === 0 ? domain === 0 : mode === 1 ? domain === 2 : mode === 2 ? civilian : true;
    const capturable=u[at+U.UTYPE]!==movementType('E6')||canCaptureBuilding(combatTypes[u[p+U.UTYPE]]?.name??'',battle.setup.campaignLevel);
    return id >= 0 && category && capturable && !areAllied(battle.setup, u[at + U.UOWNER], u[p + U.UOWNER]) && u[p + U.UHEALTH] > 0 && !u[p + U.UATTACHED] && u[p + U.UCLOAK] !== 2 && combatTypes[u[p + U.UTYPE]].targetable && !!c[id * C.CWORDS + C.CSEEN];
  };
  const current = u[at+U.UABILITY_MODE]?u[at+U.UABILITY_TARGET]-1:c[leader * C.CWORDS + C.CTARGET];
  if (eligible(current)) return current;
  let chosen = -1, best = -1;
  for (let id = 0; id < battle.setup.units.length; id++) {
    const p = id * U.WORDS, type = combatTypes[u[p + U.UTYPE]];
    if (!eligible(id)) continue;
    const raw = type.risk + type.reward;
    const score = Math.max(raw ? 2 : 0, Math.trunc((raw + c[id * C.CWORDS + C.CKILLS]) / Math.max(1, distance(u[at], u[at + 1], u[p], u[p + 1]))));
    if (score > best) { best = score; chosen = id; }
  }
  return chosen;
}

export class GpuTeamTargets {
  readonly state: StorageBufferAttribute;
  private readonly orders: StorageBufferAttribute;
  private readonly types: StorageBufferAttribute;
  private readonly teams = uniform(0, 'int');
  private readonly pass;
  private readonly retreatPass;
  private readonly gestureIds:StorageBufferAttribute;
  private readonly gestureAction=uniform(27,'int');
  private readonly gesturePass;
  private retreating=false;
  private readonly retreat:TeamRetreatPlanner;
  private previousTeams=new Map<number,string>();
  get buffers(){return [this.state,this.orders];}
  saveMeta(){return {teams:this.teams.value,previousTeams:[...this.previousTeams],retreating:this.retreating};}
  loadMeta(saved:ReturnType<GpuTeamTargets['saveMeta']>){
    this.previousTeams=new Map(saved.previousTeams);this.teams.value=saved.teams;this.retreating=saved.retreating;
  }
  constructor(private readonly battle: GpuCombat) {
    const count = battle.setup.units.length;
    this.orders = new StorageBufferAttribute(new Int32Array(count * 5 + 1), 1);
    this.state=new StorageBufferAttribute(new Int32Array(count*TEAM_TARGET_WORDS),1);
    this.retreat=new TeamRetreatPlanner(battle);
    const trigBase=combatTypes.length*TYPE_WORDS;
    this.types = new StorageBufferAttribute(Int32Array.from([...combatTypes.flatMap((type,index) => [type.risk + type.reward, Number(type.targetable), Number(/^(C\d+|CHAN|DELPHI|MOEBIUS)$/.test(type.name)),Number(canCaptureBuilding(type.name,battle.setup.campaignLevel)),weapons[type.primary]?.range??-1,...fireOffsets(type.name),Number(type.turret&&MOVEMENT[index].domain!==2)]),...Array.from({length:256},(_,dir)=>movePoint(0,0,dir,128)).flat()]), 1);
    const orders = storage(this.orders, 'int', this.orders.count), types = storage(this.types, 'int', this.types.count).toReadOnly();
    const u = storage(battle.units, 'int', battle.units.count).toReadOnly(), c = storage(battle.state, 'int', battle.state.count);
    this.gestureIds=new StorageBufferAttribute(new Int32Array(count),1);
    const gestures=storage(this.gestureIds,'int',count).toReadOnly();
    this.gesturePass=Fn(()=>{
      const id=int(instanceIndex),at=id.mul(U.WORDS),s=id.mul(C.CWORDS),action=c.element(s.add(C.CACTION));
      // TEAM.CPP AI / INFANTRY.CPP Do_Action: a completed team gestures together.
      If(gestures.element(id).notEqual(0).and(u.element(at.add(U.UKIND)).notEqual(0)).and(u.element(at.add(U.UHEALTH)).greaterThan(0)).and(u.element(at.add(U.UATTACHED)).equal(0))
        .and(action.equal(0).or(action.equal(9)).or(action.equal(10))),()=>{action.assign(this.gestureAction);c.element(s.add(C.CSTAGE)).assign(0);c.element(s.add(C.CFIRE)).assign(-1);});
    })().compute(count);
    const state=storage(this.state,'int',this.state.count),clock=storage(battle.movement.control,'int',2).toReadOnly();
    const goals=storage(battle.movement.goals,'int',count),paths=storage(battle.movement.pathGoals,'int',count);
    const move=(point:Node<'ivec2'>,dir:Node<'int'>,length:Node<'int'>)=>{const at=dir.bitAnd(255).mul(2).add(trigBase);return point.add(ivec2(types.element(at).mul(length).shiftRight(7),types.element(at.add(1)).negate().mul(length).shiftRight(7).negate()));};
    // Keep the terrain/occupancy query in a separate pass to stay within WebGPU's
    // eight-storage-buffer baseline. It runs only while a team is retreating.
    this.retreatPass=Fn(()=>{
      const cursor=int(0).toVar();
      Loop(this.teams,()=>{
        const members=orders.element(cursor),leader=orders.element(cursor.add(4).add(members).sub(1)),history=leader.mul(TEAM_TARGET_WORDS);
        If(orders.element(cursor.add(1)).equal(-2).and(orders.element(cursor.add(2)).notEqual(0).or(state.element(history).notEqual(u.element(leader.mul(U.WORDS).add(U.UGENERATION))))),()=>{
          const center=ivec2(0).toVar(),total=int(0).toVar();
          Loop(members,({i})=>{const member=orders.element(cursor.add(4).add(i)).mul(U.WORDS);If(u.element(member.add(U.UHEALTH)).greaterThan(0).and(u.element(member.add(U.UATTACHED)).equal(0)),()=>{const cell=u.element(member.add(U.UCELL));center.addAssign(ivec2(cell.mod(battle.setup.grid.width),cell.div(battle.setup.grid.width)));total.addAssign(1);});});
          state.element(history.add(3)).assign(this.retreat.find(leader,center.div(intMax(total,int(1)))));
        });
        cursor.addAssign(members.add(4));
      });
    })().compute(1);
    this.pass = Fn(() => {
      const cursor = int(0).toVar();
      Loop(this.teams, () => {
        const members = orders.element(cursor).toVar(), mode = orders.element(cursor.add(1)).toVar(),reset=orders.element(cursor.add(2)).toVar(),suicide=orders.element(cursor.add(3)).toVar();
        orders.element(cursor.add(2)).assign(0);cursor.addAssign(4);
        const leader = orders.element(cursor.add(members).sub(1)), at = leader.mul(U.WORDS), target = int(-1).toVar(), best = int(-1).toVar();
        const history=leader.mul(TEAM_TARGET_WORDS),center=ivec2(0).toVar(),total=int(0).toVar();
        Loop(members,({i})=>{const member=orders.element(cursor.add(i)).mul(U.WORDS);If(u.element(member.add(U.UHEALTH)).greaterThan(0).and(u.element(member.add(U.UATTACHED)).equal(0)),()=>{const cell=u.element(member.add(U.UCELL));center.addAssign(ivec2(cell.mod(battle.setup.grid.width),cell.div(battle.setup.grid.width)));total.addAssign(1);});});
        center.assign(center.div(intMax(total,int(1))));
        If(reset.notEqual(0).or(state.element(history).notEqual(u.element(at.add(U.UGENERATION)))),()=>{
          state.element(history).assign(u.element(at.add(U.UGENERATION)));state.element(history.add(1)).assign(0);state.element(history.add(4)).assign(0);
        });
        center.assign(center.mul(256).add(128));
        const category = (p: import('three/webgpu').Node<'int'>, type: import('three/webgpu').Node<'int'>) => mode.equal(0).and(u.element(p.add(U.UDOMAIN)).equal(0))
          .or(mode.equal(1).and(u.element(p.add(U.UDOMAIN)).equal(2))).or(mode.equal(2).and(types.element(type.mul(TYPE_WORDS).add(2)).notEqual(0))).or(mode.equal(3));
        const capturable=(type:import('three/webgpu').Node<'int'>)=>u.element(at.add(U.UTYPE)).notEqual(movementType('E6')).or(types.element(type.mul(TYPE_WORDS).add(3)).notEqual(0));
        const current = c.element(leader.mul(C.CWORDS).add(C.CTARGET)).toVar();
        If(u.element(at.add(U.UABILITY_MODE)).notEqual(0),()=>{current.assign(u.element(at.add(U.UABILITY_TARGET)).sub(1));});
        const missionTarget=state.element(history.add(4)).sub(1);
        If(missionTarget.greaterThanEqual(0),()=>{
          If(u.element(missionTarget.mul(U.WORDS).add(U.UGENERATION)).equal(state.element(history.add(5))),()=>{current.assign(missionTarget);});
        });
        If(reset.notEqual(0),()=>{current.assign(-1);});
        If(current.greaterThanEqual(int(0)), () => {
          const p = current.mul(U.WORDS), type = u.element(p.add(U.UTYPE));
          If(u.element(p.add(U.UHEALTH)).greaterThan(int(0)).and(category(p,type))
            .and(alliedOwners(battle.setup,u.element(at.add(U.UOWNER)),u.element(p.add(U.UOWNER))).not()).and(u.element(p.add(U.UATTACHED)).equal(int(0)))
            .and(u.element(p.add(U.UCLOAK)).notEqual(int(2))).and(types.element(type.mul(TYPE_WORDS).add(1)).notEqual(int(0))).and(capturable(type)).and(c.element(current.mul(C.CWORDS).add(C.CSEEN)).notEqual(int(0))), () => { target.assign(current); });
        });
        If(mode.greaterThanEqual(0).and(target.lessThan(int(0))), () => {
          Loop(count, ({ i: id }) => {
            const p = id.mul(U.WORDS), type = u.element(p.add(U.UTYPE));
            If(alliedOwners(battle.setup,u.element(at.add(U.UOWNER)),u.element(p.add(U.UOWNER))).not().and(u.element(p.add(U.UHEALTH)).greaterThan(int(0))).and(u.element(p.add(U.UATTACHED)).equal(int(0)))
              .and(category(p,type)).and(u.element(p.add(U.UCLOAK)).notEqual(int(2))).and(types.element(type.mul(TYPE_WORDS).add(1)).notEqual(int(0))).and(capturable(type)).and(c.element(id.mul(C.CWORDS).add(C.CSEEN)).notEqual(int(0))), () => {
              const raw = types.element(type.mul(TYPE_WORDS)), floor = int(0).toVar(); If(raw.notEqual(int(0)), () => { floor.assign(2); });
              const score = intMax(floor, raw.add(c.element(id.mul(C.CWORDS).add(C.CKILLS))).div(intMax(int(1), unitDistance(ivec2(u.element(at), u.element(at.add(1))), ivec2(u.element(p), u.element(p.add(1)))))));
              If(score.greaterThan(best), () => { best.assign(score); target.assign(id); });
            });
          });
        });
        // TEAM.CPP keeps MissionTarget while Target temporarily points at an attacker.
        state.element(history.add(4)).assign(target.add(1));
        If(target.greaterThanEqual(0),()=>{state.element(history.add(5)).assign(u.element(target.mul(U.WORDS).add(U.UGENERATION)));});
        const previous=state.element(history.add(1)).sub(1).toVar();
        If(previous.greaterThanEqual(0),()=>{
          const p=previous.mul(U.WORDS);
          If(u.element(p.add(U.UHEALTH)).greaterThan(0).and(u.element(p.add(U.UATTACHED)).equal(0)).and(u.element(p.add(U.UCLOAK)).notEqual(2)).and(u.element(p.add(U.UGENERATION)).equal(state.element(history.add(2))))
            .and(alliedOwners(battle.setup,u.element(at.add(U.UOWNER)),u.element(p.add(U.UOWNER))).not()),()=>{target.assign(previous);}).Else(()=>{state.element(history.add(1)).assign(0);});
        });
        If(mode.notEqual(-2).and(suicide.equal(0)).and(u.element(at.add(U.UDOMAIN)).notEqual(1)),()=>{
          Loop(members,({i})=>{
            const member=orders.element(cursor.add(i)),source=c.element(member.mul(C.CWORDS).add(C.CHIT_SOURCE)).sub(1),retaliate=int(1).toVar();
            If(c.element(member.mul(C.CWORDS).add(C.CHIT_FRAME)).equal(clock.element(0)).and(source.greaterThanEqual(0)),()=>{
              Loop(members,({i:j})=>{If(orders.element(cursor.add(j)).equal(source),()=>{retaliate.assign(0);});});
              If(u.element(source.mul(U.WORDS).add(U.UHEALTH)).lessThanEqual(0),()=>{retaliate.assign(0);});
              If(target.greaterThanEqual(0),()=>{
                const p=target.mul(U.WORDS),s=target.mul(C.CWORDS),type=u.element(p.add(U.UTYPE)),row=type.mul(TYPE_WORDS),range=types.element(row.add(4));
                const point=ivec2(u.element(p),u.element(p.add(1))).toVar();
                const dir=select(types.element(row.add(8)).notEqual(0),c.element(s.add(C.CTURRET)),u.element(p.add(U.UFACE)));
                If(u.element(p.add(U.UDOMAIN)).equal(2),()=>{point.assign(ivec2(c.element(s.add(C.CMUZZLEX)),c.element(s.add(C.CMUZZLEY))));})
                .ElseIf(u.element(p.add(U.UDOMAIN)).equal(1),()=>{point.y.subAssign(u.element(p.add(U.UALTITUDE)).mul(256).add(12).div(24));point.assign(move(point,dir,int(64)));})
                .Else(()=>{
                  If(u.element(p.add(U.UKIND)).notEqual(0).and(type.notEqual(movementType('E4'))),()=>{point.y.subAssign(53);});
                  point.assign(move(point,int(0),types.element(row.add(5))));
                  point.assign(move(point,dir.add(select(c.element(s.add(C.CSECOND)).notEqual(0),int(64),int(192))),types.element(row.add(7))));
                  point.assign(move(point,dir,types.element(row.add(6))));
                });
                If(range.greaterThanEqual(0).and(unitDistance(point,center).lessThanEqual(range)),()=>{retaliate.assign(0);});
              });
              If(retaliate.notEqual(0),()=>{target.assign(source);state.element(history.add(1)).assign(source.add(1));state.element(history.add(2)).assign(u.element(source.mul(U.WORDS).add(U.UGENERATION)));});
            });
          });
        });
        Loop(members, ({ i }) => {
          const id = orders.element(cursor.add(i)), p = id.mul(C.CWORDS);
          If(mode.greaterThanEqual(0).or(target.greaterThanEqual(0)).and(u.element(id.mul(U.WORDS).add(U.UHEALTH)).greaterThan(int(0))).and(u.element(id.mul(U.WORDS).add(U.UABILITY_MODE)).equal(0)).and(u.element(id.mul(U.WORDS).add(U.UENTER)).equal(0))
            .and(u.element(id.mul(U.WORDS).add(U.UOWNER)).notEqual(0).or(u.element(id.mul(U.WORDS).add(U.UFLAGS)).bitAnd(U.PLAYER_ORDER).equal(0))), () => { c.element(p.add(C.CMISSION)).assign(C.ATTACK); c.element(p.add(C.CTARGET)).assign(target); });
          If(mode.equal(-2).and(u.element(id.mul(U.WORDS).add(U.UHEALTH)).greaterThan(0)).and(u.element(id.mul(U.WORDS).add(U.UATTACHED)).equal(0)),()=>{
            const destination=state.element(history.add(3)),point=ivec2(destination.mod(battle.setup.grid.width),destination.div(battle.setup.grid.width)).mul(256).add(128);
            const far=unitDistance(ivec2(u.element(id.mul(U.WORDS)),u.element(id.mul(U.WORDS).add(1))),point).div(256).greaterThan(2);
            If(far,()=>{If(goals.element(id).notEqual(destination),()=>{goals.element(id).assign(destination);paths.element(id).assign(-1);});c.element(p.add(C.CMISSION)).assign(C.MOVE);c.element(p.add(C.CTARGET)).assign(-1);})
            .ElseIf(c.element(p.add(C.CMISSION)).equal(C.MOVE),()=>{goals.element(id).assign(-1);paths.element(id).assign(-1);c.element(p.add(C.CMISSION)).assign(C.GUARD);});
          });
        });
        cursor.addAssign(members);
      });
    })().compute(1);
  }
  set(groups: readonly number[][], modes?: readonly number[], epochs?:readonly string[], suicides?:readonly boolean[]) {
    const active = groups.map((group, index) => ({ group, mode: modes?.[index] ?? 0,epoch:epochs?.[index]??'',suicide:suicides?.[index]??false })).filter(({group}) => group.length);
    const next=new Map<number,string>();
    const values = active.flatMap(({group,mode,epoch,suicide}) => {const leader=group.at(-1)!,key=`${mode}:${epoch}`;next.set(leader,key);return [group.length, mode,Number(this.previousTeams.get(leader)!==key),Number(suicide), ...group];});
    this.previousTeams=next;
    this.retreating=active.some(({mode})=>mode===-2);
    if (values.length > this.orders.count) throw new Error('Campaign team membership exceeds actor capacity');
    const array = this.orders.array as Int32Array;
    if (values.some((value, i) => array[i] !== value)) { array.set(values); this.orders.addUpdateRange(0, values.length); this.orders.needsUpdate = true; }
    this.teams.value = active.length;
  }
  step() { if (this.teams.value) {if(this.retreating)this.battle.renderer.compute(this.retreatPass);this.battle.renderer.compute(this.pass);} }
  gesture(ids:readonly number[],variant:number){
    const values=this.gestureIds.array as Int32Array;values.fill(0);for(const id of ids)values[id]=1;
    this.gestureIds.needsUpdate=true;this.gestureAction.value=variant?29:27;this.battle.renderer.compute(this.gesturePass);
  }
  prepare() { return this.battle.renderer.compileComputeAsync([this.retreatPass,this.pass,this.gesturePass]); }
  dispose() { this.pass.dispose();this.retreatPass.dispose();this.gesturePass.dispose();this.retreat.dispose(); releaseStorage(this.battle.renderer, [this.orders, this.types,this.state,this.gestureIds]); }
}
