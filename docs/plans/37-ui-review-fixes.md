# 37 — UI 审查修复

fable UI 审查 28 条（`/tmp/pier-ui-review/REPORT.md`，截图同目录，行号对应 `87b02e0`）的修复状态与定下的行为。`native/` 不动。

分支 `ui-review-fixes`，lead 在 `pier.ui-review-fixes`。worker 各开 `--worktree`，lead `git merge` 回来。

## 规则

- 每个 worker 交付前：`npm run check && npm run lint && npm test` 全绿；UI 改动在浏览器里 1440×900 和 390×844（粗指针）实测，报告里写实测到的数字和覆盖范围（Chromium 模拟不是 Safari/iOS）。
- 实测用自己起的实例：独立 `PIER_HOME`（临时目录）和空闲端口，只杀自己起的 PID；不碰 `systemctl --user … pier`，不按名字杀进程。
- 行为变了同步 `docs/design/06-ui-ux.md`、`03-web-workbench.md`、`15-item-view.md`。
- `web/` 现 14017 / 上限 14.05k：净增行在 commit 里给一句理由，越线时同一 commit 抬上限（AGENTS.md Budgets 5）。
- 每条配回归测试（纯 CSS 的除外，靠浏览器实测数字）。

## 状态

状态：`todo` / `wip <branch>` / `done <sha>` / `ask`（等用户取舍）。

### M1 — P0、P1

| # | 条目 | 定下的行为 | 状态 |
| --- | --- | --- | --- |
| 1 | chip/话题标签/折叠行热区写反 | `inset-block: calc((100% - 2.75rem) / 2)`，粗指针下热区 ≥44px；折行的 chip 行里相邻热区平分间距（28–36px），等 #9 单行滚动后补齐 | done `4c6b4ab` |
| 2 | 手机顶栏 `#chat-title`、`#chat-menu` 不到 44px | 进粗指针 44px 名单；composer 的 `+` 和发送键补到 44px | done `c56e7e5` |
| 3 | 同一事项两个名字 | 方案 A，见「决定记录」 | done `8038822` |
| 4 | 运行中的 worker 会话页面空 | 子会话唯一的气泡仍在运行时步骤 chip 默认展开，日志高度跟随面板；手动收起在该会话内记住（内存，F5 后重开）；同步 06 | done `09ecf96` |
| 5 | 工具行预览是 JSON 外壳 | 单键参数显示值，多键 `key=value`（值截 48 字符） | done `8b36394` |
| 6 | 顶栏状态 lead 像当前会话的状态 | 侧栏停靠时 lead 收成「图标 + 数量」；lead 与标题之间一条细线，所有宽度和视图都有 | done `52159d2` |

M1 合入于 `d8df074`，check/lint/test 全绿（2301）。浏览器数字是各 worker 在自己分支上用注入的 DOM 量的（测试实例没有模型权限）；合并后的分支只跑了测试，未在浏览器复测，留给 M2 的 worker 顺带复测和最终 review。

### M2 — P2

| # | 条目 | 状态 |
| --- | --- | --- |
| 7 | 手机事项视图只留一个返回控件，隐藏 ⌂ 和上下文 chip | done `8ebb33f` |
| 8 | 事项视图里隐藏与视图相同的话题标签，留 waiting 圆点 | done `7d96629` |
| 9 | 手机 chip 行单行横向滚动 | done `3189133` |
| 10 | 手机状态面板：元数据独占一行无前导分隔符，短语优先占宽 | done `85818c0` |
| 11 | 无 hover 的停靠侧栏：事项行两个动作收进一个 ⋯ | done `c5e7515` |
| 12 | Close 撤销（方案 B） | done `bcbb4b8` |
| 13 | 事项行去向标记（方案 A） | done `dd9bd5f` |
| 14 | chain 行显示进行中事项（静止圆点或 `N open`） | done `8dfef64` |
| 15 | `#turns` `scrollbar-gutter: stable both-edges` | done `341238b` |
| 16 | chain 列表和状态面板的手机 sheet 加标题和关闭按钮 | done `fced09f` |
| 17 | Settings 标签条：当前标签滚入视野，44px | done `c89d127` |

### M3 — P3

| # | 条目 | 状态 |
| --- | --- | --- |
| 18 | Models 页 provider 行状态列对齐 | done `60ee997` |
| 19 | `.select:disabled` 样式 | done `ace2f6a` |
| 20 | Settings 标签 `aria-current` | done `3b4e983` |
| 21 | 两个浮动按钮文案改英文，同步 03 | done `cb9e63b` |
| 22 | 字号档位收敛到约 5 档，折叠行 12px，对比度 ≥4.5 | done `c5fcff0`（六档 11/12/13/14/15/16，neutral-400 调到 ≥4.5:1） |
| 23 | Files：chain 目录显示名字，`memory` 新到旧，对话框焦点环 | done `0adc15f` |
| 24 | 粗指针下隐藏菜单快捷键提示 | done `5894fac` |
| 25 | 单 run 事项不重复 `open` / `elapsed` | done `e3e2d30` |
| 26 | thinking 行在词/句边界截 | done `30062e6` |
| 27 | Tasks 页：时间加「ago」语义，说明文字不显示反引号 | done `2cfa015` |
| 28 | 切换 chain 记滚动位置 | done `72fae3a` |

## 待用户取舍

- **#3 事项命名**：A 侧栏/面板/顶栏标题固定用 problem（与话题标签一致），run 名进第二行或 tooltip（报告建议，只改 `core/open-items.ts` 的取值）；B 保持现状只在 tooltip 里补 problem；C 标签也改用 `title`（要让 `title` 稳定，动 tasks 的数据）。
- **#12 Close 撤销**：现在没有 reopen 事项的接口（重开只经 `<open>`）。A 关掉后原位留「Closed — Undo」几秒，Undo 调新的 `POST …/reopen`（改 `tasks/store.ts` + server）；B 延迟提交：几秒内不发 close 请求，Undo 只是取消（不动服务端，但关页面/刷新时要立即发出）；C 只把 Close 和事项视图按钮拉开/收进 ⋯，不做撤销。
- **#13 事项行去向**：A 行上加去向标记（跳子会话 ↗），点击行为不变；B 事项视图做主点击，会话做次要动作（改交互约定和 15）。

## 决定记录

- **#3 → A**：侧栏/面板/顶栏的事项标题固定用 problem（与话题标签一致），run 名进 tooltip。只改 `core/open-items.ts` 的取值，不动 tasks 数据。
- **#12 → B**：Close 延迟提交。行原位变成「Closed — Undo」几秒，期间不发 close 请求，Undo 只是取消；到时、或页面隐藏/离开（`pagehide`/`visibilitychange`）时立即发出（`keepalive`）。不动服务端。
- **#13 → A**：行上加去向标记（跳子会话时 ↗），点击行为不变。

## M2/M3 分工

并行 worktree（都基于 `0c2ab81` 之后的本分支）；worker 不改 AGENTS.md 的上限行，报净增行数，lead 合并时统一抬。

| 分支 | 条目 |
| --- | --- |
| `ui-fix-items` | #3 #10 #11 #12 #13 #25 |
| `ui-fix-itemview` | #7 #8 #9 #15 #28，并复测 M1 的 #1 #2 #6 |
| `ui-fix-sheets` | #14 #16 #17 #20 |
| `ui-fix-settings` | #18 #19 #23 #27 |
| `ui-fix-misc` | #21 #24 #26 |
| 本树、最后串行 | #22（字号收敛，横跨全部文件） |

## 合并后的状态

- 五个分支合入于 `8ae9961`，check/lint/test 全绿（2320）。`web/` 14171，上限抬到 14.2k；`core/` 2338。
- 已知未验证/遗留：
  - #12 页面离开时的 keepalive close：service worker 控制页面时，由页面发出的请求随页面一起丢（一个等待项时 0/8）；`sw.js` 改为自己发 keepalive 请求后，1/2/3 个等待项 × 导航离开两种方式各 8 次全部送达（headless Chromium，经本地转发代理计数）。隐藏标签页用的是伪造的 `visibilityState`。
  - #18 1024 宽侧栏停靠时 provider 行动作区仍折行。
  - #1 折叠行后紧跟话题标签时两者平分间距（约 40px）。
  - 所有浏览器数字来自 Chromium 模拟 + 拦截/注入的数据；Safari/iOS、暗色未测。

## 整体复测（`ffd6e74`）

1440×900、1180×820 粗指针、390×844 粗指针，亮暗各一遍，截图在 `/tmp/ui22/shots/`。顺带修了：Undo 行等高 `742f03a`、粗指针 popover 菜单行 44px `af4adb4`、侧栏 New chain `+` 44px `fae0c92`、Agent 的 Add tool/package 44px `ffd6e74`。

未修、需取舍（不在 28 条内）：
- Settings 粗指针控件已补到 44px（`.btn` min-height，开关/分段/帮助 `?`/色块/版本链接用 `.touch-reach` 热区，状态面板搜索框 min-h-11）。未补：文本输入框平板上 41px、句中的 `vt` 链接 11×15、Agent package 展开箭头宽 20px（热区会盖住旁边的标签）。
- 字号的遗留写法（值已在档位上，但写成 rem 字面量）：`chains.ts` 等约 10 处。
- 待查：从子会话重载 `#/settings/models` 显示了子会话而不是 Settings（测试夹具或产品 bug，未定）。

## 最终 review（goal `r2zkz63k19crw59d`，clean at `7673166`）

修了：页面离开时等待中的 Close 经 service worker 发出 `634cd6c`；等待期间事项重读的回归测试 `5a3cb0d`；06/03 关于手机 sheet 头的表述 `7673166`。

review 留下、未修（P2/P3）：
- `visibilitychange → hidden` 会立即提交等待中的 Close：手机上 5 秒内切应用就没有 Undo 了，03 未写明这是取舍。
- `menu.ts:146` 无 title 时默认 `closeLabel` 为 "Close undefined"（不会渲染）；`explorer.ts:175` `/api/chains` 读失败被缓存到 Files 重开。

review 之后修了（`2b808d0`，只跑了 check/lint/test，未再 review、未在浏览器实测）：Undo 期间事项被别处关掉时丢弃等待中的 Close；切回 chain 时把离开前翻出的更早成员一起读回，恢复到原行。

## `2b808d0`、`c082903` 的 review

修了：
- 切回 chain 按「离开时屏上最老的成员」读回，而不是按翻出的个数：离开期间 chain 轮转过，旧 head 也在其中 `35e74a5`。新测试用 6 条消息的 head，去掉 `left ||` 会失败（原测试的 head 只有 1 条，`shortHead` 本来就翻页）。
- 丢弃等待中 Close 的注释写成「会被拒绝」，实际服务端对已关闭的精确 key 原样返回；改注释，03 补上这条规则 `e53c61c`。
- 帮助 `?` 的热区盖住下方输入框顶部 44×7.3px（手机 49.5×8.2px）并在那里响应；手机上换行的两个开关，下面那个的热区在上面标签底部 49.5×5.1px 响应。热区改为从邻居的面下面穿过 `ada87f2`。
- 带文字的开关热区是标签正中的 44px 方块，开关处只有 19.5px（手机 22px）高可点；热区不再比面小，整行标签 44px 高 `04475c4`。

未修、需取舍：
- Undo 期间事项被改名（旧 key 成为别名，`tasks/store.ts` `claimRuns`）：旧 key 离开列表，等待中的 Close 被静默丢弃，事项以新名字留着。`OpenItem` 不带别名，前端分不清「别处关了」和「改名了」。
- 切回 chain 时一次并行读回离开前翻出的全部成员，没有上限。
- 不在这次 diff 内：平板 `Close charter` 32×32、Models 的 `Move up`/`Move down` 28×28；手机 Files 头 409px 在 390px 里横向滚动（细指针下相同）。

实测（Chromium 模拟 1180×820 与 390×844 粗指针 + 触摸，1440×900 细指针；数据为拦截注入）：Settings 七个主题、Agent 各面板、Add provider、登录流程、Charter、Files、目录选择器里没有低于 44px 的 `.btn`，没有热区在别的控件的面内响应，没有新增横向滚动；细指针下 `.touch-reach`、`.reach-row`、`.btn` 的计算样式和目录行的几何与 `7673166` 相同。Safari/iOS、暗色、真机触摸未测。

之后又修了四处（只跑了 check/lint/test，没有浏览器实测，尺寸是按规则算的）：
- 焦点在 Undo 上时事项被别处关掉，焦点交给接替的行（侧栏最后一行交给当前 chain 行），与计时器路径同一条规则 `dbcfd36`。
- 下拉触发器（`CONTROL_TRIGGER`）粗指针下 44px，与同行的目录字段等高；Settings 的 Default model、Title model 一并变高 `4e34503`。
- `.reach-row` 与 `.chip-row` 相同的两条规则合成一个选择器 `aa551d4`；随 `.chip-row` 的查询，窄于 48rem 的细指针下 `.reach-row` 也带上 `isolation`，那里没有热区可排。
- 换行叠放的开关粗指针下行距 1.75rem，两个热区各自完整（平板 44px、手机 49.5px）`cc28966`。算下来 `.reach-row` 的「从邻居下面穿过」已不再被用到，未实测，留着。

变基：分支变基到 `ec43b80`（main 合入语音输入之后），本文里的 sha 都是变基前的，按提交标题找。冲突三处，两边都留：06 的 Composer 行与 Mic 行、Menus 行，03 的浮动按钮段，AGENTS.md 的 `web/` 行。`web/` 14927，上限 14.95k（main 的 14.8k 加上本分支的净增）。check/lint/test 全绿（2397），没有浏览器实测。
