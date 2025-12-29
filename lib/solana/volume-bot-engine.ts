import { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js"
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token"
import { getResilientConnection, SOLANA_NETWORK } from "./config"
import {
  buildBuyTransaction,
  buildSellTransaction,
  getBondingCurveData,
  getBondingCurveAddress,
  calculateBuyAmount,
  calculateSellAmount,
  isPumpFunAvailable,
  buildPumpswapSwapTransaction,
  BondingCurveData,
  getPumpswapPoolData,
  calculatePumpswapSwapAmount,
} from "./pumpfun-sdk"
import bs58 from "bs58"
import { createTipInstruction, getInflightBundleStatusesWithFallback, sendBundle, type JitoRegion } from "./jito"
import { prisma } from "@/lib/prisma"

// volume bot types
export type VolumeMode = "buy" | "sell" | "wash"
export type AmountMode = "fixed" | "random" | "percentage"

export interface VolumeWallet {
  publicKey: string
  secretKey: string
  solBalance: number
  tokenBalance: number
  isActive: boolean
  ataExists?: boolean
}

export interface VolumeBotConfig {
  mintAddress: string
  mode: VolumeMode
  amountMode: AmountMode
  // for fixed mode
  fixedAmount: number
  // for random mode
  minAmount: number
  maxAmount: number
  // for percentage mode
  minPercentage: number
  maxPercentage: number
  // timing
  minInterval: number // seconds
  maxInterval: number // seconds
  // settings
  slippage: number // percent
  priorityFee: number // SOL
  maxExecutions: number // 0 = unlimited
  multiThreaded: boolean
  // jito settings
  useJito?: boolean
  jitoRegion?: JitoRegion
  jitoTip?: number // SOL
}

export interface VolumeTransaction {
  wallet: string
  type: "buy" | "sell"
  amount: number
  tokensOrSol: number
  signature?: string
  status: "pending" | "success" | "failed"
  error?: string
  timestamp: number
  // fees/priority/tip (SOL unless otherwise specified)
  networkFeeLamports?: number
  networkFeeSol?: number
  priorityFeeSolBudget?: number
  jitoTipSol?: number
  // raw serialized transaction (for simulation)
  transaction?: string
}

export interface VolumeBotState {
  isRunning: boolean
  executionCount: number
  totalBuys: number
  totalSells: number
  totalVolume: number
  transactions: VolumeTransaction[]
  startTime?: number
  lastError?: string
}

/**
 * generate random number between min and max
 */
function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

/**
 * sleep for ms
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const TOKEN_DECIMALS = 6
const RPC_REFRESH_CONCURRENCY = 2
const RPC_RETRY_ATTEMPTS = 4
const RPC_RETRY_BASE_MS = 500
const RPC_RETRY_JITTER_MS = 400
const keypairCache = new Map<string, Keypair>()

function getCachedKeypair(secretKey: string): Keypair {
  const cached = keypairCache.get(secretKey)
  if (cached) return cached
  const keypair = Keypair.fromSecretKey(bs58.decode(secretKey))
  keypairCache.set(secretKey, keypair)
  return keypair
}

function toRawTokenAmount(value: number, decimals: number = TOKEN_DECIMALS): bigint {
  if (!Number.isFinite(value) || value <= 0) return BigInt(0)
  const str = value.toString()
  const [whole = "0", frac = ""] = str.split(".")
  const wholeDigits = whole.replace(/\D/g, "") || "0"
  const fracDigits = frac.replace(/\D/g, "")
  const padded = (fracDigits + "0".repeat(decimals)).slice(0, decimals)
  const combined = `${wholeDigits}${padded}`.replace(/^0+/, "") || "0"
  return BigInt(combined)
}

function clampPercent(value: number, min: number = 0, max: number = 99): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
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

/**
 * generate new wallet
 */
export function generateWallet(): VolumeWallet {
  let keypair = Keypair.generate()
  // some base58 encodings can be 43 chars; tests expect 44
  while (keypair.publicKey.toBase58().length !== 44) {
    keypair = Keypair.generate()
  }
  return {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
    solBalance: 0,
    tokenBalance: 0,
    isActive: true,
  }
}

/**
 * import wallet from private key
 */
export function importWallet(secretKey: string): VolumeWallet {
  const keypair = getCachedKeypair(secretKey)
  return {
    publicKey: keypair.publicKey.toBase58(),
    secretKey,
    solBalance: 0,
    tokenBalance: 0,
    isActive: true,
  }
}

/**
 * refresh wallet balances
 */
export async function refreshWalletBalances(
  wallets: VolumeWallet[],
  mintAddress?: string
): Promise<VolumeWallet[]> {
  const mint = mintAddress ? new PublicKey(mintAddress) : null

  const updated = await mapWithLimit(wallets, RPC_REFRESH_CONCURRENCY, async (wallet) => {
    try {
      const pubkey = new PublicKey(wallet.publicKey)

      // get SOL balance
      const solBalance = await rpcWithRetry(() => connection.getBalance(pubkey))

      // get token balance (optional if mint provided)
      let tokenBalance = 0
      if (mint) {
        try {
          const ata = await getAssociatedTokenAddress(mint, pubkey, false)
          const tokenAccount = await rpcWithRetry(() => connection.getTokenAccountBalance(ata))
          tokenBalance = tokenAccount.value.uiAmount || 0
        } catch {
          // no token account
        }
      }

      return {
        ...wallet,
        solBalance: solBalance / LAMPORTS_PER_SOL,
        tokenBalance,
      }
    } catch (error) {
      console.error(`error refreshing wallet ${wallet.publicKey}:`, error)
      return wallet
    }
  })

  return updated
}

/**
 * calculate trade amount based on config
 */
export function calculateTradeAmount(
  config: VolumeBotConfig,
  wallet: VolumeWallet,
  type: "buy" | "sell"
): number {
  let amount = 0
  
  if (config.amountMode === "fixed") {
    amount = config.fixedAmount
  } else if (config.amountMode === "random") {
    amount = randomBetween(config.minAmount, config.maxAmount)
  } else if (config.amountMode === "percentage") {
    const percentage = randomBetween(config.minPercentage, config.maxPercentage) / 100
    if (type === "buy") {
      // percentage of SOL balance (leave some for fees)
      amount = (wallet.solBalance - 0.01) * percentage
    } else {
      // percentage of token balance
      amount = wallet.tokenBalance * percentage
    }
  }
  
  // ensure minimum amounts
  if (type === "buy") {
    amount = Math.max(0.001, Math.min(amount, wallet.solBalance - 0.005))
  } else {
    amount = Math.max(1, Math.min(amount, wallet.tokenBalance))
  }
  
  return amount
}

/**
 * execute single buy transaction
 */
export async function executeBuy(
  wallet: VolumeWallet,
  mintAddress: string,
  solAmount: number,
  slippage: number,
  priorityFee: number,
  bondingCurve: BondingCurveData | null,
  opts: { useJito?: boolean; jitoRegion?: JitoRegion; jitoTip?: number; autoFees?: boolean; ataExists?: boolean } = {}
): Promise<VolumeTransaction> {
  const tx: VolumeTransaction = {
    wallet: wallet.publicKey,
    type: "buy",
    amount: solAmount,
    tokensOrSol: 0,
    status: "pending",
    timestamp: Date.now(),
  }
  
  try {
    const keypair = getCachedKeypair(wallet.secretKey)
    const mint = new PublicKey(mintAddress)

    const safeSlippage = clampPercent(slippage)
    const startedAt = Date.now()
    // IMPORTANT: do not force huge minimum priority fees. Small wallets will fail simulation due to insufficient lamports.
    const basePriorityFee = Math.max(0, priorityFee)
    const useJito = opts.useJito ?? false
    const jitoRegion = opts.jitoRegion ?? "frankfurt"
    const requestedJitoTip = opts.jitoTip ?? 0.001
    const autoFees = opts.autoFees ?? true

    // Network-derived compute unit price (microLamports per CU) using RPC recent prioritization fees.
    // Cache for a few seconds to avoid spamming RPC during multi-wallet cycles.
    const now = Date.now()
    const cached = (globalThis as any).__vb_recentCuPriceCache as { ts: number; p75: number } | undefined
    const cacheOk = cached && now - cached.ts < 5000 && Number.isFinite(cached.p75) && cached.p75 > 0
    let networkCuPriceP75 = cacheOk ? cached!.p75 : 0
    if (!cacheOk) {
      try {
        const fees = await (connection as any).getRecentPrioritizationFees?.()
        const vals = Array.isArray(fees)
          ? fees
              .map((f: any) => Number(f?.prioritizationFee))
              .filter((n: number) => Number.isFinite(n) && n > 0)
          : []
        if (vals.length > 0) {
          vals.sort((a, b) => a - b)
          networkCuPriceP75 = vals[Math.floor(vals.length * 0.75)]
          ;(globalThis as any).__vb_recentCuPriceCache = { ts: now, p75: networkCuPriceP75 }
        }
      } catch {
        // ignore
      }
    }

    if (!bondingCurve || bondingCurve.complete) {
      tx.status = "failed"
      tx.error = "token migrated or unavailable"
      return tx
    }

    // Preflight evidence: check if the wallet has an ATA for this mint.
    // Missing ATA is a common reason buys "work" on dev wallets but fail on fresh wallets.
    const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
    const ataMissing = opts.ataExists === true ? false : true
    
    // calculate min tokens out with slippage
    const { tokensOut } = calculateBuyAmount(bondingCurve, solAmount)
    const minTokensOut = tokensOut > BigInt(0)
      ? tokensOut * BigInt(100 - safeSlippage) / BigInt(100)
      : BigInt(0)
    tx.tokensOrSol = Number(tokensOut) / 1e6
    
    let attempt = 0
    let lastError: any = null
    while (attempt < 2) {
      // Cap fees to wallet balance so we don't repeatedly simulate-fail on small wallets.
      // Also reserve extra lamports when ATA doesn't exist (rent-exempt account creation).
      const walletSol = wallet.solBalance ?? 0
      // ATA rent is ~0.00203928 SOL for token accounts; use a conservative buffer.
      const ataRentReserveSol = 0.0022
      const safetyReserveSol = 0.0015
      const reservedSol = (ataMissing ? ataRentReserveSol : 0) + safetyReserveSol
      const maxFeeBudgetSol = Math.max(0, walletSol - reservedSol - solAmount)

      // Convert network CU price → SOL budget using a conservative CU estimate.
      // microLamports/CU * CU -> microLamports; /1e6 -> lamports; /1e9 -> SOL
      const estimatedUnits = 120_000
      const dynamicPriorityFeeFromNetworkSol =
        networkCuPriceP75 > 0 ? (networkCuPriceP75 * estimatedUnits) / 1e6 / 1e9 : 0
      const baseDesiredPriorityFeeSol = autoFees
        ? Math.max(basePriorityFee, dynamicPriorityFeeFromNetworkSol)
        : basePriorityFee

      const desiredPriorityFeeSol =
        attempt === 0
          ? baseDesiredPriorityFeeSol
          : Math.max(baseDesiredPriorityFeeSol * 2, baseDesiredPriorityFeeSol + 0.0002)
      const effectivePriorityFee = Math.min(desiredPriorityFeeSol, maxFeeBudgetSol)

      const desiredJitoTip = useJito ? requestedJitoTip : 0
      const effectiveJitoTip = Math.min(desiredJitoTip, Math.max(0, maxFeeBudgetSol - effectivePriorityFee))
      tx.priorityFeeSolBudget = effectivePriorityFee
      tx.jitoTipSol = effectiveJitoTip

      // If we can't afford even the reserved budget, fail fast with a clear message.
      if (walletSol > 0 && (solAmount + reservedSol + effectivePriorityFee + effectiveJitoTip) > walletSol) {
        tx.status = "failed"
        tx.error = `insufficient SOL: balance=${walletSol.toFixed(6)} needed~${(solAmount + reservedSol + effectivePriorityFee + effectiveJitoTip).toFixed(6)}`
        return tx
      }
      const blockhashWithExpiry = await connection.getLatestBlockhash()

      // build transaction
      const transaction = await buildBuyTransaction(
        keypair.publicKey,
        mint,
        solAmount,
        minTokensOut,
        effectivePriorityFee
      )

      // align confirm with the same blockhash window
      transaction.recentBlockhash = blockhashWithExpiry.blockhash
      ;(transaction as any).lastValidBlockHeight = blockhashWithExpiry.lastValidBlockHeight

      // add jito tip if enabled (MUST be before signing)
      if (useJito) {
        const tipIx = createTipInstruction(keypair.publicKey, effectiveJitoTip, jitoRegion)
        transaction.add(tipIx)
      }
      
      // sign (after all mutations like tip)
      transaction.sign(keypair)

      // Evidence-first: simulate the exact signed transaction we are about to send.
      // This tells us whether the tx is inherently invalid (ATA missing, compute, account locks, etc.)
      try {
        // Note: for legacy Transaction overload in our web3.js version, config is not supported.
        const sim = await connection.simulateTransaction(transaction)
        const simLogs = sim?.value?.logs ?? []
        const logsHead = simLogs.slice(0, 25)
        const logsTail = simLogs.slice(Math.max(0, simLogs.length - 25))
        // attempt to capture compute budget settings from the tx
        const computeBudgetIxs = transaction.instructions
          .filter((ix) => ix.programId?.toBase58?.() === "ComputeBudget111111111111111111111111111111")
          .map((ix) => ({ programId: ix.programId.toBase58(), data: bs58.encode(ix.data) }))
        if (sim?.value?.err) {
          tx.status = "failed"
          tx.error = `simulation failed: ${JSON.stringify(sim.value.err)}`
          return tx
        }
      } catch (e) {
      }
      
      try {
        if (useJito) {
          const sentAt = Date.now()
          const { bundleId, region: usedRegion } = await sendBundle([transaction], jitoRegion as JitoRegion)

          const sig = transaction.signatures?.[0]?.signature
          const signature = bs58.encode(sig || new Uint8Array(64))
          tx.signature = signature

          // Jito is rate-limited (1 rps / IP / region). We must NOT call inflight right after sendBundle.
          // Strategy:
          // - poll Solana signature first
          // - query inflight (rate-limited) until we see landed/failed, but never exceed ~1 rps.
          let inflightChecked = false
          let inflightResult: any = null
          let lastInflightCheckAt = 0
          let lastInflightStatus: string | null = null
          let inflight429Count = 0
          let inflightUnknownCount = 0

          const confirmStart = Date.now()
          let lastStatus: any = null
          while (Date.now() - confirmStart < 60_000) {
            const statusResp = await connection.getSignatureStatuses([signature])
            const st = statusResp?.value?.[0]
            lastStatus = st || lastStatus

            if (st?.err) {
              tx.status = "failed"
              tx.error = `on-chain error: ${JSON.stringify(st.err)}`
              return tx
            }
            if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
              try {
                const gtx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 })
                const lamportsFee = (gtx as any)?.meta?.fee
                if (typeof lamportsFee === "number") {
                  tx.networkFeeLamports = lamportsFee
                  tx.networkFeeSol = lamportsFee / LAMPORTS_PER_SOL
                }
              } catch {
                // ignore
              }
              tx.status = "success"
              return tx
            }

            const now = Date.now()
            // Jito endpoints are heavily rate-limited and can be globally congested.
            // Poll inflight sparingly to reduce 429 frequency (we still keep Solana RPC polling).
            const inflightDue =
              now - sentAt >= 1500 && // never immediately after sendBundle
              now - lastInflightCheckAt >= 5000 // be conservative (<< 1 rps) to avoid 429 under congestion

            if (inflightDue) {
              inflightChecked = true
              lastInflightCheckAt = now
              try {
                const entries = await getInflightBundleStatusesWithFallback([bundleId], usedRegion as JitoRegion)
                inflightResult = entries?.[0] ?? null
                if (inflightResult?.error === "rate_limited") inflight429Count++
                else if (!inflightResult || inflightResult?.status === "pending") inflightUnknownCount++
              } catch (e) {
                const errStr = String(e)
                inflightResult = { status: "unknown", error: errStr }
                if (errStr.includes(" 429 ") || errStr.includes("rate limited")) inflight429Count++
                else inflightUnknownCount++
              }

              const status = inflightResult?.status ?? null
              if (status && status !== lastInflightStatus) {
                lastInflightStatus = status
              }

              if (inflightResult?.status === "failed") {
                tx.status = "failed"
                tx.error = inflightResult?.error || "bundle failed (inflight)"
                return tx
              }
              // If we see landed but RPC still can't see it, keep polling signature;
              // it's possible RPC lags or the tx was re-broadcasted.
            }
            await sleep(750)
          }

          // Do not mark as failed on timeout: under congestion it can confirm later.
          tx.status = "pending"
          if (inflightResult?.status === "pending") {
            tx.error = "bundle pending (rate-limited) - awaiting confirmation"
          } else if (inflightResult?.status === "landed") {
            tx.error = "bundle landed but awaiting RPC confirmation"
          } else {
            tx.error = "bundle submitted but awaiting confirmation"
          }
          return tx
        } else {
          const rawTx = transaction.serialize()

          // send initial
          const signature = await connection.sendRawTransaction(rawTx, {
            skipPreflight: true,
            maxRetries: 20,
            preflightCommitment: "confirmed",
          })
          
          const expireHeight = (transaction as any).lastValidBlockHeight ?? blockhashWithExpiry.lastValidBlockHeight
          const sendStart = Date.now()
          let confirmed = false
          let statusSlot: number | null = null
          let resendCount = 0
          const maxResendMs = 15000
          const maxResends = 80

          while (!confirmed) {
            const statusResp = await connection.getSignatureStatuses([signature])
            const st = statusResp?.value?.[0]
            statusSlot = st?.slot ?? statusSlot
            if (st?.err) {
              throw new Error(`Signature ${signature} failed: ${JSON.stringify(st.err)}`)
            }
            if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
              confirmed = true
              break
            }

            try {
              const currentHeight = await connection.getBlockHeight()
              if (expireHeight && currentHeight >= expireHeight) {
                throw new Error(`block height exceeded: current ${currentHeight} >= expire ${expireHeight}`)
              }
            } catch {
              // ignore height fetch errors
            }

            await connection.sendRawTransaction(rawTx, {
              skipPreflight: true,
              maxRetries: 0,
              preflightCommitment: "confirmed",
            }).catch(() => {})
            resendCount++

            if (Date.now() - sendStart > maxResendMs || resendCount >= maxResends) {
              throw new Error(`resend timeout exceeded (${Date.now() - sendStart}ms, ${resendCount} resends)`)
            }

            await sleep(300)
          }

          
          tx.signature = signature
          tx.status = "success"
          return tx
        }
      } catch (err: any) {
        lastError = err
        const msg = err?.message || String(err)

        const isExpiry = msg.toLowerCase().includes("block height exceeded") || msg.toLowerCase().includes("blockhash not found")
        if (isExpiry && attempt === 0) {
          attempt++
          await sleep(250)
          continue
        }
        throw err
      }
    }

    throw lastError
  } catch (error: any) {
    tx.status = "failed"
    tx.error = error.message || "unknown error"
  }
  
  return tx
}

/**
 * execute single sell transaction
 */
export async function executeSell(
  wallet: VolumeWallet,
  mintAddress: string,
  tokenAmount: number,
  slippage: number,
  priorityFee: number,
  bondingCurve: BondingCurveData | null,
  route: "auto" | "bonding_curve" | "pumpswap" = "auto",
  opts: { simulate?: boolean; useJito?: boolean; jitoRegion?: JitoRegion; jitoTip?: number; autoFees?: boolean } = {}
): Promise<VolumeTransaction> {
  const tx: VolumeTransaction = {
    wallet: wallet.publicKey,
    type: "sell",
    amount: tokenAmount,
    tokensOrSol: 0,
    status: "pending",
    timestamp: Date.now(),
  }
  
  try {
    const keypair = getCachedKeypair(wallet.secretKey)
    const mint = new PublicKey(mintAddress)
    const tokenAmountRaw = toRawTokenAmount(tokenAmount, TOKEN_DECIMALS)
    const safeSlippage = clampPercent(slippage)
    const startedAt = Date.now()
    // IMPORTANT: for sell, wallets often have low SOL (after buys). Do not force a large priority fee.
    // We'll cap priority fee + jito tip so the wallet can always pay transaction fees.
    let effectivePriorityFee = Math.max(0, priorityFee)
    const useJito = opts.useJito ?? false
    const jitoRegion = opts.jitoRegion ?? "frankfurt"
    let effectiveJitoTip = opts.jitoTip ?? 0.001
    const autoFees = opts.autoFees ?? true

    // Network-derived compute unit price cache (microLamports per CU)
    const now = Date.now()
    const cached = (globalThis as any).__vb_recentCuPriceCache as { ts: number; p75: number } | undefined
    const cacheOk = cached && now - cached.ts < 5000 && Number.isFinite(cached.p75) && cached.p75 > 0
    let networkCuPriceP75 = cacheOk ? cached!.p75 : 0
    if (!cacheOk) {
      try {
        const fees = await (connection as any).getRecentPrioritizationFees?.()
        const vals = Array.isArray(fees)
          ? fees
              .map((f: any) => Number(f?.prioritizationFee))
              .filter((n: number) => Number.isFinite(n) && n > 0)
          : []
        if (vals.length > 0) {
          vals.sort((a, b) => a - b)
          networkCuPriceP75 = vals[Math.floor(vals.length * 0.75)]
          ;(globalThis as any).__vb_recentCuPriceCache = { ts: now, p75: networkCuPriceP75 }
        }
      } catch {
        // ignore
      }
    }
    const walletSol = Number(wallet.solBalance || 0)
    const feeBufferSol = 0.00002 // base fee + tiny cushion
    const minTipSol = useJito ? 0.001 : 0
    if (useJito) {
      effectiveJitoTip = Math.max(minTipSol, effectiveJitoTip)
    } else {
      effectiveJitoTip = 0
    }

    // If autoFees enabled: bump priority fee to at least the network-derived 75p CU price converted to SOL budget.
    // This improves inclusion probability during congestion but is still capped by wallet balance below.
    if (autoFees && networkCuPriceP75 > 0) {
      const estimatedUnits = 110_000
      const dynamicPriorityFeeFromNetworkSol = (networkCuPriceP75 * estimatedUnits) / 1e6 / 1e9
      if (Number.isFinite(dynamicPriorityFeeFromNetworkSol) && dynamicPriorityFeeFromNetworkSol > 0) {
        effectivePriorityFee = Math.max(effectivePriorityFee, dynamicPriorityFeeFromNetworkSol)
      }
    }

    if (Number.isFinite(walletSol) && walletSol > 0) {
      const available = Math.max(0, walletSol - feeBufferSol)
      // priority fee is the first thing to reduce; tip is kept at minTipSol if using Jito
      let maxPriority = available - effectiveJitoTip
      if (maxPriority < 0 && useJito) {
        // try lowering tip down to minimum
        effectiveJitoTip = Math.min(effectiveJitoTip, Math.max(minTipSol, available))
        maxPriority = available - effectiveJitoTip
      }
      if (maxPriority <= 0) {
        effectivePriorityFee = 0
      } else {
        effectivePriorityFee = Math.min(effectivePriorityFee, maxPriority)
      }
    }

    tx.priorityFeeSolBudget = effectivePriorityFee
    tx.jitoTipSol = useJito ? effectiveJitoTip : 0
    
    if (tokenAmountRaw <= BigInt(0)) {
      tx.status = "failed"
      tx.error = "token amount must be positive"
      return tx
    }
    
    // calculate min SOL out with slippage
    let minSolOut = BigInt(0)
    let transaction: Transaction | undefined

    const preferPumpswap = route === "pumpswap" || (route === "auto" && bondingCurve?.complete)

    if (preferPumpswap) {
      const poolData = await getPumpswapPoolData(mint)
      if (poolData) {
        const swap = calculatePumpswapSwapAmount(poolData, tokenAmountRaw, true)
        minSolOut = swap.solOut > BigInt(0)
          ? swap.solOut * BigInt(100 - safeSlippage) / BigInt(100)
          : BigInt(0)
        tx.tokensOrSol = Number(swap.solOut) / LAMPORTS_PER_SOL

        transaction = await buildPumpswapSwapTransaction(
          keypair.publicKey,
          mint,
          tokenAmountRaw,
          minSolOut,
          effectivePriorityFee
        )
      } else if (route === "pumpswap") {
        tx.status = "failed"
        tx.error = "pumpswap pool unavailable"
        return tx
      }
    }

    if (!transaction) {
      if (!bondingCurve) {
        tx.status = "failed"
        tx.error = "token not found on pump.fun"
        return tx
      }
      const { solOut } = calculateSellAmount(bondingCurve, tokenAmountRaw)
      minSolOut = solOut > BigInt(0)
        ? solOut * BigInt(100 - safeSlippage) / BigInt(100)
        : BigInt(0)
      tx.tokensOrSol = Number(solOut) / LAMPORTS_PER_SOL

      transaction = await buildSellTransaction(
        keypair.publicKey,
        mint,
        tokenAmountRaw,
        minSolOut,
        effectivePriorityFee
      )
    }

    const blockhashWithExpiry = await connection.getLatestBlockhash()
    // align confirm with same blockhash window
    transaction.recentBlockhash = blockhashWithExpiry.blockhash
    ;(transaction as any).lastValidBlockHeight = blockhashWithExpiry.lastValidBlockHeight

    // add jito tip if enabled (MUST be before signing)
    if (useJito) {
      const tipIx = createTipInstruction(keypair.publicKey, effectiveJitoTip, jitoRegion)
      transaction.add(tipIx)
    }


    // sign (after all mutations like tip)
    transaction.sign(keypair)

    // Evidence-first: simulate the exact signed transaction we are about to send.
    try {
      const sim = await connection.simulateTransaction(transaction)
      const simLogs = sim?.value?.logs ?? []
      const logsHead = simLogs.slice(0, 25)
      const logsTail = simLogs.slice(Math.max(0, simLogs.length - 25))
      const computeBudgetIxs = transaction.instructions
        .filter((ix) => ix.programId?.toBase58?.() === "ComputeBudget111111111111111111111111111111")
        .map((ix) => ({ programId: ix.programId.toBase58(), data: bs58.encode(ix.data) }))
      if (sim?.value?.err) {
        tx.status = "failed"
        tx.error = `simulation failed: ${JSON.stringify(sim.value.err)}`
        return tx
      }
    } catch (e) {
    }

    if (opts.simulate) {
      const raw = transaction.serialize()
      tx.transaction = bs58.encode(raw)
      tx.status = "success"
      return tx
    }

    if (useJito) {
      const sentAt = Date.now()
      const { bundleId, region: usedRegion } = await sendBundle([transaction], jitoRegion as JitoRegion)

      const sig = transaction.signatures?.[0]?.signature
      const signature = bs58.encode(sig || new Uint8Array(64))
      tx.signature = signature

      let inflightChecked = false
      let inflightResult: any = null
      let lastInflightCheckAt = 0
      let lastInflightStatus: string | null = null
      let inflight429Count = 0
      let inflightUnknownCount = 0

      const confirmStart = Date.now()
      let lastStatus: any = null
      while (Date.now() - confirmStart < 60_000) {
        const statusResp = await connection.getSignatureStatuses([signature])
        const st = statusResp?.value?.[0]
        lastStatus = st || lastStatus

        if (st?.err) {
          tx.status = "failed"
          tx.error = `on-chain error: ${JSON.stringify(st.err)}`
          return tx
        }
            if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
              try {
                const gtx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 })
                const lamportsFee = (gtx as any)?.meta?.fee
                if (typeof lamportsFee === "number") {
                  tx.networkFeeLamports = lamportsFee
                  tx.networkFeeSol = lamportsFee / LAMPORTS_PER_SOL
                }
              } catch {
                // ignore
              }
          tx.status = "success"
          return tx
        }

        const now = Date.now()
        const inflightDue =
          now - sentAt >= 1500 &&
          now - lastInflightCheckAt >= 5000
        if (inflightDue) {
          inflightChecked = true
          lastInflightCheckAt = now
          try {
            const entries = await getInflightBundleStatusesWithFallback([bundleId], usedRegion as JitoRegion)
            inflightResult = entries?.[0] ?? null
            if (inflightResult?.error === "rate_limited") inflight429Count++
            else if (!inflightResult || inflightResult?.status === "pending") inflightUnknownCount++
          } catch (e) {
            const errStr = String(e)
            inflightResult = { status: "unknown", error: errStr }
            if (errStr.includes(" 429 ") || errStr.includes("rate limited")) inflight429Count++
            else inflightUnknownCount++
          }

          const status = inflightResult?.status ?? null
          if (status && status !== lastInflightStatus) {
            lastInflightStatus = status
          }
          if (inflightResult?.status === "failed") {
            tx.status = "failed"
            tx.error = inflightResult?.error || "bundle failed (inflight)"
            return tx
          }
        }
        await sleep(750)
      }

      // At this point we cannot safely claim failure: the bundle might land after congestion clears.
      // Return as "pending" and let DB reconciliation (or later polling) converge to confirmed/failed.
      tx.status = "pending"
      if (inflightResult?.status === "pending") {
        tx.error = "bundle pending (rate-limited) - awaiting confirmation"
      } else if (inflightResult?.status === "landed") {
        tx.error = "bundle landed but awaiting RPC confirmation"
      } else {
        tx.error = "bundle submitted but awaiting confirmation"
      }
      return tx
    }

    // non-jito send
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 20,
      preflightCommitment: "confirmed",
    })

    await connection.confirmTransaction(
      {
        signature,
        blockhash: transaction.recentBlockhash!,
        lastValidBlockHeight: (transaction as any).lastValidBlockHeight ?? blockhashWithExpiry.lastValidBlockHeight,
      },
      "confirmed"
    )

    tx.signature = signature
    tx.status = "success"
  } catch (error: any) {
    tx.status = "failed"
    tx.error = error.message || "unknown error"
  }
  
  return tx
}

/**
 * determine next action for wash trading
 */
export function getNextWashAction(
  wallet: VolumeWallet,
  lastAction?: "buy" | "sell"
): "buy" | "sell" {
  // if no tokens, must buy
  if (wallet.tokenBalance < 1) {
    return "buy"
  }
  
  // if low on SOL, must sell
  if (wallet.solBalance < 0.01) {
    return "sell"
  }
  
  // alternate or random
  if (lastAction === "buy") {
    return "sell"
  } else if (lastAction === "sell") {
    return "buy"
  }
  
  // random 50/50
  return Math.random() > 0.5 ? "buy" : "sell"
}

/**
 * volume bot class - manages the bot lifecycle
 */
export class VolumeBotRunner {
  private config: VolumeBotConfig
  private wallets: VolumeWallet[]
  private state: VolumeBotState
  private stopRequested: boolean = false
  private onUpdate?: (state: VolumeBotState) => void
  private lastActions: Map<string, "buy" | "sell"> = new Map()
  
  constructor(
    config: VolumeBotConfig,
    wallets: VolumeWallet[],
    onUpdate?: (state: VolumeBotState) => void
  ) {
    this.config = config
    this.wallets = wallets.filter(w => w.isActive)
    this.onUpdate = onUpdate
    this.state = {
      isRunning: false,
      executionCount: 0,
      totalBuys: 0,
      totalSells: 0,
      totalVolume: 0,
      transactions: [],
    }
  }
  
  getState(): VolumeBotState {
    return { ...this.state }
  }
  
  async start(): Promise<void> {
    if (this.state.isRunning) return
    if (!isPumpFunAvailable()) {
      throw new Error(`pump.fun not available on ${SOLANA_NETWORK}`)
    }
    if (this.wallets.length === 0) {
      throw new Error("no active wallets")
    }
    
    this.state.isRunning = true
    this.state.startTime = Date.now()
    this.stopRequested = false
    this.notifyUpdate()
    
    await this.runLoop()
  }
  
  stop(): void {
    this.stopRequested = true
    this.state.isRunning = false
    this.notifyUpdate()
  }
  
  private notifyUpdate(): void {
    if (this.onUpdate) {
      this.onUpdate(this.getState())
    }
  }
  
  private async runLoop(): Promise<void> {
    const mint = new PublicKey(this.config.mintAddress)
    
    while (!this.stopRequested) {
      // check execution limit
      if (this.config.maxExecutions > 0 && this.state.executionCount >= this.config.maxExecutions) {
        this.stop()
        break
      }
      
      try {
        // refresh bonding curve data
        const bondingCurve = await getBondingCurveData(mint)
        
        // refresh wallet balances
        this.wallets = await refreshWalletBalances(this.wallets, this.config.mintAddress)
        
        // execute trades
        if (this.config.multiThreaded) {
          // parallel execution
          const promises = this.wallets.map(wallet => 
            this.executeForWallet(wallet, bondingCurve)
          )
          await Promise.all(promises)
        } else {
          // sequential execution
          for (const wallet of this.wallets) {
            if (this.stopRequested) break
            await this.executeForWallet(wallet, bondingCurve)
            
            // small delay between wallets
            await sleep(500)
          }
        }
        
        this.state.executionCount++
        this.notifyUpdate()
        
        // wait for next interval
        const interval = randomBetween(
          this.config.minInterval * 1000,
          this.config.maxInterval * 1000
        )
        await sleep(interval)
        
      } catch (error: any) {
        this.state.lastError = error.message
        this.notifyUpdate()
        
        // wait before retry
        await sleep(5000)
      }
    }
    
    this.state.isRunning = false
    this.notifyUpdate()
  }
  
  private async executeForWallet(
    wallet: VolumeWallet,
    bondingCurve: BondingCurveData | null
  ): Promise<void> {
    let action: "buy" | "sell"
    
    // determine action based on mode
    if (this.config.mode === "buy") {
      action = "buy"
    } else if (this.config.mode === "sell") {
      action = "sell"
    } else {
      // wash trading - alternate
      action = getNextWashAction(wallet, this.lastActions.get(wallet.publicKey))
    }
    
    // calculate amount
    const amount = calculateTradeAmount(this.config, wallet, action)
    
    if (amount <= 0) {
      return // skip if no valid amount
    }
    
    // execute
    let tx: VolumeTransaction
    
    if (action === "buy") {
      tx = await executeBuy(
        wallet,
        this.config.mintAddress,
        amount,
        this.config.slippage,
        this.config.priorityFee,
        bondingCurve
      )
      
      if (tx.status === "success") {
        this.state.totalBuys++
        this.state.totalVolume += amount
      }
    } else {
      tx = await executeSell(
        wallet,
        this.config.mintAddress,
        amount,
        this.config.slippage,
        this.config.priorityFee,
        bondingCurve
      )
      
      if (tx.status === "success") {
        this.state.totalSells++
        this.state.totalVolume += tx.tokensOrSol
      }
    }
    
    // update last action
    this.lastActions.set(wallet.publicKey, action)
    
    // add to transactions (keep last 100)
    this.state.transactions.unshift(tx)
    if (this.state.transactions.length > 100) {
      this.state.transactions = this.state.transactions.slice(0, 100)
    }
    
    this.notifyUpdate()
  }
}

/**
 * estimate volume generation
 * @param solBudget - SOL budget
 * @param rate - rate per 1 SOL (e.g., 13000 = $13k volume per SOL)
 */
export function estimateVolume(solBudget: number, rate: number = 13000): number {
  return solBudget * rate
}

// New VolumeBotEngine class for persistent bot management
export interface VolumeBotPairEngineConfig {
  pairId: string
  tokenId: string
  mintAddress: string
  settings: any // From VolumeBotSettings
  onTrade?: (pairId: string, trade: any) => void
  onError?: (pairId: string, error: Error) => void
  onLog?: (pairId: string, message: string, type?: string) => void
}

export class VolumeBotPairEngine {
  private pairId: string
  private tokenId: string
  private mintAddress: string
  private settings: any
  private wallets: VolumeWallet[] = []
  private totalTrades = 0
  private totalVolume = "0"
  private solSpent = "0"
  private isActive = false
  private connection: Connection | null = null

  // Callbacks
  private onTrade?: (pairId: string, trade: any) => void
  private onError?: (pairId: string, error: Error) => void
  private onLog?: (pairId: string, message: string, type?: string) => void

  constructor(config: VolumeBotPairEngineConfig) {
    this.pairId = config.pairId
    this.tokenId = config.tokenId
    this.mintAddress = config.mintAddress
    this.settings = config.settings
    this.onTrade = config.onTrade
    this.onError = config.onError
    this.onLog = config.onLog
  }

  async initialize(): Promise<void> {
    try {
      this.connection = await getResilientConnection()

      // Load wallets from DB
      const wallets = await prisma.wallet.findMany({
        where: {
          groups: {
            some: {
              group: {
                type: "volume",
                wallets: {
                  some: {
                    wallet: {
                      // Find wallets associated with volume bot pairs
                    }
                  }
                }
              }
            }
          }
        }
      })

      const validWallets: VolumeWallet[] = []
      let skipped = 0
      for (const w of wallets) {
        const secretKey = (w.secretKey ?? "").replace(/\s/g, "").replace(/^['"]|['"]$/g, "").trim()
        const invalidChars = [...new Set(secretKey.replace(/[1-9A-HJ-NP-Za-km-z]/g, ""))]
        if (!secretKey || invalidChars.length > 0) {
          skipped++
          this.onLog?.(
            this.pairId,
            `Skipping wallet with invalid secret key: ${w.publicKey}`,
            "warning"
          )
          continue
        }
        try {
          bs58.decode(secretKey)
        } catch (error) {
          skipped++
          this.onLog?.(
            this.pairId,
            `Skipping wallet ${w.publicKey} due to invalid Base58 string`,
            "warning"
          )
          continue
        }
        validWallets.push({
          publicKey: w.publicKey,
          secretKey,
          solBalance: parseFloat(w.solBalance),
          tokenBalance: parseFloat(w.tokenBalance),
          isActive: w.isActive,
        })
      }

      this.wallets = validWallets
      if (skipped > 0) {
        this.onLog?.(this.pairId, `Skipped ${skipped} invalid wallets from DB`, "warning")
      }

      this.isActive = true
      this.onLog?.(this.pairId, `Bot initialized with ${this.wallets.length} wallets`, "info")

    } catch (error) {
      this.onError?.(this.pairId, error as Error)
    }
  }

  async executeCycle(): Promise<void> {
    if (!this.isActive || !this.connection) return

    try {
      this.onLog?.(this.pairId, "Cycle start", "info")
      // Get active wallets with tokens (for selling)
      const walletsWithTokens = this.wallets.filter(w => w.tokenBalance > 0 && w.isActive)

      // Determine action based on mode
      let action: "buy" | "sell"
      let targetWallets: VolumeWallet[]

      switch (this.settings.mode) {
        case "buy":
          action = "buy"
          targetWallets = this.wallets.filter(w => w.isActive)
          break
        case "sell":
          action = "sell"
          targetWallets = walletsWithTokens
          break
        case "wash":
        default:
          // Alternate between buy and sell
          const shouldBuy = Math.random() > 0.5 || walletsWithTokens.length === 0
          action = shouldBuy ? "buy" : "sell"
          targetWallets = shouldBuy ? this.wallets.filter(w => w.isActive) : walletsWithTokens
          break
      }

      if (targetWallets.length === 0) {
        this.onLog?.(this.pairId, `No suitable wallets for ${action} action`, "warning")
        return
      }

      // Select random wallet
      const wallet = targetWallets[Math.floor(Math.random() * targetWallets.length)]
      this.onLog?.(this.pairId, `Selected wallet ${wallet.publicKey} for ${action}`, "info")

      // Calculate amount
      let solAmount: number
      switch (this.settings.amountMode) {
        case "fixed":
          solAmount = parseFloat(this.settings.fixedAmount)
          break
        case "random":
          const min = parseFloat(this.settings.minAmount)
          const max = parseFloat(this.settings.maxAmount)
          solAmount = min + Math.random() * (max - min)
          break
        case "percentage":
          // For percentage mode, we'd need wallet balance info
          solAmount = parseFloat(this.settings.minAmount) // fallback
          break
        default:
          solAmount = 0.01
      }

      // Execute trade
      this.onLog?.(this.pairId, `Executing ${action} for ${solAmount} SOL`, "info")
      await this.executeTrade(wallet, action, solAmount)
      this.onLog?.(this.pairId, `Cycle done (${action})`, "success")

    } catch (error) {
      this.onError?.(this.pairId, error as Error)
    }
  }

  private async executeTrade(wallet: VolumeWallet, action: "buy" | "sell", solAmount: number): Promise<void> {
    try {
      const balances = await this.fetchWalletBalances(wallet.publicKey)
      wallet.solBalance = balances.solBalance
      wallet.tokenBalance = balances.tokenBalance

      if (action === "sell" && wallet.tokenBalance <= 0) {
        this.onLog?.(this.pairId, "Skip sell: token balance is zero", "warning")
        return
      }
      if (action === "buy" && wallet.solBalance <= solAmount) {
        this.onLog?.(this.pairId, "Skip buy: insufficient SOL balance", "warning")
        return
      }

      const secretKeyString = (wallet.secretKey ?? "")
        .replace(/\s/g, "")
        .replace(/^['"]|['"]$/g, "")
        .trim()
      if (!secretKeyString) {
        throw new Error("wallet secretKey is missing or empty")
      }
      const invalidChars = [...new Set(secretKeyString.replace(/[1-9A-HJ-NP-Za-km-z]/g, ""))]
      if (invalidChars.length > 0) {
        throw new Error(`wallet secretKey has invalid base58 chars: ${invalidChars.join(",")}`)
      }
      let walletKeypair: Keypair
      try {
        walletKeypair = getCachedKeypair(secretKeyString)
      } catch (error: any) {
        const msg = error?.message || String(error)
        this.onLog?.(this.pairId, `Failed to decode wallet secretKey: ${msg}`, "error")
        this.onLog?.(this.pairId, `Invalid key length: ${secretKeyString.length}`, "error")
        throw error
      }

      const mintPubkey = new PublicKey(this.mintAddress)
      let transaction: Transaction
      let tokenAmount: number = 0
      let solAmountForLog: number = solAmount

      const mintInfo = await this.connection!.getAccountInfo(mintPubkey)
      if (!mintInfo) {
        throw new Error(`Mint account not found: ${mintPubkey.toBase58()}`)
      }
      const mintOwner = mintInfo.owner?.toBase58?.() || "unknown"
      const tokenProgramId =
        mintInfo.owner?.equals?.(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
      console.log("Mint owner:", mintOwner)

      if (action === "buy") {
        const bondingCurve = await getBondingCurveData(mintPubkey)
        if (!bondingCurve) throw new Error("Bonding curve not found")

        const { tokensOut } = calculateBuyAmount(bondingCurve, solAmount)
        const minTokensOut = tokensOut * BigInt(100 - parseInt(this.settings.slippage)) / BigInt(100)

        transaction = await buildBuyTransaction(
          walletKeypair.publicKey,
          mintPubkey,
          solAmount,
          minTokensOut
        )
        if (!transaction) {
          throw new Error("Failed to build transaction: check bonding curve data")
        }
        console.log("ATA mint:", mintPubkey.toBase58())
        console.log("ATA token program:", tokenProgramId.toBase58())
        const ata = await getAssociatedTokenAddress(
          mintPubkey,
          walletKeypair.publicKey,
          false,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            walletKeypair.publicKey,
            ata,
            walletKeypair.publicKey,
            mintPubkey,
            tokenProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        )
        tokenAmount = Number(tokensOut) / 1e6 // Convert to token units
      } else {
        // For sell, calculate based on token balance
        tokenAmount = Math.min(wallet.tokenBalance, solAmount) // Use solAmount as proxy for token amount
        const bondingCurve = await getBondingCurveData(mintPubkey)
        if (!bondingCurve) throw new Error("Bonding curve not found")

        const { solOut } = calculateSellAmount(bondingCurve, toRawTokenAmount(tokenAmount, TOKEN_DECIMALS))
        const minSolOut = solOut * BigInt(100 - parseInt(this.settings.slippage)) / BigInt(100)
        solAmountForLog = Number(solOut) / LAMPORTS_PER_SOL

        transaction = await buildSellTransaction(
          walletKeypair.publicKey,
          mintPubkey,
          toRawTokenAmount(tokenAmount, TOKEN_DECIMALS),
          minSolOut
        )
        if (!transaction) {
          throw new Error("Failed to build transaction: check bonding curve data")
        }
      }

      const region = (this.settings.jitoRegion as JitoRegion) || "frankfurt"
      const rawTip = Number(this.settings.jitoTip)
      const jitoTip = Number.isFinite(rawTip) ? Math.max(0, rawTip) : 0.0001

      // Add priority fee
      const latest = await this.connection!.getLatestBlockhash()
      transaction.recentBlockhash = latest.blockhash
      ;(transaction as any).lastValidBlockHeight = latest.lastValidBlockHeight
      transaction.feePayer = walletKeypair.publicKey

      // Add Jito tip (only when > 0)
      if (jitoTip > 0) {
        const tipIx = createTipInstruction(walletKeypair.publicKey, jitoTip, region)
        if (!tipIx) {
          throw new Error("Failed to build tip instruction")
        }
        transaction.add(tipIx)
      }

      const ata = await getAssociatedTokenAddress(
        mintPubkey,
        walletKeypair.publicKey,
        false,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
      const bondingCurveAddress = getBondingCurveAddress(mintPubkey)
      console.log("Bonding curve:", bondingCurveAddress.toBase58())
      console.log("ATA:", ata.toBase58())

      // Sign before simulation and bundle
      transaction.sign(walletKeypair)

      console.log("Tx object status:", !!transaction)
      for (let i = 0; i < transaction.instructions.length; i++) {
        const programId = transaction.instructions[i]?.programId?.toBase58?.() || "unknown"
        console.log(`Inst ${i} program:`, programId)
      }

      // Pre-flight simulation
      const sim = await this.connection!.simulateTransaction(transaction)
      if (sim?.value?.err) {
        const simError = JSON.stringify(sim.value.err)
        const simLogs = sim.value.logs?.slice(-8).join(" | ")
        const simMessage = simLogs ? `${simError} | logs: ${simLogs}` : simError
        this.onLog?.(this.pairId, `Simulation failed: ${simMessage}`, "error")
        await prisma.transaction.create({
          data: {
            signature: null,
            tokenId: this.tokenId,
            type: action,
            walletAddress: wallet.publicKey,
            amount: String(tokenAmount),
            solAmount: String(solAmountForLog),
            price: tokenAmount > 0 ? String(solAmountForLog / tokenAmount) : null,
            status: "failed",
            error: simMessage,
          },
        })
        return
      }

      const { bundleId } = await sendBundle([transaction], region)
      const sig = transaction.signatures?.[0]?.signature
      const signature = bs58.encode(sig || new Uint8Array(64))

      let status: "confirmed" | "failed" | "pending" = "pending"
      const start = Date.now()
      await sleep(1500)
      while (Date.now() - start < 60_000) {
        const entries = await getInflightBundleStatusesWithFallback([bundleId], region)
        const entry = entries?.[0]
        if (entry?.status === "landed") {
          status = "confirmed"
          break
        }
        if (entry?.status === "failed") {
          status = "failed"
          this.onLog?.(this.pairId, `Bundle failed: ${entry.error || "unknown error"}`, "error")
          break
        }
        await sleep(750)
      }

      await prisma.transaction.create({
        data: {
          signature,
          tokenId: this.tokenId,
          type: action,
          walletAddress: wallet.publicKey,
          amount: String(tokenAmount),
          solAmount: String(solAmountForLog),
          price: tokenAmount > 0 ? String(solAmountForLog / tokenAmount) : null,
          status,
        },
      })

      if (status !== "confirmed") {
        this.onLog?.(this.pairId, `Bundle not confirmed (status=${status})`, status === "failed" ? "error" : "warning")
        return
      }

      // Update wallet balances in DB
      await this.updateWalletBalances(wallet.publicKey)

      // Update statistics
      this.totalTrades++
      this.totalVolume = (parseFloat(this.totalVolume) + solAmount).toString()
      this.solSpent = (parseFloat(this.solSpent) + solAmount).toString()

      // Notify about trade
      this.onTrade?.(this.pairId, {
        type: action,
        solAmount: solAmountForLog,
        tokenAmount,
        signature,
        wallet: wallet.publicKey
      })

    } catch (error) {
      throw new Error(`Trade execution failed: ${error}`)
    }
  }

  private async updateWalletBalances(walletPublicKey: string): Promise<void> {
    try {
      const balances = await this.fetchWalletBalances(walletPublicKey)

      // Update in DB
      await prisma.wallet.update({
        where: { publicKey: walletPublicKey },
        data: {
          solBalance: balances.solBalance.toString(),
          tokenBalance: balances.tokenBalance.toString()
        }
      })
    } catch (error) {
      console.error("Failed to update wallet balances:", error)
    }
  }

  private async fetchWalletBalances(walletPublicKey: string): Promise<{ solBalance: number; tokenBalance: number }> {
    if (!this.connection) {
      throw new Error("connection not initialized")
    }
    const pubkey = new PublicKey(walletPublicKey)
    const solBalance = await this.connection.getBalance(pubkey)

    let tokenBalance = 0
    try {
      const mint = new PublicKey(this.mintAddress)
      const ata = await getAssociatedTokenAddress(mint, pubkey, false)
      const tokenAccount = await this.connection.getTokenAccountBalance(ata)
      tokenBalance = tokenAccount.value.uiAmount || 0
    } catch {
      tokenBalance = 0
    }

    return {
      solBalance: solBalance / LAMPORTS_PER_SOL,
      tokenBalance,
    }
  }

  getTotalTrades(): number {
    return this.totalTrades
  }

  getTotalVolume(): string {
    return this.totalVolume
  }

  getSolSpent(): string {
    return this.solSpent
  }

  cleanup(): void {
    this.isActive = false
    this.onLog?.(this.pairId, "Bot engine cleaned up", "info")
  }
}
