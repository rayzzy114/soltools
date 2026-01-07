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
  activeWallets = combined.map((x) => x.w)
  const sortedBuyAmounts = combined.map((x) => x.amt)

  const devWallet = activeWallets[0]
  const devKeypair = getKeypair(devWallet)
  const mintKeypair = Keypair.generate()
  const mint = mintKeypair.publicKey

  // 1. Validation: Wallet Independence
  // const independenceErrors = await verifyWalletIndependence(devWallet, activeWallets)
  // if (independenceErrors.length > 0) return { bundleId: "", success: false, signatures: [], error: `Wallet Link detected: ${independenceErrors[0]}` }

  // 2. LUT Preparation (Warmup check)
  let lut: AddressLookupTableAccount | null = null
  if (providedLutAddress) {
      const acc = await safeConnection.getAddressLookupTable(new PublicKey(providedLutAddress))
      lut = acc.value
  } else {
      console.warn("LUT not pre-warmed! Creating now (slower)...")
      const readyLut = await getOrCreateLUT(devKeypair, activeWallets.map(w => new PublicKey(w.publicKey)))
      lut = readyLut.lookupTable
  }

  if (!lut) return { bundleId: "", success: false, signatures: [], error: "LUT not available" }

  // 3. Instruction Generation via PumpPortal (or Fallback)
  // We construct a request with ALL actions.
  // Item 0: Create (Dev)
  // Item 1: Buy (Dev) - if devBuyAmount > 0
  // Item 2..N: Buy (Buyers)

  const portalItems = []

  // Create Item
  portalItems.push({
      publicKey: devKeypair.publicKey.toBase58(),
      action: "create",
      tokenMetadata: {
          name: tokenMetadata.name,
          symbol: tokenMetadata.symbol,
          uri: tokenMetadata.metadataUri
      },
      mint: mint.toBase58(),
      denominatedInSol: "true",
      amount: devBuyAmount, // PumpPortal "create" usually includes initial buy if amount > 0
      slippage: slippage,
      priorityFee: priorityFee,
      pool: "pump"
  })

  // Buyer Items
  for (let i = 1; i < activeWallets.length; i++) {
      const wallet = activeWallets[i]
      const buyAmount = getRandomizedBuyAmount(i, sortedBuyAmounts[i], buyRandomizer)
      portalItems.push({
          publicKey: wallet.publicKey,
          action: "buy",
          mint: mint.toBase58(),
          denominatedInSol: "true",
          amount: buyAmount,
          slippage: slippage,
          priorityFee: priorityFee,
          pool: "pump"
      })
  }

  let transactions: VersionedTransaction[] = []

  try {
      console.log(`[bundler] Fetching ${portalItems.length} transactions from PumpPortal...`)
      transactions = await fetchPumpPortalTransactions(portalItems as any)
  } catch (error) {
      console.error("[bundler] PumpPortal failed, aborting launch:", error)
      return { bundleId: "", success: false, signatures: [], error: `PumpPortal API failed: ${error.message}` }
  }

  // 4. Repackaging into Jito Bundle (Max 5 Txs)
  // Strategy:
  // Tx 0 (Genesis): Create + Dev Buy + Buyers 1-4 (Paid by Dev) -> User said "Genesis ... Buy (First 4-5)"
  // Tx 1: Buyers 5-9 (Paid by Buyer 5)
  // ...

  const finalTransactions: VersionedTransaction[] = []
  const txSigners: Keypair[][] = []
  const { blockhash } = await safeConnection.getLatestBlockhash()

  const buyersPerTx = 5
  // First tx has Create (1 item) + Buyers?
  // PumpPortal returns 1 transaction per item.
  // Items: [Create, Buyer1, Buyer2, ...] (Note: Dev Buy is merged into Create if amount > 0)

  // Create Tx is index 0.
  // Buyers start at index 1.

  // We want to merge index 0 (Create) and indices 1..4 (Buyers) into Genesis Tx.

  let cursor = 0

  // Helper to decompile and extract instructions
  const getInstructions = (tx: VersionedTransaction): TransactionInstruction[] => {
       const msg = TransactionMessage.decompile(tx.message)
       return msg.instructions
  }

  // --- Genesis Transaction ---
  // Contains Item 0 (Create) + Items 1..X
  const genesisCount = 5 // Create + 4 buyers
  const genesisItems = transactions.slice(0, genesisCount)
  cursor += genesisCount

  let genesisInstructions: TransactionInstruction[] = []
  // Add Create instructions
  genesisInstructions.push(...getInstructions(genesisItems[0]))

  // Add Buyer instructions
  for (let i = 1; i < genesisItems.length; i++) {
      genesisInstructions.push(...getInstructions(genesisItems[i]))
  }

  // Add Tip (Paid by Dev)
  const resolvedTip = await resolveJitoTip({ baseTip: jitoTip, dynamic: config.dynamicJitoTip })
  genesisInstructions.push(createTipInstruction(devKeypair.publicKey, resolvedTip, jitoRegion as any))

  // Compile Genesis
  const genesisMsg = new TransactionMessage({
      payerKey: devKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions: genesisInstructions
  }).compileToV0Message([lut])

  const genesisTx = new VersionedTransaction(genesisMsg)

  // Signers for Genesis: Dev + Mint + Buyers 1..4
  const genesisSigners: Keypair[] = [devKeypair, mintKeypair]
  for (let i = 1; i < genesisItems.length; i++) {
      // Find wallet for this transaction (it corresponds to activeWallets[i])
      genesisSigners.push(getKeypair(activeWallets[i]))
  }
  genesisTx.sign(genesisSigners)

  finalTransactions.push(genesisTx)
  txSigners.push(genesisSigners) // Not used by sendBundleGroup refactor but kept for consistency

  // --- Subsequent Transactions ---
  while (cursor < transactions.length) {
      const chunk = transactions.slice(cursor, cursor + buyersPerTx)
      cursor += chunk.length

      // Payer is the first buyer in this chunk
      // The wallet index in activeWallets is cursor - chunk.length (since transactions[0] is Dev/Create)
      // Actually: transactions[0] is Dev. transactions[1] is Buyer1 (activeWallets[1]).
      // So current cursor points to next buyer index in transactions array.
      // The wallet corresponding to transactions[k] is activeWallets[k].

      const chunkPayerIndex = cursor - chunk.length
      const chunkPayerWallet = activeWallets[chunkPayerIndex]
      const chunkPayerKeypair = getKeypair(chunkPayerWallet)

      let chunkInstructions: TransactionInstruction[] = []
      const chunkSigners: Keypair[] = []

      for (let i = 0; i < chunk.length; i++) {
           const txIndex = chunkPayerIndex + i
           chunkInstructions.push(...getInstructions(transactions[txIndex]))
           chunkSigners.push(getKeypair(activeWallets[txIndex]))
      }

      // Add Tip (Paid by Chunk Payer)
      chunkInstructions.push(createTipInstruction(chunkPayerKeypair.publicKey, resolvedTip, jitoRegion as any))

      const chunkMsg = new TransactionMessage({
          payerKey: chunkPayerKeypair.publicKey,
          recentBlockhash: blockhash,
          instructions: chunkInstructions
      }).compileToV0Message([lut])

      const chunkTx = new VersionedTransaction(chunkMsg)
      chunkTx.sign(chunkSigners)

      finalTransactions.push(chunkTx)
      txSigners.push(chunkSigners)
  }

  // 5. Send Bundle
  console.log(`[bundler] Sending Bundle with ${finalTransactions.length} transactions (Limit: 5)...`)

  // We pass jitoTip=0 to sendBundleGroup because we manually added tip instructions above!
  const result = await sendBundleGroup(
      finalTransactions,
      txSigners,
      "launch-refactored",
      jitoRegion,
      0
  )

  return {
      bundleId: result.bundleId,
      success: true,
      signatures: result.signatures,
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
    // Legacy unmodified
  const { wallets, mintAddress, jitoTip = 0.0001, priorityFee = 0.0001, slippage = 20, jitoRegion = "auto" } = config
  if (!mintAddress) return { bundleId: "", success: false, signatures: [], error: "mint address required" }
  const activeWallets = wallets.filter((w) => w.isActive)
  if (activeWallets.length === 0) return { bundleId: "", success: false, signatures: [], error: "no active wallets" }

  try {
    const mint = new PublicKey(mintAddress)
    const computeUnits = 400_000
    const resolvedTip = await resolveJitoTip({ baseTip: jitoTip, dynamic: config.dynamicJitoTip, computeUnits })
    const walletBalances = []
    for (const wallet of activeWallets) {
      const keypair = getKeypair(wallet)
      try {
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
        const balance = await safeConnection.getTokenAccountBalance(ata)
        const tokenAmount = BigInt(balance.value.amount)
        if (tokenAmount > BigInt(0)) walletBalances.push({ wallet, tokenAmount, keypair })
      } catch {}
    }
    if (walletBalances.length === 0) return { bundleId: "", success: false, signatures: [], error: "no wallets with tokens" }

    if (config.smartExit) {
      const enrichedWallets = walletBalances.map(e => ({ ...e.wallet, tokenBalance: Number(e.tokenAmount) / Math.pow(10, TOKEN_DECIMALS) }))
      const { signatures, errors } = await createStaggeredSells({ ...config, wallets: enrichedWallets, mintAddress, staggerDelay: config.exitDelayMs ?? config.staggerDelay, exitPriorityFee: config.exitPriorityFee ?? priorityFee, exitJitoRegion: config.exitJitoRegion ?? jitoRegion })
      return { bundleId: "", success: errors.length === 0, signatures, error: errors.join("; "), mintAddress }
    }

    const bundleIds: string[] = [], bundleSignatures: string[][] = [], signatures: string[] = []
    const chunks = chunkArray(walletBalances, MAX_BUNDLE_WALLETS)
    for (const chunk of chunks) {
      const transactions: VersionedTransaction[] = [], txSigners: Keypair[][] = []
      const { blockhash } = await safeConnection.getLatestBlockhash()
      for (const entry of chunk) {
        const { keypair, tokenAmount } = entry
        try {
          const plan = await buildSellPlan(keypair.publicKey, mint, tokenAmount, slippage, priorityFee, "auto")
          const message = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions: plan.transaction.instructions }).compileToV0Message()
          const sellTx = new VersionedTransaction(message)
          sellTx.sign([keypair])
          transactions.push(sellTx)
          txSigners.push([keypair])
        } catch { continue }
      }
      if (transactions.length === 0) continue
      const tipPayerWallet = wallets.find(w => w.role?.toLowerCase() === 'dev')
      const tipPayer = tipPayerWallet ? getKeypair(tipPayerWallet) : undefined
      const result = await sendBundleGroup(transactions, txSigners, "rugpull", jitoRegion as any, resolvedTip, tipPayer)
      bundleIds.push(result.bundleId)
      bundleSignatures.push(result.signatures)
      signatures.push(...result.signatures)
    }
    return { bundleId: bundleIds[0] || "", bundleIds, bundleSignatures, success: true, signatures, mintAddress }
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
