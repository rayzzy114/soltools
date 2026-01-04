import { describe, it, expect } from "vitest"
import { __testing } from "@/lib/solana/bundler-engine"

describe("buy distribution randomizer", () => {
  it("keeps the first buy deterministic and jitters the rest", () => {
    const { getRandomizedBuyAmount } = __testing
    const base = 1
    const randomizer = { enabled: true, min: 0.8, max: 1.2 }

    const first = getRandomizedBuyAmount(0, base, randomizer)
    expect(first).toBe(base)

    const jittered = Array.from({ length: 5 }, (_, idx) => getRandomizedBuyAmount(idx + 1, base, randomizer))
    jittered.forEach((amount) => {
      expect(amount).toBeGreaterThanOrEqual(randomizer.min as number)
      expect(amount).toBeLessThanOrEqual(randomizer.max as number)
    })
  })
})
