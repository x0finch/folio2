# Vendored beUI components

`src/components/motion/`, `src/components/charts/` and `src/lib/` come from the beUI registry.
Add or update components with:

```sh
pnpm --filter @folio/ui add-beui <name> [<name>...]
```

It runs `shadcn add @beui/<name>` and marks every vendored file `// @ts-nocheck`. beUI is
written for a looser TypeScript than this repository's (`noUncheckedIndexedAccess`), and the
files are not ours to edit; the marker keeps them out of type errors while the app code that
uses them is still checked against their exported types. The folders are also excluded from
oxlint and oxfmt.

Don't edit these files. Wrap a component in `apps/web/src/components` instead.
