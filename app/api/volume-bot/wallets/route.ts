import { NextRequest, NextResponse } from "next/server"
import { Keypair, PublicKey } from "@solana/web3.js"
import { prisma } from "@/lib/prisma"
import { generateWallet, importWallet, refreshWalletBalances, type VolumeWallet } from "@/lib/solana/volume-bot-engine"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { isPumpFunAvailable } from "@/lib/solana/pumpfun-sdk"
import bs58 from "bs58"

const EXPOSE_WALLET_SECRETS = process.env.EXPOSE_WALLET_SECRETS !== "false"

const sanitize = (wallet: VolumeWallet): VolumeWallet => {
  if (EXPOSE_WALLET_SECRETS) return wallet
  const { secretKey, ...rest } = wallet
  return { ...rest, secretKey: "" }
}

async function saveWallet(wallet: VolumeWallet) {
  try {
    await prisma.wallet.upsert({
      where: { publicKey: wallet.publicKey },
      update: {
        secretKey: wallet.secretKey,
        solBalance: wallet.solBalance.toString(),
        tokenBalance: wallet.tokenBalance.toString(),
        isActive: wallet.isActive,
      },
      create: {
        publicKey: wallet.publicKey,
        secretKey: wallet.secretKey,
        solBalance: wallet.solBalance.toString(),
        tokenBalance: wallet.tokenBalance.toString(),
        isActive: wallet.isActive,
      },
    })
  } catch (error) {
    console.error("volume-bot wallet save failed:", error)
  }
}

async function loadWallets(): Promise<VolumeWallet[]> {
  try {
    const rows = await prisma.wallet.findMany({ orderBy: { createdAt: "desc" } })
    return rows.map((w) => ({
      publicKey: w.publicKey,
      secretKey: w.secretKey,
      solBalance: parseFloat(w.solBalance),
      tokenBalance: parseFloat(w.tokenBalance),
      isActive: w.isActive,
    }))
  } catch (error) {
    console.error("volume-bot load wallets failed:", error)
    return []
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get("action")

    if (action === "generate") {
      const wallet = generateWallet()
      await saveWallet(wallet)
      return NextResponse.json({ wallet: sanitize(wallet) })
    }

    if (action === "load-all") {
      const wallets = await loadWallets()

      return NextResponse.json({ wallets: wallets.map(sanitize) })
    }

    return NextResponse.json({
      network: SOLANA_NETWORK,
      pumpFunAvailable: isPumpFunAvailable(),
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    if (action === "import") {
      const { secretKey } = body
      if (!secretKey) return NextResponse.json({ error: "secretKey required" }, { status: 400 })
      try {
        const wallet = importWallet(secretKey)
        await saveWallet(wallet)
        return NextResponse.json({ wallet: sanitize(wallet) })
      } catch {
        return NextResponse.json({ error: "invalid secret key" }, { status: 400 })
      }
    }

    if (action === "refresh") {
      const { wallets, mintAddress } = body
      if (!wallets) return NextResponse.json({ error: "wallets required" }, { status: 400 })
      const updated = await refreshWalletBalances(wallets as VolumeWallet[], mintAddress || undefined)
      await Promise.all(updated.map((w) => saveWallet(w)))
      return NextResponse.json({ wallets: updated.map(sanitize) })
    }

    if (action === "delete") {
      const { publicKey } = body
      if (!publicKey) return NextResponse.json({ error: "publicKey required" }, { status: 400 })

      try {
        await prisma.wallet.delete({ where: { publicKey } })
      } catch (err: any) {
        return NextResponse.json({ success: false, error: "delete failed" }, { status: 500 })
      }
      return NextResponse.json({ success: true })
    }

    if (action === "update") {
      const { publicKey, isActive } = body
      if (!publicKey) return NextResponse.json({ error: "publicKey required" }, { status: 400 })
      const wallet = await prisma.wallet.update({
        where: { publicKey },
        data: {
          ...(isActive !== undefined && { isActive }),
        },
      })
      return NextResponse.json({
        wallet: sanitize({
          publicKey: wallet.publicKey,
          secretKey: wallet.secretKey,
          solBalance: parseFloat(wallet.solBalance),
          tokenBalance: parseFloat(wallet.tokenBalance),
          isActive: wallet.isActive,
        }),
      })
    }

    // fund via secret key (optional fallback)
    if (action === "fund") {
      const { funderSecretKey, recipients, amountLamports } = body
      if (!funderSecretKey || !recipients || !amountLamports) {
        return NextResponse.json({ error: "funderSecretKey, recipients, amountLamports required" }, { status: 400 })
      }
      const funder = Keypair.fromSecretKey(bs58.decode(funderSecretKey))
      const ix = recipients.map((r: string) => {
        return {
          to: new PublicKey(r),
          lamports: Number(amountLamports),
        }
      })
      // simple client responsibility: we only validate inputs
      return NextResponse.json({ message: "build transfer client-side", recipients: ix.length })
    }

    return NextResponse.json({ error: "invalid action" }, { status: 400 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

