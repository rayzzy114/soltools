/**
 * Test script for pump.fun on devnet
 * Run with: npx tsx scripts/test-devnet.ts
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import { createTokenWithAnchor, getBondingCurveData, buyTokensWithAnchor } from "../lib/solana/pumpfun-anchor"
import { generateMetadata, getMetadataUri } from "../lib/utils/metadata"

const DEVNET_RPC = "https://api.devnet.solana.com"
const connection = new Connection(DEVNET_RPC, "confirmed")

async function testCreateToken() {
  console.log("🧪 Testing token creation on devnet...")
  
  // Generate test keypairs
  const creator = Keypair.generate()
  const mint = Keypair.generate()
  
  console.log(`Creator: ${creator.publicKey.toBase58()}`)
  console.log(`Mint: ${mint.publicKey.toBase58()}`)
  
  // Airdrop SOL to creator (devnet only)
  // Note: Devnet airdrops are rate-limited, may need to retry or use faucet
  try {
    console.log("💰 Requesting airdrop...")
    // Try smaller amount first
    const airdropSig = await connection.requestAirdrop(creator.publicKey, 1 * 1e9) // 1 SOL
    await connection.confirmTransaction(airdropSig, "confirmed")
    console.log(`✅ Airdrop received: ${airdropSig}`)
  } catch (error: any) {
    console.error("❌ Airdrop failed:", error.message)
    console.log("💡 Tip: Use Solana faucet or wait a bit and retry")
    console.log(`   Faucet: https://faucet.solana.com/`)
    console.log(`   Or use existing wallet with devnet SOL`)
    return
  }
  
  // Check balance
  const balance = await connection.getBalance(creator.publicKey)
  console.log(`💰 Creator balance: ${balance / 1e9} SOL`)
  
  if (balance < 0.1 * 1e9) {
    console.error("❌ Insufficient balance. Need at least 0.1 SOL")
    return
  }
  
  // Generate metadata
  const metadataJson = generateMetadata({
    name: "Test Token",
    symbol: "TEST",
    description: "Test token for pump.fun integration",
    imageUrl: "https://via.placeholder.com/512",
  })
  const metadataUri = getMetadataUri(metadataJson)
  
  console.log("📝 Creating token transaction...")
  try {
    const transaction = await createTokenWithAnchor(creator, mint, {
      name: "Test Token",
      symbol: "TEST",
      uri: metadataUri,
      creator: creator.publicKey,
    })
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash("confirmed")
    transaction.recentBlockhash = blockhash
    transaction.feePayer = creator.publicKey
    
    // Sign transaction
    transaction.sign(creator, mint)
    
    // Send transaction
    console.log("📤 Sending transaction...")
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    })
    
    console.log(`⏳ Transaction sent: ${signature}`)
    console.log(`🔗 View on Solscan: https://solscan.io/tx/${signature}?cluster=devnet`)
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(signature, "confirmed")
    console.log(`✅ Transaction confirmed! Slot: ${confirmation.context.slot}`)
    
    // Check bonding curve
    console.log("🔍 Checking bonding curve...")
    const bondingCurveData = await getBondingCurveData(mint.publicKey)
    
    if (bondingCurveData) {
      console.log("✅ Bonding curve created!")
      console.log(`   Virtual Token Reserves: ${bondingCurveData.virtualTokenReserves.toString()}`)
      console.log(`   Virtual SOL Reserves: ${bondingCurveData.virtualSolReserves.toString()}`)
      console.log(`   Complete: ${bondingCurveData.complete}`)
      console.log(`   Creator: ${bondingCurveData.creator.toBase58()}`)
    } else {
      console.log("❌ Bonding curve not found")
    }
    
    return { mint: mint.publicKey, signature }
  } catch (error: any) {
    console.error("❌ Error creating token:", error)
    if (error.logs) {
      console.error("Program logs:", error.logs)
    }
    throw error
  }
}

async function testBuyTokens(mintAddress: string, buyer: Keypair) {
  console.log("\n🧪 Testing buy tokens...")
  
  // Airdrop to buyer
  try {
    console.log("💰 Requesting buyer airdrop...")
    const airdropSig = await connection.requestAirdrop(buyer.publicKey, 0.5 * 1e9) // 0.5 SOL
    await connection.confirmTransaction(airdropSig, "confirmed")
    console.log(`✅ Buyer airdrop received`)
  } catch (error: any) {
    console.error("❌ Buyer airdrop failed:", error.message)
    console.log("💡 Skipping buy test - need SOL for buyer")
    return
  }
  
  // Check balance
  const balance = await connection.getBalance(buyer.publicKey)
  console.log(`💰 Buyer balance: ${balance / 1e9} SOL`)
  
  const mint = new PublicKey(mintAddress)
  const solAmount = 0.1 // 0.1 SOL
  
  try {
    const transaction = await buyTokensWithAnchor(
      buyer.publicKey,
      mint,
      solAmount,
      0, // minTokensOut
      true // trackVolume
    )
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash("confirmed")
    transaction.recentBlockhash = blockhash
    transaction.feePayer = buyer.publicKey
    
    transaction.sign(buyer)
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    })
    
    console.log(`⏳ Buy transaction sent: ${signature}`)
    const confirmation = await connection.confirmTransaction(signature, "confirmed")
    console.log(`✅ Buy confirmed! Slot: ${confirmation.context.slot}`)
    
    // Check bonding curve again
    const bondingCurveData = await getBondingCurveData(mint)
    if (bondingCurveData) {
      console.log(`   Virtual SOL Reserves: ${bondingCurveData.virtualSolReserves.toString()}`)
      console.log(`   Virtual Token Reserves: ${bondingCurveData.virtualTokenReserves.toString()}`)
    }
  } catch (error: any) {
    console.error("❌ Error buying tokens:", error)
    if (error.logs) {
      console.error("Program logs:", error.logs)
    }
  }
}

async function main() {
  console.log("🚀 Starting pump.fun devnet tests...\n")
  
  try {
    // Test 1: Create token
    const result = await testCreateToken()
    
    if (result) {
      // Test 2: Buy tokens
      const buyer = Keypair.generate()
      await testBuyTokens(result.mint.toBase58(), buyer)
    }
    
    console.log("\n✅ All tests completed!")
  } catch (error) {
    console.error("\n❌ Tests failed:", error)
    process.exit(1)
  }
}

main()

