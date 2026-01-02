"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Wallet, Zap, Package, Plus, Trash2, Key, User, RefreshCw, Briefcase } from "lucide-react"
import { toast } from "sonner"
import { useWallet } from "@solana/wallet-adapter-react"
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, Keypair } from "@solana/web3.js"
import bs58 from "bs58"
import { getResilientConnection } from "@/lib/solana/config"

interface Token {
  symbol?: string
  name?: string
  price?: string
  change?: string
  status?: string
  mintAddress?: string
  isMigrated?: boolean
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

interface FunderWalletRecord {
  id: string
  publicKey: string
  label?: string | null
}

const LAST_TOKEN_STORAGE_KEY = "dashboardLastTokenMint"
const WALLET_SELECTION_STORAGE_KEY = "dashboardSelectedWallets"

/**
 * Dashboard UI for managing bundler wallets, funding, gas distribution, ATA creation, and token selection.
 *
 * Provides controls and displays for:
 * - loading and selecting tokens,
 * - generating, clearing and listing bundler wallets,
 * - configuring and saving a funder wallet (including top-ups),
 * - distributing SOL gas to active wallets from the configured funder wallet (topped up via connected wallet),
 * - creating associated token accounts (ATAs) for active wallets,
 * - persisting and displaying system logs and manual trade settings.
 *
 * @returns The rendered WalletToolsPage React component tree.
 */
export default function WalletToolsPage() {
  const { publicKey, sendTransaction, connected } = useWallet()
  const [tokens, setTokens] = useState<Token[]>([])
  const [selectedToken, setSelectedToken] = useState<Token | null>(null)
  const [bundlerWallets, setBundlerWallets] = useState<BundlerWallet[]>([])
  const [walletCount, setWalletCount] = useState("5")
  const [manualBuyAmount, setManualBuyAmount] = useState("0.01")
  const [manualSellPercent, setManualSellPercent] = useState("100")
  const [manualTradeDirty, setManualTradeDirty] = useState(false)
  const [funderKey, setFunderKey] = useState("")
  const [gasAmount, setGasAmount] = useState("0.003")
  const [gasLoading, setGasLoading] = useState(false)
  const [ataLoading, setAtaLoading] = useState(false)
  const [clearingWallets, setClearingWallets] = useState(false)
  const [funderWalletRecord, setFunderWalletRecord] = useState<FunderWalletRecord | null>(null)
  const [funderWalletInput, setFunderWalletInput] = useState("")
  const [funderTopupAmount, setFunderTopupAmount] = useState("0.1")
  const [funderSaving, setFunderSaving] = useState(false)
  const [funderToppingUp, setFunderToppingUp] = useState(false)
  const [systemLogs, setSystemLogs] = useState<string[]>([])
  const [logMintAddress, setLogMintAddress] = useState("")
  const [volumeBotConfig] = useState({ pairId: "", mintAddress: "" })

  const activeWallets = useMemo(() => bundlerWallets.filter(w => w.isActive), [bundlerWallets])
  const selectedTokenValue = selectedToken?.mintAddress || ""

  const normalizeTokenList = useCallback((data: any[]): Token[] => {
    if (!Array.isArray(data)) return []
    return data.map((token) => ({
      symbol: token?.symbol || token?.name || (token?.mintAddress ? token.mintAddress.slice(0, 4) : ""),
      name: token?.name || token?.symbol || "Unknown",
      price: token?.price != null ? String(token.price) : "",
      change: token?.change != null ? String(token.change) : "",
      status: token?.status || "",
      mintAddress: token?.mintAddress,
      isMigrated: token?.isMigrated,
    }))
  }, [])

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

  const addSystemLog = useCallback((message: string, type: "info" | "success" | "error" = "info") => {
    const timestamp = new Date().toLocaleTimeString()
    const logMessage = `[${timestamp}] ${type.toUpperCase()}: ${message}`
    setSystemLogs(prev => [logMessage, ...prev.slice(0, 49)])
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
  }, [
    logMintAddress,
    saveLogToLocalStorage,
    selectedToken?.mintAddress,
    volumeBotConfig.mintAddress,
    volumeBotConfig.pairId,
  ])

  const handleTokenSelect = useCallback((mintAddress: string) => {
    const token = tokens.find(t => t.mintAddress === mintAddress)
    if (token) {
      setSelectedToken(token)
      if (typeof window !== "undefined" && token.mintAddress) {
        window.localStorage.setItem(LAST_TOKEN_STORAGE_KEY, token.mintAddress)
      }
    }
  }, [tokens])

  const loadSavedWallets = useCallback(async (opts?: { silent?: boolean }) => {
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
        // Optimistic update
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
      }
    } catch (error: any) {
      console.error("failed to load saved wallets:", error)
      if (!opts?.silent) {
        toast.error(`failed to load wallets: ${error.message || "unknown error"}`)
      }
    }
  }, [])

  const loadTokens = useCallback(async () => {
    try {
      const res = await fetch("/api/tokens")
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`)
      }
      const raw = await res.json()
      const data = normalizeTokenList(raw)
      if (!Array.isArray(data)) return
      setTokens(data)
      setSelectedToken(prev => {
        if (prev) return prev
        let preferredMint: string | null = null
        if (typeof window !== "undefined") {
          preferredMint = window.localStorage.getItem(LAST_TOKEN_STORAGE_KEY)
        }
        const preferredToken = preferredMint
          ? data.find((t: any) => t.mintAddress === preferredMint)
          : null
        return preferredToken || data[0] || null
      })
    } catch (error) {
      console.error("failed to load tokens:", error)
    }
  }, [normalizeTokenList])

  const loadFunderWallet = useCallback(async () => {
    try {
      const res = await fetch("/api/funder")
      const data = await res.json()
      if (data?.funderWallet) {
        setFunderWalletRecord(data.funderWallet)
        setFunderWalletInput(data.funderWallet.publicKey)
      } else {
        setFunderWalletRecord(null)
      }
    } catch (error: any) {
      console.error("failed to load funder wallet:", error)
    }
  }, [])

  const saveFunderWallet = useCallback(async () => {
    const trimmed = funderWalletInput.trim()
    if (!trimmed) {
      toast.error("enter funder wallet address")
      return
    }
    try {
      new PublicKey(trimmed)
    } catch {
      toast.error("invalid funder wallet address")
      return
    }
    setFunderSaving(true)
    try {
      const res = await fetch("/api/funder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: trimmed }),
      })
      const data = await res.json()
      if (!res.ok || data?.error) {
        toast.error(data?.error || "failed to save funder wallet")
        return
      }
      setFunderWalletRecord(data.funderWallet)
      toast.success("funder wallet saved")
    } catch (error: any) {
      toast.error(error?.message || "failed to save funder wallet")
    } finally {
      setFunderSaving(false)
    }
  }, [funderWalletInput])

  const deleteFunderWallet = useCallback(async () => {
    if (!funderWalletRecord) return
    setFunderSaving(true)
    try {
      const res = await fetch("/api/funder", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: funderWalletRecord.id }),
      })
      const data = await res.json()
      if (!res.ok || data?.error) {
        toast.error(data?.error || "failed to delete funder wallet")
        return
      }
      setFunderWalletRecord(null)
      setFunderWalletInput("")
      toast.success("funder wallet deleted")
    } catch (error: any) {
      toast.error(error?.message || "failed to delete funder wallet")
    } finally {
      setFunderSaving(false)
    }
  }, [funderWalletRecord])

  const topupFunderWallet = useCallback(async () => {
    if (!publicKey) {
      toast.error("connect wallet first")
      return
    }
    if (!funderWalletRecord?.publicKey) {
      toast.error("set funder wallet first")
      return
    }
    const parsed = Number.parseFloat(funderTopupAmount)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error("enter valid topup amount")
      return
    }
    const lamports = Math.floor(parsed * LAMPORTS_PER_SOL)
    if (lamports <= 0) {
      toast.error("enter valid topup amount")
      return
    }
    setFunderToppingUp(true)
    try {
      const connection = await getResilientConnection()
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new PublicKey(funderWalletRecord.publicKey),
        lamports,
      }))
      const signature = await sendTransaction(tx, connection)
      await connection.confirmTransaction(signature, "confirmed")
      await fetch("/api/funder/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          funderWalletId: funderWalletRecord.id,
          fromPublicKey: publicKey.toBase58(),
          amountLamports: String(lamports),
          signature,
          status: "confirmed",
        }),
      })
      toast.success("funder wallet topped up")
    } catch (error: any) {
      toast.error(error?.message || "failed to top up")
    } finally {
      setFunderToppingUp(false)
    }
  }, [publicKey, funderWalletRecord, funderTopupAmount, sendTransaction])

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

  const clearWallets = useCallback(async () => {
    if (bundlerWallets.length === 0) {
      toast.error("no wallets to clear")
      return
    }
    setClearingWallets(true)
    try {
      const publicKeys = bundlerWallets.map(w => w.publicKey)
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-batch", publicKeys }),
      })
      const data = await res.json()

      if (!res.ok || data?.error) {
        throw new Error(data?.error || "failed to batch delete wallets")
      }

      setBundlerWallets([])
      await loadSavedWallets({ silent: true })
      toast.success(`cleared ${data.count || publicKeys.length} wallets`)
    } catch (error: any) {
      console.error("clear wallets error:", error)
      toast.error(error?.message || "failed to clear wallets")
      await loadSavedWallets()
    } finally {
      setClearingWallets(false)
    }
  }, [bundlerWallets, loadSavedWallets])

  const saveManualTradeSettings = useCallback(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem("dashboardManualBuyAmount", manualBuyAmount)
    window.localStorage.setItem("dashboardManualSellPercent", manualSellPercent)
    setManualTradeDirty(false)
    addSystemLog("Manual trade settings saved", "success")
    toast.success("Manual trade settings saved")
  }, [manualBuyAmount, manualSellPercent, addSystemLog])

  const distributeGas = useCallback(async () => {
    const active = bundlerWallets.filter(w => w.isActive)
    if (active.length === 0) {
      addSystemLog("No active wallets found", "error")
      toast.error("no active wallets")
      return
    }

    setGasLoading(true)
    addSystemLog(`Starting gas distribution to ${active.length} wallets`, "info")

    try {
      const amountPerWallet = parseFloat(gasAmount) || 0.003
      const totalSolNeeded = (amountPerWallet * active.length) + 0.01
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

      const balanceRes = await fetch(`/api/solana/balance?publicKey=${funderPubkey.toBase58()}`)
      const balanceData = await balanceRes.json()
      const balanceInSol = Number(balanceData?.sol ?? 0)
      if (balanceInSol < totalSolNeeded) {
        const error = `Insufficient balance. Need ${totalSolNeeded.toFixed(4)} SOL, have ${balanceInSol.toFixed(4)} SOL`
        addSystemLog(error, "error")
        toast.error(error)
        return
      }

      addSystemLog(`Balance check passed: ${balanceInSol.toFixed(4)} SOL available`, "success")

      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fund",
          funderSecretKey: trimmed,
          wallets: active,
          amounts: active.map(() => amountPerWallet),
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

      addSystemLog(`Successfully funded ${active.length} wallets`, "success")
      toast.success(`funded ${active.length} wallets`)
      setTimeout(() => loadSavedWallets(), 2000)
    } catch (error: any) {
      const userMessage = "Invalid funder key"
      addSystemLog(userMessage, "error")
      console.error("distribute gas error:", error)
      toast.error(userMessage)
    } finally {
      setGasLoading(false)
    }
  }, [addSystemLog, bundlerWallets, funderKey, gasAmount, loadSavedWallets])

  const createATAs = useCallback(async () => {
    if (!selectedToken || activeWallets.length === 0) return

    setAtaLoading(true)
    addSystemLog(`Starting ATA creation for ${activeWallets.length} wallets`, "info")

    const BATCH_SIZE = 5
    const batches = []
    for (let i = 0; i < activeWallets.length; i += BATCH_SIZE) {
      batches.push(activeWallets.slice(i, i + BATCH_SIZE))
    }

    try {
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]
        addSystemLog(`Creating ATAs for batch ${i + 1}/${batches.length} (${batch.length} wallets)`, "info")
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
          addSystemLog(`Batch ${i + 1}/${batches.length} completed successfully`, "success")
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
          addSystemLog(`Batch ${i + 1}/${batches.length} failed: ${errMsg}`, "error")
          toast.error(`Batch ${i + 1}/${batches.length} failed: ${errMsg}`)
          return
        }

        if (i < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }

      addSystemLog(`Successfully created ATAs for all ${activeWallets.length} wallets`, "success")
      toast.success(`Created ATAs for all ${activeWallets.length} wallets`)
      setTimeout(() => loadSavedWallets(), 3000)
    } catch (error: any) {
      addSystemLog(`ATA creation error: ${error.message}`, "error")
      console.error("Create ATAs error:", error)
      toast.error(`Failed to create ATAs: ${error.message}`)
    } finally {
      setAtaLoading(false)
    }
  }, [activeWallets, addSystemLog, loadSavedWallets, selectedToken])

  useEffect(() => {
    loadTokens()
  }, [loadTokens])

  useEffect(() => {
    loadSavedWallets()
  }, [loadSavedWallets])

  useEffect(() => {
    const interval = setInterval(() => {
      loadTokens()
      loadSavedWallets({ silent: true })
    }, 60000)
    return () => clearInterval(interval)
  }, [loadTokens, loadSavedWallets])

  useEffect(() => {
    loadFunderWallet()
  }, [loadFunderWallet])

  useEffect(() => {
    if (typeof window === "undefined") return
    const savedBuy = window.localStorage.getItem("dashboardManualBuyAmount")
    const savedSell = window.localStorage.getItem("dashboardManualSellPercent")
    if (savedBuy) setManualBuyAmount(savedBuy)
    if (savedSell) setManualSellPercent(savedSell)
  }, [])

  return (
    <div className="p-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs text-slate-600">Token</Label>
        <Select value={selectedTokenValue || ""} onValueChange={handleTokenSelect}>
          <SelectTrigger className="h-8 w-48 bg-background border-border text-xs">
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

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-1">
        <Card className="bg-neutral-900 border-neutral-700">
          <CardHeader className="py-1 px-2">
            <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
              FUNDING WALLET
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-2 space-y-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-slate-400">Funder Address</Label>
              <Input
                placeholder="wallet address..."
                value={funderWalletInput}
                onChange={(e) => setFunderWalletInput(e.target.value)}
                className="h-7 bg-background border-border text-xs"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={saveFunderWallet}
                  disabled={funderSaving}
                  className="h-7 px-2 text-[10px] bg-blue-600 hover:bg-blue-700"
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                     try {
                        const keypair = Keypair.generate()
                        const pubkey = keypair.publicKey.toBase58()
                        setFunderWalletInput(pubkey)
                        // Auto-save logic
                        setFunderSaving(true)
                        const res = await fetch("/api/funder", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ publicKey: pubkey }),
                        })
                        const data = await res.json()
                        if (!res.ok || data?.error) {
                          toast.error(data?.error || "failed to save funder wallet")
                          setFunderSaving(false)
                          return
                        }
                        setFunderWalletRecord(data.funderWallet)
                        setFunderSaving(false)
                        toast.success("Generated & saved new funder wallet")
                        // Also show secret key once
                        toast(
                            <div className="text-[10px] font-mono break-all">
                                Private Key: {bs58.encode(keypair.secretKey)}
                            </div>,
                            { duration: 10000 }
                        )
                     } catch (e: any) {
                         toast.error("Failed to generate: " + e.message)
                     }
                  }}
                  className="h-7 px-2 text-[10px] border-neutral-700"
                >
                  Generate
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={deleteFunderWallet}
                  disabled={funderSaving || !funderWalletRecord}
                  className="h-7 px-2 text-[10px] border-neutral-700"
                >
                  Delete
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[10px] text-slate-400">Top up from connected</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  step="0.0001"
                  value={funderTopupAmount}
                  onChange={(e) => setFunderTopupAmount(e.target.value)}
                  className="h-7 bg-background border-border text-xs"
                />
                <Button
                  size="sm"
                  onClick={topupFunderWallet}
                  disabled={funderToppingUp || !funderWalletRecord || !publicKey}
                  className="h-7 px-2 text-[10px] bg-green-600 hover:bg-green-700"
                >
                  Top up
                </Button>
              </div>
              <div className="text-[10px] text-slate-500">
                {funderWalletRecord
                  ? `${funderWalletRecord.publicKey.slice(0, 8)}...${funderWalletRecord.publicKey.slice(-4)}`
                  : "not set"}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-neutral-900 border-neutral-700">
          <CardHeader className="py-1 px-2">
            <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
              GAS FUNDER
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-2 space-y-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-slate-600">Funder Wallet</Label>
              <Input
                type="password"
                placeholder="funder wallet private key"
                value={funderKey}
                onChange={(e) => setFunderKey(e.target.value)}
                className="h-7 bg-background border-border text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-slate-600">Amount (SOL)</Label>
              <Input
                type="number"
                step="0.0001"
                placeholder="0.003"
                value={gasAmount}
                onChange={(e) => setGasAmount(e.target.value)}
                className="h-7 bg-background border-border text-xs"
              />
            </div>
            <div className="text-[9px] text-slate-500">Gas funder uses the provided private key.</div>
          </CardContent>
        </Card>
      </div>

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
              <Button
                size="sm"
                variant="outline"
                onClick={clearWallets}
                disabled={clearingWallets}
                className="h-6 px-2 border-neutral-700 disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      onClick={distributeGas}
                      disabled={activeWallets.length === 0 || gasLoading || !funderKey}
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
                    {`Distribute ${gasAmount} SOL to ${activeWallets.length} wallets from the funder wallet`}
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
          <div className="text-[10px] text-slate-400">Active: {activeWallets.length}</div>
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
          <div className="flex items-center justify-between mb-2 pb-1 border-b border-slate-800">
             <div className="text-[10px] text-slate-400">Total Wallets: {bundlerWallets.length}</div>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {bundlerWallets.length === 0 ? (
              <div className="text-slate-400 text-xs p-2 text-center">No wallets loaded</div>
            ) : (
                  bundlerWallets.map((wallet, index) => (
                <div
                  key={wallet.publicKey}
                  className={`p-2 rounded border text-[11px] flex items-center justify-between ${
                    wallet.isActive ? "border-cyan-500/30 bg-cyan-500/5" : "border-neutral-700 bg-neutral-800"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                        <div className="text-[10px] text-neutral-700 w-5 text-center font-bold">#{index + 1}</div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                          <div className="text-neutral-900 font-mono truncate font-bold">
                            {wallet.publicKey.slice(0, 8)}...{wallet.publicKey.slice(-4)}
                          </div>
                              {/* Role Badges */}
                          {wallet.role === 'dev' && (
                                  <Badge variant="outline" className="h-4 px-1 text-[9px] border-purple-500 text-purple-400 bg-purple-500/10">DEV</Badge>
                          )}
                          {wallet.role === 'buyer' && (
                                  <Badge variant="outline" className="h-4 px-1 text-[9px] border-cyan-500 text-cyan-400 bg-cyan-500/10">BUYER</Badge>
                          )}
                          {wallet.role === 'funder' && (
                                  <Badge variant="outline" className="h-4 px-1 text-[9px] border-green-500 text-green-400 bg-green-500/10">FUNDER</Badge>
                          )}
                          {wallet.role === 'volume_bot' && (
                                  <Badge variant="outline" className="h-4 px-1 text-[9px] border-orange-500 text-orange-400 bg-orange-500/10">BOT</Badge>
                          )}
                      </div>
                      <div className="flex gap-2 text-[10px] text-neutral-600 font-medium">
                        <span className="text-emerald-700">SOL: {wallet.solBalance.toFixed(3)}</span>
                        <span className="text-cyan-700">Tokens: {wallet.tokenBalance.toFixed(2)}</span>
                        <span className={wallet.ataExists ? "text-green-700" : "text-red-600"}>
                          ATA: {wallet.ataExists ? "yes" : "no"}
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
    </div>
  )
}