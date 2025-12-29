"use client"

import { memo } from "react"
import { Badge } from "@/components/ui/badge"

export interface BundlerWallet {
  publicKey: string
  secretKey: string
  solBalance: number
  tokenBalance: number
  isActive: boolean
  label?: string
  ataExists?: boolean
}

interface WalletRowProps {
  wallet: BundlerWallet
  isSelected: boolean
  onToggle: (publicKey: string) => void
}

export const WalletRow = memo(function WalletRow({ wallet, isSelected, onToggle }: WalletRowProps) {
  return (
    <div
      className={`p-2 rounded border text-[11px] flex items-center justify-between ${
        wallet.isActive ? "border-cyan-500/30 bg-cyan-500/5" : "border-neutral-700 bg-neutral-800"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <input
          type="checkbox"
          className="h-3 w-3 accent-cyan-500 disabled:opacity-50"
          checked={isSelected}
          onChange={() => onToggle(wallet.publicKey)}
          disabled={!wallet.isActive}
        />
        <div className="min-w-0">
          <div className="text-neutral-400 font-mono truncate">
            {wallet.publicKey.slice(0, 8)}...{wallet.publicKey.slice(-4)}
          </div>
          <div className="flex gap-2 text-[10px] text-slate-500">
            <span className="text-emerald-300/70">SOL: {wallet.solBalance.toFixed(3)}</span>
            <span className="text-cyan-300/70">Tokens: {wallet.tokenBalance.toFixed(2)}</span>
            <span className={wallet.ataExists ? "text-green-300/70" : "text-red-300/70"}>
              ATA: {wallet.ataExists ? "✓" : "✗"}
            </span>
          </div>
        </div>
      </div>
      <Badge className={wallet.isActive ? "bg-green-500/20 text-green-400" : "bg-neutral-600"}>
        {wallet.isActive ? "Active" : "Inactive"}
      </Badge>
    </div>
  )
})
