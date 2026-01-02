"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Rocket, Settings, Pause, Play } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BundlerWallet } from "@/types/dashboard"

interface VolumeBotPanelProps {
  volumeRunning: boolean
  volumeBotStatus: any
  volumeBotConfig: any
  setSettingsOpen: (open: boolean) => void
  startVolumeBot: () => void
  stopVolumeBot: () => void
  selectedToken: any
  loading: boolean
  volumeBotStats: any
  activeWallets: BundlerWallet[]
  setQuickTradeWallet: (wallet: BundlerWallet) => void
}

export function VolumeBotPanel({
  volumeRunning,
  volumeBotStatus,
  volumeBotConfig,
  setSettingsOpen,
  startVolumeBot,
  stopVolumeBot,
  selectedToken,
  loading,
  volumeBotStats,
  activeWallets,
  setQuickTradeWallet
}: VolumeBotPanelProps) {
  return (
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

        <div className="resize-y overflow-auto min-h-[120px] p-1 border border-transparent hover:border-neutral-800 transition-colors">
          <div className="grid grid-cols-6 sm:grid-cols-8 lg:grid-cols-12 gap-1 auto-rows-min">
            {activeWallets.length === 0 ? (
              <div className="col-span-full text-xs text-neutral-500">No active wallets</div>
            ) : (
              activeWallets.map((wallet, index) => {
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
                    key={wallet.publicKey}
                    type="button"
                    onClick={() => setQuickTradeWallet(wallet)}
                    className={`h-10 rounded border ${borderColor} bg-white p-1 text-left text-[9px] leading-tight transition`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <div className="text-[9px] truncate" style={{ color: "#000", fontWeight: 700 }}>
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
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
