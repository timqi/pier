# 39 — 语音输入：按住说话与展开的 composer

状态：修订中（branch `voice-composer-panel`）——独立字幕卡取消，composer 自己展开为面板；模式、手势、按下即录已在
`voice-input-ux` 落地并在 iPhone 上验证，不变。只改 `src/web/ui/`（浏览器）；服务端路由、wire、provider
不变（[38](38-voice-input.md) 的传输与 provider 两节仍然有效）；不碰 `native/`。
取代 38 的「按钮与状态」、06 §Mic，改写 03 的 Voice input / Voice text in the draft 两条。

界面文案是英文（与工作台一致），下文引号里的就是要上屏的字。

## 问题

- 录音时 composer 一行里是 `+`、×、麦克风、发送四个 44px 按钮，iPhone 上草稿框只剩约
  125px 的文字宽度（7 个汉字一行），结束后三个按钮也只有 10 个字一行。
- 草稿框最高 192px；文字超过后新字落在折叠线以下，框不跟着滚。
- 实时文字是这一刻唯一要看的东西，却在全屏最小的一块里。

## 方案一句话

composer 多一个模式切换键；语音模式下输入行变成一条 `Hold to talk`；草稿只有一份，就是 composer
里的草稿框：说话期间（以及语音模式下草稿非空时）composer 卡片向上展开成面板，草稿框整宽、字大一档、
新字自动跟到底，多次 take 依次累积在里面；说完直接在面板里改字，用面板上的 `+` 和发送键。没有第二处显示。

## Composer 的两种模式

切换键在发送键左侧（现在麦克风的位置），`#attach` 的尺寸与材质；只有 `GET /api/voice`
为 `available` 且浏览器能采集时才渲染（与现在同一个条件）。没有它，composer 与今天完全一样。

| | 键盘模式（默认） | 语音模式 |
| --- | --- | --- |
| 切换键 | `Mic`，title `Voice input` | `Keyboard`，title `Keyboard`，`aria-pressed="true"` |
| 输入行 | `+` · 草稿框 · 切换键 · 发送/停止 | `+` · `Hold to talk` 条 · 切换键 · 发送/停止 |
| 草稿框 | 行内，与今天相同 | 草稿为空且没有 take 时不显示（composer 就是一条输入行）；否则在输入行**上方**占 composer 卡片整宽，见「展开面板」 |

- 切到语音模式：草稿框失焦，手机键盘收起。切回键盘模式：草稿框获得焦点，键盘弹起。
- 语音模式下点草稿框（要改字）：草稿框获得焦点、键盘弹起、光标落在点的位置，**仍在语音模式**——面板不变形，
  `Hold to talk` 条还在下面，改完可以接着说。take 期间点草稿框无效（只读）。
- 模式按浏览器记住（`localStorage`），与侧栏开合同一个做法；语音不可用时忽略这个记忆。
- `Hold to talk` 条：占草稿框原来的弹性位，高度同其它控件（粗指针 44px），hairline、
  `neutral-50` 底、`Mic` 图标加文字居中；是一个 `<button>`。
- 图片条、引用条、`/` 补全、队列卡、发送/停止、Esc 停止 turn：两种模式下都不变。
- 取消键（×）在面板头部，只在 take 期间出现。

```
键盘模式                         语音模式（草稿为空）            语音模式（已有草稿）
┌──────────────────────────┐    ┌──────────────────────────┐    ┌──────────────────────────┐
│ +  Message…      🎤  ↑  │    │ + [ 🎤 Hold to talk ] ⌨ ↑│    │ 那我能自己通过图形界面使用 │
└──────────────────────────┘    └──────────────────────────┘    │ 这个 Chrome 做一些操作吗？ │
                                                                │ + [ 🎤 Hold to talk ] ⌨ ↑│
                                                                └──────────────────────────┘
```

## 一次 take 的手势

在 `Hold to talk` 条上（触摸、笔、鼠标主键，同一套 pointer 事件）：

| 动作 | 结果 |
| --- | --- |
| 按下 | take 开始，面板展开（草稿框失焦，键盘收起） |
| 按住 ≥ 300 ms 后松手 | 结束：文字留在草稿，面板头部收起，草稿留在面板里 |
| 按住时手指上滑，高出条顶 64px | 进入「待取消」，面板描边变红并写 `Release to cancel`；滑回来解除 |
| 在「待取消」里松手 | 取消：只删这次 take 写进草稿的字，之前的草稿不动 |
| 轻点（300 ms 内松手且位移 < 10px） | 免提：不用按着，一直听；条变成 `Square` + `Tap to finish` |
| 免提中再点条 | 结束（文字保留） |
| 面板头部的 ×，或 Esc | 取消（同上，只删这次 take 的字） |
| 系统打断按住（`pointercancel`：权限弹窗、来电） | 转成免提，不丢已说的话 |
| 键盘 Enter / Space 在条上 | 同轻点；免提中再按一次结束 |

- 免提是长口述（上限 5 分钟）、鼠标和键盘的路径，也是今天「点一下开始、再点一下结束」的延续。
- 发送键在 take 期间可用：结束 take，等 `done` 把最后一句定稿后发出草稿；期间被取消或出错则不发、草稿留着。
- take 期间切换键禁用；`+` 不变。
- 永不自动发送：松手只把字放进草稿。

## 展开面板

面板不是新元素：就是 composer 卡片（`#composer` 里那张圆角卡），在语音模式下多出头部和整宽的草稿框。
没有浮层、没有背板，transcript 不被盖住，只是被面板顶上去。

- **何时展开**：语音模式下，take 进行中（`starting` / `recording`），或草稿非空。
  **何时收起**：草稿空了（发送、清空）且没有 take，或切回键盘模式——回到一条输入行。
- **草稿框**：整宽；20px / 1.5，所有宽度相同（键盘模式仍是手机 18px / 桌面 16px）。高度随内容，
  最多 8 行（240px）在框内滚动；take 进行中最少 3 行，免得第一句话出来时面板跳。高度上限由 CSS 的
  `max-height` 说了算，`autosize()` 读它，不再写死 192。
- **内容**：整个草稿——之前打的字、之前每次 take 的字、这次 take 的字，同一种颜色（textarea 不能给
  partial 单独上色；正在识别的半句靠头部的 `Listening` 与它自己在变来表示）。草稿为空且 take 进行中时
  placeholder 是 `Speak now`，其它时候仍是 `Message…`。
- **自动滚动**：每次写入后把这次 take 的末尾滚进视野；如果写入前用户已经把 take 的末尾滑出视野
  （差距超过一行）就不跟，滑回去恢复。不做滚动动画（06 Motion：流式更新不动画）。
- **头部**（13px，仅 take 进行中，在草稿框上方）：静态圆点 + 状态字 + 计时 `m:ss`，右侧 44px 的 ×
  （title `Cancel voice input`，提示 Esc）。状态字：`Starting…`（麦克风未就绪）→ `Listening`
  （麦克风开始采集）→ `Release to cancel`（待取消）。最后 30 秒计时变琥珀色并写剩余时间（`0:30 left`）。
- **提示行**（12px，仅按住时，草稿框与输入行之间）：`Release to finish · slide up to cancel`。免提时没有。
- **待取消**：composer 卡片的 hairline 变 `red-300`，状态字红，提示行换成 `Slide back to keep talking`
  ——颜色之外有文字。草稿文字不变灰：被删的只是这次 take，不是整份草稿。
- **输入行**：`+` · 条 · 切换键 · 发送/停止，始终在面板底部；take 期间 `+` 与发送可用，切换键禁用。
  图片条、引用条仍在面板顶部原来的位置。
- **编辑**：没有 take 时草稿框就是普通的草稿框，点一下就改。take 期间只读、不持有焦点。
- **进出**：面板的高度变化不做动画。没有波形、音量条、脉冲（06 Motion：运行期间无无限动画）。
- **结束时**：松手头部即收（不等 `done`）；`Hold to talk` 条写 `Finishing…` 并禁用到 `done`
  为止（通常不到 1 秒），最后一句在草稿框里就地定稿。
- **无障碍**：头部的状态字 `role="status"`；× 是 `<button>`，take 结束时焦点若在 × 上则回到条上。
  免提时焦点在条上。读屏不朗读流式写入（textarea 本来就不是 live region）。

```
按住说话（手机）                      说完，改字，发送
┌────────────────────────────────┐   ┌────────────────────────────────┐
│ Main ▾ │ ✓ 1          14k  ⋯ │   │ Main ▾ │ ✓ 1          14k  ⋯ │
├────────────────────────────────┤   ├────────────────────────────────┤
│ (transcript，被面板顶上去)     │   │ (transcript)                   │
│                                │   │                                │
┌────────────────────────────────┐   │                                │
│ ● Listening  0:07            × │   ┌────────────────────────────────┐
│ 第一段录音说的话留在这里。     │   │ 第一段录音说的话留在这里。     │
│ 第二段接在后面，新字自动跟到   │   │ 第二段接在后面，新字自动跟到   │
│ 底，比如说登录之类的           │   │ 底，比如说登录之类的。         │
│ Release to finish · slide up   │   │ + [ 🎤 Hold to talk ]  ⌨  ↑  │
│ to cancel                      │   └────────────────────────────────┘
│ + [ 🎤 Hold to talk ]  ⌨  ↑  │
└────────────────────────────────┘
```

## 草稿与现有规则

不变：take 的字实时写进草稿的 span（`spanText` / `spanError` / `spanCancel` / `caretAfter`），
每次写入存草稿；插入点是 take 开始时的光标，多次 take 依次接在后面；`error`、麦克风被拒
保留定稿句、删 partial、在 transcript 里发 `voice input: <reason>`；切会话、`pagehide` 取消；
Console 盖住聊天、非用户发起的 head 轮换就地结束并保留文字。以上任何一种结束都收起面板的头部。

改变：

- **take 期间草稿只读**：焦点不在草稿框里（按下时失焦）。于是「用户在 take 期间编辑草稿」
  的规则（`spanEdited`、IME 合成期间暂存的写入 `heldWrites`）没有入口了，连同测试一起删除。
- **`recording` 从麦克风接上 worklet 起算**，不再等上游 `ready`（`ready` 之前的音频服务端
  本来就缓冲）：按住就能说，不用等握手。上游连不上时仍以 `error` 收场。

## 不做

- 独立的字幕卡 / 背板 / 点背板结束：草稿只有一处，结束免提点条或发送。
- partial 灰色：textarea 里做不到，不为它叠一层。
- 松手即发送（微信的默认）：识别会错，发给 agent 的话要先看一眼。
- 语音消息、波形 / 音量条、震动反馈、「滑到某个按钮转文字」的第三个落点。
- 桌面壳（Tauri）：不渲染切换键的条件不变，不改 `native/`。
- 手机上把键盘模式的草稿框也改成整宽：不在这次的范围里。

## 实现要点

- `voice.ts`（无 DOM）：`recording` 的时机；麦克风流拿到后 `context.resume()`——触摸的
  `pointerdown` 不算用户激活，`AudioContext` 会以 suspended 出生，而 WebKit 在文档正在采集时
  放行（`AudioContext.cpp` `shouldDocumentAllowWebAudioToAutoPlay`）；`pointerup` 时再
  `resume()` 一次作为兜底。手势判定（按住 / 轻点 / 待取消 / 被打断）是一个纯函数，与 span 规则
  放在一起，单测覆盖。删 `spanEdited`。
- `src/web/ui/voice-input.ts`：语音模式、条的 pointer 事件、面板头部——从 `composer.ts`
  的「voice input」一节搬出并扩充。理由（Budgets 规则 2）：composer 是草稿与发送，这是语音模式
  的呈现，两个存在的理由；`composer.ts` 现为 635 行，不因此越过 800。
- 条的 CSS：`touch-action: none; user-select: none; -webkit-touch-callout: none`，
  `contextmenu` 取消默认（长按不出系统菜单、不选字）；按下即 `setPointerCapture`。
- 面板的布局只用 CSS：`#composer[data-voice]` 下草稿框 `order: -1; flex-basis: 100%`、20px / 1.5、
  `max-height` 8 行；`:placeholder-shown` 且没有 take 时隐藏；take 进行中由 `#composer[data-take]`
  （`voice-input.ts` 的 `paint()` 写）显示头部、提示行、3 行的 `min-height`；待取消是 `data-cancel`。
- 本次修订删除：`#voice-layer` / `#voice-card` / `#voice-text` 及其 CSS（`--pane-h`、`--head-h`、
  `--voice-top`）、`paintCaption()`、背板点击、「点草稿框＝切回键盘模式」的 focus 监听；头部
  （`#voice-dot` / `#voice-status` / `#voice-clock` / `#voice-cancel`）与 `#voice-hint` 搬进 composer 卡片。
  `composer.ts` 的 `autosize()` 改读 computed `max-height`。
- `icons.ts` 加 `Keyboard`。
- 预算：`web/` 现为 15312 / 15.35k；本次修订删的比加的多，不应越线；AGENTS.md 预算行里的
  「caption card」改成面板的说法。
- 落地时更新：03（Voice input、Voice text in the draft）、06（Composer and transcript、
  Mic → Voice mode、面板草稿的 20px 字号）、CHANGELOG、AGENTS.md 的预算行（若越线）。

## 验证

- `PIER_VOICE=mock` 起临时实例；Chromium 手机模拟 + 桌面宽度各走一遍：按住、轻点免提、
  上滑取消、Esc、连续多次 take 累积在同一份草稿、take 之间点草稿改字再接着说、长文本自动滚动与上滑停滚、
  发送键在 take 期间、发送后面板收起、`+` 加图、切会话、暗色。
- 真机 iPhone Safari（Chromium 模拟不算）：按住时不出选字 / 系统菜单；首次按住的权限弹窗后
  转成免提；`pointerdown` 起的 `AudioContext` 能出声音帧；主屏幕 PWA 同样。
- `npm run check && npm run lint && npm test`。

## 风险

- iOS 上由 `pointerdown` 启动采集未实测；若 `resume()` 仍不放行，退路是切换键的那次点击
  （真正的用户激活）里预先创建并保留 `AudioContext`，离开语音模式时关闭。
  探针：`https://corkboard-private.pages.dev/voice-hold-probe/`（board `voice-hold-probe`；测试 A＝按下即录，
  B＝退路）。结果（iPhone，iOS 18.7 Safari，2026-11-13）：A 通过——`AudioContext` 以 suspended 出生，18 ms 后 running，
  按住期间 1460 帧有声；B 也通过。走正文，不做退路。主屏幕 PWA 未测。
- 首次按住会弹麦克风权限，手势必然被打断；设计上转成免提，实际以真机为准。
- 轻点＝免提与微信不同（微信提示「说话时间太短」）；条的 `title` 与面板的提示行负责教会用户。
- 本次修订只在 Chromium 模拟里验证；面板把 composer 顶高后 iPhone 上的键盘收起 / 弹起与安全区未实测。

## 用户已确认

1. 松手后文字进草稿、不自动发送。
2. 轻点＝免提，保留「点一下开始、再点一下结束」。
3. take 期间草稿只读，删掉边说边改的逻辑。
4. 语音模式按浏览器记住。
5. 不加音量条 / 波形。
6. （修订）不要独立字幕卡：composer 自己展开为面板，面板就是唯一的草稿——多段录音累积、新字自动跟到底、
   可直接编辑，发送和 `+` 在面板上，收起后回到普通输入条。
