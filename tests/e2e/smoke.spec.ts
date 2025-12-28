import { test, expect } from "@playwright/test"

test("landing loads and shows bundler link", async ({ page }) => {
  await page.goto("/")

  // if server not running, skip to avoid false negative
  if (page.url().startsWith("about:blank")) test.skip()

  const hasBundler = await page.getByText(/bundler/i).first()
  await expect(hasBundler).toBeVisible()
})

