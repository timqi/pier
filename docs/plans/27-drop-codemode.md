# 移除 codemode，升级 Pi 到 1.3.0

状态：用户已定稿（run 3mqzc2xs4jeg2ae2）。lead 工作树 `drop-codemode`，分支 `drop-codemode`，两个 worker 顺序合入。

依据：单工具包装占 55%，收益无证据（runs jqx0hh79sk88hv0q、k6nmxj9dfm6xm39g）。

## 1. 移除 codemode（worker A，分支 `drop-codemode-a`）

删尽，不留开关：

- `agent/pi.ts`：`createCodemodeExtension` import、`codemodeWithThreshold`、`pierBaseline`/`pierSystemPrompt`/`resourceLoader`/`create` 的 `codemode` 参数与 `defaultTools: ["+codemode"]`、`pier()` getter 的 `workerCodemode` 字段、`readSystemPrompt` 的三候选（只剩 worker 与无 role 两种 baseline）。
- `agent/roles.ts`：`CODEMODE_THRESHOLD` 删；`toolCalls` 不再带参数，只剩 reading rule 一条（worker 与 lead 都听）。
- `agent/events.ts`：`nestedCalls` 字段与 replay（只为 codemode 服务）删；`events.test.ts` 对应用例删。
- `settings.ts` `workerCodemode()` 与 `main.ts` 的传入删；`settings.test.ts` 用例删。
- `tasks/`：`TaskRun.codemode`、`StatsRow.codemodeRuns`/`codemodeRunIds`、`tasks/agent.ts` 的标记、`store.ts` 的 SQL 列删；`toolCalls`/`uncounted` 保留；`service.test.ts` 相应改。
- 文档：`docs/deploy.md:151` 条目删；`docs/design/09-tasks-cli.md` stats 段去掉 codemode 句；`AGENTS.md` Budgets 表中 `agent/` 与 `agent/pi.ts` 的 codemode 附加句删（ceiling 数字按 `just size` 实际回落）。CHANGELOG 不改历史条目。
- `@earendil-works/pi-codemode` 不是直接依赖（pi-coding-agent 的传递依赖），package.json 无需改。
- 旧 worker 会话 transcript 里的 `codemode` 调用仍作为一个普通 tool step 显示；旧会话 `settings` 里的 `workerCodemode` 行留着无害，不再读。

Prompt：删 codemode 三条后 `# Tool calls` 只剩 reading rule；不做其他改写。

## 2. 升级 Pi 1.0.4 → 1.3.0（worker B，分支 `drop-codemode-b`，基于 A 合入后）

`npm install @earendil-works/pi-coding-agent@1.3.0`，lock 整体更新（pi-agent-core/pi-ai/pi-tui/pi-mcp 随之）。回归点（run 744t592jgxv14f3p 的结论）：

- 1.2.0 起 `sendCustomMessage(triggerTurn)` 触发 `before_agent_start`、`messageType` 联合类型、启动期 busy/排队语义 → 验证 Pier 的自定义消息发送、追加（appended input）、steer、follow-up 队列的测试与类型。
- 1.3.0 恢复会话时保留已启用工具 → 恢复 worker 会话时工具集合符合 Pier 设置；旧会话曾启用 `codemode` 时恢复不报错（tool 不存在时 Pi 的行为需确认，必要时测试覆盖）。
- 模型切换时 transcript/事件映射（`agent/events.ts`、`agent/transcript`）。
- `npm run check && npm run lint && npm test` 全绿；lock diff 审一遍新增传递依赖。

## 3. 收尾

集成后 review goal 一轮，done milestone 指向其 `Goal:`。合入 main 与 worktree 删除归用户。
