#!/bin/bash
# SessionStart hook — prepares a fresh Claude Code container:
#   1. installs mattpocock/skills (gitignored, per-container)  → .agents/skills + .claude/skills symlinks
#   2. installs workspace deps (pnpm install)
# Idempotent and non-interactive; safe to re-run. Web-only by default.
set -uo pipefail

# Only run in Claude Code on the web (remote) containers; local devs manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 1

# 1. mattpocock skills — best-effort: a registry/network hiccup must not block session start.
echo "session-start: installing mattpocock/skills…"
if npx --yes skills@latest add mattpocock/skills -y; then
  echo "session-start: skills installed"
else
  echo "session-start: WARN skills install failed (continuing)" >&2
fi

# 2. workspace dependencies — the session needs these to run tests/lint/build.
echo "session-start: pnpm install…"
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
pnpm install --frozen-lockfile || pnpm install

echo "session-start: done"
