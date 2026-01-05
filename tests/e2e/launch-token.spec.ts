import { test, expect, type Page } from '@playwright/test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Wyf8AAAAASUVORK5CYII=',
  'base64'
);

const mockDashboardBasics = async (page: Page) => {
  await page.route('**/api/stats?type=dashboard', async route =>
    route.fulfill({ json: { activeTokens: 0, totalVolume24h: '0', bundledTxs: 0, holdersGained: 0 } }));

  await page.route('**/api/stats?type=activity*', async route => route.fulfill({ json: [] }));
  await page.route('**/api/stats?type=volume-bot', async route =>
    route.fulfill({ json: { isRunning: false, activePairs: 0, tradesToday: 0, volumeGenerated: '0', solSpent: '0' } }));

  await page.route('**/api/pnl?type=summary', async route =>
    route.fulfill({ json: { totalPnl: 0, overallRoi: 0 } }));
  await page.route('**/api/pnl?type=tokens', async route => route.fulfill({ json: [] }));
  await page.route('**/api/pnl?type=trades*', async route => route.fulfill({ json: [] }));

  await page.route('**/api/tokens', async route => route.fulfill({ json: [] }));

  await page.route('**/api/network', async route =>
    route.fulfill({ json: { network: 'mainnet-beta', pumpFunAvailable: true, rpcHealthy: true } }));

  await page.route('**/api/jito/tip-floor', async route =>
    route.fulfill({ json: { recommended: true, sol: { p75: 0.000001 } } }));

  await page.route('**/api/fees/priority', async route =>
    route.fulfill({ json: { fast: { feeSol: 0.000005 } } }));

  await page.route('**/api/logs*', async route => route.fulfill({ json: { logs: [] } }));

  await page.route('**/api/tokens/upload-metadata', async route =>
    route.fulfill({ json: { metadataUri: 'ipfs://mock-metadata', metadata: { image: 'https://mock.image/test.png' } } }));
};

const uploadMetadata = async (page: Page) => {
  await page.getByPlaceholder('Token Name').fill('Test Launch Token');
  await page.getByPlaceholder('SYMBOL').fill('TEST');
  await page.getByPlaceholder('Token description...').fill('Test token for launch verification');
  await page.setInputFiles('input[type="file"]', { name: 'token.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG });
  await page.getByRole('button', { name: /upload to ipfs/i }).click();
  await expect(page.getByText(/Metadata:/)).toBeVisible();
};

const selectWalletByKey = async (page: Page, publicKey: string, comboboxIndex = 0) => {
  const combobox = page.locator('button[role="combobox"]').nth(comboboxIndex);
  await combobox.click();
  const optionPattern = new RegExp(`${publicKey.slice(0, 6)}.*${publicKey.slice(-4)}`);
  await page.getByRole('option', { name: optionPattern }).click();
};

test.describe('Token Launch E2E', () => {
  test('should successfully launch token with dev and buyer wallets', async ({ page }) => {
    const devWallet = Keypair.generate();
    const buyer1Wallet = Keypair.generate();
    const buyer2Wallet = Keypair.generate();

    const devPublicKey = devWallet.publicKey.toBase58();
    const buyer1PublicKey = buyer1Wallet.publicKey.toBase58();
    const buyer2PublicKey = buyer2Wallet.publicKey.toBase58();

    await mockDashboardBasics(page);

    const mockWallets = [
      {
        publicKey: devPublicKey,
        role: 'dev',
        solBalance: 0.05,
        tokenBalance: 0,
        isActive: true,
        secretKey: bs58.encode(devWallet.secretKey),
        label: 'Dev Wallet'
      },
      {
        publicKey: buyer1PublicKey,
        role: 'buyer',
        solBalance: 0.032,
        tokenBalance: 0,
        isActive: true,
        secretKey: bs58.encode(buyer1Wallet.secretKey),
        label: 'Buyer 1'
      },
      {
        publicKey: buyer2PublicKey,
        role: 'buyer',
        solBalance: 0.032,
        tokenBalance: 0,
        isActive: true,
        secretKey: bs58.encode(buyer2Wallet.secretKey),
        label: 'Buyer 2'
      }
    ];

    await page.route('**/api/bundler/wallets?action=load-all', async route =>
      route.fulfill({ json: { wallets: mockWallets } }));

    await page.route('**/api/bundler/wallets?action=load-funder', async route =>
      route.fulfill({ json: { funderWallet: mockWallets[0] } }));

    let createdToken: any = null;
    await page.route('**/api/bundler/launch', async route => {
      const requestBody = route.request().postDataJSON();

      expect(requestBody).toHaveProperty('wallets');
      expect(requestBody).toHaveProperty('tokenMetadata');
      expect(requestBody).toHaveProperty('devBuyAmount');
      expect(requestBody).toHaveProperty('buyAmounts');
      expect(requestBody.tokenMetadata.metadataUri).toBe('ipfs://mock-metadata');

      expect(requestBody.wallets[0].role).toBe('dev');
      expect(requestBody.wallets[0].publicKey).toBe(devPublicKey);

      const buyerWallets = requestBody.wallets.slice(1);
      expect(buyerWallets).toHaveLength(2);
      buyerWallets.forEach((wallet: any) => {
        expect(wallet.solBalance).toBe(0.032);
        expect(wallet.role).toBe('buyer');
      });

      createdToken = {
        mintAddress: Keypair.generate().publicKey.toBase58(),
        success: true,
        bundleId: 'mock-bundle-id',
        signatures: ['mock-sig-1', 'mock-sig-2']
      };

      await route.fulfill({ json: createdToken });
    });

    await page.route('**/api/bundler/wallets', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();

        if (body.action === 'fund') {
          expect(body.funderAddress).toBe(devPublicKey);
          expect(body.funderAddress).not.toBe('CONNECTED_WALLET_PUBKEY');
          expect(body.wallets).toHaveLength(3);
          expect(body.wallets[0].publicKey).toBe(devPublicKey);
          expect(body.wallets[0].role).toBe('dev');

          await route.fulfill({ json: { signatures: ['funding-sig-1', 'funding-sig-2'] } });
        } else {
          await route.fulfill({ json: { success: true } });
        }
      } else {
        await route.continue();
      }
    });

    await page.goto('/');
    await page.getByText('SELECT TOKEN TO LAUNCH').waitFor();

    await uploadMetadata(page);
    await selectWalletByKey(page, devPublicKey);

    const addBuyerButton = page.getByRole('button', { name: /^add wallet$/i });
    await addBuyerButton.click();
    await addBuyerButton.click();

    const launchSettings = page.locator('div', { has: page.getByText('LAUNCH SETTINGS') }).first();
    const devBuyInput = launchSettings
      .locator('div', { has: page.getByText('Dev buy (SOL)') })
      .locator('input[type="number"]')
      .first();
    await devBuyInput.fill('0.005');

    const launchButton = page.getByRole('button', { name: 'LAUNCH TOKEN + BUNDLE' });
    await expect(launchButton).toBeEnabled();
    await launchButton.click();

    await expect(page.getByRole('button', { name: 'Launch another token' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/launched! mint:/i)).toBeVisible({ timeout: 10000 });

    expect(createdToken).not.toBeNull();
    expect(createdToken.success).toBe(true);
    expect(createdToken.mintAddress).toBeDefined();
    expect(createdToken.bundleId).toBe('mock-bundle-id');
    expect(createdToken.signatures).toHaveLength(2);

    console.log('Token launch test passed');
    console.log(`Created token: ${createdToken.mintAddress}`);
    console.log(`Dev wallet: ${devPublicKey}`);
    console.log(`Buyer wallets: ${buyer1PublicKey}, ${buyer2PublicKey}`);
  });

  test('should surface an error when launch fails due to buyer balance', async ({ page }) => {
    const devWallet = Keypair.generate();
    const buyerWallet = Keypair.generate();
    const devPublicKey = devWallet.publicKey.toBase58();
    const buyerPublicKey = buyerWallet.publicKey.toBase58();

    await mockDashboardBasics(page);

    const mockWallets = [
      {
        publicKey: devPublicKey,
        role: 'dev',
        solBalance: 0.05,
        tokenBalance: 0,
        isActive: true,
        secretKey: bs58.encode(devWallet.secretKey)
      },
      {
        publicKey: buyerPublicKey,
        role: 'buyer',
        solBalance: 0.002,
        tokenBalance: 0,
        isActive: true,
        secretKey: bs58.encode(buyerWallet.secretKey)
      }
    ];

    await page.route('**/api/bundler/wallets?action=load-all', async route =>
      route.fulfill({ json: { wallets: mockWallets } }));

    await page.route('**/api/bundler/wallets', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (body.action === 'fund') {
          await route.fulfill({ json: { signatures: ['funding-sig-1'] } });
        } else {
          await route.fulfill({ json: { success: true } });
        }
      } else {
        await route.continue();
      }
    });

    await page.route('**/api/bundler/launch', async route => {
      await route.fulfill({ json: { error: 'buyer wallet balance too low' } });
    });

    await page.goto('/');
    await page.getByText('SELECT TOKEN TO LAUNCH').waitFor();

    await uploadMetadata(page);
    await selectWalletByKey(page, devPublicKey);

    const addBuyerButton = page.getByRole('button', { name: /^add wallet$/i });
    await addBuyerButton.click();

    const launchButton = page.getByRole('button', { name: 'LAUNCH TOKEN + BUNDLE' });
    await expect(launchButton).toBeEnabled();
    await launchButton.click();

    const toast = page.locator('li[data-sonner-toast]').filter({ hasText: /balance too low/i });
    await expect(toast).toBeVisible({ timeout: 10000 });

    console.log('Insufficient balance validation test passed');
  });
});

