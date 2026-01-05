
import { test, expect } from '@playwright/test';
import path from 'path';

test('Verify Speed Mode Inputs', async ({ page }) => {
  // Go to the dashboard
  await page.goto('/');

  await page.getByText('DASHBOARD FLOW').waitFor();

  // We need to switch to "Main Stage" first if we are in "Launch Stage"
  const openMainStageButton = page.locator('button:has-text("Open main stage")');
  if (await openMainStageButton.isVisible()) {
    await openMainStageButton.click();
  }

  // Now wait for the "VOLUME BOT" card to be visible
  const volumeBotTitle = page.locator('div').filter({ hasText: 'VOLUME BOT' }).first();
  await expect(volumeBotTitle).toBeVisible({ timeout: 10000 });

  // Open the settings modal
  const settingsButton = page.locator('button:has(svg.lucide-settings)');
  await settingsButton.click();

  // Wait for the modal content
  const modalContent = page.locator('div[role="dialog"]');
  await expect(modalContent).toBeVisible();

  // Check for the "Speed Mode (Seconds)" label
  await expect(page.locator('text=Speed Mode (Seconds)')).toBeVisible();

  // Find inputs by locating the Label text and then finding the sibling Input
  // Structure:
  // <div ...>
  //   <Label ...>From (Min)</Label>
  //   <Input ...>
  // </div>

  // Locate the "From (Min)" text, then find the input inside the same parent div or next sibling
  const minLabel = page.locator('div', { has: page.locator('text="From (Min)"') }).last();
  const minInput = minLabel.locator('input');

  const maxLabel = page.locator('div', { has: page.locator('text="To (Max)"') }).last();
  const maxInput = maxLabel.locator('input');

  await expect(minInput).toBeVisible();
  await expect(maxInput).toBeVisible();

  // Verify default values (should be 30 and 120 based on initial state in page.tsx)
  await expect(minInput).toHaveValue('30');
  await expect(maxInput).toHaveValue('120');

  // Verify that Presets are GONE
  await expect(page.locator('text=Strategy Presets')).not.toBeVisible();
  await expect(page.locator('button:has-text("Organic Growth")')).not.toBeVisible();
  await expect(page.locator('button:has-text("Frenzy Mode")')).not.toBeVisible();
  await expect(page.locator('button:has-text("Slow Accumulate")')).not.toBeVisible();

  // Take a screenshot of the new settings modal
  await page.screenshot({ path: path.join(process.cwd(), 'verification', 'speed_mode_settings.png') });
});

