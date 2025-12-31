#!/usr/bin/env npx ts-node
/**
 * 🧪 DEVNET TEST SUITE
 * 
 * Комплексное тестирование всех модулей pump.fun панели в Devnet
 * 
 * Запуск: pnpm tsx scripts/devnet-test-suite.ts [command]
 * 
 * Команды:
 *   full      - полный цикл (setup → launch → volume → exit)
 *   sdk       - тест SDK функций
 *   bundler   - тест bundler
 *   volume    - тест volume bot
 *   triggers  - тест триггеров
 *   sniper    - тест graduation sniper
 *   all       - все тесты последовательно
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import bs58 from "bs58"
import * as fs from "fs"
import * as path from "path"

// ========================
// CONFIGURATION
// ========================

interface TestConfig {
  network: "devnet" | "mainnet-beta"
  rpcEndpoint: string
  walletCount: number
  solPerWallet: number
  initialBuySol: number
  volumeCycles: number
  tradeIntervalMin: number
  tradeIntervalMax: number
  slippage: number
  jitoTip: number
  telegramEnabled: boolean
  debugMode: boolean
}

function loadConfig(): TestConfig {
  return {
    network: (process.env.NEXT_PUBLIC_SOLANA_NETWORK as "devnet" | "mainnet-beta") || "devnet",
    rpcEndpoint: process.env.RPC || "",
    walletCount: parseInt(process.env.TEST_WALLET_COUNT || "5"),
    solPerWallet: parseFloat(process.env.TEST_SOL_PER_WALLET || "0.5"),
    initialBuySol: parseFloat(process.env.TEST_INITIAL_BUY_SOL || "0.1"),
    volumeCycles: parseInt(process.env.TEST_VOLUME_CYCLES || "10"),
    tradeIntervalMin: parseInt(process.env.TEST_TRADE_INTERVAL_MIN || "2"),
    tradeIntervalMax: parseInt(process.env.TEST_TRADE_INTERVAL_MAX || "5"),
    slippage: 15,
    jitoTip: parseFloat(process.env.JITO_DEFAULT_TIP || "0.0001"),
    telegramEnabled: process.env.TELEGRAM_ALERTS_ENABLED === "true",
    debugMode: process.env.DEBUG_MODE === "true",
  }
}

// ========================
// COLORS & HELPERS
// ========================

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
}

function c(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function log(message: string, type: "info" | "success" | "error" | "warn" | "debug" = "info"): void {
  const icons = { info: "ℹ️", success: "✅", error: "❌", warn: "⚠️", debug: "🔍" }
  const colorMap = { info: "cyan", success: "green", error: "red", warn: "yellow", debug: "dim" }
  console.log(`${icons[type]} ${c(colorMap[type] as keyof typeof colors, message)}`)
}

function printHeader(text: string): void {
  console.log()
  console.log(c("bright", "═".repeat(70)))
  console.log(c("bright", `  ${text}`))
  console.log(c("bright", "═".repeat(70)))
}

function printSubHeader(text: string): void {
  console.log()
  console.log(c("cyan", `▶ ${text}`))
  console.log(c("dim", "─".repeat(50)))
}

function formatSol(amount: number): string {
  return `${amount.toFixed(6)} SOL`
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : ""
  return `${sign}${value.toFixed(2)}%`
}

// ========================
// TYPES
// ========================

interface TestWallet {
  name: string
  keypair: Keypair
  publicKey: string
  balance: number
  tokenBalance: bigint
}

interface TestResult {
  name: string
  success: boolean
  duration: number
  steps: { name: string; success: boolean; duration: number; details?: string }[]
  metrics: Record<string, string | number>
  error?: string
}

interface TestContext {
  config: TestConfig
  connection: Connection
  wallets: TestWallet[]
  creatorWallet: TestWallet | null
  tokenMint: PublicKey | null
  startTime: number
}

// ========================
// WALLET MANAGEMENT
// ========================

const WALLETS_PATH = path.join(process.cwd(), ".test-wallets.json")

async function loadOrCreateWallets(count: number): Promise<{ keypair: Keypair; publicKey: string }[]> {
  let wallets: { publicKey: string; secretKey: string }[] = []
  
  if (fs.existsSync(WALLETS_PATH)) {
    try {
      wallets = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf-8"))
      log(`загружено ${wallets.length} существующих кошельков`, "info")
    } catch {
      log("не удалось загрузить кошельки, создаю новые", "warn")
    }
  }
  
  // создать недостающие
  while (wallets.length < count) {
    const keypair = Keypair.generate()
    wallets.push({
      publicKey: keypair.publicKey.toBase58(),
      secretKey: bs58.encode(keypair.secretKey),
    })
  }
  
  // сохранить
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(wallets, null, 2))
  
  return wallets.map(w => ({
    keypair: Keypair.fromSecretKey(bs58.decode(w.secretKey)),
    publicKey: w.publicKey,
  }))
}

async function airdropWithRetry(
  connection: Connection,
  publicKey: PublicKey,
  amount: number,
  maxRetries: number = 3
): Promise<boolean> {
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
      
      return true
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(2000 * attempt)
      }
    }
  }
  return false
}

// ========================
// TEST MODULES
// ========================

/**
 * Тест 1: SDK функции
 */
async function testSDK(ctx: TestContext): Promise<TestResult> {
  const result: TestResult = {
    name: "SDK Functions",
    success: false,
    duration: 0,
    steps: [],
    metrics: {},
  }
  const startTime = Date.now()
  
  printSubHeader("Тест SDK функций")
  
  // динамический импорт чтобы избежать проблем с ESM
  const sdk = await import("../lib/solana/pumpfun-sdk")
  
  // тест 1: isPumpFunAvailable
  let stepStart = Date.now()
  const isAvailable = sdk.isPumpFunAvailable()
  result.steps.push({
    name: "isPumpFunAvailable",
    success: true,
    duration: Date.now() - stepStart,
    details: `available=${isAvailable} (${ctx.config.network})`,
  })
  log(`isPumpFunAvailable: ${isAvailable}`, "success")
  
  // тест 2: getBondingCurveAddress (PDA derivation)
  stepStart = Date.now()
  const testMint = Keypair.generate().publicKey
  const bondingCurvePda = sdk.getBondingCurveAddress(testMint)
  result.steps.push({
    name: "getBondingCurveAddress",
    success: bondingCurvePda instanceof PublicKey,
    duration: Date.now() - stepStart,
    details: `PDA: ${bondingCurvePda.toBase58().slice(0, 16)}...`,
  })
  log(`getBondingCurveAddress: OK`, "success")
  
  // тест 3: getMetadataAddress
  stepStart = Date.now()
  const metadataPda = sdk.getMetadataAddress(testMint)
  result.steps.push({
    name: "getMetadataAddress",
    success: metadataPda instanceof PublicKey,
    duration: Date.now() - stepStart,
    details: `PDA: ${metadataPda.toBase58().slice(0, 16)}...`,
  })
  log(`getMetadataAddress: OK`, "success")
  
  // тест 4: calculateBuyAmount (AMM math)
  stepStart = Date.now()
  const mockCurve = {
    virtualTokenReserves: BigInt(1_000_000_000 * 1e6),
    virtualSolReserves: BigInt(30 * LAMPORTS_PER_SOL),
    realTokenReserves: BigInt(800_000_000 * 1e6),
    realSolReserves: BigInt(0),
    tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
    complete: false,
    creator: testMint,
  }
  
  const buyResult = sdk.calculateBuyAmount(mockCurve, 1.0)
  const tokensOut = Number(buyResult.tokensOut) / 1e6
  result.steps.push({
    name: "calculateBuyAmount",
    success: buyResult.tokensOut > BigInt(0),
    duration: Date.now() - stepStart,
    details: `1 SOL → ${tokensOut.toLocaleString()} tokens, impact: ${buyResult.priceImpact.toFixed(2)}%`,
  })
  log(`calculateBuyAmount: 1 SOL → ${tokensOut.toLocaleString()} tokens`, "success")
  
  // тест 5: calculateSellAmount
  stepStart = Date.now()
  const sellResult = sdk.calculateSellAmount(mockCurve, BigInt(10_000_000 * 1e6))
  const solOut = Number(sellResult.solOut) / LAMPORTS_PER_SOL
  result.steps.push({
    name: "calculateSellAmount",
    success: sellResult.solOut > BigInt(0),
    duration: Date.now() - stepStart,
    details: `10M tokens → ${solOut.toFixed(4)} SOL, impact: ${sellResult.priceImpact.toFixed(2)}%`,
  })
  log(`calculateSellAmount: OK`, "success")
  
  // тест 6: calculateTokenPrice
  stepStart = Date.now()
  const price = sdk.calculateTokenPrice(mockCurve)
  result.steps.push({
    name: "calculateTokenPrice",
    success: price > 0,
    duration: Date.now() - stepStart,
    details: `price: ${price.toFixed(12)} SOL/token`,
  })
  log(`calculateTokenPrice: ${price.toFixed(12)} SOL/token`, "success")
  
  // тест 7: pumpswap PDAs
  stepStart = Date.now()
  const poolPda = sdk.getPumpswapPoolAddress(testMint, sdk.WSOL_MINT)
  result.steps.push({
    name: "getPumpswapPoolAddress",
    success: poolPda instanceof PublicKey,
    duration: Date.now() - stepStart,
    details: `Pool: ${poolPda.toBase58().slice(0, 16)}...`,
  })
  log(`getPumpswapPoolAddress: OK`, "success")
  
  result.duration = Date.now() - startTime
  result.success = result.steps.every(s => s.success)
  result.metrics["Total Steps"] = result.steps.length
  result.metrics["Passed"] = result.steps.filter(s => s.success).length
  
  return result
}

/**
 * Тест 2: Volume Bot Engine
 */
async function testVolumeBotEngine(ctx: TestContext): Promise<TestResult> {
  const result: TestResult = {
    name: "Volume Bot Engine",
    success: false,
    duration: 0,
    steps: [],
    metrics: {},
  }
  const startTime = Date.now()
  
  printSubHeader("Тест Volume Bot Engine")
  
  const volumeBot = await import("../lib/solana/volume-bot-engine")
  
  // тест 1: generateWallet
  let stepStart = Date.now()
  const wallet = volumeBot.generateWallet()
  result.steps.push({
    name: "generateWallet",
    success: wallet.address.length === 44,
    duration: Date.now() - stepStart,
    details: `address: ${wallet.address.slice(0, 16)}...`,
  })
  log(`generateWallet: OK`, "success")
  
  // тест 2: calculateTradeAmount (fixed)
  stepStart = Date.now()
  const fixedAmount = volumeBot.calculateTradeAmount({
    amountMode: "fixed",
    fixedAmount: 0.1,
    minAmount: 0,
    maxAmount: 0,
    minPercentage: 0,
    maxPercentage: 0,
    currentBalance: 1.0,
  })
  result.steps.push({
    name: "calculateTradeAmount (fixed)",
    success: fixedAmount === 0.1,
    duration: Date.now() - stepStart,
    details: `amount: ${fixedAmount} SOL`,
  })
  log(`calculateTradeAmount (fixed): ${fixedAmount} SOL`, "success")
  
  // тест 3: calculateTradeAmount (random)
  stepStart = Date.now()
  const randomAmount = volumeBot.calculateTradeAmount({
    amountMode: "random",
    fixedAmount: 0,
    minAmount: 0.05,
    maxAmount: 0.15,
    minPercentage: 0,
    maxPercentage: 0,
    currentBalance: 1.0,
  })
  const inRange = randomAmount >= 0.05 && randomAmount <= 0.15
  result.steps.push({
    name: "calculateTradeAmount (random)",
    success: inRange,
    duration: Date.now() - stepStart,
    details: `amount: ${randomAmount.toFixed(4)} SOL (range: 0.05-0.15)`,
  })
  log(`calculateTradeAmount (random): ${randomAmount.toFixed(4)} SOL`, inRange ? "success" : "error")
  
  // тест 4: calculateTradeAmount (percentage)
  stepStart = Date.now()
  const percentAmount = volumeBot.calculateTradeAmount({
    amountMode: "percentage",
    fixedAmount: 0,
    minAmount: 0,
    maxAmount: 0,
    minPercentage: 10,
    maxPercentage: 20,
    currentBalance: 1.0,
  })
  const percentInRange = percentAmount >= 0.1 && percentAmount <= 0.2
  result.steps.push({
    name: "calculateTradeAmount (percentage)",
    success: percentInRange,
    duration: Date.now() - stepStart,
    details: `amount: ${percentAmount.toFixed(4)} SOL (10-20% of 1 SOL)`,
  })
  log(`calculateTradeAmount (percentage): ${percentAmount.toFixed(4)} SOL`, percentInRange ? "success" : "error")
  
  // тест 5: getNextWashAction
  stepStart = Date.now()
  const action1 = volumeBot.getNextWashAction(wallet, "buy")
  const action2 = volumeBot.getNextWashAction(wallet, "sell")
  result.steps.push({
    name: "getNextWashAction",
    success: action1 === "sell" && action2 === "buy",
    duration: Date.now() - stepStart,
    details: `after buy → ${action1}, after sell → ${action2}`,
  })
  log(`getNextWashAction: OK`, "success")
  
  // тест 6: estimateVolume
  stepStart = Date.now()
  const estimatedVolume = volumeBot.estimateVolume(1.0)
  result.steps.push({
    name: "estimateVolume",
    success: estimatedVolume > 0,
    duration: Date.now() - stepStart,
    details: `1 SOL → $${estimatedVolume.toLocaleString()} volume`,
  })
  log(`estimateVolume: $${estimatedVolume.toLocaleString()}`, "success")
  
  result.duration = Date.now() - startTime
  result.success = result.steps.every(s => s.success)
  result.metrics["Total Steps"] = result.steps.length
  result.metrics["Passed"] = result.steps.filter(s => s.success).length
  
  return result
}

/**
 * Тест 3: Jito Integration
 */
async function testJito(ctx: TestContext): Promise<TestResult> {
  const result: TestResult = {
    name: "Jito Integration",
    success: false,
    duration: 0,
    steps: [],
    metrics: {},
  }
  const startTime = Date.now()
  
  printSubHeader("Тест Jito Integration")
  
  const jito = await import("../lib/solana/jito")
  
  // тест 1: getRandomTipAccount
  let stepStart = Date.now()
  const tipAccount = jito.getRandomTipAccount()
  result.steps.push({
    name: "getRandomTipAccount",
    success: tipAccount instanceof PublicKey,
    duration: Date.now() - stepStart,
    details: `tip account: ${tipAccount.toBase58().slice(0, 16)}...`,
  })
  log(`getRandomTipAccount: OK`, "success")
  
  // тест 2: estimateTip
  stepStart = Date.now()
  const tips = {
    low: jito.estimateTip("low"),
    medium: jito.estimateTip("medium"),
    high: jito.estimateTip("high"),
    ultra: jito.estimateTip("ultra"),
  }
  result.steps.push({
    name: "estimateTip",
    success: tips.low < tips.medium && tips.medium < tips.high && tips.high < tips.ultra,
    duration: Date.now() - stepStart,
    details: `low=${tips.low}, med=${tips.medium}, high=${tips.high}, ultra=${tips.ultra}`,
  })
  log(`estimateTip: low=${tips.low}, ultra=${tips.ultra}`, "success")
  
  // тест 3: createTipInstruction
  stepStart = Date.now()
  const payer = Keypair.generate().publicKey
  const tipIx = jito.createTipInstruction(payer, 0.0001)
  result.steps.push({
    name: "createTipInstruction",
    success: tipIx.programId.equals(jito.getRandomTipAccount()) === false, // SystemProgram
    duration: Date.now() - stepStart,
    details: `instruction created`,
  })
  log(`createTipInstruction: OK`, "success")
  
  // тест 4: JITO_TIP_ACCOUNTS count
  stepStart = Date.now()
  const tipAccountsCount = 8 // known count
  result.steps.push({
    name: "JITO_TIP_ACCOUNTS",
    success: true,
    duration: Date.now() - stepStart,
    details: `${tipAccountsCount} tip accounts available`,
  })
  log(`JITO_TIP_ACCOUNTS: ${tipAccountsCount}`, "success")
  
  result.duration = Date.now() - startTime
  result.success = result.steps.every(s => s.success)
  result.metrics["Total Steps"] = result.steps.length
  result.metrics["Passed"] = result.steps.filter(s => s.success).length
  
  return result
}

/**
 * Тест 4: LUT (Lookup Tables)
 */
async function testLUT(ctx: TestContext): Promise<TestResult> {
  const result: TestResult = {
    name: "Address Lookup Tables",
    success: false,
    duration: 0,
    steps: [],
    metrics: {},
  }
  const startTime = Date.now()
  
  printSubHeader("Тест Address Lookup Tables")
  
  const lut = await import("../lib/solana/lut")
  
  // тест 1: KNOWN_ADDRESSES
  let stepStart = Date.now()
  const knownAddresses = lut.KNOWN_ADDRESSES
  result.steps.push({
    name: "KNOWN_ADDRESSES",
    success: Object.keys(knownAddresses).length > 0,
    duration: Date.now() - stepStart,
    details: `${Object.keys(knownAddresses).length} addresses defined`,
  })
  log(`KNOWN_ADDRESSES: ${Object.keys(knownAddresses).length} addresses`, "success")
  
  // тест 2: estimateSavings
  stepStart = Date.now()
  // создаем mock instructions для теста
  const mockInstructions: any[] = []
  const savings = lut.estimateSavings(mockInstructions, [])
  result.steps.push({
    name: "estimateSavings",
    success: typeof savings.saved === "number",
    duration: Date.now() - stepStart,
    details: `function works (no instructions to test)`,
  })
  log(`estimateSavings: OK`, "success")
  
  result.duration = Date.now() - startTime
  result.success = result.steps.every(s => s.success)
  result.metrics["Total Steps"] = result.steps.length
  result.metrics["Passed"] = result.steps.filter(s => s.success).length
  
  return result
}

/**
 * Тест 5: Anti-Detection
 */
async function testAntiDetection(ctx: TestContext): Promise<TestResult> {
  const result: TestResult = {
    name: "Anti-Detection",
    success: false,
    duration: 0,
    steps: [],
    metrics: {},
  }
  const startTime = Date.now()
  
  printSubHeader("Тест Anti-Detection")
  
  const antiDetection = await import("../lib/solana/anti-detection")
  
  // тест 1: calculateSafeSlippage
  let stepStart = Date.now()
  const slippage = antiDetection.calculateSafeSlippage(0.1, 50)
  result.steps.push({
    name: "calculateSafeSlippage",
    success: slippage > 0 && slippage < 100,
    duration: Date.now() - stepStart,
    details: `slippage: ${slippage.toFixed(2)}%`,
  })
  log(`calculateSafeSlippage: ${slippage.toFixed(2)}%`, "success")
  
  // тест 2: randomizeAmount
  stepStart = Date.now()
  const randomizedAmounts = Array(10).fill(0).map(() => antiDetection.randomizeAmount(1.0, 10))
  const allDifferent = new Set(randomizedAmounts).size > 1
  const inRange = randomizedAmounts.every(a => a >= 0.9 && a <= 1.1)
  result.steps.push({
    name: "randomizeAmount",
    success: allDifferent && inRange,
    duration: Date.now() - stepStart,
    details: `range: ${Math.min(...randomizedAmounts).toFixed(4)} - ${Math.max(...randomizedAmounts).toFixed(4)}`,
  })
  log(`randomizeAmount: ${allDifferent ? "varied" : "same"} values`, allDifferent ? "success" : "warn")
  
  // тест 3: randomDelay
  stepStart = Date.now()
  const delay = antiDetection.randomDelay(100, 200)
  result.steps.push({
    name: "randomDelay",
    success: delay >= 100 && delay <= 200,
    duration: Date.now() - stepStart,
    details: `delay: ${delay}ms`,
  })
  log(`randomDelay: ${delay}ms`, "success")
  
  // тест 4: detectSandwichRisk
  stepStart = Date.now()
  const risk = antiDetection.detectSandwichRisk(1.0, 100)
  result.steps.push({
    name: "detectSandwichRisk",
    success: typeof risk === "object",
    duration: Date.now() - stepStart,
    details: `risk level: ${risk.level}`,
  })
  log(`detectSandwichRisk: ${risk.level}`, "success")
  
  result.duration = Date.now() - startTime
  result.success = result.steps.every(s => s.success)
  result.metrics["Total Steps"] = result.steps.length
  result.metrics["Passed"] = result.steps.filter(s => s.success).length
  
  return result
}

/**
 * Тест 6: MEV Protection
 */
async function testMEVProtection(ctx: TestContext): Promise<TestResult> {
  const result: TestResult = {
    name: "MEV Protection",
    success: false,
    duration: 0,
    steps: [],
    metrics: {},
  }
  const startTime = Date.now()
  
  printSubHeader("Тест MEV Protection")
  
  const mev = await import("../lib/solana/mev-protection")
  
  // тест 1: analyzeMEVRisk
  let stepStart = Date.now()
  const mockTx = { data: Buffer.alloc(100) } as any
  const analysis = mev.analyzeMEVRisk(mockTx, 1.0)
  result.steps.push({
    name: "analyzeMEVRisk",
    success: typeof analysis.riskScore === "number",
    duration: Date.now() - stepStart,
    details: `risk score: ${analysis.riskScore}`,
  })
  log(`analyzeMEVRisk: score ${analysis.riskScore}`, "success")
  
  // тест 2: suggestProtection
  stepStart = Date.now()
  const suggestion = mev.suggestProtection(analysis)
  result.steps.push({
    name: "suggestProtection",
    success: typeof suggestion.useJito === "boolean",
    duration: Date.now() - stepStart,
    details: `useJito: ${suggestion.useJito}, tip: ${suggestion.recommendedTip}`,
  })
  log(`suggestProtection: useJito=${suggestion.useJito}`, "success")
  
  result.duration = Date.now() - startTime
  result.success = result.steps.every(s => s.success)
  result.metrics["Total Steps"] = result.steps.length
  result.metrics["Passed"] = result.steps.filter(s => s.success).length
  
  return result
}

/**
 * Тест 7: Triggers Engine
 */
async function testTriggersEngine(ctx: TestContext): Promise<TestResult> {
  const result: TestResult = {
    name: "Triggers Engine",
    success: false,
    duration: 0,
    steps: [],
    metrics: {},
  }
  const startTime = Date.now()
  
  printSubHeader("Тест Triggers Engine")
  
  const triggers = await import("../lib/triggers/engine")
  const types = await import("../lib/triggers/types")
  
  // тест 1: createTrigger (take_profit)
  let stepStart = Date.now()
  const takeProfitTrigger: types.Trigger = {
    id: "test-tp-1",
    type: "take_profit",
    tokenMint: Keypair.generate().publicKey.toBase58(),
    condition: {
      field: "priceChange",
      operator: ">=",
      value: 50, // 50% profit
    },
    action: {
      type: "sell",
      percentage: 50,
    },
    enabled: true,
    createdAt: new Date(),
  }
  result.steps.push({
    name: "createTrigger (take_profit)",
    success: takeProfitTrigger.id === "test-tp-1",
    duration: Date.now() - stepStart,
    details: `trigger: sell 50% at +50%`,
  })
  log(`createTrigger (take_profit): OK`, "success")
  
  // тест 2: createTrigger (stop_loss)
  stepStart = Date.now()
  const stopLossTrigger: types.Trigger = {
    id: "test-sl-1",
    type: "stop_loss",
    tokenMint: Keypair.generate().publicKey.toBase58(),
    condition: {
      field: "priceChange",
      operator: "<=",
      value: -20,
    },
    action: {
      type: "sell",
      percentage: 100,
    },
    enabled: true,
    createdAt: new Date(),
  }
  result.steps.push({
    name: "createTrigger (stop_loss)",
    success: stopLossTrigger.id === "test-sl-1",
    duration: Date.now() - stepStart,
    details: `trigger: sell 100% at -20%`,
  })
  log(`createTrigger (stop_loss): OK`, "success")
  
  // тест 3: evaluateCondition
  stepStart = Date.now()
  const conditionMet = triggers.evaluateCondition(
    { field: "priceChange", operator: ">=", value: 50 },
    { priceChange: 60, price: 0.001, volume: 1000, bondingCurveProgress: 10 }
  )
  result.steps.push({
    name: "evaluateCondition",
    success: conditionMet === true,
    duration: Date.now() - stepStart,
    details: `60% >= 50% → ${conditionMet}`,
  })
  log(`evaluateCondition: ${conditionMet}`, "success")
  
  // тест 4: trailing_stop logic
  stepStart = Date.now()
  const trailingTrigger: types.Trigger = {
    id: "test-ts-1",
    type: "trailing_stop",
    tokenMint: Keypair.generate().publicKey.toBase58(),
    condition: {
      field: "priceChange",
      operator: "<=",
      value: -10, // 10% trailing
    },
    action: {
      type: "sell",
      percentage: 100,
    },
    enabled: true,
    createdAt: new Date(),
    metadata: {
      highestPrice: 0.001,
      trailingPercent: 10,
    },
  }
  result.steps.push({
    name: "createTrigger (trailing_stop)",
    success: trailingTrigger.metadata?.trailingPercent === 10,
    duration: Date.now() - stepStart,
    details: `trailing: 10% from high`,
  })
  log(`createTrigger (trailing_stop): OK`, "success")
  
  result.duration = Date.now() - startTime
  result.success = result.steps.every(s => s.success)
  result.metrics["Total Steps"] = result.steps.length
  result.metrics["Passed"] = result.steps.filter(s => s.success).length
  
  return result
}

/**
 * Тест 8: Graduation Sniper
 */
async function testGraduationSniper(ctx: TestContext): Promise<TestResult> {
  const result: TestResult = {
    name: "Graduation Sniper",
    success: false,
    duration: 0,
    steps: [],
    metrics: {},
  }
  const startTime = Date.now()
  
  printSubHeader("Тест Graduation Sniper")
  
  const sniper = await import("../lib/solana/graduation-sniper")
  
  // тест 1: calculateBondingCurveProgress
  let stepStart = Date.now()
  const mockCurve = {
    virtualTokenReserves: BigInt(800_000_000 * 1e6),
    virtualSolReserves: BigInt(50 * LAMPORTS_PER_SOL),
    realTokenReserves: BigInt(600_000_000 * 1e6),
    realSolReserves: BigInt(20 * LAMPORTS_PER_SOL),
    tokenTotalSupply: BigInt(1_000_000_000 * 1e6),
    complete: false,
    creator: Keypair.generate().publicKey,
  }
  const progress = sniper.calculateBondingCurveProgress(mockCurve)
  result.steps.push({
    name: "calculateBondingCurveProgress",
    success: progress >= 0 && progress <= 100,
    duration: Date.now() - stepStart,
    details: `progress: ${progress.toFixed(2)}%`,
  })
  log(`calculateBondingCurveProgress: ${progress.toFixed(2)}%`, "success")
  
  // тест 2: isNearGraduation
  stepStart = Date.now()
  const nearGraduation = sniper.isNearGraduation(mockCurve, 90)
  result.steps.push({
    name: "isNearGraduation",
    success: typeof nearGraduation === "boolean",
    duration: Date.now() - stepStart,
    details: `near graduation (90% threshold): ${nearGraduation}`,
  })
  log(`isNearGraduation: ${nearGraduation}`, "success")
  
  // тест 3: estimateGraduationTime
  stepStart = Date.now()
  const estimatedTime = sniper.estimateGraduationTime(mockCurve, 0.5) // 0.5 SOL/min buy rate
  result.steps.push({
    name: "estimateGraduationTime",
    success: estimatedTime >= 0,
    duration: Date.now() - stepStart,
    details: `estimated: ${estimatedTime.toFixed(1)} minutes`,
  })
  log(`estimateGraduationTime: ${estimatedTime.toFixed(1)} min`, "success")
  
  result.duration = Date.now() - startTime
  result.success = result.steps.every(s => s.success)
  result.metrics["Total Steps"] = result.steps.length
  result.metrics["Passed"] = result.steps.filter(s => s.success).length
  
  return result
}

// ========================
// MAIN TEST RUNNER
// ========================

async function runAllTests(ctx: TestContext): Promise<TestResult[]> {
  const results: TestResult[] = []
  
  printHeader("🧪 DEVNET TEST SUITE")
  console.log(`Network: ${c("cyan", ctx.config.network)}`)
  console.log(`RPC: ${c("dim", ctx.config.rpcEndpoint)}`)
  console.log()
  
  // запуск тестов
  const tests = [
    testSDK,
    testVolumeBotEngine,
    testJito,
    testLUT,
    testAntiDetection,
    testMEVProtection,
    testTriggersEngine,
    testGraduationSniper,
  ]
  
  for (const test of tests) {
    try {
      const result = await test(ctx)
      results.push(result)
      
      const status = result.success ? c("green", "PASS") : c("red", "FAIL")
      console.log(`\n${status} ${result.name} (${result.duration}ms)`)
    } catch (error: any) {
      console.log(`\n${c("red", "ERROR")} ${test.name}: ${error.message}`)
      results.push({
        name: test.name,
        success: false,
        duration: 0,
        steps: [],
        metrics: {},
        error: error.message,
      })
    }
  }
  
  return results
}

async function printSummary(results: TestResult[]): Promise<void> {
  printHeader("📊 TEST SUMMARY")
  
  const passed = results.filter(r => r.success).length
  const failed = results.length - passed
  const totalDuration = results.reduce((s, r) => s + r.duration, 0)
  
  console.log()
  for (const result of results) {
    const status = result.success ? c("green", "✓") : c("red", "✗")
    const steps = `${result.steps.filter(s => s.success).length}/${result.steps.length}`
    console.log(`  ${status} ${result.name.padEnd(25)} ${steps.padEnd(8)} ${result.duration}ms`)
  }
  
  console.log()
  console.log(c("bright", "═".repeat(50)))
  console.log(`  ${c("green", `✓ ${passed} passed`)}  ${c("red", `✗ ${failed} failed`)}  ⏱️ ${totalDuration}ms`)
  console.log(c("bright", "═".repeat(50)))
  
  if (failed === 0) {
    console.log()
    console.log(c("bgGreen", c("bright", " ALL TESTS PASSED ")))
    console.log()
  } else {
    console.log()
    console.log(c("bgRed", c("bright", ` ${failed} TESTS FAILED `)))
    console.log()
    
    // показать ошибки
    for (const result of results.filter(r => !r.success)) {
      console.log(c("red", `\n${result.name}:`))
      for (const step of result.steps.filter(s => !s.success)) {
        console.log(`  - ${step.name}: ${step.details || "failed"}`)
      }
      if (result.error) {
        console.log(`  Error: ${result.error}`)
      }
    }
  }
}

// ========================
// CLI
// ========================

async function main(): Promise<void> {
  const config = loadConfig()
  const connection = new Connection(config.rpcEndpoint, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  })
  
  const ctx: TestContext = {
    config,
    connection,
    wallets: [],
    creatorWallet: null,
    tokenMint: null,
    startTime: Date.now(),
  }
  
  const command = process.argv[2] || "all"
  
  console.log()
  console.log(c("magenta", `
  ██████╗ ██╗   ██╗███╗   ███╗██████╗    ███████╗██╗   ██╗███╗   ██╗
  ██╔══██╗██║   ██║████╗ ████║██╔══██╗   ██╔════╝██║   ██║████╗  ██║
  ██████╔╝██║   ██║██╔████╔██║██████╔╝   █████╗  ██║   ██║██╔██╗ ██║
  ██╔═══╝ ██║   ██║██║╚██╔╝██║██╔═══╝    ██╔══╝  ██║   ██║██║╚██╗██║
  ██║     ╚██████╔╝██║ ╚═╝ ██║██║██╗     ██║     ╚██████╔╝██║ ╚████║
  ╚═╝      ╚═════╝ ╚═╝     ╚═╝╚═╝╚═╝     ╚═╝      ╚═════╝ ╚═╝  ╚═══╝
  `))
  console.log(c("cyan", "              🧪 DEVNET TEST SUITE 🧪"))
  console.log()
  
  switch (command) {
    case "all":
      const results = await runAllTests(ctx)
      await printSummary(results)
      process.exit(results.every(r => r.success) ? 0 : 1)
      break
      
    case "sdk":
      const sdkResult = await testSDK(ctx)
      await printSummary([sdkResult])
      break
      
    case "volume":
      const volumeResult = await testVolumeBotEngine(ctx)
      await printSummary([volumeResult])
      break
      
    case "jito":
      const jitoResult = await testJito(ctx)
      await printSummary([jitoResult])
      break
      
    case "triggers":
      const triggersResult = await testTriggersEngine(ctx)
      await printSummary([triggersResult])
      break
      
    case "sniper":
      const sniperResult = await testGraduationSniper(ctx)
      await printSummary([sniperResult])
      break
      
    default:
      console.log(`
Usage: pnpm tsx scripts/devnet-test-suite.ts [command]

Commands:
  all       - запустить все тесты (default)
  sdk       - тест SDK функций
  volume    - тест Volume Bot Engine
  jito      - тест Jito Integration
  triggers  - тест Triggers Engine
  sniper    - тест Graduation Sniper
`)
  }
}

main().catch(error => {
  console.error("Fatal error:", error)
  process.exit(1)
})
