# 29 — Web UI 宽屏布局、侧栏材质与重启打断的回合

状态：用户已定稿（run a82tx70p4xzdh5he）。起点是 cb38287 之后的截图：顶栏横跨全窗，
对话列 + 侧栏只占左 2/3，侧栏无底无边，重启打断的回合显示为红色 failed。

三件事，一次改完，手机不受影响（侧栏只在 ≥1098px 出现）。

## 1. 布局：对话 + 侧栏作为一个整体居中，侧栏的位置始终保留

- ≥68.625rem（1098px）时，`对话列（--read-w 44rem）+ 1rem 间隔 + 侧栏槽位`
  作为一个块 `margin-inline: auto` 居中；顶栏照旧横跨全窗，它是窗口的工具条，
  不是内容的一部分。
- 侧栏槽位宽 `clamp(14rem, 100% - --read-w - 3rem, 17.5rem)`，**无论有没有行都
  保留**：对话列的位置只随窗宽变，侧栏出现或消失都不动它。代价：没有 open
  item 时右侧空一个槽位（最多 17.5rem），对话列比正中略偏左；这是"不动"的
  价格，比每次侧栏出现平移一次便宜。
- 1098–1161px 之间槽位从 14rem 长到 17.5rem；再宽，块固定 63.5rem，两边留白
  相等。1440px 两边各约 150px，1920px 各约 390px。
- `#turns` 的 `padding-inline`、`#queue-panel` 和 `#composer > div` 的
  `margin-inline` 都按这个块算：左 = `(100% - 块宽) / 2`，右 = 左 + 间隔 + 槽位。
  现在 `style.css` 里的 `1rem` 左 pin 删掉，断点和 `drawer.ts` 的 `WIDE` 不变。
- 否决的两个方案：顶栏缩到块宽（顶栏停在 2/3 处，超宽屏更怪）；侧栏向右填满
  （一行 20 字的列表撑到 800px，空得更明显）。

## 2. 侧栏材质：一张实心阅读面，和对话列同一套材料

- 侧栏取 **assistant 气泡的材料**：`--color-white` 面、`neutral-200` 内描边
  （`inset 0 0 0 1px`）、同样的 `0 2px 8px` 轻阴影、`1.375rem` 圆角——它和
  气泡是同一层的东西（都是阅读面，不是导航），所以不是 glass。深色主题随
  `--color-white` 一起翻转，不加规则。
- 内边距 `0.75rem 1rem`，和气泡一致；计数头（`1 needs you`）贴卡片顶部，
  行列表在它下面，只有列表滚动（现状保留）。
- 顶边和第一条气泡顶边对齐：`margin-top = --head-h + 0.75rem + 0.875rem`
  （`#turns` 的上内边距加气泡的 `margin-block`）；底边上限不变
  （`min(60dvh, 视口 - 顶栏 - dock - 2rem)`）。
- 行的 hover / focus / 选中仍是 `neutral-100`，在白面上可见；行内边距
  `4px 6px` 不变。
- `docs/design/06-ui-ux.md` Layout 两条和 `03-web-workbench.md` §198
  里 "without enclosing background, border or shadow" 改为上面这句。

## 3. 重启打断的回合：灰色 `restarted`，不是红色 `failed`

现状：Pier 自己的 stop 中断一个正在跑工具的回合，Pi 记的 `stopReason` 是
`error`、`errorMessage` 是 `This operation was aborted`，`agent/events.ts`
`fromHistory` 把它当失败，网页画红色 `failed · 2 steps · 5s` 加一条红色
`This operation was aborted`。它不是失败，是 13 号文档的 stop：紧跟其后的
就是 `restart` 来源的 system input（`restarted · continuing` 芯片）。

- **翻译在 agent 这一层**：`fromHistory` 里，一个带 `error` 的 assistant 回合
  后面紧跟（中间无其它回合）一条 `origin.kind === "restart"` 的 system input，
  则这个回合的 `error` 不设，改设 `cut: "restart"`（`core/types.ts`
  `ChatTurn` 加一个可选字段，文档句：被 Pier 的 stop 截断、由后面的 restart
  input 续上的回合）。没有 restart 跟着的（没能恢复、只留了 ledger 通知）
  仍是 `error`，红色不变。
- **网页**：`cut === "restart"` 的回合，steps 芯片状态为 `restarted`，
  `text-neutral-500` + `RefreshCcw` 字形（和 cancelled / skipped 同一灰度），
  读作 `restarted · 2 steps · 5s`；没有红色 error 行。有未完成文本的保留文本；
  没有文本的，芯片行自己占一个 silent 材料的气泡（"An error or silent body
  carries the same row on its own material" 的现有规则）。
- 紧接的回合保留青色 `restarted · continuing`；两个芯片连起来读：这里被重启
  截断，这里续上。
- 用户自己按 Stop 的中断不变（Pi 记 `aborted`，无 error，steps 是琥珀色
  `interrupted`）。
- 实时路径不另做：进程重启时浏览器断线，重连后整段历史重放，走的就是
  `fromHistory`。
- 文档：`06-ui-ux.md` Conversation 段加一句；`13-stop-and-resume.md` §Turns
  加一句网页表现。

## 4. 不改的

- 断点 1098px、`--read-w` 44rem、侧栏 14–17.5rem、60dvh 上限、popover / sheet
  在更窄宽度的行为、键盘走行、状态芯片隐藏规则。
- 手机：同一条媒体查询之下什么都不变。
- 顶栏、composer、队列卡的材质；气泡、芯片、时间分隔的样式。

## 5. 文件

`src/web/ui/style.css`（§1 §2，一处媒体查询内）、`src/web/ui/drawer.ts`
（不动或仅注释）、`src/agent/events.ts` + `src/agent/events.test.ts`（§3 翻译）、
`src/core/types.ts`（`ChatTurn.cut`）、`src/web/ui/chat.ts` +
`src/web/ui/turn-activity.ts` + `chat.test.ts`（§3 渲染）、
`docs/design/06-ui-ux.md`、`docs/design/03-web-workbench.md`、
`docs/design/13-stop-and-resume.md`。

## 6. 验证

- 1098、1161、1440、1920px：块居中、对话列在侧栏出现 / 消失时不动、侧栏顶边
  与第一条气泡对齐、深浅主题各一次；1097px 退回 popover。
- 640–1097px 和手机宽度与现状逐像素一致。
- 一段含"工具中被重启"的历史：灰色 `restarted` 芯片、无红行、下一回合
  `restarted · continuing`；一段"重启后没能恢复"的历史仍是红色 failed。
- `npm run check && npm run lint && npm test`。
- 浏览器覆盖按实际报告（Chromium 不等于 Safari）。
