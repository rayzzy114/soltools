"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, DollarSign, Percent, Wallet, Coins } from "lucide-react"
import type { PnLSummary, PnLCardData, Position } from "@/lib/pnl/types"

interface PnLSummaryCardProps {
  summary: PnLSummary
  title?: string
}

export function PnLSummaryCard({ summary, title = "PnL Summary" }: PnLSummaryCardProps) {
  const isProfitable = summary.totalPnl >= 0

  return (
    <Card className={`bg-neutral-900 border ${isProfitable ? "border-green-500/30" : "border-red-500/30"}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-neutral-500">{title}</CardTitle>
          <Badge className={isProfitable ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}>
            {isProfitable ? <TrendingUp className="w-3 h-3 mr-1" /> : <TrendingDown className="w-3 h-3 mr-1" />}
            {summary.overallRoi >= 0 ? "+" : ""}{summary.overallRoi.toFixed(2)}%
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Total PnL */}
        <div className="text-center py-4">
          <p className="text-xs text-neutral-500 uppercase tracking-wider">Total PnL</p>
          <p className={`text-3xl font-bold font-mono ${isProfitable ? "text-green-400" : "text-red-400"}`}>
            {summary.totalPnl >= 0 ? "+" : ""}{summary.totalPnl.toFixed(4)} SOL
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 bg-neutral-800 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-green-400" />
              <span className="text-xs text-neutral-400">Realized</span>
            </div>
            <p className={`font-mono text-sm ${summary.totalRealizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {summary.totalRealizedPnl >= 0 ? "+" : ""}{summary.totalRealizedPnl.toFixed(4)}
            </p>
          </div>

          <div className="p-3 bg-neutral-800 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <TrendingDown className="w-4 h-4 text-yellow-400" />
              <span className="text-xs text-neutral-400">Unrealized</span>
            </div>
            <p className={`font-mono text-sm ${summary.totalUnrealizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {summary.totalUnrealizedPnl >= 0 ? "+" : ""}{summary.totalUnrealizedPnl.toFixed(4)}
            </p>
          </div>

          <div className="p-3 bg-neutral-800 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-cyan-400" />
              <span className="text-xs text-neutral-400">Invested</span>
            </div>
            <p className="font-mono text-sm text-white">{summary.totalInvested.toFixed(4)}</p>
          </div>

          <div className="p-3 bg-neutral-800 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <Wallet className="w-4 h-4 text-purple-400" />
              <span className="text-xs text-neutral-400">Returned</span>
            </div>
            <p className="font-mono text-sm text-white">{summary.totalReturned.toFixed(4)}</p>
          </div>
        </div>

        {/* Position Stats */}
        <div className="flex justify-between items-center pt-2 border-t border-neutral-700">
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-lg font-bold text-green-400">{summary.profitableTokens}</p>
              <p className="text-xs text-neutral-500">Profitable</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-red-400">{summary.losingTokens}</p>
              <p className="text-xs text-neutral-500">Losing</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-lg font-bold text-cyan-400">{summary.openPositions}</p>
              <p className="text-xs text-neutral-500">Open</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-neutral-400">{summary.closedPositions}</p>
              <p className="text-xs text-neutral-500">Closed</p>
            </div>
          </div>
        </div>

        {/* Best/Worst Performers */}
        {(summary.bestPerformer || summary.worstPerformer) && (
          <div className="space-y-2 pt-2 border-t border-neutral-700">
            {summary.bestPerformer && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-neutral-400">Best Performer</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-white">
                    {summary.bestPerformer.symbol || summary.bestPerformer.mintAddress.slice(0, 6)}
                  </span>
                  <Badge className="bg-green-500/20 text-green-400 text-xs">
                    +{summary.bestPerformer.roi.toFixed(1)}%
                  </Badge>
                </div>
              </div>
            )}
            {summary.worstPerformer && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-neutral-400">Worst Performer</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-white">
                    {summary.worstPerformer.symbol || summary.worstPerformer.mintAddress.slice(0, 6)}
                  </span>
                  <Badge className="bg-red-500/20 text-red-400 text-xs">
                    {summary.worstPerformer.roi.toFixed(1)}%
                  </Badge>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

interface PositionCardProps {
  position: Position
  symbol?: string
}

export function PositionCard({ position, symbol }: PositionCardProps) {
  const totalPnl = position.realizedPnl + position.unrealizedPnl
  const isProfitable = totalPnl >= 0

  return (
    <Card className={`bg-neutral-800 border ${isProfitable ? "border-green-500/20" : "border-red-500/20"}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isProfitable ? "bg-green-500/20" : "bg-red-500/20"}`}>
              <Coins className={`w-4 h-4 ${isProfitable ? "text-green-400" : "text-red-400"}`} />
            </div>
            <div>
              <p className="font-medium text-white">{symbol || position.mintAddress.slice(0, 8)}</p>
              <p className="text-xs text-neutral-500">{position.isOpen ? "Open" : "Closed"}</p>
            </div>
          </div>
          <Badge className={isProfitable ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}>
            {position.roi >= 0 ? "+" : ""}{position.roi.toFixed(2)}%
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-neutral-500 text-xs">PnL</p>
            <p className={`font-mono ${isProfitable ? "text-green-400" : "text-red-400"}`}>
              {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(4)}
            </p>
          </div>
          <div>
            <p className="text-neutral-500 text-xs">Balance</p>
            <p className="font-mono text-white">{position.tokenBalance.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-neutral-500 text-xs">Avg Buy</p>
            <p className="font-mono text-white">{position.avgBuyPrice.toFixed(8)}</p>
          </div>
          <div>
            <p className="text-neutral-500 text-xs">Current</p>
            <p className="font-mono text-white">{position.currentPrice.toFixed(8)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

interface MiniPnLCardProps {
  totalPnl: number
  roi: number
  label?: string
}

export function MiniPnLCard({ totalPnl, roi, label = "PnL" }: MiniPnLCardProps) {
  const isProfitable = totalPnl >= 0

  return (
    <div className={`px-1.5 py-0.5 rounded border ${isProfitable ? "bg-green-500/10 border-green-500/30" : "bg-red-500/10 border-red-500/30"}`}>
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-neutral-400">{label}</span>
        <p className={`text-[10px] font-mono ${isProfitable ? "text-green-400" : "text-red-400"}`}>
          {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(3)}
        </p>
        <p className={`text-[9px] ${isProfitable ? "text-green-400/70" : "text-red-400/70"}`}>
          {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
        </p>
        {isProfitable ? (
          <TrendingUp className="w-3 h-3 text-green-400" />
        ) : (
          <TrendingDown className="w-3 h-3 text-red-400" />
        )}
      </div>
    </div>
  )
}

// Export card for social sharing
interface ShareablePnLCardProps {
  data: PnLCardData
}

export function ShareablePnLCard({ data }: ShareablePnLCardProps) {
  return (
    <div className={`w-[400px] p-6 rounded-xl ${data.isProfitable ? "bg-gradient-to-br from-green-900/50 to-neutral-900" : "bg-gradient-to-br from-red-900/50 to-neutral-900"} border ${data.isProfitable ? "border-green-500/30" : "border-red-500/30"}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-white">{data.title}</h2>
        <Badge className={data.isProfitable ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}>
          {data.roiFormatted}
        </Badge>
      </div>

      {/* Main PnL */}
      <div className="text-center py-6 border-y border-neutral-700">
        <p className="text-neutral-400 text-sm mb-1">Total PnL</p>
        <p className={`text-4xl font-bold font-mono ${data.isProfitable ? "text-green-400" : "text-red-400"}`}>
          {data.totalPnlFormatted} SOL
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 my-4">
        <div>
          <p className="text-neutral-500 text-xs">Invested</p>
          <p className="text-white font-mono">{data.invested.toFixed(4)} SOL</p>
        </div>
        <div>
          <p className="text-neutral-500 text-xs">Returned</p>
          <p className="text-white font-mono">{data.returned.toFixed(4)} SOL</p>
        </div>
      </div>

      {/* Top Trades */}
      {data.trades.length > 0 && (
        <div className="mt-4 pt-4 border-t border-neutral-700">
          <p className="text-neutral-400 text-xs mb-2">Top Trades</p>
          <div className="space-y-1">
            {data.trades.slice(0, 5).map((trade, i) => (
              <div key={i} className="flex justify-between items-center text-sm">
                <span className="text-white">{trade.symbol}</span>
                <span className={trade.pnl >= 0 ? "text-green-400" : "text-red-400"}>
                  {trade.pnl >= 0 ? "+" : ""}{trade.pnl.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-4 pt-4 border-t border-neutral-700 flex justify-between items-center">
        <span className="text-xs text-neutral-500">{data.tokenCount} tokens traded</span>
        <span className="text-xs text-neutral-500">pump.fun panel</span>
      </div>
    </div>
  )
}
