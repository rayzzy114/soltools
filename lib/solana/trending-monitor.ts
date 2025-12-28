/**
 * Trending Monitor - tracks token performance and trending status
 * on pump.fun using on-chain data (pump.fun API blocked since June 2025)
 * 
 * Uses:
 * - Bonding curve account for price/liquidity
 * - Transaction signatures for volume calculation
 * - Token accounts for holder count
 */

import { PublicKey, LAMPORTS_PER_SOL, ConfirmedSignatureInfo, ParsedInstruction } from "@solana/web3.js"
import { connection } from "./config"
import { 
  getBondingCurveData, 
  calculateTokenPrice,
  PUMPFUN_PROGRAM_ID,
  getBondingCurveAddress,
  GRADUATION_SOL_THRESHOLD,
  isPumpFunAvailable,
} from "./pumpfun-sdk"
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token"

// pump.fun trending thresholds (based on 2025 data)
const TRENDING_THRESHOLDS = {
  volume24h: 50, // SOL - minimum to trend
  volumeGold: 200, // SOL - gold trending status
  volumePlatinum: 500, // SOL - platinum trending status
  holders: 100, // minimum holders to trend
  failureThreshold: 50, // SOL in 6 hours or 97% failure rate
}

// SOL price for USD estimation
// ⚠️ WARNING: In production, fetch from oracle (Pyth, Switchboard) or API
// This is a fallback value only
let SOL_PRICE_USD = 150

// fetch current SOL price (call this periodically)
export async function updateSolPrice(): Promise<number> {
  try {
    // use coingecko free API as fallback
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { next: { revalidate: 60 } } // cache for 1 minute
    )
    if (response.ok) {
      const data = await response.json()
      SOL_PRICE_USD = data.solana?.usd || SOL_PRICE_USD
    }
  } catch {
    // keep previous value on error
  }
  return SOL_PRICE_USD
}

export function getSolPriceUsd(): number {
  return SOL_PRICE_USD
}

export interface TokenMetrics {
  mintAddress: string
  name?: string
  symbol?: string
  
  // price data
  currentPrice: number
  priceChange1h: number
  priceChange24h: number
  
  // volume (calculated from on-chain transactions)
  volume1h: number
  volume6h: number
  volume24h: number
  
  // liquidity
  liquiditySol: number
  marketCapUsd: number
  
  // holders (from token accounts)
  holderCount: number
  
  // bonding curve
  bondingCurveProgress: number
  isGraduated: boolean
  
  // trending status
  trendingStatus: "not_trending" | "trending" | "gold" | "platinum"
  trendingScore: number
  
  // health indicators
  healthScore: number
  riskLevel: "low" | "medium" | "high"
  
  lastUpdated: Date
}

export interface TrendingAlert {
  type: "approaching_trending" | "trending_achieved" | "graduation_imminent" | "volume_spike" | "price_pump" | "price_dump"
  mintAddress: string
  message: string
  value: number
  threshold: number
  timestamp: Date
}

type AlertCallback = (alert: TrendingAlert) => void

/**
 * get token holder count from on-chain data
 */
async function getHolderCount(mintAddress: PublicKey): Promise<number> {
  try {
    // get all token accounts for this mint
    const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [
        { dataSize: 165 }, // token account size
        { memcmp: { offset: 0, bytes: mintAddress.toBase58() } },
      ],
    })
    
    // filter accounts with non-zero balance
    let holders = 0
    for (const account of accounts) {
      const data = account.account.data
      // amount is at offset 64, 8 bytes
      const amount = data.readBigUInt64LE(64)
      if (amount > BigInt(0)) {
        holders++
      }
    }
    
    return holders
  } catch {
    return 0
  }
}

/**
 * calculate trading volume from bonding curve transactions
 */
async function calculateVolumeFromTransactions(
  mintAddress: PublicKey,
  hoursBack: number
): Promise<number> {
  try {
    const bondingCurve = getBondingCurveAddress(mintAddress)
    
    // get recent signatures for bonding curve
    const signatures = await connection.getSignaturesForAddress(
      bondingCurve,
      { limit: 300 },
      "confirmed"
    )
    
    const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000)
    let totalVolumeLamports = BigInt(0)
    
    // process in batches
    const recentSigs = signatures.filter(sig => {
      const blockTime = sig.blockTime ? sig.blockTime * 1000 : 0
      return blockTime >= cutoffTime
    })
    
    // fetch transactions in batches of 100
    const batchSize = 100
    for (let i = 0; i < recentSigs.length; i += batchSize) {
      const batch = recentSigs.slice(i, i + batchSize)
      const txs = await connection.getParsedTransactions(
        batch.map(s => s.signature),
        { maxSupportedTransactionVersion: 0 }
      )
      
      for (const tx of txs) {
        if (!tx?.meta) continue
        
        // calculate SOL change in bonding curve
        const preBalance = tx.meta.preBalances[0] || 0
        const postBalance = tx.meta.postBalances[0] || 0
        const change = Math.abs(postBalance - preBalance)
        
        // only count pump.fun program transactions
        const hasPumpFun = tx.transaction.message.accountKeys.some(
          key => key.pubkey.equals(PUMPFUN_PROGRAM_ID)
        )
        
        if (hasPumpFun && change > 0) {
          totalVolumeLamports += BigInt(change)
        }
      }
    }
    
    return Number(totalVolumeLamports) / LAMPORTS_PER_SOL
  } catch {
    return 0
  }
}

export class TrendingMonitor {
  private tokens: Map<string, TokenMetrics> = new Map()
  private priceHistory: Map<string, { timestamp: number; price: number }[]> = new Map()
  private alertCallbacks: AlertCallback[] = []
  private isRunning = false
  private checkIntervalMs = 10000 // 10 seconds
  private intervalId: NodeJS.Timeout | null = null
  
  constructor(checkIntervalMs?: number) {
    if (checkIntervalMs) this.checkIntervalMs = checkIntervalMs
  }
  
  /**
   * add token to monitoring
   */
  addToken(mintAddress: string, name?: string, symbol?: string): void {
    if (this.tokens.has(mintAddress)) return
    
    this.tokens.set(mintAddress, {
      mintAddress,
      name,
      symbol,
      currentPrice: 0,
      priceChange1h: 0,
      priceChange24h: 0,
      volume1h: 0,
      volume6h: 0,
      volume24h: 0,
      liquiditySol: 0,
      marketCapUsd: 0,
      holderCount: 0,
      bondingCurveProgress: 0,
      isGraduated: false,
      trendingStatus: "not_trending",
      trendingScore: 0,
      healthScore: 0,
      riskLevel: "medium",
      lastUpdated: new Date(),
    })
    
    this.priceHistory.set(mintAddress, [])
  }
  
  /**
   * remove token from monitoring
   */
  removeToken(mintAddress: string): void {
    this.tokens.delete(mintAddress)
    this.priceHistory.delete(mintAddress)
  }
  
  /**
   * subscribe to alerts
   */
  onAlert(callback: AlertCallback): void {
    this.alertCallbacks.push(callback)
  }
  
  /**
   * start monitoring
   */
  start(): void {
    if (this.isRunning) return
    this.isRunning = true
    this.intervalId = setInterval(() => this.runMonitorCycle(), this.checkIntervalMs)
    console.log("[trending-monitor] started")
  }
  
  /**
   * stop monitoring
   */
  stop(): void {
    this.isRunning = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    console.log("[trending-monitor] stopped")
  }
  
  /**
   * run single monitoring cycle
   */
  private async runMonitorCycle(): Promise<void> {
    for (const [mintAddress] of this.tokens) {
      try {
        await this.updateTokenMetrics(mintAddress)
      } catch (error) {
        console.error(`[trending-monitor] error updating ${mintAddress}:`, error)
      }
    }
  }
  
  /**
   * update metrics for a token using on-chain data
   */
  private async updateTokenMetrics(mintAddress: string): Promise<void> {
    const metrics = this.tokens.get(mintAddress)
    if (!metrics) return
    if (!isPumpFunAvailable()) {
      metrics.lastUpdated = new Date()
      return
    }
    
    const mint = new PublicKey(mintAddress)
    const bondingCurve = await getBondingCurveData(mint)
    
    if (!bondingCurve) {
      metrics.isGraduated = true
      metrics.bondingCurveProgress = 100
      metrics.lastUpdated = new Date()
      return
    }
    
    // store old price for alerts
    const oldPrice = metrics.currentPrice
    
    // update price from bonding curve
    const newPrice = calculateTokenPrice(bondingCurve)
    
    // store price history
    const priceHist = this.priceHistory.get(mintAddress) || []
    priceHist.push({ timestamp: Date.now(), price: newPrice })
    // keep last 24 hours
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000
    this.priceHistory.set(mintAddress, priceHist.filter(p => p.timestamp > cutoff24h))
    
    // calculate price changes
    const price1hAgo = this.getPriceAtTime(mintAddress, Date.now() - 60 * 60 * 1000)
    const price24hAgo = this.getPriceAtTime(mintAddress, cutoff24h)
    
    metrics.currentPrice = newPrice
    metrics.priceChange1h = price1hAgo ? ((newPrice - price1hAgo) / price1hAgo) * 100 : 0
    metrics.priceChange24h = price24hAgo ? ((newPrice - price24hAgo) / price24hAgo) * 100 : 0
    
    // update liquidity from bonding curve
    metrics.liquiditySol = Number(bondingCurve.realSolReserves) / LAMPORTS_PER_SOL
    
    // estimate market cap
    const totalSupply = Number(bondingCurve.tokenTotalSupply) / 1e6
    metrics.marketCapUsd = newPrice * totalSupply * SOL_PRICE_USD
    
    // bonding curve progress (graduation when bondingCurve.complete = true)
    // ~85 SOL threshold is approximate - always use complete flag for actual check
    metrics.bondingCurveProgress = Math.min(100, (metrics.liquiditySol / GRADUATION_SOL_THRESHOLD) * 100)
    metrics.isGraduated = bondingCurve.complete
    
    // get holder count (less frequent - every 5 updates)
    if (Math.random() < 0.2) {
      metrics.holderCount = await getHolderCount(mint)
    }
    
    // calculate volume (less frequent - expensive operation)
    if (Math.random() < 0.1) {
      metrics.volume1h = await calculateVolumeFromTransactions(mint, 1)
      metrics.volume6h = await calculateVolumeFromTransactions(mint, 6)
      metrics.volume24h = await calculateVolumeFromTransactions(mint, 24)
    }
    
    // calculate trending status
    this.updateTrendingStatus(metrics)
    
    // calculate health score
    this.updateHealthScore(metrics)
    
    // check for alerts
    this.checkAlerts(metrics, oldPrice)
    
    metrics.lastUpdated = new Date()
  }
  
  /**
   * get price at specific time from history
   */
  private getPriceAtTime(mintAddress: string, timestamp: number): number | null {
    const history = this.priceHistory.get(mintAddress) || []
    if (history.length === 0) return null
    
    const closest = history.reduce((prev, curr) => {
      if (!prev) return curr
      return Math.abs(curr.timestamp - timestamp) < Math.abs(prev.timestamp - timestamp) ? curr : prev
    }, null as { timestamp: number; price: number } | null)
    
    return closest?.price || null
  }
  
  /**
   * update trending status based on metrics
   */
  private updateTrendingStatus(metrics: TokenMetrics): void {
    // calculate trending score (0-100)
    let score = 0
    
    // volume contribution (40%)
    score += Math.min(40, (metrics.volume24h / TRENDING_THRESHOLDS.volume24h) * 40)
    
    // holder contribution (30%)
    score += Math.min(30, (metrics.holderCount / TRENDING_THRESHOLDS.holders) * 30)
    
    // liquidity contribution (20%)
    score += Math.min(20, (metrics.liquiditySol / 50) * 20)
    
    // price momentum contribution (10%)
    if (metrics.priceChange1h > 0) {
      score += Math.min(10, metrics.priceChange1h / 10)
    }
    
    metrics.trendingScore = Math.round(score)
    
    // determine status based on volume
    if (metrics.volume24h >= TRENDING_THRESHOLDS.volumePlatinum) {
      metrics.trendingStatus = "platinum"
    } else if (metrics.volume24h >= TRENDING_THRESHOLDS.volumeGold) {
      metrics.trendingStatus = "gold"
    } else if (metrics.volume24h >= TRENDING_THRESHOLDS.volume24h) {
      metrics.trendingStatus = "trending"
    } else {
      metrics.trendingStatus = "not_trending"
    }
  }
  
  /**
   * update health score
   */
  private updateHealthScore(metrics: TokenMetrics): void {
    let health = 50 // start neutral
    
    // positive factors
    if (metrics.volume24h > 10) health += 10
    if (metrics.liquiditySol > 20) health += 10
    if (metrics.priceChange1h > 0) health += 5
    if (metrics.holderCount > 50) health += 10
    if (metrics.bondingCurveProgress > 50) health += 10
    
    // negative factors
    if (metrics.priceChange1h < -20) health -= 20
    if (metrics.liquiditySol < 5) health -= 15
    if (metrics.volume24h < 5) health -= 10
    
    metrics.healthScore = Math.max(0, Math.min(100, health))
    
    // risk level
    if (metrics.healthScore >= 70) {
      metrics.riskLevel = "low"
    } else if (metrics.healthScore >= 40) {
      metrics.riskLevel = "medium"
    } else {
      metrics.riskLevel = "high"
    }
  }
  
  /**
   * check for alert conditions
   */
  private checkAlerts(metrics: TokenMetrics, oldPrice: number): void {
    // approaching trending
    if (metrics.trendingStatus === "not_trending" && metrics.trendingScore > 80) {
      this.emitAlert({
        type: "approaching_trending",
        mintAddress: metrics.mintAddress,
        message: `${metrics.symbol || metrics.mintAddress.slice(0, 8)} approaching trending (${metrics.trendingScore}% score)`,
        value: metrics.trendingScore,
        threshold: 100,
        timestamp: new Date(),
      })
    }
    
    // graduation imminent
    if (metrics.bondingCurveProgress > 90 && !metrics.isGraduated) {
      this.emitAlert({
        type: "graduation_imminent",
        mintAddress: metrics.mintAddress,
        message: `${metrics.symbol || metrics.mintAddress.slice(0, 8)} graduation imminent (${metrics.bondingCurveProgress.toFixed(1)}%)`,
        value: metrics.bondingCurveProgress,
        threshold: 100,
        timestamp: new Date(),
      })
    }
    
    // price pump (>20% in update cycle)
    if (oldPrice > 0 && metrics.currentPrice > oldPrice * 1.2) {
      this.emitAlert({
        type: "price_pump",
        mintAddress: metrics.mintAddress,
        message: `${metrics.symbol || metrics.mintAddress.slice(0, 8)} pumping! +${(((metrics.currentPrice - oldPrice) / oldPrice) * 100).toFixed(1)}%`,
        value: metrics.currentPrice,
        threshold: oldPrice * 1.2,
        timestamp: new Date(),
      })
    }
    
    // price dump (>20% drop)
    if (oldPrice > 0 && metrics.currentPrice < oldPrice * 0.8) {
      this.emitAlert({
        type: "price_dump",
        mintAddress: metrics.mintAddress,
        message: `${metrics.symbol || metrics.mintAddress.slice(0, 8)} dumping! ${(((metrics.currentPrice - oldPrice) / oldPrice) * 100).toFixed(1)}%`,
        value: metrics.currentPrice,
        threshold: oldPrice * 0.8,
        timestamp: new Date(),
      })
    }
  }
  
  /**
   * emit alert to subscribers
   */
  private emitAlert(alert: TrendingAlert): void {
    this.alertCallbacks.forEach(cb => cb(alert))
  }
  
  /**
   * get metrics for a token
   */
  getMetrics(mintAddress: string): TokenMetrics | undefined {
    return this.tokens.get(mintAddress)
  }
  
  /**
   * get all monitored tokens
   */
  getAllMetrics(): TokenMetrics[] {
    return Array.from(this.tokens.values())
  }
  
  /**
   * get trending tokens
   */
  getTrendingTokens(): TokenMetrics[] {
    return this.getAllMetrics()
      .filter(m => m.trendingStatus !== "not_trending")
      .sort((a, b) => b.trendingScore - a.trendingScore)
  }
  
  /**
   * get tokens approaching graduation
   */
  getApproachingGraduation(threshold: number = 80): TokenMetrics[] {
    return this.getAllMetrics()
      .filter(m => !m.isGraduated && m.bondingCurveProgress >= threshold)
      .sort((a, b) => b.bondingCurveProgress - a.bondingCurveProgress)
  }
  
  /**
   * force update for a specific token
   */
  async forceUpdate(mintAddress: string): Promise<TokenMetrics | undefined> {
    if (!this.tokens.has(mintAddress)) return undefined
    await this.updateTokenMetrics(mintAddress)
    return this.tokens.get(mintAddress)
  }
}

// singleton instance
export const trendingMonitor = new TrendingMonitor()

export { TRENDING_THRESHOLDS, getHolderCount, calculateVolumeFromTransactions }
