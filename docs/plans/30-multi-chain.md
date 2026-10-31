# 多 chain：手动隔离的多条连续对话

状态：用户已定稿（lead branch `design-multi-chain`）；开放问题按 lead 的建议决定（§已决的取舍）。只出设计，不写实现；不碰 `native/`。

来源：今天一个实例只有一条连续对话（[10](../design/10-continuous-session.md)），
所有话题共用一个 head、一份 memory、一张 open items 表；[15](../design/15-item-view.md)
用 item view 在**同一条链内**按事项过滤，并把「第二个 head、按话题分链、按事项分
memory」列为不做、仅当回复混淆事项时重议。本轮是那次重议，动机不是混淆，而是用户要
**手动**把不相关的话题隔开：每条 chain 有名字、自己的 head 轮换、自己的 memory 和
items；一个开关决定是单链（今天的 Session 模式）还是多链；memory 分 global 与 chain
两层，chain 层默认隔离、可互相搜索。

落地时要更新的 owner 文档：03、04、06、08、10、11、15、`architecture.md`、
`skills/pier-help`、`skills/pier-search`、`skills/pier-tasks`、CHANGELOG。

## 已核对的事实

| 来源 | 契约与对本设计的影响 |
| --- | --- |
| `core/chain.ts` `MainChain` | 一个实例一条 `main_chain`；`members()[0]` 是 head；`send` 串行、惰性轮换（idle 1h / 60K / `/new` / lost）；seed = `MEMORY.md` 4K + `## Open` + ledger 4K + `memory/*.md` 尾 2K；`<note>` 写当天 daily note。全部按 chain 复制一份即可，规则不变 |
| `db.ts` 迁移 28、31 | `main_chain(session_id PK, started_at, reason)`；`open_items(problem PK, stage, run_ids, updated_at, closed_at, aliases, sessions)`。两张表都要加 `chain_id` |
| `tasks/service.ts` `head()` / `headOf(id)`、`tasks/callbacks.ts:181` | `callback.type === "conversation"` 解析为**唯一的** head；`chainOf(session)` 决定 launcher 集合与回调目标。多链后必须按发起 session 所在 chain 解析 |
| `tasks/service.ts:198` `onTurnEnd` | 只有 `members()[0]` 的 turn 写 open items。多链后是「任一 chain 的 head」，写入该 chain |
| `channels/runtime.ts:175`、`main.ts:230` | home DM 的消息全部进 `MainChain.send`；状态消息按 head 是否答在 DM 刷新。DM 需要一个当前 chain 指针 |
| `core/search.ts` `searchMessages(factory, chain)` | `--in pier` = 全部 `main_chain` 成员，place 为 `Pier`。多链后 place 是 chain 名，`--in chain:<name>` 限定一条 |
| `agent/roles.ts` `DISPATCHER` 53–56 | memory 规则只认一份 `MEMORY.md` 与 `memory/`。需要补两层的归属规则 |
| `web/ui/views.ts:144–149` | hash 路由 `#/conversation`、`#/conversation/item/<problem>`、`#/session/<id>` |
| `docs/design/03 §Bar and status panel` | 单列一条 bar；标题 `Pier` 打开 Session info；状态面板是全实例一张平列表，≥ 640px 是 lead 下的 32rem popover、以下是底部 sheet（`menu.ts` 原语）；没有停靠的侧栏 |
| 旧 sessions rail（`5152165^`） | 左栏列表 + ⌘⇧[ ] 切换、⌘⇧O 新建；用户说的「把之前的多 Session 拿过来」指这个交互 |

## 词汇

扩展 [10 §Prompt vocabulary](../design/10-continuous-session.md#prompt-vocabulary)；
提示词、文档和 UI 都用这几个词。

| 词 | 指 | 不是 |
| --- | --- | --- |
| chain | 一条连续对话：自己的 head 链、memory、items；有名字 | session、topic、channel |
| conversation | 原义不变，但现在指「当前 chain 的连续对话」；提示词里「main session」仍是当前 chain 的 head | 全实例 |
| global memory | `home/MEMORY.md` 与 `home/memory/`，每条 chain 都加载 | 共享 index |
| chain memory | `home/chains/<id>/MEMORY.md` 与 `…/memory/`，只有这条 chain 加载，别的 chain 可搜 | 私有、隔离（它不是硬隔离） |
| Session 模式 | 开关关：恰好一条活跃 chain，UI 不显示列表；行为与今天完全一致 | 旧版、兼容模式 |
| chain 模式 | 开关开：列表可见，可新建、切换 | — |
| 当前 chain | 某个 surface 正看着的那条：web 是 hash，home DM 是它的指针；每个 surface 各自一个 | 实例级「活动 chain」 |
| 首条 chain | 活跃 chain 里 `created_at` 最早的那条；无法归属的东西落这里 | default、主链（不设标志位） |

UI 文案：英文界面用 **Chain**；中文 tooltip 用「链」（`切换链`、`新建链`）。

## 目标与范围

- 用户能手动把不相关的话题隔到不同 chain：每条有名字，列表切换，`/chain` 命令在 web 和 IM 都能切。
- 一个 item（`<open>`/`<topic>`）属于且只属于一条 chain；它的 run、callback、item view 都跟着这条 chain。
- memory 分两层：global 每条都加载；chain 层只有自己加载、别的能搜（`rg` 和 `pier search`）。
- Session 模式就是「只有一条活跃 chain」：同一套实现、同一套表，开关只决定列表和切换是否出现。
- 不改 head 的轮换规则、seed 的各部分预算算法、open items 的状态判定、派发流程；不做自动归类（哪条 chain 由用户决定）。

## 产品行为

### 开关

- `⋯` 菜单一项 **Chain mode** 开关（web）；IM 没有开关（手机上开了也看不到列表，`/chain` 命令两种模式都认，见 §IM）。
- 存 `settings.json` `chainMode: boolean`，默认 `false`。
- 不变量：**Session 模式 ⇔ 恰好一条活跃（未归档）chain**。
  - 关 → 开：列表出现，里面是现有那条（迁移时名为 `Main`，可改名）。什么都不动。
  - 开 → 关：当前 chain 留下，其余活跃 chain 归档（§归档）。多于一条时先确认：对话框列出将归档的 chain 和各自 open 数（`Design · 2 open · 1 waiting on you`），确认才写；取消不动。
  - Session 模式下 `/chain new`、恢复归档、面板上「到它的 chain」都会把开关打开——先满足不变量再做动作，不弹第二个确认。

### chain 的生命周期

| 动作 | 入口 | 规则 |
| --- | --- | --- |
| 新建 | 列表底部 **New chain…**（行内输入名字，↵ 建并切过去，Esc 取消）；`/chain new <name>`；⌘⇧O | 建一行 `chains`，没有 head；第一条消息才建 head（reason `first`，seed 只有 global memory + 空 chain memory + `## Chains`）。名字 1–40 字符，去首尾空白，活跃 chain 内不区分大小写唯一；重名拒绝一行 `chain: "<name>" exists` |
| 改名 | 行的 `⋯` → Rename（行内编辑）；`/chain rename <name>`（改当前） | 只改 `chains.name`；memory 目录按 id 不动；活跃项内唯一同上 |
| 切换 | 列表点行；`/chain <name>`（唯一前缀匹配，规则同 `/skill` 前缀：`/chain des` → `Design`；多于一个匹配答 `/chain des matches Design, Desktop — say more`）；⌘⇧[ / ⌘⇧] | web 改 hash `#/chain/<id>`，面板关闭；DM 改指针并答一条 `↔ chain · <name>` 注记。**不触发轮换**：切过去先看到它的 head 原样，下一条消息才按它自己的 idle/full 规则轮换 |
| 归档 | 行的 `⋯` → Archive；`/chain archive`（当前）；关开关时批量 | 写 `archived_at`。有 open items 时先确认（列出 open 数）；IM 上不确认、直接拒绝一行 `chain: <name> has N open — /status first`。归档的 chain 从列表主体消失，收进底部 **Archived · N**（折叠） |
| 恢复 | Archived 组里点行 → Unarchive；状态面板上归档 chain 的 item 行的次操作「Open in its chain」 | 清 `archived_at`；Session 模式下同时打开开关 |
| 删除 | 不做 | memory 是用户的文件；归档即可 |

**归档的 chain 是只读的，不是死的**：

- head 不能收用户消息（web 面板只读，`/chain <name>` 切到它答 `chain: <name> is archived — unarchive first`，列表里它不是可切目标）。
- 已在飞的 run 照跑，callback 照常落到它的 head（`headOf` 不看归档），head 的回合照常发生、照常写 items 和 notes。它的 item 在状态面板和 `/status` 里仍然出现，带 chain 名和 `archived` 标记——**原则 5：发生了的事不能像没发生**。等用户的 item 行是「Needs you in chain <name> (archived)」，次操作就是恢复。
- 它的 memory 文件留在原处，别的 chain 照样搜得到。

### 轮换与 head

每条 chain 一份 [10 §Head lifecycle](../design/10-continuous-session.md#head-lifecycle)，规则逐字不变：idle 1h 按**这条 chain**最后一条用户消息算；60K 满；`/new` 轮当前 chain；gone 补当前 chain。`MainChain.send` 的串行队列按 chain 一把锁，chain 之间互不阻塞。

seed 的差异只有两处：

- 开头一行多出 chain 名：`[Pier: a new session of chain "<name>" — <why>. …]`，以及 chain 的 memory 路径：`your chain's memory: chains/<id>/MEMORY.md, notes chains/<id>/memory/`。
- 新增 `## Chains` 段：每条**活跃** chain 一行 `<name> · <N> open · <M> waiting on you`，当前的标 `(this one)`；归档的不列。≤ 10 行量级，让 head 知道别的话题在哪、能用 `pier search --in chain:<name>`。

model 与 reasoning：每条 chain 的新 head 都从 Settings 默认读，与今天一致；chain 级别的 pin 不做（§已决的取舍）。

## 数据模型

一次迁移，`db.ts`：

```sql
CREATE TABLE chains (
  id          TEXT PRIMARY KEY,      -- 'main' 为迁移建的首条；其余随机短 id
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER                -- NULL = 活跃
);
INSERT INTO chains VALUES ('main', 'Main', <now>, NULL);

ALTER TABLE main_chain ADD COLUMN chain_id TEXT NOT NULL DEFAULT 'main' REFERENCES chains(id);
-- open_items 的键变成 (chain_id, problem)：建新表、拷贝、换名
CREATE TABLE open_items_v2 (
  chain_id TEXT NOT NULL REFERENCES chains(id),
  problem  TEXT NOT NULL,
  stage, run_ids, updated_at, closed_at, aliases, sessions  -- 同今天
  PRIMARY KEY (chain_id, problem)
);

CREATE TABLE home_chain (            -- home DM 的当前 chain 指针，最多一行（11：一个实例一个 home）
  chain_id TEXT NOT NULL REFERENCES chains(id)
);
```

- `chains.id` 不是名字：改名不动 memory 目录、hash、DM 指针。
- head = `main_chain WHERE chain_id = ? ORDER BY started_at DESC LIMIT 1`。`chainOf(sessionId)` 返回 `{chainId, members}`（newest first），不是成员就是 undefined——签名变了，`TaskChain` 跟着变。
- `open_items` 的 `problem` 键在 chain 内唯一，跨 chain 允许同名：head 只看自己 chain 的 items，`<done>` 的 `namesKey` 匹配也只在本 chain 内。所有读 items 的地方（`TaskStore.openItems`、seed、`/status`、`GET /api/continuous/open`、`items(q)`、`itemHistory`）都带 `chain_id`，面板那种跨 chain 的读返回每行的 `chain`。
- memory 目录：

```
$PIER_HOME/home/
  MEMORY.md            global index（今天的文件，不动）
  memory/YYYY-MM-DD.md global 日记（今天的文件，不动）
  AGENTS.md            可选，Pi 读（不动）
  chains/<id>/MEMORY.md
  chains/<id>/memory/YYYY-MM-DD.md
```

head 的 cwd 仍是 `home`（所有 chain 同一个）：`dispatcher.md` 注入规则不变，系统提示词在所有 chain 间是同一串字节（§Token）。chain 路径由 seed 告诉它。

## 归属：item、topic、run、callback

- **item 属于写它的 head 所在的 chain**。`onTurnEnd` 里「是 `members()[0]`」改为「是某条 chain 的 head」（`chainOf(sessionId)?.members[0] === sessionId`），`recordOpenItems` 带 `chainId`。`<topic>`、`[item: <problem>]` 同理，都在该 head 的 chain 里解析。
- **run 属于发起它的 session 所在的 chain**：launcher 集合 = 该 chain 的成员（`operations.ts:211` 的 `chain.chainOf(caller)` 改读 `.members`）。chain A 的 head 不拥有 chain B 发起的 run（`pier task cancel/message` 拒绝 `session does not own this run`，和今天跨 session 的规则一样）。`pier task runs` 列调用者 chain 的。
- **callback**：`callback.type === "conversation"` 解析为 `headOf(run.invokedBySessionId)`；定时任务（`TaskDefinition`）用 `createdBySessionId` 所在 chain；两者都解析不到（旧数据、CLI 从外部建的任务）落**首条 chain**。`TaskService.head()`（无参）只剩这一种用途，改名 `firstHead()` 以免再有人当「唯一 head」用。
- `owesNotice`、`abnormalEnd`、`designFinal`、`milestone`：全部已经按 `headOf(session)` 走，只要 `headOf` 按 chain 解析就对；`unasked`（`service.ts:497`）里「by 的 head ≠ 这个 run 的 head」改为比 chain。
- design lead 的 `Design final:` 回调给发起它的 chain 的 head；它在 home DM 的子线程（11 §Child threads）不变——线程绑的是 session，不是 chain。
- item 不能跨 chain 移动（§已决的取舍）。用户在 A 里问 B 的事：head 从 `## Chains` 知道 B 在，答一行「这事在 chain B 里，`/chain B`」，不替 B 答、不替 B 开 item（`DISPATCHER` 一句）。

## memory 分层

### 写

| 写什么 | 去哪 | 怎么写 |
| --- | --- | --- |
| 这条 chain 的决定及理由、它的 backlog、它正在用的外部事实 | chain index `chains/<id>/MEMORY.md`；日常用 chain 日记 | head 直接编辑；`<note>line</note>` 追加到 `chains/<id>/memory/<今天>.md` |
| 用户偏好、跨话题都成立的事实、工作方式、对 Pier 自己的要求 | global index `home/MEMORY.md`；日常用 global 日记 | head 直接编辑；`<note global>line</note>` 追加到 `home/memory/<今天>.md` |

- `<note>` 的默认落在 chain——隔离是默认，共享要说出来。`<note global>` 是同一个标记加一个属性，`openItemMarkers` 多认一个 flag，剥离规则一样（fence 内不读）。
- 写失败按今天的规则报到该 head 的对话里，带丢失的行。
- `DISPATCHER` 的 memory 段改成两层的归属表（上表的前两列，一行一句）；global 的 4K 预算不变；chain index 另有 4K。「哪些算 global」的判断交给 head，判错的代价是一次搜索（§读），不是丢失。

### 读（seed）

| seed 段 | 预算 | 来源 |
| --- | --- | --- |
| `## MEMORY.md` | 4K chars（不变） | `home/MEMORY.md` |
| `## chains/<id>/MEMORY.md` | 4K chars | chain index |
| `## Open` | 自身规则（不变） | **本 chain** 的 items |
| `## Chains` | ≤ 10 行量级 | 活跃 chain 一行一条 |
| `## Runs …` | 4K（不变） | 本 chain 成员发起的 run |
| `## memory/<date>.md …` | **1K** | global 日记尾，规则同今天的 `tail` |
| `## chains/<id>/memory/<date>.md …` | 2K（今天的数） | chain 日记尾 |
| `## Previous session` | 不变 | `full` 轮换才有 |

只在轮换时读；每条 chain 轮换各读各的。`## Open` 只有本 chain 的，所以忙的用户每条 chain 的 seed 比今天的单链 seed 还小。

### 跨 chain 搜索

两条既有路径，不加新机制：

- `rg`：head 在 `home` 下 `rg <q> memory chains/*/memory`（`DISPATCHER` 的 recall 一句改成这个 glob）；别的 chain 的 index 是 `chains/*/MEMORY.md`。文件就在那里，没有权限层。
- `pier search`：`--in pier` 仍是「全部 chain 的全部成员」；新增 `--in chain:<name>`（名字唯一前缀匹配，host 解析，歧义一行 `search:` 拒绝）；不带 `--in` 时顺序改为**调用者所在 chain 的命中在前**，然后其他 chain，然后非 chain 的 session（`callerSessionId` socket 已经有）。hit 的 `place` 由 `Pier` 改为 chain 名；`--json` 多 `chain: {id, name}`。
- `skills/pier-search` 补一行：别的 chain 的事先 `--in chain:<name>`。

## Web UI

### 列表

- bar 的标题从 `Pier` 变成**当前 chain 的名字 ▾**，点开是 **chain 列表**——`menu.ts` 的同一个原语：≥ 640px 是标题下的 popover，< 640px 是底部 sheet（和状态面板一样）。Session 模式下标题仍是 `Pier`、仍打开 Session info，列表不存在。
- ≥ 80rem 列表**同时停靠为左栏**，15rem，内容高度、无底板（06 的材质，不做玻璃板）；popover 和侧栏渲染同一组行（同一个模块，像 `drawer.ts` 对面板那样）。这是「把旧 rail 拿回来」的那部分，收窄时回到标题菜单，手机上就是 sheet。
- 行：topic dot（沿用面板的状态色：sky = head 在流、amber = 有 waiting on you 或 head 未读、无 = 静）、名字（两行截断）、右侧灰字 `N waiting`（0 不显示）；当前行点亮；顺序按**最近一次用户消息**倒序（创建或说话会提到顶，后台活动不动顺序——旧 rail 的规则）。
- 行的 `⋯`（hover 或 coarse pointer 常显，44px）：Rename、Archive。底部：**New chain…**、**Archived · N**（折叠，展开后每行一个 Unarchive）。
- 键盘：↑↓ 走行、↵ 切、Esc 关；⌘⇧[ / ⌘⇧] 上一条/下一条（环绕；模态下退让）；⌘⇧O 新建。⌘⇧P 仍是状态面板。
- 新建的行内输入：行变成一个 input，占位 `Name`；↵ `POST /api/chains` 成功后切过去，失败把错误写在行内（重名）；Esc 还原。乐观渲染：行先出现再和 `chains-changed` 对账。

### 对话面板

- hash `#/chain/<id>`；item view `#/chain/<id>/item/<problem>`；`#/session/<id>` 不变。
- `#/conversation` 与裸 hash：落到**上次看的 chain**（localStorage，没有或已归档则首条）；`#/conversation/item/<problem>`：按 problem 在活跃 chain 里找，唯一就开它的 view，否则首条 chain 的（旧书签兼容，不新造）。
- 面板的内容就是该 chain head 的 transcript，divider、seed 卡、composer 全部不变；seed 卡的第一行多 chain 名。composer 发 `POST /api/continuous/messages` 带 `chain`。
- 切换 chain 是一次导航：面板按 `#/chain/<id>` 重取 `GET /api/continuous?chain=` 与 `/history`；流订阅换到新 head。⌂（`回到主会话`）回到**当前 chain**，不是首条。
- `‹`（子 session 返回）回到发起它的 run 所在的 chain（`chainOf(invokedBy)`）；不知道就回当前。
- context chip、`/new`、`/stop`、Session info 都是当前 chain head 的。

### 状态面板

- 仍是全实例一张平列表（03 的规则）：行多一个 chain 名 tag（位置同 lead 的 `phase` tag），**当前 chain 的行不带 tag**；归档 chain 的 tag 后加 ` · archived`。
- 顺序：waiting on you 跨 chain 在前（bar 的 lead 也从这里取，所以别的 chain 等你一样上 bar），然后当前 chain 的其余行，然后其他 chain 的，各自保持 `/status` 的顺序。
- 点别的 chain 的 item：导航到 `#/chain/<id>`（再按 15 的 `openItemDestination` 落 item），面板关闭。归档 chain 的 item 行次操作是 **Open in its chain**（恢复并切过去，Session 模式下开开关）。
- 搜索框：跨 chain，结果行带 tag。
- 徽标与未读：app icon 的计数 = 各 chain head 的未读回复之和 + 对话外的未读（规则不变，只是 head 变多条）；Web Push 已经按 session 发、`tag` 按 session，无需改。

### 菜单与 Settings

- `⋯`：Session info、System prompt、Browse files、Model & reasoning…、**Chain mode**（开关，右侧当前状态）、Settings。
- Settings 不加页；`chainMode` 走 `GET/PUT /api/config/defaults` 同类的一个小路由（`PUT /api/chains/mode`，见下）。

### 路由

| Route | 行为 |
| --- | --- |
| `GET /api/chains` | `{mode: "session"\|"chain", chains: [{id, name, createdAt, archivedAt?, lastUserAt?, head?: {sessionId, state}, unread, waiting}]}`，活跃在前按 `lastUserAt` 倒序，归档在后 |
| `POST /api/chains` | `{name}` → 建；201 行；400 名字不合法；409 重名；Session 模式下同时置 `chainMode=true` |
| `PATCH /api/chains/:id` | `{name?}` 改名；`{archived: true\|false}` 归档/恢复（恢复在 Session 模式下置开关）；409 重名或 `has N open`（body 带 `open`，前端据此弹确认后带 `force: true` 再发） |
| `PUT /api/chains/mode` | `{chain: boolean}`；关时 body 可带 `keep: <id>`（默认请求头里的当前 chain）和 `force: true`；没 `force` 且有将被归档的 chain → 409 带清单；成功答 `GET` 的形状 |
| `GET /api/continuous?chain=<id>` | 该 chain 的 `{chain: [...members], rotateAt}`；缺参 = 首条（旧客户端） |
| `GET /api/continuous/open` | 每行多 `chain: {id, name, archived}`；面板一次读全部 |
| `GET /api/continuous/items?q=&chain=` | `chain` 可省 = 全部；行带 `chain` |
| `GET /api/continuous/items/:chain/:problem/turns` | 15 的路由多一段 chain；旧形状 `/items/:problem/turns` 保留一版，按唯一性解析 |
| `POST /api/continuous/messages` | body 多 `chain`（缺 = 首条）；归档的 409 `chain is archived` |
| SSE `chains-changed` | 建、改名、归档、恢复、开关、head 轮换（`sessions-changed` 照发） |

## IM（home DM）

一个 DM，一条**指针**，不开线程、不开第二个 DM：

- `home_chain` 一行是 DM 的当前 chain，初始首条；home 更换时重置为首条（和 `forgetChat` 一起）。
- DM 的每条消息进 `MainChain.send(msg, homeChain, key)`。`[place]` 头不变。
- `/chain` 命令表（两种模式都认；`/`、`%` 同今天）：

| 命令 | head（home DM、web） | 别的 chat 的线程 |
| --- | --- | --- |
| `/chain` | 列表：每行 `<name> · N open · M waiting`，当前行前 `✓`，归档的在末尾带 `(archived)` | prose |
| `/chain <name>` | 切换：唯一前缀；答 `↔ chain · <name>` 注记（`chat-command`，不进模型上下文）；web 端是 hash 导航，不发命令 | prose |
| `/chain new <name>` | 建并切；Session 模式下开开关 | prose |
| `/chain rename <name>` | 改当前的名 | prose |
| `/chain archive` | 归档当前，有 open 直接拒绝一行；切到首条 | prose |

  `CHAT_COMMANDS` 多一个 `chain`，带参；`chatCommand` 要认 `chain` 后面的参数（今天的命令都无参，这是 `core/types.ts` 的一处小扩展）。`skills/pier-help` 补这五行。
- 状态消息（`▤ open items`）：当前 chain 的三组，同今天；然后一段 `Other chains`：每条其他活跃 chain 一行 `<name> · N waiting · M in progress`（都是 0 的不列，一条都没有就没这段）；归档 chain 有 waiting 的也列，带 `archived`。
- **别的 chain 的 head 在 DM 里说话**（它上次的用户消息来自 DM，后来 DM 切走了，它收到 callback 作答）：照常发在主流，但每条前面一行灰字 `chain · <name>`（Slack `context` block、Lark 灰 markdown 行）——看得见、分得清、不静默。消息上的按钮点击**路由到发它的那条 chain**，不是 DM 当前 chain（Lark button value 多 `chain: <id>`；Slack 按消息 → session 回查）。当前 chain 的回复不带那行。
- `/status`、`/new`、`/stop`、`/skills` 作用于 DM 当前 chain。
- design lead 的子线程、按钮回显、附件：不变。
- 群聊：不变，不能绑 chain（§已决的取舍）。

## 模式互转与迁移

- **升级**：迁移建 `chains('main','Main')`，`main_chain` 和 `open_items` 全部归 `main`；`chainMode=false`；`home/MEMORY.md`、`home/memory/` 原地不动，成为 global——所有 chain 都看得见今天的全部记忆，没有东西被藏起来。`chains/main/` 为空，head 在之后的工作中把「只关 Main 的」逐行挪下去（`DISPATCHER` 的归属规则；不做一次性自动分拣）。升级后的行为与升级前逐字一致，直到用户打开开关。
- **关 → 开**：零迁移，列表出现一条 `Main`。
- **开 → 关**：当前留下、其余归档（§开关的确认）。归档不是丢：run 照跑、callback 照落、item 照显示、memory 照搜；恢复一下就回来。
- **降级到不带本功能的版本**：`main_chain.chain_id` 列多余无害；`open_items_v2` 不会被旧代码读到——所以迁移要保留旧表名（新表拷完后 `DROP` 旧表、`RENAME` 新表为 `open_items`），旧代码读到的 PK 多一列但 `problem` 仍在，跨 chain 同名的行会撞。写进 CHANGELOG 的升级说明即可，不做降级迁移。

## Token 成本

| 项 | 今天 | 多链后 |
| --- | --- | --- |
| 轮换一次的 seed | ~5K tokens | +chain index ≤ 1K、+global 日记 ≤ 0.25K、+`## Chains` ~50、−`## Open` 只剩本 chain 的；忙的用户**持平或更小**，闲的用户 +~1K |
| 轮换次数 | 每小时空闲一次 | 每条 chain 各算；来回切 3 条 chain、各自空闲超过 1h 的用户最多 3 倍的 idle 轮换，每次 ~6K 未缓存输入——每天几十次轮换也在几万 tokens 量级 |
| 系统提示词 | 每 turn 同一串字节 | 仍是同一串字节、所有 chain 相同：cwd 同为 `home`，`dispatcher.md` 同一份，chain 名和路径走 seed。provider 的前缀缓存跨 session 命中，同 TTL 内多条 chain 共享 |
| `DISPATCHER` | — | +~120 tokens（两层 memory 的归属表、`<note global>`、`## Chains`、「这事在 chain B」一句） |
| 跨 chain 的事实 | 在同一上下文里 | 一次 `rg` 或 `pier search --in chain:<name>`（10 条 × 600 字 ≈ 1.5K tokens）；这是隔离的代价，也是它的收益——不相关的话题不再占上下文 |
| `/status`、状态消息 | 全部 items | 本 chain 的 items + 每条其他 chain 一行 |
| head 的上下文 | 一条 head 装所有话题，60K 更快到 | 每条 head 只装自己的话题：`full` 轮换变少，是净节省 |

结论：峰值成本是轮换次数，线性于「同时活跃且各自超时」的 chain 数，上界由用户开几条决定；没有常驻的额外成本。

## 不做

- 自动把消息归到某条 chain、head 替用户建 chain、按 item 自动分链——手动隔离是本意。
- item 跨 chain 移动；chain 合并；删除 chain。
- 一条 chain 一个群聊/一个 DM；home DM 开线程；IM 列表 UI。
- chain 级别的 model/reasoning pin、cwd、skills。
- 跨 chain 的 run 所有权（A 的 head 操作 B 的 run）。
- `native/` 的任何改动：tab、通知、badge 全部沿用 per-session 的现状。

## 已决的取舍

用户把这些交给 lead 定；每条一句理由，正文已按此写。

| 问题 | 决定 | 为什么 |
| --- | --- | --- |
| 命名 | UI 叫 **Chain**/链 | 「conversation」已是单链的词，「topic」是 item 的标签，「thread」「channel」撞 IM |
| item 跨 chain 移动 | 不做；`<done>` 后在对的 chain 重开 | 架构上可行（stage + ledger 就是 head 需要的全部），但要改 callback 解析规则；第三次需要再做 |
| 群聊绑 chain | 不做，下一轮 | 一个 Slack channel = 一条 chain 很自然，但要推翻 11 的「群不能是 home」，另起设计 |
| 关开关时其余 chain | 归档，不拒绝 | 不丢东西、一步完成；归档里在跑的事 `/status` 和面板都列，原则 5 满足 |
| chain 级 model pin | 不做 | Settings 默认之外多一层；先看有没有人要 |
| global 注记的拼写 | `<note global>` | 同一个标记加一个词，`openItemMarkers` 多认一个 flag，最少新词 |
| `pier search` 默认顺序 | 调用者 chain 优先，不加 `--all` | `--in pier` 已经是跨 chain 的平铺顺序 |
| 列表停靠 | ≥ 80rem 停靠左栏 | 「列表可见」才是旧 rail 的交互；收窄时回到标题菜单，不多一个组件 |
| 归档 chain 的 callback | 仍落它自己的 head | 转投首条会让首条的 head 处理它没开过的 item；多花的 token 是它自己 chain 的 |
| 旧 hash 跨 chain 同名 | 落首条 | 同名概率低，列出让选是为旧书签多一个 UI |
| 外部建的定时任务 | 落首条，不加 `--chain` | 创建者 chain 覆盖 head 建的全部；CLI 从外部建任务的人用 `/chain` 切到想要的 chain 再建 |

## 开放问题

无。定稿后 build lead 遇到的新选择记回本文档。

## 验收

- 开关关时：一周日常使用与升级前逐字一致（seed、`/status`、DM、面板）；升级本身不改任何文件内容。
- 开关开、两条 chain 各做一件事一天：各自的 head transcript 里没有对方的 item、note、callback；各自的 `chains/<id>/memory/` 只有自己的 `<note>`；global 日记只有 `<note global>`；一条 chain 问对方的事，head 答一行指向 `/chain <name>`，或一次 `pier search --in chain:<name>` 后作答，不猜。
- 任一 chain 的 run 失败、design lead 等人：bar 的 lead、面板首行、DM 状态消息的 `Other chains` 行、`/status` 都看得到，带 chain 名；一键到它。
- DM 里 `/chain B` 后，A 的 callback 回复带 `chain · A` 灰行，按钮点击回到 A。
- 关开关归档两条 chain 后，它们的 run 跑完、callback 落到各自 head、item 在面板上带 `archived`；恢复其中一条后能继续对话，seed 是它自己的 memory。
- 每条 chain 的轮换 seed ≤ 今天的 seed + 1.5K tokens；系统提示词字节在所有 chain 间相同（`GET /api/sessions/:id/system-prompt` 对比）。
- 手机（真机 iOS Safari/Lark/Slack 客户端各一遍）：标题 sheet 切 chain、行内新建、`/chain` 列表与切换、状态消息的 `Other chains`。

## 测试（纲要）

- `core/chain.test.ts`：两条 chain 各自 idle/full/`/new`/lost 轮换互不影响；seed 的 chain 段、`## Chains`、两层日记预算；`<note>` 与 `<note global>` 落点；归档 chain 拒收消息但 `headOf` 仍解析。
- `tasks/open-items.test.ts` / `store.test.ts`：`(chain_id, problem)` 键，跨 chain 同名互不干扰，`namesKey` 只在本 chain；`chainOf` 的 launcher 集合；`conversation` callback 按发起者 chain、定时任务按创建者 chain、无解落首条。
- `core/search.test.ts`：`--in chain:<name>` 前缀与歧义；调用者 chain 优先；`place` 为 chain 名。
- `web/server.test.ts`：`/api/chains` 四个路由、`mode` 的 409 清单与 `force`、`messages` 带 `chain`、归档 409、旧 item 路由的唯一性解析。
- `web/ui/*.test.ts`：列表 popover/侧栏同一组行、行内新建、⌘⇧[ ]、hash 导航、面板的 tag 与顺序、`Open in its chain`、`#/conversation` 落上次的 chain。
- `channels/*.test.ts`：`/chain` 五种答法、指针持久化、非当前 chain 回复的灰行、按钮路由回发它的 chain、状态消息的 `Other chains`、home 更换重置指针。
- `core/reply.test.ts`：`<note global>` 的剥离与 flag。

## 预算

- `core/`：`chains` 的读写与 `MainChain` 按 chain 的锁和成员查询、`/chain` 命令、`<note global>`，约 +150；超 2k 要在提交里按规则 5 抬 ceiling，理由：「一条 chain 自己的 head 轮换、memory 两层与 `/chain` 命令」。
- `web/`：列表模块（popover + 停靠共用）、路由、hash、面板 tag，约 +400（13.6k 内）。
- `channels/`：`/chain`、指针、灰行、`Other chains`，约 +120（5k 内）。
- `tasks/`：`chain_id` 贯穿 items 与回调解析，约 +80（4.2k 内）。
- 删除的：`TaskService.head()` 的「唯一 head」用法；`web/ui` 里写死 `#/conversation` 的分支。

## Worker 拆分（定稿后）

1. 数据与 core：迁移、`chains` 存取、`MainChain` 按 chain（锁、成员、seed 两层、`<note global>`）、`chainOf` 新签名、`TaskChain`；`core/chain.test.ts`。
2. tasks：items 的 `chain_id`、`onTurnEnd` 的「任一 head」、callback/定时任务/`unasked` 的解析、`firstHead()`；相关测试。
3. web 后端 + 前端：路由、hash、列表模块、面板 tag、`⋯` 开关、确认对话框。
4. channels：`/chain`、指针、灰行与按钮路由、`Other chains`。
5. search 与提示词：`--in chain:`、顺序、`place`；`DISPATCHER`；skills 与 owner 文档、CHANGELOG。
