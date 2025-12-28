import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js"
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import { connection, SOLANA_NETWORK } from "./config"
import {
  PUMPFUN_PROGRAM_ID,
  getBondingCurveAddress,
  getAssociatedBondingCurveAddress,
  getMintAuthorityAddress,
  getMetadataAddress,
  getBondingCurveData,
  createBuyInstruction,
  createSellInstruction,
  createCreateTokenInstruction,
  calculateBuyAmount,
  calculateSellAmount,
  getPumpfunGlobalState,
  getPumpswapPoolData,
  calculatePumpswapSwapAmount,
  buildPumpswapSwapTransaction,
  calculateBundlerRugpullProfit,
  isPumpFunAvailable,
} from "./pumpfun-sdk"
import { buildSellPlan } from "./sell-plan"
import { sendBundle, createTipInstruction, JitoRegion, JITO_ENDPOINTS } from "./jito"
import bs58 from "bs58"

// max wallets in pump.fun bundle (after recent update)
export const MAX_BUNDLE_WALLETS = 13

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
  success: boolean
  signatures: string[]
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
export function generateWallets(count: number): BundlerWallet[] {
  const wallets: BundlerWallet[] = []
  for (let i = 0; i < count; i++) {
    wallets.push(generateWallet(`Wallet ${i + 1}`))
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
 * refresh wallet balances
 */
export async function refreshWalletBalances(
  wallets: BundlerWallet[],
  mintAddress?: string
): Promise<BundlerWallet[]> {
  const mint = mintAddress ? new PublicKey(mintAddress) : null

  const updated = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const pubkey = new PublicKey(wallet.publicKey)

        // get SOL balance
        const solBalance = await connection.getBalance(pubkey)

      // get token balance
      let tokenBalance = 0
      let ataExists: boolean | undefined = undefined
      if (mint) {
        try {
          const ata = await getAssociatedTokenAddress(mint, pubkey, false)
          const tokenAccount = await connection.getTokenAccountBalance(ata)
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
        ...(mint ? { ataExists } : {}),
      }
      } catch (error) {
        console.error(`error refreshing wallet ${wallet.publicKey}:`, error)
        return wallet
      }
    })
  )

  return updated
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

  const activeWallets = wallets.filter((w) => w.isActive).slice(0, MAX_BUNDLE_WALLETS)
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

    const transactions: Transaction[] = []
    const txSigners: Keypair[][] = []
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
    const devBuyIx = await createBuyInstruction(
      devKeypair.publicKey,
      mint,
      devTokensOut,
      devSolAmountLamports,
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
    transactions.push(createTx)
    txSigners.push([devKeypair, mintKeypair])

    // transactions 2+: bundled buys from other wallets
    for (let i = 1; i < activeWallets.length; i++) {
      const wallet = activeWallets[i]
      const keypair = getKeypair(wallet)
      const buyAmount = buyAmounts[i] || buyAmounts[0] || 0.01

      const buyTx = new Transaction()

      // create ATA if needed
      const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
      const ataIx = createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey,
        ata,
        keypair.publicKey,
        mint
      )

      // buy instruction (estimate tokens from initial curve)
      const { tokensOut } = calculateBuyAmount(
        {
          ...initialCurve,
          complete: false,
          creator: keypair.publicKey,
        },
        buyAmount,
      )
      const solAmountLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL))
      const buyIx = await createBuyInstruction(keypair.publicKey, mint, tokensOut, solAmountLamports)

      const buyInstructions = addPriorityFeeInstructions([ataIx, buyIx], priorityFee)

      const { blockhash } = await connection.getLatestBlockhash()
      buyTx.add(...buyInstructions)
      buyTx.recentBlockhash = blockhash
      buyTx.feePayer = keypair.publicKey
      buyTx.sign(keypair)
      transactions.push(buyTx)
      txSigners.push([keypair])
    }

    // add jito tip to the last transaction (last instruction)
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

    // evidence-first: simulate ALL signed txs before sending
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i]
      const sig = extractTxSignature(tx)
      const sim = await connection.simulateTransaction(tx)
      if (sim?.value?.err) {
        return {
          bundleId: "",
          success: false,
          signatures: [],
          error: `simulation failed (launch idx=${i}): ${JSON.stringify(sim.value.err)}`,
        }
      }
    }

    // send bundle via jito
    const result = await sendBundleWithRetry(transactions, jitoRegion as any)
    const signatures = transactions.map(extractTxSignature)

    const statuses = await confirmSignaturesOnRpc(signatures, 60_000)
    const failed = statuses.filter((s) => s.status === "failed")
    const pending = statuses.filter((s) => s.status === "pending")

    if (failed.length || pending.length) {
      return {
        bundleId: result.bundleId,
        success: false,
        signatures,
        mintAddress: mint.toBase58(),
        error: pending.length
          ? "bundle submitted but not all transactions confirmed on RPC (timeout)"
          : `bundle contains failed transaction(s): ${JSON.stringify(failed[0]?.err ?? "unknown")}`,
      }
    }

    return {
      bundleId: result.bundleId,
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

  const activeWallets = wallets.filter((w) => w.isActive).slice(0, MAX_BUNDLE_WALLETS)
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

    // get bonding curve data
    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "token not found on pump.fun",
      }
    }

    const bondingCurveAddress = getBondingCurveAddress(mint)
    const associatedBondingCurve = getAssociatedBondingCurveAddress(mint, bondingCurveAddress)

    const transactions: Transaction[] = []
    const txSigners: Keypair[][] = []
    const { blockhash } = await connection.getLatestBlockhash()

    for (let i = 0; i < activeWallets.length; i++) {
      const wallet = activeWallets[i]
      const keypair = getKeypair(wallet)
      const buyAmount = buyAmounts[i] || buyAmounts[0] || 0.01

      // create ATA if needed
      const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)

      const instructions: TransactionInstruction[] = [
        createAssociatedTokenAccountIdempotentInstruction(
          keypair.publicKey,
          ata,
          keypair.publicKey,
          mint
        ),
      ]

      // calculate tokens out with slippage
      const solAmount = buyAmount
      const { tokensOut } = calculateBuyAmount(bondingCurve, solAmount)
      const minTokensOut = (tokensOut * BigInt(100 - slippage)) / BigInt(100)

      // buy instruction
      const solLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL))
      const buyIx = await createBuyInstruction(keypair.publicKey, mint, minTokensOut, solLamports)

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

    // add jito tip to the last transaction (last instruction)
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

    // evidence-first: simulate ALL signed txs before sending
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i]
      const sig = extractTxSignature(tx)
      const sim = await connection.simulateTransaction(tx)
      if (sim?.value?.err) {
        return {
          bundleId: "",
          success: false,
          signatures: [],
          error: `simulation failed (buy idx=${i}): ${JSON.stringify(sim.value.err)}`,
        }
      }
    }

    // send bundle via jito
    const result = await sendBundleWithRetry(transactions, jitoRegion)

    const signatures = transactions.map(extractTxSignature)

    // strict validation: confirm on-chain via RPC statuses
    const statuses = await confirmSignaturesOnRpc(signatures, 60_000)
    const failed = statuses.filter((s) => s.status === "failed")
    const pending = statuses.filter((s) => s.status === "pending")

    if (failed.length || pending.length) {
      return {
        bundleId: result.bundleId,
        success: false,
        signatures,
        error: pending.length
          ? "bundle submitted but not all transactions confirmed on RPC (timeout)"
          : `bundle contains failed transaction(s): ${JSON.stringify(failed[0]?.err ?? "unknown")}`,
      }
    }

    return {
      bundleId: result.bundleId,
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

  const activeWallets = wallets.filter((w) => w.isActive && w.tokenBalance > 0).slice(0, MAX_BUNDLE_WALLETS)
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
    const bondingCurveAddress = getBondingCurveAddress(mint)
    const associatedBondingCurve = getAssociatedBondingCurveAddress(mint, bondingCurveAddress)

    // get bonding curve data
    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "token not found on pump.fun",
      }
    }

    const transactions: Transaction[] = []
    const txSigners: Keypair[][] = []
    const { blockhash } = await connection.getLatestBlockhash()

    for (let i = 0; i < activeWallets.length; i++) {
      const wallet = activeWallets[i]
      const keypair = getKeypair(wallet)
      const sellPercentage = sellPercentages[i] ?? sellPercentages[0] ?? 100

      // calculate token amount to sell
      const tokenAmount = Math.floor((wallet.tokenBalance * sellPercentage) / 100)
      if (tokenAmount <= 0) continue

      const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 1e6))

      // use unified sell plan (auto picks pumpswap after migration)
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
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "no transactions to send",
      }
    }

    // add jito tip to the last transaction (last instruction)
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

    // send bundle via jito
    const result = await sendBundleWithRetry(transactions, jitoRegion)

    const signatures = transactions.map(extractTxSignature)

    // strict validation: confirm on-chain via RPC statuses
    const statuses = await confirmSignaturesOnRpc(signatures, 60_000)
    const failed = statuses.filter((s) => s.status === "failed")
    const pending = statuses.filter((s) => s.status === "pending")

    if (failed.length || pending.length) {
      return {
        bundleId: result.bundleId,
        success: false,
        signatures,
        error: pending.length
          ? "bundle submitted but not all transactions confirmed on RPC (timeout)"
          : `bundle contains failed transaction(s): ${JSON.stringify(failed[0]?.err ?? "unknown")}`,
      }
    }

    return {
      bundleId: result.bundleId,
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

    try {
      // get latest bonding curve data
      const bondingCurve = await getBondingCurveData(mint)
      if (!bondingCurve) {
        errors.push(`${wallet.publicKey}: token not available`)
        continue
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

      let signature: string | null = null
      const buyTx = new Transaction()
      buyTx.add(...prioritized)
      buyTx.recentBlockhash = blockhash
      buyTx.lastValidBlockHeight = lastValidBlockHeight
      buyTx.feePayer = keypair.publicKey
      buyTx.sign(keypair)

      signature = await connection.sendRawTransaction(buyTx.serialize())
      signatures.push(signature)

      if (onTransaction && signature) {
        onTransaction(wallet.publicKey, signature, i)
      }

      // random delay before next transaction
      if (i < activeWallets.length - 1) {
        const delay = Math.random() * (staggerDelay.max - staggerDelay.min) + staggerDelay.min
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    } catch (error: any) {
      errors.push(`${wallet.publicKey}: ${error.message}`)
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

    try {
      // get latest bonding curve data
      const bondingCurve = await getBondingCurveData(mint)
      if (!bondingCurve || bondingCurve.complete) {
        errors.push(`${wallet.publicKey}: token not available`)
        continue
      }

      const tokenAmount = Math.floor((wallet.tokenBalance * sellPercentage) / 100)
      if (tokenAmount <= 0) continue

      const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 1e6))

      // calculate min SOL out
      let minSolOut = BigInt(0)
      let sellTx: Transaction

      if (bondingCurve.complete) {
        const poolData = await getPumpswapPoolData(mint)
        if (!poolData) {
          errors.push(`${wallet.publicKey}: pumpswap pool unavailable`)
          continue
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

      if (onTransaction) {
        onTransaction(wallet.publicKey, signature, i)
      }

      // random delay before next transaction
      if (i < activeWallets.length - 1) {
        const delay = Math.random() * (staggerDelay.max - staggerDelay.min) + staggerDelay.min
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    } catch (error: any) {
      errors.push(`${wallet.publicKey}: ${error.message}`)
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

  const activeWallets = wallets.filter((w) => w.isActive).slice(0, MAX_BUNDLE_WALLETS)
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

    // get bonding curve data
    const bondingCurve = await getBondingCurveData(mint)
    if (!bondingCurve) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "token not found on pump.fun",
      }
    }

    // first pass: get real token balances for all wallets
    const walletBalances: { wallet: BundlerWallet; tokenAmount: bigint; keypair: any }[] = []

    for (const wallet of activeWallets) {
      const keypair = getKeypair(wallet)

      try {
        // get real token balance from RPC
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false)
        let tokenBalanceRaw = BigInt(0)
        try {
          const balance = await connection.getTokenAccountBalance(ata)
          tokenBalanceRaw = BigInt(balance.value.amount)
        } catch {
          // no token account or zero balance, skip this wallet
          continue
        }

        if (tokenBalanceRaw === BigInt(0)) {
          continue
        }

        walletBalances.push({ wallet, tokenAmount: tokenBalanceRaw, keypair })
      } catch (error: any) {
        // continue with other wallets
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

    // calculate sequential bundler profit with price impact
    const profitData = await calculateBundlerRugpullProfit(
      mint,
      walletBalances.map(w => ({
        walletAddress: w.wallet.publicKey,
        tokenAmount: w.tokenAmount
      }))
    )

    // calculate fees
    const estimatedGasFee = BigInt(Math.floor(priorityFee * LAMPORTS_PER_SOL * walletBalances.length))
    const estimatedJitoTip = BigInt(Math.floor(jitoTip * LAMPORTS_PER_SOL))
    const netEstimatedProfit = profitData.totalEstimatedSol - estimatedGasFee - estimatedJitoTip

    const transactions: Transaction[] = []
    const { blockhash } = await connection.getLatestBlockhash()

    // second pass: create transactions for wallets with balances
    for (let i = 0; i < walletBalances.length; i++) {
      const { wallet, tokenAmount, keypair } = walletBalances[i]

      try {
        // use unified sell plan (auto picks pumpswap after migration) - sell 100% of tokens
        const { buildSellPlan } = await import("./sell-plan")
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
      } catch (error: any) {
        // continue with other wallets
        continue
      }
    }

    if (transactions.length === 0) {
      return {
        bundleId: "",
        success: false,
        signatures: [],
        error: "no wallets with tokens to sell",
      }
    }

    // add jito tip to the last transaction (last instruction)
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

    // evidence-first: simulate ALL signed txs before sending
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i]
      const sig = extractTxSignature(tx)
      const sim = await connection.simulateTransaction(tx)
      if (sim?.value?.err) {
        return {
          bundleId: "",
          success: false,
          signatures: [],
          error: `simulation failed (rugpull idx=${i}): ${JSON.stringify(sim.value.err)}`,
        }
      }
    }

    // send bundle via jito
    const result = await sendBundleWithRetry(transactions, jitoRegion)

    const signatures = transactions.map(extractTxSignature)

    // strict validation: confirm on-chain via RPC statuses
    const statuses = await confirmSignaturesOnRpc(signatures, 60_000)
    const failed = statuses.filter((s) => s.status === "failed")
    const pending = statuses.filter((s) => s.status === "pending")

    if (failed.length || pending.length) {
      return {
        bundleId: result.bundleId,
        success: false,
        signatures,
        error: pending.length
          ? "bundle submitted but not all transactions confirmed on RPC (timeout)"
          : `bundle contains failed transaction(s): ${JSON.stringify(failed[0]?.err ?? "unknown")}`,
      }
    }

    return {
      bundleId: result.bundleId,
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
