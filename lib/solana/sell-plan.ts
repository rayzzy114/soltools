import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js"
import {
  getBondingCurveData,
  calculateSellAmount,
  getPumpswapPoolData,
  calculatePumpswapSwapAmount,
  buildSellTransaction,
  buildPumpswapSwapTransaction,
} from "./pumpfun-sdk"
import { SellRoute } from "@/lib/config/limits"

export interface SellPlanResult {
  transaction: Transaction
  method: "bonding_curve" | "pumpswap"
  minSolOut: bigint
  estimatedSol: bigint
}

export async function buildSellPlan(
  seller: PublicKey,
  mint: PublicKey,
  tokenAmountRaw: bigint,
  slippage: number,
  priorityFee: number,
  route: SellRoute = "auto",
  payoutAddress?: PublicKey
): Promise<SellPlanResult> {
  const bondingCurve = await getBondingCurveData(mint)

  if (!bondingCurve && route === "bonding_curve") {
    throw new Error("token not on bonding curve")
  }

  const preferPumpswap = route === "pumpswap" || (route === "auto" && bondingCurve?.complete)

  if (preferPumpswap) {
    const poolData = await getPumpswapPoolData(mint)
    if (!poolData) {
      if (route === "pumpswap") {
        throw new Error("pumpswap pool unavailable")
      }
      // fallback to bonding curve if auto
    } else {
      const swap = calculatePumpswapSwapAmount(poolData, tokenAmountRaw, true)
      const minSolOut = (swap.solOut * BigInt(100 - slippage)) / BigInt(100)
      const tx = await buildPumpswapSwapTransaction(
        seller,
        mint,
        tokenAmountRaw,
        minSolOut,
        priorityFee
      )
      if (payoutAddress) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: seller,
            toPubkey: payoutAddress,
            lamports: minSolOut > BigInt(5000) ? minSolOut - BigInt(5000) : minSolOut,
          })
        )
      }
      return {
        transaction: tx,
        method: "pumpswap",
        minSolOut,
        estimatedSol: swap.solOut,
      }
    }
  }

  if (!bondingCurve) {
    throw new Error("token not found on pump.fun")
  }

  const { solOut } = calculateSellAmount(bondingCurve, tokenAmountRaw)
  const minSolOut = (solOut * BigInt(100 - slippage)) / BigInt(100)
  const tx = await buildSellTransaction(
    seller,
    mint,
    tokenAmountRaw,
    minSolOut,
    priorityFee
  )
  if (payoutAddress) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: seller,
        toPubkey: payoutAddress,
        lamports: minSolOut > BigInt(5000) ? minSolOut - BigInt(5000) : minSolOut,
      })
    )
  }

  return {
    transaction: tx,
    method: "bonding_curve",
    minSolOut,
    estimatedSol: solOut,
  }
}

