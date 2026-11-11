# Web 工作台实时语音输入

状态：已实现（branch `voice-input`）；真实 DashScope、Safari/iOS、Tauri 壳未实测。不碰 `native/`、`core/`、`agent/`。

落地时要更新的 owner 文档：03（行为与 wire）、06（麦克风按钮与录音态）、
`architecture.md`（`web/` 新文件的一句话）、CHANGELOG、`AGENTS.md` 的 `web/` 预算行。

## 已定

- 识别：阿里云千问 `qwen3-asr-flash-realtime`，DashScope WebSocket 北京区，由 Pier
  服务端中转；浏览器不直连，key 不出服务端。
- 识别层是可替换的 provider 接口；首版两个实现：`qwen`、`mock`。豆包以后加一个文件。
- key：vault 名 `DASHSCOPE_API_KEY`（`vault.get`，与 `channels/config.ts` 同一读法）。
  没有 key（或 vault 锁着）→ `available:false`，麦克风按钮不渲染。
- 交互：点麦克风开始，再点结束；实时文字进草稿，可编辑后再发；可取消。不自动发送。
- 参考 Avibe（`~/code/ref/avibe`，MIT，Copyright (c) 2026 The Vibe Remote Authors）。
  从 `ui/src/lib/voiceRealtime.ts`、`voiceRecording.ts` 复制实质代码的文件，在文件头
  保留该版权行与 MIT 许可声明（全文放 `src/web/ui/public/voice.LICENSE-avibe` 一份，
  随 bundle 发布在 `/app/voice.LICENSE-avibe`，文件头指向它）。
- 无新运行时依赖：服务端用 Node 24 的全局 `WebSocket`（`new WebSocket(url, { headers })`，
  已在本机验证构造可用）；浏览器用 AudioWorklet、`fetch`、`EventSource`。

## 传输：浏览器 ↔ Pier

Pier 没有 WebSocket 服务端，也不为此加 `ws`。用现有的 Hono 路由 + SSE，全部在
`requireAuth` 之后（cookie + 非 GET 的同源检查）：

| 路由 | 作用 |
| --- | --- |
| `GET /api/voice` | `{ available: boolean }`；provider 可用且 key 在 |
| `POST /api/voice` body `{ language?: string }` | 开一个 take，连上游，返回 `{ id }`（随机、不可猜）；无 provider → 503 `{ error }` |
| `GET /api/voice/:id/events` | SSE，这个 take 的事件；断开 = 取消 |
| `POST /api/voice/:id/audio` | body 为裸 PCM16LE、16 kHz、单声道；≤ 256 KB，超出 413；202 |
| `POST /api/voice/:id/finish` | 不再有音频；上游收尾后发 `done` |
| `DELETE /api/voice/:id` | 取消；关上游，丢弃 |

SSE 事件（`data:` 为 JSON）：

- `{ type: "ready" }` 上游已就绪（之前到的音频服务端先缓冲，上限 128 帧，溢出即 `error`）
- `{ type: "partial", text }` 当前句的未定稿文字，整句替换（千问的 `text + stash`）
- `{ type: "final", text }` 一句定稿，追加
- `{ type: "error", message }` 之后流结束
- `{ type: "done" }` `finish` 后上游收尾完成，流结束

音频 POST 由浏览器串行发（上一个返回再发下一个，期间攒的帧并成一个 body），所以无需序号。

服务端约束：每个浏览器 session（`sessionIdOf`）同时只有一个 take，新开即关旧的；
单 take 最长 5 分钟；15 s 没有音频也没有 `finish` → 关闭并发 `error`；`:id` 不属于
这个浏览器 session → 404。音频与识别文字不进日志、不落盘；日志只有 take 的开/关、时长、
错误种类。所有失败都以 `error` 事件或非 2xx 到达浏览器（原则 5），没有静默 `catch`。

## Provider 接口（`src/web/voice.ts`）

```ts
export type AsrEvent =
  | { type: "ready" } | { type: "partial"; text: string } | { type: "final"; text: string }
  | { type: "error"; message: string } | { type: "done" };
export interface AsrStream { audio(pcm: Uint8Array): void; finish(): void; close(): void }
export interface AsrProvider {
  /** false = 按钮不显示；同步、便宜（读一次 vault）。 */
  available(): boolean;
  open(opts: { language?: string }, emit: (e: AsrEvent) => void): AsrStream;
}
```

- `src/web/voice.ts`：路由、take 表、上面的约束、接口、`mockAsr`。
- `src/web/voice-qwen.ts`：千问适配器，唯一知道 DashScope 协议的文件。
- `createServer` 的 `WebDeps` 加 `voice?: AsrProvider`；`main.ts` 接线：
  `PIER_VOICE=mock` → `mockAsr`，否则 `qwenAsr(() => vault.get("DASHSCOPE_API_KEY"))`
  （vault 锁着时 `get` 会抛，按不可用处理并记一行 warn）。
- `mockAsr`：每收到一段音频就按字节数推进一段固定脚本文字，发 `partial`，凑满一句发
  `final`；`finish` 后发剩余 `final` 与 `done`。确定性，无定时器，测试与无 key 手测都用它。

### 千问协议（适配器内部；实现前用 `pier web fetch` 对一遍官方文档）

- `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`，
  头 `Authorization: Bearer <key>`、`OpenAI-Beta: realtime=v1`。
- 连上后 `session.update`：`input_audio_format: "pcm"`、`sample_rate: 16000`、
  `input_audio_transcription: { language? }`、`turn_detection: { type: "server_vad", silence_duration_ms: 400 }`。
- 音频：`input_audio_buffer.append`，`audio` 为 base64。
- 上行事件：`session.updated` → `ready`；
  `conversation.item.input_audio_transcription.text`（`text` + `stash`）→ `partial`；
  `…transcription.completed`（`transcript`）→ `final`；`error` → `error`；
  `finish()` 发 `session.finish`，收到 `session.finished` → `done`。
- 握手 8 s 超时、收尾 20 s 超时（Avibe 的两个数）。上游意外关闭 → `error`。
- 适配器测试用注入的假 `WebSocket` 构造器，不联网。真实 DashScope 未实测（没有 key）。

资料：`/home/qiqi/.pier/workspace/qwen-doubao-realtime-asr-comparison.md` 的来源 1–3。

## 浏览器

- `src/web/ui/voice-worklet.js`（或 vite 能产出独立 URL 的等价物）：AudioWorklet 处理器，
  把输入降混为单声道、重采样到 16 kHz、转 PCM16，每 250 ms `postMessage` 一帧。
- `src/web/ui/voice.ts`：一个 take 的生命周期——`getUserMedia`、AudioContext + worklet、
  `POST /api/voice`、`EventSource`、串行上传、`finish`/`cancel`、释放 track 与 context。
  对外只有 `startTake({ onEvent, onState })` 与返回的 `{ stop(), cancel() }`。不碰 DOM。
- `src/web/ui/composer.ts`：按钮、状态、把文字写进草稿。DOM 之外的写入逻辑是纯函数
  （放 `voice.ts` 或 `composer` 里已有的纯函数旁），单测覆盖。

### 草稿写入规则

take 开始时记下光标处，之后维护一个 span `[start, end)`：定稿文字 + 当前 partial。

- `partial`：替换 span 里定稿之后的尾巴。`final`：尾巴换成定稿文字，定稿长度前移。
- take 期间用户自己编辑：编辑完全在 span 之前/之后 → span 平移；碰到 span → span 里现有
  文字就此归用户，新 span 从当前光标处空着开始。
- 结束（`done`）：span 解除，文字留下，走现有 `saveDraft`/autosize/`updateComposer`。
- 取消（取消按钮或 Esc）：删掉当前 span 里的文字（已归用户的不动），停麦克风，`DELETE`。
- 切换会话、页面隐藏卸载：等同取消。点发送：等同结束后照常发送当前草稿，不等 `done`。
- composer 离开屏幕（打开 Settings）、会话头不是用户自己切的（轮换）：take 就地结束，已写入的
  文字连同当前 partial 留在原草稿，之后不再写入，`DELETE`。
- `error`：停麦克风，已写入的定稿留下，尾巴的 partial 删掉，错误显示在 composer 现有的
  提示位置。麦克风被拒/没有设备同样显示在那里。

### 按钮与状态（细节按 06 的材料与词汇）

- 麦克风按钮在发送按钮左侧，沿用 `#attach` 的尺寸与图标集；`GET /api/voice` 为
  `available:false` 或浏览器没有 `AudioWorklet`/`getUserMedia` → 不渲染。
- 状态：`idle` → `starting`（已点、等权限与 `ready`）→ `recording`（按钮变停止样式，
  旁边出现取消）→ `finishing`（已点停止、等 `done`）→ `idle`。
- `aria-pressed`、`title` 随状态；手机宽度触控目标与 `#attach` 一致。

## 预算

`web/` 现为 14018 / 14.05k。本功能必然越线：按 Budgets 规则 5 在同一改动里抬高
`web/` 的 ceiling 到实际需要的数（集成时由 `just size` 定），commit 写明这些行是
“浏览器采集 + 服务端中转 + 一个 provider 适配器”缺一不可的原因；表里的行只补
“voice input” 这个面。`ui/composer.ts`（709）不得越过 800；语音逻辑在 `voice.ts`。

## 拆分

两个 worker 并行，各自 worktree，以上 wire 契约为界：

1. `voice-server`：`web/voice.ts`、`web/voice-qwen.ts`、`server.ts`/`main.ts` 接线、
   测试（路由用 `mockAsr` 走通 开→音频→partial/final→finish→done、取消、越权 404、
   超限 413、无 provider 503；适配器用假 WebSocket）、`architecture.md`。
2. `voice-ui`：worklet、`ui/voice.ts`、`composer.ts`、`index.html`、测试（草稿写入纯函数、
   take 状态机用假 fetch/EventSource）、03/06 文档、CHANGELOG。

集成后：`AGENTS.md` 预算行、`PIER_VOICE=mock` 起一个临时实例在浏览器里走一遍、
`npm run check && npm run lint && npm test`、review goal。

## 未验证 / 风险

- 真实 DashScope 连接与识别质量：没有 key，未实测。
- Safari/iOS、Tauri 壳（WKWebView 的麦克风权限属 `native/`，本次不动）：未覆盖。
