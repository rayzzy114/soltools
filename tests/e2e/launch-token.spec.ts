import { test, expect } from '@playwright/test';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

test.describe('Token Launch E2E', () => {
  test('should successfully launch token with dev and buyer wallets', async ({ page }) => {
    // Generate test wallets for this test
    const devWallet = Keypair.generate();
    const buyer1Wallet = Keypair.generate();
    const buyer2Wallet = Keypair.generate();

    const devPublicKey = devWallet.publicKey.toBase58();
    const buyer1PublicKey = buyer1Wallet.publicKey.toBase58();
    const buyer2PublicKey = buyer2Wallet.publicKey.toBase58();

    // Mock initial data
    await page.route('**/api/stats?type=dashboard', async route =>
      route.fulfill({ json: { activeTokens: 0, totalVolume24h: '0', bundledTxs: 0, holdersGained: 0 } }));

    await page.route('**/api/stats?type=activity*', async route => route.fulfill({ json: [] }));
    await page.route('**/api/pnl?type=summary', async route => route.fulfill({ json: { totalPnl: 0, overallRoi: 0 } }));
    await page.route('**/api/pnl?type=tokens', async route => route.fulfill({ json: [] }));
    await page.route('**/api/pnl?type=trades*', async route => route.fulfill({ json: [] }));

    // Mock tokens (empty initially)
    await page.route('**/api/tokens', async route => route.fulfill({ json: [] }));

    // Mock network status
    await page.route('**/api/network', async route =>
      route.fulfill({ json: { network: 'mainnet-beta', pumpFunAvailable: true, rpcHealthy: true } }));

    // Mock fees
    await page.route('**/api/jito/tip-floor', async route =>
      route.fulfill({ json: { recommended: true, sol: { p75: 0.000001 } } }));

    await page.route('**/api/fees/priority', async route =>
      route.fulfill({ json: { fast: { feeSol: 0.000005 } } }));

    // Mock logs
    await page.route('**/api/logs*', async route => route.fulfill({ json: { logs: [] } }));

    // Step 1: Setup wallets in database
    const mockWallets = [
      {
        publicKey: devPublicKey,
        role: 'dev',
        solBalance: 0.05, // Sufficient for launch
        tokenBalance: 0,
        isActive: true,
        secretKey: bs58.encode(devWallet.secretKey),
        label: 'Dev Wallet'
      },
      {
        publicKey: buyer1PublicKey,
        role: 'buyer',
        solBalance: 0.032, // Exact amount mentioned in bug report
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

    // Mock wallet loading
    await page.route('**/api/bundler/wallets?action=load-all', async route =>
      route.fulfill({ json: { wallets: mockWallets } }));

    // Mock funder wallet (using dev wallet as funder)
    await page.route('**/api/bundler/wallets?action=load-funder', async route =>
      route.fulfill({ json: { funderWallet: mockWallets[0] } }));

    // Step 2: Mock token creation API
    let createdToken: any = null;
    await page.route('**/api/bundler/launch', async route => {
      const requestBody = route.request().postDataJSON();

      // Validate request structure
      expect(requestBody).toHaveProperty('wallets');
      expect(requestBody).toHaveProperty('tokenMetadata');
      expect(requestBody).toHaveProperty('devBuyAmount');
      expect(requestBody).toHaveProperty('buyAmounts');

      // Verify dev wallet is first
      expect(requestBody.wallets[0].role).toBe('dev');
      expect(requestBody.wallets[0].publicKey).toBe(devPublicKey);

      // Verify buyer wallets have correct balances
      const buyerWallets = requestBody.wallets.slice(1);
      expect(buyerWallets).toHaveLength(2);
      buyerWallets.forEach((wallet: any) => {
        expect(wallet.solBalance).toBe(0.032);
        expect(wallet.role).toBe('buyer');
      });

      // Mock successful launch response
      createdToken = {
        mintAddress: Keypair.generate().publicKey.toBase58(),
        success: true,
        bundleId: 'mock-bundle-id',
        signatures: ['mock-sig-1', 'mock-sig-2']
      };

      await route.fulfill({ json: createdToken });
    });

    // Step 3: Mock funding API (using dev wallet as funder)
    await page.route('**/api/bundler/wallets', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();

        if (body.action === 'fund') {
          // Verify funder is dev wallet, not connected wallet
          expect(body.funderAddress).toBe(devPublicKey);
          expect(body.funderAddress).not.toBe('CONNECTED_WALLET_PUBKEY'); // Ensure not using connected wallet

          // Verify wallets being funded are buyers
          expect(body.wallets).toHaveLength(2);
          body.wallets.forEach((wallet: any) => {
            expect(wallet.solBalance).toBe(0.032);
            expect(wallet.role).toBe('buyer');
          });

          await route.fulfill({ json: { signatures: ['funding-sig-1', 'funding-sig-2'] } });
        } else {
          await route.fulfill({ json: { success: true } });
        }
      } else {
        await route.continue();
      }
    });

    // Step 4: Load dashboard
    await page.goto('http://localhost:3000/dashboard');

    // Switch to main stage
    const openMainStage = page.getByText('Open main stage');
    if (await openMainStage.isVisible()) {
      await openMainStage.click();
    }

    // Step 5: Setup token metadata
    await page.getByText('TOKEN INFO').waitFor();

    // Fill token details
    const nameInput = page.locator('input[placeholder*="token name"]').first();
    await nameInput.fill('Test Launch Token');

    const symbolInput = page.locator('input[placeholder*="token symbol"]').first();
    await symbolInput.fill('TEST');

    const descriptionInput = page.locator('textarea[placeholder*="description"]').first();
    await descriptionInput.fill('Test token for launch verification');

    // Step 6: Select dev wallet
    const devWalletSelect = page.locator('select').filter({ hasText: 'Select dev wallet' }).first();
    await devWalletSelect.selectOption(devPublicKey);

    // Step 7: Add buyer wallets
    const addBuyerButton = page.getByRole('button', { name: /add buyer/i }).first();
    await addBuyerButton.click();

    const buyer1Select = page.locator('select').filter({ hasText: 'Select buyer wallet' }).first();
    await buyer1Select.selectOption(buyer1PublicKey);

    await addBuyerButton.click();
    const buyer2Select = page.locator('select').filter({ hasText: 'Select buyer wallet' }).nth(1);
    await buyer2Select.selectOption(buyer2PublicKey);

    // Step 8: Set buy amounts
    const devBuyInput = page.locator('input[placeholder*="0.01"]').first();
    await devBuyInput.fill('0.005');

    const buyer1AmountInput = page.locator('input[type="number"]').nth(1);
    await buyer1AmountInput.fill('0.01');

    const buyer2AmountInput = page.locator('input[type="number"]').nth(2);
    await buyer2AmountInput.fill('0.01');

    // Step 9: Launch token
    const launchButton = page.getByRole('button', { name: /launch/i }).first();
    await expect(launchButton).toBeEnabled();

    await launchButton.click();

    // Step 10: Verify success
    await expect(page.getByText(/launch successful/i)).toBeVisible({ timeout: 10000 });

    // Verify token was created
    expect(createdToken).not.toBeNull();
    expect(createdToken.success).toBe(true);
    expect(createdToken.mintAddress).toBeDefined();

    // Verify bundle was created
    expect(createdToken.bundleId).toBe('mock-bundle-id');
    expect(createdToken.signatures).toHaveLength(2);

    // Step 11: Verify no connected wallet usage
    // This is verified in the API mocks above - funderAddress should be dev wallet

    console.log('✅ Token launch test passed');
    console.log(`📋 Created token: ${createdToken.mintAddress}`);
    console.log(`📋 Dev wallet: ${devPublicKey}`);
    console.log(`📋 Buyer wallets: ${buyer1PublicKey}, ${buyer2PublicKey}`);
  });

  test('should reject launch if buyer wallets have insufficient balance', async ({ page }) => {
    // Test that launch fails if buyers don't have enough SOL
    const devWallet = Keypair.generate();
    const buyerWallet = Keypair.generate();

    const mockWallets = [
      {
        publicKey: devWallet.publicKey.toBase58(),
        role: 'dev',
        solBalance: 0.05,
        tokenBalance: 0,
        isActive: true,
        secretKey: bs58.encode(devWallet.secretKey)
      },
      {
        publicKey: buyerWallet.publicKey.toBase58(),
        role: 'buyer',
        solBalance: 0.002, // Insufficient balance (< 0.032 mentioned in bug)
        tokenBalance: 0,
        isActive: true,
        secretKey: bs58.encode(buyerWallet.secretKey)
      }
    ];

    await page.route('**/api/bundler/wallets?action=load-all', async route =>
      route.fulfill({ json: { wallets: mockWallets } }));

    await page.route('**/api/network', async route =>
      route.fulfill({ json: { network: 'mainnet-beta', pumpFunAvailable: true, rpcHealthy: true } }));

    await page.goto('http://localhost:3000/dashboard');

    // Try to launch - should fail due to insufficient buyer balance
    const launchButton = page.getByRole('button', { name: /launch/i }).first();

    // Button should be disabled or show error
    await expect(launchButton).toBeDisabled();

    console.log('✅ Insufficient balance validation test passed');
  });
});