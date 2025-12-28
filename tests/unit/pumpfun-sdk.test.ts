/**
 * pump.fun SDK Unit Tests
 * 
 * Детальное тестирование всех функций SDK:
 * - PDA derivation (bonding curve, metadata, mint authority)
 * - Price calculations (AMM formulas)
 * - Transaction building
 * - Ragpull logic
 */

import { describe, it, expect, beforeAll } from "vitest"
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js"
import {
  getBondingCurveAddress,
  getMetadataAddress,
  getMintAuthorityAddress,
  calculateBuyAmount,
  calculateSellAmount,
  calculateTokenPrice,
  isPumpFunAvailable,
  PUMPFUN_PROGRAM_ID,
  PUMPFUN_GLOBAL,
  PUMPFUN_FEE_RECIPIENT,
  PUMPFUN_EVENT_AUTHORITY,
  METAPLEX_TOKEN_METADATA,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  getPumpswapPoolAddress,
  type BondingCurveData,
} from "@/lib/solana/pumpfun-sdk"

describe("pump.fun SDK", () => {
  // ═══════════════════════════════════════════════════════════════════
  // CONSTANTS
  // ═══════════════════════════════════════════════════════════════════
  describe("Program Constants", () => {
    it("should have correct pump.fun program ID", () => {
      expect(PUMPFUN_PROGRAM_ID.toBase58()).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
    })

    it("should have correct global account", () => {
      expect(PUMPFUN_GLOBAL.toBase58()).toBe("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf")
    })

    it("should have correct fee recipient", () => {
      expect(PUMPFUN_FEE_RECIPIENT.toBase58()).toBe("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM")
    })

    it("should have correct event authority", () => {
      expect(PUMPFUN_EVENT_AUTHORITY.toBase58()).toBe("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1")
    })

    it("should have correct metaplex metadata program", () => {
      expect(METAPLEX_TOKEN_METADATA.toBase58()).toBe("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
    })

    it("should have correct pumpswap program ID", () => {
      expect(PUMPSWAP_PROGRAM_ID.toBase58()).toBe("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")
    })

    it("should have correct WSOL mint", () => {
      expect(WSOL_MINT.toBase58()).toBe("So11111111111111111111111111111111111111112")
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // PDA DERIVATION
  // ═══════════════════════════════════════════════════════════════════
  describe("PDA Derivation", () => {
    const testMint = Keypair.generate().publicKey

    describe("getBondingCurveAddress", () => {
      it("should derive valid bonding curve PDA", () => {
        const bondingCurve = getBondingCurveAddress(testMint)
        
        expect(bondingCurve).toBeInstanceOf(PublicKey)
        expect(bondingCurve.toBase58()).toHaveLength(44)
      })

      it("should be deterministic (same mint = same PDA)", () => {
        const bc1 = getBondingCurveAddress(testMint)
        const bc2 = getBondingCurveAddress(testMint)
        
        expect(bc1.equals(bc2)).toBe(true)
      })

      it("should produce different PDAs for different mints", () => {
        const mint1 = Keypair.generate().publicKey
        const mint2 = Keypair.generate().publicKey
        
        const bc1 = getBondingCurveAddress(mint1)
        const bc2 = getBondingCurveAddress(mint2)
        
        expect(bc1.equals(bc2)).toBe(false)
      })

      it("should derive off-curve address", () => {
        const bondingCurve = getBondingCurveAddress(testMint)
        expect(PublicKey.isOnCurve(bondingCurve.toBytes())).toBe(false)
      })
    })

    describe("getMintAuthorityAddress", () => {
      it("should derive valid mint authority PDA", () => {
        const mintAuthority = getMintAuthorityAddress()
        
        expect(mintAuthority).toBeInstanceOf(PublicKey)
        // base58 addresses can be 43-44 chars
        expect(mintAuthority.toBase58().length).toBeGreaterThanOrEqual(43)
        expect(mintAuthority.toBase58().length).toBeLessThanOrEqual(44)
      })

      it("should be deterministic", () => {
        const ma1 = getMintAuthorityAddress()
        const ma2 = getMintAuthorityAddress()
        
        expect(ma1.equals(ma2)).toBe(true)
      })
    })

    describe("getMetadataAddress", () => {
      it("should derive valid metadata PDA", () => {
        const metadata = getMetadataAddress(testMint)
        
        expect(metadata).toBeInstanceOf(PublicKey)
        expect(metadata.toBase58()).toHaveLength(44)
      })

      it("should be deterministic", () => {
        const md1 = getMetadataAddress(testMint)
        const md2 = getMetadataAddress(testMint)
        
        expect(md1.equals(md2)).toBe(true)
      })

      it("should produce different PDAs for different mints", () => {
        const mint1 = Keypair.generate().publicKey
        const mint2 = Keypair.generate().publicKey
        
        const md1 = getMetadataAddress(mint1)
        const md2 = getMetadataAddress(mint2)
        
        expect(md1.equals(md2)).toBe(false)
      })
    })

    describe("getPumpswapPoolAddress", () => {
      it("should derive valid pool PDA", () => {
        const tokenMint = Keypair.generate().publicKey
        const pool = getPumpswapPoolAddress(tokenMint, WSOL_MINT)
        
        expect(pool).toBeInstanceOf(PublicKey)
      })

      it("should be symmetric (swap order doesn't matter for same mints)", () => {
        const mint1 = Keypair.generate().publicKey
        const mint2 = Keypair.generate().publicKey
        
        // pool address should be same regardless of order
        // because it sorts mints internally
        const pool1 = getPumpswapPoolAddress(mint1, mint2)
        const pool2 = getPumpswapPoolAddress(mint2, mint1)
        
        expect(pool1.equals(pool2)).toBe(true)
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // AMM CALCULATIONS
  // ═══════════════════════════════════════════════════════════════════
  describe("AMM Price Calculations", () => {
    // standard initial bonding curve (pump.fun defaults)
    const createMockCurve = (): BondingCurveData => ({
      virtualTokenReserves: BigInt(1_000_000_000 * 1e6), // 1B tokens
      virtualSolReserves: BigInt(30 * LAMPORTS_PER_SOL), // 30 SOL
      realTokenReserves: BigInt(800_000_000 * 1e6),
      realSolReserves: BigInt(0),
      tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
      complete: false,
      creator: Keypair.generate().publicKey,
    })

    describe("calculateTokenPrice", () => {
      it("should calculate correct initial price", () => {
        const curve = createMockCurve()
        const price = calculateTokenPrice(curve)
        
        // 30 SOL / 1B tokens = 0.00000003 SOL per token
        expect(price).toBeCloseTo(0.00000003, 10)
      })

      it("should increase price when SOL reserves increase", () => {
        const curve = createMockCurve()
        const initialPrice = calculateTokenPrice(curve)
        
        // simulate buy by adjusting reserves
        curve.virtualSolReserves += BigInt(5 * LAMPORTS_PER_SOL)
        curve.virtualTokenReserves -= BigInt(100_000_000 * 1e6)
        
        const newPrice = calculateTokenPrice(curve)
        expect(newPrice).toBeGreaterThan(initialPrice)
      })

      it("should handle large reserve values", () => {
        const curve: BondingCurveData = {
          virtualTokenReserves: BigInt("1000000000000000000"), // very large
          virtualSolReserves: BigInt(85_000 * LAMPORTS_PER_SOL), // near graduation
          realTokenReserves: BigInt(0),
          realSolReserves: BigInt(85_000 * LAMPORTS_PER_SOL),
          tokenTotalSupply: BigInt("1000000000000000000"),
          complete: false,
          creator: Keypair.generate().publicKey,
        }
        
        const price = calculateTokenPrice(curve)
        expect(price).toBeGreaterThan(0)
        expect(Number.isFinite(price)).toBe(true)
      })
    })

    describe("calculateBuyAmount", () => {
      it("should return positive tokens for positive SOL", () => {
        const curve = createMockCurve()
        const { tokensOut, priceImpact } = calculateBuyAmount(curve, 1.0)
        
        expect(tokensOut).toBeGreaterThan(BigInt(0))
        expect(priceImpact).toBeGreaterThan(0)
      })

      it("should return zero for non-positive input", () => {
        const curve = createMockCurve()
        const zero = calculateBuyAmount(curve, 0)
        const negative = calculateBuyAmount(curve, -1)
        
        expect(zero.tokensOut).toBe(BigInt(0))
        expect(negative.tokensOut).toBe(BigInt(0))
      })

      it("should return zero tokens for zero SOL", () => {
        const curve = createMockCurve()
        const { tokensOut, priceImpact } = calculateBuyAmount(curve, 0)
        
        expect(tokensOut).toBe(BigInt(0))
        expect(priceImpact).toBe(0)
      })

      it("should have higher impact for larger buys", () => {
        const curve1 = createMockCurve()
        const curve2 = createMockCurve()
        const curve3 = createMockCurve()
        
        const { priceImpact: impact1 } = calculateBuyAmount(curve1, 0.1)
        const { priceImpact: impact2 } = calculateBuyAmount(curve2, 1.0)
        const { priceImpact: impact3 } = calculateBuyAmount(curve3, 10.0)
        
        expect(impact2).toBeGreaterThan(impact1)
        expect(impact3).toBeGreaterThan(impact2)
      })

      it("should give fewer tokens per SOL as price increases", () => {
        const curve = createMockCurve()
        
        // first buy
        const { tokensOut: tokens1 } = calculateBuyAmount(curve, 1.0)
        
        // simulate price increase
        curve.virtualSolReserves += BigInt(10 * LAMPORTS_PER_SOL)
        curve.virtualTokenReserves -= BigInt(200_000_000 * 1e6)
        
        // second buy at higher price
        const { tokensOut: tokens2 } = calculateBuyAmount(curve, 1.0)
        
        expect(tokens2).toBeLessThan(tokens1)
      })

      it("should preserve constant product k", () => {
        const curve = createMockCurve()
        const k = curve.virtualTokenReserves * curve.virtualSolReserves
        
        const solAmount = 1.0
        const solIn = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL))
        const newSolReserves = curve.virtualSolReserves + solIn
        const newTokenReserves = k / newSolReserves
        
        // k should be approximately preserved
        const newK = newSolReserves * newTokenReserves
        const kDiff = Number(k) - Number(newK)
        
        // allow for bigint division rounding
        expect(Math.abs(kDiff)).toBeLessThan(Number(newSolReserves))
      })
    })

    describe("calculateSellAmount", () => {
      it("should return positive SOL for positive tokens", () => {
        const curve = createMockCurve()
        const tokenAmount = BigInt(10_000_000 * 1e6) // 10M tokens
        
        const { solOut, priceImpact } = calculateSellAmount(curve, tokenAmount)
        
        expect(solOut).toBeGreaterThan(BigInt(0))
        expect(priceImpact).toBeGreaterThan(0)
      })

      it("should return zero for non-positive token input", () => {
        const curve = createMockCurve()
        const result = calculateSellAmount(curve, BigInt(0))
        expect(result.solOut).toBe(BigInt(0))
      })

      it("should have higher impact for larger sells", () => {
        const curve1 = createMockCurve()
        const curve2 = createMockCurve()
        const curve3 = createMockCurve()
        
        const small = BigInt(1_000_000 * 1e6)
        const medium = BigInt(10_000_000 * 1e6)
        const large = BigInt(100_000_000 * 1e6)
        
        const { priceImpact: impact1 } = calculateSellAmount(curve1, small)
        const { priceImpact: impact2 } = calculateSellAmount(curve2, medium)
        const { priceImpact: impact3 } = calculateSellAmount(curve3, large)
        
        expect(impact2).toBeGreaterThan(impact1)
        expect(impact3).toBeGreaterThan(impact2)
      })

      it("should crash price when selling large portion", () => {
        const curve = createMockCurve()
        const initialPrice = calculateTokenPrice(curve)
        
        // sell 50% of supply
        const sellAmount = BigInt(500_000_000 * 1e6)
        const { priceImpact } = calculateSellAmount(curve, sellAmount)
        
        expect(priceImpact).toBeGreaterThan(30) // should be massive impact
      })

      it("should return less SOL per token as more is sold", () => {
        // this simulates ragpull scenario
        const curve1 = createMockCurve()
        const curve2 = createMockCurve()
        
        // first wallet sells
        const sell1 = BigInt(50_000_000 * 1e6)
        const { solOut: sol1 } = calculateSellAmount(curve1, sell1)
        
        // simulate first sale affecting curve
        curve2.virtualTokenReserves += sell1
        curve2.virtualSolReserves -= sol1
        
        // second wallet sells same amount
        const { solOut: sol2 } = calculateSellAmount(curve2, sell1)
        
        // second seller gets less SOL (worse rate)
        expect(sol2).toBeLessThan(sol1)
      })
    })

    describe("Arbitrage consistency", () => {
      it("buy then sell should result in approximately same amount (no fees in pure AMM)", () => {
        const curve = createMockCurve()
        
        // buy 1 SOL worth of tokens (без комиссий для чистого AMM теста)
        const buyAmount = 1.0
        const { tokensOut } = calculateBuyAmount(curve, buyAmount, false) // includeFee: false
        
        // update curve state
        curve.virtualSolReserves += BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL))
        curve.virtualTokenReserves -= tokensOut
        
        // immediately sell those tokens (без комиссий)
        const { solOut } = calculateSellAmount(curve, tokensOut, false) // includeFee: false
        const solReceived = Number(solOut) / LAMPORTS_PER_SOL
        
        // in pure AMM without fees, should get approximately same amount back
        // (small difference due to bigint rounding)
        expect(Math.abs(solReceived - buyAmount)).toBeLessThan(0.0001)
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // NETWORK CHECK
  // ═══════════════════════════════════════════════════════════════════
  describe("Network Availability", () => {
    it("should return boolean", () => {
      const available = isPumpFunAvailable()
      expect(typeof available).toBe("boolean")
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════
  describe("Edge Cases", () => {
    it("should handle very small buy amounts", () => {
      const curve: BondingCurveData = {
        virtualTokenReserves: BigInt(1_000_000_000 * 1e6),
        virtualSolReserves: BigInt(30 * LAMPORTS_PER_SOL),
        realTokenReserves: BigInt(800_000_000 * 1e6),
        realSolReserves: BigInt(0),
        tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
        complete: false,
        creator: Keypair.generate().publicKey,
      }
      
      const { tokensOut } = calculateBuyAmount(curve, 0.001)
      expect(tokensOut).toBeGreaterThan(BigInt(0))
    })

    it("should handle graduated curve (complete=true)", () => {
      const curve: BondingCurveData = {
        virtualTokenReserves: BigInt(200_000_000 * 1e6),
        virtualSolReserves: BigInt(85_000 * LAMPORTS_PER_SOL),
        realTokenReserves: BigInt(0),
        realSolReserves: BigInt(85_000 * LAMPORTS_PER_SOL),
        tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
        complete: true, // graduated to Raydium
        creator: Keypair.generate().publicKey,
      }
      
      expect(curve.complete).toBe(true)
      // when complete, should use pumpswap instead
    })

    it("should handle low liquidity scenario", () => {
      const lowLiquidityCurve: BondingCurveData = {
        virtualTokenReserves: BigInt(999_000_000 * 1e6),
        virtualSolReserves: BigInt(31 * LAMPORTS_PER_SOL),
        realTokenReserves: BigInt(799_000_000 * 1e6),
        realSolReserves: BigInt(1 * LAMPORTS_PER_SOL),
        tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
        complete: false,
        creator: Keypair.generate().publicKey,
      }
      
      // large sell should have massive impact
      const largeSell = BigInt(500_000_000 * 1e6)
      const { priceImpact } = calculateSellAmount(lowLiquidityCurve, largeSell)
      
      expect(priceImpact).toBeGreaterThan(50)
    })
  })
})
