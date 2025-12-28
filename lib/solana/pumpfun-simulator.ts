/**
 * PUMP.FUN SIMULATOR FOR DEVNET
 * 
 * Эмулирует pump.fun на devnet для тестирования без реальных денег.
 * Создает обычные SPL токены и симулирует bonding curve в памяти.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getOrCreateAssociatedTokenAccount,
  createMint,
  mintTo,
  burn,
  getAccount,
  getMint,
} from "@solana/spl-token"
import { connection, SOLANA_NETWORK } from "./config"
import bs58 from "bs58"

// константы симулятора
const SIMULATOR_PROGRAM_ID = new PublicKey("Simu1ator1111111111111111111111111111111111")
const INITIAL_VIRTUAL_SOL_RESERVES = BigInt(1_000_000_000) // 1 SOL
const INITIAL_VIRTUAL_TOKEN_RESERVES = BigInt(1_000_000_000_000) // 1M tokens
const BUY_FEE_BPS = 100 // 1%
const SELL_FEE_BPS = 100 // 1%

// состояние bonding curve в памяти
interface SimulatedBondingCurve {
  mint: PublicKey
  creator: PublicKey
  mintAuthority: Keypair // сохраняем mint authority для минта токенов
  virtualSolReserves: bigint
  virtualTokenReserves: bigint
  realSolReserves: bigint
  realTokenReserves: bigint
  complete: boolean
  createdAt: number
}

// хранилище симулированных токенов
const simulatedTokens = new Map<string, SimulatedBondingCurve>()

/**
 * проверка что симулятор активен (только на devnet)
 */
export function isSimulatorActive(): boolean {
  return SOLANA_NETWORK === "devnet"
}

/**
 * создание симулированного токена на devnet
 */
export async function createSimulatedToken(
  creator: Keypair,
  name: string,
  symbol: string,
  metadataUri: string
): Promise<{ mint: PublicKey; signature: string }> {
  if (!isSimulatorActive()) {
    throw new Error("симулятор работает только на devnet")
  }

  // создаем обычный SPL токен
  const mint = await createMint(
    connection,
    creator,
    creator.publicKey,
    null,
    6 // decimals
  )

  // инициализируем bonding curve в памяти
  const bondingCurve: SimulatedBondingCurve = {
    mint: mint,
    creator: creator.publicKey,
    mintAuthority: creator, // сохраняем creator как mint authority
    virtualSolReserves: INITIAL_VIRTUAL_SOL_RESERVES,
    virtualTokenReserves: INITIAL_VIRTUAL_TOKEN_RESERVES,
    realSolReserves: BigInt(0),
    realTokenReserves: INITIAL_VIRTUAL_TOKEN_RESERVES,
    complete: false,
    createdAt: Date.now(),
  }

  simulatedTokens.set(mint.toBase58(), bondingCurve)

  console.log(`✅ Создан симулированный токен: ${mint.toBase58()}`)
  console.log(`   Virtual SOL: ${bondingCurve.virtualSolReserves}`)
  console.log(`   Virtual Tokens: ${bondingCurve.virtualTokenReserves}`)

  // создаем "сигнатуру" (фейковую)
  const signature = bs58.encode(Buffer.from(`sim-${Date.now()}-${mint.toBase58()}`))

  return { mint, signature }
}

/**
 * получение данных bonding curve (из памяти)
 */
export function getSimulatedBondingCurve(mint: PublicKey): SimulatedBondingCurve | null {
  return simulatedTokens.get(mint.toBase58()) || null
}

/**
 * расчет токенов при покупке (bonding curve формула)
 */
export function calculateSimulatedBuy(
  bondingCurve: SimulatedBondingCurve,
  solAmount: number
): { tokensOut: bigint; priceImpact: number; feeAmount: number } {
  const feeAmount = solAmount * (BUY_FEE_BPS / 10000)
  const solAfterFee = solAmount - feeAmount

  const k = bondingCurve.virtualTokenReserves * bondingCurve.virtualSolReserves
  const solIn = BigInt(Math.floor(solAfterFee * LAMPORTS_PER_SOL))
  const newSolReserves = bondingCurve.virtualSolReserves + solIn
  const newTokenReserves = k / newSolReserves
  const tokensOut = bondingCurve.virtualTokenReserves - newTokenReserves

  const oldPrice = Number(bondingCurve.virtualSolReserves) / Number(bondingCurve.virtualTokenReserves)
  const newPrice = Number(newSolReserves) / Number(newTokenReserves)
  const priceImpact = ((newPrice - oldPrice) / oldPrice) * 100

  return { tokensOut, priceImpact, feeAmount }
}

/**
 * расчет SOL при продаже (bonding curve формула)
 */
export function calculateSimulatedSell(
  bondingCurve: SimulatedBondingCurve,
  tokenAmount: bigint
): { solOut: bigint; priceImpact: number; feeAmount: bigint } {
  const k = bondingCurve.virtualTokenReserves * bondingCurve.virtualSolReserves
  const newTokenReserves = bondingCurve.virtualTokenReserves + tokenAmount
  const newSolReserves = k / newTokenReserves
  const solOutBeforeFee = bondingCurve.virtualSolReserves - newSolReserves

  const feeAmount = solOutBeforeFee * BigInt(SELL_FEE_BPS) / BigInt(10000)
  const solOut = solOutBeforeFee - feeAmount

  const oldPrice = Number(bondingCurve.virtualSolReserves) / Number(bondingCurve.virtualTokenReserves)
  const newPrice = Number(newSolReserves) / Number(newTokenReserves)
  const priceImpact = ((oldPrice - newPrice) / oldPrice) * 100

  return { solOut, priceImpact, feeAmount }
}

/**
 * симуляция покупки токенов
 */
export async function simulateBuy(
  buyer: Keypair,
  mint: PublicKey,
  solAmount: number
): Promise<{ signature: string; tokensOut: bigint; solSpent: bigint; newPrice: number }> {
  if (!isSimulatorActive()) {
    throw new Error("симулятор работает только на devnet")
  }

  const bondingCurve = simulatedTokens.get(mint.toBase58())
  if (!bondingCurve) {
    throw new Error("токен не найден в симуляторе")
  }

  if (bondingCurve.complete) {
    throw new Error("токен уже мигрирован (graduated)")
  }

  // расчет токенов
  const { tokensOut, priceImpact } = calculateSimulatedBuy(bondingCurve, solAmount)

  // обновляем состояние bonding curve
  const solIn = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL))
  const feeAmount = BigInt(Math.floor(solAmount * (BUY_FEE_BPS / 10000) * LAMPORTS_PER_SOL))
  const solAfterFee = solIn - feeAmount

  bondingCurve.virtualSolReserves += solAfterFee
  bondingCurve.virtualTokenReserves -= tokensOut
  bondingCurve.realSolReserves += solAfterFee
  bondingCurve.realTokenReserves -= tokensOut

  // создаем/получаем ATA покупателя (используем getOrCreate для надежности)
  const buyerAtaInfo = await getOrCreateAssociatedTokenAccount(
    connection,
    bondingCurve.mintAuthority, // payer для создания ATA
    mint,
    buyer.publicKey,
    false // allowOwnerOffCurve
  )
  const buyerAta = buyerAtaInfo.address

  // минтуем токены покупателю (используем mint authority!)
  await mintTo(
    connection,
    bondingCurve.mintAuthority, // payer
    mint,
    buyerAta,
    bondingCurve.mintAuthority, // mint authority
    tokensOut
  )

  const newPrice = Number(bondingCurve.virtualSolReserves) / Number(bondingCurve.virtualTokenReserves)

  console.log(`✅ Симуляция покупки:`)
  console.log(`   SOL потрачено: ${solAmount}`)
  console.log(`   Токенов получено: ${tokensOut.toString()}`)
  console.log(`   Новая цена: ${newPrice.toFixed(8)}`)
  console.log(`   Price impact: ${priceImpact.toFixed(2)}%`)

  return {
    signature: bs58.encode(Buffer.from(`sim-buy-${Date.now()}`)),
    tokensOut,
    solSpent: solIn, // возвращаем потраченный SOL
    newPrice,
  }
}

/**
 * симуляция продажи токенов
 */
export async function simulateSell(
  seller: Keypair,
  mint: PublicKey,
  tokenAmount: bigint
): Promise<{ signature: string; solOut: bigint; newPrice: number }> {
  if (!isSimulatorActive()) {
    throw new Error("симулятор работает только на devnet")
  }

  const bondingCurve = simulatedTokens.get(mint.toBase58())
  if (!bondingCurve) {
    throw new Error("токен не найден в симуляторе")
  }

  // проверяем баланс
  const sellerAta = await getAssociatedTokenAddress(mint, seller.publicKey, false)
  const account = await getAccount(connection, sellerAta)
  if (account.amount < tokenAmount) {
    throw new Error("недостаточно токенов для продажи")
  }

  // расчет SOL
  const { solOut, priceImpact } = calculateSimulatedSell(bondingCurve, tokenAmount)

  // обновляем состояние bonding curve
  bondingCurve.virtualTokenReserves += tokenAmount
  bondingCurve.virtualSolReserves -= solOut
  bondingCurve.realTokenReserves += tokenAmount
  bondingCurve.realSolReserves -= solOut

  // сжигаем токены
  await burn(
    connection,
    seller,
    sellerAta,
    mint,
    seller,
    tokenAmount
  )

  // отправляем SOL продавцу (в реальности это делал бы program)
  // здесь просто симулируем - в реальности нужно было бы отправить SOL
  // но для тестирования логики достаточно обновления состояния

  const newPrice = Number(bondingCurve.virtualSolReserves) / Number(bondingCurve.virtualTokenReserves)

  console.log(`✅ Симуляция продажи:`)
  console.log(`   Токенов продано: ${tokenAmount.toString()}`)
  console.log(`   SOL получено: ${(Number(solOut) / LAMPORTS_PER_SOL).toFixed(6)}`)
  console.log(`   Новая цена: ${newPrice.toFixed(8)}`)
  console.log(`   Price impact: ${priceImpact.toFixed(2)}%`)

  return {
    signature: bs58.encode(Buffer.from(`sim-sell-${Date.now()}`)),
    solOut,
    newPrice,
  }
}

/**
 * симуляция rugpull (продажа всех токенов)
 */
export async function simulateRugpull(
  seller: Keypair,
  mint: PublicKey
): Promise<{ signature: string; solOut: bigint; tokenAmount: bigint; method: string }> {
  if (!isSimulatorActive()) {
    throw new Error("симулятор работает только на devnet")
  }

  const bondingCurve = simulatedTokens.get(mint.toBase58())
  if (!bondingCurve) {
    throw new Error("токен не найден в симуляторе")
  }

  // получаем баланс токенов
  const sellerAta = await getAssociatedTokenAddress(mint, seller.publicKey, false)
  let tokenBalance: bigint

  try {
    const account = await getAccount(connection, sellerAta)
    tokenBalance = account.amount
  } catch {
    throw new Error("нет токенов для продажи")
  }

  if (tokenBalance === BigInt(0)) {
    throw new Error("баланс токенов равен нулю")
  }

  // продаем все токены
  const result = await simulateSell(seller, mint, tokenBalance)

  console.log(`🔥 RUGPULL ВЫПОЛНЕН:`)
  console.log(`   Продано токенов: ${tokenBalance.toString()}`)
  console.log(`   Получено SOL: ${(Number(result.solOut) / LAMPORTS_PER_SOL).toFixed(6)}`)

  return {
    signature: result.signature,
    solOut: result.solOut,
    tokenAmount: tokenBalance,
    method: "bonding_curve",
  }
}

/**
 * получение баланса токенов пользователя
 */
export async function getSimulatedTokenBalance(
  user: PublicKey,
  mint: PublicKey
): Promise<{ balance: bigint; uiBalance: number }> {
  try {
    const ata = await getAssociatedTokenAddress(mint, user, false)
    const account = await getAccount(connection, ata)
    const mintInfo = await getMint(connection, mint)
    
    return {
      balance: account.amount,
      uiBalance: Number(account.amount) / Math.pow(10, mintInfo.decimals),
    }
  } catch {
    return { balance: BigInt(0), uiBalance: 0 }
  }
}

/**
 * получение статистики токена
 */
export function getSimulatedTokenStats(mint: PublicKey): {
  virtualSolReserves: bigint
  virtualTokenReserves: bigint
  realSolReserves: bigint
  realTokenReserves: bigint
  currentPrice: number
  marketCap: number
  complete: boolean
} | null {
  const bondingCurve = simulatedTokens.get(mint.toBase58())
  if (!bondingCurve) return null

  const currentPrice = Number(bondingCurve.virtualSolReserves) / Number(bondingCurve.virtualTokenReserves)
  const marketCap = Number(bondingCurve.realSolReserves) / LAMPORTS_PER_SOL * currentPrice * Number(bondingCurve.realTokenReserves)

  return {
    virtualSolReserves: bondingCurve.virtualSolReserves,
    virtualTokenReserves: bondingCurve.virtualTokenReserves,
    realSolReserves: bondingCurve.realSolReserves,
    realTokenReserves: bondingCurve.realTokenReserves,
    currentPrice,
    marketCap,
    complete: bondingCurve.complete,
  }
}

/**
 * очистка всех симулированных токенов (для тестов)
 */
export function clearSimulatedTokens(): void {
  simulatedTokens.clear()
  console.log("🧹 Все симулированные токены очищены")
}
