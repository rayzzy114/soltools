"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { TrendingUp, TrendingDown, Coins, Activity, Zap, Users, DollarSign, Play, Pause, Wallet, Settings, RefreshCw, Flame, Package, Send, Rocket, AlertTriangle, BarChart3, Plus, Trash2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, LineChart, Line } from "recharts"
import { PnLSummaryCard, MiniPnLCard } from "@/components/pnl/PnLCard"
import { TokenRanking } from "@/components/analytics/TokenRanking"
import { ActivityHeatmap } from "@/components/analytics/ActivityHeatmap"
import type { PnLSummary, TokenPnL, Trade } from "@/lib/pnl/types"
import { toast } from "sonner"
import { useWallet } from "@solana/wallet-adapter-react"
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, Keypair } from "@solana/web3.js"
import bs58 from "bs58"
import { getResilientConnection } from "@/lib/solana/config"
import { getBondingCurveAddress } from "@/lib/solana/pumpfun-sdk"
import { TokenHolderTracker, type HolderRow } from "@/lib/solana/holder-tracker"
import type { PriorityFeeRecommendations } from "@/lib/solana/priority-fees"

interface DashboardStats {
  activeTokens: number
  totalVolume24h: string
  bundledTxs: number
  holdersGained: number
}

interface Token {
  symbol: string
  name: string
  price: string
  change: string
  status: string
  mintAddress?: string
  isMigrated?: boolean
}

interface Activity {
  time: string
  action: string
  token: string
  amount?: string
  txs?: string
  supply?: string
}

interface BundlerWallet {
  publicKey: string
  secretKey: string
  solBalance: number
  tokenBalance: number
  isActive: boolean
  label?: string
  ataExists?: boolean
}

interface RugpullEstimate {
  grossSol: number
  gasFee: number
  jitoTip: number
  netSol: number
  priceImpact: number
  walletCount: number
  availableSol?: number
  isMigrated?: boolean
  priorityFee?: number
}

interface JitoTipFloor {
  lamports: {
    p50: number
    p75: number
    p95: number
  }
  sol: {
    p50: number
    p75: number
    p95: number
  }
  recommended: {
    lamports: number
    sol: number
    bufferPct: number
  }
}

const GAS_TOPUP_TARGET_SOL = 0.002
const PRIORITY_FEE_COMPUTE_UNITS = 400000
const PRICE_SERIES_MAX_POINTS = 60

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>({
    activeTokens: 0,
    totalVolume24h: "0",
    bundledTxs: 0,
    holdersGained: 0,
  })
  const [tokens, setTokens] = useState<Token[]>([])
  const [activity, setActivity] = useState<Activity[]>([])
  const [chartData, setChartData] = useState<any[]>([])
  const [volumeBotStats, setVolumeBotStats] = useState({
    isRunning: false,
    activePairs: 0,
    tradesToday: 0,
    volumeGenerated: "0",
    solSpent: "0",
  })
  const [pnlSummary, setPnlSummary] = useState<PnLSummary | null>(null)
  const [tokenPnls, setTokenPnls] = useState<TokenPnL[]>([])
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const router = useRouter()
  const { publicKey, sendTransaction, connected } = useWallet()

  // New states for enhanced dashboard
  const [selectedToken, setSelectedToken] = useState<Token | null>(null)
  const [bundlerWallets, setBundlerWallets] = useState<BundlerWallet[]>([])
  const [rugpullEstimate, setRugpullEstimate] = useState<RugpullEstimate | null>(null)
  const [devRugpullEstimate, setDevRugpullEstimate] = useState<RugpullEstimate | null>(null)
  const [selectedWallets, setSelectedWallets] = useState<Set<string>>(new Set())
  const [selectionInitialized, setSelectionInitialized] = useState(false)
  const [distributingGas, setDistributingGas] = useState(false)
  const [priorityFeeData, setPriorityFeeData] = useState<PriorityFeeRecommendations | null>(null)
  const [priorityFeePreset, setPriorityFeePreset] = useState<"default" | "fast" | "turbo" | "custom">("fast")
  const [priorityFeeSol, setPriorityFeeSol] = useState("0.0001")
  const [jitoTipFloor, setJitoTipFloor] = useState<JitoTipFloor | null>(null)
  const [autoJitoTip, setAutoJitoTip] = useState(true)
  const [jitoTipSol, setJitoTipSol] = useState("0.0001")
  const [jitoUuid, setJitoUuid] = useState("")
  const [jitoRegion, setJitoRegion] = useState("frankfurt")
  const [priceSeries, setPriceSeries] = useState<Array<{ time: string; price: number }>>([])
  const [walletCount, setWalletCount] = useState("5")
  const [devKey, setDevKey] = useState("")
  const [funderKey, setFunderKey] = useState("")
  const [useConnectedDev, setUseConnectedDev] = useState(true)
  const [useConnectedFunder, setUseConnectedFunder] = useState(true)
  const [gasLoading, setGasLoading] = useState(false)
  const [ataLoading, setAtaLoading] = useState(false)
  const [rugpullLoading, setRugpullLoading] = useState(false)
  const [systemLogs, setSystemLogs] = useState<string[]>([])
  const [rugpullSlippage, setRugpullSlippage] = useState("20")
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const [volumeBotConfig, setVolumeBotConfig] = useState({
    isRunning: false,
    pairId: "",
    mintAddress: "",
    mode: "wash" as "buy" | "sell" | "wash",
    amountMode: "random" as "fixed" | "random" | "percentage",
    fixedAmount: "0.01",
    minAmount: "0.005",
    maxAmount: "0.02",
    minPercentage: "5",
    maxPercentage: "20",
    slippage: "10",
    priorityFee: "0.005",
    jitoTip: "0.0001",
    jitoRegion: "frankfurt",
  })
  const [manualBuyAmount, setManualBuyAmount] = useState("0.01")
  const [manualSellPercent, setManualSellPercent] = useState("100")
  const [manualTradeDirty, setManualTradeDirty] = useState(false)
  const [quickTradeWallet, setQuickTradeWallet] = useState<BundlerWallet | null>(null)
  const [quickBuyAmount, setQuickBuyAmount] = useState("0.01")
  const [volumeBotStatus, setVolumeBotStatus] = useState<any>(null)
  const [logMintAddress, setLogMintAddress] = useState("")
  const [holderRows, setHolderRows] = useState<HolderRow[]>([])
  const [holdersLoading, setHoldersLoading] = useState(false)
  const holderTrackerRef = useRef<TokenHolderTracker | null>(null)
  const getPairStorageKey = useCallback((mint: string) => `volume_bot_pair_${mint}`, [])
  const getLastTokenKey = useCallback(() => "dashboardLastTokenMint", [])

  const activeWallets = useMemo(() => bundlerWallets.filter(w => w.isActive), [bundlerWallets])
  const selectedActiveWallets = useMemo(
    () => activeWallets.filter(w => selectedWallets.has(w.publicKey)),
    [activeWallets, selectedWallets]
  )
  const activeWalletsWithTokens = useMemo(
    () => activeWallets.filter(w => w.tokenBalance > 0),
    [activeWallets]
  )
  const walletsNeedingGas = useMemo(
    () => activeWallets.filter(w => w.solBalance < GAS_TOPUP_TARGET_SOL && w.tokenBalance > 0),
    [activeWallets]
  )
  const selectedWalletCount = selectedActiveWallets.length
  const selectedWalletAddressesParam = useMemo(
    () => selectedActiveWallets.map(w => w.publicKey).join(","),
    [selectedActiveWallets]
  )
  const poolShortfall = useMemo(() => {
    if (!rugpullEstimate || rugpullEstimate.availableSol === undefined) return false
    return rugpullEstimate.grossSol > rugpullEstimate.availableSol
  }, [rugpullEstimate])
  const volumeRunning = volumeBotConfig.isRunning || volumeBotStats.isRunning
  const devHolderPubkey = useMemo(() => {
    if (useConnectedDev && publicKey) return publicKey
    const trimmed = devKey.trim()
    if (!trimmed) return null
    try {
      return Keypair.fromSecretKey(bs58.decode(trimmed)).publicKey
    } catch {
      return null
    }
  }, [useConnectedDev, publicKey, devKey])

  const handleTokenSelect = useCallback((mintAddress: string) => {
    const token = tokens.find(t => t.mintAddress === mintAddress)
    if (token) {
      setSelectedToken(token)
      if (typeof window !== "undefined") {
        window.localStorage.setItem(getLastTokenKey(), token.mintAddress)
      }
    }
  }, [tokens, getLastTokenKey])

  const selectedTokenValue = selectedToken?.mintAddress || ""

  // Load saved wallets from database with batched balance updates
  const loadSavedWallets = useCallback(async () => {
    try {
      const res = await fetch("/api/bundler/wallets?action=load-all")
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`)
      }
      const data = await res.json()

      if (data.error) {
        console.error("API error:", data.error)
        return
      }

      if (data.wallets && Array.isArray(data.wallets)) {
        // If we have a selected token, refresh balances in batches to avoid rate limits
        if (selectedToken?.mintAddress) {
          await refreshWalletBalancesBatch(data.wallets, selectedToken.mintAddress)
        } else {
          setBundlerWallets(data.wallets)
        }

        // no toast: avoid noisy "loaded X saved wallets" popup
      }
    } catch (error: any) {
      console.error("failed to load saved wallets:", error)
      toast.error(`failed to load wallets: ${error.message || "unknown error"}`)
    }
  }, [selectedToken?.mintAddress])

  // Batch refresh wallet balances to avoid RPC rate limits
  const refreshWalletBalancesBatch = useCallback(async (wallets: BundlerWallet[], mintAddress: string) => {
    const BATCH_SIZE = 20 // Get up to 20 accounts per RPC call
    const batches = []
    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
      batches.push(wallets.slice(i, i + BATCH_SIZE))
    }

    for (const batch of batches) {
      try {
        const res = await fetch("/api/bundler/wallets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "refresh",
            wallets: batch,
            mintAddress
          })
        })

        const data = await res.json()
        if (data.wallets) {
          setBundlerWallets(prev => {
            // Merge refreshed wallets with existing ones
            const updated = [...prev]
            data.wallets.forEach((refreshedWallet: BundlerWallet) => {
              const index = updated.findIndex(w => w.publicKey === refreshedWallet.publicKey)
              if (index !== -1) {
                updated[index] = refreshedWallet
              }
            })
            return updated
          })
        }

        // Small delay between batches to respect rate limits
        if (batches.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      } catch (error) {
        console.error("Batch refresh error:", error)
      }
    }
  }, [])

  // Add system log
  const getLogStorageKey = useCallback((mint: string) => `system_logs_${mint}`, [])

  const saveLogToLocalStorage = useCallback((mint: string, newLog: string) => {
    if (typeof window === "undefined" || !mint) return
    try {
      const key = getLogStorageKey(mint)
      const raw = window.localStorage.getItem(key)
      const existing = raw ? (JSON.parse(raw) as string[]) : []
      const next = [newLog, ...existing].slice(0, 50)
      window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // ignore storage errors
    }
  }, [getLogStorageKey])

  const addSystemLog = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
    const timestamp = new Date().toLocaleTimeString()
    const logMessage = `[${timestamp}] ${type.toUpperCase()}: ${message}`
    setSystemLogs(prev => [logMessage, ...prev.slice(0, 49)]) // Keep last 50 logs
    console.log(logMessage)
    const mintForLogs =
      selectedToken?.mintAddress ||
      volumeBotConfig.mintAddress ||
      logMintAddress
    if (mintForLogs) {
      setLogMintAddress(mintForLogs)
      if (typeof window !== "undefined") {
        window.localStorage.setItem("dashboardLogMint", mintForLogs)
      }
      saveLogToLocalStorage(mintForLogs, logMessage)
    }
    if (volumeBotConfig.pairId || mintForLogs) {
      fetch("/api/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairId: volumeBotConfig.pairId || undefined,
          mintAddress: volumeBotConfig.pairId ? undefined : mintForLogs,
          message,
          type,
          metadata: { source: "dashboard" },
        }),
      }).catch(() => {})
    }
  }, [volumeBotConfig.pairId, selectedToken?.mintAddress, logMintAddress, saveLogToLocalStorage])

  const loadSystemLogs = useCallback(async () => {
    const mintForLogs =
      selectedToken?.mintAddress ||
      volumeBotConfig.mintAddress ||
      logMintAddress
    if (!volumeBotConfig.pairId && !mintForLogs) return
    try {
      const params = new URLSearchParams({ limit: "50", source: "dashboard" })
      if (volumeBotConfig.pairId) {
        params.set("pairId", volumeBotConfig.pairId)
      } else if (mintForLogs) {
        params.set("mintAddress", mintForLogs)
      }
      const res = await fetch(`/api/logs?${params.toString()}`)
      const data = await res.json()
      if (data.logs && Array.isArray(data.logs) && data.logs.length > 0) {
        const formatted = data.logs.map((log: any) => {
          const timestamp = new Date(log.createdAt).toLocaleTimeString()
          const typeLabel = String(log.type || "info").toUpperCase()
          return `[${timestamp}] ${typeLabel}: ${log.message}`
        })
        setSystemLogs(formatted)
      }
    } catch (error) {
      console.error("failed to load system logs:", error)
    }
  }, [volumeBotConfig.pairId, selectedToken?.mintAddress, logMintAddress])

  const clearSystemLogs = useCallback(() => {
    const mintForLogs =
      selectedToken?.mintAddress ||
      volumeBotConfig.mintAddress ||
      logMintAddress
    if (typeof window !== "undefined" && mintForLogs) {
      window.localStorage.removeItem(getLogStorageKey(mintForLogs))
    }
    setSystemLogs([])
  }, [selectedToken?.mintAddress, volumeBotConfig.mintAddress, logMintAddress, getLogStorageKey])

  useEffect(() => {
    let cancelled = false
    const loadHolders = async () => {
      if (!selectedToken?.mintAddress) {
        setHolderRows([])
        setHoldersLoading(false)
        return
      }
      setHoldersLoading(true)
      try {
        const connection = await getResilientConnection()
        if (cancelled) return
        const mint = new PublicKey(selectedToken.mintAddress)
        const bondingCurve = getBondingCurveAddress(mint)
        const tracker = new TokenHolderTracker(connection, mint, {
          bondingCurve,
          devWallet: devHolderPubkey ?? undefined,
          onUpdate: (rows) => {
            if (!cancelled) setHolderRows(rows)
          },
        })
        holderTrackerRef.current?.stop()
        holderTrackerRef.current = tracker
        await tracker.init()
      } catch (error: any) {
        console.error("holder tracker error:", error)
        addSystemLog(`Holders tracker error: ${error?.message || error}`, "error")
        setHolderRows([])
      } finally {
        if (!cancelled) setHoldersLoading(false)
      }
    }

    loadHolders()
    return () => {
      cancelled = true
      holderTrackerRef.current?.stop()
      holderTrackerRef.current = null
    }
  }, [selectedToken?.mintAddress, devHolderPubkey, addSystemLog])

  // Toggle wallet selection
  const toggleWalletSelection = useCallback((publicKey: string) => {
    setSelectedWallets(prev => {
      const newSet = new Set(prev)
      if (newSet.has(publicKey)) {
        newSet.delete(publicKey)
      } else {
        newSet.add(publicKey)
      }
      return newSet
    })
  }, [])

  // Select all wallets
  const selectAllWallets = useCallback(() => {
    setSelectedWallets(new Set(activeWallets.map(w => w.publicKey)))
  }, [activeWallets])

  // Clear selected wallets
  const clearSelectedWallets = useCallback(() => {
    setSelectedWallets(new Set())
  }, [])

  const saveManualTradeSettings = useCallback(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem("dashboardManualBuyAmount", manualBuyAmount)
    window.localStorage.setItem("dashboardManualSellPercent", manualSellPercent)
    setManualTradeDirty(false)
    addSystemLog("Manual trade settings saved", "success")
    toast.success("Manual trade settings saved")
  }, [manualBuyAmount, manualSellPercent, addSystemLog])

  // Get volume bot status
  const getVolumeBotStatus = useCallback(async () => {
    if (!volumeBotConfig.pairId) return

    try {
      const response = await fetch("/api/volume-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "status",
          pairId: volumeBotConfig.pairId
        })
      })

      const data = await response.json()
      if (data.status) {
        setVolumeBotStatus(data)
        // Update local config to match server state
        setVolumeBotConfig(prev => ({
          ...prev,
          isRunning: data.status === "running"
        }))
      }
    } catch (error) {
      console.error("Failed to get bot status:", error)
    }
  }, [volumeBotConfig.pairId])

  // Poll bot status every 5 seconds when running
  useEffect(() => {
    if (!volumeBotConfig.pairId || !volumeBotConfig.isRunning) return

    getVolumeBotStatus()
    const interval = setInterval(getVolumeBotStatus, 5000)
    return () => clearInterval(interval)
  }, [volumeBotConfig.pairId, volumeBotConfig.isRunning, getVolumeBotStatus])

  useEffect(() => {
    loadSystemLogs()
  }, [loadSystemLogs])

  useEffect(() => {
    if (typeof window === "undefined") return
    const stored = window.localStorage.getItem("dashboardLogMint")
    if (stored && !logMintAddress) {
      setLogMintAddress(stored)
    }
  }, [logMintAddress])

  useEffect(() => {
    if (!selectedToken?.mintAddress) return
    setLogMintAddress(selectedToken.mintAddress)
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dashboardLogMint", selectedToken.mintAddress)
    }
  }, [selectedToken?.mintAddress])

  useEffect(() => {
    if (typeof window === "undefined") return
    const savedBuy = window.localStorage.getItem("dashboardManualBuyAmount")
    const savedSell = window.localStorage.getItem("dashboardManualSellPercent")
    if (savedBuy) setManualBuyAmount(savedBuy)
    if (savedSell) setManualSellPercent(savedSell)
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const mintForLogs =
      selectedToken?.mintAddress ||
      volumeBotConfig.mintAddress ||
      logMintAddress
    if (!mintForLogs) return
    try {
      const key = getLogStorageKey(mintForLogs)
      const raw = window.localStorage.getItem(key)
      const existing = raw ? (JSON.parse(raw) as string[]) : []
      if (existing.length > 0) {
        setSystemLogs(existing)
      }
    } catch {
      // ignore
    }
  }, [selectedToken?.mintAddress, volumeBotConfig.mintAddress, logMintAddress, getLogStorageKey])

  // Generate wallets
  const generateWallets = useCallback(async () => {
    try {
      const count = parseInt(walletCount) || 5
      if (count < 1 || count > 20) {
        toast.error("count must be between 1 and 20")
        return
      }

      const res = await fetch(`/api/bundler/wallets?action=generate-multiple&count=${count}`)
      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
        return
      }

      if (data.wallets && Array.isArray(data.wallets)) {
        setBundlerWallets(prev => [...prev, ...data.wallets])
        toast.success(`generated ${data.wallets.length} wallets`)
      } else {
        toast.error("invalid response from server")
      }
    } catch (error: any) {
      console.error("generate wallets error:", error)
      toast.error(`failed to generate wallets: ${error.message || "unknown error"}`)
    }
  }, [walletCount])

  // Clear all wallets
  const clearWallets = useCallback(() => {
    setBundlerWallets([])
    setSelectedWallets(new Set())
    toast.success("cleared all wallets")
  }, [])

  // Distribute gas (fund wallets)
  const distributeGas = useCallback(async () => {
    const activeWallets = bundlerWallets.filter(w => w.isActive)
    if (activeWallets.length === 0) {
      addSystemLog("No active wallets found", 'error')
      toast.error("no active wallets")
      return
    }

    if (useConnectedFunder && (!connected || !publicKey)) {
      addSystemLog("Wallet not connected", 'error')
      toast.error("connect wallet first")
      return
    }

    setGasLoading(true)
    addSystemLog(`Starting gas distribution to ${activeWallets.length} wallets`, 'info')

    try {
      const amountPerWallet = 0.003
      const totalSolNeeded = (amountPerWallet * activeWallets.length) + 0.01
      const connection = await getResilientConnection()

      if (useConnectedFunder) {
        const balance = await connection.getBalance(publicKey!)
        const balanceInSol = balance / LAMPORTS_PER_SOL

        if (balanceInSol < totalSolNeeded) {
          const error = `Insufficient balance. Need ${totalSolNeeded.toFixed(4)} SOL, have ${balanceInSol.toFixed(4)} SOL`
          addSystemLog(error, 'error')
          toast.error(error)
          return
        }

        addSystemLog(`Balance check passed: ${balanceInSol.toFixed(4)} SOL available`, 'success')

        const BATCH_SIZE = 8
        for (let i = 0; i < activeWallets.length; i += BATCH_SIZE) {
          const batch = activeWallets.slice(i, i + BATCH_SIZE)
          const tx = new Transaction()
          batch.forEach((wallet) => {
            tx.add(
              SystemProgram.transfer({
                fromPubkey: publicKey!,
                toPubkey: new PublicKey(wallet.publicKey),
                lamports: Math.floor(amountPerWallet * LAMPORTS_PER_SOL),
              })
            )
          })

          const sig = await sendTransaction(tx, connection)
          await connection.confirmTransaction(sig, "confirmed")
          addSystemLog(`Batch ${Math.floor(i / BATCH_SIZE) + 1} confirmed: ${sig.slice(0, 8)}...`, 'success')
        }
      } else {
        const trimmed = funderKey.trim()
        if (!trimmed) {
          const error = "Funder private key required"
          addSystemLog(error, "error")
          toast.error(error)
          return
        }

        let funderPubkey: PublicKey | null = null
        try {
          funderPubkey = Keypair.fromSecretKey(bs58.decode(trimmed)).publicKey
        } catch (error: any) {
          const message = `Invalid funder key: ${error?.message || error}`
          addSystemLog(message, "error")
          toast.error(message)
          return
        }

        const balance = await connection.getBalance(funderPubkey)
        const balanceInSol = balance / LAMPORTS_PER_SOL
        if (balanceInSol < totalSolNeeded) {
          const error = `Insufficient balance. Need ${totalSolNeeded.toFixed(4)} SOL, have ${balanceInSol.toFixed(4)} SOL`
          addSystemLog(error, 'error')
          toast.error(error)
          return
        }

        addSystemLog(`Balance check passed: ${balanceInSol.toFixed(4)} SOL available`, 'success')

        const res = await fetch("/api/bundler/wallets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "fund",
            funderSecretKey: trimmed,
            wallets: activeWallets,
            amounts: activeWallets.map(() => amountPerWallet),
          }),
        })

        const data = await res.json()
        if (!res.ok || data?.error) {
          const message = data?.error || "Failed to fund wallets"
          addSystemLog(message, "error")
          toast.error(message)
          return
        }

        addSystemLog(`Funder tx confirmed: ${data.signature?.slice(0, 8)}...`, "success")
      }

      addSystemLog(`Successfully funded ${activeWallets.length} wallets`, 'success')
      toast.success(`funded ${activeWallets.length} wallets`)
      setTimeout(() => loadSavedWallets(), 2000)

      if (volumeBotConfig.pairId) {
        addSystemLog(`Gas distributed: ${totalSolNeeded.toFixed(4)} SOL to ${activeWallets.length} wallets`, 'info')
      }
    } catch (error: any) {
      addSystemLog(`Gas distribution error: ${error.message}`, 'error')
      console.error("distribute gas error:", error)
      toast.error(`failed to fund wallets: ${error.message}`)
    } finally {
      setGasLoading(false)
    }
  }, [
    connected,
    publicKey,
    bundlerWallets,
    useConnectedFunder,
    funderKey,
    sendTransaction,
    addSystemLog,
    loadSavedWallets,
    volumeBotConfig.pairId,
  ])

  // Rugpull all wallets
  const rugpullAllWallets = useCallback(async () => {
    if (!selectedToken || activeWalletsWithTokens.length === 0) return

    const confirmed = window.confirm(
      `This will sell ALL tokens from ALL active wallets!\n\n` +
      `Wallets: ${activeWalletsWithTokens.length}\n` +
      `Mint: ${selectedToken.mintAddress?.slice(0, 20) || "unknown"}...\n\n` +
      `Continue?`
    )

    if (!confirmed) return

    try {
      const res = await fetch("/api/bundler/rugpull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: activeWalletsWithTokens,
          mintAddress: selectedToken.mintAddress,
          jitoTip: parseFloat(jitoTipSol),
          priorityFee: parseFloat(priorityFeeSol),
          slippage: parseFloat(rugpullSlippage) || 20,
          jitoRegion,
        })
      })

      const data = await res.json()
      if (data.error) {
        toast.error(data.error)
      } else {
        toast.success(`rugpull executed! sold all tokens from ${data.signatures?.length || 0} wallets`)
        await loadSavedWallets() // Refresh balances
      }
    } catch (error: any) {
      console.error("rugpull error:", error)
      toast.error(`rugpull failed: ${error.message}`)
    }
  }, [selectedToken, activeWalletsWithTokens, jitoTipSol, priorityFeeSol, jitoRegion])

  // Rugpull dev wallet
  const rugpullDevWallet = useCallback(async () => {
    if (!selectedToken) return

    let resolvedDevKey = ""
    if (useConnectedDev) {
      if (!publicKey) {
        addSystemLog("Connect wallet to use it as dev wallet", "error")
        toast.error("connect wallet first")
        return
      }
      const match = bundlerWallets.find(
        (wallet) => wallet.publicKey === publicKey.toBase58() && wallet.secretKey
      )
      if (!match?.secretKey) {
        const message = "Connected wallet secret not found in saved wallets"
        addSystemLog(message, "error")
        toast.error(message)
        return
      }
      resolvedDevKey = match.secretKey
    } else {
      resolvedDevKey = devKey.trim()
      if (!resolvedDevKey) {
        addSystemLog("Dev wallet private key required", "error")
        toast.error("dev wallet key required")
        return
      }
    }

    try {
      const bs58 = await import("bs58")
      const devWallet = Keypair.fromSecretKey(bs58.default.decode(resolvedDevKey))

      const res = await fetch("/api/bundler/rugpull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: [{
            publicKey: devWallet.publicKey.toBase58(),
            secretKey: bs58.default.encode(devWallet.secretKey),
            solBalance: 0, // Will be checked server-side
            tokenBalance: 100, // Assume dev wallet has tokens
            isActive: true
          }],
          mintAddress: selectedToken.mintAddress,
          jitoTip: parseFloat(jitoTipSol),
          priorityFee: parseFloat(priorityFeeSol),
          slippage: parseFloat(rugpullSlippage) || 20,
          jitoRegion,
        })
      })

      const data = await res.json()
      if (data.error) {
        toast.error(data.error)
      } else {
        toast.success("dev wallet rugpull executed!")
      }
    } catch (error: any) {
      console.error("dev rugpull error:", error)
      toast.error(`dev rugpull failed: ${error.message}`)
    }
  }, [
    selectedToken,
    devKey,
    useConnectedDev,
    publicKey,
    bundlerWallets,
    jitoTipSol,
    priorityFeeSol,
    jitoRegion,
    addSystemLog,
  ])

  // Create buy bundle
  const createBuyBundle = useCallback(async () => {
    if (!selectedToken || selectedActiveWallets.length === 0) return

    try {
      const res = await fetch("/api/bundler/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: selectedActiveWallets,
          mintAddress: selectedToken.mintAddress,
          priorityFeeSol,
          jitoTipSol,
          autoJitoTip
        })
      })

      const data = await res.json()
      if (data.success) {
        toast.success("Buy bundle created successfully")
      } else {
        toast.error(data.error || "Failed to create buy bundle")
      }
    } catch (error: any) {
      console.error("create buy bundle error:", error)
      toast.error(`Failed to create buy bundle: ${error.message}`)
    }
  }, [selectedToken, selectedActiveWallets, priorityFeeSol, jitoTipSol, autoJitoTip])

  // Create sell bundle
  const createSellBundle = useCallback(async () => {
    if (!selectedToken || activeWalletsWithTokens.length === 0) return

    try {
      const res = await fetch("/api/bundler/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: activeWalletsWithTokens,
          mintAddress: selectedToken.mintAddress,
          priorityFeeSol,
          jitoTipSol,
          autoJitoTip
        })
      })

      const data = await res.json()
      if (data.success) {
        toast.success("Sell bundle created successfully")
      } else {
        toast.error(data.error || "Failed to create sell bundle")
      }
    } catch (error: any) {
      console.error("create sell bundle error:", error)
      toast.error(`Failed to create sell bundle: ${error.message}`)
    }
  }, [selectedToken, activeWalletsWithTokens, priorityFeeSol, jitoTipSol, autoJitoTip])

  // Execute wallet trade (buy/sell individual)
  const executeWalletTrade = useCallback(async (
    wallet: BundlerWallet,
    action: "buy" | "sell",
    overrides?: { buyAmount?: number; sellPercent?: number }
  ) => {
    if (!selectedToken?.mintAddress) {
      addSystemLog("Select a token before trading", "error")
      toast.error("Select a token first")
      return
    }
    if (!wallet.secretKey) {
      addSystemLog(`Wallet secret key missing for ${wallet.publicKey}`, "error")
      toast.error("Wallet secret key missing")
      return
    }

    const parsedBuy = overrides?.buyAmount ?? Number.parseFloat(manualBuyAmount)
    const buyAmount = Number.isFinite(parsedBuy) && parsedBuy > 0 ? parsedBuy : 0
    const parsedSellPct = overrides?.sellPercent ?? Number.parseFloat(manualSellPercent)
    const sellPct = Number.isFinite(parsedSellPct)
      ? Math.min(100, Math.max(1, parsedSellPct))
      : 100
    let effectiveWallet = wallet
    const calcSellAmount = (w: BundlerWallet) => Math.max(0, (w.tokenBalance || 0) * (sellPct / 100))
    let sellAmount = calcSellAmount(effectiveWallet)
    if (action === "sell" && (effectiveWallet.tokenBalance || 0) <= 0) {
      try {
        const res = await fetch("/api/bundler/wallets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "refresh",
            wallets: [wallet],
            mintAddress: selectedToken.mintAddress,
          }),
        })
        const data = await res.json()
        if (Array.isArray(data.wallets) && data.wallets[0]) {
          effectiveWallet = data.wallets[0]
          setBundlerWallets((prev) =>
            prev.map((w) => (w.publicKey === effectiveWallet.publicKey ? effectiveWallet : w))
          )
          sellAmount = calcSellAmount(effectiveWallet)
        }
      } catch {
        // ignore refresh errors, fall back to existing balance
      }
    }
    const amount = action === "buy" ? buyAmount : sellAmount

    if (action === "buy" && buyAmount <= 0) {
      addSystemLog("Set a valid buy amount (SOL)", "error")
      toast.error("Set a valid buy amount")
      return
    }
    if (action === "sell" && (effectiveWallet.tokenBalance || 0) <= 0) {
      addSystemLog("Нет токенов для продажи!", "error")
      toast.error("Нет токенов для продажи!")
      return
    }
    if (action === "sell" && sellAmount <= 0) {
      addSystemLog("Нет токенов для продажи!", "error")
      toast.error("Нет токенов для продажи!")
      return
    }

    const amountLabel =
      action === "buy"
        ? `${amount} SOL`
        : `${amount.toFixed(2)} tokens (${sellPct}%)`
    addSystemLog(
      `Manual ${action} request: ${effectiveWallet.publicKey.slice(0, 8)}...${effectiveWallet.publicKey.slice(-4)} (${amountLabel})`,
      "info"
    )

    try {
      const response = await fetch("/api/volume-bot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: {
            publicKey: effectiveWallet.publicKey,
            secretKey: effectiveWallet.secretKey,
            solBalance: effectiveWallet.solBalance,
            tokenBalance: effectiveWallet.tokenBalance,
            isActive: effectiveWallet.isActive,
            ataExists: effectiveWallet.ataExists,
          },
          mintAddress: selectedToken.mintAddress,
          type: action,
          amount,
          slippage: parseFloat(volumeBotConfig.slippage) || 10,
          priorityFee: parseFloat(priorityFeeSol) || 0.0001,
          useJito: true,
          jitoRegion,
          jitoTip: parseFloat(jitoTipSol) || 0.0001,
          autoFees: true,
        }),
      })

      const result = await response.json()
      if (!response.ok || result?.error) {
        const message = result?.error || `Failed to ${action}`
        addSystemLog(message, "error")
        toast.error(message)
        return
      }

      const tx = result?.transaction
      if (tx?.status === "success" || tx?.status === "confirmed") {
        addSystemLog(`${action.toUpperCase()} confirmed: ${tx.signature || "ok"}`, "success")
        toast.success(`${action.toUpperCase()} confirmed`)
        return
      }
      if (tx?.status === "pending") {
        addSystemLog(`${action.toUpperCase()} pending: ${tx.signature || "bundle pending"}`, "info")
        toast.success(`${action.toUpperCase()} pending`)
        return
      }

      const fallback = tx?.error || `Failed to ${action}`
      addSystemLog(fallback, "error")
      toast.error(fallback)
    } catch (error: any) {
      console.error(`${action} error:`, error)
      addSystemLog(`Manual ${action} error: ${error?.message || error}`, "error")
      toast.error(`Failed to ${action}`)
    }
  }, [
    selectedToken?.mintAddress,
    volumeBotConfig,
    priorityFeeSol,
    jitoTipSol,
    jitoRegion,
    manualBuyAmount,
    manualSellPercent,
    addSystemLog,
  ])

  // Start volume bot
  const startVolumeBot = useCallback(async () => {
    if (!selectedToken) return

    try {
      const response = await fetch("/api/volume-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          pairId: volumeBotConfig.pairId || null,
          mintAddress: selectedToken.mintAddress,
          mode: volumeBotConfig.mode,
          amountMode: volumeBotConfig.amountMode,
          fixedAmount: volumeBotConfig.fixedAmount,
          minAmount: volumeBotConfig.minAmount,
          maxAmount: volumeBotConfig.maxAmount,
          minPercentage: volumeBotConfig.minPercentage,
          maxPercentage: volumeBotConfig.maxPercentage,
          slippage: volumeBotConfig.slippage,
          priorityFee: volumeBotConfig.priorityFee,
          jitoTip: volumeBotConfig.jitoTip,
          jitoRegion: volumeBotConfig.jitoRegion
        })
      })

      const result = await response.json()
        if (result.success) {
          const resolvedPairId = result.pairId || volumeBotConfig.pairId
          if (resolvedPairId && selectedToken.mintAddress && typeof window !== "undefined") {
            window.localStorage.setItem(getPairStorageKey(selectedToken.mintAddress), resolvedPairId)
            window.localStorage.setItem(getLastTokenKey(), selectedToken.mintAddress)
          }
          setVolumeBotConfig(prev => ({
            ...prev,
            isRunning: true,
            pairId: resolvedPairId || prev.pairId,
            mintAddress: selectedToken.mintAddress
          }))
          addSystemLog("Volume bot started successfully", "success")
          toast.success("Volume bot started")
        } else {
        addSystemLog(`Failed to start volume bot: ${result.error}`, "error")
        toast.error(result.error || "Failed to start volume bot")
      }
    } catch (error) {
      console.error("Start volume bot error:", error)
      addSystemLog(`Start volume bot error: ${error}`, "error")
      toast.error("Failed to start volume bot")
    }
  }, [selectedToken, volumeBotConfig, addSystemLog, getPairStorageKey, getLastTokenKey])

  // Stop volume bot
  const stopVolumeBot = useCallback(async () => {
    if (!volumeBotConfig.pairId) return

    try {
      const response = await fetch("/api/volume-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "stop",
          pairId: volumeBotConfig.pairId
        })
      })

      const result = await response.json()
      if (result.success) {
        setVolumeBotConfig(prev => ({ ...prev, isRunning: false }))
        addSystemLog("Volume bot stopped successfully", "success")
        toast.success("Volume bot stopped")
      } else {
        addSystemLog(`Failed to stop volume bot: ${result.error}`, "error")
        toast.error(result.error || "Failed to stop volume bot")
      }
    } catch (error) {
      console.error("Stop volume bot error:", error)
      addSystemLog(`Stop volume bot error: ${error}`, "error")
      toast.error("Failed to stop volume bot")
    }
  }, [volumeBotConfig.pairId, addSystemLog])

  // Stop all processes
  const stopAllProcesses = useCallback(() => {
    if (abortController) {
      abortController.abort()
      setAbortController(null)
    }

    // Stop volume bot if running
    if (volumeBotConfig.isRunning) {
      stopVolumeBot()
    }

    setGasLoading(false)
    setAtaLoading(false)
    setRugpullLoading(false)

    addSystemLog("All processes stopped by user", 'info')
    toast.success("All processes stopped")
  }, [abortController, volumeBotConfig.isRunning, stopVolumeBot, addSystemLog])

  // Create ATAs for all wallets (batched)
  const createATAs = useCallback(async () => {
    if (!selectedToken || activeWallets.length === 0) return

    setAtaLoading(true)
    addSystemLog(`Starting ATA creation for ${activeWallets.length} wallets`, 'info')

    const BATCH_SIZE = 5
    const batches = []
    for (let i = 0; i < activeWallets.length; i += BATCH_SIZE) {
      batches.push(activeWallets.slice(i, i + BATCH_SIZE))
    }

    try {
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]
        addSystemLog(`Creating ATAs for batch ${i + 1}/${batches.length} (${batch.length} wallets)`, 'info')
        toast.info(`Creating ATAs for batch ${i + 1}/${batches.length} (${batch.length} wallets)`)

        const response = await fetch("/api/bundler/wallets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create-atas",
            wallets: batch,
            mintAddress: selectedToken.mintAddress
          })
        })

          const data = await response.json().catch(() => ({}))
          if (data.success) {
            addSystemLog(`Batch ${i + 1}/${batches.length} completed successfully`, 'success')
            toast.success(`Batch ${i + 1}/${batches.length} completed`)
          } else {
            const errMsg =
              typeof data.error === "string"
                ? data.error
                : data.error
                  ? JSON.stringify(data.error)
                  : data.errors && Array.isArray(data.errors) && data.errors.length > 0
                    ? JSON.stringify(data.errors[0])
                    : `HTTP ${response.status}`
            addSystemLog(`Batch ${i + 1}/${batches.length} failed: ${errMsg}`, 'error')
            toast.error(`Batch ${i + 1}/${batches.length} failed: ${errMsg}`)
            return // Stop on first failure
          }

        // Small delay between batches to avoid rate limits
        if (i < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }

      addSystemLog(`Successfully created ATAs for all ${activeWallets.length} wallets`, 'success')
      toast.success(`Created ATAs for all ${activeWallets.length} wallets`)
      // Auto refresh after 3 seconds to show updated ATA status
      setTimeout(() => loadSavedWallets(), 3000)

      // Log to volume bot if it's running
      if (volumeBotConfig.pairId) {
        addSystemLog(`ATAs created for ${activeWallets.length} wallets in ${batches.length} batches`, 'success')
      }
    } catch (error: any) {
      addSystemLog(`ATA creation error: ${error.message}`, 'error')
      console.error("Create ATAs error:", error)
      toast.error(`Failed to create ATAs: ${error.message}`)
    } finally {
      setAtaLoading(false)
    }
  }, [selectedToken, activeWallets, addSystemLog])

  const fetchDashboardData = useCallback(async () => {
    try {
      const [statsRes, tokensRes, activityRes, chartRes, volumeBotRes, pnlRes, tokenPnlsRes, tradesRes] = await Promise.all([
        fetch("/api/stats?type=dashboard"),
        fetch("/api/stats?type=tokens"),
        fetch("/api/stats?type=activity&limit=5"),
        fetch("/api/stats?type=chart&days=7"),
        fetch("/api/stats?type=volume-bot"),
        fetch("/api/pnl?type=summary"),
        fetch("/api/pnl?type=tokens"),
        fetch("/api/pnl?type=trades&limit=100"),
      ])

      const statsData = await statsRes.json()
      const tokensData = await tokensRes.json()
      const activityData = await activityRes.json()
      const chartDataRes = await chartRes.json()
      const volumeBotData = await volumeBotRes.json()
      const pnlData = await pnlRes.json()
      const tokenPnlsData = await tokenPnlsRes.json()
      const tradesData = await tradesRes.json()
        setStats(statsData)
        setTokens(tokensData)
        setActivity(activityData)
      setChartData(chartDataRes)
      setVolumeBotStats(volumeBotData)
      if (pnlData && !pnlData.error) {
        setPnlSummary(pnlData)
      }
      if (tokenPnlsData && Array.isArray(tokenPnlsData)) {
        setTokenPnls(tokenPnlsData)
      }
      if (tradesData && Array.isArray(tradesData)) {
        setTrades(tradesData)
      }
      // Auto-select first token if available
        let resolvedToken = selectedToken
        if (tokensData && tokensData.length > 0 && !selectedToken) {
          let preferredMint: string | null = null
          if (typeof window !== "undefined") {
            preferredMint = window.localStorage.getItem(getLastTokenKey())
          }
          const preferredToken = preferredMint
            ? tokensData.find((t: any) => t.mintAddress === preferredMint)
            : null
          resolvedToken = preferredToken || tokensData[0]
          setSelectedToken(resolvedToken)
        }

      // Load wallets
      await loadSavedWallets()

      setLoading(false)
    } catch (error) {
      console.error("Error fetching dashboard data:", error)
      setLoading(false)
    }
  }, [selectedToken?.mintAddress, getLastTokenKey])

  useEffect(() => {
    if (!selectedToken?.mintAddress) return
    if (typeof window === "undefined") return
    const storedPair = window.localStorage.getItem(getPairStorageKey(selectedToken.mintAddress))
    if (storedPair) {
      setVolumeBotConfig(prev => ({
        ...prev,
        pairId: storedPair,
        mintAddress: selectedToken.mintAddress
      }))
    }
  }, [selectedToken?.mintAddress, getPairStorageKey])

  useEffect(() => {
    if (!volumeBotConfig.pairId) return
    getVolumeBotStatus()
  }, [volumeBotConfig.pairId, getVolumeBotStatus])

  useEffect(() => {
    fetchDashboardData()
    const interval = setInterval(fetchDashboardData, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [fetchDashboardData])

  // Load wallets on mount
  useEffect(() => {
    loadSavedWallets()
  }, [loadSavedWallets])

  // Load Jito tip floor and priority fees on mount
  useEffect(() => {
    const loadNetworkData = async () => {
      try {
        // Load Jito tip floor
        const jitoRes = await fetch("/api/jito/tip-floor")
        const jitoData = await jitoRes.json()
        if (jitoData.recommended) {
          setJitoTipFloor(jitoData)
          if (autoJitoTip) {
            setJitoTipSol(jitoData.sol.p75.toFixed(6))
          }
        }

        // Load priority fees
        const priorityRes = await fetch("/api/fees/priority")
        const priorityData = await priorityRes.json()
        if (priorityData.recommendations) {
          setPriorityFeeData(priorityData)
          setPriorityFeeSol(priorityData.fast.lamports.toString())
        }
      } catch (error) {
        console.error("Failed to load network data:", error)
      }
    }

    loadNetworkData()
  }, [autoJitoTip])

  // Helper functions
  const formatVolume = (volume: string | number) => {
    const num = typeof volume === "string" ? parseFloat(volume) : volume
    return isNaN(num) ? "0" : `${num.toLocaleString()}`
  }

  const formatTimeAgo = (timestamp: string) => {
    const now = new Date()
    const time = new Date(timestamp)
    const diff = now.getTime() - time.getTime()
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return "now"
  }

  const jitoTipStatus = useMemo(() => {
    if (!jitoTipFloor) return { className: "text-neutral-500", label: "..." }
    const currentTip = autoJitoTip ? parseFloat(jitoTipFloor.sol.p75.toFixed(6)) : parseFloat(jitoTipSol)
    const recommended = jitoTipFloor.sol.p75
    const isGood = currentTip >= recommended * 0.8

    return {
      className: isGood ? "text-green-400" : "text-yellow-400",
      label: isGood ? "Good" : "Low"
    }
  }, [jitoTipFloor, autoJitoTip, jitoTipSol])

  return (
    <div className="p-1 space-y-1">
      <div className="flex flex-col gap-1 xl:flex-row xl:items-center xl:justify-between">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-white tracking-wider">CONTROL PANEL</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[10px]">
              <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/70 px-1 py-0.5">
              <span className="text-white/80">Active tokens</span>
              <span className="font-mono text-white">{loading ? "..." : stats.activeTokens}</span>
            </div>
              <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/70 px-1 py-0.5">
              <span className="text-white/80">Volume 24h</span>
              <span className="font-mono text-white">{loading ? "..." : formatVolume(stats.totalVolume24h)}</span>
            </div>
              <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/70 px-1 py-0.5">
              <span className="text-white/80">Bundled txs</span>
              <span className="font-mono text-white">{loading ? "..." : stats.bundledTxs}</span>
            </div>
              <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/70 px-1 py-0.5">
              <span className="text-white/80">Holders gained</span>
              <span className="font-mono text-white">{loading ? "..." : stats.holdersGained.toLocaleString()}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pnlSummary && (
            <MiniPnLCard totalPnl={pnlSummary.totalPnl} roi={pnlSummary.overallRoi} label="PnL" />
          )}
          <div className="flex items-center gap-1">
            <Label className="text-xs text-slate-600">Token</Label>
            <Select value={selectedTokenValue || ""} onValueChange={handleTokenSelect}>
              <SelectTrigger className="h-8 w-44 bg-background border-border text-xs">
                <SelectValue placeholder="Select token" />
              </SelectTrigger>
              <SelectContent>
                {tokens.map((token) => (
                  <SelectItem key={token.mintAddress || token.symbol} value={token.mintAddress || ""}>
                    {token.symbol} - {token.price}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={stopAllProcesses}
            variant="destructive"
            size="sm"
            className="h-7 px-2 bg-red-600 hover:bg-red-700"
          >
            <AlertTriangle className="w-3 h-3 mr-1" />
            STOP ALL
          </Button>
          <Button onClick={fetchDashboardData} variant="outline" size="sm" className="h-7 px-2">
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-1">
        <Card className="xl:col-span-6 bg-neutral-900 border-neutral-700">
          <CardHeader className="py-1 px-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                <Rocket className="w-4 h-4 text-blue-400" />
                VOLUME BOT
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge className={volumeRunning ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}>
                  {volumeRunning ? "RUNNING" : "STOPPED"}
                </Badge>
                <div className="text-[9px] text-slate-400">
                  {volumeBotStatus ? (
                    <>
                      Trades: {volumeBotStatus.totalTrades || 0} |
                      Vol: {parseFloat(volumeBotStatus.totalVolume || "0").toFixed(3)} SOL |
                      Spent: {parseFloat(volumeBotStatus.solSpent || "0").toFixed(3)} SOL
                    </>
                  ) : (
                    volumeBotConfig.amountMode === "fixed"
                      ? `Fixed: ${volumeBotConfig.fixedAmount} SOL`
                      : volumeBotConfig.amountMode === "random"
                      ? `Range: ${volumeBotConfig.minAmount}-${volumeBotConfig.maxAmount} SOL`
                      : `Perc: ${volumeBotConfig.minPercentage}-${volumeBotConfig.maxPercentage}%`
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-1 px-2 pb-2">
            <div className="flex flex-wrap items-center gap-1">
              {volumeRunning ? (
                <Button onClick={stopVolumeBot} className="h-8 bg-red-500 hover:bg-red-600">
                  <Pause className="w-4 h-4 mr-2" />
                  Stop
                </Button>
              ) : (
                <Button onClick={startVolumeBot} disabled={!selectedToken} className="h-8 bg-green-500 hover:bg-green-600">
                  <Play className="w-4 h-4 mr-2" />
                  Start
                </Button>
              )}
              <div className="flex items-center gap-3 text-[11px] text-neutral-400">
                <span>Pairs: {loading ? "..." : volumeBotStats.activePairs}</span>
                <span>Trades: {loading ? "..." : volumeBotStats.tradesToday.toLocaleString()}</span>
                <span>Vol: {loading ? "..." : `${parseFloat(volumeBotStats.volumeGenerated).toLocaleString()} SOL`}</span>
              </div>
            </div>

            <div className="max-h-40 overflow-y-auto">
              <div className="grid grid-cols-6 sm:grid-cols-8 lg:grid-cols-12 gap-1">
                {activeWallets.length === 0 ? (
                  <div className="col-span-full text-xs text-neutral-500">No active wallets</div>
                ) : (
                  activeWallets.map((wallet) => (
                  <button
                    key={wallet.publicKey}
                    type="button"
                    onClick={() => setQuickTradeWallet(wallet)}
                    className="aspect-square rounded border border-orange-500 bg-white p-0.5 text-left text-[8px] hover:border-orange-400 transition"
                  >
                    <div className="text-[8px]" style={{ color: "#000", fontWeight: 700 }}>Wallet</div>
                    <div className="font-mono text-[8px] text-neutral-900 truncate">
                      {wallet.publicKey.slice(0, 6)}...{wallet.publicKey.slice(-4)}
                    </div>
                  </button>
                ))
              )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Dialog open={!!quickTradeWallet} onOpenChange={(open) => { if (!open) setQuickTradeWallet(null) }}>
          <DialogContent className="bg-white border-neutral-300 text-neutral-900 max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm text-neutral-900">Wallet Trade</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="text-xs text-neutral-600">
                {quickTradeWallet
                  ? `${quickTradeWallet.publicKey.slice(0, 8)}...${quickTradeWallet.publicKey.slice(-4)}`
                  : ""}
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-neutral-700">Buy Amount (SOL)</Label>
                <Input
                  type="number"
                  step="0.0001"
                  className="h-8 bg-white border-neutral-300 text-xs text-neutral-900"
                  value={quickBuyAmount}
                  onChange={(e) => setQuickBuyAmount(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-4 gap-2">
                {["0.005", "0.01", "0.02", "0.05"].map((preset) => (
                  <Button
                    key={preset}
                    variant="outline"
                    className="h-8 text-xs bg-white text-neutral-900 border-neutral-300 hover:bg-neutral-100 disabled:text-neutral-400"
                    onClick={() => setQuickBuyAmount(preset)}
                  >
                    {preset}
                  </Button>
                ))}
              </div>
              <div className="flex gap-2">
                <Button
                  className="h-8 flex-1 bg-blue-500 hover:bg-blue-600 text-xs text-white"
                  onClick={() => {
                    if (!quickTradeWallet) return
                    const parsed = Number.parseFloat(quickBuyAmount)
                    executeWalletTrade(quickTradeWallet, "buy", { buyAmount: parsed })
                    setQuickTradeWallet(null)
                  }}
                  disabled={!selectedToken || !quickTradeWallet}
                >
                  Buy
                </Button>
              </div>
              <div className="text-xs text-neutral-700">Sell %</div>
              <div className="grid grid-cols-4 gap-2">
                {[10, 25, 50, 100].map((pct) => (
                  <Button
                    key={pct}
                    variant="outline"
                    className="h-8 text-xs bg-white text-neutral-900 border-neutral-300 hover:bg-neutral-100 disabled:text-neutral-400"
                    onClick={() => {
                      if (!quickTradeWallet) return
                      executeWalletTrade(quickTradeWallet, "sell", { sellPercent: pct })
                      setQuickTradeWallet(null)
                    }}
                    disabled={!selectedToken || !quickTradeWallet}
                  >
                    {pct}%
                  </Button>
                ))}
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Card className="xl:col-span-6 bg-neutral-900 border-neutral-700">
          <CardHeader className="py-1 px-2">
              <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                <Package className="w-4 h-4 text-cyan-400" />
                BUNDLER
              </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 px-2 pb-2">
            <div className="grid grid-cols-2 gap-1">
              <div className="space-y-1">
                <Label className="text-[11px] text-neutral-500">Priority Fee Preset</Label>
                <Select value={priorityFeePreset} onValueChange={(value) => setPriorityFeePreset(value as any)}>
                  <SelectTrigger className="h-8 bg-background border-border text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    <SelectItem value="fast">Fast</SelectItem>
                    <SelectItem value="turbo">Turbo</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-neutral-500">Priority Fee (SOL/tx)</Label>
                <Input
                  type="number"
                  step="0.000001"
                  className="h-7 bg-background border-border text-xs"
                  value={priorityFeeSol}
                  onChange={(e) => {
                    setPriorityFeePreset("custom")
                    setPriorityFeeSol(e.target.value)
                  }}
                  disabled={priorityFeePreset !== "custom"}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1">
              <div className="flex items-center justify-between rounded bg-neutral-900 px-2 py-1">
                <span className="text-[11px] text-neutral-400">Auto Jito Tip</span>
                <Switch checked={autoJitoTip} onCheckedChange={setAutoJitoTip} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-neutral-500">Jito Tip (SOL)</Label>
                <Input
                  type="number"
                  step="0.000001"
                  className="h-7 bg-background border-border text-xs"
                  value={jitoTipSol}
                  onChange={(e) => setJitoTipSol(e.target.value)}
                  disabled={autoJitoTip}
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] text-neutral-500">
              <span>Market Tip (p75): {jitoTipFloor ? `${jitoTipFloor.sol.p75.toFixed(6)} SOL` : "..."}</span>
              <span className={jitoTipStatus.className}>Status: {jitoTipStatus.label}</span>
            </div>

            <div className="grid grid-cols-2 gap-1">
              <Button
                onClick={createBuyBundle}
                disabled={!selectedToken || activeWallets.length === 0}
                className="h-7 bg-blue-500 hover:bg-blue-600 text-xs"
              >
                <Package className="w-3 h-3 mr-1" />
                Buy ({activeWallets.length})
              </Button>
              <Button
                onClick={createSellBundle}
                disabled={!selectedToken || activeWalletsWithTokens.length === 0}
                className="h-7 bg-orange-500 hover:bg-orange-600 text-xs"
              >
                <Send className="w-3 h-3 mr-1" />
                Sell ({activeWalletsWithTokens.length})
              </Button>
            </div>
            <div className="text-[8px] text-slate-500 text-center">
              Bundle for warming up liquidity • Use Rugpull for final exit
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Rugpull Section */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-1">
        <Card className="xl:col-span-12 bg-red-950/20 border-red-500/50">
          <CardHeader className="py-1 px-2">
              <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
              <Flame className="w-4 h-4 text-red-400" />
              RUGPULL
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 px-2 pb-2">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-1">
              <div className="space-y-1">
                <Label className="text-[10px] text-slate-600">Slippage %</Label>
                <Input
                  type="number"
                  placeholder="20"
                  value={rugpullSlippage}
                  onChange={(e) => setRugpullSlippage(e.target.value)}
                  className="h-7 bg-background border-border text-xs"
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-slate-600">Dev Wallet</Label>
                  <div className="flex items-center gap-1 text-[10px] text-slate-500">
                    <span>Connected</span>
                    <Switch checked={useConnectedDev} onCheckedChange={setUseConnectedDev} />
                  </div>
                </div>
                <Input
                  type="password"
                  placeholder="dev wallet private key"
                  value={devKey ? "*".repeat(Math.min(devKey.length, 20)) + (devKey.length > 20 ? "..." : "") : ""}
                  onChange={(e) => setDevKey(e.target.value)}
                  disabled={useConnectedDev}
                  className="h-7 bg-background border-border text-xs"
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-slate-600">Funder Wallet</Label>
                  <div className="flex items-center gap-1 text-[10px] text-slate-500">
                    <span>Connected</span>
                    <Switch checked={useConnectedFunder} onCheckedChange={setUseConnectedFunder} />
                  </div>
                </div>
                <Input
                  type="password"
                  placeholder="funder wallet private key"
                  value={funderKey ? "*".repeat(Math.min(funderKey.length, 20)) + (funderKey.length > 20 ? "..." : "") : ""}
                  onChange={(e) => setFunderKey(e.target.value)}
                  disabled={useConnectedFunder}
                  className="h-7 bg-background border-border text-xs"
                />
              </div>
            </div>
            <div className="text-[9px] text-slate-500">
              Gas funder: {useConnectedFunder
                ? connected
                  ? `${publicKey?.toBase58().slice(0, 8)}...${publicKey?.toBase58().slice(-4)}`
                  : "Not connected"
                : funderKey
                  ? "Manual key"
                  : "Not set"}
            </div>
            <div className="grid grid-cols-2 gap-1">
              <Button
                onClick={rugpullDevWallet}
                disabled={!selectedToken || (useConnectedDev ? !publicKey : !devKey.trim())}
                className="h-7 bg-red-600 hover:bg-red-700 text-xs"
              >
                <Flame className="w-3 h-3 mr-1" />
                Rugpull Dev
              </Button>
              <Button
                onClick={rugpullAllWallets}
                disabled={!selectedToken || activeWalletsWithTokens.length === 0}
                className="h-7 bg-red-600 hover:bg-red-700 text-xs"
              >
                <Flame className="w-3 h-3 mr-1" />
                Rugpull All ({activeWalletsWithTokens.length})
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-1">
        <Card className="bg-neutral-900 border-neutral-700">
          <CardHeader className="py-1 px-2">
            <div className="flex items-center justify-between">
            <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                <Wallet className="w-4 h-4" />
                WALLETS
              </CardTitle>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  placeholder="5"
                  value={walletCount}
                  onChange={(e) => setWalletCount(e.target.value)}
                  className="h-6 w-10 bg-background border-border text-xs"
                />
                <Button size="sm" onClick={generateWallets} className="h-6 px-2 bg-purple-500 hover:bg-purple-600 text-xs">
                  <Plus className="w-3 h-3" />
                </Button>
                <Button size="sm" variant="outline" onClick={clearWallets} className="h-6 px-2 border-neutral-700">
                  <Trash2 className="w-3 h-3" />
                </Button>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        onClick={distributeGas}
                        disabled={!connected || activeWallets.length === 0 || gasLoading}
                        className="h-6 px-2 bg-blue-600 hover:bg-blue-700 text-xs disabled:opacity-50"
                      >
                        {gasLoading ? (
                          <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <Zap className="w-3 h-3" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {connected
                        ? `Distribute 0.002 SOL to ${activeWallets.length} wallets from connected wallet`
                        : "Connect wallet to distribute gas"
                      }
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        onClick={createATAs}
                        disabled={!selectedToken || activeWallets.length === 0 || activeWallets.some(w => w.solBalance < 0.001) || ataLoading}
                        className="h-6 px-2 bg-purple-600 hover:bg-purple-700 text-xs disabled:opacity-50"
                      >
                        {ataLoading ? (
                          <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <Package className="w-3 h-3" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {activeWallets.some(w => w.solBalance < 0.001)
                        ? "Distribute Gas first - wallets need SOL for ATA creation"
                        : "Create Associated Token Accounts for selected wallets"
                      }
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
            <div className="text-[10px] text-slate-400">Selected: {selectedWalletCount}/{activeWallets.length} active</div>
          </CardHeader>
          <CardContent className="px-2 pb-2">
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="space-y-1">
                <Label className="text-[10px] text-slate-400">Manual Buy (SOL)</Label>
                <Input
                  type="number"
                  step="0.0001"
                  value={manualBuyAmount}
                  onChange={(e) => {
                    setManualBuyAmount(e.target.value)
                    setManualTradeDirty(true)
                  }}
                  className="h-6 bg-background border-border text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-slate-400">Manual Sell (%)</Label>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  value={manualSellPercent}
                  onChange={(e) => {
                    setManualSellPercent(e.target.value)
                    setManualTradeDirty(true)
                  }}
                  className="h-6 bg-background border-border text-xs"
                />
              </div>
            </div>
            <div className="flex justify-end mb-2">
              <Button
                size="sm"
                variant="outline"
                onClick={saveManualTradeSettings}
                disabled={!manualTradeDirty}
                className="h-6 px-2 border-neutral-700 text-[10px]"
              >
                Save
              </Button>
            </div>
            {/* Select All checkbox */}
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-slate-800">
              <input
                type="checkbox"
                className="h-3 w-3 accent-cyan-500"
                checked={selectedWalletCount === activeWallets.length && activeWallets.length > 0}
                onChange={(e) => {
                  if (e.target.checked) {
                    selectAllWallets()
                  } else {
                    clearSelectedWallets()
                  }
                }}
              />
              <span className="text-[10px] text-slate-400">Select All ({selectedWalletCount}/{activeWallets.length})</span>
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {bundlerWallets.length === 0 ? (
                <div className="text-slate-400 text-xs p-2 text-center">No wallets loaded</div>
              ) : (
                bundlerWallets.map((wallet) => (
                  <div
                    key={wallet.publicKey}
                    className={`p-2 rounded border text-[11px] flex items-center justify-between ${
                      wallet.isActive ? "border-cyan-500/30 bg-cyan-500/5" : "border-neutral-700 bg-neutral-800"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        className="h-3 w-3 accent-cyan-500 disabled:opacity-50"
                        checked={selectedWallets.has(wallet.publicKey)}
                        onChange={() => toggleWalletSelection(wallet.publicKey)}
                        disabled={!wallet.isActive}
                      />
                      <div className="min-w-0">
                        <div className="text-neutral-400 font-mono truncate">
                          {wallet.publicKey.slice(0, 8)}...{wallet.publicKey.slice(-4)}
                        </div>
                        <div className="flex gap-2 text-[10px] text-slate-500">
                          <span className="text-emerald-300/70">SOL: {wallet.solBalance.toFixed(3)}</span>
                          <span className="text-cyan-300/70">Tokens: {wallet.tokenBalance.toFixed(2)}</span>
                          <span className={wallet.ataExists ? "text-green-300/70" : "text-red-300/70"}>
                            ATA: {wallet.ataExists ? "✓" : "✗"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <Badge className={wallet.isActive ? "bg-green-500/20 text-green-400" : "bg-neutral-600"}>
                      {wallet.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-neutral-900 border-neutral-700">
          <CardHeader className="py-1 px-2">
            <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
              <Users className="w-4 h-4" />
              HOLDERS
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-2">
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {holdersLoading ? (
                <div className="text-slate-400 text-xs p-2 text-center">Loading holders...</div>
              ) : holderRows.length === 0 ? (
                <div className="text-slate-400 text-xs p-2 text-center">No holders yet</div>
              ) : (
                holderRows.map((wallet) => (
                  <div key={wallet.address} className="flex items-center justify-between text-[11px]">
                    <span className="font-mono text-neutral-400">
                      {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
                    </span>
                    <span className="text-white">
                      {wallet.balance.toFixed(2)} ({wallet.percentage.toFixed(2)}%)
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-neutral-900 border-neutral-700">
          <CardHeader className="py-1 px-2">
            <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
              <Activity className="w-4 h-4" />
              LIVE TRADES
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-2">
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {trades.length === 0 ? (
                <div className="text-slate-400 text-xs p-2 text-center">No trades yet</div>
              ) : (
                trades.slice(0, 6).map((trade) => (
                  <div key={trade.id} className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-2">
                      <Badge className={trade.type === "buy" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}>
                        {trade.type.toUpperCase()}
                      </Badge>
                      <span className="font-mono text-neutral-400">
                        {trade.mintAddress.slice(0, 6)}...{trade.mintAddress.slice(-4)}
                      </span>
                    </div>
                    <div className="text-right">
                      <div className="text-white">{trade.solAmount.toFixed(3)} SOL</div>
                      <div className="text-[10px] text-neutral-500">{formatTimeAgo(new Date(trade.timestamp).toISOString())}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* System Logs */}
      <div className="grid grid-cols-1 xl:grid-cols-1 gap-1">
        <Card className="bg-neutral-900 border-neutral-700">
          <CardHeader className="py-1 px-2">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400" />
                SYSTEM LOGS
              </CardTitle>
              <Button
                size="sm"
                variant="ghost"
                onClick={clearSystemLogs}
                className="h-6 px-2 text-[10px] text-slate-400 hover:text-slate-200"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-2 pb-2">
            <div className="space-y-1 max-h-32 overflow-y-auto bg-neutral-950 rounded p-2">
              {systemLogs.length === 0 && (!volumeBotStatus || volumeBotStatus.recentLogs?.length === 0) ? (
                <div className="text-slate-400 text-xs">No logs yet</div>
              ) : (
                <>
                  {/* System logs */}
                  {systemLogs.slice(0, 5).map((log, index) => (
                    <div key={`system-${index}`} className="text-[9px] font-mono text-slate-300">
                      {log}
                    </div>
                  ))}
                  {/* Volume bot logs */}
                  {volumeBotStatus?.recentLogs?.slice(0, 5).map((log: any, index: number) => (
                    <div key={`bot-${index}`} className="text-[9px] font-mono text-slate-300">
                      [{new Date(log.createdAt).toLocaleTimeString()}] {log.type.toUpperCase()}: {log.message}
                    </div>
                  ))}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="bg-neutral-900 border-neutral-700 max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-sm text-black">Volume Bot Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1">
              <div className="space-y-1">
                <Label className="text-xs text-neutral-400">Mode</Label>
                <Select value={volumeBotConfig.mode} onValueChange={(value: any) => setVolumeBotConfig(prev => ({ ...prev, mode: value }))}>
                  <SelectTrigger className="bg-background border-border text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wash">Wash Trading</SelectItem>
                    <SelectItem value="buy">Buy Only</SelectItem>
                    <SelectItem value="sell">Sell Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-neutral-400">Amount Mode</Label>
                <Select value={volumeBotConfig.amountMode} onValueChange={(value: any) => setVolumeBotConfig(prev => ({ ...prev, amountMode: value }))}>
                  <SelectTrigger className="bg-background border-border text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Fixed</SelectItem>
                    <SelectItem value="random">Random</SelectItem>
                    <SelectItem value="percentage">Percentage</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {volumeBotConfig.amountMode === "fixed" && (
              <div className="space-y-1">
                <Label className="text-xs text-neutral-400">Fixed Amount (SOL)</Label>
                <Input
                  type="number"
                  step="0.0001"
                  className="bg-background border-border text-xs"
                  value={volumeBotConfig.fixedAmount}
                  onChange={(e) => setVolumeBotConfig(prev => ({ ...prev, fixedAmount: e.target.value }))}
                />
              </div>
            )}

            {volumeBotConfig.amountMode === "random" && (
              <div className="grid grid-cols-2 gap-1">
                <div className="space-y-1">
                  <Label className="text-xs text-neutral-400">Min SOL</Label>
                  <Input
                    type="number"
                    step="0.0001"
                    className="bg-background border-border text-xs"
                    value={volumeBotConfig.minAmount}
                    onChange={(e) => setVolumeBotConfig(prev => ({ ...prev, minAmount: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-neutral-400">Max SOL</Label>
                  <Input
                    type="number"
                    step="0.0001"
                    className="bg-background border-border text-xs"
                    value={volumeBotConfig.maxAmount}
                    onChange={(e) => setVolumeBotConfig(prev => ({ ...prev, maxAmount: e.target.value }))}
                  />
                </div>
              </div>
            )}

            {volumeBotConfig.amountMode === "percentage" && (
              <div className="grid grid-cols-2 gap-1">
                <div className="space-y-1">
                  <Label className="text-xs text-neutral-400">Min %</Label>
                  <Input
                    type="number"
                    step="0.1"
                    className="bg-background border-border text-xs"
                    value={volumeBotConfig.minPercentage}
                    onChange={(e) => setVolumeBotConfig(prev => ({ ...prev, minPercentage: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-neutral-400">Max %</Label>
                  <Input
                    type="number"
                    step="0.1"
                    className="bg-background border-border text-xs"
                    value={volumeBotConfig.maxPercentage}
                    onChange={(e) => setVolumeBotConfig(prev => ({ ...prev, maxPercentage: e.target.value }))}
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-1">
              <div className="space-y-1">
                <Label className="text-xs text-neutral-400">Slippage %</Label>
                <Input
                  type="number"
                  step="0.1"
                  className="bg-background border-border text-xs"
                  value={volumeBotConfig.slippage}
                  onChange={(e) => setVolumeBotConfig(prev => ({ ...prev, slippage: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-neutral-400">Priority Fee (SOL)</Label>
                <Input
                  type="number"
                  step="0.0001"
                  className="bg-background border-border text-xs"
                  value={volumeBotConfig.priorityFee}
                  onChange={(e) => setVolumeBotConfig(prev => ({ ...prev, priorityFee: e.target.value }))}
                />
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
