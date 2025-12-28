/**
 * MEV Protection utilities
 * Protects against sandwich attacks, frontrunning, and other MEV exploits
 * 
 * Note: Solana doesn't have a traditional mempool. MEV happens through:
 * - Validator transaction ordering
 * - Jito bundle auctions
 * - Priority fee competition
 */

import { 
  Transaction, 
  VersionedTransaction,
  TransactionInstruction,
  PublicKey,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import { connection } from "./config"
import { sendBundle, createTipInstruction, JITO_ENDPOINTS, JitoRegion } from "./jito"
import { getBondingCurveAddress } from "./pumpfun-sdk"

export interface MEVProtectionConfig {
  // slippage protection
  maxSlippageBps: number // basis points
  
  // timing protection
  usePrivateMempool: boolean // jito bundle
  skipPreflight: boolean
  
  // compute budget
  priorityFeeLamports: number
  computeUnits: number
  
  // sandwich protection
  useDynamicSlippage: boolean
  minOutputEnforcement: boolean
}

const DEFAULT_MEV_CONFIG: MEVProtectionConfig = {
  maxSlippageBps: 500, // 5%
  usePrivateMempool: true,
  skipPreflight: true,
  priorityFeeLamports: 100000, // 0.0001 SOL
  computeUnits: 200000,
  useDynamicSlippage: true,
  minOutputEnforcement: true,
}

/**
 * calculate safe slippage based on trade size and liquidity
 */
export function calculateSafeSlippage(
  tradeAmountSol: number,
  liquiditySol: number,
  baseSlippageBps: number = 100
): number {
  if (liquiditySol <= 0 || tradeAmountSol <= 0) {
    return baseSlippageBps
  }
  // larger trades relative to liquidity need more slippage
  const tradeImpact = tradeAmountSol / liquiditySol
  
  // scale slippage based on impact
  // <1% of liquidity: base slippage
  // 1-5%: 2x base
  // 5-10%: 3x base
  // >10%: 5x base
  let multiplier = 1
  if (tradeImpact > 0.1) multiplier = 5
  else if (tradeImpact > 0.05) multiplier = 3
  else if (tradeImpact > 0.01) multiplier = 2
  
  return Math.min(baseSlippageBps * multiplier, 2000) // cap at 20%
}

/**
 * add MEV protection to transaction
 */
export function addMEVProtection(
  transaction: Transaction,
  payer: PublicKey,
  config: Partial<MEVProtectionConfig> = {}
): Transaction {
  const fullConfig = { ...DEFAULT_MEV_CONFIG, ...config }
  
  // add compute budget instructions at the start
  const computeIxs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: fullConfig.computeUnits,
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.floor(fullConfig.priorityFeeLamports * 1000 / fullConfig.computeUnits),
    }),
  ]
  
  // prepend compute budget instructions
  const protectedTx = new Transaction()
  computeIxs.forEach(ix => protectedTx.add(ix))
  transaction.instructions.forEach(ix => protectedTx.add(ix))
  
  // copy transaction properties
  protectedTx.recentBlockhash = transaction.recentBlockhash
  protectedTx.feePayer = transaction.feePayer || payer
  
  return protectedTx
}

/**
 * send transaction with MEV protection (via Jito)
 */
export async function sendWithMEVProtection(
  transaction: Transaction | VersionedTransaction,
  payer: PublicKey,
  config: Partial<MEVProtectionConfig> = {},
  region: JitoRegion = "frankfurt"
): Promise<{ success: boolean; bundleId?: string; error?: string }> {
  const fullConfig = { ...DEFAULT_MEV_CONFIG, ...config }
  
  try {
    if (fullConfig.usePrivateMempool) {
      // send via jito bundle for private mempool
      const tipIx = createTipInstruction(payer, fullConfig.priorityFeeLamports / LAMPORTS_PER_SOL)
      
      if (transaction instanceof Transaction) {
        transaction.add(tipIx)
      }
      
      const { bundleId } = await sendBundle([transaction], region)
      return { success: true, bundleId }
    } else {
      // send directly (less protection)
      if (transaction instanceof VersionedTransaction) {
        const sig = await connection.sendTransaction(transaction, {
          skipPreflight: fullConfig.skipPreflight,
        })
        await connection.confirmTransaction(sig)
        return { success: true, bundleId: sig }
      } else {
        const sig = await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: fullConfig.skipPreflight,
        })
        await connection.confirmTransaction(sig)
        return { success: true, bundleId: sig }
      }
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/**
 * analyze MEV risk based on trade parameters and market conditions
 * note: solana has no traditional mempool, MEV happens through validator ordering
 */
export async function detectSandwichRisk(
  tokenMint: string,
  tradeAmountSol: number
): Promise<{ risk: "low" | "medium" | "high"; reason?: string; recommendations: string[] }> {
  const recommendations: string[] = []
  let riskScore = 0
  const reasons: string[] = []
  
  // factor 1: trade size (larger = more attractive to MEV)
  if (tradeAmountSol > 10) {
    riskScore += 40
    reasons.push("large trade size attracts MEV bots")
    recommendations.push("split into multiple smaller trades")
  } else if (tradeAmountSol > 5) {
    riskScore += 25
    reasons.push("moderate trade size may attract attention")
    recommendations.push("consider splitting trade")
  } else if (tradeAmountSol > 1) {
    riskScore += 10
  }
  
  // factor 2: check recent MEV activity on this token
  try {
    const mint = new PublicKey(tokenMint)
    const bondingCurve = getBondingCurveAddress(mint)
    
    // get recent transactions
    const sigs = await connection.getSignaturesForAddress(bondingCurve, { limit: 20 })
    
    // analyze for rapid-fire transactions (potential MEV)
    const recentTimes = sigs
      .filter(s => s.blockTime)
      .map(s => s.blockTime! * 1000)
      .slice(0, 10)
    
    if (recentTimes.length >= 3) {
      // check for clusters of transactions (< 1 second apart)
      let clusters = 0
      for (let i = 1; i < recentTimes.length; i++) {
        if (Math.abs(recentTimes[i] - recentTimes[i-1]) < 1000) {
          clusters++
        }
      }
      
      if (clusters >= 3) {
        riskScore += 30
        reasons.push("high-frequency trading detected on this token")
        recommendations.push("use jito bundle for MEV protection")
      }
    }
  } catch {
    // couldn't analyze, add moderate risk
    riskScore += 15
    reasons.push("unable to analyze recent activity")
  }
  
  // factor 3: recommend jito for any non-trivial trade
  if (tradeAmountSol > 0.5) {
    recommendations.push("use priority fee >= 0.0001 SOL")
    recommendations.push("enable private mempool (jito)")
  }
  
  // determine risk level
  let risk: "low" | "medium" | "high"
  if (riskScore >= 50) {
    risk = "high"
  } else if (riskScore >= 25) {
    risk = "medium"
  } else {
    risk = "low"
  }
  
  return {
    risk,
    reason: reasons.join("; ") || undefined,
    recommendations: recommendations.length > 0 ? recommendations : ["standard transaction should be safe"],
  }
}

/**
 * calculate minimum output with sandwich protection
 */
export function calculateMinOutputWithProtection(
  expectedOutput: bigint,
  slippageBps: number,
  sandwichProtectionBps: number = 100 // extra 1% buffer
): bigint {
  const totalSlippageBps = slippageBps + sandwichProtectionBps
  return expectedOutput * BigInt(10000 - totalSlippageBps) / BigInt(10000)
}

/**
 * split large trade into smaller chunks (anti-MEV)
 */
export function splitTradeForMEVProtection(
  totalAmount: number,
  maxChunkSize: number = 1, // SOL
  minChunks: number = 1
): number[] {
  if (totalAmount <= maxChunkSize) {
    return [totalAmount]
  }
  
  const numChunks = Math.max(minChunks, Math.ceil(totalAmount / maxChunkSize))
  const baseChunk = totalAmount / numChunks
  
  // add some randomization to chunk sizes
  const chunks: number[] = []
  let remaining = totalAmount
  
  for (let i = 0; i < numChunks - 1; i++) {
    const variation = (Math.random() - 0.5) * 0.2 * baseChunk
    const chunk = Math.max(0.001, baseChunk + variation)
    chunks.push(chunk)
    remaining -= chunk
  }
  
  // last chunk gets the remainder
  chunks.push(remaining)
  
  return chunks
}

/**
 * get recommended jito region based on latency
 */
export async function getBestJitoRegion(): Promise<JitoRegion> {
  const regions: JitoRegion[] = ["ny", "amsterdam", "frankfurt", "tokyo", "slc", "london"]
  const latencies: { region: JitoRegion; latency: number }[] = []
  
  for (const region of regions) {
    const start = Date.now()
    try {
      await fetch(`${JITO_ENDPOINTS[region]}/api/v1/bundles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
      })
      latencies.push({ region, latency: Date.now() - start })
    } catch {
      latencies.push({ region, latency: Infinity })
    }
  }
  
  // sort by latency and return best
  latencies.sort((a, b) => a.latency - b.latency)
  return latencies[0].region
}

/**
 * analyze transaction for MEV vulnerability
 */
export function analyzeTransactionMEVRisk(
  instructions: TransactionInstruction[]
): { vulnerable: boolean; risks: string[] } {
  const risks: string[] = []
  
  // check for swap instructions without minimum output
  // this is a simplified check - real implementation would decode instruction data
  
  const hasComputeBudget = instructions.some(
    ix => ix.programId.toBase58() === "ComputeBudget111111111111111111111111111111"
  )
  
  if (!hasComputeBudget) {
    risks.push("no compute budget - may be deprioritized")
  }
  
  // check instruction count
  if (instructions.length > 10) {
    risks.push("many instructions - higher failure risk")
  }
  
  return {
    vulnerable: risks.length > 0,
    risks,
  }
}

export { DEFAULT_MEV_CONFIG }

// ========================
// SIMPLIFIED API (for testing)
// ========================

export interface MEVRiskAnalysis {
  riskScore: number // 0-100
  riskLevel: "low" | "medium" | "high" | "critical"
  factors: string[]
}

/**
 * analyze MEV risk for a transaction
 */
export function analyzeMEVRisk(
  _transaction: Transaction | any,
  amountSol: number
): MEVRiskAnalysis {
  let score = 0
  const factors: string[] = []
  
  // amount-based risk
  if (amountSol > 5) {
    score += 40
    factors.push("large trade size (>5 SOL)")
  } else if (amountSol > 1) {
    score += 20
    factors.push("moderate trade size (1-5 SOL)")
  } else if (amountSol > 0.1) {
    score += 5
    factors.push("small trade size")
  }
  
  // base score for any swap
  score += 15
  factors.push("DEX swap operation")
  
  const level = score >= 60 ? "critical" 
    : score >= 40 ? "high"
    : score >= 20 ? "medium"
    : "low"
  
  return {
    riskScore: Math.min(score, 100),
    riskLevel: level,
    factors,
  }
}

export interface MEVProtectionSuggestion {
  useJito: boolean
  recommendedTip: number
  splitTrade: boolean
  suggestedChunks: number
  additionalNotes: string[]
}

/**
 * suggest protection measures based on risk analysis
 */
export function suggestProtection(analysis: MEVRiskAnalysis): MEVProtectionSuggestion {
  const notes: string[] = []
  
  let useJito = false
  let recommendedTip = 0.0001
  let splitTrade = false
  let suggestedChunks = 1
  
  if (analysis.riskLevel === "critical") {
    useJito = true
    recommendedTip = 0.005
    splitTrade = true
    suggestedChunks = 5
    notes.push("critical risk - use maximum protection")
    notes.push("consider splitting into multiple transactions")
  } else if (analysis.riskLevel === "high") {
    useJito = true
    recommendedTip = 0.002
    splitTrade = true
    suggestedChunks = 3
    notes.push("high risk - jito bundle recommended")
  } else if (analysis.riskLevel === "medium") {
    useJito = true
    recommendedTip = 0.0005
    notes.push("medium risk - jito bundle optional but recommended")
  } else {
    notes.push("low risk - standard transaction should be safe")
  }
  
  return {
    useJito,
    recommendedTip,
    splitTrade,
    suggestedChunks,
    additionalNotes: notes,
  }
}
