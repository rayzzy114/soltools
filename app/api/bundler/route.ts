import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { createBundle, createLaunchBundle, createSniperBundle, createExitBundle } from "@/lib/solana/bundler"
import { Keypair } from "@solana/web3.js"

export async function GET() {
  try {
    const bundles = await prisma.bundle.findMany({
      include: {
        transactions: {
          include: {
            token: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 50,
    })

    return NextResponse.json(bundles)
  } catch {
    return NextResponse.json([])
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { type, payerSecretKey, ...params } = body

    // get payer from request or generate (for testing)
    let payer: Keypair
    if (payerSecretKey) {
      const bs58 = await import("bs58")
      payer = Keypair.fromSecretKey(bs58.default.decode(payerSecretKey))
    } else {
      // WARNING: this generates a new keypair for testing only
      payer = Keypair.generate()
    }

    let result
    switch (type) {
      case "custom":
        result = await createBundle(payer, params.transactions)
        break
      case "launch":
        result = await createLaunchBundle(
          payer,
          params.tokenMint,
          params.liquidityAmount,
          params.initialBuyWallets || []
        )
        break
      case "sniper":
        result = await createSniperBundle(
          params.wallets || [],
          params.tokenMint,
          params.amount
        )
        break
      case "exit":
        result = await createExitBundle(params.wallets || [], params.tokenMint)
        break
      default:
        return NextResponse.json({ error: "Invalid bundle type" }, { status: 400 })
    }

    // try to save to database
    try {
    const bundle = await prisma.bundle.create({
      data: {
        bundleId: result.bundleId,
          status: result.status === "landed" ? "completed" : "failed",
          txCount: result.signatures.length || params.transactions?.length || 0,
        successCount: result.successCount,
        failedCount: result.failedCount,
        gasUsed: result.gasUsed,
        completedAt: new Date(),
        transactions: {
          create: params.transactions?.map((tx: any, index: number) => ({
            walletAddress: tx.walletAddress,
            amount: tx.amount,
            type: tx.type,
            status: index < result.successCount ? "confirmed" : "failed",
            signature: result.signatures[index] || null,
          })) || [],
        },
      },
      include: {
        transactions: true,
      },
    })

      return NextResponse.json({
        ...bundle,
        jitoStatus: result.status,
        error: result.error,
      })
    } catch {
      return NextResponse.json(result)
    }
  } catch (error: any) {
    console.error("Error creating bundle:", error)
    return NextResponse.json({ 
      error: error.message || "Internal server error",
      bundleId: `BND-${Date.now()}`,
      status: "failed",
    }, { status: 500 })
  }
}

