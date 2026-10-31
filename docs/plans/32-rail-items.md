# 32 — 侧边栏放事项

Worktree `pier.sidebar-items`，分支 `sidebar-items`。`native/` 不动。**已定稿**，与 [33 — UI 改版](33-ui-restyle.md) 一起实施：33 定壳（两列、扁平材质、⌘B）与行的样式，本文定 Items 段的数据、顺序、Close 与渲染；两者冲突处以 33 为准（16rem、整高带头行、rail 内收掉元数据行）。原型已在本分支（`28a8dfb`），实施从它起步。

## 现状

- **侧边栏**是 chain 列表（`web/ui/chains.ts`）：≥ 80rem 且 chain 模式下停靠为 15rem 左栏 `#chain-rail`；收窄时是标题 ▾ 的 popover，手机上是 sheet。行 = dot、chain 名、`N waiting`、⋯（Rename / Archive），底部 New chain… 与 Archived 折叠。它不列事项。
- **状态面板**（`web/ui/drawer.ts`）是 bar 右侧 lead 行打开的 popover / sheet：所有 chain 的开放事项 + 无事项的活跃 session + unlisted run，一张平铺列表（waiting on you 在前，当前 chain 其次，其他 chain 带 chip），每行 Item view / Close，顶部搜索。
- 两者的数据都已在 `main.ts`：`GET /api/chains`（`chains-changed`）和 `GET /api/continuous/open`（`open-items-changed`）。

## 设计：rail 分两段，Chains 与 Items

一份列表两个表面：状态面板的行同时填进 rail 的第二段，和 `chains.ts` 对 popover / rail 的做法一样。

### 布局

- 停靠的 sidebar（≥ 80rem，chain 模式；壳见 33 §壳）在头行下分两段：**Chains**（现状不变，在上）和 **Items**（在下）。段头 `Chains` / `Items · N`（N = 面板行数，即 lead 的计数），样式按 33；Items 段空时一行灰字 `Nothing open`。
- 两段共一个滚动区（头行固定），`#chain-rail` 的 id 不改，`aria-label` 改为 `Chains and items`，两段各是一个 `<section>`，`aria-labelledby` 指向段头。
- 标题 ▾ 弹出的 chain 列表和手机 sheet 仍只列 chain：它是切换器；< 80rem 看事项的表面是状态面板（底部 sheet），lead 行 / ⌘⇧P 一点即开。≥ 80rem 面板照旧可开——bar 在每个宽度都一样，面板是同一份行，开着不算重复书记。
- session 模式下 rail 不显示（现状），事项只在面板。

### Items 段的行

- 就是 `drawer.ts` `listed()` 的行：顺序（waiting on you 在前，当前 chain 其次，其他 chain 的在后）、其他 chain 的 chip、归档 chain 行的 **Open in its chain**、`aria-current`、点击导航（`deps.openItem`），一字不改。
- 每行同样带 Item view 与 Close：fine pointer 下 hover / focus 才显示（沿用 `.chain-more` 的 opacity 规则，面板里保持常显），coarse pointer 常显 44px。
- 元数据行（`run 状态 · 时间`）在 rail 里用 CSS 收掉（`#rail-items .open-item-meta { display: none }`，33 核过 16rem 下三行仍挤）；tooltip 不变。面板行照旧显示。
- 搜索框只在面板；rail 不放。

### Close

- `closeItem` 一份：乐观移除、`closing` 集合、`open-items-changed` 对账不变。两个表面共享 `closing`，在哪个表面点 Close，另一个表面的同一行也立即消失。
- 拒绝（409）在**发起的表面**说：面板发起的照旧（红字置顶、必要时重开面板）；rail 发起的红字落在 rail Items 段顶部，不弹开面板。`closeItem` 多一个"发起的根"参数来决定焦点落到哪个根的下一行、红字写进哪个根。

### 渲染

- 一个 DOM 节点只能有一个父节点，`rowNodes`（按 key 复用行节点，让 mousedown 与 mouseup 之间的重绘不吞点击）按表面各一份：`listed()` 返回 presentation 序列，行节点由每个表面自己的 map 经 `openItemRow(p, actions, existing)` 复用。
- `renderDrawer()` 现有的 render-key 短路同时覆盖两个表面；`fill()` 按根参数化（焦点与 scrollTop 的保持已在）。`closeError` 和搜索的 `found` 是面板专属，rail 的 `fill` 不读它们。
- 触发点不加：`sessions-changed`、`task-run-changed`、`open-items-changed` 和事项持有的 session 状态变化已经调 `renderDrawer()`。sidebar 显隐（`data-on`、⌘B 的 `pier.rail`、80rem）由 `chains.ts` 决定（33 §壳）；隐藏时 `fill` 仍写，无害。

### 键盘

- rail 的 ↑↓ 现走 `[data-list]`（chains 的 `ul`）；改为走**焦点所在段**的 `[data-list]`，Items 段的 `ul` 也标 `data-list`。段之间用 Tab。⌘⇧[ ] / ⌘⇧O / ⌘⇧P 不变。

### 文档与预算

- `docs/design/03-web-workbench.md`：§Chains 改为 §Sidebar（两段、段头、Close 的表面归属、键盘走段，加 33 的 ⌘B 与纯标题条款）；§Bar and status panel 里"状态面板是 web 展示进展的唯一地方"改为"跨宽度的唯一地方；≥ 80rem 的 sidebar 就地列出同一份行"。`06-ui-ux.md` 按 33 的替换措辞改，§Layout 加一句：sidebar 在 ≥ 80rem 承载事项，窄屏由状态面板承担。
- 估计 `web/` +40 行在原型之上（drawer.ts 第二个根、按表面的 `rowNodes`、`closeItem` 的根参数约 30；原型的 `#rail-items` 临时填充替换掉）。`web/` 原型后 13767 / 13800，**会过线**：按 AGENTS 规则 5 同一提交提 ceiling，并写上这一句。
- 测试：`drawer.test.ts` 加 rail 段与面板同序、rail 发起的 Close 两表面同时移除、拒绝落在 rail 不开面板、`rowNodes` 按表面复用（同一 key 两个节点）；`chains.test.ts` 加 ↑↓ 按段走。浏览器核对 ≥ 80rem 的 hover 显隐、16rem 内的折行与焦点走行（Chromium；Safari / iOS 未验，≥ 80rem 与手机无交集）。

## 决定

1. Items 段列**全部**开放事项（面板的全部行，含 session 与 unlisted run）——用户定。
2. 不按 chain 归组、不折叠；方案（每条 chain 行下嵌套事项、其他 chain 折叠）已弃——用户定。
3. rail 行带 Close，与面板共享一份 `closeItem`。
4. 标题 ▾ 弹出列表 / 手机 sheet 保持只有 chain。
