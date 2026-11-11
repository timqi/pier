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
| 3 | 同一事项两个名字 | 需用户取舍，见「待用户取舍」 | ask |
| 4 | 运行中的 worker 会话页面空 | 子会话唯一的气泡仍在运行时步骤 chip 默认展开，日志高度跟随面板；手动收起在该会话内记住（内存，F5 后重开）；同步 06 | done `09ecf96` |
| 5 | 工具行预览是 JSON 外壳 | 单键参数显示值，多键 `key=value`（值截 48 字符） | done `8b36394` |
| 6 | 顶栏状态 lead 像当前会话的状态 | 侧栏停靠时 lead 收成「图标 + 数量」；lead 与标题之间一条细线，所有宽度和视图都有 | done `52159d2` |

M1 合入于 `d8df074`，check/lint/test 全绿（2301）。浏览器数字是各 worker 在自己分支上用注入的 DOM 量的（测试实例没有模型权限）；合并后的分支只跑了测试，未在浏览器复测，留给 M2 的 worker 顺带复测和最终 review。

### M2 — P2

| # | 条目 | 状态 |
| --- | --- | --- |
| 7 | 手机事项视图只留一个返回控件，隐藏 ⌂ 和上下文 chip | todo |
| 8 | 事项视图里隐藏与视图相同的话题标签，留 waiting 圆点 | todo |
| 9 | 手机 chip 行单行横向滚动 | todo |
| 10 | 手机状态面板：元数据独占一行无前导分隔符，短语优先占宽 | todo |
| 11 | 无 hover 的停靠侧栏：事项行两个动作收进一个 ⋯ | todo |
| 12 | Close 撤销 | ask |
| 13 | 事项行去向标记 | ask |
| 14 | chain 行显示进行中事项（静止圆点或 `N open`） | todo |
| 15 | `#turns` `scrollbar-gutter: stable both-edges` | todo |
| 16 | chain 列表和状态面板的手机 sheet 加标题和关闭按钮 | todo |
| 17 | Settings 标签条：当前标签滚入视野，44px | todo |

### M3 — P3

| # | 条目 | 状态 |
| --- | --- | --- |
| 18 | Models 页 provider 行状态列对齐 | todo |
| 19 | `.select:disabled` 样式 | todo |
| 20 | Settings 标签 `aria-current` | todo |
| 21 | 两个浮动按钮文案改英文，同步 03 | todo |
| 22 | 字号档位收敛到约 5 档，折叠行 12px，对比度 ≥4.5 | todo |
| 23 | Files：chain 目录显示名字，`memory` 新到旧，对话框焦点环 | todo |
| 24 | 粗指针下隐藏菜单快捷键提示 | todo |
| 25 | 单 run 事项不重复 `open` / `elapsed` | todo |
| 26 | thinking 行在词/句边界截 | todo |
| 27 | Tasks 页：时间加「ago」语义，说明文字不显示反引号 | todo |
| 28 | 切换 chain 记滚动位置 | todo |

## 待用户取舍

- **#3 事项命名**：A 侧栏/面板/顶栏标题固定用 problem（与话题标签一致），run 名进第二行或 tooltip（报告建议，只改 `core/open-items.ts` 的取值）；B 保持现状只在 tooltip 里补 problem；C 标签也改用 `title`（要让 `title` 稳定，动 tasks 的数据）。
- **#12 Close 撤销**：现在没有 reopen 事项的接口（重开只经 `<open>`）。A 关掉后原位留「Closed — Undo」几秒，Undo 调新的 `POST …/reopen`（改 `tasks/store.ts` + server）；B 延迟提交：几秒内不发 close 请求，Undo 只是取消（不动服务端，但关页面/刷新时要立即发出）；C 只把 Close 和事项视图按钮拉开/收进 ⋯，不做撤销。
- **#13 事项行去向**：A 行上加去向标记（跳子会话 ↗），点击行为不变；B 事项视图做主点击，会话做次要动作（改交互约定和 15）。

## 决定记录

（用户答复后写在这里。）
