import { NextRequest, NextResponse } from "next/server"
import {
  trendingMonitor,
  TRENDING_THRESHOLDS,
} from "@/lib/solana/trending-monitor"

// POST - manage monitoring
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, mintAddress, name, symbol } = body

    switch (action) {
      case "add_token": {
        if (!mintAddress) {
          return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
        }

        trendingMonitor.addToken(mintAddress, name, symbol)
        return NextResponse.json({ 
          success: true, 
          message: `added ${mintAddress} to monitoring` 
        })
      }

      case "remove_token": {
        if (!mintAddress) {
          return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
        }

        trendingMonitor.removeToken(mintAddress)
        return NextResponse.json({ 
          success: true, 
          message: `removed ${mintAddress} from monitoring` 
        })
      }

      case "start": {
        trendingMonitor.start()
        return NextResponse.json({ success: true, message: "monitoring started" })
      }

      case "stop": {
        trendingMonitor.stop()
        return NextResponse.json({ success: true, message: "monitoring stopped" })
      }

      default:
        return NextResponse.json({ error: "invalid action" }, { status: 400 })
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// GET - get metrics
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get("mintAddress")
    const filter = searchParams.get("filter") // trending, graduating, all

    if (mintAddress) {
      const metrics = trendingMonitor.getMetrics(mintAddress)
      if (!metrics) {
        return NextResponse.json({ error: "token not monitored" }, { status: 404 })
      }
      return NextResponse.json(metrics)
    }

    switch (filter) {
      case "trending":
        return NextResponse.json({
          tokens: trendingMonitor.getTrendingTokens(),
          thresholds: TRENDING_THRESHOLDS,
        })

      case "graduating":
        const threshold = Number(searchParams.get("threshold")) || 80
        return NextResponse.json({
          tokens: trendingMonitor.getApproachingGraduation(threshold),
          graduationThreshold: 85, // SOL
        })

      default:
        return NextResponse.json({
          tokens: trendingMonitor.getAllMetrics(),
          thresholds: TRENDING_THRESHOLDS,
        })
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
