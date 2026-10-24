# 里程碑 6：原版地图上的一局对战

## 目标

在原版的多人地图 scm01ea（Green Acres）上，玩家和电脑对手各从一辆 MCV 开局，一直打到一方被消灭（产品宪法第七条第一点）。多人模式的科技树在这一步补齐。

## 原因

这是切片的第一项（产品宪法第四条），要证明这是一个能从开局玩到分出胜负的游戏。1995 年的原版没有会造基地的电脑玩家，`INI.CPP` 的注释里写着 “we have no base-building AI logic”。2020 年的重制版从《红色警戒》复制了一套会造基地的 AI，所以电脑对手从重制版移植（设计宪法第一条）。

## 范围

要做：

- 电脑对手会造基地、采矿、生产和进攻，也会使用超级武器，从重制版的代码移植。规则和数值仍然以 1995 年的原版为准。
- 补齐科技树。多人模式下能造的单位和建筑都要能造，科技等级固定开到最高。其中包括直升机坪和它造的 Orca、Apache、Chinook，离子炮和核弹这两种超级武器，以及防空。
- 单位的特殊能力：工程师占领建筑、突击队炸建筑、运兵车装载步兵、隐形坦克隐身。
- 开局前选择地图和阵营，判定胜负，一局结束以后可以重新开一局。

不做：

- 宝箱、夺旗和空袭。在原版的多人模式里，空袭只能从宝箱里得到。
- 联机（产品宪法第五条）。

## 参考

重制版的源码在 `refs/source/cnc-remastered-collection/TIBERIANDAWN/`：

- `HOUSE.CPP` 里 `USE_RA_AI` 下面的 AI，包括 `Expert_AI`、`AI_Building`、`AI_Unit`、`AI_Infantry` 和 `AI_Aircraft`。

原版源码在 `refs/source/cnc-tiberian-dawn/`：

- `HOUSE.CPP` 里启用离子炮和核弹的地方、`HouseClass::Has_Nuke_Device` 和 `HouseClass::Special_Weapon_AI`，以及 `SUPER.CPP`：超级武器的条件和充能。
- `AADATA.CPP` 和 `AIRCRAFT.CPP`：飞机。
- `INFANTRY.CPP` 的 `InfantryClass::Per_Cell_Process`：工程师占领建筑。`BUILDING.CPP`：建筑被突击队炸毁。`TECHNO.CPP`：隐形坦克的隐身。
- `INI.CPP` 里多人地图开局的设置，`HOUSE.CPP` 的 `HouseClass::MPlayer_Defeated`：开局和失败的判定。

## 验收标准

- 超级武器的充能时间和伤害都和原版一致。（自动测试）
- 一局结束以后重新开局，用同样的种子，新一局开局时的模拟状态和第一局开局时逐位相同。（自动测试）
- 在 scm01ea 上，玩家和电脑各从一辆 MCV 开局，一直打到一方被消灭，中途不刷新页面。（试玩检查）
- 电脑对手会造基地、采矿、出兵进攻，也会使用超级武器。（试玩检查）
