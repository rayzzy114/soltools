import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token"
import { connection, getResilientConnection, SOLANA_NETWORK, RPC_ENDPOINT } from "./config"
import { LRUCache } from "lru-cache"
import { fetchWithRetry } from "../utils/fetch-retry"
import bs58 from "bs58"
import {
  PUMPFUN_PROGRAM_ID,
  CREATE_DISCRIMINATOR,
  BUY_DISCRIMINATOR,
  SELL_DISCRIMINATOR,
  LAMPORTS_PER_SOL,
  TOKEN_DECIMALS_FACTOR,
  getBondingCurveAddress,
  getMetadataAddress,
  createPumpFunCreateInstruction,
  createBuyInstruction,
  createSellInstruction,
} from "./pumpfun"

// pump.fun constants
export { PUMPFUN_PROGRAM_ID, getBondingCurveAddress, getMetadataAddress }
export const PUMPFUN_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf")
export const PUMPFUN_FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM")
export const PUMPFUN_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1")
export const METAPLEX_TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
export const PUMPFUN_MINT_AUTHORITY = new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM")

// pumpswap AMM constants
export const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")
export const PUMPSWAP_FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ")
// pump.fun buy now also uses fee program
export const PUMPFUN_FEE_PROGRAM_ID = PUMPSWAP_FEE_PROGRAM_ID
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112")

// fee constants (as of Dec 2025)
export const PUMPFUN_BUY_FEE_BPS = 100  // 1% buy fee
export const PUMPFUN_SELL_FEE_BPS = 100 // 1% sell fee
export const PUMPSWAP_TRADE_FEE_BPS = 25 // 0.25% (0.20% LP + 0.05% protocol)
export const CREATOR_REVENUE_SHARE_BPS = 5 // 0.05% creator revenue share (May 2025)

// graduation threshold - APPROXIMATE, varies with SOL price
// sources report different values: $30K-$35K (Bitquery), $69K (pumpfunguide)
// ⚠️ IMPORTANT: always use bondingCurve.complete flag for actual graduation check!
// this constant is for UI estimation only
export const GRADUATION_MARKET_CAP_USD = 60000 // approximate, use bondingCurve.complete for logic
export const GRADUATION_SOL_THRESHOLD = 85 // ~85 SOL in bonding curve triggers graduation

type GlobalState = {
  initialized: boolean
  authority: PublicKey
  feeRecipient: PublicKey
  initialVirtualTokenReserves: bigint
  initialVirtualSolReserves: bigint
  initialRealTokenReserves: bigint
  tokenTotalSupply: bigint
  feeBasisPoints: bigint
}

let cachedGlobalState: GlobalState | null = null

export async function getPumpfunGlobalState(): Promise<GlobalState | null> {
  if (cachedGlobalState) return cachedGlobalState
  try {
    const accountInfo = await connection.getAccountInfo(PUMPFUN_GLOBAL)
    if (!accountInfo) return null
    const data = accountInfo.data
    let offset = 0
    const initialized = data.readUInt8(offset) === 1
    offset += 1
    offset += 7 // anchor padding
    const authority = new PublicKey(data.slice(offset, offset + 32))
    offset += 32
    const feeRecipient = new PublicKey(data.slice(offset, offset + 32))
    offset += 32
    const initialVirtualTokenReserves = data.readBigUInt64LE(offset)
    offset += 8
    const initialVirtualSolReserves = data.readBigUInt64LE(offset)
    offset += 8
    const initialRealTokenReserves = data.readBigUInt64LE(offset)
    offset += 8
    const tokenTotalSupply = data.readBigUInt64LE(offset)
    offset += 8
    const feeBasisPoints = data.readBigUInt64LE(offset)

    cachedGlobalState = {
      initialized,
      authority,
      feeRecipient,
      initialVirtualTokenReserves,
      initialVirtualSolReserves,
      initialRealTokenReserves,
      tokenTotalSupply,
      feeBasisPoints,
    }
    return cachedGlobalState
  } catch (error) {
    console.error("error reading pumpfun global state:", error)
    return null
  }
}

// instruction discriminators (anchor)
const INIT_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR = Buffer.from([94, 6, 202, 115, 255, 96, 232, 183])

async function getTokenProgramForMint(mint: PublicKey): Promise<{ program: PublicKey; owner: string | null }> {
  let owner: PublicKey | null = null
  try {
    const info = await connection.getAccountInfo(mint)
    if (info?.owner) owner = info.owner
  } catch {
    // ignore lookup errors
  }
  if (owner && owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return { program: TOKEN_2022_PROGRAM_ID, owner: owner.toBase58() }
  }
  if (owner && owner.equals(TOKEN_PROGRAM_ID)) {
    return { program: TOKEN_PROGRAM_ID, owner: owner.toBase58() }
  }
  // default fallback to classic token program
  return { program: TOKEN_PROGRAM_ID, owner: owner ? owner.toBase58() : null }
}

async function getPumpfunAta(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): Promise<PublicKey> {
  return getAssociatedTokenAddress(
    mint,
    owner,
    allowOwnerOffCurve,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  )
}

// seeds must match pump.fun IDL (Dec 2025)
const GLOBAL_VOLUME_SEED = Buffer.from("global_volume_accumulator")
const USER_VOLUME_SEED = Buffer.from("user_volume_accumulator")
const FEE_CONFIG_SEED = Buffer.from("fee_config") // unused for sell (v1)
const FEE_CONFIG_MAINNET = new PublicKey("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt")
const CREATOR_VAULT_SEED = Buffer.from("creator-vault")

function getGlobalVolumeAccumulatorPda(): PublicKey {
  return PublicKey.findProgramAddressSync([GLOBAL_VOLUME_SEED], PUMPFUN_PROGRAM_ID)[0]
}

function getUserVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([USER_VOLUME_SEED, user.toBuffer()], PUMPFUN_PROGRAM_ID)[0]
}

export function createInitUserVolumeAccumulatorInstruction(payer: PublicKey, user: PublicKey): TransactionInstruction {
  const userVolumeAccumulator = getUserVolumeAccumulatorPda(user)
  const data = Buffer.alloc(8)
  INIT_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR.copy(data, 0)

  // account metas per IDL: payer, user, user_volume_accumulator, system_program, event_authority, program
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: user, isSigner: false, isWritable: false },
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
  ]

  return new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys,
    data,
  })
}

export interface CreateTokenMetadata {
  name: string
  symbol: string
  description: string
  file: File | Blob
  twitter?: string
  telegram?: string
  website?: string
}

export interface TokenCreationResult {
  success: boolean
  mintAddress?: string
  signature?: string
  error?: string
}

const BONDING_CURVE_TTL_MS = 8_000

/**
 * check if pump.fun is available on current network
 */
export function isPumpFunAvailable(): boolean {
  return SOLANA_NETWORK === "mainnet-beta"
}

/**
 * Convert a user-friendly "priority fee in SOL (total per tx)" into microLamports-per-CU
 * expected by ComputeBudgetProgram.setComputeUnitPrice.
 *
 * Note: microLamports are per compute unit. If you multiply SOL by a constant here,
 * you will massively overpay and can easily hit InsufficientFundsForFee.
 */
function toMicroLamports(priorityFeeSol: number, computeUnits: number): number {
  if (!Number.isFinite(priorityFeeSol) || priorityFeeSol <= 0) return 0
  if (!Number.isFinite(computeUnits) || computeUnits <= 0) return 0
  const totalLamports = priorityFeeSol * Number(LAMPORTS_PER_SOL)
  // microLamports per CU = (total lamports / CU) * 1e6
  const microLamports = Math.floor((totalLamports * 1_000_000) / computeUnits)
  return Math.max(0, microLamports)
}

function addPriorityFee(
  transaction: Transaction,
  microLamports: number,
  computeUnits: number
): void {
  if (microLamports <= 0) return
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports,
    })
  )
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnits,
    })
  )
}

/**
 * get bonding curve associated token account (ATA)
 * compat helper for bundler-engine
 */
export function getAssociatedBondingCurveAddress(
  mint: PublicKey,
  bondingCurve?: PublicKey
): PublicKey {
  const curve = bondingCurve ?? getBondingCurveAddress(mint)
  return PublicKey.findProgramAddressSync(
    [
      curve.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0]
}

/**
 * get mint authority PDA
 */
export function getMintAuthorityAddress(): PublicKey {
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-authority")],
    PUMPFUN_PROGRAM_ID
  )
  return mintAuthority
}

/**
 * upload metadata to pump.fun IPFS
 */
export async function uploadMetadataToPumpFun(
  metadata: CreateTokenMetadata
): Promise<{ metadataUri: string }> {
  const formData = new FormData()
  formData.append("file", metadata.file)
  formData.append("name", metadata.name)
  formData.append("symbol", metadata.symbol)
  formData.append("description", metadata.description)
  
  if (metadata.twitter) formData.append("twitter", metadata.twitter)
  if (metadata.telegram) formData.append("telegram", metadata.telegram)
  if (metadata.website) formData.append("website", metadata.website)

  const response = await fetchWithRetry("https://pump.fun/api/ipfs", {
    method: "POST",
    body: formData,
    retries: 2,
    backoffMs: 400,
  })

  if (!response.ok) {
    throw new Error(`failed to upload metadata: ${response.statusText}`)
  }

  const data = await response.json()
  return { metadataUri: data.metadataUri }
}

/**
 * compat wrapper for bundler-engine (awaitable)
 */
export async function createCreateTokenInstruction(
  creator: PublicKey,
  mint: PublicKey,
  name: string,
  symbol: string,
  uri: string
): Promise<TransactionInstruction> {
  return createPumpFunCreateInstruction(creator, mint, { name, symbol, imageUrl: uri, description: "" })
}

/**
 * build create token transaction
 */
export async function buildCreateTokenTransaction(
  creator: PublicKey,
  mint: Keypair,
  name: string,
  symbol: string,
  metadataUri: string,
  priorityFee: number = 0.0005
): Promise<Transaction> {
  const transaction = new Transaction()

  // add compute budget for priority
  addPriorityFee(transaction, toMicroLamports(priorityFee, 250_000), 250_000)

  // add create instruction
  const createIx = createPumpFunCreateInstruction(
    creator,
    mint.publicKey,
    { name, symbol, imageUrl: metadataUri, description: "" }
  )
  transaction.add(createIx)

  // set recent blockhash and fee payer
  const { blockhash } = await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.feePayer = creator

  invalidateBondingCurveCache(mint.publicKey)
  return transaction
}

/**
 * build buy transaction
 */
export async function buildBuyTransaction(
  buyer: PublicKey,
  mint: PublicKey,
  solAmount: number,
  minTokensOut: bigint = BigInt(0),
  priorityFee: number = 0.0005
): Promise<Transaction> {
  if (solAmount <= 0 || !Number.isFinite(solAmount)) {
    throw new Error("invalid sol amount")
  }
  const transaction = new Transaction()

  // add compute budget
  addPriorityFee(transaction, toMicroLamports(priorityFee, 150_000), 150_000)
  const safeMinTokensOut = minTokensOut < BigInt(0) ? BigInt(0) : minTokensOut

  // check if user has ATA, if not create it
  const { program: tokenProgram } = await getTokenProgramForMint(mint)
  const associatedUser = await getPumpfunAta(mint, buyer, false, tokenProgram)
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      buyer,
      associatedUser,
      buyer,
      mint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  )

  // ensure volume accumulator accounts exist (required by pump.fun buy)
  const globalVolumeAccumulator = getGlobalVolumeAccumulatorPda()
  const userVolumeAccumulator = getUserVolumeAccumulatorPda(buyer)
  const [gvaInfo, uvaInfo] = await Promise.all([
    connection.getAccountInfo(globalVolumeAccumulator),
    connection.getAccountInfo(userVolumeAccumulator),
  ])
  if (!gvaInfo) {
    throw new Error("pump.fun global_volume_accumulator is missing on-chain (unexpected)")
  }
  if (!uvaInfo) {
    transaction.add(createInitUserVolumeAccumulatorInstruction(buyer, buyer))
  }

  // add buy instruction
  // solAmount -> maxSolCostLamports
  const maxSolCostLamports = BigInt(Math.floor(solAmount * Number(LAMPORTS_PER_SOL)))
  // We need to estimate tokens for the amount
  const bondingCurveData = await getBondingCurveData(mint)
  if (!bondingCurveData) throw new Error("bonding curve not found for amount calc")

  const { tokensOut } = calculateBuyAmount(bondingCurveData, solAmount)
  const tokenAmount = safeMinTokensOut > BigInt(0) ? safeMinTokensOut : tokensOut

  const buyIx = await createBuyInstruction(
    buyer,
    mint,
    tokenAmount,
    maxSolCostLamports
  )
  transaction.add(buyIx)

  const { blockhash } = await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.feePayer = buyer

  invalidateBondingCurveCache(mint)
  return transaction
}

/**
 * build sell transaction
 */
export async function buildSellTransaction(
  seller: PublicKey,
  mint: PublicKey,
  tokenAmount: bigint,
  minSolOut: bigint = BigInt(0),
  priorityFee: number = 0.0005
): Promise<Transaction> {
  const transaction = new Transaction()
  const { program: tokenProgram } = await getTokenProgramForMint(mint)

  // add compute budget
  addPriorityFee(transaction, toMicroLamports(priorityFee, 150_000), 150_000)
  const safeMinSolOut = minSolOut < BigInt(0) ? BigInt(0) : minSolOut
  const bondingCurve = getBondingCurveAddress(mint)
  const associatedBondingCurve = await getPumpfunAta(mint, bondingCurve, true, tokenProgram)
  const associatedUser = await getPumpfunAta(mint, seller, false, tokenProgram)

  // ensure ATAs exist
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      seller,
      associatedBondingCurve,
      bondingCurve,
      mint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  )
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      seller,
      associatedUser,
      seller,
      mint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  )

  // add sell instruction
  const sellIx = await createSellInstruction(seller, mint, tokenAmount, safeMinSolOut)
  transaction.add(sellIx)

  const { blockhash } = await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.feePayer = seller

  invalidateBondingCurveCache(mint)
  return transaction
}

type BondingCurveCacheEntry = {
  data: BondingCurveData
  slot: number
  expires: number
}

const bondingCurveCache = new LRUCache<string, BondingCurveCacheEntry>({
  max: 256,
})

/**
 * get bonding curve data
 */
export interface BondingCurveData {
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
  tokenTotalSupply: bigint
  complete: boolean
  creator: PublicKey
}

export async function getBondingCurveData(mint: PublicKey): Promise<BondingCurveData | null> {
  try {
    const key = mint.toBase58()
    const cached = bondingCurveCache.get(key)
    if (cached && cached.expires > Date.now()) return cached.data

    const bondingCurve = getBondingCurveAddress(mint)
    const conn = await getResilientConnection()
    const accountInfo = await conn.getAccountInfoAndContext(bondingCurve)
    
    if (!accountInfo?.value) {
      console.warn("bonding curve account not found for mint:", mint.toBase58())
      return null
    }

    const data = accountInfo.value.data
    const DISCRIMINATOR_SIZE = 8

    let offset = DISCRIMINATOR_SIZE
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
    const complete = data[offset] === 1
    offset += 1
    const creator = new PublicKey(data.slice(offset, offset + 32))

    const parsed: BondingCurveData = {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      creator,
    }

    bondingCurveCache.set(key, {
      data: parsed,
      slot: accountInfo.context.slot,
      expires: Date.now() + BONDING_CURVE_TTL_MS,
    })
    return parsed
  } catch (error) {
    console.error("error getting bonding curve data:", error)
    return null
  }
}

export function invalidateBondingCurveCache(mint: PublicKey): void {
  bondingCurveCache.delete(mint.toBase58())
}

/**
 * calculate current token price
 */
export function calculateTokenPrice(bondingCurve: BondingCurveData): number {
  const virtualSol = Number(bondingCurve.virtualSolReserves) / Number(LAMPORTS_PER_SOL)
  const virtualTokens = Number(bondingCurve.virtualTokenReserves) / Number(TOKEN_DECIMALS_FACTOR) // 6 decimals
  return virtualSol / virtualTokens
}

/**
 * calculate tokens out for given SOL amount (after 1% fee)
 */
export function calculateBuyAmount(
  bondingCurve: BondingCurveData,
  solAmount: number,
  includeFee: boolean = true
): { tokensOut: bigint; priceImpact: number; feeAmount: number } {
  if (solAmount <= 0 || !Number.isFinite(solAmount)) {
    return { tokensOut: BigInt(0), priceImpact: 0, feeAmount: 0 }
  }
  // pump.fun takes 1% fee on buy
  const feeAmount = includeFee ? solAmount * (PUMPFUN_BUY_FEE_BPS / 10000) : 0
  const solAfterFee = solAmount - feeAmount
  const solInLamports = BigInt(Math.floor(solAfterFee * Number(LAMPORTS_PER_SOL)))
  
  const k = bondingCurve.virtualTokenReserves * bondingCurve.virtualSolReserves
  const newSolReserves = bondingCurve.virtualSolReserves + solInLamports

  // Prevent div by zero
  if (newSolReserves <= 0n) return { tokensOut: 0n, priceImpact: 0, feeAmount: 0 }

  const newTokenReserves = k / newSolReserves
  const tokensOut = bondingCurve.virtualTokenReserves - newTokenReserves

  const oldPrice = Number(bondingCurve.virtualSolReserves) / Number(bondingCurve.virtualTokenReserves)
  const newPrice = Number(newSolReserves) / Number(newTokenReserves)
  const priceImpact = ((newPrice - oldPrice) / oldPrice) * 100

  return { tokensOut, priceImpact, feeAmount }
}

/**
 * calculate SOL out for given token amount (after 1% fee)
 */
export function calculateSellAmount(
  bondingCurve: BondingCurveData,
  tokenAmount: bigint,
  includeFee: boolean = true
): { solOut: bigint; priceImpact: number; feeAmount: bigint } {
  if (tokenAmount <= BigInt(0)) {
    return { solOut: BigInt(0), priceImpact: 0, feeAmount: BigInt(0) }
  }
  const k = bondingCurve.virtualTokenReserves * bondingCurve.virtualSolReserves
  const newTokenReserves = bondingCurve.virtualTokenReserves + tokenAmount

  if (newTokenReserves <= 0n) return { solOut: 0n, priceImpact: 0, feeAmount: 0n }

  const newSolReserves = k / newTokenReserves
  const solOutBeforeFee = bondingCurve.virtualSolReserves - newSolReserves
  
  // pump.fun takes 1% fee on sell
  const feeAmount = includeFee ? solOutBeforeFee * BigInt(PUMPFUN_SELL_FEE_BPS) / BigInt(10000) : BigInt(0)
  const solOut = solOutBeforeFee - feeAmount

  const oldPrice = Number(bondingCurve.virtualSolReserves) / Number(bondingCurve.virtualTokenReserves)
  const newPrice = Number(newSolReserves) / Number(newTokenReserves)
  const priceImpact = ((oldPrice - newPrice) / oldPrice) * 100

  return { solOut, priceImpact, feeAmount }
}

/**
 * calculate bonding curve progress (0-100%)
 */
export function calculateBondingCurveProgress(bondingCurve: BondingCurveData): number {
  if (bondingCurve.complete) return 100

  const currentSol = Number(bondingCurve.realSolReserves) / Number(LAMPORTS_PER_SOL)
  return Math.min((currentSol / GRADUATION_SOL_THRESHOLD) * 100, 100)
}

// ========================
// PUMPSWAP AMM FUNCTIONS
// ========================

// pumpswap instruction discriminators
const PUMPSWAP_SWAP_DISCRIMINATOR = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200])

/**
 * get pumpswap pool PDA
 */
export function getPumpswapPoolAddress(baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  // sort mints for deterministic pool address
  const [mint0, mint1] = baseMint.toBuffer().compare(quoteMint.toBuffer()) < 0 
    ? [baseMint, quoteMint] 
    : [quoteMint, baseMint]
  
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mint0.toBuffer(), mint1.toBuffer()],
    PUMPSWAP_PROGRAM_ID
  )
  return pool
}

/**
 * get pumpswap pool vault PDAs
 */
export function getPumpswapVaults(pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): {
  baseVault: PublicKey
  quoteVault: PublicKey
} {
  const [baseVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), pool.toBuffer(), baseMint.toBuffer()],
    PUMPSWAP_PROGRAM_ID
  )
  const [quoteVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), pool.toBuffer(), quoteMint.toBuffer()],
    PUMPSWAP_PROGRAM_ID
  )
  return { baseVault, quoteVault }
}

/**
 * pumpswap pool data
 */
export interface PumpswapPoolData {
  tokenReserves: bigint
  solReserves: bigint
  lpSupply: bigint
}

/**
 * get pumpswap pool reserves
 */
export async function getPumpswapPoolData(tokenMint: PublicKey): Promise<PumpswapPoolData | null> {
  try {
    const pool = getPumpswapPoolAddress(tokenMint, WSOL_MINT)
    const { baseVault, quoteVault } = getPumpswapVaults(pool, tokenMint, WSOL_MINT)
    const conn = await getResilientConnection()
    
    // get vault balances
    const [tokenVaultInfo, solVaultInfo] = await Promise.all([
      conn.getTokenAccountBalance(baseVault).catch(() => null),
      conn.getTokenAccountBalance(quoteVault).catch(() => null),
    ])
    
    if (!tokenVaultInfo || !solVaultInfo) return null
    
    return {
      tokenReserves: BigInt(tokenVaultInfo.value.amount),
      solReserves: BigInt(solVaultInfo.value.amount),
      lpSupply: BigInt(0), // would need pool account data for this
    }
  } catch {
    return null
  }
}

/**
 * calculate pumpswap swap output (constant product with 0.25% fee)
 */
export function calculatePumpswapSwapAmount(
  pool: PumpswapPoolData,
  tokenAmount: bigint,
  isSell: boolean = true
): { solOut: bigint; priceImpact: number; feeAmount: bigint } {
  if (isSell) {
    // selling tokens for SOL
    const k = pool.tokenReserves * pool.solReserves
    const newTokenReserves = pool.tokenReserves + tokenAmount
    const newSolReserves = k / newTokenReserves
    const solOutBeforeFee = pool.solReserves - newSolReserves
    
    // 0.25% fee
    const feeAmount = solOutBeforeFee * BigInt(PUMPSWAP_TRADE_FEE_BPS) / BigInt(10000)
    const solOut = solOutBeforeFee - feeAmount
    
    const oldPrice = Number(pool.solReserves) / Number(pool.tokenReserves)
    const newPrice = Number(newSolReserves) / Number(newTokenReserves)
    const priceImpact = ((oldPrice - newPrice) / oldPrice) * 100
    
    return { solOut, priceImpact, feeAmount }
  } else {
    // buying tokens with SOL - not implemented for rugpull
    return { solOut: BigInt(0), priceImpact: 0, feeAmount: BigInt(0) }
  }
}

/**
 * create pumpswap swap instruction (sell token for SOL)
 */
export async function createPumpswapSwapInstruction(
  user: PublicKey,
  tokenMint: PublicKey,
  tokenAmount: bigint,
  minSolOut: bigint = BigInt(0)
): Promise<TransactionInstruction> {
  const pool = getPumpswapPoolAddress(tokenMint, WSOL_MINT)
  const { baseVault, quoteVault } = getPumpswapVaults(pool, tokenMint, WSOL_MINT)
  
  const userTokenAccount = await getAssociatedTokenAddress(tokenMint, user, false)
  const userWsolAccount = await getAssociatedTokenAddress(WSOL_MINT, user, false)

  // instruction data: discriminator + amount_in + min_amount_out
  const data = Buffer.alloc(8 + 8 + 8)
  let offset = 0
  PUMPSWAP_SWAP_DISCRIMINATOR.copy(data, offset)
  offset += 8
  data.writeBigUInt64LE(tokenAmount, offset)
  offset += 8
  data.writeBigUInt64LE(minSolOut, offset)

  const keys = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: tokenMint, isSigner: false, isWritable: false },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userWsolAccount, isSigner: false, isWritable: true },
    { pubkey: baseVault, isSigner: false, isWritable: true },
    { pubkey: quoteVault, isSigner: false, isWritable: true },
    { pubkey: PUMPSWAP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]

  return new TransactionInstruction({
    programId: PUMPSWAP_PROGRAM_ID,
    keys,
    data,
  })
}

/**
 * build pumpswap swap transaction (for migrated tokens)
 */
export async function buildPumpswapSwapTransaction(
  user: PublicKey,
  tokenMint: PublicKey,
  tokenAmount: bigint,
  minSolOut: bigint = BigInt(0),
  priorityFee: number = 0.001
): Promise<Transaction> {
  const transaction = new Transaction()

  // priority fee
  addPriorityFee(transaction, toMicroLamports(priorityFee, 200_000), 200_000)
  const safeMinSolOut = minSolOut < BigInt(0) ? BigInt(0) : minSolOut

  // check/create WSOL ATA
  const userWsolAccount = await getAssociatedTokenAddress(WSOL_MINT, user, false)
  const wsolInfo = await connection.getAccountInfo(userWsolAccount)
  if (!wsolInfo) {
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(user, userWsolAccount, user, WSOL_MINT)
    )
  }

  // swap instruction
  const swapIx = await createPumpswapSwapInstruction(user, tokenMint, tokenAmount, safeMinSolOut)
  transaction.add(swapIx)

  const { blockhash } = await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.feePayer = user

  invalidateBondingCurveCache(tokenMint)
  return transaction
}

// ========================
// RUGPULL FUNCTIONS
// ========================

export interface RugpullResult {
  canRugpull: boolean
  isMigrated: boolean
  tokenBalance: bigint
  estimatedSol: bigint
  priceImpact: number
  method: "bonding_curve" | "pumpswap" | "none"
}

/**
 * check rugpull possibility and estimate returns
 */
export async function checkRugpullStatus(
  userWallet: PublicKey,
  mintAddress: PublicKey
): Promise<RugpullResult> {
  // get user token balance
  const userAta = await getPumpfunAta(mintAddress, userWallet, false)
  let tokenBalance = BigInt(0)
  
  try {
    const ataInfo = await connection.getTokenAccountBalance(userAta)
    tokenBalance = BigInt(ataInfo.value.amount)
  } catch {
    // no token account or zero balance
  }

  if (tokenBalance === BigInt(0)) {
    return {
      canRugpull: false,
      isMigrated: false,
      tokenBalance: BigInt(0),
      estimatedSol: BigInt(0),
      priceImpact: 0,
      method: "none",
    }
  }

  // check bonding curve
  const bondingCurve = await getBondingCurveData(mintAddress)
  
  if (bondingCurve && !bondingCurve.complete) {
    // token still on bonding curve - sell there
    const { solOut, priceImpact } = calculateSellAmount(bondingCurve, tokenBalance)
    return {
      canRugpull: true,
      isMigrated: false,
      tokenBalance,
      estimatedSol: solOut,
      priceImpact,
      method: "bonding_curve",
    }
  }

  // token migrated to pumpswap - get actual pool data
  const poolData = await getPumpswapPoolData(mintAddress)
  
  if (poolData) {
    const { solOut, priceImpact } = calculatePumpswapSwapAmount(poolData, tokenBalance, true)
    return {
      canRugpull: true,
      isMigrated: true,
      tokenBalance,
      estimatedSol: solOut,
      priceImpact,
      method: "pumpswap",
    }
  }

  // fallback if pool data unavailable
  return {
    canRugpull: true,
    isMigrated: true,
    tokenBalance,
    estimatedSol: BigInt(0),
    priceImpact: 100,
    method: "pumpswap",
  }
}

/**
 * calculate sequential bundler rugpull profit with price impact
 * simulates selling from all wallets one by one, updating reserves after each sale
 */
export async function calculateBundlerRugpullProfit(
  mintAddress: PublicKey,
  walletTokenAmounts: { walletAddress: string; tokenAmount: bigint }[]
): Promise<{
  totalEstimatedSol: bigint
  totalPriceImpact: number
  perWalletEstimates: { walletAddress: string; estimatedSol: bigint; priceImpact: number }[]
}> {
  const bondingCurve = await getBondingCurveData(mintAddress)

  if (!bondingCurve) {
    throw new Error("token not found on pump.fun")
  }

  // filter out zero amounts and sort by amount (largest first for better price)
  const validAmounts = walletTokenAmounts
    .filter(w => w.tokenAmount > BigInt(0))
    .sort((a, b) => Number(b.tokenAmount - a.tokenAmount))

  if (validAmounts.length === 0) {
    return {
      totalEstimatedSol: BigInt(0),
      totalPriceImpact: 0,
      perWalletEstimates: []
    }
  }

  // check if migrated to pumpswap
  const poolData = await getPumpswapPoolData(mintAddress)

  if (poolData) {
    // migrated to pumpswap - use constant product formula
    return calculateBundlerPumpswapProfit(poolData, validAmounts)
  } else {
    // still on bonding curve
    return calculateBundlerBondingCurveProfit(bondingCurve, validAmounts)
  }
}

/**
 * sequential profit calculation for bonding curve (pump.fun)
 */
function calculateBundlerBondingCurveProfit(
  initialBondingCurve: BondingCurveData,
  walletAmounts: { walletAddress: string; tokenAmount: bigint }[]
): {
  totalEstimatedSol: bigint
  totalPriceImpact: number
  perWalletEstimates: { walletAddress: string; estimatedSol: bigint; priceImpact: number }[]
} {
  let currentReserves = { ...initialBondingCurve }
  let totalEstimatedSol = BigInt(0)
  let totalPriceImpact = 0
  const perWalletEstimates: { walletAddress: string; estimatedSol: bigint; priceImpact: number }[] = []

  // constant product K
  const k = currentReserves.virtualTokenReserves * currentReserves.virtualSolReserves

  for (const wallet of walletAmounts) {
    if (wallet.tokenAmount <= BigInt(0)) continue

    // calculate sale with current reserves
    const { solOut, priceImpact } = calculateSellAmount(currentReserves, wallet.tokenAmount, true)

    // update reserves for next wallet
    currentReserves.virtualTokenReserves += wallet.tokenAmount
    currentReserves.virtualSolReserves -= solOut

    // accumulate totals
    totalEstimatedSol += solOut
    totalPriceImpact += priceImpact

    perWalletEstimates.push({
      walletAddress: wallet.walletAddress,
      estimatedSol: solOut,
      priceImpact
    })
  }

  return {
    totalEstimatedSol,
    totalPriceImpact: totalPriceImpact / walletAmounts.length, // average impact
    perWalletEstimates
  }
}

/**
 * sequential profit calculation for pumpswap (raydium)
 */
function calculateBundlerPumpswapProfit(
  initialPool: PumpswapPoolData,
  walletAmounts: { walletAddress: string; tokenAmount: bigint }[]
): {
  totalEstimatedSol: bigint
  totalPriceImpact: number
  perWalletEstimates: { walletAddress: string; estimatedSol: bigint; priceImpact: number }[]
} {
  let currentPool = { ...initialPool }
  let totalEstimatedSol = BigInt(0)
  let totalPriceImpact = 0
  const perWalletEstimates: { walletAddress: string; estimatedSol: bigint; priceImpact: number }[] = []

  // constant product K
  const k = currentPool.tokenReserves * currentPool.solReserves

  for (const wallet of walletAmounts) {
    if (wallet.tokenAmount <= BigInt(0)) continue

    // calculate swap with current pool state
    const newTokenReserves = currentPool.tokenReserves + wallet.tokenAmount
    const newSolReserves = k / newTokenReserves
    const solOutBeforeFee = currentPool.solReserves - newSolReserves

    // apply 0.25% fee for pumpswap
    const feeAmount = solOutBeforeFee * BigInt(PUMPSWAP_TRADE_FEE_BPS) / BigInt(10000)
    const solOut = solOutBeforeFee - feeAmount

    // calculate price impact
    const oldPrice = Number(currentPool.solReserves) / Number(currentPool.tokenReserves)
    const newPrice = Number(newSolReserves) / Number(newTokenReserves)
    const priceImpact = ((oldPrice - newPrice) / oldPrice) * 100

    // update pool for next wallet
    currentPool.tokenReserves = newTokenReserves
    currentPool.solReserves = newSolReserves

    // accumulate totals
    totalEstimatedSol += solOut
    totalPriceImpact += priceImpact

    perWalletEstimates.push({
      walletAddress: wallet.walletAddress,
      estimatedSol: solOut,
      priceImpact
    })
  }

  return {
    totalEstimatedSol,
    totalPriceImpact: totalPriceImpact / walletAmounts.length, // average impact
    perWalletEstimates
  }
}

/**
 * build rugpull transaction - sells ALL tokens
 * on bonding curve: uses pump.fun sell
 * on pumpswap: uses pumpswap swap
 */
export async function buildRugpullTransaction(
  user: PublicKey,
  mintAddress: PublicKey,
  slippage: number = 20, // high slippage for rugpull
  route: "auto" | "bonding_curve" | "pumpswap" = "auto",
  payoutAddress?: PublicKey
): Promise<{ transaction: Transaction; method: string; tokenAmount: bigint; estimatedSol: bigint }> {
  // get user token balance
  const userAta = await getPumpfunAta(mintAddress, user, false)
  let tokenBalance = BigInt(0)
  try {
    const ataInfo = await connection.getTokenAccountBalance(userAta)
    tokenBalance = BigInt(ataInfo.value.amount)
  } catch {
    // no ata or zero balance -> treat as no tokens
    tokenBalance = BigInt(0)
  }

  if (tokenBalance === BigInt(0)) {
    throw new Error("no tokens to sell")
  }

  // delegate to sell plan helper
  const { buildSellPlan } = await import("./sell-plan")
  const plan = await buildSellPlan(
    user,
    mintAddress,
    tokenBalance,
    slippage,
    0.001,
    route,
    payoutAddress
  )

  return {
    transaction: plan.transaction,
    method: plan.method,
    tokenAmount: tokenBalance,
    estimatedSol: plan.estimatedSol,
  }
}

/**
 * get user token balance
 */
export async function getUserTokenBalance(
  user: PublicKey,
  mint: PublicKey
): Promise<{ balance: bigint; uiBalance: number }> {
  try {
    const ata = await getPumpfunAta(mint, user, false)
    const info = await connection.getTokenAccountBalance(ata)
    return {
      balance: BigInt(info.value.amount),
      uiBalance: info.value.uiAmount || 0,
    }
  } catch {
    return { balance: BigInt(0), uiBalance: 0 }
  }
}

export interface PumpFunTransaction {
  signature: string
  type: "buy" | "sell" | "create"
  user: string
  tokenAmount: number
  solAmount: number
  timestamp: number
  price: number
  marketCap: number
}

// Helper to get SOL price (placeholder)
function getSolPriceUsd(): number {
    return 140; // Default or fetched value
}

/**
 * get all pump.fun transactions for a token (not just our wallets)
 * includes all buys, sells, and creates for the bonding curve
 */
export async function getAllPumpFunTransactions(
  mint: PublicKey,
  limit: number = 100
): Promise<PumpFunTransaction[]> {
  try {
    const bondingCurve = getBondingCurveAddress(mint)

    // get recent signatures for bonding curve
    const signatures = await connection.getSignaturesForAddress(
      bondingCurve,
      { limit: Math.min(limit * 2, 1000) }, // fetch more to account for non-pump.fun txs
      "confirmed"
    )

    const transactions: PumpFunTransaction[] = []

    // process in batches of 50 to avoid rate limits
    const batchSize = 50
    for (let i = 0; i < signatures.length && transactions.length < limit; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize)
      const txs = await connection.getParsedTransactions(
        batch.map(s => s.signature),
        { maxSupportedTransactionVersion: 0 }
      )

      for (const tx of txs) {
        if (!tx?.meta || transactions.length >= limit) continue

        try {
          // check if this is a pump.fun transaction
          const hasPumpFun = tx.transaction.message.accountKeys.some(
            key => key.pubkey.equals(PUMPFUN_PROGRAM_ID)
          )

          if (!hasPumpFun) continue

          // parse the instruction to determine type
          const instructions = tx.transaction.message.instructions
          let txType: "buy" | "sell" | "create" = "buy"
          let userAddress = ""
          let tokenAmount = 0
          let solAmount = 0

          for (const instruction of instructions) {
            if (instruction.programId.equals(PUMPFUN_PROGRAM_ID)) {
              // Handle parsed vs raw instruction
              const data = "data" in instruction ? Buffer.from(bs58.decode(instruction.data as string)) : Buffer.alloc(0)

              // check discriminator
              if (data.length >= 8) {
                const discriminator = data.subarray(0, 8)

                if (discriminator.equals(BUY_DISCRIMINATOR)) {
                  txType = "buy"
                  // parse token amount (after discriminator)
                  if (data.length >= 16) {
                    tokenAmount = Number(data.readBigUInt64LE(8)) / 1e6 // 6 decimals
                  }
                } else if (discriminator.equals(SELL_DISCRIMINATOR)) {
                  txType = "sell"
                  // parse token amount (after discriminator)
                  if (data.length >= 16) {
                    tokenAmount = Number(data.readBigUInt64LE(8)) / 1e6 // 6 decimals
                  }
                } else if (discriminator.equals(CREATE_DISCRIMINATOR)) {
                  txType = "create"
                }

                // get user from instruction accounts
                // This part is tricky with compiled/parsed transactions if account keys aren't fully resolved in order
                // Simple heuristic: look for signer who is NOT the fee payer if possible, or just the first signer
                // For now, we use a simplified placeholder or would need advanced parsing logic matching the IDL structure against `instruction.accounts` indices.
                // Assuming we can find the signer in the transaction's account keys:

                // (Simplified for restoration - real logic needs full account index mapping)
                userAddress = tx.transaction.message.accountKeys[0].pubkey.toBase58()
              }
            }
          }

          if (!userAddress) continue

          // calculate SOL amount from balance changes
          const preBalances = tx.meta.preBalances
          const postBalances = tx.meta.postBalances
          if (preBalances.length > 0 && postBalances.length > 0) {
            // fee payer is usually 0, bonding curve might be at index X
            // Heuristic: biggest change in lamports that isn't the fee?
            // Or just check the bonding curve account if we knew its index.

            // For now, approximate with total flow
             solAmount = 0 // Needs complex parsing logic to restore fully without breaking, leaving as 0 for safety in this hotfix
          }

          transactions.push({
            signature: tx.transaction.signatures[0],
            type: txType,
            user: userAddress,
            tokenAmount,
            solAmount,
            timestamp: (tx.blockTime || 0) * 1000,
            price: 0, // calculated later if needed
            marketCap: 0,
          })

        } catch (error) {
          // skip problematic transactions
          continue
        }
      }
    }

    // sort by timestamp (newest first)
    return transactions.sort((a, b) => b.timestamp - a.timestamp)
  } catch (error) {
    console.error("error getting pump.fun transactions:", error)
    return []
  }
}
