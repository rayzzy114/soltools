import { prisma } from "@/lib/prisma"
import { getPumpswapPoolData } from "@/lib/solana/pumpfun-sdk"
import { PublicKey } from "@solana/web3.js"

export async function getDashboardStats() {
  try {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  const activeTokens = await prisma.token.count({
    where: {
      createdAt: {
        gte: weekAgo,
      },
    },
  })

  const transactions24h = await prisma.transaction.findMany({
    where: {
      createdAt: {
        gte: yesterday,
      },
      type: {
        in: ["buy", "sell"],
      },
      status: "confirmed",
    },
  })

    const totalVolume24h = transactions24h.reduce((sum: number, tx: { solAmount: string | null }) => {
    return sum + parseFloat(tx.solAmount || "0")
  }, 0)

    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
  const bundledTxs = await prisma.bundle.count({
    where: {
      createdAt: {
        gte: today,
      },
      status: "completed",
    },
  })

  const holdersGained = await prisma.transaction.count({
    where: {
      createdAt: {
        gte: yesterday,
      },
      type: "buy",
      status: "confirmed",
    },
    distinct: ["walletAddress"],
  })

  return {
    activeTokens,
    totalVolume24h: totalVolume24h.toFixed(2),
    bundledTxs,
    holdersGained,
    }
  } catch {
    // БД недоступна - возвращаем дефолтные значения
    return {
      activeTokens: 0,
      totalVolume24h: "0",
      bundledTxs: 0,
      holdersGained: 0,
    }
  }
}

export async function getVolumeChartData(days: number = 7) {
  try {
  const now = new Date()
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

  const stats = await prisma.stats.findMany({
    where: {
      date: {
        gte: startDate,
      },
    },
    orderBy: {
      date: "asc",
    },
  })

    return stats.map((stat: { date: Date; totalVolume24h: string }) => ({
    date: stat.date.toISOString().split("T")[0],
    volume: parseFloat(stat.totalVolume24h),
  }))
  } catch {
    return []
  }
}

export async function getActiveTokens() {
  try {
  const tokens = await prisma.token.findMany({
    orderBy: {
      createdAt: "desc",
    },
    take: 10,
    include: {
      transactions: {
        where: {
          status: "confirmed",
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
      },
    },
  })

    const migratedFlags = await Promise.all(
      tokens.map(async (token: any) => {
        try {
          const pool = await getPumpswapPoolData(new PublicKey(token.mintAddress))
          return !!pool
        } catch {
          return false
        }
      })
    )

    return tokens.map((token: any, idx: number) => ({
      id: token.id,
      symbol: token.symbol,
      name: token.name,
      mintAddress: token.mintAddress,
      price: token.transactions[0]?.price || "0",
      change: "+0%",
      status: migratedFlags[idx] ? "migrated" : "bonding",
      isMigrated: migratedFlags[idx],
    }))
  } catch {
    return []
  }
}

export async function getRecentActivity(limit: number = 10) {
  try {
  const transactions = await prisma.transaction.findMany({
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
    include: {
      token: true,
    },
  })

    return transactions.map((tx: any) => ({
    time: tx.createdAt,
    action: getActionLabel(tx.type),
    token: tx.token.symbol,
    amount: tx.solAmount || tx.amount,
    type: tx.type,
  }))
  } catch {
    return []
  }
}

function getActionLabel(type: string): string {
  const labels: Record<string, string> = {
    buy: "Buy executed",
    sell: "Sell executed",
    add_liquidity: "Liquidity added",
    remove_liquidity: "Liquidity removed",
    burn: "Tokens burned",
  }
  return labels[type] || "Transaction"
}

export async function getBundlerStats() {
  try {
    const bundles = await prisma.bundle.findMany({
      where: {
        status: {
          in: ["completed", "failed"],
        },
      },
    })

    const totalBundles = bundles.length
    const completedBundles = bundles.filter((b: { status: string }) => b.status === "completed").length
    const successRate = totalBundles > 0 ? (completedBundles / totalBundles) * 100 : 0

    const totalGasSaved = bundles.reduce((sum: number, b: { gasUsed: string | null; txCount: number }) => {
      const gasUsed = parseFloat(b.gasUsed || "0")
      const individualCost = b.txCount * 0.0005
      const bundledCost = gasUsed
      return sum + Math.max(0, individualCost - bundledCost)
    }, 0)

    return {
      successRate: successRate.toFixed(1),
      gasSaved: totalGasSaved.toFixed(2),
    }
  } catch {
    return {
      successRate: "0",
      gasSaved: "0",
    }
  }
}

export async function getVolumeBotStats() {
  try {
    const now = new Date()
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)

    const activePairs = await prisma.volumeBotPair.count({
      where: {
        isActive: true,
      },
    })

    const tradesToday = await prisma.transaction.count({
      where: {
        createdAt: {
          gte: today,
        },
        type: {
          in: ["buy", "sell"],
        },
        status: "confirmed",
      },
    })

    const transactionsToday = await prisma.transaction.findMany({
      where: {
        createdAt: {
          gte: today,
        },
        type: {
          in: ["buy", "sell"],
        },
        status: "confirmed",
      },
    })

    const volumeGenerated = transactionsToday.reduce((sum: number, tx: { solAmount: string | null }) => {
      return sum + parseFloat(tx.solAmount || "0")
    }, 0)

    const solSpent = await prisma.volumeBotPair.aggregate({
      where: {
        createdAt: {
          gte: today,
        },
      },
      _sum: {
        solSpent: true,
      },
    })

    const solSpentValue = parseFloat(solSpent._sum.solSpent || "0")

    const runningPairs = await prisma.volumeBotPair.findFirst({
      where: {
        isActive: true,
      },
    })
    const isRunning = !!runningPairs

    return {
      isRunning,
      activePairs,
      tradesToday,
      volumeGenerated: volumeGenerated.toFixed(2),
      solSpent: solSpentValue.toFixed(2),
    }
  } catch {
    return {
      isRunning: false,
      activePairs: 0,
      tradesToday: 0,
      volumeGenerated: "0",
      solSpent: "0",
    }
  }
}
