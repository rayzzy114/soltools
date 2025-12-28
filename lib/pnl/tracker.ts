/**
 * PnL Tracker
 * Расчет прибыли/убытка по трейдам
 */

import type {
  Trade,
  Position,
  PnLSnapshot,
  WalletPnL,
  TokenPnL,
  PnLSummary,
  PnLCardData,
} from "./types"

/**
 * создать новую позицию
 */
export function createPosition(
  mintAddress: string,
  walletAddress: string,
  currentPrice: number = 0
): Position {
  return {
    mintAddress,
    walletAddress,
    tokenBalance: 0,
    avgBuyPrice: 0,
    totalInvested: 0,
    totalSold: 0,
    tokensBought: 0,
    tokensSold: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    currentPrice,
    roi: 0,
    isOpen: false,
    firstBuyAt: new Date(),
    lastTradeAt: new Date(),
  }
}

/**
 * обновить позицию после трейда
 */
export function updatePositionWithTrade(
  position: Position,
  trade: Trade
): Position {
  const updated = { ...position }
  updated.lastTradeAt = trade.timestamp
  const feeComponents = (trade.networkFeeSol ?? 0) + (trade.priorityFeeSol ?? 0) + (trade.jitoTipSol ?? 0)
  const feeTotalRaw = typeof trade.fee === "number" ? trade.fee : feeComponents
  const feeTotal = Number.isFinite(feeTotalRaw) ? feeTotalRaw : 0

  if (trade.type === "buy") {
    // покупка - увеличиваем позицию
    const prevTotal = updated.tokenBalance * updated.avgBuyPrice
    const newTotal = trade.tokenAmount * trade.price
    
    updated.tokensBought += trade.tokenAmount
    updated.totalInvested += trade.solAmount + feeTotal
    updated.tokenBalance += trade.tokenAmount
    
    // пересчет средней цены покупки (FIFO weighted average)
    if (updated.tokenBalance > 0) {
      updated.avgBuyPrice = (prevTotal + newTotal) / updated.tokenBalance
    }
    
    if (!updated.isOpen) {
      updated.isOpen = true
      updated.firstBuyAt = trade.timestamp
    }
  } else {
    // продажа - уменьшаем позицию и фиксируем PnL
    const sellValue = Math.max(0, trade.solAmount - feeTotal)
    const costBasis = trade.tokenAmount * updated.avgBuyPrice
    const tradePnl = sellValue - costBasis
    
    updated.tokensSold += trade.tokenAmount
    updated.totalSold += sellValue
    updated.tokenBalance -= trade.tokenAmount
    updated.realizedPnl += tradePnl
    
    // если все продали - позиция закрыта
    if (updated.tokenBalance <= 0) {
      updated.tokenBalance = 0
      updated.isOpen = false
    }
  }

  return updated
}

/**
 * обновить unrealized PnL по текущей цене
 */
export function updateUnrealizedPnl(
  position: Position,
  currentPrice: number
): Position {
  const updated = { ...position }
  updated.currentPrice = currentPrice
  
  if (updated.tokenBalance > 0 && updated.avgBuyPrice > 0) {
    const currentValue = updated.tokenBalance * currentPrice
    const costBasis = updated.tokenBalance * updated.avgBuyPrice
    updated.unrealizedPnl = currentValue - costBasis
  } else {
    updated.unrealizedPnl = 0
  }
  
  // ROI = (realized + unrealized) / invested * 100
  const totalPnl = updated.realizedPnl + updated.unrealizedPnl
  if (updated.totalInvested > 0) {
    updated.roi = (totalPnl / updated.totalInvested) * 100
  }
  
  return updated
}

/**
 * построить позиции из списка трейдов
 */
export function buildPositionsFromTrades(
  trades: Trade[],
  currentPrices: Map<string, number>
): Map<string, Position> {
  const positions = new Map<string, Position>()
  
  // сортируем трейды по времени
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  
  for (const trade of sortedTrades) {
    const key = `${trade.mintAddress}:${trade.walletAddress}`
    
    let position = positions.get(key)
    if (!position) {
      position = createPosition(
        trade.mintAddress,
        trade.walletAddress,
        currentPrices.get(trade.mintAddress) || 0
      )
    }
    
    position = updatePositionWithTrade(position, trade)
    position = updateUnrealizedPnl(
      position,
      currentPrices.get(trade.mintAddress) || position.currentPrice
    )
    
    positions.set(key, position)
  }
  
  return positions
}

/**
 * агрегировать PnL по кошельку
 */
export function aggregateWalletPnL(
  positions: Position[],
  walletAddress: string
): WalletPnL {
  const walletPositions = positions.filter(p => p.walletAddress === walletAddress)
  
  let totalRealizedPnl = 0
  let totalUnrealizedPnl = 0
  let totalInvested = 0
  let totalReturned = 0
  
  for (const pos of walletPositions) {
    totalRealizedPnl += pos.realizedPnl
    totalUnrealizedPnl += pos.unrealizedPnl
    totalInvested += pos.totalInvested
    totalReturned += pos.totalSold
  }
  
  const totalPnl = totalRealizedPnl + totalUnrealizedPnl
  const overallRoi = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0
  
  return {
    walletAddress,
    positions: walletPositions,
    totalRealizedPnl,
    totalUnrealizedPnl,
    totalPnl,
    totalInvested,
    totalReturned,
    overallRoi,
  }
}

/**
 * агрегировать PnL по токену
 */
export function aggregateTokenPnL(
  positions: Position[],
  mintAddress: string,
  tokenInfo?: { symbol?: string; name?: string; isMigrated?: boolean }
): TokenPnL {
  const tokenPositions = positions.filter(p => p.mintAddress === mintAddress)
  
  let realizedPnl = 0
  let unrealizedPnl = 0
  let totalInvested = 0
  let totalReturned = 0
  let totalTokens = 0
  let currentPrice = 0
  
  for (const pos of tokenPositions) {
    realizedPnl += pos.realizedPnl
    unrealizedPnl += pos.unrealizedPnl
    totalInvested += pos.totalInvested
    totalReturned += pos.totalSold
    totalTokens += pos.tokenBalance
    currentPrice = pos.currentPrice // берем последнюю
  }
  
  const totalPnl = realizedPnl + unrealizedPnl
  const roi = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0
  
  return {
    mintAddress,
    symbol: tokenInfo?.symbol,
    name: tokenInfo?.name,
    positions: tokenPositions,
    aggregatedPnl: {
      realizedPnl,
      unrealizedPnl,
      totalPnl,
      totalInvested,
      totalReturned,
      roi,
      totalTokens,
    },
    currentPrice,
    isMigrated: tokenInfo?.isMigrated || false,
  }
}

/**
 * общая сводка PnL
 */
export function calculatePnLSummary(positions: Position[]): PnLSummary {
  let totalRealizedPnl = 0
  let totalUnrealizedPnl = 0
  let totalInvested = 0
  let totalReturned = 0
  let profitableTokens = 0
  let losingTokens = 0
  let openPositions = 0
  let closedPositions = 0
  
  // группируем по токену для подсчета profitable/losing
  const tokenPnls = new Map<string, number>()
  
  for (const pos of positions) {
    totalRealizedPnl += pos.realizedPnl
    totalUnrealizedPnl += pos.unrealizedPnl
    totalInvested += pos.totalInvested
    totalReturned += pos.totalSold
    
    if (pos.isOpen) {
      openPositions++
    } else {
      closedPositions++
    }
    
    const pnl = pos.realizedPnl + pos.unrealizedPnl
    const current = tokenPnls.get(pos.mintAddress) || 0
    tokenPnls.set(pos.mintAddress, current + pnl)
  }
  
  // подсчитываем profitable/losing tokens
  let bestPerformer: PnLSummary["bestPerformer"]
  let worstPerformer: PnLSummary["worstPerformer"]
  let bestRoi = -Infinity
  let worstRoi = Infinity
  
  for (const [mintAddress, pnl] of tokenPnls) {
    if (pnl > 0) {
      profitableTokens++
    } else if (pnl < 0) {
      losingTokens++
    }
    
    const pos = positions.find(p => p.mintAddress === mintAddress)
    const roi = pos?.roi || 0
    
    if (roi > bestRoi) {
      bestRoi = roi
      bestPerformer = { mintAddress, roi, pnl }
    }
    if (roi < worstRoi) {
      worstRoi = roi
      worstPerformer = { mintAddress, roi, pnl }
    }
  }
  
  const totalPnl = totalRealizedPnl + totalUnrealizedPnl
  const overallRoi = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0
  
  return {
    totalRealizedPnl,
    totalUnrealizedPnl,
    totalPnl,
    totalInvested,
    totalReturned,
    overallRoi,
    profitableTokens,
    losingTokens,
    openPositions,
    closedPositions,
    bestPerformer,
    worstPerformer,
  }
}

/**
 * создать снимок PnL
 */
export function createPnLSnapshot(
  mintAddress: string,
  position: Position,
  walletAddress?: string
): PnLSnapshot {
  return {
    id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mintAddress,
    walletAddress,
    realizedPnl: position.realizedPnl,
    unrealizedPnl: position.unrealizedPnl,
    totalPnl: position.realizedPnl + position.unrealizedPnl,
    totalInvested: position.totalInvested,
    totalReturned: position.totalSold,
    roi: position.roi,
    tokenBalance: position.tokenBalance,
    currentPrice: position.currentPrice,
    timestamp: new Date(),
  }
}

/**
 * форматировать число для отображения
 */
export function formatPnL(value: number, decimals: number = 4): string {
  const prefix = value >= 0 ? "+" : ""
  return `${prefix}${value.toFixed(decimals)}`
}

export function formatRoi(roi: number): string {
  const prefix = roi >= 0 ? "+" : ""
  return `${prefix}${roi.toFixed(2)}%`
}

export function formatSol(sol: number): string {
  return `${sol.toFixed(4)} SOL`
}

/**
 * создать данные для PnL карточки
 */
export function createPnLCardData(
  summary: PnLSummary,
  tokenPnls: TokenPnL[],
  title: string = "PnL Report"
): PnLCardData {
  const trades = tokenPnls
    .map(t => ({
      symbol: t.symbol || t.mintAddress.slice(0, 6),
      pnl: t.aggregatedPnl.totalPnl,
      roi: t.aggregatedPnl.roi,
    }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 10)
  
  return {
    title,
    totalPnl: summary.totalPnl,
    totalPnlFormatted: formatPnL(summary.totalPnl),
    roi: summary.overallRoi,
    roiFormatted: formatRoi(summary.overallRoi),
    invested: summary.totalInvested,
    returned: summary.totalReturned,
    tokenCount: tokenPnls.length,
    isProfitable: summary.totalPnl >= 0,
    timestamp: new Date(),
    trades,
  }
}

/**
 * PnL Tracker класс для удобного использования
 */
export class PnLTracker {
  private trades: Trade[] = []
  private positions: Map<string, Position> = new Map()
  private currentPrices: Map<string, number> = new Map()
  
  addTrade(trade: Trade): void {
    this.trades.push(trade)
    this.recalculate()
  }
  
  addTrades(trades: Trade[]): void {
    this.trades.push(...trades)
    this.recalculate()
  }
  
  updatePrice(mintAddress: string, price: number): void {
    this.currentPrices.set(mintAddress, price)
    
    // обновляем все позиции с этим токеном
    for (const [key, position] of this.positions) {
      if (position.mintAddress === mintAddress) {
        const updated = updateUnrealizedPnl(position, price)
        this.positions.set(key, updated)
      }
    }
  }
  
  updatePrices(prices: Map<string, number>): void {
    for (const [mint, price] of prices) {
      this.updatePrice(mint, price)
    }
  }
  
  private recalculate(): void {
    this.positions = buildPositionsFromTrades(this.trades, this.currentPrices)
  }
  
  getPosition(mintAddress: string, walletAddress: string): Position | undefined {
    return this.positions.get(`${mintAddress}:${walletAddress}`)
  }
  
  getAllPositions(): Position[] {
    return Array.from(this.positions.values())
  }
  
  getOpenPositions(): Position[] {
    return this.getAllPositions().filter(p => p.isOpen)
  }
  
  getClosedPositions(): Position[] {
    return this.getAllPositions().filter(p => !p.isOpen)
  }
  
  getWalletPnL(walletAddress: string): WalletPnL {
    return aggregateWalletPnL(this.getAllPositions(), walletAddress)
  }
  
  getTokenPnL(mintAddress: string, tokenInfo?: { symbol?: string; name?: string }): TokenPnL {
    return aggregateTokenPnL(this.getAllPositions(), mintAddress, tokenInfo)
  }
  
  getSummary(): PnLSummary {
    return calculatePnLSummary(this.getAllPositions())
  }
  
  getCardData(title?: string): PnLCardData {
    const positions = this.getAllPositions()
    const mints = [...new Set(positions.map(p => p.mintAddress))]
    const tokenPnls = mints.map(mint => this.getTokenPnL(mint))
    return createPnLCardData(this.getSummary(), tokenPnls, title)
  }
  
  getTrades(): Trade[] {
    return [...this.trades]
  }
  
  clear(): void {
    this.trades = []
    this.positions.clear()
  }
}

// экспорт singleton для глобального использования
export const globalPnLTracker = new PnLTracker()
