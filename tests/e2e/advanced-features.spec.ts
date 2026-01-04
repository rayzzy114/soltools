import { test, expect } from '@playwright/test';
import bs58 from 'bs58';

// Advanced features test: Panic Sell, Volume Bot Control, CEX Funding Failure
// Uses strict network mocking to ensure no real blockchain interaction.

test.describe('Advanced Dashboard Features', () => {
  test.beforeEach(async ({ page }) => {
    // 0. Setup LocalStorage with Funder Key
    // Generate a valid 64-byte secret key encoded in bs58
    const mockSecretKey = bs58.encode(new Uint8Array(64).fill(1));

    await page.addInitScript((secret) => {
        window.localStorage.setItem('funderSecretKey', secret);
    }, mockSecretKey);

    // 1. Mock Dashboard Data Load
    await page.route('**/api/stats?type=dashboard', async route => route.fulfill({ json: { activeTokens: 5, totalVolume24h: '100', bundledTxs: 50, holdersGained: 10 } }));
    await page.route('**/api/stats?type=activity*', async route => route.fulfill({ json: [] }));
    await page.route('**/api/stats?type=volume-bot', async route => route.fulfill({ json: { isRunning: false, activePairs: 1, tradesToday: 0, volumeGenerated: '0', solSpent: '0' } }));
    await page.route('**/api/pnl?type=summary', async route => route.fulfill({ json: { totalPnl: 0, overallRoi: 0 } }));
    await page.route('**/api/pnl?type=tokens', async route => route.fulfill({ json: [] }));
    await page.route('**/api/pnl?type=trades*', async route => route.fulfill({ json: [] }));

    // Mock Tokens - Need a selected token for Main Stage
    await page.route('**/api/tokens', async route => route.fulfill({
      json: [{
        mintAddress: 'TokenMint123456789',
        symbol: 'TEST',
        name: 'Test Token',
        price: '0.001',
        imageUrl: 'https://placehold.co/100x100.png',
        description: 'Test Token Description',
        creatorWallet: 'DevWallet123',
      }]
    }));

    // Mock Token Finance
    await page.route('**/api/tokens/finance*', async route => route.fulfill({
      json: {
        fundingBalanceSol: 1.5,
        liquiditySol: 10,
        currentPriceSol: 0.001,
        marketCapSol: 1000,
        totalSupply: 1000000,
        complete: false
      }
    }));

    const mockWallets = [
      { publicKey: 'DevWallet123', role: 'dev', solBalance: 1.5, tokenBalance: 10000, isActive: true, secretKey: 'mockSecret' },
      { publicKey: 'Buyer1', role: 'buyer', solBalance: 0.5, tokenBalance: 500, isActive: true, secretKey: 'mockSecret' },
      { publicKey: 'Buyer2', role: 'buyer', solBalance: 0.5, tokenBalance: 500, isActive: true, secretKey: 'mockSecret' }
    ];

    // Mock Wallets - Need Dev and Buyers
    await page.route('**/api/bundler/wallets?action=load-all', async route => route.fulfill({
      json: {
        wallets: mockWallets
      }
    }));

    // Mock Wallet Actions (POST)
    await page.route('**/api/bundler/wallets', async route => {
        if (route.request().method() === 'POST') {
            const body = route.request().postDataJSON();
            if (body.action === 'fund' || body.action === 'create-atas') {
                await route.fulfill({ json: { success: true, signature: 'mockTx' } });
            } else if (body.action === 'refresh') {
                await route.fulfill({ json: { success: true, wallets: mockWallets } });
            } else {
                await route.fulfill({ json: { success: true, wallets: mockWallets } });
            }
        } else {
            await route.continue();
        }
    });

    // Mock Network Status
    await page.route('**/api/network', async route => route.fulfill({ json: { network: 'mainnet-beta', pumpFunAvailable: true, rpcHealthy: true } }));
    await page.route('**/api/jito/tip-floor', async route => route.fulfill({ json: { recommended: true, sol: { p75: 0.0001 } } }));
    await page.route('**/api/fees/priority', async route => route.fulfill({ json: { fast: { feeSol: 0.0001 } } }));

    // Mock Logs
    await page.route('**/api/logs*', async route => route.fulfill({ json: { logs: [] } }));

    // Load page
    await page.goto('http://localhost:3000/dashboard');

    // Switch to Main Stage if needed
    const openMainStage = page.getByText('Open main stage');
    if (await openMainStage.isVisible()) {
        await openMainStage.click();
    }

    // Ensure "Test Token" is selected by clicking it explicitly
    await page.getByText('TOKEN INFO').waitFor();
    const tokenRow = page.getByText('Test Token', { exact: true }).first();
    await tokenRow.waitFor();
    await tokenRow.click();
    // Wait for finance data to load which enables buttons
    await page.waitForTimeout(500);
  });

  test('Panic Sell (Dump from buyer) should trigger API and show success', async ({ page }) => {
    let rugpullCalled = false;
    await page.route('**/api/bundler/rugpull', async route => {
      rugpullCalled = true;
      await route.fulfill({
        json: { success: true, signatures: ['sig1', 'sig2'] }
      });
    });

    const dumpBtn = page.getByRole('button', { name: 'Dump from buyer' });
    await expect(dumpBtn).toBeVisible();
    await expect(dumpBtn).toBeEnabled({ timeout: 10000 });

    page.on('dialog', async dialog => {
      await dialog.accept();
    });

    await dumpBtn.click();

    await expect(page.getByText(/rugpull executed/i)).toBeVisible({ timeout: 10000 });
    expect(rugpullCalled).toBe(true);
  });

  test('Volume Bot Toggle should update status to RUNNING', async ({ page }) => {
    await page.route('**/api/volume-bot', async route => {
      const body = route.request().postDataJSON();
      if (body.action === 'start') {
        await route.fulfill({ json: { success: true, pairId: 'pair123' } });
      } else if (body.action === 'status') {
        await route.fulfill({
            json: { status: 'running', totalTrades: 0, totalVolume: '0', solSpent: '0' }
        });
      } else {
        await route.continue();
      }
    });

    const startBtn = page.getByRole('button', { name: 'Start' });
    await expect(startBtn).toBeVisible();

    await startBtn.click();

    await expect(page.getByText('Volume bot started')).toBeVisible();
    await expect(page.locator('.bg-green-500\\/20').getByText('RUNNING').first()).toBeVisible({ timeout: 5000 });
  });

  test('CEX Funding Failure should be reported during Launch', async ({ page }) => {
    // Switch to Launch Stage
    await page.getByText('Launch another token').click();

    // 1. Mock Metadata Upload
    await page.route('**/api/tokens/upload-metadata', async route => {
        await route.fulfill({ json: { metadataUri: 'https://ipfs.io/ipfs/QmMock', metadata: { image: 'https://mock.image' } } });
    });

    // 2. Fill Launch Form
    await page.getByPlaceholder('Token Name').fill('Fail Token');
    await page.getByPlaceholder('SYMBOL').fill('FAIL');

    const buffer = Buffer.from('fake image content');
    await page.setInputFiles('input[type="file"]', {
        name: 'token.png',
        mimeType: 'image/png',
        buffer
    });

    await page.getByText('Upload to IPFS').click();
    await expect(page.getByText('Metadata: https://ipfs.io/ipfs/QmMock')).toBeVisible();

    // 3. Select Dev Wallet
    const devSelectContainer = page.locator('div')
        .filter({ has: page.locator('label', { hasText: 'Dev address' }) })
        .filter({ has: page.getByRole('combobox') })
        .last();

    const devSelect = devSelectContainer.getByRole('combobox').first();

    await page.waitForTimeout(1000);

    const selectedText = await devSelect.textContent();

    if (!selectedText?.includes('DevWallet123')) {
        await devSelect.click();
        await expect(page.getByRole('option').first()).toBeVisible();
        const option = page.getByRole('option').filter({ hasText: 'DevWallet123' }).first();
        if (await option.count() > 0) {
            await option.click();
        } else {
             await page.getByRole('option').first().click();
        }
    }

    // 4. Add Buyer Wallet
    await page.getByText('Add wallet').click();

    // 5. Click Launch
    const launchBtn = page.getByRole('button', { name: 'LAUNCH TOKEN + BUNDLE' });
    await expect(launchBtn).toBeEnabled({ timeout: 5000 });

    // 6. Mock Launch Failure (CEX error)
    await page.route('**/api/bundler/launch', async route => {
        await route.fulfill({
            json: { error: 'CEX Funding failed for Buyer1: Insufficient funds' }
        });
    });

    await launchBtn.click();

    // 7. Verify Error Feedback
    const toast = page.locator('li[data-sonner-toast]').filter({ hasText: /CEX Funding failed/ });
    await expect(toast).toBeVisible({ timeout: 10000 });
  });
});
