import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
} from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token"
import { connection } from "./config"
import bs58 from "bs58"

// Pump.fun Program ID
export const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")

// Instruction Discriminators (Anchor 8-byte)
export const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119])
export const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234])
export const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173])

// Constants
export const LAMPORTS_PER_SOL = 1_000_000_000n
export const TOKEN_DECIMALS_FACTOR = 1_000_000n

// Bonding curve account (derived from mint)
// NOTE: Seed may need adjustment after testing with real transactions
export function getBondingCurveAddress(mint: PublicKey): PublicKey {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID
  )
  return bondingCurve
}

// Metadata account (derived from mint)
// NOTE: Seed may need adjustment after testing with real transactions
export function getMetadataAddress(mint: PublicKey): PublicKey {
  const [metadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID
  )
  return metadata
}

// Associated token account for bonding curve
export function getBondingCurveTokenAccount(mint: PublicKey, bondingCurve: PublicKey): PublicKey {
  // This is a PDA, so we can calculate it synchronously
  // The bonding curve account itself holds the tokens
  return bondingCurve
}

export interface CreatePumpFunTokenParams {
  name: string
  symbol: string
  description: string
  imageUrl: string
  website?: string
  twitter?: string
  telegram?: string
}

export interface PumpFunTokenInfo {
  mintAddress: string
  bondingCurve: string
  metadata: string
  isComplete: boolean
  marketCap: number
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
  tokenTotalSupply: bigint
  creator?: string
  isMayhemMode?: boolean
}

/**
 * Create instruction to create a token on pump.fun
 * This creates the bonding curve and metadata accounts
 * 
 * NOTE: Instruction structure based on standard Anchor patterns.
 * May need adjustment after analyzing real pump.fun transactions.
 */
export function createPumpFunTokenInstruction(
  creator: PublicKey,
  mint: PublicKey,
  params: CreatePumpFunTokenParams
): TransactionInstruction {
  const bondingCurve = getBondingCurveAddress(mint)
  const metadata = getMetadataAddress(mint)

  // Encode metadata
  const metadataData = Buffer.alloc(512)
  let offset = 0
  
  // Name (max 32 bytes)
  const nameBytes = Buffer.from(params.name.slice(0, 32), "utf8")
  metadataData.writeUInt8(nameBytes.length, offset)
  offset += 1
  nameBytes.copy(metadataData, offset)
  offset += 32

  // Symbol (max 10 bytes)
  const symbolBytes = Buffer.from(params.symbol.slice(0, 10), "utf8")
  metadataData.writeUInt8(symbolBytes.length, offset)
  offset += 1
  symbolBytes.copy(metadataData, offset)
  offset += 10

  // Description (max 200 bytes)
  const descBytes = Buffer.from(params.description.slice(0, 200), "utf8")
  metadataData.writeUInt16LE(descBytes.length, offset)
  offset += 2
  descBytes.copy(metadataData, offset)
  offset += 200

  // Image URL (max 200 bytes)
  const imageBytes = Buffer.from(params.imageUrl.slice(0, 200), "utf8")
  metadataData.writeUInt16LE(imageBytes.length, offset)
  offset += 2
  imageBytes.copy(metadataData, offset)
  offset += 200

  // Website (optional, max 100 bytes)
  if (params.website) {
    const websiteBytes = Buffer.from(params.website.slice(0, 100), "utf8")
    metadataData.writeUInt8(websiteBytes.length, offset)
    offset += 1
    websiteBytes.copy(metadataData, offset)
    offset += 100
  } else {
    offset += 101
  }

  // Twitter (optional, max 50 bytes)
  if (params.twitter) {
    const twitterBytes = Buffer.from(params.twitter.slice(0, 50), "utf8")
    metadataData.writeUInt8(twitterBytes.length, offset)
    offset += 1
    twitterBytes.copy(metadataData, offset)
    offset += 50
  } else {
    offset += 51
  }

  // Telegram (optional, max 50 bytes)
  if (params.telegram) {
    const telegramBytes = Buffer.from(params.telegram.slice(0, 50), "utf8")
    metadataData.writeUInt8(telegramBytes.length, offset)
    offset += 1
    telegramBytes.copy(metadataData, offset)
  }

  const keys = [
    { pubkey: creator, isSigner: true, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ]

  // Instruction discriminator for create
  const instructionData = Buffer.alloc(8 + metadataData.length)
  CREATE_DISCRIMINATOR.copy(instructionData, 0)
  metadataData.copy(instructionData, 8)

  return new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys,
    data: instructionData,
  })
}

/**
 * Create instruction to buy tokens on bonding curve
 */
export async function createBuyInstruction(
  buyer: PublicKey,
  mint: PublicKey,
  tokenAmount: bigint,
  maxSolCost: bigint
): Promise<TransactionInstruction> {
  const bondingCurve = getBondingCurveAddress(mint)
  const bondingCurveTokenAccount = getBondingCurveTokenAccount(mint, bondingCurve)
  const buyerTokenAccount = await getAssociatedTokenAddress(mint, buyer, false)

  const keys = [
    { pubkey: buyer, isSigner: true, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: bondingCurveTokenAccount, isSigner: false, isWritable: true },
    { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]

  // Instruction discriminator for buy + args
  const instructionData = Buffer.alloc(8 + 8 + 8)
  BUY_DISCRIMINATOR.copy(instructionData, 0)
  instructionData.writeBigUInt64LE(tokenAmount, 8)
  instructionData.writeBigUInt64LE(maxSolCost, 16)

  return new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys,
    data: instructionData,
  })
}

/**
 * Create instruction to sell tokens on bonding curve
 */
export async function createSellInstruction(
  seller: PublicKey,
  mint: PublicKey,
  tokenAmount: bigint,
  minSolOut: bigint
): Promise<TransactionInstruction> {
  const bondingCurve = getBondingCurveAddress(mint)
  const bondingCurveTokenAccount = getBondingCurveTokenAccount(mint, bondingCurve)
  const sellerTokenAccount = await getAssociatedTokenAddress(mint, seller, false)

  const keys = [
    { pubkey: seller, isSigner: true, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: bondingCurveTokenAccount, isSigner: false, isWritable: true },
    { pubkey: sellerTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]

  // Instruction discriminator for sell + args
  const instructionData = Buffer.alloc(8 + 8 + 8)
  SELL_DISCRIMINATOR.copy(instructionData, 0)
  instructionData.writeBigUInt64LE(tokenAmount, 8)
  instructionData.writeBigUInt64LE(minSolOut, 16)

  return new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys,
    data: instructionData,
  })
}

/**
 * Get token info from bonding curve account
 */
export async function getPumpFunTokenInfo(mintAddress: string): Promise<PumpFunTokenInfo | null> {
  try {
    const mint = new PublicKey(mintAddress)
    const bondingCurve = getBondingCurveAddress(mint)

    const accountInfo = await connection.getAccountInfo(bondingCurve)
    if (!accountInfo) return null

    // Parse bonding curve data using Anchor IDL structure
    // Structure from IDL: virtual_token_reserves, virtual_sol_reserves, real_token_reserves, 
    //                    real_sol_reserves, token_total_supply, complete, creator, is_mayhem_mode
    // Discriminator is 8 bytes at the start
    const data = accountInfo.data
    const DISCRIMINATOR_LENGTH = 8
    
    // Skip discriminator and parse fields
    let offset = DISCRIMINATOR_LENGTH
    const virtualTokenReserves = data.readBigUInt64LE(offset)
    offset += 8
    const virtualSolReserves = data.readBigUInt64LE(offset)
    offset += 8
    const realTokenReserves = data.readBigUInt64LE(offset)
    offset += 8
    const realSolReserves = data.readBigUInt64LE(offset)
    offset += 8
    const tokenTotalSupply = data.readBigUInt64LE(offset)
    offset += 8
    const isComplete = data[offset] === 1
    offset += 1
    // creator is PublicKey (32 bytes)
    const creator = new PublicKey(data.slice(offset, offset + 32))
    offset += 32
    const isMayhemMode = data[offset] === 1

    // Calculate market cap (virtual reserves)
    // Convert to number only for display/estimation, keeping math in BigInt when possible
    const marketCap = (Number(virtualSolReserves) / 1e9) * 2

    return {
      mintAddress,
      bondingCurve: bondingCurve.toBase58(),
      metadata: getMetadataAddress(mint).toBase58(),
      isComplete,
      marketCap,
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      creator: creator.toBase58(),
      isMayhemMode,
    }
  } catch (error) {
    console.error("Error getting pump.fun token info:", error)
    return null
  }
}

/**
 * Calculate price for buying tokens
 * Uses constant product formula: x * y = k
 */
export function calculateBuyPrice(
  solAmount: bigint, // input in lamports
  virtualTokenReserves: bigint,
  virtualSolReserves: bigint
): { tokensOut: bigint; newPrice: number } {
  const k = virtualTokenReserves * virtualSolReserves
  const newSolReserves = virtualSolReserves + solAmount

  // Prevent division by zero
  if (newSolReserves <= 0n) {
      return { tokensOut: 0n, newPrice: 0 }
  }

  const newTokenReserves = k / newSolReserves
  const tokensOut = virtualTokenReserves - newTokenReserves

  // Calculate new price (SOL per Token)
  // Price = VirtualSol / VirtualToken
  // Scale up for precision if needed, but here we return a number for UI
  const newPrice = Number(newSolReserves) / Number(newTokenReserves) / 1000 // approx correction for units difference (1e9 vs 1e6)

  // Correct price calculation: (SOL/1e9) / (Tokens/1e6)
  // = (SOL * 1e6) / (Tokens * 1e9)
  // = SOL / (Tokens * 1000)

  return {
    tokensOut,
    newPrice: (Number(newSolReserves) / 1e9) / (Number(newTokenReserves) / 1e6),
  }
}

/**
 * Calculate SOL received for selling tokens
 */
export function calculateSellPrice(
  tokenAmount: bigint, // input in token units (with decimals)
  virtualTokenReserves: bigint,
  virtualSolReserves: bigint
): { solOut: bigint; newPrice: number } {
  const k = virtualTokenReserves * virtualSolReserves
  const newTokenReserves = virtualTokenReserves + tokenAmount

  if (newTokenReserves <= 0n) {
      return { solOut: 0n, newPrice: 0 }
  }

  const newSolReserves = k / newTokenReserves
  const solOut = virtualSolReserves - newSolReserves

  return {
    solOut,
    newPrice: (Number(newSolReserves) / 1e9) / (Number(newTokenReserves) / 1e6),
  }
}
