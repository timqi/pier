# Open items 卡片：实现状态

定稿契约：[/home/qiqi/code/dev/pier.open-items-card/docs/plans/24-open-items-card.md](/home/qiqi/code/dev/pier.open-items-card/docs/plans/24-open-items-card.md)。实现必须完整遵循该文档；本文件记录本实现分支的交接状态。

- 基线：main `69b53ad37d43dfba5e0a7bd4541065df8ef9e963`，实现分支 `build-open-items-card`，已快进，禁止合入 main、重启及移除工作树。
- 用户要求 astra 实现；代码简洁、复用现有逻辑，以关键端到端用户流程为主，避免细碎内部断言。
- 已确认的 seam 变更已由定稿授权：tasks 派生稳定 title 与 designSessionId；core browser-safe 展示 DTO；chat-command 可选快照；ChainDeps.status 分离 seed、显示文本、快照。

## 实施顺序

1. 顺序实现 worker（astra，在本工作树）：共享事实与展示、命令历史兼容、Web 共用行与轻量侧栏、导航竞态与错误边界、IM、必要文档和关键 E2E；完成检查并提交。
2. lead 检查实现与验收证据，处理遗漏；集成分支独立 goal 审查直到 clean。
3. 最终记录 Goal 行、检查结果、实际浏览器覆盖、提交 SHA 与保留工作树。

## 验收重点

- 稳定标题跨 Web/IM 一致，seed 保留 problem/stage/run；时间与 goal 文案正确且快照不随现在时间漂移。
- 未定稿设计入口独立于运行状态；定稿后下一次点击恢复普通 topic 路径。
- 后来的用户导航胜出；加载失败可见且禁止错误回退；行身份不按 session 合并，历史短 ID 歧义不猜测。
- sidebar 自然高度、无大块外壳、17.5rem；手机/浮层/卡片共用行、详情触摸与键盘可用，刷新保留焦点和展开。
- 更新设计文档 03/06/10/11；完整 check、lint、test；隔离浏览器验证注明 Chromium 与未覆盖 Safari/iOS。

## 当前状态

实现与独立 goal review 前两轮问题修复已完成，交 supervisor 继续 review；未合入 main、未重启生产，保留本工作树。

- tasks 从创建 run 派生稳定 title，并独立派生 designSessionId；core/open-items.ts 统一标题、状态、时间、goal 和 worker 文案，完整 seed 与紧凑 IM 文本分离。
- `/status` 保存并校验 version-1 展示快照；历史时间及目标固定，异常快照保留原文并显示降级原因，旧短 ID 只在唯一匹配时生成链接。
- Web 面板与命令卡共用行和独立 Details；main 统一导航意图、成功加载后的 topic/run/tail 回退及错误边界，刷新保留身份、控件、焦点、展开与滚动。
- 设计契约 03/06/10/11 已更新；两个新增模块分别承载跨表面的展示投影和跨容器的行交互，替代分散的拼接及行实现；净增长用于历史快照、完整详情和可取消导航边界。

## 实现 worker 的验证结果

- `npm run check`、`npm run lint`、`npm test`：通过，105 文件、1984 测试；覆盖实际设计生命周期及投影、续跑标题、完整 seed、序列化回放、goal 阶段、两 IM adapter 的长标题/转义/换行/repost，以及导航失败、取消和控件保留。
- `npm run build`、`just size`：通过，所有 area 和单模块均在现有预算内；测试/构建仍有既有的 extensionless vitest.setup 与 report.ts 动态导入提示。
- 浏览器：Linux Chrome 154.0.8037.92，通过 pinned agent-browser/CDP 访问隔离 PIER_HOME、SQLite、真实 HTTP/SSE 与构建 UI；AgentSession 为确定性 fixture，未连接生产。
- 375px、1000px popover、1280px sidebar：实际触摸 Details、44px coarse-pointer 目标、完整长标题/问题/授权、显式 session 链接、键盘方向键/Tab/Enter/Escape、窄宽断点焦点及展开保留；无横向溢出。
- 主体设计入口、定稿后的实时 topic 路径、历史卡固定目标、run/tail 回退、历史短 ID 唯一/歧义、异常快照、重新加载、SSE 刷新均已实测；新的点击、Settings 和浏览器 Back 阻止旧请求回退，404/503/网络失败保持可见。
- sidebar 0/1/3/20 项：零项隐藏，单项 149px、三项 324px 的自然高度；1280×400 时 20 项高度上限 214px、底部 289.5px，composer 顶部 312.5px，列表内部滚动且摘要固定；浅/深色、reduced motion 已检查。
- JPEG 已打开复核：`/tmp/open-items-mobile-touch.jpg`、`/tmp/open-items-mobile-card.jpg`、`/tmp/open-items-popover.jpg`、`/tmp/open-items-dark-final.jpg`、`/tmp/open-items-one.jpg`、`/tmp/open-items-short.jpg`；浏览器 error 列表为空。
- 未覆盖 Safari/iOS 真机、真实 IM 投递或真实模型执行；浏览器设计定稿使用 fixture 状态切换，真实 `Design final:` 生命周期由 TaskService 集成测试覆盖。临时 fixture 不进入提交。

## 独立验收补充

- 修复：head 轮换保留 Settings，后来的导航取消轮换后的历史分页；多 run 的 IM 概览保留完整名称与适用状态，活跃 goal 不误报 root 已完成；减少动画停用运行点闪动并保留静态描边；coarse-pointer 控件最小尺寸为 44×44px。
- 覆盖核对：对照 `69b53ad` 的测试差异，标题、seed、历史、设计生命周期及导航覆盖保留；主题点、独立会话当前态与入口断言补回现有合并测试，另加两个完整场景覆盖轮换取消和多 run 审查/失败/回放。
- 本轮检查：`npm run check && npm run lint && npm test`、`npm run build`、`just size` 通过；105 文件、1986 测试，所有 area 与模块在预算内。
- 本轮浏览器：同一 Linux Chrome 154，构建 UI 配合独立本地 HTTP/SSE fixture；API 数据与响应时序受控，未访问生产。实际 TaskService/SQLite 生命周期由现有集成测试覆盖。
- 导航实测：设计入口、定稿后的实时 topic 与历史卡固定目标；A→B、Settings、Back/Forward 离开再返回；404/503/连接中断无 run 回退，恢复后重试成功；head 轮换不退出 Settings。
- 交互实测：同 session 不同事项和同名 queued runs 保留原控件/展开，run 获得 session 不串行；方向键、Space、断点焦点归还；375px coarse-pointer 的真实触摸展开和主体导航，44×44px，无嵌套 button 或横向溢出。
- 布局实测：1000px popover、1280px sidebar，0/1/3/20 项；1280×400 的 20 项列表底部 289.5px、composer 顶部 312.5px，内部滚动及刷新位置保留；浅/深色和 reduced-motion 的计算样式已核验。
- JPEG 已打开复核：`/tmp/open-items-review-mobile-touch.jpg`、`/tmp/open-items-review-popover.jpg`、`/tmp/open-items-review-dark.jpg`、`/tmp/open-items-review-short.jpg`。网络错误仅为注入的失败；初期两条 Settings Models 异常来自 fixture 缺少 modelMenu，补齐 fixture 响应后复验未新增异常。
- 限制：Chromium 手机模拟不代表 Safari/iOS，未验证真实 IM/模型/生产服务；本轮 browser fixture 不运行完整后端，前轮完整 HTTP/SSE fixture 的覆盖见上节。净增长用于共享 IM run 概览、轮换导航边界和上述回归证据；不新增依赖。

## Goal review 第 1 轮修复

- 自动补入的设计按 `design:<sessionId>` 保持身份，marker 事项继续按 `item:<problem>`；共享投影把同一 key 传到实时列表与 `/status` 快照，同名设计及与 problem 重名的设计不会共用节点。
- 回归：SQLite 任务投影、同名设计续跑与重排、序列化快照回放；宽窄两种面板的三行计数、独立展开、焦点保留及主体/详情目标。
- 检查：check、lint、105 文件 / 1989 tests、build、size、差异空白检查通过；core/tasks 各净增一行类型声明以传递设计身份，测试与文档增长用于上述回归和身份契约。
- 浏览器：Chrome 154，实际任务投影函数配合隔离 HTTP/SSE fixture 和构建 UI；1280px sidebar、375px sheet 均保留三个同名入口，SSE 更新与重排保留原节点、焦点和展开，主体与详情进入各自会话，marker 返回主会话，历史卡保持原 run 与目标；无横向溢出。
- JPEG 已打开复核：`/tmp/open-items-identity-wide.jpg`、`/tmp/open-items-identity-mobile.jpg`；本轮请求均成功，console 为空，error 列表仅保留前轮已说明的两条 fixture Settings 异常；本轮未验证真机触摸、Safari/iOS、真实 IM 或模型执行。

## Goal review 第 2 轮修复

- 分页在旧会话与 head 的读取完成后分别核验导航、加载代次与当前 head；两次读取都通过校验才更新 earlier 并同步重绘，等待期间保留当前 pane 和事件流。
- 四个 deferred HTTP 回归在修复前均失败、修复后通过：两个请求边界各覆盖成功与 503；新 topic 先展示、旧响应不重绘，实时消息继续到达，取消后重新分页不漏旧会话。
- 检查：check、lint、105 文件 / 1993 tests、build、size、差异空白检查通过；Web 净增七行用于跨两个请求的取消边界与已读取快照的同步提交，测试和文档增长用于该竞态回归及契约。
- 浏览器：Chrome 154 构建 UI + 隔离 HTTP/SSE fixture，1280px 下分别暂停两个分页请求后点击同 head 的事项，旧响应不替换已定位的 topic；375px sheet 手动分页也被新事项导航取消；未覆盖真机触摸、Safari/iOS、真实 IM 或模型执行。
- 本轮网络失败仅为注入的两次 503；console 为空，error 列表无新增记录，仍保留前轮 fixture Settings 的两条历史异常。
