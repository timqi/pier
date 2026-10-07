# IM 事项：去掉 reaction，卡片只改不动，回执是 head 的话

状态：用户已定稿（2026-10-07）。lead 工作树 `im-open-items`；由 supervisor 按本文启动实现 lead。

范围：home DM（continuous session 的 IM 面），主流程和子线程。其他聊天不动。

## 现状

| 现在 | 代码 | 问题 |
| --- | --- | --- |
| 用户消息上挂 reaction：👀 进行中 → ❓ 等你 → ✅ 完成，随事项状态换；Lark 名字是 `OnIt`/`WHAT`/`DONE` | `channels/receipts.ts` `items()`、`item_receipts` 表 | 挂在用户**旧消息**上，聊几句就看不见；三种状态靠 emoji 猜；是卡片之外的第二套记账 |
| 一张 `▤ open items` 卡片，事件 1.5 s 合并后原地编辑，空则删；只有 `/status` 才重发到底部 | `channels/status.ts`、`main.ts` `refreshStatus` | 被埋在上面——但移动它意味着删旧发新，Lark 留「撤回」占位，之前试过，刷屏，已撤销 |
| head 派发为 `<silent>`；开了事项的静默回复主流程**什么都不发**——"reaction 或卡片就是痕迹" | `slack.ts`/`lark.ts` `send`、`DISPATCHER` §After dispatch | 去掉 reaction 后这条就是"没有痕迹" |
| callback/delegation 主流程不发；失败的发 `⚠ failed` | `shownByStatus` | 保留 |

reaction 承担三件事：**收到**（👀）、**等你**（❓）、**完成**（✅）。分析三者在没有 reaction 时各靠什么：

- **等你**的三个来源，每一个本来就带一条消息：goal 结束（review clean / decision / cap）→ callback → head 回合，`DISPATCHER` 要它用自己的话说并给 merge 按钮；design lead 等定稿 → 子线程根 `▷ <run> · design — waiting for you` + 线程里的结果；head 自己写 `waiting on you: <问题>` 的 stage → 它正在回复，问题就在回复里。卡片移动只会是**同一事件的第二次推送外加一个撤回占位**。唯一没覆盖的是 head 违约（有问题却静默），这归契约管，不靠多发消息。
- **完成**：`DISPATCHER` 已要求 done 用自己的话说。
- **收到**：只有静默派发这一种情况没有任何消息。状态消息会堆积，但**对一条用户消息的一条回复不是刷屏，是对话**——所以让 head 开口，而不是加状态行或移动卡片。

## 决策

### 1. home DM 不再有任何 reaction

- home DM 的主流程和子线程（design lead 的 topic）都不再加/换/删 reaction：没有 👀，没有事项 reaction。head 思考期间无即时信号，已接受（2026-10-07）。
- `item_receipts` 表删除（一条 migration）；`Receipts.join`/`items`、`settleAfter` 的 `joinTo`、`waiting`/`done` 两个 emoji 名、每事项 20 条上限一并删。`Receipts` 只剩回合 👀，给其他聊天用。
- 其他聊天的回合 👀 不变（不在用户要求内）。

### 2. 卡片只改不动

- 任何变化原地编辑，不推送；空则删；`/status` 重发到底部。**唯一的自动移动是 design final**：design lead 的线程根改成 `✓ <run> · design final` 5 s 后，卡片重发到底部一次（删旧发新，同 `/status`）；没有事项行，聊天里的状态消息永远 ≤ 1 条。
- 布局、分组、字段、上限不变。`OpenItemsView.items` 删除（只服务 reaction）。
- 卡片是全貌，按需 `/status` 拉到眼前；它不再是任何事件的通知。

### 3. 回执是 head 的话：一条用户消息，一条回复

`DISPATCHER` §After dispatch 改一条规则：

- 今天：「A dispatch is `<silent>dispatched</silent>` unless it has a question or news the stage lacks; so is a callback that only moves the stage.」
- 改为：「**A dispatch answers in one line — what was launched and its stage — beside its `<open>` marker, never silent.** A callback that only moves the stage is `<silent>`.」

于是：用户每说一件事得到一句话（「派了 worker 修登录，2 轮 review」），进行中静默（卡片原地改），等你和完成由 head 开口（已是契约）。推送次数 = head 说话的次数，没有状态消息。

Web 一致：静默回合不设未读、不推送（今天的规则），所以派发开口后 web 也会有一次推送——这是对的，用户说了话。

### 4. 违约兜底，不加消息

静默回复在 home 主流程的规则简化为今天去掉例外后的样子：**结清了用户消息（或该回合等的一条已发出的 note）的静默回合发 `stayed silent — <reason>`，带不带标记都一样**；没结清用户消息的（callback 触发）不发。head 违约静默派发时用户看到 `stayed silent — dispatched`，知道有事发生、可以 `/status`；`<open>` 的 stage 以 `waiting on you` 开头而回合静默时同理。原则 5 满足，代码比今天少一个分支。

### 5. 噪音账

```
你:   fix the login bug
head: 派了个 worker 修登录，2 轮 review。                              ← 回执（§3）
      …（review、修复：卡片原地编辑，不发、不推）
head: review clean at a1b2c3d — merge?   [merge] | [see review]      ← 等你
你:   ▸ merge
head: merged into main.                                              ← 完成；卡片原地改，空则删
```

对比今天：少了 reaction API 调用和 `item_receipts`；bot 消息多出派发回执那一句（原本是 👀）。撤回占位只有 design final 那一个。

### 6. Seam 与代码

- `core/types.ts` `AgentReply.opened` 删除（只服务 join）。`Channel.status(chatId, view, repost?)` 多一个 `repost`（design final 的重发，§2）；`OpenItemsView` 去掉 `items` 和 `web`。
- `channels/status.ts`：去掉 `receipts.items` 调用；其余不变。
- `slack.ts`/`lark.ts` `send`/`notify`：home DM（主流程与子线程）不 `mark`，不 `join`；静默回复按 §4。
- `agent/roles.ts` `DISPATCHER`：§3 的一条规则。
- `db.ts`：migration `DROP TABLE item_receipts`。
- 净行数下降：删 reaction 状态机、join、item 差分，无新增机制。
- 实现决定（lead，build）：§4 的「结清了用户消息」仍靠 `receipts` 表的簿记（`settleAfter` 的 `settles`），只是 home DM 里**不再调平台 reaction API**：`Receipts` 收一个 `quiet(chatId)` 谓词（适配器传 `isHome`），`mark`/`clear`/`sweep` 对 quiet 的 chat 只动账本不动 emoji。账本不改 schema，不加内存副本。`StatusMessage` 的 `seen` 参数只服务 `receipts.items`，一并删。

### 7. 不做

- 不发事项行；卡片除 design final 外不自动移动、不 pin；不加 Done 分组。design final 在 Lark 留一个撤回占位，接受。
- 不用 Slack `assistant.threads.setStatus`/typing 替代 👀（仅 assistant 容器可用，Lark 无对应）。
- 不给其他聊天去 reaction。

### 8. 文档与测试

- 文档：`docs/design/11-im-conversation.md` §Rendering（receipts 条、silent 条）、§Status 重写、emoji 表删；`04-im-channels.md` 功能表 Progress receipts 行、§Reaction receipts；`10-continuous-session.md` §Open items 的 `opened` 引用；`skills/pier-help/SKILL.md` 117–121 行。
- 测试：`channels/slack.test.ts`/`lark.test.ts` home 主流程与子线程零 reaction 调用、静默回复带标记也发 `stayed silent`、`status()` 只编辑/删除；`channels/receipts.test.ts` 删 items/join 用例；`channels/status.test.ts` 去掉 items 断言；`core/reply.test.ts` 删 `opened`；`agent/pi.test.ts` 或 `roles` 的 prompt 快照。

### 9. 验收

- home DM 全程零 reaction API 调用（mock 断言）；其他聊天的 👀 不变。
- §5 脚本在两平台各跑一遍：聊天里始终只有一张卡片，只在 design final 后移动一次。
- head 静默派发 → `stayed silent — dispatched`；开口派发 → 一句话，无其他。
- 真机：Slack 与 Lark 各看一次派发回执和等你回复的推送文案。
