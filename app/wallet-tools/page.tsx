"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Wallet, Zap, Package, Plus, Trash2 } from "lucide-react"
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
  ataExists?: boolean
}

interface FunderWalletRecord {
  id: string
  publicKey: string
  label?: string | null
}

const LAST_TOKEN_STORAGE_KEY = "dashboardLastTokenMint"
const WALLET_SELECTION_STORAGE_KEY = "dashboardSelectedWallets"

export default function WalletToolsPage() {
  const { publicKey, sendTransaction, connected } = useWallet()
  const [tokens, setTokens] = useState<Token[]>([])
  const [selectedToken, setSelectedToken] = useState<Token | null>(null)
  const [bundlerWallets, setBundlerWallets] = useState<BundlerWallet[]>([])
  const [selectedWallets, setSelectedWallets] = useState<Set<string>>(new Set())
  const [walletCount, setWalletCount] = useState("5")
  const [manualBuyAmount, setManualBuyAmount] = useState("0.01")
  const [manualSellPercent, setManualSellPercent] = useState("100")
  const [manualTradeDirty, setManualTradeDirty] = useState(false)
  const [funderKey, setFunderKey] = useState("")
  const [useConnectedFunder, setUseConnectedFunder] = useState(true)
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
  const selectedActiveWallets = useMemo(
    () => activeWallets.filter(w => selectedWallets.has(w.publicKey)),
    [activeWallets, selectedWallets]
  )
  const selectedWalletCount = selectedActiveWallets.length
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
        setBundlerWallets(data.wallets)
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
      const results = await Promise.all(
        bundlerWallets.map(async (wallet) => {
          const res = await fetch("/api/bundler/wallets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "delete", publicKey: wallet.publicKey }),
          })
          const data = await res.json().catch(() => ({}))
          return res.ok && !data?.error
        })
      )
      const failed = results.filter((ok) => !ok).length
      if (failed > 0) {
        toast.error(`failed to delete ${failed} wallets`)
        await loadSavedWallets()
        return
      }
      setBundlerWallets([])
      setSelectedWallets(new Set())
      toast.success("cleared all wallets")
    } catch (error: any) {
      toast.error(error?.message || "failed to clear wallets")
      await loadSavedWallets()
    } finally {
      setClearingWallets(false)
    }
  }, [bundlerWallets, loadSavedWallets])

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

  const selectAllWallets = useCallback(() => {
    setSelectedWallets(new Set(activeWallets.map(w => w.publicKey)))
  }, [activeWallets])

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

  const distributeGas = useCallback(async () => {
    const active = bundlerWallets.filter(w => w.isActive)
    if (active.length === 0) {
      addSystemLog("No active wallets found", "error")
      toast.error("no active wallets")
      return
    }

    if (useConnectedFunder && (!connected || !publicKey)) {
      addSystemLog("Wallet not connected", "error")
      toast.error("connect wallet first")
      return
    }

    setGasLoading(true)
    addSystemLog(`Starting gas distribution to ${active.length} wallets`, "info")

    try {
      const amountPerWallet = 0.003
      const totalSolNeeded = (amountPerWallet * active.length) + 0.01
      const connection = await getResilientConnection()
      if (useConnectedFunder) {
        const balanceRes = await fetch(`/api/solana/balance?publicKey=${publicKey!.toBase58()}`)
        const balanceData = await balanceRes.json()
        const balanceInSol = Number(balanceData?.sol ?? 0)

        if (balanceInSol < totalSolNeeded) {
          const error = `Insufficient balance. Need ${totalSolNeeded.toFixed(4)} SOL, have ${balanceInSol.toFixed(4)} SOL`
          addSystemLog(error, "error")
          toast.error(error)
          return
        }

        addSystemLog(`Balance check passed: ${balanceInSol.toFixed(4)} SOL available`, "success")

        const BATCH_SIZE = 8
        for (let i = 0; i < active.length; i += BATCH_SIZE) {
          const batch = active.slice(i, i + BATCH_SIZE)
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
          addSystemLog(`Batch ${Math.floor(i / BATCH_SIZE) + 1} confirmed: ${sig.slice(0, 8)}...`, "success")
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
      }

      addSystemLog(`Successfully funded ${active.length} wallets`, "success")
      toast.success(`funded ${active.length} wallets`)
      setTimeout(() => loadSavedWallets(), 2000)
    } catch (error: any) {
      addSystemLog(`Gas distribution error: ${error.message}`, "error")
      console.error("distribute gas error:", error)
      toast.error(`failed to fund wallets: ${error.message}`)
    } finally {
      setGasLoading(false)
    }
  }, [
    addSystemLog,
    bundlerWallets,
    connected,
    funderKey,
    loadSavedWallets,
    publicKey,
    sendTransaction,
    useConnectedFunder,
  ])

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
    const stored = window.localStorage.getItem(WALLET_SELECTION_STORAGE_KEY)
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        setSelectedWallets(new Set(parsed))
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const savedBuy = window.localStorage.getItem("dashboardManualBuyAmount")
    const savedSell = window.localStorage.getItem("dashboardManualSellPercent")
    if (savedBuy) setManualBuyAmount(savedBuy)
    if (savedSell) setManualSellPercent(savedSell)
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(WALLET_SELECTION_STORAGE_KEY, JSON.stringify([...selectedWallets]))
  }, [selectedWallets])

  useEffect(() => {
    if (bundlerWallets.length === 0) return
    setSelectedWallets(prev => {
      if (prev.size === 0) return prev
      const existing = new Set(bundlerWallets.map(wallet => wallet.publicKey))
      const next = new Set([...prev].filter((key) => existing.has(key)))
      return next.size === prev.size ? prev : next
    })
  }, [bundlerWallets])

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
                value={funderKey}
                onChange={(e) => setFunderKey(e.target.value)}
                disabled={useConnectedFunder}
                className="h-7 bg-background border-border text-xs"
              />
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
                      disabled={(useConnectedFunder && !connected) || activeWallets.length === 0 || gasLoading}
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
                    {useConnectedFunder
                      ? connected
                        ? `Distribute 0.003 SOL to ${activeWallets.length} wallets from connected wallet`
                        : "Connect wallet to distribute gas"
                      : `Distribute 0.003 SOL to ${activeWallets.length} wallets from manual funder`
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
          <div className="space-y-1 max-h-64 overflow-y-auto">
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
