#!/usr/bin/env npx ts-node
/**
 * Devnet Setup Script
 * 
 * Подготовка тестовой среды в Devnet:
 * 1. Создание кошельков
 * 2. Airdrop SOL
 * 3. Проверка RPC
 * 
 * Запуск: pnpm tsx scripts/devnet-setup.ts
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js"
import bs58 from "bs58"
import * as fs from "fs"
import * as path from "path"

// ========================
// CONFIGURATION
// ========================

const PUBLIC_DEVNET_RPCS = Array.from(
  new Set(
    [
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
      ...(process.env.NEXT_PUBLIC_SOLANA_RPC_URLS?.split(",").map((s) => s.trim()) || []),
      process.env.DEVNET_RPC_URL,
      "https://api.devnet.solana.com",
      "https://rpc.ankr.com/solana_devnet",
    ].filter(Boolean),
  ),
)

const CONFIG = {
  // RPC endpoints (приоритет: env -> приватный -> публичный)
  rpcEndpoints: PUBLIC_DEVNET_RPCS,
  
  // количество тестовых кошельков
  walletCount: 10,
  
  // SOL для каждого кошелька
  solPerWallet: 1,
  
  // путь для сохранения кошельков
  walletsPath: path.join(process.cwd(), ".test-wallets.json"),
  
  // задержка между airdrop запросами (ms)
  airdropDelay: 1500,
  
  // максимум попыток airdrop
  maxAirdropRetries: 3,
}

// ========================
// TYPES
// ========================

interface TestWallet {
  name: string
  publicKey: string
  secretKey: string
  balance: number
}

interface SetupResult {
  success: boolean
  rpcEndpoint: string
  wallets: TestWallet[]
  errors: string[]
}

// ========================
// HELPERS
// ========================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function log(message: string, type: "info" | "success" | "error" | "warn" = "info"): void {
  const icons = { info: "ℹ️", success: "✅", error: "❌", warn: "⚠️" }
  console.log(`${icons[type]} ${message}`)
}

async function testRpcConnection(endpoint: string): Promise<{ ok: boolean; latency: number }> {
  const start = Date.now()
  try {
    const conn = new Connection(endpoint, "confirmed")
    await conn.getSlot()
    return { ok: true, latency: Date.now() - start }
  } catch {
    return { ok: false, latency: -1 }
  }
}

async function findBestRpc(): Promise<string> {
  log("Тестируем RPC endpoints...")
  
  for (const endpoint of CONFIG.rpcEndpoints) {
    const { ok, latency } = await testRpcConnection(endpoint)
    if (ok) {
      log(`${endpoint} - OK (${latency}ms)`, "success")
      return endpoint
    } else {
      log(`${endpoint} - недоступен`, "warn")
    }
  }
  
  throw new Error("Все RPC endpoints недоступны")
}

async function airdropWithRetry(
  connection: Connection,
  publicKey: PublicKey,
  amount: number,
  retries: number = CONFIG.maxAirdropRetries
): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const signature = await connection.requestAirdrop(
        publicKey,
        amount * LAMPORTS_PER_SOL
      )
      
      // ждем подтверждения
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      }, "confirmed")
      
      return true
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      
      if (attempt < retries) {
        log(`Попытка ${attempt}/${retries} не удалась: ${errMsg}. Повтор...`, "warn")
        await sleep(CONFIG.airdropDelay * attempt) // exponential backoff
      } else {
        log(`Airdrop не удался после ${retries} попыток: ${errMsg}`, "error")
        return false
      }
    }
  }
  
  return false
}

// ========================
// MAIN SETUP
// ========================

async function setupDevnet(): Promise<SetupResult> {
  const result: SetupResult = {
    success: false,
    rpcEndpoint: "",
    wallets: [],
    errors: [],
  }
  
  console.log("\n" + "=".repeat(60))
  log("🚀 DEVNET SETUP SCRIPT")
  console.log("=".repeat(60) + "\n")
  
  // 1. найти рабочий RPC
  try {
    result.rpcEndpoint = await findBestRpc()
  } catch (error) {
    result.errors.push("Не удалось подключиться к RPC")
    return result
  }
  
  const connection = new Connection(result.rpcEndpoint, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  })
  
  // 2. проверить существующие кошельки
  let existingWallets: TestWallet[] = []
  if (fs.existsSync(CONFIG.walletsPath)) {
    try {
      existingWallets = JSON.parse(fs.readFileSync(CONFIG.walletsPath, "utf-8"))
      log(`Найдено ${existingWallets.length} существующих кошельков`, "info")
    } catch {
      log("Не удалось прочитать существующие кошельки", "warn")
    }
  }
  
  // 3. создать недостающие кошельки
  const walletsNeeded = CONFIG.walletCount - existingWallets.length
  if (walletsNeeded > 0) {
    log(`Создаем ${walletsNeeded} новых кошельков...`)
    
    for (let i = 0; i < walletsNeeded; i++) {
      const keypair = Keypair.generate()
      const wallet: TestWallet = {
        name: `wallet-${existingWallets.length + i + 1}`,
        publicKey: keypair.publicKey.toBase58(),
        secretKey: bs58.encode(keypair.secretKey),
        balance: 0,
      }
      existingWallets.push(wallet)
    }
    
    log(`Создано ${walletsNeeded} кошельков`, "success")
  }
  
  // 4. airdrop SOL
  log(`\nЗапрашиваем airdrop (${CONFIG.solPerWallet} SOL каждому)...`)
  
  for (let i = 0; i < existingWallets.length; i++) {
    const wallet = existingWallets[i]
    const publicKey = new PublicKey(wallet.publicKey)
    
    // проверить текущий баланс
    const currentBalance = await connection.getBalance(publicKey) / LAMPORTS_PER_SOL
    
    if (currentBalance >= CONFIG.solPerWallet) {
      log(`${wallet.name}: уже имеет ${currentBalance.toFixed(4)} SOL`, "success")
      wallet.balance = currentBalance
      continue
    }
    
    // airdrop
    const needed = CONFIG.solPerWallet - currentBalance
    log(`${wallet.name}: запрос ${needed.toFixed(4)} SOL...`)
    
    const success = await airdropWithRetry(connection, publicKey, Math.min(needed, 2)) // max 2 SOL per airdrop
    
    if (success) {
      wallet.balance = await connection.getBalance(publicKey) / LAMPORTS_PER_SOL
      log(`${wallet.name}: баланс ${wallet.balance.toFixed(4)} SOL`, "success")
    } else {
      result.errors.push(`Airdrop failed for ${wallet.name}`)
    }
    
    // задержка между запросами (rate limit)
    if (i < existingWallets.length - 1) {
      await sleep(CONFIG.airdropDelay)
    }
  }
  
  // 5. сохранить кошельки
  fs.writeFileSync(CONFIG.walletsPath, JSON.stringify(existingWallets, null, 2))
  log(`\nКошельки сохранены в ${CONFIG.walletsPath}`, "success")
  
  // 6. итоги
  result.wallets = existingWallets
  result.success = result.errors.length === 0
  
  console.log("\n" + "=".repeat(60))
  log("📊 ИТОГИ SETUP")
  console.log("=".repeat(60))
  console.log(`RPC: ${result.rpcEndpoint}`)
  console.log(`Кошельков: ${result.wallets.length}`)
  console.log(`Общий баланс: ${result.wallets.reduce((s, w) => s + w.balance, 0).toFixed(4)} SOL`)
  
  if (result.errors.length > 0) {
    console.log(`\nОшибки:`)
    result.errors.forEach(e => console.log(`  - ${e}`))
  }
  
  console.log("=".repeat(60) + "\n")
  
  return result
}

// ========================
// ADDITIONAL COMMANDS
// ========================

async function checkBalances(): Promise<void> {
  log("Проверка балансов...")
  
  if (!fs.existsSync(CONFIG.walletsPath)) {
    log("Кошельки не найдены. Запустите setup сначала.", "error")
    return
  }
  
  const wallets: TestWallet[] = JSON.parse(fs.readFileSync(CONFIG.walletsPath, "utf-8"))
  const rpcEndpoint = await findBestRpc()
  const connection = new Connection(rpcEndpoint, "confirmed")
  
  console.log("\n" + "-".repeat(50))
  console.log("БАЛАНСЫ КОШЕЛЬКОВ")
  console.log("-".repeat(50))
  
  let total = 0
  for (const wallet of wallets) {
    const balance = await connection.getBalance(new PublicKey(wallet.publicKey)) / LAMPORTS_PER_SOL
    total += balance
    console.log(`${wallet.name}: ${balance.toFixed(6)} SOL`)
  }
  
  console.log("-".repeat(50))
  console.log(`ИТОГО: ${total.toFixed(6)} SOL`)
  console.log("-".repeat(50) + "\n")
}

async function exportWallets(): Promise<void> {
  if (!fs.existsSync(CONFIG.walletsPath)) {
    log("Кошельки не найдены.", "error")
    return
  }
  
  const wallets: TestWallet[] = JSON.parse(fs.readFileSync(CONFIG.walletsPath, "utf-8"))
  
  console.log("\n" + "-".repeat(50))
  console.log("EXPORT WALLETS (для импорта в Phantom/Solflare)")
  console.log("-".repeat(50))
  
  wallets.forEach(w => {
    console.log(`\n${w.name}:`)
    console.log(`  Public Key: ${w.publicKey}`)
    console.log(`  Secret Key: ${w.secretKey}`)
  })
  
  console.log("-".repeat(50) + "\n")
}

// ========================
// CLI
// ========================

const command = process.argv[2] || "setup"

switch (command) {
  case "setup":
    setupDevnet()
    break
  case "balance":
  case "balances":
    checkBalances()
    break
  case "export":
    exportWallets()
    break
  default:
    console.log(`
Usage: pnpm tsx scripts/devnet-setup.ts [command]

Commands:
  setup     - создать кошельки и получить SOL (default)
  balances  - проверить балансы
  export    - экспортировать приватные ключи
`)
}








