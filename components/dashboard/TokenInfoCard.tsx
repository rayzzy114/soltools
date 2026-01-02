"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface TokenInfoCardProps {
  selectedToken: any
  tokenFinanceLoading: boolean
  currentPriceSol: number | null
  marketCapSol: number | null
  totalSupplyValue: number | null
  tokenFinance: any
  holdersLoading: boolean
  holderCount: number
}

export function TokenInfoCard({
  selectedToken,
  tokenFinanceLoading,
  currentPriceSol,
  marketCapSol,
  totalSupplyValue,
  tokenFinance,
  holdersLoading,
  holderCount
}: TokenInfoCardProps) {
  return (
    <Card className="bg-neutral-900 border-neutral-700">
      <CardHeader className="py-1 px-2">
        <CardTitle className="text-xs font-medium text-white tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2">
          TOKEN INFO
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-2 pb-2">
        {!selectedToken ? (
          <div className="text-slate-400 text-xs">Select a token to view info</div>
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-2">
              <div className="space-y-2">
                <div className="text-[10px] text-slate-400 uppercase tracking-wider">Main</div>
                <div className="flex items-start gap-2">
                  <div className="h-16 w-16 shrink-0 rounded border border-neutral-700 bg-neutral-800 overflow-hidden flex items-center justify-center">
                    {selectedToken?.imageUrl ? (
                      <img src={selectedToken.imageUrl} alt="Token" className="h-full w-full object-cover" />
                    ) : (
                      <div className="text-[9px] text-neutral-400">No image</div>
                    )}
                  </div>
                  <div className="grid flex-1 grid-cols-[120px_1fr] gap-x-2 gap-y-1 text-[11px]">
                    <div className="text-slate-500">Name</div>
                    <div className="text-white">{selectedToken?.name || "-"}</div>
                    <div className="text-slate-500">Symbol</div>
                    <div className="text-white">{selectedToken?.symbol || "-"}</div>
                    <div className="text-slate-500">Mint / Token key</div>
                    <div className="text-white font-mono truncate">
                      {selectedToken?.mintAddress
                        ? `${selectedToken.mintAddress.slice(0, 6)}...${selectedToken.mintAddress.slice(-4)}`
                        : "-"}
                    </div>
                    <div className="text-slate-500">Dev key</div>
                    <div className="text-white font-mono truncate">
                      {selectedToken?.creatorWallet
                        ? `${selectedToken.creatorWallet.slice(0, 6)}...${selectedToken.creatorWallet.slice(-4)}`
                        : "-"}
                    </div>
                    <div className="text-slate-500">Pump.fun link</div>
                    <div className="text-white">
                      {selectedToken?.mintAddress ? (
                        <a
                          className="text-cyan-300 hover:text-cyan-200 underline"
                          href={`https://pump.fun/${selectedToken.mintAddress}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          pump.fun/{selectedToken.mintAddress.slice(0, 6)}...
                        </a>
                      ) : (
                        "-"
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] text-slate-500">Description</div>
                  <div className="rounded border border-neutral-800 bg-neutral-950/40 p-2 text-[10px] text-white/90 leading-snug">
                    {selectedToken?.description || "-"}
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-[10px] text-slate-400 uppercase tracking-wider">Finance</div>
                <div className="grid grid-cols-[150px_1fr] gap-x-2 gap-y-1 text-[11px]">
                  <div className="text-slate-500">Current price (SOL)</div>
                  <div className="text-white font-mono">
                    {tokenFinanceLoading
                      ? "..."
                      : currentPriceSol == null
                      ? "-"
                      : currentPriceSol.toFixed(6)}
                  </div>
                  <div className="text-slate-500">Market cap</div>
                  <div className="text-white font-mono">
                    {tokenFinanceLoading
                      ? "..."
                      : marketCapSol == null
                      ? "-"
                      : `${marketCapSol.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL`}
                  </div>
                  <div className="text-slate-500">Total supply</div>
                  <div className="text-white font-mono">
                    {tokenFinanceLoading
                      ? "..."
                      : totalSupplyValue == null
                      ? "-"
                      : totalSupplyValue.toLocaleString()}
                  </div>
                  <div className="text-slate-500">SOL reserves / Liquidity</div>
                  <div className="text-white font-mono">
                    {tokenFinanceLoading
                      ? "..."
                      : tokenFinance?.liquiditySol == null
                      ? "-"
                      : `${tokenFinance.liquiditySol.toFixed(4)} SOL`}
                  </div>
                  <div className="text-slate-500">Funding balance</div>
                  <div className="text-white font-mono">
                    {tokenFinanceLoading
                      ? "..."
                      : tokenFinance?.fundingBalanceSol == null
                      ? "-"
                      : `${tokenFinance.fundingBalanceSol.toFixed(4)} SOL`}
                  </div>
                  <div className="text-slate-500">Holders count</div>
                  <div className="text-white font-mono">
                    {holdersLoading ? "..." : holderCount.toLocaleString()}
                  </div>
                  <div className="text-slate-500">24h volume</div>
                  <div className="text-white font-mono">
                    {tokenFinanceLoading
                      ? "..."
                      : tokenFinance?.volumeSol != null
                      ? `${tokenFinance.volumeSol.toFixed(2)} SOL`
                      : tokenFinance?.volumeUsd != null
                      ? `$${tokenFinance.volumeUsd.toLocaleString()}`
                      : "-"}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
