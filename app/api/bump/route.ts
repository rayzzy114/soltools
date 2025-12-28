import { NextRequest, NextResponse } from "next/server"
import {
  startBumpBot,
  stopBumpBot,
  getBumpSessionStatus,
  getActiveBumpSessions,
  estimateVolumeToTrend,
  DEFAULT_BUMP_CONFIG,
  TRENDING_VOLUME_THRESHOLD,
} from "@/lib/solana/bump-bot"

// POST - start or stop bump bot
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, walletSecretKey, mintAddress, sessionId, config } = body

    switch (action) {
      case "start": {
        if (!walletSecretKey || !mintAddress) {
          return NextResponse.json(
            { error: "walletSecretKey and mintAddress required" },
            { status: 400 }
          )
        }

        const newSessionId = startBumpBot(walletSecretKey, mintAddress, config)
        return NextResponse.json({ 
          sessionId: newSessionId, 
          message: "bump bot started",
          config: { ...DEFAULT_BUMP_CONFIG, ...config },
        })
      }

      case "stop": {
        if (!sessionId) {
          return NextResponse.json({ error: "sessionId required" }, { status: 400 })
        }

        const stopped = stopBumpBot(sessionId)
        return NextResponse.json({ 
          success: stopped, 
          message: stopped ? "bump bot stopped" : "session not found" 
        })
      }

      case "estimate": {
        const currentVolume = body.currentVolume || 0
        const estimate = estimateVolumeToTrend(currentVolume)
        return NextResponse.json({
          ...estimate,
          trendingThreshold: TRENDING_VOLUME_THRESHOLD,
        })
      }

      default:
        return NextResponse.json({ error: "invalid action" }, { status: 400 })
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// GET - get session status
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get("sessionId")

    if (sessionId) {
      const status = getBumpSessionStatus(sessionId)
      if (!status) {
        return NextResponse.json({ error: "session not found" }, { status: 404 })
      }
      return NextResponse.json(status)
    }

    // list all active sessions
    const sessions = getActiveBumpSessions()
    return NextResponse.json({ 
      sessions,
      defaultConfig: DEFAULT_BUMP_CONFIG,
      trendingThreshold: TRENDING_VOLUME_THRESHOLD,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
