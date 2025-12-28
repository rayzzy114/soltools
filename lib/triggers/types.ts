/**
 * Auto-Triggers Types
 * Типы для автоматических триггеров продажи
 */

export type TriggerType = 
  | "take_profit"      // продать при росте на X%
  | "stop_loss"        // продать при падении на X%
  | "trailing_stop"    // trailing stop loss
  | "price_target"     // продать при достижении цены
  | "time_based"       // продать через X времени

export type TriggerStatus = "active" | "triggered" | "cancelled" | "expired"

export interface TriggerCondition {
  // для take_profit
  profitPercent?: number      // +50 = продать при росте на 50%
  
  // для stop_loss
  lossPercent?: number        // 20 = продать при падении на 20%
  
  // для trailing_stop
  trailPercent?: number       // 10 = trailing stop на 10% от максимума
  
  // для price_target
  targetPrice?: number        // абсолютная цена в SOL
  priceDirection?: "above" | "below"  // направление
  
  // для time_based
  triggerAfterMinutes?: number  // через сколько минут
  triggerAt?: Date              // или в конкретное время
}

export interface Trigger {
  id: string
  mintAddress: string
  walletAddress: string
  walletSecretKey?: string     // для автоматического исполнения
  
  type: TriggerType
  condition: TriggerCondition
  
  sellPercent: number          // сколько продать (1-100)
  slippage: number             // slippage в процентах
  
  status: TriggerStatus
  
  // tracking
  entryPrice: number           // цена при создании триггера
  highestPrice?: number        // максимальная цена (для trailing stop)
  currentPrice?: number        // текущая цена
  
  // execution
  triggeredAt?: Date
  executedAt?: Date
  signature?: string           // tx signature при исполнении
  soldAmount?: number          // сколько продали
  receivedSol?: number         // сколько получили SOL
  
  // metadata
  createdAt: Date
  updatedAt: Date
  note?: string
}

export interface TriggerCreateParams {
  mintAddress: string
  walletAddress: string
  walletSecretKey?: string
  type: TriggerType
  condition: TriggerCondition
  sellPercent: number
  slippage?: number
  entryPrice?: number
  note?: string
}

export interface TriggerUpdateParams {
  condition?: TriggerCondition
  sellPercent?: number
  slippage?: number
  status?: TriggerStatus
  note?: string
}

export interface TriggerCheckResult {
  triggered: boolean
  reason?: string
  currentPrice: number
  priceChange: number          // % изменения от entry
  shouldExecute: boolean
}

export interface TriggerExecutionResult {
  success: boolean
  trigger: Trigger
  signature?: string
  soldAmount?: number
  receivedSol?: number
  error?: string
}

// настройки движка триггеров
export interface TriggerEngineConfig {
  checkIntervalMs: number      // как часто проверять (default 5000)
  maxRetries: number           // retry при ошибке
  autoExecute: boolean         // автоматически исполнять
  notifyOnTrigger: boolean     // уведомлять при срабатывании
}

// события движка
export type TriggerEventType = 
  | "trigger_created"
  | "trigger_updated"
  | "trigger_checked"
  | "trigger_triggered"
  | "trigger_executed"
  | "trigger_failed"
  | "trigger_cancelled"

export interface TriggerEvent {
  type: TriggerEventType
  trigger: Trigger
  timestamp: Date
  details?: Record<string, any>
}

export type TriggerEventHandler = (event: TriggerEvent) => void
