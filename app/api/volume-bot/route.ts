import { NextRequest, NextResponse } from "next/server"
import { PublicKey } from "@solana/web3.js"
import {
  refreshWalletBalances,
  generateWallet,
  importWallet,
  estimateVolume,
  type VolumeWallet,
} from "@/lib/solana/volume-bot-engine"
import { isPumpFunAvailable, getBondingCurveData, calculateTokenPrice } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { prisma } from "@/lib/prisma"
import { VolumeBotManager } from "@/lib/solana/volume-bot-manager"

// GET - get bot status / token info
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get("mintAddress")
    const action = searchParams.get("action")

    if (!isPumpFunAvailable()) {
      return NextResponse.json({ 
        error: `pump.fun not available on ${SOLANA_NETWORK}` 
      }, { status: 400 })
    }

    // generate wallet
    if (action === "generate-wallet") {
      const wallet = generateWallet()
      return NextResponse.json({ wallet })
    }

    // get token info
    if (mintAddress) {
      const mint = new PublicKey(mintAddress)
      const bondingCurve = await getBondingCurveData(mint)
      
      if (!bondingCurve) {
        return NextResponse.json({ 
          error: "token not found",
          mintAddress,
        })
      }

      const price = calculateTokenPrice(bondingCurve)
      
      return NextResponse.json({
        mintAddress,
        price,
        isMigrated: bondingCurve.complete,
        virtualSolReserves: Number(bondingCurve.virtualSolReserves) / 1e9,
        virtualTokenReserves: Number(bondingCurve.virtualTokenReserves) / 1e6,
        creator: bondingCurve.creator.toBase58(),
    })
    }

    return NextResponse.json({ 
      status: "ready",
      network: SOLANA_NETWORK,
    })
  } catch (error: any) {
    console.error("volume bot error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST - various actions
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    if (!isPumpFunAvailable()) {
      return NextResponse.json({ 
        error: `pump.fun not available on ${SOLANA_NETWORK}` 
      }, { status: 400 })
    }

    // import wallet
    if (action === "import-wallet") {
      const { secretKey } = body
      if (!secretKey) {
        return NextResponse.json({ error: "secretKey required" }, { status: 400 })
      }
      
      try {
        const wallet = importWallet(secretKey)
        return NextResponse.json({ wallet })
      } catch (e) {
        return NextResponse.json({ error: "invalid secret key" }, { status: 400 })
  }
}

    // refresh wallet balances
    if (action === "refresh-balances") {
      const { wallets, mintAddress } = body
      if (!wallets || !mintAddress) {
        return NextResponse.json({ error: "wallets and mintAddress required" }, { status: 400 })
      }
      
      const updated = await refreshWalletBalances(wallets as VolumeWallet[], mintAddress)
      return NextResponse.json({ wallets: updated })
  }

    // estimate volume
    if (action === "estimate") {
      const { solBudget, rate = 13000 } = body
      const volume = estimateVolume(solBudget || 1, rate)
      return NextResponse.json({
        solBudget,
        rate,
        estimatedVolume: volume,
        formatted: `$${volume.toLocaleString()}`,
    })
    }

    // start volume bot
    if (action === "start") {
      const {
        mintAddress,
        mode,
        amountMode,
        fixedAmount,
        minAmount,
        maxAmount,
        minPercentage,
        maxPercentage,
        slippage,
        priorityFee,
        jitoTip,
        jitoRegion,
        intervalSeconds
      } = body

      if (!mintAddress) {
        return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
      }

      const pairId: string | null = body.pairId || null

      try {
        // Create pair if it doesn't exist
        let resolvedPairId = pairId
        if (!resolvedPairId) {
          const token = await prisma.token.findUnique({
            where: { mintAddress }
          })

          if (!token) {
            return NextResponse.json({ error: "Token not found in database" }, { status: 400 })
          }

          const pair = await prisma.volumeBotPair.create({
            data: {
              tokenId: token.id,
              isActive: true,
              minAmount: minAmount || "0.005",
              maxAmount: maxAmount || "0.02",
              intervalSeconds: intervalSeconds || 30,
              numberOfWallets: 5,
            }
          })
          resolvedPairId = pair.id
        }

        // Always update interval on the pair if provided
        if (intervalSeconds) {
          await prisma.volumeBotPair.update({
            where: { id: resolvedPairId },
            data: { intervalSeconds }
          })
        }

        // Update bot settings in DB
        await prisma.volumeBotSettings.upsert({
          where: { pairId: resolvedPairId },
          update: {
            mode: mode || "wash",
            amountMode: amountMode || "random",
            fixedAmount: fixedAmount || "0.01",
            minAmount: minAmount || "0.005",
            maxAmount: maxAmount || "0.02",
            minPercentage: minPercentage || "5",
            maxPercentage: maxPercentage || "20",
            slippage: slippage || "10",
            priorityFee: priorityFee || "0.005",
            jitoTip: jitoTip || "0.0001",
            jitoRegion: jitoRegion || "frankfurt"
          },
          create: {
            pairId: resolvedPairId,
            mode: mode || "wash",
            amountMode: amountMode || "random",
            fixedAmount: fixedAmount || "0.01",
            minAmount: minAmount || "0.005",
            maxAmount: maxAmount || "0.02",
            minPercentage: minPercentage || "5",
            maxPercentage: maxPercentage || "20",
            slippage: slippage || "10",
            priorityFee: priorityFee || "0.005",
            jitoTip: jitoTip || "0.0001",
            jitoRegion: jitoRegion || "frankfurt"
          }
        })

        // Update pair status
        await prisma.volumeBotPair.update({
          where: { id: resolvedPairId },
          data: {
            status: "running",
            isActive: true,
            lastRunAt: new Date()
          }
        })

        // Start the bot manager
        await VolumeBotManager.getInstance().startBot(resolvedPairId)

        return NextResponse.json({
          success: true,
          message: "Volume bot started successfully",
          pairId: resolvedPairId
        })
      } catch (error: any) {
        console.error("Failed to start volume bot:", error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    // stop volume bot
    if (action === "stop") {
      const { pairId } = body

      if (!pairId) {
        return NextResponse.json({ error: "pairId required" }, { status: 400 })
      }

      try {
        // Stop the bot
        await VolumeBotManager.getInstance().stopBot(pairId)

        // Update status in DB
        await prisma.volumeBotPair.update({
          where: { id: pairId },
          data: { status: "stopped", isActive: false }
        })

        return NextResponse.json({
          success: true,
          message: "Volume bot stopped successfully"
        })
      } catch (error: any) {
        console.error("Failed to stop volume bot:", error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    // get bot status
    if (action === "status") {
      const { pairId } = body

      if (!pairId) {
        return NextResponse.json({ error: "pairId required" }, { status: 400 })
      }

      try {
        const pair = await prisma.volumeBotPair.findUnique({
          where: { id: pairId },
          include: {
            settings: true,
            logs: {
              orderBy: { createdAt: 'desc' },
              take: 50
            }
          }
        })

        if (!pair) {
          return NextResponse.json({ error: "Bot pair not found" }, { status: 404 })
        }

        return NextResponse.json({
          pairId: pair.id,
          status: pair.status,
          lastRunAt: pair.lastRunAt,
          totalTrades: pair.totalTrades,
          totalVolume: pair.totalVolume,
          solSpent: pair.solSpent,
          settings: pair.settings,
          recentLogs: pair.logs
        })
      } catch (error: any) {
        console.error("Failed to get bot status:", error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    return NextResponse.json({ error: "invalid action" }, { status: 400 })
  } catch (error: any) {
    console.error("volume bot error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
