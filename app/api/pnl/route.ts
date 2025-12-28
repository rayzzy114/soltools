import { NextRequest, NextResponse } from "next/server"
import { PublicKey } from "@solana/web3.js"
import { prisma } from "@/lib/prisma"
import { getBondingCurveData, calculateTokenPrice } from "@/lib/solana/pumpfun-sdk"
import {
  buildPositionsFromTrades,
  aggregateWalletPnL,
  aggregateTokenPnL,
  calculatePnLSummary,
  createPnLCardData,
} from "@/lib/pnl/tracker"
import type { Trade } from "@/lib/pnl/types"

type TradeFilters = {
  walletAddress?: string | null
  mintAddress?: string | null
  limit?: number
  status?: "confirmed" | "pending" | "failed"
}

async function resolveTokenByMint(mintAddress: string) {
  return prisma.token.findFirst({
    where: { mintAddress },
    select: { id: true, mintAddress: true, symbol: true, name: true },
  })
}

function toTrade(row: any): Trade {
  const tokenAmount = parseFloat(row.amount || "0")
  const solAmount = parseFloat(row.solAmount || "0")
  const price =
    row.price != null
      ? parseFloat(row.price)
      : tokenAmount > 0
        ? solAmount / tokenAmount
        : 0

  const networkFeeSol = row.networkFeeSol != null ? parseFloat(row.networkFeeSol) : undefined
  const priorityFeeSol = row.priorityFeeSolBudget != null ? parseFloat(row.priorityFeeSolBudget) : undefined
  const jitoTipSol = row.jitoTipSol != null ? parseFloat(row.jitoTipSol) : undefined
  const fee =
    row.networkFeeSol != null || row.priorityFeeSolBudget != null || row.jitoTipSol != null
      ? (networkFeeSol || 0) + (priorityFeeSol || 0) + (jitoTipSol || 0)
      : undefined

  return {
    id: row.id,
    walletAddress: row.walletAddress,
    mintAddress: row.token?.mintAddress || "",
    type: row.type === "sell" ? "sell" : "buy",
    solAmount,
    tokenAmount,
    price,
    signature: row.signature || "",
    timestamp: row.createdAt,
    networkFeeSol,
    priorityFeeSol,
    jitoTipSol,
    fee,
  }
}

async function loadTrades(filters: TradeFilters): Promise<Trade[]> {
  const { walletAddress, mintAddress, limit, status } = filters
  let tokenId: string | undefined
  if (mintAddress) {
    const token = await resolveTokenByMint(mintAddress)
    if (!token) return []
    tokenId = token.id
  }

  const where: any = {}
  if (walletAddress) where.walletAddress = walletAddress
  if (tokenId) where.tokenId = tokenId
  if (status) where.status = status

  const rows = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: "asc" },
    ...(limit ? { take: limit } : {}),
    include: {
      token: { select: { mintAddress: true, symbol: true, name: true } },
    },
  })

  return rows.map(toTrade)
}

async function getCurrentPrices(mints: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  for (const mint of mints) {
    try {
      const bondingCurve = await getBondingCurveData(new PublicKey(mint))
      if (bondingCurve) {
        prices.set(mint, calculateTokenPrice(bondingCurve))
      }
    } catch {
      // ignore individual failures
    }
  }
  return prices
}

// GET - PnL data from DB
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get("type") || "summary"
    const walletAddress = searchParams.get("wallet")
    const mintAddress = searchParams.get("mint")
    const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") || 200)))

    const trades = await loadTrades({
      walletAddress,
      mintAddress,
      limit: type === "trades" ? limit : undefined,
      status: "confirmed",
    })

    const mints = [...new Set(trades.map((t) => t.mintAddress).filter(Boolean))]
    const currentPrices = await getCurrentPrices(mints)
    const positions = buildPositionsFromTrades(trades, currentPrices)
    const positionsList = Array.from(positions.values())
    const tokenInfos = mints.length
      ? await prisma.token.findMany({
          where: { mintAddress: { in: mints } },
          select: { mintAddress: true, symbol: true, name: true },
        })
      : []
    const tokenInfoMap = new Map(tokenInfos.map((t) => [t.mintAddress, t]))

    switch (type) {
      case "summary": {
        return NextResponse.json(calculatePnLSummary(positionsList))
      }
      case "card": {
        const title = searchParams.get("title") || "PnL Report"
        const tokenPnls = mints.map((mint) =>
          aggregateTokenPnL(positionsList, mint, tokenInfoMap.get(mint))
        )
        return NextResponse.json(createPnLCardData(calculatePnLSummary(positionsList), tokenPnls, title))
      }
      case "wallet": {
        if (!walletAddress) {
          return NextResponse.json({ error: "wallet required" }, { status: 400 })
        }
        return NextResponse.json(aggregateWalletPnL(positionsList, walletAddress))
      }
      case "token": {
        if (!mintAddress) {
          return NextResponse.json({ error: "mint required" }, { status: 400 })
        }
        return NextResponse.json(aggregateTokenPnL(positionsList, mintAddress, tokenInfoMap.get(mintAddress)))
      }
      case "tokens": {
        const tokenPnls = mints.map((mint) =>
          aggregateTokenPnL(positionsList, mint, tokenInfoMap.get(mint))
        )
        return NextResponse.json(tokenPnls)
      }
      case "positions": {
        const filter = searchParams.get("filter")
        let filtered = positionsList
        if (filter === "open") filtered = filtered.filter((p) => p.isOpen)
        if (filter === "closed") filtered = filtered.filter((p) => !p.isOpen)
        if (walletAddress) filtered = filtered.filter((p) => p.walletAddress === walletAddress)
        if (mintAddress) filtered = filtered.filter((p) => p.mintAddress === mintAddress)
        return NextResponse.json(filtered)
      }
      case "trades": {
        return NextResponse.json(trades.slice(-limit))
      }
      default:
        return NextResponse.json({ error: "invalid type" }, { status: 400 })
    }
  } catch (error: any) {
    console.error("pnl error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST - record trade(s) in DB
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    if (action === "record_trade") {
      const {
        walletAddress,
        mintAddress,
        type,
        solAmount,
        tokenAmount,
        price,
        signature,
        networkFeeSol,
        priorityFeeSol,
        jitoTipSol,
      } = body

      if (!walletAddress || !mintAddress || !type || !solAmount || !tokenAmount) {
        return NextResponse.json({ error: "missing required fields" }, { status: 400 })
      }

      const token = await resolveTokenByMint(mintAddress)
      if (!token) {
        return NextResponse.json({ error: "token not found" }, { status: 404 })
      }

      const priceValue =
        price != null
          ? String(price)
          : parseFloat(tokenAmount) > 0
            ? String(Number(solAmount) / Number(tokenAmount))
            : null

      const created = await prisma.transaction.create({
        data: {
          signature: signature || null,
          tokenId: token.id,
          type: type === "sell" ? "sell" : "buy",
          walletAddress,
          amount: String(tokenAmount),
          solAmount: String(solAmount),
          price: priceValue,
          status: "confirmed",
          networkFeeSol: networkFeeSol != null ? String(networkFeeSol) : null,
          priorityFeeSolBudget: priorityFeeSol != null ? String(priorityFeeSol) : null,
          jitoTipSol: jitoTipSol != null ? String(jitoTipSol) : null,
        },
        select: { id: true },
      })

      return NextResponse.json({ success: true, id: created.id })
    }

    if (action === "record_trades") {
      const { trades } = body
      if (!Array.isArray(trades)) {
        return NextResponse.json({ error: "trades array required" }, { status: 400 })
      }

      const mintAddresses = [...new Set(trades.map((t: any) => t.mintAddress).filter(Boolean))]
      const tokens = await prisma.token.findMany({
        where: { mintAddress: { in: mintAddresses } },
        select: { id: true, mintAddress: true },
      })
      const tokenMap = new Map(tokens.map((t) => [t.mintAddress, t.id]))

      const rows = trades
        .map((t: any) => {
          const tokenId = tokenMap.get(t.mintAddress)
          if (!tokenId) return null
          const tokenAmount = Number(t.tokenAmount ?? t.amount ?? 0)
          const solAmount = Number(t.solAmount ?? t.tokensOrSol ?? 0)
          const priceValue =
            t.price != null
              ? String(t.price)
              : tokenAmount > 0
                ? String(solAmount / tokenAmount)
                : null
          return {
            signature: t.signature || null,
            tokenId,
            type: t.type === "sell" ? "sell" : "buy",
            walletAddress: t.walletAddress,
            amount: String(tokenAmount),
            solAmount: String(solAmount),
            price: priceValue,
            status: "confirmed",
            networkFeeSol: t.networkFeeSol != null ? String(t.networkFeeSol) : null,
            priorityFeeSolBudget: t.priorityFeeSol != null ? String(t.priorityFeeSol) : null,
            jitoTipSol: t.jitoTipSol != null ? String(t.jitoTipSol) : null,
          }
        })
        .filter(Boolean)

      if (!rows.length) {
        return NextResponse.json({ error: "no valid trades to record" }, { status: 400 })
      }

      await prisma.transaction.createMany({
        data: rows as any[],
        skipDuplicates: true,
      })

      return NextResponse.json({ success: true, count: rows.length })
    }

    return NextResponse.json({ error: "invalid action" }, { status: 400 })
  } catch (error: any) {
    console.error("pnl error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
