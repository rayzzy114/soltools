import { NextRequest, NextResponse } from "next/server"
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { 
  buildRugpullTransaction, 
  checkRugpullStatus, 
  isPumpFunAvailable,
  getUserTokenBalance,
} from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import bs58 from "bs58"
import { z } from "zod"
import { DEFAULT_RUGPULL_SLIPPAGE, SellRoute } from "@/lib/config/limits"
import { getCorrelationId, logger } from "@/lib/logger"

// GET - check rugpull status
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request)
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get("mintAddress")
    const userWallet = searchParams.get("userWallet")

    if (!mintAddress || !userWallet) {
      return NextResponse.json({ error: "mintAddress and userWallet required", correlationId }, { status: 400 })
    }

    if (!isPumpFunAvailable()) {
      return NextResponse.json({ 
        error: `pump.fun not available on ${SOLANA_NETWORK}`,
        correlationId,
      }, { status: 400 })
    }

    const mint = new PublicKey(mintAddress)
    const user = new PublicKey(userWallet)

    const status = await checkRugpullStatus(user, mint)
    const { balance, uiBalance } = await getUserTokenBalance(user, mint)

    return NextResponse.json({
      canRugpull: status.canRugpull,
      isMigrated: status.isMigrated,
      tokenBalance: balance.toString(),
      tokenBalanceUi: uiBalance,
      estimatedSol: (Number(status.estimatedSol) / LAMPORTS_PER_SOL).toFixed(6),
      priceImpact: status.priceImpact.toFixed(2),
      method: status.method,
      warning: status.method === "pumpswap" 
        ? "token migrated to pumpswap - LP is locked, selling will have high price impact"
        : status.method === "bonding_curve"
        ? "token on bonding curve - selling all tokens will crash the price"
        : "no tokens to sell",
      correlationId,
    })
  } catch (error: any) {
    logger.error({ correlationId, error: error?.message }, "error checking rugpull status")
    return NextResponse.json({ error: error.message || "internal server error", correlationId }, { status: 500 })
  }
}

// POST - execute rugpull
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request)
  try {
    const body = await request.json()
    const schema = z.object({
      mintAddress: z.string().min(1, "mintAddress required"),
      userWallet: z.string().min(1, "userWallet required"),
      slippage: z.number().optional(),
      route: z.enum(["auto", "bonding_curve", "pumpswap"]).optional(),
      payoutWallet: z.string().optional(),
    })
    const parsed = schema.parse(body)
    const { mintAddress, userWallet, slippage = DEFAULT_RUGPULL_SLIPPAGE, route = "auto", payoutWallet } = parsed

    if (!mintAddress || !userWallet) {
      return NextResponse.json({ error: "mintAddress and userWallet required", correlationId }, { status: 400 })
    }

    if (!isPumpFunAvailable()) {
      return NextResponse.json({ 
        error: `pump.fun not available on ${SOLANA_NETWORK}`,
        correlationId,
      }, { status: 400 })
    }

    const mint = new PublicKey(mintAddress)
    const user = new PublicKey(userWallet)
    const payout = payoutWallet ? new PublicKey(payoutWallet) : undefined

    const { transaction, method, tokenAmount, estimatedSol } = await buildRugpullTransaction(
      user,
      mint,
      Math.min(Math.max(Math.floor(slippage), 0), 99),
      route as SellRoute,
      payout
    )

    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })

    return NextResponse.json({
      transaction: bs58.encode(serializedTransaction),
      method,
      tokenAmount: tokenAmount.toString(),
      tokenAmountUi: (Number(tokenAmount) / 1e6).toFixed(2),
      estimatedSol: (Number(estimatedSol) / LAMPORTS_PER_SOL).toFixed(6),
      warning: method === "pumpswap" 
        ? "selling on pumpswap AMM - high slippage expected"
        : "selling on bonding curve - price will crash",
      correlationId,
    })
  } catch (error: any) {
    logger.error({ correlationId, error: error?.message }, "error creating rugpull transaction")
    return NextResponse.json({ error: error.message || "internal server error", correlationId }, { status: 500 })
  }
}

