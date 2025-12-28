import { NextRequest, NextResponse } from "next/server"
import { Connection, PublicKey } from "@solana/web3.js"

const emitDebugLog = (_payload: {
  hypothesisId: string
  location: string
  message: string
  data?: Record<string, unknown>
}) => {
  // no-op (debug instrumentation removed)
}

const PUMP_SOURCES = [
  {
    name: "latest",
    url: "https://frontend-api.pump.fun/coins/latest?offset=0&limit=200",
  },
  {
    name: "trending-24h",
    url: "https://frontend-api.pump.fun/coins/trending?timeframe=24h&offset=0&limit=200",
  },
  {
    name: "latest-client",
    url: "https://client-api.pump.fun/coins/latest?offset=0&limit=200",
  },
  {
    name: "trending-client-24h",
    url: "https://client-api.pump.fun/coins/trending?timeframe=24h&offset=0&limit=200",
  },
  {
    name: "latest-explorer",
    url: "https://explorer-api.pump.fun/coins/latest?offset=0&limit=200",
  },
  {
    name: "trending-explorer-24h",
    url: "https://explorer-api.pump.fun/coins/trending?timeframe=24h&offset=0&limit=200",
  },
  {
    name: "pumpportal-latest",
    url: "https://pumpportal.fun/api/coins/latest?offset=0&limit=200",
  },
  {
    name: "pumpportal-trending-24h",
    url: "https://pumpportal.fun/api/coins/trending?timeframe=24h&offset=0&limit=200",
  },
]

const HEADERS = {
  "user-agent": "panel-debug/1.0",
  accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
  referer: "https://pump.fun",
  origin: "https://pump.fun",
}

const buildProxyUrls = (url: string) => [
  url,
  `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`,
  `https://r.jina.ai/https://${url.replace(/^https?:\/\//, "")}`,
  `https://cors.isomorphic-git.org/${url}`,
]

const MAINNET_RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com"
const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")

async function fetchJsonWithFallback(name: string, url: string) {
  const variants = buildProxyUrls(url)
  let lastError: string | undefined

  for (const variant of variants) {
    emitDebugLog({
      hypothesisId: "H12",
      location: "app/api/clone/pump-scan/route.ts:fetchJsonWithFallback",
      message: "variant attempt",
      data: { name, variant },
    })

    try {
      const res = await fetch(variant, { cache: "no-store", headers: HEADERS })
      if (!res.ok) {
        lastError = `${variant} status ${res.status}`
        emitDebugLog({
          hypothesisId: "H12",
          location: "app/api/clone/pump-scan/route.ts:fetchJsonWithFallback",
          message: "variant not ok",
          data: { name, variant, status: res.status },
        })
        continue
      }
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        const first = text.indexOf("{")
        const last = text.lastIndexOf("}")
        if (first >= 0 && last > first) {
          const sliced = text.slice(first, last + 1)
          return JSON.parse(sliced)
        }
        lastError = "json parse failed"
        emitDebugLog({
          hypothesisId: "H12",
          location: "app/api/clone/pump-scan/route.ts:fetchJsonWithFallback",
          message: "parse failed",
          data: { name, variant, snippet: text.slice(0, 120) },
        })
      }
    } catch (error: any) {
      lastError = error?.message || String(error)
      emitDebugLog({
        hypothesisId: "H12",
        location: "app/api/clone/pump-scan/route.ts:fetchJsonWithFallback",
        message: "fetch error",
        data: { name, variant, error: error?.message || String(error) },
      })
      continue
    }
  }

  throw new Error(lastError || "fetch failed")
}

async function fetchRecentPumpfunMints(limit: number): Promise<string[]> {
  const connection = new Connection(MAINNET_RPC, "confirmed")
  const mints: string[] = []
  try {
    const signatures = await connection.getSignaturesForAddress(PUMPFUN_PROGRAM_ID, {
      limit: Math.min(limit * 3, 100),
    })
    for (const sig of signatures) {
      if (mints.length >= limit) break
      emitDebugLog({
        hypothesisId: "H13",
        location: "app/api/clone/pump-scan/route.ts:fetchRecentPumpfunMints",
        message: "tx fetch attempt",
        data: { signature: sig.signature },
      })
      try {
        const tx = await connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        })
        if (!tx?.transaction) continue
        const keys = tx.transaction.message.accountKeys
        const programIndex = keys.findIndex((k) => k.equals(PUMPFUN_PROGRAM_ID))
        if (programIndex === -1) continue
        for (const ix of tx.transaction.message.instructions) {
          if (ix.programIdIndex === programIndex && ix.accounts.length > 1) {
            const mint = keys[ix.accounts[1]].toBase58()
            if (!mints.includes(mint)) {
              mints.push(mint)
              emitDebugLog({
                hypothesisId: "H13",
                location: "app/api/clone/pump-scan/route.ts:fetchRecentPumpfunMints",
                message: "mint extracted",
                data: { signature: sig.signature, mint },
              })
            }
          }
          if (mints.length >= limit) break
        }
      } catch (error: any) {
        emitDebugLog({
          hypothesisId: "H13",
          location: "app/api/clone/pump-scan/route.ts:fetchRecentPumpfunMints",
          message: "tx fetch error",
          data: { signature: sig.signature, error: error?.message || String(error) },
        })
        continue
      }
    }
  } catch (error: any) {
    emitDebugLog({
      hypothesisId: "H13",
      location: "app/api/clone/pump-scan/route.ts:fetchRecentPumpfunMints",
      message: "signature fetch error",
      data: { error: error?.message || String(error) },
    })
  }
  return mints
}

const pick = (obj: any, keys: string[]) => {
  for (const key of keys) {
    if (obj?.[key]) return obj[key]
  }
  return null
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const limit = Math.max(1, Math.min(50, Number(searchParams.get("limit")) || 10))
  const maxMetaFetch = Math.max(1, Math.min(80, Number(searchParams.get("metaLimit")) || 40))
  const useOnChain = searchParams.get("onchain") === "true"

  const attempts: Array<{ source: string; status?: number; error?: string }> = []
  const items: Array<any> = []
  const clones: Array<any> = []

  for (const source of PUMP_SOURCES) {
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/pump-scan/route.ts:GET",
      message: "pump source fetch",
      data: { source: source.name, url: source.url },
    })

    try {
      const json = await fetchJsonWithFallback(source.name, source.url).catch((err: any) => {
        attempts.push({ source: source.name, error: err?.message || String(err) })
        emitDebugLog({
          hypothesisId: "H8",
          location: "app/api/clone/pump-scan/route.ts:GET",
          message: "pump source failed",
          data: { source: source.name, error: err?.message || String(err) },
        })
        return null
      })
      if (!json) continue

      const list = Array.isArray(json) ? json : Array.isArray(json?.coins) ? json.coins : []
      emitDebugLog({
        hypothesisId: "H8",
        location: "app/api/clone/pump-scan/route.ts:GET",
        message: "pump source parsed",
        data: { source: source.name, count: list.length },
      })

      for (const entry of list) {
        const mint =
          pick(entry, ["mint", "address", "mintAddress", "tokenMint"]) ||
          (entry?.bondingCurve && typeof entry.bondingCurve === "string"
            ? entry.bondingCurve.split("-").pop()
            : null)

        if (!mint) continue
        if (items.find((i) => i.mint === mint)) continue

        const name = pick(entry, ["name", "tokenName"])
        const symbol = pick(entry, ["symbol", "tokenSymbol"])
        const metadataUri = pick(entry, ["metadata_uri", "metadataUri", "metadataUrl", "metadata"])
        const image = pick(entry, ["image_uri", "image", "imageUri", "logoURI"])

        items.push({
          source: source.name,
          mint,
          name: name || "",
          symbol: symbol || "",
          metadataUri: metadataUri || "",
          image: image || "",
        })

        if (items.length >= maxMetaFetch) break
      }

      if (items.length >= maxMetaFetch) break
    } catch (error: any) {
      attempts.push({ source: source.name, error: error?.message || String(error) })
      emitDebugLog({
        hypothesisId: "H8",
        location: "app/api/clone/pump-scan/route.ts:GET",
        message: "pump source error",
        data: { source: source.name, error: error?.message || String(error) },
      })
      continue
    }
  }

  emitDebugLog({
    hypothesisId: "H11",
    location: "app/api/clone/pump-scan/route.ts:GET",
    message: "pump source aggregate done",
    data: { collected: items.length, attempts, useOnChain },
  })

  if (useOnChain && items.length < maxMetaFetch) {
    const need = maxMetaFetch - items.length
    const onChainMints = await fetchRecentPumpfunMints(need)
    emitDebugLog({
      hypothesisId: "H13",
      location: "app/api/clone/pump-scan/route.ts:GET",
      message: "on-chain mints fetched",
      data: { count: onChainMints.length },
    })
    for (const mint of onChainMints) {
      if (items.find((i) => i.mint === mint)) continue
      items.push({
        source: "onchain",
        mint,
        name: "",
        symbol: "",
        metadataUri: "",
        image: "",
      })
    }
  }

  const origin = new URL(request.url).origin
  const metaResults: Array<any> = []
  for (const item of items.slice(0, maxMetaFetch)) {
    if (!item.metadataUri) continue
    try {
      const res = await fetch(item.metadataUri, { cache: "no-store", headers: { accept: "application/json" } })
      const ok = res.ok
      const status = res.status
      let meta: any = null
      if (ok) {
        meta = await res.json().catch(() => null)
      }
      metaResults.push({ mint: item.mint, status, ok })
      emitDebugLog({
        hypothesisId: "H9",
        location: "app/api/clone/pump-scan/route.ts:GET",
        message: "metadata fetch",
        data: { mint: item.mint, status, ok },
      })

      if (clones.length < limit) {
        try {
          const cloneUrl = `${origin}/api/clone?mint=${item.mint}`
          const cloneRes = await fetch(cloneUrl, { cache: "no-store" })
          const body = await cloneRes.json().catch(() => ({}))
          clones.push({
            mint: item.mint,
            status: cloneRes.status,
            ok: cloneRes.ok,
            error: body?.error,
            source: item.source,
          })
          emitDebugLog({
            hypothesisId: "H10",
            location: "app/api/clone/pump-scan/route.ts:GET",
            message: "clone attempt from pump-scan",
            data: { mint: item.mint, status: cloneRes.status, ok: cloneRes.ok, error: body?.error },
          })
        } catch (error: any) {
          clones.push({
            mint: item.mint,
            status: 0,
            ok: false,
            error: error?.message || String(error),
            source: item.source,
          })
          emitDebugLog({
            hypothesisId: "H10",
            location: "app/api/clone/pump-scan/route.ts:GET",
            message: "clone attempt error",
            data: { mint: item.mint, error: error?.message || String(error) },
          })
        }
      }
    } catch (error: any) {
      metaResults.push({ mint: item.mint, status: 0, ok: false })
      emitDebugLog({
        hypothesisId: "H9",
        location: "app/api/clone/pump-scan/route.ts:GET",
        message: "metadata fetch error",
        data: { mint: item.mint, error: error?.message || String(error) },
      })
    }
  }

  return NextResponse.json({
    collected: items.slice(0, maxMetaFetch),
    metaResults,
    clones,
    attempts,
  })
}

