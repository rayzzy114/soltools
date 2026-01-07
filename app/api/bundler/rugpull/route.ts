import { NextRequest, NextResponse } from "next/server"
import {
  createRugpullBundle,
  type BundleConfig,
  type BundlerWallet,
} from "@/lib/solana/bundler-engine"
import { MAX_BUNDLE_WALLETS } from "@/lib/solana/bundler-engine"
import { isPumpFunAvailable, getBondingCurveData, calculateSellAmount, getPumpswapPoolData, calculatePumpswapSwapAmount } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { prisma } from "@/lib/prisma"
import { PublicKey } from "@solana/web3.js"
import { VolumeBotManager } from "@/lib/solana/volume-bot-manager"

const SELL_BUFFER_SOL = 0.0015
const TOKEN_DECIMALS = 6

const toRawTokenAmount = (value: number, decimals: number = TOKEN_DECIMALS): bigint => {
  if (!Number.isFinite(value) || value <= 0) return BigInt(0)
  const str = value.toString()
  const [whole = "0", frac = ""] = str.split(".")
  const wholeDigits = whole.replace(/\D/g, "") || "0"
  const fracDigits = frac.replace(/\D/g, "")
  const padded = (fracDigits + "0".repeat(decimals)).slice(0, decimals)
  const combined = `${wholeDigits}${padded}`.replace(/^0+/, "") || "0"
  return BigInt(combined)
}

const rawToUiAmount = (raw: bigint, decimals: number = TOKEN_DECIMALS): string => {
  const sign = raw < BigInt(0) ? "-" : ""
  const value = raw < BigInt(0) ? -raw : raw
  const str = value.toString().padStart(decimals + 1, "0")
  const whole = str.slice(0, -decimals) || "0"
  const frac = str.slice(-decimals).replace(/0+$/, "")
  return sign + (frac ? `${whole}.${frac}` : whole)
}

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
      walletPublicKeys,
      mintAddress,
      jitoTip = 0.0001,
      priorityFee = 0.0001,
      slippage = 20,
      jitoRegion = "auto",
      lutAddress
    } = body

    // validation
    if (!walletPublicKeys || !Array.isArray(walletPublicKeys) || walletPublicKeys.length === 0) {
      return NextResponse.json({ error: "walletPublicKeys array required" }, { status: 400 })
    }

    if (!mintAddress) {
      return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
    }

    // Check & Stop Volume Bot
    const volumeToken = await prisma.token.findUnique({ where: { mintAddress } })
    if (volumeToken) {
        const pair = await prisma.volumeBotPair.findFirst({ where: { tokenId: volumeToken.id } })
        if (pair && pair.status === "running") {
            console.log(`[rugpull] Stopping volume bot for pair ${pair.id} before rug...`)
            await VolumeBotManager.getInstance().stopBot(pair.id)
            // Wait a moment for loop to exit?
            // stopBot sets a flag, but loop might be mid-execution. 
            // In a real chaos test, we verify if this prevents collision.
            await prisma.volumeBotPair.update({
                where: { id: pair.id },
                data: { status: "stopped", isActive: false }
            })
        }
    }

    const dbWallets = await prisma.wallet.findMany({
      where: { publicKey: { in: walletPublicKeys } },
    })
    const walletByKey = new Map(dbWallets.map((w) => [w.publicKey, w]))
    const activeWallets = (walletPublicKeys as string[])
      .map((key) => walletByKey.get(key))
      .filter((wallet): wallet is (typeof dbWallets)[number] => Boolean(wallet))
      .map((w) => ({
        publicKey: w.publicKey,
        secretKey: w.secretKey,
        solBalance: parseFloat(w.solBalance),
        tokenBalance: parseFloat(w.tokenBalance),
        isActive: w.isActive,
        label: w.label || undefined,
        role: w.role || "project",
      })) as BundlerWallet[]
    const activeWalletsWithTokens = activeWallets
      .filter((w) => w.isActive && (w.tokenBalance ?? 0) > 0)
    if (activeWalletsWithTokens.length === 0) {
      return NextResponse.json({ error: "no wallets with token balance" }, { status: 400 })
    }
    const missingSecrets = activeWalletsWithTokens.filter((w) => !w.secretKey)
    if (missingSecrets.length > 0) {
      return NextResponse.json({ error: "wallet secret key missing in database" }, { status: 400 })
    }

    for (let i = 0; i < activeWalletsWithTokens.length; i++) {
      const wallet = activeWalletsWithTokens[i]
      const solBalance = Number(wallet.solBalance ?? 0)
      let required = SELL_BUFFER_SOL + Math.max(0, Number(priorityFee || 0))
      const isLastInBundle =
        i === activeWalletsWithTokens.length - 1 || (i + 1) % MAX_BUNDLE_WALLETS === 0
      if (isLastInBundle) {
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
      wallets: activeWalletsWithTokens as BundlerWallet[],
      mintAddress,
      jitoTip,
      priorityFee,
      slippage,
      jitoRegion: (jitoRegion as any) || "auto",
      lutAddress
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

    const bundleIds = result.bundleIds?.length ? result.bundleIds : [result.bundleId]
    const signatureGroups =
      result.bundleSignatures?.length ? result.bundleSignatures : [result.signatures]
    const bundleRows = []
    let signatureOffset = 0
    for (let bundleIdx = 0; bundleIdx < signatureGroups.length; bundleIdx++) {
      const sigs = signatureGroups[bundleIdx]
      const bundleId = bundleIds[bundleIdx] || bundleIds[0]
      const row = await prisma.bundle.create({
        data: {
          bundleId,
          status: "completed",
          txCount: sigs.length,
          successCount: sigs.length,
          failedCount: 0,
          gasUsed: null,
          completedAt: new Date(),
          transactions: {
            create: sigs.map((sig, idx) => ({
              tokenId: token?.id,
              walletAddress: activeWalletsWithTokens[signatureOffset + idx]?.publicKey || "unknown",
              amount: "100", // 100% of tokens (rugpull)
              type: "sell",
              status: "confirmed",
              signature: sig,
            })),
          },
        },
      })
      bundleRows.push(row)
      signatureOffset += sigs.length
    }

    const sellRows = (result.signatures || []).map((sig, idx) => {
      const wallet = activeWalletsWithTokens[idx]
      const tokenBalanceRaw = wallet ? toRawTokenAmount(wallet.tokenBalance) : BigInt(0)
      const tokenAmountUi = rawToUiAmount(tokenBalanceRaw)
      const tokenAmountNumber = Number(tokenAmountUi)
      let solAmount = 0
      if (tokenBalanceRaw > BigInt(0)) {
        if (bondingCurve && !bondingCurve.complete) {
          const { solOut } = calculateSellAmount(bondingCurve, tokenBalanceRaw)
          solAmount = Number(solOut) / 1e9
        } else if (pool) {
          const swap = calculatePumpswapSwapAmount(pool, tokenBalanceRaw, true)
          solAmount = Number(swap.solOut) / 1e9
        }
      }
      return {
        signature: sig,
        tokenId: token.id,
        type: "sell",
        walletAddress: wallet?.publicKey || "unknown",
        amount: tokenAmountUi,
        solAmount: String(solAmount),
        price: tokenAmountNumber > 0 ? String(solAmount / tokenAmountNumber) : null,
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
      bundleIds,
      signatures: result.signatures,
      mintAddress: result.mintAddress,
      estimatedProfit: result.estimatedProfit,
    })
  } catch (error: any) {
    console.error("rugpull bundle error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

