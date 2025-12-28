/**
 * Симуляция buy-транзакции для volume bot с tip под Jito.
 * Ничего не отправляет в сеть, только simulateTransaction и выводит base58 транзу,
 * которую можно отправить через Jito bundle.
 *
 * Запуск (ts-node):
 * SECRET_KEY="<bs58 private key>" MINT="<mint>" SOL_AMOUNT="0.01" TIP_SOL="0.001" REGION="frankfurt" npx ts-node scripts/jito-buy-sim.ts
 */

import "dotenv/config"
import bs58 from "bs58"
import { PublicKey, Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { buildBuyTransaction, calculateBuyAmount, getBondingCurveData } from "@/lib/solana/pumpfun-sdk"
import { createTipInstruction, JitoRegion } from "@/lib/solana/jito"
import { connection as sharedConnection } from "@/lib/solana/config"

async function main() {
  const secret = process.env.SECRET_KEY
  const mintStr = process.env.MINT
  const solAmount = Number(process.env.SOL_AMOUNT || "0.01")
  const tipSol = Number(process.env.TIP_SOL || "0.001")
  const region = (process.env.REGION as JitoRegion) || "frankfurt"
  const rpcOverride = process.env.RPC_ENDPOINT

  if (!secret || !mintStr) {
    console.error("SECRET_KEY and MINT are required envs")
    process.exit(1)
  }

  const wallet = Keypair.fromSecretKey(bs58.decode(secret))
  const mint = new PublicKey(mintStr)
  const conn: Connection = rpcOverride
    ? new Connection(rpcOverride, "confirmed")
    : sharedConnection

  // fetch bonding curve (to ensure token exists)
  const bondingCurve = await getBondingCurveData(mint)
  if (!bondingCurve) {
    console.error("token not found on pump.fun")
    process.exit(1)
  }
  if (bondingCurve.complete) {
    console.warn("token migrated: buy may fail on pump.fun")
  }

  const { tokensOut } = calculateBuyAmount(bondingCurve, solAmount)
  console.log("calc tokensOut:", Number(tokensOut) / 1e6)

  const { blockhash } = await conn.getLatestBlockhash()
  const tx = await buildBuyTransaction(
    wallet.publicKey,
    mint,
    solAmount,
    tokensOut, // без слиппейджа для симуляции; можно уменьшить при желании
    tipSol // priority fee
  )

  // add Jito tip
  tx.add(createTipInstruction(wallet.publicKey, tipSol, region))
  tx.recentBlockhash = blockhash
  tx.sign(wallet)

  const sim = await conn.simulateTransaction(tx, {
    sigVerify: true,
    replaceRecentBlockhash: true,
  })

  console.log("simulation err:", sim.value.err)
  console.log("compute units consumed:", sim.value.unitsConsumed)
  console.log("logs:\n", sim.value.logs?.join("\n"))

  const raw = tx.serialize()
  const base58 = bs58.encode(raw)
  console.log("serialized tx (base58):", base58)
  console.log("signature:", tx.signature ? bs58.encode(tx.signature) : "n/a")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

