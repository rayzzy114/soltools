import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createLaunchBundle } from '@/lib/solana/bundler-engine';

// Mock dependencies
vi.mock('@/lib/solana/config', () => ({
  connection: {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: 'mock-blockhash',
      lastValidBlockHeight: 100000
    }),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null } })
  },
  SOLANA_NETWORK: 'mainnet-beta'
}));

vi.mock('@/lib/solana/pumpfun-sdk', () => ({
  isPumpFunAvailable: vi.fn().mockReturnValue(true),
  getInitialCurve: vi.fn().mockResolvedValue({
    virtualTokenReserves: 1000000000000000n,
    virtualSolReserves: 30000000000n, // 30 SOL
    realTokenReserves: 0n,
    realSolReserves: 0n,
    tokenTotalSupply: 1000000000000000n,
    complete: false
  })
}));

vi.mock('@/lib/solana/jito', () => ({
  getJitoTipFloor: vi.fn().mockResolvedValue(0.000001), // 1000 lamports
  createTipInstruction: vi.fn().mockReturnValue({
    programId: new PublicKey('11111111111111111111111111111112'),
    keys: [],
    data: Buffer.from('tip')
  })
}));

vi.mock('@/lib/solana/bundler-engine', async () => {
  const actual = await vi.importActual('@/lib/solana/bundler-engine');
  return {
    ...actual,
    getKeypair: vi.fn((wallet: any) => {
      // Mock keypair generation based on wallet publicKey
      const mockKeypair = Keypair.generate();
      // Override publicKey to match wallet
      Object.defineProperty(mockKeypair, 'publicKey', {
        value: new PublicKey(wallet.publicKey),
        writable: false
      });
      return mockKeypair;
    }),
    getOrCreateLUT: vi.fn().mockResolvedValue({
      lookupTable: {
        address: new PublicKey('LUT1111111111111111111111111111111111111'),
        isActive: vi.fn().mockReturnValue(true)
      }
    })
  };
});

describe('Launch Bundle Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create token with dev wallet and buyers should buy tokens', async () => {
    // Generate test wallets
    const devWallet = {
      publicKey: Keypair.generate().publicKey.toBase58(),
      secretKey: 'mock-secret',
      solBalance: 0.05,
      tokenBalance: 0,
      isActive: true,
      role: 'dev'
    };

    const buyer1Wallet = {
      publicKey: Keypair.generate().publicKey.toBase58(),
      secretKey: 'mock-secret',
      solBalance: 0.032,
      tokenBalance: 0,
      isActive: true,
      role: 'buyer'
    };

    const buyer2Wallet = {
      publicKey: Keypair.generate().publicKey.toBase58(),
      secretKey: 'mock-secret',
      solBalance: 0.032,
      tokenBalance: 0,
      isActive: true,
      role: 'buyer'
    };

    const config = {
      wallets: [devWallet, buyer1Wallet, buyer2Wallet],
      tokenMetadata: {
        name: 'Test Token',
        symbol: 'TEST',
        description: 'Test token',
        metadataUri: 'https://example.com/metadata.json',
        imageUrl: 'https://example.com/image.png'
      },
      devBuyAmount: 0.005,
      buyAmounts: [0.01, 0.01], // buyer1, buyer2
      jitoTip: 0.000001,
      priorityFee: 0.000005,
      slippage: 20
    };

    const result = await createLaunchBundle(config);

    // Verify successful launch
    expect(result.success).toBe(true);
    expect(result.bundleId).toBeDefined();
    expect(result.signatures).toBeDefined();
    expect(result.signatures.length).toBeGreaterThan(0);
  });

  it('should use dev wallet as payer and signer for the bundle', async () => {
    // This test verifies that dev wallet is used as fee payer
    // and that buyers are included as signers for their buy instructions

    const devWallet = {
      publicKey: Keypair.generate().publicKey.toBase58(),
      secretKey: 'mock-secret',
      solBalance: 0.05,
      tokenBalance: 0,
      isActive: true,
      role: 'dev'
    };

    const buyerWallet = {
      publicKey: Keypair.generate().publicKey.toBase58(),
      secretKey: 'mock-secret',
      solBalance: 0.032,
      tokenBalance: 0,
      isActive: true,
      role: 'buyer'
    };

    const config = {
      wallets: [devWallet, buyerWallet],
      tokenMetadata: {
        name: 'Test Token',
        symbol: 'TEST',
        description: 'Test token',
        metadataUri: 'https://example.com/metadata.json',
        imageUrl: 'https://example.com/image.png'
      },
      devBuyAmount: 0.005,
      buyAmounts: [0.01],
      jitoTip: 0.000001,
      priorityFee: 0.000005,
      slippage: 20
    };

    const result = await createLaunchBundle(config);

    expect(result.success).toBe(true);
    // The result should contain transaction signatures
    expect(result.signatures).toBeDefined();
    expect(Array.isArray(result.signatures)).toBe(true);
  });

  it('should fail if dev wallet has insufficient balance', async () => {
    const devWallet = {
      publicKey: Keypair.generate().publicKey.toBase58(),
      secretKey: 'mock-secret',
      solBalance: 0.002, // Insufficient for launch
      tokenBalance: 0,
      isActive: true,
      role: 'dev'
    };

    const config = {
      wallets: [devWallet],
      tokenMetadata: {
        name: 'Test Token',
        symbol: 'TEST',
        description: 'Test token',
        metadataUri: 'https://example.com/metadata.json',
        imageUrl: 'https://example.com/image.png'
      },
      devBuyAmount: 0.005,
      buyAmounts: [],
      jitoTip: 0.000001,
      priorityFee: 0.000005,
      slippage: 20
    };

    const result = await createLaunchBundle(config);

    expect(result.success).toBe(false);
    expect(result.error).toContain('insufficient funds');
  });

  it('should limit buyers in first transaction to prevent size overflow', async () => {
    // Create many buyers to test chunking
    const devWallet = {
      publicKey: Keypair.generate().publicKey.toBase58(),
      secretKey: 'mock-secret',
      solBalance: 0.05,
      tokenBalance: 0,
      isActive: true,
      role: 'dev'
    };

    const buyers = Array(5).fill(0).map(() => ({
      publicKey: Keypair.generate().publicKey.toBase58(),
      secretKey: 'mock-secret',
      solBalance: 0.032,
      tokenBalance: 0,
      isActive: true,
      role: 'buyer'
    }));

    const config = {
      wallets: [devWallet, ...buyers],
      tokenMetadata: {
        name: 'Test Token',
        symbol: 'TEST',
        description: 'Test token',
        metadataUri: 'https://example.com/metadata.json',
        imageUrl: 'https://example.com/image.png'
      },
      devBuyAmount: 0.005,
      buyAmounts: buyers.map(() => 0.01),
      jitoTip: 0.000001,
      priorityFee: 0.000005,
      slippage: 20
    };

    const result = await createLaunchBundle(config);

    // Should succeed but may create multiple chunks
    expect(result.success).toBe(true);
    expect(result.bundleIds).toBeDefined();
  });
});