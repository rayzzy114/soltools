"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "sonner"
import {
  Play,
  Pause,
  Settings,
  Zap,
  Wallet,
  RefreshCw,
  AlertTriangle,
  Activity,
} from "lucide-react"
import { parseSafe } from "@/lib/ui-utils"

interface VolumeWallet {
  publicKey: string
  secretKey: string
  solBalance: number
  tokenBalance: number
  isActive: boolean
  label?: string
  role?: string
}

interface BundlerWallet extends VolumeWallet {
  label?: string
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

interface RugpullEstimate {
  grossSol: number
  gasFee: number
  jitoTip: number
  netSol: number
  walletCount: number
  availableSol?: number
  isMigrated?: boolean
  priorityFee?: number
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [launchedTokens, setLaunchedTokens] = useState<Array<{ id: string; mintAddress: string; name: string; symbol: string }>>([])
  const [bundlerWallets, setBundlerWallets] = useState<BundlerWallet[]>([])
  const [bundlerStats, setBundlerStats] = useState({ successRate: "0", gasSaved: "0" })
  const [rugpullEstimate, setRugpullEstimate] = useState<RugpullEstimate | null>(null)
  const [rugpullLoading, setRugpullLoading] = useState(false)
  const holderRows = useMemo(
    () =>
      [...bundlerWallets]
        .filter((w) => (w.tokenBalance ?? 0) > 0)
        .sort((a, b) => (b.tokenBalance ?? 0) - (a.tokenBalance ?? 0))
        .slice(0, 12),
    [bundlerWallets]
  )
  
  type SpeedPreset = "custom" | "slow" | "organic" | "furious"

  const SPEED_PRESETS: Record<Exclude<SpeedPreset, "custom">, { label: string; minInterval: string; maxInterval: string }> = {
    furious: { label: "Бешеный", minInterval: "1", maxInterval: "4" },
    organic: { label: "Organic", minInterval: "5", maxInterval: "15" },
    slow: { label: "Медленный", minInterval: "20", maxInterval: "45" },
  }

  const DEFAULT_SPEED_PRESET: SpeedPreset = "organic"

  // config
  const defaultConfig = {
    mintAddress: "",
    mode: "wash" as "buy" | "sell" | "wash",
    amountMode: "random" as "fixed" | "random" | "percentage",
    fixedAmount: "0.01",
    minAmount: "0.005",
    maxAmount: "0.02",
    minPercentage: "5",
    maxPercentage: "20",
    minInterval: SPEED_PRESETS[DEFAULT_SPEED_PRESET].minInterval,
    maxInterval: SPEED_PRESETS[DEFAULT_SPEED_PRESET].maxInterval,
    slippage: "10",
    priorityFee: "0.0005",
    maxExecutions: "0",
    multiThreaded: false,
    jitoTip: "0.0005",
    jitoRegion: "frankfurt",
    autoFees: true,
    autoBundler: true,
  }
  const [config, setConfig] = useState(defaultConfig)
  const [speedPreset, setSpeedPreset] = useState<SpeedPreset>(DEFAULT_SPEED_PRESET)
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
    jitoTip,
    jitoRegion,
    autoFees,
    autoBundler,
  } = config

  const devBundlerWallet = useMemo(
    () => bundlerWallets.find((wallet) => wallet.role === "dev"),
    [bundlerWallets],
  )

  const displayWallets = useMemo(() => {
    if (!devBundlerWallet) return wallets

    const existsInVolumeList = wallets.some((wallet) => wallet.publicKey === devBundlerWallet.publicKey)
    if (existsInVolumeList) {
      return wallets.map((wallet) =>
        wallet.publicKey === devBundlerWallet.publicKey
          ? { ...wallet, ...devBundlerWallet }
          : wallet,
      )
    }

    return [...wallets, { ...devBundlerWallet }]
  }, [devBundlerWallet, wallets])

  const volumeWallets = useMemo(() => wallets.filter((wallet) => wallet.role !== "dev"), [wallets])
  const activeBundlerWalletsMemo = useMemo(
    () => bundlerWallets.filter((wallet) => wallet.isActive && wallet.role !== "dev"),
    [bundlerWallets],
  )
  const presetIntervalHint = useMemo(() => {
    if (speedPreset !== "custom") {
      const preset = SPEED_PRESETS[speedPreset as Exclude<SpeedPreset, "custom">]
      if (preset) return `${preset.minInterval}-${preset.maxInterval}s`
    }

    if (minInterval && maxInterval) {
      return `${minInterval}-${maxInterval}s`
    }

    return undefined
  }, [maxInterval, minInterval, speedPreset])

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
  const setJitoTip = (value: string) => setConfig((prev) => ({ ...prev, jitoTip: value }))
  const setJitoRegion = (value: string) => setConfig((prev) => ({ ...prev, jitoRegion: value }))
  const setAutoFees = (value: boolean) => setConfig((prev) => ({ ...prev, autoFees: value }))
  const setAutoBundler = (value: boolean) => setConfig((prev) => ({ ...prev, autoBundler: value }))
  const setMaxExecutions = (value: string) => setConfig((prev) => ({ ...prev, maxExecutions: value }))
  const handleSpeedPresetChange = (value: SpeedPreset) => {
    if (value === "custom") {
      setSpeedPreset("custom")
      return
    }

    const preset = SPEED_PRESETS[value]
    if (!preset) return

    setSpeedPreset(value)
    setConfig((prev) => ({
      ...prev,
      minInterval: preset.minInterval,
      maxInterval: preset.maxInterval,
    }))
  }
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
    const mintAddress = (config.mintAddress || "").trim()
    if (!mintAddress) return
    fetch("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mintAddress,
        message,
        type: "info",
        metadata: {
          source: "volume-bot-page",
          runId,
          hypothesisId,
          location,
          data,
          timestamp: Date.now(),
        },
      }),
    }).catch(() => {})
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
    loadLaunchedTokens()
    loadBundlerWallets()
    loadBundlerStats()
    return () => {
      if (botIntervalRef.current) {
        clearTimeout(botIntervalRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const match = Object.entries(SPEED_PRESETS).find(
      ([, preset]) => preset.minInterval === minInterval && preset.maxInterval === maxInterval,
    )
    const nextPreset = (match?.[0] as SpeedPreset | undefined) ?? "custom"
    setSpeedPreset((prev) => (prev === nextPreset ? prev : nextPreset))
  }, [maxInterval, minInterval])

  const fetchNetwork = async () => {
    try {
      const res = await fetch("/api/network")
      const data = await res.json()
      setNetwork(data.network || "unknown")
    } catch {
      setNetwork("unknown")
    }
  }

  const loadLaunchedTokens = async () => {
    try {
      const res = await fetch("/api/tokens")
      const data = await res.json()
      if (Array.isArray(data) && data.length > 0) {
        setLaunchedTokens(
          data.map((t: any) => ({
            id: t.id,
            mintAddress: t.mintAddress,
            name: t.name,
            symbol: t.symbol,
          }))
        )
      }
    } catch {
      // ignore
    }
  }

  const loadBundlerWallets = async (overrideMint?: string) => {
    try {
      const mint = (overrideMint ?? config.mintAddress ?? "").trim()
      const url = mint
        ? `/api/bundler/wallets?action=load-all&mintAddress=${encodeURIComponent(mint)}`
        : "/api/bundler/wallets?action=load-all"
      const res = await fetch(url)
      const data = await res.json()
      if (data.wallets) {
        setBundlerWallets(data.wallets)
      }
    } catch {
      // ignore
    }
  }

  const loadBundlerStats = async () => {
    try {
      const res = await fetch("/api/stats?type=bundler")
      const data = await res.json()
      if (!data?.error) {
        setBundlerStats({
          successRate: String(data.successRate ?? "0"),
          gasSaved: String(data.gasSaved ?? "0"),
        })
      }
    } catch {
      // ignore
    }
  }

  const refreshBundlerWallets = async (overrideMint?: string) => {
    try {
      const mint = (overrideMint ?? config.mintAddress ?? "").trim()
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh",
          wallets: bundlerWallets,
          ...(mint ? { mintAddress: mint } : {}),
        }),
      })
      const data = await res.json()
      if (data.wallets) setBundlerWallets(data.wallets)
    } catch {
      // ignore
    }
  }

  const fetchTokenInfo = async (overrideMint?: string) => {
    const mint = (overrideMint ?? config.mintAddress ?? "").trim()
    if (!mint) return
    
    setLoading(true)
    try {
      const res = await fetch(`/api/volume-bot?mintAddress=${encodeURIComponent(mint)}`)
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

  const fetchRugpullEstimate = async (overrideMint?: string) => {
    const mint = (overrideMint ?? config.mintAddress ?? "").trim()
    if (!mint) {
      setRugpullEstimate(null)
      return
    }
    setRugpullLoading(true)
    try {
      const params = new URLSearchParams({ mintAddress: mint })
      const tip = parseSafe(config.jitoTip)
      const fee = parseSafe(config.priorityFee)
      if (Number.isFinite(tip)) params.set("jitoTip", String(Math.max(0, tip)))
      if (Number.isFinite(fee)) params.set("priorityFee", String(Math.max(0, fee)))
      const activeBundlerWalletPublicKeys = activeBundlerWalletsMemo.map((w) => w.publicKey)
      if (activeBundlerWalletPublicKeys.length > 0) {
        params.set("walletAddresses", activeBundlerWalletPublicKeys.join(","))
      }
      const res = await fetch(`/api/bundler/rugpull/estimate?${params.toString()}`)
      const data = await res.json()
      if (!res.ok || data?.error) {
        setRugpullEstimate(null)
        return
      }
      if (data?.estimatedProfit) {
        setRugpullEstimate(data.estimatedProfit)
      }
    } catch {
      setRugpullEstimate(null)
    } finally {
      setRugpullLoading(false)
    }
  }

  useEffect(() => {
    void loadBundlerWallets(config.mintAddress)
  }, [config.mintAddress])

  useEffect(() => {
    void fetchRugpullEstimate()
  }, [config.mintAddress, bundlerWallets, config.priorityFee, config.jitoTip])

  const refreshWalletBalances = async () => {
    if (volumeWallets.length === 0 || !config.mintAddress) {
      emitLog(
        "H1",
        "app/volume-bot/page.tsx:refreshWalletBalances",
        "skip refresh (missing wallets or mint)",
        { walletCount: volumeWallets.length, mintAddress: config.mintAddress },
      )
      return
    }
    
    try {
      const res = await fetch("/api/volume-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh-balances",
          wallets: volumeWallets,
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

  const getTradeAmountForWallet = (wallet: VolumeWallet, type: "buy" | "sell") => {
    if (config.amountMode === "fixed") {
      return parseSafe(config.fixedAmount)
    }
    if (config.amountMode === "random") {
      const min = parseSafe(config.minAmount)
      const max = parseSafe(config.maxAmount)
      return Math.random() * (max - min) + min
    }
    const pct = Math.random() * (parseSafe(config.maxPercentage) - parseSafe(config.minPercentage)) + parseSafe(config.minPercentage)
    if (type === "buy") {
      return (wallet.solBalance - 0.01) * (pct / 100)
    }
    return wallet.tokenBalance * (pct / 100)
  }

  const executeTrade = async (wallet: VolumeWallet, type: "buy" | "sell") => {
    if (!config.mintAddress) return null
    
    // calculate amount
    const amount = getTradeAmountForWallet(wallet, type)
    
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
          jitoTip: Math.max(0, parseSafe(config.jitoTip)),
          jitoRegion: config.jitoRegion || "frankfurt",
          autoFees: config.autoFees ?? true,
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

  const resolveBundledAction = (activeWallets: VolumeWallet[]) => {
    if (mode === "buy") return "buy"
    if (mode === "sell") return "sell"
    const hasTokens = activeWallets.some((w) => (w.tokenBalance ?? 0) > 0)
    const hasSol = activeWallets.some((w) => (w.solBalance ?? 0) > 0.001)
    if (!hasTokens) return "buy"
    if (!hasSol) return "sell"
    return executionCountRef.current % 2 === 0 ? "buy" : "sell"
  }

  const runBundledCycle = async () => {
    const mint = (config.mintAddress || "").trim()
    if (!mint) return
    const activeWallets = activeBundlerWalletsMemo
    if (!activeWallets.length) return

    const action = resolveBundledAction(activeWallets)
    const tip = Math.max(0, parseSafe(config.jitoTip))
    const fee = Math.max(0, parseSafe(config.priorityFee))
    const slippageValue = clampNumber(parseSafe(config.slippage), 0, 99)
    const region = config.jitoRegion || "frankfurt"

    if (action === "sell") {
      const sellWallets = activeWallets.filter((w) => (w.tokenBalance ?? 0) > 0)
      if (!sellWallets.length) return
      const sellPercentages = sellWallets.map((w) => {
        const amount = Math.max(0, getTradeAmountForWallet(w, "sell"))
        if (!w.tokenBalance) return 0
        const pct = (amount / w.tokenBalance) * 100
        return clampNumber(pct, 0, 100)
      })
      await fetch("/api/bundler/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: sellWallets,
          mintAddress: mint,
          sellPercentages,
          jitoTip: tip,
          priorityFee: fee,
          slippage: slippageValue,
          jitoRegion: region,
        }),
      })
    } else {
      const buyWallets = activeWallets.filter((w) => (w.solBalance ?? 0) > 0.001)
      if (!buyWallets.length) return
      const buyAmounts = buyWallets.map((w) => Math.max(0, getTradeAmountForWallet(w, "buy")))
      await fetch("/api/bundler/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: buyWallets,
          mintAddress: mint,
          buyAmounts,
          jitoTip: tip,
          priorityFee: fee,
          slippage: slippageValue,
          jitoRegion: region,
        }),
      })
    }

    await refreshWalletBalances()
    await refreshBundlerWallets(mint)
  }

  const runBotCycle = useCallback(async () => {
    const activeVolumeWallets = volumeWallets.filter((w) => w.isActive && w.solBalance > 0.01)
    const activeBundlerWalletsForRun = activeBundlerWalletsMemo
    emitLog(
      "H1",
      "app/volume-bot/page.tsx:runBotCycle",
      "cycle start",
      {
        mintAddress,
        mode,
        amountMode,
        activeWallets: activeVolumeWallets.length,
        activeBundlerWallets: activeBundlerWalletsForRun.length,
        executionCount: executionCountRef.current,
        maxExecutions: config.maxExecutions,
        multiThreaded: config.multiThreaded,
      },
    )
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

    if (autoBundler) {
      if (activeBundlerWalletsForRun.length === 0) return
      await runBundledCycle()
      setStats((prev) => ({
        executionCount: prev.executionCount + 1,
        totalBuys: prev.totalBuys,
        totalSells: prev.totalSells,
        totalVolume: prev.totalVolume,
      }))
      executionCountRef.current++
      return
    }

    if (activeVolumeWallets.length === 0) return
    
    // refresh balances first
    await refreshWalletBalances()
    
    // determine actions for each wallet
    const tradePromises = activeVolumeWallets.map(async (wallet) => {
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
  }, [volumeWallets, mintAddress, mode, amountMode, fixedAmount, minAmount, maxAmount, minPercentage, maxPercentage, slippage, priorityFee, maxExecutions, multiThreaded, autoBundler, bundlerWallets, jitoTip, jitoRegion, autoFees])

  const startBot = () => {
    emitLog(
      "H2",
      "app/volume-bot/page.tsx:startBot",
      "start requested",
      {
        mintAddress,
        walletCount: volumeWallets.length,
        activeWallets: volumeWallets.filter(w => w.isActive).length,
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
    
    const activeWallets = volumeWallets.filter(w => w.isActive)
    const activeBundlerWallets = activeBundlerWalletsMemo
    if (autoBundler) {
      if (activeBundlerWallets.length === 0) {
        toast.error("no active bundler wallets")
        return
      }
    } else if (activeWallets.length === 0) {
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
  const totalSolBalance = displayWallets.reduce((sum, w) => sum + w.solBalance, 0)
  const totalTokenBalance = displayWallets.reduce((sum, w) => sum + w.tokenBalance, 0)
  const activeVolumeWalletCount = volumeWallets.filter((w) => w.isActive).length
  const activeBundlerWalletCount = activeBundlerWalletsMemo.length
  const canStart = Boolean(mintAddress) && isMainnet && (autoBundler ? activeBundlerWalletCount > 0 : activeVolumeWalletCount > 0)
  const selectedTokenId = launchedTokens.find((t) => t.mintAddress === mintAddress)?.id

  const handleWalletTrade = async (wallet: VolumeWallet, type: "buy" | "sell") => {
    if (!config.mintAddress) {
      toast.error("enter token address first")
      return
    }
    setLoading(true)
    try {
      const tx = await executeTrade(wallet, type)
      if (tx?.status === "failed") {
        toast.error(tx.error || "trade failed")
      } else if (tx?.status === "success") {
        toast.success(`${type} sent`)
      }
      if (tx) {
        setTransactions((prev) => [tx, ...prev].slice(0, 100))
      }
      await refreshWalletBalances()
      await refreshBundlerWallets(config.mintAddress)
    } catch (error: any) {
      toast.error(error?.message || "trade failed")
    } finally {
      setLoading(false)
    }
  }

  const handleTokenSelect = async (tokenId: string) => {
    const token = launchedTokens.find((t) => t.id === tokenId)
    if (!token) return
    setMintAddress(token.mintAddress)
    await fetchTokenInfo(token.mintAddress)
    await loadBundlerWallets(token.mintAddress)
    await fetchRugpullEstimate(token.mintAddress)
  }

  const executeEmergencyDump = async () => {
    const mint = (config.mintAddress || "").trim()
    if (!mint) {
      toast.error("enter token address first")
      return
    }
    const activeWallets = activeBundlerWalletsMemo.filter((w) => (w.tokenBalance ?? 0) > 0)
    if (!activeWallets.length) {
      toast.error("no active wallets with tokens")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/bundler/rugpull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: activeWallets,
          mintAddress: mint,
          jitoTip: Math.max(0, parseSafe(config.jitoTip)),
          priorityFee: Math.max(0, parseSafe(config.priorityFee)),
          slippage: clampNumber(parseSafe(config.slippage), 0, 99),
          jitoRegion: config.jitoRegion || "frankfurt",
        }),
      })
      const data = await res.json()
      if (data?.success) {
        toast.success(`rugpull bundle: ${data.bundleId}`)
      } else {
        toast.error(data?.error || "rugpull failed")
      }
      await refreshWalletBalances()
      await refreshBundlerWallets(mint)
      await fetchRugpullEstimate(mint)
    } catch (error: any) {
      toast.error(error?.message || "rugpull failed")
    } finally {
      setLoading(false)
    }
  }


  return (
    <TooltipProvider>
      <div className="h-screen w-full bg-background text-foreground">
        <div className="flex h-full flex-col gap-2 p-2">
          <div className="flex flex-col gap-2 border-b border-border pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-lg font-semibold tracking-wider">VOLUME BOT</h1>
                <Badge className="bg-muted text-muted-foreground border border-border">{network}</Badge>
                <span className="text-[11px] text-muted-foreground">Active tokens: {launchedTokens.length}</span>
                <span className="text-[11px] text-muted-foreground">Volume: {stats.totalVolume.toFixed(3)} SOL</span>
                <span className="text-[11px] text-muted-foreground">
                  Buys/Sells: {stats.totalBuys}/{stats.totalSells}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select value={selectedTokenId} onValueChange={handleTokenSelect}>
                  <SelectTrigger className="h-8 w-[220px] bg-background border-border text-xs">
                    <SelectValue placeholder="select token" />
                  </SelectTrigger>
                  <SelectContent>
                    {launchedTokens.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.symbol} - {t.mintAddress.slice(0, 6)}...{t.mintAddress.slice(-4)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span>Mint:</span>
              <span className="font-mono text-foreground">
                {mintAddress ? `${mintAddress.slice(0, 6)}...${mintAddress.slice(-4)}` : "not set"}
              </span>
              <span>Mode: {mode}</span>
              <span>
                Interval: {minInterval}-{maxInterval}s
              </span>
              <span>Auto bundler: {autoBundler ? "on" : "off"}</span>
            </div>
          </div>

          <div className="grid flex-1 min-h-0 grid-rows-[auto_1fr] gap-2">
            <div className="grid grid-cols-1 xl:grid-cols-[1.05fr_1.7fr_1.05fr] gap-2">
              <Card className="bg-card border-border">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="text-xs font-semibold tracking-widest flex items-center gap-2">
                    <Zap className="h-3 w-3" />
                    BUNDLER
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 space-y-2 text-[12px]">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Success</span>
                      <span className="font-mono">{bundlerStats.successRate}%</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Gas saved</span>
                      <span className="font-mono">{bundlerStats.gasSaved} SOL</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Active wallets</span>
                    <span className="font-mono">{activeBundlerWalletCount}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Auto bundler</span>
                    <Badge className={autoBundler ? "bg-green-500/20 text-green-400" : "bg-muted text-muted-foreground"}>
                      {autoBundler ? "ON" : "OFF"}
                    </Badge>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="text-xs font-semibold tracking-widest flex items-center gap-2">
                    <Activity className="h-3 w-3" />
                    VOLUME BOT
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[11px]">
                      <div className={`h-2 w-2 rounded-full ${isRunning ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
                      <span className="uppercase">{isRunning ? "running" : "stopped"}</span>
                      <Badge className="bg-muted text-muted-foreground border border-border">{isMainnet ? "mainnet" : "devnet"}</Badge>
                    </div>
                    {isRunning ? (
                      <Button
                        size="sm"
                        onClick={stopBot}
                        className="h-8 bg-red-500 hover:bg-red-600 text-white text-xs"
                      >
                        <Pause className="h-3 w-3" />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={startBot}
                        disabled={!canStart}
                        className="h-8 bg-green-500 hover:bg-green-600 text-black text-xs disabled:opacity-50"
                      >
                        <Play className="h-3 w-3" />
                        Start
                      </Button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] text-muted-foreground">
                    <div className="flex items-center justify-between">
                      <span>Wallets</span>
                      <span className="font-mono text-foreground">{displayWallets.length}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Total SOL</span>
                      <span className="font-mono text-foreground">{totalSolBalance.toFixed(3)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Total Token</span>
                      <span className="font-mono text-foreground">{totalTokenBalance.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Cycles</span>
                      <span className="font-mono text-foreground">{stats.executionCount}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6 gap-2 max-h-[240px] overflow-y-auto pr-1">
                    {displayWallets.length === 0 ? (
                      <div className="text-[11px] text-muted-foreground">no wallets yet</div>
                    ) : (
                      displayWallets.map((wallet) => {
                        const isDevWallet = wallet.role === "dev"
                        const canManualTrade = Boolean(mintAddress) && !loading && (isDevWallet || wallet.isActive)

                        return (
                          <div
                            key={wallet.publicKey}
                            className={`rounded border p-2 text-[11px] space-y-1 ${
                              wallet.isActive && !isDevWallet
                                ? "bg-muted border-border"
                                : "bg-background border-border/60 opacity-70"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-[10px]">{wallet.publicKey.slice(0, 6)}...</span>
                              <div className="flex items-center gap-1">
                                {isDevWallet && <Badge className="bg-amber-500/20 text-amber-400 text-[9px]">DEV</Badge>}
                                <Badge
                                  className={`text-[9px] ${
                                    isDevWallet
                                      ? "bg-muted text-muted-foreground cursor-not-allowed opacity-70"
                                      : wallet.isActive
                                        ? "bg-green-500/20 text-green-400 cursor-pointer"
                                        : "bg-muted text-muted-foreground cursor-pointer"
                                  }`}
                                  onClick={!isDevWallet ? () => toggleWallet(wallet.publicKey) : undefined}
                                >
                                  {isDevWallet ? "MANUAL" : wallet.isActive ? "ON" : "OFF"}
                                </Badge>
                              </div>
                          </div>
                          <div className="flex items-center justify-between text-muted-foreground">
                            <span>SOL</span>
                            <span className="font-mono text-foreground">{wallet.solBalance.toFixed(3)}</span>
                          </div>
                          <div className="flex items-center justify-between text-muted-foreground">
                            <span>TKN</span>
                            <span className="font-mono text-foreground">{wallet.tokenBalance.toFixed(2)}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => handleWalletTrade(wallet, "buy")}
                              disabled={!canManualTrade}
                            >
                              Buy
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => handleWalletTrade(wallet, "sell")}
                              disabled={!canManualTrade}
                            >
                              Sell
                            </Button>
                          </div>
                        )
                      })
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="text-xs font-semibold tracking-widest flex items-center gap-2">
                    <AlertTriangle className="h-3 w-3" />
                    RUGPULL
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 space-y-3 text-[12px]">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Estimated Profit (Net)</span>
                      <span className="font-mono">
                        {rugpullLoading
                          ? "..."
                          : rugpullEstimate
                          ? `${rugpullEstimate.netSol.toFixed(3)} SOL`
                          : "--"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Total SOL</span>
                      <span className="font-mono">
                        {rugpullLoading
                          ? "..."
                          : rugpullEstimate
                          ? `${rugpullEstimate.grossSol.toFixed(3)} SOL`
                          : "--"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Wallets</span>
                      <span className="font-mono">
                        {rugpullLoading ? "..." : rugpullEstimate ? rugpullEstimate.walletCount : 0}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]">
                          fees breakdown
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="text-[11px] space-y-1">
                        <div>Gas Fee: {rugpullEstimate ? rugpullEstimate.gasFee.toFixed(4) : "--"} SOL</div>
                        <div>Jito Tip: {rugpullEstimate ? rugpullEstimate.jitoTip.toFixed(4) : "--"} SOL</div>
                      </TooltipContent>
                    </Tooltip>
                    <Button
                      onClick={executeEmergencyDump}
                      className="h-8 bg-red-600 hover:bg-red-700 text-white text-xs"
                      disabled={!mintAddress || loading}
                    >
                      Emergency Dump
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid min-h-0 grid-cols-1 xl:grid-cols-3 gap-2">
              <Card className="bg-card border-border flex flex-col min-h-0">
                <CardHeader className="py-2 px-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-xs font-semibold tracking-widest flex items-center gap-2">
                      <Wallet className="h-3 w-3" />
                      WALLETS
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={generateWallet}>
                        New
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px]"
                        onClick={() => refreshWalletBalances()}
                      >
                        <RefreshCw className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 flex flex-col gap-2 min-h-0">
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="import private key..."
                      className="h-8 bg-background border-border text-xs"
                      value={importKey}
                      onChange={(e) => setImportKey(e.target.value)}
                    />
                    <Button size="sm" className="h-8 text-[11px]" onClick={importWallet}>
                      Import
                    </Button>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-2 text-[12px]">
                    {wallets.length === 0 ? (
                      <div className="text-muted-foreground">no wallets yet</div>
                    ) : (
                      wallets.map((wallet) => (
                        <div key={wallet.publicKey} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Badge
                              className={`text-[9px] ${
                                wallet.isActive ? "bg-green-500/20 text-green-400" : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {wallet.isActive ? "ON" : "OFF"}
                            </Badge>
                            <span className="font-mono text-[11px]">{wallet.publicKey.slice(0, 8)}...</span>
                          </div>
                          <span className="font-mono text-foreground">{wallet.solBalance.toFixed(3)} SOL</span>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border flex flex-col min-h-0">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="text-xs font-semibold tracking-widest">HOLDERS</CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 flex-1 min-h-0 overflow-y-auto space-y-2 text-[12px]">
                  {holderRows.length === 0 ? (
                    <div className="text-muted-foreground">no holders yet</div>
                  ) : (
                    holderRows.map((wallet) => (
                      <div key={wallet.publicKey} className="flex items-center justify-between">
                        <span className="font-mono text-[11px]">{wallet.publicKey.slice(0, 8)}...</span>
                        <span className="font-mono text-foreground">{wallet.tokenBalance.toFixed(2)}</span>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card border-border flex flex-col min-h-0">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="text-xs font-semibold tracking-widest">TRADES</CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 flex-1 min-h-0 overflow-y-auto space-y-2 text-[12px]">
                  {transactions.length === 0 ? (
                    <div className="text-muted-foreground">no transactions yet</div>
                  ) : (
                    transactions.slice(0, 16).map((tx, i) => (
                      <div key={`${tx.wallet}-${i}`} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge
                            className={`text-[9px] ${
                              tx.type === "buy" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                            }`}
                          >
                            {tx.type.toUpperCase()}
                          </Badge>
                          <span className="font-mono text-[11px]">{tx.wallet.slice(0, 6)}...</span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{new Date(tx.timestamp).toLocaleTimeString()}</span>
                          <span className="font-mono text-foreground">
                            {tx.type === "buy"
                              ? `${tx.amount.toFixed(3)} SOL`
                              : `${tx.amount.toFixed(3)} TOK`}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle className="text-sm">Volume Bot Settings</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Token Address</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="mint address..."
                      className="h-8 bg-background border-border text-xs"
                      value={mintAddress}
                      onChange={(e) => setMintAddress(e.target.value)}
                    />
                    <Button
                      size="sm"
                      onClick={() => fetchTokenInfo()}
                      disabled={loading || !mintAddress}
                      className="h-8 text-[11px]"
                    >
                      {loading ? <RefreshCw className="h-3 w-3 animate-spin" /> : "Load"}
                    </Button>
                  </div>
                  {launchedTokens.length > 0 && (
                    <Select value={selectedTokenId} onValueChange={handleTokenSelect}>
                      <SelectTrigger className="h-8 bg-background border-border text-xs">
                        <SelectValue placeholder="pick launched token" />
                      </SelectTrigger>
                      <SelectContent>
                        {launchedTokens.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.symbol} - {t.mintAddress.slice(0, 6)}...{t.mintAddress.slice(-4)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {tokenInfo && (
                    <div className="rounded bg-muted p-2 text-[11px] space-y-1">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">price</span>
                        <span className="font-mono text-foreground">${tokenInfo.price.toFixed(10)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">status</span>
                        <span className={tokenInfo.isMigrated ? "text-blue-400" : "text-green-400"}>
                          {tokenInfo.isMigrated ? "migrated" : "bonding curve"}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Mode</Label>
                  <Select value={mode} onValueChange={(v) => setMode(v as any)}>
                    <SelectTrigger className="h-8 bg-background border-border text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="wash">Wash Trading (buy + sell)</SelectItem>
                      <SelectItem value="buy">Buy Only</SelectItem>
                      <SelectItem value="sell">Sell Only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Amount Mode</Label>
                  <Select value={amountMode} onValueChange={(v) => setAmountMode(v as any)}>
                    <SelectTrigger className="h-8 bg-background border-border text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Fixed Amount</SelectItem>
                      <SelectItem value="random">Random Range</SelectItem>
                      <SelectItem value="percentage">Percentage of Balance</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {amountMode === "fixed" && (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Amount (SOL)</Label>
                    <Input
                      type="number"
                      step="0.001"
                      className="h-8 bg-background border-border text-xs"
                      value={fixedAmount}
                      onChange={(e) => setFixedAmount(e.target.value)}
                    />
                  </div>
                )}

                {amountMode === "random" && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Min SOL</Label>
                      <Input
                        type="number"
                        step="0.001"
                        className="h-8 bg-background border-border text-xs"
                        value={minAmount}
                        onChange={(e) => setMinAmount(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Max SOL</Label>
                      <Input
                        type="number"
                        step="0.001"
                        className="h-8 bg-background border-border text-xs"
                        value={maxAmount}
                        onChange={(e) => setMaxAmount(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {amountMode === "percentage" && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Min %</Label>
                      <Input
                        type="number"
                        className="h-8 bg-background border-border text-xs"
                        value={minPercentage}
                        onChange={(e) => setMinPercentage(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Max %</Label>
                      <Input
                        type="number"
                        className="h-8 bg-background border-border text-xs"
                        value={maxPercentage}
                        onChange={(e) => setMaxPercentage(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Speed preset</Label>
                  <Select value={speedPreset} onValueChange={(value) => handleSpeedPresetChange(value as SpeedPreset)}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SelectTrigger className="h-8 bg-background border-border text-xs">
                          <SelectValue placeholder="pick speed" />
                        </SelectTrigger>
                      </TooltipTrigger>
                      {presetIntervalHint && (
                        <TooltipContent className="text-[11px]">Интервал: {presetIntervalHint}</TooltipContent>
                      )}
                    </Tooltip>
                    <SelectContent className="bg-popover border-border text-xs">
                      <SelectItem value="furious" title="1-4s">
                        {SPEED_PRESETS.furious.label} (1-4s)
                      </SelectItem>
                      <SelectItem value="organic" title="5-15s">
                        {SPEED_PRESETS.organic.label} (5-15s)
                      </SelectItem>
                      <SelectItem value="slow" title="20-45s">
                        {SPEED_PRESETS.slow.label} (20-45s)
                      </SelectItem>
                      <SelectItem value="custom">Свои интервалы</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Min Interval (s)</Label>
                    <Input
                      type="number"
                      className="h-8 bg-background border-border text-xs"
                      value={minInterval}
                      onChange={(e) => setMinInterval(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Max Interval (s)</Label>
                    <Input
                      type="number"
                      className="h-8 bg-background border-border text-xs"
                      value={maxInterval}
                      onChange={(e) => setMaxInterval(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Slippage %</Label>
                    <Input
                      type="number"
                      className="h-8 bg-background border-border text-xs"
                      value={slippage}
                      onChange={(e) => setSlippage(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Priority Fee</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      className="h-8 bg-background border-border text-xs"
                      value={priorityFee}
                      onChange={(e) => setPriorityFee(e.target.value)}
                      disabled={config.autoFees === true}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between rounded border border-border p-2">
                  <div className="text-[11px]">
                    <div className="text-foreground">Auto fees/tip</div>
                    <div className="text-muted-foreground">
                      Auto-size priority fee and Jito tip by wallet balance.
                    </div>
                  </div>
                  <Switch checked={config.autoFees === true} onCheckedChange={setAutoFees} />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Jito Tip (SOL)</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      className="h-8 bg-background border-border text-xs"
                      value={jitoTip}
                      onChange={(e) => setJitoTip(e.target.value)}
                      disabled={config.autoFees === true}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Jito Region</Label>
                    <Select value={jitoRegion || "frankfurt"} onValueChange={setJitoRegion}>
                      <SelectTrigger className="h-8 bg-background border-border text-xs">
                        <SelectValue placeholder="region" />
                      </SelectTrigger>
                      <SelectContent className="bg-popover border-border">
                        <SelectItem value="frankfurt">frankfurt</SelectItem>
                        <SelectItem value="amsterdam">amsterdam</SelectItem>
                        <SelectItem value="ny">ny</SelectItem>
                        <SelectItem value="tokyo">tokyo</SelectItem>
                        <SelectItem value="auto">auto</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Max Executions (0 = unlimited)</Label>
                  <Input
                    type="number"
                    className="h-8 bg-background border-border text-xs"
                    value={maxExecutions}
                    onChange={(e) => setMaxExecutions(e.target.value)}
                  />
                </div>

                <div className="flex items-center justify-between rounded border border-border p-2">
                  <span className="text-[11px] text-muted-foreground">Multi-threaded</span>
                  <Switch checked={multiThreaded} onCheckedChange={setMultiThreaded} />
                </div>

                <div className="flex items-center justify-between rounded border border-border p-2">
                  <span className="text-[11px] text-muted-foreground">Auto bundler</span>
                  <Switch checked={autoBundler} onCheckedChange={setAutoBundler} />
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
