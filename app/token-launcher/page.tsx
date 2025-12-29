"use client"

import { useState, useEffect, useRef, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useWallet, useConnection } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { Keypair, Transaction } from "@solana/web3.js"
import bs58 from "bs58"
import { validateTokenParams, validateBuyAmount } from "@/lib/utils/token-validation"
import { clampPercent as clampPercentUtil, parseSafe } from "@/lib/ui-utils"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Rocket,
  Coins,
  TrendingUp,
  TrendingDown,
  Users,
  Droplets,
  Lock,
  Unlock,
  ExternalLink,
  Copy,
  Upload,
  AlertTriangle,
  Image as ImageIcon,
  Flame,
  Skull,
} from "lucide-react"
import { TriggerManager } from "@/components/triggers/TriggerManager"

const clampPercent = (value: number, min = 0, max = 99) => clampPercentUtil(value, min, max)

const normalizeCloneAddress = (
  raw: string,
): { primary: string | null; alt?: string | null } => {
  let value = raw.trim()
  if (!value) return { primary: null, alt: null }
  if (value.includes("/")) {
    value = value.split("/").filter(Boolean).pop() || value
  }
  if (value.includes("?")) {
    value = value.split("?")[0]
  }
  const alt = value.endsWith("pump") ? value.slice(0, -4) : null
  if (value.length < 32 || value.length > 44) return { primary: null, alt: null }
  return { primary: value, alt }
}

export default function TokenLauncherPage() {
  const { publicKey, signTransaction, connected } = useWallet()
  const { connection } = useConnection()
  const [selectedToken, setSelectedToken] = useState<any>(null)
  const [tokens, setTokens] = useState<any[]>([])
  const [trashTokens, setTrashTokens] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [buying, setBuying] = useState(false)
  const [selling, setSelling] = useState(false)
  const [rugpulling, setRugpulling] = useState(false)
  const [rugpullStatus, setRugpullStatus] = useState<any>(null)
  const [rugpullRoute, setRugpullRoute] = useState<"auto" | "bonding_curve" | "pumpswap">("auto")
  const [payoutWallet, setPayoutWallet] = useState<string>("")
  const [tokenPrices, setTokenPrices] = useState<Record<string, { price: number; marketCap: number; isMigrated: boolean }>>({})
  const [network, setNetwork] = useState<string>("unknown")
  
  // form state
  const [tokenName, setTokenName] = useState("")
  const [tokenSymbol, setTokenSymbol] = useState("")
  const [description, setDescription] = useState("")
  const [website, setWebsite] = useState("")
  const [twitter, setTwitter] = useState("")
  const [telegram, setTelegram] = useState("")
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string>("")
  const [metadataUri, setMetadataUri] = useState<string>("")
  const [metadataImageUrl, setMetadataImageUrl] = useState<string>("")
  const [lastCreatedMint, setLastCreatedMint] = useState<string>("")
  const [customKeypair, setCustomKeypair] = useState<string>("")
  const [cloneAddress, setCloneAddress] = useState("")
  const [cloning, setCloning] = useState(false)
  const [importMint, setImportMint] = useState("")
  const [lastImportedMint, setLastImportedMint] = useState("")
  
  // buy/sell state
  const [buyAmount, setBuyAmount] = useState("")
  const [sellAmount, setSellAmount] = useState("")
  const [sellPercentage, setSellPercentage] = useState("")

  const fileInputRef = useRef<HTMLInputElement>(null)
  const keypairInputRef = useRef<HTMLInputElement>(null)

  const handleDeleteToken = async (mint: string) => {
    try {
      const res = await fetch(`/api/tokens?mintAddress=${mint}`, { method: "DELETE" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) {
        toast.error(data.error || "failed to delete token")
        return
      }
      setTokens((prev) => prev.filter((t) => t.mintAddress !== mint))
      if (selectedToken?.mintAddress === mint) {
        setSelectedToken(null)
      }
      toast.success("token removed from panel")
    } catch (error: any) {
      toast.error(error?.message || "delete failed")
    }
  }

  const handleClone = async () => {
    const { primary } = normalizeCloneAddress(cloneAddress)
    if (!primary) {
      toast.error("enter valid token address")
      return
    }
    setCloning(true)
    try {
      const token = tokens.find((entry) => entry.mintAddress === primary)
      if (!token) {
        toast.error("token not found in database")
        return
      }
      setTokenName(token.name || "")
      setTokenSymbol(token.symbol || "")
      setDescription(token.description || "")
      setWebsite(token.website || "")
      setTwitter(token.twitter || "")
      setTelegram(token.telegram || "")
      if (token.imageUrl) {
        setImagePreview(token.imageUrl)
        setMetadataImageUrl(token.imageUrl)
      }
      setMetadataUri("")
      toast.success("cloned metadata from database")
    } catch (error: any) {
      toast.error(error?.message || "Failed to clone metadata")
    } finally {
      setCloning(false)
    }
  }

  // clone existing token metadata
  const handleCloneMetadata = async (address?: string) => {
    const target = (address || cloneAddress).trim()
    if (!target) {
      toast.error("enter token address to clone")
      return
    }

    setCloning(true)
    try {
      const token = tokens.find((entry) => entry.mintAddress === target)
      if (!token) {
        throw new Error("token not found in database")
      }

      setTokenName(token.name || "")
      setTokenSymbol(token.symbol || "")
      setDescription(token.description || "")
      setWebsite(token.website || "")
      setTwitter(token.twitter || "")
      setTelegram(token.telegram || "")

      if (token.imageUrl) {
        setImagePreview(token.imageUrl)
        setMetadataImageUrl(token.imageUrl)
      }

      toast.success(`cloned metadata from ${token.symbol || "token"}`)
      setCloneAddress("")
    } catch (error: any) {
      toast.error(error.message || "failed to clone metadata")
    } finally {
      setCloning(false)
    }
  }

  // handle keypair JSON upload
  const handleKeypairUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string
        const keypairArray = JSON.parse(content)
        
        if (!Array.isArray(keypairArray) || keypairArray.length !== 64) {
          throw new Error("invalid keypair format")
        }
        
        // convert to Keypair and then to base58
        const keypair = Keypair.fromSecretKey(new Uint8Array(keypairArray))
        setCustomKeypair(bs58.encode(keypair.secretKey))
        toast.success(`loaded keypair: ${keypair.publicKey.toBase58().slice(0, 8)}...`)
      } catch (error: any) {
        toast.error(error.message || "invalid keypair JSON")
      }
    }
    reader.readAsText(file)
  }

  const qc = useQueryClient()

  useEffect(() => {
    fetchNetwork()
  }, [])

  const tokensQuery = useQuery<any[], Error>({
    queryKey: ["tokens"],
    queryFn: async () => {
      const res = await fetch("/api/tokens")
      if (!res.ok) throw new Error("failed to fetch tokens")
      return res.json()
    },
    refetchInterval: 10_000,
  })
  useEffect(() => {
    if (tokensQuery.data) {
      setTokens(tokensQuery.data)
    }
    if (tokensQuery.isSuccess || tokensQuery.isError) setLoading(false)
  }, [tokensQuery.data, tokensQuery.isSuccess, tokensQuery.isError])

  useEffect(() => {
    const loadTrash = async () => {
      try {
        const res = await fetch("/api/tokens?trash=true")
        if (!res.ok) return
        const data = await res.json()
        setTrashTokens(Array.isArray(data) ? data : [])
      } catch {
        // ignore
      }
    }
    loadTrash()
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const stored = window.localStorage.getItem("lastImportedMint")
    if (stored && !lastImportedMint) {
      setLastImportedMint(stored)
    }
  }, [lastImportedMint])

  useEffect(() => {
    if (!lastImportedMint) return
    if (!tokensQuery.data) return
    const exists = tokensQuery.data.some((t) => t.mintAddress === lastImportedMint)
    if (exists) return
    fetch("/api/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ importMint: lastImportedMint }),
    }).then(() => {
      qc.invalidateQueries({ queryKey: ["tokens"] })
    }).catch(() => {})
  }, [lastImportedMint, tokensQuery.data, qc])

  const priceQuery = useQuery<any, Error>({
    queryKey: ["token-price", selectedToken?.mintAddress],
    queryFn: async () => {
      if (!selectedToken) return null
      const res = await fetch(`/api/tokens/price?mintAddress=${selectedToken.mintAddress}`)
      if (!res.ok) throw new Error("failed to fetch token price")
      return res.json()
    },
    enabled: !!selectedToken,
    refetchInterval: 10_000,
  })
  useEffect(() => {
    if (!priceQuery.data || !selectedToken) return
    const data = priceQuery.data
    setTokenPrices((prev) => ({
      ...prev,
      [selectedToken.mintAddress]: {
        price: data.price || 0,
        marketCap: data.marketCap || 0,
        isMigrated: data.isMigrated || false,
      },
    }))
  }, [priceQuery.data, selectedToken])

  const fetchNetwork = async () => {
    try {
      const res = await fetch("/api/network")
      const data = await res.json()
      setNetwork(data.network || "unknown")
    } catch {
      setNetwork("unknown")
    }
  }

  const fetchTokenPrice = async (mintAddress: string) => {
    await qc.invalidateQueries({ queryKey: ["token-price", mintAddress] })
  }

  const handleImportMint = async () => {
    if (!importMint.trim()) {
      toast.error("enter mint to import")
      return
    }
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          importMint: importMint.trim(),
          creatorWallet: publicKey?.toBase58() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.error || "import failed")
      }
        if (data?.token) {
          setTokens((prev) => {
            const exists = prev.some((t) => t.mintAddress === data.token.mintAddress)
            return exists ? prev : [data.token, ...prev]
          })
          setSelectedToken(data.token)
          setLastImportedMint(data.token.mintAddress)
          if (typeof window !== "undefined") {
            window.localStorage.setItem("lastImportedMint", data.token.mintAddress)
          }
        }
      toast.success("token imported to panel")
      setImportMint("")
      qc.invalidateQueries({ queryKey: ["tokens"] })
    } catch (error: any) {
      toast.error(error?.message || "import failed")
    }
  }

  const handleRestoreToken = async (mint: string) => {
    try {
      const res = await fetch("/api/tokens", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mintAddress: mint }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) {
        toast.error(data.error || "restore failed")
        return
      }
      if (data.token) {
        setTrashTokens((prev) => prev.filter((t) => t.mintAddress !== mint))
        setTokens((prev) => {
          if (prev.some((t) => t.mintAddress === mint)) return prev
          return [data.token, ...prev]
        })
      }
      toast.success("token restored")
    } catch (error: any) {
      toast.error(error?.message || "restore failed")
    }
  }

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast.error("image must be less than 5MB")
        return
      }
      setImageFile(file)
      const reader = new FileReader()
      reader.onloadend = () => {
        setImagePreview(reader.result as string)
      }
      reader.readAsDataURL(file)
      setMetadataUri("") // reset metadata when image changes
      setMetadataImageUrl("")
    }
  }

  const handleUploadMetadata = async () => {
    if (!imageFile) {
      toast.error("please select an image")
      return
    }
    if (!tokenName || !tokenSymbol) {
      toast.error("name and symbol required")
      return
    }

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", imageFile)
      formData.append("name", tokenName)
      formData.append("symbol", tokenSymbol)
      formData.append("description", description || "")
      if (twitter) formData.append("twitter", twitter)
      if (telegram) formData.append("telegram", telegram)
      if (website) formData.append("website", website)

      const res = await fetch("/api/tokens/upload-metadata", {
        method: "POST",
        body: formData,
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || "failed to upload metadata")
      }

      const data = await res.json()
      setMetadataUri(data.metadataUri)
      const imageUrl =
        data?.metadata?.image ||
        data?.metadata?.image_uri ||
        data?.metadata?.imageUrl ||
        ""
      setMetadataImageUrl(imageUrl)
      toast.success("metadata uploaded to IPFS!")
    } catch (error: any) {
      toast.error(error.message || "failed to upload metadata")
    } finally {
      setUploading(false)
    }
  }

  const handleCreateToken = async () => {
    if (!publicKey || !signTransaction) {
      toast.error("please connect your wallet")
      return
    }

    if (!metadataUri) {
      toast.error("please upload metadata first")
      return
    }

    const validation = validateTokenParams({
      name: tokenName,
      symbol: tokenSymbol,
      description: description || "",
        imageUrl: metadataUri || imagePreview,
    })

    if (!validation.valid) {
      toast.error(validation.errors[0] || "invalid token parameters")
      return
    }

    setCreating(true)
    try {
      // use custom keypair or generate new one
      let mint: Keypair
      let mintKeypair: string
      
      if (customKeypair) {
        mint = Keypair.fromSecretKey(bs58.decode(customKeypair))
        mintKeypair = customKeypair
      } else {
        mint = Keypair.generate()
        mintKeypair = bs58.encode(mint.secretKey)
      }

      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: tokenName,
          symbol: tokenSymbol,
          description: description || "",
          metadataUri,
          website,
          twitter,
          telegram,
          imageUrl: metadataImageUrl || "",
          creatorWallet: publicKey.toBase58(),
          mintKeypair,
        }),
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || "failed to create token")
      }

      const { transaction: txBase58, token, mintAddress } = await res.json()

      // deserialize and sign
      const transaction = Transaction.from(bs58.decode(txBase58))
      transaction.partialSign(mint)
      const signed = await signTransaction(transaction)

      // send
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      })

      await connection.confirmTransaction(signature, "confirmed")

      toast.success(`token created! mint: ${mintAddress.slice(0, 8)}...`)
      setLastCreatedMint(mintAddress)
      setTokens([token, ...tokens])
      
      // reset form
      setTokenName("")
      setTokenSymbol("")
      setDescription("")
      setImageFile(null)
      setImagePreview("")
      setMetadataUri("")
      setMetadataImageUrl("")
      setWebsite("")
      setTwitter("")
      setTelegram("")
      setCustomKeypair("")
    } catch (error: any) {
      console.error("error creating token:", error)
      toast.error(error.message || "failed to create token")
    } finally {
      setCreating(false)
    }
  }

  const handleBuy = async () => {
    if (!publicKey || !signTransaction || !selectedToken) {
      toast.error("please connect wallet and select a token")
      return
    }
    if (tokenPrices[selectedToken.mintAddress]?.isMigrated) {
      toast.error("token migrated - buy on raydium/pumpswap")
      return
    }

    const buyValidation = validateBuyAmount(buyAmount)
    if (!buyValidation.valid) {
      toast.error(buyValidation.error || "invalid buy amount")
      return
    }

    setBuying(true)
    try {
      const res = await fetch("/api/tokens/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mintAddress: selectedToken.mintAddress,
          solAmount: buyAmount,
          buyerWallet: publicKey.toBase58(),
          slippage: clampPercent(5),
        }),
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || "failed to create buy transaction")
      }

      const { transaction: txBase58, estimatedTokens } = await res.json()
      const transaction = Transaction.from(bs58.decode(txBase58))

      const signed = await signTransaction(transaction)
      const signature = await connection.sendRawTransaction(signed.serialize())

      await connection.confirmTransaction(signature, "confirmed")
      toast.success(`bought ~${(Number(estimatedTokens) / 1e6).toFixed(2)} tokens!`)
      setBuyAmount("")
      fetchTokenPrice(selectedToken.mintAddress)
    } catch (error: any) {
      toast.error(error.message || "failed to buy tokens")
    } finally {
      setBuying(false)
    }
  }

  const handleSell = async () => {
    if (!publicKey || !signTransaction || !selectedToken) {
      toast.error("please connect wallet and select a token")
      return
    }

    setSelling(true)
    try {
      const { PublicKey } = await import("@solana/web3.js")
      const tokenAccount = await connection.getParsedTokenAccountsByOwner(publicKey, {
        mint: new PublicKey(selectedToken.mintAddress),
      })

      if (tokenAccount.value.length === 0) {
        toast.error("you don't have any tokens to sell")
        return
      }

      const balance = tokenAccount.value[0].account.data.parsed.info.tokenAmount.uiAmount
      const decimals = 6
      let amountToSell: number

      if (sellPercentage) {
        const percentage = parseFloat(sellPercentage)
        if (!Number.isFinite(percentage) || percentage <= 0) {
          toast.error("invalid percentage")
          return
        }
        amountToSell = Math.floor(balance * (percentage / 100) * (10 ** decimals))
      } else if (sellAmount) {
        const sellParsed = parseFloat(sellAmount)
        if (!Number.isFinite(sellParsed) || sellParsed <= 0) {
          toast.error("invalid sell amount")
          return
        }
        amountToSell = Math.floor(sellParsed * (10 ** decimals))
      } else {
        toast.error("please enter amount or percentage to sell")
        return
      }
      if (!Number.isFinite(amountToSell) || amountToSell <= 0) {
        toast.error("invalid sell amount")
        return
      }

      const res = await fetch("/api/tokens/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mintAddress: selectedToken.mintAddress,
          tokenAmount: amountToSell.toString(),
          sellerWallet: publicKey.toBase58(),
          slippage: clampPercent(5),
        }),
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || "failed to create sell transaction")
      }

      const { transaction: txBase58, estimatedSol } = await res.json()
      const transaction = Transaction.from(bs58.decode(txBase58))

      const signed = await signTransaction(transaction)
      const signature = await connection.sendRawTransaction(signed.serialize())

      await connection.confirmTransaction(signature, "confirmed")
      toast.success(`sold for ~${estimatedSol} SOL!`)
      setSellAmount("")
      setSellPercentage("")
      fetchTokenPrice(selectedToken.mintAddress)
    } catch (error: any) {
      toast.error(error.message || "failed to sell tokens")
    } finally {
      setSelling(false)
    }
  }

  const fetchRugpullStatus = async () => {
    if (!publicKey || !selectedToken) return
    
    try {
      const res = await fetch(
        `/api/tokens/rugpull?mintAddress=${selectedToken.mintAddress}&userWallet=${publicKey.toBase58()}`
      )
      const data = await res.json()
      setRugpullStatus(data)
    } catch (error) {
      console.error("error fetching rugpull status:", error)
    }
  }

  useEffect(() => {
    if (selectedToken && publicKey) {
      fetchRugpullStatus()
    }
  }, [selectedToken, publicKey])

  const handleRugpull = async () => {
    if (!publicKey || !signTransaction || !selectedToken) {
      toast.error("please connect wallet and select a token")
      return
    }

    // confirm
    const confirmed = window.confirm(
      `⚠️ RUGPULL WARNING ⚠️\n\n` +
      `this will sell ALL your ${selectedToken.symbol} tokens!\n` +
      `tokens: ${rugpullStatus?.tokenBalanceUi || "?"}\n` +
      `estimated SOL: ~${rugpullStatus?.estimatedSol || "?"}\n` +
      `method: ${rugpullStatus?.method || "unknown"}\n\n` +
      `this action cannot be undone. continue?`
    )

    if (!confirmed) return

    setRugpulling(true)
    try {
      const res = await fetch("/api/tokens/rugpull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mintAddress: selectedToken.mintAddress,
          userWallet: publicKey.toBase58(),
          slippage: clampPercent(25),
          route: rugpullRoute,
          payoutWallet: payoutWallet || undefined,
        }),
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || "failed to create rugpull transaction")
      }

      const { transaction: txBase58, method, tokenAmountUi, estimatedSol } = await res.json()
      const transaction = Transaction.from(bs58.decode(txBase58))

      const signed = await signTransaction(transaction)
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      })

      await connection.confirmTransaction(signature, "confirmed")
      
      toast.success(
        `🔥 RUGPULL EXECUTED!\n` +
        `sold ${tokenAmountUi} tokens via ${method}\n` +
        `estimated: ~${estimatedSol} SOL`
      )
      
      fetchTokenPrice(selectedToken.mintAddress)
      fetchRugpullStatus()
    } catch (error: any) {
      toast.error(error.message || "rugpull failed")
    } finally {
      setRugpulling(false)
    }
  }

  const isMainnet = network === "mainnet-beta"
  const setImageUrl = (url: string) => {}

  return (
    <div className="p-6 space-y-6">
      {/* network warning */}
      {!isMainnet && network !== "unknown" && (
      <Alert className="border-yellow-500/50 bg-yellow-500/10">
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
          <AlertDescription className="text-yellow-200">
            pump.fun works only on <strong>mainnet-beta</strong>. current network: <strong>{network}</strong>.
            change NEXT_PUBLIC_SOLANA_NETWORK in .env.local to mainnet-beta.
          </AlertDescription>
        </Alert>
      )}

      {/* header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-wider">PUMP.FUN LAUNCHER</h1>
          <p className="text-sm text-muted-foreground">create tokens on pump.fun bonding curve</p>
        </div>
        <Badge className={isMainnet ? "bg-green-500/20 text-green-400" : "bg-yellow-500/20 text-yellow-400"}>
          {network.toUpperCase()}
        </Badge>
      </div>

      {/* stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground tracking-wider">TOKENS CREATED</p>
                <p className="text-2xl font-bold text-foreground font-mono">{loading ? "..." : tokens.length}</p>
              </div>
              <Coins className="w-8 h-8 text-cyan-400" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground tracking-wider">WALLET</p>
                <p className="text-sm font-mono text-foreground truncate w-32">
                  {connected ? publicKey?.toBase58().slice(0, 8) + "..." : "not connected"}
                </p>
              </div>
              <Users className="w-8 h-8 text-cyan-400" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground tracking-wider">PLATFORM</p>
                <p className="text-lg font-bold text-foreground">pump.fun</p>
              </div>
              <Droplets className="w-8 h-8 text-cyan-400" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground tracking-wider">FEE</p>
                <p className="text-2xl font-bold text-foreground font-mono">~0.02 SOL</p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="import mint..."
                  value={importMint}
                  onChange={(e) => setImportMint(e.target.value)}
                  className="bg-background border-border text-foreground w-48"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="border-border text-foreground hover:bg-muted"
                  onClick={handleImportMint}
                >
                  import
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Token Metadata */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-foreground tracking-wider flex items-center gap-2">
                <Upload className="w-4 h-4 text-green-500" />
                Token Metadata
              </CardTitle>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="paste token address to clone"
                  className="bg-background border-border w-56"
                  value={cloneAddress}
                  onChange={(e) => setCloneAddress(e.target.value)}
                  disabled={cloning}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="border-border text-foreground hover:bg-muted"
                  onClick={handleClone}
                  disabled={cloning}
                >
                  {cloning ? "Cloning..." : "Clone Existing"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Token Name */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Token Name <span className="text-red-500">*</span>
              </Label>
              <Input
                placeholder="Enter token name..."
                className="bg-background border-border"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
              />
            </div>

            {/* Token Symbol */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Token Symbol <span className="text-red-500">*</span>
              </Label>
              <Input
                placeholder="Enter token symbol..."
                className="bg-background border-border"
                value={tokenSymbol}
                onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
                maxLength={10}
              />
            </div>

            {/* Token Description */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Token Description <span className="text-red-500">*</span>
              </Label>
              <Textarea
                placeholder="Enter token description..."
                className="bg-background border-border min-h-24"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Social Links */}
            <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
                <Label className="text-muted-foreground flex items-center gap-2">
                  <span className="text-lg">🌐</span> Website
                </Label>
              <Input
                  placeholder="https://example.com"
                className="bg-background border-border"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>
            <div className="space-y-2">
                <Label className="text-muted-foreground flex items-center gap-2">
                  <span className="text-lg">𝕏</span> Twitter
                </Label>
              <Input
                  placeholder="https://x.com/link"
                className="bg-background border-border"
                value={twitter}
                onChange={(e) => setTwitter(e.target.value)}
              />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground flex items-center gap-2">
                <span className="text-lg">✈️</span> Telegram
              </Label>
              <Input
                placeholder="t.me/yourtoken"
                className="bg-background border-border"
                value={telegram}
                onChange={(e) => setTelegram(e.target.value)}
              />
            </div>

            {/* Token Image */}
            <div className="space-y-2">
              <Label className="text-muted-foreground flex items-center gap-2">
                Token Image <span className="text-red-500">*</span>
                <span className="text-neutral-600 text-xs">ⓘ</span>
              </Label>
              <div 
                className="border-2 border-dashed border-border rounded-lg p-4 text-center cursor-pointer hover:border-primary/60 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                {imagePreview ? (
                  <div className="flex items-center justify-center gap-4">
                    <img src={imagePreview} alt="preview" className="w-16 h-16 rounded-lg object-cover" />
                    <span className="text-muted-foreground text-sm">Click to change image</span>
                  </div>
                ) : (
                  <div className="py-2">
                    <Button variant="outline" className="border-neutral-600 text-neutral-300">
                      <Upload className="w-4 h-4 mr-2" />
                      Upload Image
                    </Button>
                  </div>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageSelect}
                className="hidden"
              />
            </div>

            {/* Token Keypair (Optional) */}
            <div className="space-y-2">
              <Label className="text-muted-foreground flex items-center gap-2">
                Token Keypair (Optional)
                <span className="text-neutral-600 text-xs">ⓘ</span>
              </Label>
              {customKeypair ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 p-2 bg-green-500/10 border border-green-500/30 rounded text-xs text-green-400 font-mono">
                    ✓ {Keypair.fromSecretKey(bs58.decode(customKeypair)).publicKey.toBase58().slice(0, 12)}...
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-400 hover:text-red-300"
                    onClick={() => setCustomKeypair("")}
                  >
                    ✕
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="w-full border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/10"
                  onClick={() => keypairInputRef.current?.click()}
                >
                  <Upload className="w-4 h-4 mr-2" />
                  Upload Keypair JSON
                </Button>
              )}
              <p className="text-xs text-neutral-500">
                Upload a JSON file containing a Solana keypair as a number array [55,234,29,...]
              </p>
              <input
                ref={keypairInputRef}
                type="file"
                accept=".json"
                onChange={handleKeypairUpload}
                className="hidden"
              />
            </div>

            {/* Actions */}
            <div className="pt-4 space-y-3">
            {/* step 1: upload metadata */}
            {!metadataUri && (
              <Button
                onClick={handleUploadMetadata}
                  disabled={uploading || !imageFile || !tokenName || !tokenSymbol || !description || !isMainnet}
                className="w-full bg-purple-500 hover:bg-purple-600 text-white font-semibold disabled:opacity-50"
              >
                <Upload className="w-4 h-4 mr-2" />
                  {uploading ? "Uploading..." : "1. Upload to IPFS"}
              </Button>
            )}

            {/* step 2: create token */}
            {metadataUri && (
              <>
                <div className="p-2 bg-green-500/10 border border-green-500/30 rounded text-xs text-green-400 break-all">
                    ✓ Metadata: {metadataUri}
                </div>
                <Button
                  onClick={handleCreateToken}
                  disabled={creating || !publicKey || !isMainnet}
                  className="w-full bg-cyan-500 hover:bg-cyan-600 text-black font-semibold disabled:opacity-50"
                >
                  <Rocket className="w-4 h-4 mr-2" />
                    {creating ? "Creating..." : "2. Create Token (~0.02 SOL)"}
                </Button>
                {lastCreatedMint && (
                  <div className="p-2 bg-muted border border-border rounded text-xs text-foreground space-y-1 break-all">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Mint</span>
                      <span className="font-mono text-cyan-300">{lastCreatedMint}</span>
                    </div>
                    <div className="flex gap-3 flex-wrap text-[11px]">
                      <a
                        href={`https://pump.fun/${lastCreatedMint}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-400 hover:text-cyan-300"
                      >
                        pump.fun
                      </a>
                      <a
                        href={`https://solscan.io/token/${lastCreatedMint}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-400 hover:text-cyan-300"
                      >
                        solscan
                      </a>
                    </div>
                  </div>
                )}
              </>
            )}
            </div>
          </CardContent>
        </Card>

        {/* my tokens */}
        <Card className="lg:col-span-2 bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-foreground tracking-wider">MY TOKENS</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {loading ? (
                <div className="text-muted-foreground text-sm p-3">loading tokens...</div>
              ) : tokens.length === 0 ? (
                <div className="text-muted-foreground text-sm p-3">no tokens created yet</div>
              ) : (
                tokens.map((token) => (
                <div
                  key={token.id}
                  onClick={() => setSelectedToken(token)}
                  className={`p-4 rounded cursor-pointer transition-colors ${
                    selectedToken?.id === token.id
                      ? "bg-primary/10 border border-primary/40"
                      : "bg-card hover:bg-muted border border-transparent"
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-cyan-400 to-cyan-600 rounded-full flex items-center justify-center text-black font-bold">
                        {token.symbol.charAt(0)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-foreground font-bold">{token.symbol}</span>
                          <Badge className={
                            tokenPrices[token.mintAddress]?.isMigrated
                              ? "bg-blue-500/20 text-blue-500"
                              : "bg-green-500/20 text-green-500"
                          }>
                            {tokenPrices[token.mintAddress]?.isMigrated ? "MIGRATED" : "LIVE"}
                          </Badge>
                          {tokenPrices[token.mintAddress]?.isMigrated ? (
                            <Lock className="w-3 h-3 text-blue-500" />
                          ) : (
                            <Unlock className="w-3 h-3 text-yellow-500" />
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground">{token.name}</div>
                        <div className="text-xs text-primary font-mono break-all">{token.mintAddress}</div>
                        <div className="flex gap-2 text-[11px] text-primary">
                          <a
                            href={`https://pump.fun/${token.mintAddress}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:opacity-80"
                            onClick={(e) => e.stopPropagation()}
                          >
                            pump.fun
                          </a>
                          <a
                            href={`https://solscan.io/token/${token.mintAddress}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:opacity-80"
                            onClick={(e) => e.stopPropagation()}
                          >
                            solscan
                          </a>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-foreground font-mono">
                        {tokenPrices[token.mintAddress]?.price 
                          ? `$${tokenPrices[token.mintAddress].price.toFixed(8)}`
                          : "loading..."}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {tokenPrices[token.mintAddress]?.isMigrated ? "raydium" : "bonding curve"}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-muted-foreground text-xs">price</div>
                      <div className="text-foreground font-mono text-xs">
                        {tokenPrices[token.mintAddress]?.price 
                          ? `$${tokenPrices[token.mintAddress].price.toFixed(6)}`
                          : "-"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">status</div>
                      <div className="text-foreground font-mono text-xs">
                        {tokenPrices[token.mintAddress]?.isMigrated ? "migrated" : "bonding"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">market cap</div>
                      <div className="text-foreground font-mono text-xs">
                        {tokenPrices[token.mintAddress]?.marketCap 
                          ? `$${(tokenPrices[token.mintAddress].marketCap / 1000).toFixed(1)}K`
                          : "-"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">created</div>
                      <div className="text-foreground">{new Date(token.createdAt).toLocaleDateString()}</div>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end pt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-red-500/50 text-red-400 hover:bg-red-500/10"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteToken(token.mintAddress)
                      }}
                    >
                      delete
                    </Button>
                  </div>
                </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* trash */}
        <Card className="lg:col-span-2 bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-foreground tracking-wider">TRASH</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[400px] overflow-y-auto">
              {trashTokens.length === 0 ? (
                <div className="text-muted-foreground text-sm p-3">empty</div>
              ) : (
                trashTokens.map((token) => (
                  <div
                    key={token.id}
                    className="p-3 rounded bg-card border border-border flex items-center justify-between"
                  >
                    <div>
                      <div className="text-foreground font-semibold">{token.name}</div>
                      <div className="text-xs text-muted-foreground font-mono break-all">{token.mintAddress}</div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-green-600 text-green-300 hover:bg-green-600/20"
                        onClick={() => handleRestoreToken(token.mintAddress)}
                      >
                        restore
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* token management */}
      {selectedToken && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-foreground tracking-wider">
                MANAGE: {selectedToken.symbol}
              </CardTitle>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground font-mono text-sm">{selectedToken.mintAddress.slice(0, 16)}...</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    navigator.clipboard.writeText(selectedToken.mintAddress)
                    toast.success("address copied!")
                  }}
                >
                  <Copy className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    window.open(`https://pump.fun/${selectedToken.mintAddress}`, "_blank")
                  }}
                >
                  <ExternalLink className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 bg-muted rounded">
                <h4 className="text-sm font-medium text-foreground mb-3">BUY ON BONDING CURVE</h4>
                <div className="space-y-2">
                  <Input 
                    placeholder="amount in SOL" 
                    className="bg-background border-border"
                    value={buyAmount}
                    onChange={(e) => setBuyAmount(e.target.value)}
                    type="number"
                    step="0.01"
                    min="0.001"
                  />
                  <Button 
                    onClick={handleBuy}
                    disabled={
                      buying ||
                      !publicKey ||
                      !buyAmount ||
                      !isMainnet ||
                      tokenPrices[selectedToken.mintAddress]?.isMigrated
                    }
                    className="w-full bg-green-500 hover:bg-green-600 text-black disabled:opacity-50"
                  >
                    {buying ? "buying..." : "BUY"}
                  </Button>
                </div>
              </div>
              <div className="p-4 bg-muted rounded">
                <h4 className="text-sm font-medium text-foreground mb-3">SELL TOKENS</h4>
                <div className="space-y-2">
                  <Input 
                    placeholder="amount (tokens) or % to sell (e.g. 50%)" 
                    className="bg-background border-border"
                    value={sellAmount || (sellPercentage ? sellPercentage + "%" : "")}
                    onChange={(e) => {
                      const val = e.target.value
                      if (val.endsWith("%")) {
                        setSellPercentage(val.slice(0, -1))
                        setSellAmount("")
                      } else {
                        setSellAmount(val)
                        setSellPercentage("")
                      }
                    }}
                  />
                  <div className="flex gap-2">
                    {[25, 50, 75, 100].map((pct) => (
                      <Button
                        key={pct}
                        size="sm"
                        variant="outline"
                        className="flex-1 border-border text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setSellPercentage(pct.toString())
                          setSellAmount("")
                        }}
                      >
                        {pct}%
                      </Button>
                    ))}
                  </div>
                  <Button 
                    onClick={handleSell}
                    disabled={selling || !publicKey || (!sellAmount && !sellPercentage) || !isMainnet}
                    className="w-full bg-red-500 hover:bg-red-600 text-white disabled:opacity-50"
                  >
                    {selling ? "selling..." : "SELL"}
                  </Button>
                </div>
              </div>
            </div>

            {/* RUGPULL SECTION */}
            <div className="mt-6 p-4 bg-red-950/30 border border-red-500/30 rounded-lg">
              <div className="flex items-center gap-2 mb-4">
                <Skull className="w-5 h-5 text-red-500" />
                <h4 className="text-sm font-bold text-red-400 tracking-wider">RUGPULL</h4>
                <Badge className="bg-red-500/20 text-red-400 text-xs">DANGER</Badge>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">Route</Label>
                  <div className="flex gap-2 flex-wrap">
                    {["auto", "bonding_curve", "pumpswap"].map((route) => (
                      <Button
                        key={route}
                        size="sm"
                        variant={rugpullRoute === route ? "default" : "outline"}
                        className={
                          rugpullRoute === route
                            ? "bg-red-500 text-white"
                            : "border-border text-foreground"
                        }
                        onClick={() => setRugpullRoute(route as any)}
                      >
                        {route.replace("_", " ")}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">Payout wallet (optional)</Label>
                  <Input
                    placeholder="destination wallet for proceeds"
                    className="bg-background border-border"
                    value={payoutWallet}
                    onChange={(e) => setPayoutWallet(e.target.value)}
                  />
                </div>
              </div>

              {rugpullStatus && (
                <div className="space-y-3 mb-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">your balance:</span>
                      <span className="text-foreground ml-2 font-mono">
                        {rugpullStatus.tokenBalanceUi?.toLocaleString() || "0"} tokens
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">estimated return:</span>
                      <span className="text-green-400 ml-2 font-mono">
                        ~{rugpullStatus.estimatedSol || "?"} SOL
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">method:</span>
                      <span className="text-yellow-400 ml-2">
                        {rugpullStatus.method === "bonding_curve" ? "bonding curve" : 
                         rugpullStatus.method === "pumpswap" ? "pumpswap AMM" : "none"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">price impact:</span>
                      <span className="text-red-400 ml-2 font-mono">
                        ~{rugpullStatus.priceImpact || "?"}%
                      </span>
                    </div>
                  </div>
                  
                  {rugpullStatus.warning && (
                    <div className="p-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-xs text-yellow-400">
                      ⚠️ {rugpullStatus.warning}
                    </div>
                  )}
                </div>
              )}

              <Button 
                onClick={handleRugpull}
                disabled={rugpulling || !publicKey || !rugpullStatus?.canRugpull || !isMainnet}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-bold disabled:opacity-50"
              >
                <Flame className="w-4 h-4 mr-2" />
                {rugpulling ? "executing rugpull..." : "🔥 EXECUTE RUGPULL (sell all)"}
              </Button>
              
              <p className="text-xs text-neutral-500 mt-2 text-center">
                sells ALL tokens instantly. {rugpullStatus?.method === "pumpswap" ? "via pumpswap AMM" : "via bonding curve"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* auto-triggers */}
      {selectedToken && publicKey && (
        <TriggerManager
          mintAddress={selectedToken.mintAddress}
          tokenSymbol={selectedToken.symbol}
          walletAddress={publicKey.toBase58()}
          currentPrice={tokenPrices[selectedToken.mintAddress]?.price || 0}
          entryPrice={tokenPrices[selectedToken.mintAddress]?.price || 0}
        />
      )}
    </div>
  )
}
