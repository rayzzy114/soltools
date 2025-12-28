"use client"

import { useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Trade } from "@/lib/pnl/types"

interface ActivityHeatmapProps {
  trades: Trade[]
  days?: number
}

export function ActivityHeatmap({ trades, days = 30 }: ActivityHeatmapProps) {
  const heatmapData = useMemo(() => {
    const now = new Date()
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    
    // group trades by day
    const dayMap = new Map<string, { count: number; volume: number; pnl: number }>()
    
    for (let i = 0; i < days; i++) {
      const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000)
      const key = date.toISOString().split("T")[0]
      dayMap.set(key, { count: 0, volume: 0, pnl: 0 })
    }
    
    for (const trade of trades) {
      const key = new Date(trade.timestamp).toISOString().split("T")[0]
      if (dayMap.has(key)) {
        const data = dayMap.get(key)!
        data.count++
        data.volume += trade.solAmount
        if (trade.type === "sell") {
          data.pnl += trade.solAmount
        } else {
          data.pnl -= trade.solAmount
        }
      }
    }
    
    return Array.from(dayMap.entries()).map(([date, data]) => ({
      date,
      ...data,
    }))
  }, [trades, days])

  const maxCount = Math.max(...heatmapData.map(d => d.count), 1)
  
  const getIntensity = (count: number) => {
    if (count === 0) return "bg-neutral-800"
    const intensity = count / maxCount
    if (intensity < 0.25) return "bg-green-500/20"
    if (intensity < 0.5) return "bg-green-500/40"
    if (intensity < 0.75) return "bg-green-500/60"
    return "bg-green-500/80"
  }

  // group by week
  const weeks: typeof heatmapData[][] = []
  let currentWeek: typeof heatmapData = []
  
  for (const day of heatmapData) {
    currentWeek.push(day)
    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }
  }
  if (currentWeek.length > 0) {
    weeks.push(currentWeek)
  }

  const totalTrades = heatmapData.reduce((sum, d) => sum + d.count, 0)
  const totalVolume = heatmapData.reduce((sum, d) => sum + d.volume, 0)
  const activeDays = heatmapData.filter(d => d.count > 0).length

  return (
    <Card className="bg-neutral-900 border-neutral-700">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-neutral-500 tracking-wider">
            ACTIVITY ({days} DAYS)
          </CardTitle>
          <div className="flex items-center gap-4 text-xs text-neutral-400">
            <span>{totalTrades} trades</span>
            <span>{totalVolume.toFixed(2)} SOL</span>
            <span>{activeDays} active days</span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* heatmap grid */}
        <div className="flex gap-1">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-1">
              {week.map((day, di) => (
                <div
                  key={day.date}
                  className={`w-3 h-3 rounded-sm ${getIntensity(day.count)} cursor-pointer transition-transform hover:scale-125`}
                  title={`${day.date}: ${day.count} trades, ${day.volume.toFixed(4)} SOL`}
                />
              ))}
            </div>
          ))}
        </div>
        
        {/* legend */}
        <div className="flex items-center gap-2 mt-4 text-xs text-neutral-500">
          <span>less</span>
          <div className="w-3 h-3 rounded-sm bg-neutral-800" />
          <div className="w-3 h-3 rounded-sm bg-green-500/20" />
          <div className="w-3 h-3 rounded-sm bg-green-500/40" />
          <div className="w-3 h-3 rounded-sm bg-green-500/60" />
          <div className="w-3 h-3 rounded-sm bg-green-500/80" />
          <span>more</span>
        </div>
      </CardContent>
    </Card>
  )
}
