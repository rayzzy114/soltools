import { NextRequest, NextResponse } from "next/server"
import {
  createLaunchBundle,
  estimateBundleCost,
  resolveLaunchBuyAmount,
  prepareLaunchLut,
  verifyWalletIndependence,
  getKeypair,
  type BundleConfig,
  type BundlerWallet,
} from "@/lib/solana/bundler-engine"
import { MAX_BUNDLE_WALLETS } from "@/lib/solana/bundler-engine"
import { isPumpFunAvailable, getBondingCurveData, calculateBuyAmount } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { JitoRegion } from "@/lib/solana/jito"
import { prisma } from "@/lib/prisma"
import { PublicKey } from "@solana/web3.js"
import { MIN_BUY_SOL } from "@/lib/config/limits"

const ATA_RENT_BUFFER_SOL = 0.0022
const MINT_RENT_BUFFER_SOL = 0.0022
const FEE_BUFFER_SOL = 0.0015
const BUY_BUFFER_SOL = ATA_RENT_BUFFER_SOL + FEE_BUFFER_SOL
const DEV_CREATE_BUFFER_SOL = MINT_RENT_BUFFER_SOL

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
      action = "create", // create | prepare-lut | check-links
      walletPublicKeys,
      devPublicKey,
      tokenMetadata,
      devBuyAmount = 0.1,
      buyAmounts = [],
      jitoTip = 0.0001,
      priorityFee = 0.0001,
      slippage = 20,
      jitoRegion = "auto",
      lutAddress // New: optional provided LUT
    } = body

    // validation (common)
    if (!walletPublicKeys || !Array.isArray(walletPublicKeys) || walletPublicKeys.length === 0) {
      return NextResponse.json({ error: "walletPublicKeys array required" }, { status: 400 })
    }
    if (!devPublicKey || typeof devPublicKey !== "string") {
      return NextResponse.json({ error: "devPublicKey required" }, { status: 400 })
    }

    const dbWallets = await prisma.wallet.findMany({
      where: { publicKey: { in: walletPublicKeys } },
    })
    const walletByKey = new Map(dbWallets.map((w) => [w.publicKey, w]))
    let activeWallets = (walletPublicKeys as string[])
      .map((key) => walletByKey.get(key))
      .filter((wallet): wallet is (typeof dbWallets)[number] => Boolean(wallet))
      .map((w) => ({
        publicKey: w.publicKey,
        secretKey: w.secretKey,
        solBalance: parseFloat(w.solBalance),
        tokenBalance: parseFloat(w.tokenBalance),
        isActive: w.isActive,
        label: w.label || undefined,
        role: w.publicKey === devPublicKey ? "dev" : "buyer",
      })) as BundlerWallet[]

    activeWallets = activeWallets.filter((w) => w.isActive)
    if (activeWallets.length === 0) {
      return NextResponse.json({ error: "no active wallets" }, { status: 400 })
    }

    // Ensure Dev is in list
    if (!activeWallets.some((w) => w.publicKey === devPublicKey)) {
       // If action is create, we might need dev wallet explicitly.
       // If prepare-lut, we definitely do.
       // We'll enforce it.
       return NextResponse.json({ error: "devPublicKey not found in active wallets" }, { status: 400 })
    }

    const devWallet = activeWallets.find(w => w.publicKey === devPublicKey)!

    // --- Action: Prepare LUT ---
    if (action === "prepare-lut") {
        const devKeypair = getKeypair(devWallet)
        const address = await prepareLaunchLut(activeWallets, devKeypair)
        return NextResponse.json({ success: true, lutAddress: address })
    }

    // --- Action: Check Links ---
    if (action === "check-links") {
        const issues = await verifyWalletIndependence(devWallet, activeWallets)
        return NextResponse.json({ success: true, issues })
    }

    // --- Action: Create (Launch) ---
    if (action === "create") {
        if (!tokenMetadata || !tokenMetadata.name || !tokenMetadata.symbol || !tokenMetadata.metadataUri) {
          return NextResponse.json(
            { error: "tokenMetadata with name, symbol, and metadataUri required" },
            { status: 400 }
          )
        }

        const missingSecrets = activeWallets.filter((w) => !w.secretKey)
        if (missingSecrets.length > 0) {
          return NextResponse.json({ error: "wallet secret key missing in database" }, { status: 400 })
        }

        // Ensure "Dev" wallet is at index 0 and sync buyAmounts
        const rawBuyAmounts = (buyAmounts as number[]) || []
        const fallbackAmount = rawBuyAmounts[0] ?? 0.01
        const expandedBuyAmounts = activeWallets.map((_, i) => rawBuyAmounts[i] ?? fallbackAmount)

        const combined = activeWallets.map((w, i) => ({ w, amt: expandedBuyAmounts[i] }))

        // Explicitly find Dev wallet
        const devIndex = combined.findIndex(x => x.w.publicKey === devPublicKey)
        if (devIndex >= 0) {
          const [devItem] = combined.splice(devIndex, 1)
          combined.unshift(devItem)
        } else {
             // Should not happen due to check above
             return NextResponse.json({ error: "Dev wallet missing in sort" }, { status: 500 })
        }

        activeWallets = combined.map((x) => x.w)
        const sortedBuyAmounts = combined.map((x) => x.amt)

        // Balance Checks
        for (let i = 0; i < activeWallets.length; i++) {
          const wallet = activeWallets[i]
          const buyAmount = resolveLaunchBuyAmount(i, devBuyAmount, sortedBuyAmounts)
          if (!Number.isFinite(buyAmount) || buyAmount < MIN_BUY_SOL) {
            return NextResponse.json({ error: `buy amount too low for wallet ${wallet.publicKey}` }, { status: 400 })
          }
          const solBalance = Number(wallet.solBalance ?? 0)

          // Refactored Logic: Each wallet pays its own fees (approx).
          // Dev pays for Create + Tip + Dev Buy.
          // Buyers pay for Buy + Tip.

          let required = buyAmount + BUY_BUFFER_SOL + Math.max(0, Number(priorityFee || 0))

          if (i === 0) { // Dev
              required += DEV_CREATE_BUFFER_SOL
          }

          // In refactored model, everyone pays a tip in their chunk?
          // Or per transaction?
          // Our chunking logic:
          // Tx1: Dev pays tip. (Covers buyers 1-4) -> Buyers 1-4 don't pay tip/gas.
          // Tx2: Buyer 5 pays tip. (Covers buyers 5-9) -> Buyer 5 pays tip/gas.
          // We should conservatively ask *everyone* to have enough for tip/gas just in case they are the payer.

          required += Math.max(0, Number(jitoTip || 0))

          if (solBalance < required) {
            return NextResponse.json(
              {
                error: `insufficient SOL for ${wallet.publicKey.slice(0, 6)}... need ${required.toFixed(4)} SOL (buy+gas+tip)`,
              },
              { status: 400 }
            )
          }
        }

        const config: BundleConfig = {
          wallets: activeWallets as BundlerWallet[],
          tokenMetadata: {
            name: tokenMetadata.name,
            symbol: tokenMetadata.symbol,
            description: tokenMetadata.description || "",
            metadataUri: tokenMetadata.metadataUri,
            imageUrl: tokenMetadata.imageUrl || "",
            website: tokenMetadata.website,
            twitter: tokenMetadata.twitter,
            telegram: tokenMetadata.telegram,
          },
          devBuyAmount,
          buyAmounts: sortedBuyAmounts,
          jitoTip,
          priorityFee,
          slippage,
          jitoRegion: (jitoRegion as any) || "auto",
          lutAddress // Pass through
        }

        const result = await createLaunchBundle(config)

        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 400 })
        }

        // persist token + bundle into DB (launch = create token + dev buy + bundled buys)
        const mintAddress = result.mintAddress as string
        const imageUrl = tokenMetadata.imageUrl || ""
        const token = await prisma.token.upsert({
          where: { mintAddress },
          update: {
            name: tokenMetadata.name,
            symbol: tokenMetadata.symbol,
            description: tokenMetadata.description || "",
            ...(tokenMetadata.website !== undefined && { website: tokenMetadata.website || null }),
            ...(tokenMetadata.twitter !== undefined && { twitter: tokenMetadata.twitter || null }),
            ...(tokenMetadata.telegram !== undefined && { telegram: tokenMetadata.telegram || null }),
            ...(tokenMetadata.imageUrl !== undefined && { imageUrl }),
            creatorWallet: activeWallets[0]?.publicKey || "",
          },
          create: {
            mintAddress,
            name: tokenMetadata.name,
            symbol: tokenMetadata.symbol,
            decimals: 6,
            totalSupply: "0",
            description: tokenMetadata.description || "",
            imageUrl: imageUrl || "",
            website: tokenMetadata.website || null,
            twitter: tokenMetadata.twitter || null,
            telegram: tokenMetadata.telegram || null,
            creatorWallet: activeWallets[0]?.publicKey || "",
          },
          select: { id: true },
        })

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
                create: sigs.map((sig: string, idx: number) => ({
                  tokenId: token.id,
                  walletAddress: activeWallets[signatureOffset + idx]?.publicKey || "unknown",
                  amount: String(
                    (buyAmounts as number[])[signatureOffset + idx] ??
                    (signatureOffset + idx === 0 ? devBuyAmount : (buyAmounts as number[])[0] ?? 0)
                  ),
                  type: "buy",
                  status: "confirmed",
                  signature: sig,
                })),
              },
            },
          })
          bundleRows.push(row)
          signatureOffset += sigs.length
        }

        const bondingCurve = await getBondingCurveData(new PublicKey(mintAddress))
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

        // Update wallet roles
        const devWalletPubkey = activeWallets[0].publicKey
        const buyerPubkeys = activeWallets.slice(1).map(w => w.publicKey)

        await Promise.all([
          prisma.wallet.update({
            where: { publicKey: devWalletPubkey },
            data: { role: "dev" }
          }),
          prisma.wallet.updateMany({
            where: { publicKey: { in: buyerPubkeys } },
            data: { role: "buyer" }
          })
        ])

        return NextResponse.json({
          success: true,
          bundleId: result.bundleId,
          bundleIds,
          mintAddress: result.mintAddress,
          signatures: result.signatures,
        })
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 })

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
