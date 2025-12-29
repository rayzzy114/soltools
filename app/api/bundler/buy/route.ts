import { NextRequest, NextResponse } from "next/server"
import {
  createBuyBundle,
  createStaggeredBuys,
  type BundleConfig,
  type BundlerWallet,
} from "@/lib/solana/bundler-engine"
import { isPumpFunAvailable, getBondingCurveData, calculateBuyAmount } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { JitoRegion } from "@/lib/solana/jito"
import { prisma } from "@/lib/prisma"
import { PublicKey } from "@solana/web3.js"
import { MIN_BUY_SOL } from "@/lib/config/limits"

const ATA_RENT_BUFFER_SOL = 0.0022
const FEE_BUFFER_SOL = 0.0015
const BUY_BUFFER_SOL = ATA_RENT_BUFFER_SOL + FEE_BUFFER_SOL

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

// POST - create buy bundle
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
      buyAmounts = [],
      mode = "bundle", // "bundle" or "stagger"
      staggerDelay = { min: 1000, max: 3000 },
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

    const activeWallets = (wallets as BundlerWallet[]).filter((w) => w.isActive)
    const targetWallets = mode === "bundle" ? activeWallets.slice(0, 13) : activeWallets
    if (targetWallets.length === 0) {
      return NextResponse.json({ error: "no active wallets" }, { status: 400 })
    }

    const lastWalletIdx = targetWallets.length - 1
    for (let i = 0; i < targetWallets.length; i++) {
      const wallet = targetWallets[i]
      const buyAmount = (buyAmounts as number[])[i] ?? (buyAmounts as number[])[0] ?? 0.01
      if (!Number.isFinite(buyAmount) || buyAmount < MIN_BUY_SOL) {
        return NextResponse.json({ error: `buy amount too low for wallet ${wallet.publicKey}` }, { status: 400 })
      }
      const solBalance = Number(wallet.solBalance ?? 0)
      let required = buyAmount + BUY_BUFFER_SOL + Math.max(0, Number(priorityFee || 0))
      if (mode === "bundle" && i === lastWalletIdx) {
        required += Math.max(0, Number(jitoTip || 0))
      }
      if (solBalance < required) {
        return NextResponse.json(
          {
            error: `insufficient SOL for ${wallet.publicKey.slice(0, 6)}... need ${required.toFixed(4)} SOL`,
          },
          { status: 400 }
        )
      }
    }

    const config: BundleConfig = {
      wallets: targetWallets as BundlerWallet[],
      mintAddress,
      buyAmounts,
      staggerDelay,
      jitoTip,
      priorityFee,
      slippage,
      jitoRegion: (jitoRegion as any) || "auto",
    }

    if (mode === "stagger") {
      // staggered buys (not bundled)
      const result = await createStaggeredBuys(config)
      return NextResponse.json({
        success: result.signatures.length > 0,
        mode: "stagger",
        signatures: result.signatures,
        errors: result.errors,
      })
    }

    // bundled buy via jito
    const result = await createBuyBundle(config)

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    // persist bundle into DB
    const mintAddr = mintAddress as string
    const token = await ensureToken(mintAddr)
    const bondingCurve = await getBondingCurveData(new PublicKey(mintAddr))
    const bundleRow = await prisma.bundle.create({
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
            walletAddress: targetWallets[idx]?.publicKey || "unknown",
            amount: String((buyAmounts as number[])[idx] ?? (buyAmounts as number[])[0] ?? 0),
            type: "buy",
            status: "confirmed",
            signature: sig,
          })),
        },
      },
    })

    const buyRows = (result.signatures || []).map((sig, idx) => {
      const buyAmount = Number((buyAmounts as number[])[idx] ?? (buyAmounts as number[])[0] ?? 0)
      let tokenAmount = 0
      if (bondingCurve && buyAmount > 0) {
        const { tokensOut } = calculateBuyAmount(bondingCurve, buyAmount)
        tokenAmount = Number(tokensOut) / 1e6
      }
      return {
        signature: sig,
        tokenId: token.id,
        type: "buy",
        walletAddress: targetWallets[idx]?.publicKey || "unknown",
        amount: String(tokenAmount),
        solAmount: String(buyAmount),
        price: tokenAmount > 0 ? String(buyAmount / tokenAmount) : null,
        status: "confirmed",
      }
    })

    if (buyRows.length > 0) {
      await prisma.transaction.createMany({ data: buyRows, skipDuplicates: true })
    }

    return NextResponse.json({
      success: true,
      mode: "bundle",
      bundleId: result.bundleId,
      signatures: result.signatures,
      dbBundleId: bundleRow.id,
    })
  } catch (error: any) {
    console.error("buy bundle error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
