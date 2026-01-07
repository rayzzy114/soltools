import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { safeConnection, getResilientConnection } from "@/lib/solana/config"
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { getBondingCurveData, calculateTokenPrice } from "@/lib/solana/pumpfun-sdk"
import { getPumpswapPoolData } from "@/lib/solana/pumpfun-sdk"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get("mintAddress")

    // Fetch active buyer wallets
    const wallets = await prisma.wallet.findMany({
      where: { role: "buyer", isActive: true },
      select: { publicKey: true, solBalance: true, tokenBalance: true }
    })

    if (wallets.length === 0) {
      return NextResponse.json({
        totalSol: 0,
        totalTokens: 0,
        unrealizedPnl: 0,
        activeWallets: 0,
        price: 0
      })
    }

    // Calculate aggregated balances (from DB for speed, background refresher updates DB)
    let totalSol = 0
    let totalTokens = 0
    
    wallets.forEach(w => {
        totalSol += Number(w.solBalance)
        totalTokens += Number(w.tokenBalance)
    })

    let price = 0
    if (mintAddress) {
        try {
            const mint = new PublicKey(mintAddress)
            const curve = await getBondingCurveData(mint)
            if (curve && !curve.complete) {
                price = calculateTokenPrice(curve)
            } else if (curve?.complete) {
                const pool = await getPumpswapPoolData(mint)
                if (pool) {
                    // Pool price = Sol / Token
                    price = Number(pool.solReserves) / Number(pool.tokenReserves) / 1000 // Adjust decimals
                }
            }
        } catch {}
    }

    const unrealizedPnl = totalTokens * price

    return NextResponse.json({
      totalSol,
      totalTokens,
      unrealizedPnl,
      activeWallets: wallets.length,
      price
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
