"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { toast } from "sonner"
import {
  Play,
  Pause,
  Settings,
  TrendingUp,
  Zap,
  Wallet,
  Plus,
  Trash2,
  RefreshCw,
  Copy,
  AlertTriangle,
  Activity,
  Download,
} from "lucide-react"
import { clampNumber, parseSafe } from "@/lib/ui-utils"

interface VolumeWallet {
  publicKey: string
  secretKey: string
  solBalance: number
  tokenBalance: number
  isActive: boolean
}

interface VolumeTransaction {
  wallet: string
  type: "buy" | "sell"
  amount: number
  tokensOrSol: number
  signature?: string
  status: "pending" | "success" | "failed"
  error?: string
  timestamp: number
}

interface TokenInfo {
  mintAddress: string
  price: number
  isMigrated: boolean
  virtualSolReserves: number
  virtualTokenReserves: number
}

export default function VolumeBotPage() {
  // state
  const [network, setNetwork] = useState<string>("unknown")
  const [wallets, setWallets] = useState<VolumeWallet[]>([])
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null)
  const [transactions, setTransactions] = useState<VolumeTransaction[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  
  // config
  const [config, setConfig] = useState({
    mintAddress: "",
    mode: "wash" as "buy" | "sell" | "wash",
    amountMode: "random" as "fixed" | "random" | "percentage",
    fixedAmount: "0.01",
    minAmount: "0.005",
    maxAmount: "0.02",
    minPercentage: "5",
    maxPercentage: "20",
    minInterval: "5",
    maxInterval: "15",
    slippage: "10",
    priorityFee: "0.0005",
    maxExecutions: "0",
    multiThreaded: false,
  })
  const {
    mintAddress,
    mode,
    amountMode,
    fixedAmount,
    minAmount,
    maxAmount,
    minPercentage,
    maxPercentage,
    minInterval,
    maxInterval,
    slippage,
    priorityFee,
    maxExecutions,
    multiThreaded,
  } = config

  const setMintAddress = (value: string) => setConfig((prev) => ({ ...prev, mintAddress: value }))
  const setMode = (value: "buy" | "sell" | "wash") => setConfig((prev) => ({ ...prev, mode: value }))
  const setAmountMode = (value: "fixed" | "random" | "percentage") =>
    setConfig((prev) => ({ ...prev, amountMode: value }))
  const setFixedAmount = (value: string) => setConfig((prev) => ({ ...prev, fixedAmount: value }))
  const setMinAmount = (value: string) => setConfig((prev) => ({ ...prev, minAmount: value }))
  const setMaxAmount = (value: string) => setConfig((prev) => ({ ...prev, maxAmount: value }))
  const setMinPercentage = (value: string) => setConfig((prev) => ({ ...prev, minPercentage: value }))
  const setMaxPercentage = (value: string) => setConfig((prev) => ({ ...prev, maxPercentage: value }))
  const setMinInterval = (value: string) => setConfig((prev) => ({ ...prev, minInterval: value }))
  const setMaxInterval = (value: string) => setConfig((prev) => ({ ...prev, maxInterval: value }))
  const setSlippage = (value: string) => setConfig((prev) => ({ ...prev, slippage: value }))
  const setPriorityFee = (value: string) => setConfig((prev) => ({ ...prev, priorityFee: value }))
  const setMaxExecutions = (value: string) => setConfig((prev) => ({ ...prev, maxExecutions: value }))
  const setMultiThreaded = (value: boolean) => {
    setConfig((prev) => {
      const next = { ...prev, multiThreaded: value }
      emitLog(
        "H3",
        "app/volume-bot/page.tsx:setMultiThreaded",
        "toggle multiThreaded",
        { value },
      )
      return next
    })
  }
  const emitLog = (
    hypothesisId: string,
    location: string,
    message: string,
    data: Record<string, unknown>,
    runId: string = "pre-fix",
  ) => {
    // #region agent log
    fetch("http://127.0.0.1:7242/ingest/e23f7788-0527-4cc5-ae49-c1d5738f268a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId,
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {})
    // #endregion
  }
  
  // stats
  const [stats, setStats] = useState({
    totalBuys: 0,
    totalSells: 0,
    totalVolume: 0,
    executionCount: 0,
  })
  
  // import wallet modal
  const [importKey, setImportKey] = useState("")
  
  // bot interval ref
  const botIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const executionCountRef = useRef(0)
  // отслеживание последнего действия для wash trading
  const lastActionsRef = useRef<Map<string, "buy" | "sell">>(new Map())
  const runningRef = useRef(false)

  const clampNumber = (value: number, min: number, max: number) => {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, value))
  }

  useEffect(() => {
    fetchNetwork()
    return () => {
      if (botIntervalRef.current) {
        clearTimeout(botIntervalRef.current)
      }
    }
  }, [])

  const fetchNetwork = async () => {
    try {
      const res = await fetch("/api/network")
      const data = await res.json()
      setNetwork(data.network || "unknown")
    } catch {
      setNetwork("unknown")
    }
  }

  const fetchTokenInfo = async () => {
    if (!config.mintAddress) return
    
    setLoading(true)
    try {
      const res = await fetch(`/api/volume-bot?mintAddress=${config.mintAddress}`)
      const data = await res.json()
      
      if (data.error) {
        toast.error(data.error)
        setTokenInfo(null)
      } else {
        setTokenInfo(data)
        toast.success("token loaded")
      }
    } catch (error) {
      toast.error("failed to fetch token info")
    } finally {
      setLoading(false)
    }
  }

  const refreshWalletBalances = async () => {
    if (wallets.length === 0 || !config.mintAddress) {
      emitLog(
        "H1",
        "app/volume-bot/page.tsx:refreshWalletBalances",
        "skip refresh (missing wallets or mint)",
        { walletCount: wallets.length, mintAddress: config.mintAddress },
      )
      return
    }
    
    try {
      const res = await fetch("/api/volume-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh-balances",
          wallets,
          mintAddress: config.mintAddress,
        }),
      })
      
      const data = await res.json()
      if (data.wallets) {
        setWallets(data.wallets)
      }
    } catch (error) {
      console.error("failed to refresh balances:", error)
    }
  }

  const generateWallet = async () => {
    try {
      const res = await fetch("/api/volume-bot?action=generate-wallet")
      const data = await res.json()
      
      if (data.wallet) {
        setWallets([...wallets, data.wallet])
        toast.success("wallet generated")
      }
    } catch (error) {
      toast.error("failed to generate wallet")
    }
  }

  const importWallet = async () => {
    if (!importKey.trim()) {
      toast.error("enter private key")
      return
    }

    try {
      const res = await fetch("/api/volume-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import-wallet",
          secretKey: importKey.trim(),
        }),
      })

      const data = await res.json()
      
      if (data.error) {
        toast.error(data.error)
      } else if (data.wallet) {
        // check if already exists
        if (wallets.some(w => w.publicKey === data.wallet.publicKey)) {
          toast.error("wallet already exists")
          return
        }
        setWallets([...wallets, data.wallet])
        setImportKey("")
        toast.success("wallet imported")
      }
    } catch (error) {
      toast.error("failed to import wallet")
    }
  }

  const removeWallet = (publicKey: string) => {
    setWallets(wallets.filter(w => w.publicKey !== publicKey))
  }

  const toggleWallet = (publicKey: string) => {
    setWallets(wallets.map(w => 
      w.publicKey === publicKey ? { ...w, isActive: !w.isActive } : w
    ))
  }

  const executeTrade = async (wallet: VolumeWallet, type: "buy" | "sell") => {
    if (!config.mintAddress) return null
    
    // calculate amount
    let amount: number
    if (config.amountMode === "fixed") {
      amount = parseSafe(config.fixedAmount)
    } else if (config.amountMode === "random") {
      const min = parseSafe(config.minAmount)
      const max = parseSafe(config.maxAmount)
      amount = Math.random() * (max - min) + min
    } else {
      const pct = Math.random() * (parseSafe(config.maxPercentage) - parseSafe(config.minPercentage)) + parseSafe(config.minPercentage)
      if (type === "buy") {
        amount = (wallet.solBalance - 0.01) * (pct / 100)
      } else {
        amount = wallet.tokenBalance * (pct / 100)
      }
    }
    
    if (amount <= 0) return null
    
    try {
      const res = await fetch("/api/volume-bot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet,
          mintAddress: config.mintAddress,
          type,
          amount: amount.toFixed(6),
          slippage: clampNumber(parseSafe(config.slippage), 0, 99),
          priorityFee: Math.max(0, parseSafe(config.priorityFee)),
        }),
      })

      const data = await res.json()
      return data.transaction as VolumeTransaction
    } catch (error) {
      return {
        wallet: wallet.publicKey,
        type,
        amount,
        tokensOrSol: 0,
        status: "failed" as const,
        error: "request failed",
        timestamp: Date.now(),
      }
    }
  }

  const runBotCycle = useCallback(async () => {
    emitLog(
      "H1",
      "app/volume-bot/page.tsx:runBotCycle",
      "cycle start",
      {
        mintAddress,
        mode,
        amountMode,
        activeWallets: wallets.filter(w => w.isActive && w.solBalance > 0.01).length,
        executionCount: executionCountRef.current,
        maxExecutions: config.maxExecutions,
        multiThreaded: config.multiThreaded,
      },
    )
    const activeWallets = wallets.filter(w => w.isActive && w.solBalance > 0.01)
    if (activeWallets.length === 0) return
    if (tokenInfo?.isMigrated) {
      toast.error("token migrated - stop bot")
      stopBot()
      return
    }
    
    // check max executions
    const maxExec = parseInt(config.maxExecutions)
    if (maxExec > 0 && executionCountRef.current >= maxExec) {
      stopBot()
      toast.success("max executions reached")
      return
    }
    
    // refresh balances first
    await refreshWalletBalances()
    
    // determine actions for each wallet
    const tradePromises = activeWallets.map(async (wallet) => {
      let tradeType: "buy" | "sell"
      
      if (mode === "buy") {
        tradeType = "buy"
      } else if (mode === "sell") {
        tradeType = "sell"
      } else {
        // wash trading - чередуем buy/sell как в engine
        const lastAction = lastActionsRef.current.get(wallet.publicKey)
        
        // если нет токенов, нужно купить
        if (wallet.tokenBalance < 1) {
          tradeType = "buy"
        } 
        // если мало SOL, нужно продать
        else if (wallet.solBalance < 0.01) {
          tradeType = "sell"
        }
        // чередуем: если последний был buy, делаем sell и наоборот
        else if (lastAction === "buy") {
          tradeType = "sell"
        } else if (lastAction === "sell") {
          tradeType = "buy"
        }
        // если нет истории, случайный выбор (50/50)
        else {
          tradeType = Math.random() > 0.5 ? "buy" : "sell"
        }
      }
      
      // сохраняем последнее действие перед выполнением
      lastActionsRef.current.set(wallet.publicKey, tradeType)
      
      return executeTrade(wallet, tradeType)
    })
    
    // execute
    let results: (VolumeTransaction | null)[]
    if (multiThreaded) {
      results = await Promise.all(tradePromises)
    } else {
      results = []
      for (const promise of tradePromises) {
        results.push(await promise)
        await new Promise(r => setTimeout(r, 500))
      }
    }
    
    // update stats and transactions
    const validResults = results.filter(r => r !== null) as VolumeTransaction[]
    
    // обновляем lastAction только для успешных транзакций
    validResults.forEach(result => {
      if (result.status === "success") {
        lastActionsRef.current.set(result.wallet, result.type)
      }
    })
    
    setTransactions(prev => [...validResults, ...prev].slice(0, 100))
    
    const buys = validResults.filter(r => r.type === "buy" && r.status === "success").length
    const sells = validResults.filter(r => r.type === "sell" && r.status === "success").length
    const volume = validResults
      .filter(r => r.status === "success")
      .reduce((sum, r) => sum + (r.type === "buy" ? r.amount : r.tokensOrSol), 0)
    
    setStats(prev => ({
      totalBuys: prev.totalBuys + buys,
      totalSells: prev.totalSells + sells,
      totalVolume: prev.totalVolume + volume,
      executionCount: prev.executionCount + 1,
    }))
    
    executionCountRef.current++
    
    // refresh balances after trades
    await refreshWalletBalances()
  }, [wallets, mintAddress, mode, amountMode, fixedAmount, minAmount, maxAmount, minPercentage, maxPercentage, slippage, priorityFee, maxExecutions, multiThreaded])

  const startBot = () => {
    emitLog(
      "H2",
      "app/volume-bot/page.tsx:startBot",
      "start requested",
      {
        mintAddress,
        walletCount: wallets.length,
        activeWallets: wallets.filter(w => w.isActive).length,
        isRunning,
        mode,
        amountMode,
      },
    )
    if (!mintAddress) {
      toast.error("enter token address first")
      return
    }
    if (tokenInfo?.isMigrated) {
      toast.error("token migrated - cannot start bot")
      return
    }
    
    const activeWallets = wallets.filter(w => w.isActive)
    if (activeWallets.length === 0) {
      toast.error("no active wallets")
      return
    }
    
    setIsRunning(true)
    runningRef.current = true
    executionCountRef.current = 0
    
    const scheduleNext = async () => {
      if (!runningRef.current) return
      await runBotCycle()
      const minMs = Math.max(1, parseFloat(minInterval) * 1000)
      const maxMs = Math.max(minMs, parseFloat(maxInterval) * 1000)
      const delay = Math.random() * (maxMs - minMs) + minMs
      botIntervalRef.current = setTimeout(scheduleNext, delay)
    }

    scheduleNext()
    
    toast.success("volume bot started")
    }

  const stopBot = () => {
    if (botIntervalRef.current) {
      clearTimeout(botIntervalRef.current)
      botIntervalRef.current = null
    }
    setIsRunning(false)
    runningRef.current = false
    // очищаем историю действий при остановке
    lastActionsRef.current.clear()
    toast.success("volume bot stopped")
  }

  const isMainnet = network === "mainnet-beta"
  const totalSolBalance = wallets.reduce((sum, w) => sum + w.solBalance, 0)
  const totalTokenBalance = wallets.reduce((sum, w) => sum + w.tokenBalance, 0)

  return (
    <div className="p-6 space-y-6">
      {/* header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-wider">VOLUME BOT</h1>
          <p className="text-sm text-neutral-400">automated volume generation for pump.fun tokens</p>
        </div>
        <div className="flex gap-2">
          {isRunning ? (
            <Button onClick={stopBot} className="bg-red-500 hover:bg-red-600 text-white">
              <Pause className="w-4 h-4 mr-2" />
              stop bot
            </Button>
          ) : (
          <Button
              onClick={startBot} 
              disabled={!isMainnet || wallets.length === 0 || !mintAddress}
              className="bg-green-500 hover:bg-green-600 text-black disabled:opacity-50"
            >
              <Play className="w-4 h-4 mr-2" />
              start bot
          </Button>
          )}
        </div>
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="bg-neutral-900 border-neutral-700">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-neutral-400">STATUS</p>
                <p className={`text-lg font-bold ${isRunning ? "text-green-400" : "text-red-400"}`}>
                  {isRunning ? "RUNNING" : "STOPPED"}
                </p>
              </div>
              <div className={`w-3 h-3 rounded-full ${isRunning ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-neutral-900 border-neutral-700">
          <CardContent className="p-4">
            <p className="text-xs text-neutral-400">TOTAL VOLUME</p>
            <p className="text-lg font-bold text-white font-mono">{stats.totalVolume.toFixed(4)} SOL</p>
          </CardContent>
        </Card>

        <Card className="bg-neutral-900 border-neutral-700">
          <CardContent className="p-4">
            <p className="text-xs text-neutral-400">BUYS / SELLS</p>
            <p className="text-lg font-bold text-white font-mono">
              <span className="text-green-400">{stats.totalBuys}</span>
              {" / "}
              <span className="text-red-400">{stats.totalSells}</span>
            </p>
          </CardContent>
        </Card>

        <Card className="bg-neutral-900 border-neutral-700">
          <CardContent className="p-4">
            <p className="text-xs text-neutral-400">CYCLES</p>
            <p className="text-lg font-bold text-white font-mono">{stats.executionCount}</p>
          </CardContent>
        </Card>

        <Card className="bg-neutral-900 border-neutral-700">
          <CardContent className="p-4">
            <p className="text-xs text-neutral-400">WALLETS SOL</p>
            <p className="text-lg font-bold text-white font-mono">{totalSolBalance.toFixed(4)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* config */}
        <Card className="bg-neutral-900 border-neutral-700">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-neutral-300 tracking-wider flex items-center gap-2">
              <Settings className="w-4 h-4" />
              CONFIGURATION
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* token address */}
            <div className="space-y-2">
              <Label className="text-neutral-400">Token Address</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="mint address..."
                  className="bg-neutral-800 border-neutral-700 text-white flex-1"
                  value={mintAddress}
                  onChange={(e) => setMintAddress(e.target.value)}
                />
                <Button 
                  size="sm" 
                  onClick={fetchTokenInfo}
                  disabled={loading || !mintAddress}
                  className="bg-cyan-500 hover:bg-cyan-600 text-black"
                      >
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : "load"}
                </Button>
                    </div>
              {tokenInfo && (
                <div className="p-2 bg-neutral-800 rounded text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-neutral-500">price:</span>
                    <span className="text-white font-mono">${tokenInfo.price.toFixed(10)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-500">status:</span>
                    <span className={tokenInfo.isMigrated ? "text-blue-400" : "text-green-400"}>
                      {tokenInfo.isMigrated ? "migrated" : "bonding curve"}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* mode */}
            <div className="space-y-2">
              <Label className="text-neutral-400">Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as any)}>
                <SelectTrigger className="bg-neutral-800 border-neutral-700 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wash">Wash Trading (buy + sell)</SelectItem>
                  <SelectItem value="buy">Buy Only</SelectItem>
                  <SelectItem value="sell">Sell Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* amount mode */}
            <div className="space-y-2">
              <Label className="text-neutral-400">Amount Mode</Label>
              <Select value={amountMode} onValueChange={(v) => setAmountMode(v as any)}>
                <SelectTrigger className="bg-neutral-800 border-neutral-700 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed Amount</SelectItem>
                  <SelectItem value="random">Random Range</SelectItem>
                  <SelectItem value="percentage">Percentage of Balance</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* amount inputs */}
            {amountMode === "fixed" && (
              <div className="space-y-2">
                <Label className="text-neutral-400">Amount (SOL)</Label>
                <Input
                  type="number"
                  step="0.001"
                  className="bg-neutral-800 border-neutral-700 text-white"
                  value={fixedAmount}
                  onChange={(e) => setFixedAmount(e.target.value)}
                />
              </div>
            )}

            {amountMode === "random" && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Min SOL</Label>
                  <Input
                    type="number"
                    step="0.001"
                  className="bg-neutral-800 border-neutral-700 text-white"
                  value={minAmount}
                  onChange={(e) => setMinAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Max SOL</Label>
                  <Input
                    type="number"
                    step="0.001"
                    className="bg-neutral-800 border-neutral-700 text-white"
                    value={maxAmount}
                    onChange={(e) => setMaxAmount(e.target.value)}
                  />
                </div>
              </div>
            )}

            {amountMode === "percentage" && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Min %</Label>
                  <Input
                    type="number"
                    className="bg-neutral-800 border-neutral-700 text-white"
                    value={minPercentage}
                    onChange={(e) => setMinPercentage(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Max %</Label>
                  <Input
                    type="number"
                    className="bg-neutral-800 border-neutral-700 text-white"
                    value={maxPercentage}
                    onChange={(e) => setMaxPercentage(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* interval */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label className="text-neutral-400 text-xs">Min Interval (s)</Label>
                <Input
                  type="number"
                  className="bg-neutral-800 border-neutral-700 text-white"
                  value={minInterval}
                  onChange={(e) => setMinInterval(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-neutral-400 text-xs">Max Interval (s)</Label>
                <Input
                  type="number"
                  className="bg-neutral-800 border-neutral-700 text-white"
                  value={maxInterval}
                  onChange={(e) => setMaxInterval(e.target.value)}
                />
              </div>
            </div>

            {/* slippage & priority */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label className="text-neutral-400 text-xs">Slippage %</Label>
                <Input
                  type="number"
                  className="bg-neutral-800 border-neutral-700 text-white"
                  value={slippage}
                  onChange={(e) => setSlippage(e.target.value)}
                />
              </div>
            <div className="space-y-2">
                <Label className="text-neutral-400 text-xs">Priority Fee</Label>
              <Input
                type="number"
                  step="0.0001"
                className="bg-neutral-800 border-neutral-700 text-white"
                  value={priorityFee}
                  onChange={(e) => setPriorityFee(e.target.value)}
              />
              </div>
            </div>

            {/* max executions */}
            <div className="space-y-2">
              <Label className="text-neutral-400">Max Executions (0 = unlimited)</Label>
              <Input
                type="number"
                className="bg-neutral-800 border-neutral-700 text-white"
                value={maxExecutions}
                onChange={(e) => setMaxExecutions(e.target.value)}
              />
            </div>

            {/* multi-threaded */}
            <div className="flex items-center justify-between p-3 bg-neutral-800 rounded">
              <span className="text-sm text-neutral-400">Multi-threaded</span>
              <Switch checked={multiThreaded} onCheckedChange={setMultiThreaded} />
            </div>
          </CardContent>
        </Card>

        {/* wallets */}
        <Card className="bg-neutral-900 border-neutral-700">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-neutral-300 tracking-wider flex items-center gap-2">
                <Wallet className="w-4 h-4" />
                WALLETS ({wallets.length})
              </CardTitle>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={refreshWalletBalances}>
                  <RefreshCw className="w-4 h-4" />
                </Button>
                <Button size="sm" onClick={generateWallet} className="bg-cyan-500 hover:bg-cyan-600 text-black">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* import */}
            <div className="flex gap-2">
              <Input
                placeholder="paste private key..."
                className="bg-neutral-800 border-neutral-700 text-white text-xs flex-1"
                value={importKey}
                onChange={(e) => setImportKey(e.target.value)}
                type="password"
              />
              <Button size="sm" onClick={importWallet} variant="outline" className="border-neutral-700">
                <Download className="w-4 h-4" />
              </Button>
            </div>

            {/* wallet list */}
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {wallets.length === 0 ? (
                <div className="text-neutral-500 text-sm p-3 text-center">
                  no wallets. generate or import one.
                </div>
              ) : (
                wallets.map((wallet, i) => (
                  <div 
                    key={wallet.publicKey}
                    className={`p-3 rounded border ${wallet.isActive ? "bg-neutral-800 border-cyan-500/30" : "bg-neutral-900 border-neutral-700"}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Switch 
                          checked={wallet.isActive} 
                          onCheckedChange={() => toggleWallet(wallet.publicKey)}
                        />
                        <span className="text-white font-mono text-xs">
                          #{i + 1} {wallet.publicKey.slice(0, 6)}...{wallet.publicKey.slice(-4)}
                        </span>
                      </div>
                      <div className="flex gap-1">
                        <Button 
                          size="sm" 
                          variant="ghost"
                          onClick={() => {
                            navigator.clipboard.writeText(wallet.publicKey)
                            toast.success("copied")
                          }}
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
            <Button
                          size="sm" 
                          variant="ghost"
                          onClick={() => removeWallet(wallet.publicKey)}
                          className="text-red-400 hover:text-red-300"
            >
                          <Trash2 className="w-3 h-3" />
            </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-neutral-500">SOL:</span>
                        <span className="text-white font-mono ml-1">{wallet.solBalance.toFixed(4)}</span>
                      </div>
                      <div>
                        <span className="text-neutral-500">Tokens:</span>
                        <span className="text-white font-mono ml-1">{wallet.tokenBalance.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* totals */}
            {wallets.length > 0 && (
              <div className="pt-3 border-t border-neutral-700">
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-400">Total SOL:</span>
                  <span className="text-white font-mono">{totalSolBalance.toFixed(4)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-400">Total Tokens:</span>
                  <span className="text-white font-mono">{totalTokenBalance.toFixed(2)}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* transactions log */}
      <Card className="bg-neutral-900 border-neutral-700">
        <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-neutral-300 tracking-wider flex items-center gap-2">
              <Activity className="w-4 h-4" />
              TRANSACTION LOG
            </CardTitle>
        </CardHeader>
        <CardContent>
            <div className="space-y-2 max-h-[500px] overflow-y-auto">
              {transactions.length === 0 ? (
                <div className="text-neutral-500 text-sm p-3 text-center">
                  no transactions yet
                </div>
              ) : (
                transactions.map((tx, i) => (
                  <div 
                    key={i}
                    className={`p-2 rounded text-xs border ${
                      tx.status === "success" 
                        ? "bg-neutral-800 border-neutral-700" 
                        : tx.status === "failed"
                        ? "bg-red-950/30 border-red-500/30"
                        : "bg-yellow-950/30 border-yellow-500/30"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <Badge className={tx.type === "buy" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}>
                          {tx.type.toUpperCase()}
                        </Badge>
                        <span className="text-neutral-400">
                          {new Date(tx.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <Badge className={
                        tx.status === "success" ? "bg-green-500/20 text-green-400" :
                        tx.status === "failed" ? "bg-red-500/20 text-red-400" :
                        "bg-yellow-500/20 text-yellow-400"
                      }>
                        {tx.status}
                  </Badge>
                </div>
                    <div className="flex justify-between text-neutral-400">
                      <span>{tx.wallet.slice(0, 8)}...</span>
                      <span className="text-white font-mono">
                        {tx.type === "buy" ? `${tx.amount.toFixed(4)} SOL` : `${tx.amount.toFixed(2)} tokens`}
                      </span>
                    </div>
                    {tx.signature && (
                      <div className="mt-1">
                        <a 
                          href={`https://solscan.io/tx/${tx.signature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-cyan-400 hover:underline"
                        >
                          {tx.signature.slice(0, 12)}...
                        </a>
                </div>
                    )}
                    {tx.error && (
                      <div className="mt-1 text-red-400">{tx.error}</div>
                    )}
              </div>
                ))
              )}
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  )
}
