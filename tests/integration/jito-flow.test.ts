import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { Connection, Keypair, SystemProgram, PublicKey, Transaction } from "@solana/web3.js"
import bs58 from "bs58"
import { ensureLocalValidator } from "./helpers/local-validator"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    transaction: { create: vi.fn() },
    wallet: { update: vi.fn() },
  },
}))

vi.mock("@/lib/solana/pumpfun-sdk", () => ({
  getBondingCurveData: vi.fn().mockResolvedValue({
    virtualTokenReserves: 1_000_000n,
    virtualSolReserves: 1_000_000n,
    realTokenReserves: 1_000n,
    realSolReserves: 1_000n,
    tokenTotalSupply: 1_000_000n,
    complete: false,
    creator: PublicKey.default,
  }),
  calculateBuyAmount: () => ({ tokensOut: 1n, priceImpact: 0 }),
  isPumpFunAvailable: () => true,
  getPumpfunGlobalState: vi.fn(),
  PUMPFUN_BUY_FEE_BPS: 100,
  buildBuyTransaction: vi.fn().mockResolvedValue(new Transaction()),
  getBondingCurveAddress: () => new PublicKey("11111111111111111111111111111111"),
}))

vi.mock("@/lib/solana/jito", () => ({
  createTipInstruction: vi.fn((from: PublicKey) =>
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
      lamports: 1000,
    })
  ),
  sendBundle: vi.fn(async () => {
    throw new Error("sendBundle skipped")
  }),
  getInflightBundleStatusesWithFallback: vi.fn(),
}))

describe("Jito flow integration", () => {
  let validator: Awaited<ReturnType<typeof ensureLocalValidator>> | null = null

  beforeAll(async () => {
    validator = await ensureLocalValidator()
  })

  afterAll(async () => {
    await validator?.stop()
  })

  it("simulates a buy transaction before bundle send", async () => {
    const { VolumeBotPairEngine } = await import("@/lib/solana/volume-bot-engine")
    const connection = validator?.connection ?? new Connection("http://127.0.0.1:8899", "confirmed")
    const simulateSpy = vi.spyOn(connection, "simulateTransaction")

    const keypair = Keypair.generate()

    console.log("Test wallet pubkey:", keypair.publicKey.toBase58())
    const airdropSig = await connection.requestAirdrop(keypair.publicKey, 2_000_000_000)
    await connection.confirmTransaction(airdropSig, "confirmed")

    const mintAddress = "6dQEEy4E574FmCRZiiLCNo6CvpcrGoSAJVmL5hobhxTL"
    console.log("Test mint:", mintAddress)

    const engine = new VolumeBotPairEngine({
      pairId: "pair-1",
      tokenId: "token-1",
      mintAddress,
      settings: {
        mode: "buy",
        amountMode: "fixed",
        fixedAmount: "0.01",
        minAmount: "0.01",
        maxAmount: "0.02",
        slippage: "10",
        jitoTip: "0",
        jitoRegion: "frankfurt",
      },
    })

    ;(engine as any).connection = connection
    ;(engine as any).fetchWalletBalances = vi.fn(async () => ({
      solBalance: 1,
      tokenBalance: 100,
    }))

    try {
      await (engine as any).executeTrade(
        {
          publicKey: keypair.publicKey.toBase58(),
          secretKey: bs58.encode(keypair.secretKey),
          solBalance: 1,
          tokenBalance: 100,
          isActive: true,
        },
        "buy",
        0.01
      )
    } catch (error: any) {
      const message = error?.message || String(error)
      if (!/sendBundle skipped|Failed to build transaction|Failed to build tip instruction|Mint account not found/.test(message)) {
        throw error
      }
    }

    expect(simulateSpy).toHaveBeenCalled()
    const simResult = await simulateSpy.mock.results[0]?.value
    if (simResult?.value?.err) {
      const errStr = JSON.stringify(simResult.value.err)
      if (errStr.includes("AccountNotFound")) {
        console.warn("ACTION REQUIRED: Fund the test wallet with at least 0.01 SOL to pass simulation")
      }
      throw new Error(`simulateTransaction failed: ${errStr}`)
    }
  })
})
