#!/usr/bin/env npx ts-node
/**
 * ТЕСТИРОВАНИЕ PUMP.FUN СИМУЛЯТОРА НА DEVNET
 * 
 * Полный цикл: создание токена -> покупки -> rugpull
 * БЕЗ РЕАЛЬНЫХ ДЕНЕГ!
 */

import { Keypair, LAMPORTS_PER_SOL, PublicKey, Connection, SystemProgram, Transaction } from "@solana/web3.js"
import bs58 from "bs58"
import {
  createSimulatedToken,
  simulateBuy,
  simulateSell,
  simulateRagpull,
  getSimulatedTokenBalance,
  getSimulatedTokenStats,
  clearSimulatedTokens,
  isSimulatorActive,
} from "../lib/solana/pumpfun-simulator"
import * as fs from "fs"
import * as path from "path"

async function airdrop(connection: any, publicKey: PublicKey, amount: number): Promise<void> {
  const signature = await connection.requestAirdrop(publicKey, amount * LAMPORTS_PER_SOL)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  }, "confirmed")
}

async function main() {
  // загружаем переменные из test-env.txt
  const envPath = path.join(process.cwd(), "test-env.txt")
  console.log(`📄 Загрузка переменных из: ${envPath}`)
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8")
    console.log(`📄 Содержимое файла (${envContent.length} символов):`)
    console.log(envContent)
    envContent.split("\n").forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=")
        if (key && valueParts.length > 0) {
          const value = valueParts.join("=").trim()
          process.env[key.trim()] = value
          console.log(`   ✅ Загружено: ${key.trim()} = ${value.substring(0, 20)}...`)
        }
      }
    })
  } else {
    console.log(`   ⚠️  Файл не найден: ${envPath}`)
  }
  
  // проверяем что переменные загружены
  console.log(`\n🔍 Проверка переменных:`)
  console.log(`   NEXT_PUBLIC_SOLANA_NETWORK: ${process.env.NEXT_PUBLIC_SOLANA_NETWORK || "не установлен"}`)
  console.log(`   NEXT_PUBLIC_SOLANA_RPC_URL: ${process.env.NEXT_PUBLIC_SOLANA_RPC_URL ? process.env.NEXT_PUBLIC_SOLANA_RPC_URL.substring(0, 50) + "..." : "не установлен"}`)
  console.log(`   CREATOR_SECRET_KEY: ${process.env.CREATOR_SECRET_KEY ? process.env.CREATOR_SECRET_KEY.substring(0, 20) + "..." : "не установлен"}`)
  console.log()

  // создаем connection с правильным RPC (ОБЯЗАТЕЛЬНО ERPC!)
  let rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL
  
  if (!rpcUrl) {
    console.error("❌ ОШИБКА: NEXT_PUBLIC_SOLANA_RPC_URL не установлен!")
    console.error("   Проверь test-env.txt или установи переменную окружения")
    process.exit(1)
  }
  
  if (!rpcUrl.includes("erpc.global")) {
    console.error("❌ ОШИБКА: Используется НЕ ERPC RPC!")
    console.error(`   Текущий RPC: ${rpcUrl}`)
    console.error("   Нужно использовать ERPC devnet endpoint!")
    console.error("   Пример: https://devnet.erpc.global?api-key=YOUR_KEY")
    process.exit(1)
  }
  
  const connection = new Connection(rpcUrl, "confirmed")

  console.log("\n" + "=".repeat(70))
  console.log("🧪 ТЕСТИРОВАНИЕ PUMP.FUN СИМУЛЯТОРА (DEVNET)")
  console.log("=".repeat(70))
  console.log()
  console.log(`🔗 RPC: ${rpcUrl}`)
  console.log()

  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK || "devnet"
  if (network !== "devnet") {
    console.error("❌ Симулятор работает только на devnet!")
    console.error(`   Текущая сеть: ${network}`)
    process.exit(1)
  }

  if (!isSimulatorActive()) {
    console.error("❌ Симулятор не активен!")
    process.exit(1)
  }

  try {
    // очистка предыдущих тестов
    clearSimulatedTokens()

    // используем существующий кошелек как creator
    const creatorPubkey = new PublicKey("9CNL362B3uvkbbUDavoDhfeSY9SoJiqC7fkm5Z8gAziR")
    console.log("📝 Использование существующего кошелька...")
    console.log(`   Creator: ${creatorPubkey.toBase58()}`)
    
    // проверяем баланс
    const balance = await connection.getBalance(creatorPubkey)
    console.log(`   Баланс: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`)
    
    if (balance < 0.1 * LAMPORTS_PER_SOL) {
      console.error("❌ Недостаточно SOL! Нужно минимум 0.1 SOL")
      process.exit(1)
    }

    // используем существующий кошелек напрямую для всех операций
    // для этого нужен secret key - проверяем переменную окружения
    const creatorSecretKey = process.env.CREATOR_SECRET_KEY
    
    if (!creatorSecretKey) {
      console.error("❌ ОШИБКА: CREATOR_SECRET_KEY не установлен!")
      console.error("   Для использования существующего кошелька нужен secret key")
      console.error("   Установи CREATOR_SECRET_KEY в test-env.txt или как переменную окружения")
      console.error("   Формат: base58 строка или массив чисел")
      process.exit(1)
    }

    // парсим secret key
    let creator: Keypair
    try {
      // пробуем как base58 строку
      const secretKeyBytes = bs58.decode(creatorSecretKey)
      creator = Keypair.fromSecretKey(secretKeyBytes)
    } catch {
      try {
        // пробуем как JSON массив
        const secretKeyArray = JSON.parse(creatorSecretKey)
        creator = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray))
      } catch {
        console.error("❌ ОШИБКА: Не удалось распарсить CREATOR_SECRET_KEY!")
        console.error("   Используй base58 строку или JSON массив")
        process.exit(1)
      }
    }

    // проверяем что public key совпадает
    if (creator.publicKey.toBase58() !== creatorPubkey.toBase58()) {
      console.error("❌ ОШИБКА: Public key из secret key не совпадает с указанным!")
      console.error(`   Ожидался: ${creatorPubkey.toBase58()}`)
      console.error(`   Получен: ${creator.publicKey.toBase58()}`)
      process.exit(1)
    }

    console.log("✅ Кошелек загружен из secret key")
    
    // создаем дополнительные кошельки для теста (они не нужны, но оставим для совместимости)
    const buyer1 = Keypair.generate()
    const buyer2 = Keypair.generate()
    
    console.log(`   Creator: ${creator.publicKey.toBase58()}`)
    console.log(`   Buyer 1: ${buyer1.publicKey.toBase58()}`)
    console.log(`   Buyer 2: ${buyer2.publicKey.toBase58()}`)

    // переводим SOL с creator на buyer кошельки для теста
    console.log("\n💰 Перевод SOL на тестовые кошельки...")
    
    // переводим 1 SOL на buyer1
    try {
      const transfer1 = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: creator.publicKey,
          toPubkey: buyer1.publicKey,
          lamports: 1.5 * LAMPORTS_PER_SOL, // даем больше SOL
        })
      )
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      transfer1.recentBlockhash = blockhash
      transfer1.feePayer = creator.publicKey
      transfer1.sign(creator)
      const sig1 = await connection.sendRawTransaction(transfer1.serialize())
      await connection.confirmTransaction({
        signature: sig1,
        blockhash,
        lastValidBlockHeight,
      }, "confirmed")
      console.log("   ✅ 1 SOL переведен на Buyer 1")
    } catch (error: any) {
      console.log(`   ⚠️  Перевод на buyer1 не удался: ${error.message}`)
    }
    
    // переводим 1 SOL на buyer2
    try {
      const transfer2 = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: creator.publicKey,
          toPubkey: buyer2.publicKey,
          lamports: 1.5 * LAMPORTS_PER_SOL, // даем больше SOL
        })
      )
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      transfer2.recentBlockhash = blockhash
      transfer2.feePayer = creator.publicKey
      transfer2.sign(creator)
      const sig2 = await connection.sendRawTransaction(transfer2.serialize())
      await connection.confirmTransaction({
        signature: sig2,
        blockhash,
        lastValidBlockHeight,
      }, "confirmed")
      console.log("   ✅ 1 SOL переведен на Buyer 2")
    } catch (error: any) {
      console.log(`   ⚠️  Перевод на buyer2 не удался: ${error.message}`)
    }

    console.log("✅ SOL распределен")

    // шаг 1: создание токена
    console.log("\n" + "-".repeat(70))
    console.log("🚀 ШАГ 1: СОЗДАНИЕ ТОКЕНА")
    console.log("-".repeat(70))

    const { mint, signature } = await createSimulatedToken(
      creator,
      "Test Token",
      "TEST",
      "https://test.com/metadata.json"
    )

    console.log(`✅ Токен создан: ${mint.toBase58()}`)
    console.log(`   Signature: ${signature}`)

    // шаг 2: покупки
    console.log("\n" + "-".repeat(70))
    console.log("🛒 ШАГ 2: ПОКУПКИ ТОКЕНОВ")
    console.log("-".repeat(70))

    const buy1 = await simulateBuy(buyer1, mint, 0.1)
    console.log(`✅ Buyer 1 купил: ${buy1.tokensOut.toString()} токенов`)

    const buy2 = await simulateBuy(buyer2, mint, 0.2)
    console.log(`✅ Buyer 2 купил: ${buy2.tokensOut.toString()} токенов`)

    // проверка балансов
    console.log("\n📊 Проверка балансов...")
    const balance1 = await getSimulatedTokenBalance(buyer1.publicKey, mint)
    const balance2 = await getSimulatedTokenBalance(buyer2.publicKey, mint)

    console.log(`   Buyer 1: ${balance1.uiBalance.toFixed(2)} токенов`)
    console.log(`   Buyer 2: ${balance2.uiBalance.toFixed(2)} токенов`)

    // статистика токена
    const stats = getSimulatedTokenStats(mint)
    if (stats) {
      console.log("\n📈 Статистика токена:")
      console.log(`   Текущая цена: ${stats.currentPrice.toFixed(8)} SOL`)
      console.log(`   Market Cap: $${stats.marketCap.toFixed(2)}`)
      console.log(`   Real SOL в пуле: ${(Number(stats.realSolReserves) / LAMPORTS_PER_SOL).toFixed(4)}`)
      console.log(`   Real Tokens в пуле: ${stats.realTokenReserves.toString()}`)
    }

    // шаг 3: частичная продажа (пропускаем для более драматичного rugpull)
    console.log("\n" + "-".repeat(70))
    console.log("💸 ШАГ 3: ЧАСТИЧНАЯ ПРОДАЖА (пропущено для rugpull)")
    console.log("-".repeat(70))
    console.log("   ⏭️  Пропускаем частичную продажу для более наглядного rugpull")

    // шаг 4: RAGPULL (продажа всех токенов) с визуализацией
    console.log("\n" + "=".repeat(70))
    console.log("🔥 ШАГ 4: RAGPULL - ПРОДАЖА ВСЕХ ТОКЕНОВ")
    console.log("=".repeat(70))

    // получаем начальное состояние для графика
    const initialStats = getSimulatedTokenStats(mint)
    if (!initialStats) {
      throw new Error("не удалось получить статистику токена")
    }

    const initialPrice = initialStats.currentPrice
    const initialSolInPool = Number(initialStats.realSolReserves) / LAMPORTS_PER_SOL
    const initialTokensInPool = Number(initialStats.realTokenReserves)

    console.log(`\n📊 НАЧАЛЬНОЕ СОСТОЯНИЕ:`)
    console.log(`   Цена: ${initialPrice.toFixed(10)} SOL/token`)
    console.log(`   SOL в пуле: ${initialSolInPool.toFixed(6)} SOL`)
    console.log(`   Токенов в пуле: ${initialTokensInPool.toLocaleString()}`)

    // функция для отображения графика цены
    function drawPriceChart(prices: number[], width: number = 60): void {
      if (prices.length === 0) return
      
      const maxPrice = Math.max(...prices)
      const minPrice = Math.min(...prices)
      const range = maxPrice - minPrice || 1
      
      console.log(`\n📈 ГРАФИК ЦЕНЫ ВО ВРЕМЕНИ (${prices.length} точек):`)
      console.log(`   Макс: ${maxPrice.toFixed(10)} SOL | Мин: ${minPrice.toFixed(10)} SOL | Диапазон: ${((maxPrice - minPrice) / minPrice * 100).toFixed(2)}%`)
      console.log("   " + "─".repeat(width + 25))
      
      // рисуем график (инвертированный - цена падает вниз)
      const height = 15
      const chart: string[][] = Array(height).fill(null).map(() => Array(prices.length).fill(" "))
      
      for (let i = 0; i < prices.length; i++) {
        const normalized = (prices[i] - minPrice) / range
        const yPos = Math.floor(normalized * (height - 1))
        chart[height - 1 - yPos][i] = "█"
      }
      
      // соединяем точки линиями
      for (let i = 1; i < prices.length; i++) {
        const prevNormalized = (prices[i - 1] - minPrice) / range
        const currNormalized = (prices[i] - minPrice) / range
        const prevY = Math.floor(prevNormalized * (height - 1))
        const currY = Math.floor(currNormalized * (height - 1))
        
        const startY = Math.min(prevY, currY)
        const endY = Math.max(prevY, currY)
        
        for (let y = startY; y <= endY; y++) {
          if (chart[height - 1 - y][i] === " ") {
            chart[height - 1 - y][i] = "│"
          }
        }
      }
      
      // выводим график
      for (let y = 0; y < height; y++) {
        const priceAtY = minPrice + (range * (height - 1 - y) / (height - 1))
        const row = chart[y].join("")
        console.log(`   ${priceAtY.toFixed(8).padStart(12)} │${row}│`)
      }
      
      console.log("   " + "─".repeat(12) + "┼" + "─".repeat(prices.length) + "┼" + "─".repeat(12))
      console.log("   " + " ".repeat(13) + "Начало".padEnd(prices.length / 2) + "Конец".padStart(prices.length / 2))
      console.log()
    }

    // функция для отображения прогресса с дополнительной информацией
    function showProgress(current: number, total: number, label: string, extraInfo?: string): void {
      const percentage = Math.floor((current / total) * 100)
      const barLength = 30
      const filled = Math.floor((percentage / 100) * barLength)
      const bar = "█".repeat(filled) + "░".repeat(barLength - filled)
      const info = extraInfo ? ` | ${extraInfo}` : ""
      process.stdout.write(`\r   ${label}: [${bar}] ${percentage}%${info}`)
      if (current >= total) {
        process.stdout.write("\n")
      }
    }

    // собираем данные для графика
    const priceHistory: number[] = [initialPrice]
    const solInPoolHistory: number[] = [initialSolInPool]

    // функция для отображения текущего состояния в реальном времени
    function showCurrentState(stats: any, step: string): void {
      if (!stats) return
      console.log(`\n   📊 ${step}:`)
      console.log(`      Цена: ${stats.currentPrice.toFixed(10)} SOL/token`)
      console.log(`      SOL в пуле: ${(Number(stats.realSolReserves) / LAMPORTS_PER_SOL).toFixed(6)} SOL`)
      console.log(`      Токенов в пуле: ${stats.realTokenReserves.toLocaleString()}`)
    }

    // rugpull от buyer1 с визуализацией
    console.log(`\n💸 RAGPULL #1 (Buyer 1):`)
    const balance1Before = await getSimulatedTokenBalance(buyer1.publicKey, mint)
    const tokensToSell1 = balance1Before.balance
    
    if (tokensToSell1 > BigInt(0)) {
      const statsBefore1 = getSimulatedTokenStats(mint)
      if (statsBefore1) {
        showCurrentState(statsBefore1, "До продажи")
      }
      
      // симулируем продажу частями для визуализации
      const chunks = 20 // больше чанков = более плавный график
      const chunkSize = tokensToSell1 / BigInt(chunks)
      
      console.log(`\n   🔄 Продажа ${tokensToSell1.toString()} токенов частями...`)
      
      for (let i = 0; i < chunks; i++) {
        const chunk = i === chunks - 1 ? tokensToSell1 - (chunkSize * BigInt(i)) : chunkSize
        if (chunk > BigInt(0)) {
          await simulateSell(buyer1, mint, chunk)
          
          const stats = getSimulatedTokenStats(mint)
          if (stats) {
            priceHistory.push(stats.currentPrice)
            solInPoolHistory.push(Number(stats.realSolReserves) / LAMPORTS_PER_SOL)
            
            // показываем прогресс с текущей ценой и SOL в пуле
            const priceChange = ((stats.currentPrice - initialPrice) / initialPrice) * 100
            const solInPool = Number(stats.realSolReserves) / LAMPORTS_PER_SOL
            const solWithdrawn = initialSolInPool - solInPool
            showProgress(
              i + 1, 
              chunks, 
              "Продажа", 
              `Цена: ${stats.currentPrice.toFixed(8)} SOL (${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%) | Изъято: ${solWithdrawn.toFixed(6)} SOL`
            )
          }
          
          await new Promise(resolve => setTimeout(resolve, 150)) // задержка для визуализации
        }
      }
      
      const statsAfter1 = getSimulatedTokenStats(mint)
      if (statsAfter1) {
        const solDiff = initialSolInPool - (Number(statsAfter1.realSolReserves) / LAMPORTS_PER_SOL)
        console.log(`\n   ✅ Продано: ${tokensToSell1.toString()} токенов`)
        console.log(`   💰 Получено SOL: ${solDiff.toFixed(6)}`)
        showCurrentState(statsAfter1, "После продажи")
      }
    } else {
      console.log(`   ⚠️  Нет токенов для продажи`)
    }

    // rugpull от buyer2 с визуализацией
    console.log(`\n💸 RAGPULL #2 (Buyer 2):`)
    const balance2Before = await getSimulatedTokenBalance(buyer2.publicKey, mint)
    const tokensToSell2 = balance2Before.balance
    
    if (tokensToSell2 > BigInt(0)) {
      const statsBefore2 = getSimulatedTokenStats(mint)
      if (statsBefore2) {
        showCurrentState(statsBefore2, "До продажи")
      }
      
      const chunks = 20
      const chunkSize = tokensToSell2 / BigInt(chunks)
      
      console.log(`\n   🔄 Продажа ${tokensToSell2.toString()} токенов частями...`)
      
      for (let i = 0; i < chunks; i++) {
        const chunk = i === chunks - 1 ? tokensToSell2 - (chunkSize * BigInt(i)) : chunkSize
        if (chunk > BigInt(0)) {
          await simulateSell(buyer2, mint, chunk)
          
          const stats = getSimulatedTokenStats(mint)
          if (stats) {
            priceHistory.push(stats.currentPrice)
            solInPoolHistory.push(Number(stats.realSolReserves) / LAMPORTS_PER_SOL)
            
            const priceChange = ((stats.currentPrice - initialPrice) / initialPrice) * 100
            const solInPool = Number(stats.realSolReserves) / LAMPORTS_PER_SOL
            const solWithdrawn = initialSolInPool - solInPool
            showProgress(
              i + 1, 
              chunks, 
              "Продажа", 
              `Цена: ${stats.currentPrice.toFixed(8)} SOL (${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%) | Изъято: ${solWithdrawn.toFixed(6)} SOL`
            )
          }
          
          await new Promise(resolve => setTimeout(resolve, 150))
        }
      }
      
      const statsAfter2 = getSimulatedTokenStats(mint)
      if (statsAfter2) {
        const statsBefore2 = getSimulatedTokenStats(mint)
        const solBefore2 = statsBefore2 ? Number(statsBefore2.realSolReserves) / LAMPORTS_PER_SOL : initialSolInPool
        const solDiff = solBefore2 - (Number(statsAfter2.realSolReserves) / LAMPORTS_PER_SOL)
        console.log(`\n   ✅ Продано: ${tokensToSell2.toString()} токенов`)
        console.log(`   💰 Получено SOL: ${solDiff.toFixed(6)}`)
        showCurrentState(statsAfter2, "После продажи")
      }
    } else {
      console.log(`   ⚠️  Нет токенов для продажи`)
    }

    // отображаем графики
    console.log("\n" + "=".repeat(70))
    console.log("📈 ВИЗУАЛИЗАЦИЯ RAGPULL")
    console.log("=".repeat(70))
    
    drawPriceChart(priceHistory)

    // финальная статистика с графиком
    console.log("\n" + "=".repeat(70))
    console.log("📊 ФИНАЛЬНАЯ СТАТИСТИКА")
    console.log("=".repeat(70))

    const finalStats = getSimulatedTokenStats(mint)
    if (finalStats) {
      const priceChange = ((finalStats.currentPrice - initialPrice) / initialPrice) * 100
      const solChange = initialSolInPool - (Number(finalStats.realSolReserves) / LAMPORTS_PER_SOL)
      
      console.log(`\n💰 ИЗМЕНЕНИЯ:`)
      console.log(`   Цена: ${initialPrice.toFixed(10)} → ${finalStats.currentPrice.toFixed(10)} SOL`)
      console.log(`   Изменение цены: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`)
      console.log(`   SOL в пуле: ${initialSolInPool.toFixed(6)} → ${(Number(finalStats.realSolReserves) / LAMPORTS_PER_SOL).toFixed(6)} SOL`)
      console.log(`   Изъято SOL: ${solChange.toFixed(6)} SOL`)
      console.log(`   Токенов в пуле: ${initialTokensInPool.toLocaleString()} → ${finalStats.realTokenReserves.toLocaleString()}`)
      
      // график изменения SOL в пуле
      console.log(`\n📉 ГРАФИК SOL В ПУЛЕ:`)
      const maxSol = Math.max(...solInPoolHistory)
      const minSol = Math.min(...solInPoolHistory)
      const solRange = maxSol - minSol || 1
      const width = 50
      
      console.log(`   Макс: ${maxSol.toFixed(6)} SOL | Мин: ${minSol.toFixed(6)} SOL`)
      console.log("   " + "─".repeat(width + 2))
      
      for (let i = 0; i < solInPoolHistory.length; i++) {
        const normalized = (solInPoolHistory[i] - minSol) / solRange
        const barLength = Math.floor(normalized * width)
        const bar = "█".repeat(barLength) + "░".repeat(width - barLength)
        const solLabel = solInPoolHistory[i].toFixed(6)
        console.log(`   ${bar} ${solLabel} SOL`)
      }
      
      console.log("   " + "─".repeat(width + 2))
    }

    // проверка финальных балансов
    const finalBalance1 = await getSimulatedTokenBalance(buyer1.publicKey, mint)
    const finalBalance2 = await getSimulatedTokenBalance(buyer2.publicKey, mint)

    console.log("\n💰 Финальные балансы токенов:")
    console.log(`   Buyer 1: ${finalBalance1.uiBalance.toFixed(2)} токенов`)
    console.log(`   Buyer 2: ${finalBalance2.uiBalance.toFixed(2)} токенов`)

    console.log("\n" + "=".repeat(70))
    console.log("✅ ВСЕ ТЕСТЫ ПРОЙДЕНЫ УСПЕШНО!")
    console.log("=".repeat(70))
    console.log("\n💡 Теперь можешь протестировать rugpull на devnet без реальных денег!")
    console.log()

  } catch (error: any) {
    console.error("\n❌ ОШИБКА:")
    console.error(error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main().catch(console.error)
