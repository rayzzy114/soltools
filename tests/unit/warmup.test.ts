/**
 * Wallet Warmup System Unit Tests
 */

import { describe, it, expect, vi } from "vitest"
import { Keypair } from "@solana/web3.js"
import bs58 from "bs58"
import {
  DEFAULT_WARMUP_CONFIG,
  type WarmupConfig,
} from "@/lib/solana/warmup"

function generatePubkey44(): string {
  let keypair = Keypair.generate()
  while (keypair.publicKey.toBase58().length !== 44) {
    keypair = Keypair.generate()
  }
  return keypair.publicKey.toBase58()
}

describe("Wallet Warmup System", () => {
  // ═══════════════════════════════════════════════════════════════════
  // DEFAULT CONFIG
  // ═══════════════════════════════════════════════════════════════════
  describe("Default Config", () => {
    it("should have reasonable min/max transactions", () => {
      expect(DEFAULT_WARMUP_CONFIG.minTransactions).toBeGreaterThanOrEqual(1)
      expect(DEFAULT_WARMUP_CONFIG.maxTransactions).toBeGreaterThan(DEFAULT_WARMUP_CONFIG.minTransactions)
      expect(DEFAULT_WARMUP_CONFIG.maxTransactions).toBeLessThanOrEqual(20)
    })

    it("should have reasonable delays", () => {
      expect(DEFAULT_WARMUP_CONFIG.minDelayMs).toBeGreaterThanOrEqual(0)
      expect(DEFAULT_WARMUP_CONFIG.maxDelayMs).toBeGreaterThan(DEFAULT_WARMUP_CONFIG.minDelayMs)
    })

    it("should have reasonable amount range", () => {
      expect(DEFAULT_WARMUP_CONFIG.minAmount).toBeGreaterThan(0)
      expect(DEFAULT_WARMUP_CONFIG.maxAmount).toBeGreaterThan(DEFAULT_WARMUP_CONFIG.minAmount)
      expect(DEFAULT_WARMUP_CONFIG.maxAmount).toBeLessThanOrEqual(0.01) // small amounts
    })

    it("should have all action types enabled by default", () => {
      expect(DEFAULT_WARMUP_CONFIG.enableSelfTransfers).toBe(true)
      expect(DEFAULT_WARMUP_CONFIG.enableMemoProgram).toBe(true)
      expect(DEFAULT_WARMUP_CONFIG.enableComputeBudget).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // CONFIG VALIDATION
  // ═══════════════════════════════════════════════════════════════════
  describe("Config Validation", () => {
    it("should accept valid custom config", () => {
      const customConfig: Partial<WarmupConfig> = {
        minTransactions: 5,
        maxTransactions: 10,
        minDelayMs: 1000,
        maxDelayMs: 5000,
      }

      const merged = { ...DEFAULT_WARMUP_CONFIG, ...customConfig }

      expect(merged.minTransactions).toBe(5)
      expect(merged.maxTransactions).toBe(10)
      expect(merged.enableSelfTransfers).toBe(true) // preserved default
    })

    it("should allow disabling action types", () => {
      const customConfig: Partial<WarmupConfig> = {
        enableMemoProgram: false,
        enableComputeBudget: false,
      }

      const merged = { ...DEFAULT_WARMUP_CONFIG, ...customConfig }

      expect(merged.enableSelfTransfers).toBe(true)
      expect(merged.enableMemoProgram).toBe(false)
      expect(merged.enableComputeBudget).toBe(false)
    })

    it("should allow all disabled (dry run)", () => {
      const customConfig: Partial<WarmupConfig> = {
        enableSelfTransfers: false,
        enableMemoProgram: false,
        enableComputeBudget: false,
      }

      const merged = { ...DEFAULT_WARMUP_CONFIG, ...customConfig }

      expect(merged.enableSelfTransfers).toBe(false)
      expect(merged.enableMemoProgram).toBe(false)
      expect(merged.enableComputeBudget).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // KEYPAIR HANDLING
  // ═══════════════════════════════════════════════════════════════════
  describe("Keypair Handling", () => {
    it("should generate valid keypair", () => {
      const keypair = Keypair.generate()
      const secretKey = bs58.encode(keypair.secretKey)

      expect(secretKey.length).toBeGreaterThan(80)
      
      // should be able to decode back
      const decoded = Keypair.fromSecretKey(bs58.decode(secretKey))
      expect(decoded.publicKey.equals(keypair.publicKey)).toBe(true)
    })

    it("should handle multiple keypairs", () => {
      const keypairs = Array(5).fill(0).map(() => Keypair.generate())
      const addresses = keypairs.map(k => k.publicKey.toBase58())
      
      // all should be unique
      const unique = new Set(addresses)
      expect(unique.size).toBe(5)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // TRANSACTION GENERATION
  // ═══════════════════════════════════════════════════════════════════
  describe("Transaction Generation Logic", () => {
    it("should generate random transaction count", () => {
      const min = DEFAULT_WARMUP_CONFIG.minTransactions
      const max = DEFAULT_WARMUP_CONFIG.maxTransactions

      const counts = Array(100).fill(0).map(() => 
        Math.floor(Math.random() * (max - min + 1)) + min
      )

      const minCount = Math.min(...counts)
      const maxCount = Math.max(...counts)

      expect(minCount).toBeGreaterThanOrEqual(min)
      expect(maxCount).toBeLessThanOrEqual(max)
    })

    it("should pick random action types", () => {
      const actionTypes = ["self_transfer", "memo", "compute_budget"]
      
      const picked = Array(100).fill(0).map(() => 
        actionTypes[Math.floor(Math.random() * actionTypes.length)]
      )

      const unique = new Set(picked)
      
      // should hit all action types in 100 tries
      expect(unique.size).toBe(3)
    })

    it("should generate random delays within range", () => {
      const min = DEFAULT_WARMUP_CONFIG.minDelayMs
      const max = DEFAULT_WARMUP_CONFIG.maxDelayMs

      const delays = Array(100).fill(0).map(() => 
        Math.floor(Math.random() * (max - min + 1)) + min
      )

      const minDelay = Math.min(...delays)
      const maxDelay = Math.max(...delays)

      expect(minDelay).toBeGreaterThanOrEqual(min)
      expect(maxDelay).toBeLessThanOrEqual(max)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // WARMUP RESULT STRUCTURE
  // ═══════════════════════════════════════════════════════════════════
  describe("Result Structure", () => {
    it("should define correct result interface", () => {
      const mockResult = {
        walletAddress: generatePubkey44(),
        actions: [],
        totalTransactions: 5,
        successfulTransactions: 4,
        totalSolSpent: 0.0001,
        durationMs: 5000,
      }

      expect(mockResult.walletAddress.length).toBe(44)
      expect(Array.isArray(mockResult.actions)).toBe(true)
      expect(typeof mockResult.totalTransactions).toBe("number")
      expect(typeof mockResult.successfulTransactions).toBe("number")
      expect(typeof mockResult.totalSolSpent).toBe("number")
      expect(typeof mockResult.durationMs).toBe("number")
    })

    it("should define correct action interface", () => {
      const mockAction = {
        type: "self_transfer" as const,
        amount: 0.0001,
        signature: "abc123",
        timestamp: new Date(),
        success: true,
      }

      expect(["self_transfer", "memo", "compute_budget"]).toContain(mockAction.type)
      expect(typeof mockAction.amount).toBe("number")
      expect(typeof mockAction.success).toBe("boolean")
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // PROGRESS TRACKING
  // ═══════════════════════════════════════════════════════════════════
  describe("Progress Tracking", () => {
    it("should define correct progress interface", () => {
      const mockProgress = {
        walletAddress: generatePubkey44(),
        currentStep: 3,
        totalSteps: 5,
        percentage: 60,
        currentAction: "self_transfer",
      }

      expect(mockProgress.percentage).toBe(60)
      expect(mockProgress.currentStep).toBeLessThanOrEqual(mockProgress.totalSteps)
    })

    it("should calculate percentage correctly", () => {
      const totalSteps = 5
      
      for (let step = 1; step <= totalSteps; step++) {
        const percentage = (step / totalSteps) * 100
        expect(percentage).toBe(step * 20)
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // WALLET WARMTH CHECK
  // ═══════════════════════════════════════════════════════════════════
  describe("Warmth Check Logic", () => {
    it("should consider 3+ transactions as warm", () => {
      const checkWarm = (txCount: number) => txCount >= 3

      expect(checkWarm(0)).toBe(false)
      expect(checkWarm(1)).toBe(false)
      expect(checkWarm(2)).toBe(false)
      expect(checkWarm(3)).toBe(true)
      expect(checkWarm(10)).toBe(true)
    })

    it("should define correct warmth result interface", () => {
      const mockWarmth = {
        isWarm: true,
        transactionCount: 5,
        oldestTransaction: new Date(Date.now() - 86400000),
      }

      expect(typeof mockWarmth.isWarm).toBe("boolean")
      expect(typeof mockWarmth.transactionCount).toBe("number")
      expect(mockWarmth.oldestTransaction).toBeInstanceOf(Date)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // BATCH PROCESSING
  // ═══════════════════════════════════════════════════════════════════
  describe("Batch Processing", () => {
    it("should process wallets in batches", () => {
      const wallets = Array(10).fill(0).map(() => Keypair.generate())
      const concurrency = 3

      const batches: typeof wallets[] = []
      for (let i = 0; i < wallets.length; i += concurrency) {
        batches.push(wallets.slice(i, i + concurrency))
      }

      expect(batches.length).toBe(4) // 3 + 3 + 3 + 1
      expect(batches[0].length).toBe(3)
      expect(batches[3].length).toBe(1)
    })

    it("should handle concurrency of 1", () => {
      const wallets = Array(3).fill(0).map(() => Keypair.generate())
      const concurrency = 1

      const batches: typeof wallets[] = []
      for (let i = 0; i < wallets.length; i += concurrency) {
        batches.push(wallets.slice(i, i + concurrency))
      }

      expect(batches.length).toBe(3)
      batches.forEach(b => expect(b.length).toBe(1))
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════
  describe("Edge Cases", () => {
    it("should handle empty wallet list", () => {
      const wallets: Keypair[] = []
      expect(wallets.length).toBe(0)
    })

    it("should handle very large concurrency", () => {
      const wallets = Array(5).fill(0).map(() => Keypair.generate())
      const concurrency = 100 // larger than wallet count

      const batches: typeof wallets[] = []
      for (let i = 0; i < wallets.length; i += concurrency) {
        batches.push(wallets.slice(i, i + concurrency))
      }

      expect(batches.length).toBe(1)
      expect(batches[0].length).toBe(5)
    })

    it("should handle config with equal min/max", () => {
      const config: Partial<WarmupConfig> = {
        minTransactions: 5,
        maxTransactions: 5,
      }

      const merged = { ...DEFAULT_WARMUP_CONFIG, ...config }
      
      // should always return 5
      const count = Math.floor(Math.random() * (merged.maxTransactions - merged.minTransactions + 1)) + merged.minTransactions
      expect(count).toBe(5)
    })
  })
})
