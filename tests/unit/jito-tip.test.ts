import { describe, it, expect, vi } from "vitest"
import { estimateDynamicJitoTip } from "@/lib/solana/jito"

const mockConnection = (fees: number[] | null) => ({
  getRecentPrioritizationFees: vi.fn(async () => {
    if (fees === null) {
      throw new Error("network error")
    }
    return fees.map((prioritizationFee) => ({ prioritizationFee }))
  }),
})

describe("estimateDynamicJitoTip", () => {
  it("returns p75-based tip in SOL with multiplier", async () => {
    const conn = mockConnection([1, 2, 3, 4, 5]) as any
    const tip = await estimateDynamicJitoTip(conn, 1000, { multiplier: 1 })
    // p75 => 4 lamports/cu -> *1000 = 4000 lamports -> 0.000004 SOL
    expect(tip).toBeCloseTo(0.000004)
  })

  it("falls back to floor on RPC error", async () => {
    const conn = mockConnection(null) as any
    const tip = await estimateDynamicJitoTip(conn, 1000, { floorLamports: 5000 })
    expect(tip).toBeCloseTo(0.000005)
  })
})
