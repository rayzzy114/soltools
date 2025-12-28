/**
 * Bump Bot - maintains token visibility on pump.fun trending
 * through strategic micro-trades
 */

import { 
  Keypair, 
  PublicKey,
  LAMPORTS_PER_SOL 
} from "@solana/web3.js"
import { connection } from "./config"
import { 
  getBondingCurveData,
  buildBuyTransaction,
  buildSellTransaction,
  calculateBuyAmount,
  calculateSellAmount,
} from "./pumpfun-sdk"
import { sendBundle, createTipInstruction } from "./jito"
import { applyAntiDetection, DEFAULT_ANTI_DETECTION, AntiDetectionConfig } from "./anti-detection"
import bs58 from "bs58"

// pump.fun trending requirements (2025)
// tokens need ~50 SOL volume in first 6 hours to trend
const TRENDING_VOLUME_THRESHOLD = 50 // SOL
const TRENDING_WINDOW_HOURS = 6

export interface BumpConfig {
  // bump amounts
  minBumpSol: number
  maxBumpSol: number
  
  // timing
  bumpIntervalMs: number // time between bumps
  sessionDurationMs: number // total session length
  
  // strategy
  strategy: "micro" | "wave" | "random"
  // micro: constant small trades
  // wave: increasing then decreasing amounts
  // random: randomized amounts and timing
  
  // safety
  maxTotalSpend: number // max SOL to spend on bumps
  stopOnTrending: boolean // stop when token trends
  
  // execution
  useJito: boolean
  jitoTip: number
  antiDetection: Partial<AntiDetectionConfig>
}

const DEFAULT_BUMP_CONFIG: BumpConfig = {
  minBumpSol: 0.001,
  maxBumpSol: 0.01,
  bumpIntervalMs: 30000, // 30 seconds
  sessionDurationMs: 3600000, // 1 hour
  strategy: "random",
  maxTotalSpend: 1,
  stopOnTrending: false,
  useJito: true,
  jitoTip: 0.0001,
  antiDetection: {},
}

export interface BumpSession {
  id: string
  mintAddress: string
  wallet: Keypair
  config: BumpConfig
  isRunning: boolean
  stats: BumpStats
  startedAt: Date
}

export interface BumpStats {
  totalBumps: number
  successfulBumps: number
  failedBumps: number
  totalSolSpent: number
  volumeGenerated: number
  lastBumpAt?: Date
}

const sessions = new Map<string, BumpSession>()

/**
 * calculate bump amount based on strategy
 */
function calculateBumpAmount(config: BumpConfig, bumpNumber: number, totalBumps: number): number {
  const { minBumpSol, maxBumpSol, strategy } = config
  
  switch (strategy) {
    case "micro":
      // constant small amount
      return minBumpSol
      
    case "wave":
      // sine wave pattern - peaks in middle
      const progress = bumpNumber / totalBumps
      const waveMultiplier = Math.sin(progress * Math.PI)
      return minBumpSol + (maxBumpSol - minBumpSol) * waveMultiplier
      
    case "random":
    default:
      // random within range
      return minBumpSol + Math.random() * (maxBumpSol - minBumpSol)
  }
}

/**
 * execute single bump (buy then immediate sell)
 */
async function executeBump(
  session: BumpSession,
  bumpAmount: number
): Promise<{ success: boolean; volumeGenerated: number; error?: string }> {
  try {
    const mint = new PublicKey(session.mintAddress)
    const { wallet, config } = session
    
    // get current bonding curve state
    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve || bondingCurve.complete) {
      return { success: false, volumeGenerated: 0, error: "token graduated or not found" }
    }
    
    // apply anti-detection randomization
    const antiConfig = { ...DEFAULT_ANTI_DETECTION, ...config.antiDetection }
    const adjusted = applyAntiDetection({
      amount: bumpAmount,
      slippage: 20,
      priorityFee: config.jitoTip,
    }, antiConfig)
    
    // calculate expected tokens
    const { tokensOut } = calculateBuyAmount(bondingCurve, adjusted.amount)
    
    // build buy transaction
    const buyTx = await buildBuyTransaction(
      wallet.publicKey,
      mint,
      adjusted.amount,
      BigInt(0), // accept any tokens
      adjusted.priorityFee
    )
    
    if (config.useJito) {
      buyTx.add(createTipInstruction(wallet.publicKey, config.jitoTip))
    }
    
    // sign and send buy
    const { blockhash } = await connection.getLatestBlockhash()
    buyTx.recentBlockhash = blockhash
    buyTx.feePayer = wallet.publicKey
    buyTx.sign(wallet)
    
    if (config.useJito) {
      await sendBundle([buyTx])
    } else {
      const sig = await connection.sendRawTransaction(buyTx.serialize())
      await connection.confirmTransaction(sig)
    }
    
    // wait a bit before selling (looks more natural)
    await new Promise(r => setTimeout(r, adjusted.delayMs || 1000))
    
    // build sell transaction
    const sellTx = await buildSellTransaction(
      wallet.publicKey,
      mint,
      tokensOut,
      BigInt(0), // accept any SOL back
      adjusted.priorityFee
    )
    
    if (config.useJito) {
      sellTx.add(createTipInstruction(wallet.publicKey, config.jitoTip))
    }
    
    const { blockhash: blockhash2 } = await connection.getLatestBlockhash()
    sellTx.recentBlockhash = blockhash2
    sellTx.feePayer = wallet.publicKey
    sellTx.sign(wallet)
    
    if (config.useJito) {
      await sendBundle([sellTx])
    } else {
      const sig = await connection.sendRawTransaction(sellTx.serialize())
      await connection.confirmTransaction(sig)
    }
    
    // volume = buy + sell
    const volumeGenerated = adjusted.amount * 2
    
    return { success: true, volumeGenerated }
  } catch (error: any) {
    return { success: false, volumeGenerated: 0, error: error.message }
  }
}

/**
 * start bump bot session
 */
export function startBumpBot(
  walletSecretKey: string,
  mintAddress: string,
  config: Partial<BumpConfig> = {}
): string {
  const sessionId = `bump-${Date.now()}`
  const wallet = Keypair.fromSecretKey(bs58.decode(walletSecretKey))
  const fullConfig = { ...DEFAULT_BUMP_CONFIG, ...config }
  
  const session: BumpSession = {
    id: sessionId,
    mintAddress,
    wallet,
    config: fullConfig,
    isRunning: true,
    stats: {
      totalBumps: 0,
      successfulBumps: 0,
      failedBumps: 0,
      totalSolSpent: 0,
      volumeGenerated: 0,
    },
    startedAt: new Date(),
  }
  
  sessions.set(sessionId, session)
  
  // start bump loop
  runBumpLoop(sessionId)
  
  console.log(`[bump-bot] started session ${sessionId} for ${mintAddress}`)
  return sessionId
}

/**
 * bump bot main loop
 */
async function runBumpLoop(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  
  const { config } = session
  const estimatedBumps = Math.floor(config.sessionDurationMs / config.bumpIntervalMs)
  let bumpNumber = 0
  
  while (session.isRunning) {
    // check if session expired
    const elapsed = Date.now() - session.startedAt.getTime()
    if (elapsed >= config.sessionDurationMs) {
      console.log(`[bump-bot] session ${sessionId} completed (duration reached)`)
      break
    }
    
    // check if max spend reached
    if (session.stats.totalSolSpent >= config.maxTotalSpend) {
      console.log(`[bump-bot] session ${sessionId} completed (max spend reached)`)
      break
    }
    
    // calculate bump amount
    const bumpAmount = calculateBumpAmount(config, bumpNumber, estimatedBumps)
    
    // execute bump
    const result = await executeBump(session, bumpAmount)
    
    // update stats
    session.stats.totalBumps++
    if (result.success) {
      session.stats.successfulBumps++
      session.stats.totalSolSpent += bumpAmount
      session.stats.volumeGenerated += result.volumeGenerated
      session.stats.lastBumpAt = new Date()
    } else {
      session.stats.failedBumps++
      console.error(`[bump-bot] bump failed: ${result.error}`)
    }
    
    bumpNumber++
    
    // apply random delay variation
    const baseDelay = config.bumpIntervalMs
    const variation = config.strategy === "random" 
      ? (Math.random() - 0.5) * baseDelay * 0.5 
      : 0
    
    await new Promise(r => setTimeout(r, baseDelay + variation))
  }
  
  session.isRunning = false
  console.log(`[bump-bot] session ${sessionId} ended. Stats:`, session.stats)
}

/**
 * stop bump bot session
 */
export function stopBumpBot(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  
  session.isRunning = false
  return true
}

/**
 * get bump session status
 */
export function getBumpSessionStatus(sessionId: string): {
  isRunning: boolean
  stats: BumpStats
  elapsedMs: number
} | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  
  return {
    isRunning: session.isRunning,
    stats: session.stats,
    elapsedMs: Date.now() - session.startedAt.getTime(),
  }
}

/**
 * estimate volume needed to trend
 */
export function estimateVolumeToTrend(currentVolume: number): {
  needed: number
  estimatedBumps: number
  estimatedCost: number
} {
  const needed = Math.max(0, TRENDING_VOLUME_THRESHOLD - currentVolume)
  const avgBumpVolume = (DEFAULT_BUMP_CONFIG.minBumpSol + DEFAULT_BUMP_CONFIG.maxBumpSol) / 2 * 2
  const estimatedBumps = Math.ceil(needed / avgBumpVolume)
  const estimatedCost = estimatedBumps * (DEFAULT_BUMP_CONFIG.minBumpSol + DEFAULT_BUMP_CONFIG.maxBumpSol) / 2
  
  return { needed, estimatedBumps, estimatedCost }
}

/**
 * get all active bump sessions
 */
export function getActiveBumpSessions(): string[] {
  return Array.from(sessions.entries())
    .filter(([_, s]) => s.isRunning)
    .map(([id]) => id)
}

export { DEFAULT_BUMP_CONFIG, TRENDING_VOLUME_THRESHOLD, TRENDING_WINDOW_HOURS }
