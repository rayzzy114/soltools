"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent } from "@/components/ui/chart"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Area, AreaChart, ReferenceLine, ComposedChart, Tooltip, Legend } from "recharts"
import {
  Rocket,
  Package,
  Bot,
  TrendingUp,
  Wallet,
  Zap,
  BarChart3,
  PlayCircle,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Play,
} from "lucide-react"
import Link from "next/link"

interface Feature {
  id: string
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  status: "ready" | "demo" | "devnet"
  route: string
  features: string[]
}

const allFeatures: Feature[] = [
  {
    id: "token-launcher",
    title: "Token Launcher",
    description: "создание токенов на pump.fun с загрузкой метаданных на IPFS",
    icon: Rocket,
    status: "ready",
    route: "/token-launcher",
    features: [
      "загрузка изображения на IPFS",
      "создание токена с метаданными",
      "dev buy сразу после создания",
      "отслеживание созданных токенов",
    ],
  },
  {
    id: "bundler",
    title: "Solana Bundler",
    description: "создание токена + bundled buys через Jito (до 5 кошельков)",
    icon: Package,
    status: "ready",
    route: "/bundler",
    features: [
      "управление кошельками (генерация, импорт, группы)",
      "создание токена + bundled buys",
      "warmup кошельков перед запуском",
      "атомарное выполнение через Jito",
    ],
  },
  {
    id: "volume-bot",
    title: "Volume Bot",
    description: "автоматическая генерация торгового объема",
    icon: Bot,
    status: "ready",
    route: "/volume-bot",
    features: [
      "wash trading (buy/sell чередование)",
      "режимы: buy only, sell only, wash",
      "random/fixed/percentage amounts",
      "multi-threaded выполнение",
      "anti-detection (randomization)",
    ],
  },
  {
    id: "dashboard",
    title: "Dashboard",
    description: "статистика токенов, PnL, активность",
    icon: BarChart3,
    status: "ready",
    route: "/dashboard",
    features: [
      "обзор всех токенов",
      "PnL tracking (realized/unrealized)",
      "статистика торговли",
      "графики и метрики",
    ],
  },
  {
    id: "devnet-test",
    title: "Devnet Testing",
    description: "симулятор pump.fun для тестирования на devnet",
    icon: PlayCircle,
    status: "devnet",
    route: "/devnet-test",
    features: [
      "симулятор bonding curve",
      "тестирование rugpull без реальных денег",
      "графики цены в реальном времени",
      "полный цикл: create → buy → sell → rugpull",
    ],
  },
  {
    id: "triggers",
    title: "Triggers Engine",
    description: "автоматические buy/sell по условиям",
    icon: Zap,
    status: "ready",
    route: "/dashboard", // TODO: отдельная страница
    features: [
      "take profit (фиксация прибыли)",
      "stop loss (ограничение убытков)",
      "trailing stop (следящий стоп)",
      "price target (целевая цена)",
      "time-based triggers",
    ],
  },
  {
    id: "sniper",
    title: "Graduation Sniper",
    description: "мониторинг миграции токенов на Raydium",
    icon: TrendingUp,
    status: "ready",
    route: "/dashboard", // TODO: отдельная страница
    features: [
      "мониторинг прогресса bonding curve",
      "автоматический buy перед graduation",
      "уведомления о миграции",
    ],
  },
  {
    id: "ragpull",
    title: "Ragpull",
    description: "продажа всех токенов (bonding curve или pumpswap)",
    icon: Wallet,
    status: "ready",
    route: "/dashboard", // TODO: отдельная страница
    features: [
      "автоматическое определение метода продажи",
      "продажа на bonding curve",
      "swap через pumpswap AMM",
      "расчет прибыли и ROI",
    ],
  },
]

export default function DemoPage() {
  const [selectedFeature, setSelectedFeature] = useState<Feature | null>(null)

  const getStatusBadge = (status: Feature["status"]) => {
    switch (status) {
      case "ready":
        return (
          <Badge variant="default" className="bg-green-500">
            <CheckCircle2 className="w-3 h-3 mr-1" />
            готово
          </Badge>
        )
      case "demo":
        return (
          <Badge variant="secondary">
            <PlayCircle className="w-3 h-3 mr-1" />
            демо
          </Badge>
        )
      case "devnet":
        return (
          <Badge variant="outline" className="border-yellow-500 text-yellow-500">
            <AlertCircle className="w-3 h-3 mr-1" />
            devnet
          </Badge>
        )
    }
  }

  return (
    <div className="container mx-auto p-6 space-y-6 text-[#EFDBE0]">
      <div className="text-center space-y-2 mb-8">
        <h1 className="text-4xl font-bold text-[#E05174]">pump.fun панель - демонстрация</h1>
        <p className="text-[#EFDBE0] text-lg">
          полный функционал для работы с pump.fun токенами
        </p>
        <div className="flex items-center justify-center gap-2 mt-4">
          <Badge variant="outline" className="border-yellow-500 text-yellow-500">
            <AlertCircle className="w-3 h-3 mr-1" />
            демо-режим (devnet)
          </Badge>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="overview">обзор</TabsTrigger>
          <TabsTrigger value="features">функции</TabsTrigger>
          <TabsTrigger value="pipeline">пайплайн</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {allFeatures.map((feature) => {
              const Icon = feature.icon
              return (
                <Card
                  key={feature.id}
                  className="cursor-pointer hover:border-[#E05174] transition-colors text-[#EFDBE0]"
                  onClick={() => setSelectedFeature(feature)}
                >
                  <CardHeader className="text-[#EFDBE0]">
                    <div className="flex items-center justify-between">
                      <Icon className="h-8 w-8 text-[#E05174]" />
                      {getStatusBadge(feature.status)}
                    </div>
                    <CardTitle className="text-lg text-[#E05174]">{feature.title}</CardTitle>
                    <CardDescription className="text-[#EFDBE0]">{feature.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1 text-sm text-[#EFDBE0]">
                      {feature.features.slice(0, 3).map((f, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <CheckCircle2 className="w-3 h-3 text-[#E05174]" />
                          {f}
                        </li>
                      ))}
                      {feature.features.length > 3 && (
                        <li className="text-xs text-[#EFDBE0]">
                          +{feature.features.length - 3} еще...
                        </li>
                      )}
                    </ul>
                    <Button
                      asChild
                      variant="outline"
                      className="w-full mt-4 border-[#E05174] text-[#EFDBE0]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Link href={feature.route}>
                        открыть
                        <ArrowRight className="w-4 h-4 ml-2" />
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="features" className="space-y-6">
          <div className="grid gap-6">
            {allFeatures.map((feature) => {
              const Icon = feature.icon
              return (
                <Card key={feature.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Icon className="h-6 w-6 text-primary" />
                        <CardTitle>{feature.title}</CardTitle>
                      </div>
                      {getStatusBadge(feature.status)}
                    </div>
                    <CardDescription>{feature.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-2 md:grid-cols-2">
                      {feature.features.map((f, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm">
                          <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                          <span>{f}</span>
                        </div>
                      ))}
                    </div>
                    <Button asChild variant="outline" className="mt-4">
                      <Link href={feature.route}>
                        открыть {feature.title}
                        <ArrowRight className="w-4 h-4 ml-2" />
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="pipeline" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>интерактивный график полного цикла</CardTitle>
              <CardDescription>
                визуализация: лаунч → рост → volume bot → rugpull
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FullCycleChart />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>полный пайплайн работы</CardTitle>
              <CardDescription>
                от создания токена до rugpull и получения прибыли
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {[
                  {
                    phase: "фаза 1: launch",
                    steps: [
                      "подготовка метаданных (IPFS)",
                      "создание токена + dev buy",
                      "initial buys через bundler (Jito)",
                    ],
                    features: ["Token Launcher", "Bundler"],
                  },
                  {
                    phase: "фаза 2: volume",
                    steps: [
                      "volume bot (wash trading)",
                      "мониторинг прогресса bonding curve",
                    ],
                    features: ["Volume Bot", "Dashboard"],
                  },
                  {
                    phase: "фаза 3: monitoring",
                    steps: [
                      "triggers engine (take profit, stop loss)",
                      "graduation sniper (мониторинг миграции)",
                    ],
                    features: ["Triggers Engine", "Graduation Sniper"],
                  },
                  {
                    phase: "фаза 4: exit",
                    steps: [
                      "ragpull (продажа всех токенов)",
                      "расчет PnL и профита",
                    ],
                    features: ["Ragpull", "Dashboard (PnL)"],
                  },
                ].map((phase, i) => (
                  <div key={i} className="border-l-2 border-primary pl-4 space-y-2">
                    <h3 className="font-semibold text-lg">{phase.phase}</h3>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {phase.steps.map((step, j) => (
                        <li key={j} className="flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                          {step}
                        </li>
                      ))}
                    </ul>
                    <div className="flex gap-2 mt-2">
                      {phase.features.map((f) => (
                        <Badge key={f} variant="secondary">
                          {f}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>быстрый старт для демо</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <h4 className="font-semibold">1. тестирование на devnet</h4>
                <p className="text-sm text-muted-foreground">
                  используй симулятор для тестирования rugpull без реальных денег
                </p>
                <Button asChild>
                  <Link href="/devnet-test">
                    <PlayCircle className="w-4 h-4 mr-2" />
                    открыть devnet тест
                  </Link>
                </Button>
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold">2. создание токена</h4>
                <p className="text-sm text-muted-foreground">
                  создай токен через Token Launcher или Bundler
                </p>
                <div className="flex gap-2">
                  <Button asChild variant="outline">
                    <Link href="/token-launcher">Token Launcher</Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="/bundler">Bundler</Link>
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold">3. генерация объема</h4>
                <p className="text-sm text-muted-foreground">
                  запусти Volume Bot для создания торгового объема
                </p>
                <Button asChild variant="outline">
                  <Link href="/volume-bot">
                    <Bot className="w-4 h-4 mr-2" />
                    Volume Bot
                  </Link>
                </Button>
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold">4. мониторинг и выход</h4>
                <p className="text-sm text-muted-foreground">
                  отслеживай токены в Dashboard и выполняй ragpull
                </p>
                <Button asChild variant="outline">
                  <Link href="/dashboard">
                    <BarChart3 className="w-4 h-4 mr-2" />
                    Dashboard
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// компонент графика полного цикла
function FullCycleChart() {
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentPhase, setCurrentPhase] = useState<string>("")
  const [chartData, setChartData] = useState<any[]>([])

  // генерируем демо-данные для полного цикла (сглажено)
  const generateCycleData = useMemo(() => {
    const data: any[] = []
    let time = 0
    let price = 0.0001
    const clamp = (v: number) => Math.max(0.000001, v)
    const pushPoint = (phase: string, volume: number, next: number, isSell = false) => {
      const prev = price
      price = clamp(next)
      data.push({
        time: ++time,
        price,
        phase,
        volume,
        isUp: price >= prev,
        change: price - prev,
        isSell,
      })
    }

    // launch — плавный старт
    for (let i = 0; i < 10; i++) {
      const step = 0.00001 * (1 + i * 0.12)
      pushPoint("launch", 0.15 + i * 0.05, price + step)
    }

    // initial buys — контролируемый рост с редкими откатами
    for (let i = 0; i < 20; i++) {
      const drift = 0.055 + 0.025 * Math.sin(i / 4)
      const shock = i % 6 === 0 && i > 0 ? -0.012 : 0
      const next = price * (1 + drift + shock)
      pushPoint("initial_buys", 0.45 + i * 0.07, next)
    }

    // volume bot — мягкие колебания
    for (let i = 0; i < 40; i++) {
      const isSell = i % 4 === 0
      const wobble = Math.sin(i / 3) * 0.007
      const trend = 0.012
      const delta = isSell ? -0.009 + wobble : trend + wobble
      const next = price * (1 + delta)
      pushPoint("volume_bot", 1.1 + Math.sin(i / 8) * 0.35 + (isSell ? 0.2 : 0.4), next, isSell)
    }

    // monitoring — боковик с лёгким дрейфом
    for (let i = 0; i < 20; i++) {
      const drift = -0.0015 + Math.sin(i / 5) * 0.0015
      const next = price * (1 + drift)
      pushPoint("monitoring", 0.8 + Math.cos(i / 4) * 0.2, next)
    }

    // ragpull — пик и контролируемый спад
    const blowOffTop = price * 1.3
    pushPoint("ragpull", 4.5, blowOffTop, false)
    const crashMultipliers = [0.62, 0.44, 0.31, 0.22, 0.15, 0.11, 0.08, 0.06]
    crashMultipliers.forEach((mult, idx) => {
      const wobble = idx > 3 ? Math.sin(idx) * 0.009 : 0
      const next = blowOffTop * mult * (1 + wobble)
      pushPoint("ragpull", Math.max(3.5 - idx * 0.35, 0.6), next, true)
    })
    while (data.length < 100) {
      const noise = Math.sin(data.length / 4) * 0.002
      const next = price * (1 + noise)
      pushPoint("ragpull", 0.35, next, next < price)
    }

    return data
  }, [])

  const playCycle = () => {
    setIsPlaying(true)
    setChartData([])
    setCurrentPhase("запуск...")

    const fullData = generateCycleData
    let index = 0

    const interval = setInterval(() => {
      if (index < fullData.length) {
        const point = fullData[index]
        setChartData((prev) => [...prev, point])

        // обновляем фазу
        if (point.phase === "launch") {
          setCurrentPhase("🚀 лаунч токена")
        } else if (point.phase === "initial_buys") {
          setCurrentPhase("📈 initial buys (рост цены)")
        } else if (point.phase === "volume_bot") {
          setCurrentPhase("🤖 volume bot (генерация объема)")
        } else if (point.phase === "ragpull") {
          setCurrentPhase("💸 ragpull (резкое падение)")
        }

        index++
      } else {
        clearInterval(interval)
        setIsPlaying(false)
        setCurrentPhase("✅ цикл завершен")
      }
    }, 100) // обновление каждые 100ms
  }

  const resetChart = () => {
    setIsPlaying(false)
    setChartData([])
    setCurrentPhase("")
  }

  const chartConfig = {
    price: {
      label: "Цена",
      color: "#E05174",
    },
  }

  const displayData = chartData.length > 0 ? chartData : generateCycleData
  const minPrice = Math.min(...displayData.map((d) => d.price))
  const maxPrice = Math.max(...displayData.map((d) => d.price))
  const yDomain = [
    Math.max(minPrice * 0.9, 0),
    maxPrice * 1.1,
  ]
  const phaseLegend = useMemo(
    () => [
      { label: "launch", color: "#4FC3F7" },
      { label: "initial buys", color: "#6EE7B7" },
      { label: "volume bot", color: "#FBBF24" },
      { label: "ragpull", color: "#F43F5E" },
    ],
    []
  )

  const renderLegend = () => (
    <div className="flex flex-wrap gap-3 text-xs text-[#EFDBE0]">
      {phaseLegend.map((item) => (
        <div key={item.label} className="flex items-center gap-2 px-2 py-1 rounded-full border border-[#EFDBE0]/30 bg-black/10">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
          <span className="uppercase tracking-wide">{item.label}</span>
        </div>
      ))}
    </div>
  )

  // определяем фазы для визуализации
  const launchEnd = displayData.findIndex((d) => d.phase === "initial_buys")
  const initialBuysEnd = displayData.findIndex((d) => d.phase === "volume_bot")
  const volumeBotEnd = displayData.findIndex((d) => d.phase === "ragpull")

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            onClick={playCycle}
            disabled={isPlaying}
            size="sm"
          >
            <Play className="w-4 h-4 mr-2" />
            запустить демо
          </Button>
          <Button
            onClick={resetChart}
            variant="outline"
            size="sm"
            disabled={isPlaying}
          >
            сбросить
          </Button>
        </div>
        {currentPhase && (
          <Badge variant="outline" className="text-lg px-4 py-2">
            {currentPhase}
          </Badge>
        )}
      </div>

      <ChartContainer config={chartConfig} className="h-[500px] w-full">
        <ComposedChart data={displayData}>
          <defs>
            <linearGradient id="colorPriceUp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#E05174" stopOpacity={0.4} />
              <stop offset="95%" stopColor="#E05174" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorPriceDown" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#980025" stopOpacity={0.45} />
              <stop offset="95%" stopColor="#980025" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="4 4" stroke="#EFDBE0" opacity={0.25} />
          <XAxis
            dataKey="time"
            label={{ value: "Время", position: "insideBottom", offset: -5, fill: "#EFDBE0" }}
            stroke="#EFDBE0"
          />
          <YAxis
            domain={yDomain}
            label={{ value: "Цена (SOL)", angle: -90, position: "insideLeft", fill: "#EFDBE0" }}
            stroke="#EFDBE0"
            tickFormatter={(value) => value.toFixed(6)}
          />
          <Tooltip contentStyle={{ background: "#980025", border: "1px solid #E05174", color: "#EFDBE0" }} />
          <Legend content={renderLegend} />
          <ChartTooltip
            content={({ active, payload }) => {
              if (active && payload && payload.length) {
                const data = payload[0].payload
                const changePercent = data.change ? (data.change / Math.max(data.price - data.change, 1e-9)) * 100 : 0
                return (
                  <div className="rounded-lg border border-[#E05174] bg-[#980025] p-2 shadow-sm text-[#EFDBE0]">
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between gap-4">
                        <span>Цена:</span>
                        <span className="font-bold">{data.price.toFixed(8)} SOL</span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span>Изменение:</span>
                        <span className="font-bold">
                          {data.isUp ? "+" : ""}{changePercent.toFixed(2)}%
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span>Фаза:</span>
                        <Badge variant="outline" className="text-xs border-[#E05174] text-[#EFDBE0]">
                          {data.phase === "launch" && "🚀 Лаунч"}
                          {data.phase === "initial_buys" && "📈 Initial Buys"}
                          {data.phase === "volume_bot" && (data.isSell ? "🤖 Volume Bot (Sell)" : "🤖 Volume Bot (Buy)")}
                          {data.phase === "ragpull" && "💸 Ragpull"}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span>Объем:</span>
                        <span>{data.volume.toFixed(2)} SOL</span>
                      </div>
                    </div>
                  </div>
                )
              }
              return null
            }}
          />
          <Line
            type="monotone"
            dataKey="price"
            data={displayData}
            stroke="#E05174"
            strokeWidth={3}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          {launchEnd > 0 && (
            <ReferenceLine
              x={displayData[launchEnd]?.time}
              stroke="#EFDBE0"
              strokeDasharray="5 5"
              label={{ value: "Лаунч завершен", position: "top", fill: "#EFDBE0" }}
            />
          )}
          {initialBuysEnd > 0 && (
            <ReferenceLine
              x={displayData[initialBuysEnd]?.time}
              stroke="#E05174"
              strokeDasharray="5 5"
              strokeWidth={2}
              label={{ value: "Volume Bot старт", position: "top", fill: "#E05174" }}
            />
          )}
          {volumeBotEnd > 0 && (
            <ReferenceLine
              x={displayData[volumeBotEnd]?.time}
              stroke="#980025"
              strokeDasharray="5 5"
              strokeWidth={2}
              label={{ value: "RAGPULL", position: "top", fill: "#980025" }}
            />
          )}
        </ComposedChart>
      </ChartContainer>

      <div className="grid grid-cols-4 gap-4 text-sm">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-blue-500" />
            <span className="font-medium">лаунч</span>
          </div>
          <div className="text-muted-foreground pl-5">
            создание токена, начальная цена
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span className="font-medium">initial buys</span>
          </div>
          <div className="text-muted-foreground pl-5">
            резкий рост цены
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <span className="font-medium">volume bot</span>
          </div>
          <div className="text-muted-foreground pl-5">
            генерация объема, плавный рост
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <span className="font-medium">ragpull</span>
          </div>
          <div className="text-muted-foreground pl-5">
            резкое падение, продажа всех токенов
          </div>
        </div>
      </div>
    </div>
  )
}
