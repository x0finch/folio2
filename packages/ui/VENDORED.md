# Vendored beUI components

`src/components/motion/`, `src/components/charts/` and most of `src/lib/` come from the beUI
registry (`pnpm dlx shadcn@latest add @beui/<name>` run in this folder). They are excluded from
oxlint/oxfmt and are not edited, except for the patches below, which only make them compile
under this repository's stricter TypeScript (`noUncheckedIndexedAccess`). Re-apply them after
updating a component from the registry.

| File                                              | Patch                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `components/motion/loader.tsx`                    | `MORPH_PATHS[0]!` in `MORPH_SEQ`                                   |
| `components/motion/tabs.tsx`                      | `as const` on the `saved` tuples, `saved[index]!`, `clips[index]!` |
| `components/motion/bottom-sheet.tsx`              | `smaller[smaller.length - 1]!`, `snapPoints[snap]!`                |
| `components/motion/combobox/use-active-option.ts` | `rows[index]!`                                                     |
| `components/motion/select.tsx`                    | defaults `[p = 0, near = 0]` in the clip-path transform            |
| `lib/hooks/use-listbox.ts`                        | `enabled[(from + step) % enabled.length]!`                         |
| `lib/hooks/use-row-cursor.ts`                     | `live[next]!`                                                      |
