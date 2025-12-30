/**
 * Graduation Sniper - monitors tokens approaching migration to pumpswap
 * and executes snipe trades on graduation
 */

import { 
  Connection, 
  PublicKey, 
  Keypair, 
  Transaction,
  LAMPORTS_PER_SOL 
} from "@solana/web3.js"
import { connection, SOLANA_NETWORK } from "./config"
import { 
  getBondingCurveData, 
  calculateTokenPrice,
  buildBuyTransaction,
  GRADUATION_SOL_THRESHOLD,
  BondingCurveData,
  isPumpFunAvailable,
  calculateBondingCurveProgress as sdkCalculateProgress
} from "./pumpfun-sdk"
import { sendBundle, createTipInstruction } from "./jito"
import bs58 from "bs58"

// graduation happens when bonding curve complete flag is set
// approximately when realSolReserves reaches ~85 SOL
// ⚠️ always use bondingCurve.complete for actual check!
const GRADUATION_SOL_LAMPORTS = BigInt(GRADUATION_SOL_THRESHOLD * LAMPORTS_PER_SOL)

export interface GraduationTarget {
  mintAddress: string
  name?: string
  symbol?: string
  currentSolReserves: bigint
  progressPercent: number
  estimatedTimeToGraduation?: number // seconds
  lastChecked: Date
}

export interface SniperConfig {
  // buy config
  buyAmountSol: number
  maxSlippage: number
  priorityFee: number
  
  // timing
  graduationThresholdPercent: number // e.g., 95 = snipe at 95% progress
  checkIntervalMs: number
  
  // safety
  maxTokenAge: number // don't snipe tokens older than X hours
  minLiquidity: number // minimum SOL in curve
  
  // execution
  useJito: boolean
  jitoTip: number
}

const DEFAULT_CONFIG: SniperConfig = {
  buyAmountSol: 0.5,
  maxSlippage: 15,
  priorityFee: 0.001,
  graduationThresholdPercent: 95,
  checkIntervalMs: 2000,
  maxTokenAge: 24,
  minLiquidity: 10,
  useJito: true,
  jitoTip: 0.0005,
}

export interface SniperSession {
  id: string
  targets: Map<string, GraduationTarget>
  config: SniperConfig
  wallet: Keypair
  isRunning: boolean
  executedSnipes: string[]
  startedAt: Date
}

const sessions = new Map<string, SniperSession>()

/**
 * check graduation progress of a token
 */
export async function checkGraduationProgress(mintAddress: string): Promise<GraduationTarget | null> {
  try {
    if (!isPumpFunAvailable()) return null
    const mint = new PublicKey(mintAddress)
    const bondingCurve = await getBondingCurveData(mint)
    
    if (!bondingCurve || bondingCurve.complete) {
      return null // already graduated or doesn't exist
    }
    
    const progressPercent = sdkCalculateProgress(bondingCurve)
    
    return {
      mintAddress,
      currentSolReserves: bondingCurve.realSolReserves,
      progressPercent: Math.min(progressPercent, 100),
      lastChecked: new Date(),
    }
  } catch {
    return null
  }
}

/**
 * estimate time to graduation based on recent volume
 */
export function estimateTimeToGraduation(
  currentReserves: bigint,
  recentVolumePerHour: number
): number | undefined {
  if (recentVolumePerHour <= 0) return undefined
  
  const remaining = Number(GRADUATION_SOL_LAMPORTS - currentReserves)
  if (remaining <= 0) return 0
  
  const hoursRemaining = remaining / (recentVolumePerHour * LAMPORTS_PER_SOL)
  return hoursRemaining * 3600 // convert to seconds
}

/**
 * execute graduation snipe
 */
export async function executeGraduationSnipe(
  wallet: Keypair,
  mintAddress: string,
  config: SniperConfig
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    if (!isPumpFunAvailable()) {
      return { success: false, error: "pump.fun unavailable" }
    }
    const mint = new PublicKey(mintAddress)
    
    // verify still eligible
    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return { success: false, error: "bonding curve not found" }
    }
    
    if (bondingCurve.complete) {
      return { success: false, error: "already graduated" }
    }
    
    // build buy transaction
    const minTokensOut = BigInt(0) // use slippage protection on-chain
    const transaction = await buildBuyTransaction(
      wallet.publicKey,
      mint,
      config.buyAmountSol,
      minTokensOut,
      config.priorityFee
    )
    
    // add jito tip if enabled
    if (config.useJito) {
      transaction.add(createTipInstruction(wallet.publicKey, config.jitoTip))
    }
    
    // sign transaction
    const { blockhash } = await connection.getLatestBlockhash()
    transaction.recentBlockhash = blockhash
    transaction.feePayer = wallet.publicKey
    transaction.sign(wallet)
    
    // send via jito for MEV protection
    if (config.useJito) {
      const { bundleId } = await sendBundle([transaction])
      return { success: true, signature: bundleId }
    } else {
      const signature = await connection.sendRawTransaction(transaction.serialize())
      await connection.confirmTransaction(signature)
      return { success: true, signature }
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/**
 * start graduation sniper session
 */
export function startGraduationSniper(
  walletSecretKey: string,
  targetMints: string[],
  config: Partial<SniperConfig> = {}
): string {
  const sessionId = `sniper-${Date.now()}`
  const wallet = Keypair.fromSecretKey(bs58.decode(walletSecretKey))
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  
  const session: SniperSession = {
    id: sessionId,
    targets: new Map(),
    config: fullConfig,
    wallet,
    isRunning: true,
    executedSnipes: [],
    startedAt: new Date(),
  }
  
  // add initial targets
  targetMints.forEach(mint => {
    session.targets.set(mint, {
      mintAddress: mint,
      currentSolReserves: BigInt(0),
      progressPercent: 0,
      lastChecked: new Date(0),
    })
  })
  
  sessions.set(sessionId, session)
  
  // start monitoring loop
  runSniperLoop(sessionId)
  
  return sessionId
}

/**
 * sniper monitoring loop
 */
async function runSniperLoop(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  
  while (session.isRunning) {
    for (const [mintAddress, target] of session.targets) {
      // skip already sniped
      if (session.executedSnipes.includes(mintAddress)) continue
      
      // check progress
      const updated = await checkGraduationProgress(mintAddress)
      if (!updated) {
        // graduated or error - remove from targets
        session.targets.delete(mintAddress)
        continue
      }
      
      // update target
      session.targets.set(mintAddress, updated)
      
      // check if ready to snipe
      if (updated.progressPercent >= session.config.graduationThresholdPercent) {
        console.log(`[graduation-sniper] ${mintAddress} at ${updated.progressPercent.toFixed(1)}% - executing snipe`)
        
        const result = await executeGraduationSnipe(
          session.wallet,
          mintAddress,
          session.config
        )
        
        if (result.success) {
          session.executedSnipes.push(mintAddress)
          console.log(`[graduation-sniper] snipe successful: ${result.signature}`)
        } else {
          console.error(`[graduation-sniper] snipe failed: ${result.error}`)
        }
      }
    }
    
    await new Promise(r => setTimeout(r, session.config.checkIntervalMs))
  }
}

/**
 * stop sniper session
 */
export function stopGraduationSniper(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  
  session.isRunning = false
  sessions.delete(sessionId)
  return true
}

/**
 * add target to existing session
 */
export function addSniperTarget(sessionId: string, mintAddress: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  
  session.targets.set(mintAddress, {
    mintAddress,
    currentSolReserves: BigInt(0),
    progressPercent: 0,
    lastChecked: new Date(0),
  })
  return true
}

/**
 * get session status
 */
export function getSniperSessionStatus(sessionId: string): {
  isRunning: boolean
  targets: GraduationTarget[]
  executedSnipes: string[]
} | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  
  return {
    isRunning: session.isRunning,
    targets: Array.from(session.targets.values()),
    executedSnipes: session.executedSnipes,
  }
}

/**
 * get all active sessions
 */
export function getActiveSniperSessions(): string[] {
  return Array.from(sessions.keys())
}

export { DEFAULT_CONFIG as DEFAULT_SNIPER_CONFIG }

// ========================
// HELPER FUNCTIONS (for testing)
// ========================

/**
 * calculate bonding curve progress (0-100%)
 */
export function calculateBondingCurveProgress(bondingCurve: BondingCurveData): number {
  // Delegate to SDK impl
  return sdkCalculateProgress(bondingCurve)
}

/**
 * check if token is near graduation
 */
export function isNearGraduation(
  bondingCurve: BondingCurveData,
  thresholdPercent: number = 90
): boolean {
  if (bondingCurve.complete) return false
  const progress = calculateBondingCurveProgress(bondingCurve)
  return progress >= thresholdPercent
}

/**
 * estimate time to graduation based on buy rate
 */
export function estimateGraduationTime(
  bondingCurve: BondingCurveData,
  buyRateSolPerMinute: number
): number {
  if (bondingCurve.complete || buyRateSolPerMinute <= 0) return 0
  
  const currentSol = Number(bondingCurve.realSolReserves) / LAMPORTS_PER_SOL
  const remainingSol = GRADUATION_SOL_THRESHOLD - currentSol
  
  if (remainingSol <= 0) return 0
  
  return remainingSol / buyRateSolPerMinute // minutes
}
