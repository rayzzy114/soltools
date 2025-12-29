import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import bs58 from "bs58"
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher"
import { Bundle } from "jito-ts/dist/sdk/block-engine/types"

// jito block engine endpoints (updated Dec 2025)
export const JITO_ENDPOINTS = {
  ny: "ny.mainnet.block-engine.jito.wtf",
  amsterdam: "amsterdam.mainnet.block-engine.jito.wtf",
  frankfurt: "frankfurt.mainnet.block-engine.jito.wtf",
  tokyo: "tokyo.mainnet.block-engine.jito.wtf",
  slc: "slc.mainnet.block-engine.jito.wtf",
  london: "london.mainnet.block-engine.jito.wtf",
} as const

export type JitoRegion = keyof typeof JITO_ENDPOINTS

// jito tip accounts - randomly select one for each bundle
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]

const AUTH_UUID =
  process.env.JITO_AUTH_UUID ||
  process.env.NEXT_PUBLIC_JITO_AUTH_UUID

const AUTH_KEYPAIR =
  process.env.JITO_AUTH_KEYPAIR ||
  process.env.NEXT_PUBLIC_JITO_AUTH_KEYPAIR ||
  process.env.JITO_AUTH_SECRET

// For HTTP JSON-RPC, use UUID when available; otherwise fallback to keypair token.
const JITO_AUTH_TOKEN = AUTH_UUID || AUTH_KEYPAIR
const JITO_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string | undefined): boolean {
  if (!value) return false
  return JITO_UUID_REGEX.test(value.trim())
}

function withUuidParam(url: string, uuid: string): string {
  try {
    const u = new URL(url)
    if (!u.searchParams.has("uuid")) {
      u.searchParams.set("uuid", uuid)
    }
    return u.toString()
  } catch {
    return url
  }
}

// default config
const MIN_JITO_TIP_LAMPORTS = 1000 // minimum tip per jito docs
const DEFAULT_JITO_TIP = 0.0001 // SOL (~0.1 cents)
const DEFAULT_REGION: JitoRegion = "frankfurt"

// cache for dynamically fetched tip accounts
let cachedTipAccounts: string[] = JITO_TIP_ACCOUNTS
let lastTipFetch = 0
const TIP_CACHE_TTL = 60000 // 1 minute
const BUNDLE_TX_LIMIT = 5
const JITO_TIMEOUT_MS = 12_000
const JITO_BACKOFF = [250, 600, 1200, 2000]

// By default we DO NOT use the gRPC/SDK auth flow (it can require whitelisting).
// Enable only when you have a whitelisted auth key and explicitly want to use the SDK.
const USE_JITO_SDK = process.env.JITO_USE_SDK === "true"

type JsonRpcResponse<T> = { jsonrpc?: string; id?: number | string; result?: T; error?: any }

function getBundleApiUrl(region: JitoRegion = DEFAULT_REGION): string {
  // allow override but default to official public endpoint
  const override =
    process.env.JITO_BUNDLE_API_URL ||
    process.env.NEXT_PUBLIC_JITO_BUNDLE_API_URL
  if (override && override.trim()) return override.trim()

  // Prefer region-specific bundle endpoints to avoid global throttling on mainnet host.
  switch (region) {
    case "ny":
      return "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles"
    case "tokyo":
      return "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles"
    case "amsterdam":
      return "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles"
    case "slc":
      return "https://slc.mainnet.block-engine.jito.wtf/api/v1/bundles"
    case "london":
      return "https://london.mainnet.block-engine.jito.wtf/api/v1/bundles"
    case "frankfurt":
    default:
      return "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles"
  }
}

function getHostFromUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return "invalid-host"
  }
}

// Jito endpoints are rate-limited (docs: ~1 rps per IP per region).
// We enforce a conservative per-host minimum interval to avoid self-inflicted 429s,
// especially when multiple wallets execute concurrently.
const JITO_MIN_INTERVAL_MS = 1150
const lastJitoCallByHost: Record<string, number> = {}

async function jsonRpcPost<T>(url: string, payload: any): Promise<JsonRpcResponse<T>> {
  const host = getHostFromUrl(url)
  const last = lastJitoCallByHost[host] ?? 0
  const now = Date.now()
  const waitMs = Math.max(0, JITO_MIN_INTERVAL_MS - (now - last))
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs))
  }
  lastJitoCallByHost[host] = Date.now()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), JITO_TIMEOUT_MS)

  const headers: Record<string, string> = { "Content-Type": "application/json" }

  let requestUrl = url
  if (JITO_AUTH_TOKEN && JITO_AUTH_TOKEN.length > 10) {
    if (isUuid(JITO_AUTH_TOKEN)) {
      headers["x-jito-auth"] = JITO_AUTH_TOKEN
      requestUrl = withUuidParam(url, JITO_AUTH_TOKEN)
    } else {
      headers["Authorization"] = `Bearer ${JITO_AUTH_TOKEN}`
    }
  }

  try {
    const res = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await res.text()
    let json: JsonRpcResponse<T> | null = null
    try {
      json = JSON.parse(text)
    } catch {
      // ignore
    }
    if (!res.ok) {
      throw new Error(`jito http error: ${res.status} ${text.slice(0, 300)}`)
    }
    if (!json) {
      throw new Error(`jito http error: invalid json response`)
    }
    return json
  } finally {
    clearTimeout(timeout)
  }
}

async function getTipAccountsHttp(region: JitoRegion): Promise<string[]> {
  // Per Jito docs: getTipAccounts is a separate endpoint:
  // POST https://<host>/api/v1/getTipAccounts {jsonrpc, method:getTipAccounts}
  const host =
    region === "ny" ? "ny.mainnet.block-engine.jito.wtf" :
    region === "tokyo" ? "tokyo.mainnet.block-engine.jito.wtf" :
    region === "amsterdam" ? "amsterdam.mainnet.block-engine.jito.wtf" :
    region === "slc" ? "slc.mainnet.block-engine.jito.wtf" :
    region === "london" ? "london.mainnet.block-engine.jito.wtf" :
    "mainnet.block-engine.jito.wtf"
  const url = `https://${host}/api/v1/getTipAccounts`
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTipAccounts",
    params: [],
  }

  const json = await jsonRpcPost<any>(url, payload)
  if (json.error) {
    throw new Error(`jito http error: ${extractErrorMessage(json.error)}`)
  }
  const value = json.result
  const accounts: string[] =
    Array.isArray(value) ? value :
    Array.isArray((value as any)?.value) ? (value as any).value :
    []

  const filtered = accounts.filter((a) => typeof a === "string" && a.length > 20)
  if (!filtered.length) {
    throw new Error("jito http error: empty tip accounts")
  }
  return filtered
}

async function sendBundleHttpOnce(
  transactions: (Transaction | VersionedTransaction)[],
  region: JitoRegion
): Promise<{ bundleId: string; region: JitoRegion }> {
  const url = getBundleApiUrl(region)
  const serialized = transactions.map((tx) => bs58.encode(toVersioned(tx).serialize()))

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendBundle",
    params: [serialized],
  }

  const json = await jsonRpcPost<any>(url, payload)

  if (json.error) {
    throw new Error(`jito http error: ${extractErrorMessage(json.error)}`)
  }
  const bundleId = (json.result as any)?.bundleId || (json.result as any)?.bundle_id || (json.result as any) || ""
  if (!bundleId || typeof bundleId !== "string") {
    throw new Error("jito http error: empty bundle id")
  }
  return { bundleId, region }
}

type InflightEntry = {
  bundleId?: string
  bundle_id?: string
  status?: string
  state?: string
  landed_slot?: number
  landedSlot?: number
  error?: string
  err?: string
  message?: string
}

export async function getInflightBundleStatuses(
  bundleIds: string[],
  region: JitoRegion = DEFAULT_REGION
): Promise<{ bundleId: string; status: BundleStatus["status"]; landedSlot?: number; error?: string }[]> {
  const url = getBundleApiUrl(region)
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getInflightBundleStatuses",
    params: [bundleIds],
  }
  const json = await jsonRpcPost<any>(url, payload)
  if (json.error) {
    throw new Error(`jito http error: ${extractErrorMessage(json.error)}`)
  }
  const arr: InflightEntry[] = Array.isArray(json.result) ? (json.result as any) : (json.result?.value ?? [])
  return (arr || []).map((e: any, idx: number) => {
    const id = e?.bundleId || e?.bundle_id || bundleIds[idx] || ""
    const status = normalizeStatus(e?.state || e?.status)
    const landedSlot = e?.landedSlot ?? e?.landed_slot
    const error = e?.error || e?.err || e?.message
    return { bundleId: id, status, ...(landedSlot !== undefined ? { landedSlot } : {}), ...(error ? { error } : {}) }
  })
}

function isJito429(err: unknown): boolean {
  const msg = extractErrorMessage(err)
  return msg.includes(" 429 ") || msg.toLowerCase().includes("rate limited") || msg.includes("Network congested")
}

/**
 * inflight status with fallback across regions when endpoints are congested (429)
 * Note: bundle status is expected to be queryable from any block engine; we prefer the region we submitted to.
 */
export async function getInflightBundleStatusesWithFallback(
  bundleIds: string[],
  preferredRegion: JitoRegion = DEFAULT_REGION
): Promise<{ bundleId: string; status: BundleStatus["status"]; landedSlot?: number; error?: string; region?: JitoRegion }[]> {
  // IMPORTANT:
  // Jito enforces ~1 rps per IP per region. When endpoints are congested we might see 429.
  // Do NOT immediately fan out across multiple regions in a single poll; that creates a burst
  // and increases 429 rates. Instead, return a "pending" status and let the caller poll again later.
  try {
    const res = await getInflightBundleStatuses(bundleIds, preferredRegion)
    return res.map((x) => ({ ...x, region: preferredRegion }))
  } catch (e) {
    if (isJito429(e)) {
      return bundleIds.map((bundleId) => ({
        bundleId,
        status: "pending",
        error: "rate_limited",
        region: preferredRegion,
      }))
    }
    throw e
  }
}

export async function waitForInflightBundle(
  bundleId: string,
  region: JitoRegion = DEFAULT_REGION,
  timeoutMs: number = 30_000
): Promise<{ bundleId: string; status: BundleStatus["status"]; landedSlot?: number; error?: string }> {
  const start = Date.now()
  let last: any = null
  while (Date.now() - start < timeoutMs) {
    const entries = await getInflightBundleStatuses([bundleId], region)
    const e = entries[0]
    last = e || last
    if (e?.status === "landed" || e?.status === "failed") {
      return e
    }
    await new Promise((r) => setTimeout(r, 750))
  }
  return { bundleId, status: "failed", error: `timeout waiting inflight status (${timeoutMs}ms)` }
}

function sanitizeBlockEngineUrl(raw: string | undefined, region: JitoRegion = DEFAULT_REGION): string {
  const fallback = JITO_ENDPOINTS[region]
  if (!raw) return fallback
  const trimmed = raw.trim()
  const withoutProto = trimmed.replace(/^https?:\/\//, "").replace(/^dns:/, "")
  return withoutProto.replace(/\/+$/, "") || fallback
}

function getBlockEngineEndpoint(region: JitoRegion = DEFAULT_REGION): string {
  const override =
    process.env.JITO_BLOCK_ENGINE_URL ||
    process.env.NEXT_PUBLIC_JITO_BLOCK_ENGINE_URL ||
    process.env.JITO_ENGINE_URL
  return sanitizeBlockEngineUrl(override, region)
}

function parseAuthKeypair(): Keypair {
  const raw = AUTH_KEYPAIR
  if (raw) {
    const value = raw.trim()
    try {
      // JSON array secret key
      if (value.startsWith("[") && value.endsWith("]")) {
        const arr = JSON.parse(value)
        if (Array.isArray(arr)) {
          const key = Uint8Array.from(arr)
          if (key.length === 64) return Keypair.fromSecretKey(key)
          if (key.length === 32) return Keypair.fromSeed(key)
        }
      }
      // base58 secret key
      const decoded = bs58.decode(value)
      if (decoded.length === 64) {
        return Keypair.fromSecretKey(decoded)
      }
      if (decoded.length === 32) {
        return Keypair.fromSeed(decoded)
      }
      console.warn(`JITO auth key length invalid (expected 64 or 32, got ${decoded.length})`)
    } catch (error) {
      console.warn(`Failed to decode JITO_AUTH_KEYPAIR: ${(error as any)?.message || error}`)
      console.warn("Falling back to ephemeral key.")
    }
  }

  const ephemeral = Keypair.generate()
  if (typeof window === "undefined") {
    console.warn("JITO auth keypair not provided, using ephemeral key (bundles may be rate-limited)")
  }
  return ephemeral
}

type RawBundleStatus = {
  bundleId?: string
  bundle_id?: string
  state?: string
  status?: string
  bundleStatus?: string
  bundle_status?: string
  slot?: number
  landedSlot?: number
  landed_slot?: number
  error?: string
  err?: string
  message?: string
}

const searcherCache = new Map<JitoRegion, ReturnType<typeof searcherClient>>()

function getAuthKeypair(): Keypair {
  return parseAuthKeypair()
}

function getSearcher(region: JitoRegion) {
  if (!USE_JITO_SDK) {
    throw new Error("JITO SDK disabled (set JITO_USE_SDK=true to enable)")
  }
  const cached = searcherCache.get(region)
  if (cached) return cached

  const endpoint = getBlockEngineEndpoint(region)

  // Try to use the auth keypair first, if it fails, use ephemeral
  let keypair
  try {
    const decoded = AUTH_KEYPAIR ? bs58.decode(AUTH_KEYPAIR) : new Uint8Array()
    if (decoded.length === 64) {
      keypair = Keypair.fromSecretKey(decoded)
    } else {
      throw new Error("Token is not a valid secret key")
    }
  } catch (error) {
    keypair = Keypair.generate()
  }

  const client = searcherClient(endpoint, keypair)
  searcherCache.set(region, client)
  return client
}

function normalizeStatus(raw: string | undefined): BundleStatus["status"] {
  const value = (raw || "").toLowerCase()
  if (["bundle_status_landed", "landed", "ok", "confirmed"].includes(value)) return "landed"
  if (["bundle_status_failed", "failed", "dropped", "expired", "canceled", "cancelled"].includes(value)) return "failed"
  return "pending"
}

function extractErrorMessage(err: unknown): string {
  if (!err) return "unknown"
  if (typeof err === "string") return err
  if (typeof err === "object" && "message" in err) return (err as any).message || "unknown"
  return "unknown"
}

function toVersioned(tx: Transaction | VersionedTransaction): VersionedTransaction {
  if (tx instanceof VersionedTransaction) return tx
  // VersionedTransaction.deserialize handles legacy serialization by design; reuse signatures
  return VersionedTransaction.deserialize(tx.serialize())
}

/**
 * fetch tip accounts dynamically from jito API
 * falls back to hardcoded list on failure
 */
export async function fetchTipAccounts(region: JitoRegion = DEFAULT_REGION): Promise<string[]> {
  const now = Date.now()
  if (cachedTipAccounts.length && now - lastTipFetch < TIP_CACHE_TTL) return cachedTipAccounts

  // Prefer HTTP getTipAccounts (no auth)
  try {
    const accounts = await getTipAccountsHttp(region)
    cachedTipAccounts = accounts
    lastTipFetch = now
    return cachedTipAccounts
  } catch (err) {
    // ignore
  }

  try {
    const endpoint = JITO_ENDPOINTS[region]
    const searcher = getSearcher(region)
    const result = await searcher.getTipAccounts()
    if (result.ok && result.value.length > 0) {
      cachedTipAccounts = result.value
      lastTipFetch = now
      return cachedTipAccounts
    }
  } catch {
    // fall back
  }

  cachedTipAccounts = JITO_TIP_ACCOUNTS
  lastTipFetch = now
  return cachedTipAccounts
}

/**
 * sync pick from cache/fallback, fire-and-forget refresh
 */
function pickTipAccountSync(region: JitoRegion): PublicKey {
  if (!cachedTipAccounts.length) {
    void fetchTipAccounts(region).catch(() => {})
  }
  const accounts = cachedTipAccounts.length ? cachedTipAccounts : JITO_TIP_ACCOUNTS
  const index = Math.floor(Math.random() * accounts.length)
  return new PublicKey(accounts[index])
}

/**
 * get random tip account (from cache or hardcoded)
 */
export function getRandomTipAccount(region: JitoRegion = DEFAULT_REGION): PublicKey {
  return pickTipAccountSync(region)
}

/**
 * create tip instruction
 */
export function createTipInstruction(
  payer: PublicKey,
  tipAmount: number = DEFAULT_JITO_TIP,
  region: JitoRegion = DEFAULT_REGION
): TransactionInstruction {
  const tipAccount = getRandomTipAccount(region)
  const lamports = Math.max(MIN_JITO_TIP_LAMPORTS, Math.floor(tipAmount * LAMPORTS_PER_SOL))
  
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: tipAccount,
    lamports,
  })
}

/**
 * get tip in lamports (with minimum enforcement)
 */
export function getTipLamports(tipSol: number): number {
  return Math.max(MIN_JITO_TIP_LAMPORTS, Math.floor(tipSol * LAMPORTS_PER_SOL))
}

/**
 * jito bundle status
 */
export interface BundleStatus {
  bundleId: string
  status: "pending" | "landed" | "failed"
  landedSlot?: number
  error?: string
}

/**
 * send bundle to jito block engine
 */
async function sendBundleOnce(
  transactions: (Transaction | VersionedTransaction)[],
  region: JitoRegion
): Promise<{ bundleId: string }> {
  const client = getSearcher(region)
  const versioned = transactions.map(toVersioned)
  const bundle = new Bundle(versioned, BUNDLE_TX_LIMIT)
  const result = await client.sendBundle(bundle)
  if (!result.ok) {
    const message = extractErrorMessage(result.error)
    throw new Error(`jito bundle error: ${message}`)
  }
  const value = result.value as any
  const bundleId = typeof value === "string" ? value : value?.bundleId || value?.bundle_id || ""
  if (!bundleId) {
    throw new Error("jito bundle error: empty bundle id")
  }
  return { bundleId }
}

export async function sendBundle(
  transactions: (Transaction | VersionedTransaction)[],
  region: JitoRegion = DEFAULT_REGION
): Promise<{ bundleId: string; region: JitoRegion }> {
  const regions = [region, ...Object.keys(JITO_ENDPOINTS).filter((r) => r !== region)] as JitoRegion[]
  let lastError: unknown
  for (let attempt = 0; attempt < JITO_BACKOFF.length; attempt++) {
    const target = regions[attempt % regions.length]
    try {
      // PRIMARY: HTTP JSON-RPC sendBundle (no auth required per user)
      return await sendBundleHttpOnce(transactions, target)
    } catch (error) {
      lastError = error

      // SDK fallback is disabled by default; it can require whitelisting.
      if (USE_JITO_SDK) {
        try {
          return await sendBundleOnce(transactions, target)
        } catch (sdkErr) {
          lastError = sdkErr
        }
      }
      const delay = JITO_BACKOFF[attempt]
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error(`jito bundle error after retries: ${extractErrorMessage(lastError)}`)
}

/**
 * get bundle status
 */
export async function getBundleStatus(
  bundleId: string,
  region: JitoRegion = DEFAULT_REGION
): Promise<BundleStatus> {
  const client = getSearcher(region)
  const response = await client.getBundleStatuses([bundleId])

  if (!response.ok) {
    return {
      bundleId,
      status: "failed",
      error: extractErrorMessage(response.error) || "failed to fetch bundle status",
    }
  }

  const entry: RawBundleStatus | undefined = Array.isArray(response.value) ? (response.value as any)[0] : undefined
  const status = normalizeStatus(entry?.state || entry?.status || entry?.bundleStatus || entry?.bundle_status)
  const landedSlot = entry?.landedSlot ?? entry?.landed_slot ?? entry?.slot
  const error = entry?.error || entry?.err || entry?.message

  return {
    bundleId,
    status,
    ...(landedSlot !== undefined ? { landedSlot } : {}),
    ...(error ? { error } : {}),
  }
}

/**
 * wait for bundle confirmation
 */
export async function waitForBundleConfirmation(
  bundleId: string,
  region: JitoRegion = DEFAULT_REGION,
  timeoutMs: number = 30000,
  pollIntervalMs: number = 1000
): Promise<BundleStatus> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    const status = await getBundleStatus(bundleId, region)

    if (status.status === "landed" || status.status === "failed") {
      return status
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }

  return {
    bundleId,
    status: "failed",
    error: "timeout waiting for confirmation",
  }
}

/**
 * send single transaction with jito tip
 */
export async function sendTransactionWithTip(
  transaction: Transaction | VersionedTransaction,
  tipAmount: number = DEFAULT_JITO_TIP,
  region: JitoRegion = DEFAULT_REGION
): Promise<{ bundleId: string }> {
  return sendBundle([transaction], region)
}

/**
 * get tip instruction to add to transaction
 */
export function getTipInstruction(payer: PublicKey, tipLamports: number): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: getRandomTipAccount(),
    lamports: tipLamports,
  })
}

/**
 * estimate jito tip based on priority
 */
export function estimateTip(priority: "low" | "medium" | "high" | "ultra"): number {
  switch (priority) {
    case "low":
      return 0.00005 // 50k lamports
    case "medium":
      return 0.0001 // 100k lamports
    case "high":
      return 0.0005 // 500k lamports
    case "ultra":
      return 0.001 // 1M lamports
    default:
      return 0.0001
  }
}

/**
 * simulate bundle via Jito API (HTTP fallback)
 */
export async function simulateBundle(
  transactions: (Transaction | VersionedTransaction)[],
  region: JitoRegion = DEFAULT_REGION
): Promise<any> {
  // Try HTTP first
  try {
    const url = getBundleApiUrl(region)
    const serialized = transactions.map((tx) => bs58.encode(toVersioned(tx).serialize()))

    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "simulateBundle",
      params: [{ encodedTransactions: serialized }],
    }

    const json = await jsonRpcPost<any>(url, payload)
    if (json.error) {
      throw new Error(`jito simulateBundle error: ${extractErrorMessage(json.error)}`)
    }

    return json.result
      } catch (httpError) {
    console.log("HTTP simulation failed:", httpError.message)
    // Try gRPC fallback only if we have a valid keypair (not ephemeral)
    if (USE_JITO_SDK) {
      try {
        const searcher = getSearcher(region)
        const versioned = transactions.map(toVersioned)
        const bundle = new Bundle(versioned, BUNDLE_TX_LIMIT)

        // Try to send bundle and then check status to simulate
        const sendResult = await searcher.sendBundle(bundle)
        if (!sendResult.ok) {
          throw new Error(`jito grpc sendBundle error: ${extractErrorMessage(sendResult.error)}`)
        }

        const bundleId = sendResult.value

        // Wait a bit and check status to simulate landing
        await new Promise(resolve => setTimeout(resolve, 2000))

        const statusResult = await searcher.getBundleStatuses([bundleId])
        if (!statusResult.ok) {
          throw new Error(`jito grpc getBundleStatuses error: ${extractErrorMessage(statusResult.error)}`)
        }

        const status = statusResult.value[0]

        return {
          bundleId,
          status: status?.status || "unknown",
          landedSlot: status?.landedSlot,
          simulated: true
        }
      } catch (grpcError) {
        console.log("gRPC simulation also failed:", grpcError)
        throw new Error(`both http and grpc simulateBundle failed. http: ${httpError}, grpc: ${grpcError}`)
      }
    }
    console.log("gRPC not enabled, throwing HTTP error")
    throw httpError
  }
}

/**
 * jito client class for managing connections
 */
export class JitoClient {
  private region: JitoRegion
  private tipAmount: number
  
  constructor(region: JitoRegion = DEFAULT_REGION, tipAmount: number = DEFAULT_JITO_TIP) {
    this.region = region
    this.tipAmount = tipAmount
  }
  
  getEndpoint(): string {
    return JITO_ENDPOINTS[this.region]
  }
  
  setRegion(region: JitoRegion): void {
    this.region = region
  }
  
  setTipAmount(amount: number): void {
    this.tipAmount = amount
  }
  
  createTipInstruction(payer: PublicKey): TransactionInstruction {
    return createTipInstruction(payer, this.tipAmount)
  }
  
  async sendBundle(transactions: (Transaction | VersionedTransaction)[]): Promise<{ bundleId: string }> {
    return sendBundle(transactions, this.region)
  }
  
  async getBundleStatus(bundleId: string): Promise<BundleStatus> {
    return getBundleStatus(bundleId, this.region)
  }
  
  async waitForConfirmation(bundleId: string, timeoutMs?: number): Promise<BundleStatus> {
    return waitForBundleConfirmation(bundleId, this.region, timeoutMs)
  }
}

// default client instance
export const jitoClient = new JitoClient()
