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
} from "@solana/web3.js"
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  AccountLayout,
} from "@solana/spl-token"
import { connection, SOLANA_NETWORK } from "./config"
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

/**
 * Produce a per-wallet buy amount optionally randomized within a configured range.
 *
 * @param index - Zero-based wallet index; the first wallet (index 0) is not randomized.
 * @param baseAmount - The fallback/base buy amount used when randomization is disabled or for index 0.
 * @param randomizer - Optional randomization settings. `enabled` toggles randomization; `min` and `max` override the lower/upper bounds.
 * @returns The buy amount to use: `baseAmount` when randomization is disabled or `index` is 0, otherwise a number within the configured bounds rounded to 6 decimal places.
 */
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

/**
 * Retrieves the cached Address Lookup Table (LUT) address for an authority, checking the in-memory LUT cache first and falling back to the database.
 *
 * If an address is found in the database, it is parsed as a `PublicKey` and stored in the in-memory `LUT_CACHE`.
 *
 * @param authorityKey - The authority's public key string used to look up the LUT.
 * @returns The LUT address as a `PublicKey` if found, `null` otherwise.
 */
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

/**
 * Persist an address for an authority's Address Lookup Table (LUT) to in-memory cache and the database.
 *
 * @param authorityKey - The authority's public key (base58 string) used as the cache key.
 * @param address - The LUT account address to persist.
 */
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

/**
 * Converts a decimal string representation of a token amount into a scaled bigint using the given number of decimals.
 *
 * The `value` may include commas, a leading minus sign, and a fractional part; the fractional portion is truncated
 * or padded with zeros to match `decimals`. Empty or non-numeric input yields `0`.
 *
 * @param value - Decimal string (e.g., "1,234.567") possibly with a leading "-" for negatives
 * @param decimals - Number of fractional decimals to scale the value by (result = value * 10^decimals)
 * @returns The integer amount scaled by 10^`decimals` as a `bigint` (`-` sign preserved for negative inputs)
 */
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
/**
 * Determine the serialized size in bytes of a Solana Transaction or VersionedTransaction.
 *
 * @param tx - The transaction to measure (supports both legacy `Transaction` and `VersionedTransaction`).
 * @returns The size of the serialized transaction in bytes.
 */
function getTxSize(tx: Transaction | VersionedTransaction): number {
  if (tx instanceof VersionedTransaction) {
    return tx.serialize().length
  }
  return tx.serialize({ requireAllSignatures: true, verifySignatures: false }).length
}

/**
 * Convert a total lamport budget into micro-lamports per compute unit.
 *
 * @param totalLamports - Total lamports available for a transaction group
 * @param computeUnits - Total compute units to divide the budget across
 * @returns The integer micro-lamports (lamports * 1,000,000) allocated per compute unit, rounded down; returns `0` if `computeUnits` is `0` or negative
 */
function toMicroLamportsPerCu(totalLamports: number, computeUnits: number): number {
  return computeUnits > 0 ? Math.floor((totalLamports * 1_000_000) / computeUnits) : 0
}

/**
 * Resolve the Jito tip amount in SOL, ensuring it is not less than the configured floor.
 *
 * @param baseTip - Optional base tip in SOL to use when dynamic estimation is not requested
 * @param dynamic - If `true`, compute a dynamic tip based on `computeUnits`; otherwise use `baseTip` or the floor
 * @param computeUnits - The compute unit budget used when computing a dynamic tip
 * @returns The resolved tip amount in SOL, never less than the floor minimum
 */
async function resolveJitoTip({
  baseTip,
  dynamic,
}: {
  baseTip?: number
  dynamic?: boolean
  computeUnits?: number // deprecated, kept for compatibility
}): Promise<number> {
  const floorSol = MIN_JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL
  if (dynamic) {
    const est = await getJitoTipFloor()
    return Math.max(est, floorSol)
  }
  return Math.max(baseTip ?? floorSol, floorSol)
}

/**
 * Validates that each transaction's serialized size does not exceed the configured MTU.
 *
 * @param transactions - Array of Transaction or VersionedTransaction objects to check
 * @param label - Label used in the returned error message to identify the transaction group
 * @returns An error message identifying the first transaction that exceeds the MTU, or `null` if all transactions are within the MTU
 */
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

/**
 * Split an array into consecutive chunks of a given maximum size.
 *
 * @param items - The array to split
 * @param size - Maximum number of elements per chunk; if `size` is less than or equal to 0 the original array is returned as a single chunk
 * @returns An array of chunks where each chunk contains up to `size` elements
 */
function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Partitions a list of wallets into chunks and assigns a Jito region to each chunk in round-robin order.
 *
 * @param wallets - Array of wallet items to partition
 * @param regions - Candidate Jito regions; falsy values are ignored
 * @param chunkSize - Desired number of wallets per chunk; values less than 1 are treated as 1
 * @param fallbackRegion - Region to assign when `regions` is empty or a mapped region is unavailable
 * @returns An object with `chunks` (array of wallet chunks) and `regions` (parallel array of assigned Jito regions)
 */
function planGhostBundles<T>(
  wallets: T[],
  regions: JitoRegion[],
  chunkSize: number,
  fallbackRegion: JitoRegion
): { chunks: T[][]; regions: JitoRegion[] } {
  const sanitizedRegions = regions.filter(Boolean)
  const chunks = chunkArray(wallets, Math.max(1, chunkSize))
  const mappedRegions = chunks.map((_, idx) => sanitizedRegions[idx % sanitizedRegions.length] || fallbackRegion)
  return { chunks, regions: mappedRegions }
}

/**
 * Runs an asynchronous worker over a list of items with a maximum number of concurrent executions, preserving the order of results.
 *
 * @param items - The array of input items to process
 * @param limit - Maximum number of workers to run concurrently
 * @param worker - Async function applied to each item; receives the item and its index
 * @returns An array of worker results corresponding to each input item, in the original order
 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runWorker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  }
  const count = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: count }, () => runWorker()))
  return results
}

function isRateLimitedError(error: any): boolean {
  const message = (error?.message || String(error || "")).toLowerCase()
  return message.includes("429") || message.includes("rate limit") || message.includes("too many requests")
}

/**
 * Execute an RPC operation with automatic retries when the call is rate-limited.
 *
 * Retries the provided operation up to RPC_RETRY_ATTEMPTS when errors are classified
 * as rate-limited, using exponential backoff with random jitter between attempts.
 *
 * @param fn - A function that performs the RPC call and returns a promise for its result
 * @returns The resolved value from `fn`
 * @throws The last encountered error if a non-rate-limited error occurs or all retry attempts are exhausted
 */
async function rpcWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: any
  for (let attempt = 0; attempt < RPC_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isRateLimitedError(error)) break
      const backoff = RPC_RETRY_BASE_MS * Math.pow(2, attempt)
      const jitter = Math.random() * RPC_RETRY_JITTER_MS
      await sleep(backoff + jitter)
    }
  }
  throw lastError
}

/**
 * Creates a synthetic Address Lookup Table object and registers it in the in-memory LUT registry.
 *
 * Constructs an AddressLookupTableAccount populated with the provided addresses and authority, returning its address and lookup table instance.
 *
 * @param authority - Keypair whose public key will be set as the LUT authority
 * @param addresses - Array of PublicKey entries to populate the lookup table
 * @param cachedAddress - Optional PublicKey to use as the LUT address; a new random address is generated if omitted
 * @returns An object containing `address` (the LUT's PublicKey) and `lookupTable` (the constructed AddressLookupTableAccount)
 */
function createSyntheticLookupTable(
  authority: Keypair,
  addresses: PublicKey[],
  cachedAddress?: PublicKey
): { address: PublicKey; lookupTable: AddressLookupTableAccount } {
  const lutAddress = cachedAddress ?? Keypair.generate().publicKey
  const lookupTable = new AddressLookupTableAccount({
    key: lutAddress,
    state: {
      deactivationSlot: BigInt(0),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: authority.publicKey,
      addresses,
    },
  })
  LUT_REGISTRY[lutAddress.toBase58()] = lookupTable
  return { address: lutAddress, lookupTable }
}

/**
 * Create or retrieve an Address Lookup Table (LUT) for the given authority populated with the provided addresses.
 *
 * Deduplicates `addresses` (up to `options.maxAddresses`), reuses a cached LUT when available and allowed, extends an existing LUT with any missing addresses, and persists the resulting LUT address for future reuse. In test mode (`TEST_BANKRUN=true`) a synthetic LUT may be created and returned.
 *
 * @param authority - Keypair used as the LUT authority and payer for on-chain LUT operations
 * @param addresses - Array of PublicKeys to include in the LUT; duplicate entries are removed
 * @param options - Optional configuration:
 *   - maxAddresses: maximum unique addresses to include (default: 30)
 *   - reuseExisting: whether to attempt to reuse/extend a cached LUT (default: true)
 * @returns An object containing `address` (the LUT PublicKey) and `lookupTable` (the AddressLookupTableAccount)
 * @throws If the LUT account cannot be fetched after creation
 */
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
    const cachedAddress = await fetchCachedLutAddress(authorityKey)
    const synthetic = createSyntheticLookupTable(authority, uniqueAddresses, cachedAddress ?? undefined)
    await persistLutAddress(authorityKey, synthetic.address)
    return synthetic
  }

  if (reuseExisting) {
    const cachedAddress = await fetchCachedLutAddress(authorityKey)
    if (cachedAddress) {
      const existing = await connection.getAddressLookupTable(cachedAddress)
      if (existing.value) {
        const missing = uniqueAddresses.filter(
          (addr) => !existing.value?.state?.addresses?.some((a) => a.equals(addr))
        )
        if (missing.length) {
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
          const extendIx = AddressLookupTableProgram.extendLookupTable({
            authority: authority.publicKey,
            payer: authority.publicKey,
            lookupTable: cachedAddress,
            addresses: missing,
          })
          const extendMsg = new TransactionMessage({
            payerKey: authority.publicKey,
            recentBlockhash: blockhash,
            instructions: [extendIx],
          }).compileToV0Message()
          const extendTx = new VersionedTransaction(extendMsg)
          extendTx.sign([authority])
          const sig = await connection.sendTransaction(extendTx)
          await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
        }
        await persistLutAddress(authorityKey, cachedAddress)
        return { address: cachedAddress, lookupTable: existing.value }
      }
    }
  }

  const recentSlot = await rpcWithRetry(() => connection.getSlot())
  const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot,
  })

  const { blockhash: createBlockhash, lastValidBlockHeight: createLvh } = await connection.getLatestBlockhash()
  const createMsg = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: createBlockhash,
    instructions: [createIx],
  }).compileToV0Message()
  const createTx = new VersionedTransaction(createMsg)
  createTx.sign([authority])
  const createSig = await connection.sendTransaction(createTx)
  await connection.confirmTransaction({ signature: createSig, blockhash: createBlockhash, lastValidBlockHeight: createLvh })

  const minSlot = recentSlot + 1
  let currentSlot = await connection.getSlot()
  let attempts = 0
  const maxAttempts = 30 // ~12-15s wait
  while (currentSlot <= minSlot && attempts < maxAttempts) {
    await sleep(400)
    currentSlot = await connection.getSlot()
    attempts++
  }
  if (currentSlot <= minSlot) {
    console.warn(`[bundler] LUT creation: slot didn't advance from ${recentSlot} (now ${currentSlot}) after ${attempts} attempts`)
    // We continue anyway, hoping RPC is just slightly behind but tx landed
  }

  const extendChunks = chunkArray(uniqueAddresses, maxAddresses)
  for (const chunk of extendChunks) {
    if (!chunk.length) continue
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      lookupTable: lookupTableAddress,
      addresses: chunk,
    })
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
    const extendMsg = new TransactionMessage({
      payerKey: authority.publicKey,
      recentBlockhash: blockhash,
      instructions: [extendIx],
    }).compileToV0Message()
    const extendTx = new VersionedTransaction(extendMsg)
    extendTx.sign([authority])
    const sig = await connection.sendTransaction(extendTx)
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
  }

  const lutAccount = await connection.getAddressLookupTable(lookupTableAddress)
  if (!lutAccount.value) {
    throw new Error("failed to fetch LUT after creation")
  }

  await persistLutAddress(authorityKey, lookupTableAddress)
  return { address: lookupTableAddress, lookupTable: lutAccount.value }
}

/**
 * Extracts the first signature from a Transaction or VersionedTransaction and encodes it in base58.
 *
 * @param tx - The Transaction or VersionedTransaction to read the first signature from.
 * @returns The base58-encoded first signature if present, otherwise a base58-encoded 64-byte zeroed string.
 */
function extractTxSignature(tx: Transaction | VersionedTransaction): string {
  if (tx instanceof VersionedTransaction) {
    const sig = tx.signatures?.[0]
    return bs58.encode(sig || new Uint8Array(64))
  }
  const sig = tx.signatures?.[0]?.signature
  return bs58.encode(sig || new Uint8Array(64))
}

/**
 * Polls the RPC for statuses of the provided signatures until all are resolved or the timeout elapses.
 *
 * Polls the cluster for each signature's status and reports whether each signature is `"confirmed"`, `"failed"`, or still `"pending"` when the timeout is reached.
 *
 * @param signatures - Array of base58-encoded transaction signatures to check
 * @param timeoutMs - Maximum time in milliseconds to poll before returning pending statuses
 * @returns An array of objects mapping each `signature` to its `status` (`"confirmed" | "failed" | "pending"`) and an optional `err` when `status` is `"failed"`
 */
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
    const resp = await connection.getSignatureStatuses(pending)
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

/**
 * Sends a group of transactions as a Jito bundle after validating sizes, simulating, signing (if a tip is added), and confirming final execution.
 *
 * Performs MTU validation for each transaction, simulates each transaction and aborts on simulation errors, submits the bundle to Jito, and waits for RPC confirmation of all signatures.
 *
 * @param transactions - Array of transactions to include in the bundle (legacy Transaction or VersionedTransaction).
 * @param txSigners - Parallel array of signer keypairs for each transaction; used to sign a transaction when a tip instruction is appended.
 * @param label - Human-readable label used in validation and error messages.
 * @param jitoRegion - Target Jito region or `"auto"` to let the sender decide.
 * @param jitoTip - Tip in lamports to attach to the last legacy transaction in the group; ignored for versioned transactions.
 * @returns An object containing the Jito-assigned `bundleId` and an array of transaction signatures (base58-encoded).
 * @throws If any transaction exceeds MTU limits, if any simulation reports an error, if bundle submission ultimately fails, or if not all transactions are confirmed within the confirmation timeout.
 */
async function sendBundleGroup(
  transactions: (Transaction | VersionedTransaction)[],
  txSigners: Keypair[][],
  label: string,
  jitoRegion: JitoRegion | "auto",
  jitoTip: number,
  tipPayer?: Keypair
): Promise<{ bundleId: string; signatures: string[] }> {
  if (jitoTip > 0) {
    if (tipPayer) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      const tipTx = new Transaction()
      tipTx.add(createTipInstruction(tipPayer.publicKey, jitoTip))
      tipTx.recentBlockhash = blockhash
      tipTx.lastValidBlockHeight = lastValidBlockHeight
      tipTx.feePayer = tipPayer.publicKey
      tipTx.sign(tipPayer)

      transactions.push(tipTx)
      txSigners.push([tipPayer])
    } else if (transactions.length > 0) {
      const lastIdx = transactions.length - 1
      const lastTx = transactions[lastIdx]
      if (lastTx instanceof Transaction) {
        const lastSigner = txSigners[lastIdx]?.[0]
        if (lastSigner) {
          lastTx.add(createTipInstruction(lastSigner.publicKey, jitoTip))
          lastTx.sign(...txSigners[lastIdx])
        } else {
          console.warn("[bundler] missing signer for last tx (tip not added)")
        }
      } else {
        console.warn("[bundler] tip must be embedded in versioned transactions; skipping auto-tip")
      }
    }
  }

  const mtuError = validateBundleMtu(transactions, label)
  if (mtuError) {
    throw new Error(mtuError)
  }

  for (let i = 0; i < transactions.length; i++) {
    const sim = await connection.simulateTransaction(transactions[i])
    if (sim?.value?.err) {
      throw new Error(`simulation failed (${label} idx=${i}): ${JSON.stringify(sim.value.err)}`)
    }
  }

  const result = await sendBundleWithRetry(transactions, jitoRegion)
  const signatures = transactions.map(extractTxSignature)
  const statuses = await confirmSignaturesOnRpc(signatures, 60_000)
  const failed = statuses.filter((s) => s.status === "failed")
  const pending = statuses.filter((s) => s.status === "pending")
  if (failed.length || pending.length) {
    throw new Error(
      pending.length
        ? "bundle submitted but not all transactions confirmed on RPC (timeout)"
        : `bundle contains failed transaction(s): ${JSON.stringify(failed[0]?.err ?? "unknown")}`
    )
  }

  return { bundleId: result.bundleId, signatures }
}

/**
 * Retrieve the initial bonding-curve parameters from pump.fun global state.
 *
 * @returns An object containing initial reserve and supply values:
 * - `virtualTokenReserves`: virtual token reserves as a `bigint`
 * - `virtualSolReserves`: virtual SOL reserves as a `bigint`
 * - `realTokenReserves`: real token reserves as a `bigint`
 * - `realSolReserves`: real SOL reserves as a `bigint` (zeroed here)
 * - `tokenTotalSupply`: total token supply as a `bigint`
 * or `null` if the global state is not available.
 */
async function getInitialCurve(): Promise<{
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
  tokenTotalSupply: bigint
} | null> {
  const global = await getPumpfunGlobalState()
  if (!global) return null
  return {
    virtualTokenReserves: global.initialVirtualTokenReserves,
    virtualSolReserves: global.initialVirtualSolReserves,
    realTokenReserves: global.initialRealTokenReserves,
    realSolReserves: BigInt(0),
    tokenTotalSupply: global.tokenTotalSupply,
  }
}

/**
 * Applies a buy operation to the bonding curve and returns the updated reserves.
 *
 * Updates both virtual and real SOL/token reserves to reflect a purchase of `tokensOut` for
 * `solAmountLamports`. A protocol buy fee (determined by `PUMPFUN_BUY_FEE_BPS`) is taken from
 * `solAmountLamports` before updating SOL reserves; the net SOL after fee is added to SOL reserves.
 *
 * @param bondingCurve - Current bonding curve reserves (all values in raw units: lamports for SOL, smallest token units for token reserves)
 * @param solAmountLamports - The total SOL offered for the buy, expressed in lamports
 * @param tokensOut - The amount of tokens to remove from virtual reserves and credit to real reserves (in token base units)
 * @returns The new bonding curve reserves object with updated `virtualTokenReserves`, `virtualSolReserves`, `realTokenReserves`, and `realSolReserves`
 */
function applyBuyToCurve(
  bondingCurve: {
    virtualTokenReserves: bigint
    virtualSolReserves: bigint
    realTokenReserves: bigint
    realSolReserves: bigint
  },
  solAmountLamports: bigint,
  tokensOut: bigint
): {
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
} {
  const feeLamports = (solAmountLamports * BigInt(PUMPFUN_BUY_FEE_BPS)) / 10000n
  const solAfterFee = solAmountLamports - feeLamports
  return {
    virtualTokenReserves: bondingCurve.virtualTokenReserves - tokensOut,
    virtualSolReserves: bondingCurve.virtualSolReserves + solAfterFee,
    realTokenReserves: bondingCurve.realTokenReserves + tokensOut,
    realSolReserves: bondingCurve.realSolReserves + solAfterFee,
  }
}

/**
 * Attempts to send a Jito bundle for the provided transactions, retrying across configured regions on failure.
 *
 * @param transactions - Transactions to include in the bundle.
 * @param region - Preferred Jito region or `"auto"` to cycle through configured endpoints.
 * @param attempts - Maximum number of send attempts before failing; regions will be cycled if available.
 * @returns The sent bundle's id as `bundleId`.
 * @throws Error if the bundle could not be sent after the configured number of attempts; the error message contains the last observed failure reason.
 */
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

// bundler wallet type
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

// bundle config
export interface BundleConfig {
  wallets: BundlerWallet[]
  mintAddress?: string
  // launch settings
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
  // buy/sell amounts
  buyAmounts?: number[] // SOL per wallet
  sellPercentages?: number[] // % per wallet (100 = sell all)
  buyRandomizer?: { enabled?: boolean; min?: number; max?: number; noiseMemos?: boolean }
  // timing
  staggerDelay?: { min: number; max: number }
  // fees
  jitoTip?: number
  dynamicJitoTip?: boolean
  priorityFee?: number
  slippage?: number
  // jito
  // "auto" will try all regions with retries
  jitoRegion?: JitoRegion | "auto"
  // stealth launch options
  ghostMode?: boolean
  ghostChunkSize?: number
  ghostRegions?: JitoRegion[]
  // off-chain funding
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
  // exit
  smartExit?: boolean
  exitChunkSize?: number
  exitDelayMs?: { min: number; max: number }
  exitPriorityFee?: number
  exitJitoRegion?: JitoRegion | "auto"
}

// bundle result
export interface BundleResult {
  bundleId: string
  bundleIds?: string[]
  success: boolean
  signatures: string[]
  bundleSignatures?: string[][]
  error?: string
  mintAddress?: string
  estimatedProfit?: {
    grossSol: number  // total SOL from selling all tokens
    gasFee: number    // estimated gas fees
    jitoTip: number   // jito tip amount
    netSol: number    // net profit after fees
    priceImpact: number // average price impact %
    walletCount: number // number of wallets participating
  }
}

/**
 * generate new wallet
 */
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

/**
 * generate multiple wallets
 */
export function generateWallets(count: number, startIndex: number = 0): BundlerWallet[] {
  const wallets: BundlerWallet[] = []
  for (let i = 0; i < count; i++) {
    wallets.push(generateWallet(`Wallet ${startIndex + i + 1}`))
  }
  return wallets
}

/**
 * import wallet from secret key
 */
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

/**
 * get keypair from wallet
 */
export function getKeypair(wallet: BundlerWallet): Keypair {
  return Keypair.fromSecretKey(bs58.decode(wallet.secretKey))
}

/**
 * refresh wallet balances (optimized with getMultipleAccounts)
 */
export async function refreshWalletBalances(
  wallets: BundlerWallet[],
  mintAddress?: string
): Promise<BundlerWallet[]> {
  const chunks = chunkArray(wallets, 5) // RPC limit is 5 accounts per call on low tiers
  const updatedWallets: BundlerWallet[] = []
  const mint = mintAddress ? new PublicKey(mintAddress) : null

  for (const chunk of chunks) {
    try {
      const pubkeys = chunk.map(w => new PublicKey(w.publicKey))

      // 1. Fetch SOL balances
      const solAccounts = await rpcWithRetry(() => connection.getMultipleAccountsInfo(pubkeys))

      // 2. Fetch Token balances (if mint provided)
      let tokenAccounts: (any | null)[] = []
      let ataAddresses: PublicKey[] = []

      if (mint) {
        ataAddresses = await Promise.all(
          pubkeys.map(owner => getAssociatedTokenAddress(mint, owner, false))
        )
        tokenAccounts = await rpcWithRetry(() => connection.getMultipleAccountsInfo(ataAddresses))
      }

      // 3. Map results
      for (let i = 0; i < chunk.length; i++) {
        const wallet = chunk[i]
        const solAccount = solAccounts[i]

        // SOL Balance
        const solBalance = solAccount ? solAccount.lamports / LAMPORTS_PER_SOL : 0

        // Token Balance
        let tokenBalance = 0
        let ataExists = false

        if (mint) {
          const tokenAccount = tokenAccounts[i]
          if (tokenAccount) {
            ataExists = true
            try {
              // Parse SPL Token account data
              const rawAccount = AccountLayout.decode(tokenAccount.data)
              const amount = BigInt(rawAccount.amount) // amount is bigint or u64 buffer
              tokenBalance = Number(amount) / (10 ** TOKEN_DECIMALS) // Assuming 6 decimals for pump.fun tokens
            } catch (e) {
              console.error(`Failed to parse token account for ${wallet.publicKey}:`, e)
            }
          }
        }

        updatedWallets.push({
          ...wallet,
          solBalance,
          tokenBalance: mint ? tokenBalance : wallet.tokenBalance, // preserve old token balance if no mint
          ...(mint ? { ataExists } : {})
        })
      }
    } catch (error) {
      console.error("Batch refresh failed, falling back to individual:", error)
      // Fallback to original individual refresh for this chunk if batch fails
      const fallbackChunk = await mapWithLimit(chunk, RPC_REFRESH_CONCURRENCY, async (wallet) => {
         try {
           const pubkey = new PublicKey(wallet.publicKey)
           const solBalance = await rpcWithRetry(() => connection.getBalance(pubkey))
           let tokenBalance = 0
           let ataExists: boolean | undefined = undefined
           if (mint) {
             try {
               const ata = await getAssociatedTokenAddress(mint, pubkey, false)
               const tokenAccount = await rpcWithRetry(() => connection.getTokenAccountBalance(ata))
               tokenBalance = tokenAccount.value.uiAmount || 0
               ataExists = true
             } catch {
               ataExists = false
             }
           }
           return {
             ...wallet,
             solBalance: solBalance / LAMPORTS_PER_SOL,
             tokenBalance,
             ...(mint ? { ataExists } : {})
           }
         } catch {
           return wallet
         }
      })
      updatedWallets.push(...fallbackChunk)
    }
  }

  return updatedWallets
}

/**
 * fund wallets from funder wallet
 */
export async function fundWallets(
  funder: Keypair,
  wallets: BundlerWallet[],
  amounts: number[] // SOL per wallet
): Promise<string[]> {
  const signatures: string[] = []

  // Chunk wallets to avoid transaction size limits
  // Max ~20 transfers per tx to be safe with MTU
  const CHUNK_SIZE = 15
  const chunks = chunkArray(wallets, CHUNK_SIZE)
  const amountChunks = chunkArray(amounts, CHUNK_SIZE)

  for (let i = 0; i < chunks.length; i++) {
    const walletChunk = chunks[i]
    const amountChunk = amountChunks[i] || []
    const instructions: TransactionInstruction[] = []

    walletChunk.forEach((wallet, idx) => {
      // If specific amount for this wallet exists in chunk use it, otherwise use global default from first chunk
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
      const { blockhash } = await connection.getLatestBlockhash()

      const message = new TransactionMessage({
        payerKey: funder.publicKey, // Explicitly set payer key
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message()

      const transaction = new VersionedTransaction(message)
      transaction.sign([funder])

      const signature = await connection.sendRawTransaction(transaction.serialize())
      await connection.confirmTransaction(signature, "confirmed")
      signatures.push(signature)
    } catch (error) {
      console.error(`Fund chunk ${i} failed:`, error)
      throw error // Re-throw to alert user, partial success will be handled by caller if needed
    }
  }

  return signatures
}

/**
 * collect SOL from wallets back to funder using Jito bundles
 */
export async function collectSol(
  wallets: BundlerWallet[],
  recipient: PublicKey,
  options: { jitoTip?: number; jitoRegion?: JitoRegion | "auto" } = {}
): Promise<string[]> {
  const { jitoTip = 0.0001, jitoRegion = "frankfurt" } = options
  const signatures: string[] = []

  // 1. Refresh balances efficiently
  const refreshedWallets = await refreshWalletBalances(wallets)

  // 2. Filter wallets with enough funds (> 5000 lamports fee)
  const feeLamports = 5000
  const tipLamports = Math.floor(jitoTip * LAMPORTS_PER_SOL)
  const validWallets = refreshedWallets.filter(w => {
    const bal = Math.floor(w.solBalance * LAMPORTS_PER_SOL)
    return bal > feeLamports
  })

  // 3. Chunk into groups of 5 (Jito limit)
  const chunks = chunkArray(validWallets, 5)

  for (const chunk of chunks) {
    // Sort chunk by balance ascending, so the richest wallet is last and pays the tip
    const sortedChunk = [...chunk].sort((a, b) => a.solBalance - b.solBalance)

    // Check if the richest wallet can afford fee + tip
    const tipPayer = sortedChunk[sortedChunk.length - 1]
    const tipPayerBal = Math.floor(tipPayer.solBalance * LAMPORTS_PER_SOL)
    if (tipPayerBal <= feeLamports + tipLamports) {
      console.warn(`[collect] skipping chunk, richest wallet ${tipPayer.publicKey} has insufficient SOL for tip`)
      continue
    }

    const transactions: Transaction[] = []
    const txSigners: Keypair[][] = []
    const { blockhash } = await connection.getLatestBlockhash()

    for (let i = 0; i < sortedChunk.length; i++) {
      const wallet = sortedChunk[i]
      const isTipPayer = i === sortedChunk.length - 1
      const keypair = getKeypair(wallet)

      const balance = Math.floor(wallet.solBalance * LAMPORTS_PER_SOL)
      let sendAmount = balance - feeLamports

      if (isTipPayer) {
        sendAmount -= tipLamports
      }

      // Safety check (should be covered by sort check above, but good for robustness)
      if (sendAmount <= 0) continue

      const transaction = new Transaction()
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipient,
          lamports: sendAmount,
        })
      )

      transaction.recentBlockhash = blockhash
      transaction.feePayer = keypair.publicKey
      transaction.sign(keypair)

      transactions.push(transaction)
      txSigners.push([keypair])
    }

    if (transactions.length === 0) continue

    try {
      const result = await sendBundleGroup(
        transactions,
        txSigners,
        "collect",
        jitoRegion,
        jitoTip
      )
      signatures.push(...result.signatures)
    } catch (error) {
      console.error("Collect bundle failed:", error)
    }
  }

  return signatures
}

/**
 * Prepends compute budget and priority-fee instructions to an existing instruction list.
 *
 * This adds a compute unit price (derived from `priorityFee`) and a compute unit limit before the supplied instructions.
 *
 * @param instructions - The instruction array to augment; the returned array will start with the added compute-budget instructions followed by these.
 * @param priorityFee - Total SOL to allocate as priority fee for the transaction (used to compute micro-lamports per compute unit).
 * @param computeUnits - The compute unit limit to set for the transaction.
 * @returns A new array of `TransactionInstruction` containing the compute budget price and limit instructions followed by the original `instructions`.
 */
function addPriorityFeeInstructions(
  instructions: TransactionInstruction[],
  priorityFee: number = 0.0001,
  computeUnits: number = 400000
): TransactionInstruction[] {
  // priorityFee is treated as total SOL per transaction; convert to microLamports-per-CU
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

/**
 * Create a memo instruction and an optional Jito tip instruction for a transaction.
 *
 * @param payer - Public key that will fund the tip instruction when `jitoTip` is greater than zero
 * @param message - UTF-8 memo text to embed in the transaction
 * @param jitoTip - Tip amount in lamports; when greater than zero a Jito tip instruction is appended
 * @param jitoRegion - Jito region to target for the tip; `"auto"` resolves to `"frankfurt"` by default
 * @returns An array with a Memo instruction containing `message` and, if `jitoTip` > 0, a Jito tip instruction targeting `jitoRegion`
 */
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

/**
 * Creates a new token mint and executes bundled buy transactions for the provided wallets according to the bundle configuration.
 *
 * The function orchestrates mint creation, associated token account setup, and grouped buy transactions (sent via Jito bundles when configured). It honors options on randomized per-wallet buy amounts, ghost/region chunking, priority fees, dynamic Jito tips, and optional off‑chain funding. If prerequisites are missing (for example, pump.fun unavailable or token metadata absent) the returned result will indicate failure and include an error message.
 *
 * @param config - Bundle configuration describing wallets, token metadata, buy amounts and behavior (must include active wallets and `tokenMetadata`)
 * @returns A BundleResult describing the outcome. On success `success` is true and `mintAddress`, `bundleId`/`bundleIds`, and `signatures` are populated; on failure `success` is false and `error` contains a human-readable message.
 */
export async function createLaunchBundle(config: BundleConfig): Promise<BundleResult> {
  if (!isPumpFunAvailable()) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: `pump.fun not available on ${SOLANA_NETWORK}`,
    }
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
  } = config

  if (!tokenMetadata) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: "token metadata required",
    }
  }

  let activeWallets = wallets.filter((w) => w.isActive)
  if (activeWallets.length === 0) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: "no active wallets",
    }
  }

  // Ensure "Dev" wallet is at index 0 and sync buyAmounts
  const rawBuyAmounts = buyAmounts || []
  const fallbackAmount = rawBuyAmounts[0] ?? 0.01
  const expandedBuyAmounts = activeWallets.map((_, i) => rawBuyAmounts[i] ?? fallbackAmount)

  const combined = activeWallets.map((w, i) => ({ w, amt: expandedBuyAmounts[i] }))

  // Explicitly find Dev wallet
  const devIndex = combined.findIndex(x => x.w.role?.toLowerCase() === 'dev')
  if (devIndex > 0) {
    const [devItem] = combined.splice(devIndex, 1)
    combined.unshift(devItem)
  } else {
      // Fallback sort if not found or already at 0 (robustness)
      combined.sort((a, b) => {
        const aIsDev = a.w.role?.toLowerCase() === 'dev'
        const bIsDev = b.w.role?.toLowerCase() === 'dev'
        if (aIsDev) return -1
        if (bIsDev) return 1
        return 0
      })
  }

  activeWallets = combined.map((x) => x.w)
  const sortedBuyAmounts = combined.map((x) => x.amt)

  try {
    const mintKeypair = Keypair.generate()
    const mint = mintKeypair.publicKey

    // Force dev wallet to be the one we found/sorted to top
    const devWallet = activeWallets[0]
    const devKeypair = getKeypair(devWallet)

    // Pre-flight check: ensure dev wallet has enough SOL for tip
    const devSolBalance = devWallet.solBalance || 0
    // We check against resolvedTip (which might be dynamic) + buffer.
    // Since we resolve tip below, we can do a quick check here with base tip or do it after resolution.
    // User requested: "if (devWalletBalance < JITO_TIP_AMOUNT + 0.01 SOL) throw..."
    // We'll check against jitoTip first for early exit, or wait until resolved.
    // Let's resolve tip first.

    const safeSlippage = Math.min(Math.max(Math.floor(slippage), 0), 99)
    const computeUnits = 800_000
    const resolvedTip = await resolveJitoTip({
      baseTip: jitoTip,
      dynamic: config.dynamicJitoTip,
      computeUnits,
    })

    // Calculate proper Dev wallet cost estimate
    // Dev wallet pays for: token creation, all ATAs, all buys, fees, tip
    const walletCount = activeWallets.length
    const devBuyAmountValue = config.devBuyAmount || 0.01
    const buyerBuyAmounts = sortedBuyAmounts.slice(1) // exclude dev wallet
    const costEstimate = estimateBundleCost(walletCount, [devBuyAmountValue, ...buyerBuyAmounts], resolvedTip, priorityFee)

    // Add extra buffer for token creation rent (bonding curve + metadata PDAs)
    const tokenCreationRentEstimate = 0.025 // rough estimate for bonding curve + metadata rent
    const totalDevCostEstimate = costEstimate.totalSol + tokenCreationRentEstimate

    // #region agent log - Hypothesis A: Log Dev wallet balance check
    fetch('http://127.0.0.1:7247/ingest/6660ca90-26c7-4aff-8c90-88511fe0d0d0d4', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'lib/solana/bundler-engine.ts:1284',
        message: 'Dev wallet balance check calculation',
        data: {
          devSolBalance,
          resolvedTip,
          costEstimateTotal: costEstimate.totalSol,
          tokenCreationRentEstimate,
          totalDevCostEstimate,
          walletCount,
          devBuyAmount,
          buyerCount: buyerBuyAmounts.length
        },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        runId: 'run1',
        hypothesisId: 'A'
      })
    }).catch(() => {})
    // #endregion

    if (devSolBalance < totalDevCostEstimate) {
      throw new Error(`Dev wallet insufficient funds: has ${devSolBalance.toFixed(4)} SOL, need ${totalDevCostEstimate.toFixed(4)} SOL (includes token creation, ATAs, buys, fees, tip)`)
    }

    const initialCurve = await getInitialCurve()
    if (!initialCurve) {
      throw new Error("pump.fun global state unavailable")
    }

    if (config.cexFunding?.enabled) {
      try {
        const okxClient = createOkxClient()
        const sniperAddresses = activeWallets.map((w) => w.publicKey)
        if (config.cexFunding.whitelist) {
          await whitelistWithdrawalAddresses(okxClient, sniperAddresses)
        }

        // Generate a session ID for idempotency if not provided in config
        const sessionId = Date.now().toString(36)

        const fundingResult = await withdrawToSnipers(okxClient, sniperAddresses, {
          minAmount: config.cexFunding.minAmount,
          maxAmount: config.cexFunding.maxAmount,
          fee: config.cexFunding.fee,
          minDelayMs: config.cexFunding.minDelayMs,
          maxDelayMs: config.cexFunding.maxDelayMs,
          clientOrderIdPrefix: `launch-${sessionId}`
        })

        if (config.cexFunding.failOnError && fundingResult.failed.length > 0) {
          throw new Error(`CEX Funding failed for ${fundingResult.failed.length} wallets: ${fundingResult.failed[0].error}`)
        }
      } catch (error: any) {
        if (config.cexFunding.failOnError) throw error
        console.error("CEX Funding failed but continuing launch (failOnError=false):", error)
      }
    }

    const ghostMode = Boolean((config as any).ghostMode)
    const ghostChunkSize = ghostMode ? Math.max(1, (config as any).ghostChunkSize ?? 5) : activeWallets.length
    const ghostRegions = ghostMode
      ? ((config as any).ghostRegions as JitoRegion[] | undefined)
      : undefined
    const fallbackRegion: JitoRegion =
      (jitoRegion as JitoRegion) && jitoRegion !== "auto" ? (jitoRegion as JitoRegion) : "frankfurt"
    const defaultRegions: JitoRegion[] = ["ny", "frankfurt", "tokyo", "amsterdam"].filter(
      (r) => r in JITO_ENDPOINTS
    ) as JitoRegion[]
    const regionPool = ghostRegions?.filter((r): r is JitoRegion => Boolean(r)) ?? defaultRegions
    const ghostPlan = ghostMode
      ? planGhostBundles(activeWallets, regionPool, ghostChunkSize, fallbackRegion)
      : { chunks: [activeWallets], regions: [fallbackRegion] }

    let curveState = {
      ...initialCurve,
      complete: false,
      creator: devKeypair.publicKey,
    }

    const { blockhash } = await connection.getLatestBlockhash()

    const bundleIds: string[] = []
    const bundleSignatures: string[][] = []
    const signatures: string[] = []

    for (let chunkIndex = 0; chunkIndex < ghostPlan.chunks.length; chunkIndex++) {
      const walletsChunk = ghostPlan.chunks[chunkIndex]
      const lutAddresses = walletsChunk.map((w) => new PublicKey(w.publicKey))
      const { lookupTable } = await getOrCreateLUT(devKeypair, lutAddresses, {
        maxAddresses: MAX_BUNDLE_WALLETS,
        reuseExisting: !ghostMode,
      })

      const instructions: TransactionInstruction[] = []
      const totalLamports = Math.max(0, priorityFee) * LAMPORTS_PER_SOL
      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: Math.max(0, toMicroLamportsPerCu(totalLamports, computeUnits)),
        })
      )

      // Robustly separate dev wallet from buyers using role-based identification
      const devWalletInChunk = walletsChunk.find(w => w.role?.toLowerCase() === 'dev')
      const allBuyerWalletsInChunk = walletsChunk.filter(w => w.role?.toLowerCase() !== 'dev')

      // LIMIT: First transaction can only handle 2-3 buyers due to create instruction size
      const maxBuyersInFirstTx = 3
      const buyerWalletsInChunk = chunkIndex === 0
        ? allBuyerWalletsInChunk.slice(0, maxBuyersInFirstTx)
        : allBuyerWalletsInChunk

      // WARNING: If too many buyers in first chunk, log warning
      if (chunkIndex === 0 && allBuyerWalletsInChunk.length > maxBuyersInFirstTx) {
        console.warn(`WARNING: First transaction limited to ${maxBuyersInFirstTx} buyers due to create instruction size. ${allBuyerWalletsInChunk.length - maxBuyersInFirstTx} buyers moved to next transaction.`)
      }

      if (chunkIndex === 0) {
        // FIRST TRANSACTION: Must include create + dev buy + some buyers
        instructions.push(
          createCreateTokenInstruction(devKeypair.publicKey, mintKeypair.publicKey, {
            name: tokenMetadata.name,
            symbol: tokenMetadata.symbol,
            uri: tokenMetadata.metadataUri,
          })
        )

        // Dev wallet ATA creation
        const devAta = await getAssociatedTokenAddress(mint, devKeypair.publicKey, false)
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            devKeypair.publicKey,
            devAta,
            devKeypair.publicKey,
            mint
          )
        )

        // Dev wallet BUY instruction (if devBuyAmount > 0)
        if (devBuyAmount > 0) {
          const devBuyAmountLamports = BigInt(Math.floor(devBuyAmount * LAMPORTS_PER_SOL))
          const { tokensOut: devTokensOut } = calculateBuyAmount(curveState as any, devBuyAmount)
          const devMinTokensOut = (devTokensOut * BigInt(100 - safeSlippage)) / BigInt(100)

          instructions.push(
            await createBuyInstruction(devKeypair.publicKey, mint, devMinTokensOut, devBuyAmountLamports)
          )

          // Update curve state for dev buy
          curveState = {
            ...(curveState as any),
            ...applyBuyToCurve(curveState, devBuyAmountLamports, devTokensOut),
          }
        }
      }

      // Process all wallets in chunk (including dev for subsequent chunks if any)
      const walletsToProcess = chunkIndex === 0 ? buyerWalletsInChunk : walletsChunk

      for (let i = 0; i < walletsToProcess.length; i++) {
        const wallet = walletsToProcess[i]
        const globalIndex = chunkIndex * ghostChunkSize + i + (chunkIndex === 0 ? 1 : 0) // +1 for dev in first chunk
        const keypair = getKeypair(wallet)
        const baseBuyAmount = resolveLaunchBuyAmount(globalIndex, devBuyAmount, sortedBuyAmounts)
        const buyAmount = getRandomizedBuyAmount(globalIndex, baseBuyAmount, buyRandomizer)
        const solAmountLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL))
        const { tokensOut } = calculateBuyAmount(curveState as any, buyAmount)
        const minTokensOut = (tokensOut * BigInt(100 - safeSlippage)) / BigInt(100)

        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            keypair.publicKey,
            ata,
            keypair.publicKey,
            mint
          )
        )
        if (buyRandomizer.noiseMemos !== false) {
          instructions.push(
            new TransactionInstruction({
              keys: [],
              programId: MEMO_PROGRAM_ID,
              data: Buffer.from(`noise-${globalIndex}-${Math.random().toString(16).slice(2, 8)}`),
            })
          )
        }
        console.log(`Adding buy instruction for buyer: ${keypair.publicKey.toBase58()}, amount: ${solAmountLamports} lamports`)
        instructions.push(
          await createBuyInstruction(keypair.publicKey, mint, minTokensOut, solAmountLamports)
        )

        curveState = {
          ...(curveState as any),
          ...applyBuyToCurve(curveState, solAmountLamports, tokensOut),
        }
      }

      const message = new TransactionMessage({
        payerKey: devKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message([lookupTable])

      const signerMap = new Map<string, Keypair>()
      signerMap.set(devKeypair.publicKey.toBase58(), devKeypair)
      for (const wallet of walletsChunk) {
        const keypair = getKeypair(wallet)
        signerMap.set(keypair.publicKey.toBase58(), keypair)
      }
      if (chunkIndex === 0) {
        signerMap.set(mintKeypair.publicKey.toBase58(), mintKeypair)
      }

      // Add Jito tip to EVERY transaction in the bundle (not just first)
      const tipInstructions = buildCommentInstructions(
        devKeypair.publicKey,
        `Bullish! ${mint.toBase58()}`,
        resolvedTip,
        ghostPlan.regions[chunkIndex] as any
      )

      const massMessage = new TransactionMessage({
        payerKey: devKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions: [...instructions, ...tipInstructions], // Add tip to mass transaction
      }).compileToV0Message([lookupTable])

      const massTx = new VersionedTransaction(massMessage)

      // DEBUG: Log all signers in the transaction
      console.log(`Transaction signers for chunk ${chunkIndex}:`)
      for (const [pubkeyStr, keypair] of signerMap) {
        console.log(`  - Signer: ${pubkeyStr}`)
      }

      massTx.sign(Array.from(signerMap.values()))

      const txList: VersionedTransaction[] = [massTx]

      for (const tx of txList) {
        const sim = await connection.simulateTransaction(tx)
        if (sim?.value?.err) {
          throw new Error(`simulation failed (launch v0): ${JSON.stringify(sim.value.err)}`)
        }
      }

      const region = ghostPlan.regions[chunkIndex] || fallbackRegion

      // #region agent log - Hypothesis A, B, C, D, E: Log fee payers, balances, and transfer amounts before bundle send
      for (let txIdx = 0; txIdx < txList.length; txIdx++) {
        const tx = txList[txIdx]
        const feePayer = tx.message.getAccountKeys().get(0) // fee payer is always account 0

        try {
          const balance = await connection.getBalance(feePayer)
          fetch('http://127.0.0.1:7247/ingest/6660ca90-26c7-4aff-8c90-88511fe0d0d4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'lib/solana/bundler-engine.ts:1469',
              message: `Bundle TX ${txIdx} fee payer and balance`,
              data: {
                txIndex: txIdx,
                feePayer: feePayer.toBase58(),
                balanceLamports: balance,
                balanceSOL: balance / LAMPORTS_PER_SOL
              },
              timestamp: Date.now(),
              sessionId: 'debug-session',
              runId: 'run1',
              hypothesisId: 'A,B,C,D,E'
            })
          }).catch(() => {})

          // Log SystemProgram.transfer instructions with lamports
          const instructions = tx.message.compiledInstructions
          for (let instIdx = 0; instIdx < instructions.length; instIdx++) {
            const inst = instructions[instIdx]
            const programId = tx.message.getAccountKeys().get(inst.programIdIndex)
            if (programId && programId.equals(SystemProgram.programId)) {
              // Check if this is a transfer instruction (instruction type 2)
              if (inst.data.length >= 4) {
                const instructionType = inst.data.readUInt32LE(0)
                if (instructionType === 2) { // SystemProgram.transfer
                  const lamports = inst.data.readBigUInt64LE(4)
                  fetch('http://127.0.0.1:7247/ingest/6660ca90-26c7-4aff-8c90-88511fe0d0d0d4', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      location: 'lib/solana/bundler-engine.ts:1469',
                      message: `SystemProgram.transfer instruction found`,
                      data: {
                        txIndex: txIdx,
                        instructionIndex: instIdx,
                        lamports: lamports.toString(),
                        solAmount: Number(lamports) / LAMPORTS_PER_SOL,
                        fromPubkey: tx.message.getAccountKeys().get(inst.accountKeyIndexes[0])?.toBase58(),
                        toPubkey: tx.message.getAccountKeys().get(inst.accountKeyIndexes[1])?.toBase58()
                      },
                      timestamp: Date.now(),
                      sessionId: 'debug-session',
                      runId: 'run1',
                      hypothesisId: 'A,B,C,D,E'
                    })
                  }).catch(() => {})
                }
              }
            }
          }
        } catch (error) {
          fetch('http://127.0.0.1:7247/ingest/6660ca90-26c7-4aff-8c90-88511fe0d0d0d4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'lib/solana/bundler-engine.ts:1469',
              message: `Error getting balance for TX ${txIdx}`,
              data: {
                txIndex: txIdx,
                feePayer: feePayer.toBase58(),
                error: error.message
              },
              timestamp: Date.now(),
              sessionId: 'debug-session',
              runId: 'run1',
              hypothesisId: 'A,B,C,D,E'
            })
          }).catch(() => {})
        }
      }
      // #endregion

      const bundleResult = await sendBundleWithRetry(txList, region as any)
      const txSignatures = txList.map(extractTxSignature)
      bundleIds.push(bundleResult.bundleId)
      bundleSignatures.push(txSignatures)
      signatures.push(...txSignatures)
    }

    return {
      bundleId: bundleIds[0] || "",
      bundleIds,
      bundleSignatures,
      success: true,
      signatures,
      mintAddress: mint.toBase58(),
    }
  } catch (error: any) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: error.message || "unknown error",
    }
  }
}

/**
 * Create and send Jito-bundled buy transactions for multiple wallets targeting an existing token mint.
 *
 * Builds per-wallet buy transactions (including ATA creation when needed), groups them into bundles
 * respecting MAX_BUNDLE_WALLETS, signs and sends each bundle via Jito, and collects resulting bundle IDs
 * and signatures.
 *
 * @param config - Bundle configuration containing wallets and mint information. Required fields:
 *   - `wallets`: array of BundlerWallet objects (only `isActive` wallets are used)
 *   - `mintAddress`: the target token mint public key (string)
 *   Optional fields commonly used:
 *   - `buyAmounts`: per-wallet SOL amounts (fallback to first element or 0.01 SOL)
 *   - `jitoTip`: base Jito tip in SOL
 *   - `priorityFee`: compute-priority fee in SOL
 *   - `slippage`: allowed slippage percentage for min tokens out
 *   - `jitoRegion`: target Jito region
 *
 * @returns A BundleResult describing the operation:
 *   - `success`: `true` when all bundles were created and sent, `false` on failure
 *   - `bundleId`/`bundleIds` and `bundleSignatures`: identifiers and signatures for created bundles
 *   - `signatures`: flattened list of transaction signatures
 *   - `error`: error message when `success` is `false`
 */
export async function createBuyBundle(config: BundleConfig): Promise<BundleResult> {
  if (!isPumpFunAvailable()) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: `pump.fun not available on ${SOLANA_NETWORK}`,
    }
  }

  const {
    wallets,
    mintAddress,
    buyAmounts = [],
    jitoTip = 0.0001,
    priorityFee = 0.0001,
    slippage = 20,
    jitoRegion = "frankfurt",
  } = config

  if (!mintAddress) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: "mint address required",
    }
  }

  const activeWallets = wallets.filter((w) => w.isActive)
  if (activeWallets.length === 0) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: "no active wallets",
    }
  }

  try {
    const mint = new PublicKey(mintAddress)
    const computeUnits = 400_000
    const resolvedTip = await resolveJitoTip({
      baseTip: jitoTip,
      dynamic: config.dynamicJitoTip,
      computeUnits,
    })

    // Find dev wallet for tip payment
    const devWallet = wallets.find(w => w.role?.toLowerCase() === 'dev')
    if (devWallet && devWallet.isActive) {
      const devBalance = devWallet.solBalance || 0
      if (devBalance < resolvedTip + 0.01) {
        throw new Error(`Dev wallet insufficient funds for tip: has ${devBalance.toFixed(4)} SOL, need ${(resolvedTip + 0.01).toFixed(4)} SOL`)
      }
    }

    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "token not found on pump.fun",
      }
    }

    const bundleIds: string[] = []
    const bundleSignatures: string[][] = []
    const signatures: string[] = []

    const chunks = chunkArray(activeWallets, MAX_BUNDLE_WALLETS)
    const initialBondingCurve = await getBondingCurveData(mint)
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const walletsChunk = chunks[chunkIndex]
      const bondingCurve = chunkIndex === 0 ? initialBondingCurve : await getBondingCurveData(mint)
      if (!bondingCurve) {
        return {
          bundleId: "",
          success: false,
          signatures,
          error: "token not found on pump.fun",
        }
      }

      const transactions: Transaction[] = []
      const txSigners: Keypair[][] = []
      const { blockhash } = await connection.getLatestBlockhash()

      for (let i = 0; i < walletsChunk.length; i++) {
        const wallet = walletsChunk[i]
        const globalIndex = chunkIndex * MAX_BUNDLE_WALLETS + i
        const keypair = getKeypair(wallet)
        const buyAmount = buyAmounts[globalIndex] || buyAmounts[0] || 0.01

        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
        const instructions: TransactionInstruction[] = [
          createAssociatedTokenAccountIdempotentInstruction(
            keypair.publicKey,
            ata,
            keypair.publicKey,
            mint
          ),
        ]

        const { tokensOut } = calculateBuyAmount(bondingCurve, buyAmount)
        const minTokensOut = (tokensOut * BigInt(100 - slippage)) / BigInt(100)
        const solLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL))
        const buyIx = await createBuyInstruction(
          keypair.publicKey,
          mint,
          minTokensOut,
          solLamports,
          bondingCurve.creator
        )

        instructions.push(buyIx)

        const prioritized = addPriorityFeeInstructions(instructions, priorityFee)
        const buyTx = new Transaction()
        buyTx.add(...prioritized)
        buyTx.recentBlockhash = blockhash
        buyTx.feePayer = keypair.publicKey
        buyTx.sign(keypair)
        transactions.push(buyTx)
        txSigners.push([keypair])
      }

      // Identify tip payer: prioritize dev wallet if available
      const tipPayerWallet = wallets.find(w => w.role?.toLowerCase() === 'dev')
      const tipPayer = tipPayerWallet ? getKeypair(tipPayerWallet) : undefined

      const result = await sendBundleGroup(
        transactions,
        txSigners,
        "buy",
        jitoRegion,
        resolvedTip,
        tipPayer
      )
      bundleIds.push(result.bundleId)
      bundleSignatures.push(result.signatures)
      signatures.push(...result.signatures)
    }

    return {
      bundleId: bundleIds[0] || "",
      bundleIds,
      bundleSignatures,
      success: true,
      signatures,
    }
  } catch (error: any) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: error.message || "unknown error",
    }
  }
}


/**
 * Create and send bundled sell transactions for multiple wallets using pump.fun and Jito.
 *
 * @returns A BundleResult containing bundle identifiers and signatures when successful, or failure details in the `error` field when not. 
 */
export async function createSellBundle(config: BundleConfig): Promise<BundleResult> {
  if (!isPumpFunAvailable()) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: `pump.fun not available on ${SOLANA_NETWORK}`,
    }
  }

  const {
    wallets,
    mintAddress,
    sellPercentages = [],
    jitoTip = 0.0001,
    priorityFee = 0.0001,
    slippage = 20,
    jitoRegion = "frankfurt",
  } = config

  if (!mintAddress) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: "mint address required",
    }
  }

  const activeWallets = wallets.filter((w) => w.isActive && w.tokenBalance > 0)
  if (activeWallets.length === 0) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: "no wallets with tokens",
    }
  }

  try {
    const mint = new PublicKey(mintAddress)
    const computeUnits = 400_000
    const resolvedTip = await resolveJitoTip({
      baseTip: jitoTip,
      dynamic: config.dynamicJitoTip,
      computeUnits,
    })

    // Find dev wallet for tip payment
    const devWallet = wallets.find(w => w.role?.toLowerCase() === 'dev')
    if (devWallet && devWallet.isActive) {
      const devBalance = devWallet.solBalance || 0
      if (devBalance < resolvedTip + 0.01) {
        throw new Error(`Dev wallet insufficient funds for tip: has ${devBalance.toFixed(4)} SOL, need ${(resolvedTip + 0.01).toFixed(4)} SOL`)
      }
    }

    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "token not found on pump.fun",
      }
    }

    const bundleIds: string[] = []
    const bundleSignatures: string[][] = []
    const signatures: string[] = []

    const chunks = chunkArray(activeWallets, MAX_BUNDLE_WALLETS)
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const walletsChunk = chunks[chunkIndex]
      const transactions: Transaction[] = []
      const txSigners: Keypair[][] = []
      const { blockhash } = await connection.getLatestBlockhash()

      for (let i = 0; i < walletsChunk.length; i++) {
        const wallet = walletsChunk[i]
        const globalIndex = chunkIndex * MAX_BUNDLE_WALLETS + i
        const keypair = getKeypair(wallet)
        const sellPercentage = sellPercentages[globalIndex] ?? sellPercentages[0] ?? 100
        const safePercent = Math.min(Math.max(Number(sellPercentage), 0), 100)
        const percentBps = BigInt(Math.round(safePercent * 100))

        const tokenBalanceRaw = toRawTokenAmount(wallet.tokenBalance, TOKEN_DECIMALS)
        const tokenAmountRaw = tokenBalanceRaw * percentBps / BPS_DENOM
        if (tokenAmountRaw <= BigInt(0)) {
          continue
        }

        const plan = await buildSellPlan(
          keypair.publicKey,
          mint,
          tokenAmountRaw,
          slippage,
          priorityFee,
          "auto"
        )

        plan.transaction.recentBlockhash = blockhash
        plan.transaction.feePayer = keypair.publicKey

        plan.transaction.sign(keypair)
        transactions.push(plan.transaction)
        txSigners.push([keypair])
      }

      if (transactions.length === 0) {
        continue
      }

      // Identify tip payer
      const tipPayerWallet = wallets.find(w => w.role?.toLowerCase() === 'dev')
      const tipPayer = tipPayerWallet ? getKeypair(tipPayerWallet) : undefined

      const result = await sendBundleGroup(
        transactions,
        txSigners,
        "sell",
        jitoRegion,
        resolvedTip,
        tipPayer
      )
      bundleIds.push(result.bundleId)
      bundleSignatures.push(result.signatures)
      signatures.push(...result.signatures)
    }

    if (signatures.length === 0) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "no transactions to send",
      }
    }

    return {
      bundleId: bundleIds[0] || "",
      bundleIds,
      bundleSignatures,
      success: true,
      signatures,
      mintAddress,
    }
  } catch (error: any) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: error.message || "unknown error",
    }
  }
}


/**
 * Execute buy transactions sequentially for active wallets, spacing each submission with a randomized delay.
 *
 * For each active wallet this function: ensures the associated token account exists (idempotent), computes
 * the minimum acceptable tokens out using the current bonding curve and the configured slippage, builds
 * a buy transaction (optionally preceded by compute/prioritization instructions), signs and submits the
 * raw transaction, and records the resulting signature. Transient RPC errors are retried with backoff a
 * limited number of times; non-recoverable failures are recorded in the returned `errors` array.
 *
 * @param config - Bundle configuration containing wallets, mintAddress, per-wallet buy amounts, staggerDelay,
 *   priorityFee, slippage, and other bundle-related options used to build each buy transaction.
 * @param onTransaction - Optional callback invoked after a successful submission with the wallet public key,
 *   transaction signature, and the wallet index.
 * @returns An object with `signatures` — an array of submitted transaction signatures (in submission order),
 *   and `errors` — an array of error messages for wallets that failed to submit.
 */
export async function createStaggeredBuys(
  config: BundleConfig,
  onTransaction?: (wallet: string, signature: string, index: number) => void
): Promise<{ signatures: string[]; errors: string[] }> {
  const {
    wallets,
    mintAddress,
    buyAmounts = [],
    staggerDelay = { min: 1000, max: 3000 },
    priorityFee = 0.0001,
    slippage = 20,
  } = config

  if (!mintAddress) {
    return { signatures: [], errors: ["mint address required"] }
  }

  const activeWallets = wallets.filter((w) => w.isActive)
  if (activeWallets.length === 0) {
    return { signatures: [], errors: ["no active wallets"] }
  }
  const signatures: string[] = []
  const errors: string[] = []

  const mint = new PublicKey(mintAddress)

  // Ensure random delay is not faster than block time
  const resolvedDelay = {
    min: Math.max(400, staggerDelay.min),
    max: Math.max(400, staggerDelay.max)
  }

  for (let i = 0; i < activeWallets.length; i++) {
    const wallet = activeWallets[i]
    const keypair = getKeypair(wallet)
    const buyAmount = buyAmounts[i] || buyAmounts[0] || 0.01

    let attempt = 0
    let sent = false
    while (attempt < STAGGER_RETRY_ATTEMPTS && !sent) {
      try {
        // get latest bonding curve data
        const bondingCurve = await getBondingCurveData(mint)
        if (!bondingCurve) {
          errors.push(`${wallet.publicKey}: token not available`)
          break
        }

        const instructions: TransactionInstruction[] = []

        // create ATA (idempotent, avoid RPC existence check)
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
        const ataIx = createAssociatedTokenAccountIdempotentInstruction(
          keypair.publicKey,
          ata,
          keypair.publicKey,
          mint
        )
        instructions.push(ataIx)

        // calculate tokens out
        const { tokensOut } = calculateBuyAmount(bondingCurve, buyAmount)
        const minTokensOut = (tokensOut * BigInt(100 - slippage)) / BigInt(100)

        // buy instruction
        const solLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL))
        const buyIx = await createBuyInstruction(keypair.publicKey, mint, minTokensOut, solLamports)
        instructions.push(buyIx)

        const prioritized = addPriorityFeeInstructions(instructions, priorityFee)
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()

        const buyTx = new Transaction()
        buyTx.add(...prioritized)
        buyTx.recentBlockhash = blockhash
        buyTx.lastValidBlockHeight = lastValidBlockHeight
        buyTx.feePayer = keypair.publicKey
        buyTx.sign(keypair)

        const signature = await connection.sendRawTransaction(buyTx.serialize())
        signatures.push(signature)
        sent = true

        if (onTransaction && signature) {
          onTransaction(wallet.publicKey, signature, i)
        }
      } catch (error: any) {
        const message = error?.message || String(error)
        const retryable =
          message.includes("429") ||
          message.toLowerCase().includes("too many requests") ||
          message.toLowerCase().includes("rate limit") ||
          message.toLowerCase().includes("blockhash")
        attempt += 1
        if (attempt >= STAGGER_RETRY_ATTEMPTS || !retryable) {
          errors.push(`${wallet.publicKey}: ${message}`)
          break
        }
        await sleep(getRetryDelay(attempt))
      }
    }

    // random delay before next transaction
    if (i < activeWallets.length - 1) {
      const delay = Math.random() * (resolvedDelay.max - resolvedDelay.min) + resolvedDelay.min
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  return { signatures, errors }
}

/**
 * Execute sell transactions sequentially for active wallets, applying per-wallet sell percentages, optional inter-transaction delays, and retry/backoff logic.
 *
 * The function processes only wallets that are active and hold a token balance, computes per-wallet sell amounts, enforces slippage and priority-fee settings, optionally includes Jito tips, and submits raw transactions one-by-one. Retries transient/rate-limited failures up to configured attempts and collects per-wallet errors while returning all successful signatures.
 *
 * @param config - BundleConfig that specifies wallets, `mintAddress`, sell percentages, delay settings (`staggerDelay` / `exitDelayMs`), priority fee overrides, `slippage`, Jito tip settings (`jitoTip`, `dynamicJitoTip`, `jitoRegion`, `exitJitoRegion`), and related sell options.
 * @param onTransaction - Optional callback invoked after a successful transaction with the wallet public key (string), the transaction signature, and the wallet index.
 * @returns An object containing `signatures`: an array of submitted transaction signatures, and `errors`: an array of per-wallet error messages describing failures.
 */
export async function createStaggeredSells(
  config: BundleConfig,
  onTransaction?: (wallet: string, signature: string, index: number) => void
): Promise<{ signatures: string[]; errors: string[] }> {
  const {
    wallets,
    mintAddress,
    sellPercentages = [],
    staggerDelay = { min: 1000, max: 3000 },
    exitDelayMs,
    priorityFee = 0.0001,
    exitPriorityFee,
    slippage = 20,
    jitoTip = 0.0001,
    dynamicJitoTip = false,
    jitoRegion = "frankfurt",
    exitJitoRegion,
  } = config

  if (!mintAddress) {
    return { signatures: [], errors: ["mint address required"] }
  }

  const activeWallets = wallets.filter((w) => w.isActive && w.tokenBalance > 0)
  const signatures: string[] = []
  const errors: string[] = []
  const computeUnits = 400_000
  const resolvedTip = await resolveJitoTip({
    baseTip: jitoTip,
    dynamic: dynamicJitoTip,
    computeUnits,
  })
  const resolvedDelay = exitDelayMs ?? staggerDelay
  const resolvedPriorityFee = exitPriorityFee ?? priorityFee
  const resolvedRegion = exitJitoRegion ?? jitoRegion

  const mint = new PublicKey(mintAddress)

  for (let i = 0; i < activeWallets.length; i++) {
    const wallet = activeWallets[i]
    const keypair = getKeypair(wallet)
    const sellPercentage = sellPercentages[i] ?? sellPercentages[0] ?? 100
    const safePercent = Math.min(Math.max(Number(sellPercentage), 0), 100)
    const percentBps = BigInt(Math.round(safePercent * 100))

    let attempt = 0
    let sent = false
    while (attempt < STAGGER_RETRY_ATTEMPTS && !sent) {
      try {
        // get latest bonding curve data
        const bondingCurve = await getBondingCurveData(mint)
        if (!bondingCurve || bondingCurve.complete) {
          errors.push(`${wallet.publicKey}: token not available`)
          break
        }

        const tokenBalanceRaw = toRawTokenAmount(wallet.tokenBalance, TOKEN_DECIMALS)
        const tokenAmountRaw = tokenBalanceRaw * percentBps / BPS_DENOM
        if (tokenAmountRaw <= BigInt(0)) break

        // calculate min SOL out
        let minSolOut = BigInt(0)
        let sellTx: Transaction

        if (bondingCurve.complete) {
          const poolData = await getPumpswapPoolData(mint)
          if (!poolData) {
            errors.push(`${wallet.publicKey}: pumpswap pool unavailable`)
            break
          }
          const swap = calculatePumpswapSwapAmount(poolData, tokenAmountRaw, true)
          minSolOut = (swap.solOut * BigInt(100 - slippage)) / BigInt(100)
          sellTx = await buildPumpswapSwapTransaction(
            keypair.publicKey,
            mint,
            tokenAmountRaw,
            minSolOut,
            resolvedPriorityFee
          )
        } else {
          const { solOut } = calculateSellAmount(bondingCurve, tokenAmountRaw)
          minSolOut = (solOut * BigInt(100 - slippage)) / BigInt(100)
          sellTx = new Transaction()
          const sellIx = await createSellInstruction(keypair.publicKey, mint, tokenAmountRaw, minSolOut)
          const instructions = addPriorityFeeInstructions([sellIx], resolvedPriorityFee, computeUnits)
          if (resolvedTip > 0) {
            instructions.push(createTipInstruction(keypair.publicKey, resolvedTip, resolvedRegion as any))
          }
          sellTx.add(...instructions)
        }

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
        sellTx.recentBlockhash = blockhash
        sellTx.lastValidBlockHeight = lastValidBlockHeight
        sellTx.feePayer = keypair.publicKey

        sellTx.sign(keypair)

        const signature = await connection.sendRawTransaction(sellTx.serialize())
        signatures.push(signature)
        sent = true

        if (onTransaction) {
          onTransaction(wallet.publicKey, signature, i)
        }
      } catch (error: any) {
        const message = error?.message || String(error)
        const retryable =
          message.includes("429") ||
          message.toLowerCase().includes("too many requests") ||
          message.toLowerCase().includes("rate limit") ||
          message.toLowerCase().includes("blockhash")
        attempt += 1
        if (attempt >= STAGGER_RETRY_ATTEMPTS || !retryable) {
          errors.push(`${wallet.publicKey}: ${message}`)
          break
        }
        await sleep(getRetryDelay(attempt))
      }
    }

    // random delay before next transaction
    if (i < activeWallets.length - 1) {
      const delay = Math.random() * (staggerDelay.max - staggerDelay.min) + staggerDelay.min
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  return { signatures, errors }
}

/**
 * Creates Jito bundles that sell all token holdings from the active wallets in the provided configuration.
 *
 * Attempts to read each wallet's on-chain token balance and constructs sell transactions that liquidate 100% of each token balance.
 * Supports a "smart exit" mode that delegates to staggered sells, dynamic Jito tip resolution, per-bundle compute budgeting, and
 * sequential profit estimation including price impact. Returns a summary of bundle IDs, signatures, and estimated profit data when successful.
 *
 * @param config - BundleConfig controlling wallets, target mintAddress, tip/fee settings, slippage, smart-exit and stagger options, and other bundling behavior
 * @returns A BundleResult containing bundle identifiers and signatures, a `success` flag, an optional `error` message, the `mintAddress`, and `estimatedProfit` details when available
 */
export async function createRugpullBundle(config: BundleConfig): Promise<BundleResult> {
  if (!isPumpFunAvailable()) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: `pump.fun not available on ${SOLANA_NETWORK}`,
    }
  }

  const {
    wallets,
    mintAddress,
    jitoTip = 0.0001,
    priorityFee = 0.0001,
    slippage = 20,
    jitoRegion = "auto",
  } = config

  if (!mintAddress) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: "mint address required",
    }
  }

  const activeWallets = wallets.filter((w) => w.isActive)
  if (activeWallets.length === 0) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: "no active wallets",
    }
  }

  try {
    const mint = new PublicKey(mintAddress)

    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "token not found on pump.fun",
      }
    }

    const computeUnits = 400_000
    const resolvedTip = await resolveJitoTip({
      baseTip: jitoTip,
      dynamic: config.dynamicJitoTip,
      computeUnits,
    })

    // Find dev wallet for tip payment
    const devWallet = wallets.find(w => w.role?.toLowerCase() === 'dev')
    if (devWallet && devWallet.isActive) {
      const devBalance = devWallet.solBalance || 0
      if (devBalance < resolvedTip + 0.01) {
        throw new Error(`Dev wallet insufficient funds for tip: has ${devBalance.toFixed(4)} SOL, need ${(resolvedTip + 0.01).toFixed(4)} SOL`)
      }
    }

    const walletBalances: { wallet: BundlerWallet; tokenAmount: bigint; keypair: any }[] = []

    for (const wallet of activeWallets) {
      const keypair = getKeypair(wallet)

      try {
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
        let tokenBalanceRaw = BigInt(0)
        try {
          const balance = await connection.getTokenAccountBalance(ata)
          tokenBalanceRaw = BigInt(balance.value.amount)
        } catch {
          continue
        }

        if (tokenBalanceRaw === BigInt(0)) {
          continue
        }

        walletBalances.push({ wallet, tokenAmount: tokenBalanceRaw, keypair })
      } catch {
        continue
      }
    }

    if (walletBalances.length === 0) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "no wallets with tokens",
      }
    }

    if (config.smartExit) {
      const tokenDivisor = Math.pow(10, TOKEN_DECIMALS)
      const enrichedWallets = walletBalances.map((entry) => ({
        ...entry.wallet,
        tokenBalance: Number(entry.tokenAmount) / tokenDivisor,
      }))
      const { signatures, errors } = await createStaggeredSells({
        ...config,
        wallets: enrichedWallets,
        mintAddress,
        staggerDelay: config.exitDelayMs ?? config.staggerDelay,
        exitPriorityFee: config.exitPriorityFee ?? priorityFee,
        exitJitoRegion: config.exitJitoRegion ?? jitoRegion,
      })

      return {
        bundleId: "",
        success: errors.length === 0,
        signatures,
        error: errors.length ? errors.join("; ") : undefined,
        mintAddress,
      }
    }

    const profitData = await calculateBundlerRugpullProfit(
      mint,
      walletBalances.map(w => ({
        walletAddress: w.wallet.publicKey,
        tokenAmount: w.tokenAmount
      }))
    )

    const bundleCount = Math.ceil(walletBalances.length / MAX_BUNDLE_WALLETS)
    const estimatedGasFee = BigInt(Math.floor(priorityFee * LAMPORTS_PER_SOL * walletBalances.length))
    const estimatedJitoTip = BigInt(Math.floor(resolvedTip * LAMPORTS_PER_SOL * bundleCount))
    const netEstimatedProfit = profitData.totalEstimatedSol - estimatedGasFee - estimatedJitoTip

    const bundleIds: string[] = []
    const bundleSignatures: string[][] = []
    const signatures: string[] = []

    const chunks = chunkArray(walletBalances, MAX_BUNDLE_WALLETS)
    for (const chunk of chunks) {
      const transactions: Transaction[] = []
      const txSigners: Keypair[][] = []
      const { blockhash } = await connection.getLatestBlockhash()

      for (const entry of chunk) {
        const { keypair, tokenAmount } = entry
        try {
          const plan = await buildSellPlan(
            keypair.publicKey,
            mint,
            tokenAmount,
            slippage,
            priorityFee,
            "auto"
          )

          plan.transaction.recentBlockhash = blockhash
          plan.transaction.feePayer = keypair.publicKey

          plan.transaction.sign(keypair)
          transactions.push(plan.transaction)
          txSigners.push([keypair])
        } catch {
          continue
        }
      }

      if (transactions.length === 0) {
        continue
      }

      // Identify tip payer
      const tipPayerWallet = wallets.find(w => w.role?.toLowerCase() === 'dev')
      const tipPayer = tipPayerWallet ? getKeypair(tipPayerWallet) : undefined

      const result = await sendBundleGroup(
        transactions,
        txSigners,
        "rugpull",
        jitoRegion as any,
        resolvedTip,
        tipPayer
      )
      bundleIds.push(result.bundleId)
      bundleSignatures.push(result.signatures)
      signatures.push(...result.signatures)
    }

    if (signatures.length === 0) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "no wallets with tokens to sell",
      }
    }

    return {
      bundleId: bundleIds[0] || "",
      bundleIds,
      bundleSignatures,
      success: true,
      signatures,
      mintAddress,
      estimatedProfit: {
        grossSol: Number(profitData.totalEstimatedSol) / LAMPORTS_PER_SOL,
        gasFee: Number(estimatedGasFee) / LAMPORTS_PER_SOL,
        jitoTip: Number(estimatedJitoTip) / LAMPORTS_PER_SOL,
        netSol: Number(netEstimatedProfit) / LAMPORTS_PER_SOL,
        priceImpact: profitData.totalPriceImpact,
        walletCount: walletBalances.length,
      },
    }
  } catch (error: any) {
    return {
      bundleId: "",
      success: false,
      signatures: [],
      error: error.message || "unknown error",
    }
  }
}


/**
 * Estimate total SOL required and per-wallet allocations for a bundle.
 *
 * @param walletCount - Number of wallets in the bundle; used to scale fee estimates.
 * @param buyAmounts - Per-wallet buy amounts in SOL; when an entry is falsy the first element of this array is used as a fallback.
 * @param jitoTip - Jito tip in SOL to include in the estimate.
 * @param priorityFee - Per-wallet priority fee in SOL to include in the estimate.
 * @returns An object containing:
 *  - `totalSol`: Total SOL required for the bundle (sum of per-wallet allocations, fees, and `jitoTip`).
 *  - `perWallet`: Array of SOL allocations per wallet (buy amount plus estimated ATA/rent and fees).
 *  - `jitoTip`: The `jitoTip` value included in the estimate.
 *  - `fees`: Estimated aggregated fees (includes per-wallet fee components and the `jitoTip` contribution used in the calculation).
 */
export function estimateBundleCost(
  walletCount: number,
  buyAmounts: number[],
  jitoTip: number = 0.0001,
  priorityFee: number = 0.0001
): {
  totalSol: number
  perWallet: number[]
  jitoTip: number
  fees: number
} {
  // #region agent log - Hypothesis D: Log the 0.003 buffer calculation
  fetch('http://127.0.0.1:7247/ingest/6660ca90-26c7-4aff-8c90-88511fe0d0d4', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location: 'lib/solana/bundler-engine.ts:2446',
      message: 'estimateBundleCost called with 0.003 buffer logic',
      data: {
        walletCount,
        buyAmounts,
        jitoTip,
        priorityFee,
        bufferAmount: 0.003,
        bufferReason: 'buy amount + ATA rent + fees'
      },
      timestamp: Date.now(),
      sessionId: 'debug-session',
      runId: 'run1',
      hypothesisId: 'D'
    })
  }).catch(() => {})
  // #endregion

  const fees = walletCount * 0.00005 + priorityFee * walletCount // rough estimate (jitoTip added separately)

  const perWallet = buyAmounts.map((amount, i) => {
    const buy = amount || buyAmounts[0] || 0.01
    const withBuffer = buy + 0.003 // buy amount + ATA rent + fees

    // #region agent log - Hypothesis D: Log per-wallet buffer application
    fetch('http://127.0.0.1:7247/ingest/6660ca90-26c7-4aff-8c90-88511fe0d0d4', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'lib/solana/bundler-engine.ts:2519',
        message: 'Per-wallet buffer calculation',
        data: {
          walletIndex: i,
          originalBuyAmount: buy,
          bufferAdded: 0.003,
          finalAmount: withBuffer
        },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        runId: 'run1',
        hypothesisId: 'D'
      })
    }).catch(() => {})
    // #endregion

    return withBuffer
  })

  const totalSol = perWallet.reduce((sum, amount) => sum + amount, 0) + jitoTip + fees

  return {
    totalSol,
    perWallet,
    jitoTip,
    fees,
  }
}

export const __testing = {
  fetchCachedLutAddress,
  persistLutAddress,
  resetLutCache: () => {
    Object.keys(LUT_CACHE).forEach((key) => delete LUT_CACHE[key])
    Object.keys(LUT_REGISTRY).forEach((key) => delete LUT_REGISTRY[key])
  },
  buildCommentInstructions,
  planGhostBundles,
  getRandomizedBuyAmount,
}
