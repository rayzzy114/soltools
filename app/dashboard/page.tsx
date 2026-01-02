"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { MiniPnLCard } from "@/components/pnl/PnLCard"
import type { PnLSummary, TokenPnL, Trade } from "@/lib/pnl/types"
import { toast } from "sonner"
import { useWallet } from "@solana/wallet-adapter-react"
import { LAMPORTS_PER_SOL, PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js"
import bs58 from "bs58"
import { getResilientConnection, connection } from "@/lib/solana/config"
import { getBondingCurveAddress } from "@/lib/solana/pumpfun-sdk"
import { TokenHolderTracker, type HolderRow } from "@/lib/solana/holder-tracker"
import { clampNumber } from "@/lib/ui-utils"
import { TokenInfoCard } from "@/components/dashboard/TokenInfoCard"
import { RugpullPanel } from "@/components/dashboard/RugpullPanel"
import { VolumeBotPanel } from "@/components/dashboard/VolumeBotPanel"
import { LaunchPanel } from "@/components/dashboard/LaunchPanel"
import { AnalyticsPanel } from "@/components/dashboard/AnalyticsPanel"
import { LaunchStatus, FsmStatus, FsmStep } from "@/components/dashboard/LaunchStatus"
import { BundlerWallet } from "@/types/dashboard"

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

  // FSM State for Launch Timeline
  const [fsmCurrent, setFsmCurrent] = useState<FsmStatus>("idle")
  const [fsmSteps, setFsmSteps] = useState<FsmStep[]>([{
    state: "idle",
    note: "ready for next bundle",
    at: Date.now(),
  }])
  const [activeBundleId, setActiveBundleId] = useState("")

  const holderTrackerRef = useRef<TokenHolderTracker | null>(null)
  const hydratedMintsRef = useRef<Set<string>>(new Set())
  const getPairStorageKey = useCallback((mint: string) => `volume_bot_pair_${mint}`, [])
  const getLastTokenKey = useCallback(() => "dashboardLastTokenMint", [])

  const resetFsm = useCallback((note: string) => {
    const now = Date.now()
    setFsmCurrent("preparing")
    setFsmSteps([{ state: "preparing", note, at: now }])
    setActiveBundleId("")
  }, [])

  const pushFsm = useCallback((state: FsmStatus, note: string, bundleId?: string) => {
    setFsmCurrent(state)
    setFsmSteps((prev) => {
      const next = [...prev, { state, note, at: Date.now(), ...(bundleId ? { bundleId } : {}) }]
      return next.slice(-12)
    })
    if (bundleId) setActiveBundleId(bundleId)
  }, [])

  // Ref for auto-selection to break dependency cycles
  const hasAutoSelectedRef = useRef(false)

  const activeWallets = useMemo(() => bundlerWallets.filter(w => w.isActive), [bundlerWallets])
  const connectedWalletKey = publicKey?.toBase58() || ""
  const connectedDevWallet = useMemo(() => {
    if (!connectedWalletKey) return null
    return bundlerWallets.find((wallet) => wallet.publicKey === connectedWalletKey) || null
  }, [bundlerWallets, connectedWalletKey])
  const devWalletOptions = useMemo(() => {
    if (!connectedDevWallet) return activeWallets
    if (activeWallets.some((wallet) => wallet.publicKey === connectedDevWallet.publicKey)) {
      return activeWallets
    }
    return [connectedDevWallet, ...activeWallets]
  }, [activeWallets, connectedDevWallet])
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
      await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          publicKey,
          role,
        }),
      })
      // Optimistically update local state
      setBundlerWallets(prev => prev.map(w => w.publicKey === publicKey ? { ...w, role } : w))
    } catch (error) {
      console.error("Failed to update wallet role:", error)
    }
  }, [])

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
          // Optimistic update: show cached wallets immediately
          setBundlerWallets(data.wallets)

          // Refresh in background
          if (data.wallets.length > 0) {
            fetch("/api/bundler/wallets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "refresh",
                wallets: data.wallets,
              }),
            })
            .then(res => res.json())
            .then(refreshData => {
              if (refreshData.wallets && Array.isArray(refreshData.wallets)) {
                setBundlerWallets(refreshData.wallets)
              }
            })
            .catch(err => console.error("background wallet refresh failed", err))
          }

          const nextWallets = data.wallets
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

  const handleAddBuyerWallet = () => {
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
  }

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
    resetFsm("launch: preparing payload")

    try {
      const { jitoTipNum, priorityNum, slippageNum } = normalizeLaunchNumbers()
      pushFsm("building", "assembling launch bundle and jito tip")

      const launchWallets = [
        { ...devWallet, isActive: true },
        ...buyersResolved.map((entry) => ({ ...entry.wallet!, isActive: true })),
      ]
      const buyAmounts = [parsedDevBuy, ...buyerAmounts]
      const funderAmount = parseSol(funderAmountPerWallet)

      if (autoFundEnabled) {
        if (!Number.isFinite(funderAmount) || funderAmount <= 0) {
          toast.error("set valid funder amount per wallet")
          pushFsm("failed", "invalid funder amount")
          setLaunchLoading(false)
          return
        }

        addSystemLog(`Auto-funding ${launchWallets.length} wallets`, "info")
        pushFsm("preparing", `funding ${launchWallets.length} wallets`)

        if (useConnectedFunder) {
          if (!connected || !publicKey) {
            toast.error("connect funder wallet")
            return
          }
          const balanceRes = await fetch(`/api/solana/balance?publicKey=${publicKey.toBase58()}`)
          const balanceData = await balanceRes.json()
          const balanceLamports = Number(balanceData?.lamports ?? 0)
          const totalSolNeeded = (funderAmount * launchWallets.length) + 0.01
          if (balanceLamports / LAMPORTS_PER_SOL < totalSolNeeded) {
            const message = `Insufficient balance. Need ${totalSolNeeded.toFixed(4)} SOL`
            toast.error(message)
            addSystemLog(message, "error")
            pushFsm("failed", "insufficient funder balance")
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
            pushFsm("failed", "funding failed")
            return
          }
          addSystemLog(`Auto-fund ok: ${fundData.signature?.slice(0, 8)}...`, "success")
        }
      }

      pushFsm("sending", "POST /api/bundler/launch")
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

      pushFsm("confirming", "waiting for jito/bundle response")
      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
        addSystemLog(`launch failed: ${data.error}`, "error")
        pushFsm("failed", data.error)
      } else {
        toast.success(`launched! mint: ${data.mintAddress}`)
        addSystemLog(`launch ok: ${data.mintAddress}`, "success")
        pushFsm("landed", `bundle ${data.bundleId || "ok"} landed`, data.bundleId || "")

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
      pushFsm("failed", error.message || "unknown error")
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

    try {
      const res = await fetch("/api/bundler/rugpull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: buyerWallets,
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
    // Try to find the dev wallet from roles if not manual/connected override
    const devRoleWallet = bundlerWallets.find(w => w.role === 'dev')

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
        // Fallback: is the connected wallet the dev wallet?
        const message = "Connected wallet secret not found in saved wallets"
        // If we found a dev role wallet, maybe suggesting it?
        if (devRoleWallet) {
           addSystemLog("Using detected dev wallet from role instead of connected", "info")
           resolvedDevKey = devRoleWallet.secretKey
        } else {
           addSystemLog(message, "error")
           toast.error(message)
           return
        }
      } else {
        resolvedDevKey = match.secretKey
      }
    } else if (devKey.trim()) {
      resolvedDevKey = devKey.trim()
    } else if (devRoleWallet) {
       addSystemLog("Using detected dev wallet from role", "info")
       resolvedDevKey = devRoleWallet.secretKey
    } else {
        addSystemLog("Dev wallet private key required", "error")
        toast.error("dev wallet key required")
        return
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

    try {
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "collect",
          wallets: sourceWallets,
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
    }
  }, [launchDevWallet, bundlerWallets, activeWallets, loadSavedWallets, addSystemLog])

  // Withdraw Dev to Connected
  const withdrawDevToConnected = useCallback(async () => {
    if (!connected || !publicKey) {
      toast.error("Connect wallet to receive funds")
      return
    }

    let devWalletObj: BundlerWallet | undefined = bundlerWallets.find(w => w.publicKey === launchDevWallet)

    // fallback to searching by role
    if (!devWalletObj) {
        devWalletObj = bundlerWallets.find(w => w.role === 'dev')
    }

    if (!devWalletObj && devKey.trim()) {
         try {
            const bs58 = (await import("bs58")).default
            const kp = Keypair.fromSecretKey(bs58.decode(devKey.trim()))
            devWalletObj = {
                publicKey: kp.publicKey.toBase58(),
                secretKey: devKey.trim(),
                solBalance: 0,
                tokenBalance: 0,
                isActive: true
            }
         } catch {
             toast.error("Invalid dev private key")
             return
         }
    }

    if (!devWalletObj) {
        toast.error("Dev wallet not found or selected")
        return
    }

    if (devWalletObj.publicKey === publicKey.toBase58()) {
        toast.error("Dev wallet is already the connected wallet")
        return
    }

    if (!confirm(`Withdraw SOL from Dev Wallet (${devWalletObj.publicKey.slice(0,6)}...) to Connected Wallet (${publicKey.toBase58().slice(0,6)}...)?`)) {
        return
    }

    try {
       const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "collect",
          wallets: [devWalletObj],
          recipientAddress: publicKey.toBase58()
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
    }

  }, [connected, publicKey, launchDevWallet, bundlerWallets, devKey, loadSavedWallets, addSystemLog])

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
    const interval = setInterval(fetchDashboardData, 60000)
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

  const generateFunderWallet = async () => {
    try {
      const { Keypair } = await import("@solana/web3.js")
      const bs58 = (await import("bs58")).default
      const keypair = Keypair.generate()
      setFunderKey(bs58.encode(keypair.secretKey))
      toast.success("generated new funder wallet")
    } catch (error: any) {
      toast.error("failed to generate funder")
    }
  }

  const topUpFunder = async () => {
    if (!funderKey) {
      toast.error("enter funder key first")
      return
    }
    if (!connected || !publicKey) {
      toast.error("connect wallet first")
      return
    }

    try {
      const { Keypair } = await import("@solana/web3.js")
      const bs58 = (await import("bs58")).default
      const funderPubkey = Keypair.fromSecretKey(bs58.decode(funderKey)).publicKey

      const amountStr = prompt("Enter amount to top up (SOL):", "1")
      if (!amountStr) return
      const amount = parseFloat(amountStr)
      if (!amount || amount <= 0) return

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: funderPubkey,
          lamports: amount * LAMPORTS_PER_SOL
        })
      )

      const sig = await sendTransaction(tx, connection)
      await connection.confirmTransaction(sig, "confirmed")
      toast.success(`top up sent: ${sig.slice(0, 8)}...`)
    } catch (error: any) {
      toast.error(`top up failed: ${error.message}`)
    }
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
          <Button onClick={fetchDashboardData} variant="outline" size="sm" className="h-7 px-2">
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>
      </div>
      )}

      {isLaunchStage && (
        <div className="mb-4">
          <LaunchStatus fsmCurrent={fsmCurrent} fsmSteps={fsmSteps} activeBundleId={activeBundleId} />
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-1">
        {!isLaunchStage && (
        <>
          <div className="xl:col-span-7 space-y-1">
            <TokenInfoCard
              selectedToken={selectedToken}
              tokenFinanceLoading={tokenFinanceLoading}
              currentPriceSol={currentPriceSol}
              marketCapSol={marketCapSol}
              totalSupplyValue={totalSupplyValue}
              tokenFinance={tokenFinance}
              holdersLoading={holdersLoading}
              holderCount={holderRows.length}
            />
          </div>

          <div className="xl:col-span-5 space-y-1">
            <RugpullPanel
              rugpullSlippage={rugpullSlippage}
              setRugpullSlippage={setRugpullSlippage}
              useConnectedDev={useConnectedDev}
              setUseConnectedDev={setUseConnectedDev}
              devKey={devKey}
              setDevKey={setDevKey}
              rugpullEstimate={rugpullEstimate}
              totalTokensToSell={totalTokensToSell}
              profitEstimateSol={profitEstimateSol}
              selectedToken={selectedToken}
              activeWalletsWithTokens={activeWalletsWithTokens}
              rugpullAllWallets={rugpullAllWallets}
              rugpullDevWallet={rugpullDevWallet}
              collectAllToDev={collectAllToDev}
              withdrawDevToConnected={withdrawDevToConnected}
              connected={connected}
              publicKey={publicKey}
            />

            <VolumeBotPanel
              volumeRunning={volumeRunning}
              volumeBotStatus={volumeBotStatus}
              volumeBotConfig={volumeBotConfig}
              setSettingsOpen={setSettingsOpen}
              startVolumeBot={startVolumeBot}
              stopVolumeBot={stopVolumeBot}
              selectedToken={selectedToken}
              loading={loading}
              volumeBotStats={volumeBotStats}
              activeWallets={activeWallets}
              setQuickTradeWallet={setQuickTradeWallet}
            />
          </div>

          <AnalyticsPanel
            holdersLoading={holdersLoading}
            holderRows={holderRows}
            trades={trades}
            systemLogs={systemLogs}
            volumeBotStatus={volumeBotStatus}
            clearSystemLogs={clearSystemLogs}
            formatTimeAgo={formatTimeAgo}
          />
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
          <LaunchPanel
            tokenName={tokenName}
            setTokenName={setTokenName}
            tokenSymbol={tokenSymbol}
            setTokenSymbol={setTokenSymbol}
            tokenDescription={tokenDescription}
            setTokenDescription={setTokenDescription}
            tokenWebsite={tokenWebsite}
            setTokenWebsite={setTokenWebsite}
            tokenTwitter={tokenTwitter}
            setTokenTwitter={setTokenTwitter}
            tokenTelegram={tokenTelegram}
            setTokenTelegram={setTokenTelegram}
            tokenImage={tokenImage}
            tokenImagePreview={tokenImagePreview}
            handleTokenImageChange={handleTokenImageChange}
            handleImageUpload={handleImageUpload}
            launchLoading={launchLoading}
            metadataUri={metadataUri}
            launchTemplateMint={launchTemplateMint}
            setCloneTokenMint={setCloneTokenMint}
            setCloneDialogOpen={setCloneDialogOpen}
            resetLaunchForm={resetLaunchForm}
            cloneLoading={cloneLoading}
            launchDevWallet={launchDevWallet}
            setLaunchDevWallet={setLaunchDevWallet}
            buyerWallets={buyerWallets}
            setBuyerWallets={setBuyerWallets}
            activeWallets={activeWallets}
            totalBuyAmount={totalBuyAmount}
            setTotalBuyAmount={setTotalBuyAmount}
            handleAddBuyerWallet={handleAddBuyerWallet}
            handleRemoveBuyerWallet={handleRemoveBuyerWallet}
            handleEqualBuy={handleEqualBuy}
            handleRandomBuy={handleRandomBuy}
            autoFundEnabled={autoFundEnabled}
            setAutoFundEnabled={setAutoFundEnabled}
            autoCreateAtaEnabled={autoCreateAtaEnabled}
            setAutoCreateAtaEnabled={setAutoCreateAtaEnabled}
            useConnectedFunder={useConnectedFunder}
            setUseConnectedFunder={setUseConnectedFunder}
            funderAmountPerWallet={funderAmountPerWallet}
            setFunderAmountPerWallet={setFunderAmountPerWallet}
            funderKey={funderKey}
            setFunderKey={setFunderKey}
            generateFunderWallet={generateFunderWallet}
            topUpFunder={topUpFunder}
            devBuyAmount={devBuyAmount}
            setDevBuyAmount={setDevBuyAmount}
            buyAmountPerWallet={buyAmountPerWallet}
            setBuyAmountPerWallet={setBuyAmountPerWallet}
            jitoTipSol={jitoTipSol}
            priorityFeeSol={priorityFeeSol}
            handleLaunch={handleLaunch}
            networkBlocked={networkBlocked}
            isMainnet={isMainnet}
            connectedWalletKey={connectedWalletKey}
            updateWalletRole={updateWalletRole}
            parseSol={parseSol}
            devWalletOptions={devWalletOptions}
          />
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



