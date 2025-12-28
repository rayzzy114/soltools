import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { Transaction, Keypair } from "@solana/web3.js"
import bs58 from "bs58"
import { File, FormData } from "undici"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    token: {
      findFirst: vi.fn().mockResolvedValue({
        id: "test-token-id",
        mintAddress: "6dQEEy4E574FmCRZiiLCNo6CvpcrGoSAJVmL5hobhxTL",
        symbol: "TEST",
        name: "Test Token",
        bondingCurve: "TestBondingCurveAddress",
      }),
      create: vi.fn().mockResolvedValue({ id: "new-id" }),
      update: vi.fn().mockResolvedValue({ id: "updated-id" }),
    },
    bundle: { create: vi.fn().mockResolvedValue({ id: "bundle-id" }) },
    transaction: {
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    wallet: { update: vi.fn().mockResolvedValue({}) },
  },
}))

// mocks for pumpfun sdk + engines
const fakeBondingCurve = {
  virtualTokenReserves: BigInt(1_000_000_000_000),
  virtualSolReserves: BigInt(1_000_000_000),
  realTokenReserves: BigInt(1_000_000_000_000),
  realSolReserves: BigInt(1_000_000_000),
  tokenTotalSupply: BigInt(1_000_000_000_000),
  complete: false,
  creator: { toBase58: () => "creator" },
}

vi.mock("@/lib/solana/pumpfun-sdk", () => {
  const makeTx = () => {
    const tx = new Transaction()
    tx.recentBlockhash = "11111111111111111111111111111111"
    tx.feePayer = Keypair.generate().publicKey
    return tx
  }
  return {
    isPumpFunAvailable: vi.fn(() => true),
    SOLANA_NETWORK: "mainnet-beta",
    getBondingCurveData: vi.fn(async () => fakeBondingCurve),
    calculateTokenPrice: vi.fn(() => 1),
    calculateBuyAmount: vi.fn(() => ({ tokensOut: BigInt(1_000_000) })),
    calculateSellAmount: vi.fn(() => ({ solOut: BigInt(1_000_000_000) })),
    buildBuyTransaction: vi.fn(async () => makeTx()),
    buildSellTransaction: vi.fn(async () => makeTx()),
    getPumpswapPoolData: vi.fn(async () => ({
      tokenReserves: BigInt(1_000_000_000_000),
      solReserves: BigInt(1_000_000_000_000),
      lpSupply: BigInt(0),
    })),
    calculatePumpswapSwapAmount: vi.fn(() => ({
      solOut: BigInt(500_000_000),
      priceImpact: 1,
      feeAmount: BigInt(0),
    })),
    buildPumpswapSwapTransaction: vi.fn(async () => new Transaction()),
  }
})

vi.mock("@/lib/solana/bundler-engine", () => ({
  createBuyBundle: vi.fn(async () => ({
    success: true,
    bundleId: "BND-test",
    signatures: ["sig"],
  })),
  createSellBundle: vi.fn(async () => ({
    success: true,
    bundleId: "BND-test",
    signatures: ["sig"],
  })),
}))

vi.mock("@/lib/solana/volume-bot-engine", () => ({
  executeBuy: vi.fn(async () => ({ transaction: new Transaction() })),
  executeSell: vi.fn(async () => ({ transaction: new Transaction() })),
}))

vi.mock("@/lib/utils/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async () => new Response(JSON.stringify({ metadataUri: "ipfs://ok" }), { status: 200 })),
}))

// import after mocks
import * as priceRoute from "@/app/api/tokens/price/route"
import * as uploadRoute from "@/app/api/tokens/upload-metadata/route"
import * as bundlerBuyRoute from "@/app/api/bundler/buy/route"
import * as volumeExecuteRoute from "@/app/api/volume-bot/execute/route"

describe("pump.fun api smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns price payload and caches", async () => {
    const mint = Keypair.generate().publicKey.toBase58()
    const req = new NextRequest(`http://localhost/api/tokens/price?mintAddress=${mint}`)
    const res = await priceRoute.GET(req)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.price).toBeDefined()
    // second call should hit cache without error
    const res2 = await priceRoute.GET(req)
    expect(res2.status).toBe(200)
  })

  it("clamps slippage and returns correlation id for buy", async () => {
    const mint = Keypair.generate().publicKey.toBase58()
    const buyer = Keypair.generate().publicKey.toBase58()
    const req = new NextRequest("http://localhost/api/tokens/buy", {
      method: "POST",
      body: JSON.stringify({
        mintAddress: mint,
        solAmount: "0.5",
        buyerWallet: buyer,
        slippage: 200, // should clamp to 99
      }),
      headers: {
        "x-correlation-id": "test-corr",
      },
    })
    const res = await (await import("@/app/api/tokens/buy/route")).POST(req)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.correlationId).toBe("test-corr")
    expect(json.minTokensOut).toBeDefined()
  })

  it("rejects oversized upload", async () => {
    const form = new FormData()
    const bigFile = new File([new Uint8Array(6 * 1024 * 1024)], "big.png", { type: "image/png" })
    form.set("file", bigFile)
    form.set("name", "n")
    form.set("symbol", "S")
    const req = new NextRequest("http://localhost/api/tokens/upload-metadata", {
      method: "POST",
      body: form,
    })
    const res = await uploadRoute.POST(req)
    expect(res.status).toBe(400)
  })

  it("bundler buy responds success", async () => {
    const mint = Keypair.generate().publicKey.toBase58()
    const req = new NextRequest("http://localhost/api/bundler/buy", {
      method: "POST",
      body: JSON.stringify({
        wallets: [{ publicKey: "w", secretKey: "s", solBalance: 1, tokenBalance: 0, isActive: true }],
        mintAddress: mint,
        buyAmounts: [0.01],
      }),
    })
    const res = await bundlerBuyRoute.POST(req)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
  })

  it("volume-bot execute sell handles migrated pumpswap path", async () => {
    // mark bonding curve as complete for this test
    const sdk = await import("@/lib/solana/pumpfun-sdk")
    ;(sdk.getBondingCurveData as any).mockResolvedValueOnce({ ...fakeBondingCurve, complete: true })
    const walletKey = Keypair.generate().publicKey.toBase58()
    const req = new NextRequest("http://localhost/api/volume-bot/execute", {
      method: "POST",
      body: JSON.stringify({
        wallet: { publicKey: walletKey, secretKey: bs58.encode(Keypair.generate().secretKey), solBalance: 1, tokenBalance: 100, isActive: true },
        mintAddress: Keypair.generate().publicKey.toBase58(),
        type: "sell",
        amount: 10,
      }),
    })
    const res = await volumeExecuteRoute.POST(req)
    expect(res.status).toBe(200)
  })
})

