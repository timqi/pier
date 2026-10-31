# 33 — Web 工作台改版

**已定稿**，与 [32 — 侧边栏放事项](32-rail-items.md) 一起在 worktree `pier.sidebar-items`（分支 `sidebar-items`）实施；原型已 fast-forward 进该分支（`28a8dfb`），实施从它起步，Console 各页（Settings 的胶囊 tab 与阴影卡片）一并换到本材质。待拍板各项按建议采纳：侧边栏头行只放实例名，来源 `$PIER_TITLE`，不加 Settings 字段；纯标题用 heading 元素而非 disabled button。截图全部来自一台隔离的 Pier（临时 `PIER_HOME`、端口 3999、`PIER_TITLE=g1`、种子对话），`native/` 不动。目标："更适合 web 的高效样式，重点优化交互体验，更易读"；Pier 的身份（一条 indigo 色阶、topic 色、状态行词汇、一个阅读列、共用控件）全部保留。

## 现状问题

每条对应 §对比截图里的 `before` 图。

- **桌面用了手机的字号。** 根字号 18px 在每个宽度都生效，bar 54px 高、菜单 17px、状态行 15.75px：1440 下整个 chrome 像放大了 112% 的手机页（`conversation-1440-*-before`、`menu-1440-*-before`）。
- **玻璃和药丸是手机壳的材质。** bar 是浮在 canvas 上带圆角、模糊、两段阴影的玻璃条；编辑器是 `rounded-[1.75rem]` 的药丸，多行草稿时两端半圆；菜单、面板、↓/⌂ 全靠模糊和阴影分层。浅色下 rail 与 canvas 同色，只有一条 1px 边，读不出"这是侧边栏"（`conversation-1440-light-before`）。
- **rail 叠在 bar 下面，不是一列。** bar 横跨整个窗口，rail 从 bar 底开始、浮在第 1 列的 15rem 块上，阅读列仍按整个 pane 居中：rail 和转录之间 50px，右侧却空 330px；bar 的标题 `<chain> ▾` 开的列表就在旁边的 rail 里，同一份列表两个入口（`conversation-1440-light-before`）。
- **回复是气泡，不是文档。** 回复 `max-width: 88%`、`width: fit-content`，表格、代码块、`/status` 卡被挤在 44rem 的 88% 里（`steps-1440-light-before`）。
- **四个 chip 都是填色块。** topic tag 和过程 chip 同一材质，一行四个读成四个按钮（`conversation-390-light-before`）。
- **状态行三行高。** 标题 / 状态+短语 / 元数据各一行，rail 里到 4 行；Item view / Close 常显，占掉标题 72px。
- **暗色里回复不浮。** `--color-white` 22.5% 明度与 canvas 差一步，卡片靠边线勉强可辨（`panel-1024-dark-before`）。

## 方案

### 已定（不再讨论）

- **根字号两档**：`< 48rem` 18px，`≥ 48rem` 16px。转录正文定为 16px / 1.55，不随根。
- **阅读列 46rem**（`--read-w`），正文 16px 时一行 40–44 个汉字。
- **回复满列（桌面）**：助手回复 `width: 100%`，用户气泡 `max-width: 76%`；手机不变。
- **过程 chip 描边化**：透明底 + `currentColor 28%` 描边，hover / 打开时 10% 填色；topic tag 保持填色，是一行里唯一的归属标签。
- **平面材质**（§材质）：`--workbench-chrome` 浅色 93.8% / 暗色 20.5%，不再调。
- **⌘B**（§侧边栏开关）：`< 80rem` 的 ⋯ 菜单保留 `Sidebar` 条目，点它开浮动列表。
- **侧边栏是网格的第一列**，分 **Chains** / **Items · N** 两段（与 32 同向）。
- **状态行一行到底**：标题下一行是 状态标记 · 短语 · 元数据；fine pointer 下 Item view / Close 随 hover / focus 浮出。

### 壳：两列并排

`≥ 80rem`、chain 模式、侧边栏未被 ⌘B 藏起时，`main` 是 `[侧边栏 16rem][内容列]` 两列；其余情况（⌘B 藏起、`< 80rem`、session 模式）是单列，bar 整宽，内容列居中——`sidebar-hidden-1440-light-after` 维持 v2 的样子。

- **侧边栏整高**：`#chain-rail` 占 `grid-row: 1 / -1`，从视口顶到底，`--workbench-chrome` 面、右侧一条 `--line`。bar 不再横跨它：`main:has(#chain-rail[data-on]) > :not(#chain-rail) { grid-column: 2 }`，bar、转录、队列卡、编辑器、↓/⌂ 和 Console 视图都在内容列里（`conversation-1440-light-after`）。改 06 §Layout "One column… centred in the pane under the full-width bar" 和 §Bar "one … strip at every width"：bar 是内容列的条，不是窗口的条。
- **侧边栏头**：`#rail-title`（`<h1>`），高 `--head-h`（3rem，与 bar 同高同底线，两条发丝线在侧边栏的右边线上接平），`padding-inline: 1rem`，15px / 600 / `neutral-800`——与 bar 标题同字号，两列的头是对等的。内容是实例名，**没有控件**：主题开关留在 Settings 的头（06 §Settings 已定，它是每浏览器的偏好，不是导航）；New chain… 留在 Chains 段末尾（它是列表的动作，紧挨列表）。头里只有名字，侧边栏的整个上缘读成"这是 g1 这台 Pier 的工作台"。
- **实例名的来源**：`$PIER_TITLE`——manifest 的 `name`、tab 标题的前缀已经是它；`server.ts` 的 `withInstanceName` 在发 shell 时把它写进 `#rail-title`，未设时是 `Pier`。Settings → Instance 没有"名字"这一项（只有 public URL、accent、reload），任务里"Settings → Instance"按 `$PIER_TITLE` 理解；要不要把它搬进 Settings 见待拍板 1。
- **侧边栏内部**：头下面 `#rail-body` 是唯一的滚动区（`flex: 1; overflow-y: auto`），Chains 段、Items 段同 v2；段头 `Chains` / `Items · 5` 12px / 600 / `neutral-600`，Items 段上方一条 `--line`。
- **bar 标题的两种形态**：侧边栏在屏上时（`sidebarDocked()`：`#chain-rail[data-on]` 且 `≥ 80rem`），标题是 chain 名的**平文字**——无 ▾、不可点、`disabled`、无 `aria-haspopup`、无 tooltip（列表就在旁边，第二个入口是噪音）；侧边栏藏起或 `< 80rem` 时是 `<chain> ▾`，点开浮动列表，与今天一样（`chains-1440-light-after`：⌘B 藏起侧边栏后点标题）。`‹`、lead 行、`1/N`、context chip、⋯ 不变。
- **形态的切换点**：⌘B 之后 `chains.ts` 调 `deps.docked()`（main.ts 传 `renderHeader`）；窗口跨过 80rem 时 `matchMedia("(width >= 80rem)")` 的 `change` 同样重绘列表和标题。session 模式、item view、子 session 的标题不受影响（`chain` 为空或 `item` 有值时 `plain` 恒为 false）。
- **键盘**：↑↓ 走行、⌘⇧[ ]、⌘⇧O、⌘⇧P、⌘B 都不变。标题是平文字时 Tab 顺序里少一个停靠点（它 `disabled`），列表本身在侧边栏里可达。
- **Settings**：替换内容列，**侧边栏留着**（`settings-1440-light-after`）。`#settings-view` 是 `main > section`，跟着 `grid-column: 2`，它的 `.pagehead` 与侧边栏头同高同底线；删掉 v2 的 `#bar.hidden ~ #chain-rail { display: none }`。Settings 开着时点侧边栏的 chain 行或事项行走原路（`go` → `openChain` → `select` → `showChat`）：Settings 关掉、回到对话。改 06 §Settings, Files and System prompt 一句："Settings is an overlay that replaces the content column and keeps the sidebar"。
- **Files / System prompt / 灯箱**：`<dialog>` 模态，`::backdrop` 30% 黑盖住侧边栏在内的一切，与今天一样；✕ / Esc 回到打开前的样子。
- **手机与 `< 80rem`**：没有侧边栏，bar 是顶条，一切不变（`conversation-390-*-after`、`panel-390-*-after`）。

### 材质：平面工作台

一套材质，浅色和暗色各一组 token，手机同材质。

- **三个 token**：`--workbench-chrome`（chrome 面，canvas 退一步：浅色 `oklch(93.8% 0.006 250)`、暗色 `oklch(20.5% 0.004 260)`）、`--line`（发丝线：浅色 `rgb(16 24 40 / 0.1)`、暗色 `rgb(255 255 255 / 0.1)`）、`--shadow-pop`（唯一保留的阴影，只给弹出层：浅色 `0 4px 14px -2px rgb(16 24 40 / 0.14)`）。删除 `--glass-edge`、`--glass-shadow`、`--glass-shadow-raised`、`--glass-surface` 和 `.glass` 的 `backdrop-filter`。
- **bar**：`--workbench-chrome` 的平条，底部一条 `--line`，无圆角无阴影；高度 `3rem`（`--head-h`，转录顶部的渐隐从它起）；宽度是它所在的列（§壳）。Console 的 `.pagehead` 同一条。
- **侧边栏**：整高列，`--workbench-chrome` 面、右侧一条 `--line`；头与段头见 §壳。行的状态见 §行词汇。
- **编辑器**：`neutral-200` 1px 边框、白底、10px 圆角的盒子，停在阅读列脚；焦点态只有 3px `indigo-100` 环，无阴影。
- **↓ / ⌂**：白底、`--line` 边、无阴影的小圆（coarse pointer 44px），hover `neutral-100`。
- **菜单 / popover / 状态面板**：实色面（`--color-white`）、`--line` 边、`--shadow-pop`；圆角 10px，行 6px。`.glass-menu` 改名 `.popover`。`dialog::backdrop` 是 30% 黑，无模糊。
- **圆角 6–10px**：`.btn` / 回复卡 / 菜单 / 编辑器 10px，`.icon-btn` / 菜单行 / 状态面板行 / rail 小行 6px，chip 维持 `rounded-md`。用户气泡 1rem、`indigo-200` 边，去掉气泡尾巴。
- **回复卡**：`inset 0 0 0 1px --line`，无外阴影；暗色 `--color-white` 提到 24.5% 明度，让卡在近黑 canvas 上不靠阴影浮起。
- **回退**：`prefers-reduced-transparency` 块删除（不再有透明层）；`prefers-contrast: more` 下 `.popover, #bar, #queue-panel, .pagehead, #chain-rail, #composer > div` 的边线提到 `neutral-900` 实色。
- **不动**：indigo 色阶与 `data-accent` 重排、topic 色（`topicHue`）、状态标记五色、焦点环（`outline: 2px indigo-500, offset 3px`）、44px coarse 目标。

### 行词汇

面板行、rail 行、chain 行三处一套：

- `:root { --row-hover: neutral-100 }`，rail 内覆写为 chrome 面再混 7% `neutral-900`（rail 面本身是 neutral-100 一档，hover 要再退一步才可见）。
- hover / `:focus-within`：`--row-hover` 底；`aria-current`：`indigo-100` 底，标题 / chain 名 `indigo-700`。截图 `conversation-1440-light-after`：当前 chain 一行 indigo，第三条事项 hover 着——Item view / Close 浮在行右端，垫 `--row-hover`。
- rail 的 Items 段 **CSS 收掉元数据行**（`#rail-items .open-item-meta { display: none }`）：16rem 内标题 + 状态短语两行够读。行的 tooltip 维持现状：标题截断时的完整 problem、短语截断时的完整 stage。面板行照旧显示元数据。

### 侧边栏开关（⌘B）

- `chains.ts` 导出 `SIDEBAR_KEY = "b"`，`chord(SIDEBAR_KEY, toggleSidebar, modalOpen)`：模态打开时让出（与 ⌘⇧O 相同）。
- `≥ 80rem` 且 chain 模式：翻 `localStorage` 的 `pier.rail`（`"off"` / 不存在，默认显示）并重绘；`renderChains()` 只在 `pier.rail !== "off"` 时给 `#chain-rail` 置 `data-on`，rail 隐藏则 `main:has(#chain-rail[data-on])` 不匹配，网格回到单列，bar 整宽，阅读列居中，标题变回 `<chain> ▾`。
- `< 80rem`：同一个 chord 打开标题 ▾ 的浮动 chain 列表（`openChains()`）；再按一次，菜单原语的 Esc / 外点关闭它。
- session 模式：no-op；⋯ 的 `Sidebar` 条目 hint `in chain mode` 并 disabled。
- ⋯ 菜单在 `Chain mode` 之后加 `Sidebar`，hint 为 `chordLabel(SIDEBAR_KEY)`（Mac `⌘B`、其他 `Ctrl+B`），每个宽度都列。
- rail 隐藏时 ⌘⇧[ ]、⌘⇧O、↑↓ 不变：它们的表面是浮动列表（⌘⇧O 开"rail 的字段——当它在屏上时"，隐藏时开浮动列表的）。
- 测试：`chains.test.ts` 加 ⌘B 三态（隐藏并记住、恢复并清除、< 80rem 开浮动列表）与 `sidebarDocked()` / `docked` 回调；`session-header.test.ts` 加 `Sidebar` 条目两态和"侧边栏停靠时标题是平文字"；`server.test.ts` 加 `withInstanceName` 的转义与空值。

### 替换 06-ui-ux.md 的措辞

§Materials 第二条替换为：

> - **Flat chrome + hairline**: navigation, the sidebar and floating controls are one solid surface, `--workbench-chrome`, one step off the canvas, edged by a neutral hairline (`--line`, light in dark mode) — no blur, no gradient, no shadow. Menus and popovers are solid, hairline-edged and carry the one shadow (`--shadow-pop`). Radii are 6–10px: 10px for cards, menus and the composer, 6px for rows and icon buttons.

§Layout 第一条 **One column** 替换为：

> - **Two columns, one reading column**: from 80rem in chain mode the shell is a 16rem sidebar beside a content column; the sidebar runs the window's full height on the chrome surface with a right hairline, headed by the instance's name (`$PIER_TITLE`, `Pier` when unset) in a row the bar's height, then Chains over Items · N; the content column is the bar, the transcript and the dock. Hidden by ⌘B, below 80rem or in session mode the content column is the window. In it the conversation is a 46rem reading column (`--read-w`, inset by `--col-pad`: transcript, queue card, composer share both edges) centred under the bar; a reply is the full column, a user bubble 76% of it at most; a phone's inset is 0.75rem.

§Bar 的首句 "one glass strip at every width; in chain mode the conversation's title is its chain's name with a ▾, opening the chain list" 替换为 "one flat strip with a bottom hairline, the content column's width; in chain mode the conversation's title is its chain's name — a plain heading while the sidebar is docked beside it, `<chain> ▾` opening the floated chain list otherwise"；§Floating buttons "icon-only glass circles" 替换为 "icon-only hairline circles"。

§Chain list "a 15rem rail docked left of the column on the canvas, under the bar's height and hidden with the bar" 替换为 "the sidebar's Chains section from 80rem in chain mode (**Two columns** above), hidden by ⌘B and remembered"；行态 "the current one a neutral surface and semibold" 替换为 "the current one an indigo-100 surface with indigo-700 text; hover and focus a neutral step; one vocabulary with the status panel's rows"。

§Settings, Files and System prompt 首句替换为 "Settings is an overlay that replaces the content column — the sidebar stays, and a row of it leaves Settings for the chain or item — and returns to its origin with ✕ or Esc; its head contains the version link and theme toggle."

03 §Bar and status panel 第一条的 "in chain mode it is `<chain name> ▾` (` · archived` on an archived chain), which opens the chain list" 替换为 "in chain mode it is the chain's name (` · archived` on an archived chain): a plain heading while the sidebar is docked (`sidebarDocked()` in `chains.ts`), `<chain name> ▾` opening the chain list (**Chains** below) while it is hidden or below 80rem"。

03 §Chains 第一条替换为 "One list, two surfaces: floated from the bar's title as a popover at 640px and above, a bottom sheet below (`menu.ts`), and docked from 80rem in chain mode as the Chains section of the 16rem sidebar — the shell's first column, the window's full height, headed by the instance's name the server patches into `#rail-title` (`$PIER_TITLE`, `Pier` when unset) — which Settings keeps beside it."，并加一条：

> - ⌘B toggles the sidebar: from 80rem in chain mode the docked rail is hidden or shown, remembered as `pier.rail` in localStorage (absent = shown), the column recentres and the bar's title changes shape (`docked` in `ChainsDeps`, which crossing 80rem calls too); below 80rem the chord opens the floated list. It defers to an open modal like ⌘⇧O; ⌘⇧[ ], ⌘⇧O and the arrows keep working through the floated list while the rail is hidden. The bar menu's `Sidebar` entry carries its label, disabled outside chain mode.

03 §Menus 的 bar menu 清单在 `Chain mode` 后加 `Sidebar`；03 §Backend 的 `GET /app` 行加 "and `$PIER_TITLE` into the sidebar's head"。

### 与 32 的关系

- 32 定 rail 15rem、"从 bar 底起"、段头"小字标题"、"元数据行在 15rem 内照显，浏览器里核对折行后再决定是否用 CSS 收掉"：本提案核过——16rem 下三行仍挤，**收掉**（§行词汇）；rail 改为整高、有头（§壳）。32 实施时按此落地，32 文本里的"15rem"、"under the bar"与"照显"与本提案不一致，合并时以本提案为准。
- 32 的 Close / 拒绝归属、`renderDrawer()` 填两个表面、↑↓ 按段走：本提案不碰，原型的 `#rail-items` 由 `renderDrawer` 填只为出图。
- 32 的"rail 显隐由 `chains.ts` / CSS 决定"：⌘B 和 `sidebarDocked()` 加进 `chains.ts`，仍是同一处。

## 对比截图

截图在评审时出过、看过，没有进仓库（76 张 11.5 MiB）。覆盖：对话（当前 chain + hover 的事项行）、转录顶部（步骤、表格、代码）、状态面板、chain 列表、⋯ 菜单、编辑器带草稿，各 1440×900 / 1024×768 / 390×844、浅色 / 暗色、before / after；另有 1440 的"⌘B 隐藏侧边栏"和"Settings（侧边栏留着）"只有 after。同一视口、同一种子、同一滚动位置。1440 停靠侧边栏；1024 浮动列表；390 手机 sheet。1440 的 chain 列表 after 是 ⌘B 藏起侧边栏后点标题 ▾（停靠时标题不可点）。

- 浏览器为 agent-browser 驱动的 Chromium（CDP），`matchMedia("(hover: hover)")` 与 `(pointer: fine)` 在该上下文里都为 false：before 图里 ⋯ 和行内动作常显是这个缘故。after 图在 1440 / 1024 注入了与 `style.css` 等价的 fine-pointer 规则（仅截图用，不在代码里），390 不注入。Safari / iOS 未验。

## 代价

- 行数（非空非注释）：`web/` 13731 → 13767，过 13.75k 的 ceiling；本分支按 Budgets 规则 5 提到 13.8k，句子是 ⌘B、它的 ⋯ 条目和侧边栏的头（AGENTS.md 的表已改）。相对 v2 +4：`style.css` +14（侧边栏头、`#rail-body`，减去 bar 跨列和 `#bar.hidden ~` 的三条）、`chains.ts` +9（`sidebarDocked`、`docked` 回调、80rem 的 `change`）、`session-header.ts` +3、`server.ts` +1（`withInstanceName`）、`index.html` +5、`main.ts` +1。与 32（估 +45）叠加约 13812——32 合并时再核 `just size`。
- `chat.ts` 825 / 830 不变。
- 待同步的文档：06 §Materials、§Layout（Two columns、Bar、Floating buttons、Chain list、Status rows、Settings）、§Conversation（转录字号、回复宽度、chip 材质）；03 §Backend（`GET /app`）、§Bar（标题两形态）、§Chains（侧边栏、⌘B、`pier.rail`）、§Menus（`Sidebar`）。措辞见 §替换 06-ui-ux.md 的措辞。
- 风险：
  - 根字号分档影响**所有** `≥ 48rem` 页面——Settings、Files、Agent、模型选择器同缩 11%，原型核了聊天面、Settings 的 `.pagehead` 与侧边栏并排（`settings-1440-light-after`）；其余 Console 页需各看一眼。
  - Settings 留着侧边栏：Settings 的内容列在 1440 下是 1184px，卡片列 46rem 照旧居中；1280（80rem 的下限）下是 1024px，仍宽于 1024 单列。侧边栏行在 Settings 里可点、可键盘到达，走的是对话的路由，不是 Settings 的——Settings 没保存的表单会被离开（和今天点浏览器后退一样）。
  - `--workbench-chrome` 浅色 93.8% 与 canvas `#f1f4f3`（约 96%）差 2 步，是"读得出侧边栏"的最小差；暗色 20.5% 与 canvas `#14171a`（约 18%）同理。
  - 去模糊后 bar 下的转录靠 `--head-h` 起的渐隐遮罩过渡；滚动时卡片上沿会从 bar 底的发丝线下穿出，这是平面材质的常态，不是缺陷。
  - 标题平文字时 `#chat-title` 是 `disabled` 的 `<button>`，读屏器读到的是一个禁用按钮而不是标题；落地时可改成按形态换元素（`<h1>` / `<button>`），原型没做。
  - ⌘B 在 Firefox / Linux Chrome 是 Ctrl+B；Chrome 默认不占用，Firefox 的 Ctrl+B 是书签栏——`chord` 在 capture 阶段 `preventDefault`，与 ⌘I 同一处理，未在 Firefox 实测。
  - `pier.rail` 只在 ≥ 80rem 生效；用户在宽屏藏起 rail 后缩窗再放大，rail 保持隐藏——符合"记住"的预期，但没有可见提示它被藏了，⋯ 菜单的 `Sidebar` 条目是唯一入口（见待拍板 2）。
- 测试：`npm run check`、`npm run lint`、`npm test` 全绿；新增 ⌘B 三态、`sidebarDocked` 与 `docked` 回调、`Sidebar` 条目两态、停靠时的平标题、`withInstanceName`。

## 决定（原待拍板，均按建议采纳）

1. **实例名的来源**：原型读 `$PIER_TITLE`（manifest、tab 标题已用它）。要不要在 Settings → Instance 加一个"名字"字段存进 settings 表、让 manifest 和 tab 也改读它？建议**先不加**——一个名字一个来源，环境变量已经是 deploy.md 的约定；要改是另一个提案。
2. **侧边栏头的控件**：原型只有名字。可选加一个 `«`（⌘B 的可见入口，藏起后 bar 左端出现 `»`），代价是一对图标按钮和一条 `.hidden` 状态（约 +12 行）。建议**不加**——⌘B 在 ⋯ 菜单里有教学条目，头保持为一行名字。
3. **停靠时标题的元素**：维持 `disabled` 的 `<button>`（原型），还是按形态换成 `<h1>`？建议**换 `<h1>`**，落地时做（`renderHeader` 里一次 `replaceWith`，约 +6 行），读屏器才读到"标题"。
