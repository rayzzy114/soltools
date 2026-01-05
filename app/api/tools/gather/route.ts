import { NextResponse } from "next/server"
import { executeGather } from "@/lib/solana/gather"

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const result = await executeGather({
      mainAddress: body.mainAddress,
      buyerAddress: body.buyerAddress,
      walletIds: body.walletIds,
      groupIds: body.groupIds,
      priorityFeeMicroLamports: body.priorityFeeMicroLamports,
    })
    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "gather failed" }, { status: 500 })
  }
}

