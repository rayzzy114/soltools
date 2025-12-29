"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DollarSign, Rocket, Upload } from "lucide-react"

type StaggerPreset = "fast" | "human" | "slow"

type LaunchPanelProps = {
  tokenName: string
  onTokenNameChange: (value: string) => void
  tokenSymbol: string
  onTokenSymbolChange: (value: string) => void
  tokenDescription: string
  onTokenDescriptionChange: (value: string) => void
  tokenImage: File | null
  onTokenImageChange: (file: File | null) => void
  metadataUri: string
  onUploadMetadata: () => void
  devBuyAmount: string
  onDevBuyAmountChange: (value: string) => void
  buyAmountPerWallet: string
  onBuyAmountPerWalletChange: (value: string) => void
  activeWalletCount: number
  jitoTip: string
  priorityFee: string
  onApplyStaggerPreset: (preset: StaggerPreset) => void
  onLaunch: () => void
  loading: boolean
  isMainnet: boolean
  dense?: boolean
}

export function LaunchPanel({
  tokenName,
  onTokenNameChange,
  tokenSymbol,
  onTokenSymbolChange,
  tokenDescription,
  onTokenDescriptionChange,
  tokenImage,
  onTokenImageChange,
  metadataUri,
  onUploadMetadata,
  devBuyAmount,
  onDevBuyAmountChange,
  buyAmountPerWallet,
  onBuyAmountPerWalletChange,
  activeWalletCount,
  jitoTip,
  priorityFee,
  onApplyStaggerPreset,
  onLaunch,
  loading,
  isMainnet,
  dense = false,
}: LaunchPanelProps) {
  const gapClass = dense ? "gap-1" : "gap-4"

  return (
    <div className={`grid grid-cols-1 lg:grid-cols-2 ${gapClass}`}>
      <Card className="bg-neutral-900 border-neutral-700">
        <CardHeader className={dense ? "py-2 px-2" : "pb-3"}>
          <CardTitle className="text-sm text-neutral-300 flex items-center gap-2">
            <Rocket className="w-4 h-4 text-purple-400" />
            Token Metadata
          </CardTitle>
        </CardHeader>
        <CardContent className={dense ? "space-y-2 px-2 pb-2" : "space-y-4"}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-neutral-400 text-xs">Name</Label>
              <Input
                value={tokenName}
                onChange={(e) => onTokenNameChange(e.target.value)}
                placeholder="Token Name"
                className="bg-neutral-800 border-neutral-700 text-white"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-neutral-400 text-xs">Symbol</Label>
              <Input
                value={tokenSymbol}
                onChange={(e) => onTokenSymbolChange(e.target.value)}
                placeholder="SYMBOL"
                className="bg-neutral-800 border-neutral-700 text-white"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-neutral-400 text-xs">Description</Label>
            <Textarea
              value={tokenDescription}
              onChange={(e) => onTokenDescriptionChange(e.target.value)}
              placeholder="Token description..."
              className="bg-neutral-800 border-neutral-700 text-white resize-none"
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-neutral-400 text-xs">Image</Label>
            <Input
              type="file"
              accept="image/*"
              onChange={(e) => onTokenImageChange(e.target.files?.[0] || null)}
              className="bg-neutral-800 border-neutral-700 text-white"
            />
          </div>

          <Button
            onClick={onUploadMetadata}
            disabled={loading || !tokenImage || !tokenName || !tokenSymbol}
            className="w-full bg-cyan-500 hover:bg-cyan-600"
          >
            <Upload className="w-4 h-4 mr-2" />
            Upload to IPFS
          </Button>

          {metadataUri && (
            <div className="p-2 bg-green-900/20 border border-green-500/30 rounded text-xs">
              <span className="text-green-400">Metadata URI:</span>
              <span className="text-white ml-2 font-mono break-all">{metadataUri}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-neutral-900 border-neutral-700">
        <CardHeader className={dense ? "py-2 px-2 flex flex-col gap-2" : "pb-3 flex flex-col gap-2"}>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm text-neutral-300 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-green-400" />
              Launch Settings
            </CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onApplyStaggerPreset("fast")}>
                fast stagger
              </Button>
              <Button variant="outline" size="sm" onClick={() => onApplyStaggerPreset("human")}>
                human
              </Button>
              <Button variant="outline" size="sm" onClick={() => onApplyStaggerPreset("slow")}>
                slow
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className={dense ? "space-y-2 px-2 pb-2" : "space-y-4"}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-neutral-400 text-xs">Dev Buy (SOL)</Label>
              <Input
                type="number"
                step="0.01"
                value={devBuyAmount}
                onChange={(e) => onDevBuyAmountChange(e.target.value)}
                className="bg-neutral-800 border-neutral-700 text-white"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-neutral-400 text-xs">Per Wallet (SOL)</Label>
              <Input
                type="number"
                step="0.001"
                value={buyAmountPerWallet}
                onChange={(e) => onBuyAmountPerWalletChange(e.target.value)}
                className="bg-neutral-800 border-neutral-700 text-white"
              />
            </div>
          </div>

          <div className="p-3 bg-neutral-800 rounded space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">Active Wallets:</span>
              <span className="text-white font-mono">{activeWalletCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">Dev Buy:</span>
              <span className="text-cyan-400 font-mono">{devBuyAmount} SOL</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">Bundled Buys:</span>
              <span className="text-cyan-400 font-mono">
                {Math.max(0, activeWalletCount - 1)} x {buyAmountPerWallet} SOL
              </span>
            </div>
            <div className="flex justify-between text-sm border-t border-neutral-700 pt-2">
              <span className="text-neutral-400">Estimated Total:</span>
              <span className="text-green-400 font-mono">
                {(
                  parseFloat(devBuyAmount || "0") +
                  Math.max(0, activeWalletCount - 1) * parseFloat(buyAmountPerWallet || "0") +
                  parseFloat(jitoTip || "0") +
                  activeWalletCount * parseFloat(priorityFee || "0")
                ).toFixed(4)}{" "}
                SOL
              </span>
            </div>
          </div>

          <Button
            onClick={onLaunch}
            disabled={loading || !metadataUri || activeWalletCount === 0 || !isMainnet}
            className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold"
          >
            <Rocket className="w-4 h-4 mr-2" />
            {loading ? "LAUNCHING..." : "LAUNCH TOKEN + BUNDLE"}
          </Button>

          <p className="text-xs text-neutral-500 text-center">
            creates token + {activeWalletCount} bundled buys via jito
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
