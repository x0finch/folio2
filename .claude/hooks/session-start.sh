#!/bin/bash
# SessionStart hook: installs workspace deps in a fresh Claude Code web container.
# Idempotent and non-interactive.
set -uo pipefail

# Only run in Claude Code on the web (remote) containers; local devs manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 1

# Workspace dependencies — the session needs these to run tests/lint/build.
echo "session-start: pnpm install…"
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
pnpm install

echo "session-start: done"
