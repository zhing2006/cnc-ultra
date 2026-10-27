import { CELL_LEPTONS } from '../coord.ts';
import { combatTypes, weapons } from '../data/combat.ts';

export interface MapRectangle { x: number; y: number; width: number; height: number }
export interface BattleLayout {
  deployments: [MapRectangle, MapRectangle];
  support: [MapRectangle, MapRectangle];
  mineralFields: [MapRectangle[], MapRectangle[]];
  /** Ground slots after excluding all facility and mineral-field reservations. */
  deploymentCapacity: [number, number];
  battlefield: MapRectangle;
  /** Reserved positions only; range is the existing weapon's value in leptons. */
  navalSupport: { patrol: MapRectangle; front: MapRectangle; range: number };
}
export const inside = (x: number, y: number, rect: MapRectangle) =>
  x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;

/** Position armies, their support and resources together, before terrain decoration. */
export function planBattleLayout(width: number, height: number): BattleLayout {
  const shoreTop = Math.trunc(height * 3 / 4), coastalDepth = 2;
  const gunboat = combatTypes.find(type => type.name === 'BOAT')!;
  const range = weapons[gunboat.primary].range;
  // Leave a cell of range in reserve for movement instead of placing targets at maximum reach.
  const patrolRow = shoreTop + Math.trunc(range / CELL_LEPTONS) - coastalDepth - 1;
  const navalSupport = {
    patrol: { x: 0, y: patrolRow, width, height: 1 },
    front: { x: 0, y: shoreTop - coastalDepth, width, height: coastalDepth },
    range,
  };
  const deploymentWidth = Math.trunc(width / 4), deploymentHeight = Math.trunc(height / 2);
  const gap = 24, center = Math.trunc(width / 2), deploymentY = shoreTop - deploymentHeight;
  const deployments: [MapRectangle, MapRectangle] = [
    { x: center - gap / 2 - deploymentWidth, y: deploymentY, width: deploymentWidth, height: deploymentHeight },
    { x: center + gap / 2, y: deploymentY, width: deploymentWidth, height: deploymentHeight },
  ];
  const battlefield = { x: 0, y: deploymentY, width, height: deploymentHeight };
  const supportFor = (army: MapRectangle, side: number): MapRectangle => ({
    // Behind the army's forward edge, centered on the north-south front to limit return flights.
    x: side === 0 ? army.x + army.width - 28 - 18 : army.x + 18,
    y: army.y + Math.trunc((army.height - 18) / 2),
    width: 28, height: 18,
  });
  const support: [MapRectangle, MapRectangle] = [supportFor(deployments[0], 0), supportFor(deployments[1], 1)];
  const fieldsFor = (base: MapRectangle, side: number): MapRectangle[] => {
    const rx = 25, ry = 9, gap = 8;
    const fieldWidth = rx * 2 + 1;
    const x = side === 0 ? base.x - gap - fieldWidth : base.x + base.width + gap;
    const centerY = base.y + Math.trunc(base.height / 2);
    const offset = Math.trunc(base.height / 2) + gap + ry;
    return [-offset, offset].map(dy => ({ x, y: centerY + dy - ry, width: fieldWidth, height: ry * 2 + 1 }));
  };
  const mineralFields: [MapRectangle[], MapRectangle[]] = [fieldsFor(support[0], 0), fieldsFor(support[1], 1)];
  const excluded = [...support, ...mineralFields.flat()];
  const capacity = (army: MapRectangle) => {
    let cells = 0;
    for (let y = army.y; y < army.y + army.height; y++) for (let x = army.x; x < army.x + army.width; x++) {
      if (!excluded.some(rect => inside(x, y, rect))) cells++;
    }
    return cells;
  };
  return { deployments, support, mineralFields, deploymentCapacity: [capacity(deployments[0]), capacity(deployments[1])], battlefield, navalSupport };
}
