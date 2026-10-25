# AGENTS.md

C&C Ultra rebuilds the original Command & Conquer (1995) in the browser. Rendering uses Three.js on WebGPU, and the game simulation runs in WebGPU compute shaders. Overview, requirements and license: [README.md](README.md).

The constitutions in `docs/` set the product scope and the technical, design and testing principles; [docs/README.md](docs/README.md) lists them. They take precedence over this file and over task descriptions. When a task conflicts with them, stop and ask.

## Commands

- `pnpm install`: install dependencies.
- `pnpm dev`: start the dev server at http://127.0.0.1:5173. The `dev` and `preview` scripts start Vite with `node` instead of through the `vite` binary, because on Windows that binary is a batch file, and Ctrl+C then leaves cmd's "Terminate batch job (Y/N)?" on screen.
- `pnpm check`: type-check TypeScript and Svelte with svelte-check.
- `pnpm test`: run the unit tests (Vitest), `src/**/*.test.ts`.
- `pnpm test:e2e`: run the daily browser checks with `tests/run.ts`. It starts Vite in-process on a free port, launches one full Chromium, which has WebGPU in new headless mode, and runs the checks side by side. Install Chromium once with `pnpm exec playwright install chromium`.
- `pnpm test:acceptance`: run the daily checks plus full economy, rearming, transport and construction journeys and large-scale GPU measurements on NVIDIA and AMD in turn, sharing one Vite server. It discovers Windows adapters at run time and verifies the actual WebGPU vendor. Reports and screenshots are saved separately under `test-results/nvidia/` and `test-results/amd/`. Reserve this full suite for milestone acceptance; use focused checks while implementing or debugging a feature.
- `pnpm build`: type-check, then build into `dist/`.
- `refs/fetch.ps1` on Windows, `refs/fetch.sh` elsewhere: download the game data and the reference source code into `refs/`.
- `node refs/export-png.ts`: export OpenRA's decoding of the original shapes and templates into `refs/openra-png/` and write their digests to `tests/reference/openra.txt`, which the format tests compare against. It builds OpenRA first if needed, which takes the .NET SDK.

For investigation, review, or documentation/instruction-only tasks, run only the focused checks needed to answer the question or validate the edit. Do not run the full check, unit, browser or GPU acceptance suites merely to close a task, including when temporary diagnostic scripts were created.

For implementation changes to application code, checked-in tests or runtime/build configuration, finish the implementation and focused verification first. Before reporting the implementation as done, run `pnpm check`, `pnpm test` and `pnpm test:e2e`, and report what each one printed, failures included. Follow any narrower test scope or sequencing requested by the user.

At the end of every milestone, run `pnpm test:acceptance` in place of the single-GPU `pnpm test:e2e` run. Both NVIDIA and AMD must pass the functional and CPU/GPU determinism checks. Record both GPUs, driver versions, browser version and measured GPU costs in that milestone's task file. A missing AMD adapter or an unverified GPU selection is an incomplete acceptance run, not a pass. The product constitution's 60 FPS budget still targets the specified NVIDIA development GPU; AMD measurements must not be presented as full-frame performance unless rendering was measured too.

## Stack

- TypeScript, Svelte 5 with bits-ui for headless UI components, Vite, Vitest, Playwright, pnpm, Node.js 24 or later.
- Three.js `WebGPURenderer` from `three/webgpu`, with shaders and compute kernels in TSL. WebGPU only: there is no WebGL fallback, and no code may depend on the WebGL backend.
- Dependency versions are pinned exactly. Use the latest release of each package unless it conflicts with another; TypeScript stays on 6.x because svelte-check does not support 7. pnpm refuses releases younger than a day (`minimumReleaseAgeStrict`); when it does, pin the previous release instead of adding a `minimumReleaseAgeExclude` entry.

## Layout

- `src/engine/`: the engine. Rendering, the GPU simulation framework and generic systems such as flow fields and grid occupancy. It is written from scratch, contains no code ported from the original game or from other C&C projects, and never imports from `src/game/`.
- `src/game/`: everything specific to C&C, such as file formats, game rules, AI and interface. It may import from `src/engine/`.
- `src/App.svelte`, `src/main.ts`: the app shell.
- `assets/dev/`: a few original MIX files for development and tests, stored in LFS with lower-case names. The dev server serves them at `data/`, where the game fetches its data at run time.
- `refs/`: downloaded references. Git ignores everything in it except its index and the fetch scripts.
- `docs/`: docs in Chinese: the constitutions, the roadmap and the writing guide, listed in `docs/README.md`. `docs/tasks/` holds one file per milestone of the roadmap, with its goal, reasons, scope, references and acceptance criteria, and `docs/tasks/progress.md` tracks where each milestone stands.

## Rules

- Comments and output messages in code, scripts and config files are in English, as are this file and `REVIEW.md`. `README.md` is in English and `README_CN.md` in Chinese; keep the two in sync, each with a language switch at the top. Other docs are in Chinese.
- Game rules are ported from EA's original source in `refs/`, cross-checked against the Nyerguds fork. Parts the 1995 original lacks, such as a computer opponent that builds a base, may be ported from the 2020 remaster's source in `refs/`; they still use the 1995 rules and values. OpenRA and Vanilla Conquer are references for file formats and for cross-checking; do not copy their code.
- Ported code carries a comment naming the original file and function, such as `// Ported from UNIT.CPP, UnitClass::AI`.
- Simulation state is integer fixed-point and deterministic. No floating point in simulation state or in decisions made from it; rendering may use floats. The details are in the technical constitution.
- The game needs no backend: it builds to a static site with relative asset paths. The page is cross-origin isolated (`vite.config.ts` sets COOP and COEP), so it can only load resources from other origins that send CORP or CORS headers; do not add external resources.
- Read original data at run time through the format parsers in `src/game/`. Do not commit converted or extracted copies of original assets, except reference images for tests.
- Never commit anything from `refs/` other than its index and fetch scripts, and never commit original game files outside `assets/dev/`.
- Ask first before adding a dependency, changing a constitution or another design doc, moving code across the engine/game boundary or committing new binary files.

## Reviews

Reviews follow [REVIEW.md](REVIEW.md): what to report, the three levels, and the performance budget.

## Commits

- Do not run git commit unless the user explicitly asks for a commit.
- Make each commit one logical change.
- Write commit messages in English, without emoji. The subject line is at most 50 characters, in the imperative mood ("Add MIX reader", not "Added MIX reader"), capitalized and without a trailing period. When the change needs explaining, leave a blank line and write a body wrapped at 72 characters that says what changed and why.
- End every commit message with exactly these two trailers. Replace any attribution your tool adds by default:

  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  Co-Authored-By: GPT <noreply@openai.com>
  ```

## Tests

Tests follow the [testing constitution](docs/testing.md). The core of it:

- Write only tests that can catch meaningful functional errors. Do not write defensive tests, or negative tests merely because something was removed.
- Test against the original game, not the current implementation: file formats against the original source and OpenRA's parsers, rules against the original source, rendering against reference images from an independent source, such as captures of the original game or a decoder other than the one under test. Do not record this project's own output as a golden image.
- When fixing a defect, first write a test that reproduces it and see it fail.
- During feature development, finish the implementation and its tests before running checks. Do not repeatedly run checks after intermediate edits. When debugging a specific problem, run the relevant checks as needed. Once development is complete, run the required checks listed above.
- Run checks in parallel and share state: one Vite server and one browser for all checks, and a page carries on from the previous check's state when that state is the next one's starting point. Prepare separate state only when preconditions conflict. Add browser checks to the list in `tests/run.ts`; `tests/browser.ts` opens a page and fails the check on any console or page error it did not expect.
- Name tests in English.

## Writing

These rules cover Chinese prose: `README_CN.md`, the docs under `docs/` and other Chinese text. Code comments and program output are in English and fall outside them. Chinese prose should read as if a person wrote it. Machine prose gives itself away by trying too hard: it compresses, balances and ornaments, and the reader keeps stopping to decode it. Banning a pattern only brings the habit back in another shape, so correct the urge to sound crafted, not the surface form. The rules are cues for review, not a list of banned words; a paragraph that is clear and reads well needs no change. The core rules follow. Before writing or editing Chinese prose, also read [`docs/writing.md`](docs/writing.md): it holds the remaining rules, examples of the core ones, and the rules for editing existing text.

Facts and certainty come before every other rule:

- Write only what is known. Report performance, compatibility and test results as measured, with the GPU, browser and version; if something has not been measured, write “未实测”.
- Do not raise certainty. “可能” does not become “会”, a planned feature is not a finished one, two things happening together are not cause and effect, and “支持 SHP” is not “SHP 已通过测试”.
- When information is missing, say what is missing. Do not fill the gap with a guess, and do not keep repeating that sources are limited.
- Cite the source of original-game behavior, such as a file and function in the original source, rather than a vague “业界普遍认为” or “据说”.

Then:

- Do not balance clauses. Matched halves, semicolon couplets and an even beat across a paragraph are the strongest mark of machine prose, and they slip through because to the writer they feel like good rhythm. Let sentence length follow the meaning.
- Spell out the logic. When one clause turns against, causes or concedes to another, write the connective, such as “但是”“因为”“虽然”; do not set them side by side for the reader to infer.
- Keep the small grammatical words natural Chinese carries: aspect particles such as “了”“着”“过”, modal verbs, adverbs, result complements. Stripping them makes prose terse and telegraphic. Drop the small words that only add a flourish of contrast or restraint.
- Prefer common two-syllable words such as “已经” and “如果” to clipped single-syllable or classical ones such as “已” and “若”.
- Get to the point and say a thing once. Write no preview sentences such as “下面我们来看看”, no empty background such as “随着技术的不断发展”, and no closing platitudes such as “总之” or “值得期待”. Do not follow a point with a line explaining it, and do not open a section by restating its heading.
- Do not inflate. Cut words that carry no information, such as “标志着”“彰显了”“至关重要”“深入探讨”“无缝”“赋能”, and trailing verdicts such as “体现了……”; such a word may stay where it has its exact meaning. Do not stage contrasts with “不是 X，而是 Y” unless the first half corrects a misreading a reader might really have.
- Write graphics and game terms the way developers use them. Keep established terms such as WebGPU, compute shader, TSL, draw call, storage buffer, MIX and SHP in their original form; do not coin Chinese paraphrases.
- Everything under `docs/` except `docs/tasks/` is a design doc. Design docs hold the high-level design, module boundaries and constraints that are easy to get wrong. They hold no work log, no test results, performance measurements or build-pass records, and nothing the code already says; those, and task progress, go in `docs/tasks/`. In normal work, the only docs you update are the files in `docs/tasks/`, including `progress.md`. Once a design is settled, change it only for a good reason, and give the reason in the commit message. Do not write “这里新补充了……” or “现在改为……”, or leave notes about moved content. Record changes in commit messages.
- In Simplified Chinese, use “” for quotes, names and section references; 「」 belongs to Traditional Chinese. Use full-width punctuation in Chinese text, and leave code, paths and commands as they are.

## References

Reference layout and download instructions are in [refs/README.md](refs/README.md). When adding a downloaded reference, pin it to the same commit or checksum in both fetch scripts and list it in that index.
