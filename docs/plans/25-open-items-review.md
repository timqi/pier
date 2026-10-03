# Open items：逻辑修复与文案

状态：用户已定稿（2026-10-03），含 D 的导航改动；由 supervisor 按本文启动实现 lead。基线：本工作树 `da67f1b`（0.4.5）。

## 复核范围

标记解析 `core/reply.ts` → 存储 `tasks/store.ts` `open_items` → 状态派生 `tasks/open-items.ts` → 投影 `core/open-items.ts` → Web 面板 `web/ui/drawer.ts`、`web/ui/open-items.ts`、导航 `web/ui/main.ts` → IM 状态消息 `channels/status.ts`、`channels/receipts.ts`。

## 发现的问题

| # | 问题 | 根因 | 证据 |
| --- | --- | --- | --- |
| 1 | 失败/被取代的 design lead 永远卡在「Needs you · Finalize design」；`<done>` 删掉事项后它以 `design:<session>` 身份重新出现 | 每个未报 `Design final:` 的 design lead 都被自动注入为事项（"unheld designs"）；原本靠「会话已关闭」过滤，关闭功能已删，现在没有任何东西能结束一个设计 | `tasks/service.ts:404` `openDesigns`，`tasks/open-items.ts:76` `unheld`；`dd65062` 引入时有 `flags.closed` 过滤 |
| 2 | design lead 最新 run 失败仍判为 `waiting on you` | `openStatus` 查设计时不看 run 状态 | `tasks/open-items.ts:52`；线上 `01a0ff27…` 两次 failed 后显示 `Needs you · Finalize design · failed 5h ago` |
| 3 | 会话列表里的 design lead 会话同样永远「design — waiting for you to finalize」 | `SessionInfo.designOpen` 进了 `isLive`/`markOf`，同样无生命周期 | `web/ui/drawer.ts:78,88`，`web/server.ts:302` |
| 4 | `<done>` 没命中任何事项时静默 | `recordOpenItems` 只返回「是否改了行」，无日志 | `tasks/open-items.ts:132`，`tasks/store.ts:455` |
| 5 | `<done>` 与 `<open>`/`<topic>` 的键解析不一致：`<done>a — b</done>` 的键是 `a — b`，而 `<open>a — b</open>` 的键是 `a` | done 走 `oneLine`，open/topic 走 `openLine` | `core/reply.ts:209` |
| 6 | head 分不清卡片来源（open_items 表 vs 自动注入的设计），seed 里两者长得一样，于是以为 `<done>` 无效、转而尝试 archive/cancel | 同 #1 | seed 见 `tasks/open-items.ts:146` |
| 7 | 事项每次被 `<open>` 更新就跳到列表末尾 | `ORDER BY updated_at` | `tasks/store.ts:450` |
| 8 | 设计类等待项第二行是 head 的 stage（如「设计 lead review 全链路中」），看不出要去设计会话回话；只有 stage 为空才显示 `Finalize design`，而 lead 多数时候只是提了个问题，并非待定稿 | 投影的 `waitsIn` 没进文案 | `core/open-items.ts:73` |
| 9 | goal 结束（review clean / decision / cap）但 head 的 stage 没写 `waiting on you:` 时，第二行仍是旧 stage，真正要做的事（合并？决定？）在第三行元信息里 | 第二行只取 stage | `core/open-items.ts:56` |

`#1–#3` 是同一个根因：设计的「未定稿」状态被当成独立于事项的开放列表。

## 修复方案

### A. 设计只通过 head 的事项存在

- 删除 `openDesigns` 注入和 `design:` 键：一个 design lead 出现在 open items 的唯一方式是 head 的 `<open>…(run <id>)</open>`，`<done>` 就是它的结束。head 忘写标记时它和任何子任务一样只在运行期出现在 `unlisted`。
- `TaskStore.leads().designOpen` 保留，只用于事项：`waiting on you` + `waitsIn`、导航目标 `designSessionId`。
- `openStatus` 的设计判定加条件：该会话的最新 run 为 `succeeded`；失败/取消/中断 → `stopped`，由 head 的回调决定续跑或 `<done>`。
- 会话列表去掉 `designOpen`（`SessionInfo`、`isLive`、`markOf`、`MARK_ROW.design`、`server.ts` `leads` 的该字段）；design lead 会话仍有 `phase` 标签，turn 结束未看仍是 amber unread。app 角标随之只数 unread。
- 删掉的测试：`tasks/open-items.test.ts` 三条 unheld designs 用例；`drawer.test.ts` 的 design mark 用例。

### B. 标记与存储

- `<done>` 用 `openLine` 取键，与 `<open>`/`<topic>` 一致。
- `<done>` 未命中任何事项：`log.warn("open items: <done> named no open item: …")`；`recordOpenItems` 不变。
- `open_items` 按 `rowid`（创建序）排序，upsert 不改变位置。

### C. 第二行只回答「要我干嘛」

投影规则（`core/open-items.ts`，Web/IM/`/status` 共用）：

| 状态 | 第二行 | 第三行 |
| --- | --- | --- |
| 等待，答在聊天（stage 带 `waiting on you:`） | `Needs you · <问题>` | 时间/goal/workers |
| 等待，goal 结束且 stage 无问题 | `Needs you · merge?`（review clean）/ `Needs you · decision: <reason>` / `Needs you · review cap reached · findings remain`；goal 文案从第三行移到第二行 | 其余元信息 |
| 等待，答在设计会话（`waitsIn`） | `Needs you in the design session` + ` · <stage>`（有则加） | 时间 |
| running / queued | stage（running 无标签，queued 为 `Queued`） | `elapsed …`、goal、workers |
| pending release / stopped | `Pending release · <stage>` / `Stopped · <stage>` | `succeeded 2h ago` / `failed 5h ago` |

- 删除 `Finalize design` 回退：定稿与否由 lead 在其会话里问，面板只说去哪。
- 分组卡片与 IM 的 Waiting on you 组内仍省略 `Needs you` 前缀，但保留 `in the design session`。
- 多 run 元信息：`N runs · <最新 run 的状态/时间>`，不再逐 run 分行。

### D. 去掉 Details

- 删除 `OpenItemPresentation.details`、行内 `Details` 开关、展开区及其焦点/展开状态保留逻辑；`/status` 快照保持 `version: 1`，校验不再要求 `details`，旧快照多出的字段忽略。
- seed 直接从事项事实生成：`- <problem> — <stage> (run <id> · session <id>)… · <status>`，完整键和 run 标识保留。
- 完整原话：标题与 problem 不同时作为行主体的 `title` 提示。
- 导航：Details 是到达 run 会话的唯一入口，去掉后主点击改为「去事情发生的地方」：`designSessionId` → `waitsIn` → 答在聊天的等待项定位 head 的 topic → 其余有 run 的事项进最新 run 的会话 → 无 run 则 head 末尾。已确认。

### E. 文档

更新 `docs/design/10-continuous-session.md` §Open items、`03-web-workbench.md` §Bar and status panel、`06-ui-ux.md` Status rows、`11-im-conversation.md` §Status，删除 unheld designs / Details / `Finalize design` 的契约句。

## 不做

- `OpenStatus` 四个状态值不变（IM reaction、topic 标签依赖）；只改展示标签。
- 不加「关闭会话」或「archive 卡片」命令：`<done>` 是唯一出口。
- `pier task cancel` 对已结束 run 无效是正确的，不动。

## 验收

- 线上场景回放：design lead 两次 failed 后被新 lead 取代 → 旧的在 head `<open>` 替换 run 后消失；仅 `<done>` 也消失；失败未取代时显示 `Stopped · failed …`。
- `<done>a — b</done>` 关掉 `<open>a — b</open>` 打开的事项；`<done>不存在</done>` 出一条 warn。
- 等待项三种来源（stage 问题、goal 结束、设计会话）第二行各如 C 表；IM 与 Web 同句。
- 面板无 Details 控件，↑↓/Tab 只走主体；375px 与 1280px 各看一次。
- 旧 `/status` 快照（带 details）回放不报错、不丢卡。
- `npm run check && npm run lint && npm test` 绿。

## F. 宽屏布局（用户追加，2026-10-03 已确认）

- ≥80rem：会话标题栏 `#bar` 横跨 `main` 两列；open items 右栏 `#status-side` 留在第二列、标题栏下方，与 chat 并列，顶部间距与现在一致。
- <80rem 不变。
- 更新 `03-web-workbench.md` §Bar and status panel 的对应句子。

## 进度

- A–C：`29926ba`；D：`052ad5a`；E：`bff0e5e`；F：`65b6fad`。review 已做；375px/1280px 浏览器目检未做。
