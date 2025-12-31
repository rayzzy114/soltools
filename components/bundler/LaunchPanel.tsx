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
  const gapClass = dense ? "gap-4" : "gap-6"

  return (
    <div className={`grid grid-cols-1 lg:grid-cols-2 ${gapClass}`}>
      <Card className="bg-card border-border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-foreground">
            <Rocket className="w-4 h-4 text-purple-500" />
            Token Metadata
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input
                value={tokenName}
                onChange={(e) => onTokenNameChange(e.target.value)}
                placeholder="Token Name"
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Symbol</Label>
              <Input
                value={tokenSymbol}
                onChange={(e) => onTokenSymbolChange(e.target.value)}
                placeholder="SYMBOL"
                className="bg-background border-border"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Description</Label>
            <Textarea
              value={tokenDescription}
              onChange={(e) => onTokenDescriptionChange(e.target.value)}
              placeholder="Token description..."
              className="bg-background border-border resize-none"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Image</Label>
            <Input
              type="file"
              accept="image/*"
              onChange={(e) => onTokenImageChange(e.target.files?.[0] || null)}
              className="bg-background border-border"
            />
          </div>

          <Button
            onClick={onUploadMetadata}
            disabled={loading || !tokenImage || !tokenName || !tokenSymbol}
            className="w-full bg-cyan-600 hover:bg-cyan-700 text-white shadow-sm"
          >
            <Upload className="w-4 h-4 mr-2" />
            Upload to IPFS
          </Button>

          {metadataUri && (
            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-md text-xs">
              <span className="text-green-600 font-medium">Metadata URI:</span>
              <span className="text-foreground ml-2 font-mono break-all">{metadataUri}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border shadow-sm">
        <CardHeader className="pb-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-foreground">
              <DollarSign className="w-4 h-4 text-green-500" />
              Launch Settings
            </CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onApplyStaggerPreset("fast")}>
                Fast
              </Button>
              <Button variant="outline" size="sm" onClick={() => onApplyStaggerPreset("human")}>
                Human
              </Button>
              <Button variant="outline" size="sm" onClick={() => onApplyStaggerPreset("slow")}>
                Slow
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Dev Buy (SOL)</Label>
              <Input
                type="number"
                step="0.01"
                value={devBuyAmount}
                onChange={(e) => onDevBuyAmountChange(e.target.value)}
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Per Wallet (SOL)</Label>
              <Input
                type="number"
                step="0.001"
                value={buyAmountPerWallet}
                onChange={(e) => onBuyAmountPerWalletChange(e.target.value)}
                className="bg-background border-border"
              />
            </div>
          </div>

          <div className="p-4 bg-muted/50 rounded-md space-y-3 border border-border/50">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Active Wallets</span>
              <span className="text-foreground font-mono font-medium">{activeWalletCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Dev Buy</span>
              <span className="text-foreground font-mono font-medium">{devBuyAmount} SOL</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Bundled Buys</span>
              <span className="text-foreground font-mono font-medium">
                {Math.max(0, activeWalletCount - 1)} x {buyAmountPerWallet} SOL
              </span>
            </div>
            <div className="flex justify-between text-sm border-t border-border/50 pt-3 mt-2">
              <span className="text-muted-foreground font-medium">Estimated Total</span>
              <span className="text-green-600 font-mono font-bold text-base">
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
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-bold shadow-md"
          >
            <Rocket className="w-4 h-4 mr-2" />
            {loading ? "LAUNCHING..." : "LAUNCH TOKEN + BUNDLE"}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            creates token + {activeWalletCount} bundled buys via Jito
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
