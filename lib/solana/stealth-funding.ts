import { Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { connection } from "./config"
import { createBundle, BundleTransaction } from "./bundler-engine"
import bs58 from "bs58"

export interface StealthFundConfig {
  intermediaryCount: number
  minDelayMs: number
  maxDelayMs: number
  jitterPercent: number
  useJito: boolean
}

export const DEFAULT_STEALTH_CONFIG: StealthFundConfig = {
  intermediaryCount: 3,
  minDelayMs: 60000, // 60s
  maxDelayMs: 300000, // 300s
  jitterPercent: 7,
  useJito: true
}

// Helper to add jitter
function applyJitter(amount: number, percentage: number): number {
  const variation = amount * (percentage / 100)
  const jitter = (Math.random() * variation * 2) - variation
  return amount + jitter
}

export interface StealthFundingState {
  proxies: { address: string; secretKey: string; balance: number }[]
  targetWallets: { address: string; amount: number }[]
}

/**
 * Step 1: Calculate distribution and generate proxies
 */
export async function prepareStealthFunding(
  targetWallets: { address: string; amount: number }[],
  config: StealthFundConfig
): Promise<StealthFundingState> {
  const proxies: { address: string; secretKey: string; balance: number }[] = []

  // Create proxies
  for (let i = 0; i < config.intermediaryCount; i++) {
    const kp = Keypair.generate()
    proxies.push({
      address: kp.publicKey.toBase58(),
      secretKey: bs58.encode(kp.secretKey),
      balance: 0
    })
  }

  // Distribute targets among proxies
  const targetsPerProxy = Math.ceil(targetWallets.length / proxies.length)

  // Calculate needed balance for each proxy
  // Each proxy needs: sum(target amounts) + fees
  // We'll just distribute evenly for now, but better to be precise

  let targetIndex = 0
  for (let i = 0; i < proxies.length; i++) {
    let proxyTotal = 0
    const count = Math.min(targetsPerProxy, targetWallets.length - targetIndex)

    for (let j = 0; j < count; j++) {
      if (targetIndex < targetWallets.length) {
        // Add jitter to target amount if not already jittered?
        // The prompt says "randomize each transfer amount".
        // We assume targetWallets.amount is the base desired.
        const targetAmount = applyJitter(targetWallets[targetIndex].amount, config.jitterPercent)
        targetWallets[targetIndex].amount = targetAmount // Update target with jittered amount
        proxyTotal += targetAmount
        targetIndex++
      }
    }

    // Add transaction fees buffer (approx 0.005 SOL per proxy for its outgoing txs)
    proxyTotal += 0.005

    proxies[i].balance = proxyTotal
  }

  return {
    proxies,
    targetWallets
  }
}

/**
 * Step 2: Fund Proxies from Main Wallet
 */
export async function fundProxies(
  mainSecretKey: string,
  proxies: { address: string; amount: number }[],
  useJito: boolean = true
) {
  const mainWallet = Keypair.fromSecretKey(bs58.decode(mainSecretKey))

  const transactions: BundleTransaction[] = proxies.map(p => ({
    walletAddress: mainWallet.publicKey.toBase58(), // Payer
    tokenMint: "So11111111111111111111111111111111111111112", // SOL
    amount: p.amount.toString(),
    type: "buy" // misused type, but bundler logic handles "buy" as tx building.
                // Wait, bundler-engine createBundle expects tokenMint and builds buy/sell txs.
                // It does NOT support simple SOL transfers.
                // I need to implement SOL transfer support in bundler or here.
  }))

  // Since createBundle is specific to PumpFun buys/sells, I should implement a simple Jito SOL transfer batcher here.
  // or use sendBundle directly.

  return await executeSolTransfers(mainWallet, proxies, useJito)
}

/**
 * Execute batch SOL transfers using Jito
 */
async function executeSolTransfers(
  fromWallet: Keypair,
  transfers: { address: string; amount: number }[],
  useJito: boolean
) {
  // We can bundle multiple transfers in one transaction (up to ~20)
  // or multiple transactions in a bundle (up to 5).
  // Ideally: 1 transaction with multiple instructions.

  const MAX_IKS_PER_TX = 12 // Safe limit
  const txs: Transaction[] = []

  let currentTx = new Transaction()
  let ikCount = 0

  for (const transfer of transfers) {
    currentTx.add(
      SystemProgram.transfer({
        fromPubkey: fromWallet.publicKey,
        toPubkey: new PublicKey(transfer.address),
        lamports: Math.floor(transfer.amount * LAMPORTS_PER_SOL)
      })
    )
    ikCount++

    if (ikCount >= MAX_IKS_PER_TX) {
      txs.push(currentTx)
      currentTx = new Transaction()
      ikCount = 0
    }
  }

  if (ikCount > 0) {
    txs.push(currentTx)
  }

  // Send via Jito
  if (useJito) {
    // Import dynamically to avoid circular deps if any, or just standard import
    const { sendBundle, waitForBundleConfirmation, createTipInstruction } = await import("./jito")

    // Add tip to each transaction (or just the last one if bundled? Jito bundles are atomic)
    // If we have multiple transactions, we can bundle them (max 5).
    // If we have more than 5 txs, we need multiple bundles.

    const results = []

    // Chunk into bundles of 5
    const BUNDLE_SIZE = 5
    for (let i = 0; i < txs.length; i += BUNDLE_SIZE) {
      const bundleTxs = txs.slice(i, i + BUNDLE_SIZE)

      // Add tip to the last tx in the bundle
      const tipIx = createTipInstruction(fromWallet.publicKey, 0.001) // 0.001 SOL tip
      bundleTxs[bundleTxs.length - 1].add(tipIx)

      const { blockhash } = await connection.getLatestBlockhash()

      bundleTxs.forEach(tx => {
        tx.recentBlockhash = blockhash
        tx.sign(fromWallet)
      })

      const { bundleId } = await sendBundle(bundleTxs, "frankfurt") // Configurable region?
      results.push(bundleId)

      // Wait a bit between bundles to avoid rate limits?
      await new Promise(r => setTimeout(r, 2000))
    }

    return results
  } else {
    // Standard send
    const signatures = []
    for (const tx of txs) {
       const sig = await connection.sendTransaction(tx, [fromWallet])
       await connection.confirmTransaction(sig)
       signatures.push(sig)
    }
    return signatures
  }
}

/**
 * Step 3: Fund Targets from Proxies
 */
export async function fundTargetsFromProxies(
  proxies: { address: string; secretKey: string }[],
  targetWallets: { address: string; amount: number }[],
  useJito: boolean = true
) {
  // Distribute targets to proxies
  const targetsPerProxy = Math.ceil(targetWallets.length / proxies.length)

  const promises = proxies.map(async (proxy, i) => {
    const start = i * targetsPerProxy
    const end = Math.min(start + targetsPerProxy, targetWallets.length)
    const myTargets = targetWallets.slice(start, end)

    if (myTargets.length === 0) return

    const proxyWallet = Keypair.fromSecretKey(bs58.decode(proxy.secretKey))
    return await executeSolTransfers(proxyWallet, myTargets, useJito)
  })

  return await Promise.all(promises)
}
