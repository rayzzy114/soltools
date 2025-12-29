import { NextRequest, NextResponse } from "next/server"
import { PublicKey } from "@solana/web3.js"
import { getResilientConnection } from "@/lib/solana/config"

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const publicKey = searchParams.get("publicKey")
    if (!publicKey) {
      return NextResponse.json({ error: "publicKey required" }, { status: 400 })
    }
    const pubkey = new PublicKey(publicKey)
    const connection = await getResilientConnection()
    const lamports = await connection.getBalance(pubkey)
    return NextResponse.json({
      publicKey,
      lamports,
      sol: lamports / 1_000_000_000,
    })
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "failed to fetch balance" },
      { status: 500 }
    )
  }
}
