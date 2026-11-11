# chain 章程与 system prompt 的分层

状态：已实现（branch `chain-charter`）；不碰 `native/`。
换 head 时沿用上一个 head 的 model/thinking 由 run `fyv4xsjvfnyv82z8` 做，不在本文。

本文两部分：A 是对现有 system prompt 拼装的 review，B 是四项改动——chain 章程、
从通用到具体的顺序、System prompt 视图的标签、去掉 Chain mode 开关。

落地时要更新的 owner 文档：03、06、10、`architecture.md`、`skills/pier-help`、
CHANGELOG、`AGENTS.md` 的预算行。

## A. 现状 review

### 今天怎么拼（Pi 1.5 的段，顺序固定）

| Pi 段 | 内容 | 谁给的 |
| --- | --- | --- |
| `preamble` | Pier baseline（按角色三种）→ 用户的 `SYSTEM.md` | `systemPromptOverride`，`agent/pi.ts` |
| `addendum` | 用户的 `APPEND_SYSTEM.md`（本机没有） | Pi |
| `project_context` | Pi 读到的 `AGENTS.md`（agentDir、祖先目录、cwd）→ `<pier>/AGENTS.md`（chat surface + 实例事实）→ `<pier>/dispatcher.md` \| `lead.md` \| `worker.md` | `agentsFilesOverride` |
| `skills`、`cwd` | Pi 的 | Pi |
| 第一条消息 | head 的 seed：`MEMORY.md`、`chains/<id>/MEMORY.md`、Open、Chains、Runs、notes | `core/chain.ts` |

自定义段只能排在 `cwd` 之后（`buildSystemPromptSections`），所以 `preamble` 与
`project_context` 之间，Pier 能用的位置只有 `preamble` 本身和 `addendum`。

### 实测（chars/4，取自本机 transcript 的 system message）

| 角色 | preamble | project_context | skills | 合计 | 其中 |
| --- | --- | --- | --- | --- | --- |
| head | 973 | 2542 | 916 | ~4.4K | baseline 734、SYSTEM.md 239、surface 647、`DISPATCHER` 1838 |
| lead（本仓库） | 1023 | 4953 | 916 | ~6.9K | 仓库 `AGENTS.md` ~4.0K、surface 647、`lead(design)` 216 / `lead(build)` 521 |
| worker（本仓库，review 同） | 676 | 4741 | 838 | ~6.3K | 仓库 `AGENTS.md` ~4.0K、surface 289、`WORKER` 360 |
| 无角色（IM 线程、cron） | 973 | 685 | 916 | ~2.6K | surface 647 |

head 另有 seed ~5–8K（消息，不在 system prompt）。review 不是角色：它是 worker
会话加消息里的 `reviewPrompt`（~1K/轮，sha 钉死所以只能在消息里）。

### 发现

| # | 现状 | 处理 |
| --- | --- | --- |
| F1 | 角色契约和 chat surface 伪装成项目文件：在「Project-specific instructions」标题下、带假路径 `<pier>/…`，并且排在真正的项目 `AGENTS.md` **之后**——最通用的两段在最具体的一段后面 | B1 |
| F2 | System prompt 视图里 dispatcher 有显示，但标签是 `Role prompt`，「dispatcher」只出现在灰色小字路径里，正文开头是「You are the main session…」。已在线上 head `01a1c85c…` 的 transcript 上核对：`project_context` 含 `<pier>/AGENTS.md`（2588 字符）和 `<pier>/dispatcher.md`（7349 字符），回放的正则两块都切得出。结论：**标签误导，不是漏显示**（数据层核对，未在浏览器里点开） | B3 |
| F3 | 同一视图里 lead 会话的 baseline 认不出：`readSystemPrompt` 只传了 worker 和无角色两种 baseline，lead 的多一段 `# Tool calls`，于是整段显示成 `Preamble`，`SYSTEM.md` 没被分出来 | B3 |
| F4 | head 的 system prompt 没有 chain 这一层：chain 的方向、默认仓库、模型偏好只能写进 `MEMORY.md`（agent 写、4K 截断、压缩后丢） | B2 |
| F5 | 冲突时谁赢没写明，靠「后者胜」的隐含约定（`SYSTEM.md` 在 baseline 后「所以它赢」）。今天角色在项目文件后面；顺序改正后项目与章程在角色后面，需要一句话守住角色里的硬规则 | B1 的一句 |
| F6 | baseline 用 `#`，surface 用 `##`（因为它寄居在项目文件里），同一层的内容两种标题级别 | B1 顺带 |
| F7 | worker 的 surface 自相矛盾：注释说它的回复由 agent 读，正文仍说「Your replies render in a chat UI」并教它群聊里保持沉默，~100 tokens | §瘦身 O1 |
| F8 | 本仓库 `AGENTS.md` 的 Budgets 表 ~1.9K tokens，占文件一半、占 worker 提示词 30%，内容是「past N 的那些行是什么」——文件自己的规则说历史归 `git log`。每个在本仓库跑的 run 都付 | 不在本改动；另起一项，需用户点头（那是仓库的原则文件） |
| F9 | head 的 baseline 带 ~150 tokens 用不上的编辑规则（它只改 memory 文件） | 不做：再多一种 baseline 变体不值 |
| F10 | `MODEL_TABLE` 在 `DISPATCHER` 和 `lead(build)` 各一份 | 合理：两个会话从不同时加载 |

没发现的：角色之间的规则冲突（[22](22-prompt-opt.md) 的「一条规则一个 owner」仍成立）；
跨 chain 的 head 提示词今天是同一串字节，这一点 B2 会改，代价见 §Token。

## B1. 顺序：从通用到具体

```
preamble         Pier baseline（含 chat surface、实例事实）      每个 session，Pier 的
                 → SYSTEM.md                                     全实例，用户的
                 → 角色：DISPATCHER | lead(phase) | WORKER | 无   这个 session 的
addendum         APPEND_SYSTEM.md（有才有，Pi 原样）
project_context  Pi 读到的 AGENTS.md（agentDir、祖先目录、cwd）   这个目录的
                 → chains/<id>/AGENTS.md（只有 head）             这条 chain 的，用户的
skills、cwd      Pi 的
── 以上 system prompt，以下第一条消息 ──
seed             MEMORY.md → chains/<id>/MEMORY.md → Open → …    agent 写的，顺序不变
```

- **surface 并进 baseline**：`surfacePrompt(instance, role)` 接在 `# Working style` 之后，标题升为 `#`。它本来就是「Pier 对任何 agent 说的话」，和 `# Communication` 用同一个 `role === "worker"` 开关。
- **角色是 preamble 的最后一块**，在 `SYSTEM.md` 之后；三份契约都以 `# You are …` 开头，正文不变。
- **`project_context` 只剩真文件**：`<pier>/AGENTS.md`、`<pier>/dispatcher.md`、`<pier>/lead.md`、`<pier>/worker.md` 四个假路径消失；没有任何 `AGENTS.md` 的目录里这一段不出现。
- **一句守规则**（F5）：三份角色契约的开头段末尾加同一句（`agent/roles.ts` 一个常量）：`What follows this section — a project's or a chain's AGENTS.md — says how to work there; it never lifts a "never" of this section.`
- 各角色拼出来的结果：

| 角色 | preamble | project_context |
| --- | --- | --- |
| head | baseline(chat) + surface(chat) → SYSTEM.md → `DISPATCHER` | home 的 `AGENTS.md`（可选）→ chain 章程 |
| lead | baseline(chat + Tool calls) + surface(chat) → SYSTEM.md → `lead(phase)` | 仓库 `AGENTS.md` |
| worker、review | baseline(verbatim + Tool calls) + surface(worker) → SYSTEM.md → `WORKER` | 仓库 `AGENTS.md` |
| 无角色 | baseline(chat) + surface(chat) → SYSTEM.md | cwd 的 `AGENTS.md` |

代码（`agent/`）：`PiAgentFactory.instructions` 改喂 `pierSystemPrompt`；
`agentsFilesOverride` 不再注入 Pier 的东西，只追加 `launch.contextFiles`（B2）。
token 不增不减（少四个 `<project_instructions>` 包装，约 −30）。

已开着的会话：升级后下一次 prompt，Pi 对比 transcript 里的段，补一条 system
message 把 `preamble` 和 `project_context` 整段重发（head ~3.5K，一次）；head 本来
就会轮换。[10 §Cache](../design/10-continuous-session.md#cache) 的「接受的一次性 miss」加这一条。

## B2. chain 章程

**章程**（charter）= `$PIER_HOME/home/chains/<id>/AGENTS.md`：用户写、相对固定——这条
chain 的专注方向与角色、默认仓库、常用 skill、模型偏好。`MEMORY.md` 不变，仍是
agent 写的记忆。两层对称：

| | 全实例 | 这条 chain |
| --- | --- | --- |
| 用户写的章程 | `home/AGENTS.md`（今天就有，Pi 读；没有 UI，用 Files 改） | `home/chains/<id>/AGENTS.md`（新） |
| agent 写的记忆 | `home/MEMORY.md`、`home/memory/` | `home/chains/<id>/MEMORY.md`、`…/memory/` |

- **纯 Markdown，不解析**：没有 front-matter、没有字段。默认仓库、skill、模型都是 head 读到的文字，由 head 执行。编辑框的占位文字给出建议的四行（`Focus:`、`Default repo:`、`Skills:`、`Models:`），不写进文件。
- **进 system prompt，不进 seed**：常驻指令要经得起压缩、要在 System prompt 视图里看得见、要排在角色之后记忆之前。head 的 cwd 仍是 `home`。
- **只给 head**：这条 chain 派出的 lead/worker 不加载它；该传下去的由 head 写进 run 的 prompt。
- **谁改**：用户在 web 的章程对话框里改；或者在对话里让 head 改——head 的 cwd 是 `home`，直接编辑 `chains/<id>/AGENTS.md`，IM 上也走这条路。没有 `/chain` 命令写章程。
- **大小**：web 的保存上限 4000 字符，超了拒绝并说明；head 改的和磁盘上手改的照读，不截断（`DISPATCHER` 要它守住 4K）。读不了的文件：该块正文为 `(could not be read: …)` 并记日志，会话照开。
- **生效**：下一个 head 起（轮换或 `/new`）；web 的保存和 head 的回答都说明这一点。Pier 因重启、`pier reload`、空闲 30 分钟回收而重开当前 head 时会更早生效（Pi 补一条 `project_context` 的更新）。保存不打断、不重开当前 head。
- **`DISPATCHER` 加一节**（~90 tokens，措辞由 build 按 [10 §Prompt vocabulary](../design/10-continuous-session.md#prompt-vocabulary) 定，词表加 `charter`）：

```
## Charter
- A `chains/<id>/AGENTS.md` in the project context is this chain's charter, the user's: its focus, default repo, skills and models.
- It fills what this contract leaves to you: a run with no repo named takes its default as `--cwd`, its models replace §Models' rows, a skill it names is read before the work it covers.
- It is the user's to write: you edit it only when asked, keep it under 4K chars, and say it applies from the next session. What you learn goes to memory, never here.
```

  `MODEL_TABLE` 的末句改为 `A model the user or the charter names wins.`
- **head 自己的模型**不归章程：它沿用上一个 head 的（另一个 run 在做），在这条 chain 里切一次就留住。

seam 改动（`core/types.ts`，是设计决定）：

```ts
interface AgentLaunchOptions {
  /** Instruction files loaded after the cwd's own, absolute paths; a missing one is skipped. */
  contextFiles?: string[];
}
```

- `MainChain.rotate` 建 head 时传 `[<home>/chains/<id>/AGENTS.md]`；`agent/` 不知道 chain，只读路径。
- 重开（`factory.resume`）：工厂的 `roleOf(sessionId)` 扩成返回 `role | phase | contextFiles`，`main.ts` 用 `main_chain` 查出该 session 的 chain（和 `roleOf` 一样晚绑定）。
- 章程的读写在 `MainChain`（它已经拥有 `home` 下的读写）：`charter(chainId)`、`setCharter(chainId, text)`（空文本 = 删文件）。

`/chain` 命令表不变：`/chain new <name>` 只建 chain，没有 `/chain edit`。

### Web

- **章程对话框**（新 `web/ui/charter.ts`，一个理由：编辑一条 chain 的章程）：和 System prompt 同一种模态 `<dialog>`（md 以下全屏、safe-area）。标题 `Charter`、chain 名、一行灰字 `chains/<id>/AGENTS.md · read by this chain's main session from its next session`；一个等宽 textarea、`N / 4000` 计数、Cancel、Save（未改动或超限时禁用）；⌘/Ctrl+↵ 保存；有未保存改动时 Esc/✕ 先 `confirm`；失败在框内红字 `role="alert"`，输入保留。
- 入口三处，同一个对话框：bar 的 `⋯` 菜单 **Charter…**（占 Chain mode 原来的位置，只在对话里出现）；chain 行的 `⋯`：Rename…、**Charter…**、Archive；还没有 head 的 chain 的空面板那行提示后面一个 **Charter…** 按钮——新建后第一条消息之前就是填章程的时机。新建仍是一个名字输入框加 ↵，不加第二步。
- 保存成功：对话框关闭；chain 有 head 时面板追加一行 `charter saved · applies from the next session — /new starts one`。
- 手机：同一个对话框全屏，按钮 44px，textarea 字号 ≥ 16px（iOS 不缩放）。

| Route | 行为 |
| --- | --- |
| `GET /api/chains/:id/charter` | `{text}`，没有文件时 `text: ""`；404 未知 chain |
| `PUT /api/chains/:id/charter` | `{text}` → 写（空 = 删）；400 超过 4000 字符；404 未知 chain；答 `{text, head: boolean}` |

## B3. System prompt 视图

`replaySystemPrompt`（`agent/system-prompt.ts`）按新布局切块，标签直说是什么：

| 块 | 标签 | 怎么认 |
| --- | --- | --- |
| baseline + surface | `Pier baseline` | preamble 开头到 surface 的固定末句（`roles.ts` 导出的常量） |
| 用户的 | `SYSTEM.md` | 两者之间 |
| 角色 | `Role · dispatcher` \| `Role · lead · design` \| `Role · lead · build` \| `Role · worker` | preamble 里最后一个行首 `# You are ` 到段尾，且它是三份契约的 H1 之一或其后带守规则那一句（`SYSTEM.md` 自己的 `# You are …` 标题仍归 `SYSTEM.md`）；名字按三份契约的 H1 对，认不出就 `Role` |
| 项目文件 | 文件名 + 路径（不变） | `<project_instructions path>` |
| 章程 | `Chain charter` + 路径 | 路径是 `…/chains/<id>/AGENTS.md`，且不在会话 cwd 或其上级目录（那是项目自己的文件）（标签在 `web/ui/system-prompt.ts` 换，`agent/` 不知道 chain） |
| 其余 | `APPEND_SYSTEM.md`、`Skills`、`Working directory`（不变） | |

- 不再传 `baselines`：按结构切，不按当前代码渲染出来的字节比，F3 随之消失。
- 旧 transcript（没再开过的会话）：`<pier>/dispatcher.md` → `Role · dispatcher`，`<pier>/lead.md` → `Role · lead`，`<pier>/worker.md` → `Role · worker`，`<pier>/AGENTS.md` → `Pier surface`；preamble 认不出末句的整段标 `Preamble`。
- 对话框头部加一行目录：每块 `标签 ~tokens`，点一下滚到那块——八块长文本里不用靠滚动找角色。手机上这一行横向滚动。
- `SystemPromptBlock` 的形状不变，只是 `label` 的取值变了（`core/types.ts` 的注释跟着改）。

## B4. 去掉 Chain mode 开关

chain 常开：列表、`/chain`、侧栏永远在；一条 chain 的实例就是列表里只有一行。

### 删掉的

| 层 | 删什么 |
| --- | --- |
| root | `Settings.chainMode`、`setChainMode`、`#flag`（只有它用）；`main.ts` 的 `mode` 依赖；一条迁移删 `settings` 表的 `chainMode` 行 |
| `core/chain.ts` | `deps.mode`；`/chain new` 里「先开开关、名字被拒再关回去」那段；`chainLines` 的开关判断改为「活跃 chain ≥ 2 才有 `## Chains`」 |
| `web/server.ts` | `PUT /api/chains/mode` 整条路由、`chainModeOn` 及三处调用、`ChainList.mode`、`ChainOpen` 类型 |
| `web/ui` | `⋯` 的 Chain mode 项、`setChainMode`（含归档确认框）、`deps.chainMode`、`mode === "chain"` 的判断（`chains.ts` 的 rail、⌘B、⌘⇧[ ] 三处，`main.ts` 的 `chain()` 与 `chainMode()`）、Sidebar 项的 `disabled` 与 `in chain mode` 提示 |
| 文档 | 03 里提到开关的各处（路由三行、bar、`⋯` 菜单、侧栏）、06 里三处 `in chain mode`、10 §Chains 的 Session mode 一条和 `/chain new` 行、`skills/pier-help` 两行、[30](30-multi-chain.md) 顶部加一行「开关已由 36 去掉」 |

估计：非测试代码净 −90 行左右（web −70、core −12、root −8），测试 −150 行左右。

### 留下的（不是单 chain 路径）

- `Chains.first()`、`MainChain.firstHead()`：无主的回调、外部建的定时任务、旧客户端不带 `chain` 参数时的落点。
- `#/conversation` 与 `landing()`：裸地址落到上次看的 chain。
- 「最后一条活跃 chain 不能归档」。

### 可以同批删的 pre-chain 兼容（与开关无关，建议删第一个）

- `GET /api/continuous/items/:problem/turns` 旧形状：UI 已只用 `:chain/:problem`，没有调用者。
- `#/conversation/item/<problem>` 旧书签与 `chainHolding()`：建议再留一版。

### 迁移影响

- **数据不动**：不归档、不恢复任何 chain。以前关开关时被归档的 chain 仍在 `Archived · N` 下，要用就恢复。
- **一直没开过开关的实例**（默认值）：升级后标题从 `Pier` 变成 chain 名（迁移建的那条叫 `Main`），≥ 64rem 出现侧栏（Chains + Items），⌘B 收起并记住。Session info 仍在 `⋯` 里。这是唯一看得见的变化，写进 CHANGELOG。
- 标题在列表读到之前仍显示 `Pier`。
- **缓存里的旧 web UI**：Chain mode 项会打到已删的路由，报一行错；刷新后是新 UI。
- **降级**：旧代码读不到 `chainMode` 当作关，多条活跃 chain 时列表不显示，把开关打开即恢复；写进 CHANGELOG 的升级说明，不做降级迁移。
- `native/`：不调用这些路由，不受影响。

## Token 成本

| 项 | 变化 |
| --- | --- |
| 各角色 system prompt | 顺序调整本身 ±0；角色里的一句守规则 +~25 |
| head | `## Charter` +~90；章程 ≤ 1K（写了才有） |
| 跨 chain 的前缀缓存 | 今天所有 chain 的 head 提示词同一串字节；以后从章程起分叉，分叉之后只有 `skills` + `cwd` ~0.9K 不再共享。有章程的 chain 每个 TTL 多付这 ~0.9K 的一次写缓存 |
| 升级那一次 | 每个开着的会话重发 `preamble` + `project_context` 一次 |
| seed | 只有一条活跃 chain 时不列 `## Chains`；其余不变 |

## 瘦身（用户已定：做，但不进本 build）

定稿后由主会话单独开一个 run（模型 fable）直接做，和 build 分开：

- **O1** worker 的 surface 只留语言行和实例事实，去掉「chat UI」「Staying silent」两段（F7，−~100 tokens/worker）。动之前要确认 worker 的 `<silent>` 没有代码路径依赖。它和 B1 都改 `agent/roles.ts` 的 surface，后落地的一方 rebase。
- **O2** 本仓库 `AGENTS.md` 的 Budgets 表瘦身（F8，−~1.5K tokens/run）。

## 不做

- 章程的结构化字段、按章程强制 cwd/skill/模型；章程给 lead/worker；全局章程的 UI。
- 写章程的 `/chain` 命令（`/chain new` 带正文、`/chain edit`）：web 能改、head 能改，够了。
- 保存后立刻让当前 head 重开；章程的版本历史、并发编辑冲突检测（后写的赢）。
- head 的 baseline 第四种变体（F9）；单独的 review 角色。
- 向 Pi 要「可排序的自定义段」。
- `native/` 的任何改动。

## 已决的取舍

| 问题 | 决定 | 为什么 |
| --- | --- | --- |
| 角色放 Pi 的哪个位置 | `preamble` 末尾 | 另一个位置是 `addendum`：Pi 会包一层 `<addendum>`，把最重要的契约标成「附录」，还要和用户的 `APPEND_SYSTEM.md` 共用一段。视图里角色仍是独立的一块 |
| surface 放哪 | 并进 baseline | 它和 `# Communication` 是同一层、同一个角色开关；独立成块只因为以前寄居在项目文件里 |
| 章程进 system prompt 还是 seed | system prompt | 常驻指令：压缩不丢、视图可见、权重高于一条消息。代价是跨 chain 少共享 ~0.9K 缓存 |
| 章程怎么到 `agent/` | `AgentLaunchOptions.contextFiles` | 把 head 的 cwd 改成 `chains/<id>/` 能让 Pi 原生加载，但要动「cwd 是 home」的全部判断和 memory 的相对路径 |
| 生效时机 | 下一个 head（用户定） | 不打断当前回合、不为一次保存付整段重发；用户要立刻生效就 `/new` |
| 章程给不给派出的 lead/worker | 不给（用户定） | 该传下去的由 head 写进 run 的 prompt |
| IM 上怎么改章程 | 让 head 改（用户定） | 不加命令；head 本来就能编辑 `home` 下的文件 |
| 单 chain 时的 `## Chains` | 不列 | 只有一行「(this one)」，seed 不说废话 |
| 视图怎么认块 | 按结构（末句、`# You are`） | 按字节比 baseline 要枚举每种角色，换版本、换实例地址都会认不出 |

## 开放问题

无。定稿后 build lead 遇到的新选择记回本文档。

## 验收

- `GET /api/sessions/:id/system-prompt`：head 的块依次是 `Pier baseline`、`SYSTEM.md`、`Role · dispatcher`、（home `AGENTS.md`）、`Chain charter`、`Skills`、`Working directory`；lead 的是 `Role · lead · design|build`，worker 的是 `Role · worker`；没有任何 `<pier>/` 路径。
- 两条 chain 各写章程，各发一条消息：各自 head 的提示词只含自己的章程；没写章程的 chain 与今天只差顺序。
- 章程里写 `Default repo: <path>` 和一条模型偏好：说「修一下 X」不点名仓库，head 派的 run 是 `--cwd <path>`、模型按章程。
- 仓库 `AGENTS.md` 写着「绿了就 merge」的仓库里跑一个 worker：它不 merge（守规则那一句）。
- 新建一条 chain，在空面板点 **Charter…** 写好再发第一条消息：head 带章程。在 home DM 里说「把章程改成…」：head 改了文件，并说下一个 session 生效。
- 章程对话框：桌面与手机各一遍（真机 iOS Safari 一遍）——未保存时 Esc 有确认、超限禁用 Save、失败不丢输入。
- 升级一个 `chainMode` 关着的实例：数据不变，标题是 `Main`，侧栏可用 ⌘B 收起；`⋯` 里没有 Chain mode。
- 升级前开着的 head 收到下一条消息：transcript 多一条 system message，之后视图按新布局显示。

## 测试（纲要）

- `agent/pi.test.ts`：四种角色的 preamble 顺序（baseline → SYSTEM.md → 角色）；`project_context` 只有真文件；`contextFiles` 追加在 cwd 的之后、缺失跳过、读不了的有标记；`resume` 带回 `contextFiles`。
- `agent/system-prompt.test.ts`：新布局的切块与标签（四种角色、有无 `SYSTEM.md`）；旧 `<pier>/` transcript 的标签；认不出的落 `Preamble` / `Role`。
- `agent/roles.test.ts`：三份契约都以 `# You are ` 开头并带守规则那一句；`DISPATCHER` 有 `## Charter`。
- `core/chain.test.ts`：`rotate` 传章程路径；`charter`/`setCharter`（空 = 删、读不了的说明）；`## Chains` 只在 ≥ 2 条活跃时出现；没有 `mode`。
- `web/server.test.ts`：章程两条路由（空 = 删、400、404）；`/api/chains` 没有 `mode`；`PUT /api/chains/mode` 不存在。
- `web/ui/*.test.ts`：章程对话框（禁用态、确认、失败保留输入）、三个入口；System prompt 的目录行与 `Chain charter` 标签；菜单没有 Chain mode、Sidebar 恒可用。
- `settings.test.ts`：没有 `chainMode`；迁移删掉那一行。

## 预算

- `agent/`（2962 / 3.2k）：约 +25——`contextFiles`、preamble 的拼装；回放改按结构切，行数持平。
- `core/`（2317 / 2.35k）：章程读写与 `rotate` 传路径约 +15，开关 −12；不越线。
- `web/`（13895 / 13.9k）：章程对话框与两条路由约 +110、目录行 +15，开关 −70；会越线，抬 ceiling，理由：「章程对话框及其三个入口、两条路由；System prompt 的目录行」。
- root（3604 / 3.8k）：约 −5。
