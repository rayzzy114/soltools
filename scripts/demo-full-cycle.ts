/**
 * 🎬 PUMP.FUN FULL CYCLE DEMO
 * 
 * Визуальная демонстрация полного цикла:
 * 1. Создание токена
 * 2. Launch bundle (initial buys)
 * 3. Volume bot (wash trading)
 * 4. Ragpull (продажа всех токенов)
 * 5. Подсчет прибыли
 * 
 * Run: npx tsx scripts/demo-full-cycle.ts
 */

import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js"
import bs58 from "bs58"

// colors for terminal output
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
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgRed: "\x1b[41m",
  bgMagenta: "\x1b[45m",
}

// helper functions
function c(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function clearLine(): void {
  process.stdout.write("\r\x1b[K")
}

function printLine(char: string = "═", length: number = 70): void {
  console.log(c("dim", char.repeat(length)))
}

function printHeader(text: string): void {
  console.log()
  printLine("═")
  console.log(c("bright", `  ${text}`))
  printLine("═")
}

function printSubHeader(text: string): void {
  console.log()
  console.log(c("cyan", `▶ ${text}`))
  printLine("─", 50)
}

function formatSol(amount: number): string {
  return `${amount.toFixed(6)} SOL`
}

function formatTokens(amount: bigint): string {
  return `${(Number(amount) / 1e6).toLocaleString()} tokens`
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : ""
  return `${sign}${value.toFixed(2)}%`
}

function formatUsd(sol: number, price: number = 150): string {
  return `$${(sol * price).toFixed(2)}`
}

// progress bar
function progressBar(current: number, total: number, width: number = 30): string {
  const percent = current / total
  const filled = Math.round(width * percent)
  const empty = width - filled
  const bar = c("green", "█".repeat(filled)) + c("dim", "░".repeat(empty))
  return `[${bar}] ${(percent * 100).toFixed(0)}%`
}

// spinner
class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  private current = 0
  private interval: NodeJS.Timeout | null = null
  private text = ""

  start(text: string): void {
    this.text = text
    this.interval = setInterval(() => {
      clearLine()
      process.stdout.write(`${c("cyan", this.frames[this.current])} ${this.text}`)
      this.current = (this.current + 1) % this.frames.length
    }, 80)
  }

  stop(success: boolean = true): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    clearLine()
    const icon = success ? c("green", "✓") : c("red", "✗")
    console.log(`${icon} ${this.text}`)
  }

  update(text: string): void {
    this.text = text
  }
}

// table
function printTable(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) => 
    Math.max(h.length, ...rows.map(r => (r[i] || "").length)) + 2
  )
  
  const formatRow = (row: string[]): string => {
    return "│ " + row.map((cell, i) => cell.padEnd(colWidths[i])).join(" │ ") + " │"
  }
  
  const separator = "├" + colWidths.map(w => "─".repeat(w + 2)).join("┼") + "┤"
  const top = "┌" + colWidths.map(w => "─".repeat(w + 2)).join("┬") + "┐"
  const bottom = "└" + colWidths.map(w => "─".repeat(w + 2)).join("┴") + "┘"
  
  console.log(c("dim", top))
  console.log(c("bright", formatRow(headers)))
  console.log(c("dim", separator))
  rows.forEach(row => console.log(formatRow(row)))
  console.log(c("dim", bottom))
}

// bonding curve simulation
interface BondingCurveState {
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
  complete: boolean
}

function createInitialBondingCurve(): BondingCurveState {
  return {
    virtualTokenReserves: BigInt(1_000_000_000 * 1e6), // 1B tokens
    virtualSolReserves: BigInt(30 * LAMPORTS_PER_SOL), // 30 SOL
    realTokenReserves: BigInt(800_000_000 * 1e6),
    realSolReserves: BigInt(0),
    complete: false,
  }
}

function simulateBuy(curve: BondingCurveState, solAmount: number): { tokensOut: bigint; newPrice: number } {
  const solIn = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL))
  const k = curve.virtualTokenReserves * curve.virtualSolReserves
  const newSolReserves = curve.virtualSolReserves + solIn
  const newTokenReserves = k / newSolReserves
  const tokensOut = curve.virtualTokenReserves - newTokenReserves
  
  curve.virtualSolReserves = newSolReserves
  curve.virtualTokenReserves = newTokenReserves
  curve.realSolReserves += solIn
  curve.realTokenReserves -= tokensOut
  
  const newPrice = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves) * 1e6
  
  return { tokensOut, newPrice }
}

function simulateSell(curve: BondingCurveState, tokenAmount: bigint): { solOut: bigint; newPrice: number } {
  const k = curve.virtualTokenReserves * curve.virtualSolReserves
  const newTokenReserves = curve.virtualTokenReserves + tokenAmount
  const newSolReserves = k / newTokenReserves
  const solOut = curve.virtualSolReserves - newSolReserves
  
  curve.virtualTokenReserves = newTokenReserves
  curve.virtualSolReserves = newSolReserves
  curve.realSolReserves -= solOut
  curve.realTokenReserves += tokenAmount
  
  const newPrice = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves) * 1e6
  
  return { solOut, newPrice }
}

function getTokenPrice(curve: BondingCurveState): number {
  return Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves) * 1e6
}

// wallet simulation
interface WalletState {
  address: string
  solBalance: number
  tokenBalance: bigint
  invested: number
}

// main demo
async function runDemo(): Promise<void> {
  console.clear()
  
  // ASCII art title
  console.log(c("magenta", `
  ██████╗ ██╗   ██╗███╗   ███╗██████╗    ███████╗██╗   ██╗███╗   ██╗
  ██╔══██╗██║   ██║████╗ ████║██╔══██╗   ██╔════╝██║   ██║████╗  ██║
  ██████╔╝██║   ██║██╔████╔██║██████╔╝   █████╗  ██║   ██║██╔██╗ ██║
  ██╔═══╝ ██║   ██║██║╚██╔╝██║██╔═══╝    ██╔══╝  ██║   ██║██║╚██╗██║
  ██║     ╚██████╔╝██║ ╚═╝ ██║██║██╗     ██║     ╚██████╔╝██║ ╚████║
  ╚═╝      ╚═════╝ ╚═╝     ╚═╝╚═╝╚═╝     ╚═╝      ╚═════╝ ╚═╝  ╚═══╝
  `))
  
  console.log(c("cyan", "          🚀 FULL CYCLE DEMONSTRATION 🚀"))
  console.log(c("dim", "     Token Creation → Volume Bot → Ragpull → Profit"))
  console.log()
  
  await sleep(1000)
  
  // ═══════════════════════════════════════════════════════════════════
  // PHASE 0: SETUP
  // ═══════════════════════════════════════════════════════════════════
  printHeader("📋 PHASE 0: SETUP & CONFIGURATION")
  
  // generate wallets
  const creatorWallet: WalletState = {
    address: Keypair.generate().publicKey.toBase58(),
    solBalance: 5.0,
    tokenBalance: BigInt(0),
    invested: 0,
  }
  
  const volumeWallets: WalletState[] = Array(3).fill(null).map(() => ({
    address: Keypair.generate().publicKey.toBase58(),
    solBalance: 0.5,
    tokenBalance: BigInt(0),
    invested: 0,
  }))
  
  console.log()
  console.log(c("yellow", "👤 Creator Wallet:"))
  console.log(`   Address: ${c("cyan", creatorWallet.address.slice(0, 8))}...${creatorWallet.address.slice(-8)}`)
  console.log(`   Balance: ${c("green", formatSol(creatorWallet.solBalance))}`)
  
  console.log()
  console.log(c("yellow", "🤖 Volume Bot Wallets:"))
  volumeWallets.forEach((w, i) => {
    console.log(`   Wallet ${i + 1}: ${c("cyan", w.address.slice(0, 8))}...${w.address.slice(-8)} | ${c("green", formatSol(w.solBalance))}`)
  })
  
  // config
  const config = {
    initialBuy: 2.0,
    volumeCycles: 5,
    tradeAmountMin: 0.05,
    tradeAmountMax: 0.15,
    slippage: 15,
    jitoTip: 0.0001,
  }
  
  console.log()
  console.log(c("yellow", "⚙️ Configuration:"))
  printTable(
    ["Parameter", "Value"],
    [
      ["Initial Buy", formatSol(config.initialBuy)],
      ["Volume Cycles", config.volumeCycles.toString()],
      ["Trade Range", `${formatSol(config.tradeAmountMin)} - ${formatSol(config.tradeAmountMax)}`],
      ["Slippage", `${config.slippage}%`],
      ["Jito Tip", formatSol(config.jitoTip)],
    ]
  )
  
  await sleep(2000)
  
  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: TOKEN CREATION
  // ═══════════════════════════════════════════════════════════════════
  printHeader("🪙 PHASE 1: TOKEN CREATION")
  
  const tokenMint = Keypair.generate().publicKey.toBase58()
  const tokenMetadata = {
    name: "Demo Pump Token",
    symbol: "DPUMP",
    description: "Demonstration token for pump.fun cycle",
  }
  
  printSubHeader("Token Metadata")
  console.log(`   Name: ${c("bright", tokenMetadata.name)}`)
  console.log(`   Symbol: ${c("cyan", tokenMetadata.symbol)}`)
  console.log(`   Mint: ${c("yellow", tokenMint.slice(0, 8))}...${tokenMint.slice(-8)}`)
  
  const spinner = new Spinner()
  
  // simulate metadata upload
  spinner.start("Uploading metadata to IPFS...")
  await sleep(1500)
  spinner.stop(true)
  console.log(`   ${c("dim", "URI: ipfs://Qm...")}`)
  
  // simulate token creation
  spinner.start("Creating token on pump.fun...")
  await sleep(2000)
  spinner.stop(true)
  
  // initialize bonding curve
  const bondingCurve = createInitialBondingCurve()
  const creationCost = 0.02
  creatorWallet.solBalance -= creationCost
  creatorWallet.invested += creationCost
  
  printSubHeader("Bonding Curve Initialized")
  const initialPrice = getTokenPrice(bondingCurve)
  console.log(`   Initial Price: ${c("green", `${initialPrice.toFixed(10)} SOL/token`)}`)
  console.log(`   Virtual SOL: ${c("cyan", formatSol(30))}`)
  console.log(`   Virtual Tokens: ${c("cyan", "1,000,000,000")}`)
  console.log(`   Creation Cost: ${c("red", "-" + formatSol(creationCost))}`)
  
  await sleep(1500)
  
  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: LAUNCH BUNDLE
  // ═══════════════════════════════════════════════════════════════════
  printHeader("🚀 PHASE 2: LAUNCH BUNDLE (Initial Buys)")
  
  printSubHeader("Creator Initial Buy")
  
  spinner.start(`Buying tokens for ${formatSol(config.initialBuy)}...`)
  await sleep(1500)
  
  const { tokensOut: creatorTokens, newPrice: priceAfterCreator } = simulateBuy(bondingCurve, config.initialBuy)
  creatorWallet.solBalance -= config.initialBuy
  creatorWallet.tokenBalance = creatorTokens
  creatorWallet.invested += config.initialBuy
  
  spinner.stop(true)
  console.log(`   SOL Spent: ${c("red", "-" + formatSol(config.initialBuy))}`)
  console.log(`   Tokens Received: ${c("green", "+" + formatTokens(creatorTokens))}`)
  console.log(`   New Price: ${c("yellow", `${priceAfterCreator.toFixed(10)} SOL/token`)}`)
  console.log(`   Price Impact: ${c("yellow", formatPercent((priceAfterCreator - initialPrice) / initialPrice * 100))}`)
  
  // bundle buys from volume wallets
  printSubHeader("Volume Wallet Buys (Bundled)")
  
  const bundleTxs: { wallet: string; amount: number; tokens: bigint }[] = []
  
  for (let i = 0; i < volumeWallets.length; i++) {
    const wallet = volumeWallets[i]
    const buyAmount = 0.1
    
    spinner.start(`Wallet ${i + 1}: Buying ${formatSol(buyAmount)}...`)
    await sleep(800)
    
    const { tokensOut, newPrice } = simulateBuy(bondingCurve, buyAmount)
    wallet.solBalance -= buyAmount
    wallet.tokenBalance = tokensOut
    wallet.invested += buyAmount
    
    bundleTxs.push({ wallet: wallet.address, amount: buyAmount, tokens: tokensOut })
    spinner.stop(true)
  }
  
  console.log()
  console.log(c("yellow", "📦 Bundle Summary:"))
  printTable(
    ["Wallet", "SOL Spent", "Tokens", "Price After"],
    bundleTxs.map((tx, i) => [
      `Wallet ${i + 1}`,
      formatSol(tx.amount),
      formatTokens(tx.tokens),
      getTokenPrice(bondingCurve).toFixed(10),
    ])
  )
  
  const priceAfterLaunch = getTokenPrice(bondingCurve)
  console.log()
  console.log(`   ${c("bright", "Launch Complete!")}`)
  console.log(`   Price Change: ${c("green", formatPercent((priceAfterLaunch - initialPrice) / initialPrice * 100))}`)
  
  await sleep(2000)
  
  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: VOLUME BOT
  // ═══════════════════════════════════════════════════════════════════
  printHeader("🔄 PHASE 3: VOLUME BOT (Wash Trading)")
  
  let totalVolume = 0
  let totalFees = 0
  const priceHistory: number[] = [priceAfterLaunch]
  
  for (let cycle = 1; cycle <= config.volumeCycles; cycle++) {
    printSubHeader(`Cycle ${cycle}/${config.volumeCycles}`)
    
    for (let i = 0; i < volumeWallets.length; i++) {
      const wallet = volumeWallets[i]
      
      // alternate buy/sell
      const isBuy = (cycle + i) % 2 === 0
      const amount = config.tradeAmountMin + Math.random() * (config.tradeAmountMax - config.tradeAmountMin)
      
      if (isBuy && wallet.solBalance > amount + 0.01) {
        spinner.start(`Wallet ${i + 1}: BUY ${formatSol(amount)}`)
        await sleep(500)
        
        const { tokensOut, newPrice } = simulateBuy(bondingCurve, amount)
        wallet.solBalance -= amount
        wallet.tokenBalance += tokensOut
        totalVolume += amount
        totalFees += config.jitoTip
        
        priceHistory.push(newPrice)
        spinner.stop(true)
        console.log(`      ${c("green", "+")}${formatTokens(tokensOut)} | Price: ${newPrice.toFixed(10)}`)
        
      } else if (!isBuy && wallet.tokenBalance > BigInt(0)) {
        const sellAmount = wallet.tokenBalance / BigInt(2)
        
        spinner.start(`Wallet ${i + 1}: SELL ${formatTokens(sellAmount)}`)
        await sleep(500)
        
        const { solOut, newPrice } = simulateSell(bondingCurve, sellAmount)
        wallet.tokenBalance -= sellAmount
        wallet.solBalance += Number(solOut) / LAMPORTS_PER_SOL
        totalVolume += Number(solOut) / LAMPORTS_PER_SOL
        totalFees += config.jitoTip
        
        priceHistory.push(newPrice)
        spinner.stop(true)
        console.log(`      ${c("green", "+")}${formatSol(Number(solOut) / LAMPORTS_PER_SOL)} | Price: ${newPrice.toFixed(10)}`)
      }
    }
    
    // show progress
    console.log()
    console.log(`   Progress: ${progressBar(cycle, config.volumeCycles)}`)
    console.log(`   Volume: ${c("cyan", formatSol(totalVolume))} | Fees: ${c("red", formatSol(totalFees))}`)
  }
  
  const priceAfterVolume = getTokenPrice(bondingCurve)
  
  console.log()
  console.log(c("yellow", "📊 Volume Bot Results:"))
  printTable(
    ["Metric", "Value"],
    [
      ["Total Volume", formatSol(totalVolume)],
      ["Total Fees", formatSol(totalFees)],
      ["Price Before", `${priceAfterLaunch.toFixed(10)} SOL`],
      ["Price After", `${priceAfterVolume.toFixed(10)} SOL`],
      ["Price Change", formatPercent((priceAfterVolume - priceAfterLaunch) / priceAfterLaunch * 100)],
    ]
  )
  
  // price chart
  console.log()
  console.log(c("yellow", "📈 Price Chart:"))
  const maxPrice = Math.max(...priceHistory)
  const minPrice = Math.min(...priceHistory)
  const chartHeight = 8
  
  for (let row = chartHeight; row >= 0; row--) {
    const threshold = minPrice + (maxPrice - minPrice) * (row / chartHeight)
    let line = `   ${threshold.toFixed(11)} │`
    
    for (let col = 0; col < priceHistory.length; col++) {
      if (priceHistory[col] >= threshold) {
        line += c("green", "█")
      } else {
        line += " "
      }
    }
    console.log(line)
  }
  console.log(`   ${" ".repeat(14)}└${"─".repeat(priceHistory.length)}`)
  
  await sleep(2000)
  
  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: RAGPULL
  // ═══════════════════════════════════════════════════════════════════
  printHeader("💸 PHASE 4: RAGPULL (Exit Strategy)")
  
  let totalReturns = 0
  const exitResults: { wallet: string; tokens: bigint; sol: number }[] = []
  
  printSubHeader("Selling All Tokens")
  
  // sell from all wallets
  const allWallets = [
    { name: "Creator", wallet: creatorWallet },
    ...volumeWallets.map((w, i) => ({ name: `Volume ${i + 1}`, wallet: w })),
  ]
  
  for (const { name, wallet } of allWallets) {
    if (wallet.tokenBalance > BigInt(0)) {
      spinner.start(`${name}: Selling ${formatTokens(wallet.tokenBalance)}...`)
      await sleep(800)
      
      const { solOut, newPrice } = simulateSell(bondingCurve, wallet.tokenBalance)
      const solValue = Number(solOut) / LAMPORTS_PER_SOL
      
      exitResults.push({
        wallet: name,
        tokens: wallet.tokenBalance,
        sol: solValue,
      })
      
      wallet.solBalance += solValue
      totalReturns += solValue
      wallet.tokenBalance = BigInt(0)
      
      spinner.stop(true)
      console.log(`      ${c("green", "+")}${formatSol(solValue)} | Price Impact: ${formatPercent((newPrice - priceAfterVolume) / priceAfterVolume * 100)}`)
    }
  }
  
  console.log()
  console.log(c("yellow", "📊 Exit Summary:"))
  printTable(
    ["Wallet", "Tokens Sold", "SOL Received"],
    exitResults.map(r => [r.wallet, formatTokens(r.tokens), formatSol(r.sol)])
  )
  
  await sleep(1500)
  
  // ═══════════════════════════════════════════════════════════════════
  // PHASE 5: PROFIT CALCULATION
  // ═══════════════════════════════════════════════════════════════════
  printHeader("📊 PHASE 5: FINAL RESULTS")
  
  // calculate totals
  const totalInvested = creatorWallet.invested + volumeWallets.reduce((s, w) => s + w.invested, 0)
  const totalSolNow = creatorWallet.solBalance + volumeWallets.reduce((s, w) => s + w.solBalance, 0)
  const grossProfit = totalSolNow - (5.0 + 0.5 * 3) // initial balances
  const netProfit = grossProfit - totalFees
  const roi = (netProfit / totalInvested) * 100
  
  console.log()
  console.log(c("bright", "═".repeat(50)))
  console.log(c("bright", "  PUMP & DUMP CYCLE COMPLETE"))
  console.log(c("bright", "═".repeat(50)))
  console.log()
  
  printTable(
    ["Metric", "Value", "USD (@ $150/SOL)"],
    [
      ["Total Invested", formatSol(totalInvested), formatUsd(totalInvested)],
      ["Total Returns", formatSol(totalReturns), formatUsd(totalReturns)],
      ["Fees Spent", formatSol(totalFees), formatUsd(totalFees)],
      ["Volume Generated", formatSol(totalVolume), formatUsd(totalVolume)],
      [c("bright", "Gross Profit"), c(grossProfit >= 0 ? "green" : "red", formatSol(grossProfit)), formatUsd(grossProfit)],
      [c("bright", "Net Profit"), c(netProfit >= 0 ? "green" : "red", formatSol(netProfit)), formatUsd(netProfit)],
      [c("bright", "ROI"), c(roi >= 0 ? "green" : "red", formatPercent(roi)), ""],
    ]
  )
  
  console.log()
  console.log(c("yellow", "📍 Final Wallet States:"))
  printTable(
    ["Wallet", "SOL Balance", "Tokens", "P/L"],
    [
      ["Creator", formatSol(creatorWallet.solBalance), formatTokens(creatorWallet.tokenBalance), formatSol(creatorWallet.solBalance - 5.0)],
      ...volumeWallets.map((w, i) => [
        `Volume ${i + 1}`,
        formatSol(w.solBalance),
        formatTokens(w.tokenBalance),
        formatSol(w.solBalance - 0.5),
      ]),
    ]
  )
  
  // final verdict
  console.log()
  if (netProfit > 0) {
    console.log(c("bgGreen", c("bright", " ✓ PROFITABLE CYCLE ")))
    console.log(c("green", `   Net profit: ${formatSol(netProfit)} (${formatUsd(netProfit)})`))
  } else {
    console.log(c("bgRed", c("bright", " ✗ UNPROFITABLE CYCLE ")))
    console.log(c("red", `   Net loss: ${formatSol(Math.abs(netProfit))} (${formatUsd(Math.abs(netProfit))})`))
  }
  
  console.log()
  printLine("═")
  console.log(c("dim", "  Demo completed. No real transactions were made."))
  console.log(c("dim", "  This is a simulation of the pump.fun cycle."))
  printLine("═")
  console.log()
}

// run
runDemo().catch(console.error)
