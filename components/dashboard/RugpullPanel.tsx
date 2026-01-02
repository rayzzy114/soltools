"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Flame, Wallet, Download } from "lucide-react"
import { BundlerWallet } from "@/types/dashboard"
import { RugpullEstimate } from "@/lib/pnl/types"

interface RugpullPanelProps {
  rugpullSlippage: string
  setRugpullSlippage: (value: string) => void
  useConnectedDev: boolean
  setUseConnectedDev: (value: boolean) => void
  devKey: string
  setDevKey: (value: string) => void
  rugpullEstimate: any
  totalTokensToSell: number
  profitEstimateSol: number | null
  selectedToken: any
  activeWalletsWithTokens: BundlerWallet[]
  rugpullAllWallets: () => void
  rugpullDevWallet: () => void
  collectAllToDev: () => void
  withdrawDevToConnected: () => void
  connected: boolean
  publicKey: any
}

export function RugpullPanel({
  rugpullSlippage,
  setRugpullSlippage,
  useConnectedDev,
  setUseConnectedDev,
  devKey,
  setDevKey,
  rugpullEstimate,
  totalTokensToSell,
  profitEstimateSol,
  selectedToken,
  activeWalletsWithTokens,
  rugpullAllWallets,
  rugpullDevWallet,
  collectAllToDev,
  withdrawDevToConnected,
  connected,
  publicKey
}: RugpullPanelProps) {
  return (
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

        <div className="pt-2 border-t border-red-500/20 mt-2">
            <Label className="text-[10px] text-slate-400 mb-1 block">AFTER DUMP</Label>
            <div className="grid grid-cols-2 gap-1">
                <Button
                    onClick={collectAllToDev}
                    className="h-6 bg-blue-600 hover:bg-blue-700 text-[10px]"
                >
                    <Wallet className="w-3 h-3 mr-1" />
                    Collect all → dev
                </Button>
                <Button
                    onClick={withdrawDevToConnected}
                    disabled={!connected}
                    className="h-6 bg-green-600 hover:bg-green-700 text-[10px]"
                >
                    <Download className="w-3 h-3 mr-1" />
                    Withdraw dev → connected
                </Button>
            </div>
        </div>
      </CardContent>
    </Card>
  )
}
