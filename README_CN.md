# C&C Ultra

[English](README.md) | 中文

C&C Ultra 在浏览器里重做 1995 年的《命令与征服》，使用原版的美术、声音和游戏规则。目标是保留原版的操作手感，同时把战斗规模扩展到上万个单位。

当前版本可以浏览原版地图，建设 GDI 或 Nod 的基地，采集泰伯利亚矿，生产和指挥地面单位及飞机。完整对战、战役和 Ultra 规模的战斗仍在开发中，详见[里程碑进展](docs/tasks/progress.md)。

## 试玩

需要支持 WebGPU 的浏览器，比如新版 Chrome 或 Edge。在本地运行时，先安装 Node.js 24 或更新版本和 pnpm，再执行：

```sh
pnpm install
pnpm dev
```

| 入口 | 内容 |
|---|---|
| [原版地图](http://127.0.0.1:5173/) | 浏览 GDI 第 8 关，单位保持静止。 |
| [地面战斗](http://127.0.0.1:5173/?demo=combat) | 指挥 GDI 进攻 Nod 阵地。 |
| [单位操作](http://127.0.0.1:5173/?demo=units) | 体验选择、移动、编队和视野，也可以试飞 Orca、Apache 和 Chinook。 |
| [建筑演示](http://127.0.0.1:5173/?demo=buildings) | 从一辆 MCV 和 100000 资金开始，随着建设逐步解锁原版生产选项。增加 `&faction=nod` 可以选择 Nod。敌方运输机波次默认关闭，可以在演示控制区开启。 |
| [经济开局](http://127.0.0.1:5173/?demo=economy) | 在 SCM01EA 上从一辆 MCV 开始，增加 `&faction=nod` 可以选择 Nod。 |
| [模拟测试](http://127.0.0.1:5173/?demo=simulation) | 指挥一大组坦克移动。 |
| [素材预览](http://127.0.0.1:5173/?preview=assets) | 查看原版单位、建筑和地形素材。 |

页面载入时会显示当前进度。点击战场后由游戏控制鼠标，左键点选或框选单位，再点击地面移动，点击敌军攻击。Shift 点选可以添加或取消单个单位，Ctrl 加左键强制攻击。右键清空选择，滚轮缩放，屏幕边缘滚动地图。

登上 APC 或 Chinook 时，先选中步兵，再左键点运输载具。卸载时先右键清空选择，选中运输载具，再左键点它自身。原版侧边栏显示整个基地的生产选项，选中建筑或飞机不会切换成单位命令面板。

## 快捷键

单位命令适用于单位操作和地面战斗场景。请通过 Alt+Enter 进入全屏，让浏览器把编队和视角书签快捷键交给游戏。

| 按键 | 操作 |
|---|---|
| `Esc` | 释放鼠标、退出全屏。 |
| `Alt+Enter` | 切换全屏。 |
| 方向键 | 滚动地图。 |
| `+` / `-` | 放大、缩小。 |
| `Ctrl+1` 至 `Ctrl+9` | 保存编队。 |
| `1` 至 `9` | 选择编队。 |
| `Shift+1` 至 `Shift+9` | 将编队加入当前选择。 |
| `Alt+1` 至 `Alt+9` | 选择编队，并将镜头移过去。 |
| `N` / `Shift+N` | 选择下一个、上一个单位，并将镜头移过去。 |
| `Home` | 将镜头移到当前选择。 |
| `H` | 选择 MCV。 |
| `D` | 在经济开局或建筑场景中展开选中的 MCV。 |
| `S` | 停止。 |
| `X` | 散开。 |
| `Ctrl+F7` 至 `Ctrl+F10` | 保存视角书签。 |
| `F7` 至 `F10` | 跳转到视角书签。 |

## 部署

执行 `pnpm build`，通过 HTTPS 或 localhost 提供 `dist/`。在 `index.html` 旁放置 `data/` 目录，包含 `conquer.mix`、`temperat.mix`、`general.mix`、`cclocal.mix`、`sounds.mix`、`updatec.mix`、`speech.mix`、`tempicnh.mix`，以及素材预览所需的 `desert.mix`。构建产物不包含这些 MIX 文件。

日常浏览器检查使用 `pnpm test:e2e`。里程碑验收使用 `pnpm test:acceptance`，增加完整经济流程和 NVIDIA、AMD 的 GPU 耗时检查。两个命令都使用独立服务和空闲端口，可以保留开发服务供试玩。

服务器必须返回 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`。Vite 的开发和预览服务已经配置这两个响应头。包含原版素材的部署仅供内部使用。

## 游戏数据和许可证

开发时使用 `assets/dev/` 中的原版游戏文件，下载方式见[游戏数据和参考资料](refs/README.md)。

代码采用 [GPL-3.0-or-later](LICENSE)，从 EA 源码移植的代码还须遵守其中的附加条款。原版美术和音频归 Electronic Arts 所有，不在代码许可证范围内。Command & Conquer 是 Electronic Arts 的商标。本项目与 Electronic Arts 没有关联，也没有得到其认可。
