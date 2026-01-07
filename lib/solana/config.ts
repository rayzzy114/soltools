
import { Connection } from "@solana/web3.js"
import { ENV } from "../env"
import Bottleneck from "bottleneck"

export const SOLANA_NETWORK: string = ENV.network

const envRpcPrimary = process.env.RPC || ENV.rpcPrimary || ""
const envRpcList = envRpcPrimary ? [envRpcPrimary] : []
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com"

export const RPC_ENDPOINTS = envRpcList.length ? [...envRpcList] : [DEFAULT_RPC]
export const RPC_ENDPOINT = RPC_ENDPOINTS[0] || ""

const toWs = (url: string) => (url?.startsWith("http") ? url.replace(/^http/, "ws") : url)
export let RPC_WEBSOCKET_ENDPOINT = toWs(RPC_ENDPOINT)

// --- GLOBAL RPC LOCK & RATE LIMITING ---

let isRpcPaused = false
let rpcPausePromise: Promise<void> | null = null
const RPC_PAUSE_DURATION_MS = 15_000

// SAFE LANE: Strict concurrency limit (Slow Lane)
const limiter = new Bottleneck({
  maxConcurrent: 2,
  minTime: 0
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
  console.warn("[RPC:Safe] Pausing traffic for 15s due to 429")

  rpcPausePromise = new Promise((resolve) => {
    setTimeout(() => {
      isRpcPaused = false
      rpcPausePromise = null
      resolve()
    }, RPC_PAUSE_DURATION_MS)
  })
}

// SAFE LANE FETCH
const rateLimitedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  return limiter.schedule(async () => {
    await waitForRpcPause()
    await new Promise(r => setTimeout(r, 250)) // Delay for safe lane

    try {
      const response = await fetch(input, init)
      if (response.status === 429) {
        triggerRpcPause()
      }
      return response
    } catch (error: any) {
      if (error?.status === 429) {
        triggerRpcPause()
      }
      throw error
    }
  })
}

// EXEC LANE FETCH (No limiter, Immediate Failover logic could go here or in wrapper)
const unthrottledFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  // Direct fetch, no pause check, no limiter.
  return fetch(input, init)
}

// --- CONNECTION INSTANCES ---

// 1. SAFE CONNECTION (Slow, throttled, paused on 429)
// Used for: Data fetching, balances, background tasks
let cachedSafeConnection: Connection | null = null
let selectedRpcEndpoint = RPC_ENDPOINT

export const getSafeConnection = () => {
  if (!cachedSafeConnection) {
    cachedSafeConnection = new Connection(selectedRpcEndpoint, {
      commitment: "confirmed",
      fetch: rateLimitedFetch,
    })
  }
  return cachedSafeConnection
}

// 2. EXEC CONNECTION (Fast, unthrottled)
// Used for: sendTransaction, Jito, critical execution
let cachedExecConnection: Connection | null = null

export const getExecConnection = () => {
  if (!cachedExecConnection) {
    // We can potentially use a DIFFERENT endpoint here if configured,
    // otherwise use the same endpoint but with unthrottledFetch
    cachedExecConnection = new Connection(selectedRpcEndpoint, {
      commitment: "confirmed",
      fetch: unthrottledFetch,
    })
  }
  return cachedExecConnection
}

// Backward compatibility: "connection" usually implies the safe/general one
// But for safety in existing code that might spam, we map it to safeConnection.
export const connection: Connection = getSafeConnection()

// Re-export specific getters for clarity
export const safeConnection = getSafeConnection()
export const execConnection = getExecConnection()

// --- RESILIENCE & HEALTH ---

const rpcHeaders = { "Content-Type": "application/json" }

async function probeEndpoint(endpoint: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Probe uses rateLimitedFetch to avoid spamming during checks
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

// Rotates the SAFE connection (slow lane)
export async function getResilientConnection(): Promise<Connection> {
  await waitForRpcPause()

  if (RPC_ENDPOINTS.length <= 1) return getSafeConnection()

  // Simple rotation check
  const endpoint = await selectHealthyRpcEndpoint()
  if (!cachedSafeConnection || endpoint !== selectedRpcEndpoint) {
    selectedRpcEndpoint = endpoint
    cachedSafeConnection = new Connection(selectedRpcEndpoint, {
      commitment: "confirmed",
      fetch: rateLimitedFetch,
    })
    // Also update exec connection to match (or keep it separate if we had distinct pools)
    cachedExecConnection = new Connection(selectedRpcEndpoint, {
      commitment: "confirmed",
      fetch: unthrottledFetch,
    })
  }
  return cachedSafeConnection
}

export async function selectHealthyRpcEndpoint(): Promise<string> {
  if (!RPC_ENDPOINTS.length) return DEFAULT_RPC
  await waitForRpcPause()

  const attempts = Math.min(RPC_ENDPOINTS.length * 2, 6)
  for (let i = 0; i < attempts; i++) {
    const endpoint = RPC_ENDPOINTS[i % RPC_ENDPOINTS.length]
    const healthy = await probeEndpoint(endpoint, 1200 + i * 200)
    if (healthy) {
      RPC_WEBSOCKET_ENDPOINT = toWs(endpoint)
      return endpoint
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * Math.pow(1.4, i)))
  }
  return selectedRpcEndpoint
}

// --- EXEC LANE FAILOVER ---

/**
 * Execute a critical RPC task (like sendTransaction) with immediate failover.
 * If 429 or timeout, immediately switches to next endpoint and retries.
 * Does NOT wait for global pause.
 */
export async function executeCritical<T>(
  task: (conn: Connection) => Promise<T>,
  retries = 3
): Promise<T> {
  let lastError: any

  for (let i = 0; i <= retries; i++) {
    try {
      const conn = getExecConnection()
      return await task(conn)
    } catch (error: any) {
      lastError = error
      const isRetryable = error?.message?.includes("429") ||
                          error?.message?.includes("timeout") ||
                          error?.name === "NetworkError"

      if (isRetryable && i < retries) {
        console.warn(`[Exec] Critical task failed, failing over immediately (attempt ${i+1}/${retries})`)

        // IMMEDIATE FAILOVER: Rotate endpoint without waiting
        const currentIdx = RPC_ENDPOINTS.indexOf(selectedRpcEndpoint)
        const nextIdx = (currentIdx + 1) % RPC_ENDPOINTS.length
        selectedRpcEndpoint = RPC_ENDPOINTS[nextIdx]

        // Re-init exec connection
        cachedExecConnection = new Connection(selectedRpcEndpoint, {
          commitment: "confirmed",
          fetch: unthrottledFetch,
        })

        continue
      }
      throw error
    }
  }
  throw lastError
}

export const isPublicRpc =
  RPC_ENDPOINT.includes("api.mainnet-beta.solana.com") ||
  RPC_ENDPOINT.includes("api.devnet.solana.com")

if (typeof window === "undefined") {
  console.log(`Solana Network: ${SOLANA_NETWORK}`)
  console.log(`RPC Strategy: Split Lane (Safe: ${limiter.counts().EXECUTING}, Exec: Unthrottled)`)
}
