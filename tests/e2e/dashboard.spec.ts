import { test, expect } from '@playwright/test';

test.describe('Dashboard Functionality', () => {
  test('should generate wallets in Wallet Tools', async ({ page }) => {
    await page.route('/api/bundler/wallets?action=load-all', async route => {
      await route.fulfill({ json: { wallets: [] } });
    });

    await page.route('/api/tokens', async route => {
      await route.fulfill({ json: [] });
    });

    await page.route('/api/funder', async route => {
        await route.fulfill({ json: { funderWallet: null } });
    });

    await page.goto('/wallet-tools');
    await page.getByText('WALLETS', { exact: true }).first().waitFor();

    await page.route('/api/bundler/wallets?action=generate-multiple&count=5', async route => {
      await route.fulfill({
        json: {
          wallets: Array(5).fill(0).map((_, i) => ({
            publicKey: `GeneratedWallet${i}xxxxxxxxxxxxxxxxxxxxxxxx`,
            secretKey: 'mockSecret',
            solBalance: 0,
            tokenBalance: 0,
            isActive: true,
            role: 'project',
            label: `Wallet ${i + 1}`,
            ataExists: false
          }))
        }
      });
    });

    const generateButton = page.locator('button[aria-label="Generate wallets"]');
    await expect(generateButton).toBeVisible();

    await generateButton.click();

    await expect(page.getByText(/generated 5 wallets/i)).toBeVisible();

    // Allow React render cycle
    await page.waitForTimeout(500);

    const walletListContainer = page.locator('.max-h-64.overflow-y-auto');
    // Check child divs count. The container has direct children divs for each wallet.
    // Selector: > div
    await expect(walletListContainer.locator('> div')).toHaveCount(5);
  });

  test('should navigate between Wallet Tools and Dashboard', async ({ page }) => {
    await page.goto('/');
    const walletToolsLink = page.locator('a[href="/wallet-tools"]');
    if (await walletToolsLink.isVisible()) {
        await walletToolsLink.click();
        await expect(page).toHaveURL(/wallet-tools/);
    }
  });

  test('should handle token selection in Wallet Tools', async ({ page }) => {
    await page.route('/api/tokens', async route => {
      await route.fulfill({
        json: [
          {
            mintAddress: 'TokenMintAddress123456789',
            symbol: 'TEST',
            name: 'Test Token',
            price: '1.23'
          }
        ]
      });
    });

    await page.goto('/wallet-tools');
    await page.getByText('WALLETS', { exact: true }).first().waitFor();

    const tokenTrigger = page.locator('div', { has: page.getByText('Token') }).locator('button[role="combobox"]');
    await expect(tokenTrigger).toBeVisible();

    await tokenTrigger.click();

    const options = page.locator('div[role="option"]');
    await expect(options).toHaveCount(1);

    await options.first().click();
    await expect(tokenTrigger).toContainText('TEST');
  });
});

