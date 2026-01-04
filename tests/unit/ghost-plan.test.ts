import { describe, it, expect } from "vitest"
import { __testing } from "@/lib/solana/bundler-engine"

const { planGhostBundles } = __testing

describe("planGhostBundles", () => {
  it("chunks wallets and rotates regions", () => {
    const wallets = Array.from({ length: 7 }, (_, i) => `wallet-${i}`)
    const { chunks, regions } = planGhostBundles(wallets, ["ny", "tokyo"], 3, "frankfurt")

    expect(chunks.length).toBe(3)
    expect(chunks[0]).toEqual(["wallet-0", "wallet-1", "wallet-2"])
    expect(chunks[1]).toEqual(["wallet-3", "wallet-4", "wallet-5"])
    expect(chunks[2]).toEqual(["wallet-6"])
    expect(regions).toEqual(["ny", "tokyo", "ny"])
  })
})
