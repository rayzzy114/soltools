import { readFileSync } from "fs"
import { join } from "path"
import bs58 from "bs58"
import { Connection, PublicKey, Transaction, VersionedTransaction, Keypair } from "@solana/web3.js"
import { RPC_ENDPOINT } from "../lib/solana/config"

type BuyRequest = {
  mintAddress: string
  solAmount: number
  buyerWallet: string
  slippage?: number
}

async function main() {
  const [mintAddress, solAmountStr, secretKeyPath] = process.argv.slice(2)
  if (!mintAddress || !solAmountStr || !secretKeyPath) {
    console.error("usage: pnpm tsx scripts/simulate-buy.ts <mint> <solAmount> <secretKeyFile>")
    process.exit(1)
  }
  const solAmount = parseFloat(solAmountStr)
  const secret = readFileSync(join(process.cwd(), secretKeyPath), "utf8").trim()
  const buyer = bs58.decode(secret)
  const kp = Keypair.fromSecretKey(buyer)
  const buyerPub = kp.publicKey.toBase58()

  const body: BuyRequest = {
    mintAddress,
    solAmount,
    buyerWallet: buyerPub,
  }

  const res = await fetch("http://localhost:3000/api/tokens/buy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    console.error("api error", data)
    process.exit(1)
  }

  const txBase58 = data.transaction as string
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

