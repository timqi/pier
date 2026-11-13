# 39 — 语音输入：按住说话与字幕卡

状态：设计已定稿（2026-11-13）；未实现。只改 `src/web/ui/`（浏览器）；服务端路由、wire、provider
不变（[38](38-voice-input.md) 的传输与 provider 两节仍然有效）；不碰 `native/`。
取代 38 的「按钮与状态」、06 §Mic，改写 03 的 Voice input / Voice text in the draft 两条。

界面文案是英文（与工作台一致），下文引号里的就是要上屏的字。
示意图（手机宽度，非契约）：`~/.pier/workspace/voice-input-ux/voice-a.png`、`voice-b.png`。

## 问题

- 录音时 composer 一行里是 `+`、×、麦克风、发送四个 44px 按钮，iPhone 上草稿框只剩约
  125px 的文字宽度（7 个汉字一行），结束后三个按钮也只有 10 个字一行。
- 草稿框最高 192px；文字超过后新字落在折叠线以下，框不跟着滚。
- 实时文字是这一刻唯一要看的东西，却在全屏最小的一块里。

## 方案一句话

composer 多一个模式切换键；语音模式下输入行变成一条 `Hold to talk`；说话期间一张字幕卡浮在
transcript 区中间偏上，只显示这次说的字，字比正文大一档、自动跟到底；松手后文字留在草稿里，照旧由用户发送。

## Composer 的两种模式

切换键在发送键左侧（现在麦克风的位置），`#attach` 的尺寸与材质；只有 `GET /api/voice`
为 `available` 且浏览器能采集时才渲染（与现在同一个条件）。没有它，composer 与今天完全一样。

| | 键盘模式（默认） | 语音模式 |
| --- | --- | --- |
| 切换键 | `Mic`，title `Voice input` | `Keyboard`，title `Keyboard`，`aria-pressed="true"` |
| 输入行 | `+` · 草稿框 · 切换键 · 发送/停止 | `+` · `Hold to talk` 条 · 切换键 · 发送/停止 |
| 草稿框 | 行内，与今天相同 | 草稿为空时不显示；非空时在输入行**上方**占 composer 卡片整宽（手机上约 18 个汉字一行），最高仍 192px |

- 切到语音模式：草稿框失焦，手机键盘收起。切回键盘模式：草稿框获得焦点，键盘弹起。
- 语音模式下点草稿框（要改字）＝切回键盘模式，光标落在点的位置。
- 模式按浏览器记住（`localStorage`），与侧栏开合同一个做法；语音不可用时忽略这个记忆。
- `Hold to talk` 条：占草稿框原来的弹性位，高度同其它控件（粗指针 44px），hairline、
  `neutral-50` 底、`Mic` 图标加文字居中；是一个 `<button>`。
- 图片条、引用条、`/` 补全、队列卡、发送/停止、Esc 停止 turn：两种模式下都不变。
- 现在的 `#voice-cancel`（×）从输入行删除；取消在字幕卡里。

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
| 按下 | take 开始，字幕卡打开 |
| 按住 ≥ 300 ms 后松手 | 结束：文字留在草稿，字幕卡关闭 |
| 按住时手指上滑，高出条顶 64px | 进入「待取消」，字幕卡变红并写 `Release to cancel`；滑回来解除 |
| 在「待取消」里松手 | 取消：这次 take 写进草稿的字删掉 |
| 轻点（300 ms 内松手且位移 < 10px） | 免提：不用按着，一直听；条变成 `Square` + `Tap to finish` |
| 免提中再点条，或点字幕卡外的背板 | 结束（文字保留） |
| 字幕卡头部的 ×，或 Esc | 取消 |
| 系统打断按住（`pointercancel`：权限弹窗、来电） | 转成免提，不丢已说的话 |
| 键盘 Enter / Space 在条上 | 同轻点；免提中再按一次结束 |

- 免提是长口述（上限 5 分钟）、鼠标和键盘的路径，也是今天「点一下开始、再点一下结束」的延续。
- 发送键在 take 期间可用，规则不变：结束 take，草稿按当下的样子发出。
- take 期间切换键禁用；`+` 不变。
- 永不自动发送：松手只把字放进草稿。

## 字幕卡

- **位置**：浮在 transcript 区中间偏上——顶边固定在 transcript 区高度的 18% 处，随文字
  向下长，所以长的时候顶边不跳。手机上是阅读列宽度、`--col-pad` 内缩；≥ 48rem 宽度至多
  30rem，水平居中。其下一层背板（`bg-black/15`，与 sheet 同）盖住 transcript 与 bar；
  composer 不被盖住。
- **大小**：正文区最少 3 行、最多 8 行（手机上约 17 个汉字一行，满了约 130 字），超过
  8 行在卡内滚动。满的时候卡片约占 transcript 区的一半。
- **材质**：solid 卡片，hairline，10px 圆角，`--shadow-pop`（与菜单、弹层同一套）。
- **头部**（13px）：静态圆点 + 状态字 + 计时 `m:ss`，右侧 44px 的 ×（title `Cancel voice input`，
  提示 Esc）。状态字：`Starting…`（麦克风未就绪）→ `Listening`（麦克风开始采集）→
  `Release to cancel`（待取消）。最后 30 秒计时变琥珀色并写剩余时间（`0:30 left`）。
- **正文**：只显示这次 take 的字，直接取自草稿里的 span——定稿句正色，当前 partial
  `neutral-500`；20px / 1.5，所有宽度相同（transcript 正文 16px，手机草稿 18px）；还没字时
  是灰色的 `Speak now`。
- **自动滚动**：每次写入后，如果写入前就在底部（差距不超过一行）就跟到底；用户往上滑就停，
  滑回底部恢复。不做滚动动画（06 Motion：流式更新不动画）。
- **底部提示**（12px，仅按住时）：`Release to finish · slide up to cancel`。免提时没有底部。
- **待取消**：hairline 变 `red-300`，状态字红，正文降到 `neutral-400`，底部提示换成
  `Slide back to keep talking`——颜色之外有文字。
- **进出**：现有的 `surface-in`（160ms），减少动效时用 `surface-fade`。没有波形、音量条、
  脉冲：状态是文字、计时和正在出现的字（06 Motion：运行期间无无限动画）。
- **结束时**：松手即关（不等 `done`）；`Hold to talk` 条写 `Finishing…` 并禁用到 `done`
  为止（通常不到 1 秒），最后一句在草稿框里就地定稿。草稿框滚到这次 take 的末尾。
- **无障碍**：`role="dialog"`、`aria-label="Voice input"`；状态行 `role="status"`；正文
  `aria-live="off"`（读屏不能盖过用户自己的声音）。免提时焦点在条上，关闭后回到条上。

```
按住说话（手机）                      免提
┌────────────────────────────────┐   ┌────────────────────────────────┐
│ Main ▾ │ ✓ 1          14k  ⋯ │   │ Main ▾ │ ✓ 1          14k  ⋯ │
├────────────────────────────────┤   ├────────────────────────────────┤
│ (transcript，背板压暗)         │   │ (transcript，背板压暗)         │
│ ┌────────────────────────────┐ │   │ ┌────────────────────────────┐ │
│ │ ● Listening  0:07        × │ │   │ │ ● Listening  1:42        × │ │
│ │ 那我能自己通过图形界面使用 │ │   │ │ …前面的句子滚上去了，这里 │ │
│ │ 这个 Chrome 做一些操作吗？ │ │   │ │ 始终是最新的 8 行。定稿的  │ │
│ │ 比如说登录之类的           │ │   │ │ 句子正色，正在识别的半句是 │ │
│ │ Release to finish · slide  │ │   │ │ 灰色                       │ │
│ │ up to cancel               │ │   │ └────────────────────────────┘ │
│ └────────────────────────────┘ │   │                                │
│                                │   │                                │
│                                │   │                                │
┌────────────────────────────────┐   ┌────────────────────────────────┐
│ + [ 🎤 Hold to talk ]  ⌨  ↑  │   │ + [ ■ Tap to finish ]  ⌨  ↑  │
└────────────────────────────────┘   └────────────────────────────────┘
```

## 草稿与现有规则

不变：take 的字实时写进草稿的 span（`spanText` / `spanError` / `spanCancel` / `caretAfter`），
每次写入存草稿；插入点是 take 开始时的光标，多次 take 依次接在后面；`error`、麦克风被拒
保留定稿句、删 partial、在 transcript 里发 `voice input: <reason>`；切会话、`pagehide` 取消；
Console 盖住聊天、非用户发起的 head 轮换就地结束并保留文字。以上任何一种结束都关闭字幕卡。

改变：

- **take 期间草稿只读**：字幕卡是模态的，焦点不在草稿框里。于是「用户在 take 期间编辑草稿」
  的规则（`spanEdited`、IME 合成期间暂存的写入 `heldWrites`）没有入口了，连同测试一起删除。
- **`recording` 从麦克风接上 worklet 起算**，不再等上游 `ready`（`ready` 之前的音频服务端
  本来就缓冲）：按住就能说，不用等握手。上游连不上时仍以 `error` 收场。

## 不做

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
- 新文件 `src/web/ui/voice-input.ts`：语音模式、条的 pointer 事件、字幕卡——从 `composer.ts`
  的「voice input」一节搬出并扩充。理由（Budgets 规则 2）：composer 是草稿与发送，这是语音模式
  的呈现，两个存在的理由；`composer.ts` 现为 635 行，不因此越过 800。
- 条的 CSS：`touch-action: none; user-select: none; -webkit-touch-callout: none`，
  `contextmenu` 取消默认（长按不出系统菜单、不选字）；按下即 `setPointerCapture`。
- 语音模式的布局只用 CSS：`#composer[data-voice]` 下草稿框 `order: -1; flex-basis: 100%`，
  `:placeholder-shown` 时隐藏；输入行 `flex-wrap`。
- `icons.ts` 加 `Keyboard`。`index.html`：删 `#voice-cancel`，加条与字幕卡的骨架。
- 预算：`web/` 现为 14954 / 15k，这次会越线；按规则 5 在同一改动里抬高，commit 写明
  「模式、手势、字幕卡」各自不可少的原因。
- 落地时更新：03（Voice input、Voice text in the draft）、06（Composer and transcript、
  Mic → Voice mode、字幕卡的 20px 字号）、CHANGELOG、AGENTS.md 的预算行（若越线）。

## 验证

- `PIER_VOICE=mock` 起临时实例；Chromium 手机模拟 + 桌面宽度各走一遍：按住、轻点免提、
  上滑取消、Esc、背板点击、长文本自动滚动与上滑停滚、发送键在 take 期间、切会话、暗色、减少动效。
- 真机 iPhone Safari（Chromium 模拟不算）：按住时不出选字 / 系统菜单；首次按住的权限弹窗后
  转成免提；`pointerdown` 起的 `AudioContext` 能出声音帧；主屏幕 PWA 同样。
- `npm run check && npm run lint && npm test`。

## 风险

- iOS 上由 `pointerdown` 启动采集未实测；若 `resume()` 仍不放行，退路是切换键的那次点击
  （真正的用户激活）里预先创建并保留 `AudioContext`，离开语音模式时关闭。
- 首次按住会弹麦克风权限，手势必然被打断；设计上转成免提，实际以真机为准。
- 轻点＝免提与微信不同（微信提示「说话时间太短」）；条的 `title` 与字幕卡底部提示负责教会用户。

## 用户已确认

1. 松手后文字进草稿、不自动发送。
2. 轻点＝免提，保留「点一下开始、再点一下结束」。
3. take 期间草稿只读，删掉边说边改的逻辑。
4. 语音模式按浏览器记住。
5. 不加音量条 / 波形。
6. 字幕卡浮在中间偏上、3–8 行、20px，不占满 transcript 区。
