import { it } from 'vitest';
import { makeReviewBattle, reviewScenarios } from '../../../tests/review-scenarios.ts';

for (const scenario of reviewScenarios) it(scenario.name, () => {
  const battle = makeReviewBattle(scenario);
  if (scenario.resolveOnly) battle.resolveStep();
  else for (let i = 0; i < (scenario.ticks ?? 1); i++) battle.step();
  scenario.verify(battle);
});
