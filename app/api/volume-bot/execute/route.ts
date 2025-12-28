import { NextRequest, NextResponse } from "next/server"
import { PublicKey } from "@solana/web3.js"
import { executeBuy, executeSell, type VolumeWallet } from "@/lib/solana/volume-bot-engine"
import { isPumpFunAvailable, getBondingCurveData } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { SellRoute } from "@/lib/config/limits"
import { z } from "zod"
import { prisma } from "@/lib/prisma"

// POST - execute single transaction
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const schema = z.object({
      wallet: z.object({
        publicKey: z.string(),
        secretKey: z.string(),
        solBalance: z.number(),
        tokenBalance: z.number(),
        isActive: z.boolean(),
        ataExists: z.boolean().optional(),
      }),
      mintAddress: z.string(),
      type: z.enum(["buy", "sell"]),
      amount: z.union([z.string(), z.number()]),
      slippage: z.number().optional(),
      priorityFee: z.number().optional(),
      route: z.enum(["auto", "bonding_curve", "pumpswap"]).optional(),
      simulate: z.boolean().optional(),
      useJito: z.boolean().optional(),
      jitoRegion: z.string().optional(),
      jitoTip: z.number().optional(),
      autoFees: z.boolean().optional(),
    })
    const {
      wallet,
      mintAddress,
      type,
      amount,
      slippage = 10,
      priorityFee = 0.0005,
      route = "auto",
      simulate = false,
      useJito = true,
      jitoRegion,
      jitoTip,
      autoFees = true,
    } = schema.parse(body)

    if (!wallet || !mintAddress || !type || !amount) {
      return NextResponse.json(
        {
          error: "wallet, mintAddress, type, and amount required",
        },
        { status: 400 }
      )
    }

    if (!isPumpFunAvailable()) {
      return NextResponse.json(
        {
          error: `pump.fun not available on ${SOLANA_NETWORK}`,
        },
        { status: 400 }
      )
    }

    const mint = new PublicKey(mintAddress)
    const bondingCurve = await getBondingCurveData(mint)

    if (type === "buy" && bondingCurve?.complete) {
      return NextResponse.json(
        {
          error: "token migrated - buy on pumpswap/raydium",
        },
        { status: 400 }
      )
    }

    let tx
    if (type === "buy") {
      tx = await executeBuy(
        wallet as VolumeWallet,
        mintAddress,
        parseFloat(String(amount)),
        slippage,
        priorityFee,
        bondingCurve,
        {
          useJito,
          jitoRegion: (jitoRegion as any) || "frankfurt",
          jitoTip: jitoTip ?? 0.005,
          autoFees,
          ataExists: wallet.ataExists ?? false,
        }
      )
    } else if (type === "sell") {
      tx = await executeSell(
        wallet as VolumeWallet,
        mintAddress,
        parseFloat(String(amount)),
        slippage,
        priorityFee,
        bondingCurve,
        route as SellRoute,
        {
          simulate,
          useJito,
          jitoRegion: (jitoRegion as any) || "frankfurt",
          jitoTip: jitoTip ?? 0.005,
          autoFees,
        }
      )
    } else {
      return NextResponse.json({ error: "invalid type" }, { status: 400 })
    }

    // persist tx into DB (Transaction table) so UI stats/log survive refresh
    if (tx) {
      const mintAddr = mint.toBase58()
      let token = await prisma.token.findFirst({
        where: { mintAddress: mintAddr },
        select: { id: true },
      })
      if (!token) {
        // best-effort: fetch from pump.fun to avoid bogus placeholders
        let data: any = null
        try {
          const resp = await fetch(`https://frontend-api.pump.fun/coins/${mintAddr}`)
          if (resp.ok) data = await resp.json()
        } catch {
          // ignore
        }
        const created = await prisma.token.create({
          data: {
            mintAddress: mintAddr,
            name: data?.name || mintAddr.slice(0, 6),
            symbol: data?.symbol || mintAddr.slice(0, 4),
            decimals: 6,
            totalSupply: "0",
            description: data?.description || "",
            imageUrl: data?.image_uri || "",
            creatorWallet: data?.creator || "",
          },
          select: { id: true },
        })
        token = created
      }

      const status = tx.status === "success" ? "confirmed" : tx.status === "failed" ? "failed" : "pending"
      const tokenAmount = tx.type === "buy" ? tx.tokensOrSol : tx.amount
      const solAmountValue = tx.type === "buy" ? tx.amount : tx.tokensOrSol

      const feeData = {
        networkFeeLamports: typeof tx.networkFeeLamports === "number" ? String(tx.networkFeeLamports) : null,
        networkFeeSol: typeof tx.networkFeeSol === "number" ? String(tx.networkFeeSol) : null,
        jitoTipSol: typeof tx.jitoTipSol === "number" ? String(tx.jitoTipSol) : null,
        priorityFeeSolBudget: typeof tx.priorityFeeSolBudget === "number" ? String(tx.priorityFeeSolBudget) : null,
        error: tx.error ? String(tx.error).slice(0, 500) : null,
      }

      if (tx.signature) {
        await prisma.transaction.upsert({
          where: { signature: tx.signature },
          update: {
            type: tx.type,
            walletAddress: tx.wallet,
            amount: String(tokenAmount),
            solAmount: String(solAmountValue),
            status,
            ...feeData,
          },
          create: {
            signature: tx.signature,
            tokenId: token.id,
            type: tx.type,
            walletAddress: tx.wallet,
            amount: String(tokenAmount),
            solAmount: String(solAmountValue),
            status,
            ...feeData,
          },
        })
      } else {
        await prisma.transaction.create({
          data: {
            signature: null as any,
            tokenId: token.id,
            type: tx.type,
            walletAddress: tx.wallet,
            amount: String(tokenAmount),
            solAmount: String(solAmountValue),
            status,
            ...feeData,
          },
        })
      }
    }

    return NextResponse.json({ transaction: tx })
  } catch (error: any) {
    console.error("execute error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
