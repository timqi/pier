# 34 — 侧边栏样式优化

**已定稿**（2026-10-31，待拍板三项按建议采纳：阈值 64rem、当前行 `indigo-50`、chrome 浅 `oklch(93.8% 0.005 175)` / 暗 `oklch(22.5% 0.006 248)`）。Worktree `pier.sidebar-polish`，分支 `sidebar-polish`。`native/` 不动。对 32/33 合并后的侧边栏：停靠阈值按"阅读列 + 侧边栏放得下"自动；chrome 配色跟对话同一色相；头行的发丝线去掉；侧边栏一条对齐网格；样式借 v0.1.x 侧边栏（`e005cfc`，2026-09-10 的 `#sidebar`；New 的 `+` 图标按钮取同日更早的 `6be70c3`）的结构和控件。33 已定的扁平材质（整高 chrome 面、发丝线、无浮动面板、无阴影）不动——借的是骨架，不是材质。

## 现状问题

对应 `before-*` 图（§截图）。

- **1280px 才停靠**（`DOCKED = "(width >= 80rem)"`，`style.css` 同值）。阅读列 46rem + 两侧各 1rem + 侧边栏 16rem = 64rem（1024px）就放得下，1024–1279 之间却仍是单列 + 浮动列表。
- **行的 ⋯ 在行内展开**成 `Rename  Archive` 两个文字按钮（`actionsOf`），行撑高、按钮无边界，与 bar ⋯ 和事项行的 popover 菜单不是一个词汇（用户截图）。
- **New chain… 是一条灰字行**，没有动作感，与列表行对不齐（`px-2` 对 `px-2.5` + dot 槽）。
- **行偏大偏松**：14px 字、`py-2`、闲置 chain 也占 8px dot 槽，`h-9` 的 ⋯；段头 `Chains` 12px/600 与行文字分不开层级；`Nothing open` 与段头同灰。
- **当前行 `indigo-100`** 在 teal accent 下是一大块薄荷色，两行事项行时尤其重。
- **chrome 与 canvas 不同色相**：`--workbench-chrome` 是 `oklch(93.8% 0.006 250)`（偏蓝），canvas `#f1f4f3` 是 `oklch(96.5% 0.003 174)`（偏绿），对话脚下的 mist / mint 也是绿青；侧边栏和 bar 读成另一套灰。
- **左上角三条线**：侧边栏头的底线、bar 的底线、侧边栏的右线在一点相接成 ⊥ + ⊢，头被框成一格（用户红框）。
- **左边不齐**：实测 `g1` x=16、段头 20、dot 18、chain 名 34、`New chain…` 16、`Nothing open` 20；⋯ 36px 盒子居右 211–247，段头无对应控件。事项行的 dot `margin-top .375rem` 不在首行中线。

v0.1.x 的侧边栏（`old-*.jpg`）：头行无底线；小写字母间距的段头，右端 `+` 图标按钮（`6be70c3`）；32px 圆角行、闲置行无 dot 槽；⋯ hover 浮出并打开 popover 菜单；当前行 `indigo-50` + indigo 字。

## 方案

### 停靠阈值：64rem

- `chains.ts` 的 `DOCKED` 和 `style.css` 的 `@media (width >= 80rem)` 改为 **64rem**，各带一句注释：`--read-w` 46rem + 两侧 `--col-pad` 最小 1rem + 侧边栏 16rem。媒体查询读不了自定义属性，所以是两处同一个数；改 `--read-w` 或侧边栏宽度时一起改。
- 64rem 恰好放下：1024 宽时内容列 768px，阅读列 736px 贴两侧 1rem（`after-1024.jpg`）。
- 其余不变：⌘B、`pier.rail`、`sidebarDocked()`、标题两形态、跨阈值的 `change` 重绘。`index.html`、`drawer.ts`、`chains.ts` 注释和 03/06 里的"80rem"全部改成 64rem。

### 配色：chrome 取 canvas 的色相

- `--workbench-chrome` 浅色 `oklch(93.8% 0.005 175)`（明度步长不变，色相从 250 改到 canvas 的 174），暗色 `oklch(22.5% 0.006 248)`（canvas `#14171a` 的色相 248，比它亮 2 步；今天的 20.5% 与 canvas 20.3% 几乎同色，侧边栏只剩一条线）。bar、`.pagehead`、侧边栏同用这一个 token，一起变（`after2-1440.jpg`、`after2-1440-dark.jpg`）。
- `--line`、`--row-hover` 的算法、indigo 色阶不动。

### 头行：去掉底线

- `.rail-title` 不再 `border-bottom`：侧边栏的线只有右边一条，bar 的底线在它上停下，左上角是一个 ⊢（`after2-topleft.png`）。头与 Chains 段头之间靠 3rem 头高和段头的 `margin-top` 分开，与 v0.1.x 一样。
- `--head-h`、与 bar 同高、15px/600 不变。

### 对齐网格

侧边栏 16rem，一条左边、一条右边，所有东西落在它们上（`mock2.js` 实测值，px）：

| 元素 | 左 | 右 |
| --- | --- | --- |
| `g1`（头）、段头文字、chain 的 dot、事项的 topic dot | 16 | — |
| chain 名、事项标题、事项的状态行、`Nothing open` | 32 | — |
| 行的 hover / current 底板 | 8 | 248 |
| 段头的 `+`、行的 ⋯（28px 盒） | 212 | 240 |

- `#rail-body` `padding: 0 .5rem .75rem`；行 `padding-inline: .5rem`；段头 `padding-inline: .5rem`；头 `padding-inline: 1rem`。dot 8px + `gap .5rem` 把文字推到 32。
- 垂直：行 `min-height: 2rem`、`align-items: center`，单行名居中；两行名（clamp）和事项行的 dot 对首行中线（首行 19px → `margin-top: .34375rem`）；段头 `min-height: 1.75rem`、flex 居中，`+` 在右端 `margin-left: auto`；⋯ 在行里 `align-self: center`，右侧 `.5rem`。
- 事项行的状态行与标题同起点（在同一文字列里，`margin-top: 1px`）；面板里的行用同一组值。

### 侧边栏骨架

从上到下：头 → Chains（段头右端 `+`）→ Items。

- **New chain 是段头的 `+`**：`.rail-head` 里一枚 `icon-btn`（Lucide `Plus` 14px，28px 盒，`aria-label` / `title` `New chain`），用户定：很少做，不配一枚大填色按钮。
  - 点击 / ⌘⇧O：Chains 列表顶部出现命名字段（今天的 `field()`，占一行，`padding-inline .5rem` 与行对齐），↵ 创建、Esc 收起，拒绝的红字在字段下——`creating` 状态照旧，停靠时画在列表头而不是列表尾（pending 行已经画在顶部，字段与它同位）。
  - 浮动列表（< 64rem 或 ⌘B 藏起）没有段头：`New chain…` 仍是列表尾的一行，改为与 chain 行同高、同内边距、前置 `+` 图标，字段也在那一行。一个 `create` 构造，两种落位由 `root === rail` 决定（`fill()` 已按它分支）。
- **段头** `.rail-head`：11px / 600 / `letter-spacing: .04em` / 大写 / `neutral-500`，`CHAINS`、`ITEMS · 1`。`#rail-items` 上方发丝线保留，`margin-top: .5rem; padding-top: .25rem`。`aria-labelledby` 指向段头里的文字 span，不含按钮。
- **Nothing open**：13px `neutral-400`，左 32。

### 行词汇（面板、rail、浮动列表三处一套）

- 行：`min-height: 2rem`，`padding: .3125rem .5rem`，`border-radius: .5rem`，`margin-block: 1px`，14px 字。chain 行与 `.open-item` 同一组值。
- **当前行 `indigo-50`**（`.chain-row:has([aria-current])`、`.open-item:has([aria-current])`），文字 `indigo-700` 不变；hover / focus-within 仍 `--row-hover`。菜单行的 hover 本来就是 `indigo-50`，三处一致。
- **chain 的 dot 槽保留在行首**（闲置时空 8px）：它让 chain 名和事项标题落在同一条 32px 线上——对齐比省一个槽重要；dot 本身仍是 sky / amber / 无。
- ⋯ 用 `.icon-btn` 自己的 28px，去掉 `h-9 w-9`；fine pointer 下 hover / focus 浮出、`aria-expanded` 时常显，coarse 下 44px 常显——规则不变。

### 行的 ⋯：popover 菜单

- `chains.ts` 删 `actionsOf` 和行内的 `Rename` / `Archive` 按钮；⋯ 的 click 调 `openMenu(more, [{label: "Rename…"}, {label: "Archive"}], c.name)`——与 bar ⋯、事项行同一个 `menu.ts` 原语：popover ≥ 640px，手机 sheet 带标题和 ✕，Esc / 外点关闭，焦点回 ⋯。
- `Rename…` → `renaming = {id, value}`，重绘，`focusField()`；`Archive` → `archive(c)`，409 的 `confirm()` 照旧。
- **浮动列表里**：`openPanel` 一次只开一个，⋯ 的菜单取代列表（`menu.ts` 的 `placed` 让它落在 ⋯ 原位）。`Rename…` 之后 `openChains()` 重开列表、字段在行里；`Archive` 被拒时 `notice` 无处可说，也 `openChains()` 让它出现在列表里——"没有事情可以看起来像没发生"。成功归档不重开：bar 标题已经换了。
- 停靠时流的重绘会换掉 ⋯ 节点：`row()` 复用 `aria-expanded="true"` 的那个 ⋯（v0.1.x `sessionRow(s, expanded)` 的做法），菜单的 trigger 不失联，Esc 还能把焦点还回去。
- 03 §Sidebar 的 "A row's ⋯ … offers Rename, an inline field, and Archive" 改为 "opens a menu (`menu.ts`) of Rename…, an inline field, and Archive"；06 §Chain list 加 "its ⋯ opens the row menu, a popover or sheet like the bar's"。

### 手机与 < 64rem

没有侧边栏，不受段头影响；bar 的新 chrome 色在每个宽度生效；浮动列表是 sheet，行的 ⋯ 打开 sheet 菜单时 chain sheet 先关（同上）。行高、当前行色、dot 位置三处同改，sheet 里也变。coarse 的 44px 目标不变。

### 不做

- 不恢复 v0.1.x 的浮动圆角侧边栏、阴影、图标头（33 已定扁平材质）。
- 不加搜索按钮、不加 Console 段（Settings 仍在 ⋯ 菜单）、不加填色主按钮（用户定）。
- 不动 `native/`。

## 截图

在仓库外：`~/code/dev/pier-shots/34-sidebar-polish/`（不入库）。

- `old-session-menu.jpg`、`old-new-session-recent-menu.jpg`、`old-new-session-menu.jpg`：`e005cfc` 构建在 `/tmp/pier-old`（`PIER_HOME=/tmp/pier-old-home`，端口 3998），1440×900——参考的原版。
- `before-1440-actions.jpg`（⋯ 行内展开）、`before-1024.jpg`（1024 单列）：本分支 `48f3fbb`，隔离实例 `PIER_HOME=/tmp/pier-new-home`、端口 3999、`PIER_TITLE=g1`，chain `Main / pier / security`。
- `after2-1440.jpg`、`after2-1440-menu.jpg`、`after2-1440-dark.jpg`、`after2-topleft.png`（左上角 2×）：同一页面注入 `mock2.js`（配色、去头线、对齐网格、段头 `+`、一条样例事项行、菜单 popover）得到的原型，不是代码；`after-1024.jpg` 是上一轮 `dock64.js`（64rem 停靠规则）的 1024 图，阈值部分仍有效，样式是上一轮的填色按钮版。
- 浏览器是 agent-browser 驱动的 Chromium（CDP），`(hover: hover)` / `(pointer: fine)` 为 false，after 图注入了等价的 fine-pointer 规则；字体是系统回退字体。Safari / iOS 未验。

## 代价

- 行数估算（非空非注释）：`chains.ts` −8（`actionsOf`、行内按钮、`openChains` 的清理）+7（`openMenu` 调用、浮动列表的重开、⋯ 复用、段头的 `+`）；`style.css` ±0（删 `h-9`、`.rail-title` 的 border、`.chain-row .chain-open`，改 token 两个值，加段头 flex、`Nothing open`）；`index.html` 0；`drawer.ts` +1（段头含 `+` 的结构两段共用，Items 段头无按钮）。约 ±0，不过 13.82k。
- 测试：`chains.test.ts` 的 `docked` 用的 `matchMedia` 桩不依赖数值；加 ⋯ 打开 `openMenu`（`menu` 已 mock）、`Rename…` 进字段、浮动列表里 `Rename…` 重开列表、段头 `+` 与列表尾两处 `New chain`；`session-header.test.ts` 注释里的 80rem 改 64rem。
- 风险：
  - 1024–1279 的窗口（iPad 横屏、小笔记本）从单列变两列；阅读列仍是 46rem，只是贴边。⌘B 可藏。
  - 浮动列表里 ⋯ 菜单取代列表，多一次重开；停靠时无此事。
  - `indigo-50` 当前行在暗色下是 `data-theme=dark` 的重排值，`after2-1440-dark.jpg` 核过可辨。
  - chrome 换色相影响每个 `.pagehead`（Settings、Files 头）和手机的 bar；是同一个 token，Console 各页落地时各看一眼。
  - 头行没了底线，Settings 的 `.pagehead` 仍有底线、与侧边栏头并排：那条线同样在侧边栏右线上停下，形态与 bar 一致。

## 已定

- New chain 是 Chains 段头右端的 `+` 图标按钮，不是填色按钮（用户，2026-10-31）。
- 行的 ⋯ 打开 popover 菜单，不在行内展开（用户）。

## 决定（原待拍板，均按建议采纳）

1. **停靠阈值**：64rem（建议），还是留 1rem 以上余量（如 68rem）？
2. **当前行色**：`indigo-50`（建议，v0.1.x 的值）还是维持 `indigo-100`？
3. **chrome 色值**：浅 `oklch(93.8% 0.005 175)` / 暗 `oklch(22.5% 0.006 248)`（建议，`after2-*`），还是更贴 canvas 一步（浅 95%）？
