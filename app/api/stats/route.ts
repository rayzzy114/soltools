import { NextResponse } from "next/server"
import { getDashboardStats, getVolumeChartData, getActiveTokens, getRecentActivity, getBundlerStats, getVolumeBotStats } from "@/lib/stats"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get("type")

    switch (type) {
      case "dashboard":
        const stats = await getDashboardStats()
        return NextResponse.json(stats)
      
      case "chart":
        const days = parseInt(searchParams.get("days") || "7")
        const chartData = await getVolumeChartData(days)
        return NextResponse.json(chartData)
      
      case "tokens":
        const tokens = await getActiveTokens()
        return NextResponse.json(tokens)
      
      case "activity":
        const limit = parseInt(searchParams.get("limit") || "10")
        const activity = await getRecentActivity(limit)
        return NextResponse.json(activity)
      
      case "bundler":
        const bundlerStats = await getBundlerStats()
        return NextResponse.json(bundlerStats)
      
      case "volume-bot":
        const volumeBotStats = await getVolumeBotStats()
        return NextResponse.json(volumeBotStats)
      
      default:
        return NextResponse.json({ error: "Invalid type" }, { status: 400 })
    }
  } catch (error) {
    console.error("Error fetching stats:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

