import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
} from "@solana/web3.js"
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
  burn,
  getMint,
  getAccount,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  getMinimumBalanceForRentExemptMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token"
import { connection } from "./config"
import {
  getPumpFunTokenInfo,
  calculateBuyPrice,
  calculateSellPrice,
} from "./pumpfun"
import {
  createTokenWithAnchor,
  buyTokensWithAnchor,
  sellTokensWithAnchor,
  getBondingCurveData,
  type CreateTokenParams as AnchorCreateTokenParams,
} from "./pumpfun-anchor"
import { generateMetadata, getMetadataUri } from "@/lib/utils/metadata"

export interface CreateTokenParams {
  name: string
  symbol: string
  decimals: number
  totalSupply: number
  description?: string
  imageUrl?: string
  revokeMintAuthority?: boolean
  revokeFreezeAuthority?: boolean
}

// Pump.fun specific params
export interface CreatePumpFunTokenParams {
  name: string
  symbol: string
  description?: string
  imageUrl?: string
  website?: string
  twitter?: string
  telegram?: string
}

export interface TokenInfo {
  mintAddress: string
  name: string
  symbol: string
  decimals: number
  totalSupply: string
  supply: string
  holders?: number
}

export async function createToken(
  payer: Keypair,
  params: CreateTokenParams
): Promise<string> {
  // Create mint with payer as mint authority
  const mintPublicKey = await createMint(
    connection,
    payer,
    payer.publicKey, // mint authority
    payer.publicKey, // freeze authority (can be null)
    params.decimals
  )

  // Create associated token account for payer
  const associatedTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintPublicKey,
    payer.publicKey
  )

  // Mint tokens to the payer's account
  await mintTo(
    connection,
    payer,
    mintPublicKey,
    associatedTokenAccount.address,
    payer,
    BigInt(params.totalSupply) * BigInt(10 ** params.decimals)
  )

  // Note: Revoking mint/freeze authority would require additional transactions
  // This is a simplified version - in production, add those transactions if needed

  return mintPublicKey.toBase58()
}

export async function getTokenInfo(mintAddress: string): Promise<TokenInfo | null> {
  try {
    const mintPublicKey = new PublicKey(mintAddress)
    const mintInfo = await getMint(connection, mintPublicKey)
    
    return {
      mintAddress,
      name: "",
      symbol: "",
      decimals: mintInfo.decimals,
      totalSupply: mintInfo.supply.toString(),
      supply: mintInfo.supply.toString(),
    }
  } catch (error) {
    console.error("Error getting token info:", error)
    return null
  }
}

export async function burnTokens(
  payer: Keypair,
  mintAddress: string,
  amount: bigint
): Promise<string> {
  const mintPublicKey = new PublicKey(mintAddress)
  const associatedTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintPublicKey,
    payer.publicKey
  )

  const signature = await burn(
    connection,
    payer,
    associatedTokenAccount.address,
    mintPublicKey,
    payer,
    amount
  )

  return signature
}

export async function transferTokens(
  from: Keypair,
  to: PublicKey,
  mintAddress: string,
  amount: bigint
): Promise<string> {
  const mintPublicKey = new PublicKey(mintAddress)
  
  const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    from,
    mintPublicKey,
    from.publicKey
  )

  const toTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    from,
    mintPublicKey,
    to
  )

  const signature = await transfer(
    connection,
    from,
    fromTokenAccount.address,
    toTokenAccount.address,
    from,
    amount
  )

  return signature
}

/**
 * Create token on pump.fun using Anchor
 * Returns transaction that needs to be signed by wallet
 */
export async function createPumpFunToken(
  creator: Keypair,
  mint: Keypair,
  params: CreatePumpFunTokenParams
): Promise<Transaction> {
  // Generate metadata JSON
  const metadataJson = generateMetadata({
    name: params.name,
    symbol: params.symbol,
    description: params.description || "",
    imageUrl: params.imageUrl || "",
    website: params.website,
    twitter: params.twitter,
    telegram: params.telegram,
  })

  // Get metadata URI (for now using data URI, should upload to IPFS in production)
  const metadataUri = getMetadataUri(metadataJson)

  // Create token using Anchor
  const transaction = await createTokenWithAnchor(creator, mint, {
    name: params.name,
    symbol: params.symbol,
    uri: metadataUri,
    creator: creator.publicKey,
  })

  return transaction
}

/**
 * Buy tokens on pump.fun bonding curve using Anchor
 */
export async function buyPumpFunToken(
  buyer: PublicKey,
  mintAddress: string,
  solAmount: number,
  minTokensOut: number = 0
): Promise<Transaction> {
  const mint = new PublicKey(mintAddress)
  
  // Use Anchor to create buy transaction
  const transaction = await buyTokensWithAnchor(
    buyer,
    mint,
    solAmount,
    minTokensOut,
    true // trackVolume
  )

  return transaction
}

/**
 * Sell tokens on pump.fun bonding curve using Anchor
 */
export async function sellPumpFunToken(
  seller: PublicKey,
  mintAddress: string,
  tokenAmount: number, // Changed from bigint to number for Anchor compatibility
  minSolOutput: number = 0
): Promise<Transaction> {
  const mint = new PublicKey(mintAddress)
  
  // Use Anchor to create sell transaction
  const transaction = await sellTokensWithAnchor(
    seller,
    mint,
    tokenAmount,
    minSolOutput
  )

  return transaction
}

/**
 * @deprecated This function is not needed for ragpull on pump.fun/pumpswap
 * 
 * On pump.fun:
 * - Before graduation: sell tokens via bonding curve (buildSellTransaction in pumpfun-sdk.ts)
 * - After graduation: sell tokens via pumpswap AMM (buildPumpswapSwapTransaction in pumpfun-sdk.ts)
 * 
 * LP is automatically locked on graduation - creators CANNOT remove it.
 * Use buildRagpullTransaction() from pumpfun-sdk.ts for ragpull functionality.
 */
export async function removeLiquidityPumpSwap(
  _user: PublicKey,
  _mintAddress: string
): Promise<Transaction> {
  throw new Error(
    "removeLiquidityPumpSwap is deprecated. " +
    "LP is locked on PumpSwap graduation - cannot be removed. " +
    "Use buildRagpullTransaction() from pumpfun-sdk.ts to sell tokens instead."
  )
}

/**
 * Get current price from bonding curve
 */
export async function getPumpFunPrice(mintAddress: string): Promise<number | null> {
  const tokenInfo = await getPumpFunTokenInfo(mintAddress)
  if (!tokenInfo || tokenInfo.isComplete) return null

  // Price = virtual SOL reserves / virtual token reserves
  const price = (tokenInfo.virtualSolReserves / 1e9) / (tokenInfo.virtualTokenReserves / 1e6)
  return price
}

/**
 * Check if token has migrated to PumpSwap
 */
export async function isTokenMigrated(mintAddress: string): Promise<boolean> {
  const tokenInfo = await getPumpFunTokenInfo(mintAddress)
  return tokenInfo?.isComplete ?? false
}

