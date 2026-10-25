# 里程碑 6：原版地图上的一局对战

状态：完成。2026-10-25，按项目负责人确认收尾。

## 交付范围

入口为 `?demo=match`。在原版 scm01ea（Green Acres）上，GDI 与 Nod 各从一辆 MCV 开局，支持双方 AI、玩家接管、交还控制权、胜负判定和不刷新重开。经济、建造、运输、飞机及防空沿用 M5，增加离子炮、核弹、工程师占领、突击队 C4 和隐形坦克。

默认种子为 `1995`，可通过 URL 或面板更改。双方迷雾视角与控制权独立。`1× / 10× / 100×` 是目标推进倍率，达不到时显示实际倍率，不跳逻辑帧。快进和暂停时静音，恢复后不补播积压声音。

本阶段不包括地图选择、同阵营配置、联机、宝箱、夺旗、多人空袭或战役。战役与主菜单属于 M6.5；补全 AI 决策和科技投资策略属于 M9。

## 规则依据与限制

经济、战斗和特殊能力以 `refs/source/cnc-tiberian-dawn/` 的 1995 年源码为准，并与 Nyerguds 源码交叉核对。函数出处保留在实现注释中，回归覆盖见 `tests/match-regressions-fixture.ts`、`tests/super-weapons-fixture.ts`、`tests/harvest.ts` 及对应单测。

- 造基地的 AI 来自重制版 `TIBERIANDAWN/HOUSE.CPP`；1995 年版没有这套多人 AI。M6 补入了原移植列表缺少的 GDI 防御和科技建筑候选，但没有资金预留或专门的科技发展策略，不能保证每局及时建成超级武器建筑。
- 原版 `HOUSE.CPP::AI` 要求 `IsHuman` 才授予新的核弹，因此纯 AI Nod 不会凭神庙获得核弹。玩家接管时可以获得，交还 AI 后保留已有武器。多人 AI 可以获得并使用离子炮。
- 原版 `TECHNO.CPP::Base_Is_Attacked` 的协防候选存在越界读取，本项目使用稳定的评分和 ID 顺序裁决，不复制未定义行为。
- 阵营状态 EVA 只对当前控制方播放；观战保留占领、核弹来袭等全局提示。

## 最终自动检查

2026-10-25，AMD Ryzen 9 9950X，Node.js 24.13.0，Three.js 0.186.1。

| 命令 | 结果 |
|---|---|
| `pnpm check` | 0 errors、0 warnings |
| `pnpm test` | 33 个文件、704 项通过 |
| `pnpm test:acceptance` | NVIDIA、AMD 各 20 组通过，零失败，总计 785.0 秒 |
| `pnpm build` | 成功；主 JS chunk 为 1481.80 kB，gzip 后 409.72 kB，保留超过 1024 kB 的体积警告 |

双卡验收包含日常浏览器检查、完整经济与运输流程、原版素材对照和 CPU/GPU 确定性检查，替代重复的单卡 `pnpm test:e2e`。

| GPU | 驱动 | Chromium | 检查耗时 |
|---|---|---|---:|
| NVIDIA GeForce RTX 5090 D | 32.0.16.1664 | 156.0.8078.4 | 383.403 秒 |
| AMD Radeon(TM) Graphics，RDNA 2 | 32.0.21042.62 | 156.0.8078.4 | 398.434 秒 |

实际 WebGPU vendor 均已核对。结果保存在 `test-results/m6-wrap-acceptance.json`；命令输出为同目录的 `m6-wrap-check.log`、`m6-wrap-unit.log`、`m6-wrap-acceptance.log` 和 `m6-wrap-build.log`。

## 实局与性能

### 原版地图对局

`node tests/match-simulation.ts --seed=1995 --ticks=90000` 在 RTX 5090 D 上执行了 90000 个完整逻辑帧，没有人工命令、额外资源或绘制，平均 228.83 ticks/s。达到运行上限时双方仍有存活对象，尚未分出胜负；这不是自然终局通过记录。M6 不设置固定种子的限时通关门槛，AI 的发展与进攻策略补全属于 M9。

原始结果为 `test-results/m6-wrap-natural.json`，输出为 `test-results/m6-wrap-natural.log`。

### 绘制与快进

`node tests/match-performance.ts --label=wrap` 使用上述两张卡和浏览器版本。种子 `1995` 的双方 AI 先运行到约 14000 帧，每档预热 2 秒、采样约 5 秒。场景为 512 个槽位，采样时有 37–59 个存活对象，没有额外资金或单位。

| GPU | 目标倍率 | 实际倍率 | 绘制提交频率 | 经济报告平均等待 |
|---|---:|---:|---:|---:|
| RTX 5090 D | 1× | 1.00× | 170.03 Hz | 3.07 ms |
| RTX 5090 D | 10× | 10.00× | 17.95 Hz | 4.29 ms |
| RTX 5090 D | 100× | 14.16× | 59.90 Hz | 4.00 ms |
| AMD RDNA 2 | 1× | 1.00× | 169.93 Hz | 6.13 ms |
| AMD RDNA 2 | 10× | 10.00× | 21.16 Hz | 4.84 ms |
| AMD RDNA 2 | 100× | 11.73× | 59.83 Hz | 4.99 ms |

绘制提交频率按 `PalettePipeline.render` 调用计数，不是 GPU 帧耗时。快进允许减少绘制，`100×` 目标未达到。数据和截图保存在 `test-results/m6-live-wrap.json` 及同名前缀的 PNG 中。

### 大规模专项

| 场景 | RTX 5090 D GPU 耗时 | AMD RDNA 2 GPU 耗时 |
|---|---:|---:|
| 两万对象、256×128 地图、八次协防请求 | 0.79–0.92 ms | 4.33–4.65 ms |
| 两万对象战斗专项 | 0.46–0.66 ms | 6.82–8.78 ms |

协防取三次预热后的五个样本，战斗取三个样本。两项均不包含渲染，不能据此宣称两万单位整场达到 60 FPS。完整 GPU 帧耗时和两万单位实战渲染仍未实测，属于后续 Ultra 验收。

协防原始数据为 `test-results/m6-wrap-scaling-nvidia.json`、`test-results/m6-wrap-scaling-amd.json`；战斗数据为两卡子目录中的 `m4-measurement.json`。
