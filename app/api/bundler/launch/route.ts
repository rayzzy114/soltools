import { NextRequest, NextResponse } from "next/server"
import {
  createLaunchBundle,
  estimateBundleCost,
  type BundleConfig,
  type BundlerWallet,
} from "@/lib/solana/bundler-engine"
import { isPumpFunAvailable, getBondingCurveData, calculateBuyAmount } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { JitoRegion } from "@/lib/solana/jito"
import { prisma } from "@/lib/prisma"
import { PublicKey } from "@solana/web3.js"

// POST - create launch bundle (create token + bundled buys)
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
      tokenMetadata,
      devBuyAmount = 0.1,
      buyAmounts = [],
      jitoTip = 0.0001,
      priorityFee = 0.0001,
      slippage = 20,
      jitoRegion = "auto",
    } = body

    // validation
    if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
      return NextResponse.json({ error: "wallets array required" }, { status: 400 })
    }

    if (!tokenMetadata || !tokenMetadata.name || !tokenMetadata.symbol || !tokenMetadata.metadataUri) {
      return NextResponse.json(
        { error: "tokenMetadata with name, symbol, and metadataUri required" },
        { status: 400 }
      )
    }

    const config: BundleConfig = {
      wallets: wallets as BundlerWallet[],
      tokenMetadata: {
        name: tokenMetadata.name,
        symbol: tokenMetadata.symbol,
        description: tokenMetadata.description || "",
        metadataUri: tokenMetadata.metadataUri,
      },
      devBuyAmount,
      buyAmounts,
      jitoTip,
      priorityFee,
      slippage,
      jitoRegion: (jitoRegion as any) || "auto",
    }

    const result = await createLaunchBundle(config)

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    // persist token + bundle into DB (launch = create token + dev buy + bundled buys)
    const mintAddress = result.mintAddress as string
    const token = await prisma.token.upsert({
      where: { mintAddress },
      update: {
        name: tokenMetadata.name,
        symbol: tokenMetadata.symbol,
        description: tokenMetadata.description || "",
        creatorWallet: (wallets as BundlerWallet[])[0]?.publicKey || "",
      },
      create: {
        mintAddress,
        name: tokenMetadata.name,
        symbol: tokenMetadata.symbol,
        decimals: 6,
        totalSupply: "0",
        description: tokenMetadata.description || "",
        imageUrl: "",
        creatorWallet: (wallets as BundlerWallet[])[0]?.publicKey || "",
      },
      select: { id: true },
    })

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
          create: (result.signatures || []).map((sig: string, idx: number) => ({
            tokenId: token.id,
            walletAddress: (wallets as BundlerWallet[])[idx]?.publicKey || "unknown",
            amount: String((buyAmounts as number[])[idx] ?? (idx === 0 ? devBuyAmount : (buyAmounts as number[])[0] ?? 0)),
            type: "buy",
            status: "confirmed",
            signature: sig,
          })),
        },
      },
    })

    const bondingCurve = await getBondingCurveData(new PublicKey(mintAddress))
    const activeWallets = (wallets as BundlerWallet[])
      .filter((w) => w.isActive)
      .slice(0, 13)
    const buyRows = (result.signatures || []).map((sig: string, idx: number) => {
      const buyAmount = Number(
        (buyAmounts as number[])[idx] ?? (idx === 0 ? devBuyAmount : (buyAmounts as number[])[0] ?? 0)
      )
      let tokenAmount = 0
      if (bondingCurve && buyAmount > 0) {
        const { tokensOut } = calculateBuyAmount(bondingCurve, buyAmount)
        tokenAmount = Number(tokensOut) / 1e6
      }
      return {
        signature: sig,
        tokenId: token.id,
        type: "buy",
        walletAddress: activeWallets[idx]?.publicKey || "unknown",
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
      bundleId: result.bundleId,
      mintAddress: result.mintAddress,
      signatures: result.signatures,
    })
  } catch (error: any) {
    console.error("launch bundle error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// GET - estimate launch costs
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const walletCount = parseInt(searchParams.get("walletCount") || "5")
    const devBuyAmount = parseFloat(searchParams.get("devBuyAmount") || "0.1")
    const buyAmountPerWallet = parseFloat(searchParams.get("buyAmountPerWallet") || "0.01")
    const jitoTip = parseFloat(searchParams.get("jitoTip") || "0.0001")
    const priorityFee = parseFloat(searchParams.get("priorityFee") || "0.0001")

    // create buy amounts array
    const buyAmounts = [devBuyAmount]
    for (let i = 1; i < walletCount; i++) {
      buyAmounts.push(buyAmountPerWallet)
    }

    const estimate = estimateBundleCost(walletCount, buyAmounts, jitoTip, priorityFee)

    return NextResponse.json({
      walletCount,
      devBuyAmount,
      buyAmountPerWallet,
      jitoTip,
      priorityFee,
      estimate: {
        totalSol: estimate.totalSol.toFixed(4),
        perWallet: estimate.perWallet.map((a) => a.toFixed(4)),
        fees: estimate.fees.toFixed(6),
      },
    })
  } catch (error: any) {
    console.error("estimate error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
