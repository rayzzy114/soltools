/**
 * Wallet Warmup System
 * Generates real activity for wallets before usage
 */

import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js"
import { connection } from "./config"
import bs58 from "bs58"

export interface WarmupConfig {
  minTransactions: number  // min transactions
  maxTransactions: number  // max transactions
  minDelayMs: number       // min delay between tx
  maxDelayMs: number       // max delay
  minAmount: number        // min SOL amount
  maxAmount: number        // max SOL amount
  enableSelfTransfers: boolean   // self transfers
  enableMemoProgram: boolean     // use memo
  enableComputeBudget: boolean   // add compute budget
  enableBurnTransfers: boolean   // transfer to burn address
}

export interface WarmupAction {
  type: "self_transfer" | "memo" | "compute_budget" | "burn_transfer"
  amount?: number
  signature?: string
  timestamp: Date
  success: boolean
  error?: string
}

export interface WarmupResult {
  walletAddress: string
  actions: WarmupAction[]
  totalTransactions: number
  successfulTransactions: number
  totalSolSpent: number
  durationMs: number
}

export interface WarmupProgress {
  walletAddress: string
  currentStep: number
  totalSteps: number
  percentage: number
  currentAction: string
}

// default config - realistic looking activity
const DEFAULT_WARMUP_CONFIG: WarmupConfig = {
  minTransactions: 3,
  maxTransactions: 8,
  minDelayMs: 2000,
  maxDelayMs: 10000,
  minAmount: 0.0001,
  maxAmount: 0.001,
  enableSelfTransfers: true,
  enableMemoProgram: true,
  enableComputeBudget: true,
  enableBurnTransfers: true,
}

// Presets for UI
export const WARMUP_PRESETS = {
  OFF: {
    minTransactions: 0,
    maxTransactions: 0,
  },
  LOW: {
    minTransactions: 1,
    maxTransactions: 2,
    minDelayMs: 1000,
    maxDelayMs: 3000,
    enableBurnTransfers: true,
    enableSelfTransfers: true,
  },
  HIGH: {
    minTransactions: 4,
    maxTransactions: 8,
    minDelayMs: 2000,
    maxDelayMs: 8000,
    enableBurnTransfers: true,
    enableSelfTransfers: true,
    enableMemoProgram: true,
    enableComputeBudget: true,
  }
}

// memo program
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
// Incinerator (Burn Address)
const BURN_ADDRESS = new PublicKey("1nc1nerator11111111111111111111111111111111")

// random helpers
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Generate random memo text
 */
function generateMemo(): string {
  const memos = [
    "gm",
    "test",
    "hey",
    "lol",
    "",
    "ok",
    "nice",
    "wagmi",
    "gg",
    Date.now().toString().slice(-6),
  ]
  return memos[randomInt(0, memos.length - 1)]
}

/**
 * Create self-transfer transaction
 */
async function createSelfTransfer(
  wallet: Keypair,
  amount: number
): Promise<Transaction> {
  const tx = new Transaction()
  
  // add compute budget for variety
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: randomInt(50000, 200000),
    })
  )
  
  // self transfer
  tx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wallet.publicKey,
      lamports: Math.floor(amount * LAMPORTS_PER_SOL),
    })
  )
  
  return tx
}

/**
 * Create burn transfer transaction
 */
async function createBurnTransfer(
  wallet: Keypair,
  amount: number
): Promise<Transaction> {
  const tx = new Transaction()

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: randomInt(10000, 50000),
    })
  )

  tx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: BURN_ADDRESS,
      lamports: Math.floor(amount * LAMPORTS_PER_SOL),
    })
  )

  return tx
}

/**
 * Create memo transaction
 */
async function createMemoTransaction(
  wallet: Keypair,
  memo: string
): Promise<Transaction> {
  const tx = new Transaction()
  
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: randomInt(10000, 50000),
    })
  )
  
  tx.add({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from(memo),
  })
  
  return tx
}

/**
 * Execute single warmup action
 */
async function executeWarmupAction(
  wallet: Keypair,
  actionType: "self_transfer" | "memo" | "compute_budget" | "burn_transfer",
  amount?: number
): Promise<WarmupAction> {
  const action: WarmupAction = {
    type: actionType,
    timestamp: new Date(),
    success: false,
    amount,
  }
  
  try {
    let tx: Transaction
    
    switch (actionType) {
      case "self_transfer":
        tx = await createSelfTransfer(wallet, amount || 0.0001)
        break
      case "burn_transfer":
        tx = await createBurnTransfer(wallet, amount || 0.0001)
        break
      case "memo":
        tx = await createMemoTransaction(wallet, generateMemo())
        break
      case "compute_budget":
        tx = new Transaction()
        tx.add(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: randomInt(100000, 500000),
          }),
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: randomInt(1000, 5000),
          }),
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: wallet.publicKey,
            lamports: 1,
          })
        )
        break
      default:
        throw new Error(`unknown action type: ${actionType}`)
    }
    
    const { blockhash } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = wallet.publicKey
    tx.sign(wallet)
    
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    })
    
    await connection.confirmTransaction(signature, "confirmed")
    
    action.signature = signature
    action.success = true
  } catch (error: any) {
    action.error = error.message
    action.success = false
  }
  
  return action
}

/**
 * Warmup single wallet
 */
export async function warmupWallet(
  walletSecretKey: string,
  config: Partial<WarmupConfig> = {},
  onProgress?: (progress: WarmupProgress) => void
): Promise<WarmupResult> {
  const cfg = { ...DEFAULT_WARMUP_CONFIG, ...config }
  const wallet = Keypair.fromSecretKey(bs58.decode(walletSecretKey))
  const walletAddress = wallet.publicKey.toBase58()
  
  const startTime = Date.now()
  const actions: WarmupAction[] = []
  let totalSolSpent = 0
  
  // determine number of transactions
  const numTransactions = randomInt(cfg.minTransactions, cfg.maxTransactions)
  
  // build action plan
  const actionTypes: Array<"self_transfer" | "memo" | "compute_budget" | "burn_transfer"> = []
  
  if (cfg.enableSelfTransfers) actionTypes.push("self_transfer")
  if (cfg.enableBurnTransfers) actionTypes.push("burn_transfer")
  if (cfg.enableMemoProgram) actionTypes.push("memo")
  if (cfg.enableComputeBudget) actionTypes.push("compute_budget")
  
  if (actionTypes.length === 0 || numTransactions <= 0) {
    return {
      walletAddress,
      actions: [],
      totalTransactions: 0,
      successfulTransactions: 0,
      totalSolSpent: 0,
      durationMs: 0,
    }
  }
  
  for (let i = 0; i < numTransactions; i++) {
    // report progress
    if (onProgress) {
      onProgress({
        walletAddress,
        currentStep: i + 1,
        totalSteps: numTransactions,
        percentage: ((i + 1) / numTransactions) * 100,
        currentAction: actionTypes[i % actionTypes.length],
      })
    }
    
    // pick random action
    const actionType = actionTypes[randomInt(0, actionTypes.length - 1)]
    const amount = (actionType === "self_transfer" || actionType === "burn_transfer")
      ? randomFloat(cfg.minAmount, cfg.maxAmount) 
      : undefined
    
    const action = await executeWarmupAction(wallet, actionType, amount)
    actions.push(action)
    
    if (action.success && action.amount) {
      totalSolSpent += action.amount
    }
    
    // random delay (except for last action)
    if (i < numTransactions - 1) {
      const delay = randomInt(cfg.minDelayMs, cfg.maxDelayMs)
      await sleep(delay)
    }
  }
  
  const durationMs = Date.now() - startTime
  const successfulTransactions = actions.filter(a => a.success).length
  
  return {
    walletAddress,
    actions,
    totalTransactions: numTransactions,
    successfulTransactions,
    totalSolSpent: totalSolSpent + (successfulTransactions * 0.000005), // approx tx fees
    durationMs,
  }
}

/**
 * Warmup multiple wallets in parallel (with limit)
 */
export async function warmupWallets(
  walletSecretKeys: string[],
  config: Partial<WarmupConfig> = {},
  concurrency: number = 3,
  onProgress?: (wallet: string, progress: WarmupProgress) => void
): Promise<WarmupResult[]> {
  const results: WarmupResult[] = []
  
  // process in batches
  for (let i = 0; i < walletSecretKeys.length; i += concurrency) {
    const batch = walletSecretKeys.slice(i, i + concurrency)
    
    const batchResults = await Promise.all(
      batch.map(secretKey => 
        warmupWallet(secretKey, config, (progress) => {
          if (onProgress) {
            onProgress(progress.walletAddress, progress)
          }
        })
      )
    )
    
    results.push(...batchResults)
    
    // delay between batches
    if (i + concurrency < walletSecretKeys.length) {
      await sleep(randomInt(1000, 3000))
    }
  }
  
  return results
}

/**
 * Check if wallet looks "warm" (has tx history)
 */
export async function isWalletWarm(walletAddress: string): Promise<{
  isWarm: boolean
  transactionCount: number
  oldestTransaction?: Date
}> {
  try {
    const pubkey = new PublicKey(walletAddress)
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 20 })
    
    const transactionCount = signatures.length
    const isWarm = transactionCount >= 3
    
    let oldestTransaction: Date | undefined
    if (signatures.length > 0) {
      const oldest = signatures[signatures.length - 1]
      if (oldest.blockTime) {
        oldestTransaction = new Date(oldest.blockTime * 1000)
      }
    }
    
    return { isWarm, transactionCount, oldestTransaction }
  } catch {
    return { isWarm: false, transactionCount: 0 }
  }
}

/**
 * Get warmup stats for multiple wallets
 */
export async function getWalletsWarmupStatus(
  walletAddresses: string[]
): Promise<{
  address: string
  isWarm: boolean
  txCount: number
}[]> {
  const results = await Promise.all(
    walletAddresses.map(async (address) => {
      const status = await isWalletWarm(address)
      return {
        address,
        isWarm: status.isWarm,
        txCount: status.transactionCount,
      }
    })
  )
  
  return results
}

// export default config
export { DEFAULT_WARMUP_CONFIG }
