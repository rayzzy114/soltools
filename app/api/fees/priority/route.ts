import { NextRequest, NextResponse } from "next/server"
import { getPriorityFeeRecommendations } from "@/lib/solana/priority-fees"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const computeUnits = Math.max(1, parseInt(searchParams.get("computeUnits") || "400000", 10))
    const data = await getPriorityFeeRecommendations(computeUnits)
    return NextResponse.json(data)
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "failed to fetch priority fees" }, { status: 500 })
  }
}
