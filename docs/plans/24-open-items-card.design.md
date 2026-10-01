# Open items：状态卡片与轻量侧栏的呈现契约

状态：用户已定稿；指定 astra 完成实现，由 supervisor 按本文启动实现 lead；本设计会话到交接为止。

实现约束：代码保持简洁，复用现有入口与共享投影；测试以关键端到端流程为主，断言用户可见结果，避免按内部函数、调用顺序或每个分支拆出过细测试。

复核基线：2026-10-01，本地 main `69b53ad37d43dfba5e0a7bd4541065df8ef9e963`（0.4.3；相对 `fe047e0` 仅版本文件变化，已含 status-sidebar 与 Pi SDK 0.99.2）。信息分层、去重及 IM 文本优化仍成立；sidebar 复用稳定标题和停靠机制，按用户新反馈改为内容高度的轻量列表，移除占标题宽度的状态徽标，并修复未定稿设计的跳转目标随运行状态变化的问题。

## 对照 main 的结论

| 判断 | 代码证据（该 main 的行号） | 方案调整 |
| --- | --- | --- |
| 已有短标题和常驻侧栏 | `src/web/ui/drawer.ts:246` 优先 session.title；80rem 停靠与 17.5rem 列宽已合入 | 复用短标题及停靠机制；侧栏改为内容高度，无整块背景、外框和阴影 |
| 当前侧栏视觉过重 | `src/web/ui/style.css` 的 `#status-side` 跨满 grid 行并套用 glass、border、shadow；`drawer.ts` 在导航按钮旁放 flex-none 状态徽标 | 内容从 bar 下方开始；状态文字移入第二行，标题不再为徽标预留一列 |
| 原草案的 run.name 优先会倒退 | `src/tasks/open-items.ts:70` 换成该 session 的最新 run；`src/web/ui/drawer.test.ts` 已覆盖续跑 prompt 变长而 session 标题不变 | 稳定标题取 session 创建时的名称，最新 run 仅表示当前执行 |
| 原截图的混排仍存在 | `src/tasks/open-items.ts:118` 一行追加事项状态及全部 runs；`src/core/reply.ts:154` 再输出 run 状态和 review: working | 保留去重、分层、审查文案修正及 IM 分行 |
| 面板尚缺可见元信息 | `src/web/ui/drawer.ts:179` stage 单行截断，`:249` 有 stage 时 run 信息只在 tooltip | 增加必要元信息、完整问题和触摸可达详情，并修复下述导航边界 |
| 面板契约仍是一张平列表 | `docs/design/03-web-workbench.md` 明确 no group heads；sidebar 头已显示 running / needs you 总数 | 面板保留平列表，分组标题仅用于 `/status` 卡片与 IM |
| Web 与 IM 还没有统一稳定标题输入 | `drawer.ts` 额外 join sessions；`main.ts:140` / `:205` 的 status 路径只拿 OpenItems | 在任务事实投影中补齐稳定展示标题，不让 IM 取最新 run.name 冒充同源 |
| 历史与 seed 约束未改变 | `src/core/chain.ts:255` 使用同一 status.text 作 seed；`src/agent/events.ts:87` 仅恢复 sessions 链接 | 保留原话键；结构化 Web 卡仍需显式快照兼容设计 |

已完成 main 静态复核、设计导航六场景及其他导航十三场景的隔离复现，并运行现有六个相关测试文件（140 项通过）；已确认设计入口以及四类额外导航缺陷，详见下文；没有更新本工作树代码基线或执行浏览器验证。

## 目标与范围

让用户依次看清「哪件事」「是否要我处理」「做到哪里」，再按需查看执行细节。

- 覆盖 Web `/status` 卡片、状态面板及其宽屏 sidebar、飞书/Slack 的状态消息与 `/status` 文本。
- 复用任务账本、`openStatus` 和现有事件流，修复未定稿设计入口、异步导航取消、加载失败回退、行身份和历史链接歧义；不增加事项存储、模型摘要调用、轮询或第三方依赖。
- 保留英文界面词汇，标题与阶段沿用任务内容的语言；本次不建立国际化系统。
- 不改变 dispatcher 的派发流程、事项主键、授权规则、状态判定及 IM 消息刷新生命周期。

## 已核对的事实

| 来源 | 当前契约与影响 |
| --- | --- |
| `src/agent/roles.ts`，`DISPATCHER` | `--name` 是用户语言的短标题；`problem` 必须沿用用户原话，是 `<open>` / `<done>` / `<topic>` 的键；stage 可包含待回答问题和持续授权 |
| `src/tasks/open-items.ts` | 由账本补齐每个事项的 runs、goal、workers，再计算 status 与 waitsIn；文本把 problem、stage、事项状态和每个 run 拼成一行 |
| `src/core/reply.ts` | `openRunText` 再输出 run 状态，因此出现 `(running) · running 5m`；`review: working` 实际表示 goal 的初始工作阶段，并非审查已经开始 |
| `src/core/chain.ts` | 同一份 status 文本用于 `/status` 回复及新会话 seed；精简标题若丢掉 problem，会使续接失去事项键 |
| `src/web/ui/chat.ts` | `/status` 是持久化的 chat-command 卡片，现有 origin.sessions 让 run ID 可跳转；并非实时状态面板 |
| `src/web/ui/drawer.ts` | 面板消费结构化 OpenItems 并 join sessions；session 标题优先、run name 次之、problem 兜底；stage 是第二行，run 信息藏于 tooltip；waiting 优先，一张平列表 |
| `src/channels/status.ts`、`src/channels/lines.ts` | IM 消费同源文本，去掉 run ID；截图中的 `▤ open items` 标题由 IM adapter 输出，Web 命令卡标题为 `/status` |
| `src/core/types.ts`，`LedgerRun` | 只有 queuedAt、finishedAt，没有 startedAt；当前 `running 5m` 从入队时间算起，不能设计成精确执行耗时 |

截图：`/home/qiqi/.pier/inbox/lark/1790842040447-b7f678-image.png`；sidebar 反馈截图：`/home/qiqi/.pier/inbox/lark/1790843497148-469fd9-image.png`。

## 推荐呈现

一个事项是一行组，行组间用留白区分；不把每一项做成嵌套卡片。

| 层级 | 显示内容 | 规则 |
| --- | --- | --- |
| 第一层 | 稳定短标题 | 最多两行；占满文字列，不为右侧状态徽标预留空间 |
| 第二层 | 必要状态文字、当前阶段或待回答问题 | 状态使用短词和现有语义色、不带实底；自然换行，问题和授权不截断，不靠 hover 阅读 |
| 第三层 | 时间、审查轮次、必要的子任务概况 | 使用现有辅助文字字号与颜色，允许换行，不与标题串接 |
| 展开后 | 完整原话、完整 stage、每个 run 的名称/状态/时间/链接及 workers/goal 详情 | 一个明确的详情开关，桌面与手机都可用；不存在的字段省略 |

`/status` 卡片与 IM 的示意（sidebar 保留平列表；时间仅作示意）：

```text
Waiting on you · 1

Pi SDK 升级
是否合并 0.99.2 升级？
review clean

In progress · 2

● 宽屏状态侧栏
实现中
elapsed 5m

● BYR 搜索并添加
搜索玩具总动员系列
elapsed <1m
```

- 运行中沿用主题色点和运行指示，不另加 `running` 徽标；辅助技术仍可读到完整状态，关闭动画后也能区分状态。
- 平列表的等待项在第二行以 amber 文字显示 `Needs you · <问题或阶段>`；有 Waiting on you 组标题的卡片/IM 不逐项重复该前缀。
- queued、pending release、stopped 同样是第二行的简短状态文字，分别为 `Queued`、`Pending release`、`Stopped`，不占独立徽标列；名称与后端状态映射由共享函数提供。
- 主题色只标识事项，不能表达成功或失败；错误原因有明确文字，不只换颜色。
- 空阶段不保留空行；不补 `working` 或 `not on the list` 这类无增量信息。
- 较长标题的完整内容放在详情内；原话与短标题相同时只展示一次。
- `/status` 卡片保留现有 solid 阅读材料；宽屏侧栏直接位于 canvas，只有 hover/focus 行及展开的详情使用现有材料，细则见下文。

### 标题与身份

- 标题沿用 main 的优先级：目标 session 的稳定标题，其次是有效账本 run 的 name，最后回退 problem；不存在于账本的占位 run ID 不能充当标题。
- 稳定标题是 session 创建时采用的名称，不是 latestRunForTarget 返回的最新任务名；续跑未指定 `--name` 时，最新任务名可能是整段 steering prompt。
- IM、Web `/status` 和面板必须获得同一稳定标题：由 tasks 从现有创建 run 记录派生可选的事项 title，与最新 run 的状态分别投影；不新增数据库标题副本，不在每次状态刷新遍历 Pi transcript。
- 创建 run 查询按本次涉及的 session 批量读取，复用现有 lead 创建 run 信息；记录缺失时各表面统一按有效 run.name/problem 回退，不编造创建关系；仅面板列出的独立交互 session 仍使用自己的 session 标题。
- 当前 `OpenItems` 尚无此 title 字段，属于本设计建议的小型 DTO 扩展；core 展示函数只接收已解析标题，不负责访问 session 或账本。
- 多 run 事项仍是一项，元信息标明 `N runs`，展开后逐条列出；标题选择沿用上述稳定顺序，不按「最近活跃」来回切换。
- problem 继续作为数据库、topic 颜色、标记、消息定位和 IM reaction 的键；显示标题绝不写回键，也不迁移历史事项。
- task name 本身过长时仅在视图中限制行数；不增加自动摘要，不改名。
- 本次不更改聊天气泡 topic tag 的显示规则；其键与事项导航继续一致。

### 状态与分组

- 所有表面都把 `waitsOnYou` 判定为真的项放在最前；状态面板、popover、sheet、sidebar 沿用 main 的一张平列表和头部总数，不增加组标题。
- `/status` 卡片与 IM 保留 `Waiting on you`、`In progress` 文本组；In progress 包含 running 及未跟踪的 queued run。
- 卡片与 IM 存在 pending release 或 stopped 项时显示 `Other open`，不把它们标成正在执行；空组隐藏。
- 卡片与 IM 的组标题带行数；面板等待项之后沿用现有行顺序，各表面不按计时每分钟重排。
- 状态面板中未被事项持有的独立 session 继续按现有 mark 映射参与列表；头部总数包含这些行，Web 与 IM 的差异来自既有列表范围。
- 运行状态来自 `openStatus`；stage 中可能滞后的 `waiting on you` 不覆盖仍在运行的 run tree。
- 停止项明确显示 run 的失败、取消、中断或账本缺失状态；仅展示现有数据提供的原因，普通 LedgerRun 没有 error 字段时保留会话链接，不由状态猜测错误原因；无事项的 `/status` 仍回答 `Nothing open.`。

### 阶段、时间与审查

- stage 是 dispatcher 写下的语义信息，不再追加 `(status)`；只有实际 waiting 项开头的 `waiting on you:` 可作为显示前缀省略，冒号后的问题完整保留。
- 不用正则猜测、重写自由文本阶段；dispatcher 契约补一条：stage 写具体阶段、待回答问题及有效授权，不重复账本自动显示的 run 状态、时间和审查轮次。
- 单 run 且仍 queued/running：`elapsed <age>` 从 queuedAt 算，含排队；不能写 `running for` 或「执行耗时」。
- 单 run 已结束且没有活跃 goal：显示 `<state> <age> ago`；不把结束多久前写成总耗时。
- goal 仍活跃但 root run 已结束时，概览省略 root 的结束时间与成功状态，避免出现「已完成」却仍在审查；root 的真实信息保留在详情中。
- 多 run 概览不编造一个总耗时；显示 `N runs`，各 run 的时间进入详情。
- 无 goal 时不显示审查信息；初始 `work / round=0` 不显示 `review: working`。
- 审查中显示 `review n/cap`；修复中显示 `fixing · next review n/cap`；清洁结束显示 `review clean`，waiting 徽标表达等待用户。
- 达到审查上限显示 `review cap reached · findings remain`；decision / failed 的非空 reason 必须可见且可换行，不隐藏在 tooltip；legacy merge 状态继续有明确文字。
- workers 全量计数保留在详情；运行中的子任务数量可进入第三层，失败/中断数量不能因折叠而完全消失。

## Web 与 IM 同源

共享事实及展示选择，不要求共享一段最终排版字符串。

- tasks 继续拥有事实读取、稳定标题补齐和 `openStatus`；browser-safe 的 core 中用同一个纯函数构建每项展示文案，建议名 `openItemPresentation`，统一标题回退、状态短词、阶段去重、审查文案、时间语义和详情。
- 函数接收已补齐的事项事实与 now，返回 title、status、statusLabel、stage、metadata、details 等展示字段；statusLabel 可独立省略，分组卡片无需通过替换字符串去掉 `Needs you`。
- sidebar、popover、sheet 及 `/status` 复用这份字段构建与 Web 行内容渲染；IM 只将相同字段按行连接和平台转义，不各写一套 goal/stage/time 判断。
- 历史 `/status` 存储当次函数产出的快照，恢复时不以当前 now 重建文案；面板用当前事实构建，排序和计数仍读原始状态。
- 面板独立 session 的 unread/design 等语义沿用 MARK_ROW 的事实映射，适配为同一展示输入；不把 session unread 推断写回事项的 openStatus。
- Web 面板从现有 OpenItems 快照投影，不解析 IM 文本，不另存事项状态；IM 用同一投影输出纯文本。
- IM 每项按「短标题 + 必要状态」「阶段/问题」「元信息」分行；缺失层省略，项间留一空行；平台 adapter 只负责已有转义与消息材料。
- IM 不输出无法点击的 run ID；多 run 的关键状态按 run name 分行，错误/审查阻塞原因保留，完整原话不在每次刷新重复。
- Web 命令卡保留完整详情；IM 的紧凑文本不承担会话 seed 的身份存储职责。
- seed 必须保留原始 problem、完整 stage 和 run 标识；沿用完整文本投影，不能把短标题卡片文本直接当 seed。
- IM 继续按既有事件刷新；纯时间经过不触发网络刷新或反复编辑消息。

### `/status` 历史与 seam

- 建议在 chat-command origin 增加可选的结构化状态展示快照；只为 `/status` 记录，内容与当次文本同一时刻生成。
- 快照由 core 声明 browser-safe 的最小展示 DTO：事项键、标题、状态、阶段、元信息、完整详情与 run/session 链接；类型不得反向导入 tasks。
- 这是 transcript 中一次命令回答的内容，不是另一份实时事项存储；实时面板仍只消费现有 OpenItems 与事件流。
- `ChainDeps.status` 提供完整 seed 文本、紧凑显示文本和展示快照；三者源于同一次读取，`/status` 选择显示文本，seed 选择完整文本。
- `agent/events.ts` 的历史恢复必须读取并验证可选快照；格式损坏时记录原因并降级为已有文本卡，卡片本身不能丢失。
- 新卡片按快照渲染分层文案、状态文字和 run 链接；旧 transcript 没有快照时保留原文本及 origin.sessions 链接，不用现在的事项状态冒充过去。
- 历史卡片的 elapsed 固定为回答当时的值；实时面板可复用已有 UI 时钟更新相对时间，不增加服务器请求。
- 用户定稿已确认本文的 seam 变更范围；由 astra 在实现阶段完成代码与验证。

## 轻量 sidebar

sidebar 已合入 main `fe047e0`；本次按用户反馈调整容器及行内层级，保留稳定标题、单列表状态、导航和停靠机制。

### 容器与视觉重量

- 宽屏 ≥80rem 时保持侧边可见，宽度仍为 17.5rem；chat 的 44rem 阅读宽度不变，不新增收起开关或偏好设置。
- 列表上缘位于 bar 下方，与 transcript 的顶部内容起点对齐；不与 bar 顶边对齐，也不延伸到 composer 底部。
- aside 按内容自然高度布局、顶部对齐；只有一项时就是标题与该事项的高度，底下直接露出 canvas。
- 取消 aside 的整块 glass/白底、外框、圆角阴影及竖向分隔线；无需用全局 opacity 弱化文字，沿用现有中性文字色保证对比度。
- 列表上限为可用高度与 60dvh 中较小者；可用高度扣除 bar、composer 和安全间距，超出后仅列表内部滚动，头部摘要不滚动。
- 内容自然高度和 max-height 同时成立，不能用 `flex: 1` 把少量事项撑满；复用现有 bar/composer 尺寸来源，不增加另一套 resize 测量状态。
- 当前 grid 的侧栏列继续负责留出宽度；不把列表盖到消息上，不因事项数量变化而横向挪动 chat。
- 零项时整列按既有契约消失；Console 隐藏侧栏；断点切换复用现有列表，不出现两份可交互内容。

### 行内层级与紧凑状态

- 头部保留 `N running · M needs you` 的现有计数，字号 12px、常规字重和辅助文字色，不套胶囊、边框或额外标题。
- 标题沿用 14px 主文字，最多两行；主题点留在左侧，右侧取消 `waiting on you` 实底徽标及其保留宽度。
- 第二行使用 12px 辅助文字；waiting 的 `Needs you` 为 amber 文字，后接阶段/问题，无背景和边框，空间不足自然换行。
- 需要定稿且没有具体待回答问题时，可显示 `Needs you · Finalize design`；必须由 designSessionId 指向未定稿设计且当前状态确为 waiting 的结构化事实决定，不能单凭文字或导航目标把运行中的设计标成等待定稿；原始 stage 中的问题和授权仍完整保留。
- 有具体待回答问题时问题优先；不能把 `是否合并？`、授权范围或阻塞原因替换成泛泛的 `Needs you`。
- 普通运行项第二行只写 stage，第三行仅在存在时间/审查/子任务增量信息时出现；行间 8px 左右留白，不套小卡片或画分割线。
- 每项的详情入口放在末行的轻量 disclosure，与主体导航分开；不再挤占标题宽度，触摸与键盘始终可达，不能只在 hover 才显示。
- 只在 hover、focus 或当前选中项上使用轻微中性底色/可见焦点环；平时只有文字、主题点与必要的状态色。

单事项侧栏示意（无包围外框；下面留空即 canvas）：

```text
1 needs you

● open items 卡片信息优化
  Needs you · Finalize design
  Details
```

`Needs you` 是短状态文字，`Details` 是详情入口；不会出现与标题并排的长徽标。

### 窄屏与材料边界

- 640px–80rem 保留点击状态入口出现的 popover，640px 以下保留 bottom sheet；浮层继续使用现有 menu 材料和遮罩，仅宽屏常驻 aside 去掉外壳。
- 所有宽度复用同一行内容：不出现桌面去掉长徽标、手机仍被徽标挤占的两套规则。
- 展开详情使用既有轻量信息区；不改变正文、顶部 bar 和 composer 的材料。
- 构建从包含 `fe047e0` 的最新 main 承接；本设计工作树仍基于 `0e3617a`，不能直接用旧 drawer 覆盖 main。
- 实现时更新 03/06 中「通栏 glass 侧栏、waiting 实底 tag」的契约为本节；这是本次用户明确要求的设计调整。

## 设计会话跳转修复

规则：只要事项关联的设计会话尚未报告 `Design final:`，点击事项主体始终进入该设计会话，第一次 run、续跑、直接对话和当前 running/waiting 状态均不改变目标。

### 已复现的问题

- main `src/tasks/open-items.ts:46` 在任何执行活动存在时先返回 running，不附带 waitsIn。
- 同文件 `:49` 在 stage 包含 `waiting on you` 或 goal 等待决策时先返回 waiting，也不附带 waitsIn；未定稿设计的判断排在这两条之后。
- `src/web/ui/drawer.ts:252` 只检查 waitsIn，缺失时先定位主会话的 topic，只有 topic 不在屏幕上才回退 run session。
- 所以问题不取决于 run 序号：第二次 run 空闲且 stage 普通时仍能直接进入设计会话；续跑中、直接对话 streaming 或 stage 写了 waiting 时则可能跳回主会话。
- 首次未被事项追踪的 run 使用 unlistedRow，直接打开其 session；成为正式事项后改走 itemRow，也会让问题看起来像「只有第一次能进」。

复现采用 Node 内置 TypeScript 类型擦除和 vm，读取 main 的实际 openItems/ledgerRun/itemRow 源码，账本和 sessions 为内存 fixture、select/showTopic 为记录调用的替身；showTopic 返回 true，模拟主会话已经存在该事项回复，无生产读写、网络或浏览器。

| 场景 | designOpen | main 返回的 status / waitsIn | 实际调用 |
| --- | --- | --- | --- |
| 首 run 结束，普通 stage | true | waiting / design-session | select(design-session) |
| 第二次 run 结束，普通 stage | true | waiting / design-session | select(design-session) |
| 第二次 run 结束，stage 为 waiting on you | true | waiting / 无 | showTopic：错误目标 |
| 第二次 run 正在运行 | true | running / 无 | showTopic：错误目标 |
| run 已结束，但直接对话正在 streaming | true | running / 无 | showTopic：错误目标 |
| 设计已定稿 | false | pending release / 无 | showTopic：符合既有规则 |

六个对当前行为的断言均通过，三种行为违反本设计要求；这不是修复通过的测试，也未核验用户线上那次点击的实时记录。

### 修复方式与边界

- 在任务层 OpenItem 派生可选 designSessionId：从已解析的关联 runs 中，按原顺序取第一条 targetSessionId 属于 openDesigns 的 session；该值独立于 openStatus 的提前返回。
- 复用现有 openDesigns/TaskStore.leads 的设计生命周期事实；不会因为最新 run 变成 reuse 或 worker 角色而丢掉设计身份，不另建设计状态表。
- Web 主体跳转顺序固定为 designSessionId → waitsIn → 主会话 topic → 第一条具有 targetSessionId 的 run session → 主会话末尾；不能先 showTopic 再覆盖为设计会话；加载失败与导航取消必须终止回退，不能当成 topic 不存在。
- waitsIn 保持「等待的回答地点」原语义；designSessionId 表示「尚未定稿的设计入口」，两者不能复用同一个字段，否则运行中事项会被误认为需要用户决定。
- designSessionId 不参与等待分组、needs you 计数或 IM reaction；running 仍是 running，只有导航保持设计入口。
- 服务端随 OpenItems 输出目标，不依赖浏览器 sessions 列表是否已加载，也不让 sidebar、popover、sheet 各自重算；共享展示投影和新的 `/status` 快照携带相同目标。
- 多设计关联项以 run 原顺序的第一条未定稿设计为主体入口，详情保留所有 run/session 链接；未被事项追踪的 run、独立 session 继续直接进入各自会话。
- `Design final:` 被现有机制记录后，重新读取的实时快照不再带该 designSessionId，恢复常规跳转；定稿只改变导航目标，不删除应保留的事项。
- 历史 `/status` 的目标随当次快照固定，属于历史记录；实时 sidebar 以新快照为准，旧文本卡仍只有既有 run 链接。

### 实现时的回归要求

- 以端到端流程验证「设计创建 → 多次续跑/直接对话 → 定稿 → 下一次点击」：定稿前始终进入同一设计会话，定稿后恢复常规规则，状态与计数仍符合真实执行状态。
- 场景中同时保留主会话的 topic 回复，验证 sidebar、popover/sheet 和新命令卡实际落点，避免用内部 select/showTopic 调用次数代替用户结果。
- 将等待 stage、多 run 中设计不是第一项、会话列表尚未加载、失败/中断及直接会话定稿作为关键变体合并验证；下文矩阵是验收范围，不要求每行、每种排列都单独建测试。
- 定稿与事件刷新保持当前阅读位置，只有用户点击才导航；普通事项与 goal 决策路径继续可用。

## 其他跳转场景复核

复核对象包括普通事项、goal 等待、无 run/账本缺失、多 run、未跟踪 run、独立 session、历史 `/status`、topic 定位、主会话轮换、异步导航及列表焦点；代码证据均指上述 main。

### 额外确认的缺陷

| 优先级 | 可复现触发与结果 | 根因与证据 |
| --- | --- | --- |
| P1 | 主会话加载中依次点 A、B，A 的 topic 缺失而 B 已找到；最后仍被 A 的旧回退带到其 run。加载期间改开 Settings，旧回退也会退出设置页 | `main.ts:179` 只检查 continuousOpen，不检查新点击或可见路由；`drawer.ts:253` 的异步回退没有取消检查；`views.ts:54` 打开 Settings 保持当前 session 不变 |
| P2 | 主会话历史请求返回 503，刚显示的错误被自动进入 run session 的加载清掉 | `main.ts:557` 显示错误后正常结束 Promise；showTopic 将错误空屏当成 topic 缺失，drawer 随即回退 |
| P2 | 不同 problem 共用一个 session，焦点原在第二项，状态刷新后落到第一项；随后 Enter 打开错误事项 | `drawer.ts:248` 用 targetSessionId 作行身份，`:334` 只恢复第一个同 ID 行；事项存储按 problem 唯一，不约束 session 独占 |
| P3 | 历史卡两个 run ID 的前八位相同，点第二个链接仍进入第一个 run 的 session | `turn-activity.ts:74` 对截断 ID 用 startsWith + find，默认首个匹配；这是构造碰撞复现，未发现线上实际碰撞 |

上述复现调用 main 的实际 showTopic、select、loadSession、drawSession、itemRow、unlistedRow、fill 和 linkRuns 源码；仅 HTTP、DOM、渲染和路由依赖用内存替身，延迟 Promise 控制完成顺序，不构造真实会话。

### 修复契约

- 同一次事项点击的定位与回退由现有 main 导航入口完成，面板和新命令卡调用同一个入口，避免各自异步 `.then(select)`；不引入通用路由框架。
- 新事项点击、显式 session 选择、返回主会话、Settings 路由切换或浏览器 Back/Forward 都使旧定位失效；每次 await 后及最终 reveal/select/scroll 前校验，最后一次用户导航生效。
- 一次导航自身引发的 head 选择及 hash 同步不算新用户意图；SSE 刷新不取消当前请求，也不自动跳走；不能只比较 session ID，离开再返回同一 session 仍是新导航。
- 主会话成功加载但找不到 topic、加载失败、导航已取消必须能区分；仅第一种进入 run/tail 回退，错误留在原失败位置并沿用现有错误呈现，取消不滚动、不回退。
- 未加载的旧 chain 历史不自动遍历寻找 topic，保留「当前已加载范围内最新回复」的现有契约；无 targetSessionId 时跳过该 run，选有 ID 的首条，全部没有则落到主会话末尾。
- 有 session ID 但服务端报告不存在时显示该会话的错误，不能把“有 ID”冒充“验证存在”，也不能未经选择自动尝试别的 run；独立 run/session 入口沿用按 ID 加载而非依赖列表包含关系。
- 行身份与导航目标分开：事项用 problem、未跟踪 run 用完整 runId、独立 session 用 sessionId，并按行种类区分；两事项同 session、同名 queued runs、run 获得 session 均不能串焦点或展开状态。
- 只恢复原列表内部的焦点，按行身份与具体控件恢复；aria-current 不再由行 key 或第一个 run 推断，只在明确的会话入口匹配时标注，详情链接仍按自身完整 session ID 导航。
- 新结构化卡片直接绑定完整 run/session ID，显示截断不参与寻址；旧卡的完整 ID 精确匹配，截断 ID 仅在唯一候选时生成链接，歧义保留原文本并说明无法唯一定位，不选首个候选。

### 已检查的正常路径与补充验收

| 场景 | 结论或实现验收 |
| --- | --- |
| 普通事项，主会话已加载该 topic | 隔离验证正常：定位最新回复，不进入 run |
| 无 topic 且没有 run/session | 隔离验证正常：主会话滚到末尾；不存在账本的占位 run 不能生成 session 链接 |
| waitsIn 与首 run 的 session 不同 | 隔离验证正常：waitsIn 优先；新增 designSessionId 后仍按前述优先级 |
| 未跟踪 run 有/无 session | 隔离验证正常：分别直接进入该 session 或打开主会话；独立 session 行直接按自己的 ID 打开 |
| 历史卡完整 run ID | 隔离验证正常：使用当次存储的 session 映射，不替换成今日最新 run |
| 加载期间离开到子会话 | 现有普通场景正常；必须增加主会话内 A→B 连点、去 Settings、离开再返回、旧回退已排入微任务的覆盖 |
| 主会话 404/503/网络失败，run 会话成功 | 错误保持可见，不启动 run 回退；重试后才可继续正常 topic 定位 |
| 多 run 首条无 session、后续有 session；目标已删除 | 跳过无 ID 的条目；按 ID 打开后的 404 可见，不能误跳另一会话 |
| 共用 session 的两事项、同名 queued runs、等待目标非首 run | SSE 刷新后焦点和展开仍对应原行、原控件；Enter 打开原事项，当前态不串行 |
| 历史短 ID 同前缀、唯一前缀、完整 ID、无 session 映射 | 分别为明确不可定位、唯一链接、精确链接、原文，不猜测目标 |
| head 轮换、浏览器 Back/Forward、导航自身 hash 同步 | 沿用旧 head 进入连续会话的规则，用户的新导航胜出；自身 hash 同步不能取消自己的点击 |
| popover/sheet 与 sidebar | 主体或详情链接导航关闭浮层、保留 sidebar；展开不跳转；断点切换不把焦点留在不可见行，手机触摸单独验证 |

- 已运行 `main.test.ts`、`drawer.test.ts`、`continuous.test.ts`、`chat.test.ts`、`views.test.ts`、`tasks/open-items.test.ts`：6 文件、140 测试通过，使用 main 现有 Vitest 隔离配置；这些测试没有覆盖上述新增缺陷。
- 本轮另运行 13 个源码隔离场景：六个失败行为复现归属上述四类缺陷，七个正常路径对照；断言针对现有行为，不能当作修复通过。
- 新增验证以真实浏览器中的导航、错误呈现和焦点流程为主，复用现有测试设施；必要时控制 HTTP/SSE 时序，不 mock 掉被验证的导航链路，避免逐函数断言；布局、触摸命中与真实浏览器路由尚未验证，不能由 Node 内存替身的结果推定。

## 交互与 sidebar 边界

- 标题/主体按「设计会话跳转修复」优先进入未定稿设计；非设计项沿用 waitsIn → topic → run session 的回退；详情中的 run 链接始终进入该 run 的会话。
- 详情按钮与导航按钮分开，不能嵌套 button；Enter/Space 可展开，44px 触摸命中区，`aria-expanded` 与可见状态一致。
- 面板内展开不导航、不关闭弹层；Esc 仍关闭弹层并回到入口；sidebar 的 Esc/焦点行为沿用它的契约。
- 展开状态是当前视图内的交互状态，以 problem 或未跟踪 run ID 定位；事件刷新保留焦点、展开状态与滚动位置，移除项后清理对应状态。
- 分组标题不参与卡片键盘导航；面板新增详情开关时，Tab 可遍历行内控件，↑↓ 仍走事项主体，展开内容中的链接不能改变事项导航顺序。
- main 的 `menu.ts` `walkRows` 当前遍历所有 button，`drawer.ts` `fill` 仅按 sessionId 恢复主体焦点；实现详情时需在状态列表局部适配，保留具体焦点控件，并验证停靠/浮动切换，不直接给每行塞第二个按钮后沿用旧遍历。
- 避免一次刷新重建节点导致点击丢失。
- 手机、popover、sidebar、命令卡共用展示规则；面板与卡片共用行内容渲染，容器和点击导航按已有职责处理。

- sidebar 的断点、计数与 chat 阅读宽度承接 main；导航按设计会话修复规则，容器自然高度、轻量材料与状态文字布局按上节调整。

## 验收与实施范围

实现时更新 `docs/design/03-web-workbench.md`、`06-ui-ux.md`、`10-continuous-session.md`、`11-im-conversation.md` 的相应契约；讨论期仅维护本文。

| 验收场景 | 必须成立 |
| --- | --- |
| 截图中的三个任务 | 短标题清楚；没有 `(running) · running` 和 `review: working`；阶段与元信息分层 |
| 名称缺失、多 run、无 run、run 不在账本 | 回退可解释，不出现 ID 冒充短标题；原始 key 可从 Web 详情及 seed 找回 |
| 同一 session 连续续跑、最新 run.name 是长 prompt | 三个表面仍显示创建时的短标题；当前状态来自最新 run；面板现有续跑标题测试继续成立 |
| 设计未定稿，续跑/直接对话/等待 stage，主会话 topic 已存在 | 点击事项只进设计会话，不先跳主会话；running 与 needs you 计数不变 |
| 设计在任意后续 run 或直接会话中定稿 | 实时 OpenItems 清除设计导航字段；下次点击恢复常规规则，当前阅读位置不自动改变 |
| goal 工作、审查、修复、clean、cap、decision、failed | 轮次与现有 goalText 语义一致；根 run 成功不误报事项完成；问题及失败原因可见 |
| running、queued、waiting、pending release、stopped | 卡片/IM 分组正确；面板保持平列表；短状态文字与 needs you 计数继续由现有状态规则决定 |
| 新旧 `/status` 历史、重新加载与 SSE 重连 | 快照保持原时刻；旧卡文本可读；run 链接未丢；异常快照有可见降级和日志 |
| IM 两平台 | 相同输入得到相同语义顺序；转义、长文本与换行正确；去 ID 不损坏标题；状态消息刷新/repost/空列表语义未改 |
| 窄屏 375px、popover、宽屏 1280px+ | 无横向溢出；17.5rem sidebar 可读；触摸、键盘、导航与展开均可操作 |
| sidebar 0、1、3、20 项及短窗口 | 零项隐藏；少项自然高度，无通栏背景/外框/阴影；多项内部滚动，摘要仍可见，不侵入 bar/composer |
| 截图中的长标题与 waiting 项 | 标题占满文字列；第二行短状态自然换行，不存在右侧长徽标；实际问题与定稿入口可达 |
| 同一事项在 sidebar、卡片、IM | 相同字段由同一函数构建，仅分组前缀、链接和排版不同；不出现各表面审查轮次/耗时文案分叉 |
| 浅色、深色、减少动画、连续事件刷新 | 文字状态可辨；焦点/展开/滚动不丢；点击不被刷新吞掉 |

- 测试以少量完整端到端流程为主，合并覆盖展示、详情、导航竞态、失败、历史回放和手机交互；已有测试继续运行，完整 seed、origin 兼容与 IM adapter 等难由浏览器覆盖的边界仅补必要的集成测试，不逐字段、逐函数或逐文案写细碎测试。
- 实现后运行仓库要求的 check、lint、test；实际浏览器验证报告注明浏览器及覆盖范围，Chromium 手机模拟不声称 Safari/iOS 已验证。
- 净增长用于跨表面共用展示投影、命令快照回放、手机可操作的详情以及避免误跳和吞掉加载错误的导航边界；删除被替代的重复拼接/去 ID 逻辑，仅在旧历史兼容仍需要时保留。
- 本轮仅改本文；已运行 main 源码的设计导航六场景和其他导航十三场景复现，以及现有相关 140 项测试，未运行完整测试套件或浏览器验证，修复尚未实施。

## 实现交接

- 实现人：astra；从最新 main 承接本方案，完成共享展示、轻量侧栏及已确认的导航修复。
- 代码：保持简洁，删除被替代的重复逻辑，优先复用现有模块，不为本功能引入通用框架或不必要的层次。
- 验证：以端到端用户流程为主，少量必要的边界集成测试补充，报告实际浏览器覆盖与未验证项；本设计会话未启动实现。
