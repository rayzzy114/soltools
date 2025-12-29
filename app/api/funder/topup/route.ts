import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { funderWalletId, fromPublicKey, amountLamports, signature, status } = body || {}
    if (!funderWalletId || !fromPublicKey || !amountLamports) {
      return NextResponse.json(
        { error: "funderWalletId, fromPublicKey, amountLamports required" },
        { status: 400 }
      )
    }

    const topup = await prisma.funderTopup.create({
      data: {
        funderWalletId,
        fromPublicKey,
        amountLamports: String(amountLamports),
        signature: signature || null,
        status: status || "submitted",
      },
    })

    return NextResponse.json({ topup })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "failed to record topup" }, { status: 500 })
  }
}
