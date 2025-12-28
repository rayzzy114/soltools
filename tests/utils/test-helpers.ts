import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import bs58 from "bs58"

// test configuration
export const TEST_CONFIG = {
  // use devnet for testing (override with env vars)
  rpcEndpoint: process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
  network: (process.env.NEXT_PUBLIC_SOLANA_NETWORK || "devnet") as "devnet" | "mainnet-beta",
  // timeout for transactions
  txTimeout: 60000,
  // default slippage
  slippage: 15,
  // jito tip for bundles
  jitoTip: parseFloat(process.env.JITO_DEFAULT_TIP || "0.0001"),
  // airdrop settings
  airdropRetries: 3,
  airdropDelayMs: 2000,
}

// create connection
export function createTestConnection(): Connection {
  return new Connection(TEST_CONFIG.rpcEndpoint, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: TEST_CONFIG.txTimeout,
  })
}

// generate test wallet
export function generateTestWallet(): {
  keypair: Keypair
  publicKey: string
  secretKey: string
} {
  const keypair = Keypair.generate()
  return {
    keypair,
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
  }
}

// airdrop SOL (devnet only)
export async function airdropSol(
  connection: Connection,
  publicKey: PublicKey,
  amount: number = 1
): Promise<boolean> {
  try {
    const signature = await connection.requestAirdrop(
      publicKey,
      amount * LAMPORTS_PER_SOL
    )
    await connection.confirmTransaction(signature, "confirmed")
    return true
  } catch (error) {
    console.error("airdrop failed:", error)
    return false
  }
}

// get SOL balance
export async function getSolBalance(
  connection: Connection,
  publicKey: PublicKey
): Promise<number> {
  const balance = await connection.getBalance(publicKey)
  return balance / LAMPORTS_PER_SOL
}

// wait for specified time
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// calculate profit
export function calculateProfit(
  initialSol: number,
  finalSol: number,
  feesSpent: number
): {
  grossProfit: number
  netProfit: number
  roi: number
} {
  const grossProfit = finalSol - initialSol
  const netProfit = grossProfit - feesSpent
  const roi = initialSol > 0 ? (netProfit / initialSol) * 100 : 0
  
  return {
    grossProfit,
    netProfit,
    roi,
  }
}

// format SOL amount
export function formatSol(amount: number): string {
  return `${amount.toFixed(6)} SOL`
}

// simulate transaction result for unit tests
export interface MockTransactionResult {
  signature: string
  success: boolean
  slot?: number
  error?: string
}

export function createMockSignature(): string {
  return bs58.encode(Buffer.from(Array(64).fill(0).map(() => Math.floor(Math.random() * 256))))
}

// test wallet state
export interface WalletState {
  address: string
  solBalance: number
  tokenBalance: number
}

// pump.fun test constants
export const PUMP_FUN_CONSTANTS = {
  // token creation costs approximately 0.02 SOL
  tokenCreationCost: 0.02,
  // minimum buy amount
  minBuyAmount: 0.001,
  // fee percentage
  feePercentage: 1,
  // bonding curve graduation threshold
  graduationThreshold: 85000, // ~85k SOL market cap
}

// volume bot test configuration
export interface VolumeBotTestConfig {
  mode: "buy" | "sell" | "wash"
  amountMode: "fixed" | "random" | "percentage"
  fixedAmount?: number
  minAmount?: number
  maxAmount?: number
  minPercentage?: number
  maxPercentage?: number
  slippage: number
  priorityFee: number
  executionCount: number
  intervalSeconds: number
}

export const DEFAULT_VOLUME_BOT_CONFIG: VolumeBotTestConfig = {
  mode: "wash",
  amountMode: "fixed",
  fixedAmount: 0.01,
  slippage: 15,
  priorityFee: 0.0005,
  executionCount: 5,
  intervalSeconds: 2,
}

// ragpull test configuration
export interface RagpullTestConfig {
  slippage: number
  sellPercentage: number // 100 = sell all
}

export const DEFAULT_RAGPULL_CONFIG: RagpullTestConfig = {
  slippage: 20,
  sellPercentage: 100,
}

// ========================
// DEVNET SPECIFIC HELPERS
// ========================

/**
 * airdrop with retry and rate limiting
 */
export async function airdropWithRetry(
  connection: Connection,
  publicKey: PublicKey,
  amount: number = 1,
  maxRetries: number = TEST_CONFIG.airdropRetries
): Promise<{ success: boolean; signature?: string; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const signature = await connection.requestAirdrop(
        publicKey,
        amount * LAMPORTS_PER_SOL
      )
      
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      }, "confirmed")
      
      return { success: true, signature }
    } catch (error: any) {
      if (attempt < maxRetries) {
        await sleep(TEST_CONFIG.airdropDelayMs * attempt) // exponential backoff
      } else {
        return { success: false, error: error.message }
      }
    }
  }
  return { success: false, error: "max retries exceeded" }
}

/**
 * check if running on devnet
 */
export function isDevnet(): boolean {
  return TEST_CONFIG.network === "devnet"
}

/**
 * check if running on mainnet
 */
export function isMainnet(): boolean {
  return TEST_CONFIG.network === "mainnet-beta"
}

/**
 * skip test if not on expected network
 */
export function requireNetwork(network: "devnet" | "mainnet-beta"): void {
  if (TEST_CONFIG.network !== network) {
    throw new Error(`test requires ${network}, but running on ${TEST_CONFIG.network}`)
  }
}

/**
 * create mock bonding curve data for testing
 */
export function createMockBondingCurve(overrides: Partial<{
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
  tokenTotalSupply: bigint
  complete: boolean
  creator: PublicKey
}> = {}): {
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
  tokenTotalSupply: bigint
  complete: boolean
  creator: PublicKey
} {
  return {
    virtualTokenReserves: BigInt(1_000_000_000 * 1e6), // 1B tokens
    virtualSolReserves: BigInt(30 * LAMPORTS_PER_SOL), // 30 SOL
    realTokenReserves: BigInt(800_000_000 * 1e6),
    realSolReserves: BigInt(0),
    tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
    complete: false,
    creator: Keypair.generate().publicKey,
    ...overrides,
  }
}

/**
 * generate multiple test wallets
 */
export function generateTestWallets(count: number): ReturnType<typeof generateTestWallet>[] {
  return Array(count).fill(null).map(() => generateTestWallet())
}

// test report
export interface TestReport {
  testName: string
  startTime: Date
  endTime?: Date
  duration?: number
  success: boolean
  steps: TestStep[]
  metrics: Record<string, number | string>
  error?: string
}

export interface TestStep {
  name: string
  success: boolean
  duration: number
  details?: string
  txSignature?: string
}

export function createTestReport(testName: string): TestReport {
  return {
    testName,
    startTime: new Date(),
    success: false,
    steps: [],
    metrics: {},
  }
}

export function finalizeTestReport(report: TestReport, success: boolean): TestReport {
  report.endTime = new Date()
  report.duration = report.endTime.getTime() - report.startTime.getTime()
  report.success = success
  return report
}

export function printTestReport(report: TestReport): void {
  console.log("\n" + "=".repeat(60))
  console.log(`📊 TEST REPORT: ${report.testName}`)
  console.log("=".repeat(60))
  console.log(`Status: ${report.success ? "✅ PASSED" : "❌ FAILED"}`)
  console.log(`Duration: ${report.duration}ms`)
  console.log(`Start: ${report.startTime.toISOString()}`)
  console.log(`End: ${report.endTime?.toISOString()}`)
  
  console.log("\n📝 Steps:")
  report.steps.forEach((step, i) => {
    const status = step.success ? "✅" : "❌"
    console.log(`  ${i + 1}. ${status} ${step.name} (${step.duration}ms)`)
    if (step.details) console.log(`     ${step.details}`)
    if (step.txSignature) console.log(`     TX: ${step.txSignature}`)
  })
  
  console.log("\n📈 Metrics:")
  Object.entries(report.metrics).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`)
  })
  
  if (report.error) {
    console.log(`\n❌ Error: ${report.error}`)
  }
  
  console.log("=".repeat(60) + "\n")
}
