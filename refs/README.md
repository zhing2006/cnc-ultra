# 参考资料

这个目录存放下载来的原版游戏数据和参考源码，以及从 OpenRA 导出的参考图。除了本文和几个脚本，目录里的其他内容都不入库。

## 下载

在 Windows 上运行下面任意一条：

```powershell
pwsh refs/fetch.ps1
powershell -ExecutionPolicy Bypass -File refs\fetch.ps1
```

在 macOS 和 Linux 上运行：

```sh
bash refs/fetch.sh
```

脚本需要 curl、git 和 bsdtar。Windows 10 以后自带的 `tar.exe` 和 macOS 的 `tar` 都是 bsdtar。Linux 上常见的 GNU tar 读不了 ISO 镜像，要另外安装 bsdtar，Debian 和 Ubuntu 上的包名是 `libarchive-tools`。也可以用环境变量 `TAR` 指定 bsdtar 的路径。

脚本可以重复运行。下载的文件按 SHA-256 校验，已经下好的会跳过。解出来的数据记着来源文件的校验和，来源没有变就不重新解。源码仓库已经在固定的 commit 上时，也不会重新拉取。全部下完大约占 2.3 GB，其中下载的原始文件约 1.2 GB，解出来的游戏数据约 1.0 GB，源码约 0.2 GB。

## 目录

完整的校验和与 commit 写在两个脚本里。

| 路径 | 内容 | 来源 | 固定版本 |
|---|---|---|---|
| `downloads/gdi95.iso` | C&C Gold 的 GDI 光盘 | [archive.org](https://archive.org/details/gdi-95) | SHA-256 `c90b284d` |
| `downloads/nod95.iso` | C&C Gold 的 Nod 光盘 | [archive.org](https://archive.org/details/gdi-95) | SHA-256 `721df01b` |
| `downloads/cnc-packages.zip` | OpenRA 的免费素材包 | [OpenRA 的镜像](https://www.openra.net/packages/cnc-mirrors.txt) | SHA-256 `a55b2c16` |
| `cnc-gold/gdi/` | GDI 光盘上的游戏数据 | `downloads/gdi95.iso` | |
| `cnc-gold/nod/` | Nod 光盘上的游戏数据 | `downloads/nod95.iso` | |
| `cnc-gold/openra/` | 素材包的全部内容 | `downloads/cnc-packages.zip` | |
| `source/cnc-tiberian-dawn/` | EA 在 2025 年以 GPL v3 公开的 1995 年原版源码 | [electronicarts/CnC_Tiberian_Dawn](https://github.com/electronicarts/CnC_Tiberian_Dawn) | `e0d372d` |
| `source/cnc-remastered-collection/` | 2020 年重制版的 TiberianDawn.dll、RedAlert.dll 和地图编辑器源码 | [electronicarts/CnC_Remastered_Collection](https://github.com/electronicarts/CnC_Remastered_Collection) | `f1f0d42` |
| `source/nyerguds-tiberian-dawn/` | 在原版源码基础上修到能编译、能运行的版本 | [Nyerguds/CnC_Tiberian_Dawn](https://github.com/Nyerguds/CnC_Tiberian_Dawn) | `3c9449e` |
| `source/openra/` | 用 C# 写的重制引擎，资源格式的解析代码可以对照 | [OpenRA/OpenRA](https://github.com/OpenRA/OpenRA) | `release-20250330`（`b4f3d8a`） |
| `source/vanilla-conquer/` | 基于重制版源码的跨平台移植 | [TheAssemblyArmada/Vanilla-Conquer](https://github.com/TheAssemblyArmada/Vanilla-Conquer) | `ce83b59` |
| `openra-png/` | OpenRA 导出的参考图，每个文件一个目录 | `export-png.ts` | |

## 游戏数据

两张光盘是 EA 在 2007 年发布的免费版，MD5 和 [ModDB](https://www.moddb.com/games/cc-gold/downloads) 上公布的一致：GDI 光盘是 `1cb7c6290718c5e729ae1a4a146aa793`，Nod 光盘是 `1dfb2ccae81117b053b60d70e8381250`。

脚本从每张光盘上取出根目录里的 MIX、VQA 和 VQP 文件，再加上 `INSTALL/CCLOCAL.MIX`，文件名全部改成小写。Acrobat Reader、DirectX、Planet Westwood 和桌面主题这几个目录里不是游戏数据，所以没有解出来。两张光盘之间只有 `general.mix` 和 `movies.mix` 不同，其余文件逐字节相同。

`fetch` 脚本另外解开了 OpenRA 的素材包，供格式核对使用，见 `source/openra/mods/cnc-content/installer/downloads.yaml`。完整游戏入口使用下面的 `prepare-data` 脚本准备数据；它直接读取原版光盘，包括 `INSTALL/SETUP.Z` 里的 `update.mix`、`updatec.mix`、`speech.mix`、`transit.mix` 和其他安装文件。`SETUP.Z` 是 InstallShield 3 的安装包，bsdtar 不能解开，脚本会调用固定版本 OpenRA 的 Blast 解码器。解码器只在准备数据时运行，不会打包进网页。

`assets/dev/` 里入库的 `conquer.mix`、`temperat.mix`、`general.mix` 和 `cclocal.mix` 复制自 `cnc-gold/gdi/`，供开发和测试使用。

## 准备完整战役数据

先运行 `fetch`，然后在 Windows 上运行：

```powershell
pwsh refs/prepare-data.ps1
```

macOS 和 Linux 上运行：

```sh
bash refs/prepare-data.sh
```

除了 Node.js 和 bsdtar，还需要 .NET 9 SDK。第一次运行时，如果固定版本的 OpenRA 解码器还没有编译，脚本会先编译它。脚本在提取之前校验两张 ISO 的完整 SHA-256，随后把原始 MIX、VQA 和 VQP 文件放进项目根目录的 `data/`，不转换图像或音频格式。这个目录已经被 Git 忽略。

公共文件放在 `data/`，两张光盘各自的 `general.mix` 和 `movies.mix` 放在 `data/gdi/`、`data/nod/`。脚本还会生成 `data/index.json`，记录文件名与长度。开发服务器优先使用 `assets/dev/` 中已有的文件，其余从 `data/` 读取，并按实际文件生成清单。

部署时，把 `data/` 复制到构建结果 `dist/` 下，与 `index.html` 同级。Vite 不会把游戏数据打进 JavaScript，也不会自动复制它们。托管服务器需要支持 HTTP Range 请求，返回 `206` 和正确的 `Content-Range`，否则大影片不能按段读取。保留相对目录结构后，入口也可以部署在子路径下。页面与数据应使用同源地址，并保留项目要求的 COOP、COEP 响应头。

## 影片和界面动画的参考摘要

`node tests/reference/export-vqa.ts` 调用固定版本 OpenRA 的 `VqaVideo`，生成 GDI 开场、简报、首关行动及胜负影片的逐帧 BGRA 摘要和 PCM 摘要。`node tests/reference/export-wsa.ts` 用同一版本的 LCW、XOR 解码器生成阵营选择和计分动画的摘要。WSA 导出器按文件头分配中间缓冲区，因为 OpenRA 的 `WsaVideo` 在 `CHOOSE.WSA` 第二帧使用的缓冲区太小。

摘要保存在 `tests/reference/`，原始影片和解码后的媒体都不入库。

## 参考图

`export-png.ts` 用 OpenRA 的 `--png` 命令，导出 `assets/dev/` 里的温带地形模板、全部车辆和步兵的 SHP，以及鼠标指针的 `mouse.shp`。导出的 PNG 存在 `openra-png/` 里，可以直接打开看。脚本把每个文件逐帧的宽、高和调色板索引算成 SHA-256，写进 `tests/reference/openra.txt`，格式测试拿这个文件来对照。

```sh
node refs/export-png.ts
```

还没有编译过 OpenRA 的话，脚本会先在 `source/openra/` 里编译，这需要 .NET SDK。OpenRA 的目标框架是 net6.0，用 .NET 9 SDK 也能编译，只会报一个框架过期的警告。

## 源码

EA 的两个仓库都已经归档，是只读的。按照 EA 的说明，原版源码不能完整编译，因为缺少核心引擎库。移植游戏规则时以 `source/cnc-tiberian-dawn/` 为准，用 Nyerguds 的版本交叉核对。OpenRA 和 Vanilla Conquer 只用来对照文件格式和核对行为，不复制它们的代码。
