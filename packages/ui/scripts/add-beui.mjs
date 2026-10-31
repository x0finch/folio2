// Adds beUI components from the registry and marks every vendored file `@ts-nocheck`.
// Usage: pnpm --filter @folio/ui add-beui <name> [<name>...]
//
// beUI is written for a looser TypeScript than this repository's (`noUncheckedIndexedAccess`),
// and its files are not ours to edit. The marker keeps them out of type errors; the code that
// uses them is still checked against their exported types.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = '// @ts-nocheck -- vendored from beUI, see packages/ui/VENDORED.md'
const VENDORED = ['src/components/motion', 'src/components/charts', 'src/lib']

const names = process.argv.slice(2)
if (names.length) {
  execFileSync(
    'pnpm',
    ['dlx', 'shadcn@latest', 'add', ...names.map((name) => `@beui/${name}`), '--yes'],
    { stdio: 'inherit' },
  )
}

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (/\.tsx?$/.test(entry)) yield path
  }
}

for (const dir of VENDORED) {
  for (const path of files(dir)) {
    const source = readFileSync(path, 'utf8')
    if (source.includes(MARKER)) continue
    // First line: TypeScript only honours the marker before any statement, directives included.
    writeFileSync(path, `${MARKER}\n${source}`)
  }
}
