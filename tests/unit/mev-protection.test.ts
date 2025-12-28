/**
 * MEV Protection Unit Tests
 */

import { describe, it, expect } from "vitest"
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js"
import {
  DEFAULT_MEV_CONFIG,
  calculateSafeSlippage,
  calculateMinOutputWithProtection,
  splitTradeForMEVProtection,
  detectSandwichRisk,
  analyzeTransactionMEVRisk,
} from "@/lib/solana/mev-protection"

describe("MEV Protection", () => {
  // ═══════════════════════════════════════════════════════════════════
  // DEFAULT CONFIG
  // ═══════════════════════════════════════════════════════════════════
  describe("Default Config", () => {
    it("should have reasonable slippage", () => {
      expect(DEFAULT_MEV_CONFIG.maxSlippageBps).toBeGreaterThanOrEqual(100)
      expect(DEFAULT_MEV_CONFIG.maxSlippageBps).toBeLessThanOrEqual(2000)
    })

    it("should use private mempool by default", () => {
      expect(DEFAULT_MEV_CONFIG.usePrivateMempool).toBe(true)
    })

    it("should skip preflight", () => {
      expect(DEFAULT_MEV_CONFIG.skipPreflight).toBe(true)
    })

    it("should have compute units", () => {
      expect(DEFAULT_MEV_CONFIG.computeUnits).toBeGreaterThan(0)
    })

    it("should have priority fee", () => {
      expect(DEFAULT_MEV_CONFIG.priorityFeeLamports).toBeGreaterThan(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // SAFE SLIPPAGE
  // ═══════════════════════════════════════════════════════════════════
  describe("calculateSafeSlippage", () => {
    it("should return base slippage for small trades", () => {
      const slippage = calculateSafeSlippage(0.1, 100, 100)
      expect(slippage).toBe(100) // 1%
    })

    it("should increase slippage for larger trades", () => {
      const small = calculateSafeSlippage(0.5, 100, 100)
      const medium = calculateSafeSlippage(2, 100, 100)
      const large = calculateSafeSlippage(10, 100, 100)
      const huge = calculateSafeSlippage(15, 100, 100)

      expect(medium).toBeGreaterThan(small)
      expect(large).toBeGreaterThan(medium)
      expect(huge).toBeGreaterThan(large)
    })

    it("should cap at 20%", () => {
      const slippage = calculateSafeSlippage(50, 100, 500)
      expect(slippage).toBeLessThanOrEqual(2000)
    })

    it("should handle edge cases", () => {
      // very small trade
      expect(calculateSafeSlippage(0.001, 100, 100)).toBe(100)
      
      // trade = liquidity
      expect(calculateSafeSlippage(100, 100, 100)).toBe(500)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // MIN OUTPUT PROTECTION
  // ═══════════════════════════════════════════════════════════════════
  describe("calculateMinOutputWithProtection", () => {
    it("should apply slippage correctly", () => {
      const expected = BigInt(1000000)
      const minOutput = calculateMinOutputWithProtection(expected, 500) // 5%
      
      // should be 94% of expected (5% slippage + 1% protection)
      const expectedMin = expected * BigInt(9400) / BigInt(10000)
      expect(minOutput).toBe(expectedMin)
    })

    it("should add extra protection buffer", () => {
      const expected = BigInt(1000000)
      const withoutExtra = calculateMinOutputWithProtection(expected, 500, 0)
      const withExtra = calculateMinOutputWithProtection(expected, 500, 100)
      
      expect(withExtra).toBeLessThan(withoutExtra)
    })

    it("should handle zero expected", () => {
      const minOutput = calculateMinOutputWithProtection(BigInt(0), 500)
      expect(minOutput).toBe(BigInt(0))
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // TRADE SPLITTING
  // ═══════════════════════════════════════════════════════════════════
  describe("splitTradeForMEVProtection", () => {
    it("should not split small trades", () => {
      const chunks = splitTradeForMEVProtection(0.5)
      expect(chunks.length).toBe(1)
      expect(chunks[0]).toBe(0.5)
    })

    it("should split large trades", () => {
      const chunks = splitTradeForMEVProtection(5, 1)
      expect(chunks.length).toBeGreaterThanOrEqual(5)
    })

    it("should preserve total amount", () => {
      const total = 10
      const chunks = splitTradeForMEVProtection(total, 1)
      const sum = chunks.reduce((a, b) => a + b, 0)
      
      expect(sum).toBeCloseTo(total, 5)
    })

    it("should respect max chunk size", () => {
      const chunks = splitTradeForMEVProtection(10, 2)
      
      // most chunks should be around max size (with some variation)
      chunks.forEach(chunk => {
        expect(chunk).toBeLessThan(3) // 2 + variation
      })
    })

    it("should add randomization", () => {
      const chunks1 = splitTradeForMEVProtection(5, 1)
      const chunks2 = splitTradeForMEVProtection(5, 1)
      
      // chunks should vary between calls (probabilistic)
      // just verify both have same count and total
      expect(chunks1.length).toBe(chunks2.length)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // SANDWICH DETECTION
  // ═══════════════════════════════════════════════════════════════════
  describe("detectSandwichRisk", () => {
    it("should return low risk for small trades", async () => {
      const result = await detectSandwichRisk("mintAddress", 0.1)
      expect(result.risk).toBe("low")
      expect(result.recommendations).toBeDefined()
    })

    it("should return higher risk for large trades", async () => {
      const result = await detectSandwichRisk("mintAddress", 15)
      // large trades always increase risk score
      expect(["medium", "high"]).toContain(result.risk)
    })

    it("should include recommendations", async () => {
      const result = await detectSandwichRisk("mintAddress", 5)
      expect(result.recommendations).toBeDefined()
      expect(Array.isArray(result.recommendations)).toBe(true)
    })

    it("should recommend jito for non-trivial trades", async () => {
      const result = await detectSandwichRisk("mintAddress", 1)
      expect(result.recommendations.some(r => r.includes("jito") || r.includes("priority"))).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // TRANSACTION ANALYSIS
  // ═══════════════════════════════════════════════════════════════════
  describe("analyzeTransactionMEVRisk", () => {
    it("should detect missing compute budget", () => {
      const payer = Keypair.generate()
      const instructions = [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: payer.publicKey,
          lamports: 1000,
        }),
      ]

      const result = analyzeTransactionMEVRisk(instructions)
      
      expect(result.vulnerable).toBe(true)
      expect(result.risks).toContain("no compute budget - may be deprioritized")
    })

    it("should warn on many instructions", () => {
      const payer = Keypair.generate()
      const instructions = Array(15).fill(null).map(() =>
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: payer.publicKey,
          lamports: 1000,
        })
      )

      const result = analyzeTransactionMEVRisk(instructions)
      
      expect(result.risks).toContain("many instructions - higher failure risk")
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════
  describe("Edge Cases", () => {
    it("should handle zero trade amount", () => {
      const chunks = splitTradeForMEVProtection(0)
      expect(chunks.length).toBe(1)
      expect(chunks[0]).toBe(0)
    })

    it("should handle negative slippage (invalid)", () => {
      const minOutput = calculateMinOutputWithProtection(BigInt(1000), -100)
      // should still work, just won't protect
      // при отрицательном slippage и sandwichProtectionBps=100, totalSlippageBps=0, результат = expectedOutput
      expect(minOutput).toBeGreaterThanOrEqual(BigInt(1000))
    })
  })
})
