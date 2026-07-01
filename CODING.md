# Coding Style

Coding conventions for Folio. Consolidates the coding-related rules from [CLAUDE.md](CLAUDE.md)
(which remains the authority on architecture, security, and process) plus front-end/React style.

## General

- **Relative imports, no extensions** — `import './foo'` (never `./foo.js` / `./foo.ts`). `moduleResolution: bundler`.
- **kebab-case filenames** (`token-combobox.tsx`); exports keep their own case: components `PascalCase`, funcs/vars `camelCase`, types `PascalCase`, constants `UPPER_SNAKE`.
- **No hardcoding** — chain IDs, API bases, timeouts, TTLs, limits → `constants.ts` or env. Name every magic number; volatile/env-specific → env, stable domain → `constants.ts`.
- **Prefer mature, vetted libraries** over hand-rolling (signing, BIP32, crypto, dates, decimals). A new lib must pass 4 gates: ① runs on CF Workers, ② maintained/no severe CVEs, ③ complexity matches payoff, ④ no conflicting deps. Record the choice.
- **Secrets never leave / never logged** — APIs return only a safe projection; decrypt only at use time and discard.

## UI

- **Base UI only, never Radix.** Compose the shadcn design system (`@base-ui/react`); `radix-ui` is not a dependency and must not be reintroduced. Colors/spacing/radius via design tokens (`bg-background`, `text-foreground`, …) — no hardcoded colors, no arbitrary values (`bg-[#…]`, `p-[13px]`), no editing component internals.
- **Primitives are added via `shadcn add`, never hand-written** — `pnpm dlx shadcn@latest add <comp>` with the Base UI registry (`--base base`); verify the import is `@base-ui/react`. Monorepo-aware: primitives land in `@folio/ui` (export from `src/index.ts`), blocks/compositions in `apps/web/src/components/` (hand-authored). A new transitive dep from `add` → run the 4 library gates.
- **Use a component's native API, don't be clever.** Prefer controlled props / built-in behavior (`value`, `open`, `filter`, `openOnInputClick`, …) over hand-rolled overlays, focus hacks, or pointer-event tricks. Extend on top of the native structure, minimally.
- When unsure what a component supports, **read its types / the `shadcn add` output — don't guess.**

## React

- **Data fetching → `useQuery`, not `useEffect`.** The app is TanStack Start with react-query wired in (`router.tsx`: `QueryClient` + `setupRouterSsrQueryIntegration`). Never build fetches from `useEffect` + `useState` status flags.
  - Debounce with `useDeferredValue` (as the `queryKey`), not `useEffect` + `setTimeout`.
  - Derive with `useMemo` / inline; don't `useEffect` → `setState` to sync derived state.
  - Reserve `useEffect` for genuine one-off side effects that can't live in an event handler.

  ```tsx
  const search = useDeferredValue(query.trim());
  const q = useQuery({
    queryKey: ["tokens", search],
    queryFn: () => (search ? searchCoins({ data: { query: search } }) : topCoins({ data: {} })),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  ```

- **Lift conditional JSX into named variables**; keep the returned tree flat. Don't inline `cond && (<big block/>)`.

  ```tsx
  const isSelectedAndClosed = value !== null && !open;
  const selectedOverlay = isSelectedAndClosed ? <SelectedRow … /> : null;
  const dropdownBody = q.isError ? <ErrorRow /> : q.isLoading ? <LoadingRow /> : <TokenList … />;
  return (<Combobox …>{selectedOverlay}<ComboboxContent>{dropdownBody}</ComboboxContent></Combobox>);
  ```

- **Extract stateful sub-views into named components** (same file) — loading / error / empty branches that have their own structure become `TokenListLoading` / `TokenListError` / `TokenListEmpty`, not inline blocks. Factor shared layout (e.g. a centered `StatusBlock`) so the states stay visually consistent.

## Naming

- One concept, one word across the codebase (e.g. `token` everywhere — `TokenCombobox`, `TokenRow`, `TokenInfo` — not mixed `coin`/`token`).

## Tests

- **Test-first**: adapters get tests against recorded fixtures before impl; parsing logic gets golden tests. Tests in `tests/` beside `src/`, fixtures in `tests/fixtures/`.
- Vendored shadcn primitives are not unit-tested — validate integration (build emits their classes); test our own logic (compositions, hooks, pure functions).

## Debugging

- **Don't guess — add logs + make a real request.** Add structured logs (`getLogger(["folio", …])`), run the real path, read the actual error/`cause`, then fix the root cause.

## Commits

- Small commits, **English** messages, conventional-commit style (`type(scope): summary`). Never `git commit` without explicit approval.
