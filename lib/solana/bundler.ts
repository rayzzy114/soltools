import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import { connection } from "./config"
import { getAssociatedTokenAddress } from "@solana/spl-token"
import {
  buildBuyTransaction,
  buildSellTransaction,
  getBondingCurveData,
  calculateBuyAmount,
  calculateSellAmount,
  isPumpFunAvailable,
  buildPumpswapSwapTransaction,
  calculatePumpswapSwapAmount,
  getPumpswapPoolData,
} from "./pumpfun-sdk"
import {
  sendBundle,
  waitForBundleConfirmation,
  createTipInstruction,
  JitoRegion,
} from "./jito"
import {
  createPumpFunLUT,
  getLookupTableAccount,
  estimateSavings,
  KNOWN_ADDRESSES,
} from "./lut"
import { buildSellPlan } from "./sell-plan"
import bs58 from "bs58"

function clampPercent(value: number, min: number = 0, max: number = 99): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

// LUT cache for bundler
let bundlerLUT: PublicKey | null = null
let bundlerLUTAccount: AddressLookupTableAccount | null = null

export interface BundleTransaction {
  walletAddress: string
  walletSecretKey?: string // base58 encoded
  tokenMint: string
  amount: string
  type: "buy" | "sell"
}

export interface BundleResult {
  bundleId: string
  signatures: string[]
  successCount: number
  failedCount: number
  gasUsed: string
  status: "pending" | "landed" | "failed"
  error?: string
}

/**
 * create and send bundle of pump.fun transactions via jito
 */
export async function createBundle(
  payer: Keypair,
  transactions: BundleTransaction[],
  jitoTip: number = 0.0001,
  region: JitoRegion = "frankfurt"
): Promise<BundleResult> {
  const bundleId = `BND-${Date.now()}`
  
  if (!isPumpFunAvailable()) {
    return {
      bundleId,
      signatures: [],
      successCount: 0,
      failedCount: transactions.length,
      gasUsed: "0",
      status: "failed",
      error: "pump.fun not available on current network",
    }
  }
  
  if (transactions.length === 0) {
    return {
      bundleId,
      signatures: [],
      successCount: 0,
      failedCount: 0,
      gasUsed: "0",
      status: "landed",
    }
  }
  
  try {
    const txList: Transaction[] = []
    const signers: Keypair[] = []
    
    for (const tx of transactions) {
      const mint = new PublicKey(tx.tokenMint)
      const bondingCurve = await getBondingCurveData(mint)
      
      // get wallet keypair
      let wallet: Keypair
      if (tx.walletSecretKey) {
        wallet = Keypair.fromSecretKey(bs58.decode(tx.walletSecretKey))
      } else {
        // use payer as wallet if no secret key provided
        wallet = payer
      }
      
      const amount = parseFloat(tx.amount)
      
      let transaction: Transaction
      
      if (tx.type === "buy") {
        if (!bondingCurve || bondingCurve.complete) {
          console.warn(`token ${tx.tokenMint} migrated or unavailable, skipping buy`)
          continue
        }
        // calculate min tokens out with 10% slippage
        const safeSlippage = clampPercent(10)
        const { tokensOut } = calculateBuyAmount(bondingCurve, amount)
        const minTokensOut = tokensOut > BigInt(0)
          ? tokensOut * BigInt(100 - safeSlippage) / BigInt(100)
          : BigInt(0)
        
        transaction = await buildBuyTransaction(
          wallet.publicKey,
          mint,
          amount,
          minTokensOut,
          0.0005 // priority fee
        )
      } else {
        // sell - amount is in tokens
        const tokenAmountRaw = BigInt(Math.floor(amount * 1e6))
        const safeSlippage = clampPercent(10)
        
        const plan = await buildSellPlan(
          wallet.publicKey,
          mint,
          tokenAmountRaw,
          safeSlippage,
          0.0005,
          "auto"
        )

        transaction = plan.transaction
      }
      
      // sign transaction
      transaction.sign(wallet)
      txList.push(transaction)
      signers.push(wallet)
    }
    
    if (txList.length === 0) {
      return {
        bundleId,
        signatures: [],
        successCount: 0,
        failedCount: transactions.length,
        gasUsed: "0",
        status: "failed",
        error: "no valid transactions to bundle",
        }
    }
    
    // add jito tip to last transaction
    const lastTx = txList[txList.length - 1]
    const tipIx = createTipInstruction(signers[signers.length - 1].publicKey, jitoTip)
    lastTx.add(tipIx)
    
    // re-sign all transactions with fresh blockhash
    const { blockhash } = await connection.getLatestBlockhash()
    txList.forEach((tx, idx) => {
      tx.recentBlockhash = blockhash
      tx.sign(signers[idx] ?? payer)
    })
    
    // send bundle to jito
    const { bundleId: jitoBundleId } = await sendBundle(txList, region)
      
    // wait for confirmation
    const status = await waitForBundleConfirmation(jitoBundleId, region, 30000)
    
    // extract signatures
    const signatures = txList.map(tx => bs58.encode(tx.signature || new Uint8Array(64)))
    
    const gasUsed = (jitoTip + 0.0005 * txList.length).toFixed(6)
    
    if (status.status === "landed") {
      return {
        bundleId: jitoBundleId,
        signatures,
        successCount: txList.length,
        failedCount: transactions.length - txList.length,
        gasUsed,
        status: "landed",
      }
    } else {
      return {
        bundleId: jitoBundleId,
        signatures: [],
        successCount: 0,
        failedCount: transactions.length,
        gasUsed: "0",
        status: "failed",
        error: status.error || "bundle failed",
    }
  }
  } catch (error: any) {
    console.error("bundle error:", error)
  return {
    bundleId,
      signatures: [],
      successCount: 0,
      failedCount: transactions.length,
      gasUsed: "0",
      status: "failed",
      error: error.message || "unknown error",
    }
  }
}

/**
 * create launch bundle: create token + initial buys
 * all transactions executed atomically in same block
 */
export async function createLaunchBundle(
  payer: Keypair,
  tokenMint: string,
  liquidityAmount: number,
  initialBuyWallets: { address: string; secretKey: string; amount: number }[]
): Promise<BundleResult> {
  const transactions: BundleTransaction[] = [
    // initial buy from payer
    {
      walletAddress: payer.publicKey.toBase58(),
      tokenMint,
      amount: liquidityAmount.toString(),
      type: "buy",
    },
    // buys from other wallets
    ...initialBuyWallets.map((w) => ({
      walletAddress: w.address,
      walletSecretKey: w.secretKey,
      tokenMint,
      amount: w.amount.toString(),
      type: "buy" as const,
    })),
  ]

  return createBundle(payer, transactions, 0.001) // higher tip for launch
}

/**
 * create sniper bundle: multiple wallets buy at same block
 */
export async function createSniperBundle(
  wallets: { address: string; secretKey: string }[],
  tokenMint: string,
  amount: string
): Promise<BundleResult> {
  const transactions: BundleTransaction[] = wallets.map((wallet) => ({
    walletAddress: wallet.address,
    walletSecretKey: wallet.secretKey,
    tokenMint,
    amount,
    type: "buy",
  }))

  // use first wallet as payer
  const payer = Keypair.fromSecretKey(bs58.decode(wallets[0].secretKey))
  
  return createBundle(payer, transactions, 0.0005) // medium tip for snipe
}

/**
 * create exit bundle: all wallets sell tokens at same block
 */
export async function createExitBundle(
  wallets: { address: string; secretKey: string; tokenBalance: number }[],
  tokenMint: string
): Promise<BundleResult> {
  const transactions: BundleTransaction[] = wallets
    .filter(w => w.tokenBalance > 0)
    .map((wallet) => ({
      walletAddress: wallet.address,
      walletSecretKey: wallet.secretKey,
    tokenMint,
      amount: wallet.tokenBalance.toString(),
    type: "sell",
  }))

  if (transactions.length === 0) {
    return {
      bundleId: `BND-${Date.now()}`,
      signatures: [],
      successCount: 0,
      failedCount: 0,
      gasUsed: "0",
      status: "landed",
    }
  }

  // use first wallet as payer
  const payer = Keypair.fromSecretKey(bs58.decode(wallets[0].secretKey))
  
  return createBundle(payer, transactions, 0.001) // higher tip for exit (speed matters)
}

/**
 * get token balances for wallets
 */
export async function getWalletTokenBalances(
  wallets: string[],
  tokenMint: string
): Promise<{ address: string; balance: number }[]> {
  const mint = new PublicKey(tokenMint)
  
  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const pubkey = new PublicKey(wallet)
        const ata = await getAssociatedTokenAddress(mint, pubkey, false)
        const balance = await connection.getTokenAccountBalance(ata)
        return {
          address: wallet,
          balance: balance.value.uiAmount || 0,
        }
      } catch {
        return { address: wallet, balance: 0 }
      }
    })
  )
  
  return results
}

// ==== LUT INTEGRATION ====

/**
 * initialize or get bundler LUT
 */
export async function initBundlerLUT(payer: Keypair): Promise<PublicKey> {
  if (bundlerLUT && bundlerLUTAccount) {
    return bundlerLUT
  }

  // create pump.fun optimized LUT
  bundlerLUT = await createPumpFunLUT(payer, [payer.publicKey])
  
  // wait for LUT to be available (next slot)
  await new Promise(resolve => setTimeout(resolve, 2000))
  
  bundlerLUTAccount = await getLookupTableAccount(bundlerLUT)
  
  return bundlerLUT
}

/**
 * set existing LUT address
 */
export async function setBundlerLUT(lutAddress: PublicKey): Promise<boolean> {
  const account = await getLookupTableAccount(lutAddress)
  
  if (!account) {
    return false
  }
  
  bundlerLUT = lutAddress
  bundlerLUTAccount = account
  return true
}

/**
 * get current LUT info
 */
export function getBundlerLUTInfo(): { 
  address: string | null
  addressCount: number 
  isReady: boolean
} {
  return {
    address: bundlerLUT?.toBase58() || null,
    addressCount: bundlerLUTAccount?.state.addresses.length || 0,
    isReady: !!bundlerLUTAccount,
  }
}

/**
 * create V0 bundle with LUT optimization
 * saves ~30-50% on transaction size
 */
export async function createOptimizedBundle(
  payer: Keypair,
  transactions: BundleTransaction[],
  jitoTip: number = 0.0001,
  region: JitoRegion = "frankfurt"
): Promise<BundleResult & { savings?: { percentage: number; bytes: number } }> {
  const bundleId = `BND-V0-${Date.now()}`
  
  if (!isPumpFunAvailable()) {
    return {
      bundleId,
      signatures: [],
      successCount: 0,
      failedCount: transactions.length,
      gasUsed: "0",
      status: "failed",
      error: "pump.fun not available on current network",
    }
  }

  if (transactions.length === 0) {
    return {
      bundleId,
      signatures: [],
      successCount: 0,
      failedCount: 0,
      gasUsed: "0",
      status: "landed",
    }
  }

  try {
    // init LUT if needed
    if (!bundlerLUTAccount) {
      await initBundlerLUT(payer)
    }

    const v0Transactions: VersionedTransaction[] = []
    const signersList: Keypair[][] = []
    let totalSaved = 0
    let totalOriginal = 0
    
    for (const tx of transactions) {
      const mint = new PublicKey(tx.tokenMint)
      const bondingCurve = await getBondingCurveData(mint)
      
      if (!bondingCurve || bondingCurve.complete) {
        continue
      }
      
      let wallet: Keypair
      if (tx.walletSecretKey) {
        wallet = Keypair.fromSecretKey(bs58.decode(tx.walletSecretKey))
      } else {
        wallet = payer
      }
      
      const amount = parseFloat(tx.amount)
      let legacyTx: Transaction
      
      if (tx.type === "buy") {
        const { tokensOut } = calculateBuyAmount(bondingCurve, amount)
        const minTokensOut = tokensOut * BigInt(90) / BigInt(100)
        
        legacyTx = await buildBuyTransaction(
          wallet.publicKey,
          mint,
          amount,
          minTokensOut,
          0.0005
        )
      } else {
        const tokenAmountRaw = BigInt(Math.floor(amount * 1e6))
        const { solOut } = calculateSellAmount(bondingCurve, tokenAmountRaw)
        const minSolOut = solOut * BigInt(90) / BigInt(100)
        
        legacyTx = await buildSellTransaction(
          wallet.publicKey,
          mint,
          tokenAmountRaw,
          minSolOut,
          0.0005
        )
      }

      // estimate savings
      if (bundlerLUTAccount) {
        const savings = estimateSavings(legacyTx.instructions, [bundlerLUTAccount])
        totalOriginal += savings.withoutLut
        totalSaved += savings.saved
      }

      // convert to V0 with LUT
      const { blockhash } = await connection.getLatestBlockhash()
      
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: legacyTx.instructions,
      }).compileToV0Message(bundlerLUTAccount ? [bundlerLUTAccount] : [])

      const v0Tx = new VersionedTransaction(messageV0)
      v0Tx.sign([wallet])
      
      v0Transactions.push(v0Tx)
      signersList.push([wallet])
    }

    if (v0Transactions.length === 0) {
      return {
        bundleId,
        signatures: [],
        successCount: 0,
        failedCount: transactions.length,
        gasUsed: "0",
        status: "failed",
        error: "no valid transactions to bundle",
      }
    }

    // add jito tip to last transaction (need to rebuild)
    const lastSigner = signersList[signersList.length - 1][0]
    const tipIx = createTipInstruction(lastSigner.publicKey, jitoTip)
    
    const { blockhash } = await connection.getLatestBlockhash()
    
    // rebuild last tx with tip
    const lastOriginalTx = v0Transactions[v0Transactions.length - 1]
    const lastMessage = TransactionMessage.decompile(lastOriginalTx.message)
    lastMessage.instructions.push(tipIx)
    
    const newLastMessage = new TransactionMessage({
      payerKey: lastSigner.publicKey,
      recentBlockhash: blockhash,
      instructions: lastMessage.instructions,
    }).compileToV0Message(bundlerLUTAccount ? [bundlerLUTAccount] : [])
    
    const newLastTx = new VersionedTransaction(newLastMessage)
    newLastTx.sign([lastSigner])
    v0Transactions[v0Transactions.length - 1] = newLastTx

    // send to jito with native V0 bundle support
    const { bundleId: jitoBundleId } = await sendBundle(v0Transactions, region)

    const status = await waitForBundleConfirmation(jitoBundleId, region, 30000)
    
    const signatures = v0Transactions.map(tx => 
      bs58.encode(tx.signatures[0] || new Uint8Array(64))
    )
    
    const gasUsed = (jitoTip + 0.0005 * v0Transactions.length).toFixed(6)
    const savingsPercentage = totalOriginal > 0 ? (totalSaved / totalOriginal) * 100 : 0

    if (status.status === "landed") {
      return {
        bundleId: jitoBundleId,
        signatures,
        successCount: v0Transactions.length,
        failedCount: transactions.length - v0Transactions.length,
        gasUsed,
        status: "landed",
        savings: {
          percentage: Math.round(savingsPercentage),
          bytes: totalSaved,
        },
      }
    } else {
      return {
        bundleId: jitoBundleId,
        signatures: [],
        successCount: 0,
        failedCount: transactions.length,
        gasUsed: "0",
        status: "failed",
        error: status.error || "bundle failed",
      }
    }
  } catch (error: any) {
    console.error("optimized bundle error:", error)
    return {
      bundleId,
      signatures: [],
      successCount: 0,
      failedCount: transactions.length,
      gasUsed: "0",
      status: "failed",
      error: error.message || "unknown error",
    }
  }
}
