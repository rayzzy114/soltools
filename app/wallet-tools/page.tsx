"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Checkbox } from "@/components/ui/checkbox"
import { Wallet, Zap, Package, Plus, Trash2, RefreshCw, ArrowDownToLine, Download, Copy, Key } from "lucide-react"
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
const FUNDER_SECRET_KEY = "funderSecretKey"
const GAS_AMOUNT_KEY = "walletToolsGasAmount"

/**
 * Render the WalletToolsPage dashboard for managing bundler wallets, funding, gas distribution, ATA creation, token selection, and system logs.
 *
 * Provides UI controls and state for token selection, generating/clearing/listing bundler wallets, configuring and topping up a funder wallet, distributing SOL gas to active wallets, creating associated token accounts (ATAs) in batches, and persisting/displaying system logs.
 *
 * @returns The WalletToolsPage React component tree
 */
export default function WalletToolsPage() {
  const { publicKey, sendTransaction } = useWallet()
  const [tokens, setTokens] = useState<Token[]>([])
  const [selectedToken, setSelectedToken] = useState<Token | null>(null)
  const [bundlerWallets, setBundlerWallets] = useState<BundlerWallet[]>([])
  const [walletCount, setWalletCount] = useState("5")
  const [funderKey, setFunderKey] = useState("")
  const [gasAmount, setGasAmount] = useState("0.003")
  const [gasLoading, setGasLoading] = useState(false)
  const [ataLoading, setAtaLoading] = useState(false)
  const [collectingSol, setCollectingSol] = useState(false)
  const [clearingWallets, setClearingWallets] = useState(false)
  const [funderWalletRecord, setFunderWalletRecord] = useState<FunderWalletRecord | null>(null)
  const [funderBalance, setFunderBalance] = useState<number | null>(null)
  const [funderWalletInput, setFunderWalletInput] = useState("")
  const [funderTopupAmount, setFunderTopupAmount] = useState("0.1")
  const [funderSaving, setFunderSaving] = useState(false)
  const [funderToppingUp, setFunderToppingUp] = useState(false)
  const [systemLogs, setSystemLogs] = useState<string[]>([])
  const [logMintAddress, setLogMintAddress] = useState("")
  const [volumeBotConfig] = useState({ pairId: "", mintAddress: "" })
  const [refreshingWallets, setRefreshingWallets] = useState<Set<string>>(new Set())
  const [selectedWallets, setSelectedWallets] = useState<Set<string>>(new Set())

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
        let walletsToUse = data.wallets

        if (walletsToUse.length > 0) {
          try {
            const refreshRes = await fetch("/api/bundler/wallets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "refresh",
                wallets: walletsToUse,
              }),
            })
            const refreshData = await refreshRes.json()
            if (refreshRes.ok && refreshData.wallets && Array.isArray(refreshData.wallets)) {
              walletsToUse = refreshData.wallets
            }
          } catch (err) {
            console.error("wallet refresh failed", err)
          }
        }

        setBundlerWallets(walletsToUse)
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

  const refreshFunderBalance = useCallback(async (pubkeyStr?: string) => {
    const target = pubkeyStr || funderWalletRecord?.publicKey
    if (!target) return
    try {
        const res = await fetch(`/api/solana/balance?publicKey=${target}`)
        const data = await res.json()
        if (typeof data.sol === 'number') {
            setFunderBalance(data.sol)
        }
    } catch (e) {
        console.error("failed to refresh funder balance", e)
    }
  }, [funderWalletRecord])

  const loadFunderWallet = useCallback(async () => {
    try {
      const res = await fetch("/api/funder")
      const data = await res.json()
      if (data?.funderWallet) {
        setFunderWalletRecord(data.funderWallet)
        setFunderWalletInput(data.funderWallet.publicKey)
        refreshFunderBalance(data.funderWallet.publicKey)
      } else {
        setFunderWalletRecord(null)
        setFunderBalance(null)
      }
    } catch (error: any) {
      console.error("failed to load funder wallet:", error)
    }
  }, [refreshFunderBalance])

  const saveFunderWallet = useCallback(async (overridePublicKey?: string) => {
    const trimmed = overridePublicKey || funderWalletInput.trim()
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
      refreshFunderBalance(data.funderWallet.publicKey)
      toast.success("funder wallet saved")
    } catch (error: any) {
      toast.error(error?.message || "failed to save funder wallet")
    } finally {
      setFunderSaving(false)
    }
  }, [funderWalletInput, refreshFunderBalance])

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
      setFunderBalance(null)
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
      refreshFunderBalance()
      toast.success("funder wallet topped up")
    } catch (error: any) {
      toast.error(error?.message || "failed to top up")
    } finally {
      setFunderToppingUp(false)
    }
  }, [publicKey, funderWalletRecord, funderTopupAmount, sendTransaction, refreshFunderBalance])

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

  const handleSelectAll = useCallback((checked: boolean) => {
    if (checked) {
      setSelectedWallets(new Set(bundlerWallets.map(w => w.publicKey)))
    } else {
      setSelectedWallets(new Set())
    }
  }, [bundlerWallets])

  const toggleWalletSelection = useCallback((publicKey: string) => {
    setSelectedWallets(prev => {
      const next = new Set(prev)
      if (next.has(publicKey)) {
        next.delete(publicKey)
      } else {
        next.add(publicKey)
      }
      return next
    })
  }, [])

  const deleteSelectedWallets = useCallback(async () => {
    if (selectedWallets.size === 0) {
      toast.error("No wallets selected")
      return
    }
    setClearingWallets(true)
    try {
      const publicKeys = Array.from(selectedWallets)
      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-batch", publicKeys }),
      })
      const data = await res.json()

      if (!res.ok || data?.error) {
        throw new Error(data?.error || "failed to batch delete wallets")
      }

      setBundlerWallets(prev => prev.filter(w => !selectedWallets.has(w.publicKey)))
      setSelectedWallets(new Set()) // Clear selection
      await loadSavedWallets({ silent: true })
      toast.success(`Deleted ${data.count || publicKeys.length} wallets`)
    } catch (error: any) {
      console.error("delete wallets error:", error)
      toast.error(error?.message || "failed to delete wallets")
      await loadSavedWallets()
    } finally {
      setClearingWallets(false)
    }
  }, [selectedWallets, loadSavedWallets])

  const handleRefreshWallet = useCallback(async (wallet: BundlerWallet) => {
    setRefreshingWallets(prev => {
        const next = new Set(prev)
        next.add(wallet.publicKey)
        return next
    })
    try {
        const res = await fetch("/api/bundler/wallets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                action: "refresh",
                wallets: [wallet],
            }),
        })
        const data = await res.json()
        if (data.wallets && data.wallets.length > 0) {
             const updated = data.wallets[0]
             setBundlerWallets(prev => prev.map(w => w.publicKey === updated.publicKey ? updated : w))
             toast.success("Wallet refreshed")
        }
    } catch (error) {
        toast.error("Failed to refresh wallet")
    } finally {
        setRefreshingWallets(prev => {
            const next = new Set(prev)
            next.delete(wallet.publicKey)
            return next
        })
    }
  }, [])

  const handleCollectSol = useCallback(async () => {
    if (!publicKey) {
      toast.error("connect wallet first")
      return
    }
    const active = bundlerWallets.filter(w => w.isActive)
    if (active.length === 0) {
      toast.error("no active wallets")
      return
    }

    setCollectingSol(true)
    try {
      // 1. Refresh balances first to get accurate amount
      toast.info("checking wallet balances...")
      const refreshRes = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh", wallets: active }),
      })
      const refreshData = await refreshRes.json()
      const currentWallets: BundlerWallet[] = refreshData.wallets || active

      // 2. Calculate total withdrawals
      // collectSol leaves ~5000 lamports (0.000005 SOL)
      const FEE_BUFFER = 0.000005
      let totalToCollect = 0
      const walletsWithFunds = currentWallets.filter(w => {
        const available = w.solBalance - FEE_BUFFER
        if (available > 0) {
          totalToCollect += available
          return true
        }
        return false
      })

      if (walletsWithFunds.length === 0) {
        toast.info("no wallets have enough SOL to collect")
        setCollectingSol(false)
        return
      }

      // 3. Confirm
      const confirmed = window.confirm(
        `Are you sure you want to withdraw ~${totalToCollect.toFixed(4)} SOL from ${walletsWithFunds.length} wallets to your connected wallet (${publicKey.toBase58().slice(0, 4)}...)?`
      )

      if (!confirmed) {
        setCollectingSol(false)
        return
      }

      toast.info(`Collecting SOL from ${walletsWithFunds.length} wallets...`)

      const res = await fetch("/api/bundler/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "collect",
          wallets: walletsWithFunds,
          recipientAddress: publicKey.toBase58(),
        }),
      })

      const data = await res.json()
      if (data.error) {
        throw new Error(data.error)
      }

      toast.success(`Successfully collected funds! txs: ${data.signatures?.length || 0}`)
      addSystemLog(`Collected SOL from ${walletsWithFunds.length} wallets`, "success")

      // Refresh UI
      if (data.wallets) {
        setBundlerWallets(prev => {
           // Merge updates
           const map = new Map(prev.map(w => [w.publicKey, w]))
           data.wallets.forEach((w: BundlerWallet) => map.set(w.publicKey, w))
           return Array.from(map.values())
        })
      } else {
        loadSavedWallets()
      }

    } catch (error: any) {
      console.error("collect sol error:", error)
      toast.error(error.message || "failed to collect sol")
      addSystemLog(`Collect SOL failed: ${error.message}`, "error")
    } finally {
      setCollectingSol(false)
    }
  }, [bundlerWallets, publicKey, addSystemLog, loadSavedWallets])

  // Handle Gas Amount Change with Persistence
  const handleGasAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setGasAmount(value)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(GAS_AMOUNT_KEY, value)
    }
  }

  const distributeGas = useCallback(async () => {
    // 1. Ensure unique wallets
    const active = Array.from(
      new Map(bundlerWallets.filter(w => w.isActive).map(w => [w.publicKey, w])).values()
    )

    if (active.length === 0) {
      addSystemLog("No active wallets found", "error")
      toast.error("no active wallets")
      return
    }

    setGasLoading(true)
    addSystemLog(`Starting gas distribution to ${active.length} wallets`, "info")

    try {
      // 2. Robust parsing (replace comma with dot)
      const normalizedGas = gasAmount.replace(/,/g, ".")
      const parsedAmount = parseFloat(normalizedGas)
      const amountPerWallet = (!isNaN(parsedAmount) && parsedAmount > 0) ? parsedAmount : 0.003

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

      // Handle multiple signatures if backend sends them
      const signatures = data.signatures || (data.signature ? [data.signature] : [])
      if (signatures.length > 0) {
         addSystemLog(`Funder tx(s) confirmed: ${signatures.length} transactions`, "success")
      } else {
         addSystemLog(`Funding completed`, "success")
      }

      addSystemLog(`Successfully funded ${active.length} wallets with ${amountPerWallet} SOL each`, "success")
      toast.success(`funded ${active.length} wallets`)
      refreshFunderBalance()
      setTimeout(() => loadSavedWallets(), 2000)
    } catch (error: any) {
      const userMessage = "Funding failed: " + (error?.message || "Unknown error")
      addSystemLog(userMessage, "error")
      console.error("distribute gas error:", error)
      toast.error(userMessage)
    } finally {
      setGasLoading(false)
    }
  }, [addSystemLog, bundlerWallets, funderKey, gasAmount, loadSavedWallets, refreshFunderBalance])

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

  const handleExportKeys = useCallback(() => {
    if (bundlerWallets.length === 0) {
      toast.error("No wallets to export")
      return
    }

    const headers = ["Index", "PublicKey", "SecretKey", "Role", "SolBalance", "TokenBalance"]
    const rows = bundlerWallets.map((w, idx) => [
      String(idx + 1),
      w.publicKey,
      w.secretKey || "HIDDEN",
      w.role || "project",
      w.solBalance.toFixed(6),
      w.tokenBalance.toFixed(2)
    ])

    const csvContent = [
      headers.join(","),
      ...rows.map(row => row.join(","))
    ].join("\n")

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.setAttribute("download", `wallets_export_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [bundlerWallets])

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
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(FUNDER_SECRET_KEY)
      if (stored) setFunderKey(stored)

      const savedGas = window.localStorage.getItem(GAS_AMOUNT_KEY)
      if (savedGas) setGasAmount(savedGas)
    }
  }, [loadFunderWallet])

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
                  onClick={() => {
                     // Check if input is a private key
                     let pubkey = funderWalletInput.trim()
                     let secretKey = ""
                     try {
                        const decoded = bs58.decode(pubkey)
                        if (decoded.length === 64) {
                            const pair = Keypair.fromSecretKey(decoded)
                            pubkey = pair.publicKey.toBase58()
                            secretKey = bs58.encode(pair.secretKey)
                            setFunderWalletInput(pubkey)
                            if (typeof window !== "undefined") {
                                window.localStorage.setItem(FUNDER_SECRET_KEY, secretKey)
                                setFunderKey(secretKey)
                            }
                        }
                     } catch {
                        // Not a private key, treat as pubkey
                     }
                     // Pass the derived pubkey explicitly to avoid race condition with state
                     saveFunderWallet(pubkey)
                  }}
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
                        const secretKey = bs58.encode(keypair.secretKey)
                        setFunderWalletInput(pubkey)
                        if (typeof window !== "undefined") {
                            window.localStorage.setItem(FUNDER_SECRET_KEY, secretKey)
                            setFunderKey(secretKey)
                        }
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
                  onClick={() => {
                      deleteFunderWallet()
                      if (typeof window !== "undefined") {
                          window.localStorage.removeItem(FUNDER_SECRET_KEY)
                          setFunderKey("")
                      }
                  }}
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
              <div className="flex justify-between items-center text-[10px] text-slate-500">
                <span>
                {funderWalletRecord
                  ? `${funderWalletRecord.publicKey.slice(0, 8)}...${funderWalletRecord.publicKey.slice(-4)}`
                  : "not set"}
                </span>
                {funderBalance !== null && (
                    <span className="text-green-400 font-medium">Balance: {funderBalance.toFixed(4)} SOL</span>
                )}
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
                readOnly
                className="h-7 bg-neutral-950/50 border-border text-xs text-slate-500 cursor-not-allowed"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-slate-600">Amount (SOL)</Label>
              <Input
                type="number"
                step="0.0001"
                placeholder="0.003"
                value={gasAmount}
                onChange={handleGasAmountChange}
                className="h-7 bg-background border-border text-xs"
              />
            </div>
            <div className="text-[9px] text-slate-500">Uses the Funding Wallet generated above.</div>
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
              <Button
                size="sm"
                onClick={generateWallets}
                className="h-6 px-2 bg-purple-500 hover:bg-purple-600 text-xs"
                aria-label="Generate wallets"
                title="Generate wallets"
              >
                <Plus className="w-3 h-3" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCollectSol}
                disabled={collectingSol || !publicKey || activeWallets.length === 0}
                className="h-6 px-2 border-neutral-700 disabled:opacity-50 hover:bg-green-900/20 hover:text-green-400"
                aria-label="Collect SOL to connected wallet"
                title="Collect SOL from wallets"
              >
                {collectingSol ? (
                  <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <ArrowDownToLine className="w-3 h-3" />
                )}
              </Button>
               <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleExportKeys}
                        disabled={bundlerWallets.length === 0}
                        className="h-6 px-2 border-neutral-700 disabled:opacity-50 hover:bg-blue-900/20 hover:text-blue-400"
                        aria-label="Export wallet keys"
                      >
                         <Download className="w-3 h-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Export Wallets (CSV)</TooltipContent>
                  </Tooltip>
               </TooltipProvider>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={deleteSelectedWallets}
                      disabled={clearingWallets}
                      className="h-6 px-2 border-neutral-700 disabled:opacity-50 hover:bg-red-900/20 hover:text-red-400"
                      aria-label="Delete selected wallets"
                      title="Delete selected wallets"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Delete selected wallets
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      onClick={distributeGas}
                      disabled={activeWallets.length === 0 || gasLoading || !funderKey}
                      className="h-6 px-2 bg-blue-600 hover:bg-blue-700 text-xs disabled:opacity-50"
                      aria-label="Distribute gas"
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
                      aria-label="Create token accounts"
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
          <div className="flex items-center gap-2 mb-2 pb-1 border-b border-slate-800">
             <Checkbox
                checked={bundlerWallets.length > 0 && selectedWallets.size === bundlerWallets.length}
                onCheckedChange={(checked) => handleSelectAll(!!checked)}
                className="border-neutral-600"
             />
             <div className="text-[10px] text-slate-400">Total Wallets: {bundlerWallets.length}</div>
             {selectedWallets.size > 0 && (
                <div className="text-[10px] text-slate-400 ml-auto">Selected: {selectedWallets.size}</div>
             )}
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
                    <Checkbox
                        checked={selectedWallets.has(wallet.publicKey)}
                        onCheckedChange={() => toggleWalletSelection(wallet.publicKey)}
                        className="border-neutral-600"
                    />
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
                  <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRefreshWallet(wallet)}
                        disabled={refreshingWallets.has(wallet.publicKey)}
                        className="h-6 w-6 text-slate-400 hover:text-white"
                        title="Refresh balance"
                    >
                        <RefreshCw className={`w-3 h-3 ${refreshingWallets.has(wallet.publicKey) ? "animate-spin" : ""}`} />
                    </Button>
                    <Badge className={wallet.isActive ? "bg-green-500/20 text-green-400" : "bg-neutral-600"}>
                        {wallet.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
