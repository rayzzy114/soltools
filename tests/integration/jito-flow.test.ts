import { describe, it, expect, vi } from "vitest"
import { Connection, Keypair } from "@solana/web3.js"
import bs58 from "bs58"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    transaction: { create: vi.fn() },
    wallet: { update: vi.fn() },
  },
}))

vi.mock("@/lib/solana/jito", () => ({
  createTipInstruction: vi.fn(() => null),
  sendBundle: vi.fn(async () => {
    throw new Error("sendBundle skipped")
  }),
  getInflightBundleStatusesWithFallback: vi.fn(),
}))

describe("Jito flow integration", () => {
  it("simulates a buy transaction before bundle send", async () => {
    const { VolumeBotPairEngine } = await import("@/lib/solana/volume-bot-engine")
    const rpcUrl = process.env.SOLANA_RPC_URL || process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com"
    console.log("RPC URL:", rpcUrl.split("?")[0])
    const connection = new Connection(rpcUrl, "confirmed")
    const simulateSpy = vi.spyOn(connection, "simulateTransaction")

    const secretRaw = process.env.TEST_WALLET_SECRET ?? ""
    const secretKey = secretRaw.trim().replace(/^['"]|['"]$/g, "").replace(/\s/g, "")
    if (!secretKey) {
      throw new Error("TEST_WALLET_SECRET is missing or empty")
    }

    let keypair: Keypair
    try {
      keypair = Keypair.fromSecretKey(bs58.decode(secretKey))
    } catch (error: any) {
      throw new Error(`Invalid TEST_WALLET_SECRET: ${error?.message || error}`)
    }

    console.log("Test wallet pubkey:", keypair.publicKey.toBase58())
    try {
      await connection.getBalance(keypair.publicKey)
    } catch (error: any) {
      throw new Error(`RPC auth failed while reading balance: ${error?.message || error}`)
    }

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
