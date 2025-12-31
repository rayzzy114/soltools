import { Connection } from "@solana/web3.js"
import { ENV } from "../env"

export const SOLANA_NETWORK: string = ENV.network

const envRpcPrimary = process.env.RPC || ENV.rpcPrimary || ""

const envRpcList = envRpcPrimary ? [envRpcPrimary] : []

// build RPC endpoints list (no public fallback)
export const RPC_ENDPOINTS = envRpcList.length ? [...envRpcList] : []

export const RPC_ENDPOINT = RPC_ENDPOINTS[0] || ""
const toWs = (url: string) => (url?.startsWith("http") ? url.replace(/^http/, "ws") : url)
let selectedWebsocketEndpoint = toWs(RPC_ENDPOINT)
export let RPC_WEBSOCKET_ENDPOINT = selectedWebsocketEndpoint

// check if using public RPC (not recommended for production)
export const isPublicRpc =
  RPC_ENDPOINT.includes("api.mainnet-beta.solana.com") ||
  RPC_ENDPOINT.includes("api.devnet.solana.com")

const defaultRpcMinTime = isPublicRpc ? 1200 : 300
const defaultRpcMaxConcurrent = 1
const parsedMinTime = Number(process.env.RPC_RATE_LIMIT_MIN_TIME_MS)
const parsedMaxConcurrent = Number(process.env.RPC_RATE_LIMIT_MAX_CONCURRENT)
const RPC_RATE_LIMIT_MIN_TIME_MS = Number.isFinite(parsedMinTime)
  ? Math.max(0, parsedMinTime)
  : defaultRpcMinTime
const RPC_RATE_LIMIT_MAX_CONCURRENT = Number.isFinite(parsedMaxConcurrent)
  ? Math.max(1, Math.floor(parsedMaxConcurrent))
  : defaultRpcMaxConcurrent

type FetchTask = {
  input: RequestInfo | URL
  init?: RequestInit
  resolve: (value: Response | PromiseLike<Response>) => void
  reject: (reason?: any) => void
}

function createRateLimitedFetch(minIntervalMs: number, maxConcurrent: number) {
  if (minIntervalMs <= 0 && maxConcurrent >= 50) {
    return (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)
  }

  const queue: FetchTask[] = []
  let inFlight = 0
  let lastStart = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const pump = () => {
    if (inFlight >= maxConcurrent) return
    if (!queue.length) return
    const now = Date.now()
    const waitMs = Math.max(0, minIntervalMs - (now - lastStart))
    if (waitMs > 0) {
      if (!timer) {
        timer = setTimeout(() => {
          timer = null
          pump()
        }, waitMs)
      }
      return
    }

    const task = queue.shift()
    if (!task) return
    inFlight += 1
    lastStart = Date.now()
    fetch(task.input, task.init)
      .then(task.resolve, task.reject)
      .finally(() => {
        inFlight -= 1
        pump()
      })

    if (inFlight < maxConcurrent) {
      pump()
    }
  }

  return (input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      queue.push({ input, init, resolve, reject })
      pump()
    })
}

const rateLimitedFetch = createRateLimitedFetch(
  RPC_RATE_LIMIT_MIN_TIME_MS,
  RPC_RATE_LIMIT_MAX_CONCURRENT
)

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
    throw new Error("RPC is not configured")
  }
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
  if (!RPC_ENDPOINTS.length) {
    throw new Error("RPC is not configured")
  }
  if (!cachedConnection) {
    cachedConnection = new Connection(selectedRpcEndpoint, {
      commitment: "confirmed",
      fetch: rateLimitedFetch,
    })
  }
  return cachedConnection
}

export async function getResilientConnection(): Promise<Connection> {
  if (!RPC_ENDPOINTS.length) {
    throw new Error("RPC is not configured")
  }
  const endpoint = await selectHealthyRpcEndpoint()
  if (!cachedConnection || endpoint !== selectedRpcEndpoint) {
    selectedRpcEndpoint = endpoint
    cachedConnection = new Connection(selectedRpcEndpoint, {
      commitment: "confirmed",
      fetch: rateLimitedFetch,
    })
  }
  return cachedConnection
}

export async function getRpcHealth(): Promise<{ endpoint: string; healthy: boolean }> {
  const endpoint = await selectHealthyRpcEndpoint()
  const healthy = await probeEndpoint(endpoint)
  return { endpoint, healthy }
}

// Lazy initialization to avoid crash on import if RPC is missing
let connectionInstance: Connection | null = null;
export const connection = new Proxy({} as Connection, {
  get(_target, prop) {
    if (!connectionInstance) {
      connectionInstance = getConnection()
    }
    // @ts-ignore
    const value = connectionInstance[prop]
    if (typeof value === "function") {
      return value.bind(connectionInstance)
    }
    return value
  },
})

// Log network info and warnings
if (typeof window === "undefined") {
  console.log(`Solana Network: ${SOLANA_NETWORK}`)
  if (RPC_ENDPOINT) {
    console.log(`RPC Endpoint: ${RPC_ENDPOINT}`)
    if (RPC_ENDPOINTS.length > 1) {
      console.log(`RPC fallbacks: ${RPC_ENDPOINTS.slice(1).join(", ")}`)
    }
  } else {
    console.error("RPC Endpoint missing: set RPC in .env")
  }

  // production warnings
  if (SOLANA_NETWORK === "devnet") {
    console.warn("WARNING: Running on DEVNET! Set NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta for production")
  }

  if (isPublicRpc && SOLANA_NETWORK === "mainnet-beta") {
    console.warn("WARNING: Using PUBLIC RPC on mainnet! This will be slow and rate-limited.")
    console.warn("Set RPC to your provider (Helius, QuickNode, ERPC)")
  }
}
