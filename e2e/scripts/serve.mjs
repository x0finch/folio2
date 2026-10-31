// Serves the built app with a fresh local API for the end-to-end tests: applies the D1
// migrations to a throwaway state directory, starts the market-data stub, then runs
// `wrangler dev` in the foreground (Playwright stops it when the run ends).
import { execFileSync, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PORT, STUB_PORT, STUB_URL } from '../support/env.mjs'
import { startStub } from './stub.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const state = fileURLToPath(new URL('../.wrangler-state', import.meta.url))
rmSync(state, { recursive: true, force: true })

execFileSync(
  'pnpm',
  [
    '--filter',
    '@folio/api',
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--persist-to',
    state,
    '--config',
    '../../wrangler.jsonc',
  ],
  { cwd: root, stdio: 'inherit' },
)

const stub = startStub(STUB_PORT)
const dev = spawn(
  'pnpm',
  [
    '--filter',
    '@folio/api',
    'exec',
    'wrangler',
    'dev',
    '--local',
    '--port',
    String(PORT),
    '--persist-to',
    state,
    '--config',
    '../../wrangler.jsonc',
    '--var',
    `BETTER_AUTH_URL:http://localhost:${PORT}`,
    '--var',
    'BETTER_AUTH_SECRET:e2e-secret-e2e-secret-e2e-secret-e2e',
    '--var',
    'ENCRYPTION_SECRET:e2e-encryption-e2e-encryption-e2e-enc',
    '--var',
    `DEFILLAMA_URL:${STUB_URL}`,
    '--var',
    `FRANKFURTER_URL:${STUB_URL}`,
    '--var',
    `COINGECKO_URL:${STUB_URL}`,
  ],
  { cwd: root, stdio: 'inherit' },
)
const stop = () => {
  stub.close()
  dev.kill('SIGTERM')
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
dev.on('exit', (code) => {
  stub.close()
  process.exit(code ?? 0)
})
