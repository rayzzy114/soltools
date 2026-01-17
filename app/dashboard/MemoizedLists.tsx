
import { memo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Trash2 } from "lucide-react"

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

interface BuyerWalletSelection {
  publicKey: string
  amount: string
}

interface BuyerWalletListProps {
  buyerWallets: BuyerWalletSelection[]
  activeWallets: BundlerWallet[]
  launchDevWallet: string
  onUpdateWalletRole: (publicKey: string, role: string) => void
  onSetBuyerWallets: (updater: (prev: BuyerWalletSelection[]) => BuyerWalletSelection[]) => void
  onRemoveBuyerWallet: (index: number) => void
}

export const BuyerWalletList = memo(({
  buyerWallets,
  activeWallets,
  launchDevWallet,
  onUpdateWalletRole,
  onSetBuyerWallets,
  onRemoveBuyerWallet
}: BuyerWalletListProps) => {
  if (buyerWallets.length === 0) {
    return <div className="text-[10px] text-slate-500">No buyer wallets selected</div>
  }

  // Pre-calculate used keys for filtering
  const usedKeys = new Set(buyerWallets.map((entry) => entry.publicKey))

  return (
    <>
      {buyerWallets.map((wallet, index) => {
        // Filter options for this specific dropdown
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
                  onUpdateWalletRole(wallet.publicKey, 'project')
                  onUpdateWalletRole(value, 'buyer')
                  onSetBuyerWallets((prev) =>
                    prev.map((entry, idx) =>
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
                  const val = e.target.value
                  onSetBuyerWallets((prev) =>
                    prev.map((entry, idx) =>
                      idx === index ? { ...entry, amount: val } : entry
                    )
                  )
                }}
                className="h-8 bg-background border-border text-xs"
                aria-label={`Amount for wallet ${index + 1}`}
              />
            </div>
            <div className="col-span-1 flex justify-end">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onRemoveBuyerWallet(index)}
                className="h-8 w-8 text-red-400 hover:text-red-300"
                aria-label="Remove wallet"
                title="Remove wallet"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )
      })}
    </>
  )
})

BuyerWalletList.displayName = "BuyerWalletList"

interface DevWalletSelectProps {
  launchDevWallet: string
  devWalletOptions: BundlerWallet[]
  onSelect: (value: string) => void
  id?: string
}

export const DevWalletSelect = memo(({
  launchDevWallet,
  devWalletOptions,
  onSelect,
  id
}: DevWalletSelectProps) => {
  return (
    <Select
      value={launchDevWallet}
      onValueChange={onSelect}
    >
      <SelectTrigger id={id} className="h-8 bg-background border-border text-xs">
        <SelectValue placeholder="Pick dev wallet" />
      </SelectTrigger>
      <SelectContent>
        {devWalletOptions.map((wallet, index) => {
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
                <span className="text-neutral-800 font-medium">Balance: {wallet.solBalance.toFixed(4)} SOL</span>
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
  )
})

DevWalletSelect.displayName = "DevWalletSelect"
