"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { TrendingUp, TrendingDown, Coins, Activity, Users, Play, Pause, Settings, RefreshCw, Flame, Rocket, AlertTriangle, BarChart3, Trash2, Upload } from "lucide-react"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, LineChart, Line } from "recharts"
import { PnLSummaryCard, MiniPnLCard } from "@/components/pnl/PnLCard"
import { TokenRanking } from "@/components/analytics/TokenRanking"
import { ActivityHeatmap } from "@/components/analytics/ActivityHeatmap"
import type { PnLSummary, TokenPnL, Trade } from "@/lib/pnl/types"
import { toast } from "sonner"
import { useWallet } from "@solana/wallet-adapter-react"
import { LAMPORTS_PER_SOL, PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js"
import bs58 from "bs58"
import { getResilientConnection } from "@/lib/solana/config"
import { getBondingCurveAddress } from "@/lib/solana/pumpfun-sdk"
import { TokenHolderTracker, type HolderRow } from "@/lib/solana/holder-tracker"
import { clampNumber } from "@/lib/ui-utils"

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
const MAX_LAUNCH_WALLETS = 13

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
  const [dashboardStage, setDashboardStage] = useState<"launch" | "main">("launch")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { publicKey, sendTransaction, connected } = useWallet()

  // New states for enhanced dashboard
  const [selectedToken, setSelectedToken] = useState<Token | null>(null)
  const [bundlerWallets, setBundlerWallets] = useState<BundlerWallet[]>([])
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
  const [autoFundEnabled, setAutoFundEnabled] = useState(true)
  const [autoCreateAtaEnabled, setAutoCreateAtaEnabled] = useState(true)
  const [useConnectedFunder, setUseConnectedFunder] = useState(true)
  const [funderKey, setFunderKey] = useState("")
  const [funderAmountPerWallet, setFunderAmountPerWallet] = useState("0.003")
  const [launchDevWallet, setLaunchDevWallet] = useState("")
  const [buyerWallets, setBuyerWallets] = useState<BuyerWalletSelection[]>([])
  const [totalBuyAmount, setTotalBuyAmount] = useState("1")
  const [launchTemplateMint, setLaunchTemplateMint] = useState("")
  const [cloneLoading, setCloneLoading] = useState(false)
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false)
  const [cloneTokenMint, setCloneTokenMint] = useState("")
  const [priceSeries, setPriceSeries] = useState<Array<{ time: string; price: number }>>([])
  const [devKey, setDevKey] = useState("")
  const [useConnectedDev, setUseConnectedDev] = useState(true)
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
  const [quickTradeWallet, setQuickTradeWallet] = useState<BundlerWallet | null>(null)
  const [quickBuyAmount, setQuickBuyAmount] = useState("0.01")
  const [volumeBotStatus, setVolumeBotStatus] = useState<any>(null)
  const [logMintAddress, setLogMintAddress] = useState("")
  const [holderRows, setHolderRows] = useState<HolderRow[]>([])
  const [holdersLoading, setHoldersLoading] = useState(false)
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
  const getPairStorageKey = useCallback((mint: string) => `volume_bot_pair_${mint}`, [])
  const getLastTokenKey = useCallback(() => "dashboardLastTokenMint", [])

  const activeWallets = useMemo(() => bundlerWallets.filter(w => w.isActive), [bundlerWallets])
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
    if (useConnectedDev && publicKey) return publicKey
    const trimmed = devKey.trim()
    if (!trimmed) return null
    try {
      return Keypair.fromSecretKey(bs58.decode(trimmed)).publicKey
    } catch {
      return null
    }
  }, [useConnectedDev, publicKey, devKey])
  const networkBlocked = pumpFunAvailable === false || rpcHealthy === false
  const isMainnet = network === "mainnet-beta"
  const isLaunchStage = dashboardStage === "launch"
  const canOpenMainStage = Boolean(selectedToken?.mintAddress)

  useEffect(() => {
    if (activeWallets.length === 0) {
      if (launchDevWallet) setLaunchDevWallet("")
      return
    }
    const exists = activeWallets.some((wallet) => wallet.publicKey === launchDevWallet)
    if (!exists) {
      setLaunchDevWallet(activeWallets[0].publicKey)
    }
  }, [activeWallets, launchDevWallet])

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
      const template = tokens.find((token) => token.mintAddress === mintAddress)
      if (!template) {
        throw new Error("template not found")
      }
      setTokenName(template.name || "")
      setTokenSymbol((template.symbol || "").toUpperCase())
      setTokenDescription(template.description || "")
      setTokenWebsite(template.website || "")
      setTokenTwitter(template.twitter || "")
      setTokenTelegram(template.telegram || "")
      setTokenImageUrl(template.imageUrl || "")
      setTokenImagePreview(template.imageUrl || "")
      setTokenImage(null)
      setMetadataUri("")
      toast.success("token metadata loaded")
    } catch (error: any) {
      toast.error(error?.message || "failed to load metadata")
    } finally {
      setCloneLoading(false)
    }
  }

  const handleAddBuyerWallet = () => {
    if (buyerWallets.length >= MAX_LAUNCH_WALLETS - 1) {
      toast.error(`max ${MAX_LAUNCH_WALLETS - 1} buyer wallets`)
      return
    }
    const used = new Set(buyerWallets.map((wallet) => wallet.publicKey))
    const available = activeWallets.filter(
      (wallet) => wallet.publicKey !== launchDevWallet && !used.has(wallet.publicKey)
    )
    if (available.length === 0) {
      toast.error("no available buyer wallets")
      return
    }
    const next = available[0]
    setBuyerWallets((prev) => [
      ...prev,
      {
        publicKey: next.publicKey,
        amount: buyAmountPerWallet || "0.01",
      },
    ])
  }

  const handleRemoveBuyerWallet = (index?: number) => {
    setBuyerWallets((prev) => {
      if (prev.length === 0) return prev
      if (index === undefined) return prev.slice(0, -1)
      return prev.filter((_, idx) => idx !== index)
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
    if (buyerKeys.length + 1 > MAX_LAUNCH_WALLETS) {
      toast.error(`max ${MAX_LAUNCH_WALLETS} wallets per bundle`)
      return
    }

    const devWallet = bundlerWallets.find((wallet) => wallet.publicKey === launchDevWallet)
    if (!devWallet) {
      toast.error("dev wallet not found")
      return
    }
    if (!devWallet.secretKey) {
      toast.error("dev wallet secret key missing")
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
    const missingSecret = buyersResolved.find((entry) => !entry.wallet?.secretKey)
    if (missingSecret) {
      toast.error("buyer wallet secret key missing")
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
      const buyAmounts = [parsedDevBuy, ...buyerAmounts]
      const funderAmount = parseSol(funderAmountPerWallet)

      if (autoFundEnabled) {
        if (!Number.isFinite(funderAmount) || funderAmount <= 0) {
          toast.error("set valid funder amount per wallet")
          return
        }

        addSystemLog(`Auto-funding ${launchWallets.length} wallets`, "info")
        if (useConnectedFunder) {
          if (!connected || !publicKey) {
            toast.error("connect funder wallet")
            return
          }
          const connection = await getResilientConnection()
          const balanceLamports = await connection.getBalance(publicKey)
          const totalSolNeeded = (funderAmount * launchWallets.length) + 0.01
          if (balanceLamports / LAMPORTS_PER_SOL < totalSolNeeded) {
            const message = `Insufficient balance. Need ${totalSolNeeded.toFixed(4)} SOL`
            toast.error(message)
            addSystemLog(message, "error")
            return
          }

          const BATCH_SIZE = 8
          for (let i = 0; i < launchWallets.length; i += BATCH_SIZE) {
            const batch = launchWallets.slice(i, i + BATCH_SIZE)
            const tx = new Transaction()
            batch.forEach((wallet) => {
              tx.add(
                SystemProgram.transfer({
                  fromPubkey: publicKey,
                  toPubkey: new PublicKey(wallet.publicKey),
                  lamports: Math.floor(funderAmount * LAMPORTS_PER_SOL),
                })
              )
            })
            const sig = await sendTransaction(tx, connection)
            await connection.confirmTransaction(sig, "confirmed")
            addSystemLog(`Funder batch confirmed: ${sig.slice(0, 8)}...`, "success")
          }
        } else {
          const trimmedFunderKey = funderKey.trim()
          if (!trimmedFunderKey) {
            toast.error("funder private key required")
            return
          }
          const fundRes = await fetch("/api/bundler/wallets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "fund",
              funderSecretKey: trimmedFunderKey,
              wallets: launchWallets,
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
      }

      const res = await fetch("/api/bundler/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: launchWallets,
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
              wallets: launchWallets,
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
        await loadSavedWallets()
      }
    } catch (error: any) {
      console.error("rugpull error:", error)
      toast.error(`rugpull failed: ${error.message}`)
    }
  }, [selectedToken, activeWalletsWithTokens, jitoTipSol, priorityFeeSol, jitoRegion, loadSavedWallets, rugpullSlippage])

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
            solBalance: 0,
            tokenBalance: 100,
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
    rugpullSlippage,
  ])

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
      const [statsRes, tokensRes, activityRes, chartRes, volumeBotRes, pnlRes, tokenPnlsRes, tradesRes] = await Promise.all([
        fetch("/api/stats?type=dashboard"),
        fetch("/api/tokens"),
        fetch("/api/stats?type=activity&limit=5"),
        fetch("/api/stats?type=chart&days=7"),
        fetch("/api/stats?type=volume-bot"),
        fetch("/api/pnl?type=summary"),
        fetch("/api/pnl?type=tokens"),
        fetch("/api/pnl?type=trades&limit=100"),
      ])

      const statsData = await statsRes.json()
      const tokensRaw = await tokensRes.json()
      const tokensData = normalizeTokenList(tokensRaw)
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
  }, [selectedToken, getLastTokenKey, loadSavedWallets, normalizeTokenList])

  useEffect(() => {
    if (!selectedToken?.mintAddress || tokens.length === 0) return
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
  }, [tokens, selectedToken?.mintAddress])

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
          <Button onClick={fetchDashboardData} variant="outline" size="sm" className="h-7 px-2">
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>
      </div>
      )}

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
                          <div className="h-16 w-16 shrink-0 rounded border border-neutral-700 bg-neutral-800 overflow-hidden flex items-center justify-center">
                            {selectedToken?.imageUrl ? (
                              <img src={selectedToken.imageUrl} alt="Token" className="h-full w-full object-cover" />
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
                            <div className="text-white font-mono truncate">
                              {selectedToken?.mintAddress
                                ? `${selectedToken.mintAddress.slice(0, 6)}...${selectedToken.mintAddress.slice(-4)}`
                                : "-"}
                            </div>
                            <div className="text-slate-500">Dev key</div>
                            <div className="text-white font-mono truncate">
                              {selectedToken?.creatorWallet
                                ? `${selectedToken.creatorWallet.slice(0, 6)}...${selectedToken.creatorWallet.slice(-4)}`
                                : "-"}
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
                    disabled={!selectedToken || activeWalletsWithTokens.length === 0}
                    className="h-6 bg-red-600 hover:bg-red-700 text-[10px]"
                  >
                    <Flame className="w-3 h-3 mr-1" />
                    Dump from buyer
                  </Button>
                  <Button
                    onClick={rugpullDevWallet}
                    disabled={!selectedToken || (useConnectedDev ? !publicKey : !devKey.trim())}
                    className="h-6 bg-red-600 hover:bg-red-700 text-[10px]"
                  >
                    <Flame className="w-3 h-3 mr-1" />
                    Dump from dev
                  </Button>
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

                <div className="max-h-20 overflow-y-auto">
                  <div className="grid grid-cols-6 sm:grid-cols-8 lg:grid-cols-12 gap-1 auto-rows-min">
                    {activeWallets.length === 0 ? (
                      <div className="col-span-full text-xs text-neutral-500">No active wallets</div>
                    ) : (
                      activeWallets.map((wallet) => (
                      <button
                        key={wallet.publicKey}
                        type="button"
                        onClick={() => setQuickTradeWallet(wallet)}
                        className="h-10 rounded border border-orange-500 bg-white p-1 text-left text-[9px] leading-tight hover:border-orange-400 transition"
                      >
                        <div className="text-[9px]" style={{ color: "#000", fontWeight: 700 }}>Wallet</div>
                        <div className="font-mono text-[9px] text-neutral-900 truncate">
                          {wallet.publicKey.slice(0, 6)}...{wallet.publicKey.slice(-4)}
                        </div>
                      </button>
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
                <div className="space-y-1 max-h-24 overflow-y-auto">
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
                    <div className="space-y-1 max-h-24 overflow-y-auto">
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
                    <div className="h-10 w-10 overflow-hidden rounded bg-neutral-800">
                      {tokenImagePreview ? (
                        <img src={tokenImagePreview} alt="token preview" className="h-full w-full object-cover" />
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
                <Select
                  value={launchDevWallet}
                  onValueChange={(value) => {
                    setLaunchDevWallet(value)
                    setBuyerWallets((prev) => prev.filter((wallet) => wallet.publicKey !== value))
                  }}
                >
                  <SelectTrigger className="h-8 bg-background border-border text-xs">
                    <SelectValue placeholder="Pick dev wallet" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeWallets.map((wallet) => (
                      <SelectItem key={wallet.publicKey} value={wallet.publicKey}>
                        Balance: {wallet.solBalance.toFixed(4)} SOL - {wallet.publicKey.slice(0, 6)}...{wallet.publicKey.slice(-4)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                  {buyerWallets.length}/{Math.max(0, MAX_LAUNCH_WALLETS - 1)} buyers
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
                </div>
              </div>

              <div className="space-y-1">
                {buyerWallets.length === 0 ? (
                  <div className="text-[10px] text-slate-500">No buyer wallets selected</div>
                ) : (
                  buyerWallets.map((wallet, index) => {
                    const usedKeys = new Set(buyerWallets.map((entry) => entry.publicKey))
                    const options = activeWallets.filter((option) => {
                      if (option.publicKey === launchDevWallet) return false
                      if (option.publicKey === wallet.publicKey) return true
                      return !usedKeys.has(option.publicKey)
                    })
                    return (
                      <div key={`${wallet.publicKey}-${index}`} className="grid grid-cols-12 gap-2 items-center rounded border border-neutral-800 bg-neutral-950/40 p-2">
                        <div className="col-span-1 text-[10px] text-slate-400">{index + 1}</div>
                        <div className="col-span-7">
                          <Select
                            value={wallet.publicKey}
                            onValueChange={(value) => {
                              setBuyerWallets((prev) =>
                                prev.map((entry, idx) =>
                                  idx === index ? { ...entry, publicKey: value } : entry
                                )
                              )
                            }}
                          >
                            <SelectTrigger className="h-8 bg-background border-border text-xs">
                              <SelectValue placeholder="Select wallet" />
                            </SelectTrigger>
                            <SelectContent>
                              {options.map((option) => (
                                <SelectItem key={option.publicKey} value={option.publicKey}>
                                  {option.label ? `${option.label} - ` : ""}
                                  {option.publicKey.slice(0, 6)}...{option.publicKey.slice(-4)} ({option.solBalance.toFixed(3)} SOL)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-3">
                          <Input
                            type="number"
                            step="0.0001"
                            value={wallet.amount}
                            onChange={(e) => {
                              setBuyerWallets((prev) =>
                                prev.map((entry, idx) =>
                                  idx === index ? { ...entry, amount: e.target.value } : entry
                                )
                              )
                            }}
                            className="h-8 bg-background border-border text-xs"
                          />
                        </div>
                        <div className="col-span-1 flex justify-end">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => handleRemoveBuyerWallet(index)}
                            className="h-8 w-8 text-red-400 hover:text-red-300"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-neutral-900 border-cyan-500/30">
            <CardHeader className="py-1 px-2">
              <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
                  4
                </span>
                AUTO FUNDING + ATA
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 px-2 pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/40 px-2 py-1 text-[10px] text-slate-400">
                  <span>Auto fund</span>
                  <Switch checked={autoFundEnabled} onCheckedChange={setAutoFundEnabled} />
                </div>
                <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/40 px-2 py-1 text-[10px] text-slate-400">
                  <span>Auto ATA</span>
                  <Switch checked={autoCreateAtaEnabled} onCheckedChange={setAutoCreateAtaEnabled} />
                </div>
                <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/40 px-2 py-1 text-[10px] text-slate-400">
                  <span>Use connected funder</span>
                  <Switch checked={useConnectedFunder} onCheckedChange={setUseConnectedFunder} />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] text-black">Amount per wallet (SOL)</Label>
                  <Input
                    type="number"
                    step="0.0001"
                    value={funderAmountPerWallet}
                    onChange={(e) => setFunderAmountPerWallet(e.target.value)}
                    className="h-8 bg-background border-border text-xs"
                    disabled={!autoFundEnabled}
                  />
                </div>
                <div className="space-y-1 md:col-span-2">
                  <Label className="text-[10px] text-black">Funder private key</Label>
                  <Input
                    type="password"
                    placeholder="funder wallet private key"
                    value={funderKey}
                    onChange={(e) => setFunderKey(e.target.value)}
                    className="h-8 bg-background border-border text-xs"
                    disabled={!autoFundEnabled || useConnectedFunder}
                  />
                </div>
              </div>
              <div className="text-[10px] text-slate-500">
                Auto-fund runs before launch. Auto-ATA runs after mint is created.
                {useConnectedFunder ? " Uses connected wallet for funding." : ""}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-neutral-900 border-cyan-500/30">
            <CardHeader className="py-1 px-2">
              <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
                <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
                  5
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



