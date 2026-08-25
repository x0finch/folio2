# Issue tracker: Linear

Issue / PRD 都活在 **Linear**,不在 GitHub。

- **Workspace**:`x0finch`
- **Team**:`Folio`,key `FOL` → issue 标识形如 `FOL-21`
- **通道**:Linear 的 **GraphQL API,直接 curl**(`https://api.linear.app/graphql`)—— 不走 MCP,理由见下

## 认证:`LINEAR_API_KEY`

走 **个人 API key**,不走 OAuth。

- **key 从哪来**:Linear → Settings → Security & access → Personal API keys。**要建可写的**(只读 key 建不了 issue)。
- **key 放哪**:**`~/.zshenv`**(不是 `~/.zshrc` —— 见下面那条,是刻意的):

  ```bash
  export LINEAR_API_KEY=lin_api_xxxxx
  ```

- **真 key 绝不入库**,也不写进 `.claude/settings.json`。

### 为什么是 `.zshenv` 而不是 `.zshrc`

**zsh 的非交互模式不读 `~/.zshrc`,只读 `~/.zshenv`。** agent 的 Bash 工具跑的就是非交互 shell —— key 放 `.zshrc` 的话它在那儿看不到这个变量,会误判成「没配」然后瞎折腾(这坑真踩过)。放 `.zshenv` 之后两种 shell 都能读到。

所以检查配没配,直接查就行(**别把 key 打出来**):

```bash
[ -n "$LINEAR_API_KEY" ] && echo "configured (${#LINEAR_API_KEY} chars)" || echo "missing"
```

`missing` 就是真没配 —— **问用户**,别自己找地方存一份,也别搬回 `.zshrc`。

**取不到 key 时不要退回 GitHub 建 issue** —— 停下来告诉用户。GitHub 那边的 issue 写操作已经在 `.claude/settings.json` 里 deny 了。(这坑踩过两次:发到 GitHub 再补一句「Linear 没连上」不是解决,是把「我做不到」改成「我改了规则」。)

## 进度用 state,分诊用 label

两套东西别混:

- **workflow state** = 这件事做到哪了。`Backlog` → `Todo` → `In Progress` → `In Review` → `Done`(另有 `Canceled` / `Duplicate`)。
- **label** = 这件事是什么 / 该谁接。五个分诊角色 + `roadmap`,见 [triage-labels.md](triage-labels.md)。

所以「先不做」不打 label,挪到 `Backlog`;「不做了」挪到 `Canceled`(`wontfix` label 仍在,给需要显式标记的场合)。

## 常用操作

一律走 GraphQL:查询用 `viewer` / `teams` / `issues`,写用 `issueCreate` / `issueUpdate` / `commentCreate` / `issueRelationCreate` 这几个 mutation。几条约定:

- **建 issue**:必须落在 team `FOL`。标题一行说清,正文写背景 + 验收。
- **读 issue**:带上评论一起读 —— 决策经常只在评论里。
- **列 issue**:默认按 label + state 过滤,别一次拉全量。
- **认领**:assignee 设成当前开发者,这是一个 session 的第一次写操作。
- **关闭**:挪到 `Done`(做完)或 `Canceled`(不做),并留一条说明为什么。

**技能里说「publish to the issue tracker」** → 在 `FOL` 建一个 Linear issue。
**技能里说「fetch the relevant ticket」** → 按标识(`FOL-<n>`)读那个 issue,连评论。

## 怎么调

POST `https://api.linear.app/graphql`,已验证可用的形状:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { name } teams(first:10){ nodes { id key name } } }"}'
```

写操作是 `issueCreate` / `issueUpdate` / `commentCreate` / `issueRelationCreate` / `issueLabelCreate` 这几个 mutation。

**header 是裸 key**:`Authorization: <key>`,**不加 `Bearer `**(加了认证失败;2026-08-25 实测)。

**如果 shell 里读不到这个变量**,是因为跑 agent 的那个进程不是从终端起的(桌面端拉起的进程不经过 zsh,`.zshenv` 对它无效)。那就在同一条命令里现取,别打印它:

```bash
eval "$(grep -m1 'LINEAR_API_KEY=' ~/.zshenv)"
```

## 为什么不用 MCP

Linear 有官方 MCP,试过,**放弃了**:它要「进程环境里有 key」+「项目级 MCP 被批准过」两个条件同时成立,而桌面端拉起的进程拿不到 key —— 于是 `claude mcp list` 在终端里显示 `Connected`(那是**另一个**进程,它有 key),会话里工具却一个都注册不上。诊断这件事比写 GraphQL 贵得多。

GraphQL 这条只依赖一个东西:能读到 key。

**踩过的坑**:issue 正文是多行 markdown,**别让它经过 shell 变量** —— zsh 的 `echo` 会把 JSON 里的 `\n` 解释成真换行,把 payload 拆坏("control characters must be escaped")。用 `jq` 从文件里一步构造整个 payload,或 `printf '%s'` 传递,别用 `echo`。

## Pull request

**PR 不是需求入口:否** —— 这仓库不把外部 PR 当 feature request,`/triage` 不用管 PR。

**PR 仍然在 GitHub**(`x0finch/folio2`),只有 issue 搬走了。所以:

- **`Closes #N` 那条自动关闭链路对 Linear 无效**。要让 PR 合并后自动流转 Linear issue,得装 Linear 的 GitHub 集成,靠分支名带 `fol-<n>`(如 `feat/fol-21-stablecoin-facet`)或 PR 标题里带 `FOL-<n>` 关联。**集成没装之前,合并后手动把 issue 挪到 `Done`。**
- **仓库里历史的 `#N` 引用指向 GitHub**,不是 Linear。CLAUDE.md / ADR / commit message 里那些 `#504`、`#527` 全是 GitHub issue 和 PR,继续按 GitHub 读。
- 2026-08-25 迁移时的 21 个 open issue 已搬到 `FOL-1`…`FOL-21`,GitHub 原件各留了一条指向 Linear 的评论后关闭。已关闭的历史 issue **没有**迁,还在 GitHub。

## Wayfinding 操作

`/wayfinder` 用的形状。**map** 是一个 issue,**ticket** 是它的子 issue。

- **Map**:一个打 `wayfinder:map` label 的 issue,正文放 Notes / Decisions-so-far / Fog。
- **子 ticket**:设 `parentId` 指向 map —— Linear 原生父子关系,UI 里直接可见。label 打 `wayfinder:<type>`(`research`/`prototype`/`grilling`/`task`)。认领 = 设 assignee。
- **阻塞**:`issueRelationCreate` mutation,`type: "blocks"`。Linear 原生依赖关系,看板上会显示。
- **前沿查询**:列 map 的子 issue 中 state 未完成、无 assignee、且没有未完成 blocker 的,按 map 里的顺序取第一个。
- **解决**:建一条评论写答案 → 挪到 `Done` → 把结论追加到 map 正文的 Decisions-so-far。

`wayfinder:*` label 还没建,第一次用到时再建。
