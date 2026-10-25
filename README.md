# C&C Ultra

English | [中文](README_CN.md)

C&C Ultra rebuilds Command & Conquer (1995) in the browser, using the original art, sound and game rules. The goal is to preserve the original feel while expanding battles to tens of thousands of units.

The current version lets you explore original maps, build a GDI or Nod base, harvest Tiberium, and produce and command ground units and aircraft. Full matches, campaigns and Ultra-scale battles are still in development. See the [milestone progress](docs/tasks/progress.md).

## Try it

Use a browser with WebGPU, such as a recent Chrome or Edge. To run locally, install Node.js 24 or later and pnpm, then run:

```sh
pnpm install
pnpm dev
```

| Page | What to try |
|---|---|
| [Original map](http://127.0.0.1:5173/) | Explore GDI mission 8; units remain still. |
| [Ground combat](http://127.0.0.1:5173/?demo=combat) | Command GDI against a Nod position. |
| [Unit controls](http://127.0.0.1:5173/?demo=units) | Try selection, movement, groups and sight, including Orca, Apache and Chinook flights. |
| [Buildings](http://127.0.0.1:5173/?demo=buildings) | Start with one MCV and 100000 credits. Build to unlock the original production options; add `&faction=nod` for Nod. Enemy transport waves are off until enabled in the demo controls. |
| [Economy opening](http://127.0.0.1:5173/?demo=economy) | Start with one MCV on SCM01EA; add `&faction=nod` for Nod. |
| [Simulation demo](http://127.0.0.1:5173/?demo=simulation) | Move a large group of tanks. |
| [Asset gallery](http://127.0.0.1:5173/?preview=assets) | Browse the original units, buildings and terrain. |

Pages show their progress while loading. Click the battlefield to capture the mouse. Left-click or drag to select units, then click ground to move or an enemy to attack. Shift-click adds or removes a unit; Ctrl+click forces an attack. Right-click clears the selection. Use the wheel to zoom and the screen edges to scroll.

To board an APC or Chinook, select infantry and left-click the transport. To unload, right-click to clear the selection, select the transport, then left-click it again. The original sidebar lists production options for the whole base; selecting a building or aircraft does not replace it with unit commands.

## Keyboard shortcuts

Unit commands apply to the unit-control and combat demos. Use Alt+Enter to enter fullscreen so the browser passes group and bookmark shortcuts to the game.

| Key | Action |
|---|---|
| `Esc` | Release the mouse; leave fullscreen. |
| `Alt+Enter` | Toggle fullscreen. |
| Arrow keys | Scroll the map. |
| `+` / `-` | Zoom in / out. |
| `Ctrl+1`–`Ctrl+9` | Save a group. |
| `1`–`9` | Select a group. |
| `Shift+1`–`Shift+9` | Add a group to the selection. |
| `Alt+1`–`Alt+9` | Select a group and center the view on it. |
| `N` / `Shift+N` | Select and center the next / previous unit. |
| `Home` | Center the view on the selection. |
| `H` | Select the MCV. |
| `D` | Deploy the selected MCV in an economy or building scene. |
| `S` | Stop. |
| `X` | Scatter. |
| `Ctrl+F7`–`Ctrl+F10` | Save a view bookmark. |
| `F7`–`F10` | Jump to a view bookmark. |

## Deployment

Run `pnpm build` and serve `dist/` over HTTPS or localhost. Add a `data/` directory beside `index.html` containing `conquer.mix`, `temperat.mix`, `general.mix`, `cclocal.mix`, `sounds.mix`, `updatec.mix`, `speech.mix`, `tempicnh.mix` and `desert.mix` (for the asset gallery). MIX files are not included in the build.

Use `pnpm test:e2e` for daily browser checks. `pnpm test:acceptance` adds full economy journeys and GPU measurements on NVIDIA and AMD for milestone acceptance. Both commands use an independent server on a free port, so the development server can keep running.

The server must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Vite sets these for development and preview. Deployments containing the original assets are for internal use only.

## Game data and license

Development uses the original game files in `assets/dev/`. See [game data and references](refs/README.md) for download instructions.

Code is licensed under [GPL-3.0-or-later](LICENSE); code ported from EA's source is also subject to its additional terms. The original game art and audio belong to Electronic Arts and are not covered by the code license. Command & Conquer is an Electronic Arts trademark. This project is not affiliated with or endorsed by Electronic Arts.
