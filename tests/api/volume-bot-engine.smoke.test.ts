import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<any>("@solana/web3.js")
  class SafePublicKey extends actual.PublicKey {
    constructor(value: any) {
      try {
        super(value)
      } catch {
        super("11111111111111111111111111111111")
      }
    }
  }
  return { ...actual, PublicKey: SafePublicKey }
})

vi.mock("@/lib/prisma", () => ({
  prisma: {
    transaction: { create: vi.fn() },
    wallet: {
      update: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

vi.mock("@/lib/solana/jito", async () => {
  const web3 = await vi.importActual<any>("@solana/web3.js")
  return {
    createTipInstruction: vi.fn(
      () =>
        new web3.TransactionInstruction({
          keys: [],
          programId: web3.SystemProgram.programId,
          data: Buffer.from([]),
        })
    ),
    sendBundle: vi.fn(async () => ({ bundleId: "bundle-1", region: "frankfurt" })),
    getInflightBundleStatusesWithFallback: vi.fn(async () => [{ status: "landed" }]),
  }
})

vi.mock("@/lib/solana/pumpfun-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/solana/pumpfun-sdk")>()
  const web3 = await vi.importActual<any>("@solana/web3.js")
  return {
    ...actual,
    buildBuyTransaction: vi.fn(async () => new web3.Transaction()),
    buildSellTransaction: vi.fn(async () => new web3.Transaction()),
    getBondingCurveData: vi.fn(async () => ({})),
    calculateBuyAmount: vi.fn(() => ({ tokensOut: BigInt(1000) })),
    calculateSellAmount: vi.fn(() => ({ solOut: BigInt(1000000) })),
  }
})

vi.mock("@/lib/solana/config", async () => {
  const { Connection } = await vi.importActual<any>("@solana/web3.js")
  const rpc =
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_ENDPOINT ||
    "https://api.mainnet-beta.solana.com"
  return {
    getResilientConnection: async () => new Connection(rpc, "confirmed"),
    SOLANA_NETWORK: "mainnet-beta",
  }
})

describe("VolumeBotPairEngine smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("sends bundle and records confirmed trade", async () => {
    const { VolumeBotPairEngine } = await import("@/lib/solana/volume-bot-engine")
    const { PublicKey } = await import("@solana/web3.js")
    const rawSecret = process.env.TEST_WALLET_SECRET ?? ""
    const secretKey = rawSecret.trim().replace(/^['"]|['"]$/g, "").replace(/\s/g, "")
    if (!secretKey) {
      return
    }
    const invalidChars = [...new Set(secretKey.replace(/[1-9A-HJ-NP-Za-km-z]/g, ""))]
    if (invalidChars.length > 0) {
      throw new Error(
        `TEST_WALLET_SECRET contains invalid base58 chars: ${invalidChars.join(",") || "unknown"}`
      )
    }
    try {
      const bs58 = (await import("bs58")).default
      bs58.decode(secretKey)
    } catch (error: any) {
      throw new Error(`TEST_WALLET_SECRET failed base58 decode: ${error?.message || error}`)
    }

    const wallet = {
      publicKey: "11111111111111111111111111111111",
      secretKey,
      solBalance: 1,
      tokenBalance: 100,
      isActive: true,
    }
    const config = {
      pairId: "pair-1",
      tokenId: "token-1",
      mintAddress: "So11111111111111111111111111111111111111112",
      settings: {
        mode: "buy",
        amountMode: "fixed",
        fixedAmount: "0.01",
        minAmount: "0.01",
        maxAmount: "0.02",
        slippage: "10",
        jitoTip: "0.0005",
        jitoRegion: "frankfurt",
      },
    }

    const prismaModule = await import("@/lib/prisma")
    ;(prismaModule.prisma.wallet.findMany as any).mockResolvedValue([
      {
        publicKey: wallet.publicKey,
        secretKey: wallet.secretKey,
        solBalance: "1",
        tokenBalance: "100",
        isActive: true,
      },
    ])

    const engine = new VolumeBotPairEngine(config)
    await engine.initialize()
    ;(engine as any).connection = {
      getAccountInfo: vi.fn(async () => ({
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      })),
      getLatestBlockhash: vi.fn(async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 1,
      })),
      simulateTransaction: vi.fn(async () => ({
        value: { err: null, logs: [] },
      })),
    }
    ;(engine as any).fetchWalletBalances = vi.fn(async () => ({
      solBalance: 1,
      tokenBalance: 100,
    }))
    ;(engine as any).updateWalletBalances = vi.fn(async () => {})

    await (engine as any).executeTrade(wallet, "buy", 0.01)

    const jito = await import("@/lib/solana/jito")
    expect(jito.sendBundle).toHaveBeenCalled()
    expect(jito.getInflightBundleStatusesWithFallback).toHaveBeenCalled()
    expect(prismaModule.prisma.transaction.create).toHaveBeenCalled()
    const createArgs = (prismaModule.prisma.transaction.create as any).mock.calls[0][0]
    expect(createArgs.data.status).toBe("confirmed")
  })
})
