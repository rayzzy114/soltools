import { describe, it, expect, vi, beforeEach } from "vitest"
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js"

const mockFindUnique = vi.fn()
const mockUpsert = vi.fn()

const mockConnection = {
  getAddressLookupTable: vi.fn().mockResolvedValue({ value: null }),
  getSlot: vi.fn().mockResolvedValue(10),
  getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "test-blockhash", lastValidBlockHeight: 123 }),
  sendTransaction: vi.fn().mockResolvedValue("sig"),
  confirmTransaction: vi.fn().mockResolvedValue({}),
  simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lookupTableCache: {
      findUnique: mockFindUnique,
      upsert: mockUpsert,
    },
  },
}))

vi.mock("@/lib/solana/config", () => ({
  connection: mockConnection,
  SOLANA_NETWORK: "localnet",
}))

vi.mock("@/lib/solana/jito", () => ({
  JITO_ENDPOINTS: { frankfurt: "" },
  createTipInstruction: () =>
    SystemProgram.transfer({ fromPubkey: PublicKey.default, toPubkey: PublicKey.default, lamports: 1 }),
  sendBundle: vi.fn().mockResolvedValue({ bundleId: "bundle-1" }),
}))

vi.mock("@/lib/solana/pumpfun-sdk", () => ({
  getPumpfunGlobalState: vi.fn().mockResolvedValue({
    initialVirtualTokenReserves: 1_000_000n,
    initialVirtualSolReserves: 1_000_000n,
    initialRealTokenReserves: 0n,
    tokenTotalSupply: 1_000_000n,
  }),
  calculateBuyAmount: () => ({ tokensOut: 1n }),
  isPumpFunAvailable: () => true,
  PUMPFUN_BUY_FEE_BPS: 100,
}))

vi.mock("@/lib/solana/pumpfun", () => ({
  createBuyInstruction: vi.fn().mockResolvedValue(new TransactionInstruction({ keys: [], programId: SystemProgram.programId })),
  createSellInstruction: vi.fn(),
  createPumpFunCreateInstruction: vi
    .fn()
    .mockReturnValue(new TransactionInstruction({ keys: [], programId: SystemProgram.programId })),
}))

vi.mock("@/lib/solana/sell-plan", () => ({ buildSellPlan: vi.fn() }))

vi.mock("@/lib/solana/jito-tip", () => ({ getTipInstruction: vi.fn() }))

describe("LUT cache persistence", () => {
  beforeEach(() => {
    mockFindUnique.mockReset()
    mockUpsert.mockReset()
  })

  it("persists to prisma and memory", async () => {
    const mod = await import("@/lib/solana/bundler-engine")
    const { __testing } = mod
    __testing.resetLutCache()

    const authorityKey = Keypair.generate().publicKey.toBase58()
    const lutAddress = Keypair.generate().publicKey

    await __testing.persistLutAddress(authorityKey, lutAddress)

    expect(mockUpsert).toHaveBeenCalled()
    const cached = await __testing.fetchCachedLutAddress(authorityKey)
    expect(cached?.toBase58()).toBe(lutAddress.toBase58())
  })

  it("reads from prisma when memory is cold", async () => {
    const mod = await import("@/lib/solana/bundler-engine")
    const { __testing } = mod
    __testing.resetLutCache()

    const authorityKey = Keypair.generate().publicKey.toBase58()
    const lutAddress = Keypair.generate().publicKey

    mockFindUnique.mockResolvedValue({ authorityPublicKey: authorityKey, lutAddress: lutAddress.toBase58() })

    const fetched = await __testing.fetchCachedLutAddress(authorityKey)
    expect(mockFindUnique).toHaveBeenCalled()
    expect(fetched?.toBase58()).toBe(lutAddress.toBase58())
  })
})

describe("comment bot instructions", () => {
  it("places memo before jito tip", async () => {
    const mod = await import("@/lib/solana/bundler-engine")
    const { buildCommentInstructions, MEMO_PROGRAM_ID } = mod

    const payer = Keypair.generate().publicKey
    const instructions = buildCommentInstructions(payer, "Bullish!", 0.001, "frankfurt")

    expect(instructions[0].programId.toBase58()).toBe(MEMO_PROGRAM_ID.toBase58())
    expect(instructions[instructions.length - 1].programId.toBase58()).toBe(SystemProgram.programId.toBase58())
  })
})
