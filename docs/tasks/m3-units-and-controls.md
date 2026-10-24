# 里程碑 3：单位和操作

## 目标

车辆和步兵按原版的类型数据移动，玩家可以像在原版里一样选择单位、下达移动命令。视野和迷雾在这一步做，单位被选中和接到命令时也会回话。

## 原因

从这一步开始，游戏第一次能上手操作了。原版玩家最先感觉到的，就是选择、下命令和单位移动的手感，这些都要照原版来做（设计宪法第三条）。

## 范围

要做：

- 从原版移植车辆和步兵的类型数据，包括速度、转向速度、视野和造价。
- 车辆的朝向、转向和移动，步兵走路的动画。
- 单位被友军挡住时，按原版的规则等待或者绕开。
- 点选、框选、移动命令和光标的形状（设计宪法第三条）。
- 原版快捷键里和选择、移动有关的部分。
- 视野和迷雾在 GPU 上计算。原版的迷雾揭开以后就不会再盖上。
- 视野的透视层。
- 解析和播放 AUD 音频，单位被选中和接到命令时的语音。

不做：

- 攻击和其他战斗，放在里程碑 4。
- 侧边栏、雷达和建造，放在里程碑 5。
- 飞机，放在里程碑 6。
- 适合几千个单位的选择方式，放在里程碑 8。

## 参考

原版源码在 `refs/source/cnc-tiberian-dawn/`：

- `UDATA.CPP` 和 `IDATA.CPP`：车辆和步兵的类型数据。
- `DRIVE.CPP` 的 `DriveClass::Start_Of_Move` 和 `DriveClass::While_Moving`：车辆的移动。
- `INFANTRY.CPP`：步兵的移动和动画。
- `UNIT.CPP` 的 `UnitClass::Can_Enter_Cell` 和 `DEFINES.H` 里的 `MOVE_TEMP`、`MOVE_MOVING_BLOCK`：被挡住时的处理。
- `DISPLAY.CPP` 的 `DisplayClass::Select_These`：框选。
- `MOUSE.CPP`：光标。`CONQUER.CPP` 的 `Keyboard_Process`：快捷键。
- `MAP.CPP` 的 `MapClass::Sight_From`：视野。
- `AUDIO.CPP` 的 `Sound_Effect`：播放音效和单位的语音。

OpenRA 的 `OpenRA.Mods.Cnc/FileFormats/AudReader.cs`：AUD 格式，只用来对照。

单位的语音和音效在 `sounds.mix` 里，开工时把 `refs/cnc-gold/gdi/sounds.mix` 加进 `assets/dev/`。

## 验收标准

- 同一辆车在空地上走同一段直路，用的逻辑帧数和按原版数值算出来的一样。（自动测试）
- 一辆车原地转一整圈，用的逻辑帧数和按原版的转向速度算出来的一样。（自动测试）
- 一个单位揭开的格子，和按 `MapClass::Sight_From` 的规则算出来的相同。（自动测试）
- AUD 的解码结果和 OpenRA 解出来的采样相同。（自动测试）
- 点选、框选、下命令的方式和光标的变化都和原版一致，单位接到命令会回话。（试玩检查）
