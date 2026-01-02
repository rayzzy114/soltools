"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TokenRanking } from "@/components/analytics/TokenRanking"
import { ActivityHeatmap } from "@/components/analytics/ActivityHeatmap"
import { Users, AlertTriangle, Trash2, Activity } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { HolderRow } from "@/lib/solana/holder-tracker"
import { Trade } from "@/lib/pnl/types"

interface AnalyticsPanelProps {
  holdersLoading: boolean
  holderRows: HolderRow[]
  trades: Trade[]
  systemLogs: string[]
  volumeBotStatus: any
  clearSystemLogs: () => void
  formatTimeAgo: (timestamp: string) => string
}

export function AnalyticsPanel({
  holdersLoading,
  holderRows,
  trades,
  systemLogs,
  volumeBotStatus,
  clearSystemLogs,
  formatTimeAgo
}: AnalyticsPanelProps) {
  return (
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
  )
}
