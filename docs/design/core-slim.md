# core 精简 — 设计（working doc，定稿后由 build lead 执行）

Baseline: main `4d1513a`, `just size` core 1797 / 1800。

## 目标

**净删除**：整个仓库少代码、少接线。core 的行数只是结果，不是目标。
纯搬家（core 减、别处等量加）不做；搬家的正当性只能是删掉它带来的接线。
凡是"应该放 core 但超了"的，改 ceiling 加一句话，不搬。

评判标准：每一项写出 **repo 净行数** 和 **删掉了什么接线/概念**。

## 做（按顺序，每项一个 commit，各自 green）

### A. 死代码 — repo −5
`Attached.stateSince` + `Router.stateSinceOf()`（`src/core/router.ts`）无调用者，注释里说的 "UI reads it as idle since" 不成立。删。

### B. 三份 code-skipping 扫描器合一 — repo ≈ −23
`reply.ts` 的 `unfenced`+`FENCE`、`cjkFriendly` 的 stash/restore、`inbound-file.ts` 的 `codeRanges`/`replaceOutsideCode`（CommonMark 正确的那份）是同一件事的三份（Budgets 规则 3）。保留 `replaceOutsideCode`，`reply.ts` 两处改用它：`openItemMarkers` 由单次扫描拿到文档序（删 `offset`/`found.sort`），`streamBody` 变一次调用。
附带两处 1:1 重复：`chain.ts` `localDate` = `identity.ts` `day`；`router.ts` `truncate` = `cut(msg, 600)`。
行为变化（都是修正）：inline code span 里的 marker 不再记录/剥离；含 code span 的 `**…**` 不再提标点。`reply.test.ts` 会指出哪些 case 要改。
不动：`stableBlockEnd` 的增量 fence 追踪、`identity.ts` 的 `NOT_PROSE`——不同的活。

### C. IM note 摘要下沉到 channels，顺手合并 slack/lark 的 note 拼装 — repo ≈ −8，删一层接线
`router.ts` 的 `digest`/`NOTE_CHARS`/`NOTE_LINES` 只为 IM 存在（web 走 hub 拿全文）——平台事实，按原则 3 属于 adapter。`Channel.notify` 收全文；`channels/slack-outbound.ts:69` 和 `lark-outbound.ts:110` 现在各自把 note 拼成 `> ` 引用体（复制对），改为共享一个 `noteBody(note)`（放 `channels/lines.ts`，`chunk` 旁边），摘要 + 引用 + 标签一次完成。
删掉的概念：core 不再知道"IM 显示多少"。`Channel.notify` 的 doc comment 加一句："the whole text; the adapter decides how much a chat shows"。`router.test.ts` 的 digest case 迁到 channels。

### D. Open items 归 tasks，删掉 chain ↔ tasks 的回调环 — repo ≈ −25，删 4 个 dep、1 个订阅
现状是环：`MainChain` 通过 `ChainDeps` 的 4 个回调（`ledger`/`sessionOf`/`roleOf`/`designs`）依赖 tasks，`TaskService` 又通过 `TaskChain` 依赖 chain；`main.ts:131-140` 手工接这 4 根线；chain 还为 head 单独 `hub.subscribe` 一次（`watch`/`unwatch`），而 `TaskService` 已经在 `router.onTurnEnd` 上听每个 turn（`tasks/service.ts:104`）。
- `openItems()`/`renderOpenItems`/`record` 及其 SQL、`IN_FLIGHT`、`runText`/`runStatus`/`workersText` → 新文件 `src/tasks/open-items.ts`（新文件的理由：ledger join、按状态计 worker、markers 表都是 task-run 词汇，`TaskService` 已直接持有 `ledger`/`openDesigns`/`store.roleOf`/`getRun`，4 个回调因此消失）。
- marker 记录并入 `TaskService` 已有的 `onTurnEnd` 监听，条件 `continuous.members()[0]?.sessionId === sessionId`；`watch`/`unwatch` 和 chain 构造函数里的订阅整体删除。
- `ChainDeps` 变为：`factory, router, home, status: (now) => { text; sessions }, now?`（`/status` 卡片和 seed 的 "Open" 段都调它）。`chain.ts` 文件头回到一个理由：哪个 session 接用户消息。
- 类型：`OpenItems`/`OpenRun`/`TASK_RUN_STATES`/`TaskRunState`/`NOT_IN_LEDGER`/`ParkedMessage` → `tasks/types.ts`。`LedgerRun`/`LEDGER_WINDOW_MS`/`ChainReason`/`ChainMember`/`CHAT_COMMANDS` 留在 core（seed 仍列 runs，composer 需要命令表）。
- web：`web/server.ts` deps 增加 `openItems: () => OpenItems`（与 `taskSessions`/`leads` 同一回调模式），`GET /api/continuous/open` 走它；`web/ui/drawer.ts` 从 `tasks/types.ts` type-only 导入（已允许）。`docs/architecture.md` 依赖规则加一句允许 `web/server.ts` type-only 导入 `tasks/types.ts`。
- 测试：`chain.test.ts` 的 open-items case → `tasks/open-items.test.ts`；`/status` 卡片和 seed 的字符串必须逐字节相同（现有测试有）。
- 文档：`docs/design/10-continuous-session.md#open-items` 指向新文件。

### E. Console ↔ Pi 配置 seam 出 `core/types.ts`，进 `src/agent/types.ts` — repo ±0，修一个错层
`core/types.ts:468-901`（233 行：`Config*`/`Package*`/`Provider*`/`RegistryModel`…`WebAuth`/`ProviderManager`/`AgentConfigSync`）core 里没有任何文件读；消费者是 `web/`、`agent/`、`websearch/`、根 `tools.ts`/`config-sync.ts`。它们在 core 只因为"web 只能 import core"。这条规则已经造出一个错层的实物：`validateProviderSetup`/`validateEndpoint`（30 行校验逻辑）放在 types 文件里，`web/providers.ts:8` 的注释直说是"since web/ cannot [import agent]"。
- 新文件 `src/agent/types.ts`："the Pi-config seams the Console asks agent/ for, declared by the side that answers them"；无 SDK、无 `node:*`（`web/ui/config.ts`、`model-menu.ts` 要 type-only 打进浏览器包）。
- 规则改一句（AGENTS.md 架构段 + `docs/architecture.md`）："`agent/types.ts` imports no SDK and no `node:*`; any area may import it." 原则 3 的可换性不受影响——换 RPC 换的是 `agent/pi.ts`，不是这份声明。
- `core/types.ts` 文件头随之成真：只剩对话 seam（Channel、AgentSession、事件、chain）。
- agent ceiling 2.5k → 2.8k，句子："the Console's config seams are declared on the side that answers them"。

### F. `REPLY_SURFACE_PROMPT` 出 `reply.ts`，进 `agent/roles.ts` — repo ±0，一文件一理由
`reply.ts` 文件头说它是"presentation, computed once for every surface"；51 行注入给 agent 的 prompt 不是 presentation。`roles.ts` 已是"the role contracts Pier injects from code"（`DISPATCHER`、`LEAD`），surface prompt 是同类。`main.ts:110` 改一个 import；reply.ts 里留一行交叉引用（"the syntax is told in agent/roles.ts"）。计入 E 的 agent ceiling 提升。

### G. Budgets 表
A–F 后 core ≈ 1350 / 1800；core 行描述重写（现在写着 open items 和 Console seam）；agent 行 2.8k 及上面那句。不改 ceiling 数字以外的任何东西。

### H. 删掉队列提升恢复（queue promotion recovery）— repo ≈ −220，删 3 个概念（已批准）
`router.ts:353-493`（118 行）+ `web/ui/composer.ts` 的恢复面板 (~40) + `server.ts` 3 个端点 + `types.ts` `QueueRecovery` + `architecture.md` 一段 + 测试。它维护内存态的失败批次账本、"uncertain" 持有位、ACK 流程，全部不落盘、不 exactly-once。
更简单且满足原则 5 的失败路径：提升失败 → `reportTo` 把**原文**随错误发到会话（hub 不截断；IM 侧 `cut` 600），不再保留账本、不再暂停自动提升、无 ACK。用户看到的是"这几条没送出去 + 原文"，自己重发。
接受的代价：不再区分"确定没发"和"可能已发"，极端情况用户重发一条已到达的消息。
保留：`deliverQueue`（steer/restart/auto 三种模式）与 `recallQueue` 本身、`useQueue` 锁、`promoteQueued`/`resumePromotion` 的自动提升；删的是 `recoveries`/`uncertaintyHeld` 两份账本状态（`promotionRequested` 留，自动提升靠它）、`recoveryOf`/`queueUncertain`/`acknowledgeRecovery`/`recoveryChanged`、`QueueRecovery` 类型与 `queue-recovery` 事件、history snapshot 里的 `queueRecovery`/`queueUncertain` 字段、`POST …/queue/recovery/:batchId/ack`、composer 的恢复面板与暂停提示、`architecture.md` 的 "Queue promotion recovery" 段、`03-web-workbench.md` 的 ack 端点行；`router.test.ts`/`server.test.ts`/`composer.test.ts` 的对应 case 改为断言"失败 → 会话收到含原文的 error"。

## 不做
- 拆任何文件以挪数字（规则 2）。
- `identity.ts` 的列表 helper（web/channels 共用，无处可去）。
- 提 core ceiling（不需要）。

## 执行顺序与验收
A → B → C → D → E → F → G → H，各一 commit，每个 commit 过 `npm run check && npm run lint && npm test`；E 是 seam/规则改动，其 commit 同时改 AGENTS.md 与 `docs/architecture.md`。完成后 `just size` 贴进最后一个 commit。
