"use client"

import { useEffect, useRef, useState } from "react"
import Script from "next/script"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

const flowChart = `
flowchart TD
  A[Upload metadata\\napp/api/tokens/upload-metadata\\nfetchWithRetry -> pump.fun/ipfs] --> B[Create token tx\\nlib/solana/pumpfun-sdk.buildCreateTokenTransaction]
  B --> C[Launch bundle\\nlib/solana/bundler-engine.createLaunchBundle]
  C --> D[Initial buys\\ncreateBuyInstruction]
  D --> E[Price/Stats API\\napp/api/tokens/price]
  E --> F[Volume bot\\nlib/solana/volume-bot-engine\\nexecuteBuy/executeSell]
  F --> G[Graduation check\\ngetBondingCurveData.complete]
  G -->|complete=false| H[Sell on bonding curve\\ncreateSellInstruction]
  G -->|complete=true| I[Sell on pumpswap\\nbuildPumpswapSwapTransaction]
  H --> J[Ragpull API\\napp/api/tokens/ragpull]
  I --> J
  J --> K[Profit to payout wallet]
`

const sequence = `
sequenceDiagram
  participant User
  participant Frontend
  participant API
  participant SDK as pumpfun-sdk
  participant Bundler as bundler-engine
  participant Volume as volume-bot-engine

  User->>Frontend: Upload image + metadata
  Frontend->>API: POST /api/tokens/upload-metadata
  API->>pump.fun: POST /api/ipfs (with retries)
  pump.fun-->>API: metadataUri
  API-->>Frontend: metadataUri

  User->>Frontend: Create token
  Frontend->>API: POST /api/tokens (name,symbol,metadataUri,mintKeypair)
  API->>SDK: buildCreateTokenTransaction
  API-->>Frontend: unsigned tx (base58)
  User->>Frontend: Sign & send tx
  Frontend->>Bundler: POST /api/bundler/launch (wallets,buy amounts)
  Bundler->>SDK: createCreateTokenInstruction + createBuyInstruction
  Bundler-->>Frontend: bundleId, signatures

  loop Trading
    User->>Volume: POST /api/volume-bot/execute (buy/sell)
    Volume->>SDK: buildBuyTransaction / buildPumpswapSwapTransaction
    SDK-->>Volume: signed tx
    Volume-->>User: signature
  end

  User->>API: GET /api/tokens/price (UI polling)
  API->>SDK: getBondingCurveData + calculateTokenPrice
  SDK-->>API: price, migrated?
  API-->>User: price payload (cached)

  alt Token migrated
    User->>API: POST /api/tokens/ragpull (slippage)
    API->>SDK: buildPumpswapSwapTransaction
  else Not migrated
    User->>API: POST /api/tokens/ragpull
    API->>SDK: buildSellTransaction
  end
  SDK-->>API: tx, estimates
  API-->>User: tx for signature, summary
`

function Mermaid({ chart, id }: { chart: string; id: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const render = async () => {
      // @ts-expect-error mermaid is injected via script tag
      const mermaid = window.mermaid
      if (!mermaid || !ref.current) return
      await mermaid.run({
        nodes: [ref.current],
      })
    }
    render()
  }, [chart])

  return (
    <div
      className="mermaid text-sm bg-neutral-900/80 p-4 rounded-lg border border-neutral-800 overflow-x-auto"
      id={id}
      ref={ref}
    >
      {chart}
    </div>
  )
}

export default function PipelinePage() {
  const [networkStatus, setNetworkStatus] = useState<any>(null)
  const [running, setRunning] = useState<"smoke" | "health" | null>(null)

  useEffect(() => {
    fetch("/api/network")
      .then((r) => r.json())
      .then(setNetworkStatus)
      .catch(() => {})
  }, [])

  const runCheck = async (type: "smoke" | "health") => {
    setRunning(type)
    try {
      if (type === "smoke") {
        const res = await fetch("/api/tests?action=run&suite=smoke")
        const data = await res.json()
        if (res.ok) toast.success(`smoke tests ok (${data.durationMs}ms)`)
        else toast.error(data.error || "smoke failed")
      } else {
        const res = await fetch("/api/network")
        const data = await res.json()
        setNetworkStatus(data)
        if (res.ok) toast.success("health refreshed")
        else toast.error(data.error || "health failed")
      }
    } catch (e: any) {
      toast.error(e?.message || "failed to run")
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="p-6 space-y-6 text-white">
      <Script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" strategy="beforeInteractive" />
      <Script
        id="mermaid-init"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            if (window.mermaid) {
              window.mermaid.initialize({ startOnLoad: false, theme: 'dark' });
            }
          `,
        }}
      />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-wider">pump.fun pipeline</h1>
          <p className="text-neutral-400 text-sm">end-to-end визуализация: metadata → launch → volume → ragpull</p>
        </div>
        <div className="flex gap-2">
          <Badge className="bg-pink-600/20 text-pink-300 border border-pink-500/30">mainnet-beta only</Badge>
          <Badge className="bg-cyan-500/20 text-cyan-200 border border-cyan-500/30">pumpswap aware</Badge>
        </div>
      </div>

      <Card className="bg-neutral-950 border-neutral-800">
        <CardHeader>
          <CardTitle className="text-lg text-neutral-100">health & quick actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 items-center">
          <Button
            onClick={() => runCheck("smoke")}
            disabled={running !== null}
            className="bg-cyan-500 text-black"
          >
            {running === "smoke" ? "Running smoke..." : "Run smoke tests"}
          </Button>
          <Button
            onClick={() => runCheck("health")}
            disabled={running !== null}
            variant="outline"
            className="border-neutral-700 text-neutral-100"
          >
            {running === "health" ? "Refreshing..." : "Refresh health"}
          </Button>
          {networkStatus && (
            <div className="text-sm text-neutral-300 space-y-1">
              <div>Network: {networkStatus.network}</div>
              <div>RPC: {networkStatus.rpc}</div>
              <div>Healthy: {String(networkStatus.rpcHealthy)}</div>
              <div>pump.fun available: {String(networkStatus.pumpFunAvailable)}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-neutral-950 border-neutral-800">
        <CardHeader>
          <CardTitle className="text-lg text-neutral-100">поток: функции и api</CardTitle>
        </CardHeader>
        <CardContent>
          <Mermaid chart={flowChart} id="pipeline-flow" />
        </CardContent>
      </Card>

      <Card className="bg-neutral-950 border-neutral-800">
        <CardHeader>
          <CardTitle className="text-lg text-neutral-100">последовательность действий</CardTitle>
        </CardHeader>
        <CardContent>
          <Mermaid chart={sequence} id="pipeline-seq" />
        </CardContent>
      </Card>

      <Card className="bg-neutral-950 border-neutral-800">
        <CardHeader>
          <CardTitle className="text-lg text-neutral-100">ключевые точки принятия решений</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-neutral-200">
          <ul className="list-disc pl-5 space-y-2">
            <li><span className="text-pink-400">metadata upload</span>: `uploadMetadataToPumpFun` через fetchWithRetry, проверка размера/типа файла.</li>
            <li><span className="text-pink-400">launch</span>: `buildCreateTokenTransaction` + `createLaunchBundle` (dev buy + bundled buys).</li>
            <li><span className="text-pink-400">volume</span>: `executeBuy`/`executeSell` в volume-bot-engine; при graduation — `buildPumpswapSwapTransaction`.</li>
            <li><span className="text-pink-400">pricing</span>: `/api/tokens/price` кеширует ответы, использует `getBondingCurveData`.</li>
            <li><span className="text-pink-400">ragpull</span>: до migration — sell на curve, после — pumpswap; все токены, высокий slippage.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

