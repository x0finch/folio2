#!/bin/bash
set -euo pipefail

# SessionStart hook —— 云端(Claude Code on the web)会话启动准备:
#   ① 安装 mattpocock 工程技能链(/ask-matt、/grill-with-docs、/implement、/code-review、
#      /to-spec、/to-tickets 等)
#   ② 安装 pnpm 依赖,让四闸(typecheck / test / biome / build)在云会话里开箱能跑
#
# 为什么需要它:云会话每次都是全新容器。技能链住在 gitignore 的 .agents/ + .claude/skills/
# (各人本地自装、不随仓库分发),node_modules 更不入库 —— 不装,云会话里技能链缺席、测试跑不了。
# 容器状态在 hook 跑完后会被缓存,所以这两步每个容器只付一次首启成本。
#
# 同步执行(不用 async):技能必须在会话「扫描 .claude/skills/」之前落地,async 有竞态让本次
# 会话扫不到。代价是首个会话启动多等一会儿(技能约 10s + 依赖装一次);两步都带幂等短路,
# resume/compact 秒过。

# 仅云端跑。本地开发者自己 `npx skills add` + `pnpm install`,不该被这个 hook 打扰。
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# ① 技能链。已装过就跳过(同容器内 resume 不必重跑)。非致命:技能是增强不是必需。
if [ -e "$CLAUDE_PROJECT_DIR/.claude/skills/ask-matt" ]; then
  echo "mattpocock skills already installed"
elif npx -y skills@latest add mattpocock/skills --all >/tmp/skills-install.log 2>&1; then
  echo "mattpocock skills installed into .claude/skills/"
else
  echo "mattpocock skills install failed — see /tmp/skills-install.log (non-fatal)"
fi

# ② pnpm 依赖。已装过就跳过。非致命:装不上不该挡住会话启动,只是四闸得等你手动 pnpm install。
if [ -d "$CLAUDE_PROJECT_DIR/node_modules" ]; then
  echo "node_modules present — skipping pnpm install"
elif pnpm install >/tmp/pnpm-install.log 2>&1; then
  echo "pnpm dependencies installed"
else
  echo "pnpm install failed — see /tmp/pnpm-install.log (non-fatal)"
fi
