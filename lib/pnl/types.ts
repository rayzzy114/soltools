/**
 * PnL Tracking Types
 * Типы для отслеживания прибыли/убытка
 */

export interface Trade {
  id: string
  walletAddress: string
  mintAddress: string
  type: "buy" | "sell"
  solAmount: number      // SOL потраченный/полученный
  tokenAmount: number    // токены купленные/проданные
  price: number          // цена за токен в SOL
  signature: string      // tx signature
  timestamp: Date
  networkFeeSol?: number // network fee in SOL
  priorityFeeSol?: number // priority fee in SOL
  jitoTipSol?: number     // jito tip in SOL
  fee?: number           // total fee override in SOL
}

export interface Position {
  mintAddress: string
  walletAddress: string
  tokenBalance: number       // текущий баланс токенов
  avgBuyPrice: number        // средняя цена покупки
  totalInvested: number      // всего вложено SOL
  totalSold: number          // всего получено SOL от продаж
  tokensBought: number       // всего куплено токенов
  tokensSold: number         // всего продано токенов
  realizedPnl: number        // реализованный PnL (от продаж)
  unrealizedPnl: number      // нереализованный PnL (текущий баланс)
  currentPrice: number       // текущая цена
  roi: number                // ROI в процентах
  isOpen: boolean            // позиция открыта
  firstBuyAt: Date
  lastTradeAt: Date
}

export interface PnLSnapshot {
  id: string
  mintAddress: string
  walletAddress?: string      // если null - агрегированный по всем кошелькам
  realizedPnl: number
  unrealizedPnl: number
  totalPnl: number
  totalInvested: number
  totalReturned: number
  roi: number
  tokenBalance: number
  currentPrice: number
  timestamp: Date
}

export interface WalletPnL {
  walletAddress: string
  positions: Position[]
  totalRealizedPnl: number
  totalUnrealizedPnl: number
  totalPnl: number
  totalInvested: number
  totalReturned: number
  overallRoi: number
}

export interface TokenPnL {
  mintAddress: string
  symbol?: string
  name?: string
  positions: Position[]        // позиции по разным кошелькам
  aggregatedPnl: {
    realizedPnl: number
    unrealizedPnl: number
    totalPnl: number
    totalInvested: number
    totalReturned: number
    roi: number
    totalTokens: number
  }
  currentPrice: number
  isMigrated: boolean
}

export interface PnLSummary {
  totalRealizedPnl: number
  totalUnrealizedPnl: number
  totalPnl: number
  totalInvested: number
  totalReturned: number
  overallRoi: number
  profitableTokens: number
  losingTokens: number
  openPositions: number
  closedPositions: number
  bestPerformer?: {
    mintAddress: string
    symbol?: string
    roi: number
    pnl: number
  }
  worstPerformer?: {
    mintAddress: string
    symbol?: string
    roi: number
    pnl: number
  }
}

export interface PnLCardData {
  title: string
  totalPnl: number
  totalPnlFormatted: string
  roi: number
  roiFormatted: string
  invested: number
  returned: number
  tokenCount: number
  isProfitable: boolean
  timestamp: Date
  trades: {
    symbol: string
    pnl: number
    roi: number
  }[]
}

// для генерации PnL карточки (картинки)
export interface PnLCardStyle {
  theme: "dark" | "light" | "neon"
  showDetails: boolean
  showTrades: boolean
  maxTrades: number
}
