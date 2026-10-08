# Boards 拆成独立项目：git 仓库为真相，GitHub Actions 直传两个 Pages 项目，private 走 Cloudflare Access

状态：用户已定稿（2026-10-09）。lead 工作树 `boards-split-design`。只写设计，不写实现。

## 1. 目标与硬约束

目标：Pier 删掉全部 boards 代码（`src/boards/`、Console → Boards、`pier boards publish`、`/boards` `/b/` 路由、`pier-boards` skill），boards 变成一个独立项目，多个 Pier 实例共用，以 Pi package（skill + CLI）形式挂进每个实例。

硬约束，以及推荐方案如何满足：

| 约束 | 满足方式 |
| --- | --- |
| 托管在 Cloudflare Pages，`*.pages.dev` | 两个 Pages 项目：`<prefix>.pages.dev`（public）、`<prefix>-private.pages.dev`（private），无自定义域 |
| public / private 都由本项目管理 | 同一 git 仓库、同一部署流水线，可见性 = 目录（`public/<slug>` / `private/<slug>`） |
| private 需鉴权 | Cloudflare Access 保护 private 项目的生产域名和预览域名（Pages 自带开关 + 一次手工调整，见 §6） |
| 页面访问不占用 Worker 配额 | 纯静态资源，无 Pages Functions，无 Worker 路由；Access 不是 Worker；部署在 GitHub Actions 跑 |

已核对的 Cloudflare 事实（2026-10 文档）：Access 可以保护 `<project>.pages.dev` 生产域名（Known issues → "Enable Access on your pages.dev domain"）；Pages 限额 — 每次部署 20,000 文件、单文件 25 MiB、每账号 100 个项目、`_redirects` 2,000 条静态 + 100 条动态、`_headers` 100 条；"500 builds/月" 是 git 集成构建的限额，wrangler 直传不是 build。

## 2. 一句话方案

**一个私有 git 仓库是所有 board 的真相；每个实例各有一份 clone；agent 用文件操作改 board，用 `cork publish` 提交推送；GitHub Actions 收到 push 后把 `public/*/site` 和 `private/*/site` 分别直传到两个 Pages 项目；private 项目整体在 Cloudflare Access 后面；撤回 = `git mv` 或 `git rm` + 一次 push；实例上只需要 `git` 和一把 deploy key，Cloudflare 凭据只存在 GitHub Secrets 里。**

## 3. 项目名

| 名字 | CLI | 理由 | 顾虑 |
| --- | --- | --- | --- |
| **Corkboard**（已选） | `cork` | 软木板就是钉页面的地方，"Board" 这个词原样保留；`cork publish` / `cork list` 读得通；4 字母 | 与 Pier 的码头意象无关 |
| Placard | `placard` | 告示牌，public/private 都成立；少见，搜索不撞 | 7 字母，敲起来长 |
| Kiosk | `kiosk` | 街头的报亭/展示柜，"给路人看的页面" | 浏览器 "kiosk mode" 已占这个词 |

Pages 项目名（全局唯一，先到先得）：`corkboard` 和 `corkboard-private`，即 `https://corkboard.pages.dev` 和 `https://corkboard-private.pages.dev`；文中记作 `<pub>` 和 `<priv>`。实现第一步就是 `wrangler pages project create` 占下这两个名字，被占则由用户另起。

## 4. 数据端

### 4.1 存在哪里

| 方案 | 读 / 改已有 board | 多实例 | 历史与回滚 | 需要的凭据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A. git 仓库（GitHub 私有库）** | `git pull` 后就是本地文件，agent 用现有 read/edit/write | push 即合并；同一文件并发改才冲突，git 原生报告 | 全量，`git log`/`revert` 白送 | 每实例一把 deploy key | **推荐** |
| B. R2 bucket | 得先 `wrangler r2 object get` 到本地，改完 put 回去；无原子性 | 后写覆盖，无检测 | 无（或要开版本化并自己写列举） | 每实例一个 R2 token | 比 A 多一层同步代码，少历史，否 |
| C. Pages 直传（现状） | 本地目录就是真相 | 没有共享：每实例一个项目，或互相覆盖 | 无 | 每实例 wrangler + CF token | 不满足"多实例共享"，否 |
| D. 每实例自己的仓库 + 聚合器 | 同 A | 没有共享的 board，只有共享的站点 | 同 A | 同 A 再加聚合器凭据 | 多一个会动的部件，否 |

A 的代价：仓库会长（11 MB 的日报 `work/` 必须留在仓库外，见 §9.3）；离线时只能读旧副本。

### 4.2 仓库布局

```
<boards repo>/
  corkboard.json              # 两个项目的名字和地址，所有实例和流水线读同一份
  public/<slug>/              # 可见性就是目录：public/ 下的每个 site/ 上公开站
    board.json                # {title, description, owner}
    site/index.html           # 唯一会被部署的目录
    README.md, src/, bin/…    # 自带构建的 board 的源码，永不部署
  private/<slug>/             # 同上，上 Access 站
  assets/pier.css             # 共享样式表 → 两个站的 /_assets/pier.css
  .gitignore                  # */*/work/  node_modules/  .wrangler/
  .github/workflows/deploy.yml  # 十行：uses: <user>/corkboard/.github/workflows/deploy.yml@v1
```

`corkboard.json`：

```json
{ "public":  { "project": "corkboard",         "url": "https://corkboard.pages.dev" },
  "private": { "project": "corkboard-private", "url": "https://corkboard-private.pages.dev" } }
```

`board.json` 只剩不可推导的三项：`title`、`description`、`owner`（创建它的实例名，纯信息，不做权限）。现有的 `public`、`url`、`publishedAt`、`withdrawnAt`、`sessions` 全部删除：可见性是目录，URL 是 `<corkboard.json 的 url>/<slug>/`，发布时间是 `git log -1 -- <dir>/site`，撤回时间是 `git log --diff-filter=DR`。

Slug 规则不变：`[a-z0-9][a-z0-9-]{0,63}`。流水线对不合规的目录跳过并在 Actions 日志报一行；`cork` 在本地先拒。

### 4.3 agent 怎么读、怎么改

1. `cork path [<slug>]` → 先 `git pull --ff-only`（失败则警告并继续用本地副本），打印 clone 或该 board 的绝对路径。
2. 读、改、建：普通文件操作。新 board 用 `cork new <slug> --title … --description … [--public]` 建目录和 `board.json`（默认 private）。
3. `cork publish [-m <msg>] [--wait]`：`git add -A`、按 board 生成提交信息、`git pull --rebase`、`git push`。`--wait` 轮询到部署上线（§5.3）后按 board 打印 `live <url>`。

### 4.4 多实例归属与冲突

| 策略 | 效果 | 结论 |
| --- | --- | --- |
| **不划归属，`owner` 只做标记** | 任何实例可改任何 board（沿用现有产品决定 2）；`cork list --mine` 用 `owner` 过滤 | **推荐** |
| slug 加实例前缀 `g1-weekly` | URL 变丑，跨实例续写同一 board 还是要改别人的 | 否 |
| 每实例一个子目录 | 同一 slug 两份、两个 URL；"共享"名存实亡 | 否 |
| 流水线校验 `owner` 等于提交者 | 要维护实例身份与提交者映射；一改就是权限系统 | 否 |

冲突：两实例并发改**同一文件**时，后 push 的 `pull --rebase` 失败。`cork publish` 此时 `git rebase --abort`，保留本地提交，打印冲突文件和对方的 `owner`/时间，退出 1；agent 像处理任何 git 冲突一样解决后再 `cork publish`。同名 slug 同时新建落到 `board.json` 的冲突上，同理。

每个实例一把 GitHub deploy key（写权限），clone 时写进 `core.sshCommand`；`cork` 以 `<instance> <instance@corkboard>` 作为 author，`git log` 直接看得出是哪个实例改的。

## 5. 部署流水线

### 5.1 谁来执行

| 方案 | 凭据位置 | 串行化 | 配额 | 结论 |
| --- | --- | --- | --- | --- |
| **GitHub Actions + `wrangler pages deploy`（直传）** | CF token 只在 GitHub Secrets | `concurrency: deploy` 排队 | Actions 私库 2,000 分钟/月，每次约 1 分钟；直传不计 build | **推荐** |
| Pages 的 Git 集成（Cloudflare 自己拉仓库） | 无需 token | Cloudflare 排队 | 每次 push 两个项目各算一次 build，500/月；克隆深度不保证够 `git log --since` 算撤回 | 备选，零配置但受配额和历史限制 |
| 实例本地 wrangler（现状） | N 个实例 N 份 token + wrangler | 无；靠"只删更老的部署"兜底 | 不计 build | 多凭据多竞态，否 |

### 5.2 一次部署做什么

由 Corkboard 工具仓库里的 reusable workflow 完成，数据仓库只写 `uses:` 一行加 secrets：

1. `git diff --name-only <before> <after>` 判断 `public/`、`private/`、`assets/` 哪些变了，只部署受影响的项目（`assets/` 变则两个都部）。
2. 为每个项目装配快照：`<slug>/` ← `<vis>/<slug>/site/`（无 `site/index.html` 的目录跳过并报一行）；`_assets/pier.css`；`_headers`（`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: connect-src 'self'; frame-ancestors 'none'`）；`_meta.json`（提交 sha、时间、每个 slug 的 title 和最近修改时间）。
3. `_redirects`：对 7 天内从该目录消失的 slug（`git log --since=7.days --diff-filter=DR --name-only -- <vis>/`）写 `/<slug>/* / 302`。原因见 §6.3。
4. private 快照另加根 `index.html`：所有 board（两边的）一行一个，标题链到各自地址、描述、最近修改时间、`owner`。这就是 Console → Boards 的替代品，本身在 Access 后面。public 快照不设根页，`/` 是 Pages 的 404。
5. `wrangler pages deploy <snapshot> --project-name <project> --branch main`。项目不存在则先 `wrangler pages project create`。

### 5.3 实例怎么知道"上线了"

| 方案 | 结论 |
| --- | --- |
| **流水线写进快照的 `/_meta.json`，`cork` 拉取比对 sha** | 无额外存储、无回写、无循环；public 项目直接 fetch；private 项目需要 Access service token（可选配置，没有就只报 public 并说明） |
| 流水线回写仓库（`deployed.json`） | 每次部署再触发一次 push → 要加防循环逻辑，否 |
| `gh run watch` | 依赖实例上的 `gh` 登录；作为 `--wait` 超时后的提示保留 |

`cork publish --wait` 默认等 5 分钟；超时打印 `cork: pushed <sha>, not live yet — check Actions` 退出 1。

## 6. public / private 与撤回

### 6.1 为什么是两个项目

| 方案 | 结论 |
| --- | --- |
| **两个 Pages 项目，Access 罩住整个 private 域** | 边界是域名，配置错不了；public 项目没有任何 Access 规则要维护；两边各自的边缘缓存互不影响 |
| 一个项目，Access 按路径罩 `/p/*` | 一条路径规则写错就是泄露；public 与 private 共用一份 `_redirects`/`_headers` 配额 |
| 一个项目，private 用签名 URL（今天 `/b/` 的做法） | 没有服务端就没法签名；Pages 静态做不到 |

### 6.2 Access 配置（一次性，手工）

1. private 项目：Settings → **Enable access policy**（罩 `*.<priv>.pages.dev` 预览域）；按 Known issues 步骤把 Access 应用的 Subdomain 里的 `*` 删掉，再重新 Enable 一次，得到两个应用：`<priv>.pages.dev` 和 `*.<priv>.pages.dev`。
2. 策略：Allow，身份 = One-time PIN（邮箱验证码，零 IdP 配置；已选）；放行名单 = 用户的邮箱。会话时长设到最长（1 个月），手机上一个月登录一次。Zero Trust 免费 50 席。
3. public 项目：也打开 **Enable access policy**，但不改 Subdomain——只罩 `<hash>.<pub>.pages.dev` 这类预览/历史部署地址，生产域不受影响。效果：旧部署的 hash URL 不再公开可读，现有流程里"删除更老的部署"那一步整个不需要了。
4. 可选：一个 Access service token，给 `cork` 拉 private 的 `_meta.json`、给 agent 用 curl / headless Chrome 核对 private 页面；放 Pier vault，通过 `pier vault run` 注入。

### 6.3 撤回

| 动作 | 操作 | 上线后 |
| --- | --- | --- |
| public → private | `cork set <slug> private`（`git mv public/<slug> private/<slug>`）+ `cork publish` | public 站的 `_redirects` 把 `/<slug>/*` 302 到 `/`（404）7 天；private 站出现该 slug |
| private → public | `cork set <slug> public` + `cork publish` | 反向同上 |
| 删除 | `cork delete <slug>`（`git rm -r`）+ `cork publish` | 两站都 302 7 天；仓库历史里仍可恢复 |

7 天来自现有实现观察到的 Pages 边缘缓存行为：被新部署删掉的路径还可能从 `s-maxage=604800` 的缓存副本被服务；`_redirects` 先于缓存被查，所以用重定向顶住一周。这条规则靠 `git log` 算出来，不需要任何回写字段。不覆盖的情况与现状相同：一个仍在线 board 里删掉的单个文件、一周内重新发布的同名 slug。

说法沿用：撤回后告诉用户"已下线；别人已经拿到的副本可能还在别处缓存"，发布时说"拿到链接的人都能读"。

## 7. 管理端

| 方案 | 结论 |
| --- | --- |
| **纯 CLI + git + private 站的索引页** | 没有在线代码、没有服务端状态；列表 = `cork list`（本地 + `_meta.json`）或打开 `<priv>/`；审计 = `git log` | **已选** |
| GitHub PR 门禁：`CODEOWNERS` 让 `public/` 必须人审 | 分支保护是整个分支的，private 的小改也得开 PR；日报每天一个 PR | 不开（用户决定）；公开的闸门仍是 skill 的规则——只在用户明确要求时才 `--public` |
| Worker 管理 API | 多一份在线代码、一个 secret、一套实例↔Worker 的鉴权；只有当实例不能跑 git 时才值 | 否 |

## 8. skill 与 CLI 接口

### 8.1 安装

- Corkboard 工具仓库是一个 Pi package：`skills/corkboard/SKILL.md` + `skills/corkboard/bin/cork`（Node ≥ 22，零依赖：`child_process` 跑 git，`fetch` 拉 `_meta.json`）。每个 Pier 实例在 Console → Packages 加这个包（`git:` 来源或本地路径），Pier 不改一行代码。
- 实例配置 `~/.config/corkboard/config.json`：`{"repo": "git@github.com:<user>/<boards>.git", "instance": "pier-g1", "checkout": "~/.local/share/corkboard/boards"}`；`checkout` 可省，默认如示。`cork init` 写配置并 clone。
- `compatibility`（skill frontmatter）：`git`、`node`、配置文件存在；一条自检命令 `cork status`。

### 8.2 命令

| 命令 | 作用 | 输出 |
| --- | --- | --- |
| `cork path [<slug>]` | pull 后打印 clone 或 board 的绝对路径 | 一行路径 |
| `cork new <slug> --title <t> --description <d> [--public]` | 建目录和 `board.json`，默认 private | 路径 |
| `cork list [--json] [--mine]` | 每个 board：可见性、标题、`site/` 最近改动、状态、URL；public 在前 | 一行一个 |
| `cork set <slug> public\|private` | `git mv`，不提交 | 新 URL |
| `cork delete <slug>` | `git rm -r`，不提交 | — |
| `cork publish [-m <msg>] [--wait]` | 提交、rebase、push，可选等上线 | 每个变动 board 一行 `pushed <url>` / `live <url>` / `removed <slug>`；错误一行 `cork: …` 退出 1 |
| `cork status` | 配置、clone、远端可达、两站 `_meta.json` 的 sha 与本地 HEAD 的差 | 几行 |
| `cork serve [--port]` | 本地起静态服务，按部署布局（含 `/_assets/pier.css`）供 headless Chrome 核对 | URL |

状态词沿用现有：`live`、`changes unpublished`（本地或已 push 但 `_meta.json` 的 sha 落后）、`pending`（已 push 未上线）。不再有 `publish pending` / `unpublish pending` / `deleted · still live`：可见性与存在都是目录状态，一次 push 全部解决。

### 8.3 SKILL.md 内容

从现有 `skills/pier-boards/SKILL.md` 搬过来并改三处：

- 定位：开头不再引用 `<pier>/AGENTS.md` 的路径，改成"先 `cork path`"；一切路径来自 CLI 输出，skill 文件里不出现本机路径（遵守 `~/code/skills/AGENTS.md` 的 host-independent 规则）。
- 发布与可见性：`public: true` 改成 `--public` / `cork set`；`pier boards publish` 改成 `cork publish --wait`；不再有 `url`/`publishedAt` 字段的告诫。回答用户时仍然只给一个裸 URL（public 给 `<pub>/<slug>/`，private 给 `<priv>/<slug>/` 并说"需要登录"）。
- 样式表链接从 `/b/_assets/pier.css` 改为 `/_assets/pier.css`。

页面写法、布局、`.hero/.card/.table-scroll` 等 helper 的章节、核对清单原样保留；`pier.css` 文件随之搬到数据仓库 `assets/`（流水线部署它）而不是工具仓库，这样一个实例改样式其他实例立刻跟上。

## 9. Pier 侧删除与迁移

### 9.1 删除（代码）

| 位置 | 内容 |
| --- | --- |
| `src/boards/`（整个目录） | `boards.ts` 336、`publish.ts` 278、`pier.css` 510、两个测试 546 行 |
| `src/web/ui/boards.ts`（267 行） | Console → Boards 面板 |
| `src/web/ui/settings.ts` | `createBoardsPane` 导入、`Topic` 的 `"boards"`、导航项、`:123` `:136` 两句关于 board 链接的文案改写 |
| `src/settings.ts` | `pagesProject`、`pagesUrl` 字段与 setter；`:77` 注释 |
| `src/socket.ts` | `/boards` 路由、`boards` 依赖、`ANONYMOUS` 里的 `/boards` |
| `src/cli.ts` | `boards` 子命令与帮助行 |
| `src/main.ts` | `:15-16` 导入、`:116` `surfacePrompt` 的 `boardsDir`、`:356-357` `rotateBoardViews`、`:375` 路由注册、`:377-378` `pagesTarget`、`:449` |
| `src/agent/roles.ts` | `surfacePrompt` 的 Boards 段；签名去掉 `boardsDir`；`publicUrl` 保留（push、passkeys 还用） |
| `src/web/auth.ts` | `isPublic` 的 `/b/` 豁免及 `:229-232` `:334` 注释 |
| `src/web/server.ts:668`、`src/web/ui/composer.ts:402,409`、`src/web/ui/attachments.ts:167,210`、`src/paths.ts:16`、`src/service.ts:89` | 提到 boards 的注释改写；逻辑不动 |
| `skills/pier-boards/` | 整个目录 |
| `justfile:28` | size 表去掉 `boards` |

### 9.2 删除与改写（文档）

- 删：`docs/design/05-boards.md`。
- 改：`AGENTS.md`（架构列表的 `boards/` 行、依赖方向、budgets 表 `web/` 的描述）；`docs/architecture.md`（`:59-60` `:127` `:150` `:264-266` `:280-284`）；`docs/design/03-web-workbench.md`（`/api/boards*` 三行、`PUT /api/settings {pages}`、`#/settings/boards` 段、`:389` 的 `~/.pier/boards` 例子）；`docs/design/08-cli-socket.md`（`/boards` 路由、`boards:` 错误行）；`docs/deploy.md`（`:22-26` wrangler 段、`:77` 日志 scope、`:275` 备份清单）；`README.md:32,40`。
- `CHANGELOG.md` 加一条：boards 迁出到 Corkboard，`/boards/*` `/b/*` 不再服务，Console 无 Boards。

净减约 2.6k 行（含测试），`web/` 与 root `src/*.ts` 的 ceiling 随之下调，`just size` 给出新数。

### 9.3 数据迁移

一次性脚本（放工具仓库 `scripts/import-pier.sh`，用完即删或留作其他实例用）：

1. `cork init` 建好配置与 clone；`corkboard.json` 写两个项目。
2. 对 `~/.pier/boards/*/`：跳过 `*.deleted-*`；按 `board.json` 的 `public` 放进 `public/` 或 `private/`；`board.json` 只保留 `title`、`description`，加 `owner: pier-g1`；`site/**/*.html` 里的 `/b/_assets/pier.css` 替换为 `/_assets/pier.css`。
3. 现有 11 个 board：7 个 public（`daily-news`、`foam-rolling-guide`、`ios-keychain-threat-model`、`nimbus-docs-research`、`qtc-mining`、`session-memory-design`、`vt-intro`），4 个 private（`jd-vacuum`、`sky-token-briefing`、`uniswap-v3-v4`、`workflow-review`）；以迁移当天的 `url` 字段为准。
4. `cork publish --wait`，核对两站；然后 Pier 升级到删掉 boards 的版本，`~/.pier/boards` 归档（`mv ~/.pier/boards ~/.pier/boards.migrated-<ts>`，确认一周后删）。

日报 board（`daily-news`，11 MB，其中 `work/` 占 11 MB）：

- `bin/`、`days/`、`PROCEDURE.md`、`site/`、`board.json` 进 `public/daily-news/`；`work/` 被 `.gitignore` 排除，留在 checkout 里不入库。
- `bin/build.py` 的模板把样式表路径改为 `/_assets/pier.css`。
- `PROCEDURE.md`：Board dir 改为 `cork path daily-news` 的输出；§4 的 `curl … /p/daily-news-91ab644c/` 核对（这个 URL 现在已失效）改为 `cork publish --wait -m "daily-news <D>"`；公开链接改为 `https://<pub>.pages.dev/daily-news/`。
- 定时任务 `1rzpyjf2qd19h0q1`（`每日新闻日报`，`0 7 * * *` Asia/Singapore）：`session.cwd` 改为新 checkout 下的 `public/daily-news`，prompt 里的链接改为新地址。
- 每日一次 push → 每日一次部署，远在任何配额之下。

### 9.4 旧的 `pier-g1.pages.dev`

| 方案 | 结论 |
| --- | --- |
| 新 public 项目沿用名字 `pier-g1` | 所有旧链接不变；但多实例共享的站叫一个实例的名字 | 否 |
| 新名字 + 旧项目最后部署一份只含 `_redirects` 的快照，数周后删除 | 旧链接继续可达 | 否 |
| **迁移完成后直接删除项目 `pier-g1`** | 旧链接失效；删除项目同时结束它所有边缘缓存副本 | **已选**（用户决定）；Pier 升级前清掉 Console → Boards 里的项目名，免得旧版本再发一次 |

## 10. 风险与未验证项

- Access 保护 `<project>.pages.dev` 生产域的步骤来自 Cloudflare 文档，本机未实操；实现前先在一个空项目上走一遍。
- Lark / Slack 内置浏览器里走 Access 的 One-time PIN 流程是否顺畅，未验证；不顺就改 GitHub login。
- 7 天边缘缓存是现有实现的观察结论，不是文档承诺；`_redirects` 的兜底写法与今天一致。
- 仓库增长：每个 board 的 `site/` 入库，图片要克制；`cork publish` 对单文件 > 25 MiB 直接拒（Pages 限额）。
- 一个实例离线时只能读旧副本、不能发布；没有本地回退路径（这是设计选择：不再在实例上服务页面）。
- 工具仓库的 reusable workflow 是所有实例的单点：改坏了所有人都发不了。用 tag（`@v1`）钉版本。

## 11. 已决定

1. 项目名 Corkboard，CLI `cork`。
2. Pages 项目 `corkboard` / `corkboard-private`。
3. Access 身份：One-time PIN 邮箱。
4. 旧 `pier-g1.pages.dev`：迁移后删除，不做跳转。
5. 不开 `public/` 的 PR 门禁。
