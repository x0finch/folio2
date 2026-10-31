# Working on Folio

See README.md for the stack, commands and architecture. Conventions the code doesn't show:

## Workflow

- Work is tracked in GitHub issues under the rewrite epic. One PR per issue (or per slice of
  one), based on `rewrite`. Before merging, tick every checklist item in the issue; anything
  visual gets screenshots in the PR, old app vs new, desktop and mobile.
- `pnpm check` (format, lint, typecheck, test) and `pnpm build` must pass before pushing.
- Everything in the repository is English: code, comments, commits, issues, PRs, UI copy.
- Prefer a maintained library over hand-written code when one exists and runs on Workers;
  say why in the PR when adding a dependency.

## Free plan

- Requests run with 10 ms CPU. Anything that fetches upstreams, loops over many rows or
  hashes runs in a Durable Object alarm (30 s CPU), never in a request handler.
- Only SQLite-backed Durable Objects (`new_sqlite_classes`) exist on the free plan.
- Count subrequests: an alarm invocation stays under the per-invocation limit; plugins fetch
  through `ctx.fetch`, which enforces the budget.

## Data sources

- Every source is a plugin in `packages/sources/src/<id>/` built with `defineSource()`.
  Plugins don't touch D1, pricing or each other; they return positions. See
  `packages/sources/README.md`.
- Config fields marked `secret` are encrypted before they reach D1 and never leave the API.
  Never log a plugin's config.

## Data

- Every user-owned table has `user_id` and every query filters by it. Public data (prices,
  FX rates) lives in tables without `user_id`.
- Amounts are decimal strings; values are USD numbers. Conversion to the display currency
  happens in the web app.

## UI

- beUI components are added with `pnpm --filter @folio/ui add-beui <name>` (see
  `packages/ui/VENDORED.md`);
  token-only local primitives where beUI has none. No Radix.
- Colours come from tokens only (`packages/ui/src/styles`), charts from `--chart-*`.
