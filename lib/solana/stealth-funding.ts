import { Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { connection } from "./config"
import bs58 from "bs58"
import { sendBundle, createTipInstruction, type JitoRegion } from "./jito"

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
  let targetIndex = 0
  for (let i = 0; i < proxies.length; i++) {
    let proxyTotal = 0
    const count = Math.min(targetsPerProxy, targetWallets.length - targetIndex)

    for (let j = 0; j < count; j++) {
      if (targetIndex < targetWallets.length) {
        // Add jitter to target amount
        const targetAmount = applyJitter(targetWallets[targetIndex].amount, config.jitterPercent)
        targetWallets[targetIndex].amount = targetAmount
        proxyTotal += targetAmount
        targetIndex++
      }
    }

    // Add transaction fees buffer (approx 0.005 SOL per proxy for its outgoing txs + tip)
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
  useJito: boolean = true,
  region: JitoRegion = "frankfurt"
) {
  const mainWallet = Keypair.fromSecretKey(bs58.decode(mainSecretKey))
  return await executeSolTransfers(mainWallet, proxies, useJito, region)
}

/**
 * Step 3: Fund Targets from specific Proxy
 */
export async function fundTargetsFromProxy(
  proxySecretKey: string,
  targets: { address: string; amount: number }[],
  useJito: boolean = true,
  region: JitoRegion = "frankfurt"
) {
  const proxyWallet = Keypair.fromSecretKey(bs58.decode(proxySecretKey))
  return await executeSolTransfers(proxyWallet, targets, useJito, region)
}

/**
 * Execute batch SOL transfers
 */
async function executeSolTransfers(
  fromWallet: Keypair,
  transfers: { address: string; amount: number }[],
  useJito: boolean,
  region: JitoRegion
) {
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

  const results = []

  // Send via Jito (bundled in groups of 5) or Standard
  const BUNDLE_SIZE = 5

  if (useJito) {
    for (let i = 0; i < txs.length; i += BUNDLE_SIZE) {
      const bundleTxs = txs.slice(i, i + BUNDLE_SIZE)

      // Add tip to the last tx in the bundle
      const tipIx = createTipInstruction(fromWallet.publicKey, 0.001, region)
      bundleTxs[bundleTxs.length - 1].add(tipIx)

      const { blockhash } = await connection.getLatestBlockhash()

      bundleTxs.forEach(tx => {
        tx.recentBlockhash = blockhash
        tx.sign(fromWallet)
      })

      const { bundleId } = await sendBundle(bundleTxs, region)
      results.push(bundleId)

      // Small delay to avoid rate limits if many bundles
      if (i + BUNDLE_SIZE < txs.length) {
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  } else {
    for (const tx of txs) {
       const sig = await connection.sendTransaction(tx, [fromWallet])
       await connection.confirmTransaction(sig)
       results.push(sig)
    }
  }

  return results
}
