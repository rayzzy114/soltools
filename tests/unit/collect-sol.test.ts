import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { collectSol, generateWallet } from '../../lib/solana/bundler-engine';
import { connection } from '../../lib/solana/config';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import * as jito from '../../lib/solana/jito';
import bs58 from 'bs58';

// Mock Jito
vi.mock('../../lib/solana/jito', async (importOriginal) => {
  const { TransactionInstruction, PublicKey } = await import('@solana/web3.js');
  const actual = await importOriginal();
  return {
    ...actual,
    sendBundle: vi.fn().mockResolvedValue({ bundleId: 'mock-bundle-id' }),
    createTipInstruction: vi.fn().mockReturnValue(new TransactionInstruction({
      keys: [],
      programId: new PublicKey('11111111111111111111111111111111'),
      data: Buffer.alloc(0),
    })),
  };
});

// Mock Config
vi.mock('../../lib/solana/config', () => {
  const mockConnection = {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100
    }),
    getMultipleAccountsInfo: vi.fn(),
    getBalance: vi.fn(),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ confirmationStatus: 'confirmed' }] }),
  };
  return {
    connection: mockConnection,
    SOLANA_NETWORK: 'mainnet-beta',
  };
});

describe('collectSol', () => {
  const recipient = new PublicKey('11111111111111111111111111111111'); // System program as dummy recipient

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should collect from rich wallets using Jito bundles', async () => {
    const wallets = Array.from({ length: 5 }, () => generateWallet());

    // Mock balances: 1 SOL each
    (connection.getMultipleAccountsInfo as any).mockResolvedValue(
      wallets.map(() => ({
        lamports: 1 * LAMPORTS_PER_SOL,
        data: Buffer.alloc(0),
        owner: new PublicKey('11111111111111111111111111111111'),
        executable: false,
      }))
    );

    // Mock getBalance fallback if needed
    (connection.getBalance as any).mockResolvedValue(1 * LAMPORTS_PER_SOL);

    const signatures = await collectSol(wallets, recipient);

    expect(signatures.length).toBe(5); // 5 signatures from 5 wallets
    expect(jito.sendBundle).toHaveBeenCalledTimes(1); // 1 bundle for 5 txs
  });

  it('should exclude wallets with insufficient funds for fees', async () => {
    const richWallet = generateWallet();
    const poorWallet = generateWallet(); // 0 balance
    const wallets = [richWallet, poorWallet];

    (connection.getMultipleAccountsInfo as any).mockResolvedValue([
      { lamports: 1 * LAMPORTS_PER_SOL }, // rich
      { lamports: 0 }, // poor
    ]);

    const signatures = await collectSol(wallets, recipient);

    expect(signatures.length).toBe(1);
    expect(jito.sendBundle).toHaveBeenCalledTimes(1);
  });

  it('should handle tip payment correctly (last wallet pays tip)', async () => {
    const w1 = generateWallet(); // 1 SOL
    const w2 = generateWallet(); // 0.0002 SOL (Fee 5000 + Tip 100000 = 105000 lamports = 0.000105 SOL). Enough.

    const wallets = [w1, w2];

    (connection.getMultipleAccountsInfo as any).mockResolvedValue([
      { lamports: 1 * LAMPORTS_PER_SOL },
      { lamports: 0.0002 * LAMPORTS_PER_SOL },
    ]);

    // collectSol sorts by balance. w2 has less, w1 has more.
    // Sorted: [w2, w1].
    // w1 is last. w1 pays tip.
    // w1 balance 1 SOL. Can pay.
    // w2 balance 0.0002 SOL. Can pay fee.

    const signatures = await collectSol(wallets, recipient);
    expect(signatures.length).toBe(2);
    expect(jito.sendBundle).toHaveBeenCalledTimes(1);
  });

  it('should skip chunk if richest wallet cannot pay tip', async () => {
    const w1 = generateWallet(); // 0.0001 SOL (Enough for fee, NOT fee+tip)
    const w2 = generateWallet(); // 0.0001 SOL
    const wallets = [w1, w2];

    // Tip 0.0001 + Fee 0.000005 = 0.000105.
    // Balance 0.0001 < 0.000105.
    // Richest (both equal) cannot pay.

    (connection.getMultipleAccountsInfo as any).mockResolvedValue([
      { lamports: 0.0001 * LAMPORTS_PER_SOL },
      { lamports: 0.0001 * LAMPORTS_PER_SOL },
    ]);

    const signatures = await collectSol(wallets, recipient);
    expect(signatures.length).toBe(0);
    expect(jito.sendBundle).not.toHaveBeenCalled();
  });

  it('should chunk 10 wallets into 2 bundles', async () => {
    const wallets = Array.from({ length: 10 }, () => generateWallet());
    (connection.getMultipleAccountsInfo as any).mockResolvedValue(
      wallets.map(() => ({ lamports: 1 * LAMPORTS_PER_SOL }))
    );

    const signatures = await collectSol(wallets, recipient);
    expect(signatures.length).toBe(10);
    expect(jito.sendBundle).toHaveBeenCalledTimes(2);
  });
});
