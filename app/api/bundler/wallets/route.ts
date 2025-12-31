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
import { SOLANA_NETWORK, RPC_ENDPOINTS } from "@/lib/solana/config"
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
  try {
    await prisma.wallet.upsert({
      where: { publicKey: wallet.publicKey },
      update: {
        secretKey: wallet.secretKey,
        label: wallet.label || null,
        solBalance: wallet.solBalance.toString(),
        tokenBalance: wallet.tokenBalance.toString(),
        isActive: wallet.isActive,
      },
      create: {
        publicKey: wallet.publicKey,
        secretKey: wallet.secretKey,
        label: wallet.label || null,
        solBalance: wallet.solBalance.toString(),
        tokenBalance: wallet.tokenBalance.toString(),
        isActive: wallet.isActive,
      },
    })
  } catch (error) {
    console.error("failed to save wallet to DB:", error)
    // не бросаем ошибку, чтобы не ломать основной flow
  }
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
      const wallets = generateWallets(Math.min(count, 20))
      // автосохранение всех кошельков в БД
      await Promise.all(wallets.map(w => saveWalletToDB(w)))
      return NextResponse.json({ wallets: wallets.map(sanitizeWallet) })
    }

    // load all wallets from DB
    if (action === "load-all") {
      const wallets = await loadWalletsFromDB()

      // If asking to refresh balances (implicitly or explicitly via future params), check RPC
      if (!RPC_ENDPOINTS.length && mintAddress) {
          // If mintAddress is provided, we intend to fetch token balances, which requires RPC
          console.warn("RPC not configured, skipping balance refresh")
          // We return cached wallets, but maybe we should warn the user?
          // Since the client polls this, returning error 500 might be too aggressive if they just want to see the list.
          // But "Wallet balances still show 0.0000" implies they expect live data.
          // We will return what we have, but if balances are 0, it's because of this.
      }

      if (mintAddress) {
        if (!RPC_ENDPOINTS.length) {
             return NextResponse.json({ error: "RPC not configured: cannot refresh balances" }, { status: 503 })
        }
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

// POST - wallet actions
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request)
  try {
    const body = await request.json()
    const { action } = body

    // Check RPC for actions that require it
    if (["refresh", "fund", "collect", "create-atas"].includes(action) && !RPC_ENDPOINTS.length) {
        return NextResponse.json({ error: "RPC not configured" }, { status: 503 })
    }

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
      const { funderSecretKey, wallets, amounts } = body
      if (!funderSecretKey || !wallets || !amounts) {
        return NextResponse.json({ error: "funderSecretKey, wallets, and amounts required" }, { status: 400 })
      }

      try {
        const funder = Keypair.fromSecretKey(bs58.decode(funderSecretKey))
        const signature = await fundWallets(funder, wallets as BundlerWallet[], amounts)
        return NextResponse.json({ signature })
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
        const recipient = new PublicKey(recipientAddress)
        const signatures = await collectSol(wallets as BundlerWallet[], recipient)
        // обновить балансы после сбора SOL
        const updated = await refreshWalletBalances(wallets as BundlerWallet[])
        await Promise.all(updated.map(w => saveWalletToDB(w)))
        return NextResponse.json({ signatures, wallets: updated.map(sanitizeWallet) })
      } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
    }

    // update wallet (label, isActive)
    if (action === "update") {
      const { publicKey, label, isActive } = body
      if (!publicKey) {
        return NextResponse.json({ error: "publicKey required" }, { status: 400 })
      }

      try {
        const wallet = await prisma.wallet.update({
          where: { publicKey },
          data: {
            ...(label !== undefined && { label }),
            ...(isActive !== undefined && { isActive }),
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
          },
        })
      } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 })
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
