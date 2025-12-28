/**
 * Anti-Detection System
 * Предотвращение обнаружения бот-активности
 */

export interface AntiDetectionConfig {
  // amount randomization
  randomizeAmounts: boolean
  amountVariationPercent: number // +/- % variation
  
  // timing randomization
  randomizeTiming: boolean
  minDelayMs: number
  maxDelayMs: number
  
  // transaction spacing
  minTimeBetweenTx: number // seconds
  maxTimeBetweenTx: number
  
  // batch size limits
  maxTransactionsPerBlock: number
  maxTransactionsPerMinute: number
  
  // wallet behavior
  useMiddleWallets: boolean      // route through intermediary wallets
  splitLargeAmounts: boolean     // split big trades into smaller ones
  splitThreshold: number         // SOL threshold for splitting
  
  // fee randomization
  randomizePriorityFee: boolean
  minPriorityFee: number
  maxPriorityFee: number
  
  // slippage variation
  randomizeSlippage: boolean
  minSlippage: number
  maxSlippage: number
}

// default config - aggressive anti-detection
export const DEFAULT_ANTI_DETECTION: AntiDetectionConfig = {
  randomizeAmounts: true,
  amountVariationPercent: 15, // +/- 15%
  
  randomizeTiming: true,
  minDelayMs: 500,
  maxDelayMs: 3000,
  
  minTimeBetweenTx: 2,
  maxTimeBetweenTx: 10,
  
  maxTransactionsPerBlock: 3,
  maxTransactionsPerMinute: 10,
  
  useMiddleWallets: false,
  splitLargeAmounts: true,
  splitThreshold: 1, // split if > 1 SOL
  
  randomizePriorityFee: true,
  minPriorityFee: 0.0001,
  maxPriorityFee: 0.001,
  
  randomizeSlippage: true,
  minSlippage: 5,
  maxSlippage: 15,
}

// stealth mode - maximum anti-detection
export const STEALTH_ANTI_DETECTION: AntiDetectionConfig = {
  randomizeAmounts: true,
  amountVariationPercent: 25,
  
  randomizeTiming: true,
  minDelayMs: 2000,
  maxDelayMs: 10000,
  
  minTimeBetweenTx: 10,
  maxTimeBetweenTx: 60,
  
  maxTransactionsPerBlock: 1,
  maxTransactionsPerMinute: 3,
  
  useMiddleWallets: true,
  splitLargeAmounts: true,
  splitThreshold: 0.5,
  
  randomizePriorityFee: true,
  minPriorityFee: 0.00005,
  maxPriorityFee: 0.0005,
  
  randomizeSlippage: true,
  minSlippage: 8,
  maxSlippage: 20,
}

// fast mode - minimal anti-detection for speed
export const FAST_ANTI_DETECTION: AntiDetectionConfig = {
  randomizeAmounts: true,
  amountVariationPercent: 5,
  
  randomizeTiming: false,
  minDelayMs: 0,
  maxDelayMs: 500,
  
  minTimeBetweenTx: 0,
  maxTimeBetweenTx: 2,
  
  maxTransactionsPerBlock: 5,
  maxTransactionsPerMinute: 30,
  
  useMiddleWallets: false,
  splitLargeAmounts: false,
  splitThreshold: 5,
  
  randomizePriorityFee: true,
  minPriorityFee: 0.0005,
  maxPriorityFee: 0.002,
  
  randomizeSlippage: false,
  minSlippage: 10,
  maxSlippage: 10,
}

// helpers
function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Apply amount variation
 */
export function randomizeAmount(amount: number, config: AntiDetectionConfig): number {
  if (!config.randomizeAmounts) return amount
  
  const variation = config.amountVariationPercent / 100
  const factor = 1 + randomFloat(-variation, variation)
  return amount * factor
}

/**
 * Get random delay
 */
export function getRandomDelay(config: AntiDetectionConfig): number {
  if (!config.randomizeTiming) return 0
  return randomInt(config.minDelayMs, config.maxDelayMs)
}

/**
 * Get random priority fee
 */
export function getRandomPriorityFee(config: AntiDetectionConfig): number {
  if (!config.randomizePriorityFee) {
    return (config.minPriorityFee + config.maxPriorityFee) / 2
  }
  return randomFloat(config.minPriorityFee, config.maxPriorityFee)
}

/**
 * Get random slippage
 */
export function getRandomSlippage(config: AntiDetectionConfig): number {
  if (!config.randomizeSlippage) {
    return config.minSlippage
  }
  return randomInt(config.minSlippage, config.maxSlippage)
}

/**
 * Split amount into smaller chunks
 */
export function splitAmount(
  totalAmount: number, 
  config: AntiDetectionConfig
): number[] {
  if (!config.splitLargeAmounts || totalAmount <= config.splitThreshold) {
    return [totalAmount]
  }
  
  const chunks: number[] = []
  let remaining = totalAmount
  
  while (remaining > 0) {
    // random chunk size between 20% and 40% of threshold
    let chunkSize = randomFloat(
      config.splitThreshold * 0.2,
      config.splitThreshold * 0.4
    )
    
    // apply variation
    chunkSize = randomizeAmount(chunkSize, config)
    
    if (chunkSize >= remaining) {
      chunks.push(remaining)
      break
    }
    
    chunks.push(chunkSize)
    remaining -= chunkSize
  }
  
  return chunks
}

/**
 * Calculate optimal batch sizes
 */
export function calculateBatchSizes(
  totalTransactions: number,
  config: AntiDetectionConfig
): number[] {
  const batches: number[] = []
  let remaining = totalTransactions
  
  while (remaining > 0) {
    const batchSize = Math.min(
      remaining,
      randomInt(1, config.maxTransactionsPerBlock)
    )
    batches.push(batchSize)
    remaining -= batchSize
  }
  
  return batches
}

/**
 * Get time between transactions in seconds
 */
export function getTimeBetweenTx(config: AntiDetectionConfig): number {
  return randomFloat(config.minTimeBetweenTx, config.maxTimeBetweenTx)
}

/**
 * Apply anti-detection to transaction parameters
 */
export function applyAntiDetection(
  params: {
    amount: number
    slippage: number
    priorityFee: number
  },
  config: AntiDetectionConfig
): {
  amount: number
  slippage: number
  priorityFee: number
  delayMs: number
} {
  return {
    amount: randomizeAmount(params.amount, config),
    slippage: getRandomSlippage(config),
    priorityFee: getRandomPriorityFee(config),
    delayMs: getRandomDelay(config),
  }
}

/**
 * Rate limiter for anti-detection
 */
export class RateLimiter {
  private timestamps: number[] = []
  private config: AntiDetectionConfig
  
  constructor(config: AntiDetectionConfig) {
    this.config = config
  }
  
  async waitForSlot(): Promise<void> {
    const now = Date.now()
    const oneMinuteAgo = now - 60000
    
    // cleanup old timestamps
    this.timestamps = this.timestamps.filter(t => t > oneMinuteAgo)
    
    // check rate limit
    if (this.timestamps.length >= this.config.maxTransactionsPerMinute) {
      // wait until oldest timestamp expires
      const waitTime = this.timestamps[0] - oneMinuteAgo + 1000
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }
    
    // add base delay
    const delay = getRandomDelay(this.config)
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    
    this.timestamps.push(Date.now())
  }
  
  getStats(): { 
    transactionsLastMinute: number
    remainingCapacity: number 
  } {
    const oneMinuteAgo = Date.now() - 60000
    const recentCount = this.timestamps.filter(t => t > oneMinuteAgo).length
    
    return {
      transactionsLastMinute: recentCount,
      remainingCapacity: Math.max(0, this.config.maxTransactionsPerMinute - recentCount),
    }
  }
}

// singleton rate limiters per config type
const rateLimiters = new Map<string, RateLimiter>()

export function getRateLimiter(config: AntiDetectionConfig): RateLimiter {
  const key = JSON.stringify(config)
  
  if (!rateLimiters.has(key)) {
    rateLimiters.set(key, new RateLimiter(config))
  }
  
  return rateLimiters.get(key)!
}

// ========================
// SIMPLIFIED API (for testing)
// ========================

/**
 * calculate safe slippage based on amount and liquidity
 */
export function calculateSafeSlippage(amount: number, liquiditySol: number): number {
  // base slippage increases with amount/liquidity ratio
  const ratio = amount / liquiditySol
  
  if (ratio < 0.01) return 5  // <1% of liquidity
  if (ratio < 0.05) return 10 // <5% of liquidity
  if (ratio < 0.10) return 15 // <10% of liquidity
  if (ratio < 0.20) return 20 // <20% of liquidity
  return 30 // large trade
}

/**
 * simple random delay (ms)
 */
export function randomDelay(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
}

/**
 * detect sandwich attack risk
 */
export interface SandwichRiskAnalysis {
  level: "low" | "medium" | "high" | "critical"
  score: number // 0-100
  recommendation: string
}

export function detectSandwichRisk(
  amountSol: number,
  liquiditySol: number
): SandwichRiskAnalysis {
  const ratio = amountSol / liquiditySol
  
  if (ratio < 0.02) {
    return {
      level: "low",
      score: 10,
      recommendation: "safe to execute without protection",
    }
  }
  
  if (ratio < 0.05) {
    return {
      level: "medium",
      score: 40,
      recommendation: "consider using jito bundle",
    }
  }
  
  if (ratio < 0.15) {
    return {
      level: "high",
      score: 70,
      recommendation: "use jito bundle with high tip",
    }
  }
  
  return {
    level: "critical",
    score: 95,
    recommendation: "split into multiple transactions with jito protection",
  }
}
