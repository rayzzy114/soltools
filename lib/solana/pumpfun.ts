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
export const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")

// Instruction Discriminators (Anchor 8-byte)
// global:create -> [24, 30, 200, 40, 5, 28, 7, 119]
export const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119])
// global:buy -> [102, 6, 61, 18, 1, 218, 235, 234]
export const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234])
// global:sell -> [51, 230, 133, 164, 1, 127, 131, 173]
export const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173])

// Constants
export const LAMPORTS_PER_SOL = 1_000_000_000n
export const TOKEN_DECIMALS_FACTOR = 1_000_000n

export const GLOBAL_SEEDS = Buffer.from("global")
export const MINT_AUTHORITY_SEEDS = Buffer.from("mint-authority")
export const BONDING_CURVE_SEEDS = Buffer.from("bonding-curve")
export const METADATA_SEEDS = Buffer.from("metadata")

// PDAs
export function getGlobalAddress(): PublicKey {
  const [global] = PublicKey.findProgramAddressSync(
    [GLOBAL_SEEDS],
    PUMPFUN_PROGRAM_ID
  )
  return global
}

export function getMintAuthorityAddress(): PublicKey {
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [MINT_AUTHORITY_SEEDS],
    PUMPFUN_PROGRAM_ID
  )
  return mintAuthority
}

export function getEventAuthorityAddress(): PublicKey {
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMPFUN_PROGRAM_ID
  )
  return eventAuthority
}

export function getBondingCurveAddress(mint: PublicKey): PublicKey {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEEDS, mint.toBuffer()],
    PUMPFUN_PROGRAM_ID
  )
  return bondingCurve
}

// Associated token account for bonding curve
export function getBondingCurveTokenAccount(mint: PublicKey, bondingCurve: PublicKey): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
        [
            bondingCurve.toBuffer(),
            TOKEN_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )
    return ata
}

// Helper to get the associated bonding curve address
export function getAssociatedBondingCurveAddress(mint: PublicKey): PublicKey {
    const bondingCurve = getBondingCurveAddress(mint)
    return getBondingCurveTokenAccount(mint, bondingCurve)
}

export function getMetadataAddress(mint: PublicKey): PublicKey {
  const [metadata] = PublicKey.findProgramAddressSync(
    [METADATA_SEEDS, MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA_PROGRAM_ID
  )
  return metadata
}

export interface CreatePumpFunTokenParams {
  name: string
  symbol: string
  uri: string
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
 */
export function createPumpFunCreateInstruction(
  creator: PublicKey,
  mint: PublicKey,
  params: CreatePumpFunTokenParams
): TransactionInstruction {
  const bondingCurve = getBondingCurveAddress(mint)
  const associatedBondingCurve = getBondingCurveTokenAccount(mint, bondingCurve)
  const metadata = getMetadataAddress(mint)
  const global = getGlobalAddress()
  const mintAuthority = getMintAuthorityAddress()
  const eventAuthority = getEventAuthorityAddress()

  // Serialize arguments: name, symbol, uri, creator
  const nameBytes = Buffer.from(params.name, "utf8")
  const symbolBytes = Buffer.from(params.symbol, "utf8")
  const uriBytes = Buffer.from(params.uri, "utf8")

  const bufferSize = 8 +
    4 + nameBytes.length +
    4 + symbolBytes.length +
    4 + uriBytes.length +
    32 // creator

  const data = Buffer.alloc(bufferSize)
  let offset = 0

  // Discriminator
  CREATE_DISCRIMINATOR.copy(data, offset)
  offset += 8

  // Name
  data.writeUInt32LE(nameBytes.length, offset)
  offset += 4
  nameBytes.copy(data, offset)
  offset += nameBytes.length

  // Symbol
  data.writeUInt32LE(symbolBytes.length, offset)
  offset += 4
  symbolBytes.copy(data, offset)
  offset += symbolBytes.length

  // Uri
  data.writeUInt32LE(uriBytes.length, offset)
  offset += 4
  uriBytes.copy(data, offset)
  offset += uriBytes.length

  // Creator (as arg)
  creator.toBuffer().copy(data, offset)
  offset += 32

  const keys = [
    { pubkey: mint, isSigner: true, isWritable: true },
    { pubkey: mintAuthority, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: global, isSigner: false, isWritable: false },
    { pubkey: MPL_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: creator, isSigner: true, isWritable: true }, // user
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
  ]

  return new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys,
    data,
  })
}

/**
 * Create instruction to buy tokens on bonding curve
 */
export async function createBuyInstruction(
  buyer: PublicKey,
  mint: PublicKey,
  tokenAmount: bigint,
  maxSolCost: bigint,
  bondingCurveCreator?: string
): Promise<TransactionInstruction> {
  console.log(`Creating buy instruction: buyer=${buyer.toBase58()}, mint=${mint.toBase58()}, maxSolCost=${maxSolCost} lamports`)
  const bondingCurve = getBondingCurveAddress(mint)
  const bondingCurveTokenAccount = getBondingCurveTokenAccount(mint, bondingCurve)
  const buyerTokenAccount = await getAssociatedTokenAddress(mint, buyer, false)
  const global = getGlobalAddress()
  const eventAuthority = getEventAuthorityAddress()

  const FEE_RECIPIENT = new PublicKey("CebN5WGQ4vvepcovs24O1KyeykzzCO3ug0M35DAJLbL6")

  const keys = [
    { pubkey: global, isSigner: false, isWritable: false },
    { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: bondingCurveTokenAccount, isSigner: false, isWritable: true },
    { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
    { pubkey: buyer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
  ]

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
  const global = getGlobalAddress()
  const eventAuthority = getEventAuthorityAddress()

  const FEE_RECIPIENT = new PublicKey("CebN5WGQ4vvepcovs24O1KyeykzzCO3ug0M35DAJLbL6")

  const keys = [
    { pubkey: global, isSigner: false, isWritable: false },
    { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: bondingCurveTokenAccount, isSigner: false, isWritable: true },
    { pubkey: sellerTokenAccount, isSigner: false, isWritable: true },
    { pubkey: seller, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
  ]

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

    const data = accountInfo.data
    const DISCRIMINATOR_LENGTH = 8
    
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
    const creator = new PublicKey(data.slice(offset, offset + 32))
    offset += 32
    const isMayhemMode = data[offset] === 1

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
 */
export function calculateBuyPrice(
  solAmount: bigint,
  virtualTokenReserves: bigint,
  virtualSolReserves: bigint
): { tokensOut: bigint; newPrice: number } {
  const k = virtualTokenReserves * virtualSolReserves
  const newSolReserves = virtualSolReserves + solAmount

  if (newSolReserves <= 0n) {
      return { tokensOut: 0n, newPrice: 0 }
  }

  const newTokenReserves = k / newSolReserves
  const tokensOut = virtualTokenReserves - newTokenReserves

  return {
    tokensOut,
    newPrice: (Number(newSolReserves) / 1e9) / (Number(newTokenReserves) / 1e6),
  }
}

/**
 * Calculate SOL received for selling tokens
 */
export function calculateSellPrice(
  tokenAmount: bigint,
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
