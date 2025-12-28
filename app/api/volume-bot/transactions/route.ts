import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { connection } from "@/lib/solana/config"

// POST - create a volume-bot transaction log row (used for UI guards/skip/errors that have no on-chain signature)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const mintAddress = String(body?.mintAddress || "").trim()
    const wallet = String(body?.wallet || "").trim()
    const type = body?.type === "sell" ? "sell" : "buy"
    const statusRaw = String(body?.status || "failed")
    const status = statusRaw === "confirmed" || statusRaw === "success" ? "confirmed" : statusRaw === "pending" ? "pending" : "failed"
    const amount = String(body?.amount ?? "0")
    const solAmount = body?.solAmount != null ? String(body?.solAmount) : null
    const error = body?.error ? String(body?.error).slice(0, 500) : null

    if (!mintAddress) return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
    if (!wallet) return NextResponse.json({ error: "wallet required" }, { status: 400 })

    const token = await prisma.token.findFirst({
      where: { mintAddress },
      select: { id: true },
    })
    if (!token) return NextResponse.json({ error: "token not found" }, { status: 404 })

    const created = await prisma.transaction.create({
      data: {
        signature: null,
        tokenId: token.id,
        type,
        walletAddress: wallet,
        amount,
        solAmount,
        status,
        error,
        networkFeeLamports: body?.networkFeeLamports != null ? String(body.networkFeeLamports) : null,
        networkFeeSol: body?.networkFeeSol != null ? String(body.networkFeeSol) : null,
        jitoTipSol: body?.jitoTipSol != null ? String(body.jitoTipSol) : null,
        priorityFeeSolBudget: body?.priorityFeeSolBudget != null ? String(body.priorityFeeSolBudget) : null,
      },
      select: { id: true },
    })

    return NextResponse.json({ success: true, id: created.id })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "create failed" }, { status: 500 })
  }
}

// GET - list volume-bot transactions for a mint (persisted + all token transactions)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get("mintAddress")
    const limitRaw = searchParams.get("limit")
    const includeAll = searchParams.get("includeAll") === "true" // new parameter to include all token transactions
    const limit = Math.min(200, Math.max(1, Number(limitRaw || 100)))

    if (!mintAddress) {
      return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
    }

    const token = await prisma.token.findFirst({
      where: { mintAddress },
      select: { id: true },
    })

    if (!token) {
      return NextResponse.json({
        transactions: [],
        stats: { buys: 0, sells: 0, volumeSol: 0 },
      })
    }

    let transactions: any[] = []
    let stats = { buys: 0, sells: 0, volumeSol: 0 }

    if (includeAll) {
      // get all pump.fun transactions for this token
      const { getAllPumpFunTransactions } = await import("@/lib/solana/pumpfun-sdk")
      const { PublicKey } = await import("@solana/web3.js")

      try {
        const mint = new PublicKey(mintAddress)
        const allTxs = await getAllPumpFunTransactions(mint, limit)

        transactions = allTxs.map(tx => ({
          wallet: tx.user,
          type: tx.type === "create" ? "buy" : tx.type, // treat create as buy
          amount: tx.type === "buy" ? tx.solAmount : tx.tokenAmount,
          tokensOrSol: tx.type === "buy" ? tx.tokenAmount : tx.solAmount,
          signature: tx.signature,
          status: "success", // all blockchain txs are successful
          timestamp: tx.timestamp,
          price: tx.price,
          marketCap: tx.marketCap,
          isAllTx: true, // flag to distinguish from our bot transactions
        }))

        // calculate stats from all transactions
        const confirmedTxs = transactions
        stats.buys = confirmedTxs.filter(tx => tx.type === "buy").length
        stats.sells = confirmedTxs.filter(tx => tx.type === "sell").length
        stats.volumeSol = confirmedTxs.reduce((sum, tx) => sum + (tx.type === "buy" ? tx.amount : tx.tokensOrSol), 0)

      } catch (error) {
        console.error("error getting all pump.fun transactions:", error)
        // fallback to our transactions only
        includeAll = false
      }
    }

    if (!includeAll) {
      // original logic - only our bot transactions
      const rows = await prisma.transaction.findMany({
        where: { tokenId: token.id },
        orderBy: { createdAt: "desc" },
        take: limit,
      })

      // reconcile "pending" rows using Solana RPC so the UI/DB converge even if jito polling times out.
      const pending = rows.filter((r) => r.status === "pending").slice(0, 20)
      if (pending.length) {
        try {
          const sigs = pending.map((r) => r.signature)
          const resp = await connection.getSignatureStatuses(sigs)
          const updates: Array<{ signature: string; status: "confirmed" | "failed" }> = []
          resp.value.forEach((st, idx) => {
            const signature = sigs[idx]
            if (!signature) return
            if (!st) return
            if (st.err) updates.push({ signature, status: "failed" })
            else if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
              updates.push({ signature, status: "confirmed" })
            }
          })
          if (updates.length) {
            await Promise.all(
              updates.map((u) =>
                prisma.transaction.update({
                  where: { signature: u.signature },
                  data: { status: u.status },
                })
              )
            )
            // refresh rows after reconciliation so UI gets updated status
            const refreshed = await prisma.transaction.findMany({
              where: { tokenId: token.id },
              orderBy: { createdAt: "desc" },
              take: limit,
            })
            rows.splice(0, rows.length, ...refreshed)
          }
        } catch (e: any) {
          // ignore
        }
      }

      transactions = rows.map((r) => {
        const status =
          r.status === "confirmed" ? "success" : r.status === "failed" ? "failed" : "pending"
        const tokenAmount = Number(r.amount || "0")
        const solAmount = Number(r.solAmount || "0")
        return {
          wallet: r.walletAddress,
          type: r.type === "sell" ? "sell" : "buy",
          // UI expects: buy shows SOL, sell shows tokens
          amount: r.type === "buy" ? solAmount : tokenAmount,
          // inverse field for UI
          tokensOrSol: r.type === "buy" ? tokenAmount : solAmount,
          signature: r.signature,
          status,
          timestamp: new Date(r.createdAt).getTime(),
          networkFeeLamports: r.networkFeeLamports ? Number(r.networkFeeLamports) : undefined,
          networkFeeSol: r.networkFeeSol ? Number(r.networkFeeSol) : undefined,
          jitoTipSol: r.jitoTipSol ? Number(r.jitoTipSol) : undefined,
          priorityFeeSolBudget: r.priorityFeeSolBudget ? Number(r.priorityFeeSolBudget) : undefined,
          error: r.error || undefined,
          isAllTx: false, // our bot transactions
        }
      })

      const buys = rows.filter((r) => r.type === "buy" && r.status === "confirmed").length
      const sells = rows.filter((r) => r.type === "sell" && r.status === "confirmed").length
      const volumeSol = rows
        .filter((r) => r.status === "confirmed")
        .reduce((sum, r) => sum + Number(r.solAmount || "0"), 0)

      stats = { buys, sells, volumeSol }
    }

    return NextResponse.json({ transactions, stats })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "internal error" }, { status: 500 })
  }
}

// DELETE - clear volume-bot transactions for a mint
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get("mintAddress")
    if (!mintAddress) {
      return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
    }
    const token = await prisma.token.findFirst({
      where: { mintAddress },
      select: { id: true },
    })

    if (!token) return NextResponse.json({ success: true, deleted: 0 })

    const res = await prisma.transaction.deleteMany({ where: { tokenId: token.id } })
    return NextResponse.json({ success: true, deleted: res.count })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "delete failed" }, { status: 500 })
  }
}


