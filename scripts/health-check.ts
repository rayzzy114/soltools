import { PUMPFUN_PROGRAM_ID } from "../lib/solana/pumpfun-sdk"
import { getResilientConnection, getRpcHealth, RPC_ENDPOINTS, SOLANA_NETWORK } from "../lib/solana/config"

async function main() {
  console.log("🔗 network:", SOLANA_NETWORK)
  console.log("🔗 rpc endpoints:", RPC_ENDPOINTS.join(", "))

  const { endpoint, healthy } = await getRpcHealth()
  console.log("✅ rpc health:", healthy ? "ok" : "unhealthy", "-", endpoint)

  const connection = await getResilientConnection()

  const programInfo = await connection.getAccountInfo(PUMPFUN_PROGRAM_ID)
  console.log("✅ pump.fun program account:", programInfo ? "reachable" : "missing")

  try {
    const res = await fetch("https://pump.fun/api/ipfs", { method: "OPTIONS" })
    console.log("✅ pump.fun ipfs endpoint:", res.ok ? "reachable" : `status ${res.status}`)
  } catch (error: any) {
    console.log("⚠️  pump.fun ipfs check failed:", error?.message)
  }
}

main().catch((error) => {
  console.error("health check failed:", error)
  process.exit(1)
})

