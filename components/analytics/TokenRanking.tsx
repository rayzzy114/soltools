"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, Crown, Medal, Award } from "lucide-react"
import type { TokenPnL } from "@/lib/pnl/types"

interface TokenRankingProps {
  tokens: TokenPnL[]
  limit?: number
  sortBy?: "pnl" | "roi" | "volume"
}

export function TokenRanking({ tokens, limit = 10, sortBy = "pnl" }: TokenRankingProps) {
  const sorted = [...tokens].sort((a, b) => {
    switch (sortBy) {
      case "roi":
        return b.roi - a.roi
      case "volume":
        return (b.totalBought + b.totalSold) - (a.totalBought + a.totalSold)
      default:
        return b.realizedPnL - a.realizedPnL
    }
  }).slice(0, limit)

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 0:
        return <Crown className="w-4 h-4 text-yellow-400" />
      case 1:
        return <Medal className="w-4 h-4 text-neutral-300" />
      case 2:
        return <Award className="w-4 h-4 text-orange-400" />
      default:
        return <span className="text-xs text-neutral-500 w-4 text-center">{rank + 1}</span>
    }
  }

  if (sorted.length === 0) {
    return (
      <Card className="bg-neutral-900 border-neutral-700">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-neutral-500 tracking-wider">
            TOKEN RANKING
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center text-neutral-500 py-4">
            no token data
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="bg-neutral-900 border-neutral-700">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-neutral-500 tracking-wider">
            TOKEN RANKING
          </CardTitle>
          <div className="flex items-center gap-1">
            {["pnl", "roi", "volume"].map((type) => (
              <Badge
                key={type}
                className={sortBy === type 
                  ? "bg-cyan-500/20 text-cyan-400 cursor-pointer" 
                  : "bg-neutral-800 text-neutral-400 cursor-pointer hover:bg-neutral-700"
                }
              >
                {type.toUpperCase()}
              </Badge>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {sorted.map((token, i) => {
            const isProfit = token.realizedPnL >= 0
            const totalVolume = token.totalBought + token.totalSold
            
            return (
              <div
                key={token.mintAddress}
                className="flex items-center gap-3 p-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 transition-colors"
              >
                <div className="flex items-center justify-center w-6">
                  {getRankIcon(i)}
                </div>
                
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-cyan-400 flex items-center justify-center text-black font-bold text-xs">
                  {token.symbol?.charAt(0) || "?"}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium truncate">
                      {token.symbol || token.mintAddress.slice(0, 6)}
                    </span>
                    {token.currentPosition > 0 && (
                      <Badge className="bg-blue-500/20 text-blue-400 text-[10px]">
                        holding
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {token.trades.length} trades · {totalVolume.toFixed(2)} SOL vol
                  </div>
                </div>
                
                <div className="text-right">
                  <div className={`font-mono text-sm flex items-center gap-1 ${isProfit ? "text-green-400" : "text-red-400"}`}>
                    {isProfit ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {isProfit ? "+" : ""}{token.realizedPnL.toFixed(4)}
                  </div>
                  <div className={`text-xs ${isProfit ? "text-green-400/70" : "text-red-400/70"}`}>
                    {isProfit ? "+" : ""}{token.roi.toFixed(1)}% ROI
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
