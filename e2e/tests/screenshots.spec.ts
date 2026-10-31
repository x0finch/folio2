import { mkdirSync } from 'node:fs'

import { devices, test } from '@playwright/test'

import { addManualAccount, signUp } from '../support/app'

/** Saves the key screens for PR comparisons (not a CI check: pixels differ per machine). */
const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { ...devices['iPhone 13'], browserName: 'chromium' as const },
}

for (const [name, options] of Object.entries(VIEWPORTS)) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${name} ${colorScheme}`, async ({ browser }) => {
      const context = await browser.newContext({ ...options, colorScheme })
      const page = await context.newPage()
      const dir = new URL('../screenshots/', import.meta.url).pathname
      mkdirSync(dir, { recursive: true })
      const shot = async (screen: string) => {
        await page.waitForTimeout(800)
        await page.screenshot({ path: `${dir}${screen}-${name}-${colorScheme}.png` })
      }
      await page.goto('/sign-in')
      await shot('sign-in')
      await signUp(page)
      await shot('overview-empty')
      await addManualAccount(page, 'Cold storage', [
        { search: 'bitcoin', symbol: 'BTC', amount: '0.5' },
        { search: 'ethereum', symbol: 'ETH', amount: '2' },
        { search: 'solana', symbol: 'SOL', amount: '40' },
      ])
      await page
        .getByRole('button', { name: /Cold storage/ })
        .getByText('Synced')
        .waitFor()
      await shot('accounts')
      for (const [path, screen] of [
        ['/', 'overview'],
        ['/insights', 'insights'],
        ['/assets/coingecko:bitcoin', 'asset'],
        ['/settings', 'settings'],
      ]) {
        await page.goto(path!)
        await shot(screen!)
      }
      await context.close()
    })
  }
}
