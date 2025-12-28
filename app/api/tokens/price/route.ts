import { NextRequest, NextResponse } from "next/server"
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { calculateTokenPrice, getBondingCurveData, getPumpswapPoolData } from "@/lib/solana/pumpfun-sdk"
import { prisma } from "@/lib/prisma"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get("mintAddress")
    if (!mintAddress) {
      return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
    }

    let mint: PublicKey
    try {
      mint = new PublicKey(mintAddress)
    } catch {
      return NextResponse.json({ error: "invalid mintAddress format" }, { status: 400 })
    }

    const tokenMeta = await prisma.token.findFirst({
      where: { mintAddress },
      select: { decimals: true },
    })
    const tokenDecimals = tokenMeta?.decimals ?? 6
    const tokenFactor = Math.pow(10, tokenDecimals)

    const poolData = await getPumpswapPoolData(mint)
    if (poolData) {
      const solUi = Number(poolData.solReserves) / LAMPORTS_PER_SOL
      const tokenUi = Number(poolData.tokenReserves) / tokenFactor
      const price = tokenUi > 0 ? solUi / tokenUi : 0
      return NextResponse.json({ price, isMigrated: true })
    }

    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return NextResponse.json({ error: "token not found on pump.fun" }, { status: 404 })
    }

    const price = calculateTokenPrice(bondingCurve)
    return NextResponse.json({ price, isMigrated: false })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "failed to fetch token price" }, { status: 500 })
  }
}
