import { NextRequest, NextResponse } from "next/server"
import { PublicKey, Keypair, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js"
import {
  generateWallet,
  generateWallets,
  importWallet,
  refreshWalletBalances,
  fundWallets,
  collectSol,
  getKeypair,
  MAX_BUNDLE_WALLETS,
  type BundlerWallet,
} from "@/lib/solana/bundler-engine"
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token"
import { isPumpFunAvailable } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { prisma } from "@/lib/prisma"
import bs58 from "bs58"
import { logger, getCorrelationId } from "@/lib/logger"
import { connection } from "@/lib/solana/config"

const EXPOSE_WALLET_SECRETS = process.env.EXPOSE_WALLET_SECRETS !== "false"

const sanitizeWallet = (wallet: BundlerWallet): BundlerWallet => {
  if (EXPOSE_WALLET_SECRETS) return wallet
  const { secretKey, ...rest } = wallet
  return { ...rest, secretKey: "" }
}

// helper: save wallet to DB
async function saveWalletToDB(wallet: BundlerWallet): Promise<void> {
  await prisma.wallet.upsert({
    where: { publicKey: wallet.publicKey },
    update: {
      secretKey: wallet.secretKey,
      label: wallet.label || null,
      role: wallet.role || undefined,
      solBalance: wallet.solBalance.toString(),
      tokenBalance: wallet.tokenBalance.toString(),
      isActive: wallet.isActive,
    },
    create: {
      publicKey: wallet.publicKey,
      secretKey: wallet.secretKey,
      label: wallet.label || null,
      role: wallet.role || "project",
      solBalance: wallet.solBalance.toString(),
      tokenBalance: wallet.tokenBalance.toString(),
      isActive: wallet.isActive,
    },
  })
}

// helper: load wallets from DB
async function loadWalletsFromDB(): Promise<BundlerWallet[]> {
  try {
    const dbWallets = await prisma.wallet.findMany({
      orderBy: { createdAt: "desc" },
    })

    return dbWallets.map((w) => ({
      publicKey: w.publicKey,
      secretKey: w.secretKey,
      solBalance: parseFloat(w.solBalance),
      tokenBalance: parseFloat(w.tokenBalance),
      isActive: w.isActive,
      label: w.label || undefined,
      role: w.role || "project",
    }))
  } catch (error) {
    console.error("failed to load wallets from DB:", error)
    return []
  }
}

// GET - get wallets status
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request)
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get("action")
    const mintAddress = searchParams.get("mintAddress") || undefined

    // generate single wallet
    if (action === "generate") {
      const label = searchParams.get("label") || undefined
      const wallet = generateWallet(label)
      // автосохранение в БД
      await saveWalletToDB(wallet)
      return NextResponse.json({ wallet: sanitizeWallet(wallet) })
    }

    // generate multiple wallets
    if (action === "generate-multiple") {
      const count = parseInt(searchParams.get("count") || "5")
      // Increase limit to 100 as requested
      const safeCount = Math.min(Math.max(count, 1), 100)

      // Get current wallet count for correct labeling
      const currentCount = await prisma.wallet.count()

      const wallets = generateWallets(safeCount, currentCount)

      // Save all wallets to DB, abort if any fail
      try {
        await Promise.all(wallets.map(w => saveWalletToDB(w)))
        return NextResponse.json({ wallets: wallets.map(sanitizeWallet) })
      } catch (dbError: any) {
        logger.error({ correlationId, error: dbError?.message }, "failed to save generated wallets to DB")
        return NextResponse.json({ error: "Failed to persist wallets to database" }, { status: 500 })
      }
    }

    // load all wallets from DB
    if (action === "load-all") {
      const wallets = await loadWalletsFromDB()
      if (mintAddress) {
        const refreshed = await refreshWalletBalances(wallets, mintAddress)
        return NextResponse.json({ wallets: refreshed.map(sanitizeWallet) })
      }
      return NextResponse.json({ wallets: wallets.map(sanitizeWallet) })
    }

    return NextResponse.json({
      network: SOLANA_NETWORK,
      pumpFunAvailable: isPumpFunAvailable(),
      maxBundleWallets: MAX_BUNDLE_WALLETS,
    })
  } catch (error: any) {
    logger.error({ correlationId, error: error?.message }, "bundler wallets GET failed")
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * Handle POST requests for bundler wallet operations such as import, refresh balances, fund, delete-batch, collect SOL, update, delete, and create-atas.
 *
 * @returns A NextResponse with a JSON body containing the action-specific result (e.g., wallet data, signatures, success/count) or an `error` message on failure.
 */
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request)
  try {
    const body = await request.json()
    const { action } = body

    // import wallet
    if (action === "import") {
      const { secretKey, label } = body
      if (!secretKey) {
        return NextResponse.json({ error: "secretKey required" }, { status: 400 })
      }

      try {
        const wallet = importWallet(secretKey, label)
        // автосохранение в БД
        await saveWalletToDB(wallet)
        return NextResponse.json({ wallet: sanitizeWallet(wallet) })
      } catch {
        return NextResponse.json({ error: "invalid secret key" }, { status: 400 })
      }
    }

    // refresh balances
    if (action === "refresh") {
      const { wallets, mintAddress } = body
      if (!wallets || !Array.isArray(wallets)) {
        return NextResponse.json({ error: "wallets array required" }, { status: 400 })
      }

      const updated = await refreshWalletBalances(wallets as BundlerWallet[], mintAddress)
      // обновить балансы в БД
      await Promise.all(updated.map(w => saveWalletToDB(w)))
      return NextResponse.json({ wallets: updated.map(sanitizeWallet) })
    }

    // fund wallets
    if (action === "fund") {
      const { funderAddress, wallets, amounts } = body
      if (!funderAddress || !wallets || !amounts) {
        return NextResponse.json({ error: "funderAddress, wallets, and amounts required" }, { status: 400 })
      }

      // Find funder wallet in DB by address
      const funderWallet = await prisma.wallet.findUnique({
        where: { publicKey: funderAddress }
      })
      if (!funderWallet) {
        return NextResponse.json({ error: "funder wallet not found in database" }, { status: 400 })
      }
      if (!funderWallet.secretKey) {
        return NextResponse.json({ error: "funder wallet missing secret key" }, { status: 400 })
      }

      try {
        const funder = Keypair.fromSecretKey(bs58.decode(funderWallet.secretKey))

        // Check balance and log it
        const balance = await connection.getBalance(funder.publicKey)
        const balanceSOL = balance / LAMPORTS_PER_SOL
        console.log("Using funder:", funderWallet.publicKey, "with balance:", balanceSOL.toFixed(4), "SOL")

        const signatures = await fundWallets(funder, wallets as BundlerWallet[], amounts)
        return NextResponse.json({ signatures })
      } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
    }

    // delete multiple wallets (batch)
    if (action === "delete-batch") {
      const { publicKeys } = body
      if (!publicKeys || !Array.isArray(publicKeys) || publicKeys.length === 0) {
        return NextResponse.json({ error: "publicKeys array required" }, { status: 400 })
      }

      try {
        const { deleteResult, missingKeys } = await prisma.$transaction(async (tx) => {
          // fetch wallet ids first to clean up related group records
          const walletsToDelete = await tx.wallet.findMany({
            where: { publicKey: { in: publicKeys } },
            select: { id: true, publicKey: true },
          })

          if (walletsToDelete.length === 0) {
            throw new Error("no matching wallets found for deletion")
          }

          const walletIds = walletsToDelete.map((w) => w.id)

          if (walletIds.length > 0) {
            await tx.walletGroupWallet.deleteMany({
              where: { walletId: { in: walletIds } },
            })
          }

          const deleteResult = await tx.wallet.deleteMany({
            where: { id: { in: walletIds } },
          })

          const missingKeys = publicKeys.filter(
            (pk) => !walletsToDelete.some((wallet) => wallet.publicKey === pk)
          )

          return { deleteResult, missingKeys }
        })

        if (deleteResult.count === 0) {
          return NextResponse.json({ error: "failed to delete wallets" }, { status: 500 })
        }

        if (missingKeys.length > 0) {
          logger.warn({ correlationId, missingKeys }, "some requested wallets not found during deletion")
        }

        return NextResponse.json({ success: true, count: deleteResult.count })
      } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
    }

    // collect SOL back
    if (action === "collect") {
      const { wallets, recipientAddress } = body
      if (!wallets || !recipientAddress) {
        return NextResponse.json({ error: "wallets and recipientAddress required" }, { status: 400 })
      }

      try {
        // Hydrate wallets from DB to ensure secret keys are present if missing
        const publicKeys = (wallets as BundlerWallet[]).map((w) => w.publicKey)
        const dbWallets = await prisma.wallet.findMany({
          where: { publicKey: { in: publicKeys } },
        })

        const walletsWithSecrets: BundlerWallet[] = dbWallets.map((w) => ({
          publicKey: w.publicKey,
          secretKey: w.secretKey,
          solBalance: parseFloat(w.solBalance),
          tokenBalance: parseFloat(w.tokenBalance),
          isActive: w.isActive,
          label: w.label || undefined,
          role: w.role || "project",
        }))

        if (walletsWithSecrets.length === 0) {
          throw new Error("no valid wallets found for collection")
        }

        const recipient = new PublicKey(recipientAddress)
        const signatures = await collectSol(walletsWithSecrets, recipient)
        // refresh balances after collection
        const updated = await refreshWalletBalances(walletsWithSecrets)
        await Promise.all(updated.map(w => saveWalletToDB(w)))
        return NextResponse.json({ signatures, wallets: updated.map(sanitizeWallet) })
      } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
    }

    // update wallet (label, isActive, role)
    if (action === "update") {
      const { publicKey, label, isActive, role } = body
      if (!publicKey) {
        return NextResponse.json({ error: "publicKey required" }, { status: 400 })
      }

      try {
        const existingWallet = await prisma.wallet.findUnique({ where: { publicKey } })
        if (!existingWallet) {
          logger.warn({ correlationId, publicKey }, "update requested for unknown wallet")
          return NextResponse.json({ error: "wallet not found; import it before updating" }, { status: 404 })
        }

        const wallet = await prisma.wallet.update({
          where: { publicKey },
          data: {
            ...(label !== undefined && { label }),
            ...(isActive !== undefined && { isActive }),
            ...(role !== undefined && { role }),
          },
        })

        return NextResponse.json({
          wallet: {
            publicKey: wallet.publicKey,
            secretKey: EXPOSE_WALLET_SECRETS ? wallet.secretKey : "",
            solBalance: parseFloat(wallet.solBalance),
            tokenBalance: parseFloat(wallet.tokenBalance),
            isActive: wallet.isActive,
            label: wallet.label || undefined,
            role: wallet.role || "project",
          },
        })
      } catch (error: any) {
        const isNotFound =
          error?.code === "P2025" ||
          typeof error?.code === "string" && error.code.includes("NotFound") ||
          typeof error?.message === "string" && error.message.toLowerCase().includes("not found")

        const status = isNotFound ? 404 : 400
        const message = isNotFound ? "wallet not found; import it before updating" : error?.message
        logger.error({ correlationId, error: error?.message, publicKey }, "failed to update wallet")
        return NextResponse.json({ error: message }, { status })
      }
    }

    // delete wallet
    if (action === "delete") {
      const { publicKey } = body
      if (!publicKey) {
        return NextResponse.json({ error: "publicKey required" }, { status: 400 })
      }

      try {
        await prisma.wallet.delete({
          where: { publicKey },
        })
        return NextResponse.json({ success: true })
      } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
    }

    // create associated token accounts for wallets
    if (action === "create-atas") {
      const { wallets, mintAddress } = body
      if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
        return NextResponse.json({ error: "wallets array required" }, { status: 400 })
      }
      if (!mintAddress) {
        return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
      }

      const mint = new PublicKey(mintAddress)
      const signatures: string[] = []
      const errors: Array<{ wallet: string; error: string }> = []

      for (const wallet of wallets as BundlerWallet[]) {
        try {
          const keypair = getKeypair(wallet)
          const balanceLamports = await connection.getBalance(keypair.publicKey)
          const minRentLamports = 2_000_000 // ~0.002 SOL rent-exempt buffer
          const feeBufferLamports = 5000
          if (balanceLamports < minRentLamports + feeBufferLamports) {
            errors.push({
              wallet: wallet.publicKey,
              error: `insufficient SOL for ATA rent (balance ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`,
            })
            continue
          }

          const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
          try {
            await connection.getTokenAccountBalance(ata)
            continue
          } catch {
            // ATA missing - create it
          }

          const tx = new Transaction()
          tx.add(createAssociatedTokenAccountInstruction(
            keypair.publicKey,
            ata,
            keypair.publicKey,
            mint
          ))

          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
          tx.recentBlockhash = blockhash
          tx.lastValidBlockHeight = lastValidBlockHeight
          tx.feePayer = keypair.publicKey
          tx.sign(keypair)

          const signature = await connection.sendRawTransaction(tx.serialize())
          await connection.confirmTransaction(signature, "confirmed")
          signatures.push(signature)
        } catch (error: any) {
          const message =
            typeof error?.message === "string"
              ? error.message
              : typeof error?.toString === "function"
                ? error.toString()
                : JSON.stringify(error)
          errors.push({
            wallet: wallet.publicKey,
            error: message || "failed to create ATA",
          })
        }
      }

      return NextResponse.json({
        success: errors.length === 0,
        signatures,
        errors,
      })
    }

    return NextResponse.json({ error: "invalid action" }, { status: 400 })
  } catch (error: any) {
    logger.error({ correlationId, error: error?.message }, "bundler wallets POST failed")
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}