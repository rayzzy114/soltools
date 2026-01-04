import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { withdrawToSnipers, __testing } from "@/lib/cex/okx-funding"

const { randomInRange } = __testing

describe("randomInRange", () => {
  it("returns min when max is less than or equal to min", () => {
    expect(randomInRange(1, 1)).toBe(1)
    expect(randomInRange(2, 1)).toBe(2)
  })
})

describe("withdrawToSnipers", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("sends jittered withdrawals across wallets", async () => {
    const client = { withdraw: vi.fn().mockResolvedValue({}) } as any
    const mathSpy = vi.spyOn(Math, "random")
    // amount1(min), delay1(min), amount2(mid), delay2(max)
    mathSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(1)

    const promise = withdrawToSnipers(client, ["wallet-1", "wallet-2"], {
      minAmount: 0.3,
      maxAmount: 0.5,
      minDelayMs: 1000,
      maxDelayMs: 1000,
      fee: 0.02,
    })

    await vi.runAllTimersAsync()
    await promise

    expect(client.withdraw).toHaveBeenCalledTimes(2)
    expect(client.withdraw).toHaveBeenNthCalledWith(1, "SOL", 0.3, "wallet-1", undefined, {
      dest: "4",
      fee: 0.02,
    })
    expect(client.withdraw).toHaveBeenNthCalledWith(2, "SOL", expect.any(Number), "wallet-2", undefined, {
      dest: "4",
      fee: 0.02,
    })
    const secondAmount = (client.withdraw as any).mock.calls[1][1]
    expect(secondAmount).toBeGreaterThanOrEqual(0.3)
    expect(secondAmount).toBeLessThanOrEqual(0.5)
  })
})
