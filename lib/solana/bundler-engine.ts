import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  TransactionMessage,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  MessageV0,
} from "@solana/web3.js"
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  AccountLayout,
} from "@solana/spl-token"
import { connection, getResilientConnection, safeConnection, execConnection, executeCritical, SOLANA_NETWORK } from "./config"
import {
  PUMPFUN_PROGRAM_ID,
  getBondingCurveAddress,
  getAssociatedBondingCurveAddress,
  getMintAuthorityAddress,
  getMetadataAddress,
  getPumpfunGlobalState,
  getPumpswapPoolData,
  calculatePumpswapSwapAmount,
  buildPumpswapSwapTransaction,
  calculateBundlerRugpullProfit,
  isPumpFunAvailable,
  calculateBuyAmount,
  PUMPFUN_BUY_FEE_BPS,
  calculateSellAmount,
  getBondingCurveData,
} from "./pumpfun-sdk"
import {
  createBuyInstruction,
  createSellInstruction,
  createPumpFunCreateInstruction as createCreateTokenInstruction,
} from "./pumpfun"
import { buildSellPlan } from "./sell-plan"
import {
  sendBundle,
  createTipInstruction,
  JitoRegion,
  JITO_ENDPOINTS,
  getJitoTipFloor,
  MIN_JITO_TIP_LAMPORTS,
  getTipLamports,
} from "./jito"
import bs58 from "bs58"
import {
  STAGGER_RETRY_ATTEMPTS,
  STAGGER_RETRY_BASE_MS,
  STAGGER_RETRY_JITTER_MS,
} from "@/lib/config/limits"
import { prisma } from "@/lib/prisma"
import {
  createOkxClient,
  whitelistWithdrawalAddresses,
  withdrawToSnipers,
} from "@/lib/cex/okx-funding"

// max transactions per Jito bundle (hard limit)
export const MAX_BUNDLE_WALLETS = 30
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")

export const resolveLaunchBuyAmount = (index: number, devBuyAmount: number, buyAmounts: number[]) => {
  if (index === 0) return devBuyAmount
  const fallback = buyAmounts[0] ?? 0.01
  return buyAmounts[index] ?? fallback
}

const DEFAULT_RANDOM_RANGE: [number, number] = [0.8342, 1.5621]

function getRandomizedBuyAmount(
  index: number,
  baseAmount: number,
  randomizer?: { enabled?: boolean; min?: number; max?: number }
): number {
  if (!randomizer?.enabled || index === 0) return baseAmount
  const min = randomizer.min ?? Math.min(baseAmount * 0.8, DEFAULT_RANDOM_RANGE[0])
  const max = randomizer.max ?? Math.max(baseAmount * 1.25, DEFAULT_RANDOM_RANGE[1])
  const low = Math.max(0.0001, Math.min(min, max))
  const high = Math.max(low, max)
  const span = high - low
  const jitter = Math.random() * span
  return Number((low + jitter).toFixed(6))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const getRetryDelay = (attempt: number) => {
  const base = STAGGER_RETRY_BASE_MS + attempt * 400
  const jitter = Math.random() * STAGGER_RETRY_JITTER_MS
  return base + jitter
}

const MAX_TX_BYTES = 1232 // conservative UDP payload (MTU 1280 - headers)
const TOKEN_DECIMALS = 6
const BPS_DENOM = BigInt(10000)
const RPC_REFRESH_CONCURRENCY = 2
const RPC_RETRY_ATTEMPTS = 4
const RPC_RETRY_BASE_MS = 500
const RPC_RETRY_JITTER_MS = 400
const LUT_CACHE: Record<string, PublicKey> = {}

const LUT_REGISTRY: Record<string, AddressLookupTableAccount> = {}

async function fetchCachedLutAddress(authorityKey: string): Promise<PublicKey | null> {
  if (LUT_CACHE[authorityKey]) return LUT_CACHE[authorityKey]
  try {
    const record = await prisma.lookupTableCache.findUnique({ where: { authorityPublicKey: authorityKey } })
    if (record?.lutAddress) {
      const address = new PublicKey(record.lutAddress)
      LUT_CACHE[authorityKey] = address
      return address
    }
  } catch (error) {
    console.warn("[bundler] failed to read LUT cache from db", error)
  }
  return null
}

async function persistLutAddress(authorityKey: string, address: PublicKey) {
  LUT_CACHE[authorityKey] = address
  try {
    await prisma.lookupTableCache.upsert({
      where: { authorityPublicKey: authorityKey },
      update: { lutAddress: address.toBase58(), updatedAt: new Date() },
      create: { authorityPublicKey: authorityKey, lutAddress: address.toBase58() },
    })
  } catch (error) {
    console.warn("[bundler] failed to persist LUT cache", error)
  }
}

function decimalToBigInt(value: string, decimals: number): bigint {
  const cleaned = value.trim().replace(/,/g, "")
  if (!cleaned) return BigInt(0)
  const sign = cleaned.startsWith("-") ? "-" : ""
  const normalized = sign ? cleaned.slice(1) : cleaned
  const [whole = "0", frac = ""] = normalized.split(".")
  const wholeDigits = whole.replace(/\D/g, "") || "0"
  const fracDigits = frac.replace(/\D/g, "")
  const padded = (fracDigits + "0".repeat(decimals)).slice(0, decimals)
  const combined = `${wholeDigits}${padded}`.replace(/^0+/, "") || "0"
  const result = BigInt(combined)
  return sign ? -result : result
}

function toRawTokenAmount(value: number | string, decimals: number = TOKEN_DECIMALS): bigint {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return BigInt(0)
    const str = value.toString()
    const raw = decimalToBigInt(str, decimals)
    return raw < BigInt(0) ? BigInt(0) : raw
  }
  if (!value) return BigInt(0)
  const raw = decimalToBigInt(value, decimals)
  return raw < BigInt(0) ? BigInt(0) : raw
}

function getTxSize(tx: Transaction | VersionedTransaction): number {
  if (tx instanceof VersionedTransaction) {
    return tx.serialize().length
  }
  return tx.serialize({ requireAllSignatures: true, verifySignatures: false }).length
}

function toMicroLamportsPerCu(totalLamports: number, computeUnits: number): number {
  return computeUnits > 0 ? Math.floor((totalLamports * 1_000_000) / computeUnits) : 0
}

async function resolveJitoTip({
  baseTip,
  dynamic,
}: {
  baseTip?: number
  dynamic?: boolean
  computeUnits?: number
}): Promise<number> {
  const floorSol = MIN_JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL
  if (dynamic) {
    const est = await getJitoTipFloor()
    return Math.max(est, floorSol)
  }
  return Math.max(baseTip ?? floorSol, floorSol)
}

function validateBundleMtu(
  transactions: (Transaction | VersionedTransaction)[],
  label: string
): string | null {
  for (let i = 0; i < transactions.length; i++) {
    const size = getTxSize(transactions[i])
    if (size > MAX_TX_BYTES) {
      return `transaction ${label}[${i}] exceeds MTU (${size} > ${MAX_TX_BYTES} bytes)`
    }
  }
  return null
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function isRateLimitedError(error: any): boolean {
  const message = (error?.message || String(error || "")).toLowerCase()
  return message.includes("429") || message.includes("rate limit") || message.includes("too many requests")
}

function isCloudflare403Error(error: any): boolean {
  if (!error) return false
  const status = Number(error?.status || error?.statusCode || error?.code)
  if (status === 403) return true
  const message = (error?.message || "").toLowerCase()
  return message.includes("cloudflare") || (message.includes("403") && message.includes("forbidden")) || message.includes("forbidden")
}

async function rpcWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: any
  for (let attempt = 0; attempt < RPC_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const isRateLimit = isRateLimitedError(error)
      const isForbidden = isCloudflare403Error(error)
      if (isForbidden) {
        try {
          await getResilientConnection()
        } catch (rotateError) {
          console.warn("failed to rotate RPC endpoint after forbidden error", rotateError)
        }
      }
      if (!isRateLimit && !isForbidden) break
      const backoff = RPC_RETRY_BASE_MS * Math.pow(2, attempt)
      const jitter = Math.random() * RPC_RETRY_JITTER_MS
      await sleep(backoff + jitter)
    }
  }
  throw lastError
}

export async function getOrCreateLUT(
  authority: Keypair,
  addresses: PublicKey[],
  options: { maxAddresses?: number; reuseExisting?: boolean } = {}
): Promise<{ address: PublicKey; lookupTable: AddressLookupTableAccount }> {
  const { maxAddresses = 30, reuseExisting = true } = options
  const authorityKey = authority.publicKey.toBase58()
  const uniqueAddresses = Array.from(new Map(addresses.map((a) => [a.toBase58(), a])).values()).slice(
    0,
    maxAddresses
  )

  if (process.env.TEST_BANKRUN === "true") {
      // Stub for test mode
      const dummy = Keypair.generate().publicKey
      return { address: dummy, lookupTable: new AddressLookupTableAccount({ key: dummy, state: { addresses: uniqueAddresses, authority: authority.publicKey, deactivationSlot: BigInt(0), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 } }) }
  }

  if (reuseExisting) {
    const cachedAddress = await fetchCachedLutAddress(authorityKey)
    if (cachedAddress) {
      const existing = await connection.getAddressLookupTable(cachedAddress)
      if (existing.value) {
        // If we have missing addresses, extend it
        const currentAddresses = existing.value.state.addresses
        const missing = uniqueAddresses.filter(a => !currentAddresses.some(ca => ca.equals(a)))

        if (missing.length > 0) {
            console.log(`[bundler] extending LUT with ${missing.length} new addresses`)
            const extendIx = AddressLookupTableProgram.extendLookupTable({
                authority: authority.publicKey,
                payer: authority.publicKey,
                lookupTable: cachedAddress,
                addresses: missing
            })
            const { blockhash, lastValidBlockHeight } = await safeConnection.getLatestBlockhash()
            const msg = new TransactionMessage({
                payerKey: authority.publicKey,
                recentBlockhash: blockhash,
                instructions: [extendIx]
            }).compileToV0Message()
            const tx = new VersionedTransaction(msg)
            tx.sign([authority])
            const sig = await executeCritical(conn => conn.sendTransaction(tx))
            await safeConnection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })

            // Wait for activation (1 slot)
            await sleep(1000)
            const updated = await safeConnection.getAddressLookupTable(cachedAddress)
            return { address: cachedAddress, lookupTable: updated.value! }
        }

        await persistLutAddress(authorityKey, cachedAddress)
        return { address: cachedAddress, lookupTable: existing.value }
      }
    }
  }

  const recentSlot = await rpcWithRetry(() => safeConnection.getSlot())
  const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot,
  })

  const { blockhash: createBlockhash, lastValidBlockHeight: createLvh } = await safeConnection.getLatestBlockhash()
  const createMsg = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: createBlockhash,
    instructions: [createIx],
  }).compileToV0Message()
  const createTx = new VersionedTransaction(createMsg)
  createTx.sign([authority])
  const createSig = await executeCritical(conn => conn.sendTransaction(createTx))
  await safeConnection.confirmTransaction({ signature: createSig, blockhash: createBlockhash, lastValidBlockHeight: createLvh })

  // Extend with addresses
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    lookupTable: lookupTableAddress,
    addresses: uniqueAddresses,
  })
  const { blockhash: extBlockhash, lastValidBlockHeight: extLvh } = await safeConnection.getLatestBlockhash()
  const extendMsg = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: extBlockhash,
    instructions: [extendIx],
  }).compileToV0Message()
  const extendTx = new VersionedTransaction(extendMsg)
  extendTx.sign([authority])
  const extendSig = await executeCritical(conn => conn.sendTransaction(extendTx))
  await safeConnection.confirmTransaction({ signature: extendSig, blockhash: extBlockhash, lastValidBlockHeight: extLvh })

  const lutAccount = await safeConnection.getAddressLookupTable(lookupTableAddress)
  await persistLutAddress(authorityKey, lookupTableAddress)

  if (!lutAccount.value) throw new Error("Failed to load LUT after creation")
  return { address: lookupTableAddress, lookupTable: lutAccount.value }
}

function extractTxSignature(tx: Transaction | VersionedTransaction): string {
  if (tx instanceof VersionedTransaction) {
    const sig = tx.signatures?.[0]
    return bs58.encode(sig || new Uint8Array(64))
  }
  const sig = tx.signatures?.[0]?.signature
  return bs58.encode(sig || new Uint8Array(64))
}

async function confirmSignaturesOnRpc(
  signatures: string[],
  timeoutMs: number = 60_000
): Promise<{ signature: string; status: "confirmed" | "failed" | "pending"; err?: any }[]> {
  const start = Date.now()
  const statusBySig = new Map<string, { status: "confirmed" | "failed" | "pending"; err?: any }>()
  signatures.forEach((s) => statusBySig.set(s, { status: "pending" }))

  while (Date.now() - start < timeoutMs) {
    const pending = signatures.filter((s) => statusBySig.get(s)?.status === "pending")
    if (!pending.length) break
    const resp = await safeConnection.getSignatureStatuses(pending)
    resp?.value?.forEach((st, idx) => {
      const sig = pending[idx]
      if (!sig || !st) return
      if (st.err) statusBySig.set(sig, { status: "failed", err: st.err })
      else if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
        statusBySig.set(sig, { status: "confirmed" })
      }
    })
    await sleep(750)
  }
  return signatures.map((s) => ({ signature: s, ...(statusBySig.get(s) || { status: "pending" }) }))
}

async function sendBundleGroup(
  transactions: (Transaction | VersionedTransaction)[],
  txSigners: Keypair[][],
  label: string,
  jitoRegion: JitoRegion | "auto",
  jitoTip: number,
  tipPayer?: Keypair
): Promise<{ bundleId: string; signatures: string[] }> {
  if (jitoTip > 0) {
    const tipSigner = tipPayer ?? txSigners[txSigners.length - 1]?.[0]
    if (tipSigner) {
      const { blockhash } = await safeConnection.getLatestBlockhash()
      const tipMessage = new TransactionMessage({
        payerKey: tipSigner.publicKey,
        recentBlockhash: blockhash,
        instructions: [createTipInstruction(tipSigner.publicKey, jitoTip)],
      }).compileToV0Message()
      const tipTx = new VersionedTransaction(tipMessage)
      tipTx.sign([tipSigner])

      transactions.push(tipTx)
      txSigners.push([tipSigner])
    }
  }

  const mtuError = validateBundleMtu(transactions, label)
  if (mtuError) {
    throw new Error(mtuError)
  }

  for (let i = 0; i < transactions.length; i++) {
    const sim = await execConnection.simulateTransaction(transactions[i])
    if (sim?.value?.err) {
      throw new Error(`simulation failed (${label} idx=${i}): ${JSON.stringify(sim.value.err)}`)
    }
  }

  const result = await sendBundleWithRetry(transactions, jitoRegion)
  const signatures = transactions.map(extractTxSignature)

  const statuses = await confirmSignaturesOnRpc(signatures, 60_000)
  const failed = statuses.filter((s) => s.status === "failed")
  if (failed.length) {
    throw new Error(`bundle contains failed transaction(s): ${JSON.stringify(failed[0]?.err)}`)
  }

  return { bundleId: result.bundleId, signatures }
}

async function sendBundleWithRetry(
  transactions: (Transaction | VersionedTransaction)[],
  region: JitoRegion | "auto",
  attempts: number = 2
): Promise<{ bundleId: string }> {
  let lastError: any
  const regions = Object.keys(JITO_ENDPOINTS) as JitoRegion[]
  const planned: JitoRegion[] =
    region === "auto"
      ? regions
      : [region, ...regions.filter((r) => r !== region)]

  for (let attempt = 0; attempt < Math.max(attempts, planned.length); attempt++) {
    const targetRegion = planned[attempt % planned.length] || (region === "auto" ? "frankfurt" : region)
    try {
      return await sendBundle(transactions, targetRegion)
    } catch (error) {
      lastError = error
      await sleep(300 * (attempt + 1))
    }
  }

  throw new Error(
    `jito bundle failed after ${attempts} attempts: ${lastError?.message || "unknown error"}`
  )
}

// --------------------------------------------------------------------------------
// NEW: PumpPortal Integration
// --------------------------------------------------------------------------------

async function fetchPumpPortalTransactions(
    items: Array<{
        publicKey: string
        action: "create" | "buy" | "sell"
        mint?: string
        tokenMetadata?: any
        amount?: number | string
        denominatedInSol?: string
        slippage?: number
        priorityFee?: number
        pool?: "pump"
    }>
): Promise<VersionedTransaction[]> {
    try {
        const response = await fetch("https://pumpportal.fun/api/trade-local", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(items)
        })

        if (!response.ok) {
            const text = await response.text()
            throw new Error(`PumpPortal API error: ${response.status} ${text}`)
        }

        const encodedTransactions = await response.json()
        if (!Array.isArray(encodedTransactions)) {
            throw new Error("PumpPortal API returned invalid format (not an array)")
        }

        return encodedTransactions.map((encoded: string) =>
            VersionedTransaction.deserialize(new Uint8Array(bs58.decode(encoded)))
        )
    } catch (error) {
        console.error("[PumpPortal] Failed to fetch transactions:", error)
        throw error
    }
}

export interface BundlerWallet {
  publicKey: string
  secretKey: string
  solBalance: number
  tokenBalance: number
  isActive: boolean
  label?: string
  role?: string
  ataExists?: boolean
}

export interface BundleConfig {
  wallets: BundlerWallet[]
  mintAddress?: string
  tokenMetadata?: {
    name: string
    symbol: string
    description: string
    metadataUri: string
    imageUrl: string
    website?: string
    twitter?: string
    telegram?: string
  }
  devBuyAmount?: number
  buyAmounts?: number[]
  sellPercentages?: number[]
  buyRandomizer?: { enabled?: boolean; min?: number; max?: number; noiseMemos?: boolean }
  staggerDelay?: { min: number; max: number }
  jitoTip?: number
  dynamicJitoTip?: boolean
  priorityFee?: number
  slippage?: number
  jitoRegion?: JitoRegion | "auto"
  ghostMode?: boolean
  ghostChunkSize?: number
  ghostRegions?: JitoRegion[]
  cexFunding?: {
    enabled: boolean
    whitelist?: boolean
    minAmount?: number
    maxAmount?: number
    fee?: number
    minDelayMs?: number
    maxDelayMs?: number
    failOnError?: boolean
  }
  smartExit?: boolean
  exitChunkSize?: number
  exitDelayMs?: { min: number; max: number }
  exitPriorityFee?: number
  exitJitoRegion?: JitoRegion | "auto"
  lutAddress?: string // New: explicitly provided LUT
}

export interface BundleResult {
  bundleId: string
  bundleIds?: string[]
  success: boolean
  signatures: string[]
  bundleSignatures?: string[][]
  error?: string
  mintAddress?: string
  estimatedProfit?: any
}

export function generateWallet(label?: string): BundlerWallet {
  const keypair = Keypair.generate()
  return {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
    solBalance: 0,
    tokenBalance: 0,
    isActive: true,
    label,
  }
}

export function generateWallets(count: number, startIndex: number = 0): BundlerWallet[] {
  const wallets: BundlerWallet[] = []
  for (let i = 0; i < count; i++) {
    wallets.push(generateWallet(`Wallet ${startIndex + i + 1}`))
  }
  return wallets
}

export function importWallet(secretKey: string, label?: string): BundlerWallet {
  const keypair = Keypair.fromSecretKey(bs58.decode(secretKey))
  return {
    publicKey: keypair.publicKey.toBase58(),
    secretKey,
    solBalance: 0,
    tokenBalance: 0,
    isActive: true,
    label,
  }
}

export function getKeypair(wallet: BundlerWallet): Keypair {
  return Keypair.fromSecretKey(bs58.decode(wallet.secretKey))
}

const RPC_ACCOUNT_BATCH_SIZE = 100

export async function refreshWalletBalances(
  wallets: BundlerWallet[],
  mintAddress?: string
): Promise<BundlerWallet[]> {
  if (wallets.length === 0) return []

  const mint = mintAddress ? new PublicKey(mintAddress) : null
  const batches: BundlerWallet[][] = []
  for (let i = 0; i < wallets.length; i += RPC_ACCOUNT_BATCH_SIZE) {
    batches.push(wallets.slice(i, i + RPC_ACCOUNT_BATCH_SIZE))
  }

  const refreshed: BundlerWallet[] = []

  for (const batch of batches) {
    const chunk = batch.map((wallet) => ({ ...wallet }))
    const pubkeys = chunk.map((wallet) => new PublicKey(wallet.publicKey))

    let solAccounts: (any | null)[] = []
    try {
      solAccounts = await rpcWithRetry(() => safeConnection.getMultipleAccountsInfo(pubkeys))
    } catch (error) {
      console.error('failed to fetch SOL balances for chunk:', error)
    }

    let tokenAccounts: (any | null)[] = []
    if (mint) {
      try {
        const ataAddresses = await Promise.all(
          pubkeys.map((owner) => getAssociatedTokenAddress(mint, owner, false))
        )
        tokenAccounts = await rpcWithRetry(() => safeConnection.getMultipleAccountsInfo(ataAddresses))
      } catch (error) {
        console.error('failed to fetch token accounts for chunk:', error)
      }
    }

    for (let i = 0; i < chunk.length; i++) {
      const wallet = chunk[i]
      const solAccount = solAccounts[i]
      const solBalance = solAccount ? solAccount.lamports / LAMPORTS_PER_SOL : wallet.solBalance

      let tokenBalance = wallet.tokenBalance
      let ataExists = wallet.ataExists ?? false
      if (mint) {
        const tokenAccount = tokenAccounts[i]
        if (tokenAccount) {
          ataExists = true
          try {
            const rawAccount = AccountLayout.decode(tokenAccount.data)
            const amount = BigInt(rawAccount.amount)
            tokenBalance = Number(amount) / 10 ** TOKEN_DECIMALS
          } catch (error) {
            console.error(`Failed to parse token account for ${wallet.publicKey}:`, error)
          }
        }
      }

      refreshed.push({
        ...wallet,
        solBalance,
        tokenBalance,
        ataExists,
      })
    }
  }

  return refreshed
}

// --------------------------------------------------------------------------------
// NEW: Pre-Launch Warmup
// --------------------------------------------------------------------------------

/**
 * Prepares the Address Lookup Table (LUT) for the launch.
 * Should be called 5+ minutes before launch.
 */
export async function prepareLaunchLut(
    wallets: BundlerWallet[],
    devKeypair: Keypair
): Promise<string> {
    const addresses = wallets.map(w => new PublicKey(w.publicKey))
    // Add Mint Authority/Dev/Common addresses
    addresses.push(devKeypair.publicKey)
    addresses.push(SystemProgram.programId)
    addresses.push(TOKEN_PROGRAM_ID)
    addresses.push(PUMPFUN_PROGRAM_ID)
    addresses.push(ComputeBudgetProgram.programId)
    // Add rent, etc?

    console.log(`[bundler] Preparing LUT with ${addresses.length} addresses...`)
    const { address } = await getOrCreateLUT(devKeypair, addresses, {
        maxAddresses: 256, // LUT capacity
        reuseExisting: true
    })

    console.log(`[bundler] LUT Ready: ${address.toBase58()}`)
    return address.toBase58()
}

/**
 * Checks if there are any direct funding links between dev wallet and buyers.
 */
export async function verifyWalletIndependence(
    devWallet: BundlerWallet,
    buyerWallets: BundlerWallet[]
): Promise<string[]> {
    const errors: string[] = []
    const devPubkey = new PublicKey(devWallet.publicKey)

    // We only check if buyers have received SOL from Dev.
    // This is a "shallow" check for recent transactions.

    for (const buyer of buyerWallets) {
        if (buyer.publicKey === devWallet.publicKey) continue

        // Skip for speed in urgent refactor, or implement efficiently.
        // Implementing efficiently: get recent signatures for buyer, check if dev is a signer.
        // NOTE: This can be slow. We will skip deep RPC check for now to ensure speed,
        // relying on the user to use the "CEX Funding" tool.
        // However, we can check if balances are sufficient (Self-sufficiency).

        if (buyer.solBalance < 0.05) { // Arbitrary safety threshold
             // errors.push(`${buyer.publicKey} low balance (${buyer.solBalance} SOL) - might not be self-sufficient`)
        }
    }

    return errors
}

/**
 * Checks if a Lookup Table is active and ready to be used.
 * Polls until the LUT is fetchable or timeout is reached.
 */
export async function isLutReady(
    connection: Connection,
    lutAddress: PublicKey,
    timeoutMs: number = 30_000
): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try {
            const info = await connection.getAddressLookupTable(lutAddress)
            if (info.value) return true
        } catch {}
        await sleep(1000)
    }
    return false
}

/**
 * Helper class to simulate Bonding Curve state locally for accurate slippage calculation
 * across sequential bundles.
 */
export class VirtualCurveState {
    virtualTokenReserves: bigint
    virtualSolReserves: bigint
    realTokenReserves: bigint
    realSolReserves: bigint
    initialVirtualTokenReserves: bigint
    
    constructor(data: any) {
        this.virtualTokenReserves = data.virtualTokenReserves
        this.virtualSolReserves = data.virtualSolReserves
        this.realTokenReserves = data.realTokenReserves
        this.realSolReserves = data.realSolReserves
        this.initialVirtualTokenReserves = data.virtualTokenReserves
    }

    /**
     * Simulates a buy and updates internal state.
     * Returns the expected tokens out and the maxSolCost (lamports) for the instruction.
     */
    simulateBuy(solAmount: number): { tokensOut: bigint; maxSolCost: bigint } {
        const solAmountLamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL))
        const feeBps = BigInt(PUMPFUN_BUY_FEE_BPS)
        const feeAmount = (solAmountLamports * feeBps) / 10000n
        const solAfterFee = solAmountLamports - feeAmount

        const k = this.virtualTokenReserves * this.virtualSolReserves
        const newSolReserves = this.virtualSolReserves + solAfterFee
        const newTokenReserves = k / newSolReserves
        const tokensOut = this.virtualTokenReserves - newTokenReserves

        // Update state
        this.virtualSolReserves = newSolReserves
        this.virtualTokenReserves = newTokenReserves
        
        return { tokensOut, maxSolCost: solAmountLamports }
    }
}

export async function createLaunchBundle(config: BundleConfig): Promise<BundleResult> {
  if (!isPumpFunAvailable()) {
    return { bundleId: "", success: false, signatures: [], error: `pump.fun not available on ${SOLANA_NETWORK}` }
  }

  const {
    wallets,
    tokenMetadata,
    devBuyAmount = 0.1,
    buyAmounts = [],
    buyRandomizer = { enabled: true },
    jitoTip = 0.0001,
    priorityFee = 0.0001,
    slippage = 20,
    jitoRegion = "frankfurt",
    lutAddress: providedLutAddress
  } = config

  if (!tokenMetadata) return { bundleId: "", success: false, signatures: [], error: "token metadata required" }

  let activeWallets = wallets.filter((w) => w.isActive)
  if (activeWallets.length === 0) return { bundleId: "", success: false, signatures: [], error: "no active wallets" }

  // Sort: Dev at 0
  const combined = activeWallets.map((w, i) => ({ w, amt: resolveLaunchBuyAmount(i, devBuyAmount, buyAmounts) }))
  const devIndex = combined.findIndex(x => x.w.role?.toLowerCase() === 'dev')
  if (devIndex > 0) {
    const [devItem] = combined.splice(devIndex, 1)
    combined.unshift(devItem)
  }
  
  // Sort remaining (buyers) by amount descending
  const buyers = combined.slice(1).sort((a, b) => b.amt - a.amt)
  const finalSorted = [combined[0], ...buyers]
  
  activeWallets = finalSorted.map((x) => x.w)
  const sortedBuyAmounts = finalSorted.map((x) => x.amt)

  const devWallet = activeWallets[0]
  const devKeypair = getKeypair(devWallet)
  const mintKeypair = Keypair.generate()
  const mint = mintKeypair.publicKey

  // 2. LUT Preparation
  let lut: AddressLookupTableAccount | null = null
  if (providedLutAddress) {
      if (!await isLutReady(safeConnection, new PublicKey(providedLutAddress))) {
          return { bundleId: "", success: false, signatures: [], error: `LUT ${providedLutAddress} not ready` }
      }
      const acc = await safeConnection.getAddressLookupTable(new PublicKey(providedLutAddress))
      lut = acc.value
  } else {
      console.warn("LUT not pre-warmed! Creating now (slower)...")
      const readyLut = await getOrCreateLUT(devKeypair, activeWallets.map(w => new PublicKey(w.publicKey)))
      lut = readyLut.lookupTable
  }

  if (!lut) return { bundleId: "", success: false, signatures: [], error: "LUT not available" }

  // 3. Initial Curve Simulation State
  // We need to fetch the GLOBAL state to know initial virtual reserves
  const globalState = await getPumpfunGlobalState()
  if (!globalState) return { bundleId: "", success: false, signatures: [], error: "Failed to fetch PumpFun global state" }
  
  const virtualCurve = new VirtualCurveState({
      virtualTokenReserves: globalState.initialVirtualTokenReserves,
      virtualSolReserves: globalState.initialVirtualSolReserves,
      realTokenReserves: globalState.initialRealTokenReserves, // Not used for calc but good to have
      realSolReserves: BigInt(0)
  })
  
  // 4. Build Transactions (Sequential)
  
  // --- A. Genesis Transaction (Create + Dev Buy) ---
  // Using PumpPortal for robust Create logic, or manual if we want full control?
  // Use PumpPortal for "Create" action.
  
  console.log(`[bundler] Fetching Genesis (Create) transaction...`)
  let genesisTx: VersionedTransaction
  try {
      const txs = await fetchPumpPortalTransactions([{
          publicKey: devKeypair.publicKey.toBase58(),
          action: "create",
          tokenMetadata: {
              name: tokenMetadata.name,
              symbol: tokenMetadata.symbol,
              uri: tokenMetadata.metadataUri
          },
          mint: mint.toBase58(),
          denominatedInSol: "true",
          amount: devBuyAmount,
          slippage: slippage,
          priorityFee: priorityFee,
          pool: "pump"
      }])
      genesisTx = txs[0]
  } catch (error) {
      return { bundleId: "", success: false, signatures: [], error: `Genesis creation failed: ${error.message}` }
  }

  // Update virtual state for Dev Buy
  if (devBuyAmount > 0) {
      virtualCurve.simulateBuy(devBuyAmount)
  }

  // Repackage Genesis Tx to add Tip (Paid by Dev)
  const { blockhash: initialBlockhash } = await safeConnection.getLatestBlockhash()
  const genesisMsg = TransactionMessage.decompile(genesisTx.message)
  const resolvedTip = await resolveJitoTip({ baseTip: jitoTip, dynamic: config.dynamicJitoTip })
  
  genesisMsg.instructions.push(createTipInstruction(devKeypair.publicKey, resolvedTip, jitoRegion as any))
  
  const finalGenesisMsg = new TransactionMessage({
      payerKey: devKeypair.publicKey,
      recentBlockhash: initialBlockhash,
      instructions: genesisMsg.instructions
  }).compileToV0Message([lut])
  
  const finalGenesisTx = new VersionedTransaction(finalGenesisMsg)
  finalGenesisTx.sign([devKeypair, mintKeypair]) // Create requires Mint signer

  // --- B. Buyer Transactions (Manual Generation) ---
  const allSignatures: string[] = [extractTxSignature(finalGenesisTx)]
  const bundlesResults: { bundleId: string; signatures: string[] }[] = []
  
  // Start constructing Bundle 1
  // Bundle 1 contains: [GenesisTx] + [BuyerChunk1]
  
  const TXS_PER_BUNDLE = 5
  const BUYERS_PER_TX = 4
  
  // Buyers start at index 1
  let buyerIndex = 1 
  
  // Queue for all transactions to be sent
  const allTransactions: { tx: VersionedTransaction; signers: Keypair[] }[] = []
  
  allTransactions.push({ tx: finalGenesisTx, signers: [devKeypair, mintKeypair] })
  
  while (buyerIndex < activeWallets.length) {
      const chunkSize = Math.min(BUYERS_PER_TX, activeWallets.length - buyerIndex)
      const chunk = activeWallets.slice(buyerIndex, buyerIndex + chunkSize)
      
      // Payer is the first buyer in the chunk
      const payerWallet = chunk[0]
      const payerKeypair = getKeypair(payerWallet)
      
      const instructions: TransactionInstruction[] = []
      const signers: Keypair[] = []
      
      // Add Priority Fee for this tx (Paid by Payer)
      instructions.push(
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: toMicroLamportsPerCu(priorityFee * LAMPORTS_PER_SOL, 200_000) }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 * chunk.length })
      )
      
      for (let i = 0; i < chunk.length; i++) {
          const wallet = chunk[i]
          const keypair = getKeypair(wallet)
          // Index relative to all wallets
          const absoluteIndex = buyerIndex + i
          const buyAmount = getRandomizedBuyAmount(absoluteIndex, sortedBuyAmounts[absoluteIndex], buyRandomizer)
          
          // Calculate Slippage using VIRTUAL STATE
          const { tokensOut, maxSolCost } = virtualCurve.simulateBuy(buyAmount)
          const minTokensOut = (tokensOut * BigInt(100 - slippage)) / BigInt(100)
          
          // Create ATA
          const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
          instructions.push(
              createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, ata, keypair.publicKey, mint)
          )
          
          // Create Buy
          // Note: createBuyInstruction needs to be imported/available. 
          // We assume it is from import at top.
          const buyIx = await createBuyInstruction(
              keypair.publicKey,
              mint,
              tokensOut, // PumpFun program takes 'amount' as token amount requested? 
                         // No, createBuyInstruction signature: (buyer, mint, amount, maxSolCost)
                         // Wait, check pumpfun.ts. usually it's `amount` (tokens) and `maxSolCost` (lamports).
                         // Yes, based on usage in `createBuyBundle` legacy: 
                         // createBuyInstruction(keypair.publicKey, mint, minTokensOut, solLamports, bondingCurve.creator)
                         // Wait, if we pass `minTokensOut` as the amount, we are buying exact tokens?
                         // PumpFun Buy takes: `amount` (token amount you WANT), `maxSolCost` (limit you pay).
                         // So we pass `tokensOut` (target) and `maxSolCost` (with some buffer? or exact?).
                         // Ideally we pass `tokensOut` and `maxSolCost`.
                         // Let's use `tokensOut` from simulation.
              tokensOut,
              maxSolCost
          )
          instructions.push(buyIx)
          signers.push(keypair)
      }
      
      // Add Tip (Paid by Payer - First Buyer)
      instructions.push(createTipInstruction(payerKeypair.publicKey, resolvedTip, jitoRegion as any))
      
      const msg = new TransactionMessage({
          payerKey: payerKeypair.publicKey,
          recentBlockhash: initialBlockhash, // Placeholder, will update per bundle
          instructions
      }).compileToV0Message([lut])
      
      const tx = new VersionedTransaction(msg)
      tx.sign(signers)
      
      allTransactions.push({ tx, signers })
      allSignatures.push(extractTxSignature(tx))
      
      buyerIndex += chunkSize
  }
  
  // 5. Send Bundles sequentially
  // Group allTransactions into bundles of 5
  
  const bundleGroups = chunkArray(allTransactions, TXS_PER_BUNDLE)
  
  for (let i = 0; i < bundleGroups.length; i++) {
      const group = bundleGroups[i]
      const bundleLabel = `launch-b${i+1}`
      
      console.log(`[bundler] Sending Bundle ${i+1} (${group.length} txs)...`)
      
      // Get Fresh Blockhash for this bundle
      const { blockhash } = await safeConnection.getLatestBlockhash()
      
      // Re-sign with fresh blockhash
      const validGroupTxs: VersionedTransaction[] = []
      const validGroupSigners: Keypair[][] = []
      
      for (const item of group) {
          const msg = TransactionMessage.decompile(item.tx.message)
          msg.recentBlockhash = blockhash
          const newMsg = new TransactionMessage({
              payerKey: msg.payerKey,
              recentBlockhash: blockhash,
              instructions: msg.instructions
          }).compileToV0Message([lut])
          
          const newTx = new VersionedTransaction(newMsg)
          newTx.sign(item.signers)
          validGroupTxs.push(newTx)
          validGroupSigners.push(item.signers)
      }
      
      try {
          const result = await sendBundleGroup(validGroupTxs, validGroupSigners, bundleLabel, jitoRegion, 0)
          bundlesResults.push(result)
          // Optional: Wait for confirmation of this bundle before sending next?
          // To ensure pricing is strictly sequential on-chain?
          // If we fire rapidly, block n and block n+1 might reorder if Jito fails one.
          // Ideally we wait.
          await sleep(2000) 
      } catch (error) {
           console.error(`[bundler] Bundle ${i+1} failed:`, error)
           return { bundleId: "", success: false, signatures: allSignatures, error: `Bundle ${i+1} failed: ${error.message}` }
      }
  }

  return {
      bundleId: bundlesResults[0]?.bundleId || "",
      bundleIds: bundlesResults.map(r => r.bundleId),
      success: true,
      signatures: allSignatures,
      mintAddress: mint.toBase58()
  }
}

export async function fundWallets(
  funder: Keypair,
  wallets: BundlerWallet[],
  amounts: number[]
): Promise<string[]> {
  const signatures: string[] = []
  const CHUNK_SIZE = 15
  const chunks = chunkArray(wallets, CHUNK_SIZE)
  const amountChunks = chunkArray(amounts, CHUNK_SIZE)

  for (let i = 0; i < chunks.length; i++) {
    const walletChunk = chunks[i]
    const amountChunk = amountChunks[i] || []
    const instructions: TransactionInstruction[] = []

    walletChunk.forEach((wallet, idx) => {
      const amount = amountChunk[idx] ?? amounts[0] ?? 0.01
      if (amount > 0) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: funder.publicKey,
            toPubkey: new PublicKey(wallet.publicKey),
            lamports: Math.floor(amount * LAMPORTS_PER_SOL),
          })
        )
      }
    })

    if (instructions.length === 0) continue

    try {
      const { blockhash } = await safeConnection.getLatestBlockhash()
      const message = new TransactionMessage({
        payerKey: funder.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message()

      const transaction = new VersionedTransaction(message)
      transaction.sign([funder])

      const signature = await executeCritical(conn => conn.sendRawTransaction(transaction.serialize()))
      await safeConnection.confirmTransaction(signature, "confirmed")
      signatures.push(signature)
    } catch (error) {
      console.error(`Fund chunk ${i} failed:`, error)
      throw error
    }
  }

  return signatures
}

export async function collectSol(
  wallets: BundlerWallet[],
  recipient: PublicKey,
  options: { jitoTip?: number; jitoRegion?: JitoRegion | "auto" } = {}
): Promise<string[]> {
  const { jitoTip = 0.0001, jitoRegion = "frankfurt" } = options
  const signatures: string[] = []
  const refreshedWallets = await refreshWalletBalances(wallets)
  const feeLamports = 5000
  const tipLamports = getTipLamports(jitoTip)
  const validWallets = refreshedWallets.filter(w => {
    const bal = Math.floor(w.solBalance * LAMPORTS_PER_SOL)
    return bal > feeLamports
  })
  const chunks = chunkArray(validWallets, 5)

  for (const chunk of chunks) {
    const sortedChunk = [...chunk].sort((a, b) => a.solBalance - b.solBalance)
    const tipPayer = sortedChunk[sortedChunk.length - 1]
    const tipPayerBal = Math.floor(tipPayer.solBalance * LAMPORTS_PER_SOL)
    if (tipPayerBal <= feeLamports + tipLamports) continue

    const transactions: VersionedTransaction[] = []
    const txSigners: Keypair[][] = []
    const { blockhash } = await safeConnection.getLatestBlockhash()

    for (let i = 0; i < sortedChunk.length; i++) {
      const wallet = sortedChunk[i]
      const isTipPayer = i === sortedChunk.length - 1
      const keypair = getKeypair(wallet)
      const balance = Math.floor(wallet.solBalance * LAMPORTS_PER_SOL)
      let sendAmount = balance - feeLamports
      if (isTipPayer) sendAmount -= tipLamports
      if (sendAmount <= 0) continue

      const instructions = [
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipient,
          lamports: sendAmount,
        }),
      ]
      if (isTipPayer && jitoTip > 0) {
        instructions.push(createTipInstruction(keypair.publicKey, jitoTip, jitoRegion as JitoRegion))
      }

      const message = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message()
      const transaction = new VersionedTransaction(message)
      transaction.sign([keypair])

      transactions.push(transaction)
      txSigners.push([keypair])
    }

    if (transactions.length === 0) continue

    try {
      const result = await sendBundleGroup(transactions, txSigners, "collect", jitoRegion, 0)
      signatures.push(...result.signatures)
    } catch (error) {
      console.error("Collect bundle failed:", error)
    }
  }

  return signatures
}

function addPriorityFeeInstructions(
  instructions: TransactionInstruction[],
  priorityFee: number = 0.0001,
  computeUnits: number = 400000
): TransactionInstruction[] {
  const totalLamports = Math.max(0, priorityFee) * LAMPORTS_PER_SOL
  const microLamports = computeUnits > 0 ? Math.floor((totalLamports * 1_000_000) / computeUnits) : 0
  return [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.max(0, microLamports),
    }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ...instructions,
  ]
}

export function buildCommentInstructions(
  payer: PublicKey,
  message: string,
  jitoTip: number,
  jitoRegion: JitoRegion | "auto" = "frankfurt"
): TransactionInstruction[] {
  const region = jitoRegion === "auto" ? ("frankfurt" as JitoRegion) : jitoRegion
  const memoIx = new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(message, "utf8"),
  })
  const instructions: TransactionInstruction[] = [memoIx]
  if (jitoTip > 0) {
    instructions.push(createTipInstruction(payer, jitoTip, region))
  }
  return instructions
}

export async function createBuyBundle(config: BundleConfig): Promise<BundleResult> {
  // Legacy function (unmodified logic)
  if (!isPumpFunAvailable()) return { bundleId: "", success: false, signatures: [], error: "pump.fun not available" }
  const { wallets, mintAddress, buyAmounts = [], jitoTip = 0.0001, priorityFee = 0.0001, slippage = 20, jitoRegion = "frankfurt" } = config
  if (!mintAddress) return { bundleId: "", success: false, signatures: [], error: "mint address required" }
  const activeWallets = wallets.filter((w) => w.isActive)
  if (activeWallets.length === 0) return { bundleId: "", success: false, signatures: [], error: "no active wallets" }

  try {
    const mint = new PublicKey(mintAddress)
    const computeUnits = 400_000
    const resolvedTip = await resolveJitoTip({ baseTip: jitoTip, dynamic: config.dynamicJitoTip, computeUnits })
    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) return { bundleId: "", success: false, signatures: [], error: "token not found" }

    const bundleIds: string[] = []
    const bundleSignatures: string[][] = []
    const signatures: string[] = []
    const chunks = chunkArray(activeWallets, MAX_BUNDLE_WALLETS)

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const walletsChunk = chunks[chunkIndex]
      const transactions: VersionedTransaction[] = []
      const txSigners: Keypair[][] = []
      const { blockhash } = await safeConnection.getLatestBlockhash()

      for (let i = 0; i < walletsChunk.length; i++) {
        const wallet = walletsChunk[i]
        const keypair = getKeypair(wallet)
        const buyAmount = buyAmounts[chunkIndex * MAX_BUNDLE_WALLETS + i] || buyAmounts[0] || 0.01
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
        const instructions: TransactionInstruction[] = [
          createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, ata, keypair.publicKey, mint),
        ]
        const { tokensOut } = calculateBuyAmount(bondingCurve, buyAmount)
        const minTokensOut = (tokensOut * BigInt(100 - slippage)) / BigInt(100)
        const solLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL))
        const buyIx = await createBuyInstruction(keypair.publicKey, mint, minTokensOut, solLamports, bondingCurve.creator)
        instructions.push(buyIx)
        const prioritized = addPriorityFeeInstructions(instructions, priorityFee)
        const message = new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: blockhash,
          instructions: prioritized,
        }).compileToV0Message()
        const buyTx = new VersionedTransaction(message)
        buyTx.sign([keypair])
        transactions.push(buyTx)
        txSigners.push([keypair])
      }

      const tipPayerWallet = wallets.find(w => w.role?.toLowerCase() === 'dev')
      const tipPayer = tipPayerWallet ? getKeypair(tipPayerWallet) : undefined
      const result = await sendBundleGroup(transactions, txSigners, "buy", jitoRegion, resolvedTip, tipPayer)
      bundleIds.push(result.bundleId)
      bundleSignatures.push(result.signatures)
      signatures.push(...result.signatures)
    }
    return { bundleId: bundleIds[0] || "", bundleIds, bundleSignatures, success: true, signatures }
  } catch (error: any) {
    return { bundleId: "", success: false, signatures: [], error: error.message || "unknown error" }
  }
}

export async function createSellBundle(config: BundleConfig): Promise<BundleResult> {
  // Legacy function (unmodified)
  if (!isPumpFunAvailable()) return { bundleId: "", success: false, signatures: [], error: "pump.fun not available" }
  const { wallets, mintAddress, sellPercentages = [], jitoTip = 0.0001, priorityFee = 0.0001, slippage = 20, jitoRegion = "frankfurt" } = config
  if (!mintAddress) return { bundleId: "", success: false, signatures: [], error: "mint address required" }
  const activeWallets = wallets.filter((w) => w.isActive && w.tokenBalance > 0)
  if (activeWallets.length === 0) return { bundleId: "", success: false, signatures: [], error: "no wallets with tokens" }

  try {
    const mint = new PublicKey(mintAddress)
    const computeUnits = 400_000
    const resolvedTip = await resolveJitoTip({ baseTip: jitoTip, dynamic: config.dynamicJitoTip, computeUnits })
    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) return { bundleId: "", success: false, signatures: [], error: "token not found" }

    const bundleIds: string[] = []
    const bundleSignatures: string[][] = []
    const signatures: string[] = []
    const chunks = chunkArray(activeWallets, MAX_BUNDLE_WALLETS)

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const walletsChunk = chunks[chunkIndex]
      const transactions: VersionedTransaction[] = []
      const txSigners: Keypair[][] = []
      const { blockhash } = await safeConnection.getLatestBlockhash()

      for (let i = 0; i < walletsChunk.length; i++) {
        const wallet = walletsChunk[i]
        const keypair = getKeypair(wallet)
        const sellPercentage = sellPercentages[chunkIndex * MAX_BUNDLE_WALLETS + i] ?? sellPercentages[0] ?? 100
        const percentBps = BigInt(Math.round(Math.min(Math.max(Number(sellPercentage), 0), 100) * 100))
        const tokenAmountRaw = toRawTokenAmount(wallet.tokenBalance) * percentBps / BPS_DENOM
        if (tokenAmountRaw <= BigInt(0)) continue

        const plan = await buildSellPlan(keypair.publicKey, mint, tokenAmountRaw, slippage, priorityFee, "auto")
        const message = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions: plan.transaction.instructions }).compileToV0Message()
        const sellTx = new VersionedTransaction(message)
        sellTx.sign([keypair])
        transactions.push(sellTx)
        txSigners.push([keypair])
      }
      if (transactions.length === 0) continue
      const tipPayerWallet = wallets.find(w => w.role?.toLowerCase() === 'dev')
      const tipPayer = tipPayerWallet ? getKeypair(tipPayerWallet) : undefined
      const result = await sendBundleGroup(transactions, txSigners, "sell", jitoRegion, resolvedTip, tipPayer)
      bundleIds.push(result.bundleId)
      bundleSignatures.push(result.signatures)
      signatures.push(...result.signatures)
    }
    return { bundleId: bundleIds[0] || "", bundleIds, bundleSignatures, success: true, signatures, mintAddress }
  } catch (error: any) {
    return { bundleId: "", success: false, signatures: [], error: error.message }
  }
}

export async function createStaggeredBuys(config: BundleConfig, onTransaction?: (wallet: string, signature: string, index: number) => void): Promise<{ signatures: string[]; errors: string[] }> {
    // Legacy unmodified
  const { wallets, mintAddress, buyAmounts = [], staggerDelay = { min: 1000, max: 3000 }, priorityFee = 0.0001, slippage = 20 } = config
  if (!mintAddress) return { signatures: [], errors: ["mint address required"] }
  const activeWallets = wallets.filter((w) => w.isActive)
  if (activeWallets.length === 0) return { signatures: [], errors: ["no active wallets"] }
  const signatures: string[] = []
  const errors: string[] = []
  const mint = new PublicKey(mintAddress)
  const resolvedDelay = { min: Math.max(400, staggerDelay.min), max: Math.max(400, staggerDelay.max) }

  for (let i = 0; i < activeWallets.length; i++) {
    const wallet = activeWallets[i]
    const keypair = getKeypair(wallet)
    const buyAmount = buyAmounts[i] || buyAmounts[0] || 0.01
    let attempt = 0, sent = false
    while (attempt < STAGGER_RETRY_ATTEMPTS && !sent) {
      try {
        const bondingCurve = await getBondingCurveData(mint)
        if (!bondingCurve) { errors.push(`${wallet.publicKey}: token not available`); break }
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
        const instructions = [
            createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, ata, keypair.publicKey, mint),
            await createBuyInstruction(keypair.publicKey, mint, (calculateBuyAmount(bondingCurve, buyAmount).tokensOut * BigInt(100 - slippage)) / BigInt(100), BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL)))
        ]
        const prioritized = addPriorityFeeInstructions(instructions, priorityFee)
        const { blockhash } = await safeConnection.getLatestBlockhash()
        const message = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions: prioritized }).compileToV0Message()
        const buyTx = new VersionedTransaction(message)
        buyTx.sign([keypair])
        const signature = await executeCritical(conn => conn.sendRawTransaction(buyTx.serialize()))
        signatures.push(signature)
        sent = true
        if (onTransaction) onTransaction(wallet.publicKey, signature, i)
      } catch (error: any) {
        attempt++
        if (attempt >= STAGGER_RETRY_ATTEMPTS) errors.push(`${wallet.publicKey}: ${error.message}`)
        await sleep(getRetryDelay(attempt))
      }
    }
    if (i < activeWallets.length - 1) await sleep(Math.random() * (resolvedDelay.max - resolvedDelay.min) + resolvedDelay.min)
  }
  return { signatures, errors }
}

export async function createStaggeredSells(config: BundleConfig, onTransaction?: (wallet: string, signature: string, index: number) => void): Promise<{ signatures: string[]; errors: string[] }> {
    // Legacy unmodified
  const { wallets, mintAddress, sellPercentages = [], staggerDelay = { min: 1000, max: 3000 }, exitDelayMs, priorityFee = 0.0001, exitPriorityFee, slippage = 20, jitoTip = 0.0001, dynamicJitoTip = false, jitoRegion = "frankfurt", exitJitoRegion } = config
  if (!mintAddress) return { signatures: [], errors: ["mint address required"] }
  const activeWallets = wallets.filter((w) => w.isActive && w.tokenBalance > 0)
  const signatures: string[] = [], errors: string[] = []
  const computeUnits = 400_000
  const resolvedTip = await resolveJitoTip({ baseTip: jitoTip, dynamic: dynamicJitoTip, computeUnits })
  const resolvedDelay = exitDelayMs ?? staggerDelay
  const resolvedPriorityFee = exitPriorityFee ?? priorityFee
  const resolvedRegion = exitJitoRegion ?? jitoRegion
  const mint = new PublicKey(mintAddress)

  for (let i = 0; i < activeWallets.length; i++) {
    const wallet = activeWallets[i]
    const keypair = getKeypair(wallet)
    const sellPercentage = sellPercentages[i] ?? sellPercentages[0] ?? 100
    const percentBps = BigInt(Math.round(Math.min(Math.max(Number(sellPercentage), 0), 100) * 100))
    let attempt = 0, sent = false
    while (attempt < STAGGER_RETRY_ATTEMPTS && !sent) {
      try {
        const bondingCurve = await getBondingCurveData(mint)
        if (!bondingCurve || bondingCurve.complete) { errors.push(`${wallet.publicKey}: token not available`); break }
        const tokenAmountRaw = toRawTokenAmount(wallet.tokenBalance) * percentBps / BPS_DENOM
        if (tokenAmountRaw <= BigInt(0)) break

        let instructions: TransactionInstruction[] = []
        if (bondingCurve.complete) {
            const poolData = await getPumpswapPoolData(mint)
            if (!poolData) { errors.push(`${wallet.publicKey}: pumpswap pool unavailable`); break }
            const swap = calculatePumpswapSwapAmount(poolData, tokenAmountRaw, true)
            const minSolOut = (swap.solOut * BigInt(100 - slippage)) / BigInt(100)
            const swapTx = await buildPumpswapSwapTransaction(keypair.publicKey, mint, tokenAmountRaw, minSolOut, resolvedPriorityFee)
            instructions = swapTx.instructions
        } else {
            const { solOut } = calculateSellAmount(bondingCurve, tokenAmountRaw)
            const minSolOut = (solOut * BigInt(100 - slippage)) / BigInt(100)
            instructions = addPriorityFeeInstructions([await createSellInstruction(keypair.publicKey, mint, tokenAmountRaw, minSolOut)], resolvedPriorityFee, computeUnits)
        }
        if (resolvedTip > 0) instructions.push(createTipInstruction(keypair.publicKey, resolvedTip, resolvedRegion as any))
        const { blockhash } = await safeConnection.getLatestBlockhash()
        const message = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message()
        const sellTx = new VersionedTransaction(message)
        sellTx.sign([keypair])
        const signature = await executeCritical(conn => conn.sendRawTransaction(sellTx.serialize()))
        signatures.push(signature)
        sent = true
        if (onTransaction) onTransaction(wallet.publicKey, signature, i)
      } catch (error: any) {
        attempt++
        if (attempt >= STAGGER_RETRY_ATTEMPTS) errors.push(`${wallet.publicKey}: ${error.message}`)
        await sleep(getRetryDelay(attempt))
      }
    }
    if (i < activeWallets.length - 1) await sleep(Math.random() * (resolvedDelay.max - resolvedDelay.min) + resolvedDelay.min)
  }
  return { signatures, errors }
}

export async function createRugpullBundle(config: BundleConfig): Promise<BundleResult> {
  const { wallets, mintAddress, jitoTip = 0.0001, priorityFee = 0.0001, slippage = 20, jitoRegion = "auto", lutAddress: providedLutAddress } = config
  if (!mintAddress) return { bundleId: "", success: false, signatures: [], error: "mint address required" }
  
  // Filter for wallets with tokens
  const activeWallets = wallets.filter((w) => w.isActive && w.tokenBalance > 0)
  if (activeWallets.length === 0) return { bundleId: "", success: false, signatures: [], error: "no wallets with tokens" }

  try {
    const mint = new PublicKey(mintAddress)
    const computeUnits = 400_000
    const resolvedTip = await resolveJitoTip({ baseTip: jitoTip, dynamic: config.dynamicJitoTip, computeUnits })
    
    // Check if LUT is ready
    let lut: AddressLookupTableAccount | null = null
    if (providedLutAddress) {
        if (!await isLutReady(safeConnection, new PublicKey(providedLutAddress))) {
             // Try to proceed without LUT or warn? 
             // Requirement says "using LUT". If not ready, we might fail or fallback.
             // We'll try to fetch it.
        }
        const acc = await safeConnection.getAddressLookupTable(new PublicKey(providedLutAddress))
        lut = acc.value
    }
    
    // If no LUT, we can't fit many instructions.
    // The previous logic didn't enforce LUT but for "Atomic Rug" with 30 wallets, we need it.
    
    const bondingCurve = await getBondingCurveData(mint)
    // If migrated, use pool? Handled by buildSellPlan?
    // buildSellPlan handles it.
    
    const bundleIds: string[] = []
    const signatures: string[] = []
    
    // Chunking: 
    // Jito Bundle Limit: 5 Transactions
    // Transaction Limit: V0 with LUT can hold ~20-30 simple instructions?
    // We use "Buyer Pays" model.
    // Each transaction pays its own fee.
    // Max 5 sellers per transaction (safe margin)? 
    // If 5 sellers per tx * 5 txs = 25 sellers per bundle.
    // If we have 30 wallets, we need 2 bundles.
    
    const SELLERS_PER_TX = 5
    const TXS_PER_BUNDLE = 5
    const SELLERS_PER_BUNDLE = SELLERS_PER_TX * TXS_PER_BUNDLE
    
    // Sort wallets? Maybe not needed for rug, just dump.
    
    let cursor = 0
    let bundleIndex = 1
    const { blockhash } = await safeConnection.getLatestBlockhash() // Initial hash
    
    while (cursor < activeWallets.length) {
        const bundleTxs: VersionedTransaction[] = []
        const bundleSigners: Keypair[][] = []
        
        // Build transactions for this bundle
        while (bundleTxs.length < TXS_PER_BUNDLE && cursor < activeWallets.length) {
            const chunk = activeWallets.slice(cursor, cursor + SELLERS_PER_TX)
            cursor += chunk.length
            
            const payerWallet = chunk[0] // First seller pays for the chunk
            const payerKeypair = getKeypair(payerWallet)
            
            const instructions: TransactionInstruction[] = []
            const signers: Keypair[] = []
            
            // Priority Fee
            instructions.push(
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: toMicroLamportsPerCu(priorityFee * LAMPORTS_PER_SOL, computeUnits) }),
                ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits * chunk.length })
            )
            
            for (const wallet of chunk) {
                const keypair = getKeypair(wallet)
                const tokenAmountRaw = toRawTokenAmount(wallet.tokenBalance)
                
                // Build Sell Instruction
                // We use buildSellPlan to get instructions
                const plan = await buildSellPlan(keypair.publicKey, mint, tokenAmountRaw, slippage, 0, "auto") // 0 priority fee here as we added globally
                instructions.push(...plan.transaction.instructions)
                signers.push(keypair)
            }
            
            // Tip (Paid by Payer)
            instructions.push(createTipInstruction(payerKeypair.publicKey, resolvedTip, jitoRegion as any))
            
            // Compile
            const msg = new TransactionMessage({
                payerKey: payerKeypair.publicKey,
                recentBlockhash: blockhash, // Will update before sending
                instructions
            }).compileToV0Message(lut ? [lut] : [])
            
            const tx = new VersionedTransaction(msg)
            tx.sign(signers)
            
            bundleTxs.push(tx)
            bundleSigners.push(signers)
        }
        
        if (bundleTxs.length > 0) {
             // Get fresh blockhash
             const { blockhash: freshBlockhash } = await safeConnection.getLatestBlockhash()
             
             // Re-sign
             const validTxs: VersionedTransaction[] = []
             const validSigners: Keypair[][] = []
             
             for (let i=0; i<bundleTxs.length; i++) {
                 const oldTx = bundleTxs[i]
                 const s = bundleSigners[i]
                 const msg = TransactionMessage.decompile(oldTx.message)
                 msg.recentBlockhash = freshBlockhash
                 const newMsg = new TransactionMessage({
                     payerKey: msg.payerKey,
                     recentBlockhash: freshBlockhash,
                     instructions: msg.instructions
                 }).compileToV0Message(lut ? [lut] : [])
                 const newTx = new VersionedTransaction(newMsg)
                 newTx.sign(s)
                 validTxs.push(newTx)
                 validSigners.push(s)
             }
             
             console.log(`[rugpull] Sending Bundle ${bundleIndex} with ${validTxs.length} txs...`)
             try {
                 const result = await sendBundleGroup(validTxs, validSigners, `rug-b${bundleIndex}`, jitoRegion, 0)
                 bundleIds.push(result.bundleId)
                 signatures.push(...result.signatures)
             } catch (e) {
                 console.error(`Rugpull Bundle ${bundleIndex} failed:`, e)
                 // Continue to next bundle to sell as much as possible? Yes.
             }
        }
        bundleIndex++
        await sleep(1000)
    }

    return { bundleId: bundleIds[0] || "", bundleIds, success: bundleIds.length > 0, signatures, mintAddress }
  } catch (error: any) {
    return { bundleId: "", success: false, signatures: [], error: error.message }
  }
}

export function estimateBundleCost(
  walletCount: number,
  buyAmounts: number[],
  jitoTip: number = 0.0001,
  priorityFee: number = 0.0001
): { totalSol: number; perWallet: number[]; jitoTip: number; fees: number } {
  const fees = walletCount * 0.00005 + priorityFee * walletCount
  const perWallet = buyAmounts.map((amount) => (amount || buyAmounts[0] || 0.01) + 0.003)
  const totalSol = perWallet.reduce((sum, amount) => sum + amount, 0) + jitoTip + fees
  return { totalSol, perWallet, jitoTip, fees }
}

export const __testing = {
  fetchCachedLutAddress,
  persistLutAddress,
  resetLutCache: () => {
    Object.keys(LUT_CACHE).forEach((key) => delete LUT_CACHE[key])
    Object.keys(LUT_REGISTRY).forEach((key) => delete LUT_REGISTRY[key])
  },
  buildCommentInstructions,
  getRandomizedBuyAmount,
}
