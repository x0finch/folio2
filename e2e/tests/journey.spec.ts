import { expect, test } from '@playwright/test'

import { addManualAccount, signUp } from '../support/app'

test('signed-out visitors land on sign-in', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(page.getByRole('heading', { name: 'Sign in to Folio' })).toBeVisible()
})

test('a wrong password is refused', async ({ page }) => {
  const email = await signUp(page)
  await page.getByRole('button', { name: 'Sign out' }).first().click()
  await expect(page).toHaveURL(/\/sign-in$/)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('not my password')
  await page.getByRole('button', { name: 'Sign in' }).last().click()
  await expect(page.getByRole('alert')).toHaveText('Wrong email or password.')
})

test('from sign-up to a priced portfolio, history and deleting the account', async ({ page }) => {
  await signUp(page)
  await expect(page.getByText('Nothing to show yet')).toBeVisible()

  await addManualAccount(page, 'Cold storage', [
    { search: 'bitcoin', symbol: 'BTC', amount: '0.5' },
    { search: 'ethereum', symbol: 'ETH', amount: '2' },
  ])
  // The new account syncs on its own (Durable Object alarm), then gets priced.
  const row = page.getByRole('button', { name: /Cold storage/ })
  await expect(row).toContainText('Synced')
  await expect(row).toContainText('$')

  await page.goto('/')
  await expect(page.getByText('Live portfolio across 1 source')).toBeVisible()
  const bitcoin = page.getByRole('link', { name: /Bitcoin/ })
  await expect(bitcoin).toContainText('0.5 BTC')
  await expect(page.getByRole('link', { name: /Ethereum/ })).toContainText('2 ETH')

  await bitcoin.click()
  await expect(page.getByRole('heading', { name: 'Bitcoin' })).toBeVisible()
  await expect(page.getByText('Where you hold it')).toBeVisible()
  await expect(page.getByText('Cold storage')).toBeVisible()

  await page.goto('/insights')
  await expect(page.getByRole('heading', { name: 'By asset' })).toBeVisible()
  await expect(page.getByText('The trend appears after a few syncs.')).toBeVisible()

  // Editing an account: rename it.
  await page.goto('/accounts')
  await page.getByRole('button', { name: /Cold storage/ }).click()
  await page.getByLabel('Label', { exact: true }).fill('Ledger')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: /Ledger/ })).toBeVisible()

  // Display currency.
  await page.goto('/settings')
  await page.getByRole('button', { name: /USD/ }).click()
  await page.getByRole('option', { name: /EUR/ }).click()
  await page.goto('/')
  await expect(page.getByRole('link', { name: /Bitcoin/ })).toContainText('€')

  // Delete the account and everything in it.
  await page.goto('/settings')
  await page.getByLabel('Type "delete" to confirm').fill('delete')
  await page.getByRole('button', { name: 'Delete everything' }).click()
  await expect(page).toHaveURL(/\/sign-in$/)
})
