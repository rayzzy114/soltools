import { Connection } from "@solana/web3.js"
import { ENV } from "../env"
import Bottleneck from "bottleneck"

export const SOLANA_NETWORK: string = ENV.network

const envRpcPrimary = process.env.RPC || ENV.rpcPrimary || ""

const envRpcList = envRpcPrimary ? [envRpcPrimary] : []

// Fallback to public Mainnet if no RPC is configured, to prevent crash.
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com"

// build RPC endpoints list
export const RPC_ENDPOINTS = envRpcList.length ? [...envRpcList] : [DEFAULT_RPC]

export const RPC_ENDPOINT = RPC_ENDPOINTS[0] || ""
const toWs = (url: string) => (url?.startsWith("http") ? url.replace(/^http/, "ws") : url)
let selectedWebsocketEndpoint = toWs(RPC_ENDPOINT)
export let RPC_WEBSOCKET_ENDPOINT = selectedWebsocketEndpoint

// --- GLOBAL RPC LOCK & RATE LIMITING ---

let isRpcPaused = false
let rpcPausePromise: Promise<void> | null = null
const RPC_PAUSE_DURATION_MS = 15_000

// Strict concurrency limit as requested
// We use Bottleneck to enforce max concurrent requests
const limiter = new Bottleneck({
  maxConcurrent: 2,
  minTime: 0 // We handle delay manually to ensure "2 by 2" batching effect if needed
})

const waitForRpcPause = () => {
  if (isRpcPaused && rpcPausePromise) {
    return rpcPausePromise
  }
  return Promise.resolve()
}

const triggerRpcPause = () => {
  if (isRpcPaused) return
  isRpcPaused = true
  console.warn("[RPC] Pausing all traffic for 15s due to 429")

  rpcPausePromise = new Promise((resolve) => {
    setTimeout(() => {
      isRpcPaused = false
      rpcPausePromise = null
      resolve()
    }, RPC_PAUSE_DURATION_MS)
  })
}

const rateLimitedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  return limiter.schedule(async () => {
    // 1. Check global pause
    // If paused, we await the promise. Since this function is running inside a limiter slot,
    // this effectively blocks one of the concurrency slots. With maxConcurrent=2,
    // 2 requests will hang here, and the rest will queue in Bottleneck.
    await waitForRpcPause()

    // 2. Strict delay between requests (250ms)
    // This ensures we don't burst even within the concurrency limit.
    // "strictly 2 by 2 with a 250ms delay between each"
    await new Promise(r => setTimeout(r, 250))

    try {
      const response = await fetch(input, init)

      if (response.status === 429) {
        triggerRpcPause()
      }
      return response
    } catch (error: any) {
      // If the fetch itself throws (e.g. network error), check if it has status 429
      if (error?.status === 429) {
        triggerRpcPause()
      }
      throw error
    }
  })
}

// check if using public RPC (not recommended for production)
export const isPublicRpc =
  RPC_ENDPOINT.includes("api.mainnet-beta.solana.com") ||
  RPC_ENDPOINT.includes("api.devnet.solana.com")

let selectedRpcEndpoint = RPC_ENDPOINT
let cachedConnection: Connection | null = null

const rpcHeaders = { "Content-Type": "application/json" }

async function probeEndpoint(endpoint: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await rateLimitedFetch(endpoint, {
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
  if (!RPC_ENDPOINTS.length) {
    return DEFAULT_RPC
  }

  // Optimization: If we are paused, wait before probing anything.
  await waitForRpcPause()

  const attempts = Math.min(RPC_ENDPOINTS.length * 2, 6)
  for (let i = 0; i < attempts; i++) {
    const endpoint = RPC_ENDPOINTS[i % RPC_ENDPOINTS.length]
    // probeEndpoint uses rateLimitedFetch, so it respects limits and pause
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
      fetch: rateLimitedFetch,
    })
  }
  return cachedConnection
}

export let connection: Connection = getConnection()

export async function getResilientConnection(): Promise<Connection> {
  // Respect global pause before attempting rotation
  await waitForRpcPause()

  const endpoint = await selectHealthyRpcEndpoint()
  if (!cachedConnection || endpoint !== selectedRpcEndpoint) {
    selectedRpcEndpoint = endpoint
    cachedConnection = new Connection(selectedRpcEndpoint, {
      commitment: "confirmed",
      fetch: rateLimitedFetch,
    })
    connection = cachedConnection
  }
  return cachedConnection
}

export async function getRpcHealth(): Promise<{ endpoint: string; healthy: boolean }> {
  const endpoint = await selectHealthyRpcEndpoint()
  const healthy = await probeEndpoint(endpoint)
  return { endpoint, healthy }
}

// Log network info and warnings
if (typeof window === "undefined") {
  console.log(`Solana Network: ${SOLANA_NETWORK}`)
  if (RPC_ENDPOINT) {
    console.log(`RPC Endpoint: ${RPC_ENDPOINT}`)
    if (RPC_ENDPOINTS.length > 1) {
      console.log(`RPC fallbacks: ${RPC_ENDPOINTS.slice(1).join(", ")}`)
    }
    if (RPC_ENDPOINT === DEFAULT_RPC && !envRpcList.length) {
       console.error("CRITICAL: RPC is not configured in .env! Using public fallback.")
    }
  } else {
    console.error("RPC Endpoint missing: set RPC in .env")
  }

  if (SOLANA_NETWORK === "devnet") {
    console.warn("WARNING: Running on DEVNET! Set NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta for production")
  }

  if (isPublicRpc && SOLANA_NETWORK === "mainnet-beta") {
    console.warn("WARNING: Using PUBLIC RPC on mainnet! This will be slow and rate-limited.")
    console.warn("Set RPC to your provider (Helius, QuickNode, ERPC)")
  }
}
