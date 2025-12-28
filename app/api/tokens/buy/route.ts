import { NextRequest, NextResponse } from "next/server"
import { PublicKey } from "@solana/web3.js"
import { buildBuyTransaction, isPumpFunAvailable, getBondingCurveData, calculateBuyAmount } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import bs58 from "bs58"
import { MIN_BUY_SOL, MAX_BUY_SOL, DEFAULT_SLIPPAGE_PERCENT } from "@/lib/config/limits"
import { z } from "zod"
import { getCorrelationId, logger } from "@/lib/logger"

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request)
  try {
    const body = await request.json()
    const schema = z.object({
      mintAddress: z.string().min(1, "mintAddress required"),
      solAmount: z.union([z.string(), z.number()]),
      buyerWallet: z.string().min(1, "buyerWallet required"),
      slippage: z.number().optional(),
    })
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.message, correlationId }, { status: 400 })
    }

    const { mintAddress, solAmount, buyerWallet } = parsed.data
    const slippageInput = parsed.data.slippage ?? DEFAULT_SLIPPAGE_PERCENT

    if (!mintAddress || !solAmount || !buyerWallet) {
      return NextResponse.json({ error: "missing required parameters", correlationId }, { status: 400 })
    }

    if (!isPumpFunAvailable()) {
      return NextResponse.json({ 
        error: `pump.fun not available on ${SOLANA_NETWORK}. switch to mainnet-beta`,
        correlationId,
      }, { status: 400 })
    }

    const slippage = Math.min(Math.max(Math.floor(slippageInput), 0), 99)
    const buyer = new PublicKey(buyerWallet)
    const mint = new PublicKey(mintAddress)
    const solAmountNumber = typeof solAmount === "number" ? solAmount : Number(solAmount)

    if (!Number.isFinite(solAmountNumber) || solAmountNumber < MIN_BUY_SOL) {
      return NextResponse.json({ error: `minimum buy amount is ${MIN_BUY_SOL} SOL`, correlationId }, { status: 400 })
    }
    if (solAmountNumber > MAX_BUY_SOL) {
      return NextResponse.json({ error: `maximum buy amount is ${MAX_BUY_SOL} SOL`, correlationId }, { status: 400 })
    }

    // get bonding curve data for slippage calculation
    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return NextResponse.json({ error: "token not found on pump.fun", correlationId }, { status: 404 })
    }

    if (bondingCurve.complete) {
      return NextResponse.json({ error: "token migrated, use pumpswap or raydium", correlationId }, { status: 400 })
    }

    // calculate min tokens with slippage
    const { tokensOut } = calculateBuyAmount(bondingCurve, solAmountNumber)
    const minTokensOut = tokensOut * BigInt(100 - slippage) / BigInt(100)

    const transaction = await buildBuyTransaction(buyer, mint, solAmountNumber, minTokensOut)

    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })

    return NextResponse.json({
      transaction: bs58.encode(serializedTransaction),
      estimatedTokens: tokensOut.toString(),
      minTokensOut: minTokensOut.toString(),
      correlationId,
    })
  } catch (error: any) {
    logger.error({ correlationId, error: error?.message }, "error creating buy transaction")
    return NextResponse.json({ error: error.message || "internal server error", correlationId }, { status: 500 })
  }
}
