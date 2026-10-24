# 里程碑 0：调色板管线

## 目标

从原版的 MIX 文件读出数据，把 GDI 任务地图 scg08eb 的地形、车辆和步兵画出来，单位带阵营颜色和阴影。这一步要定下调色板索引渲染的整条管线（技术宪法第三条）。

## 原因

这是第一次从原版数据一路打通到屏幕，格式解析、GPU 纹理和 TSL shader 都要走一遍。阵营换色和阴影决定了管线的形状。阵营换色是在查调色板之前，先用 remap 表把索引换成另一个索引。阴影则要先读出底下像素的索引，再换成更暗的颜色。WebGPU 不能在同一遍里读正在写的像素，如果先做一条不带阴影的管线，以后加阴影时很可能要推倒重来。

这一步的代码也是后面所有任务的样板。引擎层和游戏层怎么分，TSL 怎么写，测试怎么写，后面的任务都照着它来。

第一张图用任务地图 scg08eb，因为多人地图上没有预先放好的单位。这一步要用的数据都在 `assets/dev/` 的三个 MIX 文件里。

## 范围

要做：

- 读取 MIX 文件。游戏在运行时从站点上读取原版的 MIX 文件（技术宪法第十条和第十四条）。
- 解析调色板、地形模板和 SHP。
- 解析地图 INI 和 BIN 里的地形、车辆和步兵。
- 渲染管线，包括索引图、调色板纹理、阵营换色的 remap 表和单位的阴影。
- 按地图里写的位置和朝向画出车辆和步兵。

不做：

- 覆盖层、树木、建筑和它们的阴影，放在里程碑 1。
- 隐形坦克的扭曲效果和水面的调色板循环，放在里程碑 1。
- 镜头的滚动和缩放，放在里程碑 1。这一步的镜头固定不动。
- 单位的动画和任何模拟。

## 参考

原版源码在 `refs/source/cnc-tiberian-dawn/`：

- `MIXFILE.CPP`：MIX 文件的结构，以及按文件名查找文件的做法。
- `KEYFRAME.CPP` 的 `Build_Frame`：SHP 的解码。
- `CDATA.CPP`：地形模板的类型数据。
- `INI.CPP` 的 `Read_Scenario_Ini` 和 `MAP.CPP` 的 `MapClass::Read_Binary`：地图 INI 和 BIN 的读取。
- `CONST.CPP` 里 `RemapYellow` 这些 remap 表，`HDATA.CPP` 里每个阵营用哪一张。
- `TECHNO.CPP` 里画单位的 `CC_Draw_Shape`，带着 `SHAPE_GHOST` 和 `Map.UnitShadow`：单位的阴影。`DISPLAY.CPP` 里生成 `UnitShadow` 表的代码。

OpenRA 在 `refs/source/openra/`，只用来对照，不复制代码：

- `OpenRA.Mods.Cnc/FileSystem/MixFile.cs`、`OpenRA.Mods.Cnc/SpriteLoaders/ShpTDLoader.cs` 和 `TmpTDLoader.cs`：MIX、SHP 和地形模板。
- `OpenRA.Mods.Cnc/UtilityCommands/ImportTiberianDawnMapCommand.cs`：原版地图的读取。
- `OpenRA.Mods.Common/UtilityCommands/ConvertSpriteToPngCommand.cs`：`--png` 命令，用来导出测试的参考图。

## 验收标准

- SHP 和地形模板的解码结果，和 OpenRA 的 `--png` 导出的图逐像素一致。（自动测试）
- 在 GPU 上画一个压在地形上的单位，读回索引图，阴影像素的索引等于底下像素的索引经过 `UnitShadow` 表换出来的值，其他像素等于单位的 SHP 经过阵营 remap 表换出来的值。（自动测试）
- 打开页面能看到 scg08eb 的地形、车辆和步兵，位置和朝向和地图里写的一致。（试玩检查）
- GDI 和 Nod 的单位颜色分得清，单位的阴影压暗了底下的地面。（试玩检查）

## 待定问题

- 导出参考图要先编译 OpenRA。OpenRA 的目标框架是 .NET 6，开发机上装的是 .NET 9 SDK，开工时先确认能不能编译和运行。
