/**
 * Anti-Detection System Unit Tests
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  DEFAULT_ANTI_DETECTION,
  STEALTH_ANTI_DETECTION,
  FAST_ANTI_DETECTION,
  randomizeAmount,
  getRandomDelay,
  getRandomPriorityFee,
  getRandomSlippage,
  splitAmount,
  calculateBatchSizes,
  applyAntiDetection,
  RateLimiter,
  type AntiDetectionConfig,
} from "@/lib/solana/anti-detection"

describe("Anti-Detection System", () => {
  // ═══════════════════════════════════════════════════════════════════
  // CONFIG PRESETS
  // ═══════════════════════════════════════════════════════════════════
  describe("Config Presets", () => {
    it("should have valid default config", () => {
      expect(DEFAULT_ANTI_DETECTION.randomizeAmounts).toBe(true)
      expect(DEFAULT_ANTI_DETECTION.amountVariationPercent).toBe(15)
      expect(DEFAULT_ANTI_DETECTION.maxTransactionsPerMinute).toBe(10)
    })

    it("should have valid stealth config", () => {
      expect(STEALTH_ANTI_DETECTION.randomizeAmounts).toBe(true)
      expect(STEALTH_ANTI_DETECTION.amountVariationPercent).toBe(25)
      expect(STEALTH_ANTI_DETECTION.maxTransactionsPerMinute).toBe(3)
      expect(STEALTH_ANTI_DETECTION.useMiddleWallets).toBe(true)
    })

    it("should have valid fast config", () => {
      expect(FAST_ANTI_DETECTION.randomizeAmounts).toBe(true)
      expect(FAST_ANTI_DETECTION.amountVariationPercent).toBe(5)
      expect(FAST_ANTI_DETECTION.maxTransactionsPerMinute).toBe(30)
      expect(FAST_ANTI_DETECTION.randomizeTiming).toBe(false)
    })

    it("stealth should be more conservative than default", () => {
      expect(STEALTH_ANTI_DETECTION.maxTransactionsPerMinute)
        .toBeLessThan(DEFAULT_ANTI_DETECTION.maxTransactionsPerMinute)
      expect(STEALTH_ANTI_DETECTION.minDelayMs)
        .toBeGreaterThan(DEFAULT_ANTI_DETECTION.minDelayMs)
    })

    it("fast should be less conservative than default", () => {
      expect(FAST_ANTI_DETECTION.maxTransactionsPerMinute)
        .toBeGreaterThan(DEFAULT_ANTI_DETECTION.maxTransactionsPerMinute)
      expect(FAST_ANTI_DETECTION.maxDelayMs)
        .toBeLessThan(DEFAULT_ANTI_DETECTION.maxDelayMs)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // randomizeAmount
  // ═══════════════════════════════════════════════════════════════════
  describe("randomizeAmount", () => {
    it("should return original amount when disabled", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        randomizeAmounts: false,
      }

      const result = randomizeAmount(1.0, config)
      expect(result).toBe(1.0)
    })

    it("should vary amount within configured range", () => {
      const config = DEFAULT_ANTI_DETECTION // 15% variation
      const baseAmount = 1.0

      // run multiple times to test randomness
      const results = Array(100).fill(0).map(() => randomizeAmount(baseAmount, config))
      
      const min = Math.min(...results)
      const max = Math.max(...results)

      // should be within +/- 15%
      expect(min).toBeGreaterThanOrEqual(0.85)
      expect(max).toBeLessThanOrEqual(1.15)
      
      // should have actual variation
      expect(max - min).toBeGreaterThan(0.05)
    })

    it("should handle zero amount", () => {
      const result = randomizeAmount(0, DEFAULT_ANTI_DETECTION)
      expect(result).toBe(0)
    })

    it("should handle very small amounts", () => {
      const result = randomizeAmount(0.0001, DEFAULT_ANTI_DETECTION)
      expect(result).toBeGreaterThan(0)
      expect(result).toBeLessThan(0.001)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // getRandomDelay
  // ═══════════════════════════════════════════════════════════════════
  describe("getRandomDelay", () => {
    it("should return 0 when timing disabled", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        randomizeTiming: false,
      }

      const result = getRandomDelay(config)
      expect(result).toBe(0)
    })

    it("should return delay within range", () => {
      const results = Array(50).fill(0).map(() => getRandomDelay(DEFAULT_ANTI_DETECTION))
      
      const min = Math.min(...results)
      const max = Math.max(...results)

      expect(min).toBeGreaterThanOrEqual(DEFAULT_ANTI_DETECTION.minDelayMs)
      expect(max).toBeLessThanOrEqual(DEFAULT_ANTI_DETECTION.maxDelayMs)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // getRandomPriorityFee
  // ═══════════════════════════════════════════════════════════════════
  describe("getRandomPriorityFee", () => {
    it("should return average when disabled", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        randomizePriorityFee: false,
      }

      const result = getRandomPriorityFee(config)
      const expected = (config.minPriorityFee + config.maxPriorityFee) / 2
      expect(result).toBe(expected)
    })

    it("should return fee within range", () => {
      const results = Array(50).fill(0).map(() => getRandomPriorityFee(DEFAULT_ANTI_DETECTION))
      
      const min = Math.min(...results)
      const max = Math.max(...results)

      expect(min).toBeGreaterThanOrEqual(DEFAULT_ANTI_DETECTION.minPriorityFee)
      expect(max).toBeLessThanOrEqual(DEFAULT_ANTI_DETECTION.maxPriorityFee)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // getRandomSlippage
  // ═══════════════════════════════════════════════════════════════════
  describe("getRandomSlippage", () => {
    it("should return minSlippage when disabled", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        randomizeSlippage: false,
      }

      const result = getRandomSlippage(config)
      expect(result).toBe(config.minSlippage)
    })

    it("should return slippage within range", () => {
      const results = Array(50).fill(0).map(() => getRandomSlippage(DEFAULT_ANTI_DETECTION))
      
      const min = Math.min(...results)
      const max = Math.max(...results)

      expect(min).toBeGreaterThanOrEqual(DEFAULT_ANTI_DETECTION.minSlippage)
      expect(max).toBeLessThanOrEqual(DEFAULT_ANTI_DETECTION.maxSlippage)
    })

    it("should return integers", () => {
      const results = Array(20).fill(0).map(() => getRandomSlippage(DEFAULT_ANTI_DETECTION))
      
      results.forEach(r => {
        expect(Number.isInteger(r)).toBe(true)
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // splitAmount
  // ═══════════════════════════════════════════════════════════════════
  describe("splitAmount", () => {
    it("should not split below threshold", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        splitLargeAmounts: true,
        splitThreshold: 1.0,
      }

      const chunks = splitAmount(0.5, config)
      expect(chunks.length).toBe(1)
      expect(chunks[0]).toBe(0.5)
    })

    it("should not split when disabled", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        splitLargeAmounts: false,
        splitThreshold: 1.0,
      }

      const chunks = splitAmount(5.0, config)
      expect(chunks.length).toBe(1)
    })

    it("should split large amounts into multiple chunks", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        splitLargeAmounts: true,
        splitThreshold: 1.0,
      }

      const chunks = splitAmount(5.0, config)
      
      expect(chunks.length).toBeGreaterThan(1)
      
      // sum should equal total (approximately, due to rounding)
      const sum = chunks.reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(5.0, 1)
    })

    it("should create chunks within expected range", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        splitLargeAmounts: true,
        splitThreshold: 1.0,
      }

      const chunks = splitAmount(10.0, config)
      
      // each chunk should be less than threshold
      chunks.forEach(chunk => {
        expect(chunk).toBeLessThanOrEqual(config.splitThreshold * 0.5) // max ~50% of threshold
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // calculateBatchSizes
  // ═══════════════════════════════════════════════════════════════════
  describe("calculateBatchSizes", () => {
    it("should split transactions into batches", () => {
      const batches = calculateBatchSizes(10, DEFAULT_ANTI_DETECTION)
      
      expect(batches.length).toBeGreaterThan(0)
      
      // sum should equal total
      const sum = batches.reduce((a, b) => a + b, 0)
      expect(sum).toBe(10)
    })

    it("should respect maxTransactionsPerBlock", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        maxTransactionsPerBlock: 2,
      }

      const batches = calculateBatchSizes(10, config)
      
      batches.forEach(batch => {
        expect(batch).toBeLessThanOrEqual(2)
      })
    })

    it("should handle single transaction", () => {
      const batches = calculateBatchSizes(1, DEFAULT_ANTI_DETECTION)
      
      expect(batches.length).toBe(1)
      expect(batches[0]).toBe(1)
    })

    it("should handle zero transactions", () => {
      const batches = calculateBatchSizes(0, DEFAULT_ANTI_DETECTION)
      expect(batches.length).toBe(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // applyAntiDetection
  // ═══════════════════════════════════════════════════════════════════
  describe("applyAntiDetection", () => {
    it("should return all modified parameters", () => {
      const params = {
        amount: 1.0,
        slippage: 10,
        priorityFee: 0.0005,
      }

      const result = applyAntiDetection(params, DEFAULT_ANTI_DETECTION)

      expect(result).toHaveProperty("amount")
      expect(result).toHaveProperty("slippage")
      expect(result).toHaveProperty("priorityFee")
      expect(result).toHaveProperty("delayMs")
    })

    it("should apply randomization", () => {
      const params = {
        amount: 1.0,
        slippage: 10,
        priorityFee: 0.0005,
      }

      // run multiple times
      const results = Array(20).fill(0).map(() => 
        applyAntiDetection(params, DEFAULT_ANTI_DETECTION)
      )

      const amounts = results.map(r => r.amount)
      const uniqueAmounts = new Set(amounts)

      // should have variation
      expect(uniqueAmounts.size).toBeGreaterThan(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // RateLimiter
  // ═══════════════════════════════════════════════════════════════════
  describe("RateLimiter", () => {
    it("should track transactions", async () => {
      const limiter = new RateLimiter({
        ...FAST_ANTI_DETECTION,
        maxTransactionsPerMinute: 100,
      })

      await limiter.waitForSlot()
      await limiter.waitForSlot()
      await limiter.waitForSlot()

      const stats = limiter.getStats()
      expect(stats.transactionsLastMinute).toBe(3)
    })

    it("should report remaining capacity", () => {
      const limiter = new RateLimiter({
        ...DEFAULT_ANTI_DETECTION,
        maxTransactionsPerMinute: 10,
      })

      const stats = limiter.getStats()
      expect(stats.remainingCapacity).toBe(10)
    })

    it("should have correct initial state", () => {
      const limiter = new RateLimiter(DEFAULT_ANTI_DETECTION)
      
      const stats = limiter.getStats()
      expect(stats.transactionsLastMinute).toBe(0)
      expect(stats.remainingCapacity).toBe(DEFAULT_ANTI_DETECTION.maxTransactionsPerMinute)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // Edge Cases
  // ═══════════════════════════════════════════════════════════════════
  describe("Edge Cases", () => {
    it("should handle very large amounts", () => {
      const result = randomizeAmount(1000000, DEFAULT_ANTI_DETECTION)
      expect(result).toBeGreaterThan(0)
      expect(Number.isFinite(result)).toBe(true)
    })

    it("should handle negative amounts", () => {
      // should still work, though negative amounts don't make sense
      const result = randomizeAmount(-1, DEFAULT_ANTI_DETECTION)
      expect(Number.isFinite(result)).toBe(true)
    })

    it("should handle config with 0 variation", () => {
      const config: AntiDetectionConfig = {
        ...DEFAULT_ANTI_DETECTION,
        amountVariationPercent: 0,
      }

      const result = randomizeAmount(1.0, config)
      expect(result).toBe(1.0)
    })
  })
})
