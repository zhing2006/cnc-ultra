# AGENTS.md

C&C Ultra rebuilds the original Command & Conquer (1995) in the browser. Rendering uses Three.js on WebGPU, and the game simulation runs in WebGPU compute shaders. Overview, requirements and license: [README.md](README.md).

The constitutions in [`docs/constitution/`](docs/constitution/README.md) set the product scope and the technical and design principles. They take precedence over this file and over task descriptions. When a task conflicts with them, stop and ask.

## Commands

- `pnpm install`: install dependencies.
- `pnpm dev`: start the dev server at http://127.0.0.1:5173.
- `pnpm check`: type-check TypeScript and Svelte with svelte-check.
- `pnpm test`: run the unit tests (Vitest), `src/**/*.test.ts`.
- `pnpm test:e2e`: run the browser tests (Playwright) in `tests/`. They need full Chromium, which has WebGPU in new headless mode; install it once with `pnpm exec playwright install chromium`.
- `pnpm build`: type-check, then build into `dist/`.
- `refs/fetch.ps1` on Windows, `refs/fetch.sh` elsewhere: download the game data and the reference source code into `refs/`.

Before reporting a task as done, run `pnpm check`, `pnpm test` and `pnpm test:e2e`, and report what each one printed, failures included.

## Stack

- TypeScript, Svelte 5 with bits-ui for headless UI components, Vite, Vitest, Playwright, pnpm, Node.js 24 or later.
- Three.js `WebGPURenderer` from `three/webgpu`, with shaders and compute kernels in TSL. WebGPU only: there is no WebGL fallback, and no code may depend on the WebGL backend.
- Dependency versions are pinned exactly. Use the latest release of each package unless it conflicts with another; TypeScript stays on 6.x because svelte-check does not support 7. pnpm refuses releases younger than a day (`minimumReleaseAgeStrict`); when it does, pin the previous release instead of adding a `minimumReleaseAgeExclude` entry.

## Layout

- `src/engine/`: the engine. Rendering, the GPU simulation framework and generic systems such as flow fields and spatial hashing. It is written from scratch, contains no code ported from the original game or from other C&C projects, and never imports from `src/game/`.
- `src/game/`: everything specific to C&C, such as file formats, game rules, AI and interface. It may import from `src/engine/`.
- `src/App.svelte`, `src/main.ts`: the app shell.
- `assets/dev/`: a few original MIX files for development and tests, stored in LFS with lower-case names.
- `refs/`: downloaded references. Git ignores everything in it except its index and the fetch scripts.
- `docs/`: design docs in Chinese, including the constitutions and the plans in `docs/plans/`.

## Rules

- Comments and output messages in code, scripts and config files are in English, as is this file. `README.md` is in English and `README_CN.md` in Chinese; keep the two in sync, each with a language switch at the top. Other docs are in Chinese.
- Game rules are ported from EA's original source in `refs/`, cross-checked against the Nyerguds fork. OpenRA and Vanilla Conquer are references for file formats and for cross-checking; do not copy their code.
- Ported code carries a comment naming the original file and function, such as `// Ported from UNIT.CPP, UnitClass::AI`.
- Simulation state is integer fixed-point and deterministic. No floating point in simulation state or in decisions made from it; rendering may use floats. The details are in the technical constitution.
- Read original data at run time through the format parsers in `src/game/`. Do not commit converted or extracted copies of original assets, except reference images for tests.
- Never commit anything from `refs/` other than its index and fetch scripts, and never commit original game files outside `assets/dev/`.
- Ask first before adding a dependency, changing a constitution, moving code across the engine/game boundary or committing new binary files.

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

- Write only tests that can catch meaningful functional errors. Do not write defensive tests, or negative tests merely because something was removed.
- Test against the original game, not the current implementation: file formats against the original source and OpenRA's parsers, rules against the original source, rendering against reference images from an independent source, such as captures of the original game or a decoder other than the one under test. Do not record this project's own output as a golden image.
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
- Design docs and guides describe the current design, constraints and usage. Do not put test results, performance measurements or build-pass records in them; keep measurements in reports and task progress in `docs/plans/`. Do not write “这里新补充了……” or “现在改为……”, or leave notes about moved content. Record changes in commit messages.
- In Simplified Chinese, use “” for quotes, names and section references; 「」 belongs to Traditional Chinese. Use full-width punctuation in Chinese text, and leave code, paths and commands as they are.

## References

Reference layout and download instructions are in [refs/README.md](refs/README.md). When adding a downloaded reference, pin it to the same commit or checksum in both fetch scripts and list it in that index.
