# 里程碑 5：经济和建造

## 目标

从一辆 MCV 开始，造出基地、采矿、生产地面单位和飞机。实现飞机的操控、运输和战斗，以及地面单位和建筑的防空。加上原版的侧边栏、雷达和 EVA 的语音提示。

## 原因

建造和采矿是“建造、采矿、作战”这一圈的另外两环。飞机和防空也在这一步接入生产和战斗，让两边阵营的基地都能生产和使用空中部队。泰伯利亚矿的生长在 GPU 上计算（技术宪法第五条），矿区密度的叠加层也在这一步做。

## 范围

要做：

- 泰伯利亚矿的生长和蔓延，在 GPU 上计算。
- 矿区密度的叠加层。
- 采矿车找矿、采矿，装满以后回精炼厂卸货。
- 资金和电力，以及电力不足时的影响。
- 建筑的放置规则、MCV 展开、建造队列、工厂生产单位，以及建筑的修理和出售。
- GDI 和 Nod 的经济建筑、兵营、车辆工厂、直升机坪和防御建筑，以及本阶段单位的生产前提。
- Nod 机场通过 C-17 交付车辆，包括进场、卸载、离场，以及交付受阻时的处理。
- Orca、Apache 和 Chinook 的生产、选择、编队、移动、起降及各自的战斗或运输行为。补充弹药、维修和乘员装卸按原版实现。
- APC 运兵车的五人装载、舱门和卸载。
- 建筑被攻击和被摧毁，防御建筑向地面单位开火。具有防空能力的单位和建筑按原版规则攻击飞机。
- 原版界面里的侧边栏和雷达（设计宪法第七条）。
- EVA 的语音提示。
- 测试场景：在多人地图 scm01ea 的一个出生点放一辆 MCV。
- 演示场景：在现有 `?demo=units` 中加入飞行单位，新增 `?demo=buildings` 用于体验和检查建筑行为。

不做：

- 电脑对手，放在里程碑 6。
- 超级武器，放在里程碑 6。
- 工程师占领建筑、突击队炸建筑和隐形坦克隐身，放在里程碑 6。
- 宝箱、夺旗和空袭不在本阶段范围内。

本阶段所有单位、建筑和经济规则都以 1995 年原版源码为准，并用 Nyerguds 版本交叉核对。价格、生产条件、建造时间、扣款和退款，以及移动、攻击、运输和维修的数值与行为都要核对，不能用演示场景中的简化规则代替。随机数、寻路和飞行视野遵守技术宪法、设计宪法中已经规定的差异。

## 演示场景

- `?demo=units` 保留现有的车辆和步兵，加入本阶段的飞行单位，方便检查选择、编队、飞行和各自的战斗或运输行为。
- `?demo=buildings` 从一辆可以展开的 MCV 开始，玩家逐步建设基地、解锁本阶段的建筑和单位。默认使用 GDI，`faction=nod` 使用 Nod。
- 建筑演示提供 100000 起始现金，足够反复建造、生产、修理和出售。科技等级开到原版多人模式的最高级，生产权限仍按原版的阵营和工厂规则处理。提高起始现金不改变价格、建造时间、用电、采矿收入和退款规则。
- 建筑演示默认不生成敌人。玩家开启运输机波次后，敌方 Chinook 持续飞入基地，降落并卸下步兵，供玩家测试防空和对地防御。C-17 按原版 `AADATA.CPP` 的 `IsLegalTarget` 设置不作为防空靶机。波次开关放在原版侧边栏之外。
- `?demo=economy` 在 scm01ea 上提供正常的 10000 起始资金，供完整经济试玩使用。
- 两个经济演示的调试面板提供建造／生产队列 ×1、×10、×100。默认 ×1，倍率不改变价格和扣款规则。

## 参考

原版源码在 `refs/source/cnc-tiberian-dawn/`：

- `MAP.CPP` 的 `MapClass::Logic`：泰伯利亚矿的生长和蔓延。
- `UNIT.CPP` 的 `UnitClass::Harvesting` 和 `BUILDING.CPP` 的 `BuildingClass::Mission_Harvest`：采矿和卸货。
- `BDATA.CPP` 和 `BUILDING.CPP`：建筑的类型数据和行为。
- `FACTORY.CPP`：生产。`HOUSE.CPP`：资金和电力的结算。
- `UDATA.CPP`、`IDATA.CPP` 和 `AADATA.CPP`：单位的类型数据。`HOUSE.CPP` 的 `HouseClass::Can_Build`：生产条件。`TECHNO.CPP` 的 `TechnoTypeClass::Cost_Of` 和 `TechnoTypeClass::Time_To_Build`：价格和建造时间。
- `AADATA.CPP` 和 `AIRCRAFT.CPP`：飞机的类型数据、飞行、起降、攻击、补充弹药、维修和运输。`UNIT.CPP` 的 `Receive_Message`、`Desired_Load_Dir`、`Mission_Unload`，以及 `CARGO.CPP`、`INFANTRY.CPP`：APC 和 Chinook 的乘员装卸。
- `BUILDING.CPP` 的 `BuildingClass::Exit_Object`、`REINF.CPP` 的 `Create_Special_Reinforcement` 和 `AIRCRAFT.CPP` 的 `AircraftClass::Mission_Unload`：Nod 机场的 C-17 运输交付。
- `BDATA.CPP`、`BUILDING.CPP`、`TECHNO.CPP` 和 `BULLET.CPP`：防空武器、目标选择和对飞机的伤害。
- `SIDEBAR.CPP` 和 `RADAR.CPP`：侧边栏和雷达。
- `AUDIO.CPP` 的 `Speak`：EVA 的语音。

EVA 的语音在 `speech.mix` 里，开工时把 `refs/cnc-gold/openra/speech.mix` 加进 `assets/dev/`。光盘上的 `speech.mix` 装在 InstallShield 的安装包里，所以这个文件取自 OpenRA 的素材包（`refs/README.md`）。

## 原版行为核对

标成“待验收”之前，要对照原版源码逐项核对。下面这些都要一个一个读过：

- `BDATA.CPP` 里的每一种建筑、`BUILDING.CPP` 里的每一个函数。
- `FACTORY.CPP`，以及 `HOUSE.CPP`、`SIDEBAR.CPP` 里和经济、生产及建筑有关的部分。
- `AADATA.CPP` 里的每一种飞机、`AIRCRAFT.CPP` 里的每一个函数。
- `UDATA.CPP`、`IDATA.CPP`、`HOUSE.CPP` 和 `TECHNO.CPP` 里，本阶段单位的类型数据、生产条件和建造时间。
- `UNIT.CPP` 里的 MCV 展开、采矿车找矿和卸货，以及 `BUILDING.CPP`、`REINF.CPP` 里的 C-17 交付流程。
- `UNIT.CPP`、`CARGO.CPP`、`INFANTRY.CPP` 里 APC 和 Chinook 乘员装卸用到的函数，以及单位、建筑和子弹的防空相关函数。

读到的每一条行为都记在任务单最后的“核对记录”一节，写明出处的文件和函数，再写这里是怎么处理的。做了的，写由哪项自动测试或者试玩检查覆盖；没做的，写放到了哪个里程碑，或者为什么不适用。

## 验收标准

- GDI 和 Nod 都能从一辆 MCV 开局，展开、造电厂和精炼厂、采矿、生产地面单位和飞机。每一样东西的价格、生产条件和建造时间都和原版一致。（自动测试）
- 采矿车采满一车再卸货，得到的资金和原版一致。（自动测试）
- 泰伯利亚矿的生长和蔓延，在很多个逻辑帧里统计出来的比例符合原版的规则和概率。（自动测试）
- Nod 机场生产的车辆由 C-17 送达，交付时机、出口受阻和机场丢失时的处理符合原版规则。（自动测试）
- 飞机的移动、起降、攻击、补充弹药、维修和乘员装卸符合原版规则；防空目标选择、射程、射速和伤害符合原版规则。（自动测试）
- APC 最多装载五名步兵，按原版转向、开门和逐人装卸，出口堵住时保留乘员。除 C-17 外的己方飞机飞行和起降时揭开周围一格，经过的地形保持已探索（设计宪法第三条）。（自动测试）
- 本阶段新增的 GPU 模拟系统都有 CPU 对照，两边从相同状态执行相同命令后逐位一致；NVIDIA 和 AMD 都通过检查。（自动测试）
- 打开矿区密度的叠加层，能看到每一格的矿量。（试玩检查）
- 侧边栏、雷达和 EVA 的提示都和原版一致。（试玩检查）
- `?demo=units` 可以选择和操控飞行单位，并检查飞行动画和各自的攻击或运输行为；`?demo=buildings` 可以体验和检查本阶段的建筑行为。（试玩检查）
- 建筑演示从一辆 MCV 开始，玩家可以展开、建造并逐步解锁本阵营的生产选项。起始现金充足，敌方运输机默认不刷新，手动开启波次后可以测试防空。（试玩检查）
- 核对记录列全了原版建筑、飞机和本阶段经济及单位相关行为，每一条都写了出处和处理方式。（对照源码检查）

## 验收安排与状态

2026-10-25，项目负责人确认试玩通过，M5 完成。审查中的 GPU 串行扫描、全槽位传输、地图尺寸、精炼厂排队和批量换层重排问题已经修正。

- 单位状态、建筑特效和矿石爆炸扣减并行计算。设施、乘员、飞机位置和目标格使用 GPU 索引；创建、接洽和付款等需要顺序的请求按编号处理。混合地面与空中单位的 HUNT 使用空间索引。
- 生命周期命令和建筑外观只上传变化。经济报告读取建筑、待创建单位、当前选择、可复用编号和汇总计数。在下述两万槽位、五座建筑的样本中，每帧读回从 320060 字节减到 616 字节。CPU 结算仍按前一逻辑帧的报告进行，异步读取不会改变经济事件的生效顺序。
- 系统之间只更新占位发生变化的格子，后续系统可以立即看到运输、出厂和起降产生的新占位。墙体连接直接查询放置网格。
- 96×48 地图上的 MCV 展开、建筑占地、雷达点击、矿量显示和放置预览已有专项检查。
- 忙碌精炼厂旁的矿车按 `UNIT.CPP::Mission_Harvest` 与 `TECHNO.CPP::Nearby_Location` 靠近等待，每 15 帧重试接洽。
- 建造厂施工期间按 `BUILDING.CPP::AI` 计入供电，用电和容量在 `Grand_Opening` 计入。展开动画中开始生产第一座电厂，正常倍率下仍需 216 个逻辑帧，即 14.4 秒；不会误用极低电量的生产间隔。
- 兵营出兵经过正常的五站位分配，站满后使用后续出口。重工厂车辆按 `RADIO_RUN_AWAY` 让开出口；新出车任务等待前一次关门结束。停机坪检查已有飞机和返航接洽，忙碌时按 `Exit_Object` 从地图边缘朝北进场，再寻找落点。

本次定向检查：`pnpm check` 输出 0 errors、0 warnings；`pnpm test src/game/simulation/map.test.ts src/game/simulation/transport.test.ts` 的 2 个文件、7 项检查通过。`pnpm test:e2e "--only=coordination,compaction" --acceptance "--gpus=nvidia,amd"` 在 NVIDIA 和 AMD 上都通过。排序逐位对照原版 `LAYER.CPP::Sorted_Add` 的顺序插入，覆盖空批次、单对象、相等键、部分有序列表、多次重排，以及两万对象中同时变化 2000 个、8193 个对象中同时变化 5000 个。乘员出现和隐藏、移动标记及飞机协调沿用已有检查。NVIDIA 上的 `pnpm test:e2e "--only=units,selectionready"` 也通过，覆盖单位像素、实际操作和进入游戏前的管线准备。

共用前缀和的派发参数已经修正：Three.js 的数值参数表示调用数，工作组数量须使用三维数组。专项检查验证了跨工作组的总和、编号超过 128 的空闲槽位和激光收集，以及建筑火焰、碎片与 CPU 参照的一致性。
原有的两阵营完整开局、采矿和补弹等长流程保留前次结果，本次没有重跑整套里程碑验收。

日常检查运行 `pnpm test:e2e`。可用 `node tests/run.ts --only=economy "--gpus=nvidia,amd"` 单独复查经济模块；加入 `--acceptance` 才运行完整采矿、补弹、运输、工厂进出和两阵营开局。运输与飞行视野可用 `--only=transport` 定向运行；该组的 `--acceptance` 只增加 Chinook 的完整装卸回归。排序和飞机协调可用 `--only=coordination` 复查，加入 `--acceptance` 才运行两万对象和 5000 个变化对象的对照。空闲槽位、激光收集和建筑火焰可用 `--only=compaction` 复查。整套里程碑验收使用 `pnpm test:acceptance`。

### 性能实测

2026-10-25，Chromium 156.0.8078.4。实际 WebGPU adapter 均已核对：NVIDIA GeForce RTX 5090 D，驱动 32.0.16.1664；AMD Radeon(TM) Graphics（RDNA 2），驱动 32.0.21042.62。

修正前后使用同一 256×128 地图：全部槽位启用，同方单位，没有敌军；包含五座建筑、矿车、Chinook 和 Orca，其余是坦克。每次先运行三帧，再取五个 GPU timestamp 样本。计算包括移动、战斗、视野和 M5 系统，不含渲染或 CPU 工作，不能据此判断完整 Ultra 对局帧率。

| GPU | 单位槽位 | 修正前每逻辑帧 | 修正后每逻辑帧 | 显式预编译调用累计，前 → 后 |
|---|---|---|---|---|
| RTX 5090 D | 64 | 0.786–1.638 ms | 0.262–0.721 ms | 7.731 → 6.677 s |
| RTX 5090 D | 20000 | 191.300–283.902 ms | 0.721–1.180 ms | 5.065 → 6.156 s |
| AMD RDNA 2 | 64 | 1.573–2.163 ms | 1.114–1.769 ms | 7.040 → 5.861 s |
| AMD RDNA 2 | 20000 | 225.968–226.755 ms | 11.665–12.255 ms | 5.037 → 5.454 s |

上表没有关闭浏览器的 timestamp 量化，约 65 µs 的步长只适合看整体变化，不能用来判断单个小系统的耗时。预编译列测量 `compileComputeAsync` 调用的墙钟时间，包含 TSL 生成和驱动工作，受缓存影响，不是整个页面的载入耗时。两万槽位样本的预编译累计有所增加。复测命令为 `node tests/economy-performance.ts --label=after`；各模块的编译耗时和 GPU 原始样本保存在 `test-results/m5-performance-before.json` 与 `test-results/m5-performance-after.json`。

### 包含绘制更新的复测

换层和移动标记由逐对象并行计算检测变化，再用 `GpuTaskMask` 收集编号。批量重排先并行查找未变化对象中的插入边界，按编号处理变化对象之间的依赖，最后用前缀和计算新位置并统一写回。串行部分只访问变化对象，不再对每个对象扫描和移动整张排序表。结果保持 `LAYER.CPP::Sorted_Add` 对部分有序列表和相等键的行为。乘员装卸也参与出现／隐藏检测；新生产步兵按 `FOOT.CPP::Sort_Y` 重新计算排序偏移。

没有变化时，候选计算和依赖处理的间接派发工作组数为零，其余固定大小的 pass 在 GPU 上跳过主体。变化对象之间的候选比较仍是二次工作量，但由多个工作组并行处理；超过 2000 个同时变化的 GPU 耗时尚未实测。

飞机的备用落点、首选停机坪和射击候选位置先并行计算。按编号处理接洽时复核占用；更早的飞机释放停机坪时重新计算，全部停机坪占满后不再逐架重扫。射击候选仍按原版的扫描顺序选择，保留“前一个最佳位置”的含义。地面、战斗和特效绘制更新共享最后一次空间索引重建，本次两万单位样本每逻辑帧有 334 次派发，包含间接派发；批量重排比上一版增加了 28 次小派发。这里统计的是完整测量场景，不只是 M5 新增系统。

复测沿用上面的两万单位、256×128 地图和显卡、驱动、浏览器版本，增加地面排序、换层、精灵更新、乘员标记、侧边栏、雷达、激光和建造预览更新。GPU 列仅汇总 compute pass，不含最终画面合成；CPU 列是修正后同步提交和绘制更新的墙钟时间，不含等待读回，不代表完整游戏主线程耗时。修正前没有测侧边栏更新，因此不比较两轮 CPU 耗时。

| GPU | 单线程换层时 compute | 当前 compute | 当前 CPU 提交与更新 | 显式预编译调用累计，前 → 后 |
|---|---|---|---|---|
| NVIDIA GeForce RTX 5090 D | 11.501–11.737 ms | 1.331–1.353 ms | 1.105–1.240 ms | 6.263 → 6.191 s |
| AMD Radeon(TM) Graphics | 40.346–40.951 ms | 21.270–21.597 ms | 1.900–2.255 ms | 6.443 → 6.044 s |

RTX 5090 D 的普通地面排序为 0.130–0.136 ms，无变化的换层更新为 0.057–0.061 ms。实际 `GpuGround.transitionLayers()` 中，200、1000、2000 架飞机同时跨层分别为 0.195–0.201、0.798–0.806、1.651–1.851 ms。200 架 Orca 和 300 座建筑（含 20 个停机坪）的独立样本中，同时返航为 0.610–0.612 ms，同时选射击位置为 1.122–1.145 ms。雷达、激光和预览的离屏 render pass 合计为 0.021–0.023 ms。

AMD RDNA 2 的普通地面排序为 0.763–1.107 ms，无变化的换层更新为 0.241–0.271 ms。实际换层更新中，200、1000、2000 架飞机同时跨层分别为 0.703–1.428、2.273–2.296、4.805–5.520 ms。同时返航为 0.858–1.571 ms，同时选射击位置为 1.425–2.276 ms；离屏 render pass 合计为 0.244–0.249 ms。

单独对重排模块使用相同的两万对象输入，改前、改后各预热两次，再记录五次 GPU 样本。下表包含变化收集与重排，不包含整个游戏帧。

| GPU | 同时变化的对象数 | 逐对象重排 | 批量重排 |
|---|---:|---|---|
| RTX 5090 D | 0 | 0.024–0.027 ms | 0.053–0.055 ms |
| RTX 5090 D | 1 | 0.070–0.072 ms | 0.066–0.069 ms |
| RTX 5090 D | 200 | 3.838–5.170 ms | 0.189–0.190 ms |
| RTX 5090 D | 1000 | 18.775–24.092 ms | 0.795–0.798 ms |
| RTX 5090 D | 2000 | 42.793–48.253 ms | 1.646–1.649 ms |
| AMD RDNA 2 | 0 | 0.032–0.076 ms | 0.163–0.196 ms |
| AMD RDNA 2 | 1 | 0.090–0.253 ms | 0.264–0.510 ms |
| AMD RDNA 2 | 200 | 4.497–5.572 ms | 0.701–0.893 ms |
| AMD RDNA 2 | 1000 | 22.342–24.857 ms | 2.037–2.075 ms |
| AMD RDNA 2 | 2000 | 44.917–47.990 ms | 4.540–4.610 ms |

批量算法增加了固定派发开销，RTX 5090 D 的空批次多约 0.03 ms。重排模块的构建、首次编译与执行在 NVIDIA 上从 0.110 s 增至 0.275 s，在 AMD 上从 0.078 s 增至 0.231 s；这是测试模块的准备时间，不能当作整个页面的载入耗时。

AMD 的数据是集成显卡上的功能与压力测量，不代表达到 60 FPS。两块显卡都没有测量最终画面合成，完整 Ultra 对局帧率仍未实测。

测量专用浏览器启用了 `--enable-webgpu-developer-features`。[Chrome 文档](https://developer.chrome.com/docs/web-platform/webgpu/developer-features)说明该功能关闭 timestamp 量化；当前 Chromium 156.0.8078.4 的实测样本也不再局限于 0.065536 ms 的整数倍。日常游戏不依赖这个参数。

CPU profiler 记录了十个逻辑帧。可见热点包括 Three.js 的绑定更新、管线设置和命令提交，以及侧边栏的像素复制。绘制索引的重复重建已经合并；运输、采矿和飞行之间的占位刷新仍保留，因为后续系统会读取前一系统刚更新的占位。

复测命令：`node tests/economy-performance.ts --drawing --counts=20000 --label=review3-after`。完整更新的原始数据为 `test-results/m5-performance-review2-before-20k.json` 和 `test-results/m5-performance-review3-after.json`，包含分系统 GPU 耗时、派发计数、绘制准备时间和整个测试场景的准备时间。CPU profile 为 `test-results/m5-cpu-review3-after-nvidia.cpuprofile` 和 `test-results/m5-cpu-review3-after-amd.cpuprofile`。独立重排的改前、改后测量数据为 `test-results/m5-reinsert-before.json` 和 `test-results/m5-reinsert-after.json`。

## 核对记录

核对范围包含 `BUILDING.CPP` 的 66 个函数定义和 `AIRCRAFT.CPP` 的 57 个函数定义，重载分别计数。

### 建筑函数

| 原版函数 | 处理与检查 |
|---|---|
| `Validate`、`Debug_Dump`、`operator new`、`operator delete`、构造和析构、`Init`、`As_Target` | C++ 对象池、虚表和 DOS 调试画面不适用。使用稳定对象编号和 generation；`lifecycle-cpu.ts` 与 GPU 创建命令对照。新建筑阵营采用构造函数的 `ActLike` 规则。 |
| `Draw_It`、`Begin_Mode` | `building-view.ts` 负责 MAKE、逆向出售、受损帧、炮塔、SAM、精炼厂、维修扳手及建造厂工作动画。建筑受损火焰在 `building-effects-cpu.ts` 与 `building-effects-gpu.ts` 中处理，包含 `ANIM.CPP` 的定点累计伤害。建筑动画画面已经通过试玩验收。 |
| `Mark`、`Sort_Y`、`Center_Coord`、`Docking_Coord`、`Remap_Table`、`Hidden`、`Pip_Count` | 放置与绘制使用原版占地、中心及停靠偏移。`ground.ts` 包含排序的 CPU 参照与 GPU 实现。仓储、弹药和乘员标记使用原版 `HPIPS.SHP`；建筑移除后保留无主地坪。 |
| `Unlimbo`、`Grand_Opening`、`Limbo`、`Revealed`、`Look` | 建筑放下后登记，施工结束时增加用电和容量。赠送矿车先尝试精炼厂西南格，再找附近位置，均失败才退款。赠送飞机取房屋阵营。销毁时等移除建筑再结算容量。 |
| `Receive_Message`、`Exit_Object`、`Find_Exit_Cell` | 由 `harvest`、`services`、`transport` 和 `air-operations` 的 CPU/GPU 实现处理。设施接洽互斥，兵营出口全部堵塞时保留生产完成状态，C-17 卸货后结束机场接洽。 |
| `Flush_For_Placement` | 电脑建造时驱散占地内友军或请求攻击敌军，属于 M6 的基地 AI；玩家放置仍检查即时占用。 |
| `Update_Buildables`、`Toggle_Primary`、两个 `Active_Click_With` 和两个 `What_Action` | 侧边栏保留已解锁的生产选项。再次点选同类工厂可以切换主要工厂；没有主要工厂时选择最后一个合格工厂。SAM 不接受玩家指定攻击目标。 |
| `Assign_Target`、`Fire_At`、`Fire_Coord`、`Greatest_Threat`、`Can_Fire`、`Fire_Direction`、`Mission_Guard`、`Mission_Attack` | CPU/GPU 战斗处理炮口、射程、防空和低电量限制。SAM 每次旋转 15，炮塔每次旋转 12；玩家的防御建筑不会自动选择建筑目标。专项检查覆盖伤害、低电量和目标资格。 |
| `AI`、`Take_Damage`、`Drop_Debris`、`Crew_Type`、`Death_Announcement` | 包含建筑伤害、SAM 收起减伤、八帧延迟移除、逃生乘员和完整占地的爆炸、火焰与残骸。出售建造厂的乘员最多包含一名工程师。电脑维修与生产归 M6，突击队破坏归 M6，特定战役逃生人物归 M6.5。 |
| `Repair`、`Sell_Back`、`Can_Demolish`、`Mission_Construction`、`Mission_Deconstruction` | 建筑可以修理和逆向出售。维修站可以出售停靠车辆，精炼厂卸货期间限制出售，移除仓储时扣除失去的库存。默认关闭 `IsMCVDeploy`，出售建造厂按退款规则，不启用可选的重新打包规则。 |
| `Mission_Harvest`、`Mission_Repair`、`Mission_Unload`、`Enter_Idle_Mode` | 矿车进出轨迹、装卸动画、飞机补弹和工厂开门已经接入设施接洽状态。采矿、补弹和维修循环有 CPU/GPU 对照。 |
| `Power_Output`、`Refund_Amount` | 按原版两次定点转换计算发电量；退款以 `Raw_Cost` 为基础。`IsV107` 默认关闭，其兼容模式额外返还库存的分支不启用。 |
| `Detach`、`Detach_All` | 对象移除后释放接洽和生产关系；最后一个合格工厂丢失时取消生产。C-17 的机场丢失与退款路径有专项检查。 |
| `Can_Enter_Cell`、`Passes_Proximity_Check` | 完整放置占地和邻接检查在 `building-rules.ts`，即时单位占用和矿石由 GPU 复核。原版有主地坪会阻止建造，不能把它当作普通空地。 |
| `Read_INI`、`Write_INI` | 读取由场景解析器负责；场景编辑和写回 INI 不属于 M5。建筑触发器归 M6.5。 |
| `Captured`、`Mission_Missile` | 占领和核弹属于 M6，保留本阶段所需的原始阵营数据。 |
| `Fire_Out`、`Update_Specials` | 原版函数没有实际行为。 |

### 飞机函数

| 原版函数 | 处理与检查 |
|---|---|
| `Validate`、`As_Target`、`operator new`、`operator delete`、构造和析构、`Unlimbo`、`Init`、`Debug_Dump` | 使用稳定对象编号、generation 和 GPU 生命周期；离场和销毁清理乘员。C++ 内存管理、虚表及 DOS 调试输出不适用。 |
| `Draw_It`、`Mark`、`Overlap_List`、`In_Which_Layer`、`Sort_Y`、`Pip_Count` | 飞机本体、旋翼、阴影、倾斜、弹药与乘员标记已接入。Chinook 舱门按 `AIRCRAFT.CPP::Draw_It` 和 `DOOR.CPP::Door_Stage` 选择帧。固定翼飞机始终处于顶层；重绘脏矩形由 GPU 绘制取代。 |
| `Read_INI`、`Write_INI` | 原版场景读取已接入；写回 INI 和场景编辑不属于 M5。 |
| `AI`、`Mission_Move`、`Process_Fly_To`、`Process_Take_Off`、`Process_Landing`、`Pose_Dir`、`Set_Speed` | 采用原版整数速度、朝向和高度。起飞等待舱门关闭，进入地面层前复核降落区，C-17 的视野保持为 0，其余己方飞机在飞行和起降时都使用一格视野（设计宪法第三条）。普通飞行已有 CPU/GPU 对照。 |
| `Is_LZ_Clear`、`New_LZ`、`Can_Enter_Cell`、`Cell_Seems_Ok` | 按原版逐圈搜索和接洽对象例外处理降落区；战役中禁止进入未探索区的限制归 M6.5。 |
| `Enter_Idle_Mode`、`Good_LZ`、`Scatter`、`Mission_Guard`、`Mission_Guard_Area` | 无法返回停机坪时选择友军建筑附近的落点，其中停机坪距离除以四。电脑自主出击与维修归 M6，GDI 第七关的特殊等待归 M6.5。 |
| `Mission_Hunt`、`Mission_Attack`、`Good_Fire_Location` | Orca 和 Apache 按原版双发、换位和返航；严格落点检查也排除飞机自身所在格。固定翼轰炸属于本阶段明确排除的空袭。 |
| `Fire_At`、`Take_Damage`、`Fire_Coord`、`Target_Coord`、`Fire_Direction`、`Rearm_Delay`、`Threat_Range` | 使用投影炮口、飞机受伤减半、原版弹药和射击间隔。防空专项覆盖直接命中伤害；掉落炸弹和 AI 全图威胁扫描留给其对应的后续功能。 |
| 两个 `Active_Click_With`、`Player_Assign_Mission`、两个 `What_Action`、`Response_Attack`、`Response_Move`、`Response_Select` | 选择、移动、攻击、停靠和卸载接入原有输入及语音。选中步兵后左键点 Chinook 登机；选中 Chinook 后再次点自身卸载，侧边栏没有卸载按钮。飞机语音候选表与 EA `AIRCRAFT.CPP` 相同；无武装运输机不接受攻击命令。 |
| `Mission_Unload`、`Mission_Retreat`、`Receive_Message`、`Desired_Load_Dir`、`Exit_Object`、`Mission_Enter` | Chinook 逐人接洽并让步兵走入机身，最多装载五人，后进先出。卸载采用原版出口顺序且不等待开门。C-17 处理车辆交付、受阻退款、机场丢失和离场爬升。 |

### 经济和相关规则

类型数据共 112 项：`BDATA.CPP` 的 65 种建筑（含中立建筑和墙）、`UDATA.CPP` 的 22 种车辆、`IDATA.CPP` 的 20 种步兵，以及 `AADATA.CPP` 的 A10、TRAN、HELI、ORCA、C17。A10 保留类型数据，空袭行为不在 M5 范围内。

| 原版出处 | 当前处理与检查 |
|---|---|
| `BDATA.CPP`、`UDATA.CPP`、`IDATA.CPP`、`AADATA.CPP` 的类型构造数据 | EA 与 Nyerguds 的 112 项构造数据有下文列出的 7 处差异。生产数据采用 EA 版本，并按 `DEFINES.H` 启用 `PATCH`、关闭 `ADVANCED`。 |
| `HOUSE.CPP`，`Available_Money`、`Harvested`、`Spend_Money`、`Refund_Money`、`Adjust_Capacity`、`Power_Fraction` | 资金和仓储的 CPU 实现见 `economy.ts`。`economy.test.ts` 检查矿物优先扣款、仓储溢出、出售仓储与摧毁仓储的区别。 |
| `TECHNO.CPP`，`Time_To_Build`；`BDATA.CPP`，`Raw_Cost`、`Cost_Of`；`FACTORY.CPP` 和 `STAGE.H` | `FactoryProduction` 按 108 个阶段生产，保留整数截断、缺钱时退回当前阶段，以及多工厂加速。测试覆盖电厂、精炼厂、直升机坪、坦克和 Orca 的完成时间与总扣款。 |
| `MAP.CPP`，`MapClass::Logic` | 保留每次扫描 30 格、批次边界格重复扫描、正反交替、两个 50 项候选表和矿树的三次入表机会。`tests/economy-fixture.ts` 对照完整 CPU/GPU 状态和重复运行结果。 |
| `UNIT.CPP`，`Mission_Harvest`、`Goto_Tiberium`、`Harvesting`；`CELL.CPP`，`Reduce_Tiberium`；`TYPE.H`，`UnitTypeClass` | 单次采矿量和 28 份满载容量有单元测试；满载对应 700 资金。矿车状态机的 CPU/GPU 对照及两阵营完整开局已经通过。 |
| `BDATA.CPP`，`Legal_Placement`、`Occupy_List`、`Bib_And_Offset`；`DISPLAY.CPP`，`Passes_Proximity_Check`；`UNIT.CPP`，`Try_To_Deploy` | 放置检查包含完整地坪，并区分邻接要求和 MCV 原地展开。单元测试检查地坪被占、缺少邻接建筑、展开位置偏移和生命比例。 |
| `AIRCRAFT.CPP`；`FLY.CPP`，`Physics`、`Fly_Speed` | 普通移动已有 CPU/GPU 实现。浏览器检查运行 400 个逻辑帧，比较移动状态，并检查起飞时机和最终降落。其余函数见上表。 |
| `FACTORY.CPP` 的全部函数；`HOUSE.CPP`，`Begin_Production`、`Suspend_Production`、`Abandon_Production`、`Can_Build` | 原版 108 阶段、资金不足、暂停退款和科技条件已实现。超级武器分支归 M6；C++ 分配和调试接口不适用。 |
| `UDATA.CPP`、`IDATA.CPP`、`AADATA.CPP`、`BDATA.CPP` 的 `Who_Can_Build_Me`；`TECHNO.CPP`，`Find_Docking_Bay` | 优先使用主要工厂，否则使用最后一个合格工厂，排除正在接洽的地面工厂。停机坪已被占用或有返航接洽时，新飞机从地图边缘朝北进入，再飞向附近空地。 |
| `HOUSE.CPP`，`AI` 的电力、提示和库存部分；`LOGIC.CPP` 的扫描登记 | 缺电时每 900 逻辑帧对半血以上建筑造成伤害。施工中的建筑也参与类型扫描和工厂计数，实际服务仍须等施工完成。 |
| `SIDEBAR.CPP`，`StripClass::Add`、`AI`、`Recalc`、`SelectClass::Action` | 生产列表汇总本方工厂，不随选中建筑改变，新解锁选项追加到末尾。前置建筑被毁后保留已解锁选项，对应工厂全部丢失时移除。右键先暂停，再次右键取消；滚动每逻辑帧移动 8 像素。完工提示使用 EA 对应的 EVA 语音，画面读取原版 SHP、字体和进度。 |
| `RADAR.CPP`，`Radar_Activate`、`AI`、`Radar_Anim`、`Plot_Radar_Pixel`；`POWER.CPP`，`AI`、`Power_Height` | 雷达地图、缩放、开关动画和原版电量高度已接入。电量条逐像素变化，到达目标后按原版 12 帧偏移表摆动。 |
| `UNIT.CPP`，`Receive_Message`、`Desired_Load_Dir`、`Mission_Unload`、`APC_Open_Door`、`APC_Close_Door`、`Draw_It` | APC 装载五名步兵，按接洽方向转向和开门，卸载按后进先出处理。乘员在接洽忙碌时仍向载具靠近，走入载具后才隐藏；出口受阻时保留乘员。已通过 `transport.test.ts` 和 `tests/transport-fixture.ts`；转向、开关门和卸载函数与 Nyerguds 核对一致。 |
| `UDATA.CPP`、`AADATA.CPP` 的 `IsTransporter`；`REINF.CPP` 的 `Do_Reinforcements` | 运输类型包括 APC、Chinook、LST 和 C-17。APC、Chinook 提供玩家常规登乘操作；C-17 用于机场交付。LST 的海运增援属于 M6.5。 |
| `CARGO.CPP`，`Attach`、`Detach_Object`；`REINF.CPP`，`Create_Special_Reinforcement` | 乘员后进先出和临时 C-17 运输任务已经接入。战役人物撤离、海运援军和关卡触发器归 M6.5。 |

Nyerguds 与 EA 构造数据的差异是：`HPAD.is_factory`、`NUKE.is_simpledamage`、`NUK2.is_simpledamage`、`HOSP.is_nominal`、`MSAM.is_gigundo`、`E5.is_fraidycat` 和 `E5.scenario`。本阶段以 EA 为准，没有把这些差异一并移植。

EA 与 Nyerguds 的 `FACTORY.CPP` 排除注释、空白和调试校验后，20 个函数定义一致。下列建筑和飞机行为差异采用 EA 版本：

| 函数 | Nyerguds 的差异 |
|---|---|
| `BuildingClass::Draw_It` | 简单受损帧使用总帧数的一半；EA 使用倒数第二帧。 |
| `BuildingClass::Fire_At` | 给 SAM 增加开火声音。 |
| `BuildingClass::AI` | 调整电脑维修和出售时使用的关卡等级；属于 M6 的 AI 核对。 |
| `BuildingClass::Take_Damage`、`Death_Announcement` | 增加摧毁提示调用，并调整阵营与友军的提示条件。 |
| `BuildingClass::Drop_Debris` | 改变逃生乘员的任务、遭破坏后的开火延迟和弹坑位置。 |
| `BuildingClass::Repair`、`Mission_Repair` | 增加维修语音；EA 的这两个入口没有播放该语音。 |
| `BuildingClass::Captured` | 调整占领提示和重绘条件；占领属于 M6。 |
| `AircraftClass::Active_Click_With`、两个 `What_Action` | 去掉部分重复命令，调整强制攻击及未探索区域的操作条件。 |
| `AircraftClass::Can_Enter_Cell`、`Good_Fire_Location` | 将未探索区域限制扩展到多人模式；EA 仅在战役分支检查。 |
