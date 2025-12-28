"use client"

import { useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { PnLSnapshot, Trade } from "@/lib/pnl/types"

interface PnLChartProps {
  snapshots?: PnLSnapshot[]
  trades?: Trade[]
  height?: number
}

export function PnLChart({ snapshots = [], trades = [], height = 200 }: PnLChartProps) {
  // calculate chart data from snapshots or trades
  const chartData = useMemo(() => {
    if (snapshots.length > 0) {
      return snapshots.map(s => ({
        timestamp: new Date(s.timestamp).getTime(),
        value: s.totalPnL,
        roi: s.roi,
      }))
    }
    
    if (trades.length === 0) return []
    
    // build cumulative PnL from trades
    let cumulative = 0
    return trades
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .map(t => {
        const pnl = t.type === "sell" ? t.solAmount - (t.tokenAmount * 0.00001) : 0
        cumulative += pnl
        return {
          timestamp: new Date(t.timestamp).getTime(),
          value: cumulative,
          roi: 0,
        }
      })
  }, [snapshots, trades])

  if (chartData.length === 0) {
    return (
      <Card className="bg-neutral-900 border-neutral-700">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-neutral-300 tracking-wider">
            P&L CHART
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div 
            className="flex items-center justify-center text-neutral-500"
            style={{ height }}
          >
            no data available
          </div>
        </CardContent>
      </Card>
    )
  }

  // calculate bounds
  const minVal = Math.min(...chartData.map(d => d.value))
  const maxVal = Math.max(...chartData.map(d => d.value))
  const range = maxVal - minVal || 1
  const padding = range * 0.1
  
  const minTime = chartData[0].timestamp
  const maxTime = chartData[chartData.length - 1].timestamp
  const timeRange = maxTime - minTime || 1

  // generate SVG path
  const points = chartData.map((d, i) => {
    const x = ((d.timestamp - minTime) / timeRange) * 100
    const y = 100 - ((d.value - minVal + padding) / (range + padding * 2)) * 100
    return { x, y, value: d.value }
  })

  const pathD = points.map((p, i) => 
    `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`
  ).join(" ")

  // gradient fill path
  const fillD = `${pathD} L ${points[points.length - 1].x} 100 L ${points[0].x} 100 Z`

  const lastValue = chartData[chartData.length - 1].value
  const isPositive = lastValue >= 0

  return (
    <Card className="bg-neutral-900 border-neutral-700">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-neutral-300 tracking-wider">
            P&L CHART
          </CardTitle>
          <span className={`font-mono text-sm ${isPositive ? "text-green-400" : "text-red-400"}`}>
            {isPositive ? "+" : ""}{lastValue.toFixed(4)} SOL
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ height, width: "100%" }}
          className="overflow-visible"
        >
          <defs>
            <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
              <stop 
                offset="0%" 
                stopColor={isPositive ? "#22c55e" : "#ef4444"} 
                stopOpacity="0.3" 
              />
              <stop 
                offset="100%" 
                stopColor={isPositive ? "#22c55e" : "#ef4444"} 
                stopOpacity="0" 
              />
            </linearGradient>
          </defs>
          
          {/* grid lines */}
          <line x1="0" y1="50" x2="100" y2="50" stroke="#404040" strokeWidth="0.3" strokeDasharray="2" />
          <line x1="0" y1="25" x2="100" y2="25" stroke="#404040" strokeWidth="0.2" strokeDasharray="1" />
          <line x1="0" y1="75" x2="100" y2="75" stroke="#404040" strokeWidth="0.2" strokeDasharray="1" />
          
          {/* fill */}
          <path d={fillD} fill="url(#pnlGradient)" />
          
          {/* line */}
          <path 
            d={pathD} 
            fill="none" 
            stroke={isPositive ? "#22c55e" : "#ef4444"} 
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          
          {/* points */}
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r="1.5"
              fill={isPositive ? "#22c55e" : "#ef4444"}
              className="opacity-0 hover:opacity-100 transition-opacity"
            />
          ))}
        </svg>
        
        {/* time axis */}
        <div className="flex justify-between text-[10px] text-neutral-500 mt-2">
          <span>{new Date(minTime).toLocaleDateString()}</span>
          <span>{new Date(maxTime).toLocaleDateString()}</span>
        </div>
      </CardContent>
    </Card>
  )
}
