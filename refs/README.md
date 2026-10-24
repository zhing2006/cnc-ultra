# 参考资料

这个目录存放下载来的原版游戏数据和参考源码。除了本文和两个下载脚本，目录里的其他内容都不入库。

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

## 游戏数据

两张光盘是 EA 在 2007 年发布的免费版，MD5 和 [ModDB](https://www.moddb.com/games/cc-gold/downloads) 上公布的一致：GDI 光盘是 `1cb7c6290718c5e729ae1a4a146aa793`，Nod 光盘是 `1dfb2ccae81117b053b60d70e8381250`。

脚本从每张光盘上取出根目录里的 MIX、VQA 和 VQP 文件，再加上 `INSTALL/CCLOCAL.MIX`，文件名全部改成小写。Acrobat Reader、DirectX、Planet Westwood 和桌面主题这几个目录里不是游戏数据，所以没有解出来。两张光盘之间只有 `general.mix` 和 `movies.mix` 不同，其余文件逐字节相同。

`speech.mix`、`tempicnh.mix` 和 `transit.mix` 装在光盘的 `INSTALL/SETUP.Z` 里。这是 InstallShield 3 的安装包，bsdtar 读不了，所以这三个文件取自 OpenRA 的素材包。OpenRA 也提供这个素材包，用来代替从光盘安装，见 `source/openra/mods/cnc-content/installer/downloads.yaml`。素材包里的这三个文件和 `SETUP.Z` 里的是否逐字节相同，未核对。素材包里的其他 MIX 和 GDI 光盘上的相同，只有 `cclocal.mix` 是另一个版本。素材包里还多一个 `updatec.mix`，光盘上没有这个文件。

`assets/dev/` 里入库的 `conquer.mix`、`temperat.mix` 和 `general.mix` 复制自 `cnc-gold/gdi/`，供开发和测试使用。

## 源码

EA 的两个仓库都已经归档，是只读的。按照 EA 的说明，原版源码不能完整编译，因为缺少核心引擎库。移植游戏规则时以 `source/cnc-tiberian-dawn/` 为准，用 Nyerguds 的版本交叉核对。OpenRA 和 Vanilla Conquer 只用来对照文件格式和核对行为，不复制它们的代码。
