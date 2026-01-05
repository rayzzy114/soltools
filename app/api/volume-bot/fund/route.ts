import { NextRequest, NextResponse } from "next/server"
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, Keypair } from "@solana/web3.js"
import { SOLANA_NETWORK, RPC_ENDPOINT } from "@/lib/solana/config"
import { isPumpFunAvailable } from "@/lib/solana/pumpfun-sdk"
import { prisma } from "@/lib/prisma"
import bs58 from "bs58"

const connection = new Connection(RPC_ENDPOINT, "confirmed")

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { funderAddress, recipients, lamports } = body || {}

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json({ error: "recipients required" }, { status: 400 })
    }

    if (!isPumpFunAvailable()) {
      return NextResponse.json(
        { error: `pump.fun not available on ${SOLANA_NETWORK}` },
        { status: 400 }
      )
    }

    const funderWallet =
      (funderAddress
        ? await prisma.wallet.findUnique({ where: { publicKey: funderAddress } })
        : await prisma.wallet.findFirst({ where: { role: "funder" } }))
    if (funderAddress && funderWallet?.role !== "funder") {
      return NextResponse.json({ error: "wallet is not configured as funder" }, { status: 400 })
    }
    if (!funderWallet?.secretKey) {
      return NextResponse.json({ error: "funder wallet not found in database" }, { status: 404 })
    }

    const funderKeypair = Keypair.fromSecretKey(bs58.decode(funderWallet.secretKey))

    const latestBlockhash = await connection.getLatestBlockhash("confirmed")

    const signatures: string[] = []
    const amountLamports = Number(lamports)
    if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
      return NextResponse.json({ error: "lamports required" }, { status: 400 })
    }

    const CHUNK_SIZE = 15
    const recipientChunks = []
    for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
      recipientChunks.push(recipients.slice(i, i + CHUNK_SIZE))
    }

    for (const chunk of recipientChunks) {
      const instructions = []
      for (const r of chunk) {
        const toKey = typeof r === "string" ? r : r?.to
        if (!toKey) continue
        const to = new PublicKey(toKey)
        instructions.push(SystemProgram.transfer({
          fromPubkey: funderKeypair.publicKey,
          toPubkey: to,
          lamports: amountLamports,
        }))
      }
      if (instructions.length === 0) continue

      const message = new TransactionMessage({
        payerKey: funderKeypair.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message()
      const vtx = new VersionedTransaction(message)
      vtx.sign([funderKeypair])

      const sig = await connection.sendRawTransaction(vtx.serialize())
      await connection.confirmTransaction(sig, "confirmed")
      signatures.push(sig)
    }

    if (signatures.length === 0) {
      return NextResponse.json({ error: "no valid recipients" }, { status: 400 })
    }

    return NextResponse.json({ signatures })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "fund build failed" }, { status: 500 })
  }
}

