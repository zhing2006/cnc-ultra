# 进展

| 里程碑 | 状态 |
|---|---|
| [里程碑 0：调色板管线](m0-palette-pipeline.md) | 完成 |
| [里程碑 1：原版画面](m1-original-visuals.md) | 完成 |
| [里程碑 2：GPU 模拟框架](m2-gpu-simulation.md) | 完成 |
| [里程碑 3：单位和操作](m3-units-and-controls.md) | 待验收 |
| [里程碑 4：战斗](m4-combat.md) | 待验收 |
| [里程碑 5：经济和建造](m5-economy-and-building.md) | 完成 |
| [里程碑 6：原版地图上的一局对战](m6-full-match.md) | 未开始 |
| [里程碑 6.5：原版战役](m6.5-campaigns.md) | 未开始 |
| [里程碑 7：地图生成器](m7-map-generator.md) | 未开始 |
| [里程碑 8：Ultra 模式](m8-ultra.md) | 未开始 |
| [里程碑 9：透视视图和对比场景](m9-views-and-comparison.md) | 未开始 |

状态有四种：未开始、进行中、待验收、完成。里程碑做完，自动测试都通过以后，标成“待验收”。项目负责人按任务单里的验收标准检查通过以后，再标成“完成”。

每个里程碑结束时，运行 `pnpm check`、`pnpm test` 和 `pnpm test:acceptance`。最后一项在 NVIDIA、AMD 上分别执行浏览器检查，并核对实际使用的 WebGPU adapter。两张卡的功能与 CPU/GPU 确定性检查都通过后，再进入试玩验收。显卡、驱动、浏览器版本和 GPU 耗时写进对应任务单；缺少 AMD 实测时，验收尚未完成。产品宪法中的 60 FPS 性能预算仍以指定的 NVIDIA 开发机为准。
