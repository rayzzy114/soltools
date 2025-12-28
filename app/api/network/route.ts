import { NextResponse } from "next/server"
import { SOLANA_NETWORK, RPC_ENDPOINT, RPC_ENDPOINTS, getRpcHealth } from "@/lib/solana/config"
import { logger, getCorrelationId } from "@/lib/logger"

export async function GET() {
  const correlationId = getCorrelationId()
  const { endpoint: healthyRpc, healthy } = await getRpcHealth()

  logger.info({ correlationId, endpoint: healthyRpc, healthy }, "network status")

  return NextResponse.json({
    network: SOLANA_NETWORK,
    rpc: RPC_ENDPOINT,
    rpcFallbacks: RPC_ENDPOINTS.slice(1),
    healthyRpc,
    rpcHealthy: healthy,
    pumpFunAvailable: SOLANA_NETWORK === "mainnet-beta",
  })
}
