# C&C Ultra

English | [中文](README_CN.md)

C&C Ultra rebuilds the original Command & Conquer (1995) in the browser, with the original art and sound. The game simulation runs in WebGPU compute shaders, so battles can grow far beyond the original engine. A map in the original usually held a few dozen units; here, tens of thousands are meant to fight at once.

The project has just started. The page opens a WebGPU canvas and clears it to a solid color; none of the game runs yet.

## Requirements

- A browser with WebGPU, such as a recent Chrome or Edge.
- Node.js 24 or later, and pnpm.

## Getting started

```sh
pnpm install
pnpm dev
```

Then open http://127.0.0.1:5173.

## Game data and references

The original art, audio and video are not in this repository, apart from a few MIX files in `assets/dev/` used for development and tests. `refs/fetch.ps1` on Windows or `refs/fetch.sh` elsewhere downloads the 2007 freeware release of C&C Gold and the reference source code into `refs/`; see [refs/README.md](refs/README.md).

## License

The code is licensed under GPL-3.0-or-later; see [LICENSE](LICENSE). Game rules will be ported from the original source code that Electronic Arts released under GPL v3 in 2025, and the ported code is also subject to the additional terms EA attached under section 7 of that license.

Command & Conquer is a trademark of Electronic Arts Inc. This project is not affiliated with or endorsed by Electronic Arts. The original game's art, audio and video belong to Electronic Arts and are not covered by the GPL.
