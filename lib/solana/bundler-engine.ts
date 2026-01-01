import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
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
  calculateSellAmount,
  getBondingCurveData,
} from "./pumpfun-sdk"
import {
  createBuyInstruction,
  createSellInstruction,
  createPumpFunCreateInstruction as createCreateTokenInstruction,
} from "./pumpfun"
import { buildSellPlan } from "./sell-plan"
import { sendBundle, createTipInstruction, JitoRegion, JITO_ENDPOINTS } from "./jito"
import bs58 from "bs58"
import {
  STAGGER_RETRY_ATTEMPTS,
  STAGGER_RETRY_BASE_MS,
  STAGGER_RETRY_JITTER_MS,
} from "@/lib/config/limits"

// max transactions per Jito bundle (hard limit)
export const MAX_BUNDLE_WALLETS = 5

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

async function sendBundleGroup(
  transactions: Transaction[],
  txSigners: Keypair[][],
  label: string,
  jitoRegion: JitoRegion | "auto",
  jitoTip: number
): Promise<{ bundleId: string; signatures: string[] }> {
  if (jitoTip > 0 && transactions.length > 0) {
    const lastIdx = transactions.length - 1
    const lastTx = transactions[lastIdx]
    const lastSigner = txSigners[lastIdx]?.[0]
    if (lastSigner) {
      lastTx.add(createTipInstruction(lastSigner.publicKey, jitoTip))
      lastTx.sign(...txSigners[lastIdx])
    } else {
      console.warn("[bundler] missing signer for last tx (tip not added)")
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

async function sendBundleWithRetry(
  transactions: Transaction[],
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
    website?: string
    twitter?: string
    telegram?: string
    imageUrl?: string
  }
  devBuyAmount?: number
  // buy/sell amounts
  buyAmounts?: number[] // SOL per wallet
  sellPercentages?: number[] // % per wallet (100 = sell all)
  // timing
  staggerDelay?: { min: number; max: number }
  // fees
  jitoTip?: number
  priorityFee?: number
  slippage?: number
  // jito
  // "auto" will try all regions with retries
  jitoRegion?: JitoRegion | "auto"
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
  const chunks = chunkArray(wallets, 100) // RPC limit is 100 accounts per call
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
): Promise<string> {
  const instructions: TransactionInstruction[] = []

  wallets.forEach((wallet, i) => {
    const amount = amounts[i] || amounts[0] || 0.01
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

  const transaction = new Transaction()
  transaction.add(...instructions)

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.lastValidBlockHeight = lastValidBlockHeight
  transaction.feePayer = funder.publicKey

  transaction.sign(funder)

  const signature = await connection.sendRawTransaction(transaction.serialize())
  await connection.confirmTransaction(signature, "confirmed")

  return signature
}

/**
 * collect SOL from wallets back to funder
 */
export async function collectSol(
  wallets: BundlerWallet[],
  recipient: PublicKey
): Promise<string[]> {
  const signatures: string[] = []

  for (const wallet of wallets) {
    try {
      const keypair = getKeypair(wallet)
      const balance = await connection.getBalance(keypair.publicKey)

      // leave some for rent
      const sendAmount = balance - 5000

      if (sendAmount <= 0) continue

      const transaction = new Transaction()
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipient,
          lamports: sendAmount,
        })
      )

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      transaction.recentBlockhash = blockhash
      transaction.lastValidBlockHeight = lastValidBlockHeight
      transaction.feePayer = keypair.publicKey

      transaction.sign(keypair)

      const signature = await connection.sendRawTransaction(transaction.serialize())
      signatures.push(signature)
    } catch (error) {
      console.error(`error collecting from ${wallet.publicKey}:`, error)
    }
  }

  return signatures
}

/**
 * add priority fee and compute budget instructions
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
 * create launch bundle - create token + bundled buys
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
    // generate mint keypair
    const mintKeypair = Keypair.generate()
    const mint = mintKeypair.publicKey

    // dev wallet (first wallet)
    const devWallet = activeWallets[0]
    const devKeypair = getKeypair(devWallet)

    const bundleIds: string[] = []
    const bundleSignatures: string[][] = []
    const signatures: string[] = []
    const safeSlippage = Math.min(Math.max(Math.floor(slippage), 0), 99)
    // NOTE: Do not use LUT with Jito bundles.
    // transaction 1: create token + dev buy (+ tip)
    const createTx = new Transaction()

    // create token instruction
    const createIx = await createCreateTokenInstruction(
      devKeypair.publicKey,
      mintKeypair.publicKey,
      tokenMetadata.name,
      tokenMetadata.symbol,
      tokenMetadata.metadataUri
    )

    const initialCurve = await getInitialCurve()
    if (!initialCurve) {
      throw new Error("pump.fun global state unavailable")
    }
    // dev buy instruction (amount in tokens, cap in lamports)
    const devSolAmountLamports = BigInt(Math.floor(devBuyAmount * LAMPORTS_PER_SOL))
    const { tokensOut: devTokensOut } = calculateBuyAmount(
      {
        ...initialCurve,
        complete: false,
        creator: devKeypair.publicKey,
      },
      devBuyAmount,
    )
    const devMinTokensOut = (devTokensOut * BigInt(100 - safeSlippage)) / BigInt(100)
    const devBuyIx = await createBuyInstruction(
      devKeypair.publicKey,
      mint,
      devMinTokensOut,
      devSolAmountLamports,
      devKeypair.publicKey,
    )

    // dev ATA (idempotent)
    const devAta = await getAssociatedTokenAddress(mint, devKeypair.publicKey, false)
    const devAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      devKeypair.publicKey,
      devAta,
      devKeypair.publicKey,
      mint
    )

    const createInstructions = addPriorityFeeInstructions(
      [createIx, devAtaIx, devBuyIx],
      priorityFee
    )

    const { blockhash: createBh } = await connection.getLatestBlockhash()
    createTx.add(...createInstructions)
    createTx.recentBlockhash = createBh
    createTx.feePayer = devKeypair.publicKey
    createTx.sign(devKeypair, mintKeypair)

    const firstBundleTxs: Transaction[] = [createTx]
    const firstBundleSigners: Keypair[][] = [[devKeypair, mintKeypair]]
    const firstBundleCount = Math.min(activeWallets.length, MAX_BUNDLE_WALLETS)

    for (let i = 1; i < firstBundleCount; i++) {
      const wallet = activeWallets[i]
      const keypair = getKeypair(wallet)
      const buyAmount = resolveLaunchBuyAmount(i, devBuyAmount, buyAmounts as number[])

      const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
      const ataIx = createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey,
        ata,
        keypair.publicKey,
        mint
      )

      const { tokensOut } = calculateBuyAmount(
        {
          ...initialCurve,
          complete: false,
          creator: devKeypair.publicKey,
        },
        buyAmount,
      )
      const minTokensOut = (tokensOut * BigInt(100 - safeSlippage)) / BigInt(100)
      const solAmountLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL))
      const buyIx = await createBuyInstruction(
        keypair.publicKey,
        mint,
        minTokensOut,
        solAmountLamports,
        devKeypair.publicKey
      )

      const buyInstructions = addPriorityFeeInstructions([ataIx, buyIx], priorityFee)
      const { blockhash } = await connection.getLatestBlockhash()
      const buyTx = new Transaction()
      buyTx.add(...buyInstructions)
      buyTx.recentBlockhash = blockhash
      buyTx.feePayer = keypair.publicKey
      buyTx.sign(keypair)
      firstBundleTxs.push(buyTx)
      firstBundleSigners.push([keypair])
    }

    const firstResult = await sendBundleGroup(
      firstBundleTxs,
      firstBundleSigners,
      "launch",
      jitoRegion as any,
      jitoTip
    )
    bundleIds.push(firstResult.bundleId)
    bundleSignatures.push(firstResult.signatures)
    signatures.push(...firstResult.signatures)

    const remainingWallets = activeWallets.slice(firstBundleCount)
    if (remainingWallets.length > 0) {
      const chunks = chunkArray(remainingWallets, MAX_BUNDLE_WALLETS)
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex]
        const bondingCurve = await getBondingCurveData(mint)
        if (!bondingCurve) {
          throw new Error("token not found on pump.fun")
        }
        const bundleTxs: Transaction[] = []
        const bundleSigners: Keypair[][] = []
        for (let i = 0; i < chunk.length; i++) {
          const wallet = chunk[i]
          const keypair = getKeypair(wallet)
          const globalIndex = firstBundleCount + chunkIndex * MAX_BUNDLE_WALLETS + i
          const buyAmount = resolveLaunchBuyAmount(globalIndex, devBuyAmount, buyAmounts as number[])

          const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
          const ataIx = createAssociatedTokenAccountIdempotentInstruction(
            keypair.publicKey,
            ata,
            keypair.publicKey,
            mint
          )

          const { tokensOut } = calculateBuyAmount(bondingCurve, buyAmount)
          const minTokensOut = (tokensOut * BigInt(100 - safeSlippage)) / BigInt(100)
          const solAmountLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL))
          const buyIx = await createBuyInstruction(
            keypair.publicKey,
            mint,
            minTokensOut,
            solAmountLamports,
            bondingCurve.creator
          )

          const buyInstructions = addPriorityFeeInstructions([ataIx, buyIx], priorityFee)
          const { blockhash } = await connection.getLatestBlockhash()
          const buyTx = new Transaction()
          buyTx.add(...buyInstructions)
          buyTx.recentBlockhash = blockhash
          buyTx.feePayer = keypair.publicKey
          buyTx.sign(keypair)
          bundleTxs.push(buyTx)
          bundleSigners.push([keypair])
        }

        const bundleResult = await sendBundleGroup(
          bundleTxs,
          bundleSigners,
          "launch-followup",
          jitoRegion as any,
          jitoTip
        )
        bundleIds.push(bundleResult.bundleId)
        bundleSignatures.push(bundleResult.signatures)
        signatures.push(...bundleResult.signatures)
      }
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
 * create buy bundle - bundled buys on existing token
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
      const bondingCurve = chunkIndex === 0 ? initialCurve : await getBondingCurveData(mint)
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

      const result = await sendBundleGroup(
        transactions,
        txSigners,
        "buy",
        jitoRegion,
        jitoTip
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
 * create sell bundle - bundled sells
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

      const result = await sendBundleGroup(
        transactions,
        txSigners,
        "sell",
        jitoRegion,
        jitoTip
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
 * create staggered buy transactions (not bundled, with delays)
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
      const delay = Math.random() * (staggerDelay.max - staggerDelay.min) + staggerDelay.min
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  return { signatures, errors }
}

/**
 * create staggered sell transactions (not bundled, with delays)
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
    priorityFee = 0.0001,
    slippage = 20,
  } = config

  if (!mintAddress) {
    return { signatures: [], errors: ["mint address required"] }
  }

  const activeWallets = wallets.filter((w) => w.isActive && w.tokenBalance > 0)
  const signatures: string[] = []
  const errors: string[] = []

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
            priorityFee
          )
        } else {
          const { solOut } = calculateSellAmount(bondingCurve, tokenAmountRaw)
          minSolOut = (solOut * BigInt(100 - slippage)) / BigInt(100)
          sellTx = new Transaction()
          const sellIx = await createSellInstruction(keypair.publicKey, mint, tokenAmountRaw, minSolOut)
          const instructions = addPriorityFeeInstructions([sellIx], priorityFee)
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
 * create rugpull bundle - sells ALL tokens from ALL wallets via Jito bundle
 * gets real token balances from RPC and sells 100% from each wallet with tokens
 * NOW INCLUDES: sequential profit calculation with price impact accounting
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

    const profitData = await calculateBundlerRugpullProfit(
      mint,
      walletBalances.map(w => ({
        walletAddress: w.wallet.publicKey,
        tokenAmount: w.tokenAmount
      }))
    )

    const bundleCount = Math.ceil(walletBalances.length / MAX_BUNDLE_WALLETS)
    const estimatedGasFee = BigInt(Math.floor(priorityFee * LAMPORTS_PER_SOL * walletBalances.length))
    const estimatedJitoTip = BigInt(Math.floor(jitoTip * LAMPORTS_PER_SOL * bundleCount))
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

      const result = await sendBundleGroup(
        transactions,
        txSigners,
        "rugpull",
        jitoRegion as any,
        jitoTip
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
 * estimate bundle costs
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
  const fees = walletCount * 0.00005 + jitoTip + priorityFee * walletCount // rough estimate

  const perWallet = buyAmounts.map((amount, i) => {
    const buy = amount || buyAmounts[0] || 0.01
    return buy + 0.003 // buy amount + ATA rent + fees
  })

  const totalSol = perWallet.reduce((sum, amount) => sum + amount, 0) + jitoTip + fees

  return {
    totalSol,
    perWallet,
    jitoTip,
    fees,
  }
}
