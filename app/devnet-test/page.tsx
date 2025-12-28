"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, ComposedChart, Area } from "recharts"
import { Play, Square, TrendingDown, TrendingUp, Coins, Wallet, AlertCircle, Brain, Activity, Zap, Target, CheckCircle, XCircle, Info } from "lucide-react"
import { toast } from "sonner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"

interface TestState {
  creator?: string
  buyer1?: string
  buyer2?: string
  mint?: string
  buyer1SecretKey?: string
  buyer2SecretKey?: string
  createSignature?: string
}

interface PricePoint {
  time: number
  price: number
  solInPool: number
  tokensInPool: number
}

interface RagpullProgress {
  step: number
  total: number
  price: number
  priceChange: number
  solWithdrawn: number
  label: string
}

interface LogEntry {
  id: string
  timestamp: number
  type: "info" | "decision" | "action" | "success" | "warning" | "error"
  phase: "launch" | "buy" | "volume" | "ragpull" | "complete"
  message: string
  details?: {
    factor?: string
    value?: string | number
    impact?: string
    decision?: string
    reason?: string
  }
}

export default function DevnetTestPage() {
  const [testState, setTestState] = useState<TestState>({})
  const [creatorSecretKey, setCreatorSecretKey] = useState("")
  const [isRunning, setIsRunning] = useState(false)
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([])
  const [currentStats, setCurrentStats] = useState<any>(null)
  const [ragpullProgress, setRagpullProgress] = useState<RagpullProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [initialPrice, setInitialPrice] = useState<number | null>(null)
  const [initialSolInPool, setInitialSolInPool] = useState<number | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [decisionFactors, setDecisionFactors] = useState<any>(null)
  const [streaming, setStreaming] = useState(false)

  const loadStats = useCallback(async () => {
    if (!testState.mint || !testState.buyer1SecretKey || !testState.buyer2SecretKey) return

    try {
      const res = await fetch("/api/devnet-simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get-stats",
          mint: testState.mint,
          buyer1SecretKey: testState.buyer1SecretKey,
          buyer2SecretKey: testState.buyer2SecretKey,
        }),
      })

      const data = await res.json()
      if (data.success && data.stats) {
        setCurrentStats(data.stats)
        
        const price = data.stats.currentPrice
        const solInPool = Number(data.stats.realSolReserves) / 1e9
        const tokensInPool = Number(data.stats.realTokenReserves)

        setPriceHistory((prev) => {
          const newPoint = {
            time: Date.now(),
            price,
            solInPool,
            tokensInPool,
          }
          // ограничиваем историю до 100 точек
          return [...prev.slice(-99), newPoint]
        })
      }
    } catch (error: any) {
      console.error("error loading stats:", error)
    }
  }, [testState])

  useEffect(() => {
    if (!isRunning) return
    setStreaming(true)
    const id = setInterval(() => {
      loadStats()
    }, 1000)
    return () => {
      clearInterval(id)
      setStreaming(false)
    }
  }, [isRunning, loadStats])

  const addLog = (type: LogEntry["type"], phase: LogEntry["phase"], message: string, details?: LogEntry["details"]) => {
    const log: LogEntry = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      type,
      phase,
      message,
      details,
    }
    setLogs((prev) => [...prev, log])
  }

  const startTest = async () => {
    if (!creatorSecretKey.trim()) {
      setError("введи secret key creator кошелька")
      return
    }

    setIsRunning(true)
    setError(null)
    setPriceHistory([])
    setRagpullProgress(null)
    setInitialPrice(null)
    setInitialSolInPool(null)
    setLogs([])
    setDecisionFactors(null)
    
    addLog("info", "launch", "🚀 запуск теста", { factor: "инициализация", value: "начало цикла" })

    try {
      // очищаем предыдущие тесты
      await fetch("/api/devnet-simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      })

      // запускаем тест
      const res = await fetch("/api/devnet-simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start-test",
          creatorSecretKey: creatorSecretKey.trim(),
        }),
      })

      const data = await res.json()
      if (!data.success) {
        throw new Error(data.error || "ошибка запуска теста")
      }

      setTestState(data)
      toast.success("тест запущен")
      
      addLog("success", "launch", "✅ токен создан", {
        factor: "mint",
        value: data.mint?.slice(0, 8) + "...",
        impact: "токен готов к торговле"
      })

      // получаем начальную статистику
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await loadStats()
      
      addLog("info", "buy", "📊 анализ начального состояния", {
        factor: "bonding curve",
        value: "инициализация",
        impact: "базовая цена установлена"
      })

      // делаем покупки
      await performBuys(data)
    } catch (error: any) {
      setError(error.message)
      setIsRunning(false)
      toast.error(error.message)
    }
  }

  const performBuys = async (state: TestState) => {
    try {
      addLog("action", "buy", "💰 покупка buyer1", {
        factor: "amount",
        value: "0.1 SOL",
        impact: "увеличение ликвидности"
      })
      
      // покупка buyer1
      const buy1Res = await fetch("/api/devnet-simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "buy",
          buyerSecretKey: state.buyer1SecretKey,
          mint: state.mint,
          solAmount: 0.1,
        }),
      })
      const buy1Data = await buy1Res.json()
      await loadStats()
      
      if (buy1Data.success && currentStats) {
        addLog("success", "buy", "✅ покупка выполнена", {
          factor: "price impact",
          value: `${((currentStats.currentPrice - (initialPrice || 0)) / (initialPrice || 1) * 100).toFixed(2)}%`,
          impact: "цена выросла"
        })
      }
      
      await new Promise((resolve) => setTimeout(resolve, 500))

      addLog("action", "buy", "💰 покупка buyer2", {
        factor: "amount",
        value: "0.2 SOL",
        impact: "дальнейший рост ликвидности"
      })

      // покупка buyer2
      const buy2Res = await fetch("/api/devnet-simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "buy",
          buyerSecretKey: state.buyer2SecretKey,
          mint: state.mint,
          solAmount: 0.2,
        }),
      })
      const buy2Data = await buy2Res.json()
      await loadStats()

      if (buy2Data.success && currentStats) {
        addLog("success", "buy", "✅ покупка выполнена", {
          factor: "price impact",
          value: `${((currentStats.currentPrice - (initialPrice || 0)) / (initialPrice || 1) * 100).toFixed(2)}%`,
          impact: "цена продолжает расти"
        })
      }

      // сохраняем начальные значения для rugpull
      if (currentStats) {
        setInitialPrice(currentStats.currentPrice)
        setInitialSolInPool(Number(currentStats.realSolReserves) / 1e9)
        
        addLog("decision", "ragpull", "🧠 анализ условий для ragpull", {
          factor: "текущая цена",
          value: `${currentStats.currentPrice.toFixed(8)} SOL`,
          decision: "оценка прибыльности",
          reason: "проверка возможности выхода с прибылью"
        })
        
        // симулируем факторы принятия решения
        const factors = {
          currentPrice: currentStats.currentPrice,
          solInPool: Number(currentStats.realSolReserves) / 1e9,
          priceChange: 0,
          liquidity: Number(currentStats.realSolReserves) / 1e9,
          canRagpull: true,
          estimatedProfit: 0,
          riskLevel: "medium",
        }
        setDecisionFactors(factors)
      }

      // запускаем rugpull
      await performRagpull(state)
    } catch (error: any) {
      setError(error.message)
      setIsRunning(false)
      toast.error(error.message)
    }
  }

  const performRagpull = async (state: TestState) => {
    if (!state.mint || !state.buyer1SecretKey || !state.buyer2SecretKey) return

    try {
      addLog("decision", "ragpull", "🔍 проверка условий ragpull", {
        factor: "балансы токенов",
        decision: "оценка возможности продажи",
        reason: "проверка наличия токенов для продажи"
      })
      
      // получаем балансы
      const statsRes = await fetch("/api/devnet-simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get-stats",
          mint: state.mint,
          buyer1SecretKey: state.buyer1SecretKey,
          buyer2SecretKey: state.buyer2SecretKey,
        }),
      })

      const statsData = await statsRes.json()
      if (!statsData.success) throw new Error("не удалось получить балансы")

      const balance1 = BigInt(statsData.balance1.balance)
      const balance2 = BigInt(statsData.balance2.balance)
      
      addLog("info", "ragpull", "📊 балансы получены", {
        factor: "buyer1",
        value: `${Number(balance1) / 1e6} токенов`,
        impact: "готов к продаже"
      })
      
      addLog("info", "ragpull", "📊 балансы получены", {
        factor: "buyer2",
        value: `${Number(balance2) / 1e6} токенов`,
        impact: "готов к продаже"
      })
      
      // анализ факторов для принятия решения
      if (currentStats && initialPrice) {
        const priceChange = ((currentStats.currentPrice - initialPrice) / initialPrice) * 100
        const totalTokens = Number(balance1) + Number(balance2)
        const estimatedSol = currentStats.currentPrice * (totalTokens / 1e6)
        
        addLog("decision", "ragpull", "🧠 расчет прибыльности", {
          factor: "изменение цены",
          value: `${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`,
          decision: priceChange > 0 ? "прибыльный выход" : "убыточный выход",
          reason: priceChange > 0 ? "цена выросла, можно фиксировать прибыль" : "цена упала, но нужно выходить"
        })
        
        addLog("decision", "ragpull", "🧠 оценка ликвидности", {
          factor: "SOL в пуле",
          value: `${(Number(currentStats.realSolReserves) / 1e9).toFixed(6)} SOL`,
          decision: Number(currentStats.realSolReserves) / 1e9 > 0.1 ? "достаточно ликвидности" : "низкая ликвидность",
          reason: "проверка возможности продажи без большого проскальзывания"
        })
        
        setDecisionFactors({
          currentPrice: currentStats.currentPrice,
          initialPrice,
          priceChange,
          solInPool: Number(currentStats.realSolReserves) / 1e9,
          totalTokens: totalTokens / 1e6,
          estimatedSol,
          canRagpull: true,
          riskLevel: priceChange > 20 ? "low" : priceChange > 0 ? "medium" : "high",
        })
      }

      // rugpull buyer1
      if (balance1 > BigInt(0)) {
        addLog("action", "ragpull", "💸 начало ragpull buyer1", {
          factor: "стратегия",
          value: "продажа частями",
          decision: "минимизация price impact",
          reason: "продажа большими частями приведет к большому проскальзыванию"
        })
        
        const chunks = 20
        const chunkSize = balance1 / BigInt(chunks)

        for (let i = 0; i < chunks; i++) {
          const chunk = i === chunks - 1
            ? balance1 - chunkSize * BigInt(i)
            : chunkSize

          if (chunk > BigInt(0)) {
            addLog("action", "ragpull", `📤 продажа чанка ${i + 1}/${chunks}`, {
              factor: "размер чанка",
              value: `${Number(chunk) / 1e6} токенов`,
              impact: "частичное снижение цены"
            })
            
            const sellRes = await fetch("/api/devnet-simulator", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "sell",
                buyerSecretKey: state.buyer1SecretKey,
                mint: state.mint,
                tokenAmount: chunk.toString(),
              }),
            })
            
            const sellData = await sellRes.json()
            await loadStats()
            
            if (sellData.success && currentStats) {
              const priceChange = ((currentStats.currentPrice - (initialPrice || 0)) / (initialPrice || 1)) * 100
              const solWithdrawn = initialSolInPool
                ? initialSolInPool - (Number(currentStats.realSolReserves) / 1e9)
                : 0
              
              addLog("success", "ragpull", `✅ чанк ${i + 1} продан`, {
                factor: "цена после продажи",
                value: `${currentStats.currentPrice.toFixed(8)} SOL`,
                impact: `цена изменилась на ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`
              })

              setRagpullProgress({
                step: i + 1,
                total: chunks,
                price: currentStats.currentPrice,
                priceChange,
                solWithdrawn,
                label: "Ragpull #1 (Buyer 1)",
              })
            }
            
            await new Promise((resolve) => setTimeout(resolve, 200))
          }
        }
        
        addLog("success", "ragpull", "✅ ragpull buyer1 завершен", {
          factor: "результат",
          value: "все токены проданы",
          impact: "ликвидность изъята из пула"
        })
      }

      // rugpull buyer2
      if (balance2 > BigInt(0)) {
        addLog("action", "ragpull", "💸 начало ragpull buyer2", {
          factor: "стратегия",
          value: "продажа частями",
          decision: "продолжение изъятия ликвидности",
          reason: "максимизация прибыли при минимальном проскальзывании"
        })
        
        const chunks = 20
        const chunkSize = balance2 / BigInt(chunks)

        for (let i = 0; i < chunks; i++) {
          const chunk = i === chunks - 1
            ? balance2 - chunkSize * BigInt(i)
            : chunkSize

          if (chunk > BigInt(0)) {
            addLog("action", "ragpull", `📤 продажа чанка ${i + 1}/${chunks}`, {
              factor: "размер чанка",
              value: `${Number(chunk) / 1e6} токенов`,
              impact: "дальнейшее снижение цены"
            })
            
            const sellRes = await fetch("/api/devnet-simulator", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "sell",
                buyerSecretKey: state.buyer2SecretKey,
                mint: state.mint,
                tokenAmount: chunk.toString(),
              }),
            })
            
            const sellData = await sellRes.json()
            await loadStats()
            
            if (sellData.success && currentStats) {
              const priceChange = ((currentStats.currentPrice - (initialPrice || 0)) / (initialPrice || 1)) * 100
              const solWithdrawn = initialSolInPool
                ? initialSolInPool - (Number(currentStats.realSolReserves) / 1e9)
                : 0
              
              addLog("success", "ragpull", `✅ чанк ${i + 1} продан`, {
                factor: "цена после продажи",
                value: `${currentStats.currentPrice.toFixed(8)} SOL`,
                impact: `цена изменилась на ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`
              })

              setRagpullProgress({
                step: i + 1,
                total: chunks,
                price: currentStats.currentPrice,
                priceChange,
                solWithdrawn,
                label: "Ragpull #2 (Buyer 2)",
              })
            }
            
            await new Promise((resolve) => setTimeout(resolve, 200))
          }
        }
        
        addLog("success", "ragpull", "✅ ragpull buyer2 завершен", {
          factor: "результат",
          value: "все токены проданы",
          impact: "ликвидность полностью изъята"
        })
      }

      // финальный анализ
      if (currentStats && initialPrice && initialSolInPool) {
        // жёсткое визуальное падение цены (ragpull)
        setPriceHistory((prev) => {
          const base = prev.slice(-99)
          const last = base[base.length - 1]
          if (!last) return base

          const peakPrice = last.price * 1.25 // финальный памп перед сливом
          const peakSol = last.solInPool

          const crashPoints = [
            { mult: 0.40, solMult: 0.30 },
            { mult: 0.18, solMult: 0.12 },
            { mult: 0.07, solMult: 0.05 },
            { mult: 0.025, solMult: 0.015 },
            { mult: 0.010, solMult: 0.008 },
            { mult: 0.004, solMult: 0.004 },
            { mult: 0.002, solMult: 0.002 },
          ]

          const visualCrash = [
            // wick up before dump
            {
              time: last.time + 1,
              price: peakPrice,
              solInPool: peakSol * 1.05,
              tokensInPool: last.tokensInPool,
            },
            ...crashPoints.map((p, idx) => ({
              time: last.time + idx + 2,
              price: Math.max(peakPrice * p.mult, 0),
              solInPool: Math.max(peakSol * p.solMult, 0),
              tokensInPool: 0,
            })),
          ]

          return [...base, ...visualCrash]
        })

        const finalPriceChange = ((currentStats.currentPrice - initialPrice) / initialPrice) * 100
        const totalSolWithdrawn = initialSolInPool - (Number(currentStats.realSolReserves) / 1e9)
        
        addLog("decision", "complete", "📊 финальный анализ", {
          factor: "общее изменение цены",
          value: `${finalPriceChange >= 0 ? "+" : ""}${finalPriceChange.toFixed(2)}%`,
          decision: finalPriceChange > 0 ? "прибыльный выход" : "убыточный выход",
          reason: "оценка эффективности стратегии"
        })
        
        addLog("success", "complete", "🎉 ragpull завершен успешно", {
          factor: "изъято SOL",
          value: `${totalSolWithdrawn.toFixed(6)} SOL`,
          impact: "ликвидность изъята, прибыль зафиксирована"
        })
      }

      setRagpullProgress(null)
      setIsRunning(false)
      toast.success("ragpull завершен")
    } catch (error: any) {
      setError(error.message)
      setIsRunning(false)
      toast.error(error.message)
    }
  }

  const chartConfig = {
    price: {
      label: "Цена",
      color: "#E05174",
    },
    priceDown: {
      label: "Цена (падение)",
      color: "#980025",
    },
    solInPool: {
      label: "SOL в пуле",
      color: "#EFDBE0",
    },
  }

  // добавляем информацию о направлении для правильных цветов
  const chartData = priceHistory.map((point, index) => {
    const prevPoint = priceHistory[index - 1]
    const isUp = !prevPoint || point.price >= prevPoint.price
    return {
      time: index,
      price: point.price,
      priceUp: isUp ? point.price : null,
      priceDown: !isUp ? point.price : null,
      solInPool: point.solInPool,
      isUp,
    }
  })

  return (
    <div className="container mx-auto p-6 space-y-6 text-[#EFDBE0]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[#E05174]">devnet тестирование</h1>
          <p className="text-[#EFDBE0] mt-1">
            симулятор pump.fun для тестирования rugpull
          </p>
        </div>
        <Badge variant="outline" className="border-yellow-500 text-yellow-500">
          <AlertCircle className="w-3 h-3 mr-1" />
          DEMO MODE
        </Badge>
      </div>

      {error && (
        <Alert variant="destructive" className="border-[#980025] bg-[#980025] text-white">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="text-white">{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="text-[#EFDBE0]">
            <CardTitle className="text-[#E05174]">настройка теста</CardTitle>
            <CardDescription className="text-[#EFDBE0]">
              введи secret key кошелька с SOL на devnet
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="secretKey">Creator Secret Key (base58)</Label>
              <Input
                id="secretKey"
                type="password"
                placeholder="2bo29pzBW6iBKZpMzPNKuGf9nHQ6mUQ3Cu4GdhWArbbyRfKNprCKnCyWz7FAWJfeZq7qKBdfbA7UrVAx1USnuRNm"
                value={creatorSecretKey}
                onChange={(e) => setCreatorSecretKey(e.target.value)}
                disabled={isRunning}
              />
            </div>
            <Button
              onClick={startTest}
              disabled={isRunning || !creatorSecretKey.trim()}
              className="w-full"
            >
              <Play className="mr-2 h-4 w-4" />
              запустить тест
            </Button>
          </CardContent>
        </Card>

        {testState.mint && (
          <Card>
            <CardHeader>
              <CardTitle>информация о тесте</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                <span className="font-medium">Creator:</span>{" "}
                {testState.creator?.slice(0, 8)}...
              </div>
              <div>
                <span className="font-medium">Mint:</span>{" "}
                {testState.mint?.slice(0, 8)}...
              </div>
              <div>
                <span className="font-medium">Buyer 1:</span>{" "}
                {testState.buyer1?.slice(0, 8)}...
              </div>
              <div>
                <span className="font-medium">Buyer 2:</span>{" "}
                {testState.buyer2?.slice(0, 8)}...
              </div>
            </CardContent>
          </Card>
        )}

        {currentStats && (
          <Card>
            <CardHeader>
              <CardTitle>текущая статистика</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-muted-foreground">Цена</div>
                  <div className="text-2xl font-bold">
                    {currentStats.currentPrice.toFixed(10)} SOL
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">SOL в пуле</div>
                  <div className="text-2xl font-bold">
                    {(Number(currentStats.realSolReserves) / 1e9).toFixed(6)} SOL
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Токенов в пуле</div>
                  <div className="text-2xl font-bold">
                    {Number(currentStats.realTokenReserves).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Market Cap</div>
                  <div className="text-2xl font-bold">
                    ${currentStats.marketCap.toFixed(2)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {ragpullProgress && (
          <Card>
            <CardHeader>
              <CardTitle>{ragpullProgress.label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span>Прогресс</span>
                  <span>
                    {ragpullProgress.step} / {ragpullProgress.total} (
                    {Math.floor((ragpullProgress.step / ragpullProgress.total) * 100)}%)
                  </span>
                </div>
                <Progress
                  value={(ragpullProgress.step / ragpullProgress.total) * 100}
                />
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-muted-foreground">Цена</div>
                  <div className="font-bold">
                    {ragpullProgress.price.toFixed(8)} SOL
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Изменение</div>
                  <div
                    className={`font-bold ${
                      ragpullProgress.priceChange < 0
                        ? "text-red-500"
                        : "text-green-500"
                    }`}
                  >
                    {ragpullProgress.priceChange >= 0 ? "+" : ""}
                    {ragpullProgress.priceChange.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Изъято SOL</div>
                  <div className="font-bold">
                    {ragpullProgress.solWithdrawn.toFixed(6)} SOL
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {priceHistory.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>график цены</CardTitle>
            <CardDescription>
              изменение цены токена во время rugpull (зеленый = рост, красный = падение)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={chartConfig} className="h-[400px]">
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EFDBE0" opacity={0.35} />
                <XAxis dataKey="time" stroke="#EFDBE0" />
                <YAxis stroke="#EFDBE0" />
                <ChartTooltip 
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload
                      return (
                        <div className="rounded-lg border bg-background p-2 shadow-sm">
                          <div className="grid gap-2">
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">Цена:</span>
                              <span className="font-bold">{data.price.toFixed(8)} SOL</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">Направление:</span>
                              <Badge variant="outline" className={data.isUp ? "border-green-500 text-green-500" : "border-red-500 text-red-500"}>
                                {data.isUp ? "↑ рост" : "↓ падение"}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      )
                    }
                    return null
                  }}
                />
                {/* зеленая линия для роста */}
                <Line
                  type="monotone"
                  dataKey="priceUp"
                  stroke="#E05174"
                  strokeWidth={2.5}
                  dot={false}
                  connectNulls={true}
                />
                {/* красная линия для падения */}
                <Line
                  type="monotone"
                  dataKey="priceDown"
                  stroke="#980025"
                  strokeWidth={3}
                  dot={false}
                  connectNulls={true}
                />
              </ComposedChart>
            </ChartContainer>
          </CardContent>
        </Card>
      )}

      {priceHistory.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>график SOL в пуле</CardTitle>
            <CardDescription>
              изменение SOL в пуле ликвидности
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={chartConfig} className="h-[400px]">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EFDBE0" opacity={0.35} />
                <XAxis dataKey="time" stroke="#EFDBE0" />
                <YAxis stroke="#EFDBE0" />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line
                  type="monotone"
                  dataKey="solInPool"
                  stroke="#EFDBE0"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>
      )}

      {/* логирование процесса */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            логирование процесса
          </CardTitle>
          <CardDescription>
            детальная информация о принятии решений и выполнении операций
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px] w-full pr-4">
            <div className="space-y-3">
              {logs.map((log) => {
                const time = new Date(log.timestamp)
                const timeStr = time.toLocaleTimeString()
                
                const typeColors = {
                  info: "text-blue-400",
                  decision: "text-purple-400",
                  action: "text-yellow-400",
                  success: "text-green-400",
                  warning: "text-orange-400",
                  error: "text-red-400",
                }
                
                const typeIcons = {
                  info: <Info className="w-4 h-4" />,
                  decision: <Brain className="w-4 h-4" />,
                  action: <Zap className="w-4 h-4" />,
                  success: <CheckCircle className="w-4 h-4" />,
                  warning: <AlertCircle className="w-4 h-4" />,
                  error: <XCircle className="w-4 h-4" />,
                }
                
                const phaseLabels = {
                  launch: "🚀 Лаунч",
                  buy: "💰 Покупка",
                  volume: "🤖 Volume",
                  ragpull: "💸 Ragpull",
                  complete: "✅ Завершение",
                }
                
                return (
                  <div
                    key={log.id}
                    className={`p-3 rounded-lg border ${
                      log.type === "success" ? "bg-green-500/10 border-green-500/30" :
                      log.type === "error" ? "bg-red-500/10 border-red-500/30" :
                      log.type === "decision" ? "bg-purple-500/10 border-purple-500/30" :
                      log.type === "action" ? "bg-yellow-500/10 border-yellow-500/30" :
                      "bg-blue-500/10 border-blue-500/30"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 ${typeColors[log.type]}`}>
                        {typeIcons[log.type]}
                      </div>
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground">{timeStr}</span>
                          <Badge variant="outline" className="text-xs">
                            {phaseLabels[log.phase]}
                          </Badge>
                          <span className={`text-sm font-medium ${typeColors[log.type]}`}>
                            {log.message}
                          </span>
                        </div>
                        {log.details && (
                          <div className="mt-2 space-y-1 pl-7 text-xs text-muted-foreground">
                            {log.details.factor && (
                              <div>
                                <span className="font-medium">фактор:</span> {log.details.factor}
                                {log.details.value && (
                                  <span className="ml-2 text-foreground">= {log.details.value}</span>
                                )}
                              </div>
                            )}
                            {log.details.decision && (
                              <div className="flex items-center gap-2">
                                <Target className="w-3 h-3 text-purple-400" />
                                <span className="font-medium text-purple-400">решение:</span>
                                <span>{log.details.decision}</span>
                              </div>
                            )}
                            {log.details.reason && (
                              <div className="text-muted-foreground italic">
                                {log.details.reason}
                              </div>
                            )}
                            {log.details.impact && (
                              <div>
                                <span className="font-medium">влияние:</span> {log.details.impact}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              {logs.length === 0 && (
                <div className="text-center text-muted-foreground py-8">
                  логи появятся после запуска теста
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* факторы принятия решений */}
      {decisionFactors && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="w-5 h-5" />
              факторы принятия решений
            </CardTitle>
            <CardDescription>
              анализ условий для выполнения ragpull
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
                  <div className="text-sm font-medium text-blue-400 mb-2">цена</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">начальная:</span>
                      <span>{decisionFactors.initialPrice?.toFixed(8) || "N/A"} SOL</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">текущая:</span>
                      <span>{decisionFactors.currentPrice?.toFixed(8) || "N/A"} SOL</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">изменение:</span>
                      <span className={decisionFactors.priceChange >= 0 ? "text-green-400" : "text-red-400"}>
                        {decisionFactors.priceChange >= 0 ? "+" : ""}{decisionFactors.priceChange?.toFixed(2) || "N/A"}%
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                  <div className="text-sm font-medium text-green-400 mb-2">ликвидность</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">SOL в пуле:</span>
                      <span>{decisionFactors.solInPool?.toFixed(6) || "N/A"} SOL</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">токенов:</span>
                      <span>{decisionFactors.totalTokens?.toFixed(2) || "N/A"}</span>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="space-y-3">
                <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/30">
                  <div className="text-sm font-medium text-purple-400 mb-2">оценка</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">риск:</span>
                      <Badge
                        variant="outline"
                        className={
                          decisionFactors.riskLevel === "low" ? "border-green-500 text-green-500" :
                          decisionFactors.riskLevel === "high" ? "border-red-500 text-red-500" :
                          "border-yellow-500 text-yellow-500"
                        }
                      >
                        {decisionFactors.riskLevel || "unknown"}
                      </Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">можно ragpull:</span>
                      <span className={decisionFactors.canRagpull ? "text-green-400" : "text-red-400"}>
                        {decisionFactors.canRagpull ? "да" : "нет"}
                      </span>
                    </div>
                    {decisionFactors.estimatedSol && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">оценка SOL:</span>
                        <span>{decisionFactors.estimatedSol.toFixed(6)} SOL</span>
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                  <div className="text-sm font-medium text-yellow-400 mb-2">стратегия</div>
                  <div className="text-xs space-y-1">
                    <div>• продажа частями (20 чанков)</div>
                    <div>• минимизация price impact</div>
                    <div>• постепенное изъятие ликвидности</div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
