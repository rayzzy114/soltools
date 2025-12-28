import { NextRequest, NextResponse } from "next/server"
import {
  createRugpullBundle,
  type BundleConfig,
  type BundlerWallet,
} from "@/lib/solana/bundler-engine"
import { isPumpFunAvailable, getBondingCurveData, calculateSellAmount, getPumpswapPoolData, calculatePumpswapSwapAmount } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { prisma } from "@/lib/prisma"
import { PublicKey } from "@solana/web3.js"

async function ensureToken(mintAddress: string) {
  const existing = await prisma.token.findFirst({
    where: { mintAddress },
    select: { id: true },
  })
  if (existing) return existing

  let data: any = null
  try {
    const resp = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`)
    if (resp.ok) data = await resp.json()
  } catch {
    // ignore
  }

  return prisma.token.create({
    data: {
      mintAddress,
      name: data?.name || mintAddress.slice(0, 6),
      symbol: data?.symbol || mintAddress.slice(0, 4),
      decimals: 6,
      totalSupply: "0",
      description: data?.description || "",
      imageUrl: data?.image_uri || "",
      creatorWallet: data?.creator || "",
    },
    select: { id: true },
  })
}

// POST - execute rugpull bundle (sell ALL tokens from ALL wallets)
export async function POST(request: NextRequest) {
  try {
    if (!isPumpFunAvailable()) {
      return NextResponse.json(
        { error: `pump.fun not available on ${SOLANA_NETWORK}` },
        { status: 400 }
      )
    }

    const body = await request.json()
    const {
      wallets,
      mintAddress,
      jitoTip = 0.0001,
      priorityFee = 0.0001,
      slippage = 20,
      jitoRegion = "auto",
    } = body

    // validation
    if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
      return NextResponse.json({ error: "wallets array required" }, { status: 400 })
    }

    if (!mintAddress) {
      return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
    }

    const config: BundleConfig = {
      wallets: wallets as BundlerWallet[],
      mintAddress,
      jitoTip,
      priorityFee,
      slippage,
      jitoRegion: (jitoRegion as any) || "auto",
    }

    // bundled rugpull via jito (sells 100% tokens from all wallets)
    const result = await createRugpullBundle(config)

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    // persist bundle into DB
    const mintAddr = mintAddress as string
    const token = await ensureToken(mintAddr)
    const bondingCurve = await getBondingCurveData(new PublicKey(mintAddr))
    const pool = bondingCurve?.complete ? await getPumpswapPoolData(new PublicKey(mintAddr)) : null

    await prisma.bundle.create({
      data: {
        bundleId: result.bundleId,
        status: "completed",
        txCount: result.signatures.length,
        successCount: result.signatures.length,
        failedCount: 0,
        gasUsed: null,
        completedAt: new Date(),
        transactions: {
          create: (result.signatures || []).map((sig, idx) => ({
            tokenId: token?.id,
            walletAddress: (wallets as BundlerWallet[])[idx]?.publicKey || "unknown",
            amount: "100", // 100% of tokens (rugpull)
            type: "sell",
            status: "confirmed",
            signature: sig,
          })),
        },
      },
    })

    const activeWallets = (wallets as BundlerWallet[])
      .filter((w) => w.isActive && (w.tokenBalance ?? 0) > 0)
      .slice(0, 13)
    const sellRows = (result.signatures || []).map((sig, idx) => {
      const wallet = activeWallets[idx]
      const tokenAmount = wallet ? Math.floor(wallet.tokenBalance) : 0
      const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 1e6))
      let solAmount = 0
      if (tokenAmount > 0) {
        if (bondingCurve && !bondingCurve.complete) {
          const { solOut } = calculateSellAmount(bondingCurve, tokenAmountRaw)
          solAmount = Number(solOut) / 1e9
        } else if (pool) {
          const swap = calculatePumpswapSwapAmount(pool, tokenAmountRaw, true)
          solAmount = Number(swap.solOut) / 1e9
        }
      }
      return {
        signature: sig,
        tokenId: token.id,
        type: "sell",
        walletAddress: wallet?.publicKey || "unknown",
        amount: String(tokenAmount),
        solAmount: String(solAmount),
        price: tokenAmount > 0 ? String(solAmount / tokenAmount) : null,
        status: "confirmed",
      }
    })

    if (sellRows.length > 0) {
      await prisma.transaction.createMany({ data: sellRows, skipDuplicates: true })
    }

    return NextResponse.json({
      success: true,
      mode: "bundle",
      bundleId: result.bundleId,
      signatures: result.signatures,
      mintAddress: result.mintAddress,
      estimatedProfit: result.estimatedProfit,
    })
  } catch (error: any) {
    console.error("rugpull bundle error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

