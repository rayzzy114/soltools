/**
 * Trigger Engine
 * Движок для автоматического исполнения триггеров
 */

import { Keypair, PublicKey } from "@solana/web3.js"
import bs58 from "bs58"
import {
  getBondingCurveData,
  getMultipleBondingCurves,
  calculateTokenPrice,
  buildSellTransaction,
  calculateSellAmount,
} from "@/lib/solana/pumpfun-sdk"
import { safeConnection, execConnection } from "@/lib/solana/config"
import { getAssociatedTokenAddress } from "@solana/spl-token"
import type {
  Trigger,
  TriggerCreateParams,
  TriggerUpdateParams,
  TriggerCheckResult,
  TriggerExecutionResult,
  TriggerEngineConfig,
  TriggerEventHandler,
  TriggerEvent,
  TriggerStatus,
} from "./types"

// default config
const DEFAULT_CONFIG: TriggerEngineConfig = {
  checkIntervalMs: 5000,
  maxRetries: 3,
  autoExecute: true,
  notifyOnTrigger: true,
}

/**
 * создать новый триггер
 */
export function createTrigger(params: TriggerCreateParams): Trigger {
  const now = new Date()
  
  return {
    id: `trig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mintAddress: params.mintAddress,
    walletAddress: params.walletAddress,
    walletSecretKey: params.walletSecretKey,
    type: params.type,
    condition: params.condition,
    sellPercent: params.sellPercent,
    slippage: params.slippage || 10,
    status: "active",
    entryPrice: params.entryPrice || 0,
    createdAt: now,
    updatedAt: now,
    note: params.note,
  }
}

/**
 * обновить триггер
 */
export function updateTrigger(trigger: Trigger, params: TriggerUpdateParams): Trigger {
  return {
    ...trigger,
    ...params,
    condition: params.condition ? { ...trigger.condition, ...params.condition } : trigger.condition,
    updatedAt: new Date(),
  }
}

/**
 * проверить, сработал ли триггер
 */
export function checkTrigger(trigger: Trigger, currentPrice: number): TriggerCheckResult {
  const priceChange = trigger.entryPrice > 0 
    ? ((currentPrice - trigger.entryPrice) / trigger.entryPrice) * 100 
    : 0

  const result: TriggerCheckResult = {
    triggered: false,
    currentPrice,
    priceChange,
    shouldExecute: false,
  }

  if (trigger.status !== "active") {
    return result
  }

  switch (trigger.type) {
    case "take_profit": {
      const targetPercent = trigger.condition.profitPercent || 0
      if (priceChange >= targetPercent) {
        result.triggered = true
        result.reason = `Take profit triggered: +${priceChange.toFixed(2)}% (target: +${targetPercent}%)`
        result.shouldExecute = true
      }
      break
    }

    case "stop_loss": {
      const lossPercent = trigger.condition.lossPercent || 0
      if (priceChange <= -lossPercent) {
        result.triggered = true
        result.reason = `Stop loss triggered: ${priceChange.toFixed(2)}% (threshold: -${lossPercent}%)`
        result.shouldExecute = true
      }
      break
    }

    case "trailing_stop": {
      const trailPercent = trigger.condition.trailPercent || 10
      const highestPrice = trigger.highestPrice || trigger.entryPrice
      
      // обновляем максимум если цена выросла
      if (currentPrice > highestPrice) {
        // не триггерим, просто обновляем highest
        result.triggered = false
      } else {
        // проверяем падение от максимума
        const dropFromHigh = ((highestPrice - currentPrice) / highestPrice) * 100
        if (dropFromHigh >= trailPercent) {
          result.triggered = true
          result.reason = `Trailing stop triggered: -${dropFromHigh.toFixed(2)}% from high (trail: ${trailPercent}%)`
          result.shouldExecute = true
        }
      }
      break
    }

    case "price_target": {
      const targetPrice = trigger.condition.targetPrice || 0
      const direction = trigger.condition.priceDirection || "above"
      
      if (direction === "above" && currentPrice >= targetPrice) {
        result.triggered = true
        result.reason = `Price target reached: ${currentPrice} >= ${targetPrice}`
        result.shouldExecute = true
      } else if (direction === "below" && currentPrice <= targetPrice) {
        result.triggered = true
        result.reason = `Price target reached: ${currentPrice} <= ${targetPrice}`
        result.shouldExecute = true
      }
      break
    }

    case "time_based": {
      const now = new Date()
      
      if (trigger.condition.triggerAt) {
        if (now >= new Date(trigger.condition.triggerAt)) {
          result.triggered = true
          result.reason = `Time trigger: scheduled at ${trigger.condition.triggerAt}`
          result.shouldExecute = true
        }
      } else if (trigger.condition.triggerAfterMinutes) {
        const triggerTime = new Date(trigger.createdAt.getTime() + trigger.condition.triggerAfterMinutes * 60 * 1000)
        if (now >= triggerTime) {
          result.triggered = true
          result.reason = `Time trigger: ${trigger.condition.triggerAfterMinutes} minutes elapsed`
          result.shouldExecute = true
        }
      }
      break
    }
  }

  return result
}

/**
 * исполнить триггер (продать токены)
 */
export async function executeTrigger(trigger: Trigger): Promise<TriggerExecutionResult> {
  try {
    if (!trigger.walletSecretKey) {
      return {
        success: false,
        trigger,
        error: "wallet secret key not provided",
      }
    }

    const keypair = Keypair.fromSecretKey(bs58.decode(trigger.walletSecretKey))
    const mint = new PublicKey(trigger.mintAddress)

    // получить баланс токенов
    const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
    const tokenAccount = await safeConnection.getTokenAccountBalance(ata)
    const totalBalance = BigInt(tokenAccount.value.amount)

    if (totalBalance === BigInt(0)) {
      return {
        success: false,
        trigger,
        error: "no tokens to sell",
      }
    }

    // сколько продаем
    const sellAmount = (totalBalance * BigInt(trigger.sellPercent)) / BigInt(100)

    // получить bonding curve для расчета min sol out
    const bondingCurve = await getBondingCurveData(mint)
    let minSolOut = BigInt(0)

    if (bondingCurve && !bondingCurve.complete) {
      const { solOut } = calculateSellAmount(bondingCurve, sellAmount)
      minSolOut = (solOut * BigInt(100 - trigger.slippage)) / BigInt(100)
    }

    // build and send transaction
    const transaction = await buildSellTransaction(
      keypair.publicKey,
      mint,
      sellAmount,
      minSolOut,
      0.001 // priority fee
    )

    transaction.sign(keypair)

    const signature = await execConnection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    })

    await safeConnection.confirmTransaction(signature, "confirmed")

    // calculate received sol
    const receivedSol = Number(minSolOut) / 1e9

    return {
      success: true,
      trigger: {
        ...trigger,
        status: "triggered",
        triggeredAt: new Date(),
        executedAt: new Date(),
        signature,
        soldAmount: Number(sellAmount) / 1e6,
        receivedSol,
      },
      signature,
      soldAmount: Number(sellAmount) / 1e6,
      receivedSol,
    }
  } catch (error: any) {
    return {
      success: false,
      trigger,
      error: error.message || "execution failed",
    }
  }
}

/**
 * Trigger Engine класс
 */
export class TriggerEngine {
  private triggers: Map<string, Trigger> = new Map()
  private config: TriggerEngineConfig
  private intervalId: NodeJS.Timeout | null = null
  private eventHandlers: TriggerEventHandler[] = []
  private isRunning: boolean = false

  constructor(config: Partial<TriggerEngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // event handling
  on(handler: TriggerEventHandler): void {
    this.eventHandlers.push(handler)
  }

  off(handler: TriggerEventHandler): void {
    this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
  }

  private emit(event: TriggerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (e) {
        console.error("trigger event handler error:", e)
      }
    }
  }

  // trigger management
  add(params: TriggerCreateParams): Trigger {
    const trigger = createTrigger(params)
    this.triggers.set(trigger.id, trigger)
    
    this.emit({
      type: "trigger_created",
      trigger,
      timestamp: new Date(),
    })
    
    return trigger
  }

  update(id: string, params: TriggerUpdateParams): Trigger | null {
    const trigger = this.triggers.get(id)
    if (!trigger) return null

    const updated = updateTrigger(trigger, params)
    this.triggers.set(id, updated)
    
    this.emit({
      type: "trigger_updated",
      trigger: updated,
      timestamp: new Date(),
    })
    
    return updated
  }

  remove(id: string): boolean {
    const trigger = this.triggers.get(id)
    if (!trigger) return false

    this.triggers.delete(id)
    
    this.emit({
      type: "trigger_cancelled",
      trigger: { ...trigger, status: "cancelled" },
      timestamp: new Date(),
    })
    
    return true
  }

  get(id: string): Trigger | undefined {
    return this.triggers.get(id)
  }

  getAll(): Trigger[] {
    return Array.from(this.triggers.values())
  }

  getActive(): Trigger[] {
    return this.getAll().filter(t => t.status === "active")
  }

  getByMint(mintAddress: string): Trigger[] {
    return this.getAll().filter(t => t.mintAddress === mintAddress)
  }

  getByWallet(walletAddress: string): Trigger[] {
    return this.getAll().filter(t => t.walletAddress === walletAddress)
  }

  // engine control
  start(): void {
    if (this.isRunning) return

    this.isRunning = true
    this.intervalId = setInterval(() => this.checkAllTriggers(), this.config.checkIntervalMs)
    console.log(`trigger engine started (interval: ${this.config.checkIntervalMs}ms)`)
  }

  stop(): void {
    if (!this.isRunning) return

    this.isRunning = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    console.log("trigger engine stopped")
  }

  isActive(): boolean {
    return this.isRunning
  }

  // check triggers
  private async checkAllTriggers(): Promise<void> {
    const activeTriggers = this.getActive()
    if (activeTriggers.length === 0) return

    // group by mint for efficiency
    const byMint = new Map<string, Trigger[]>()
    for (const trigger of activeTriggers) {
      const list = byMint.get(trigger.mintAddress) || []
      list.push(trigger)
      byMint.set(trigger.mintAddress, list)
    }

    const mintAddresses = Array.from(byMint.keys())
    const mintPublicKeys = mintAddresses.map(m => new PublicKey(m))

    try {
      // Batch fetch bonding curves
      const bondingCurves = await getMultipleBondingCurves(mintPublicKeys)

      for (const [mintAddress, triggers] of byMint) {
        const bondingCurve = bondingCurves.get(mintAddress)
        
        if (!bondingCurve) {
          continue // token not found or migrated
        }

        const currentPrice = calculateTokenPrice(bondingCurve)

        for (const trigger of triggers) {
          const result = checkTrigger(trigger, currentPrice)
          
          // update trigger with current price
          const updated: Trigger = {
            ...trigger,
            currentPrice,
            highestPrice: Math.max(trigger.highestPrice || 0, currentPrice),
            updatedAt: new Date(),
          }

          this.emit({
            type: "trigger_checked",
            trigger: updated,
            timestamp: new Date(),
            details: { result },
          })

          if (result.triggered && result.shouldExecute) {
            this.emit({
              type: "trigger_triggered",
              trigger: updated,
              timestamp: new Date(),
              details: { reason: result.reason },
            })

            if (this.config.autoExecute && trigger.walletSecretKey) {
              const execResult = await executeTrigger(updated)
              
              if (execResult.success) {
                this.triggers.set(trigger.id, execResult.trigger)
                this.emit({
                  type: "trigger_executed",
                  trigger: execResult.trigger,
                  timestamp: new Date(),
                  details: { 
                    signature: execResult.signature,
                    soldAmount: execResult.soldAmount,
                    receivedSol: execResult.receivedSol,
                  },
                })
              } else {
                this.emit({
                  type: "trigger_failed",
                  trigger: updated,
                  timestamp: new Date(),
                  details: { error: execResult.error },
                })
              }
            } else {
              // mark as triggered but not executed
              updated.status = "triggered"
              updated.triggeredAt = new Date()
              this.triggers.set(trigger.id, updated)
            }
          } else {
            this.triggers.set(trigger.id, updated)
          }
        }
      }
    } catch (error) {
      console.error(`error checking triggers batch:`, error)
    }
  }

  // manual execution
  async execute(id: string): Promise<TriggerExecutionResult | null> {
    const trigger = this.triggers.get(id)
    if (!trigger) return null

    const result = await executeTrigger(trigger)
    
    if (result.success) {
      this.triggers.set(id, result.trigger)
    }
    
    return result
  }
}

// singleton instance
export const triggerEngine = new TriggerEngine()

// ========================
// HELPER FUNCTIONS (for testing)
// ========================

export interface ConditionData {
  priceChange: number
  price: number
  volume: number
  bondingCurveProgress: number
}

/**
 * evaluate a single condition against data
 */
export function evaluateCondition(
  condition: { field: string; operator: string; value: number },
  data: ConditionData
): boolean {
  const fieldValue = data[condition.field as keyof ConditionData]
  if (fieldValue === undefined) return false
  
  switch (condition.operator) {
    case ">=":
      return fieldValue >= condition.value
    case "<=":
      return fieldValue <= condition.value
    case ">":
      return fieldValue > condition.value
    case "<":
      return fieldValue < condition.value
    case "==":
    case "===":
      return fieldValue === condition.value
    default:
      return false
  }
}
