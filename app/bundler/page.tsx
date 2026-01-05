"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LaunchPanel } from "@/components/bundler/LaunchPanel"
import { toast } from "sonner"
import { clampNumber } from "@/lib/ui-utils"
import {
  Rocket,
  Wallet,
  Plus,
  Trash2,
  RefreshCw,
  Copy,
  AlertTriangle,
  Download,
  Zap,
  TrendingUp,
  TrendingDown,
  Package,
  Send,
  DollarSign,
  Clock,
  Settings,
  Flame,
} from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { useWallet } from "@solana/wallet-adapter-react"
import { SystemProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js"
import { RPC_ENDPOINT, connection } from "@/lib/solana/config"

interface BundlerWallet {
  publicKey: string
  secretKey: string
  solBalance: number
  tokenBalance: number
  isActive: boolean
  label?: string
  buyAmount?: number
  sellPercentage?: number
  ataExists?: boolean
  role?: string
}

interface BundleLog {
  id: string
  type: "launch" | "buy" | "sell"
  bundleId: string
  success: boolean
  signatures: string[]
  mintAddress?: string
  error?: string
  timestamp: number
}

type FsmStatus = "idle" | "preparing" | "building" | "sending" | "confirming" | "landed" | "failed"

interface FsmStep {
  state: FsmStatus
  note: string
  at: number
  bundleId?: string
}

export default function BundlerPage() {
  const { publicKey: connectedPublicKey, sendTransaction } = useWallet()
  // state
  const [network, setNetwork] = useState<string>("unknown")
  const [rpcEndpoint, setRpcEndpoint] = useState<string>(RPC_ENDPOINT)
  const [pumpFunAvailable, setPumpFunAvailable] = useState<boolean | null>(null)
  const [rpcHealthy, setRpcHealthy] = useState<boolean | null>(null)
  const [wallets, setWallets] = useState<BundlerWallet[]>([])
  const [bundleLogs, setBundleLogs] = useState<BundleLog[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState("wallets")
  const [fsmCurrent, setFsmCurrent] = useState<FsmStatus>("idle")
  const [fsmSteps, setFsmSteps] = useState<FsmStep[]>([{
    state: "idle",
    note: "ready for next bundle",
    at: Date.now(),
  }])
  const [activeBundleId, setActiveBundleId] = useState("")

  // Dev & Funder wallets (DB-backed)
  const [devWalletInput, setDevWalletInput] = useState("")
  const [funderWalletInput, setFunderWalletInput] = useState("")

  // wallet management
  const [importKey, setImportKey] = useState("")
  const [walletCount, setWalletCount] = useState("5")
  const [fundAmount, setFundAmount] = useState("0.05")
  const [buyAmountAll, setBuyAmountAll] = useState("0.01")

  // wallet groups
  const [walletGroups, setWalletGroups] = useState<Array<{ id: string; name: string; type: string; _count: { wallets: number } }>>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [groupName, setGroupName] = useState("")
  const [groupType, setGroupType] = useState<"custom" | "launch" | "exit" | "volume">("custom")
  // gather
  const [gatherBuyerAddress, setGatherBuyerAddress] = useState("")
  const [gatherWalletIds, setGatherWalletIds] = useState("")
  const [gatherGroupIds, setGatherGroupIds] = useState("")
  const [gatherPriorityFee, setGatherPriorityFee] = useState("220000")
  const [gatherLoading, setGatherLoading] = useState(false)

  // launch mode (Bundler, Stagger, Bundle+Stagger)
  const [launchMode, setLaunchMode] = useState<"bundler" | "stagger" | "bundle-stagger">("bundler")
  const [warmupEnabled, setWarmupEnabled] = useState(false)
  const [warmupProgress, setWarmupProgress] = useState(0)

  // token settings
  const [mintAddress, setMintAddress] = useState("")
  const [launchedTokens, setLaunchedTokens] = useState<Array<{ id: string; mintAddress: string; name: string; symbol: string }>>([])

  // launch settings
  const [tokenName, setTokenName] = useState("JITSU")
  const [tokenSymbol, setTokenSymbol] = useState("JTSU")
  const [tokenDescription, setTokenDescription] = useState("test launch via bundler")
  const [tokenImage, setTokenImage] = useState<File | null>(null)
  const [metadataUri, setMetadataUri] = useState("")
  const [devBuyAmount, setDevBuyAmount] = useState("0.1")

  // buy/sell settings
  const [buyAmountPerWallet, setBuyAmountPerWallet] = useState("0.01")
  const [sellPercentage, setSellPercentage] = useState("100")
  const [mode, setMode] = useState<"bundle" | "stagger">("bundle")
  const [staggerDelayMin, setStaggerDelayMin] = useState("1000")
  const [staggerDelayMax, setStaggerDelayMax] = useState("3000")
  // LUT intentionally not used for Jito bundles (per Jito guidance + project policy)

  // jito settings
  const [jitoTip, setJitoTip] = useState("0.0001")
  const [priorityFee, setPriorityFee] = useState("0.0001")
  const [slippage, setSlippage] = useState("20")
  const [jitoRegion, setJitoRegion] = useState("auto")

  const allowPrivateKeys = true
  const networkBlocked = pumpFunAvailable === false || rpcHealthy === false
  const formatRpcLabel = (value: string) => {
    try {
      const url = new URL(value)
      return url.host
    } catch {
      return value
    }
  }

  const activeWallets = useMemo(() => wallets.filter((w) => w.isActive), [wallets])
  const activeWalletCount = activeWallets.length
  const devWalletRecord = useMemo(() => wallets.find((w) => w.role === "dev") || null, [wallets])
  const funderWalletRecord = useMemo(() => wallets.find((w) => w.role === "funder") || null, [wallets])

  const applyStaggerPreset = (preset: "fast" | "human" | "slow") => {
    if (preset === "fast") {
      setStaggerDelayMin("200")
      setStaggerDelayMax("600")
    } else if (preset === "human") {
      setStaggerDelayMin("800")
      setStaggerDelayMax("2000")
    } else {
      setStaggerDelayMin("2000")
      setStaggerDelayMax("5000")
    }
  }
  const applyAntiSniperPreset = (preset: "shield" | "smoke" | "ambush") => {
    if (preset === "shield") {
      setMode("bundle")
      setJitoTip("0.002")
      setPriorityFee("0.0015")
      setSlippage("15")
      setStaggerDelayMin("400")
      setStaggerDelayMax("900")
    } else if (preset === "smoke") {
      setMode("stagger")
      setJitoTip("0.001")
      setPriorityFee("0.0008")
      setSlippage("22")
      setStaggerDelayMin("900")
      setStaggerDelayMax("2400")
    } else {
      setMode("bundle")
      setJitoTip("0.0025")
      setPriorityFee("0.002")
      setSlippage("18")
      setStaggerDelayMin("250")
      setStaggerDelayMax("650")
    }
    toast.success("anti-sniper preset applied")
  }
  const totalSolBalance = useMemo(() => wallets.reduce((sum, w) => sum + w.solBalance, 0), [wallets])
  const totalTokenBalance = useMemo(() => wallets.reduce((sum, w) => sum + w.tokenBalance, 0), [wallets])

  const { data: networkData } = useQuery({
    queryKey: ["network-status"],
    queryFn: async () => {
      const res = await fetch("/api/network")
      if (!res.ok) throw new Error("network status failed")
      return res.json()
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  })

  useEffect(() => {
    if (networkData) {
      setNetwork(networkData.network || "unknown")
      setRpcEndpoint(networkData.healthyRpc || networkData.rpc || RPC_ENDPOINT)
      setPumpFunAvailable(networkData.pumpFunAvailable ?? null)
      setRpcHealthy(networkData.rpcHealthy ?? null)
    }
  }, [networkData])

  useEffect(() => {
    const loadTokens = async () => {
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
    loadTokens()
  }, [])

  const updateWalletRole = async (publicKey: string, role: "dev" | "funder") => {
    const trimmed = publicKey.trim()
    if (!trimmed) {
      toast.error(`enter ${role} wallet address`)
      return
    }

    try {
      const existing = role === "dev" ? devWalletRecord : funderWalletRecord
      if (existing && existing.publicKey !== trimmed) {
        const clearRes = await fetch("/api/bundler/wallets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update",
            publicKey: existing.publicKey,
            role: "project",
          }),
        })
        const clearData = await clearRes.json().catch(() => ({}))
        if (!clearRes.ok || clearData?.error) {
          throw new Error(clearData?.error || `failed to clear ${role} wallet`)
        }
      }

      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          publicKey: trimmed,
          role,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) {
        throw new Error(data?.error || `failed to set ${role} wallet`)
      }

      await loadSavedWallets({ silent: true })
      if (role === "dev") {
        setDevWalletInput("")
      } else {
        setFunderWalletInput("")
      }
      toast.success(`${role} wallet assigned`)
    } catch (error: any) {
      toast.error(error?.message || `failed to set ${role} wallet`)
    }
  }

  const clearWalletRole = async (role: "dev" | "funder") => {
    const existing = role === "dev" ? devWalletRecord : funderWalletRecord
    if (!existing) return

    try {
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          publicKey: existing.publicKey,
          role: "project",
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) {
        throw new Error(data?.error || `failed to clear ${role} wallet`)
      }
      await loadSavedWallets({ silent: true })
      toast.success(`${role} wallet cleared`)
    } catch (error: any) {
      toast.error(error?.message || `failed to clear ${role} wallet`)
    }
  }

  const generateRoleWallet = async (role: "dev" | "funder") => {
    try {
      const label = role === "dev" ? "Dev" : "Funder"
      const res = await fetch(`/api/bundler/wallets?action=generate&label=${encodeURIComponent(label)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error || !data?.wallet?.publicKey) {
        throw new Error(data?.error || "failed to generate wallet")
      }

      await updateWalletRole(data.wallet.publicKey, role)
    } catch (error: any) {
      toast.error(error?.message || `failed to generate ${role} wallet`)
    }
  }

  const refreshRoleBalances = async () => {
    const keys = [devWalletRecord?.publicKey, funderWalletRecord?.publicKey].filter(Boolean)
    if (keys.length === 0) return

    try {
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh",
          walletPublicKeys: keys,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.error) {
        throw new Error(data?.error || "failed to refresh balances")
      }
      if (data.wallets) {
        setWallets((prev) => {
          const byKey = new Map(prev.map((w) => [w.publicKey, w]))
          data.wallets.forEach((w: BundlerWallet) => {
            const existing = byKey.get(w.publicKey)
            byKey.set(w.publicKey, {
              ...w,
              buyAmount: existing?.buyAmount ?? w.buyAmount,
              sellPercentage: existing?.sellPercentage ?? w.sellPercentage,
            })
          })
          return Array.from(byKey.values())
        })
      }
    } catch (error: any) {
      toast.error(error?.message || "failed to refresh balances")
    }
  }

  const topUpFunderWallet = async () => {
    if (!funderWalletRecord) {
      toast.error("funder wallet not configured")
      return
    }
    if (!connectedPublicKey) {
      toast.error("connect wallet first")
      return
    }

    const amountStr = prompt("Enter amount to top up (SOL):", "1")
    if (!amountStr) return
    const amount = parseFloat(amountStr)
    if (!amount || amount <= 0) {
      toast.error("invalid amount")
      return
    }

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      const message = new TransactionMessage({
        payerKey: connectedPublicKey,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: connectedPublicKey,
            toPubkey: new PublicKey(funderWalletRecord.publicKey),
            lamports: Math.floor(amount * 1_000_000_000),
          }),
        ],
      }).compileToV0Message()

      const tx = new VersionedTransaction(message)
      const signature = await sendTransaction(tx, connection)
      toast.success(`top up sent: ${signature.slice(0, 8)}...`)
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")
      toast.success("top up confirmed")
      refreshRoleBalances()
    } catch (error: any) {
      console.error("top up failed:", error)
      toast.error(`top up failed: ${error.message}`)
    }
  }

  // wallet warmup - make random transactions to "warm" wallets
  const warmupWallets = async () => {
    if (wallets.length === 0) {
      toast.error("no wallets to warmup")
      return
    }

    setLoading(true)
    setWarmupProgress(0)
    
    try {
      const activeWallets = wallets.filter(w => w.isActive)
      if (activeWallets.length === 0) {
        toast.error("no active wallets to warmup")
        return
      }

      const tipValue = Number.parseFloat(jitoTip)
      const safeTip = Number.isFinite(tipValue) ? tipValue : 0.0001
      const res = await fetch("/api/bundler/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "warmup_batch",
          walletPublicKeys: activeWallets.map((w) => w.publicKey),
          jitoTip: safeTip,
          jitoRegion,
          transferSol: 0.000001,
        }),
      })

      const data = await res.json()
      if (!res.ok || data.error) {
        throw new Error(data.error || "warmup failed")
      }

      setWarmupProgress(100)
      toast.success(`warmed up ${activeWallets.length} wallets`)
    } catch (error: any) {
      toast.error(error.message || "warmup failed")
    } finally {
      setLoading(false)
      setWarmupProgress(0)
    }
  }

  const fsmFlow: FsmStatus[] = ["preparing", "building", "sending", "confirming", "landed"]

  const resetFsm = (note: string) => {
    const now = Date.now()
    setFsmCurrent("preparing")
    setFsmSteps([{ state: "preparing", note, at: now }])
    setActiveBundleId("")
  }

  const pushFsm = (state: FsmStatus, note: string, bundleId?: string) => {
    setFsmCurrent(state)
    setFsmSteps((prev) => {
      const next = [...prev, { state, note, at: Date.now(), ...(bundleId ? { bundleId } : {}) }]
      return next.slice(-12)
    })
    if (bundleId) setActiveBundleId(bundleId)
  }

  // retard prevention - check if can delete wallet
  const canDeleteWallet = (wallet: BundlerWallet): boolean => {
    if (wallet.solBalance > 0.001) {
      return false // has SOL balance
    }
    if (wallet.tokenBalance > 0) {
      return false // has token balance
    }
    return true
  }

  // retard prevention - check if can launch
  const canLaunch = (): { ok: boolean; error?: string } => {
    if (!devWalletRecord) {
      return { ok: false, error: "configure dev wallet first" }
    }
    if (!devWalletRecord.isActive) {
      return { ok: false, error: "dev wallet must be active" }
    }
    const devBuy = parseFloat(devBuyAmount) || 0
    const fees = 0.02 + parseFloat(jitoTip) + parseFloat(priorityFee)
    const minRequired = devBuy + fees
    
    if (devWalletRecord.solBalance < minRequired) {
      return { ok: false, error: `dev wallet needs at least ${minRequired.toFixed(4)} SOL (has ${devWalletRecord.solBalance.toFixed(4)})` }
    }
    
    const activeWallets = wallets.filter(w => w.isActive)
    for (const wallet of activeWallets) {
      const buyAmt = wallet.buyAmount || parseFloat(buyAmountPerWallet)
      const walletFees = parseFloat(priorityFee)
      if (wallet.solBalance < buyAmt + walletFees) {
        return { ok: false, error: `wallet ${wallet.publicKey.slice(0,8)}... needs more SOL` }
      }
    }
    
    return { ok: true }
  }

  // set buy amount for all wallets
  const setAllBuyAmounts = (amount: number) => {
    setWallets(wallets.map(w => ({ ...w, buyAmount: amount })))
    setBuyAmountAll(amount.toString())
    toast.success(`set all buy amounts to ${amount} SOL`)
  }

  // set sell percentage for all wallets
  const setAllSellPercentages = (percentage: number) => {
    setWallets(wallets.map(w => ({ ...w, sellPercentage: percentage })))
    setSellPercentage(percentage.toString())
    toast.success(`set all sell to ${percentage}%`)
  }

  // refund all - collect SOL from all wallets
  const refundAll = async () => {
    if (!funderWalletRecord) {
      toast.error("configure funder wallet to receive funds")
      return
    }
    
    const walletsWithBalance = wallets.filter(w => w.solBalance > 0.001)
    if (walletsWithBalance.length === 0) {
      toast.error("no wallets with balance to refund")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "collect",
          walletPublicKeys: walletsWithBalance.map((wallet) => wallet.publicKey),
          recipientAddress: funderWalletRecord.publicKey,
        }),
      })

      const data = await res.json()
      if (!res.ok || data.error) {
        throw new Error(data.error || `refund failed with status ${res.status}`)
      }

      toast.success(`refunded ${walletsWithBalance.length} wallets to funder`)
      await refreshBalances()
    } catch (error: any) {
      toast.error(error.message || "refund failed")
    } finally {
      setLoading(false)
    }
  }

  // load wallet groups
  const loadWalletGroups = async () => {
    try {
      const res = await fetch("/api/bundler/groups")
      const data = await res.json()
      if (data.groups) {
        setWalletGroups(data.groups)
      }
    } catch (error) {
      console.error("failed to load groups:", error)
    }
  }

  // load wallets and groups on mount
  useEffect(() => {
    loadWalletGroups()
    loadSavedWallets()
  }, [])

  // load saved wallets from DB
  const loadSavedWallets = async (opts?: { silent?: boolean }) => {
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
      
      if (data.wallets && Array.isArray(data.wallets) && data.wallets.length > 0) {
        setWallets((prev) => {
          const byKey = new Map(prev.map((w) => [w.publicKey, w]))
          return data.wallets.map((w: BundlerWallet) => {
            const existing = byKey.get(w.publicKey)
            return {
              ...w,
              buyAmount: existing?.buyAmount ?? w.buyAmount,
              sellPercentage: existing?.sellPercentage ?? w.sellPercentage,
            }
          })
        })
        if (data.wallets.length > 0 && !opts?.silent) {
          toast.success(`loaded ${data.wallets.length} saved wallets`)
        }
      }
    } catch (error: any) {
      console.error("failed to load saved wallets:", error)
      if (!opts?.silent) {
        toast.error(`failed to load wallets: ${error.message || "unknown error"}`)
      }
    }
  }

  useEffect(() => {
    const interval = setInterval(() => {
      loadWalletGroups()
      loadSavedWallets({ silent: true })
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  // use all active wallets
  const useAllActiveWallets = () => {
    const activeWallets = wallets.filter(w => w.isActive)
    if (activeWallets.length === 0) {
      toast.error("no active wallets")
      return
    }
    toast.success(`using ${activeWallets.length} active wallets`)
  }

  // load group wallets
  const loadGroupWallets = async (groupId: string) => {
    try {
      const res = await fetch(`/api/bundler/groups?id=${groupId}`)
      const data = await res.json()
      if (data.group && data.group.wallets) {
        // merge group wallets with current wallets (avoid duplicates)
        const existingKeys = new Set(wallets.map(w => w.publicKey))
        const newWallets = data.group.wallets
          .filter((w: any) => !existingKeys.has(w.publicKey))
          .map((w: any) => ({
            publicKey: w.publicKey,
            secretKey: w.secretKey,
            solBalance: parseFloat(w.solBalance || "0"),
            tokenBalance: parseFloat(w.tokenBalance || "0"),
            isActive: true,
            label: w.label,
            role: w.role,
          }))
        setWallets([...wallets, ...newWallets])
        toast.success(`loaded ${newWallets.length} wallets from group`)
      }
    } catch (error: any) {
      toast.error(error.message || "failed to load group")
    }
  }

  // gather tokens/sol from wallets
  const handleGather = async () => {
    const mainWallet = devWalletRecord || funderWalletRecord
    if (!mainWallet) {
      toast.error("configure dev or funder wallet first")
      return
    }

    setGatherLoading(true)
    try {
      const walletIds = gatherWalletIds.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean)
      const groupIds = gatherGroupIds.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean)
      const priority = parseInt(gatherPriorityFee) || undefined

      const res = await fetch("/api/tools/gather", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mainAddress: mainWallet.publicKey,
          buyerAddress: gatherBuyerAddress.trim() || undefined,
          walletIds: walletIds.length ? walletIds : undefined,
          groupIds: groupIds.length ? groupIds : undefined,
          priorityFeeMicroLamports: priority,
        }),
      })

      const data = await res.json()
      if (!data.success) {
        throw new Error(data.error || "gather failed")
      }

      toast.success(`gathered ${data.signatures?.length || 0} tx`)
    } catch (error: any) {
      toast.error(error?.message || "gather failed")
    } finally {
      setGatherLoading(false)
    }
  }

  // create wallet group from active wallets
  const createGroupFromActive = async () => {
    const activeWallets = wallets.filter(w => w.isActive)
    if (activeWallets.length === 0) {
      toast.error("no active wallets to group")
      return
    }

    if (!groupName.trim()) {
      toast.error("enter group name")
      return
    }

    setLoading(true)
    try {
      // create group
      const createRes = await fetch("/api/bundler/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: groupName,
          type: groupType,
        }),
      })

      const createData = await createRes.json()
      if (createData.error) {
        throw new Error(createData.error)
      }

      // кошельки уже должны быть в БД (сохраняются при генерации/импорте)
      // добавить их в группу
      const walletPublicKeys = activeWallets.map(w => w.publicKey)

      const addRes = await fetch("/api/bundler/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add-wallets",
          groupId: createData.group.id,
          walletPublicKeys,
        }),
      })

      if (addRes.ok) {
        toast.success(`created group "${groupName}" with ${activeWallets.length} wallets`)
        setGroupName("")
        await loadWalletGroups()
      } else {
        throw new Error("failed to add wallets to group")
      }
    } catch (error: any) {
      toast.error(error.message || "failed to create group")
    } finally {
      setLoading(false)
    }
  }

  // wallet functions
  const generateWallets = async () => {
    setLoading(true)
    try {
      const count = parseInt(walletCount) || 5
      if (count < 1 || count > 20) {
        toast.error("count must be between 1 and 20")
        setLoading(false)
        return
      }

      const res = await fetch(`/api/bundler/wallets?action=generate-multiple&count=${count}`)
      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
        return
      }

      if (data.wallets && Array.isArray(data.wallets)) {
        setWallets((prev) => [...prev, ...data.wallets])
        toast.success(`generated ${data.wallets.length} wallets`)
      } else {
        toast.error("invalid response from server")
        console.error("unexpected response:", data)
      }
    } catch (error: any) {
      console.error("generate wallets error:", error)
      toast.error(`failed to generate wallets: ${error.message || "unknown error"}`)
    } finally {
      setLoading(false)
    }
  }

  const importWallet = async () => {
    if (!allowPrivateKeys) {
      toast.error("private keys are disabled by policy")
      return
    }
    if (!importKey.trim()) {
      toast.error("enter private key")
      return
    }

    try {
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import",
          secretKey: importKey.trim(),
        }),
      })

      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
      } else if (data.wallet) {
        if (wallets.some((w) => w.publicKey === data.wallet.publicKey)) {
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

  const refreshBalances = async () => {
    if (wallets.length === 0) return

    setLoading(true)
    try {
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh",
          walletPublicKeys: wallets.map((wallet) => wallet.publicKey),
          mintAddress: mintAddress || undefined,
        }),
      })

      const data = await res.json()
      if (data.wallets) {
        setWallets((prev) => {
          const byKey = new Map(prev.map((w) => [w.publicKey, w]))
          return data.wallets.map((w: BundlerWallet) => {
            const existing = byKey.get(w.publicKey)
            return {
              ...w,
              buyAmount: existing?.buyAmount ?? w.buyAmount,
              sellPercentage: existing?.sellPercentage ?? w.sellPercentage,
            }
          })
        })
        toast.success("balances refreshed")
      }
    } catch (error) {
      toast.error("failed to refresh balances")
    } finally {
      setLoading(false)
    }
  }

  const fundWallets = async () => {
    if (!funderWalletRecord) {
      toast.error("configure funder wallet first")
      return
    }

    const activeWallets = wallets.filter((w) => w.isActive)
    if (activeWallets.length === 0) {
      toast.error("no active wallets")
      return
    }
    if (!devWalletRecord) {
      toast.error("configure dev wallet first")
      return
    }
    if (!activeWallets.some((wallet) => wallet.publicKey === devWalletRecord.publicKey)) {
      toast.error("dev wallet must be active")
      return
    }

    setLoading(true)
    try {
      const amount = parseFloat(fundAmount) || 0.05
      const amounts = activeWallets.map(() => amount)

      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fund",
          funderAddress: funderWalletRecord.publicKey,
          walletPublicKeys: activeWallets.map((wallet) => wallet.publicKey),
          amounts,
        }),
      })

      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
      } else {
        toast.success(`funded ${activeWallets.length} wallets`)
        await refreshBalances()
      }
    } catch (error) {
      toast.error("failed to fund wallets")
    } finally {
      setLoading(false)
    }
  }

  const removeWallet = async (publicKey: string) => {
    const wallet = wallets.find(w => w.publicKey === publicKey)
    if (wallet && !canDeleteWallet(wallet)) {
      toast.error(`cannot delete wallet with balance (${wallet.solBalance.toFixed(4)} SOL)`)
      return
    }
    
    // удалить из БД
    try {
      await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          publicKey,
        }),
      })
    } catch (error) {
      console.error("failed to delete wallet from DB:", error)
    }
    
    setWallets(wallets.filter((w) => w.publicKey !== publicKey))
    toast.success("wallet removed")
  }

  const toggleWallet = async (publicKey: string) => {
    const wallet = wallets.find(w => w.publicKey === publicKey)
    if (!wallet) return
    
    const newActive = !wallet.isActive
    setWallets(wallets.map((w) => (w.publicKey === publicKey ? { ...w, isActive: newActive } : w)))
    
    // обновить в БД
    try {
      await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          publicKey,
          isActive: newActive,
        }),
      })
    } catch (error) {
      console.error("failed to update wallet in DB:", error)
    }
  }

  const toggleAllWallets = async (active: boolean) => {
    setWallets(wallets.map((w) => ({ ...w, isActive: active })))
    
    // обновить все в БД
    try {
      await Promise.all(
        wallets.map(w =>
          fetch("/api/bundler/wallets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "update",
              publicKey: w.publicKey,
              isActive: active,
            }),
          })
        )
      )
    } catch (error) {
      console.error("failed to update wallets in DB:", error)
    }
  }

  // metadata upload
  const handleImageUpload = async () => {
    if (!tokenImage || !tokenName || !tokenSymbol) {
      toast.error("fill in name, symbol, and select image")
      return
    }

    setLoading(true)
    try {
      const formData = new FormData()
      formData.append("file", tokenImage)
      formData.append("name", tokenName)
      formData.append("symbol", tokenSymbol)
      formData.append("description", tokenDescription)

      const res = await fetch("/api/tokens/upload-metadata", {
        method: "POST",
        body: formData,
      })

      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
      } else if (data.metadataUri) {
        setMetadataUri(data.metadataUri)
        toast.success("metadata uploaded to IPFS")
      }
    } catch (error) {
      toast.error("failed to upload metadata")
    } finally {
      setLoading(false)
    }
  }

  // launch bundle
  const normalizeNumbers = () => {
    return {
      jitoTipNum: Math.max(0, parseFloat(jitoTip)),
      priorityNum: Math.max(0, parseFloat(priorityFee)),
      slippageNum: clampNumber(parseInt(slippage), 0, 99),
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

    const activeWallets = wallets.filter((w) => w.isActive)
    if (activeWallets.length === 0) {
      toast.error("no active wallets")
      return
    }

    resetFsm("launch: preparing payload")
    setLoading(true)
    try {
      const { jitoTipNum, priorityNum, slippageNum } = normalizeNumbers()
      pushFsm("building", "assembling launch bundle and jito tip")
      const buyAmounts = [parseFloat(devBuyAmount)]
      for (let i = 1; i < activeWallets.length; i++) {
        buyAmounts.push(parseFloat(buyAmountPerWallet))
      }

      pushFsm("sending", "POST /api/bundler/launch")
      const res = await fetch("/api/bundler/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPublicKeys: activeWallets.map((wallet) => wallet.publicKey),
          devPublicKey: devWalletRecord.publicKey,
          tokenMetadata: {
            name: tokenName,
            symbol: tokenSymbol,
            description: tokenDescription,
            metadataUri,
          },
          devBuyAmount: parseFloat(devBuyAmount),
          buyAmounts,
          jitoTip: jitoTipNum,
          priorityFee: priorityNum,
          slippage: slippageNum,
          jitoRegion,
          // LUT removed
        }),
      })

      pushFsm("confirming", "waiting for jito/bundle response")
      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
        addLog("launch", "", false, [], data.error)
        pushFsm("failed", data.error || "launch failed")
      } else {
        toast.success(`launched! mint: ${data.mintAddress}`)
        setMintAddress(data.mintAddress)
        addLog("launch", data.bundleId, true, data.signatures, undefined, data.mintAddress)
        pushFsm("landed", `bundle ${data.bundleId || "ok"} landed`, data.bundleId || "")
        await refreshBalances()
      }
    } catch (error: any) {
      toast.error("launch failed")
      addLog("launch", "", false, [], error.message)
      pushFsm("failed", error.message || "launch failed")
    } finally {
      setLoading(false)
    }
  }

  // buy bundle
  const handleBuy = async () => {
    if (networkBlocked) {
      toast.error("pump.fun unavailable or rpc unhealthy")
      return
    }
    if (!mintAddress) {
      toast.error("enter mint address")
      return
    }

    const activeWallets = wallets.filter((w) => w.isActive)
    if (activeWallets.length === 0) {
      toast.error("no active wallets")
      return
    }

    resetFsm(`buy ${mode}: preparing payload`)
    setLoading(true)
    try {
      const { jitoTipNum, priorityNum, slippageNum } = normalizeNumbers()
      pushFsm("building", "assembling buy batch")
      const buyAmounts = activeWallets.map(() => parseFloat(buyAmountPerWallet))

      pushFsm("sending", `POST /api/bundler/buy (${mode})`)
      const res = await fetch("/api/bundler/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPublicKeys: activeWallets.map((wallet) => wallet.publicKey),
          mintAddress,
          buyAmounts,
          mode,
          staggerDelay: {
            min: parseInt(staggerDelayMin),
            max: parseInt(staggerDelayMax),
          },
          jitoTip: jitoTipNum,
          priorityFee: priorityNum,
          slippage: slippageNum,
          jitoRegion,
          // LUT removed
        }),
      })

      pushFsm("confirming", "waiting for buy result")
      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
        addLog("buy", "", false, [], data.error)
        pushFsm("failed", data.error || "buy failed")
      } else {
        toast.success(`buy ${mode} executed`)
        addLog("buy", data.bundleId || "", data.success, data.signatures)
        pushFsm("landed", data.bundleId ? `bundle ${data.bundleId} landed` : "buy flow completed", data.bundleId || "")
        await refreshBalances()
      }
    } catch (error: any) {
      toast.error("buy failed")
      addLog("buy", "", false, [], error.message)
      pushFsm("failed", error.message || "buy failed")
    } finally {
      setLoading(false)
    }
  }

  // sell bundle
  const handleSell = async () => {
    if (networkBlocked) {
      toast.error("pump.fun unavailable or rpc unhealthy")
      return
    }
    if (!mintAddress) {
      toast.error("enter mint address")
      return
    }

    const activeWallets = wallets.filter((w) => w.isActive && w.tokenBalance > 0)
    if (activeWallets.length === 0) {
      toast.error("no wallets with tokens")
      return
    }

    resetFsm(`sell ${mode}: preparing payload`)
    setLoading(true)
    try {
      const { jitoTipNum, priorityNum, slippageNum } = normalizeNumbers()
      pushFsm("building", "assembling sell batch")
      const sellPercentages = activeWallets.map(() => parseInt(sellPercentage))

      pushFsm("sending", `POST /api/bundler/sell (${mode})`)
      const res = await fetch("/api/bundler/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPublicKeys: activeWallets.map((wallet) => wallet.publicKey),
          mintAddress,
          sellPercentages,
          mode,
          staggerDelay: {
            min: parseInt(staggerDelayMin),
            max: parseInt(staggerDelayMax),
          },
          jitoTip: jitoTipNum,
          priorityFee: priorityNum,
          slippage: slippageNum,
          jitoRegion,
          // LUT removed
        }),
      })

      pushFsm("confirming", "waiting for sell result")
      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
        addLog("sell", "", false, [], data.error)
        pushFsm("failed", data.error || "sell failed")
      } else {
        toast.success(`sell ${mode} executed`)
        addLog("sell", data.bundleId || "", data.success, data.signatures)
        pushFsm("landed", data.bundleId ? `bundle ${data.bundleId} landed` : "sell flow completed", data.bundleId || "")
        await refreshBalances()
      }
    } catch (error: any) {
      toast.error("sell failed")
      addLog("sell", "", false, [], error.message)
      pushFsm("failed", error.message || "sell failed")
    } finally {
      setLoading(false)
    }
  }

  // rugpull bundle - sell ALL tokens from ALL wallets
  const handleRugpull = async () => {
    if (networkBlocked) {
      toast.error("pump.fun unavailable or rpc unhealthy")
      return
    }
    if (!mintAddress) {
      toast.error("enter mint address")
      return
    }

    const activeWallets = wallets.filter((w) => w.isActive)
    if (activeWallets.length === 0) {
      toast.error("no active wallets")
      return
    }

    // confirm rugpull
    const confirmed = window.confirm(
      `⚠️ RUGPULL WARNING ⚠️\n\n` +
      `this will sell ALL tokens from ALL active wallets!\n` +
      `wallets: ${activeWallets.length}\n` +
      `mint: ${mintAddress.slice(0, 20)}...\n\n` +
      `this action cannot be undone. continue?`
    )

    if (!confirmed) return

    resetFsm(`rugpull: preparing payload`)
    setLoading(true)
    try {
      const { jitoTipNum, priorityNum, slippageNum } = normalizeNumbers()
      pushFsm("building", "assembling rugpull bundle (sell 100% from all wallets)")

      pushFsm("sending", `POST /api/bundler/rugpull`)
      const res = await fetch("/api/bundler/rugpull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPublicKeys: activeWallets.map((wallet) => wallet.publicKey),
          mintAddress,
          jitoTip: jitoTipNum,
          priorityFee: priorityNum,
          slippage: slippageNum,
          jitoRegion,
        }),
      })

      pushFsm("confirming", "waiting for rugpull result")
      const data = await res.json()

      if (data.error) {
        toast.error(data.error)
        addLog("sell", "", false, [], data.error)
        pushFsm("failed", data.error || "rugpull failed")
      } else {
        toast.success(`rugpull executed! sold all tokens from ${data.signatures?.length || 0} wallets`)
        addLog("sell", data.bundleId || "", data.success, data.signatures, undefined, data.mintAddress)
        pushFsm("landed", data.bundleId ? `rugpull bundle ${data.bundleId} landed` : "rugpull completed", data.bundleId || "")
        await refreshBalances()
      }
    } catch (error: any) {
      toast.error("rugpull failed")
      addLog("sell", "", false, [], error.message)
      pushFsm("failed", error.message || "rugpull failed")
    } finally {
      setLoading(false)
    }
  }

  const addLog = (
    type: "launch" | "buy" | "sell",
    bundleId: string,
    success: boolean,
    signatures: string[],
    error?: string,
    mintAddress?: string
  ) => {
    const log: BundleLog = {
      id: Date.now().toString(),
      type,
      bundleId,
      success,
      signatures,
      mintAddress,
      error,
      timestamp: Date.now(),
    }
    setBundleLogs((prev) => [log, ...prev].slice(0, 50))
  }

  const isMainnet = network === "mainnet-beta"
  const visitedStates = new Set(fsmSteps.map((step) => step.state))
  const activeIdx = Math.max(0, fsmFlow.findIndex((s) => s === fsmCurrent))
  const recentFsmSteps = [...fsmSteps].slice(-6).reverse()

  const clampNumber = (value: number, min: number, max: number) => {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, value))
  }

  return (
    <div className="p-6 space-y-6">
      {networkBlocked && (
        <Alert className="border-red-500/50 bg-red-500/10">
          <AlertTriangle className="h-4 w-4 text-red-400" />
          <AlertDescription className="text-red-200">
            pump.fun blocked: {pumpFunAvailable === false ? "pump.fun requires mainnet-beta" : "rpc unhealthy"}.
            please switch network or set a healthy rpc endpoint.
          </AlertDescription>
        </Alert>
      )}

      {/* header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-wider flex items-center gap-2">
            <Package className="w-6 h-6 text-purple-400" />
            PUMP.FUN BUNDLER
          </h1>
          <p className="text-sm text-muted-foreground">create token + bundled buys via jito</p>
        </div>
        <div className="flex gap-2 text-sm">
          <Badge className="bg-purple-500/20 text-purple-400">{wallets.length} wallets</Badge>
          <Badge className="bg-cyan-500/20 text-cyan-400">{totalSolBalance.toFixed(2)} SOL</Badge>
          <Badge className="bg-green-500/20 text-green-400">max 5 per bundle</Badge>
          <Badge className="bg-sky-500/20 text-sky-200">
            rpc {rpcEndpoint ? formatRpcLabel(rpcEndpoint) : "unknown"}
          </Badge>
          {rpcHealthy !== null && (
            <Badge className={rpcHealthy ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}>
              rpc {rpcHealthy ? "healthy" : "unhealthy"}
            </Badge>
          )}
        </div>
      </div>

      {/* quick wallet controls (always visible) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-neutral-200">Generate Sub-Wallets</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input
              type="number"
              value={walletCount}
              onChange={(e) => setWalletCount(e.target.value)}
              className="bg-background border-border w-20"
              min="1"
              max="20"
            />
            <Button onClick={generateWallets} disabled={loading} className="flex-1 bg-purple-500 hover:bg-purple-600">
              <Plus className="w-4 h-4 mr-1" />
              Generate
            </Button>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-neutral-200">Import Private Key</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input
              placeholder="private key..."
              value={importKey}
              onChange={(e) => setImportKey(e.target.value)}
              className="bg-background border-border flex-1"
              type="password"
            />
            <Button onClick={importWallet} variant="outline" className="border-border">
              <Download className="w-4 h-4" />
            </Button>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-neutral-200">Fund Wallets (SOL)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input
              placeholder="funder wallet address"
              value={funderWalletRecord?.publicKey || "not set"}
              readOnly
              className="bg-neutral-950/50 border-border text-slate-500 cursor-not-allowed"
              type="text"
            />
            <div className="flex gap-2">
              <Input
                placeholder="amount per wallet"
                value={fundAmount}
                onChange={(e) => setFundAmount(e.target.value)}
                className="bg-background border-border w-32"
              />
              <Button onClick={fundWallets} disabled={loading || wallets.length === 0 || !funderWalletRecord} className="flex-1">
                Fund active ({activeWalletCount})
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* FSM visualizer */}
      <Card className="bg-gradient-to-r from-[#1a0b14] via-[#2a0d1c] to-[#0d0711] border border-[#ff0054]/30 shadow-[0_0_32px_rgba(255,0,84,0.15)]">
        <CardHeader className="pb-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <CardTitle className="text-sm text-[#EFDBE0]">bundle state machine</CardTitle>
            <p className="text-xs text-neutral-200/70">tracks launch / buy / sell across jito bundler</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className={`border ${fsmCurrent === "failed" ? "bg-red-500/20 text-red-200 border-red-500/40" : "bg-[#ff0054]/20 text-[#ff93b8] border-[#ff0054]/40"}`}>
              state: {fsmCurrent}
            </Badge>
            {activeBundleId && (
              <Badge className="bg-[#E05174]/20 text-[#ffb2c9] border border-[#E05174]/40">
                bundle {activeBundleId.slice(0, 6)}...{activeBundleId.slice(-4)}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {fsmFlow.map((state, idx) => {
              const step = [...fsmSteps].reverse().find((s) => s.state === state)
              const isCurrent = state === fsmCurrent
              const isDone = visitedStates.has(state) && idx < activeIdx
              const baseClasses = isCurrent
                ? "border-[#ff0054] bg-[#ff0054]/15 shadow-[0_0_18px_rgba(255,0,84,0.3)]"
                : isDone
                ? "border-[#E05174]/40 bg-[#E05174]/10"
                : "border-neutral-700 bg-neutral-900/80"
              return (
                <div key={state} className={`p-3 rounded-lg border transition ${baseClasses}`}>
                  <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-[#EFDBE0]">
                    <span>{state}</span>
                    <span className="text-[10px] text-neutral-400">
                      {step ? new Date(step.at).toLocaleTimeString([], { hour12: false }) : "--:--:--"}
                    </span>
                  </div>
                  <div className="text-[11px] text-neutral-200 mt-1 line-clamp-2 min-h-[30px]">
                    {step?.note || "waiting"}
                  </div>
                </div>
              )
            })}
          </div>

            <div className="bg-muted border border-border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-xs text-[#EFDBE0]">
              <span>timeline</span>
              <span className="text-muted-foreground">last {recentFsmSteps.length} steps</span>
            </div>
            <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
              {recentFsmSteps.map((step) => (
                <div
                  key={`${step.state}-${step.at}`}
                  className="flex items-center justify-between text-[11px] text-neutral-200"
                >
                  <span className="font-mono text-neutral-400 w-16">
                    {new Date(step.at).toLocaleTimeString([], { hour12: false })}
                  </span>
                  <span className="w-20 text-[#ff93b8] uppercase">{step.state}</span>
                  <span className="flex-1 text-right text-neutral-300 truncate ml-2">{step.note}</span>
                </div>
              ))}
              {recentFsmSteps.length === 0 && (
                <div className="text-neutral-400 text-xs">no events yet</div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-muted border border-border">
          <TabsTrigger value="wallets" className="data-[state=active]:bg-purple-500/20">
            <Wallet className="w-4 h-4 mr-1" />
            Wallets
          </TabsTrigger>
          <TabsTrigger value="launch" className="data-[state=active]:bg-purple-500/20">
            <Rocket className="w-4 h-4 mr-1" />
            Launch
          </TabsTrigger>
          <TabsTrigger value="trade" className="data-[state=active]:bg-purple-500/20">
            <Zap className="w-4 h-4 mr-1" />
            Buy/Sell
          </TabsTrigger>
          <TabsTrigger value="settings" className="data-[state=active]:bg-purple-500/20">
            <Settings className="w-4 h-4 mr-1" />
            Settings
          </TabsTrigger>
        </TabsList>

        {/* WALLETS TAB */}
        <TabsContent value="wallets" className="space-y-4">
          {/* Dev & Funder Wallets (like Infinity) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Dev Wallet */}
            <Card className={`border ${devWalletRecord ? "border-purple-500/50 bg-purple-900/10" : "border-neutral-700 bg-neutral-900"}`}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm text-neutral-300 flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${devWalletRecord ? "bg-purple-500" : "bg-neutral-600"}`} />
                    Dev Wallet
                  </CardTitle>
                  {devWalletRecord && (
                    <Badge className="bg-purple-500/20 text-purple-400">
                      {devWalletRecord.solBalance.toFixed(4)} SOL
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {devWalletRecord ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 p-2 bg-neutral-800 rounded">
                      <Copy className="w-4 h-4 text-neutral-500" />
                      <span className="text-white font-mono text-sm flex-1">
                        {devWalletRecord.publicKey.slice(0, 8)}...{devWalletRecord.publicKey.slice(-8)}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => {
                        navigator.clipboard.writeText(devWalletRecord.publicKey)
                        toast.success("copied")
                      }}>
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={refreshRoleBalances} size="sm" variant="outline" className="flex-1 border-neutral-700">
                        <RefreshCw className="w-3 h-3 mr-1" />
                        Refresh
                      </Button>
                      <Button onClick={() => clearWalletRole("dev")} size="sm" variant="ghost" className="text-red-400">
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                    <div className="text-xs text-neutral-500">
                      Default Dev Buy: <span className="text-cyan-400">{devBuyAmount} SOL</span>
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <Input
                    placeholder="dev wallet address..."
                    value={devWalletInput}
                    onChange={(e) => setDevWalletInput(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white"
                  />
                  <div className="flex gap-2">
                    <Button onClick={() => updateWalletRole(devWalletInput, "dev")} className="flex-1 bg-purple-500 hover:bg-purple-600">
                      <Plus className="w-4 h-4 mr-1" />
                      Set Dev Wallet
                    </Button>
                    <Button onClick={() => generateRoleWallet("dev")} variant="outline" className="border-neutral-700">
                      Generate
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Funder Wallet */}
            <Card className={`border ${funderWalletRecord ? "border-green-500/50 bg-green-900/10" : "border-neutral-700 bg-neutral-900"}`}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm text-neutral-300 flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${funderWalletRecord ? "bg-green-500" : "bg-neutral-600"}`} />
                    Funder Wallet
                  </CardTitle>
                  {funderWalletRecord && (
                    <Badge className="bg-green-500/20 text-green-400">
                      {funderWalletRecord.solBalance.toFixed(4)} SOL
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {funderWalletRecord ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 p-2 bg-neutral-800 rounded">
                      <Copy className="w-4 h-4 text-neutral-500" />
                      <span className="text-white font-mono text-sm flex-1">
                        {funderWalletRecord.publicKey.slice(0, 8)}...{funderWalletRecord.publicKey.slice(-8)}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => {
                        navigator.clipboard.writeText(funderWalletRecord.publicKey)
                        toast.success("copied")
                      }}>
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={refreshRoleBalances} size="sm" variant="outline" className="flex-1 border-neutral-700">
                        <RefreshCw className="w-3 h-3 mr-1" />
                        Refresh
                      </Button>
                      <Button onClick={topUpFunderWallet} size="sm" variant="outline" className="flex-1 border-neutral-700 bg-green-900/20 text-green-400 hover:bg-green-900/40">
                        <Plus className="w-3 h-3 mr-1" />
                        Top Up
                      </Button>
                      <Button onClick={() => clearWalletRole("funder")} size="sm" variant="ghost" className="text-red-400">
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <Input
                    placeholder="funder wallet address..."
                    value={funderWalletInput}
                    onChange={(e) => setFunderWalletInput(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white"
                  />
                  <div className="flex gap-2">
                    <Button onClick={() => updateWalletRole(funderWalletInput, "funder")} className="flex-1 bg-green-600 hover:bg-green-700">
                      <Plus className="w-4 h-4 mr-1" />
                      Set Funder
                    </Button>
                    <Button onClick={() => generateRoleWallet("funder")} variant="outline" className="border-neutral-700">
                      Generate
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Action Buttons Row */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Button onClick={generateWallets} disabled={loading} className="bg-purple-500 hover:bg-purple-600">
              <Plus className="w-4 h-4 mr-1" />
              Generate Wallets
            </Button>
            <Button onClick={() => setAllBuyAmounts(parseFloat(buyAmountAll))} variant="outline" className="border-neutral-700">
              <DollarSign className="w-4 h-4 mr-1" />
              Set Fund Amounts
            </Button>
            <Button onClick={() => setAllBuyAmounts(parseFloat(buyAmountPerWallet))} variant="outline" className="border-neutral-700">
              <TrendingUp className="w-4 h-4 mr-1" />
              Set Buy Amounts
            </Button>
            <Button onClick={warmupWallets} disabled={loading || wallets.length === 0} variant="outline" className="border-neutral-700">
              <Zap className="w-4 h-4 mr-1" />
              {warmupProgress > 0 ? `Warming ${warmupProgress}%` : "Wallet Warmup"}
            </Button>
            <Button onClick={importWallet} disabled={!importKey} variant="outline" className="border-neutral-700">
              <Download className="w-4 h-4 mr-1" />
              Import Wallets
            </Button>
            <Button onClick={refundAll} disabled={loading || !funderWalletRecord} variant="outline" className="border-neutral-700">
              <Send className="w-4 h-4 mr-1" />
              Claim Fees ({totalSolBalance.toFixed(4)} SOL)
            </Button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* wallet generation */}
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-neutral-300">Generate Sub-Wallets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={walletCount}
                    onChange={(e) => setWalletCount(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white w-20"
                    min="1"
                    max="20"
                  />
                  <Button onClick={generateWallets} disabled={loading} className="flex-1 bg-purple-500 hover:bg-purple-600">
                    <Plus className="w-4 h-4 mr-1" />
                    Generate
                  </Button>
                </div>

                <div className="flex gap-2">
                  <Input
                    placeholder="private key..."
                    value={importKey}
                    onChange={(e) => setImportKey(e.target.value)}
                    type="password"
                    className="bg-neutral-800 border-neutral-700 text-white flex-1"
                  />
                  <Button onClick={importWallet} variant="outline" className="border-neutral-700">
                    <Download className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* fund wallets */}
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-neutral-300">Fund Wallets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="funder wallet address"
                  value={funderWalletRecord?.publicKey || "not set"}
                  readOnly
                  type="text"
                  className="bg-neutral-950/50 border-neutral-700 text-slate-500 cursor-not-allowed"
                />
                <div className="flex gap-2">
                  <Input
                    type="number"
                    step="0.01"
                    value={fundAmount}
                    onChange={(e) => setFundAmount(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white w-24"
                  />
                  <span className="text-neutral-500 self-center">SOL each</span>
                  <Button
                    onClick={fundWallets}
                    disabled={loading || activeWalletCount === 0 || !funderWalletRecord}
                    className="flex-1 bg-green-600 hover:bg-green-700"
                  >
                    <Send className="w-4 h-4 mr-1" />
                    Fund ({activeWalletCount})
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* quick actions */}
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-neutral-300">Quick Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Button onClick={refreshBalances} disabled={loading} variant="outline" className="flex-1 border-neutral-700">
                    <RefreshCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                  <Button onClick={() => toggleAllWallets(true)} variant="outline" className="border-neutral-700">
                    All On
                  </Button>
                  <Button onClick={() => toggleAllWallets(false)} variant="outline" className="border-neutral-700">
                    All Off
                  </Button>
                </div>
                <Input
                  placeholder="token mint address (for balance check)"
                  value={mintAddress}
                  onChange={(e) => setMintAddress(e.target.value)}
                  className="bg-neutral-800 border-neutral-700 text-white text-xs"
                />
              </CardContent>
            </Card>
          </div>

          {/* wallet groups */}
          <Card className="bg-neutral-900 border-neutral-700">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-neutral-300">Wallet Groups</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Select value={selectedGroupId || "none"} onValueChange={(v) => {
                  if (v === "none") {
                    setSelectedGroupId(null)
                  } else {
                    setSelectedGroupId(v)
                    if (v) loadGroupWallets(v)
                  }
                }}>
                  <SelectTrigger className="bg-neutral-800 border-neutral-700 text-white flex-1">
                    <SelectValue placeholder="select group or create new" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">none</SelectItem>
                    {walletGroups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name} ({g._count.wallets} wallets)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={loadWalletGroups} variant="outline" className="border-neutral-700">
                  <RefreshCw className="w-4 h-4" />
                </Button>
              </div>

              <div className="flex gap-2">
                <Input
                  placeholder="group name..."
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  className="bg-neutral-800 border-neutral-700 text-white flex-1"
                />
                <Select value={groupType} onValueChange={(v: any) => setGroupType(v)}>
                  <SelectTrigger className="bg-neutral-800 border-neutral-700 text-white w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">custom</SelectItem>
                    <SelectItem value="launch">launch</SelectItem>
                    <SelectItem value="exit">exit</SelectItem>
                    <SelectItem value="volume">volume</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  onClick={createGroupFromActive}
                  disabled={loading || !groupName.trim() || activeWalletCount === 0}
                  className="bg-purple-500 hover:bg-purple-600"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Create from Active
                </Button>
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={useAllActiveWallets}
                  disabled={activeWalletCount === 0}
                  variant="outline"
                  className="flex-1 border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/10"
                >
                  <Package className="w-4 h-4 mr-2" />
                  Use All Active ({activeWalletCount})
                </Button>
                <Button
                  onClick={loadSavedWallets}
                  variant="outline"
                  className="border-neutral-700"
                  title="load all saved wallets from database"
                >
                  <Download className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* gather from wallets */}
          <Card className="bg-neutral-900 border-neutral-700">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-neutral-300">Gather (tokens + SOL)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Main Wallet (dev/funder)</Label>
                  <Input
                    type="text"
                    value={devWalletRecord?.publicKey || funderWalletRecord?.publicKey || "not set"}
                    readOnly
                    placeholder="set dev or funder wallet"
                    className="bg-neutral-950/50 border-neutral-700 text-slate-500 cursor-not-allowed"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Buyer Wallet Address (optional)</Label>
                  <Input
                    type="text"
                    value={gatherBuyerAddress}
                    onChange={(e) => setGatherBuyerAddress(e.target.value)}
                    placeholder="public key"
                    className="bg-neutral-800 border-neutral-700 text-white"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Wallet IDs (comma/space separated)</Label>
                  <Input
                    value={gatherWalletIds}
                    onChange={(e) => setGatherWalletIds(e.target.value)}
                    placeholder="cuid1, cuid2 ..."
                    className="bg-neutral-800 border-neutral-700 text-white"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Group IDs (comma/space separated)</Label>
                  <Input
                    value={gatherGroupIds}
                    onChange={(e) => setGatherGroupIds(e.target.value)}
                    placeholder="group cuid list"
                    className="bg-neutral-800 border-neutral-700 text-white"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Priority Fee (microLamports)</Label>
                  <Input
                    type="number"
                    value={gatherPriorityFee}
                    onChange={(e) => setGatherPriorityFee(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white"
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    onClick={handleGather}
                    disabled={gatherLoading}
                    className="w-full bg-[#ff0054] hover:bg-[#ff2d6f]"
                  >
                    {gatherLoading ? "gathering..." : "gather now"}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-neutral-500">
                Gathers token accounts and SOL into the selected dev/funder wallet. Filter sources by walletId or groupId.
              </p>
            </CardContent>
          </Card>

          {/* wallet list */}
          <Card className="bg-neutral-900 border-neutral-700">
            <CardHeader className="pb-3">
              <div className="flex justify-between items-center">
                <CardTitle className="text-sm text-neutral-300">
                  Wallets ({wallets.length}) - Active: {activeWalletCount}
                </CardTitle>
                <Badge className="bg-cyan-500/20 text-cyan-400">Total: {totalSolBalance.toFixed(4)} SOL</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {wallets.length === 0 ? (
                  <div className="text-neutral-500 text-sm p-4 text-center">no wallets. generate or import.</div>
                ) : (
                  wallets.map((wallet, i) => (
                    <div
                      key={wallet.publicKey}
                      className={`p-3 rounded border ${
                        wallet.isActive ? "bg-neutral-800 border-purple-500/30" : "bg-neutral-900 border-neutral-700"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Switch checked={wallet.isActive} onCheckedChange={() => toggleWallet(wallet.publicKey)} />
                          <span className="text-white font-mono text-sm">
                            #{i + 1} {wallet.publicKey.slice(0, 8)}...{wallet.publicKey.slice(-6)}
                          </span>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right text-sm">
                            <div className="text-cyan-400 font-mono">{wallet.solBalance.toFixed(4)} SOL</div>
                            {wallet.tokenBalance > 0 && (
                              <div className="text-green-400 font-mono text-xs">{wallet.tokenBalance.toFixed(0)} tokens</div>
                            )}
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
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* LAUNCH TAB */}
        <TabsContent value="launch" className="space-y-4">
          <LaunchPanel
            tokenName={tokenName}
            onTokenNameChange={setTokenName}
            tokenSymbol={tokenSymbol}
            onTokenSymbolChange={setTokenSymbol}
            tokenDescription={tokenDescription}
            onTokenDescriptionChange={setTokenDescription}
            tokenImage={tokenImage}
            onTokenImageChange={setTokenImage}
            metadataUri={metadataUri}
            onUploadMetadata={handleImageUpload}
            devBuyAmount={devBuyAmount}
            onDevBuyAmountChange={setDevBuyAmount}
            buyAmountPerWallet={buyAmountPerWallet}
            onBuyAmountPerWalletChange={setBuyAmountPerWallet}
            activeWalletCount={activeWalletCount}
            jitoTip={jitoTip}
            priorityFee={priorityFee}
            onApplyStaggerPreset={applyStaggerPreset}
            onLaunch={handleLaunch}
            loading={loading}
            isMainnet={isMainnet}
          />
        </TabsContent>
        {/* TRADE TAB */}
        <TabsContent value="trade" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* buy section */}
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-neutral-300 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-green-400" />
                  Bundle Buy
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Token Mint Address</Label>
                  <div className="flex flex-col gap-2">
                    <Input
                      value={mintAddress}
                      onChange={(e) => setMintAddress(e.target.value)}
                      placeholder="mint address..."
                      className="bg-neutral-800 border-neutral-700 text-white"
                    />
                    {launchedTokens.length > 0 && (
                      <Select
                        onValueChange={(v) => {
                          const token = launchedTokens.find((t) => t.id === v)
                          if (token) {
                            setMintAddress(token.mintAddress)
                          }
                        }}
                      >
                        <SelectTrigger className="bg-neutral-800 border-neutral-700 text-white">
                          <SelectValue placeholder="pick launched token" />
                        </SelectTrigger>
                        <SelectContent>
                          {launchedTokens.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.symbol} — {t.mintAddress.slice(0, 6)}...{t.mintAddress.slice(-4)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label className="text-neutral-400 text-xs">Amount per Wallet (SOL)</Label>
                    <Input
                      type="number"
                      step="0.001"
                      value={buyAmountPerWallet}
                      onChange={(e) => setBuyAmountPerWallet(e.target.value)}
                      className="bg-neutral-800 border-neutral-700 text-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-neutral-400 text-xs">Mode</Label>
                    <Select value={mode} onValueChange={(v) => setMode(v as "bundle" | "stagger")}>
                      <SelectTrigger className="bg-neutral-800 border-neutral-700 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bundle">Bundle (Jito)</SelectItem>
                        <SelectItem value="stagger">Stagger (Delay)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Anti-sniper presets</Label>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => applyAntiSniperPreset("shield")} className="border-[#ff0054]/50 text-[#ff93b8] hover:bg-[#ff0054]/10">
                      shield (bundle)
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => applyAntiSniperPreset("smoke")} className="border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10">
                      smoke (stagger)
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => applyAntiSniperPreset("ambush")} className="border-amber-400/50 text-amber-200 hover:bg-amber-400/10">
                      ambush (burst)
                    </Button>
                  </div>
                </div>

                <Button
                  onClick={handleBuy}
                  disabled={loading || !mintAddress || activeWalletCount === 0 || !isMainnet}
                  className="w-full bg-green-600 hover:bg-green-700"
                >
                  <TrendingUp className="w-4 h-4 mr-2" />
                  {loading ? "BUYING..." : `BUY (${activeWalletCount} wallets)`}
                </Button>
              </CardContent>
            </Card>

            {/* sell section */}
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-neutral-300 flex items-center gap-2">
                  <TrendingDown className="w-4 h-4 text-red-400" />
                  Bundle Sell
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Sell Percentage</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min="1"
                      max="100"
                      value={sellPercentage}
                      onChange={(e) => setSellPercentage(e.target.value)}
                      className="bg-neutral-800 border-neutral-700 text-white"
                    />
                    <span className="text-neutral-500 self-center">%</span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={() => setSellPercentage("25")}
                    variant="outline"
                    size="sm"
                    className="flex-1 border-neutral-700"
                  >
                    25%
                  </Button>
                  <Button
                    onClick={() => setSellPercentage("50")}
                    variant="outline"
                    size="sm"
                    className="flex-1 border-neutral-700"
                  >
                    50%
                  </Button>
                  <Button
                    onClick={() => setSellPercentage("75")}
                    variant="outline"
                    size="sm"
                    className="flex-1 border-neutral-700"
                  >
                    75%
                  </Button>
                  <Button
                    onClick={() => setSellPercentage("100")}
                    variant="outline"
                    size="sm"
                    className="flex-1 border-red-500/50 text-red-400"
                  >
                    100%
                  </Button>
                </div>

                <div className="p-2 bg-neutral-800 rounded text-sm">
                  <div className="flex justify-between">
                    <span className="text-neutral-400">Total Token Balance:</span>
                    <span className="text-white font-mono">{totalTokenBalance.toFixed(0)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-400">Wallets with Tokens:</span>
                    <span className="text-white font-mono">{wallets.filter((w) => w.isActive && w.tokenBalance > 0).length}</span>
                  </div>
                </div>

                <Button
                  onClick={handleSell}
                  disabled={
                    loading ||
                    !mintAddress ||
                    wallets.filter((w) => w.isActive && w.tokenBalance > 0).length === 0 ||
                    !isMainnet
                  }
                  className="w-full bg-red-600 hover:bg-red-700"
                >
                  <TrendingDown className="w-4 h-4 mr-2" />
                  {loading ? "SELLING..." : `SELL ${sellPercentage}%`}
                </Button>
              </CardContent>
            </Card>

            {/* rugpull card */}
            <Card className="bg-red-950/20 border-red-500/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-red-400 flex items-center gap-2">
                  <Flame className="w-4 h-4" />
                  RUGPULL (sell all)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-neutral-400 mb-4">
                  sells 100% of tokens from all active wallets via jito bundle
                </p>
                <Button
                  onClick={handleRugpull}
                  disabled={
                    loading ||
                    !mintAddress ||
                    wallets.filter((w) => w.isActive).length === 0 ||
                    !isMainnet
                  }
                  className="w-full bg-red-600 hover:bg-red-700"
                >
                  <Flame className="w-4 h-4 mr-2" />
                  {loading ? "RUGPULLING..." : "🔥 EXECUTE RUGPULL (sell all)"}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* stagger settings */}
          {mode === "stagger" && (
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-neutral-300 flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  Stagger Settings
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-neutral-400 text-xs">Min Delay (ms)</Label>
                    <Input
                      type="number"
                      value={staggerDelayMin}
                      onChange={(e) => setStaggerDelayMin(e.target.value)}
                      className="bg-neutral-800 border-neutral-700 text-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-neutral-400 text-xs">Max Delay (ms)</Label>
                    <Input
                      type="number"
                      value={staggerDelayMax}
                      onChange={(e) => setStaggerDelayMax(e.target.value)}
                      className="bg-neutral-800 border-neutral-700 text-white"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* SETTINGS TAB */}
        <TabsContent value="settings" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* jito settings */}
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-neutral-300 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-yellow-400" />
                  Jito Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Region</Label>
                  <Select value={jitoRegion} onValueChange={setJitoRegion}>
                    <SelectTrigger className="bg-neutral-800 border-neutral-700 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto (try all regions)</SelectItem>
                      <SelectItem value="frankfurt">Frankfurt (EU)</SelectItem>
                      <SelectItem value="amsterdam">Amsterdam (EU)</SelectItem>
                      <SelectItem value="ny">New York (US)</SelectItem>
                      <SelectItem value="slc">Salt Lake City (US)</SelectItem>
                      <SelectItem value="tokyo">Tokyo (Asia)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label className="text-neutral-400 text-xs">Jito Tip (SOL)</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      value={jitoTip}
                      onChange={(e) => setJitoTip(e.target.value)}
                      className="bg-neutral-800 border-neutral-700 text-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-neutral-400 text-xs">Priority Fee (SOL)</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      value={priorityFee}
                      onChange={(e) => setPriorityFee(e.target.value)}
                      className="bg-neutral-800 border-neutral-700 text-white"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* trade settings */}
            <Card className="bg-neutral-900 border-neutral-700">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm text-neutral-300">Trade Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-neutral-400 text-xs">Slippage (%)</Label>
                  <Input
                    type="number"
                    value={slippage}
                    onChange={(e) => setSlippage(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white"
                  />
                </div>

                <div className="p-3 bg-yellow-900/20 border border-yellow-500/30 rounded">
                  <p className="text-xs text-yellow-400">
                    ⚠️ pump.fun allows max 5 wallets per bundle. larger groups will be split.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* bundle logs */}
          <Card className="bg-neutral-900 border-neutral-700">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-neutral-300">Bundle History</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {bundleLogs.length === 0 ? (
                  <div className="text-neutral-500 text-sm p-4 text-center">no bundles yet</div>
                ) : (
                  bundleLogs.map((log) => (
                    <div
                      key={log.id}
                      className={`p-3 rounded border ${
                        log.success ? "bg-neutral-800 border-green-500/30" : "bg-red-900/20 border-red-500/30"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Badge
                            className={
                              log.type === "launch"
                                ? "bg-purple-500/20 text-purple-400"
                                : log.type === "buy"
                                  ? "bg-green-500/20 text-green-400"
                                  : "bg-red-500/20 text-red-400"
                            }
                          >
                            {log.type.toUpperCase()}
                          </Badge>
                          <Badge className={log.success ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}>
                            {log.success ? "SUCCESS" : "FAILED"}
                          </Badge>
                        </div>
                        <span className="text-neutral-500 text-xs">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      </div>
                      {log.bundleId && (
                        <div className="text-xs text-neutral-400">
                          Bundle: <span className="font-mono text-cyan-400">{log.bundleId.slice(0, 20)}...</span>
                        </div>
                      )}
                      {log.mintAddress && (
                        <div className="text-xs text-neutral-400">
                          Mint:{" "}
                          <a
                            href={`https://pump.fun/${log.mintAddress}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-purple-400 hover:underline"
                          >
                            {log.mintAddress.slice(0, 20)}...
                          </a>
                        </div>
                      )}
                      {log.error && <div className="text-xs text-red-400 mt-1">{log.error}</div>}
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

