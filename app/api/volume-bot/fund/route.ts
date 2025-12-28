import { NextRequest, NextResponse } from "next/server"
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js"
import { SOLANA_NETWORK, RPC_ENDPOINT } from "@/lib/solana/config"
import { isPumpFunAvailable } from "@/lib/solana/pumpfun-sdk"

const connection = new Connection(RPC_ENDPOINT, "confirmed")

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { fromPubkey, recipients } = body || {}

    if (!fromPubkey || !Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json({ error: "fromPubkey and recipients required" }, { status: 400 })
    }

    if (!isPumpFunAvailable()) {
      return NextResponse.json(
        { error: `pump.fun not available on ${SOLANA_NETWORK}` },
        { status: 400 }
      )
    }

    const from = new PublicKey(fromPubkey)

    const latestBlockhash = await connection.getLatestBlockhash("confirmed")

    const txs: string[] = []

    for (const r of recipients) {
      if (!r?.to || !r?.lamports) continue
      const to = new PublicKey(r.to)
      const lamports = Number(r.lamports)
      if (!Number.isFinite(lamports) || lamports <= 0) continue

      const transferIx = SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })

      const message = new TransactionMessage({
        payerKey: from,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [transferIx],
      }).compileToV0Message()

      const vtx = new VersionedTransaction(message)
      txs.push(Buffer.from(vtx.serialize()).toString("base64"))
    }

    if (txs.length === 0) {
      return NextResponse.json({ error: "no valid recipients" }, { status: 400 })
    }

    return NextResponse.json({ transactions: txs, blockhash: latestBlockhash.blockhash })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "fund build failed" }, { status: 500 })
  }
}

