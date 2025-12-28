import { describe, it, expect, vi, beforeEach } from "vitest"
import { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js"
vi.mock("bs58", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bs58")>()
  return {
    ...actual,
    decode: vi.fn(() => Keypair.generate().secretKey),
  }
})

vi.mock("@/lib/prisma", () => ({
  prisma: {
    transaction: { create: vi.fn() },
    wallet: { update: vi.fn() },
  },
}))

vi.mock("@/lib/solana/jito", () => ({
  createTipInstruction: vi.fn(
    () =>
      new TransactionInstruction({
        keys: [],
        programId: SystemProgram.programId,
        data: Buffer.from([]),
      })
  ),
  sendBundle: vi.fn(),
  getInflightBundleStatusesWithFallback: vi.fn(),
}))

vi.mock("@/lib/solana/pumpfun-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/solana/pumpfun-sdk")>()
  return {
    ...actual,
    buildBuyTransaction: vi.fn(async () => new Transaction()),
    buildSellTransaction: vi.fn(async () => new Transaction()),
    getBondingCurveData: vi.fn(async () => ({})),
    calculateBuyAmount: vi.fn(() => ({ tokensOut: BigInt(1000) })),
    calculateSellAmount: vi.fn(() => ({ solOut: BigInt(1000000) })),
  }
})

describe("VolumeBotPairEngine", () => {
  let wallet: {
    publicKey: string
    secretKey: string
    solBalance: number
    tokenBalance: number
    isActive: boolean
  }

  const config = {
    pairId: "pair-1",
    tokenId: "token-1",
    mintAddress: Keypair.generate().publicKey.toBase58(),
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

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("captures simulation errors with logs", async () => {
    const onLog = vi.fn()
    const { VolumeBotPairEngine, generateWallet } = await import("@/lib/solana/volume-bot-engine")
    wallet = {
      ...generateWallet(),
      solBalance: 1,
      tokenBalance: 100,
      isActive: true,
    }
    const engine = new VolumeBotPairEngine({ ...config, onLog })

    const connection = {
      getAccountInfo: vi.fn(async () => ({
        data: Buffer.from([]),
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        lamports: 1_000_000_000,
        executable: false,
        rentEpoch: 0,
      })),
      getLatestBlockhash: vi.fn(async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 123,
      })),
      simulateTransaction: vi.fn(async () => ({
        value: {
          err: { InstructionError: [0, "Custom"] },
          logs: ["Program log: fail", "Program log: detail"],
        },
      })),
    }

    ;(engine as any).connection = connection
    ;(engine as any).fetchWalletBalances = vi.fn(async () => ({
      solBalance: 1,
      tokenBalance: 100,
    }))

    await (engine as any).executeTrade(wallet, "buy", 0.01)

    expect(onLog).toHaveBeenCalled()
    const message = onLog.mock.calls.map((c) => c[1]).join(" ")
    expect(message).toContain("Simulation failed")
    expect(message).toContain("logs:")
  })
})
