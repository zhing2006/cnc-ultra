# C&C Ultra

[English](README.md) | 中文

C&C Ultra 在浏览器里重做 1995 年的初代《命令与征服》，画面和声音用的都是原版素材。游戏的模拟跑在 WebGPU 的 compute shader 上，所以战场的规模可以远远超过原版引擎。原版的一张地图上通常只有几十个单位，这里要让上万个单位同时作战。

项目刚刚开始。目前页面会打开一个 WebGPU 画布，并把它清成纯色，游戏本身还没有任何部分能运行。

## 运行要求

- 支持 WebGPU 的浏览器，比如新版的 Chrome 或 Edge。
- Node.js 24 或更新的版本，以及 pnpm。

## 开始

```sh
pnpm install
pnpm dev
```

然后打开 http://127.0.0.1:5173。

## 部署

`pnpm build` 会在 `dist/` 里生成一个静态网站，不需要后端，放在任何路径下都能运行。网站要通过 HTTPS 或 localhost 访问，服务器还要返回下面两个响应头，因为页面需要跨源隔离：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

构建产物里不包含原版游戏数据。

## 游戏数据和参考资料

仓库里没有原版的美术、音效和视频，只有 `assets/dev/` 里开发和测试要用的几个 MIX 文件。在 Windows 上运行 `refs/fetch.ps1`，在其他系统上运行 `refs/fetch.sh`，就会把 2007 年发布的 C&C Gold 免费版和参考源码下载到 `refs/`，详见 [refs/README.md](refs/README.md)。

## 许可证

代码采用 GPL-3.0-or-later，见 [LICENSE](LICENSE)。游戏规则将从 Electronic Arts 在 2025 年以 GPL v3 公开的原版源码移植过来，移植的代码还要遵守 EA 在该许可证第 7 条下附加的条款。

Command & Conquer 是 Electronic Arts Inc. 的商标。本项目与 Electronic Arts 没有关联，也没有得到它的认可。原版游戏的美术、音效和视频归 Electronic Arts 所有，不在 GPL 的范围内。
