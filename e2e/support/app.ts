import { type Page, expect } from '@playwright/test'

let counter = 0

/** Signs up a fresh user through the UI and waits for the overview. */
export async function signUp(page: Page) {
  counter += 1
  const email = `e2e-${Date.now()}-${counter}@example.com`
  await page.goto('/sign-in')
  await page.getByRole('tab', { name: 'Sign up' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  return email
}

/** Adds a manual account with the given coins (searched by name) and amounts. */
export async function addManualAccount(
  page: Page,
  label: string,
  holdings: { search: string; symbol: string; amount: string }[],
) {
  await page.goto('/accounts')
  await page.getByRole('button', { name: 'Add account' }).first().click()
  await page.getByRole('button', { name: 'Manual', exact: true }).click()
  await page.getByLabel('Label (optional)').fill(label)
  for (const holding of holdings) {
    if (!(await page.getByLabel('Search coins').isVisible())) {
      await page.getByRole('button', { name: 'Add an asset' }).click()
    }
    await page.getByLabel('Search coins').fill(holding.search)
    await page
      .getByRole('button', { name: new RegExp(`^${holding.symbol}\\b`) })
      .first()
      .click()
    await page.getByLabel(`${holding.symbol} amount`).fill(holding.amount)
  }
  await page.getByRole('button', { name: 'Add account', exact: true }).last().click()
  await expect(page.getByRole('dialog')).toBeHidden()
}
