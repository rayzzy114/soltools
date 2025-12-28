import { NextResponse } from "next/server"
import { fetchJitoTipFloor } from "@/lib/solana/jito-tip"

export async function GET() {
  try {
    const data = await fetchJitoTipFloor(0.1)
    return NextResponse.json(data)
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "failed to fetch jito tip floor" }, { status: 500 })
  }
}
