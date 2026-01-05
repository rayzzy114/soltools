import { test, expect } from "@playwright/test"

test("landing loads and shows dashboard shell", async ({ page }) => {
  await page.goto("/")

  // if server not running, skip to avoid false negative
  if (page.url().startsWith("about:blank")) test.skip()

  await expect(page.getByRole('heading', { name: 'SOLANA TOOLS' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'DASHBOARD' })).toBeVisible()
})

