import { NextResponse } from "next/server"
import { getDashboardStats, getVolumeChartData, getActiveTokens, getRecentActivity, getBundlerStats, getVolumeBotStats } from "@/lib/stats"
import { getCached } from "@/lib/solana/cache"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get("type")

    // Cache TTLs (ms)
    const DASHBOARD_TTL = 5000
    const CHART_TTL = 60000
    const TOKENS_TTL = 10000
    const ACTIVITY_TTL = 5000
    const BOT_TTL = 3000

    switch (type) {
      case "dashboard":
        const stats = await getCached("stats_dashboard", getDashboardStats, DASHBOARD_TTL)
        return NextResponse.json(stats)
      
      case "chart":
        const days = parseInt(searchParams.get("days") || "7")
        const chartData = await getCached(`stats_chart_${days}`, () => getVolumeChartData(days), CHART_TTL)
        return NextResponse.json(chartData)
      
      case "tokens":
        const tokens = await getCached("stats_active_tokens", getActiveTokens, TOKENS_TTL)
        return NextResponse.json(tokens)
      
      case "activity":
        const limit = parseInt(searchParams.get("limit") || "10")
        const activity = await getCached(`stats_activity_${limit}`, () => getRecentActivity(limit), ACTIVITY_TTL)
        return NextResponse.json(activity)
      
      case "bundler":
        const bundlerStats = await getCached("stats_bundler", getBundlerStats, DASHBOARD_TTL)
        return NextResponse.json(bundlerStats)
      
      case "volume-bot":
        const volumeBotStats = await getCached("stats_volume_bot", getVolumeBotStats, BOT_TTL)
        return NextResponse.json(volumeBotStats)
      
      default:
        return NextResponse.json({ error: "Invalid type" }, { status: 400 })
    }
  } catch (error) {
    console.error("Error fetching stats:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

