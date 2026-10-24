# 里程碑 0：调色板管线

## 目标

从原版的 MIX 文件读出数据，把 GDI 任务地图 scg08eb 的地形、车辆和步兵画出来，单位带阵营颜色和阴影。这一步要定下调色板索引渲染的整条管线（技术宪法第三条）。镜头照原版的方式滚动，加上方向键滚屏（设计宪法第三条）。

## 原因

这是第一次从原版数据一路打通到屏幕，格式解析、GPU 纹理和 TSL shader 都要走一遍。阵营换色和阴影决定了管线的形状。阵营换色是在查调色板之前，先用 remap 表把索引换成另一个索引。阴影则要先读出底下像素的索引，再换成更暗的颜色。WebGPU 不能在同一遍里读正在写的像素，如果先做一条不带阴影的管线，以后加阴影时很可能要推倒重来。

这一步的代码也是后面所有任务的样板。引擎层和游戏层怎么分，TSL 怎么写，测试怎么写，后面的任务都照着它来。

第一张图用任务地图 scg08eb，因为多人地图上没有预先放好的单位。scg08eb 的可玩区域是 56×59 格，一屏放不下，所以镜头要能滚动。

这一步要用的数据在 `assets/dev/` 的四个 MIX 文件里。鼠标指针的图形 `mouse.shp` 在 `cclocal.mix` 里，这个文件从 GDI 光盘上复制过来（`refs/cnc-gold/gdi/cclocal.mix`）。

## 范围

要做：

- 读取 MIX 文件。游戏在运行时从站点上读取原版的 MIX 文件（技术宪法第十条和第十四条）。
- 解析调色板、地形模板和 SHP。
- 解析地图 INI 和 BIN 里的地形、车辆和步兵。
- 渲染管线，包括索引图、调色板纹理、阵营换色的 remap 表和单位的阴影。
- 按地图里写的位置和朝向画出车辆和步兵。
- 镜头的滚动。鼠标移到画面最边上时，地图往那个方向滚，速度、惯性和指针的形状都照原版。方向键也能滚屏，速度的规则和贴边滚屏一样。F7–F10 是四个视角书签，按住 Shift、Ctrl 或者 Alt 再按是记下当前位置，直接按是跳回去。
- 点进游戏画面以后锁定鼠标，指针由游戏自己画，按 Esc 解锁（设计宪法第三条）。

不做：

- 覆盖层、树木、建筑和它们的阴影，放在里程碑 1。
- 隐形坦克的扭曲效果和水面的调色板循环，放在里程碑 1。
- 镜头的缩放，放在里程碑 1。这一步按整数倍放大，倍数由屏幕的高度决定，不能调。
- Home、H 和 N 这几个让镜头对准单位的键，要等里程碑 3 有了选择再做。点雷达跳转，要等里程碑 5 有了侧边栏。
- 单位的动画和任何模拟。

## 参考

原版源码在 `refs/source/cnc-tiberian-dawn/`：

- `MIXFILE.CPP`：MIX 文件的结构，以及按文件名查找文件的做法。
- `KEYFRAME.CPP` 的 `Build_Frame`：SHP 的解码。
- `CDATA.CPP`：地形模板的类型数据。
- `INI.CPP` 的 `Read_Scenario_Ini` 和 `MAP.CPP` 的 `MapClass::Read_Binary`：地图 INI 和 BIN 的读取。
- `CONST.CPP` 里 `RemapYellow` 这些 remap 表，`HDATA.CPP` 里每个阵营用哪一张。
- `TECHNO.CPP` 里画单位的 `CC_Draw_Shape`，带着 `SHAPE_GHOST` 和 `Map.UnitShadow`：单位的阴影。原版的 `DISPLAY.CPP` 定义了 `_RETRIEVE`，所以 `UnitShadow` 表直接从 `temperat.mix` 的 `TUNITS.MRF` 读出来。重制版源码的 `KEYFBUFF.ASM` 里有画阴影的汇编，阴影像素查完 `UnitShadow` 表以后，还要再过一遍阵营的 remap 表。温带的 `UnitShadow` 表换出来的值都不在 remap 表改动的 176–191 里，所以温带地图上这一步不改变结果。
- `SCROLL.CPP` 的 `ScrollClass::AI` 和 `DISPLAY.CPP` 的 `DisplayClass::Scroll_Map`：贴边滚屏的方向、速度和惯性。
- `MOUSE.CPP` 的 `MouseControl` 表：每种指针用 `mouse.shp` 的哪几帧，热点在哪里。
- `CONQUER.CPP` 的 `Keyboard_Process` 和 `Handle_View`：F7–F10 的视角书签，以及被关掉的方向键滚屏。

OpenRA 在 `refs/source/openra/`，只用来对照，不复制代码：

- `OpenRA.Mods.Cnc/FileSystem/MixFile.cs`、`OpenRA.Mods.Cnc/SpriteLoaders/ShpTDLoader.cs` 和 `TmpTDLoader.cs`：MIX、SHP 和地形模板。
- `OpenRA.Mods.Cnc/UtilityCommands/ImportTiberianDawnMapCommand.cs`：原版地图的读取。
- `OpenRA.Mods.Common/UtilityCommands/ConvertSpriteToPngCommand.cs`：`--png` 命令，用来导出测试的参考图。

导出参考图的脚本放在 `refs/` 下。它先编译 `refs/source/openra/`，再用 `--png` 导出每个 SHP 和地形模板，PNG 存在 `refs/` 下，不入库。脚本把每一帧的宽、高和索引像素的摘要写进一个文本文件，入库的只有这个文件，测试拿它来对照。开发机上的 .NET 9 SDK 能编译 OpenRA 的 net6.0 目标，只报一个框架过期的警告。

## 验收标准

- SHP 和地形模板的解码结果，和 OpenRA 的 `--png` 导出的图逐像素一致。（自动测试）
- 在 GPU 上画一个压在地形上的单位，读回索引图，阴影像素的索引等于底下像素的索引经过 `UnitShadow` 表换出来的值，其他像素等于单位的 SHP 经过阵营 remap 表换出来的值。（自动测试）
- 鼠标一直停在画面边上时，镜头每一步滚过的距离，和按 `ScrollClass::AI` 的速度表与惯性规则算出来的相同。滚到地图边上以后停住，不会滚出可玩区域。（自动测试）
- 打开页面能看到 scg08eb 的地形、车辆和步兵，位置和朝向和地图里写的一致。（试玩检查）
- GDI 和 Nod 的单位颜色分得清，单位的阴影压暗了底下的地面。（试玩检查）
- 鼠标贴边和方向键都能把镜头滚到地图的每个角落，贴边时指针换成对应方向的箭头，滚不动时换成另一种箭头。F7–F10 能记下和跳回视角。（试玩检查）

## 开发笔记

- 原版在等待下一帧的循环里反复调用 `ScrollClass::AI`，调用的频率取决于机器有多快。这里每 1/60 秒调用一次，和原版惯性计数器的精度一样。按默认的滚动速度，镜头加速完以后每一步滚 127 个 lepton。试玩时如果觉得太快或者太慢，要调的是调用频率。
- `CDATA.CPP` 里 CLEAR1 是 1×1 的模板，但是它的图标表里有 16 个图标，`CellClass::Clear_Icon` 按格子的位置挑其中一个。原版查图标表时不检查边界，所以解码时图标表一直读到透明标记表开始的地方，OpenRA 的 `TmpTDLoader` 也是这样读的。
- `mouse.shp` 是更早的形状库格式，OpenRA 的 cnc 模组读不了，导出时用 ra 模组。OpenRA 的 `ShpD2Loader` 会把没有颜色表的形状里的 1 到 4 换成 0x7F 到 0x7C，这是 Dune II 的规矩，原版的 `WWMOUSE.ASM` 不换。测试对照时把我们的结果也这样换一遍。
- 温带的 `UnitShadow` 表换出来的 17 个索引都是这张表的不动点，所以原版里两片阴影重叠也只暗一层。
- 气垫船和炮艇有自己的画法，这一步没有移植，scg08eb 上也没有这两种单位。
