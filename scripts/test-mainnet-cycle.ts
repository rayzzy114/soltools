/**
 * Mainnet Full Cycle Test
 * 
 * ⚠️  WARNING: This script executes REAL transactions on mainnet!
 * ⚠️  You will spend actual SOL and create real tokens!
 * 
 * Run with: npx tsx scripts/test-mainnet-cycle.ts
 * 
 * Required environment variables:
 * - CREATOR_SECRET_KEY: Base58 encoded creator wallet secret key
 * - VOLUME_WALLET_1: Base58 encoded volume wallet 1 secret key
 * - VOLUME_WALLET_2: Base58 encoded volume wallet 2 secret key
 * - VOLUME_WALLET_3: Base58 encoded volume wallet 3 secret key
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import bs58 from "bs58"
import {
  isPumpFunAvailable,
  getBondingCurveData,
  buildCreateTokenTransaction,
  buildBuyTransaction,
  buildSellTransaction,
  calculateBuyAmount,
  calculateSellAmount,
  calculateTokenPrice,
  uploadMetadataToPumpFun,
  buildRagpullTransaction,
  getUserTokenBalance,
  type BondingCurveData,
} from "../lib/solana/pumpfun-sdk"
import { connection, SOLANA_NETWORK } from "../lib/solana/config"
import {
  sendBundle,
  waitForBundleConfirmation,
  createTipInstruction,
  estimateTip,
} from "../lib/solana/jito"
import {
  generateWallet,
  refreshWalletBalances,
  type VolumeWallet,
} from "../lib/solana/volume-bot-engine"

// configuration
const CONFIG = {
  // initial buy amount in SOL
  initialBuyAmount: 0.5,
  // number of volume bot cycles
  volumeCycles: 5,
  // trade amount range for volume bot
  minTradeAmount: 0.02,
  maxTradeAmount: 0.08,
  // interval between trades (ms)
  tradeInterval: 3000,
  // slippage percentage
  slippage: 15,
  // priority fee
  priorityFee: 0.0005,
  // jito tip
  jitoTip: 0.0001,
}

interface CycleResult {
  success: boolean
  tokenMint?: string
  initialInvestment: number
  finalReturn: number
  profit: number
  roi: number
  volumeGenerated: number
  feesSpent: number
  error?: string
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getWalletBalance(publicKey: PublicKey): Promise<number> {
  const balance = await connection.getBalance(publicKey)
  return balance / LAMPORTS_PER_SOL
}

async function loadWallets(): Promise<{
  creator: Keypair
  volumeWallets: VolumeWallet[]
}> {
  const creatorKey = process.env.CREATOR_SECRET_KEY
  if (!creatorKey) {
    throw new Error("CREATOR_SECRET_KEY not set")
  }
  
  const creator = Keypair.fromSecretKey(bs58.decode(creatorKey))
  
  const volumeWallets: VolumeWallet[] = []
  for (let i = 1; i <= 3; i++) {
    const key = process.env[`VOLUME_WALLET_${i}`]
    if (key) {
      const keypair = Keypair.fromSecretKey(bs58.decode(key))
      volumeWallets.push({
        publicKey: keypair.publicKey.toBase58(),
        secretKey: key,
        solBalance: 0,
        tokenBalance: 0,
        isActive: true,
      })
    }
  }
  
  return { creator, volumeWallets }
}

async function phase1_createToken(creator: Keypair): Promise<{ mint: Keypair; signature: string }> {
  console.log("\n📝 Phase 1: Creating Token...")
  
  // generate mint
  const mint = Keypair.generate()
  console.log(`Mint: ${mint.publicKey.toBase58()}`)
  
  // upload metadata (you need to provide real image)
  const metadata = {
    name: "Test Pump Token",
    symbol: "TPUMP",
    description: "Test token for pump.fun cycle testing",
    file: new Blob(["placeholder"]), // replace with actual image
    twitter: "",
    telegram: "",
    website: "",
  }
  
  console.log("⚠️  Skipping metadata upload (no real image)")
  const metadataUri = "https://placeholder.uri" // would be real IPFS URI
  
  // build transaction
  const transaction = await buildCreateTokenTransaction(
    creator.publicKey,
    mint,
    metadata.name,
    metadata.symbol,
    metadataUri,
    CONFIG.priorityFee
  )
  
  // sign
  transaction.sign(creator, mint)
  
  // send
  console.log("Sending create transaction...")
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })
  
  console.log(`TX: ${signature}`)
  await connection.confirmTransaction(signature, "confirmed")
  console.log("✅ Token created!")
  
  return { mint, signature }
}

async function phase2_initialBuy(
  creator: Keypair,
  mint: PublicKey,
  amount: number
): Promise<string> {
  console.log(`\n💰 Phase 2: Initial Buy (${amount} SOL)...`)
  
  // wait for bonding curve to be created
  await sleep(2000)
  
  const bondingCurve = await getBondingCurveData(mint)
  if (!bondingCurve) {
    throw new Error("Bonding curve not found")
  }
  
  const { tokensOut, priceImpact } = calculateBuyAmount(bondingCurve, amount)
  console.log(`Expected tokens: ${(Number(tokensOut) / 1e6).toFixed(0)}`)
  console.log(`Price impact: ${priceImpact.toFixed(2)}%`)
  
  const minTokensOut = tokensOut * BigInt(100 - CONFIG.slippage) / BigInt(100)
  
  const transaction = await buildBuyTransaction(
    creator.publicKey,
    mint,
    amount,
    minTokensOut,
    CONFIG.priorityFee
  )
  
  transaction.sign(creator)
  
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })
  
  console.log(`TX: ${signature}`)
  await connection.confirmTransaction(signature, "confirmed")
  console.log("✅ Initial buy complete!")
  
  return signature
}

async function phase3_volumeBot(
  wallets: VolumeWallet[],
  mint: PublicKey,
  cycles: number
): Promise<{ volumeGenerated: number; feesSpent: number }> {
  console.log(`\n🔄 Phase 3: Volume Bot (${cycles} cycles)...`)
  
  let volumeGenerated = 0
  let feesSpent = 0
  let lastAction: "buy" | "sell" = "sell"
  
  for (let i = 0; i < cycles; i++) {
    console.log(`\nCycle ${i + 1}/${cycles}`)
    
    for (const wallet of wallets) {
      const keypair = Keypair.fromSecretKey(bs58.decode(wallet.secretKey))
      const bondingCurve = await getBondingCurveData(mint)
      
      if (!bondingCurve || bondingCurve.complete) {
        console.log("⚠️  Token graduated or curve not found")
        continue
      }
      
      // alternate between buy and sell
      const action = lastAction === "buy" ? "sell" : "buy"
      lastAction = action
      
      const amount = CONFIG.minTradeAmount + Math.random() * (CONFIG.maxTradeAmount - CONFIG.minTradeAmount)
      
      try {
        if (action === "buy") {
          const { tokensOut } = calculateBuyAmount(bondingCurve, amount)
          const minTokensOut = tokensOut * BigInt(100 - CONFIG.slippage) / BigInt(100)
          
          const tx = await buildBuyTransaction(
            keypair.publicKey,
            mint,
            amount,
            minTokensOut,
            CONFIG.priorityFee
          )
          tx.sign(keypair)
          
          const sig = await connection.sendRawTransaction(tx.serialize())
          await connection.confirmTransaction(sig, "confirmed")
          
          console.log(`  ✅ ${wallet.publicKey.slice(0, 8)}... BUY ${amount.toFixed(4)} SOL`)
          volumeGenerated += amount
        } else {
          // get token balance
          const { balance } = await getUserTokenBalance(keypair.publicKey, mint)
          if (balance === BigInt(0)) {
            console.log(`  ⏭️  ${wallet.publicKey.slice(0, 8)}... No tokens to sell`)
            continue
          }
          
          const sellAmount = balance / BigInt(2) // sell half
          const { solOut } = calculateSellAmount(bondingCurve, sellAmount)
          const minSolOut = solOut * BigInt(100 - CONFIG.slippage) / BigInt(100)
          
          const tx = await buildSellTransaction(
            keypair.publicKey,
            mint,
            sellAmount,
            minSolOut,
            CONFIG.priorityFee
          )
          tx.sign(keypair)
          
          const sig = await connection.sendRawTransaction(tx.serialize())
          await connection.confirmTransaction(sig, "confirmed")
          
          const solValue = Number(solOut) / LAMPORTS_PER_SOL
          console.log(`  ✅ ${wallet.publicKey.slice(0, 8)}... SELL ${solValue.toFixed(4)} SOL`)
          volumeGenerated += solValue
        }
        
        feesSpent += CONFIG.priorityFee
      } catch (error: any) {
        console.log(`  ❌ ${wallet.publicKey.slice(0, 8)}... Error: ${error.message}`)
      }
      
      await sleep(CONFIG.tradeInterval)
    }
  }
  
  console.log(`\n📊 Volume generated: ${volumeGenerated.toFixed(4)} SOL`)
  return { volumeGenerated, feesSpent }
}

async function phase4_ragpull(
  wallets: VolumeWallet[],
  creator: Keypair,
  mint: PublicKey
): Promise<number> {
  console.log("\n💸 Phase 4: Ragpull (Selling all tokens)...")
  
  let totalReturns = 0
  
  // sell from all wallets including creator
  const allWallets = [
    { publicKey: creator.publicKey.toBase58(), secretKey: bs58.encode(creator.secretKey) },
    ...wallets.map(w => ({ publicKey: w.publicKey, secretKey: w.secretKey })),
  ]
  
  for (const wallet of allWallets) {
    const keypair = Keypair.fromSecretKey(bs58.decode(wallet.secretKey))
    
    try {
      const { transaction, estimatedSol, tokenAmount } = await buildRagpullTransaction(
        keypair.publicKey,
        mint,
        20 // high slippage for ragpull
      )
      
      if (tokenAmount === BigInt(0)) {
        console.log(`  ⏭️  ${wallet.publicKey.slice(0, 8)}... No tokens`)
        continue
      }
      
      transaction.sign(keypair)
      
      const sig = await connection.sendRawTransaction(transaction.serialize())
      await connection.confirmTransaction(sig, "confirmed")
      
      const solValue = Number(estimatedSol) / LAMPORTS_PER_SOL
      totalReturns += solValue
      
      console.log(`  ✅ ${wallet.publicKey.slice(0, 8)}... Sold ${(Number(tokenAmount) / 1e6).toFixed(0)} tokens for ~${solValue.toFixed(4)} SOL`)
    } catch (error: any) {
      console.log(`  ❌ ${wallet.publicKey.slice(0, 8)}... Error: ${error.message}`)
    }
  }
  
  console.log(`\n📊 Total returns: ${totalReturns.toFixed(4)} SOL`)
  return totalReturns
}

async function main(): Promise<CycleResult> {
  console.log("🚀 Starting Mainnet Full Cycle Test")
  console.log("═".repeat(50))
  
  // check network
  if (SOLANA_NETWORK !== "mainnet-beta") {
    console.log("⚠️  Not on mainnet. Current network:", SOLANA_NETWORK)
    console.log("Set SOLANA_NETWORK=mainnet-beta to run real tests")
    return {
      success: false,
      initialInvestment: 0,
      finalReturn: 0,
      profit: 0,
      roi: 0,
      volumeGenerated: 0,
      feesSpent: 0,
      error: "Not on mainnet",
    }
  }
  
  if (!isPumpFunAvailable()) {
    return {
      success: false,
      initialInvestment: 0,
      finalReturn: 0,
      profit: 0,
      roi: 0,
      volumeGenerated: 0,
      feesSpent: 0,
      error: "pump.fun not available",
    }
  }
  
  try {
    const { creator, volumeWallets } = await loadWallets()
    console.log(`\nCreator: ${creator.publicKey.toBase58()}`)
    console.log(`Volume wallets: ${volumeWallets.length}`)
    
    // check balances
    const creatorBalance = await getWalletBalance(creator.publicKey)
    console.log(`Creator balance: ${creatorBalance.toFixed(4)} SOL`)
    
    if (creatorBalance < 1) {
      throw new Error("Insufficient creator balance (need at least 1 SOL)")
    }
    
    // track investment
    let initialInvestment = 0
    let feesSpent = 0
    
    // Phase 1: Create token
    const { mint } = await phase1_createToken(creator)
    initialInvestment += 0.02 // creation cost
    
    // Phase 2: Initial buy
    await phase2_initialBuy(creator, mint.publicKey, CONFIG.initialBuyAmount)
    initialInvestment += CONFIG.initialBuyAmount
    
    // Phase 3: Volume bot
    const volumeResult = await phase3_volumeBot(
      volumeWallets,
      mint.publicKey,
      CONFIG.volumeCycles
    )
    feesSpent += volumeResult.feesSpent
    
    // Wait a bit for price to stabilize
    console.log("\n⏳ Waiting for price to stabilize...")
    await sleep(5000)
    
    // Phase 4: Ragpull
    const finalReturn = await phase4_ragpull(volumeWallets, creator, mint.publicKey)
    
    // Calculate profit
    const profit = finalReturn - initialInvestment - feesSpent
    const roi = (profit / initialInvestment) * 100
    
    console.log("\n" + "═".repeat(50))
    console.log("📊 FINAL RESULTS")
    console.log("═".repeat(50))
    console.log(`Token: ${mint.publicKey.toBase58()}`)
    console.log(`Initial Investment: ${initialInvestment.toFixed(4)} SOL`)
    console.log(`Final Return: ${finalReturn.toFixed(4)} SOL`)
    console.log(`Fees Spent: ${feesSpent.toFixed(4)} SOL`)
    console.log(`Volume Generated: ${volumeResult.volumeGenerated.toFixed(4)} SOL`)
    console.log(`Profit: ${profit.toFixed(4)} SOL`)
    console.log(`ROI: ${roi.toFixed(2)}%`)
    console.log("═".repeat(50))
    
    return {
      success: true,
      tokenMint: mint.publicKey.toBase58(),
      initialInvestment,
      finalReturn,
      profit,
      roi,
      volumeGenerated: volumeResult.volumeGenerated,
      feesSpent,
    }
  } catch (error: any) {
    console.error("\n❌ Error:", error.message)
    return {
      success: false,
      initialInvestment: 0,
      finalReturn: 0,
      profit: 0,
      roi: 0,
      volumeGenerated: 0,
      feesSpent: 0,
      error: error.message,
    }
  }
}

main().then(result => {
  if (result.success) {
    console.log("\n✅ Test completed successfully!")
  } else {
    console.log("\n❌ Test failed:", result.error)
  }
  process.exit(result.success ? 0 : 1)
})
