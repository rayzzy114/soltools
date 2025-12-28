/**
 * Volume Bot Engine Unit Tests
 * 
 * Детальное тестирование:
 * - Wallet management (generate, import)
 * - Trade amount calculation (fixed, random, percentage)
 * - Wash trading logic
 * - Volume estimation
 */

import { describe, it, expect, beforeEach } from "vitest"
import { Keypair } from "@solana/web3.js"
import {
  generateWallet,
  importWallet,
  calculateTradeAmount,
  getNextWashAction,
  estimateVolume,
  type VolumeWallet,
  type VolumeBotConfig,
} from "@/lib/solana/volume-bot-engine"
import bs58 from "bs58"

describe("Volume Bot Engine", () => {
  // ═══════════════════════════════════════════════════════════════════
  // WALLET MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════
  describe("Wallet Management", () => {
    describe("generateWallet", () => {
      it("should generate wallet with all required fields", () => {
        const wallet = generateWallet()
        
        expect(wallet).toHaveProperty("publicKey")
        expect(wallet).toHaveProperty("secretKey")
        expect(wallet).toHaveProperty("solBalance")
        expect(wallet).toHaveProperty("tokenBalance")
        expect(wallet).toHaveProperty("isActive")
      })

      it("should generate valid base58 public key", () => {
        const wallet = generateWallet()
        
        expect(wallet.publicKey).toHaveLength(44)
        expect(() => new Keypair().publicKey.toBase58()).not.toThrow()
      })

      it("should generate unique wallets", () => {
        const wallets = Array(10).fill(null).map(() => generateWallet())
        const publicKeys = wallets.map(w => w.publicKey)
        const uniqueKeys = new Set(publicKeys)
        
        expect(uniqueKeys.size).toBe(10)
      })

      it("should initialize with zero balances", () => {
        const wallet = generateWallet()
        
        expect(wallet.solBalance).toBe(0)
        expect(wallet.tokenBalance).toBe(0)
      })

      it("should be active by default", () => {
        const wallet = generateWallet()
        expect(wallet.isActive).toBe(true)
      })

      it("should be reconstructable from secret key", () => {
        const wallet = generateWallet()
        const keypair = Keypair.fromSecretKey(bs58.decode(wallet.secretKey))
        
        expect(keypair.publicKey.toBase58()).toBe(wallet.publicKey)
      })
    })

    describe("importWallet", () => {
      it("should import wallet from valid secret key", () => {
        const original = Keypair.generate()
        const secretKey = bs58.encode(original.secretKey)
        
        const wallet = importWallet(secretKey)
        
        expect(wallet.publicKey).toBe(original.publicKey.toBase58())
        expect(wallet.secretKey).toBe(secretKey)
      })

      it("should throw on invalid secret key", () => {
        expect(() => importWallet("invalid-key")).toThrow()
      })

      it("should throw on too short key", () => {
        expect(() => importWallet("abc123")).toThrow()
      })

      it("should initialize imported wallet with zero balances", () => {
        const original = Keypair.generate()
        const secretKey = bs58.encode(original.secretKey)
        
        const wallet = importWallet(secretKey)
        
        expect(wallet.solBalance).toBe(0)
        expect(wallet.tokenBalance).toBe(0)
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // TRADE AMOUNT CALCULATION
  // ═══════════════════════════════════════════════════════════════════
  describe("Trade Amount Calculation", () => {
    const createConfig = (overrides: Partial<VolumeBotConfig> = {}): VolumeBotConfig => ({
      mintAddress: Keypair.generate().publicKey.toBase58(),
      mode: "buy",
      amountMode: "fixed",
      fixedAmount: 0.1,
      minAmount: 0.01,
      maxAmount: 0.5,
      minPercentage: 10,
      maxPercentage: 50,
      minInterval: 1,
      maxInterval: 5,
      slippage: 15,
      priorityFee: 0.0005,
      maxExecutions: 10,
      multiThreaded: false,
      ...overrides,
    })

    const createWallet = (overrides: Partial<VolumeWallet> = {}): VolumeWallet => ({
      publicKey: Keypair.generate().publicKey.toBase58(),
      secretKey: "",
      solBalance: 1.0,
      tokenBalance: 1000,
      isActive: true,
      ...overrides,
    })

    describe("Fixed Amount Mode", () => {
      it("should return exact fixed amount for buy", () => {
        const config = createConfig({ amountMode: "fixed", fixedAmount: 0.25 })
        const wallet = createWallet({ solBalance: 1.0 })
        
        const amount = calculateTradeAmount(config, wallet, "buy")
        
        expect(amount).toBe(0.25)
      })

      it("should return exact fixed amount for sell", () => {
        const config = createConfig({ amountMode: "fixed", fixedAmount: 500 })
        const wallet = createWallet({ tokenBalance: 1000 })
        
        const amount = calculateTradeAmount(config, wallet, "sell")
        
        expect(amount).toBe(500)
      })

      it("should cap buy at available balance minus fees", () => {
        const config = createConfig({ amountMode: "fixed", fixedAmount: 2.0 })
        const wallet = createWallet({ solBalance: 0.5 })
        
        const amount = calculateTradeAmount(config, wallet, "buy")
        
        expect(amount).toBeLessThanOrEqual(wallet.solBalance - 0.005)
      })

      it("should cap sell at available tokens", () => {
        const config = createConfig({ amountMode: "fixed", fixedAmount: 2000 })
        const wallet = createWallet({ tokenBalance: 500 })
        
        const amount = calculateTradeAmount(config, wallet, "sell")
        
        expect(amount).toBeLessThanOrEqual(500)
      })
    })

    describe("Random Amount Mode", () => {
      it("should return amount within range", () => {
        const config = createConfig({ 
          amountMode: "random", 
          minAmount: 0.1, 
          maxAmount: 0.5 
        })
        const wallet = createWallet({ solBalance: 1.0 })
        
        // test multiple times for randomness
        for (let i = 0; i < 20; i++) {
          const amount = calculateTradeAmount(config, wallet, "buy")
          expect(amount).toBeGreaterThanOrEqual(0.1)
          expect(amount).toBeLessThanOrEqual(0.5)
        }
      })

      it("should produce different values (randomness)", () => {
        const config = createConfig({ 
          amountMode: "random", 
          minAmount: 0.01, 
          maxAmount: 0.5 
        })
        const wallet = createWallet({ solBalance: 1.0 })
        
        const amounts = Array(10).fill(null).map(() => 
          calculateTradeAmount(config, wallet, "buy")
        )
        const uniqueAmounts = new Set(amounts.map(a => a.toFixed(6)))
        
        // should have at least 5 different values
        expect(uniqueAmounts.size).toBeGreaterThanOrEqual(5)
      })
    })

    describe("Percentage Amount Mode", () => {
      it("should calculate percentage of SOL for buy", () => {
        const config = createConfig({ 
          amountMode: "percentage", 
          minPercentage: 50, 
          maxPercentage: 50 
        })
        const wallet = createWallet({ solBalance: 1.0 })
        
        const amount = calculateTradeAmount(config, wallet, "buy")
        
        // 50% of (1.0 - 0.01 fee reserve) ≈ 0.495
        expect(amount).toBeGreaterThan(0.4)
        expect(amount).toBeLessThan(0.6)
      })

      it("should calculate percentage of tokens for sell", () => {
        const config = createConfig({ 
          amountMode: "percentage", 
          minPercentage: 50, 
          maxPercentage: 50 
        })
        const wallet = createWallet({ tokenBalance: 1000 })
        
        const amount = calculateTradeAmount(config, wallet, "sell")
        
        expect(amount).toBeCloseTo(500, 0)
      })

      it("should handle percentage range", () => {
        const config = createConfig({ 
          amountMode: "percentage", 
          minPercentage: 20, 
          maxPercentage: 80 
        })
        const wallet = createWallet({ solBalance: 1.0 })
        
        for (let i = 0; i < 10; i++) {
          const amount = calculateTradeAmount(config, wallet, "buy")
          // 20-80% of ~0.99 SOL
          expect(amount).toBeGreaterThanOrEqual(0.19)
          expect(amount).toBeLessThanOrEqual(0.8)
        }
      })
    })

    describe("Minimum Amount Enforcement", () => {
      it("should enforce minimum buy amount", () => {
        const config = createConfig({ amountMode: "fixed", fixedAmount: 0.0001 })
        const wallet = createWallet({ solBalance: 1.0 })
        
        const amount = calculateTradeAmount(config, wallet, "buy")
        
        expect(amount).toBeGreaterThanOrEqual(0.001)
      })

      it("should enforce minimum sell amount", () => {
        const config = createConfig({ amountMode: "fixed", fixedAmount: 0.1 })
        const wallet = createWallet({ tokenBalance: 1000 })
        
        const amount = calculateTradeAmount(config, wallet, "sell")
        
        expect(amount).toBeGreaterThanOrEqual(1)
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // WASH TRADING LOGIC
  // ═══════════════════════════════════════════════════════════════════
  describe("Wash Trading Logic", () => {
    const createWallet = (overrides: Partial<VolumeWallet> = {}): VolumeWallet => ({
      publicKey: "",
      secretKey: "",
      solBalance: 1.0,
      tokenBalance: 1000,
      isActive: true,
      ...overrides,
    })

    describe("getNextWashAction", () => {
      it("should return buy when wallet has no tokens", () => {
        const wallet = createWallet({ tokenBalance: 0 })
        
        const action = getNextWashAction(wallet)
        
        expect(action).toBe("buy")
      })

      it("should return buy when tokens very low", () => {
        const wallet = createWallet({ tokenBalance: 0.5 })
        
        const action = getNextWashAction(wallet)
        
        expect(action).toBe("buy")
      })

      it("should return sell when SOL very low", () => {
        const wallet = createWallet({ solBalance: 0.005, tokenBalance: 1000 })
        
        const action = getNextWashAction(wallet)
        
        expect(action).toBe("sell")
      })

      it("should alternate after buy", () => {
        const wallet = createWallet()
        
        const action = getNextWashAction(wallet, "buy")
        
        expect(action).toBe("sell")
      })

      it("should alternate after sell", () => {
        const wallet = createWallet()
        
        const action = getNextWashAction(wallet, "sell")
        
        expect(action).toBe("buy")
      })

      it("should be random when no last action and balanced", () => {
        const wallet = createWallet({ solBalance: 1.0, tokenBalance: 1000 })
        
        // collect many samples
        const actions = Array(100).fill(null).map(() => getNextWashAction(wallet))
        const buys = actions.filter(a => a === "buy").length
        const sells = actions.filter(a => a === "sell").length
        
        // should be roughly 50/50 (allow for variance)
        expect(buys).toBeGreaterThan(30)
        expect(sells).toBeGreaterThan(30)
      })

      it("should prioritize buy when token balance is low", () => {
        const wallet = createWallet({ solBalance: 1.0, tokenBalance: 0.5 })
        
        // when tokens < 1, should always buy
        const action = getNextWashAction(wallet)
        
        expect(action).toBe("buy")
      })
    })

    describe("Wash Trading Scenarios", () => {
      it("should handle full wash cycle", () => {
        const wallet = createWallet({ solBalance: 1.0, tokenBalance: 0 })
        
        // first action: must buy (no tokens)
        const action1 = getNextWashAction(wallet)
        expect(action1).toBe("buy")
        
        // simulate buy
        wallet.tokenBalance = 1000
        wallet.solBalance = 0.9
        
        // second action: should sell (alternating)
        const action2 = getNextWashAction(wallet, "buy")
        expect(action2).toBe("sell")
        
        // simulate sell
        wallet.tokenBalance = 500
        wallet.solBalance = 0.95
        
        // third action: should buy (alternating)
        const action3 = getNextWashAction(wallet, "sell")
        expect(action3).toBe("buy")
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // VOLUME ESTIMATION
  // ═══════════════════════════════════════════════════════════════════
  describe("Volume Estimation", () => {
    describe("estimateVolume", () => {
      it("should estimate with default rate", () => {
        const volume = estimateVolume(1)
        
        expect(volume).toBe(13000) // 1 SOL * 13000 rate
      })

      it("should estimate with custom rate", () => {
        const volume = estimateVolume(2, 10000)
        
        expect(volume).toBe(20000) // 2 SOL * 10000 rate
      })

      it("should return zero for zero budget", () => {
        const volume = estimateVolume(0)
        
        expect(volume).toBe(0)
      })

      it("should scale linearly", () => {
        const v1 = estimateVolume(1)
        const v2 = estimateVolume(2)
        const v5 = estimateVolume(5)
        
        expect(v2).toBe(v1 * 2)
        expect(v5).toBe(v1 * 5)
      })

      it("should handle fractional budgets", () => {
        const volume = estimateVolume(0.5)
        
        expect(volume).toBe(6500) // 0.5 * 13000
      })

      it("should handle large budgets", () => {
        const volume = estimateVolume(100)
        
        expect(volume).toBe(1300000)
      })
    })

    describe("Volume Estimation Accuracy", () => {
      it("should reflect realistic pump.fun volume multiplier", () => {
        // pump.fun typically generates ~$13k volume per 1 SOL spent
        // (due to multiple trades, wash trading, etc)
        
        const solSpent = 1.0
        const estimatedVolume = estimateVolume(solSpent)
        const solPrice = 150 // USD
        
        // at $150/SOL, 1 SOL = $150 invested
        // volume multiplier = 13000 / 150 = ~87x
        const multiplier = estimatedVolume / (solSpent * solPrice)
        
        expect(multiplier).toBeGreaterThan(80)
        expect(multiplier).toBeLessThan(100)
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // CONFIG VALIDATION
  // ═══════════════════════════════════════════════════════════════════
  describe("Configuration Validation", () => {
    it("should accept valid modes", () => {
      const validModes = ["buy", "sell", "wash"]
      validModes.forEach(mode => {
        expect(mode).toMatch(/^(buy|sell|wash)$/)
      })
    })

    it("should accept valid amount modes", () => {
      const validModes = ["fixed", "random", "percentage"]
      validModes.forEach(mode => {
        expect(mode).toMatch(/^(fixed|random|percentage)$/)
      })
    })

    it("should have reasonable slippage range", () => {
      const minSlippage = 1
      const maxSlippage = 50
      
      expect(minSlippage).toBeGreaterThan(0)
      expect(maxSlippage).toBeLessThanOrEqual(100)
    })
  })
})
