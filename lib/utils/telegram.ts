/**
 * Telegram Alerter для тестов и мониторинга
 */

export interface TelegramConfig {
  botToken: string
  chatId: string
  enabled: boolean
}

export interface AlertMessage {
  title: string
  message: string
  type: "info" | "success" | "warning" | "error"
  data?: Record<string, string | number>
}

const EMOJI = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  error: "❌",
  rocket: "🚀",
  money: "💰",
  chart: "📊",
  token: "🪙",
  bot: "🤖",
  exit: "💸",
  clock: "⏱️",
}

function getConfig(): TelegramConfig {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
    enabled: process.env.TELEGRAM_ALERTS_ENABLED === "true",
  }
}

function formatData(data: Record<string, string | number>): string {
  return Object.entries(data)
    .map(([key, value]) => `• <b>${key}:</b> ${value}`)
    .join("\n")
}

export async function sendTelegramAlert(alert: AlertMessage): Promise<boolean> {
  const config = getConfig()
  
  if (!config.enabled || !config.botToken || !config.chatId) {
    if (process.env.DEBUG_MODE === "true") {
      console.log(`[telegram] alert skipped (disabled): ${alert.title}`)
    }
    return false
  }

  const emoji = EMOJI[alert.type]
  let text = `${emoji} <b>${alert.title}</b>\n\n${alert.message}`
  
  if (alert.data && Object.keys(alert.data).length > 0) {
    text += `\n\n${formatData(alert.data)}`
  }

  try {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error("[telegram] send failed:", error)
      return false
    }

    return true
  } catch (error) {
    console.error("[telegram] error:", error)
    return false
  }
}

// ========================
// PREDEFINED ALERTS
// ========================

export async function alertTestStarted(testName: string, config: Record<string, string | number>): Promise<void> {
  await sendTelegramAlert({
    title: `${EMOJI.rocket} Тест запущен: ${testName}`,
    message: "Начат цикл тестирования в Devnet",
    type: "info",
    data: config,
  })
}

export async function alertTestCompleted(
  testName: string,
  success: boolean,
  metrics: Record<string, string | number>
): Promise<void> {
  await sendTelegramAlert({
    title: success ? `${EMOJI.success} Тест завершен` : `${EMOJI.error} Тест провален`,
    message: testName,
    type: success ? "success" : "error",
    data: metrics,
  })
}

export async function alertTokenCreated(
  tokenMint: string,
  tokenName: string,
  tokenSymbol: string
): Promise<void> {
  await sendTelegramAlert({
    title: `${EMOJI.token} Токен создан`,
    message: `${tokenName} (${tokenSymbol})`,
    type: "success",
    data: {
      "Mint": tokenMint,
      "Solscan": `solscan.io/token/${tokenMint}?cluster=devnet`,
    },
  })
}

export async function alertBundleSent(
  bundleId: string,
  txCount: number,
  status: string
): Promise<void> {
  const isSuccess = status === "landed"
  await sendTelegramAlert({
    title: `${EMOJI.rocket} Bundle ${isSuccess ? "отправлен" : "ошибка"}`,
    message: `ID: ${bundleId}`,
    type: isSuccess ? "success" : "error",
    data: {
      "Транзакций": txCount,
      "Статус": status,
    },
  })
}

export async function alertVolumeBotCycle(
  cycle: number,
  totalCycles: number,
  volume: number,
  price: number
): Promise<void> {
  await sendTelegramAlert({
    title: `${EMOJI.bot} Volume Bot`,
    message: `Цикл ${cycle}/${totalCycles}`,
    type: "info",
    data: {
      "Объем": `${volume.toFixed(4)} SOL`,
      "Цена": `${price.toFixed(10)} SOL/token`,
    },
  })
}

export async function alertTriggerFired(
  triggerType: string,
  tokenMint: string,
  value: number,
  threshold: number
): Promise<void> {
  await sendTelegramAlert({
    title: `${EMOJI.chart} Триггер сработал`,
    message: triggerType,
    type: "warning",
    data: {
      "Токен": tokenMint.slice(0, 8) + "...",
      "Значение": value.toFixed(4),
      "Порог": threshold.toFixed(4),
    },
  })
}

export async function alertRagpullExecuted(
  tokenMint: string,
  solReturned: number,
  profit: number,
  roi: number
): Promise<void> {
  const isProfit = profit >= 0
  await sendTelegramAlert({
    title: `${EMOJI.exit} Ragpull выполнен`,
    message: isProfit ? "Прибыльный выход" : "Убыточный выход",
    type: isProfit ? "success" : "warning",
    data: {
      "Токен": tokenMint.slice(0, 8) + "...",
      "Получено SOL": solReturned.toFixed(4),
      "Прибыль": `${profit >= 0 ? "+" : ""}${profit.toFixed(4)} SOL`,
      "ROI": `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`,
    },
  })
}

export async function alertError(
  context: string,
  error: string,
  details?: Record<string, string | number>
): Promise<void> {
  await sendTelegramAlert({
    title: `${EMOJI.error} Ошибка`,
    message: `${context}: ${error}`,
    type: "error",
    data: details,
  })
}

export async function alertGraduationDetected(
  tokenMint: string,
  bondingCurveProgress: number
): Promise<void> {
  await sendTelegramAlert({
    title: `${EMOJI.rocket} Graduation обнаружен!`,
    message: "Токен мигрирует на Raydium",
    type: "warning",
    data: {
      "Токен": tokenMint.slice(0, 8) + "...",
      "Прогресс BC": `${bondingCurveProgress.toFixed(2)}%`,
    },
  })
}

// ========================
// TEST HELPER
// ========================

export async function testTelegramConnection(): Promise<boolean> {
  const config = getConfig()
  
  if (!config.botToken || !config.chatId) {
    console.log("[telegram] не настроен (botToken или chatId отсутствует)")
    return false
  }

  try {
    const url = `https://api.telegram.org/bot${config.botToken}/getMe`
    const response = await fetch(url)
    const data = await response.json()
    
    if (data.ok) {
      console.log(`[telegram] подключен к боту: @${data.result.username}`)
      
      // отправить тестовое сообщение
      await sendTelegramAlert({
        title: "🔔 Тест подключения",
        message: "Telegram алерты работают!",
        type: "success",
        data: {
          "Бот": `@${data.result.username}`,
          "Время": new Date().toISOString(),
        },
      })
      
      return true
    }
    
    return false
  } catch (error) {
    console.error("[telegram] ошибка подключения:", error)
    return false
  }
}
