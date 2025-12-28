import { NextRequest, NextResponse } from "next/server"
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { buildSellTransaction, isPumpFunAvailable, getBondingCurveData, calculateSellAmount } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import bs58 from "bs58"
import { MIN_SELL_RAW, MAX_SELL_RAW, DEFAULT_SLIPPAGE_PERCENT } from "@/lib/config/limits"
import { z } from "zod"
import { getCorrelationId, logger } from "@/lib/logger"

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request)
  try {
    const body = await request.json()
    const schema = z.object({
      mintAddress: z.string().min(1, "mintAddress required"),
      tokenAmount: z.union([z.string(), z.number()]),
      sellerWallet: z.string().min(1, "sellerWallet required"),
      slippage: z.number().optional(),
    })
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.message, correlationId }, { status: 400 })
    }
    const { mintAddress, tokenAmount, sellerWallet } = parsed.data
    const slippageInput = parsed.data.slippage ?? DEFAULT_SLIPPAGE_PERCENT

    if (!mintAddress || !tokenAmount || !sellerWallet) {
      return NextResponse.json({ error: "missing required parameters", correlationId }, { status: 400 })
    }

    if (!isPumpFunAvailable()) {
      return NextResponse.json({ 
        error: `pump.fun not available on ${SOLANA_NETWORK}. switch to mainnet-beta`,
        correlationId,
      }, { status: 400 })
    }

    const seller = new PublicKey(sellerWallet)
    const mint = new PublicKey(mintAddress)
    const tokenAmountBigInt = BigInt(typeof tokenAmount === "number" ? Math.trunc(tokenAmount) : tokenAmount)
    const slippage = Math.min(Math.max(Math.floor(slippageInput), 0), 99)

    if (tokenAmountBigInt < MIN_SELL_RAW) {
      return NextResponse.json({ error: "tokenAmount must be positive", correlationId }, { status: 400 })
    }
    if (tokenAmountBigInt > MAX_SELL_RAW) {
      return NextResponse.json({ error: "tokenAmount exceeds max supported size", correlationId }, { status: 400 })
    }

    // get bonding curve data
    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return NextResponse.json({ error: "token not found on pump.fun", correlationId }, { status: 404 })
    }

    if (bondingCurve.complete) {
      return NextResponse.json({ error: "token migrated, use pumpswap or raydium", correlationId }, { status: 400 })
    }

    // calculate min SOL with slippage
    const { solOut } = calculateSellAmount(bondingCurve, tokenAmountBigInt)
    const minSolOut = solOut * BigInt(100 - slippage) / BigInt(100)

    const transaction = await buildSellTransaction(seller, mint, tokenAmountBigInt, minSolOut)

    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })

    return NextResponse.json({
      transaction: bs58.encode(serializedTransaction),
      estimatedSol: (Number(solOut) / LAMPORTS_PER_SOL).toFixed(6),
      minSolOut: (Number(minSolOut) / LAMPORTS_PER_SOL).toFixed(6),
      correlationId,
    })
  } catch (error: any) {
    logger.error({ correlationId, error: error?.message }, "error creating sell transaction")
    return NextResponse.json({ error: error.message || "internal server error", correlationId }, { status: 500 })
  }
}
