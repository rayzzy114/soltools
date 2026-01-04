import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { withdrawToSnipers, createOkxClient } from "../../lib/cex/okx-funding"
import { connection } from "../../lib/solana/config"
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js"

// Mock dependencies
vi.mock("../../lib/solana/config", () => ({
  connection: {
    getBalance: vi.fn(),
  },
}))

vi.mock("ccxt", () => {
  const mockWithdraw = vi.fn()
  const MockOkx = vi.fn(() => ({
    withdraw: mockWithdraw,
    fetch2: vi.fn(),
  }))
  return {
    default: {
      okx: MockOkx,
    },
    okx: MockOkx,
  }
})

describe("withdrawToSnipers", () => {
  let client: any
  // Use valid base58 keys
  const walletA = Keypair.generate().publicKey.toBase58()
  const walletB = Keypair.generate().publicKey.toBase58()

  beforeEach(() => {
    client = createOkxClient()
    vi.clearAllMocks()
    // Default mock implementation for getBalance to return 0 (needs funding)
    ;(connection.getBalance as any).mockResolvedValue(0)
  })

  it("should withdraw funds to wallets with low balance", async () => {
    const wallets = [walletA, walletB]
    // Mock getBalance: WalletA has 0 SOL, WalletB has 0 SOL
    ;(connection.getBalance as any).mockResolvedValue(0)
    // Mock withdraw success
    client.withdraw.mockResolvedValue({ id: "123" })

    const result = await withdrawToSnipers(client, wallets, {
      minAmount: 0.1,
      maxAmount: 0.1,
      minDelayMs: 0,
      maxDelayMs: 0,
    })

    expect(result.success).toEqual(wallets)
    expect(result.failed).toEqual([])
    expect(client.withdraw).toHaveBeenCalledTimes(2)
    // Check that getBalance was called for each wallet
    expect(connection.getBalance).toHaveBeenCalledTimes(2)
  })

  it("should skip wallets that are already funded (idempotency)", async () => {
    const wallets = [walletA, walletB]

    // Better mock approach for specific values
    const getBalanceMock = connection.getBalance as any
    getBalanceMock
      .mockResolvedValueOnce(1 * LAMPORTS_PER_SOL) // WalletA
      .mockResolvedValueOnce(0) // WalletB

    client.withdraw.mockResolvedValue({ id: "123" })

    const result = await withdrawToSnipers(client, wallets, {
      minAmount: 0.1,
      maxAmount: 0.1,
      minDelayMs: 0,
      maxDelayMs: 0,
    })

    expect(result.success).toEqual([walletA, walletB]) // Both successful (one skipped, one funded)
    expect(client.withdraw).toHaveBeenCalledTimes(1) // Only one withdrawal call
  })

  it("should handle withdrawal errors gracefully and return failure report", async () => {
    const wallets = [walletA, walletB]
    ;(connection.getBalance as any).mockResolvedValue(0)

    // First call fails, second succeeds
    client.withdraw
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockResolvedValueOnce({ id: "456" })

    const result = await withdrawToSnipers(client, wallets, {
      minAmount: 0.1,
      maxAmount: 0.1,
      minDelayMs: 0,
      maxDelayMs: 0,
    })

    expect(result.success).toEqual([walletB])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].address).toBe(walletA)
    expect(result.failed[0].error).toContain("Network Error")
  })

  it("should generate clientOrderId when prefix is provided", async () => {
    const wallets = [walletA]
    ;(connection.getBalance as any).mockResolvedValue(0)
    client.withdraw.mockResolvedValue({ id: "123" })

    await withdrawToSnipers(client, wallets, {
      minAmount: 0.1,
      maxAmount: 0.1,
      minDelayMs: 0,
      maxDelayMs: 0,
      clientOrderIdPrefix: "test-session",
    })

    expect(client.withdraw).toHaveBeenCalledWith(
      "SOL",
      expect.any(Number),
      walletA,
      undefined,
      expect.objectContaining({
        clientId: expect.stringContaining("test-session"),
      })
    )
  })
})
