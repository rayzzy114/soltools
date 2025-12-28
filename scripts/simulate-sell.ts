import { readFileSync } from "fs"
import { join } from "path"
import bs58 from "bs58"
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js"
import { RPC_ENDPOINT } from "../lib/solana/config"

async function main() {
  const [mintAddress, tokenAmountStr, secretKeyPath] = process.argv.slice(2)
  if (!mintAddress || !tokenAmountStr || !secretKeyPath) {
    console.error("usage: pnpm tsx scripts/simulate-sell.ts <mint> <tokenAmount> <secretKeyFile>")
    process.exit(1)
  }
  const tokenAmount = parseFloat(tokenAmountStr)
  const secret = readFileSync(join(process.cwd(), secretKeyPath), "utf8").trim()
  const kp = Keypair.fromSecretKey(bs58.decode(secret))

  const body = {
    wallet: {
      publicKey: kp.publicKey.toBase58(),
      secretKey: bs58.encode(kp.secretKey),
      solBalance: 0,
      tokenBalance: 0,
      isActive: true,
    },
    mintAddress,
    type: "sell",
    amount: tokenAmount.toFixed(6),
    slippage: 20,
    priorityFee: 0.0001,
    route: "auto",
    simulate: true,
  }

  const res = await fetch("http://localhost:3000/api/volume-bot/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok || data.error) {
    console.error("api error", data.error || res.statusText)
    process.exit(1)
  }
  if (!data.transaction || !data.transaction.transaction) {
    console.error("no transaction returned", data)
    process.exit(1)
  }

  const txBase58 = data.transaction.transaction as string
  const raw = bs58.decode(txBase58)
  let legacyTx: Transaction | undefined
  let vtx: VersionedTransaction | undefined
  try {
    vtx = VersionedTransaction.deserialize(raw)
  } catch {
    legacyTx = Transaction.from(raw)
  }

  const connection = new Connection(RPC_ENDPOINT, "confirmed")
  if (vtx) {
    const sim = await connection.simulateTransaction(vtx, { replaceRecentBlockhash: true })
    console.log("simulate logs:", sim.value.logs)
    console.log("simulate err:", sim.value.err)
  } else if (legacyTx) {
    const sim = await connection.simulateTransaction(legacyTx, [], { replaceRecentBlockhash: true } as any)
    console.log("simulate logs:", sim.value.logs)
    console.log("simulate err:", sim.value.err)
  } else {
    console.error("failed to deserialize transaction")
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

