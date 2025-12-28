import { Program, AnchorProvider, BN } from "@coral-xyz/anchor"
import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, TransactionMessage } from "@solana/web3.js"
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token"
import { getConnection } from "./config"
import { getPumpFunProgram } from "./idl-loader"
import { PUMPFUN_PROGRAM_ID } from "./pumpfun"

// Metaplex Token Metadata Program
export const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")

/**
 * Get global PDA
 */
export function getGlobalAddress(): PublicKey {
  const [global] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMPFUN_PROGRAM_ID
  )
  return global
}

/**
 * Get mint authority PDA
 */
export function getMintAuthorityAddress(): PublicKey {
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-authority")],
    PUMPFUN_PROGRAM_ID
  )
  return mintAuthority
}

/**
 * Get bonding curve PDA
 */
export function getBondingCurveAddress(mint: PublicKey): PublicKey {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID
  )
  return bondingCurve
}

/**
 * Get associated bonding curve token account PDA
 */
export async function getAssociatedBondingCurveAddress(mint: PublicKey): Promise<PublicKey> {
  const bondingCurve = getBondingCurveAddress(mint)
  return getAssociatedTokenAddress(mint, bondingCurve, true)
}

/**
 * Get metadata PDA (Metaplex)
 */
export function getMetadataAddress(mint: PublicKey): PublicKey {
  const [metadata] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  )
  return metadata
}

/**
 * Get event authority PDA
 */
export function getEventAuthorityAddress(): PublicKey {
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMPFUN_PROGRAM_ID
  )
  return eventAuthority
}

/**
 * Get creator vault PDA
 * Note: Creator is stored in bonding curve account, Anchor will resolve this automatically
 */
export function getCreatorVaultAddress(creator: PublicKey): PublicKey {
  const [creatorVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    PUMPFUN_PROGRAM_ID
  )
  return creatorVault
}

export interface CreateTokenParams {
  name: string
  symbol: string
  uri: string // JSON metadata URI (IPFS or HTTP)
  creator: PublicKey
}

/**
 * Create token using Anchor Program
 */
export async function createTokenWithAnchor(
  user: Keypair,
  mint: Keypair,
  params: CreateTokenParams
): Promise<Transaction> {
  const program = getPumpFunProgram(user)
  const global = getGlobalAddress()
  const mintAuthority = getMintAuthorityAddress()
  const bondingCurve = getBondingCurveAddress(mint.publicKey)
  const associatedBondingCurve = await getAssociatedBondingCurveAddress(mint.publicKey)
  const metadata = getMetadataAddress(mint.publicKey)
  const eventAuthority = getEventAuthorityAddress()

  const tx = await program.methods
    .create(params.name, params.symbol, params.uri, params.creator)
    .accounts({
      mint: mint.publicKey,
      mintAuthority,
      bondingCurve,
      associatedBondingCurve,
      global,
      mplTokenMetadata: METADATA_PROGRAM_ID,
      metadata,
      user: user.publicKey,
      systemProgram: PublicKey.default, // Will be set by Anchor
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: PublicKey.default, // Will be set by Anchor
      eventAuthority,
      program: PUMPFUN_PROGRAM_ID,
    })
    .signers([mint, user])
    .transaction()

  return tx
}

/**
 * Buy tokens using Anchor Program
 */
export async function buyTokensWithAnchor(
  user: PublicKey,
  mint: PublicKey,
  solAmount: number,
  minTokensOut: number = 0,
  trackVolume: boolean = true
): Promise<Transaction> {
  const program = getPumpFunProgram()
  const global = getGlobalAddress()
  const bondingCurve = getBondingCurveAddress(mint)
  const associatedBondingCurve = await getAssociatedBondingCurveAddress(mint)
  const associatedUser = await getAssociatedTokenAddress(mint, user, false)
  const feeRecipient = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM") // From IDL analysis
  const eventAuthority = getEventAuthorityAddress()

  const spendableSolIn = new BN(solAmount * 1e9)
  const minTokensOutBN = new BN(minTokensOut)

  // Get bonding curve to find creator for creator_vault
  // Note: In production, you might need to fetch this first or let Anchor resolve it
  const bondingCurveData = await getBondingCurveData(mint)
  const creator = bondingCurveData?.creator || user // Fallback to user if not found
  const creatorVault = getCreatorVaultAddress(creator)

  const tx = await program.methods
    .buy(spendableSolIn, minTokensOutBN, trackVolume ? { some: true } : null)
    .accounts({
      global,
      feeRecipient,
      mint,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      user,
      systemProgram: PublicKey.default,
      tokenProgram: TOKEN_PROGRAM_ID,
      creatorVault,
      eventAuthority,
      program: PUMPFUN_PROGRAM_ID,
    })
    .transaction()

  return tx
}

/**
 * Sell tokens using Anchor Program
 */
export async function sellTokensWithAnchor(
  user: PublicKey,
  mint: PublicKey,
  tokenAmount: number,
  minSolOutput: number = 0
): Promise<Transaction> {
  const program = getPumpFunProgram()
  const global = getGlobalAddress()
  const bondingCurve = getBondingCurveAddress(mint)
  const associatedBondingCurve = await getAssociatedBondingCurveAddress(mint)
  const associatedUser = await getAssociatedTokenAddress(mint, user, false)
  const feeRecipient = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM")
  const eventAuthority = getEventAuthorityAddress()

  const amount = new BN(tokenAmount)
  const minSolOutputBN = new BN(minSolOutput * 1e9)

  // Get bonding curve to find creator for creator_vault
  const bondingCurveData = await getBondingCurveData(mint)
  const creator = bondingCurveData?.creator || user // Fallback to user if not found
  const creatorVault = getCreatorVaultAddress(creator)

  const tx = await program.methods
    .sell(amount, minSolOutputBN)
    .accounts({
      global,
      feeRecipient,
      mint,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      user,
      systemProgram: PublicKey.default,
      tokenProgram: TOKEN_PROGRAM_ID,
      creatorVault,
      eventAuthority,
      program: PUMPFUN_PROGRAM_ID,
    })
    .transaction()

  return tx
}

/**
 * Get bonding curve account data
 */
export async function getBondingCurveData(mint: PublicKey): Promise<any> {
  const program = getPumpFunProgram()
  const bondingCurve = getBondingCurveAddress(mint)
  
  try {
    const bondingCurveAccount = await program.account.bondingCurve.fetch(bondingCurve)
    return {
      virtualTokenReserves: bondingCurveAccount.virtualTokenReserves,
      virtualSolReserves: bondingCurveAccount.virtualSolReserves,
      realTokenReserves: bondingCurveAccount.realTokenReserves,
      realSolReserves: bondingCurveAccount.realSolReserves,
      tokenTotalSupply: bondingCurveAccount.tokenTotalSupply,
      complete: bondingCurveAccount.complete,
      creator: bondingCurveAccount.creator,
      isMayhemMode: bondingCurveAccount.isMayhemMode,
    }
  } catch (error) {
    console.error("Error fetching bonding curve:", error)
    return null
  }
}

