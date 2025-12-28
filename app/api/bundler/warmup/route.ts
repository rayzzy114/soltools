import { NextRequest, NextResponse } from "next/server"
import { 
  isWalletWarm, 
  getWalletsWarmupStatus,
  DEFAULT_WARMUP_CONFIG,
} from "@/lib/solana/warmup"
import { Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js"
import bs58 from "bs58"
import { connection } from "@/lib/solana/config"
import { createTipInstruction, sendBundle, type JitoRegion } from "@/lib/solana/jito"

const MAX_BUNDLE_TXS = 5

async function confirmSignatures(signatures: string[], timeoutMs: number = 60_000) {
  const start = Date.now()
  const statusBySig = new Map<string, { status: "confirmed" | "failed" | "pending" }>()
  signatures.forEach((sig) => statusBySig.set(sig, { status: "pending" }))

  while (Date.now() - start < timeoutMs) {
    const pending = signatures.filter((sig) => statusBySig.get(sig)?.status === "pending")
    if (!pending.length) break
    const resp = await connection.getSignatureStatuses(pending)
    resp?.value?.forEach((st, idx) => {
      const sig = pending[idx]
      if (!sig || !st) return
      if (st.err) statusBySig.set(sig, { status: "failed" })
      else if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
        statusBySig.set(sig, { status: "confirmed" })
      }
    })
    await new Promise((r) => setTimeout(r, 750))
  }

  return signatures.map((sig) => ({ signature: sig, ...(statusBySig.get(sig) || { status: "pending" }) }))
}

// POST - warmup wallets
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, walletSecretKeys, walletSecretKey } = body

    switch (action) {
      case "warmup_single": {
        if (!walletSecretKey) {
          return NextResponse.json({ error: "walletSecretKey required" }, { status: 400 })
        }

        const region = (body.jitoRegion || "frankfurt") as JitoRegion
        const rawTip = Number(body.jitoTip)
        const tip = Number.isFinite(rawTip) ? Math.max(0, rawTip) : 0.0001
        const rawTransfer = Number(body.transferSol)
        const transferSol = Number.isFinite(rawTransfer) ? Math.max(0, rawTransfer) : 0.000001
        const transferLamports = Math.max(1, Math.floor(transferSol * LAMPORTS_PER_SOL))

        const keypair = Keypair.fromSecretKey(bs58.decode(walletSecretKey))
        const { blockhash } = await connection.getLatestBlockhash()
        const tx = new Transaction()
        tx.add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: keypair.publicKey,
            lamports: transferLamports,
          })
        )
        tx.add(createTipInstruction(keypair.publicKey, tip, region))
        tx.recentBlockhash = blockhash
        tx.feePayer = keypair.publicKey
        tx.sign(keypair)

        const { bundleId } = await sendBundle([tx], region)
        const signatures = [bs58.encode(tx.signatures?.[0]?.signature || new Uint8Array(64))]
        const statuses = await confirmSignatures(signatures)

        return NextResponse.json({
          success: statuses.some((s) => s.status === "confirmed"),
          bundleId,
          signatures,
          statuses,
        })
      }

      case "warmup_batch": {
        if (!walletSecretKeys || !Array.isArray(walletSecretKeys)) {
          return NextResponse.json({ error: "walletSecretKeys array required" }, { status: 400 })
        }

        if (walletSecretKeys.length === 0) {
          return NextResponse.json({ error: "no wallets provided" }, { status: 400 })
        }

        if (walletSecretKeys.length > 20) {
          return NextResponse.json({ error: "max 20 wallets per batch" }, { status: 400 })
        }

        const region = (body.jitoRegion || "frankfurt") as JitoRegion
        const rawTip = Number(body.jitoTip)
        const tip = Number.isFinite(rawTip) ? Math.max(0, rawTip) : 0.0001
        const rawTransfer = Number(body.transferSol)
        const transferSol = Number.isFinite(rawTransfer) ? Math.max(0, rawTransfer) : 0.000001
        const transferLamports = Math.max(1, Math.floor(transferSol * LAMPORTS_PER_SOL))

        const bundles: Array<{ bundleId: string; signatures: string[] }> = []
        const allSignatures: string[] = []

        for (let i = 0; i < walletSecretKeys.length; i += MAX_BUNDLE_TXS) {
          const batch = walletSecretKeys.slice(i, i + MAX_BUNDLE_TXS)
          const { blockhash } = await connection.getLatestBlockhash()
          const txs: Transaction[] = []

          batch.forEach((secretKey, idx) => {
            const keypair = Keypair.fromSecretKey(bs58.decode(secretKey))
            const tx = new Transaction()
            tx.add(
              SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: keypair.publicKey,
                lamports: transferLamports,
              })
            )
            if (idx === 0) {
              tx.add(createTipInstruction(keypair.publicKey, tip, region))
            }
            tx.recentBlockhash = blockhash
            tx.feePayer = keypair.publicKey
            tx.sign(keypair)
            txs.push(tx)
          })

          const { bundleId } = await sendBundle(txs, region)
          const signatures = txs.map((tx) => bs58.encode(tx.signatures?.[0]?.signature || new Uint8Array(64)))
          bundles.push({ bundleId, signatures })
          allSignatures.push(...signatures)
        }

        const statuses = await confirmSignatures(allSignatures)

        return NextResponse.json({
          success: statuses.some((s) => s.status === "confirmed"),
          bundles,
          statuses,
        })
      }

      case "check_warmth": {
        const { walletAddress, walletAddresses } = body
        
        if (walletAddresses && Array.isArray(walletAddresses)) {
          const statuses = await getWalletsWarmupStatus(walletAddresses)
          const warmCount = statuses.filter(s => s.isWarm).length
          
          return NextResponse.json({
            statuses,
            summary: {
              total: walletAddresses.length,
              warm: warmCount,
              cold: walletAddresses.length - warmCount,
            },
          })
        }
        
        if (walletAddress) {
          const status = await isWalletWarm(walletAddress)
          return NextResponse.json(status)
        }
        
        return NextResponse.json({ error: "walletAddress or walletAddresses required" }, { status: 400 })
      }

      default:
        return NextResponse.json({ error: "invalid action" }, { status: 400 })
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// GET - get default config
export async function GET() {
  return NextResponse.json({
    defaultConfig: DEFAULT_WARMUP_CONFIG,
    description: {
      minTransactions: "minimum warmup transactions",
      maxTransactions: "maximum warmup transactions",
      minDelayMs: "minimum delay between transactions (ms)",
      maxDelayMs: "maximum delay between transactions (ms)",
      minAmount: "minimum SOL amount for transfers",
      maxAmount: "maximum SOL amount for transfers",
      enableSelfTransfers: "enable self-transfer transactions",
      enableMemoProgram: "enable memo transactions",
      enableComputeBudget: "enable compute budget transactions",
    },
  })
}
