import { Keypair, PublicKey, Transaction } from "@solana/web3.js"
import { connection } from "./config"
import { getAssociatedTokenAddress } from "@solana/spl-token"
import bs58 from "bs58"
import {
  getBondingCurveData,
  calculateBuyAmount,
  calculateSellAmount,
  buildBuyTransaction,
  buildSellTransaction,
  calculateTokenPrice,
  isPumpFunAvailable,
  buildPumpswapSwapTransaction,
  calculatePumpswapSwapAmount,
  getPumpswapPoolData,
} from "./pumpfun-sdk"
import {
  AntiDetectionConfig,
  DEFAULT_ANTI_DETECTION,
  STEALTH_ANTI_DETECTION,
  FAST_ANTI_DETECTION,
  applyAntiDetection,
  splitAmount,
  getRateLimiter,
} from "./anti-detection"

function clampPercent(value: number, min: number = 0, max: number = 99): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export interface VolumeBotConfig {
  tokenMint: string
  minAmount: number // in SOL
  maxAmount: number // in SOL
  intervalSeconds: number
  numberOfWallets: number
  randomDelays: boolean
  antiDetection: boolean
  antiDetectionMode?: "default" | "stealth" | "fast"
  customAntiDetection?: Partial<AntiDetectionConfig>
}

export interface TradeResult {
  signature: string
  type: "buy" | "sell"
  amount: string
  tokensTraded?: string
  price?: string
  timestamp: Date
  walletAddress: string
}

export interface VolumeBotSession {
  id: string
  config: VolumeBotConfig
  wallets: Keypair[]
  isRunning: boolean
  trades: TradeResult[]
  startedAt?: Date
  stoppedAt?: Date
  totalVolumeSol: number
  totalTrades: number
}

// active sessions
const sessions = new Map<string, VolumeBotSession>()

/**
 * Get anti-detection config based on mode
 */
function getAntiDetectionConfig(config: VolumeBotConfig): AntiDetectionConfig {
  if (!config.antiDetection) {
    return FAST_ANTI_DETECTION // minimal delays
  }
  
  if (config.customAntiDetection) {
    return { ...DEFAULT_ANTI_DETECTION, ...config.customAntiDetection }
  }
  
  switch (config.antiDetectionMode) {
    case "stealth":
      return STEALTH_ANTI_DETECTION
    case "fast":
      return FAST_ANTI_DETECTION
    default:
      return DEFAULT_ANTI_DETECTION
  }
}

/**
 * Execute buy/sell trade on bonding curve
 */
export async function executeTrade(
  wallet: Keypair,
  config: VolumeBotConfig,
  type: "buy" | "sell"
): Promise<TradeResult | null> {
  try {
    if (!isPumpFunAvailable()) {
      console.error("pump.fun not available")
      return null
    }

    const tokenMint = new PublicKey(config.tokenMint)
    const bondingCurve = await getBondingCurveData(tokenMint)
    
    if (!bondingCurve) {
      console.error("token not found on pump.fun")
      return null
    }
    if (type === "buy" && bondingCurve.complete) {
      console.error("token migrated - buy not supported")
      return null
    }

    // get anti-detection config
    const adConfig = getAntiDetectionConfig(config)
    
    // get random amount
    const baseAmount = config.minAmount + Math.random() * (config.maxAmount - config.minAmount)
    
    // apply anti-detection
    const params = applyAntiDetection({
      amount: baseAmount,
      slippage: 10,
      priorityFee: 0.0005,
    }, adConfig)
    
    // wait for rate limit
    const rateLimiter = getRateLimiter(adConfig)
    await rateLimiter.waitForSlot()
    
    // apply delay
    if (params.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, params.delayMs))
    }

    let transaction: Transaction
    let tokensTraded = 0

    const safeSlippage = clampPercent(params.slippage)

    if (type === "buy") {
      // calculate tokens out
      const { tokensOut } = calculateBuyAmount(bondingCurve, params.amount)
      const minTokensOut = tokensOut > BigInt(0)
        ? (tokensOut * BigInt(100 - safeSlippage)) / BigInt(100)
        : BigInt(0)
      
      transaction = await buildBuyTransaction(
        wallet.publicKey,
        tokenMint,
        params.amount,
        minTokensOut,
        params.priorityFee
      )
      tokensTraded = Number(tokensOut) / 1e6
    } else {
      // get token balance
      const ata = await getAssociatedTokenAddress(tokenMint, wallet.publicKey, false)
      const balanceInfo = await connection.getTokenAccountBalance(ata)
      const balance = BigInt(balanceInfo.value.amount)
      
      if (balance === BigInt(0)) {
        return null
      }
      
      // sell percentage of balance (random 50-100%)
      const sellPercent = 50 + Math.random() * 50
      const sellAmount = (balance * BigInt(Math.floor(sellPercent))) / BigInt(100)
      
      // migrated tokens: try pumpswap
      if (bondingCurve.complete) {
        const pool = await getPumpswapPoolData(tokenMint)
        if (!pool) {
          console.error("pumpswap pool unavailable for migrated token")
          return null
        }
        const { solOut } = calculatePumpswapSwapAmount(pool, sellAmount, true)
        const minSolOut = solOut > BigInt(0)
          ? (solOut * BigInt(100 - safeSlippage)) / BigInt(100)
          : BigInt(0)
        transaction = await buildPumpswapSwapTransaction(
          wallet.publicKey,
          tokenMint,
          sellAmount,
          minSolOut,
          params.priorityFee
        )
        tokensTraded = Number(sellAmount) / 1e6
      } else {
        const { solOut } = calculateSellAmount(bondingCurve, sellAmount)
        const minSolOut = solOut > BigInt(0)
          ? (solOut * BigInt(100 - safeSlippage)) / BigInt(100)
          : BigInt(0)
      
        transaction = await buildSellTransaction(
          wallet.publicKey,
          tokenMint,
          sellAmount,
          minSolOut,
          params.priorityFee
        )
        tokensTraded = Number(sellAmount) / 1e6
      }
    }

    // sign and send
    transaction.sign(wallet)
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    })
    
    await connection.confirmTransaction(signature, "confirmed")
    
    const price = calculateTokenPrice(bondingCurve)
    
    return {
      signature,
      type,
      amount: params.amount.toFixed(6),
      tokensTraded: tokensTraded.toFixed(2),
      price: price.toFixed(10),
      timestamp: new Date(),
      walletAddress: wallet.publicKey.toBase58(),
    }
  } catch (error: any) {
    console.error("trade execution error:", error.message)
    return null
  }
}

/**
 * Start volume bot session
 */
export async function startVolumeBot(
  config: VolumeBotConfig,
  wallets: Keypair[]
): Promise<string> {
  const sessionId = `vol-${Date.now()}`
  
  const session: VolumeBotSession = {
    id: sessionId,
    config,
    wallets,
    isRunning: true,
    trades: [],
    startedAt: new Date(),
    totalVolumeSol: 0,
    totalTrades: 0,
  }
  
  sessions.set(sessionId, session)
  
  // run trading loop in background
  runTradingLoop(sessionId)
  
  return sessionId
}

/**
 * Stop volume bot session
 */
export function stopVolumeBot(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  
  session.isRunning = false
  session.stoppedAt = new Date()
  
  return true
}

/**
 * Get session status
 */
export function getSessionStatus(sessionId: string): VolumeBotSession | null {
  return sessions.get(sessionId) || null
}

/**
 * Get all active sessions
 */
export function getActiveSessions(): VolumeBotSession[] {
  return Array.from(sessions.values()).filter(s => s.isRunning)
}

/**
 * Trading loop
 */
async function runTradingLoop(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  
  const { config, wallets } = session
  const adConfig = getAntiDetectionConfig(config)
  
  while (session.isRunning) {
    try {
      // pick random wallet
      const wallet = wallets[Math.floor(Math.random() * wallets.length)]
      
      // decide buy or sell (60% buy, 40% sell)
      const type = Math.random() > 0.4 ? "buy" : "sell"
      
      const result = await executeTrade(wallet, config, type)
      
      if (result) {
        session.trades.push(result)
        session.totalTrades++
        session.totalVolumeSol += parseFloat(result.amount)
      }
      
      // wait interval with randomization
      let interval = config.intervalSeconds * 1000
      if (config.randomDelays) {
        const variation = interval * 0.3 // +/- 30%
        interval = interval + (Math.random() * variation * 2) - variation
      }
      
      await new Promise(resolve => setTimeout(resolve, interval))
    } catch (error) {
      console.error("trading loop error:", error)
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
}

/**
 * Generate random delay
 */
export function generateRandomDelay(minSeconds: number, maxSeconds: number): number {
  return Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds
}

/**
 * Check if trade should execute (anti-detection check)
 */
export function shouldExecuteTrade(antiDetection: boolean): boolean {
  if (!antiDetection) return true
  return Math.random() > 0.1 // 90% chance
}
