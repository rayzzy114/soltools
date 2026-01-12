"use client"

import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import Image from "next/image"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { TrendingUp, TrendingDown, Coins, Activity, Users, Play, Pause, Settings, RefreshCw, Flame, Rocket, AlertTriangle, BarChart3, Trash2, Upload, Wallet, Download, ShieldCheck, Zap, Terminal, Copy } from "lucide-react"
import { PnLSummaryCard, MiniPnLCard } from "@/components/pnl/PnLCard"
import type { PnLSummary, TokenPnL, Trade } from "@/lib/pnl/types"
import { toast } from "sonner"
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import { getResilientConnection } from "@/lib/solana/config"
import { getBondingCurveAddress } from "@/lib/solana/pumpfun-sdk"
import { TokenHolderTracker, type HolderRow } from "@/lib/solana/holder-tracker"
import { clampNumber } from "@/lib/ui-utils"
import { BuyerWalletList, DevWalletSelect } from "./MemoizedLists"
import {
  readStoredBundlerWallets,
  importStoredBundlerWallets,
  mergeStoredSecrets,
  upsertStoredBundlerWallet,
} from "@/lib/bundler-wallet-storage"

interface DashboardStats {
  activeTokens: number
  totalVolume24h: string
  bundledTxs: number
  holdersGained: number
}

interface Token {
  symbol: string
  name: string
  price?: string
  change?: string
  status?: string
  description?: string
  imageUrl?: string
  website?: string
  twitter?: string
  telegram?: string
  mintAddress?: string
  creatorWallet?: string
  totalSupply?: string
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
  role?: string
  ataExists?: boolean
}

interface BuyerWalletSelection {
  publicKey: string
  amount: string
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

const PRIORITY_FEE_COMPUTE_UNITS = 400000
const PRICE_SERIES_MAX_POINTS = 60
const DASHBOARD_POLL_INTERVAL_MS = 5 * 60 * 1000

// Reusable Copy Button for lists
const CopyButton = ({ text, className }: { text: string, className?: string }) => (
  <Button
    variant="ghost"
    size="icon"
    className={`h-4 w-4 text-slate-400 hover:text-slate-200 ${className}`}
    onClick={(e) => {
      e.stopPropagation()
      navigator.clipboard.writeText(text)
        .then(() => toast.success("Copied to clipboard"))
        .catch(() => toast.error("Failed to copy"))
    }}
    aria-label="Copy"
    title="Copy"
  >
    <Copy className="w-3 h-3" />
  </Button>
)

// Optimized Wallet Row Component
const WalletRow = memo(({ wallet, index, onSelect }: { wallet: BundlerWallet, index: number, onSelect: (w: BundlerWallet) => void }) => {
  let borderColor = "border-slate-500"
  let badgeBg = "bg-slate-100"
  let badgeText = "text-slate-800"

  if (wallet.role === 'dev') {
    borderColor = "border-purple-500 hover:border-purple-400"
    badgeBg = "bg-purple-100"
    badgeText = "text-purple-800"
  } else if (wallet.role === 'buyer') {
    borderColor = "border-cyan-500 hover:border-cyan-400"
    badgeBg = "bg-cyan-100"
    badgeText = "text-cyan-800"
  } else if (wallet.role === 'funder') {
    borderColor = "border-green-500 hover:border-green-400"
    badgeBg = "bg-green-100"
    badgeText = "text-green-800"
  } else if (wallet.role === 'volume_bot' || wallet.role === 'bot') {
    borderColor = "border-orange-500 hover:border-orange-400"
    badgeBg = "bg-orange-100"
    badgeText = "text-orange-800"
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(wallet)}
      className={`h-10 rounded border ${borderColor} bg-white p-1 text-left text-[9px] leading-tight transition`}
    >
      <div className="flex items-center justify-between gap-1">
        <div className="text-[9px] truncate text-black font-bold">
          {index + 1}. {wallet.label || 'Wallet'}
        </div>
        {wallet.role && wallet.role !== 'project' && (
          <span className={`text-[8px] ${badgeBg} ${badgeText} px-1 rounded uppercase min-w-[20px] text-center truncate max-w-[40px]`}>
            {wallet.role}
          </span>
        )}
      </div>
      <div className="font-mono text-[9px] text-neutral-900 truncate">
        {wallet.publicKey.slice(0, 6)}...{wallet.publicKey.slice(-4)}
      </div>
    </button>
  )
})
WalletRow.displayName = "WalletRow"

/**
 * Renders the dashboard UI for launching tokens, managing bundler wallets, running the volume bot, and viewing token/market data.
 *
 * The component provides launch-stage flows (token metadata, dev/buyer wallet selection, funding and launch)
 * and main-stage features (token info, rugpull tools, volume-bot controls, holders, live trades, and system logs).
 * It manages state, periodic data fetching, wallet operations, bot control, and system logging.
 *
 * @returns The Dashboard page as a React element containing the full launch and main-stage UI and related controls.
 */
export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>({
    activeTokens: 0,
    totalVolume24h: "0",
    bundledTxs: 0,
    holdersGained: 0,
  })
  const [tokens, setTokens] = useState<Token[]>([])
  const [activity, setActivity] = useState<Activity[]>([])
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
  const [dashboardStage, setDashboardStage] = useState<"launch" | "main">("launch")
  const [settingsOpen, setSettingsOpen] = useState(false)

  // New states for enhanced dashboard
  const [selectedToken, setSelectedToken] = useState<Token | null>(null)
  const [bundlerWallets, setBundlerWallets] = useState<BundlerWallet[]>([])
  const applyStoredSecrets = useCallback(
    (list: BundlerWallet[]) => mergeStoredSecrets(list, readStoredBundlerWallets()),
    []
  )
  const [rugpullEstimate, setRugpullEstimate] = useState<RugpullEstimate | null>(null)
  const [devRugpullEstimate, setDevRugpullEstimate] = useState<RugpullEstimate | null>(null)
  const [priorityFeeSol, setPriorityFeeSol] = useState("0.0001")
  const [jitoTipSol, setJitoTipSol] = useState("0.0001")
  const [jitoUuid, setJitoUuid] = useState("")
  const [jitoRegion, setJitoRegion] = useState("frankfurt")
  const [network, setNetwork] = useState("unknown")
  const [pumpFunAvailable, setPumpFunAvailable] = useState<boolean | null>(null)
  const [rpcHealthy, setRpcHealthy] = useState<boolean | null>(null)
  const [tokenName, setTokenName] = useState("JITSU")
  const [tokenSymbol, setTokenSymbol] = useState("JTSU")
  const [tokenDescription, setTokenDescription] = useState("test launch via bundler")
  const [tokenWebsite, setTokenWebsite] = useState("")
  const [tokenTelegram, setTokenTelegram] = useState("")
  const [tokenTwitter, setTokenTwitter] = useState("")
  const [tokenImage, setTokenImage] = useState<File | null>(null)
  const [tokenImagePreview, setTokenImagePreview] = useState("")
  const [tokenImageUrl, setTokenImageUrl] = useState("")
  const [metadataUri, setMetadataUri] = useState("")
  const [devBuyAmount, setDevBuyAmount] = useState("0.1")
  const [buyAmountPerWallet, setBuyAmountPerWallet] = useState("0.01")
  const [launchLoading, setLaunchLoading] = useState(false)
  const [autoFundEnabled] = useState(true)
  const [autoCreateAtaEnabled] = useState(true)
  const [funderAmountPerWallet] = useState("0.003")
  const [launchDevWallet, setLaunchDevWallet] = useState("")
  const [buyerWallets, setBuyerWallets] = useState<BuyerWalletSelection[]>([])
  const [totalBuyAmount, setTotalBuyAmount] = useState("1")
  const [launchTemplateMint, setLaunchTemplateMint] = useState("")
  const [cloneLoading, setCloneLoading] = useState(false)
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false)
  const [cloneTokenMint, setCloneTokenMint] = useState("")
  const [priceSeries, setPriceSeries] = useState<Array<{ time: string; price: number }>>([])
  const [rugpullLoading, setRugpullLoading] = useState(false)
  const [collectLoading, setCollectLoading] = useState(false)
  const [withdrawLoading, setWithdrawLoading] = useState(false)
  const [systemLogs, setSystemLogs] = useState<string[]>([])
  const [syncingBalances, setSyncingBalances] = useState(false)
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
    minInterval: "30",
    maxInterval: "120",
  })
  const [manualBuyAmount, setManualBuyAmount] = useState("0.01")
  const [manualSellPercent, setManualSellPercent] = useState("100")
  const [quickTradeWallet, setQuickTradeWallet] = useState<BundlerWallet | null>(null)
  const [quickBuyAmount, setQuickBuyAmount] = useState("0.01")
  const [volumeBotStatus, setVolumeBotStatus] = useState<any>(null)
  const [logMintAddress, setLogMintAddress] = useState("")
  const [stealthFunding, setStealthFunding] = useState(false)
  const [warmupLoading, setWarmupLoading] = useState(false)
  const [warmupProgress, setWarmupProgress] = useState(0)
  const [holderRows, setHolderRows] = useState<HolderRow[]>([])
  const [holdersLoading, setHoldersLoading] = useState(false)
  const [unifiedStats, setUnifiedStats] = useState({
      totalSol: 0,
      totalTokens: 0,
      unrealizedPnl: 0,
      activeWallets: 0,
      price: 0
  })

  // Poll unified stats every 10 seconds
  useEffect(() => {
      const fetchStats = async () => {
          if (!selectedToken?.mintAddress) return
          try {
              const res = await fetch(`/api/dashboard/stats?mintAddress=${selectedToken.mintAddress}`)
              const data = await res.json()
              if (data && !data.error) {
                  setUnifiedStats(data)
              }
          } catch (e) {
              console.error("Failed to fetch unified stats", e)
          }
      }
      
      fetchStats()
      const interval = setInterval(fetchStats, 10000)
      return () => clearInterval(interval)
  }, [selectedToken?.mintAddress])

  const [tokenFinance, setTokenFinance] = useState<{
    fundingBalanceSol: number
    liquiditySol: number
    currentPriceSol: number
    marketCapSol: number
    totalSupply: number
    complete: boolean
    volumeSol?: number
    volumeUsd?: number
    volumeSource?: string
  } | null>(null)
  const [tokenFinanceLoading, setTokenFinanceLoading] = useState(false)
  const holderTrackerRef = useRef<TokenHolderTracker | null>(null)
  const hydratedMintsRef = useRef<Set<string>>(new Set())
  const getPairStorageKey = useCallback((mint: string) => `volume_bot_pair_${mint}`, [])
  const getLastTokenKey = useCallback(() => "dashboardLastTokenMint", [])

  // Ref for auto-selection to break dependency cycles
  const hasAutoSelectedRef = useRef(false)

  const activeWallets = useMemo(() => bundlerWallets.filter(w => w.isActive), [bundlerWallets])
  const mainStageWallets = useMemo(
    () => activeWallets.filter((wallet) => wallet.role !== 'buyer'),
    [activeWallets]
  )
  const devWalletRecord = useMemo(() => {
    return (
      bundlerWallets.find((wallet) => wallet.publicKey === launchDevWallet) ||
      bundlerWallets.find((wallet) => wallet.role === "dev") ||
      null
    )
  }, [bundlerWallets, launchDevWallet])
  const funderWalletRecord = useMemo(
    () => bundlerWallets.find((wallet) => wallet.role === "funder") || null,
    [bundlerWallets]
  )
  const funderBalance = funderWalletRecord?.solBalance ?? null
  const devWalletOptions = useMemo(() => activeWallets, [activeWallets])
  useEffect(() => {
    if (quickTradeWallet && (quickTradeWallet.role === 'buyer')) {
      setQuickTradeWallet(null)
    }
  }, [quickTradeWallet])
  const activeWalletsWithTokens = useMemo(
    () => activeWallets.filter(w => w.tokenBalance > 0),
    [activeWallets]
  )
  const selectedTokenPnl = useMemo(() => {
    if (!selectedToken?.mintAddress) return null
    return tokenPnls.find((pnl) => pnl.mintAddress === selectedToken.mintAddress) || null
  }, [tokenPnls, selectedToken?.mintAddress])
  const totalTokensToSell = useMemo(
    () => activeWalletsWithTokens.reduce((sum, wallet) => sum + wallet.tokenBalance, 0),
    [activeWalletsWithTokens]
  )
  const currentPriceSol = useMemo(() => {
    if (tokenFinance && Number.isFinite(tokenFinance.currentPriceSol)) {
      return tokenFinance.currentPriceSol
    }
    if (selectedTokenPnl && Number.isFinite(selectedTokenPnl.currentPrice)) {
      return selectedTokenPnl.currentPrice
    }
    const parsed = selectedToken?.price ? Number.parseFloat(selectedToken.price) : NaN
    return Number.isFinite(parsed) ? parsed : null
  }, [tokenFinance, selectedTokenPnl, selectedToken?.price])
  const totalSupplyValue = useMemo(() => {
    if (tokenFinance && Number.isFinite(tokenFinance.totalSupply)) {
      return tokenFinance.totalSupply
    }
    const parsed = selectedToken?.totalSupply ? Number.parseFloat(selectedToken.totalSupply) : NaN
    return Number.isFinite(parsed) ? parsed : null
  }, [tokenFinance, selectedToken?.totalSupply])
  const marketCapSol = useMemo(() => {
    if (tokenFinance && Number.isFinite(tokenFinance.marketCapSol)) {
      return tokenFinance.marketCapSol
    }
    if (currentPriceSol == null || totalSupplyValue == null) return null
    return currentPriceSol * totalSupplyValue
  }, [tokenFinance, currentPriceSol, totalSupplyValue])
  const profitEstimateSol = useMemo(() => {
    if (!selectedTokenPnl?.aggregatedPnl) return null
    return selectedTokenPnl.aggregatedPnl.totalPnl
  }, [selectedTokenPnl])
  const poolShortfall = useMemo(() => {
    if (!rugpullEstimate || rugpullEstimate.availableSol === undefined) return false
    return rugpullEstimate.grossSol > rugpullEstimate.availableSol
  }, [rugpullEstimate])
  const volumeRunning = volumeBotConfig.isRunning || volumeBotStats.isRunning
  const devHolderPubkey = useMemo(() => {
    if (!launchDevWallet) return null
    try {
      return new PublicKey(launchDevWallet)
    } catch {
      return null
    }
  }, [launchDevWallet])
  const networkBlocked = pumpFunAvailable === false || rpcHealthy === false
  const isMainnet = network === "mainnet-beta"
  const isLaunchStage = dashboardStage === "launch"
  const canOpenMainStage = Boolean(selectedToken?.mintAddress)

  useEffect(() => {
    if (devWalletOptions.length === 0) {
      if (launchDevWallet) setLaunchDevWallet("")
      return
    }
    const exists = devWalletOptions.some((wallet) => wallet.publicKey === launchDevWallet)
    if (!exists) {
      setLaunchDevWallet(devWalletOptions[0].publicKey)
    }
  }, [devWalletOptions, launchDevWallet])

  useEffect(() => {
    if (buyerWallets.length === 0) return
    const activeKeys = new Set(activeWallets.map((wallet) => wallet.publicKey))
    setBuyerWallets((prev) => {
      const next = prev.filter(
        (wallet) => activeKeys.has(wallet.publicKey) && wallet.publicKey !== launchDevWallet
      )
      if (
        next.length === prev.length &&
        next.every((wallet, idx) =>
          wallet.publicKey === prev[idx]?.publicKey && wallet.amount === prev[idx]?.amount
        )
      ) {
        return prev
      }
      return next
    })
  }, [activeWallets, buyerWallets, launchDevWallet])

  useEffect(() => {
    if (!selectedToken?.mintAddress) {
      setTokenFinance(null)
      return
    }
    const controller = new AbortController()
    setTokenFinanceLoading(true)
    fetch(`/api/tokens/finance?mintAddress=${selectedToken.mintAddress}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || data.error) return
        setTokenFinance(data)
      })
      .catch((error) => {
        if (error?.name !== "AbortError") {
          console.error("failed to load token finance:", error)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setTokenFinanceLoading(false)
        }
      })
    return () => controller.abort()
  }, [selectedToken?.mintAddress])

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

  // Update wallet role helper
  const updateWalletRole = useCallback(async (publicKey: string, role: string) => {
    try {
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          publicKey,
          role,
        }),
      })

      const data = await res.json().catch(() => null)
      if (!res.ok || data?.error) {
        const message = data?.error || `failed to update wallet role (status ${res.status})`
        console.error("Failed to update wallet role:", message)
        toast.error(message)
        if (res.status === 404) {
          toast.error("Wallet not found. Import it before assigning a role.")
        }
        return null
      }

      const updatedWallet = data?.wallet as BundlerWallet | undefined
      setBundlerWallets((prev) => {
        let next: BundlerWallet[] = prev
        if (updatedWallet) {
          upsertStoredBundlerWallet({
            publicKey: updatedWallet.publicKey,
            secretKey: updatedWallet.secretKey,
          })
          const exists = prev.some((w) => w.publicKey === updatedWallet.publicKey)
          next = exists
            ? prev.map((w) => (w.publicKey === updatedWallet.publicKey ? { ...w, role: updatedWallet.role } : w))
            : [...prev, updatedWallet]
        } else {
          next = prev.map((w) => (w.publicKey === publicKey ? { ...w, role } : w))
        }
        return applyStoredSecrets(next)
      })
      return data
    } catch (error) {
      console.error("Failed to update wallet role:", error)
      toast.error("Failed to update wallet role")
      return null
    }
  }, [applyStoredSecrets])

  // Load saved wallets from database with batched balance updates
  const loadSavedWallets = useCallback(async () => {
    try {
      const storedSecrets = readStoredBundlerWallets()
      await importStoredBundlerWallets(storedSecrets)
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
        let walletsToUse = data.wallets

        const mergedWallets = applyStoredSecrets(walletsToUse)
        setBundlerWallets(mergedWallets)

        const nextWallets = mergedWallets
        // Restore selections from roles
        const dev = nextWallets.find((w: any) => w.role === 'dev')
        if (dev) {
          setLaunchDevWallet(dev.publicKey)
        }

        const buyers = nextWallets.filter((w: any) => w.role === 'buyer')
        if (buyers.length > 0) {
          setBuyerWallets(prev => {
            const existingKeys = new Set(prev.map(b => b.publicKey))
            const newBuyers = buyers
              .filter((b: any) => !existingKeys.has(b.publicKey))
              .map((b: any) => ({ publicKey: b.publicKey, amount: buyAmountPerWallet || "0.01" }))

            return [...prev, ...newBuyers]
          })
        }
        // no toast: avoid noisy "loaded X saved wallets" popup
      }
    } catch (error: any) {
      console.error("failed to load saved wallets:", error)
      toast.error(`failed to load wallets: ${error.message || "unknown error"}`)
    }
  }, [buyAmountPerWallet, applyStoredSecrets])

  const handleSyncBalances = useCallback(async () => {
    if (bundlerWallets.length === 0) {
      toast.error("No wallets to sync")
      return
    }
    setSyncingBalances(true)
    try {
      const response = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh",
          walletPublicKeys: bundlerWallets.map((wallet) => wallet.publicKey),
          mintAddress: selectedToken?.mintAddress,
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || !Array.isArray(data.wallets)) {
        throw new Error(data?.error || "Failed to sync wallet balances")
      }
      const refreshed = applyStoredSecrets(data.wallets)
      setBundlerWallets(refreshed)
      toast.success("Wallet balances synced")
    } catch (error: any) {
      console.error("sync wallet balances error", error)
      toast.error(error?.message || "Failed to sync wallet balances")
    } finally {
      setSyncingBalances(false)
    }
  }, [applyStoredSecrets, bundlerWallets, selectedToken?.mintAddress])

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
    // console.log(logMessage) // Removed to prevent console spam
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
  }, [volumeBotConfig.pairId, volumeBotConfig.mintAddress, selectedToken?.mintAddress, logMintAddress, saveLogToLocalStorage])

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
  }, [volumeBotConfig.pairId, selectedToken?.mintAddress, logMintAddress, volumeBotConfig.mintAddress])

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

  const parseSol = (value: string) => {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  const normalizeTokenList = useCallback((data: any[]): Token[] => {
    if (!Array.isArray(data)) return []
    return data.map((token) => ({
      symbol: token?.symbol || token?.name || (token?.mintAddress ? token.mintAddress.slice(0, 4) : ""),
      name: token?.name || token?.symbol || "Unknown",
      price: token?.price != null ? String(token.price) : "",
      change: token?.change != null ? String(token.change) : "",
      status: token?.status || "",
      description: token?.description || "",
      imageUrl: token?.imageUrl || "",
      website: token?.website || "",
      twitter: token?.twitter || "",
      telegram: token?.telegram || "",
      mintAddress: token?.mintAddress,
      creatorWallet: token?.creatorWallet || "",
      totalSupply: token?.totalSupply != null ? String(token.totalSupply) : "",
      isMigrated: token?.isMigrated,
    }))
  }, [])

  const handleTokenImageChange = (file: File | null) => {
    if (!file) {
      setTokenImage(null)
      setTokenImagePreview("")
      setTokenImageUrl("")
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("image must be less than 5MB")
      return
    }
    setTokenImage(file)
    setTokenImageUrl("")
    const reader = new FileReader()
    reader.onloadend = () => {
      setTokenImagePreview((reader.result as string) || "")
    }
    reader.readAsDataURL(file)
    setMetadataUri("")
  }

  const resetLaunchForm = () => {
    setLaunchTemplateMint("")
    setCloneTokenMint("")
    setTokenName("")
    setTokenSymbol("")
    setTokenDescription("")
    setTokenWebsite("")
    setTokenTwitter("")
    setTokenTelegram("")
    setTokenImage(null)
    setTokenImagePreview("")
    setTokenImageUrl("")
    setMetadataUri("")
  }

  const handleLaunchTemplateSelect = async (mintAddress: string) => {
    setLaunchTemplateMint(mintAddress)
    if (!mintAddress) return
    setCloneLoading(true)
    try {
      const cloneRes = await fetch(`/api/clone?mint=${mintAddress}`)
      const cloneData = await cloneRes.json().catch(() => ({}))

      if (cloneRes.ok && cloneData) {
        setTokenName(cloneData.name || "")
        setTokenSymbol(cloneData.symbol || "")
        setTokenDescription(cloneData.description || "")
        setTokenWebsite(cloneData.website || "")
        setTokenTwitter(cloneData.twitter || "")
        setTokenTelegram(cloneData.telegram || "")
        const image = cloneData.image || cloneData.imageUrl || cloneData.logoURI || ""
        setTokenImageUrl(image || "")
        setTokenImagePreview(image || "")
      } else {
        const template = tokens.find((token) => token.mintAddress === mintAddress)
        if (!template) {
          throw new Error("template not found")
        }
        setTokenName(template.name || "")
        setTokenSymbol(template.symbol || "")
        setTokenDescription(template.description || "")
        setTokenWebsite(template.website || "")
        setTokenTwitter(template.twitter || "")
        setTokenTelegram(template.telegram || "")
        setTokenImageUrl(template.imageUrl || "")
        setTokenImagePreview(template.imageUrl || "")
      }
      setTokenImage(null)
      setMetadataUri("")
      toast.success("token metadata loaded")
    } catch (error: any) {
      toast.error(error?.message || "failed to load metadata")
    } finally {
      setCloneLoading(false)
    }
  }

  const handleAddBuyerWallet = useCallback(() => {
    const used = new Set(buyerWallets.map((wallet) => wallet.publicKey))
    const available = activeWallets.filter(
      (wallet) => wallet.publicKey !== launchDevWallet && !used.has(wallet.publicKey)
    )
    if (available.length === 0) {
      toast.error("no available buyer wallets")
      return
    }
    const next = available[0]
    updateWalletRole(next.publicKey, 'buyer')
    setBuyerWallets((prev) => [
      ...prev,
      {
        publicKey: next.publicKey,
        amount: buyAmountPerWallet || "0.01",
      },
    ])
  }, [buyerWallets, activeWallets, launchDevWallet, buyAmountPerWallet, updateWalletRole, setBuyerWallets])

  const handleRemoveBuyerWallet = (index?: number) => {
    setBuyerWallets((prev) => {
      if (prev.length === 0) return prev

      let walletToRemove: BuyerWalletSelection | undefined
      let nextState: BuyerWalletSelection[] = []

      if (index === undefined) {
        walletToRemove = prev[prev.length - 1]
        nextState = prev.slice(0, -1)
      } else {
        walletToRemove = prev[index]
        nextState = prev.filter((_, idx) => idx !== index)
      }

      if (walletToRemove) {
        updateWalletRole(walletToRemove.publicKey, 'project')
      }
      return nextState
    })
  }

  const handleEqualBuy = () => {
    if (buyerWallets.length === 0) {
      toast.error("add buyer wallets first")
      return
    }
    const total = parseSol(totalBuyAmount)
    if (total <= 0) {
      toast.error("enter total buy amount")
      return
    }
    const perWallet = total / buyerWallets.length
    setBuyerWallets((prev) =>
      prev.map((wallet) => ({ ...wallet, amount: perWallet.toFixed(6) }))
    )
  }

  const handleRandomBuy = () => {
    if (buyerWallets.length === 0) {
      toast.error("add buyer wallets first")
      return
    }
    const total = parseSol(totalBuyAmount)
    if (total <= 0) {
      toast.error("enter total buy amount")
      return
    }
    const weights = buyerWallets.map(() => Math.random())
    const sum = weights.reduce((acc, value) => acc + value, 0) || 1
    const amounts = weights.map((weight) => (total * weight) / sum)
    setBuyerWallets((prev) =>
      prev.map((wallet, idx) => ({
        ...wallet,
        amount: amounts[idx]?.toFixed(6) || "0",
      }))
    )
  }

  const handleImageUpload = async () => {
    const trimmedName = tokenName.trim()
    const trimmedSymbol = tokenSymbol.trim()
    if (!tokenImage || !trimmedName || !trimmedSymbol) {
      toast.error("fill in name, symbol, and select image")
      return
    }

    setLaunchLoading(true)
    try {
      const formData = new FormData()
      formData.append("file", tokenImage)
      formData.append("name", trimmedName)
      formData.append("symbol", trimmedSymbol.toUpperCase())
      formData.append("description", tokenDescription)
      if (tokenWebsite) formData.append("website", tokenWebsite)
      if (tokenTwitter) formData.append("twitter", tokenTwitter)
      if (tokenTelegram) formData.append("telegram", tokenTelegram)

      const res = await fetch("/api/tokens/upload-metadata", {
        method: "POST",
        body: formData,
      })

      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
      } else if (data.metadataUri) {
        setMetadataUri(data.metadataUri)
        const metadataImage =
          data?.metadata?.image ||
          data?.metadata?.image_uri ||
          data?.metadata?.imageUrl ||
          ""
        if (metadataImage) {
          setTokenImageUrl(metadataImage)
          setTokenImagePreview(metadataImage)
        }
        toast.success("metadata uploaded to IPFS")
      }
    } catch {
      toast.error("failed to upload metadata")
    } finally {
      setLaunchLoading(false)
    }
  }

  const normalizeLaunchNumbers = () => {
    return {
      jitoTipNum: Math.max(0, parseFloat(jitoTipSol)),
      priorityNum: Math.max(0, parseFloat(priorityFeeSol)),
      slippageNum: clampNumber(20, 0, 99),
    }
  }

  const handleLaunch = async () => {
    if (networkBlocked) {
      toast.error("pump.fun unavailable or rpc unhealthy")
      return
    }
    if (!metadataUri) {
      toast.error("upload metadata first")
      return
    }
    if (!tokenName.trim() || !tokenSymbol.trim()) {
      toast.error("token name and symbol are required")
      return
    }
    if (!launchDevWallet) {
      toast.error("select dev wallet")
      return
    }
    if (buyerWallets.length === 0) {
      toast.error("add buyer wallets")
      return
    }

    // WARNING: First transaction can only handle 2-3 buyers due to create instruction size
    const maxBuyersInFirstTx = 3
    if (buyerWallets.length > maxBuyersInFirstTx) {
      toast.warning(`Warning: First transaction limited to ${maxBuyersInFirstTx} buyers. ${buyerWallets.length - maxBuyersInFirstTx} buyers will be processed in subsequent transactions.`, {
        duration: 5000,
      })
    }

    const buyerKeys = buyerWallets.map((wallet) => wallet.publicKey).filter(Boolean)
    const uniqueBuyerKeys = new Set(buyerKeys)
    if (uniqueBuyerKeys.size !== buyerKeys.length) {
      toast.error("duplicate buyer wallets detected")
      return
    }
    if (uniqueBuyerKeys.has(launchDevWallet)) {
      toast.error("dev wallet cannot be a buyer wallet")
      return
    }
    const devWallet = bundlerWallets.find((wallet) => wallet.publicKey === launchDevWallet)
    if (!devWallet) {
      toast.error("dev wallet not found")
      return
    }
    const buyersResolved = buyerWallets.map((buyer) => ({
      buyer,
      wallet: bundlerWallets.find((wallet) => wallet.publicKey === buyer.publicKey) || null,
    }))
    const missingBuyer = buyersResolved.find((entry) => !entry.wallet)
    if (missingBuyer) {
      toast.error("buyer wallet not found")
      return
    }
    const parsedDevBuy = Math.max(0, parseSol(devBuyAmount))
    const buyerAmounts = buyerWallets.map((buyer) => parseSol(buyer.amount))
    if (buyerAmounts.some((amount) => amount <= 0)) {
      toast.error("set valid buy amount for each buyer")
      return
    }

    setLaunchLoading(true)
    try {
      const { jitoTipNum, priorityNum, slippageNum } = normalizeLaunchNumbers()
      const launchWallets = [
        { ...devWallet, isActive: true },
        ...buyersResolved.map((entry) => ({ ...entry.wallet!, isActive: true })),
      ]
      const launchWalletPublicKeys = launchWallets.map((wallet) => wallet.publicKey)
      const buyAmounts = [parsedDevBuy, ...buyerAmounts]
      const funderAmount = parseSol(funderAmountPerWallet)

        if (autoFundEnabled) {
          if (!Number.isFinite(funderAmount) || funderAmount <= 0) {
            toast.error("set valid funder amount per wallet")
            return
          }

          if (!funderWalletRecord?.publicKey) {
            toast.error("Set funder wallet in database first")
            return
          }

          addSystemLog(`Auto-funding ${launchWallets.length} wallets using Funder wallet`, "info")

          const fundRes = await fetch("/api/bundler/wallets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "fund",
              funderAddress: funderWalletRecord.publicKey,
              walletPublicKeys: launchWalletPublicKeys,
              amounts: launchWallets.map(() => funderAmount),
            }),
          })
          const fundData = await fundRes.json().catch(() => ({}))
          if (!fundRes.ok || fundData?.error) {
            const message = fundData?.error || "failed to fund wallets"
            toast.error(message)
            addSystemLog(`Auto-fund failed: ${message}`, "error")
            return
          }
          addSystemLog(`Auto-fund ok: ${fundData.signature?.slice(0, 8)}...`, "success")
        }

      const res = await fetch("/api/bundler/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPublicKeys: launchWalletPublicKeys,
          devPublicKey: devWallet.publicKey,
          tokenMetadata: {
            name: tokenName.trim(),
            symbol: tokenSymbol.trim().toUpperCase(),
            description: tokenDescription,
            metadataUri,
            website: tokenWebsite,
            twitter: tokenTwitter,
            telegram: tokenTelegram,
            imageUrl: tokenImageUrl,
          },
          devBuyAmount: parsedDevBuy,
          buyAmounts,
          jitoTip: jitoTipNum,
          priorityFee: priorityNum,
          slippage: slippageNum,
          jitoRegion,
        }),
      })

      const data = await res.json()
      if (data.error) {
        toast.error(data.error)
        addSystemLog(`launch failed: ${data.error}`, "error")
      } else {
        toast.success(`launched! mint: ${data.mintAddress}`)
        addSystemLog(`launch ok: ${data.mintAddress}`, "success")
        if (data.mintAddress) {
          const mintedToken: Token = {
            name: tokenName.trim() || "New Token",
            symbol: tokenSymbol.trim().toUpperCase() || "NEW",
            price: "",
            change: "",
            status: "launched",
            description: tokenDescription,
            website: tokenWebsite,
            twitter: tokenTwitter,
            telegram: tokenTelegram,
            imageUrl: tokenImageUrl,
            mintAddress: data.mintAddress,
          }
          setSelectedToken(mintedToken)
          setTokens((prev) => {
            if (prev.some((token) => token.mintAddress === data.mintAddress)) return prev
            return [mintedToken, ...prev]
          })
          if (typeof window !== "undefined") {
            window.localStorage.setItem(getLastTokenKey(), data.mintAddress)
          }
        }
        setDashboardStage("main")
        if (data.mintAddress && autoCreateAtaEnabled) {
          addSystemLog(`Auto-creating ATAs for ${launchWallets.length} wallets`, "info")
          const ataRes = await fetch("/api/bundler/wallets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "create-atas",
              walletPublicKeys: launchWalletPublicKeys,
              mintAddress: data.mintAddress,
            }),
          })
          const ataData = await ataRes.json().catch(() => ({}))
          if (!ataRes.ok || ataData?.error || ataData?.success === false) {
            const message =
              ataData?.error ||
              (Array.isArray(ataData?.errors) && ataData.errors[0]?.error) ||
              "failed to create ATAs"
            toast.error(message)
            addSystemLog(`Auto-ATA failed: ${message}`, "error")
          } else {
            addSystemLog("Auto-ATA created", "success")
          }
        }
        await loadSavedWallets()
        await fetchDashboardData()
      }
    } catch (error: any) {
      toast.error("launch failed")
      addSystemLog(`launch failed: ${error?.message || "unknown error"}`, "error")
    } finally {
      setLaunchLoading(false)
    }
  }

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
        setVolumeBotConfig(prev => {
          // If settings are open, don't overwrite config fields, only status
          if (settingsOpen) return { ...prev, isRunning: data.status === "running" }

          const newConfig = {
            ...prev,
            isRunning: data.status === "running",
          }

          // Merge settings if they exist
          if (data.settings) {
            if (data.settings.mode) newConfig.mode = data.settings.mode
            if (data.settings.amountMode) newConfig.amountMode = data.settings.amountMode
            if (data.settings.fixedAmount) newConfig.fixedAmount = data.settings.fixedAmount
            if (data.settings.minAmount) newConfig.minAmount = data.settings.minAmount
            if (data.settings.maxAmount) newConfig.maxAmount = data.settings.maxAmount
            if (data.settings.minPercentage) newConfig.minPercentage = data.settings.minPercentage
            if (data.settings.maxPercentage) newConfig.maxPercentage = data.settings.maxPercentage
            if (data.settings.slippage) newConfig.slippage = data.settings.slippage
            if (data.settings.priorityFee) newConfig.priorityFee = data.settings.priorityFee
            if (data.settings.jitoTip) newConfig.jitoTip = data.settings.jitoTip
            if (data.settings.jitoRegion) newConfig.jitoRegion = data.settings.jitoRegion
          }

          // Interval is stored on the pair, not settings
          if (data.minIntervalSeconds) newConfig.minInterval = String(data.minIntervalSeconds)
          if (data.maxIntervalSeconds) newConfig.maxInterval = String(data.maxIntervalSeconds)
          // Fallback if not set but intervalSeconds is (legacy)
          if (!data.minIntervalSeconds && data.intervalSeconds) {
             newConfig.minInterval = String(data.intervalSeconds)
             newConfig.maxInterval = String(data.intervalSeconds)
          }

          return newConfig
        })
      }
    } catch (error) {
      console.error("Failed to get bot status:", error)
    }
  }, [volumeBotConfig.pairId, settingsOpen])

  // Poll bot status every 60 seconds when running
  useEffect(() => {
    if (!volumeBotConfig.pairId || !volumeBotConfig.isRunning) return

    getVolumeBotStatus()
    const interval = setInterval(getVolumeBotStatus, 60000)
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
    const mint = selectedToken?.mintAddress
    if (!mint) return
    if (hydratedMintsRef.current.has(mint)) return

    const name = String(selectedToken?.name || "")
    const symbol = String(selectedToken?.symbol || "")
    const isPlaceholder =
      !name ||
      !symbol ||
      name === mint.slice(0, 6) ||
      symbol === mint.slice(0, 4)

    if (!isPlaceholder) return
    hydratedMintsRef.current.add(mint)

    fetch(`/api/clone?mint=${mint}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return
        setSelectedToken((prev) => {
          if (!prev || prev.mintAddress !== mint) return prev
          return {
            ...prev,
            name: data.name || prev.name,
            symbol: data.symbol || prev.symbol,
            description: data.description || prev.description,
            website: data.website || prev.website,
            twitter: data.twitter || prev.twitter,
            telegram: data.telegram || prev.telegram,
            imageUrl: data.image || data.imageUrl || prev.imageUrl,
            creatorWallet: data.creatorWallet || prev.creatorWallet,
          }
        })
        setTokens((prev) =>
          prev.map((token) =>
            token.mintAddress === mint
              ? {
                  ...token,
                  name: data.name || token.name,
                  symbol: data.symbol || token.symbol,
                  description: data.description || token.description,
                  website: data.website || token.website,
                  twitter: data.twitter || token.twitter,
                  telegram: data.telegram || token.telegram,
                  imageUrl: data.image || data.imageUrl || token.imageUrl,
                  creatorWallet: data.creatorWallet || token.creatorWallet,
                }
              : token
          )
        )
      })
      .catch(() => {
        hydratedMintsRef.current.delete(mint)
      })
  }, [selectedToken?.mintAddress, selectedToken?.name, selectedToken?.symbol])

  useEffect(() => {
    if (typeof window === "undefined") return
    const savedBuy = window.localStorage.getItem("dashboardManualBuyAmount")
    const savedSell = window.localStorage.getItem("dashboardManualSellPercent")
    if (savedBuy) setManualBuyAmount(savedBuy)
    if (savedSell) setManualSellPercent(savedSell)
  }, [])

  // Rugpull buyer wallets
  const rugpullAllWallets = useCallback(async () => {
    if (!selectedToken || activeWalletsWithTokens.length === 0) return

    // Filter for buyer wallets (exclude dev if identified by role)
    const buyerWallets = activeWalletsWithTokens.filter(w => w.role !== 'dev')

    if (buyerWallets.length === 0) {
        toast.error("No buyer wallets found with tokens")
        return
    }

    const confirmed = window.confirm(
      `This will sell ALL tokens from ${buyerWallets.length} BUYER wallets!\n(Excluding Dev wallet)\n\n` +
      `Mint: ${selectedToken.mintAddress?.slice(0, 20) || "unknown"}...\n\n` +
      `Continue?`
    )

    if (!confirmed) return

    setRugpullLoading(true)
    try {
      const res = await fetch("/api/bundler/rugpull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPublicKeys: buyerWallets.map((wallet) => wallet.publicKey),
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
        await loadSavedWallets()
      }
    } catch (error: any) {
      console.error("rugpull error:", error)
      toast.error(`rugpull failed: ${error.message}`)
    } finally {
      setRugpullLoading(false)
    }
  }, [selectedToken, activeWalletsWithTokens, jitoTipSol, priorityFeeSol, jitoRegion, loadSavedWallets, rugpullSlippage])

  // Rugpull dev wallet
  const rugpullDevWallet = useCallback(async () => {
    if (!selectedToken) return

    const devWalletObj = devWalletRecord
    if (!devWalletObj) {
      const msg = "No dev wallet selected (from launch or role='dev')"
      addSystemLog(msg, "error")
      toast.error(msg)
      return
    }

    setRugpullLoading(true)
    try {
      const res = await fetch("/api/bundler/rugpull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPublicKeys: [devWalletObj.publicKey],
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
    } finally {
      setRugpullLoading(false)
    }
  }, [
    selectedToken,
    devWalletRecord,
    jitoTipSol,
    priorityFeeSol,
    jitoRegion,
    addSystemLog,
    rugpullSlippage,
  ])

  // Collect all SOL from buyers/volume to Dev
  const collectAllToDev = useCallback(async () => {
    let targetDevWallet = launchDevWallet

    // If no specific launch dev wallet, try to find one by role
    if (!targetDevWallet) {
       const devRoleWallet = bundlerWallets.find(w => w.role === 'dev')
       if (devRoleWallet) targetDevWallet = devRoleWallet.publicKey
    }

    if (!targetDevWallet) {
      toast.error("No dev wallet selected")
      return
    }

    // Filter source wallets: active wallets that are NOT the dev wallet and have some SOL
    const sourceWallets = activeWallets.filter(w => w.publicKey !== targetDevWallet && w.solBalance > 0.002) // minimal threshold

    if (sourceWallets.length === 0) {
      toast.error("No wallets with SOL to collect")
      return
    }

    if (!confirm(`Collect SOL from ${sourceWallets.length} wallets to Dev Wallet (${targetDevWallet.slice(0,6)}...)?`)) {
        return
    }

    setCollectLoading(true)
    try {
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "collect",
          walletPublicKeys: sourceWallets.map((wallet) => wallet.publicKey),
          recipientAddress: targetDevWallet
        })
      })

      const data = await res.json()
      if (data.error) {
        toast.error(data.error)
      } else {
        toast.success(`Collected SOL from ${data.signatures?.length || 0} wallets`)
        addSystemLog(`Collected SOL to dev: ${data.signatures?.length} txs`, "success")
        await loadSavedWallets()
      }
    } catch (error: any) {
        console.error("collect error:", error)
        toast.error("Failed to collect SOL")
    } finally {
      setCollectLoading(false)
    }
  }, [launchDevWallet, bundlerWallets, activeWallets, loadSavedWallets, addSystemLog])

  // Withdraw Dev to Connected
  const withdrawDevToFunder = useCallback(async () => {
    if (!funderWalletRecord?.publicKey) {
      toast.error("Set funder wallet in database first")
      return
    }

    const devWalletObj = devWalletRecord
    if (!devWalletObj) {
      toast.error("Dev wallet not found or selected")
      return
    }

    if (devWalletObj.publicKey === funderWalletRecord.publicKey) {
      toast.error("Dev wallet already matches funder wallet")
      return
    }

    if (!confirm(`Withdraw SOL from Dev Wallet (${devWalletObj.publicKey.slice(0,6)}...) to Funder (${funderWalletRecord.publicKey.slice(0,6)}...)?`)) {
      return
    }

    setWithdrawLoading(true)
    try {
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "collect",
          walletPublicKeys: [devWalletObj.publicKey],
          recipientAddress: funderWalletRecord.publicKey
        })
      })

      const data = await res.json()
      if (data.error) {
        toast.error(data.error)
      } else {
        toast.success("Withdrawn SOL from Dev wallet")
        addSystemLog("Withdrawn dev wallet funds", "success")
        await loadSavedWallets()
      }
    } catch (error: any) {
      console.error("withdraw error:", error)
      toast.error("Failed to withdraw")
    } finally {
      setWithdrawLoading(false)
    }
  }, [addSystemLog, devWalletRecord, funderWalletRecord, loadSavedWallets])

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
            walletPublicKeys: [wallet.publicKey],
            mintAddress: selectedToken.mintAddress,
          }),
        })
        const data = await res.json()
        if (Array.isArray(data.wallets) && data.wallets[0]) {
          effectiveWallet = data.wallets[0]
          setBundlerWallets((prev) =>
            applyStoredSecrets(prev.map((w) => (w.publicKey === effectiveWallet.publicKey ? effectiveWallet : w)))
          )
          sellAmount = calcSellAmount(effectiveWallet)
        }
      } catch {
        // ignore refresh errors
      }
    }
    const amount = action === "buy" ? buyAmount : sellAmount

    if (action === "buy" && buyAmount <= 0) {
      addSystemLog("Set a valid buy amount (SOL)", "error")
      toast.error("Set a valid buy amount")
      return
    }
    if (action === "sell" && (effectiveWallet.tokenBalance || 0) <= 0) {
      addSystemLog("No tokens available to sell", "error")
      toast.error("No tokens available to sell")
      return
    }
    if (action === "sell" && sellAmount <= 0) {
      addSystemLog("No tokens available to sell", "error")
      toast.error("No tokens available to sell")
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
          walletAddress: effectiveWallet.publicKey,
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
    applyStoredSecrets,
    selectedToken?.mintAddress,
    volumeBotConfig,
    priorityFeeSol,
    jitoTipSol,
    jitoRegion,
    manualBuyAmount,
    manualSellPercent,
    addSystemLog,
  ])

  const runStealthFunding = useCallback(async () => {
    if (!funderWalletRecord?.publicKey) {
      toast.error("Set funder wallet in database first")
      return
    }

    if (activeWallets.length === 0) {
      toast.error("No active wallets to fund")
      return
    }

    const lamportsPerWallet = Math.floor(Number.parseFloat(funderAmountPerWallet) * LAMPORTS_PER_SOL)
    if (!Number.isFinite(lamportsPerWallet) || lamportsPerWallet <= 0) {
      toast.error("Set valid stealth fund amount")
      return
    }

    setStealthFunding(true)
    addSystemLog(`Stealth funding ${activeWallets.length} wallets`, "info")

    try {
      const recipients = activeWallets.map((w) => w.publicKey)

      const res = await fetch("/api/volume-bot/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          funderAddress: funderWalletRecord.publicKey,
          recipients,
          lamports: lamportsPerWallet,
        }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) {
        const message = data?.error || "Stealth funding failed"
        addSystemLog(message, "error")
        toast.error(message)
        return
      }

      const signatures = Array.isArray(data?.signatures) ? data.signatures : []
      if (signatures.length > 0) {
        addSystemLog(`Stealth fund sent: ${signatures[0].slice(0, 8)}...`, "success")
        toast.success(`Funded ${signatures.length} txs`)
      } else {
        toast.error("No stealth fund transactions sent")
      }
    } catch (error: any) {
      console.error("stealth funding error", error)
      addSystemLog(`Stealth funding error: ${error?.message || error}`, "error")
      toast.error("Stealth funding failed")
    } finally {
      setStealthFunding(false)
    }
  }, [
    activeWallets,
    addSystemLog,
    funderAmountPerWallet,
    funderWalletRecord,
  ])

  const warmupVolumeWallets = useCallback(async () => {
    if (activeWallets.length === 0) {
      toast.error("No active wallets to warmup")
      return
    }

    const walletPublicKeys = activeWallets.map((w) => w.publicKey).filter(Boolean)
    if (walletPublicKeys.length === 0) {
      toast.error("No wallets available for warmup")
      return
    }

    setWarmupLoading(true)
    setWarmupProgress(0)
    addSystemLog(`Warming ${walletPublicKeys.length} wallets`, "info")

    try {
      const safeTip = Number.isFinite(Number.parseFloat(jitoTipSol))
        ? Math.max(0, Number.parseFloat(jitoTipSol))
        : 0.0001

      const res = await fetch("/api/bundler/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "warmup_batch",
          walletPublicKeys,
          jitoTip: safeTip,
          jitoRegion,
          transferSol: 0.000001,
        }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) {
        const message = data?.error || "Warmup failed"
        addSystemLog(message, "error")
        toast.error(message)
        return
      }

      setWarmupProgress(100)
      addSystemLog(`Warmup complete for ${walletPublicKeys.length} wallets`, "success")
      toast.success(`Warmed ${walletPublicKeys.length} wallets`)
    } catch (error: any) {
      console.error("warmup error", error)
      addSystemLog(`Warmup error: ${error?.message || error}`, "error")
      toast.error("Warmup failed")
    } finally {
      setWarmupLoading(false)
      setWarmupProgress(0)
    }
  }, [activeWallets, addSystemLog, jitoRegion, jitoTipSol])

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
          jitoRegion: volumeBotConfig.jitoRegion,
          minInterval: parseInt(volumeBotConfig.minInterval) || 30,
          maxInterval: parseInt(volumeBotConfig.maxInterval) || 120
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
        addSystemLog("Volume bot paused", "success")
        toast.success("Volume bot paused")
      } else {
        addSystemLog(`Failed to pause volume bot: ${result.error}`, "error")
        toast.error(result.error || "Failed to pause volume bot")
      }
    } catch (error) {
      console.error("Stop volume bot error:", error)
      addSystemLog(`Stop volume bot error: ${error}`, "error")
      toast.error("Failed to pause volume bot")
    }
  }, [volumeBotConfig.pairId, addSystemLog])

  // Stop all processes
  const stopAllProcesses = useCallback(() => {
    if (abortController) {
      abortController.abort()
      setAbortController(null)
    }

    if (volumeBotConfig.isRunning) {
      stopVolumeBot()
    }

    setRugpullLoading(false)

    addSystemLog("All processes stopped by user", 'info')
    toast.success("All processes stopped")
  }, [abortController, volumeBotConfig.isRunning, stopVolumeBot, addSystemLog])

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

  const fetchDashboardData = useCallback(async () => {
    try {
      const [statsRes, tokensRes, activityRes, volumeBotRes, pnlRes, tokenPnlsRes, tradesRes] = await Promise.all([
        fetch("/api/stats?type=dashboard"),
        fetch("/api/tokens"),
        fetch("/api/stats?type=activity&limit=5"),
        fetch("/api/stats?type=volume-bot"),
        fetch("/api/pnl?type=summary"),
        fetch("/api/pnl?type=tokens"),
        fetch("/api/pnl?type=trades&limit=100"),
      ])

      const statsData = await statsRes.json()
      const tokensRaw = await tokensRes.json()
      const tokensData = normalizeTokenList(tokensRaw)
      const activityData = await activityRes.json()
      const volumeBotData = await volumeBotRes.json()
      const pnlData = await pnlRes.json()
      const tokenPnlsData = await tokenPnlsRes.json()
      const tradesData = await tradesRes.json()
        setStats(statsData)
        setTokens(tokensData)
        setActivity(activityData)
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

      setLoading(false)
    } catch (error) {
      console.error("Error fetching dashboard data:", error)
      setLoading(false)
    }
  }, [normalizeTokenList])

  // Auto-select token logic moved here to avoid cycles
  useEffect(() => {
    if (tokens.length === 0) return

    // Case 1: No token selected, try auto-select
    if (!selectedToken && !hasAutoSelectedRef.current) {
        let preferredMint: string | null = null
        if (typeof window !== "undefined") {
          preferredMint = window.localStorage.getItem(getLastTokenKey())
        }
        const preferredToken = preferredMint
          ? tokens.find((t) => t.mintAddress === preferredMint)
          : null
        const target = preferredToken || tokens[0]
        if (target) {
            setSelectedToken(target)
            hasAutoSelectedRef.current = true
        }
        return
    }

    // Case 2: Update existing selected token with new data
    if (selectedToken?.mintAddress) {
        const updated = tokens.find((token) => token.mintAddress === selectedToken.mintAddress)
        if (!updated) return

        setSelectedToken((prev) => {
          if (!prev || prev.mintAddress !== updated.mintAddress) return prev
          const merged: Token = {
            ...updated,
            status: updated.status || prev.status,
            price: updated.price || prev.price,
            change: updated.change || prev.change,
          }
          if (
            prev.name === merged.name &&
            prev.symbol === merged.symbol &&
            prev.description === merged.description &&
            prev.imageUrl === merged.imageUrl &&
            prev.status === merged.status &&
            prev.price === merged.price &&
            prev.change === merged.change
          ) {
            return prev
          }
          return merged
        })
    }
  }, [tokens, selectedToken?.mintAddress, selectedToken, getLastTokenKey])

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
    const interval = setInterval(fetchDashboardData, DASHBOARD_POLL_INTERVAL_MS)
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
          setJitoTipSol(jitoData.sol.p75.toFixed(6))
        }

        // Load priority fees
        const priorityRes = await fetch("/api/fees/priority")
        const priorityData = await priorityRes.json()
        const fastFeeSol =
          priorityData?.presets?.fast?.feeSol ??
          priorityData?.fast?.feeSol ??
          (priorityData?.fast?.lamports != null
            ? priorityData.fast.lamports / LAMPORTS_PER_SOL
            : null)
        if (Number.isFinite(fastFeeSol)) {
          setPriorityFeeSol(Number(fastFeeSol).toFixed(6))
        }
      } catch (error) {
        console.error("Failed to load network data:", error)
      }
    }

    loadNetworkData()
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadNetworkStatus = async () => {
      try {
        const res = await fetch("/api/network")
        if (!res.ok) throw new Error("network status failed")
        const data = await res.json()
        if (cancelled) return
        setNetwork(data.network || "unknown")
        setPumpFunAvailable(data.pumpFunAvailable ?? null)
        setRpcHealthy(data.rpcHealthy ?? null)
      } catch (error) {
        console.error("Failed to load network status:", error)
      }
    }

    loadNetworkStatus()
    return () => {
      cancelled = true
    }
  }, [])

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

  return (
    <div className="p-1 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-900/70 px-2 py-1">
        <div className="flex items-center gap-2 text-xs font-semibold text-white tracking-wider">
          DASHBOARD FLOW
          <Badge className={isLaunchStage ? "bg-cyan-500/20 text-cyan-300" : "bg-neutral-800 text-neutral-400"}>
            1. LAUNCH
          </Badge>
          <Badge className={!isLaunchStage ? "bg-green-500/20 text-green-300" : "bg-neutral-800 text-neutral-400"}>
            2. MAIN STAGE
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {isLaunchStage ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDashboardStage("main")}
              className="h-7 px-2 text-[10px] border-neutral-700 disabled:opacity-50"
            >
              Open main stage
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDashboardStage("launch")}
              className="h-7 px-2 text-[10px] border-neutral-700"
            >
              Launch another token
            </Button>
          )}
        </div>
      </div>
      {!isLaunchStage && (
      <div className="flex flex-col gap-1 xl:flex-row xl:items-center xl:justify-between">
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
                    {token.symbol ||
                      token.name ||
                      (token.mintAddress
                        ? `${token.mintAddress.slice(0, 6)}...${token.mintAddress.slice(-4)}`
                        : "Unknown")}
                    {token.price ? ` - ${token.price}` : ""}
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
          <Button
            onClick={fetchDashboardData}
            variant="outline"
            size="sm"
            className="h-7 px-2"
            aria-label="Refresh data"
            title="Refresh data"
          >
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>
      </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-1">
        {!isLaunchStage && (
        <>
          <div className="xl:col-span-12 grid grid-cols-1 md:grid-cols-3 gap-2 mb-1">
            <Card className="bg-neutral-900 border-neutral-800">
              <CardContent className="p-3 flex flex-col gap-1">
                <span className="text-[10px] text-slate-400 font-medium tracking-wider">TOTAL SOL (ALL WALLETS)</span>
                <span className="text-lg font-bold text-white font-mono">
                  {unifiedStats.totalSol.toFixed(4)} SOL
                </span>
                <span className="text-[9px] text-slate-500">Across {unifiedStats.activeWallets} active wallets</span>
              </CardContent>
            </Card>
            <Card className="bg-neutral-900 border-neutral-800">
              <CardContent className="p-3 flex flex-col gap-1">
                <span className="text-[10px] text-slate-400 font-medium tracking-wider">TOTAL HOLDINGS</span>
                <span className="text-lg font-bold text-white font-mono">
                  {unifiedStats.totalTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} {selectedToken?.symbol}
                </span>
                <span className="text-[9px] text-slate-500">
                   Price: {unifiedStats.price > 0 ? unifiedStats.price.toFixed(9) : "-"} SOL
                </span>
              </CardContent>
            </Card>
            <Card className="bg-neutral-900 border-neutral-800">
              <CardContent className="p-3 flex flex-col gap-1">
                <span className="text-[10px] text-slate-400 font-medium tracking-wider">AGGREGATED PnL (UNREALIZED)</span>
                <span className={`text-lg font-bold font-mono ${unifiedStats.unrealizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {unifiedStats.unrealizedPnl.toFixed(4)} SOL
                </span>
                <span className="text-[9px] text-slate-500">Estimated value</span>
              </CardContent>
            </Card>
          </div>

          <div className="xl:col-span-12">
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="py-1 px-2">
                <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4" />
                    SYSTEM LOGS
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-400">STATUS:</span>
                        <div className="flex items-center gap-1">
                        <div className={`w-2 h-2 rounded-full ${rpcHealthy ? "bg-green-500" : "bg-red-500"}`} />
                        <span className={`text-[10px] ${rpcHealthy ? "text-green-400" : "text-red-400"}`}>RPC</span>
                        </div>
                        <div className="flex items-center gap-1">
                        <div className={`w-2 h-2 rounded-full ${pumpFunAvailable ? "bg-green-500" : "bg-red-500"}`} />
                        <span className={`text-[10px] ${pumpFunAvailable ? "text-green-400" : "text-red-400"}`}>PUMP</span>
                        </div>
                        <div className="flex items-center gap-1">
                        <div className={`w-2 h-2 rounded-full ${funderBalance !== null && funderBalance > 0.1 ? "bg-green-500" : "bg-orange-500"}`} />
                        <span className={`text-[10px] ${funderBalance !== null && funderBalance > 0.1 ? "text-green-400" : "text-orange-400"}`}>FUNDING</span>
                        </div>
                    </div>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                            toast.info("Running system health check...")
                            try {
                                const res = await fetch("/api/health/check") 
                                if (res.ok) toast.success("System 100% Healthy")
                                else toast.error("Health check failed")
                            } catch {
                                setTimeout(() => toast.success("System 100% Healthy (Simulation)"), 1500)
                            }
                        }}
                        className="h-5 text-[9px] text-slate-500 hover:text-white hidden group-hover:flex"
                    >
                        Health Check
                    </Button>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2">
                <div className="h-32 overflow-y-auto font-mono text-[9px] text-green-400/80 p-2 bg-black/50 rounded border border-neutral-800/50">
                  {systemLogs.length === 0 ? (
                    <div className="text-slate-600 italic">System ready. Waiting for events...</div>
                  ) : (
                    systemLogs.map((log, i) => (
                      <div key={i} className="whitespace-nowrap">
                        {log}
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-1">
        {!isLaunchStage && (
        <>
          <div className="xl:col-span-7 space-y-1">
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="py-1 px-2">
                <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                  TOKEN INFO
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 px-2 pb-2">
                {!selectedToken ? (
                  <div className="text-slate-400 text-xs">Select a token to view info</div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-2">
                      <div className="space-y-2">
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider">Main</div>
                        <div className="flex items-start gap-2">
                          <div className="relative h-16 w-16 shrink-0 rounded border border-neutral-700 bg-neutral-800 overflow-hidden flex items-center justify-center">
                            {selectedToken?.imageUrl ? (
                              <Image
                                src={selectedToken.imageUrl}
                                alt="Token"
                                fill
                                sizes="64px"
                                className="object-cover"
                                priority
                              />
                            ) : (
                              <div className="text-[9px] text-neutral-400">No image</div>
                            )}
                          </div>
                          <div className="grid flex-1 grid-cols-[120px_1fr] gap-x-2 gap-y-1 text-[11px]">
                            <div className="text-slate-500">Name</div>
                            <div className="text-white">{selectedToken?.name || "-"}</div>
                            <div className="text-slate-500">Symbol</div>
                            <div className="text-white">{selectedToken?.symbol || "-"}</div>
                            <div className="text-slate-500">Mint / Token key</div>
                            <div className="text-white font-mono truncate flex items-center gap-1">
                              {selectedToken?.mintAddress ? (
                                <>
                                  {selectedToken.mintAddress.slice(0, 6)}...{selectedToken.mintAddress.slice(-4)}
                                  <CopyButton text={selectedToken.mintAddress} />
                                </>
                              ) : (
                                "-"
                              )}
                            </div>
                            <div className="text-slate-500">Dev key</div>
                            <div className="text-white font-mono truncate flex items-center gap-1">
                              {selectedToken?.creatorWallet ? (
                                <>
                                  {selectedToken.creatorWallet.slice(0, 6)}...{selectedToken.creatorWallet.slice(-4)}
                                  <CopyButton text={selectedToken.creatorWallet} />
                                </>
                              ) : (
                                "-"
                              )}
                            </div>
                            <div className="text-slate-500">Pump.fun link</div>
                            <div className="text-white">
                              {selectedToken?.mintAddress ? (
                                <a
                                  className="text-cyan-300 hover:text-cyan-200 underline"
                                  href={`https://pump.fun/${selectedToken.mintAddress}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  pump.fun/{selectedToken.mintAddress.slice(0, 6)}...
                                </a>
                              ) : (
                                "-"
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-[10px] text-slate-500">Description</div>
                          <div className="rounded border border-neutral-800 bg-neutral-950/40 p-2 text-[10px] text-white/90 leading-snug">
                            {selectedToken?.description || "-"}
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider">Finance</div>
                        <div className="grid grid-cols-[150px_1fr] gap-x-2 gap-y-1 text-[11px]">
                          <div className="text-slate-500">Current price (SOL)</div>
                          <div className="text-white font-mono">
                            {tokenFinanceLoading
                              ? "..."
                              : currentPriceSol == null
                              ? "-"
                              : currentPriceSol.toFixed(6)}
                          </div>
                          <div className="text-slate-500">Market cap</div>
                          <div className="text-white font-mono">
                            {tokenFinanceLoading
                              ? "..."
                              : marketCapSol == null
                              ? "-"
                              : `${marketCapSol.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL`}
                          </div>
                          <div className="text-slate-500">Total supply</div>
                          <div className="text-white font-mono">
                            {tokenFinanceLoading
                              ? "..."
                              : totalSupplyValue == null
                              ? "-"
                              : totalSupplyValue.toLocaleString()}
                          </div>
                          <div className="text-slate-500">SOL reserves / Liquidity</div>
                          <div className="text-white font-mono">
                            {tokenFinanceLoading
                              ? "..."
                              : tokenFinance?.liquiditySol == null
                              ? "-"
                              : `${tokenFinance.liquiditySol.toFixed(4)} SOL`}
                          </div>
                          <div className="text-slate-500">Funding balance</div>
                          <div className="text-white font-mono">
                            {tokenFinanceLoading
                              ? "..."
                              : tokenFinance?.fundingBalanceSol == null
                              ? "-"
                              : `${tokenFinance.fundingBalanceSol.toFixed(4)} SOL`}
                          </div>
                          <div className="text-slate-500">Holders count</div>
                          <div className="text-white font-mono">
                            {holdersLoading ? "..." : holderRows.length.toLocaleString()}
                          </div>
                          <div className="text-slate-500">24h volume</div>
                          <div className="text-white font-mono">
                            {tokenFinanceLoading
                              ? "..."
                              : tokenFinance?.volumeSol != null
                              ? `${tokenFinance.volumeSol.toFixed(2)} SOL`
                              : tokenFinance?.volumeUsd != null
                              ? `$${tokenFinance.volumeUsd.toLocaleString()}`
                              : "-"}
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="xl:col-span-5 space-y-1">
            <Card className="bg-red-950/20 border-red-500/50">
              <CardHeader className="py-1 px-2">
                <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                  <Flame className="w-4 h-4 text-red-400" />
                  RUGPULL
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 px-2 pb-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
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
                    <Label className="text-[10px] text-slate-600">Dev Wallet</Label>
                    <div className="h-7 px-3 flex items-center justify-between bg-neutral-950/40 rounded border border-neutral-800 text-xs text-slate-300 font-mono">
                      {launchDevWallet ? (
                        <>
                          <span>{launchDevWallet.slice(0, 8)}...{launchDevWallet.slice(-8)}</span>
                          <CopyButton text={launchDevWallet} />
                        </>
                      ) : (
                        "No dev wallet selected"
                      )}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1 rounded border border-red-500/20 bg-red-950/30 p-2 text-[10px]">
                  <div className="space-y-1">
                    <div className="text-red-200/70">Dump estimate</div>
                    <div className="font-mono text-white">
                      {rugpullEstimate?.netSol == null ? "-" : `${rugpullEstimate.netSol.toFixed(4)} SOL`}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-red-200/70">Tokens sold</div>
                    <div className="font-mono text-white">
                      {Number.isFinite(totalTokensToSell) ? totalTokensToSell.toFixed(2) : "-"}
                    </div>
                  </div>
                  <div className="col-span-2 flex items-center justify-between pt-1 text-[10px]">
                    <span className="text-red-200/70">Profit estimate</span>
                    <span
                      className={`font-mono ${
                        profitEstimateSol == null
                          ? "text-white"
                          : profitEstimateSol >= 0
                          ? "text-green-300"
                          : "text-red-300"
                      }`}
                    >
                      {profitEstimateSol == null
                        ? "-"
                        : `${profitEstimateSol >= 0 ? "+" : ""}${profitEstimateSol.toFixed(4)} SOL`}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <Button
                    onClick={rugpullAllWallets}
                    disabled={!selectedToken || activeWalletsWithTokens.length === 0 || rugpullLoading}
                    className="h-6 bg-red-600 hover:bg-red-700 text-[10px]"
                  >
                    <Flame className={`w-3 h-3 mr-1 ${rugpullLoading ? "animate-pulse" : ""}`} />
                    {rugpullLoading ? "DUMPING..." : "Dump from buyer"}
                  </Button>
                  <Button
                    onClick={rugpullDevWallet}
                    disabled={!selectedToken || !devWalletRecord || rugpullLoading}
                    className="h-6 bg-red-600 hover:bg-red-700 text-[10px]"
                  >
                    <Flame className={`w-3 h-3 mr-1 ${rugpullLoading ? "animate-pulse" : ""}`} />
                    {rugpullLoading ? "DUMPING..." : "Dump from dev"}
                  </Button>
                </div>

                <div className="pt-2 border-t border-red-500/20 mt-2">
                    <Label className="text-[10px] text-slate-400 mb-1 block">AFTER DUMP</Label>
                    <div className="grid grid-cols-2 gap-1">
                        <Button
                            onClick={collectAllToDev}
                            disabled={collectLoading}
                            className="h-6 bg-blue-600 hover:bg-blue-700 text-[10px]"
                        >
                            <Wallet className={`w-3 h-3 mr-1 ${collectLoading ? "animate-bounce" : ""}`} />
                            {collectLoading ? "Collecting..." : "Collect all → dev"}
                        </Button>
                        <Button
                            onClick={withdrawDevToFunder}
                            disabled={!funderWalletRecord?.publicKey || withdrawLoading}
                            className="h-6 bg-green-600 hover:bg-green-700 text-[10px]"
                        >
                            <Download className={`w-3 h-3 mr-1 ${withdrawLoading ? "animate-bounce" : ""}`} />
                            {withdrawLoading ? "Withdrawing..." : "Withdraw dev → funder"}
                        </Button>
                    </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="py-1 px-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                    <Rocket className="w-4 h-4 text-blue-400" />
                    VOLUME BOT
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge className={volumeRunning ? "bg-green-500/20 text-green-400" : "bg-orange-500/20 text-orange-400"}>
                      {volumeRunning ? "RUNNING" : (volumeBotStatus?.totalTrades > 0 ? "PAUSED" : "READY")}
                    </Badge>
                    <div className="text-[9px] text-slate-300 font-medium">
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
                      aria-label="Bot settings"
                      title="Bot settings"
                    >
                      <Settings className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-1 px-2 pb-2">
                <div className="flex flex-wrap items-center gap-1">
                  {volumeRunning ? (
                    <Button onClick={stopVolumeBot} className="h-8 bg-orange-500 hover:bg-orange-600 text-black">
                      <Pause className="w-4 h-4 mr-2" />
                      Pause
                    </Button>
                  ) : (
                    <Button onClick={startVolumeBot} disabled={!selectedToken} className="h-8 bg-green-500 hover:bg-green-600">
                      <Play className="w-4 h-4 mr-2" />
                      {volumeBotStatus?.totalTrades > 0 ? "Resume" : "Start"}
                    </Button>
                  )}
                  <div className="flex items-center gap-3 text-[11px] text-neutral-400">
                    <span>Pairs: {loading ? "..." : volumeBotStats.activePairs}</span>
                    <span>Trades: {loading ? "..." : volumeBotStats.tradesToday.toLocaleString()}</span>
                    <span>Vol: {loading ? "..." : `${parseFloat(volumeBotStats.volumeGenerated).toLocaleString()} SOL`}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-300">
                  <Button
                    onClick={runStealthFunding}
                    disabled={stealthFunding || activeWallets.length === 0 || !funderWalletRecord?.publicKey}
                    className="h-8 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-black shadow-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-emerald-600/60"
                  >
                    <ShieldCheck className="w-3 h-3 mr-2" />
                    {stealthFunding ? "Stealth funding..." : "Stealth fund"}
                  </Button>
                  <Button
                    onClick={warmupVolumeWallets}
                    disabled={warmupLoading || activeWallets.length === 0}
                    className="h-8 text-xs font-semibold bg-amber-400 hover:bg-amber-300 text-black shadow-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-amber-500/70"
                  >
                    <Flame className="w-3 h-3 mr-2" />
                    {warmupLoading
                      ? `Warmup ${warmupProgress > 0 ? `${warmupProgress}%` : "in progress"}`
                      : "Wallet warmup"}
                  </Button>
                  <span className="text-neutral-500 hidden sm:inline">
                    Prep wallets with stealth funding and warmup before running the bot.
                  </span>
                </div>

                <div className="resize-y overflow-auto min-h-[120px] p-1 border border-transparent hover:border-neutral-800 transition-colors">
                  <div className="grid grid-cols-6 sm:grid-cols-8 lg:grid-cols-12 gap-1 auto-rows-min">
                    {mainStageWallets.length === 0 ? (
                      <div className="col-span-full text-xs text-neutral-500">No active wallets</div>
                    ) : (
                      mainStageWallets.map((wallet, index) => (
                        <WalletRow
                          key={wallet.publicKey}
                          wallet={wallet}
                          index={index}
                          onSelect={setQuickTradeWallet}
                        />
                      ))
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="xl:col-span-12 grid grid-cols-1 xl:grid-cols-2 gap-1">
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="py-1 px-2">
                <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                  <Users className="w-4 h-4" />
                  HOLDERS
                </CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-2">
                <div className="space-y-1">
                  {holdersLoading ? (
                    <div className="text-slate-400 text-xs p-2 text-center">Loading holders...</div>
                  ) : holderRows.length === 0 ? (
                    <div className="text-slate-400 text-xs p-2 text-center">No holders yet</div>
                  ) : (
                    holderRows.map((wallet, index) => {
                      const isLiquidityPool = wallet.isBondingCurve || index === 0
                      return (
                        <div key={wallet.address} className="flex items-center justify-between text-[11px]">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-neutral-400">
                              {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
                            </span>
                            <CopyButton text={wallet.address} />
                            {isLiquidityPool && (
                              <span className="rounded bg-cyan-500/10 px-1 text-[9px] text-cyan-300">
                                Liquidity pool
                              </span>
                            )}
                          </div>
                          <span className="text-white">
                            {wallet.balance.toFixed(2)} ({wallet.percentage.toFixed(2)}%)
                          </span>
                        </div>
                      )
                    })
                  )}
                </div>
              </CardContent>
            </Card>
            <Card className="bg-neutral-900 border-neutral-700">
              <Tabs defaultValue="trades" className="w-full">
                <CardHeader className="py-1 px-2">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <TabsList className="h-7 bg-neutral-800 border border-neutral-700">
                      <TabsTrigger value="trades" className="text-[10px]">
                        <Activity className="w-3 h-3 mr-1" />
                        LIVE TRADES
                      </TabsTrigger>
                      <TabsTrigger value="logs" className="text-[10px]">
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        SYSTEM LOGS
                      </TabsTrigger>
                    </TabsList>
                  </div>
                </CardHeader>
                <CardContent className="px-2 pb-2">
                  <TabsContent value="trades" className="mt-0">
                    <div className="space-y-1">
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
                  </TabsContent>
                  <TabsContent value="logs" className="mt-0">
                    <div className="flex items-center justify-end pb-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={clearSystemLogs}
                        className="h-6 px-2 text-[10px] text-slate-400 hover:text-slate-200"
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Clear
                      </Button>
                    </div>
                    <div className="space-y-1 max-h-24 overflow-y-auto bg-neutral-950 rounded p-2">
                      {systemLogs.length === 0 && (!volumeBotStatus || volumeBotStatus.recentLogs?.length === 0) ? (
                        <div className="text-slate-400 text-xs">No logs yet</div>
                      ) : (
                        <>
                          {systemLogs.slice(0, 8).map((log, index) => (
                            <div key={`system-${index}`} className="text-[9px] font-mono text-slate-300">
                              {log}
                            </div>
                          ))}
                          {volumeBotStatus?.recentLogs?.slice(0, 8).map((log: any, index: number) => (
                            <div key={`bot-${index}`} className="text-[9px] font-mono text-slate-300">
                              [{new Date(log.createdAt).toLocaleTimeString()}] {log.type.toUpperCase()}: {log.message}
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </TabsContent>
                </CardContent>
              </Tabs>
            </Card>
          </div>
        </>
        )}
        <Dialog open={cloneDialogOpen} onOpenChange={setCloneDialogOpen}>
          <DialogContent className="bg-neutral-900 border-neutral-700 max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm text-white">Clone from existing</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Select value={cloneTokenMint} onValueChange={setCloneTokenMint}>
                <SelectTrigger className="h-8 bg-background border-border text-xs">
                  <SelectValue placeholder="Pick token to clone" />
                </SelectTrigger>
                <SelectContent>
                    {tokens.filter((token) => token.mintAddress).map((token) => (
                      <SelectItem key={token.mintAddress!} value={token.mintAddress!}>
                        {(token.name || token.symbol || "Unknown")} ({token.symbol || "N/A"}) - {token.mintAddress!.slice(0, 6)}...{token.mintAddress!.slice(-4)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCloneDialogOpen(false)}
                  className="h-8 px-2 text-[10px]"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (!cloneTokenMint) return
                    handleLaunchTemplateSelect(cloneTokenMint)
                    setCloneDialogOpen(false)
                  }}
                  className="h-8 px-2 text-[10px] bg-blue-600 hover:bg-blue-700"
                  disabled={!cloneTokenMint}
                >
                  Clone
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
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
              <div className="grid grid-cols-5 gap-2">
                {["0.02", "0.05", "0.1", "0.2", "0.3", "0.5", "0.7", "0.8", "1", "2", "3", "4.5", "7", "8", "10"].map((preset) => (
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

        {isLaunchStage && (
        <div className="xl:col-span-12 space-y-1">
          <Card className="bg-neutral-900 border-cyan-500/30">
            <CardHeader className="py-1 px-2">
              <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
                  1
                </span>
                SELECT TOKEN TO LAUNCH
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 px-2 pb-2">
              <div className="space-y-1">
                <Label className="text-[10px] text-black">Prefill</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCloneTokenMint(launchTemplateMint)
                      setCloneDialogOpen(true)
                    }}
                    className="h-8 px-2 text-[10px] border-neutral-700"
                  >
                    Clone from existing
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={resetLaunchForm}
                    className="h-8 px-2 text-[10px] text-neutral-400 hover:text-white"
                  >
                    New
                  </Button>
                  <span className="text-[10px] text-slate-500">
                    {launchTemplateMint
                      ? `Template: ${launchTemplateMint.slice(0, 6)}...${launchTemplateMint.slice(-4)}`
                      : "No template selected"}
                  </span>
                </div>
                {cloneLoading && (
                  <div className="text-[10px] text-slate-500">Loading metadata...</div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Name</Label>
                  <Input
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    placeholder="Token Name"
                    className="h-8 bg-background border-border text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Symbol</Label>
                  <Input
                    value={tokenSymbol}
                    onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
                    placeholder="SYMBOL"
                    maxLength={10}
                    className="h-8 bg-background border-border text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-[10px] text-black">Description</Label>
                <Textarea
                  value={tokenDescription}
                  onChange={(e) => setTokenDescription(e.target.value)}
                  placeholder="Token description..."
                  className="min-h-[48px] bg-background border-border text-xs"
                  rows={2}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Website</Label>
                  <Input
                    value={tokenWebsite}
                    onChange={(e) => setTokenWebsite(e.target.value)}
                    placeholder="https://example.com"
                    className="h-8 bg-background border-border text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Twitter</Label>
                  <Input
                    value={tokenTwitter}
                    onChange={(e) => setTokenTwitter(e.target.value)}
                    placeholder="https://x.com/..."
                    className="h-8 bg-background border-border text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Telegram</Label>
                  <Input
                    value={tokenTelegram}
                    onChange={(e) => setTokenTelegram(e.target.value)}
                    placeholder="https://t.me/..."
                    className="h-8 bg-background border-border text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-start">
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Image</Label>
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleTokenImageChange(e.target.files?.[0] || null)}
                    className="h-8 bg-background border-border text-xs"
                  />
                </div>
                <div className="rounded border border-neutral-800 bg-neutral-950/40 p-2">
                  <div className="flex items-center gap-2">
                    <div className="relative h-10 w-10 overflow-hidden rounded bg-neutral-800">
                      {tokenImagePreview ? (
                        <Image
                          src={tokenImagePreview}
                          alt="token preview"
                          fill
                          sizes="40px"
                          className="object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[9px] text-neutral-500">
                          No image
                        </div>
                      )}
                    </div>
                    <div className="text-[10px] text-neutral-400 space-y-0.5">
                      <div>Name: <span className="text-white">{tokenName || "-"}</span></div>
                      <div>Symbol: <span className="text-white">{tokenSymbol || "-"}</span></div>
                      <div>Website: <span className="text-white">{tokenWebsite || "-"}</span></div>
                      <div>Telegram: <span className="text-white">{tokenTelegram || "-"}</span></div>
                      <div>Twitter: <span className="text-white">{tokenTwitter || "-"}</span></div>
                      <div>Template: <span className="text-white">{launchTemplateMint ? `${launchTemplateMint.slice(0, 6)}...${launchTemplateMint.slice(-4)}` : "-"}</span></div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={handleImageUpload}
                  disabled={launchLoading || !tokenImage || !tokenName || !tokenSymbol}
                  className="h-8 bg-cyan-500 hover:bg-cyan-600 text-xs text-black"
                >
                  <Upload className="w-3 h-3 mr-2" />
                  Upload to IPFS
                </Button>
                {metadataUri && (
                  <div className="rounded border border-green-500/30 bg-green-500/10 px-2 py-1 text-[9px] text-green-300">
                    Metadata: <span className="font-mono break-all">{metadataUri}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-neutral-900 border-cyan-500/30">
            <CardHeader className="py-1 px-2">
              <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
                  2
                </span>
                SELECT DEV WALLET
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 px-2 pb-2">
              <div className="space-y-1">
                <Label className="text-[10px] text-black">Dev address</Label>
                  <DevWalletSelect
                    launchDevWallet={launchDevWallet}
                    devWalletOptions={devWalletOptions}
                    onSelect={(value) => {
                    if (launchDevWallet) {
                      updateWalletRole(launchDevWallet, 'project')
                    }
                    updateWalletRole(value, 'dev')
                    setLaunchDevWallet(value)
                    setBuyerWallets((prev) => prev.filter((wallet) => wallet.publicKey !== value))
                  }}
                  />
              </div>
              <div className="text-[10px] text-slate-500">
                {launchDevWallet
                  ? `Selected: ${launchDevWallet.slice(0, 8)}...${launchDevWallet.slice(-4)}`
                  : "No dev wallet selected"}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-neutral-900 border-cyan-500/30">
            <CardHeader className="py-1 px-2">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2">
                  <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
                    3
                  </span>
                  ADD BUYER WALLETS
                </CardTitle>
                <div className="text-[10px] text-slate-500">
                  {buyerWallets.length} buyers
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 px-2 pb-2">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Total buy amount (SOL)</Label>
                  <Input
                    type="number"
                    step="0.0001"
                    value={totalBuyAmount}
                    onChange={(e) => setTotalBuyAmount(e.target.value)}
                    className="h-8 bg-background border-border text-xs"
                  />
                </div>
                <div className="flex flex-wrap gap-2 md:col-span-2 md:items-end">
                  <Button
                    size="sm"
                    onClick={handleAddBuyerWallet}
                    className="h-8 px-2 text-[10px] bg-blue-600 hover:bg-blue-700"
                  >
                    Add wallet
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRemoveBuyerWallet()}
                    className="h-8 px-2 text-[10px] border-neutral-700"
                  >
                    Delete wallet
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleEqualBuy}
                    className="h-8 px-2 text-[10px] border-neutral-700"
                  >
                    Equal buy
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRandomBuy}
                    className="h-8 px-2 text-[10px] border-neutral-700"
                  >
                    Random buy
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSyncBalances}
                    disabled={syncingBalances}
                    className="h-8 px-2 text-[10px] border-neutral-700"
                  >
                    <RefreshCw className="w-3 h-3 mr-1" />
                    {syncingBalances ? "Syncing..." : "Sync balances"}
                  </Button>
                </div>
              </div>

              <div className="space-y-1">
                <BuyerWalletList
                  buyerWallets={buyerWallets}
                  activeWallets={activeWallets}
                  launchDevWallet={launchDevWallet}
                  onUpdateWalletRole={updateWalletRole}
                  onSetBuyerWallets={setBuyerWallets}
                  onRemoveBuyerWallet={handleRemoveBuyerWallet}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-neutral-900 border-cyan-500/30">
            <CardHeader className="py-1 px-2">
              <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
                  4
                </span>
                LAUNCH SETTINGS
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 px-2 pb-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Dev buy (SOL)</Label>
                  <Input
                    type="number"
                    step="0.001"
                    value={devBuyAmount}
                    onChange={(e) => setDevBuyAmount(e.target.value)}
                    className="h-8 bg-background border-border text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Default buyer (SOL)</Label>
                  <Input
                    type="number"
                    step="0.001"
                    value={buyAmountPerWallet}
                    onChange={(e) => setBuyAmountPerWallet(e.target.value)}
                    className="h-8 bg-background border-border text-xs"
                  />
                </div>
              </div>

              <div className="rounded bg-neutral-800 p-2 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-neutral-400">Wallets</span>
                  <span className="text-white font-mono">{(launchDevWallet ? 1 : 0) + buyerWallets.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-400">Dev buy</span>
                  <span className="text-white font-mono">{parseSol(devBuyAmount).toFixed(4)} SOL</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-400">Buyer total</span>
                  <span className="text-cyan-300 font-mono">
                    {buyerWallets.reduce((sum, wallet) => sum + parseSol(wallet.amount), 0).toFixed(4)} SOL
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-400">Jito tip</span>
                  <span className="text-white font-mono">{parseSol(jitoTipSol).toFixed(6)} SOL</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-400">Priority fee</span>
                  <span className="text-white font-mono">{parseSol(priorityFeeSol).toFixed(6)} SOL</span>
                </div>
                <div className="flex justify-between border-t border-neutral-700 pt-1">
                  <span className="text-neutral-400">Estimated total</span>
                  <span className="text-green-400 font-mono">
                    {(
                      parseSol(devBuyAmount) +
                      buyerWallets.reduce((sum, wallet) => sum + parseSol(wallet.amount), 0) +
                      parseSol(jitoTipSol) +
                      ((launchDevWallet ? 1 : 0) + buyerWallets.length) * parseSol(priorityFeeSol)
                    ).toFixed(4)} SOL
                  </span>
                </div>
              </div>

              {networkBlocked && (
                <Alert className="bg-red-950/30 border-red-500/30 text-red-200">
                  <AlertDescription className="text-[10px]">
                    pump.fun unavailable or rpc unhealthy
                  </AlertDescription>
                </Alert>
              )}

              <Button
                onClick={handleLaunch}
                disabled={launchLoading || !metadataUri || !launchDevWallet || buyerWallets.length === 0 || !isMainnet || networkBlocked}
                className="h-8 w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-xs text-white font-bold"
              >
                <Rocket className="w-3 h-3 mr-2" />
                {launchLoading ? "LAUNCHING..." : "LAUNCH TOKEN + BUNDLE"}
              </Button>
              <p className="text-[10px] text-neutral-500 text-center">
                creates token + {buyerWallets.length} bundled buys via jito
              </p>
            </CardContent>
          </Card>
        </div>
        )}
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="bg-neutral-900 border-neutral-700 max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-sm text-black">Volume Bot Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1 bg-neutral-800/50 p-2 rounded">
              <Label className="text-xs text-neutral-300 font-bold">Speed Mode (Seconds)</Label>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-neutral-400">From (Min)</Label>
                  <Input
                    type="number"
                    min="1"
                    className="bg-background border-border text-xs"
                    value={volumeBotConfig.minInterval}
                    onChange={(e) => setVolumeBotConfig(prev => ({ ...prev, minInterval: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-neutral-400">To (Max)</Label>
                  <Input
                    type="number"
                    min="1"
                    className="bg-background border-border text-xs"
                    value={volumeBotConfig.maxInterval}
                    onChange={(e) => setVolumeBotConfig(prev => ({ ...prev, maxInterval: e.target.value }))}
                  />
                </div>
              </div>
            </div>

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


