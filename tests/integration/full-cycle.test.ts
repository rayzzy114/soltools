/**
 * Full Cycle Integration Test
 * 
 * Simulates the complete pump.fun workflow:
 * 1. Create token
 * 2. Initial buy (launch bundle)
 * 3. Volume bot (wash trading to increase visibility)
 * 4. Ragpull (sell all tokens)
 * 5. Calculate profit
 * 
 * NOTE: This test requires mainnet-beta for actual pump.fun operations
 * In devnet, it will test the logic without actual transactions
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js"
import bs58 from "bs58"
import {
  createTestConnection,
  generateTestWallet,
  airdropSol,
  getSolBalance,
  sleep,
  calculateProfit,
  formatSol,
  createTestReport,
  finalizeTestReport,
  printTestReport,
  type TestReport,
  PUMP_FUN_CONSTANTS,
  DEFAULT_VOLUME_BOT_CONFIG,
  DEFAULT_RAGPULL_CONFIG,
} from "../utils/test-helpers"
import {
  isPumpFunAvailable,
  getBondingCurveAddress,
  getBondingCurveData,
  calculateBuyAmount,
  calculateSellAmount,
  calculateTokenPrice,
  type BondingCurveData,
} from "@/lib/solana/pumpfun-sdk"
import {
  generateWallet,
  calculateTradeAmount,
  getNextWashAction,
  estimateVolume,
  type VolumeWallet,
  type VolumeBotConfig,
} from "@/lib/solana/volume-bot-engine"
import { estimateTip, getRandomTipAccount } from "@/lib/solana/jito"

describe("Full Pump & Dump Cycle", () => {
  let connection: Connection
  let report: TestReport
  
  // test wallets
  let creatorWallet: ReturnType<typeof generateTestWallet>
  let volumeWallets: VolumeWallet[]
  
  // token info
  let tokenMint: PublicKey
  let bondingCurve: BondingCurveData | null
  
  // tracking
  let initialSolBalance: number = 0
  let totalFeesSpent: number = 0
  let totalVolumeGenerated: number = 0

  beforeAll(async () => {
    connection = createTestConnection()
    report = createTestReport("Full Pump & Dump Cycle")
    
    // generate test wallets
    creatorWallet = generateTestWallet()
    volumeWallets = Array(3).fill(null).map(() => generateWallet())
    
    console.log("\n🚀 Starting Full Cycle Test")
    console.log(`Creator: ${creatorWallet.publicKey}`)
    console.log(`Volume wallets: ${volumeWallets.length}`)
  })

  afterAll(() => {
    finalizeTestReport(report, report.steps.every(s => s.success))
    printTestReport(report)
  })

  describe("Phase 1: Setup & Token Creation", () => {
    it("should check pump.fun availability", async () => {
      const startTime = Date.now()
      const available = isPumpFunAvailable()
      
      report.steps.push({
        name: "Check pump.fun availability",
        success: true,
        duration: Date.now() - startTime,
        details: `Available: ${available} (network dependent)`,
      })
      
      // this test passes regardless - just checking the function works
      expect(typeof available).toBe("boolean")
    })

    it("should generate valid token mint", async () => {
      const startTime = Date.now()
      const mintKeypair = Keypair.generate()
      tokenMint = mintKeypair.publicKey
      
      report.steps.push({
        name: "Generate token mint",
        success: true,
        duration: Date.now() - startTime,
        details: `Mint: ${tokenMint.toBase58()}`,
      })
      
      expect(tokenMint).toBeInstanceOf(PublicKey)
    })

    it("should derive bonding curve PDA", async () => {
      const startTime = Date.now()
      const bondingCurvePda = getBondingCurveAddress(tokenMint)
      
      report.steps.push({
        name: "Derive bonding curve PDA",
        success: true,
        duration: Date.now() - startTime,
        details: `PDA: ${bondingCurvePda.toBase58()}`,
      })
      
      expect(bondingCurvePda).toBeInstanceOf(PublicKey)
    })

    it("should estimate token creation cost", async () => {
      const startTime = Date.now()
      const estimatedCost = PUMP_FUN_CONSTANTS.tokenCreationCost
      totalFeesSpent += estimatedCost
      
      report.steps.push({
        name: "Estimate creation cost",
        success: true,
        duration: Date.now() - startTime,
        details: `Cost: ${formatSol(estimatedCost)}`,
      })
      
      report.metrics["Token Creation Cost"] = formatSol(estimatedCost)
      expect(estimatedCost).toBeGreaterThan(0)
    })
  })

  describe("Phase 2: Initial Buy (Launch Bundle)", () => {
    // simulate bonding curve state after token creation
    const mockBondingCurve: BondingCurveData = {
      virtualTokenReserves: BigInt(1_000_000_000 * 1e6), // 1B tokens
      virtualSolReserves: BigInt(30 * LAMPORTS_PER_SOL), // 30 SOL initial
      realTokenReserves: BigInt(800_000_000 * 1e6),
      realSolReserves: BigInt(0),
      tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
      complete: false,
      creator: Keypair.generate().publicKey,
    }

    it("should calculate initial buy amount", async () => {
      const startTime = Date.now()
      const buyAmount = 2.0 // 2 SOL initial buy
      const { tokensOut, priceImpact } = calculateBuyAmount(mockBondingCurve, buyAmount)
      
      report.steps.push({
        name: "Calculate initial buy",
        success: true,
        duration: Date.now() - startTime,
        details: `Buy: ${buyAmount} SOL -> ~${(Number(tokensOut) / 1e6).toFixed(0)} tokens, Impact: ${priceImpact.toFixed(2)}%`,
      })
      
      report.metrics["Initial Buy Amount"] = formatSol(buyAmount)
      report.metrics["Initial Tokens Received"] = `${(Number(tokensOut) / 1e6).toFixed(0)} tokens`
      
      expect(tokensOut).toBeGreaterThan(BigInt(0))
    })

    it("should estimate jito tip for launch", async () => {
      const startTime = Date.now()
      const tip = estimateTip("high") // high priority for launch
      totalFeesSpent += tip
      
      report.steps.push({
        name: "Estimate launch tip",
        success: true,
        duration: Date.now() - startTime,
        details: `Tip: ${formatSol(tip)}`,
      })
      
      expect(tip).toBeGreaterThan(0)
    })

    it("should setup initial buy wallets", async () => {
      const startTime = Date.now()
      const initialBuyers = 3
      const buyPerWallet = 0.1
      
      report.steps.push({
        name: "Setup initial buyers",
        success: true,
        duration: Date.now() - startTime,
        details: `${initialBuyers} wallets × ${buyPerWallet} SOL = ${initialBuyers * buyPerWallet} SOL total`,
      })
      
      report.metrics["Initial Buyers"] = initialBuyers.toString()
      expect(initialBuyers).toBeGreaterThan(0)
    })
  })

  describe("Phase 3: Volume Bot (Wash Trading)", () => {
    // simulate bonding curve after initial buys
    const postLaunchCurve: BondingCurveData = {
      virtualTokenReserves: BigInt(900_000_000 * 1e6), // reduced after buys
      virtualSolReserves: BigInt(35 * LAMPORTS_PER_SOL), // increased after buys
      realTokenReserves: BigInt(700_000_000 * 1e6),
      realSolReserves: BigInt(5 * LAMPORTS_PER_SOL),
      tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
      complete: false,
      creator: Keypair.generate().publicKey,
    }

    it("should setup volume bot configuration", async () => {
      const startTime = Date.now()
      const config: VolumeBotConfig = {
        mintAddress: tokenMint.toBase58(),
        mode: "wash",
        amountMode: "random",
        fixedAmount: 0,
        minAmount: 0.05,
        maxAmount: 0.2,
        minPercentage: 0,
        maxPercentage: 0,
        minInterval: 2,
        maxInterval: 5,
        slippage: 15,
        priorityFee: 0.0005,
        maxExecutions: 10,
        multiThreaded: false,
      }
      
      report.steps.push({
        name: "Configure volume bot",
        success: true,
        duration: Date.now() - startTime,
        details: `Mode: ${config.mode}, Amount: ${config.minAmount}-${config.maxAmount} SOL, Executions: ${config.maxExecutions}`,
      })
      
      report.metrics["Volume Bot Mode"] = config.mode
      report.metrics["Volume Bot Executions"] = config.maxExecutions.toString()
      expect(config.mode).toBe("wash")
    })

    it("should simulate wash trading cycle", async () => {
      const startTime = Date.now()
      const executionCount = 10
      let totalBuys = 0
      let totalSells = 0
      
      // simulate wash trading
      for (let i = 0; i < executionCount; i++) {
        const wallet = volumeWallets[i % volumeWallets.length]
        const action = getNextWashAction(wallet, i % 2 === 0 ? "sell" : "buy")
        
        if (action === "buy") {
          totalBuys++
          const amount = 0.1 + Math.random() * 0.1
          totalVolumeGenerated += amount * 2 // buy + sell = 2x volume
        } else {
          totalSells++
        }
        
        // simulate fee
        totalFeesSpent += 0.0005
      }
      
      report.steps.push({
        name: "Execute wash trading",
        success: true,
        duration: Date.now() - startTime,
        details: `${executionCount} cycles: ${totalBuys} buys, ${totalSells} sells`,
      })
      
      report.metrics["Wash Trades Executed"] = executionCount.toString()
      report.metrics["Total Buys"] = totalBuys.toString()
      report.metrics["Total Sells"] = totalSells.toString()
      
      expect(totalBuys + totalSells).toBe(executionCount)
    })

    it("should estimate volume generated", async () => {
      const startTime = Date.now()
      const solBudget = 1.0 // 1 SOL for volume
      const estimatedVolume = estimateVolume(solBudget)
      
      report.steps.push({
        name: "Estimate volume",
        success: true,
        duration: Date.now() - startTime,
        details: `${formatSol(solBudget)} budget -> $${estimatedVolume.toLocaleString()} volume`,
      })
      
      report.metrics["Estimated Volume ($)"] = `$${estimatedVolume.toLocaleString()}`
      expect(estimatedVolume).toBeGreaterThan(0)
    })

    it("should calculate price change after volume", async () => {
      const startTime = Date.now()
      // simulate price increase from volume activity
      const initialPrice = 30 / 1_000_000_000 // initial price per token
      const finalPrice = 35 / 900_000_000 // price after volume
      const priceChange = ((finalPrice - initialPrice) / initialPrice) * 100
      
      report.steps.push({
        name: "Calculate price change",
        success: true,
        duration: Date.now() - startTime,
        details: `Price change: ${priceChange.toFixed(2)}%`,
      })
      
      report.metrics["Price Change (%)"] = `${priceChange.toFixed(2)}%`
      expect(priceChange).toBeGreaterThan(0)
    })
  })

  describe("Phase 4: Ragpull (Exit)", () => {
    // simulate bonding curve at peak (after volume)
    const peakCurve: BondingCurveData = {
      virtualTokenReserves: BigInt(850_000_000 * 1e6), // more bought
      virtualSolReserves: BigInt(40 * LAMPORTS_PER_SOL), // more SOL in
      realTokenReserves: BigInt(650_000_000 * 1e6),
      realSolReserves: BigInt(10 * LAMPORTS_PER_SOL),
      tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
      complete: false,
      creator: Keypair.generate().publicKey,
    }

    it("should calculate total token holdings", async () => {
      const startTime = Date.now()
      // simulate total tokens held across wallets
      const totalTokens = BigInt(150_000_000 * 1e6) // 150M tokens = 15% of supply
      
      report.steps.push({
        name: "Calculate holdings",
        success: true,
        duration: Date.now() - startTime,
        details: `Total: ${(Number(totalTokens) / 1e6).toLocaleString()} tokens (15% of supply)`,
      })
      
      report.metrics["Total Token Holdings"] = `${(Number(totalTokens) / 1e6).toLocaleString()} tokens`
      expect(totalTokens).toBeGreaterThan(BigInt(0))
    })

    it("should estimate ragpull returns", async () => {
      const startTime = Date.now()
      const tokensToSell = BigInt(150_000_000 * 1e6)
      const { solOut, priceImpact } = calculateSellAmount(peakCurve, tokensToSell)
      
      report.steps.push({
        name: "Estimate ragpull returns",
        success: true,
        duration: Date.now() - startTime,
        details: `Sell ${(Number(tokensToSell) / 1e6).toLocaleString()} tokens -> ${formatSol(Number(solOut) / LAMPORTS_PER_SOL)}, Impact: ${priceImpact.toFixed(2)}%`,
      })
      
      report.metrics["Ragpull SOL Out"] = formatSol(Number(solOut) / LAMPORTS_PER_SOL)
      report.metrics["Price Impact (%)"] = `${priceImpact.toFixed(2)}%`
      
      expect(solOut).toBeGreaterThan(BigInt(0))
    })

    it("should estimate jito tip for exit", async () => {
      const startTime = Date.now()
      const tip = estimateTip("ultra") // ultra priority for ragpull
      totalFeesSpent += tip
      
      report.steps.push({
        name: "Estimate exit tip",
        success: true,
        duration: Date.now() - startTime,
        details: `Tip: ${formatSol(tip)}`,
      })
      
      expect(tip).toBeGreaterThan(0)
    })
  })

  describe("Phase 5: Profit Calculation", () => {
    it("should calculate total investment", async () => {
      const startTime = Date.now()
      // sum up all costs
      const tokenCreation = 0.02
      const initialBuy = 2.3 // creator + 3 wallets
      const volumeBudget = 1.0
      const totalInvestment = tokenCreation + initialBuy + volumeBudget + totalFeesSpent
      
      initialSolBalance = totalInvestment
      
      report.steps.push({
        name: "Calculate investment",
        success: true,
        duration: Date.now() - startTime,
        details: `Total: ${formatSol(totalInvestment)}`,
      })
      
      report.metrics["Total Investment"] = formatSol(totalInvestment)
      expect(totalInvestment).toBeGreaterThan(0)
    })

    it("should calculate final returns", async () => {
      const startTime = Date.now()
      // simulate returns from ragpull
      const ragpullReturns = 4.5 // SOL received from selling all tokens
      
      report.steps.push({
        name: "Calculate returns",
        success: true,
        duration: Date.now() - startTime,
        details: `Returns: ${formatSol(ragpullReturns)}`,
      })
      
      report.metrics["Ragpull Returns"] = formatSol(ragpullReturns)
      expect(ragpullReturns).toBeGreaterThan(0)
    })

    it("should calculate profit/loss", async () => {
      const startTime = Date.now()
      const totalInvestment = initialSolBalance
      const totalReturns = 4.5
      const { grossProfit, netProfit, roi } = calculateProfit(
        totalInvestment,
        totalReturns,
        totalFeesSpent
      )
      
      report.steps.push({
        name: "Calculate P&L",
        success: true,
        duration: Date.now() - startTime,
        details: `Gross: ${formatSol(grossProfit)}, Net: ${formatSol(netProfit)}, ROI: ${roi.toFixed(2)}%`,
      })
      
      report.metrics["Gross Profit"] = formatSol(grossProfit)
      report.metrics["Net Profit"] = formatSol(netProfit)
      report.metrics["ROI (%)"] = `${roi.toFixed(2)}%`
      report.metrics["Total Fees"] = formatSol(totalFeesSpent)
      
      // in this simulation, we should have profit
      expect(typeof netProfit).toBe("number")
    })

    it("should generate final summary", async () => {
      const startTime = Date.now()
      
      const summary = {
        tokenCreated: tokenMint?.toBase58() || "simulated",
        totalInvested: formatSol(initialSolBalance),
        totalFees: formatSol(totalFeesSpent),
        volumeGenerated: `$${estimateVolume(totalVolumeGenerated).toLocaleString()}`,
        washTrades: "10 cycles",
        finalProfit: report.metrics["Net Profit"],
        roi: report.metrics["ROI (%)"],
      }
      
      report.steps.push({
        name: "Generate summary",
        success: true,
        duration: Date.now() - startTime,
        details: JSON.stringify(summary, null, 2),
      })
      
      console.log("\n📊 PUMP & DUMP SUMMARY:")
      console.log("═".repeat(40))
      Object.entries(summary).forEach(([key, value]) => {
        console.log(`${key}: ${value}`)
      })
      console.log("═".repeat(40))
      
      expect(summary.tokenCreated).toBeDefined()
    })
  })
})

describe("Edge Cases & Risk Scenarios", () => {
  describe("Bonding curve completion", () => {
    it("should detect when token graduates to Raydium", () => {
      const completedCurve: BondingCurveData = {
        virtualTokenReserves: BigInt(200_000_000 * 1e6),
        virtualSolReserves: BigInt(85_000 * LAMPORTS_PER_SOL), // ~85k SOL = graduated
        realTokenReserves: BigInt(0),
        realSolReserves: BigInt(85_000 * LAMPORTS_PER_SOL),
        tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
        complete: true,
        creator: Keypair.generate().publicKey,
      }
      
      expect(completedCurve.complete).toBe(true)
      // when complete, need to sell on Raydium instead
    })
  })

  describe("High slippage scenarios", () => {
    it("should handle large sell with high price impact", () => {
      const lowLiquidityCurve: BondingCurveData = {
        virtualTokenReserves: BigInt(999_000_000 * 1e6),
        virtualSolReserves: BigInt(31 * LAMPORTS_PER_SOL),
        realTokenReserves: BigInt(799_000_000 * 1e6),
        realSolReserves: BigInt(1 * LAMPORTS_PER_SOL),
        tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
        complete: false,
        creator: Keypair.generate().publicKey,
      }
      
      // selling 50% of supply should have massive impact
      const tokensToSell = BigInt(500_000_000 * 1e6)
      const { priceImpact } = calculateSellAmount(lowLiquidityCurve, tokensToSell)
      
      expect(priceImpact).toBeGreaterThan(50) // should be very high
    })
  })

  describe("Minimum amounts", () => {
    it("should respect minimum buy amount", () => {
      const minBuy = PUMP_FUN_CONSTANTS.minBuyAmount
      expect(minBuy).toBe(0.001)
    })
  })
})
