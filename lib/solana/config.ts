import { Connection, clusterApiUrl } from "@solana/web3.js"
import { ENV } from "../env"

// hard mainnet defaults for testing (ignores .env network)
export const SOLANA_NETWORK: string = "mainnet-beta"

const HARDCODED_RPC = "https://lb.drpc.live/solana/Atq_UX05s04RtjyXPMy7fEdebKdG1c4R8KoACqfUNZ5M"
const PUBLIC_FALLBACKS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-mainnet.rpcpool.com",
]

// build RPC endpoints list with fallbacks, prefer provided
export const RPC_ENDPOINTS = [HARDCODED_RPC, ...PUBLIC_FALLBACKS]

export const RPC_ENDPOINT = RPC_ENDPOINTS[0]
const toWs = (url: string) => (url?.startsWith("http") ? url.replace(/^http/, "ws") : url)
let selectedWebsocketEndpoint = toWs(RPC_ENDPOINT)
export let RPC_WEBSOCKET_ENDPOINT = selectedWebsocketEndpoint

// check if using public RPC (not recommended for production) — with hardcoded defaults we consider public if primary is fallback
export const isPublicRpc = RPC_ENDPOINT !== HARDCODED_RPC

let selectedRpcEndpoint = RPC_ENDPOINT
let cachedConnection: Connection | null = null

const rpcHeaders = { "Content-Type": "application/json" }

async function probeEndpoint(endpoint: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: controller.signal,
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => ({}))
    return data?.result === "ok"
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function selectHealthyRpcEndpoint(): Promise<string> {
  const attempts = Math.min(RPC_ENDPOINTS.length * 2, 6)
  for (let i = 0; i < attempts; i++) {
    const endpoint = RPC_ENDPOINTS[i % RPC_ENDPOINTS.length]
    const healthy = await probeEndpoint(endpoint, 1200 + i * 200)
    if (healthy) {
      selectedRpcEndpoint = endpoint
      selectedWebsocketEndpoint = toWs(endpoint)
      RPC_WEBSOCKET_ENDPOINT = selectedWebsocketEndpoint
      return endpoint
    }
    // exponential-ish backoff
    await new Promise((resolve) => setTimeout(resolve, 150 * Math.pow(1.4, i)))
  }
  return selectedRpcEndpoint
}

export const getConnection = () => {
  if (!cachedConnection) {
    cachedConnection = new Connection(selectedRpcEndpoint, {
      commitment: "confirmed",
    })
  }
  return cachedConnection
}

export async function getResilientConnection(): Promise<Connection> {
  const endpoint = await selectHealthyRpcEndpoint()
  if (!cachedConnection || endpoint !== selectedRpcEndpoint) {
    selectedRpcEndpoint = endpoint
    cachedConnection = new Connection(selectedRpcEndpoint, {
      commitment: "confirmed",
    })
  }
  return cachedConnection
}

export async function getRpcHealth(): Promise<{ endpoint: string; healthy: boolean }> {
  const endpoint = await selectHealthyRpcEndpoint()
  const healthy = await probeEndpoint(endpoint)
  return { endpoint, healthy }
}

export const connection = getConnection()

// Log network info and warnings
if (typeof window === "undefined") {
  console.log(`🔗 Solana Network: ${SOLANA_NETWORK}`)
  console.log(`🔗 RPC Endpoint: ${RPC_ENDPOINT}`)
  if (RPC_ENDPOINTS.length > 1) {
    console.log(`🔁 RPC fallbacks: ${RPC_ENDPOINTS.slice(1).join(", ")}`)
  }
  
  // production warnings
  if (SOLANA_NETWORK === "devnet") {
    console.warn(`⚠️  WARNING: Running on DEVNET! Set NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta for production`)
  }
  
  if (isPublicRpc && SOLANA_NETWORK === "mainnet-beta") {
    console.warn(`⚠️  WARNING: Using PUBLIC RPC on mainnet! This will be slow and rate-limited.`)
    console.warn(`⚠️  Set NEXT_PUBLIC_SOLANA_RPC_URL to your RPC provider (Helius, QuickNode, ERPC)`)
  }
}

