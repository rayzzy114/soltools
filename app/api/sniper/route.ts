import { NextRequest, NextResponse } from "next/server"
import {
  startGraduationSniper,
  stopGraduationSniper,
  addSniperTarget,
  getSniperSessionStatus,
  getActiveSniperSessions,
  checkGraduationProgress,
  DEFAULT_SNIPER_CONFIG,
} from "@/lib/solana/graduation-sniper"

// POST - start sniper or add target
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, walletSecretKey, targetMints, sessionId, mintAddress, config } = body

    switch (action) {
      case "start": {
        if (!walletSecretKey || !targetMints?.length) {
          return NextResponse.json(
            { error: "walletSecretKey and targetMints required" },
            { status: 400 }
          )
        }

        const newSessionId = startGraduationSniper(walletSecretKey, targetMints, config)
        return NextResponse.json({ sessionId: newSessionId, message: "sniper started" })
      }

      case "stop": {
        if (!sessionId) {
          return NextResponse.json({ error: "sessionId required" }, { status: 400 })
        }

        const stopped = stopGraduationSniper(sessionId)
        return NextResponse.json({ 
          success: stopped, 
          message: stopped ? "sniper stopped" : "session not found" 
        })
      }

      case "add_target": {
        if (!sessionId || !mintAddress) {
          return NextResponse.json(
            { error: "sessionId and mintAddress required" },
            { status: 400 }
          )
        }

        const added = addSniperTarget(sessionId, mintAddress)
        return NextResponse.json({ 
          success: added, 
          message: added ? "target added" : "session not found" 
        })
      }

      case "check_progress": {
        if (!mintAddress) {
          return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
        }

        const progress = await checkGraduationProgress(mintAddress)
        return NextResponse.json({ progress })
      }

      default:
        return NextResponse.json({ error: "invalid action" }, { status: 400 })
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// GET - get session status or list sessions
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get("sessionId")

    if (sessionId) {
      const status = getSniperSessionStatus(sessionId)
      if (!status) {
        return NextResponse.json({ error: "session not found" }, { status: 404 })
      }
      return NextResponse.json(status)
    }

    // list all active sessions
    const sessions = getActiveSniperSessions()
    return NextResponse.json({ 
      sessions,
      defaultConfig: DEFAULT_SNIPER_CONFIG,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
