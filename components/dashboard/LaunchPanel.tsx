"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Upload, Rocket, Trash2 } from "lucide-react"
import { BundlerWallet } from "@/types/dashboard"
import { Alert, AlertDescription } from "@/components/ui/alert"

interface LaunchPanelProps {
  tokenName: string
  setTokenName: (value: string) => void
  tokenSymbol: string
  setTokenSymbol: (value: string) => void
  tokenDescription: string
  setTokenDescription: (value: string) => void
  tokenWebsite: string
  setTokenWebsite: (value: string) => void
  tokenTwitter: string
  setTokenTwitter: (value: string) => void
  tokenTelegram: string
  setTokenTelegram: (value: string) => void
  tokenImage: File | null
  tokenImagePreview: string
  handleTokenImageChange: (file: File | null) => void
  handleImageUpload: () => void
  launchLoading: boolean
  metadataUri: string
  launchTemplateMint: string
  setCloneTokenMint: (value: string) => void
  setCloneDialogOpen: (value: boolean) => void
  resetLaunchForm: () => void
  cloneLoading: boolean
  launchDevWallet: string
  setLaunchDevWallet: (value: string) => void
  buyerWallets: any[]
  setBuyerWallets: (wallets: any[]) => void
  activeWallets: BundlerWallet[]
  totalBuyAmount: string
  setTotalBuyAmount: (value: string) => void
  handleAddBuyerWallet: () => void
  handleRemoveBuyerWallet: (index?: number) => void
  handleEqualBuy: () => void
  handleRandomBuy: () => void
  autoFundEnabled: boolean
  setAutoFundEnabled: (value: boolean) => void
  autoCreateAtaEnabled: boolean
  setAutoCreateAtaEnabled: (value: boolean) => void
  useConnectedFunder: boolean
  setUseConnectedFunder: (value: boolean) => void
  funderAmountPerWallet: string
  setFunderAmountPerWallet: (value: string) => void
  funderKey: string
  setFunderKey: (value: string) => void
  generateFunderWallet: () => void
  topUpFunder: () => void
  devBuyAmount: string
  setDevBuyAmount: (value: string) => void
  buyAmountPerWallet: string
  setBuyAmountPerWallet: (value: string) => void
  jitoTipSol: string
  priorityFeeSol: string
  handleLaunch: () => void
  networkBlocked: boolean
  isMainnet: boolean
  connectedWalletKey: string
  updateWalletRole: (pubkey: string, role: string) => void
  parseSol: (val: string) => number
  devWalletOptions: BundlerWallet[]
}

export function LaunchPanel(props: LaunchPanelProps) {
  const {
    tokenName, setTokenName,
    tokenSymbol, setTokenSymbol,
    tokenDescription, setTokenDescription,
    tokenWebsite, setTokenWebsite,
    tokenTwitter, setTokenTwitter,
    tokenTelegram, setTokenTelegram,
    tokenImage, tokenImagePreview, handleTokenImageChange,
    handleImageUpload, launchLoading, metadataUri,
    launchTemplateMint, setCloneTokenMint, setCloneDialogOpen, resetLaunchForm, cloneLoading,
    launchDevWallet, setLaunchDevWallet,
    buyerWallets, setBuyerWallets, activeWallets,
    totalBuyAmount, setTotalBuyAmount, handleAddBuyerWallet, handleRemoveBuyerWallet, handleEqualBuy, handleRandomBuy,
    autoFundEnabled, setAutoFundEnabled, autoCreateAtaEnabled, setAutoCreateAtaEnabled,
    useConnectedFunder, setUseConnectedFunder, funderAmountPerWallet, setFunderAmountPerWallet,
    funderKey, setFunderKey, generateFunderWallet, topUpFunder,
    devBuyAmount, setDevBuyAmount, buyAmountPerWallet, setBuyAmountPerWallet,
    jitoTipSol, priorityFeeSol, handleLaunch, networkBlocked, isMainnet,
    connectedWalletKey, updateWalletRole, parseSol, devWalletOptions
  } = props

  return (
    <div className="xl:col-span-12 space-y-1">
      {/* 1. SELECT TOKEN */}
      <Card className="bg-neutral-900 border-cyan-500/30">
        <CardHeader className="py-1 px-2">
          <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
              1
            </span>
            SELECT TOKEN TO LAUNCH
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-2 pb-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-black">Prefill</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCloneTokenMint(launchTemplateMint)
                  setCloneDialogOpen(true)
                }}
                className="h-8 px-2 text-[10px] border-neutral-700"
              >
                Clone from existing
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={resetLaunchForm}
                className="h-8 px-2 text-[10px] text-neutral-400 hover:text-white"
              >
                New
              </Button>
              <span className="text-[10px] text-slate-500">
                {launchTemplateMint
                  ? `Template: ${launchTemplateMint.slice(0, 6)}...${launchTemplateMint.slice(-4)}`
                  : "No template selected"}
              </span>
            </div>
            {cloneLoading && (
              <div className="text-[10px] text-slate-500">Loading metadata...</div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Name</Label>
              <Input
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder="Token Name"
                className="h-8 bg-background border-border text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Symbol</Label>
              <Input
                value={tokenSymbol}
                onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
                placeholder="SYMBOL"
                maxLength={10}
                className="h-8 bg-background border-border text-xs"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[10px] text-black">Description</Label>
            <Textarea
              value={tokenDescription}
              onChange={(e) => setTokenDescription(e.target.value)}
              placeholder="Token description..."
              className="min-h-[48px] bg-background border-border text-xs"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Website</Label>
              <Input
                value={tokenWebsite}
                onChange={(e) => setTokenWebsite(e.target.value)}
                placeholder="https://example.com"
                className="h-8 bg-background border-border text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Twitter</Label>
              <Input
                value={tokenTwitter}
                onChange={(e) => setTokenTwitter(e.target.value)}
                placeholder="https://x.com/..."
                className="h-8 bg-background border-border text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Telegram</Label>
              <Input
                value={tokenTelegram}
                onChange={(e) => setTokenTelegram(e.target.value)}
                placeholder="https://t.me/..."
                className="h-8 bg-background border-border text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-start">
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Image</Label>
              <Input
                type="file"
                accept="image/*"
                onChange={(e) => handleTokenImageChange(e.target.files?.[0] || null)}
                className="h-8 bg-background border-border text-xs"
              />
            </div>
            <div className="rounded border border-neutral-800 bg-neutral-950/40 p-2">
              <div className="flex items-center gap-2">
                <div className="h-10 w-10 overflow-hidden rounded bg-neutral-800">
                  {tokenImagePreview ? (
                    <img src={tokenImagePreview} alt="token preview" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[9px] text-neutral-500">
                      No image
                    </div>
                  )}
                </div>
                <div className="text-[10px] text-neutral-400 space-y-0.5">
                  <div>Name: <span className="text-white">{tokenName || "-"}</span></div>
                  <div>Symbol: <span className="text-white">{tokenSymbol || "-"}</span></div>
                  <div>Website: <span className="text-white">{tokenWebsite || "-"}</span></div>
                  <div>Telegram: <span className="text-white">{tokenTelegram || "-"}</span></div>
                  <div>Twitter: <span className="text-white">{tokenTwitter || "-"}</span></div>
                  <div>Template: <span className="text-white">{launchTemplateMint ? `${launchTemplateMint.slice(0, 6)}...${launchTemplateMint.slice(-4)}` : "-"}</span></div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={handleImageUpload}
              disabled={launchLoading || !tokenImage || !tokenName || !tokenSymbol}
              className="h-8 bg-cyan-500 hover:bg-cyan-600 text-xs text-black"
            >
              <Upload className="w-3 h-3 mr-2" />
              Upload to IPFS
            </Button>
            {metadataUri && (
              <div className="rounded border border-green-500/30 bg-green-500/10 px-2 py-1 text-[9px] text-green-300">
                Metadata: <span className="font-mono break-all">{metadataUri}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 2. SELECT DEV WALLET */}
      <Card className="bg-neutral-900 border-cyan-500/30">
        <CardHeader className="py-1 px-2">
          <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
              2
            </span>
            SELECT DEV WALLET
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-2 pb-2">
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label className="text-[10px] text-black">Dev address</Label>
              <Button
                size="sm"
                variant="outline"
                className="h-5 px-2 text-[9px] border-blue-500/50 text-blue-400 hover:bg-blue-500/10"
                onClick={() => {
                  if (connectedWalletKey) {
                    if (launchDevWallet) updateWalletRole(launchDevWallet, 'project')
                    updateWalletRole(connectedWalletKey, 'dev')
                    setLaunchDevWallet(connectedWalletKey)
                    // remove dev from buyer list if present
                    setBuyerWallets(buyerWallets.filter((w: any) => w.publicKey !== connectedWalletKey))
                  }
                }}
              >
                Use Connected
              </Button>
            </div>
            <Select
              value={launchDevWallet}
              onValueChange={(value) => {
                if (launchDevWallet) {
                  updateWalletRole(launchDevWallet, 'project')
                }
                updateWalletRole(value, 'dev')
                setLaunchDevWallet(value)
                setBuyerWallets(buyerWallets.filter((w: any) => w.publicKey !== value))
              }}
            >
              <SelectTrigger className="h-8 bg-background border-border text-xs">
                <SelectValue placeholder="Pick dev wallet" />
              </SelectTrigger>
              <SelectContent>
                {devWalletOptions.map((wallet: BundlerWallet, index: number) => {
                  const isConnectedWallet = connectedWalletKey.length > 0 && wallet.publicKey === connectedWalletKey
                  const labelPrefix = isConnectedWallet ? "Connected" : "Balance"
                  let roleColor = "text-slate-400"
                  let roleLabel = ""
                  if (wallet.role === 'dev') { roleColor = "text-purple-400"; roleLabel = "DEV" }
                  else if (wallet.role === 'buyer') { roleColor = "text-cyan-400"; roleLabel = "BUYER" }
                  else if (wallet.role === 'funder') { roleColor = "text-green-400"; roleLabel = "FUNDER" }
                  else if (wallet.role === 'volume_bot') { roleColor = "text-orange-400"; roleLabel = "BOT" }
                  else if (wallet.role && wallet.role !== 'project') { roleLabel = wallet.role.toUpperCase() }

                  return (
                    <SelectItem key={wallet.publicKey} value={wallet.publicKey}>
                      <div className="flex items-center gap-2">
                        <span className="text-neutral-600 font-bold font-mono text-[10px]">#{index + 1}</span>
                        <span className="text-neutral-800 font-medium">{labelPrefix}: {wallet.solBalance.toFixed(4)} SOL</span>
                        <span className="text-neutral-400">-</span>
                        <span className="font-mono text-neutral-900 font-semibold">{wallet.publicKey.slice(0, 6)}...{wallet.publicKey.slice(-4)}</span>
                        {roleLabel && (
                          <span className={`text-[9px] font-bold ${roleColor} border border-current px-1 rounded`}>
                            {roleLabel}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="text-[10px] text-slate-500">
            {launchDevWallet
              ? `Selected: ${launchDevWallet.slice(0, 8)}...${launchDevWallet.slice(-4)}`
              : "No dev wallet selected"}
          </div>
        </CardContent>
      </Card>

      {/* 3. ADD BUYER WALLETS */}
      <Card className="bg-neutral-900 border-cyan-500/30">
        <CardHeader className="py-1 px-2">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2">
              <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
                3
              </span>
              ADD BUYER WALLETS
            </CardTitle>
            <div className="text-[10px] text-slate-500">
              {buyerWallets.length} buyers
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 px-2 pb-2">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Total buy amount (SOL)</Label>
              <Input
                type="number"
                step="0.0001"
                value={totalBuyAmount}
                onChange={(e) => setTotalBuyAmount(e.target.value)}
                className="h-8 bg-background border-border text-xs"
              />
            </div>
            <div className="flex flex-wrap gap-2 md:col-span-2 md:items-end">
              <Button
                size="sm"
                onClick={handleAddBuyerWallet}
                className="h-8 px-2 text-[10px] bg-blue-600 hover:bg-blue-700"
              >
                Add wallet
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleRemoveBuyerWallet()}
                className="h-8 px-2 text-[10px] border-neutral-700"
              >
                Delete wallet
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleEqualBuy}
                className="h-8 px-2 text-[10px] border-neutral-700"
              >
                Equal buy
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRandomBuy}
                className="h-8 px-2 text-[10px] border-neutral-700"
              >
                Random buy
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            {buyerWallets.length === 0 ? (
              <div className="text-[10px] text-slate-500">No buyer wallets selected</div>
            ) : (
              buyerWallets.map((wallet: any, index: number) => {
                const usedKeys = new Set(buyerWallets.map((entry: any) => entry.publicKey))
                const options = activeWallets.filter((option) => {
                  if (option.publicKey === launchDevWallet) return false
                  if (option.publicKey === wallet.publicKey) return true
                  return !usedKeys.has(option.publicKey)
                })
                return (
                  <div key={`${wallet.publicKey}-${index}`} className="grid grid-cols-12 gap-2 items-center rounded border border-neutral-800 bg-neutral-950/40 p-2">
                    <div className="col-span-1 text-[10px] text-slate-400">{index + 1}</div>
                    <div className="col-span-7">
                      <Select
                        value={wallet.publicKey}
                        onValueChange={(value) => {
                          updateWalletRole(wallet.publicKey, 'project')
                          updateWalletRole(value, 'buyer')
                          setBuyerWallets(
                            buyerWallets.map((entry: any, idx: number) =>
                              idx === index ? { ...entry, publicKey: value } : entry
                            )
                          )
                        }}
                      >
                        <SelectTrigger className="h-8 bg-background border-border text-xs">
                          <SelectValue placeholder="Select wallet" />
                        </SelectTrigger>
                        <SelectContent>
                          {options.map((option) => {
                            const roleSuffix = option.role && option.role !== 'project' ? ` [${option.role.toUpperCase()}]` : ""
                            return (
                              <SelectItem key={option.publicKey} value={option.publicKey}>
                                {option.label ? `${option.label} - ` : ""}
                                {option.publicKey.slice(0, 6)}...{option.publicKey.slice(-4)} ({option.solBalance.toFixed(3)} SOL){roleSuffix}
                              </SelectItem>
                            )
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-3">
                      <Input
                        type="number"
                        step="0.0001"
                        value={wallet.amount}
                        onChange={(e) => {
                          setBuyerWallets(
                            buyerWallets.map((entry: any, idx: number) =>
                              idx === index ? { ...entry, amount: e.target.value } : entry
                            )
                          )
                        }}
                        className="h-8 bg-background border-border text-xs"
                      />
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleRemoveBuyerWallet(index)}
                        className="h-8 w-8 text-red-400 hover:text-red-300"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </CardContent>
      </Card>

      {/* 4. AUTO FUNDING + ATA */}
      <Card className="bg-neutral-900 border-cyan-500/30">
        <CardHeader className="py-1 px-2">
          <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
              4
            </span>
            AUTO FUNDING + ATA
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-2 pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/40 px-2 py-1 text-[10px] text-slate-400">
              <span>Auto fund</span>
              <Switch checked={autoFundEnabled} onCheckedChange={setAutoFundEnabled} />
            </div>
            <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/40 px-2 py-1 text-[10px] text-slate-400">
              <span>Auto ATA</span>
              <Switch checked={autoCreateAtaEnabled} onCheckedChange={setAutoCreateAtaEnabled} />
            </div>
            <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/40 px-2 py-1 text-[10px] text-slate-400">
              <span>Use connected funder</span>
              <Switch checked={useConnectedFunder} onCheckedChange={setUseConnectedFunder} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Amount per wallet (SOL)</Label>
              <Input
                type="number"
                step="0.0001"
                value={funderAmountPerWallet}
                onChange={(e) => setFunderAmountPerWallet(e.target.value)}
                className="h-8 bg-background border-border text-xs"
                disabled={!autoFundEnabled}
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label className="text-[10px] text-black">Funder private key</Label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder="funder wallet private key"
                  value={funderKey}
                  onChange={(e) => setFunderKey(e.target.value)}
                  className="h-8 bg-background border-border text-xs"
                  disabled={!autoFundEnabled || useConnectedFunder}
                />
                {!useConnectedFunder && (
                  <>
                    <Button onClick={generateFunderWallet} size="sm" variant="outline" className="h-8 px-2 text-[10px] border-neutral-700">
                      Gen
                    </Button>
                    <Button onClick={topUpFunder} size="sm" variant="outline" className="h-8 px-2 text-[10px] border-neutral-700 bg-green-900/20 text-green-400">
                      TopUp
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="text-[10px] text-slate-500">
            Auto-fund runs before launch. Auto-ATA runs after mint is created.
            {useConnectedFunder ? " Uses connected wallet for funding." : ""}
          </div>
        </CardContent>
      </Card>

      {/* 5. LAUNCH SETTINGS */}
      <Card className="bg-neutral-900 border-cyan-500/30">
        <CardHeader className="py-1 px-2">
          <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-cyan-500/20 text-[9px] text-cyan-300">
              5
            </span>
            LAUNCH SETTINGS
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-2 pb-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Dev buy (SOL)</Label>
              <Input
                type="number"
                step="0.001"
                value={devBuyAmount}
                onChange={(e) => setDevBuyAmount(e.target.value)}
                className="h-8 bg-background border-border text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-black">Default buyer (SOL)</Label>
              <Input
                type="number"
                step="0.001"
                value={buyAmountPerWallet}
                onChange={(e) => setBuyAmountPerWallet(e.target.value)}
                className="h-8 bg-background border-border text-xs"
              />
            </div>
          </div>

          <div className="rounded bg-neutral-800 p-2 text-[11px]">
            <div className="flex justify-between">
              <span className="text-neutral-400">Wallets</span>
              <span className="text-white font-mono">{(launchDevWallet ? 1 : 0) + buyerWallets.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Dev buy</span>
              <span className="text-white font-mono">{parseSol(devBuyAmount).toFixed(4)} SOL</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Buyer total</span>
              <span className="text-cyan-300 font-mono">
                {buyerWallets.reduce((sum: number, wallet: any) => sum + parseSol(wallet.amount), 0).toFixed(4)} SOL
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Jito tip</span>
              <span className="text-white font-mono">{parseSol(jitoTipSol).toFixed(6)} SOL</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Priority fee</span>
              <span className="text-white font-mono">{parseSol(priorityFeeSol).toFixed(6)} SOL</span>
            </div>
            <div className="flex justify-between border-t border-neutral-700 pt-1">
              <span className="text-neutral-400">Estimated total</span>
              <span className="text-green-400 font-mono">
                {(
                  parseSol(devBuyAmount) +
                  buyerWallets.reduce((sum: number, wallet: any) => sum + parseSol(wallet.amount), 0) +
                  parseSol(jitoTipSol) +
                  ((launchDevWallet ? 1 : 0) + buyerWallets.length) * parseSol(priorityFeeSol)
                ).toFixed(4)} SOL
              </span>
            </div>
          </div>

          {networkBlocked && (
            <Alert className="bg-red-950/30 border-red-500/30 text-red-200">
              <AlertDescription className="text-[10px]">
                pump.fun unavailable or rpc unhealthy
              </AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleLaunch}
            disabled={launchLoading || !metadataUri || !launchDevWallet || buyerWallets.length === 0 || !isMainnet || networkBlocked}
            className="h-8 w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-xs text-white font-bold"
          >
            <Rocket className="w-3 h-3 mr-2" />
            {launchLoading ? "LAUNCHING..." : "LAUNCH TOKEN + BUNDLE"}
          </Button>
          <p className="text-[10px] text-neutral-500 text-center">
            creates token + {buyerWallets.length} bundled buys via jito
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
