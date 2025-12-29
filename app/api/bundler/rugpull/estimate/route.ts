import { NextRequest, NextResponse } from "next/server"
import {
  calculateBundlerRugpullProfit,
  getBondingCurveData,
  getPumpswapPoolData,
  isPumpFunAvailable,
} from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { getPriorityFeeRecommendations } from "@/lib/solana/priority-fees"
import { fetchJitoTipFloor } from "@/lib/solana/jito-tip"
import { prisma } from "@/lib/prisma"
import { logger, getCorrelationId } from "@/lib/logger"
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"

const toRawTokenAmount = (value: string, decimals: number): bigint => {
  const cleaned = value.trim().replace(/,/g, "")
  if (!cleaned) return BigInt(0)
  const sign = cleaned.startsWith("-") ? "-" : ""
  const normalized = sign ? cleaned.slice(1) : cleaned
  const [whole = "0", frac = ""] = normalized.split(".")
  const wholeDigits = whole.replace(/\D/g, "") || "0"
  const fracDigits = frac.replace(/\D/g, "")
  const padded = (fracDigits + "0".repeat(decimals)).slice(0, decimals)
  const combined = `${wholeDigits}${padded}`.replace(/^0+/, "") || "0"
  const result = BigInt(combined)
  return sign ? -result : result
}

// GET - estimate rugpull profit
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request)
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get("mintAddress")
    const walletAddress = searchParams.get("walletAddress")
    const walletAddressesParam = searchParams.get("walletAddresses")
    const priorityFeeParam = searchParams.get("priorityFee")
    const jitoTipParam = searchParams.get("jitoTip")

    if (!mintAddress) {
      return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
    }

    // Validate mint address format
    try {
      new PublicKey(mintAddress)
    } catch {
      return NextResponse.json({ error: "invalid mintAddress format" }, { status: 400 })
    }

    if (!isPumpFunAvailable()) {
      return NextResponse.json({
        error: `pump.fun not available on ${SOLANA_NETWORK}`,
      }, { status: 400 })
    }

    let wallets: { walletAddress: string; tokenAmount: bigint }[]
    const tokenMeta = await prisma.token.findFirst({
      where: { mintAddress },
      select: { decimals: true },
    })
    const tokenDecimals = tokenMeta?.decimals ?? 6

    if (walletAddress) {
      // Single wallet calculation
      try {
        new PublicKey(walletAddress)
      } catch {
        return NextResponse.json({ error: "invalid walletAddress format" }, { status: 400 })
      }

      // Get specific wallet balance from DB
      const dbWallet = await prisma.wallet.findUnique({
        where: { publicKey: walletAddress },
      })

      if (!dbWallet || !dbWallet.isActive) {
        return NextResponse.json({
          estimatedProfit: {
            grossSol: 0,
            gasFee: 0,
            jitoTip: 0,
            netSol: 0,
            priceImpact: 0,
            walletCount: 0,
            availableSol: 0,
            isMigrated: false,
            priorityFee: 0,
          }
        })
      }

      wallets = [{
        walletAddress: dbWallet.publicKey,
        tokenAmount: toRawTokenAmount(dbWallet.tokenBalance, tokenDecimals),
      }]
    } else if (walletAddressesParam) {
      const walletAddresses = walletAddressesParam
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w.length > 0)
      if (walletAddresses.length === 0) {
        return NextResponse.json({
          estimatedProfit: {
            grossSol: 0,
            gasFee: 0,
            jitoTip: 0,
            netSol: 0,
            priceImpact: 0,
            walletCount: 0,
            availableSol: 0,
            isMigrated: false,
            priorityFee: 0,
          }
        })
      }

      const dbWallets = await prisma.wallet.findMany({
        where: {
          isActive: true,
          publicKey: { in: walletAddresses },
        },
        orderBy: { createdAt: "desc" },
      })

      wallets = dbWallets.map((w) => ({
        walletAddress: w.publicKey,
        tokenAmount: toRawTokenAmount(w.tokenBalance, tokenDecimals),
      }))
    } else {
      // All active wallets calculation
      const dbWallets = await prisma.wallet.findMany({
        where: { isActive: true },
        orderBy: { createdAt: "desc" },
      })

      wallets = dbWallets.map((w) => ({
        walletAddress: w.publicKey,
        tokenAmount: toRawTokenAmount(w.tokenBalance, tokenDecimals),
      }))
    }

    if (wallets.length === 0) {
      return NextResponse.json({
        estimatedProfit: {
          grossSol: 0,
          gasFee: 0,
          jitoTip: 0,
          netSol: 0,
          priceImpact: 0,
          walletCount: 0,
          availableSol: 0,
          isMigrated: false,
          priorityFee: 0,
        }
      })
    }

    // Calculate bundler profit
    const profitData = await calculateBundlerRugpullProfit(
      new PublicKey(mintAddress),
      wallets
    )

    const priorityFee =
      priorityFeeParam && Number.isFinite(Number(priorityFeeParam))
        ? Math.max(0, Number(priorityFeeParam))
        : (await getPriorityFeeRecommendations(400000)).presets.fast.feeSol

    const jitoTip =
      jitoTipParam && Number.isFinite(Number(jitoTipParam))
        ? Math.max(0, Number(jitoTipParam))
        : (await fetchJitoTipFloor(0.1)).recommended.sol

    const poolData = await getPumpswapPoolData(new PublicKey(mintAddress))
    const bondingCurve = poolData ? null : await getBondingCurveData(new PublicKey(mintAddress))
    const availableSolLamports = poolData?.solReserves ?? bondingCurve?.realSolReserves ?? BigInt(0)
    const availableSol = Number(availableSolLamports) / LAMPORTS_PER_SOL

    // Calculate fees (rough estimates)
    const estimatedGasFee = priorityFee * wallets.length
    const estimatedJitoTip = jitoTip
    const netEstimatedProfit = Number(profitData.totalEstimatedSol) / 1e9 - estimatedGasFee - estimatedJitoTip

    return NextResponse.json({
      estimatedProfit: {
        grossSol: Number(profitData.totalEstimatedSol) / 1e9,
        gasFee: estimatedGasFee,
        jitoTip: estimatedJitoTip,
        netSol: Math.max(0, netEstimatedProfit),
        priceImpact: profitData.totalPriceImpact,
        walletCount: wallets.length,
        availableSol,
        isMigrated: !!poolData,
        priorityFee,
      }
    })
  } catch (error: any) {
    logger.error({ correlationId, error: error?.message }, "rugpull estimate failed")
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
