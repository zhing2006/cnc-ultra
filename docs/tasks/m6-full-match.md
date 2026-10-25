# 里程碑 6：原版地图上的一局对战

## 目标

在原版的多人地图 scm01ea（Green Acres）上，GDI 和 Nod 各从一辆 MCV 开局，默认由两个电脑对手一直打到分出胜负。玩家可以随时接管其中一方，也可以交还给 AI 继续观看（产品宪法第七条第一点）。在里程碑 5 的经济、建造、飞机和防空基础上，补齐超级武器和其余单位特殊能力。

## 原因

这是第一版的第一项（产品宪法第四条），要证明这是一个能从开局玩到分出胜负的游戏。1995 年的原版没有会造基地的电脑玩家，`INI.CPP` 的注释里写着 “we have no base-building AI logic”。2020 年的重制版从《红色警戒》复制了一套会造基地的 AI，所以电脑对手从重制版移植（设计宪法第一条）。

## 范围

要做：

- 电脑对手会造基地、采矿、生产和进攻，也会使用超级武器，从重制版的代码移植。规则和数值仍然以 1995 年的原版为准。
- 补齐超级武器及其建筑功能，包括离子炮和核弹。一局对战中，多人模式下能造的单位和建筑都要能造，科技等级固定开到最高；经济、建造、飞机和防空沿用里程碑 5 的实现。
- 单位的特殊能力：工程师占领建筑、突击队炸建筑、隐形坦克隐身。
- 新增 `?demo=match`，固定使用 scm01ea，固定 GDI 对 Nod。判定胜负，一局结束以后可以在不刷新页面的情况下重新开局。
- 调试面板提供双方接管、迷雾视角、整场模拟快进和种子设置，具体行为见“对战演示”。
- 把演示场景、演示专用规则和调试面板集中到 `src/demo/`，与 `src/game/` 的正式游戏规则分开。

不做：

- 宝箱、夺旗和空袭。在原版的多人模式里，空袭只能从宝箱里得到。
- 联机（产品宪法第五条）。
- 地图选择，留到下一个里程碑再安排；本阶段也不提供同阵营对战配置。
- 受迷雾限制的战略情报系统。AI 保留重制版的战略信息权限。
- 开场动画、主菜单、音乐、游戏内的选项菜单和存档，放在里程碑 6.5。

## 对战演示

`?demo=match` 默认是两个 AI 对战。调试控件放在原版界面之外，保留暂停功能。

- 控制方式可以选“观战”“接管 GDI”“接管 Nod”。接管后，该方 AI 停止发出新命令，已有命令和生产队列继续执行。切换到另一方或回到观战时，交还的一方从当前局面继续由 AI 控制，不重置基地和部队。
- 迷雾视角可以独立选择 GDI、Nod 或全图。切换只影响显示，不改变控制权、探索记录、AI 信息权限或单位索敌规则。
- `1× / 10× / 100×` 调整整场模拟的逻辑帧推进速度。移动、战斗、经济、AI 和超级武器都按同一倍率推进，每个逻辑帧完整执行。倍率是目标值，达不到时尽力运行并显示实际倍率，不跳过逻辑帧，不修改单位数值或生产规则。
- `1×` 正常播放声音，`10× / 100×` 默认静音。恢复 `1×` 时不补播快进期间的声音；暂停时不触发新的游戏声音。接管时只播放该方的状态 EVA，观战时不播放阵营状态提示。核弹来袭和建筑被占领向双方播报，切换控制方会清除旧的 EVA 队列。
- 未指定种子时使用 `1995`，显示在面板中并写入 URL。URL 中指定的有效种子优先使用，不再每次启动随机生成。可以输入种子，也可以选择“同种子重开”或“随机种子新局”。修改种子只对新局生效。相同种子和相同玩家命令应当复现相同模拟状态，纯 AI 对局不需要人工输入。
- AI 从重制版移植，保留 `HOUSE.CPP::Expert_AI` 读取敌方基地位置、建筑和部队统计的权限。不得为演示额外发钱、刷兵或加速。单位索敌和隐形单位发现仍按原版规则处理。

## 参考

重制版的源码在 `refs/source/cnc-remastered-collection/TIBERIANDAWN/`：

- `HOUSE.CPP` 里 `USE_RA_AI` 下面的 AI，包括 `Expert_AI`、`AI_Building`、`AI_Unit`、`AI_Infantry` 和 `AI_Aircraft`。

原版源码在 `refs/source/cnc-tiberian-dawn/`：

- `HOUSE.CPP` 里启用离子炮和核弹的地方、`HouseClass::Has_Nuke_Device` 和 `HouseClass::Special_Weapon_AI`，以及 `SUPER.CPP`：超级武器的条件和充能。
- `INFANTRY.CPP` 的 `InfantryClass::Per_Cell_Process`：工程师占领建筑。`BUILDING.CPP`：建筑被突击队炸毁。`TECHNO.CPP`：隐形坦克的隐身。
- `INI.CPP` 里多人地图开局的设置，`HOUSE.CPP` 的 `HouseClass::MPlayer_Defeated`：开局和失败的判定。

## 原版行为核对

标成“待验收”之前，要对照源码逐项核对这一步新加的行为。下面这些都要一个一个读过：

- `SUPER.CPP`，以及 `HOUSE.CPP` 里和超级武器有关的部分。
- `INFANTRY.CPP`、`UNIT.CPP` 和 `TECHNO.CPP` 里，工程师、突击队和隐形坦克用到的函数。
- 里程碑 5 的核对记录里，标成放到里程碑 6 的条目。
- 电脑对手：重制版 `HOUSE.CPP` 里 `USE_RA_AI` 下面的每一个函数。

读到的每一条行为都记在任务单最后的“核对记录”一节，写明出处的文件和函数，再写这里是怎么处理的。做了的，写由哪项自动测试或者试玩检查覆盖；没做的，写放到了哪个里程碑，或者为什么不适用。

## 验收标准

- 超级武器的充能时间和伤害都和原版一致。（自动测试）
- 一局结束以后重新开局，用同样的种子，新一局开局时的模拟状态和第一局开局时逐位相同。（自动测试）
- 相同初始状态和命令在不同快进倍率下推进到相同逻辑帧时，模拟状态逐位一致。切换迷雾显示不改变模拟结果。（自动测试）
- 本阶段新增的 GPU 模拟系统都有 CPU 对照，NVIDIA 和 AMD 都通过功能与确定性检查。记录显卡、驱动、浏览器版本和实测成本。（自动测试）
- 在 scm01ea 上，GDI 和 Nod 各从一辆 MCV 开局，由 AI 打到按原版规则分出胜负，中途不刷新页面。整局由项目负责人观看验收，不设置固定种子的批量整局通关门槛。（试玩检查）
- 电脑对手会造基地、采矿、生产和使用地面单位及飞机，能组织防空，也会使用超级武器。（试玩检查）
- 双方均可接管、操作和交还 AI，接管时可以指挥、建造和使用超级武器；迷雾、快进、声音、种子设置和重开符合“对战演示”的约定。（试玩检查）
- 核对记录列全了这一步新加的行为，每一条都写了出处和处理方式。（对照源码检查）

## 实施状态

M6 进行中。主要功能已经接入，较早的区域驻守版本完成过一局无绘制 AI 对战。独立 Review 指出的规则缺陷已经修正，并通过受影响的单测和 NVIDIA 专项。本轮按项目负责人要求没有运行全量或双卡检查，最终验收和当前版本的整局试玩仍未完成。演示与运行框架包括：

- `src/demo/` 保存现有演示场景的组装、素材预览、调试面板和 URL 配置。建筑演示的额外资金、运输机波次和生产加速也在这里。`src/game/`、`src/engine/` 不引用这个目录。
- `src/game/game-setup.ts` 和 `src/game/simulation/economy-setup.ts` 定义场景输入，正式运行逻辑接收准备好的场景，不判断演示名称。演示入口调用同一套游戏运行逻辑。
- 现有演示的面板增加了整场逻辑帧 `1× / 10× / 100×` 和实际倍率显示。调度器在短任务中推进模拟，经济报告返回后可以继续执行，不必等待下一个渲染帧；每次仍然只处理一个逻辑帧。暂停、后台切换和修改倍率都会清除待追赶的墙钟时间。
- 双方各自保存探索记录。显示层从中生成一个独立的 GPU buffer，支持己方、对方和全图显示，雷达使用相同视角。切换不改动模拟视野，也不改变当前控制方。使用单个显示 buffer 是为了不超过 WebGPU 默认每阶段 8 个 storage buffer 的限制。
- 快进和暂停时停止声音，恢复后不补播 EVA 队列或迟到的战斗音效读回。

`?demo=match&seed=1995` 可以启动固定地图上的双方 AI 对局。双方共用地图、对象槽位和 GPU 模拟，各自保存资金、工厂、队列及探索记录。面板支持观战、接管任一方、独立切换迷雾视角、修改种子和不刷新重开；胜负按除围墙以外的存活建筑和单位统计判定。

离子炮、核弹、工程师占领、突击队 C4 和隐形坦克已经接入。超级武器使用原版图标、动画和音效，玩家可以从侧边栏指定目标，AI 根据敌方建筑价值选择目标。占领会转移建筑的容量和溢出的库存，不会额外赠送采矿车。

AI 已经接入生产、建造选址、维修、紧急出售和进攻调度。新生产的 MCV 会等工厂出口流程结束，再找空地展开。建造遇到友军堵位会请求散开；敌军堵位或无武装建筑受击时，会招募最多六个协防单位。协防在 GPU 上建立可用单位索引，再按评分上界搜索附近单位，不为每个攻击者遍历整支部队。

开发期间只运行改动相关的专项，不反复执行完整回归或双卡大组合。下面保留各阶段的结果，不能把较早的通过记录当作当前版本已经验收。

### 独立 Review 修正

本轮修正了围墙阻止判负、EVA 混播、AI 自动获得核弹、完成建筑无处放置后占住队列、占领后继续攻击，以及隐形与索敌相关的缺陷。隐形完成后的散开保留碾压通行规则。CPU/GPU 统一先处理碾压，再结算工程师和 C4，之后检查隐形接触。飞机不混入地面占格候选；占领会解除当前和挂起的攻击目标，但隐形或占领不会让已发射的导弹失去目标。

Nod AI 不会凭神庙获得新的核弹。玩家接管时可以获得；交还 AI 后保留已有的充能和发射能力。开局位置改为从地图路点按原版的距离排序和随机分配规则选择，使用模拟自己的种子。M6 有两个参战方，按原版默认的四个最大玩家槽位选择位置，默认种子仍为 `1995`。

无合法建造位置时，AI 放弃完成的产品并退款。临时被单位挡住时，复用创建结果报告设置 45 帧重试等待，不增加额外的 GPU 回读。已有产品在这段等待中保留。

复现失败日志保存在 `test-results/review-cpu-before.log`、`test-results/review-house-before.log` 和 `test-results/review-house-gpu-before.log`。新增的 `tests/review-scenarios.ts` 同时供 CPU 单测和单卡 GPU 对照使用，涵盖同格飞机与步兵、隐形散开、碾压与占领同帧、接触显影、导弹追踪以及占领后的任务恢复。GPU 阶段样本不绘制，也不等待 RAF。

本轮结果：

- `pnpm check`：0 errors、0 warnings。
- 受影响的 11 个单元测试文件：135 项通过，完整命令在 `test-results/review-final-unit.log`。
- `pnpm test:e2e --only=matchregressions,match,matchfoundations,navigation,matchcrew,matchai,combat`：七组通过，140.2 秒。
- 补充占领后挂起任务恢复的断言后，`pnpm test:e2e --only=matchregressions,matchcrew,navigation,combat`：四组通过，95.4 秒。阶段样本与正常对局共用 CPU/GPU 的后移动结算入口。

两次浏览器检查均使用 NVIDIA GeForce RTX 5090 D、驱动 `32.0.16.1664`、Chromium `156.0.8078.4`。没有运行 AMD、完整验收或两万单位性能测量。本轮后的性能仍未实测。检查日志为 `test-results/review-final-check.log`、`test-results/review-affected-browser.log` 和 `test-results/review-final-browser.log`。

### 后续 Review：进门结算与开局槽位

此前把工程师消耗和建筑转移放在了同一个敌我判断中，导致第二名工程师走进已被友军占领的建筑后留在里面。现在按照 `INFANTRY.CPP::Per_Cell_Process`，工程师进门后仍被消耗，只有确实变更所属方时才转移建筑和解除目标。强制 C4 也不再被这个所属方判断拦住。

开局分配此前误用了参战人数。原版 `GLOBALS.CPP` 的 `MPlayerMax` 默认是 4，`INI.CPP::Create_Units` 从这个最大槽位集合中随机分配，并不保证两人局一定处于对角。排序也改用 `FUNCTION.H::Distance(CELL,CELL)` 的格子距离，保留较短轴除以二时向下取整。原来断言两人必在对角的测试已经更正。

修改前五项复现失败；修正后三个相关单测文件共 18 项通过，`pnpm check` 为 0 errors、0 warnings。`pnpm test:e2e --only=matchregressions,matchcrew,match` 在 NVIDIA GeForce RTX 5090 D、驱动 `32.0.16.1664`、Chromium `156.0.8078.4` 上通过，耗时 108.3 秒。没有运行全量或双卡。记录为 `test-results/review-followup-before.log`、`test-results/review-followup-check.log`、`test-results/review-followup-unit.log` 和 `test-results/review-followup-gpu.log`。

### 协防性能修正

第二轮完整检查中，NVIDIA、AMD 各 18 组功能与确定性检查通过，总计 672.0 秒。但是两万对象、连续八次协防请求的 GPU 耗时严重超出预算，因此这一轮不能算里程碑性能验收通过。拆分计时后确认，NVIDIA 的索引构建低于约 0.07 ms，耗时来自单个 invocation 中的串行空间搜索，每次查询约 48–65 ms。

协防查询已经改成按空间块并行筛选，再合并各块的前六名。分数相同时仍按步兵、车辆及稳定 ID 排序；已分配的威胁值和后续请求的候选资格仍逐次更新。`pnpm test:e2e --only=matchai,combat --acceptance --gpus=nvidia,amd` 在两卡通过，总计 107.7 秒，包含两万对象的 CPU 对照。

| GPU | 修正前，八次请求 | 修正后，八次请求 |
|---|---|---|
| NVIDIA GeForce RTX 5090 D，驱动 `32.0.16.1664` | 472.58–475.27 ms | 0.59–0.85 ms |
| AMD Radeon(TM) Graphics，RDNA 2，驱动 `32.0.21042.62` | 563.09–564.85 ms | 4.46–4.59 ms |

两次均使用 Chromium `156.0.8078.4`，三次预热后取五次样本。这里不包含渲染，尤其不能把 AMD 数值当作整场帧率。NVIDIA 专项加入了单独超过 16.67 ms 就失败的检查；低于这个上限仍不等于整场达到 60 FPS。

原始记录为 `test-results/m6-defense-before-nvidia.json`、`test-results/m6-defense-before-amd.json`、两卡目录下的 `m6-scaling.json`，以及 `test-results/m6-defense-final-dual.log`。

### 待处理的观战反馈

项目负责人报告的红方矿车停滞已经复现。原起点配置下，38 号矿车满载 28 单位矿物返厂后，停在入口旁两格。导航目标被清除，但采矿状态仍为返厂，记录中从第 9300 帧持续到第 26700 帧没有恢复。按 `BUILDING.CPP::Receive_Message(RADIO_DOCKING)` 补上重新发送进厂目标后，单测和此前的双卡小场景已经验证卸货及恢复采矿。修正后的原起点场景运行到 15000 帧，38 号车继续行驶，draw call 为零；记录为 `test-results/m6-harvester-after.log` 和 `test-results/m6-simulation-1995-history.jsonl`。

蓝方等待驶出的记录也已经定位：第 19200–21000 帧，15 号己方步兵一直驻守在 1475 格出口，12 号矿车已经卸空，却停在等待驶出的状态。原版 `BUILDING.CPP::Mission_Harvest` 在每次卸矿时对出口调用 `Incoming(0, true)`，本项目此前漏掉了这一步。

现在卸矿会请求出口上的单位散开，沿用已有移动系统的选格与占位裁决。步兵正在执行移动命令或不可打断的动作时仍按原版规则处理，不会一律取消命令。GPU 使用少量位标记记录请求，再并行处理，没有新增 CPU 回读。回归测试验证了驻守步兵让路、矿车驶出和重新采矿。

本次 `pnpm check` 输出 0 errors、0 warnings。受影响的经济、移动和区域驻守三个单测文件共 67 项通过；`pnpm test:e2e --only=harvest,navigation` 两组通过，总计 17.5 秒，使用 NVIDIA GeForce RTX 5090 D、驱动 `32.0.16.1664`、Chromium `156.0.8078.4`。记录在 `test-results/harvest-exit-before.log`、`test-results/harvest-exit-check.log`、`test-results/harvest-exit-unit.log` 和 `test-results/harvest-exit-gpu.log`。没有运行全量或双卡检查。

这两条矿车缺陷已有各自的回归测试，但本轮 Review 改变了开局位置分配，旧起点的对局记录不代表当前版本的整局验收。

### 当前版本交付观战前的检查

默认种子为 `1995`，URL 可覆盖，面板仍提供手输种子和随机新局。开发服务器已经启动，入口为 `http://127.0.0.1:5173/?demo=match`。

- `pnpm check`：0 errors、0 warnings。
- `pnpm test`：30 个文件、673 项测试通过。
- `pnpm test:e2e --only=match,economy`：NVIDIA 上两组通过，总计 113.9 秒。覆盖无种子 URL 的默认值、控制权交接、同种子不刷新重开，以及经济、飞机、创建命令和建筑操作。
- `pnpm test:acceptance`：两卡各 18 组功能与确定性检查通过，但该轮发现了下面记录的协防性能问题。修正后只重跑相关双卡专项，没有用旧的全量结果冒充当前版本的最终验收。当时的实际对局帧率和快进倍率已经测量，见后文；这些结果早于本轮 Review 修正。

输出保存在 `test-results/m6-ready-check.log`、`test-results/m6-ready-unit.log`、`test-results/m6-ready-browser.log` 和 `test-results/m6-final-acceptance.log`。

首轮完整验收在 NVIDIA 阶段中断，未进入 AMD，不能算完整结果。它报出了一个仍依赖突击队自动开火的旧测试，以及三个页面启动超时。旧测试已经改成显式攻击命令；测试调度限制为最多四组并发，避免同时编译全部页面的 shader，没有放宽功能断言或延长启动时限。该轮日志保存在 `test-results/m6-final-acceptance-attempt1.log` 和同名 `-error.log`。

随后战斗专项在第 624 帧发现 CPU/GPU 差异：GPU 的惊慌散开分支没有排除被敌方步兵部分占用的格子。惊慌散开和建造驱散两条 GPU 路径已经补上同样的检查。战斗行军、寻路和 AI 协防三组专项通过，总计 45.7 秒，输出在 `test-results/m6-final-scatter.log`。该修正之后的完整双卡检查结果与后续协防性能修正分开记录。

### 基础阶段自动检查

- `pnpm check`：最终输出 `svelte-check found 0 errors and 0 warnings`。
- `pnpm test`：18 个文件、628 项测试通过。
- `pnpm test:e2e --gpus=nvidia,amd`：两块 GPU 各 13 组日常检查通过，最终输出 `browser checks passed (200.0s total)`。同一个 Vite 服务供两轮检查使用，实际 WebGPU adapter 均已核对。这不是 `pnpm test:acceptance` 的完整里程碑验收。

| GPU | 驱动 | Chromium | 日常检查 |
|---|---|---|---|
| NVIDIA GeForce RTX 5090 D | 32.0.16.1664 | 156.0.8078.4 | 13／13，通过 |
| AMD Radeon(TM) Graphics，RDNA 2 | 32.0.21042.62 | 156.0.8078.4 | 13／13，通过 |

新增检查覆盖双方视野的 CPU/GPU 对照、切换视角前后的状态不变、不同倍率下相同命令的逐位结果，以及暂停和异步报告的执行顺序。面板检查复用战斗检查中已经暂停的页面，没有另开同样的场景。GPU 耗时、完整帧率和实际场景的 `100×` 达成率未实测。

检查结果保存在 `test-results/acceptance.json`、`test-results/nvidia/`、`test-results/amd/`，本轮终端输出在 `test-results/m6-check.log`、`test-results/m6-test.log` 和 `test-results/m6-e2e.log`。

### 自查修正与专项结果

自查修正了以下问题，修正前先运行复现测试，确认失败：

- 地图外围等待进场的增援提前揭开迷雾。CPU 和 GPU 现在都按 `MAP.CPP::Sight_From` 检查来源格是否在可玩区域内。原版没有把整个探索范围裁到可玩区域，因此来源合法时仍允许揭开外围格子。
- 同一个对象槽位在原地换成了视野更大的单位时，探索缓存只比较中心格，漏掉了扩大后的范围。缓存现在也记录半径，并在对象不能探索时失效。
- 快进时，侧边栏在每个逻辑帧重画 160×400 的像素图。雷达、电力条和列表滚动仍逐逻辑帧推进，但是像素只在需要显示时重画。新解锁图标的解码也提前到开局准备阶段，避免在第一次显示时解码。
- 选择命令的 GPU 回应可能在快进结束后才返回，导致旧的单位语音被补播。每次切换静音状态都会更新播放标记，迟到的回应不能跨过这次切换播放声音。

本次没有重跑全量单元测试或整套浏览器回归：

- `pnpm check`：0 errors、0 warnings。
- 视野、侧边栏、音效、调度器和战斗的 6 个单元测试文件：76 项通过。复现阶段的视野／侧边栏 4 项失败和迟到语音 1 项失败均已修正。
- `pnpm test:e2e --only=matchfoundations --acceptance --gpus=nvidia,amd`：两张卡均通过。这里的 `--acceptance` 只开启这个专项的侧边栏测量，不是完整 M6 验收。
- `pnpm test:e2e --only=economy,transport --gpus=nvidia,amd`：两张卡的两组专项均通过，包含经济演示实际操作、飞机探索和乘员装卸。

侧边栏测量使用 AMD Ryzen 9 9950X，浏览器与 GPU 驱动同上。八个可见图标，预热后交替运行两种绘制方式，各取五次样本；每次推进 1000 个逻辑帧，模拟每 25 个逻辑帧显示一次。表中只测 CPU 状态更新和像素重画，不包含 GPU 上传、最终渲染或完整游戏帧。

| 浏览器使用的 GPU | 每逻辑帧重画，1000 次 | 合并到显示时重画，40 次 |
|---|---|---|
| NVIDIA GeForce RTX 5090 D | 215.4–230.2 ms | 8.7–9.5 ms |
| AMD Radeon(TM) Graphics | 208.5–231.3 ms | 8.5–9.4 ms |

原始样本在 `test-results/nvidia/m6-review-measurement.json` 和 `test-results/amd/m6-review-measurement.json`。专项终端输出在 `test-results/m6-review-unit.log`、`test-results/m6-review-foundations.log`、`test-results/m6-review-integration.log`。这些 CPU 数据不能代表显卡性能或整局快进倍率。

### 对局、特殊能力与 AI 专项

- 双方 AI 开局、控制权切换和同种子不刷新重开，已经通过 NVIDIA、AMD 专项。开局快照比较的是 GPU 模拟状态，不只是地图图像。
- 超级武器伤害、C4、工程师占领、隐形状态、多人模式索敌和飞机 AI 的 CPU/GPU 对照，已经通过两卡专项。相关文件为 `tests/super-weapons-fixture.ts`、`tests/air-ai-fixture.ts` 和 `tests/match-economy-fixture.ts`。
- `tests/match-rendering-fixture.ts` 检查了逐逻辑帧保留烟迹、弹坑和地基，显示时才生成精灵；也检查了隐形的图层组合和离子炮的 SHP 帧。两卡通过。
- 后续补充了 MCV 出厂后展开、建造堵位和建筑受击协防。新增 `pnpm test:e2e --only=matchai` 只运行这些行为，最近一次 NVIDIA 输出 `browser checks passed (27.4s total)`。这些后续改动尚未在 AMD 上重新检查。
- 协防核对发现了原有威胁值读取错误。`TECHNO.CPP` 构造函数会按武器伤害、射程和射速重新计算 `Risk`，并非直接采用单位构造参数里的 80。先用 `base-defense.test.ts` 复现，再修正数据计算。
- 超级武器选点也曾错误地把两格宽、高建筑的中心移到下一格。`super-weapons.test.ts` 已经复现；实现改为先计算原版中心坐标，再转换成格子。修正后与战斗规则一起运行了专项，两个文件共 68 项通过。

上述双卡结果使用 NVIDIA GeForce RTX 5090 D（驱动 `32.0.16.1664`）和 AMD Radeon(TM) Graphics、RDNA 2（驱动 `32.0.21042.62`），Chromium 为 `156.0.8078.4`。它们不代替最终的 `pnpm test:acceptance`。

一次排障用的实局推进到了约 29 分钟逻辑时间，尚未分出胜负。期间发现 AI 的首笔生产付款失败后会停在第 0 阶段，以及旋翼飞机收到 HUNT 命令后没有进入攻击流程。这两处已先用相关测试复现并修正；这次实局不能作为修正后版本的整局结果。

### 无绘制对局排障

`node tests/match-simulation.ts --ticks=90000` 使用真实地图、双方经济和 AI，直接逐逻辑帧调用与游戏页面共用的 `stepBattle()`。它不等待 RAF 或墙钟倍率，不播放声音，也不执行绘制；调用 `render()` 会直接报错。每帧仍然等待经济报告，不能跳过收入、生产或维修。每 3000 帧写一次诊断快照，包含双方账户、队列、存活对象及其命令。这些快照不是游戏存档。

排障先发现了不可达目标的处理问题：目标格本身可通行，但与出发点之间已被建筑隔开时，单位没有走向可达的路径末端。`units.test.ts` 的步兵、坦克复现均先失败，修正后 31 项移动测试通过；`tests/navigation-fixture.ts` 的 CPU/GPU 对照也通过。

这次修正后的种子 1995 对局跑了 90000 帧，仍未分出胜负。双方已有战斗损失，但随后在敌方挡路对象前反复等待。该次无绘制推进约为 236.89 逻辑帧／秒，draw call 为零，使用上表的 NVIDIA、驱动和 Chromium。这个数值不包含渲染，也早于下面的挡路处理修正，不能作为当前版本的性能验收。

继续核对 `DRIVE.CPP::Start_Of_Move` 和 `INFANTRY.CPP::AI/Can_Enter_Cell`，补上了临时攻击敌方挡路者、清障后恢复任务的行为，也修正了敌对步兵错误地共用一个格子的情况。新的移动复现先失败，修正后战斗、移动和协防的三个文件共 101 项通过；无绘制 GPU 专项在同一场景的六条独立通道中检查步兵、车辆、建筑堵路、恢复 HUNT 目标和替换玩家命令，NVIDIA 输出 `browser checks passed (13.8s total)`。`pnpm check` 输出 0 errors、0 warnings。随后还修正了双方步兵同时预订一个空格时的归属冲突。区域驻守及换位逻辑接入后，种子 `1995` 在第 43869 帧由 GDI 获胜，没有额外资源或强制进攻，记录在 `test-results/m6-first-natural-finish.json`。这一局使用上述 NVIDIA、驱动和 Chromium，无绘制推进约 237.03 逻辑帧／秒；它不是渲染性能结果，也早于下面的人员任务修正。

调用路径复核补上了出售建筑后人员的 `GUARD_AREA`，以及 `Drop_Debris` 对 C4 破坏者的追击。`WhomToRepay` 在这里指突击队，不是任意一次伤害的攻击者。创建命令分别携带散开目的地和任务目标，避免一个覆盖另一个。人员任务、双账户和占领专项在 NVIDIA 输出 `browser checks passed (8.9s total)`；相关三个单元测试文件共 33 项通过，类型检查为 0 errors、0 warnings。最终双卡验收尚未完成。

原始报告、阶段快照与终端输出保存在 `test-results/m6-before-obstruction.json`、`test-results/m6-simulation-1995-progress.json`、`test-results/m6-obstruction-unit.log` 和 `test-results/m6-obstruction-gpu.log`。测试会覆盖当前阶段快照，不能把其中途状态当作终局报告。

### 快进绘制测量

快进时绘制上限为 60 FPS，持续跟不上目标时会降低到 30 或 15 FPS。输入仍按显示循环处理，逻辑帧不跳过。排序、烟迹、弹坑和地基历史仍逐逻辑帧更新。

较早的单辆空闲 MCV 场景使用 512 个对象槽位、100× 目标倍率，预热 2 秒后采样约 5 秒。合并精灵投影后，NVIDIA 实际约 16.03×，AMD 约 11.13×；再限制为约 60 FPS 绘制后，分别约 16.60× 和 12.99×。硬件和浏览器版本同上。原始数据在 `test-results/m6-live-after-draw-batching.json` 和 `test-results/m6-live-capped-presentation.json`。

这次测量早于双账户报告扩展、AI 和特殊能力接入，不代表当前完整对局的性能。

### 当前对局的绘制与推进速度

本节数据早于矿车恢复和独立 Review 修正，不能作为当前版本的性能验收。`node tests/match-performance.ts --label=final` 使用种子 `1995` 的真实双方 AI 对局，先快进到约 14000 帧，再依次测试 `1× / 10× / 100×`。每档预热 2 秒、采样约 5 秒，沿用同一局状态，没有加入额外资金或单位。场景有 512 个槽位，采样时约 32–40 个存活对象，不能当作两万单位整帧测量。

| GPU | 目标倍率 | 实际推进倍率 | 绘制提交频率 | 经济报告平均等待 |
|---|---:|---:|---:|---:|
| NVIDIA GeForce RTX 5090 D | 1× | 1.00× | 169.87 Hz | 2.61 ms |
| NVIDIA GeForce RTX 5090 D | 10× | 10.01× | 16.37 Hz | 4.21 ms |
| NVIDIA GeForce RTX 5090 D | 100× | 15.13× | 60.10 Hz | 3.76 ms |
| AMD Radeon(TM) Graphics | 1× | 1.00× | 169.21 Hz | 6.67 ms |
| AMD Radeon(TM) Graphics | 10× | 10.00× | 16.78 Hz | 4.78 ms |
| AMD Radeon(TM) Graphics | 100× | 11.78× | 59.96 Hz | 4.94 ms |

GPU、驱动和 Chromium 版本与上面的协防测量相同。绘制频率来自 `PalettePipeline.render` 调用次数，不是完整 GPU 帧耗时；`1×` 的绘制间隔 p95 分别为 6.31 ms 和 6.32 ms。快进档允许减少绘制，`100×` 的目标没有达到。两卡在最后一档推进到了不同逻辑帧，不能据此做严格的等负载硬件比较。完整 GPU 帧耗时和两万单位的整场表现仍未实测。

原始数据和各档截图保存在 `test-results/m6-live-final.json` 与同名前缀的 PNG 中，终端输出为 `test-results/m6-final-live-performance.log`。

## 核对记录

以下记录已经核对并接入的行为，以及源码中未启用或不适用于本次对局的分支。整局检查和最终性能验收尚未完成。

| 出处 | 本轮处理 | 覆盖 |
|---|---|---|
| 原版 `HOUSE.CPP::AI/MPlayer_Defeated`，`BUILDING.CPP::Unlimbo` | 原版围墙落地后转为 overlay，不进入存活建筑统计。本项目保留围墙对象供模拟使用，但失败判定排除围墙。 | `tests/match-regressions-fixture.ts` 的只剩围墙场景 |
| 原版 `INI.CPP::Create_Units/Sort_Cells/Furthest_Cell` | 先随机选择一个路点，再按离已有点的最小格子距离排序其余路点。按 `GLOBALS.CPP` 默认 `MPlayerMax=4` 建立候选槽位，再为两个参战方无重复分配；较短轴除以二时向下取整。使用本项目的种子随机流，不要求随机数值逐次等同原版。 | `skirmish-scene.test.ts`；`tests/match.ts` 的同种子重开 |
| 原版 `HOUSE.CPP::AI/Attacked`，`BUILDING.CPP::Captured` | 阵营状态 EVA 按当前控制方过滤，占领和核弹来袭全局播放。观战不播放阵营状态 EVA。 | `tests/match.ts` |
| 原版 `BUILDING.CPP::Receive_Message/Mission_Harvest`、`FOOT.CPP::Mission_Enter/Receive_Message`、`CELL.CPP::Incoming`、`UNIT.CPP/INFANTRY.CPP::Scatter` | 返厂导航中断后，炼厂重新发送进厂坐标。卸矿时要求出口上的单位散开，保留步兵的移动与动作打断限制，让矿车能够驶出。 | `economy.test.ts`；`tests/harvest.ts`、`tests/economy-fixture.ts` 的进厂、让路及恢复采矿检查 |
| 原版与 Nyerguds `UNIT.CPP::UnitClass::Look` | 原版只为所属玩家揭开地图。本轮将已有视野实现的所属方改为参数，两方分别保存探索结果，不因观看哪一方而停止计算另一方。 | `src/game/simulation/sight.test.ts`；`tests/match-foundations-fixture.ts` |
| 原版与 Nyerguds `MAP.CPP::MapClass::Sight_From`、`In_Radar`；`UDATA.CPP` 的 MCV 类型数据 | 沿用 MCV 的 2 格探索半径和整数距离裁剪。来源格必须在可玩区域内，探索范围和递归补格仍按网格边界裁剪。缓存同时比较中心格和半径，允许原地替换对象后扩大探索范围。 | `sight.test.ts`；`tests/match-foundations-fixture.ts` 中的增援进场、槽位复用、乘员和所属方切换检查 |
| 原版与 Nyerguds `FINDPATH.CPP::Find_Path` | 最终区域不可达时仍保留可走的路径末端。GPU 利用已有的有界 flow field 缓存求来源格的可达区域，不为此增加 CPU 地图读回。 | `units.test.ts`；`tests/navigation-fixture.ts` |
| 原版与 Nyerguds `DRIVE.CPP::Start_Of_Move`，`INFANTRY.CPP::AI/Can_Enter_Cell`，`MISSION.CPP`、`TECHNO.CPP`、`FOOT.CPP` 的 `Override_Mission/Restore_Mission` | 敌对步兵不能共用格子。武装单位临时攻击挡路者，再恢复原来的目标和移动命令；玩家新命令会取消挂起的任务。可碾压步兵沿用碾压规则，墙体仍检查控制方和弹头类型。 | `combat.test.ts`；`tests/navigation-fixture.ts` |
| 原版 `FACTORY.CPP`、`STAGE.H`，沿用 M5 的规则实现 | 正式队列每个逻辑帧只按原版规则推进。仅演示子类重复推进生产；电厂仍按 108 个阶段、正常电力下每阶段 2 个逻辑帧计费和完成。 | 原经济测试；迁入 `src/demo/production.test.ts` 的加速及价格检查 |
| 原版 `POWER.CPP::AI`、`Draw_It`；`RADAR.CPP::AI`；`SIDEBAR.CPP::StripClass::AI` | 合并像素重画不跳过界面计时。电力条每逻辑帧移动一像素，保留 12 帧摆动；雷达初次激活到第 22 帧；图标列表每逻辑帧滚动 8 像素。 | `src/game/sidebar.test.ts` 的计时、滚动和图标像素检查；侧边栏 CPU 测量 |
| 本任务的快进静音约定 | 单位语音的异步回应带有播放标记，快进或暂停切换后不补播旧回应；有效的新回应仍正常播放。 | `src/game/audio-playback.test.ts` |
| 原版与 Nyerguds `SUPER.CPP::Enable/Suspend/Recharge/Discharged/AI/Anim_Stage`，`DEFINES.H` | 离子炮充能 9000 帧，核弹 12600 帧。缺电暂停时保存剩余时间，恢复后续充；已经就绪的武器不会因为之后缺电而失效。图标沿用 102 阶段。一次性宝箱武器不在 M6 范围内。 | `super-weapons.test.ts` |
| `HOUSE.CPP::AI/Has_Nuke_Device/Special_Weapon_AI/Place_Special_Blast` | 多人模式不要求收集核弹部件，但新核弹仍要求 `IsHuman`。离子炮允许 AI 获得。已有核弹在交还 AI 后继续充能并可自动发射；不把获得条件当成删除条件。AI 选择建筑目标时使用原版中心坐标，两格边长的中心偏移为 255 leptons。 | `house-rules.test.ts`；`super-weapons.test.ts`；最终实局待检查 |
| 原版及重制版 `BUILDING.CPP::Mission_Deconstruction/Drop_Debris` | 出售后的人员保留散开目的地并进入区域驻守。普通建筑毁坏后，玩家人员进入 GUARD，电脑人员进入 HUNT；如果有合法的 C4 破坏者，则进入 ATTACK 并以其为目标。 | `economy.test.ts`；`tests/match-economy-fixture.ts`；生命周期 CPU/GPU 对照 |
| 重制版 `UNIT.CPP/INFANTRY.CPP::Enter_Idle_Mode`、`RULES.CPP::RulesClass`，原版 `FOOT.CPP::Mission_Guard_Area` | 默认最高 IQ 达到区域驻守阈值。非编队电脑地面武装单位结束移动或攻击后进入区域驻守，按驻守点扫描两倍武器射程、最多十格的范围，并受返回距离约束。 | `combat.test.ts`；`guard-area.test.ts`；`tests/navigation-fixture.ts` |
| `BUILDING.CPP::Mission_Missile`，`BULLET.CPP::Unlimbo/AI`，`FUSE.CPP::Fuse_Checkup` | 使用神殿发射过程、上升和下降导弹、原版引信距离判断。发射建筑在下降导弹生成前被毁时取消后续发射。 | `super-weapons.test.ts`；`tests/super-weapons-fixture.ts` |
| `ANIM.CPP::Middle`，`ADATA.CPP`，`COMBAT.CPP::Explosion_Damage/Modify_Damage` | 离子炮在原版动画中间帧造成 600 点 PB 原始伤害。核爆沿用多人分支的 7×7 格、每格 100 点 FIRE 原始伤害，再按目标装甲和距离计算；没有使用战役分支的伤害。弹坑、焦痕和矿物损失进入逐帧历史。 | `super-weapons.test.ts`；`tests/super-weapons-fixture.ts`；`tests/match-rendering-fixture.ts` |
| 原版与 Nyerguds `INFANTRY.CPP::What_Action/Per_Cell_Process`，`BUILDING.CPP::Captured` | 工程师进入可占领建筑后被消耗。建筑原始阵营保留，所属方、容量和库存转移；附属对象随所属建筑转移。不能直接命令工程师占领友方建筑，但先前命令的目标已经被友军占领时，进门的工程师仍被消耗，不重复转移或解除目标。空运输直升机的占领分支不属于本任务列出的建筑占领范围。 | `special.test.ts`；`tests/super-weapons-fixture.ts`；`tests/match-economy-fixture.ts` |
| `INFANTRY.CPP::Assign_Mission/Per_Cell_Process`，`BUILDING.CPP::AI` | 突击队进入建筑后设置 20 帧倒计时，按 5000 点 FIRE 原始伤害处理，并撤出建筑；强制对友方建筑使用 C4 不被敌我判断拦截。原版接到破坏命令时播放 `BOMBIT1`；Nyerguds 改成只对非玩家单位播放，本项目沿用原版。 | `special.test.ts`；`tests/super-weapons-fixture.ts` |
| 原版与 Nyerguds `TECHNO.CPP::AI/Do_Cloak/Do_Uncloak/Do_Shimmer/Visual_Character/Can_Fire`，`FOOT.CPP::Per_Cell_Process` | 保留 38 阶段隐形、受伤后从半程显影、解除隐形以后才能开火，以及相邻侦测者引起的显影。完全隐形的敌人不能被选择、索敌或显示在雷达上；所属方和观战全图仍可看见原版阴影效果。 | `cloak-simulation.test.ts`；`tests/super-weapons-fixture.ts`；`tests/match-rendering-fixture.ts` |
| `TECHNO.CPP::Greatest_Threat/Evaluate_Cell/Evaluate_Object`，`INFANTRY.CPP::Greatest_Threat` | 空中目标单独评分。地面按稳定 ID 选择格内首个敌方对象，再检查类别、隐形和射程，CPU/GPU 使用相同顺序。多人索敌不受单人战役的发现条件限制，不读取观战视角。人类不自动攻击无武装建筑，突击队和工程师保留各自目标类别。 | `match-rules.test.ts`；`review-regressions.test.ts`；`tests/match-regressions-fixture.ts` |
| 原版 `TECHNO.CPP::Captured/Detach`，`BULLET.CPP::Detach` | 占领解除指向该对象的当前和挂起目标，并恢复仍有效的挂起移动任务。`Detach_All(false)` 不解除已经发射的弹体目标，隐形也沿用这个区别。 | `review-regressions.test.ts`；`tests/match-regressions-fixture.ts` |
| 原版 `DRIVE.CPP::Overrun_Square/Start_Of_Move/While_Moving`，`UNIT.CPP/INFANTRY.CPP::Can_Enter_Cell` | 碾压成功后解除隐形；实际移动碰到隐形敌人时产生 `MOVE_CLOAK` 接触显影。GPU 暂存接触标记后统一处理，不依赖线程顺序。碾压先于特殊步兵和相邻侦测结算。 | `review-regressions.test.ts`；`tests/match-regressions-fixture.ts`；`tests/navigation-fixture.ts` |
| 原版 `TECHNO.CPP` 类型构造函数、`Risk/Refund_Amount` | 威胁值从主武器计算，无武器单位的威胁值为零。出售时人类获得一半原始造价，电脑获得原始造价；不按损伤比例额外扣减。 | `base-defense.test.ts`；经济规则测试 |
| 原版 `BUILDING.CPP::AI`，Nyerguds 对应修正 | 原版按地图编号决定电脑维修阈值。SCM01 使用四分之一血量、至少 1000 资金的条件。Nyerguds 多人分支改用等级 20，对应四分之三血量；本项目没有采用这个数值变更。停滞的电脑生产队列按原版建筑 AI 取消后重新决策，避免首笔付款失败后永久停产。 | `commander.test.ts` |
| 重制版 `BUILDING.CPP::AI/Exit_Object` | 没有合法建造位置时放弃产品并退款；临时阻挡时保留产品，等待 45 帧再重试。通过原有创建报告确认 GPU 阻挡，不增加单独回读。 | `commander.test.ts`；`tests/match-regressions-fixture.ts` |
| `AIRCRAFT.CPP::Mission_Hunt/Mission_Guard`，`BUILDING.CPP::Mission_Repair` | 有目标和弹药的旋翼飞机从 HUNT 进入攻击流程。电脑飞机在半血以下且有至少 100 资金时寻找维修设施，修复后继续原有降落与补弹流程。战役第七关的特殊等待归 M6.5。 | `air-ai.test.ts`；`tests/air-ai-fixture.ts` |
| 重制版 `UNIT.CPP::Mission_Guard/Mission_Unload/Mission_Hunt/Goto_Clear_Spot`，原版 `Try_To_Deploy` | 跟踪新生产的 MCV，不再只处理开局那一辆。MCV 等待出厂或运输结束后，按重制版的 36 个偏移随机起点搜索，再调用原版展开规则。CPU 只接收这些 MCV 的小型报告。 | `tests/match-ai-fixture.ts` |
| `BUILDING.CPP::Flush_For_Placement`，`TECHNO.CPP::Base_Is_Attacked`，`FOOT.CPP::Rescue_Mission` | 建造堵位会驱散友军或请求协防，无武装建筑受击也会请求协防。保留威胁评分、最多六名候选者和 225 帧响应冷却。原版及 Nyerguds 的 `value[count]` 存在越界读取，不能移植为确定性行为；这里按函数意图保留六个最高评分，平分时按步兵、车辆及稳定 ID 排序。 | `tests/match-ai-fixture.ts` 的 CPU/GPU 对照和真实伤害报告检查 |

### 重制版 `HOUSE.CPP` 的 AI 函数

此前根据本项目没有发出 `GUARD_AREA` 命令，就把相关分支排除，这个判断有误。复核后已经接入重制版 `Enter_Idle_Mode` 的区域驻守、`AI_Attack` 的驻守换位，以及出售建筑人员的直接任务分配。下表按源码的实际调用和编译条件区分各项，不能用“当前实现没有调用”作为排除依据。

| 函数 | 处理 |
|---|---|
| `Percent_Chance`、`Round_Up`、`fixed` | 使用确定性随机流和整数定点计算。`Round_Up` 恰好为整数时直接返回原值的分支也保留，见 `base-planning.test.ts`。 |
| `Suggest_New_Building`、`Find_Building`、`Production_Begun` | 对应每方建造队列和建筑集合。生产对象确认创建后清除队列，临时受阻时保留产品；没有合法位置时按工厂放弃流程退款。 |
| `Recalc_Center`、`Which_Zone` 的三个重载 | 按建筑中心及造价权重计算基地中心。半径沿用未加权距离和除以加权数量的原式。 |
| `Find_Build_Location`、`Find_Cell_In_Zone`、`Random_Cell_In_Zone` | 按各区防御不足量选择目标区，再选择接近目标点的合法格。原版的格子扫描只要求处于基地四倍半径内，并不强制留在首选区。空候选集时，改换目标区也不会产生合法格，因此不重复扫描同一空集合。 |
| `Zone_Cell`、`Where_To_Go` | `Zone_Cell` 在重制版 `TIBERIANDAWN` 中只有声明和定义，未找到调用。`Where_To_Go` 已接入 `AI_Attack` 的区域驻守换位分支：未参加进攻的驻守单位有 20% 概率重新选择驻守位置。位置按原版环形顺序选择，并使用本项目的静态通行标记排除场景障碍。 |
| `Expert_AI` | 双方固定敌对，因此无需多方敌人排名。保留对敌方数量的全局统计、上限调整、受击状态、紧急出售和进攻调度。原版局部变量 `acted` 没有用于提前结束策略循环，这里也执行各个有效紧急级别。 |
| `Check_Build_Power`、`AI_Build_Power` | 前者计算缺电紧急程度，但后者直接返回 `false`。实际补电由 `AI_Building` 完成。 |
| `Check_Build_Defense`、`Check_Build_Offense`、`Check_Build_Income`、`Check_Build_Engineer` 及对应 `AI_Build_*` | 原代码分别返回无紧急度或 `false`，没有另一套可移植的建造策略。 |
| `Check_Attack`、`AI_Attack` | 一分钟后按冷却检查进攻，保留 33% 出击决策、每个武装单位或工程师的 75% 参与概率，以及无建筑时的强制出击。未出击时仍处理区域驻守换位。间隔沿用 `3 × Random(450, 1800)` 帧。 |
| `Check_Fire_Sale`、`AI_Fire_Sale`、`Fire_Sale`、`Do_All_To_Hunt` | 没有剩余工厂并且不处于受击期时出售建筑，所有地面和空中对象进入 HUNT；不额外生成单位。 |
| `Check_Raise_Money`、`AI_Raise_Money`、`Check_Raise_Power`、`AI_Raise_Power`、`Check_Lower_Power`、`AI_Lower_Power` | 保留阈值、紧急程度和出售类型顺序。`Can_Make_Money` 沿用资金大于 300 或拥有炼厂的判断，并非只看当前是否有采矿车。 |
| `AI_Base_Defense` | 位于 `#ifdef NEVER`，不执行。 |
| `AI_Building` | 保留电力盈余、比例、数量上限、严格资金比较及同优先级的选择顺序。为满足 M6 的完整双方科技树，补入原移植列表缺少的 GDI 防御、HQ、EYE 和 TMPL；它们仍受原版造价及前置条件约束。 |
| `AI_Unit` | SCM01 没有战役 TeamTypes，使用会造基地的分支及武装／支援单位 20∶1 权重，并补充损失的采矿车。 |
| `AI_Infantry` | 保留 E1、E2、E3、E4 权重和最多一个工程师的选择条件。源代码的 `INFANTRY_E7` 对应素材名 E6。 |
| `AI_Aircraft` | 保留机场数量与飞机数量的比较，没有悄悄改成停机坪数量。停机坪赠机仍由原版建筑规则提供。 |
| `AI_Vessel` | `HouseClass::AI` 有调用，但函数主体位于 `#if (0)`，不产生造船行为。原版多人模式没有可建造海军。 |
| `Tracking_Add/Tracking_Remove`、`Recalc_Attributes`、`Get_Quantity` | 由共享 GPU 世界的存活统计、所属方和每类数量提供；生产、死亡、占领都会更新。 |
| `Factory_Counter/Factory_Count`、`Active_Add/Active_Remove`、`Fetch_Factory/Set_Factory` | 复用每方独立的工厂集合和生产队列，不保留 C++ 堆索引。 |
| `Find_Juicy_Target` | 阅读了野外目标评分；该函数在重制版 TD 中没有调用点，不另外启用新策略。 |
| `Read_INI/Write_INI`、`Is_No_YakMig/Is_Hack_Prevented` | 这些移入的实现位于 `#if (0)`。地图由现有解析器读取；本任务不写回 INI，也没有 Yak／MiG。 |
| `Is_Allowed_To_Ally`、`Computer_Paranoid`、`Get_Ally_Flags` | 这些函数并非全部被源码关闭。M6 明确固定双方敌对，不提供结盟；重制版现代多人模式不执行 `Computer_Paranoid`。`Get_Ally_Flags` 有 DLL 查询调用，本项目不沿用该 C++ 接口，由所属方数据表达固定敌对关系。 |
| `Adjust_Power/Adjust_Drain` | 由双方经济账户根据建筑、损伤和建造完成状态更新。 |
