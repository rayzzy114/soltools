import { prisma } from "@/lib/prisma"
import { VolumeBotPairEngine } from "./volume-bot-engine"
import { getResilientConnection } from "./config"

export class VolumeBotManager {
  private static instance: VolumeBotManager
  private runningBots: Map<string, NodeJS.Timeout> = new Map()
  private engines: Map<string, VolumeBotPairEngine> = new Map()

  private constructor() {}

  static getInstance(): VolumeBotManager {
    if (!VolumeBotManager.instance) {
      VolumeBotManager.instance = new VolumeBotManager()
    }
    return VolumeBotManager.instance
  }

  async startBot(pairId: string): Promise<void> {
    // Stop if already running
    if (this.runningBots.has(pairId)) {
      await this.stopBot(pairId)
    }

    // Get bot configuration from DB
    const pair = await prisma.volumeBotPair.findUnique({
      where: { id: pairId },
      include: { settings: true, token: true }
    })

    if (!pair || !pair.settings) {
      throw new Error("Bot pair or settings not found")
    }

    // Create engine
    const engine = new VolumeBotPairEngine({
      pairId,
      tokenId: pair.tokenId,
      mintAddress: pair.token.mintAddress,
      settings: pair.settings,
      onTrade: this.handleTrade.bind(this),
      onError: this.handleError.bind(this),
      onLog: this.handleLog.bind(this)
    })

    await engine.initialize()
    this.engines.set(pairId, engine)

    // Start the bot loop
    // We use a dummy timer to indicate running state in runningBots map, but logic is recursive
    this.runningBots.set(pairId, setTimeout(() => {}, 0))
    this.scheduleNextCycle(pairId)

    await this.log(pairId, "Volume bot started", "info")
  }

  private async scheduleNextCycle(pairId: string): Promise<void> {
    if (!this.runningBots.has(pairId)) return

    try {
      // Reload pair config to get latest intervals
      const pair = await prisma.volumeBotPair.findUnique({
        where: { id: pairId },
        select: { minIntervalSeconds: true, maxIntervalSeconds: true, intervalSeconds: true }
      })

      if (!pair) {
        await this.stopBot(pairId)
        return
      }

      // Calculate delay
      const min = pair.minIntervalSeconds || pair.intervalSeconds || 30
      const max = pair.maxIntervalSeconds || pair.intervalSeconds || 120
      const delaySeconds = Math.floor(Math.random() * (max - min + 1)) + min

      await this.log(pairId, `Next cycle in ${delaySeconds}s`, "info")

      const timer = setTimeout(async () => {
        if (!this.runningBots.has(pairId)) return
        try {
          const engine = this.engines.get(pairId)
          if (engine) {
            await this.log(pairId, "Cycle tick", "info")
            await engine.executeCycle()
          }
        } catch (error) {
          console.error(`Bot ${pairId} cycle error:`, error)
          await this.handleError(pairId, error as Error)
        } finally {
          // Schedule next
          this.scheduleNextCycle(pairId)
        }
      }, delaySeconds * 1000)

      this.runningBots.set(pairId, timer)

    } catch (error) {
      console.error(`Scheduling error for ${pairId}:`, error)
      await this.stopBot(pairId)
    }
  }

  async stopBot(pairId: string): Promise<void> {
    const timer = this.runningBots.get(pairId)
    if (timer) {
      clearTimeout(timer)
      this.runningBots.delete(pairId)
    }

    const engine = this.engines.get(pairId)
    if (engine) {
      engine.cleanup()
      this.engines.delete(pairId)
    }

    await this.log(pairId, "Volume bot stopped", "info")
  }

  async getBotStatus(pairId: string) {
    const isRunning = this.runningBots.has(pairId)
    const engine = this.engines.get(pairId)

    return {
      isRunning,
      engine: engine ? {
        totalTrades: engine.getTotalTrades(),
        totalVolume: engine.getTotalVolume(),
        solSpent: engine.getSolSpent()
      } : null
    }
  }

  private async handleTrade(pairId: string, trade: any) {
    // Update statistics in DB
    await prisma.volumeBotPair.update({
      where: { id: pairId },
      data: {
        totalTrades: { increment: 1 },
        totalVolume: trade.solAmount,
        solSpent: trade.solAmount,
        lastRunAt: new Date()
      }
    })

    await this.log(pairId, `Trade executed: ${trade.type} ${trade.solAmount} SOL`, "success", {
      type: trade.type,
      solAmount: trade.solAmount,
      signature: trade.signature
    })
  }

  private async handleError(pairId: string, error: Error) {
    // Log error to DB
    await this.log(pairId, `Error: ${error.message}`, "error", {
      stack: error.stack
    })

    // If it's a critical error, stop the bot
    if (error.message.includes("insufficient funds") ||
        error.message.includes("rate limit") ||
        error.message.includes("connection")) {
      console.error(`Critical error for bot ${pairId}, stopping:`, error)
      await this.stopBot(pairId)
    }
  }

  private async handleLog(pairId: string, message: string, type: string = "info") {
    await this.log(pairId, message, type)
  }

  private async log(pairId: string, message: string, type: string = "info", metadata?: any) {
    try {
      await prisma.botLog.create({
        data: {
          pairId,
          message,
          type,
          metadata: metadata || {}
        }
      })
    } catch (error) {
      console.error("Failed to log to database:", error)
    }
  }

  // Cleanup all bots on shutdown
  async shutdown(): Promise<void> {
    for (const pairId of this.runningBots.keys()) {
      await this.stopBot(pairId)
    }
  }
}
