#!/bin/bash
set -euo pipefail

# SessionStart hook —— 云端(Claude Code on the web)自动安装 mattpocock 工程技能链
# (/ask-matt、/grill-with-docs、/implement、/code-review、/to-spec、/to-tickets 等)。
#
# 为什么需要它:云会话每次都是全新容器,而 .agents/ 与 .claude/skills/ 都被 gitignore
# (按仓库约定,这些技能各人本地 `npx skills add` 自装、不随仓库分发)—— 于是云端每次启动
# 都得重装一遍,否则那条技能链在云会话里根本不存在。
#
# 同步执行(不用 async):技能必须在会话「扫描 .claude/skills/」之前就落地,async 会有竞态
# 让本次会话扫不到刚装的技能。代价是会话启动多等约 10-20 秒(仅首次;见下方短路)。

# 仅云端跑。本地开发者自己装,不该被这个 hook 打扰。
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# 幂等短路:同一容器内已装过就秒退(resume/compact 不必重跑那 15 秒)。
if [ -e "$CLAUDE_PROJECT_DIR/.claude/skills/ask-matt" ]; then
  exit 0
fi

# 装。非致命:技能是增强不是必需,装不上也不该挡住会话启动 —— 失败只留一行提示 + 日志。
if npx -y skills@latest add mattpocock/skills --all >/tmp/skills-install.log 2>&1; then
  echo "mattpocock skills installed into .claude/skills/"
else
  echo "mattpocock skills install failed — see /tmp/skills-install.log (non-fatal)"
fi
