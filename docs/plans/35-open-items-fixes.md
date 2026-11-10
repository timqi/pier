# 35 — open items 修复

两份审查（报告 A、报告 B）的全部问题定下的行为，每条配回归测试。`native/` 不动。

## 定下的行为

每条末尾括号是来源（A1 = 报告 A 第 1 条）。

### P — 解析（`core/reply.ts`、`core/inbound-file.ts`）

- **P1 箭头只认 ` → `**：`ARROW` 去掉 ` -> `。`reply.ts` 导出 `ARROW = " \u2192 "` 和 `arrowOf(key): { old: string; to: string } | undefined`（按第一个 ` → ` 切，两边 trim，任一为空则 `undefined`）；`tasks/open-items.ts` 自己那份 `ARROW` 删掉改用它。（B1）
- **P2 `<done>` 带整段原文**：done marker 变为 `{ op: "done"; problem: string; to?: string; whole?: string }`。`whole` 只在切出了箭头时给，值是整段正文按 `<open>` 行读出的 key（`openLine(body).problem`）；`problem`/`to` 的读法不变（箭头两边各自 `openLine`）。（A1、B1）
- **P3 key 的切分**：先按第一个 ` —+ `（两侧有空格的一串 em dash）切；没有才退回第一个裸 `—+`。`修复登录——web 端 — 进行中` 的 key 是 `修复登录——web 端`；`a—b` 仍是 key `a`、stage `b`。（B7）
- **P4 `(run <id>)` 任意位置**：正文里所有 `(run <id>)` 和 `(runs <id>, <id>)` 都收进 `runIds`（按出现顺序）并从正文剥掉，然后才切 key/stage；id 是不含空白、括号、逗号的一个词，所以 `(run the tests)` 不是 token。`<open>a (run r1) — b</open>` 的 key 是 `a`。`<topic>`、`<done>` 两边同样读。（A6）
- **P5 标记不吞同名开标签**：一个标记的正文里不能再出现同名开标签（`<done> … <done>c</done>` 只认后一个）；`<open>a — say <done>b</done> later</open>` 照旧是一个 `<open>`。（A5 inlineUnclosed）
- **P6 回复最后一行的未闭合标记**：`<open|done|note|topic|note global>` 开在回复最后一个非空行、到文末没有正确闭合标签的（缺失，或写成别的 `</…>`），正文取到行尾（错的闭合标签一并剥掉），按正常标记解析并从可见文本剥离。`openItemMarkers` 多返回 `unclosed: string[]`（这类标记的原文），`recordOpenItems` 逐条 `log.warn`。不在最后一行的未闭合开标签照旧是正文。（A5）
- **P7 任意缩进的围栏**：`FENCE_RE` 认任意空白缩进的 ``` / `~~~`（列表里 4 格缩进的代码块）。（B4）

### T — 整轮文本与压缩（`agent/`、`core/types.ts`、`core/router.ts`、`core/chain.ts`）

- **T1 `turn-end` 带 `earlier`**：`{ type: "turn-end"; text; meta?; error?; earlier?: string }`。`earlier` 是这一轮里答复之前、带工具调用的 assistant 消息的文本（非空的，按顺序 `\n` 连接），没有就不带。`PiSession.subscribe` 在闭包里攒（Pi 的 `turn_end`：assistant、有 tool call、`stopReason` 不是 error/aborted、文本非空），发出任何 `turn-end` 时带上并清空。`toSessionEvents` 保持无状态。（B5）
- **T2 `Router.onTurnEnd` 第四个参数 `earlier: string`**（没有则 `""`）。`MainChain` 的 `<note>`/`<note global>` 从 `earlier` 和 `text` 都读。`tasks/service.ts` 的消费归 S。可见回复、`autoTitle`、`DESIGN_FINAL`、silent 判定只看 `text`。
- **T3 压缩后重注入**：`Router.onCompacted(listener: (sessionId: string) => void)`，在 `context-compacted` 事件上调用。`MainChain` 注册：session 是某 chain 的 head 且 `status(chainId).seed !== NOTHING_OPEN` 时，`systemInput("[Pier: the context was compacted. The open items as they stand, keys exact:]\n" + seed, { kind: "open-items", statusSnapshot }, "append")`；发不出去走 `router.reportTo`。（B 推测项，已核实：全仓只有 `tasks/agent.ts` 读 `context-compacted`，head 压缩后没有任何重注入）

### S — 存储与 head 回合（`tasks/store.ts`、`tasks/service.ts`、`tasks/open-items.ts`）

- **S1 `namesKey`**：`KEY_END = /^(?:\s*[。:：]|\s+[-–]\s)/u`——`-`、`–` 要前后空白，`—` 删掉（P3 之后 key 里的 em dash 是 head 有意写的）。`<done>gpu</done>` 不关 `gpu-speed3 …`。（B3）
- **S2 `<open>` 不带 run 保留原 run_ids**：upsert 一个开着的事项时，marker 的 `runIds` 为空则 `run_ids` 不变（用户决定）。重开已关闭的 key 仍按 marker 写。（B6）
- **S3 `<done>` 的匹配顺序**（`closeItem`），`keys` = 本 chain 开着的 key：
  1. 无箭头：`problem` 是开着的 key，或 `namesKey` 唯一命中 → 关闭。
  2. 无箭头且没命中：`problem` 正是本 chain 一个已关闭行的 key 或已关闭行的 alias，并且不是任何开着事项的 alias → **已了结**（no-op，不算 unmatched）。是开着事项的 alias（改过名）→ unmatched，提示里有现 key。（A4、A2）
  3. 有箭头（仍然排在所有其它 marker 之后处理）：
     a. `whole` 正是开着的 key → 当普通 `<done>` 关掉它。（A1）
     b. `old` 命中开着的事项（规则 1 的读法）且 `to` 是另一个开着的 key → 关 `old` 并入 `to`（现状）。
     c. `old` 没开着、`to` 开着：`to` 的 aliases 含 `old` → 已了结；本 chain 有 key 为 `old` 的已关闭行 → `absorb(to, old)`，已了结。（A3、B2）
     d. 其余 unmatched。
  `markOpenItems` 的返回要能区分“已了结”和“什么都没命中”（形状由实现定，最朴素的即可）；“已了结”不算行变化、不发 `open-items-changed`、不进 unmatched。
- **S4 `<open>` 的 key 里带箭头**：`arrowOf(problem)` 有值、整段不是开着的 key、`old` 正是开着的 key（精确）且 `to !== old` → 当作 `<open>to — stage (runs)</open>` 加 `<done>old → to</done>`。否则 key 原样存（`迁移 v1 → v2`），之后靠 S3.3a 关得掉。（A1、B1）
- **S5 `userClosed` 删除**：S3.2 之后 head 对已关闭 key 的 `<done>` 本来就是 no-op，记录在 DB 里，重启不丢；带箭头、`old` 被用户关过的 `<done>` 不再被吞（走 S3.3）。（A2）
- **S6 owed 的 unmatched**：head 回合结束时——这条回复关掉了至少一个事项 → owed = 本回合的 unmatched；否则 owed = 去重(旧 owed + 本回合 unmatched) 取最新 5 条；没有开着的事项 → 空。用户关闭时按现状滤掉指向该 key 的。（A4）
- **S7 回合中被用户关闭后不复活**：`closedMidTurn` 记 `{ key, runIds }`（关闭前读）。回合结束、写完 marker 后，把这些事项再关掉：key 相同的；或者这条回复之前没开着、且（aliases 含那个 key，或与它共享一个 run——按 `getRun(id)?.targetSessionId ?? id` 比）的。（A9）
- **S8 整轮标记**：`recordOpenItems(…, earlier = "")` 的 marker 是 `earlier` 的在前、`text` 的在后；`topic` 只读 `text`。`staleItems` 的“回复点了名的 key”两段都算，并加上 `whole`。（B5）
- **S9 内存状态不持久化**（A4 的评估）：`userClosed` 已删（DB 的已关闭行就是记录）；`closedMidTurn` 只活一个回合，重启本来就切断这个回合，续上的回合上下文里有 `[Pier: the user closed …]`；owed 丢的只是 `/status` 和下一个 seed 的一行提醒，head 当时已收到提示并（N1 之后）立刻有一轮去处理——不值得一张表。

### N — 提示与 seed（`tasks/service.ts`、`tasks/open-items.ts`、`core/`、`agent/roles.ts`、文档）

- **N1 unmatched / stale 提示触发 head 一轮**：这条 `systemInput` 用 `followUp`（空闲即起一轮，回合中则排在其后），origin `{ kind: "open-items", turn: true, … }`。防循环两条，命中任一就退回 `append`、不带 `turn`：这一轮本身是 `open-items` 提示开的（`opened?.kind === "open-items"`）；提示全文与本 chain 上一条发出的提示相同（内存里每 chain 记一条）。`awaitsTurn` 对带 `turn` 的 `open-items` 为 true；`agent/events.ts` 的 `systemOrigin` 把 `turn` 读回来；`core/types.ts` 的 origin 文档改写。`[Pier: the user closed …]` 和 T3 仍是 `append`。（B8）
- **N2 unmatched 提示措辞**：`[Pier: <done>X</done> closed no open item. If it meant one of these, resend <done> with that key exactly; if its item is already closed, send nothing:\n- k1\n- k2]`；箭头指向没开着的 `to` 的括注保留。seed 行：`- unmatched <done>: X (closed nothing; if it meant an item above, <done> that item's key)`。（A4）
- **N3 seed 里的 unlisted run 不再长得像事项**：事项行（和 owed 行）之后单独一段：
  ```
  Runs in no item — not keys, never <done> one; <open> an item naming a run that is tracked work:
  - run <id> · session <sid> · <name> · running
  ```
  没有事项时第一行仍是 `Nothing open.`，这段跟在后面。`/status` 文本和 snapshot 不变。（B 推测项，已核实：`openItemsStatus` 的 seed 把 `[...items, ...unlisted]` 用同一格式渲染，run 名占了 key 的位置）
- **N4 `agent/roles.ts` `DISPATCHER` §Open items**：箭头只有 ` → `、只写在 `<done>` 里，`<open>` 的 key 不带箭头；`<open>` 不带 `(run <id>)` 保留该事项原有的 run，写了就整体替换；`open items` 提示（unmatched / stale）是给 head 的一轮：只回修正后的 marker，`<silent>`，没有要改的就 `<silent>` 说明；seed 的 `Runs in no item` 不是 key。一句一条，不加解释。
- **N5 文档**：`docs/design/10-continuous-session.md` §Open items 按 P/T/S/N 全部改到位（含 A、D 两个 worker 的行为）；`docs/design/11-im-conversation.md` 的 `open-items` 行（现在带回执、起一轮）；`docs/design/03-web-workbench.md` 由 W 改。

### W — web（`web/ui/`）

- **W1 回到前台重读**：`visibilitychange` 变 `visible` 时 `void refreshSessions()`。（A7）
- **W2 响应序号**：`loadOpenItems` 发起时取单调序号，`commitOpenItems` 丢弃序号小于已提交的响应（`refreshOpenItems` 与 `refreshSessions` 两条路共用）。（A7）
- **W3 topic 表按 chain**：`setOpenTopics` 只收屏幕上这条 chain 的事项（`item.chain.id`）；切 chain 后重建。等待点、选项折叠（`topicOpen`）、回调归属（`runTopic`）都不再串 chain。（A8）
