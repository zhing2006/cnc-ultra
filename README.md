# C&C Ultra

English | [中文](README_CN.md)

C&C Ultra rebuilds the original Command & Conquer (1995) in the browser, with the original art and sound. The game simulation runs in WebGPU compute shaders, so battles can grow far beyond the original engine. A map in the original usually held a few dozen units; here, tens of thousands are meant to fight at once.

The page reads the original MIX files and shows GDI mission 8 (scg08eb): terrain, tiberium, walls, ground marks, trees, buildings, vehicles and infantry, with house colors and shadows. Water uses the original palette cycle. The view scrolls at the screen edge or with the arrow keys, and zooms in integer steps. Units and buildings remain still and cannot be selected yet.

## Requirements

- A browser with WebGPU, such as a recent Chrome or Edge.
- Node.js 24 or later, and pnpm.

## Getting started

```sh
pnpm install
pnpm dev
```

Then open http://127.0.0.1:5173 and click the view to let the game take the mouse; Esc gives it back.

Use the mouse wheel to zoom around the pointer, or `+` / `-` to zoom around the center of the view. The initial scale fits the window height; manual zoom ranges from 1× to 16×.

Open http://127.0.0.1:5173/?preview=assets for the asset gallery. It tiles the units, buildings or terrain objects, with controls for house colors, facing, building damage and integer scale. Switch between Temperate and Desert to see their native artwork. The cloaking category shows all six visual stages with overlapping trees and buildings.

## Deployment

`pnpm build` writes a static site to `dist/` that needs no backend and runs from any path. Serve it over HTTPS or from localhost, with the two headers the page needs for cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The build does not include the original game data. Put the MIX files the game reads in a `data/` directory next to `index.html`: `conquer.mix`, `temperat.mix`, `general.mix` and `cclocal.mix` from C&C Gold. The asset gallery also needs `desert.mix`. The dev server serves `assets/dev/` at `data/`. The data belongs to Electronic Arts, so keep such a site on an internal network.

## Game data and references

The original art, audio and video are not in this repository, apart from a few MIX files in `assets/dev/` used for development and tests. `refs/fetch.ps1` on Windows or `refs/fetch.sh` elsewhere downloads the 2007 freeware release of C&C Gold and the reference source code into `refs/`; see [refs/README.md](refs/README.md).

## License

The code is licensed under GPL-3.0-or-later; see [LICENSE](LICENSE). Game rules will be ported from the original source code that Electronic Arts released under GPL v3 in 2025, and the ported code is also subject to the additional terms EA attached under section 7 of that license.

Command & Conquer is a trademark of Electronic Arts Inc. This project is not affiliated with or endorsed by Electronic Arts. The original game's art, audio and video belong to Electronic Arts and are not covered by the GPL.
