"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Coins,
  RefreshCw,
  ExternalLink,
  Search,
  Filter,
  ArrowUpDown,
  DollarSign,
  Percent,
  Clock,
  Zap,
  MoreVertical,
} from "lucide-react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { PnLSummaryCard, MiniPnLCard } from "@/components/pnl/PnLCard"
import type { PnLSummary, TokenPnL } from "@/lib/pnl/types"

interface TokenHolding {
  mintAddress: string
  symbol: string
  name: string
  balance: number
  balanceUsd: number
  price: number
  priceChange24h: number
  costBasis: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  isMigrated: boolean
  lastUpdated: Date
}

type SortField = "balance" | "value" | "pnl" | "change"
type SortOrder = "asc" | "desc"

export default function PortfolioPage() {
  const { publicKey, connected } = useWallet()
  const [holdings, setHoldings] = useState<TokenHolding[]>([])
  const [pnlSummary, setPnlSummary] = useState<PnLSummary | null>(null)
  const [tokenPnls, setTokenPnls] = useState<TokenPnL[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState("")
  const [sortField, setSortField] = useState<SortField>("value")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")
  const [filter, setFilter] = useState<"all" | "profit" | "loss">("all")
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (connected && publicKey) {
      fetchPortfolio()
    }
  }, [connected, publicKey])

  const fetchPortfolio = async () => {
    if (!publicKey) return
    
    setLoading(true)
    try {
      // fetch tokens
      const tokensRes = await fetch("/api/tokens")
      const tokens = await tokensRes.json()

      // fetch pnl summary
      const pnlRes = await fetch("/api/pnl?type=summary")
      const pnlData = await pnlRes.json()
      setPnlSummary(pnlData.summary)

      // fetch token pnls
      const tokenPnlRes = await fetch("/api/pnl?type=token")
      const tokenPnlData = await tokenPnlRes.json()
      setTokenPnls(tokenPnlData.tokenPnLs || [])

      // mock holdings for display (in production, fetch from chain)
      const mockHoldings: TokenHolding[] = tokens.map((token: any) => ({
        mintAddress: token.mintAddress,
        symbol: token.symbol,
        name: token.name,
        balance: Math.random() * 1000000,
        balanceUsd: Math.random() * 500,
        price: Math.random() * 0.0001,
        priceChange24h: (Math.random() - 0.5) * 40,
        costBasis: Math.random() * 300,
        unrealizedPnl: (Math.random() - 0.4) * 200,
        unrealizedPnlPercent: (Math.random() - 0.4) * 100,
        isMigrated: Math.random() > 0.7,
        lastUpdated: new Date(),
      }))

      setHoldings(mockHoldings)
    } catch (error) {
      console.error("error fetching portfolio:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortOrder("desc")
    }
  }

  const toggleTokenSelection = (mint: string) => {
    const newSelected = new Set(selectedTokens)
    if (newSelected.has(mint)) {
      newSelected.delete(mint)
    } else {
      newSelected.add(mint)
    }
    setSelectedTokens(newSelected)
  }

  const selectAll = () => {
    if (selectedTokens.size === filteredHoldings.length) {
      setSelectedTokens(new Set())
    } else {
      setSelectedTokens(new Set(filteredHoldings.map(h => h.mintAddress)))
    }
  }

  const batchSell = async (percent: number) => {
    if (selectedTokens.size === 0) {
      toast.error("select tokens to sell")
      return
    }
    
    toast.info(`selling ${percent}% of ${selectedTokens.size} tokens...`)
    // in production, execute batch sell
  }

  // filter and sort
  let filteredHoldings = holdings
    .filter(h => {
      if (search) {
        const s = search.toLowerCase()
        if (!h.symbol.toLowerCase().includes(s) && !h.name.toLowerCase().includes(s)) {
          return false
        }
      }
      if (filter === "profit" && h.unrealizedPnl <= 0) return false
      if (filter === "loss" && h.unrealizedPnl >= 0) return false
      return true
    })
    .sort((a, b) => {
      let aVal = 0, bVal = 0
      switch (sortField) {
        case "balance": aVal = a.balance; bVal = b.balance; break
        case "value": aVal = a.balanceUsd; bVal = b.balanceUsd; break
        case "pnl": aVal = a.unrealizedPnl; bVal = b.unrealizedPnl; break
        case "change": aVal = a.priceChange24h; bVal = b.priceChange24h; break
      }
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal
    })

  // totals
  const totalValue = holdings.reduce((sum, h) => sum + h.balanceUsd, 0)
  const totalPnl = holdings.reduce((sum, h) => sum + h.unrealizedPnl, 0)
  const totalPnlPercent = totalValue > 0 ? (totalPnl / (totalValue - totalPnl)) * 100 : 0

  return (
    <div className="p-6 space-y-6">
      {/* header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-wider">PORTFOLIO</h1>
          <p className="text-sm text-neutral-400">manage all your pump.fun tokens</p>
        </div>
        <div className="flex items-center gap-2">
          <Button 
            variant="outline" 
            className="border-neutral-700 text-neutral-300"
            onClick={fetchPortfolio}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            refresh
          </Button>
        </div>
      </div>

      {!connected ? (
        <Card className="bg-neutral-900 border-neutral-700">
          <CardContent className="p-8 text-center">
            <Wallet className="w-12 h-12 mx-auto text-neutral-500 mb-4" />
            <p className="text-neutral-400">connect your wallet to view portfolio</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card className="bg-neutral-900 border-neutral-700">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-neutral-400 tracking-wider">TOTAL VALUE</p>
                    <p className="text-2xl font-bold text-white font-mono">${totalValue.toFixed(2)}</p>
                  </div>
                  <DollarSign className="w-8 h-8 text-cyan-400" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-neutral-900 border-neutral-700">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-neutral-400 tracking-wider">UNREALIZED P&L</p>
                    <p className={`text-2xl font-bold font-mono ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
                    </p>
                  </div>
                  {totalPnl >= 0 ? (
                    <TrendingUp className="w-8 h-8 text-green-400" />
                  ) : (
                    <TrendingDown className="w-8 h-8 text-red-400" />
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="bg-neutral-900 border-neutral-700">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-neutral-400 tracking-wider">ROI</p>
                    <p className={`text-2xl font-bold font-mono ${totalPnlPercent >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {totalPnlPercent >= 0 ? "+" : ""}{totalPnlPercent.toFixed(1)}%
                    </p>
                  </div>
                  <Percent className="w-8 h-8 text-purple-400" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-neutral-900 border-neutral-700">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-neutral-400 tracking-wider">TOKENS</p>
                    <p className="text-2xl font-bold text-white font-mono">{holdings.length}</p>
                  </div>
                  <Coins className="w-8 h-8 text-yellow-400" />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* pnl card */}
          {pnlSummary && (
            <PnLSummaryCard summary={pnlSummary} title="Realized P&L Summary" />
          )}

          {/* filters and actions */}
          <Card className="bg-neutral-900 border-neutral-700">
            <CardContent className="p-4">
              <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
                    <Input
                      placeholder="search tokens..."
                      className="pl-9 bg-neutral-800 border-neutral-700 text-white w-48"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant={filter === "all" ? "default" : "outline"}
                      className={filter === "all" 
                        ? "bg-cyan-500/20 text-cyan-400" 
                        : "border-neutral-700 text-neutral-400"
                      }
                      onClick={() => setFilter("all")}
                    >
                      all
                    </Button>
                    <Button
                      size="sm"
                      variant={filter === "profit" ? "default" : "outline"}
                      className={filter === "profit" 
                        ? "bg-green-500/20 text-green-400" 
                        : "border-neutral-700 text-neutral-400"
                      }
                      onClick={() => setFilter("profit")}
                    >
                      profit
                    </Button>
                    <Button
                      size="sm"
                      variant={filter === "loss" ? "default" : "outline"}
                      className={filter === "loss" 
                        ? "bg-red-500/20 text-red-400" 
                        : "border-neutral-700 text-neutral-400"
                      }
                      onClick={() => setFilter("loss")}
                    >
                      loss
                    </Button>
                  </div>
                </div>

                {/* batch actions */}
                {selectedTokens.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-neutral-400">
                      {selectedTokens.size} selected
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-yellow-500/50 text-yellow-400"
                      onClick={() => batchSell(50)}
                    >
                      sell 50%
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-red-500/50 text-red-400"
                      onClick={() => batchSell(100)}
                    >
                      sell all
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* holdings table */}
          <Card className="bg-neutral-900 border-neutral-700">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-neutral-300 tracking-wider">
                  HOLDINGS
                </CardTitle>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-neutral-400"
                  onClick={selectAll}
                >
                  {selectedTokens.size === filteredHoldings.length ? "deselect all" : "select all"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {/* header */}
              <div className="grid grid-cols-12 gap-4 p-3 bg-neutral-800 rounded-lg text-xs text-neutral-500 font-medium mb-2">
                <div className="col-span-1"></div>
                <div className="col-span-3">TOKEN</div>
                <div 
                  className="col-span-2 cursor-pointer flex items-center gap-1"
                  onClick={() => handleSort("balance")}
                >
                  BALANCE
                  <ArrowUpDown className="w-3 h-3" />
                </div>
                <div 
                  className="col-span-2 cursor-pointer flex items-center gap-1"
                  onClick={() => handleSort("value")}
                >
                  VALUE
                  <ArrowUpDown className="w-3 h-3" />
                </div>
                <div 
                  className="col-span-2 cursor-pointer flex items-center gap-1"
                  onClick={() => handleSort("pnl")}
                >
                  P&L
                  <ArrowUpDown className="w-3 h-3" />
                </div>
                <div 
                  className="col-span-1 cursor-pointer flex items-center gap-1"
                  onClick={() => handleSort("change")}
                >
                  24H
                  <ArrowUpDown className="w-3 h-3" />
                </div>
                <div className="col-span-1"></div>
              </div>

              {/* rows */}
              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {filteredHoldings.length === 0 ? (
                  <div className="p-8 text-center text-neutral-500">
                    {loading ? "loading..." : "no tokens found"}
                  </div>
                ) : (
                  filteredHoldings.map((holding) => (
                    <div
                      key={holding.mintAddress}
                      className={`grid grid-cols-12 gap-4 p-3 rounded-lg transition-colors ${
                        selectedTokens.has(holding.mintAddress)
                          ? "bg-cyan-500/10 border border-cyan-500/30"
                          : "bg-neutral-800 hover:bg-neutral-700"
                      }`}
                    >
                      <div className="col-span-1 flex items-center">
                        <input
                          type="checkbox"
                          checked={selectedTokens.has(holding.mintAddress)}
                          onChange={() => toggleTokenSelection(holding.mintAddress)}
                          className="w-4 h-4 rounded border-neutral-600 bg-neutral-700"
                        />
                      </div>
                      
                      <div className="col-span-3 flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-purple-500 flex items-center justify-center text-black font-bold text-xs">
                          {holding.symbol.charAt(0)}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-white font-medium">{holding.symbol}</span>
                            {holding.isMigrated && (
                              <Badge className="bg-blue-500/20 text-blue-400 text-[10px]">AMM</Badge>
                            )}
                          </div>
                          <div className="text-xs text-neutral-500 truncate w-32">
                            {holding.mintAddress.slice(0, 8)}...
                          </div>
                        </div>
                      </div>
                      
                      <div className="col-span-2 flex items-center">
                        <span className="text-white font-mono text-sm">
                          {holding.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                      
                      <div className="col-span-2 flex items-center">
                        <span className="text-white font-mono text-sm">
                          ${holding.balanceUsd.toFixed(2)}
                        </span>
                      </div>
                      
                      <div className="col-span-2 flex items-center">
                        <div>
                          <div className={`font-mono text-sm ${holding.unrealizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {holding.unrealizedPnl >= 0 ? "+" : ""}{holding.unrealizedPnl.toFixed(2)}
                          </div>
                          <div className={`text-xs ${holding.unrealizedPnlPercent >= 0 ? "text-green-400/70" : "text-red-400/70"}`}>
                            {holding.unrealizedPnlPercent >= 0 ? "+" : ""}{holding.unrealizedPnlPercent.toFixed(1)}%
                          </div>
                        </div>
                      </div>
                      
                      <div className="col-span-1 flex items-center">
                        <span className={`font-mono text-sm ${holding.priceChange24h >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {holding.priceChange24h >= 0 ? "+" : ""}{holding.priceChange24h.toFixed(1)}%
                        </span>
                      </div>
                      
                      <div className="col-span-1 flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-neutral-400 hover:text-white h-8 w-8 p-0"
                          onClick={() => window.open(`https://pump.fun/${holding.mintAddress}`, "_blank")}
                        >
                          <ExternalLink className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-yellow-400 hover:text-yellow-300 h-8 w-8 p-0"
                          onClick={() => toast.info("quick actions coming soon")}
                        >
                          <Zap className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
