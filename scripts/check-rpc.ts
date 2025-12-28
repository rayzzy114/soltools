#!/usr/bin/env npx ts-node
/**
 * Проверка подключения к ERPC RPC
 * 
 * Запуск: pnpm tsx scripts/check-rpc.ts
 */

import { Connection, PublicKey } from "@solana/web3.js"
import { RPC_ENDPOINT, SOLANA_NETWORK } from "../lib/solana/config"

async function checkRpc(): Promise<void> {
  console.log("\n" + "=".repeat(60))
  console.log("🔍 ПРОВЕРКА RPC ПОДКЛЮЧЕНИЯ")
  console.log("=".repeat(60))
  console.log()
  
  console.log(`Network: ${SOLANA_NETWORK}`)
  console.log(`RPC: ${RPC_ENDPOINT}`)
  console.log()
  
  try {
    const connection = new Connection(RPC_ENDPOINT, {
      commitment: "confirmed",
    })
    
    // тест 1: getSlot
    console.log("📡 Тест 1: getSlot...")
    const start1 = Date.now()
    const slot = await connection.getSlot()
    const latency1 = Date.now() - start1
    console.log(`✅ Slot: ${slot} (${latency1}ms)`)
    
    // тест 2: getVersion
    console.log("\n📡 Тест 2: getVersion...")
    const start2 = Date.now()
    const version = await connection.getVersion()
    const latency2 = Date.now() - start2
    console.log(`✅ Version: ${version["solana-core"]} (${latency2}ms)`)
    
    // тест 3: getBalance
    console.log("\n📡 Тест 3: getBalance (системный аккаунт)...")
    const start3 = Date.now()
    const sysAccount = new PublicKey("11111111111111111111111111111111")
    const balance = await connection.getBalance(sysAccount)
    const latency3 = Date.now() - start3
    console.log(`✅ Balance: ${balance / 1e9} SOL (${latency3}ms)`)
    
    // тест 4: getLatestBlockhash
    console.log("\n📡 Тест 4: getLatestBlockhash...")
    const start4 = Date.now()
    const blockhash = await connection.getLatestBlockhash()
    const latency4 = Date.now() - start4
    console.log(`✅ Blockhash: ${blockhash.blockhash.slice(0, 16)}... (${latency4}ms)`)
    
    // тест 5: getAccountInfo (pump.fun program)
    if (SOLANA_NETWORK === "mainnet-beta") {
      console.log("\n📡 Тест 5: getAccountInfo (pump.fun program)...")
      const start5 = Date.now()
      const pumpFunProgram = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
      const accountInfo = await connection.getAccountInfo(pumpFunProgram)
      const latency5 = Date.now() - start5
      if (accountInfo) {
        console.log(`✅ Pump.fun program найден (${latency5}ms)`)
      } else {
        console.log(`⚠️  Pump.fun program не найден (${latency5}ms)`)
      }
    }
    
    // итоговая статистика
    const avgLatency = (latency1 + latency2 + latency3 + latency4) / 4
    console.log("\n" + "=".repeat(60))
    console.log("📊 РЕЗУЛЬТАТЫ")
    console.log("=".repeat(60))
    console.log(`✅ RPC подключен и работает`)
    console.log(`📈 Средняя латентность: ${avgLatency.toFixed(0)}ms`)
    
    if (avgLatency < 100) {
      console.log(`🚀 Отлично! Низкая латентность`)
    } else if (avgLatency < 300) {
      console.log(`✅ Хорошо! Приемлемая латентность`)
    } else {
      console.log(`⚠️  Высокая латентность, возможно проблемы с сетью`)
    }
    
    if (SOLANA_NETWORK === "mainnet-beta") {
      console.log(`\n✅ Настроен на mainnet-beta - pump.fun доступен`)
    } else {
      console.log(`\n⚠️  Настроен на ${SOLANA_NETWORK} - pump.fun НЕ работает!`)
      console.log(`   Переключи на mainnet-beta для работы с pump.fun`)
    }
    
    console.log("=".repeat(60) + "\n")
    
  } catch (error: any) {
    console.error("\n❌ ОШИБКА ПОДКЛЮЧЕНИЯ:")
    console.error(error.message)
    console.error("\nПроверь:")
    console.error("1. Правильность RPC URL в .env")
    console.error("2. Что API ключ корректный")
    console.error("3. Что интернет подключен")
    console.error("=".repeat(60) + "\n")
    process.exit(1)
  }
}

checkRpc().catch(console.error)
