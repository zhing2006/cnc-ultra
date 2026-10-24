# Review instructions

These rules apply to every review of this repository, by people or by agents. AGENTS.md and the constitutions in `docs/constitution/` still apply; this file decides what a review reports and at what level.

## What to report

Report real functional defects and real risks. A defect is something a player runs into in normal play. A risk is code that will fail along the planned path of the project: at Ultra scale, on bigger maps, or once the remaining features of the slice in the product constitution are built. For every finding, describe what goes wrong for the player, or which hard requirement breaks, and how it happens.

Do not report:

- Edge cases players will hardly ever reach, and problems that only reproduce under contrived conditions. The must-fix items below are the exception: report those however rarely they trigger.
- Hypothetical problems that no current or planned feature leads to.
- Anything `pnpm check`, `pnpm test` or `pnpm test:e2e` already catches.
- Files under `refs/`, `pnpm-lock.yaml`, and the binary files under `assets/`.

## Levels

Every finding gets one of three levels. Game QA usually ranks bugs as blocker, critical, major, minor and trivial. Here blocker and critical become must-fix, major and minor become defects, and trivial goes to suggestions together with everything else that does not affect players.

### Must fix

A must-fix finding blocks the change:

- The game crashes, hangs or stops responding. The page fails to start in a browser that has WebGPU. A lost WebGPU device or an uncaught error leaves the game dead.
- A core loop is broken with no way around it: building, harvesting, combat, movement and pathfinding, selection and orders, or one of the slice features in the product constitution (a full match on an original map, Ultra mode, the perspective views, the CPU and GPU comparison).
- A match cannot be finished, or a win or loss is decided wrongly.
- The simulation is not deterministic: floating point in simulation state or in decisions made from it, results that depend on thread order or timing, iteration order that is not fixed feeding the simulation, or randomness that does not come from the simulation's own seeded generator.
- A hard rule of the constitutions is broken: code that depends on the WebGL backend; ported code in `src/engine/`, or `src/engine/` importing `src/game/`; ported code without a comment naming the original file and function; converted or extracted original assets committed outside test reference images; an EA trademark in a name meant for release; a dependency added without approval.
- The performance budget below is broken.

### Defect

A defect is a problem a player will notice in normal play but can work around or play through:

- Behavior that differs from the original in a way a player of the original would notice: speed, range, damage, build time or cost of a unit, the controls, how a sprite, a palette or a shadow looks, the timing of a sound.
- Visual or audio glitches in normal play: sprites that flicker, are drawn in the wrong order or at the wrong offset, sounds that are missing or repeat.
- Interface problems that mislead the player, such as a button that does nothing or a wrong cost on display.
- Tests that break the testing constitution: defensive tests, negative tests for removed features, golden images recorded from this project's own output.

### Suggestion

Anything that does not affect players: naming, structure, readability, comments, wording in docs, and performance work that stays within the budget. Report at most five suggestions per review. Do not raise a suggestion to a higher level because it seems important.

## Performance budget

The budget comes from article 7 of the product constitution: Ultra mode runs 20,000 units at 60 frames per second on the development machine, which has an NVIDIA GeForce RTX 5090 D, an AMD Ryzen 9 9950X and the latest Chrome or Edge. A review cannot measure this, so report code that clearly breaks it as must-fix:

- Per-frame CPU work that grows with the number of units on the Ultra path: per-unit JavaScript loops, per-unit draw calls, per-unit uploads to the GPU.
- Reading simulation state back to the CPU every frame, or waiting for a readback inside the frame loop.
- Work quadratic in the number of units, such as checking all pairs for collisions instead of using the spatial hash.
- Creating buffers, textures, pipelines or shaders every frame, or anything that recompiles shaders during play.
- Blocking the main thread long enough to drop frames during play, such as decoding a MIX file synchronously in the middle of a match.
- Memory that grows without bound over a session: GPU resources never disposed, listeners never removed, caches without a limit.

Report a measured slowdown with its numbers and the GPU, browser and version they come from. Without a measurement, describe the cost in units, frames and bytes, and say that it is unmeasured.

## Evidence

- A claim about the original game cites the original source in `refs/source/` by file and function, or a capture of the original game. Memory, the 2020 Remastered version and OpenRA's behavior do not count; OpenRA's parsers count only for file formats.
- A claim about this project's behavior cites `file:line`. Do not infer behavior from names.
- When a finding cannot be confirmed from the code, say what is missing to confirm it instead of raising its level.

## Report

List the findings from must-fix down. For each one give the level, the location, what goes wrong and in which situation, and the evidence. If nothing reaches the bar, say so; do not pad the report.

Review tools with fixed level names map must-fix and defects to Important, and suggestions to Nit.
