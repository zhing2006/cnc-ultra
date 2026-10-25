# Review instructions

These rules apply to every review of this repository, by people or by agents. They are written for games in general; the last section, This project, supplies what is specific to this one: its reference, its target scale and budget, its hard rules and its tools. The project's own instructions, such as AGENTS.md and the documents it points to, still apply; this file decides what a review reports and at what level.

## What to report

Report real functional defects and real risks. A defect is something a player runs into in normal play. A risk is code that will fail along the planned path of the project: at the scale it targets, or once the features it plans are built. For every finding, describe what goes wrong for the player, or which hard requirement breaks, and how it happens.

Also review performance: whether the CPU and GPU code is the most efficient implementation available for the scale it runs at, not only whether it fits the budget. The performance review section below says what to check and how to level it.

Do not report:

- Edge cases players will hardly ever reach, and problems that only reproduce under contrived conditions. The must-fix items below are the exception: report those however rarely they trigger.
- Hypothetical problems that no current or planned feature leads to.
- Anything the project's automated checks already catch.
- Files the project section excludes, such as downloaded references, lock files and binary assets.

## Levels

Every finding gets one of three levels. Game QA usually ranks bugs as blocker, critical, major, minor and trivial. Here blocker and critical become must-fix, major and minor become defects, and trivial goes to suggestions together with everything else that does not affect players.

### Must fix

A must-fix finding blocks the change:

- The game crashes, hangs or stops responding. It fails to start on a supported platform. A lost graphics device or an uncaught error leaves the game dead.
- A core loop is broken with no way around it: one of the core loops or essential features the project section lists.
- A match or session cannot be finished, or a win or loss is decided wrongly.
- A hard rule of the project is broken, such as determinism where the project requires it, or a rule of its architecture, licensing or assets. The project section lists them.
- The performance budget is broken.

### Defect

A defect is a problem a player will notice in normal play but can work around or play through:

- Behavior that differs from the project's reference, such as an original game it recreates or its design documents, in a way a player would notice: the speed, range or damage of a unit, a cost or a build time, the controls, how a sprite or an effect looks, the timing of a sound.
- Visual or audio glitches in normal play: sprites that flicker, are drawn in the wrong order or at the wrong offset, sounds that are missing or repeat.
- Interface problems that mislead the player, such as a button that does nothing or a wrong cost on display.
- Tests that break the project's testing rules, such as defensive tests, negative tests for removed features, or golden images recorded from the project's own output.
- On a path that runs at the target scale, a cost well above that of a known better implementation, even within the budget, as the performance review section defines it.

### Suggestion

Anything that does not affect players: naming, structure, readability, comments, wording in docs, and smaller performance gains. Report at most five suggestions per review; performance suggestions do not count toward the five. Do not raise a suggestion to a higher level because it seems important.

## Performance budget

The project section gives the budget: the scale the game must sustain, the frame rate, and the hardware it is measured on. A review usually cannot measure it, so report code that clearly breaks it as must-fix:

- Per-frame CPU work that grows with the number of objects on the path that runs at the target scale: per-object loops in script, per-object draw calls, per-object uploads to the GPU.
- Reading state back from the GPU every frame, or waiting for a readback inside the frame loop.
- Work quadratic in the number of objects, such as checking every pair of units for targets or collisions instead of looking them up in a spatial index or an occupancy grid.
- Creating buffers, textures, pipelines or shaders every frame, or anything that recompiles shaders during play.
- Blocking the main thread long enough to drop frames during play, such as decoding an asset archive synchronously in the middle of a match.
- Memory that grows without bound over a session: GPU resources never disposed, listeners never removed, caches without a limit.

Report a measured slowdown with its numbers and the hardware, platform and versions they come from. Without a measurement, describe the cost in objects, frames and bytes, and say that it is unmeasured.

## Performance review

The budget is a floor, not the goal. It has to hold once every planned system is built, so a system that spends twice what a known approach would spend takes budget that later work needs. Every review therefore also asks whether the CPU and GPU code is the most efficient implementation available for the scale it runs at, whether or not it fits the budget today.

What to check:

- Complexity: work per frame or per tick that grows faster than it needs to with units, cells, targets or selected objects, such as nested loops over units and command lists, or full scans where an index, a bitmap or a compacted list would do.
- GPU parallelism: loops in one invocation or one workgroup over data that could be processed in parallel; threads dispatched for idle work where an indirect dispatch or a compacted list would skip it; barriers and atomics that serialize more than the algorithm needs; work repeated every tick or every frame although its inputs have not changed.
- Memory and traffic: buffers that grow with the product of two large counts, such as units and map cells; access patterns that waste bandwidth; uploads and readbacks; and the number of dispatches and passes per tick.
- The game's own CPU code: per-frame and per-tick code on the main thread, such as input, the interface, commands, audio and loading, and game logic kept on the CPU, such as AI and building. Look for allocation per object or per frame on hot paths, which the garbage collector pays for later, and for the cost of encoding many small dispatches.

One exception: code that exists only as a reference for other code is reviewed for correctness only, and the performance budget does not apply to it. An example is a CPU version kept bit-identical to a GPU system for tests, which may use a slower algorithm to stay identical. The project section names such code.

For each finding, give the current cost and the better approach with its expected cost. Measure where possible: GPU timestamp queries or a GPU profiler for GPU work, and a CPU profiler for the main thread, with the hardware and versions. Otherwise estimate in operations, bytes and frames, and say that it is unmeasured. Do not report micro-optimizations without a measurable effect at the planned scale.

Levels: breaking the budget is must-fix, as above. On a path that runs at the target scale, a higher complexity class than needed is a defect, and so is a cost at least twice that of a known approach when that cost matters at that scale; as a guide, 1% of a frame at the target frame rate, about 0.17 ms at 60 fps, on the GPU or the main thread. Smaller gains are suggestions.

## Evidence

- A claim about the reference cites a source the project section accepts. Memory does not count.
- A claim about this project's behavior cites `file:line`. Do not infer behavior from names.
- When a finding cannot be confirmed from the code, say what is missing to confirm it instead of raising its level.

## Report

List the findings from must-fix down, performance findings at their level among the others. For each one give the level, the location, what goes wrong and in which situation, and the evidence. If nothing reaches the bar, say so; do not pad the report.

Review tools with fixed level names map must-fix and defects to Important, and suggestions to Nit.

## This project

C&C Ultra rebuilds the original Command & Conquer (1995) in the browser, with the simulation in WebGPU compute shaders.

- Reference: the 1995 original. A claim about it cites the original source in `refs/source/` by file and function, or a capture of the original game. The 2020 Remastered version and OpenRA's behavior do not count; OpenRA's parsers count only for file formats.
- Planned path and target scale: Ultra mode, the larger maps of the map generator, and the remaining features of the first version in the product constitution.
- Budget: article 7 of the product constitution. Ultra mode runs 20,000 units at 60 frames per second on the development machine, which has an NVIDIA GeForce RTX 5090 D, an AMD Ryzen 9 9950X and the latest Chrome or Edge.
- Platform: a browser with WebGPU.
- Core loops and essential features: building, harvesting, combat, movement and pathfinding, selection and orders, and the features of the first version in the product constitution: a full match on an original map, the single-player campaigns, Ultra mode, the overlays, and the completed computer opponent.
- Hard rules, from AGENTS.md and the constitutions:
  - The simulation is deterministic: no floating point in simulation state or in decisions made from it, no results that depend on thread order or timing, no iteration order that is not fixed feeding the simulation, and no randomness that does not come from the simulation's own seeded generator.
  - No code depends on the WebGL backend.
  - No ported code in `src/engine/`, and `src/engine/` does not import `src/game/`. Ported code carries a comment naming the original file and function.
  - No converted or extracted original assets are committed outside test reference images.
  - No EA trademark in a name meant for release.
  - No dependency is added without approval.
- Testing rules: the testing constitution, `docs/testing.md`.
- Automated checks: `pnpm check`, `pnpm test` and `pnpm test:e2e`.
- Not reviewed: files under `refs/`, `pnpm-lock.yaml`, and the binary files under `assets/`.
- Reference-only code: the CPU versions of the simulation systems (technical constitution, article 15). They stay bit-identical to the GPU versions for the tests, so they may use slower algorithms, such as the GPU's relaxation scheme for flow fields instead of Dijkstra. Their speed is not reviewed.
