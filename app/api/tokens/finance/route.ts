import { NextRequest, NextResponse } from "next/server"
import { PublicKey } from "@solana/web3.js"
import { getBondingCurveData, calculateTokenPrice } from "@/lib/solana/pumpfun-sdk"

type PumpFunVolume = {
  volumeSol?: number
  volumeUsd?: number
  source?: string
}

type RpcFinance = {
  fundingBalanceSol: number
  liquiditySol: number
  currentPriceSol: number
  marketCapSol: number
  totalSupply: number
  complete: boolean
}

type FinanceCacheEntry<T> = {
  data: T
  expiresAt: number
}

const RPC_TTL_MS = 1000
const VOLUME_TTL_MS = 20000
const rpcCache = new Map<string, FinanceCacheEntry<RpcFinance>>()
const volumeCache = new Map<string, FinanceCacheEntry<PumpFunVolume>>()

const normalizeNumber = (value: any): number | null => {
  if (value == null) return null
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const pickVolumeFromPumpFun = (payload: any): PumpFunVolume => {
  if (!payload || typeof payload !== "object") return {}

  const volumeSol =
    normalizeNumber(payload.volume_24h) ??
    normalizeNumber(payload.volume) ??
    normalizeNumber(payload.total_volume) ??
    normalizeNumber(payload.total_trade_volume)

  const volumeUsd =
    normalizeNumber(payload.usd_volume_24h) ??
    normalizeNumber(payload.usd_volume) ??
    normalizeNumber(payload.volume_usd) ??
    normalizeNumber(payload.total_volume_usd)

  const source =
    volumeSol != null || volumeUsd != null
      ? "pump.fun"
      : undefined

  return { volumeSol: volumeSol ?? undefined, volumeUsd: volumeUsd ?? undefined, source }
}

const getRpcFinance = async (mintAddress: string): Promise<RpcFinance | null> => {
  const cached = rpcCache.get(mintAddress)
  if (cached && cached.expiresAt > Date.now()) return cached.data

  const mint = new PublicKey(mintAddress)
  const bondingCurve = await getBondingCurveData(mint)
  if (!bondingCurve) return null

  const realSolReserves = Number(bondingCurve.realSolReserves) / 1e9
  const totalSupply = Number(bondingCurve.tokenTotalSupply) / 1e6
  const currentPriceSol = calculateTokenPrice(bondingCurve)
  const marketCapSol = totalSupply * currentPriceSol

  const data: RpcFinance = {
    fundingBalanceSol: realSolReserves,
    liquiditySol: realSolReserves,
    currentPriceSol,
    marketCapSol,
    totalSupply,
    complete: bondingCurve.complete,
  }

  rpcCache.set(mintAddress, { data, expiresAt: Date.now() + RPC_TTL_MS })
  return data
}

const getVolumeData = async (mintAddress: string): Promise<PumpFunVolume> => {
  const cached = volumeCache.get(mintAddress)
  if (cached && cached.expiresAt > Date.now()) return cached.data

  let volume: PumpFunVolume = {}
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`, {
      cache: "no-store",
      headers: {
        "user-agent": "panel/1.0",
        accept: "application/json",
        referer: "https://pump.fun",
      },
    })
    if (res.ok) {
      const data = await res.json().catch(() => null)
      volume = pickVolumeFromPumpFun(data)
    }
  } catch {
    volume = {}
  }

  volumeCache.set(mintAddress, { data: volume, expiresAt: Date.now() + VOLUME_TTL_MS })
  return volume
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = String(searchParams.get("mintAddress") || "").trim()
    if (!mintAddress) {
      return NextResponse.json({ error: "mintAddress required" }, { status: 400 })
    }

    const rpcFinance = await getRpcFinance(mintAddress)
    if (!rpcFinance) {
      return NextResponse.json({ error: "bonding curve not found" }, { status: 404 })
    }

    const volume = await getVolumeData(mintAddress)

    return NextResponse.json({
      mintAddress,
      fundingBalanceSol: rpcFinance.fundingBalanceSol,
      liquiditySol: rpcFinance.liquiditySol,
      currentPriceSol: rpcFinance.currentPriceSol,
      marketCapSol: rpcFinance.marketCapSol,
      totalSupply: rpcFinance.totalSupply,
      complete: rpcFinance.complete,
      volumeSol: volume.volumeSol,
      volumeUsd: volume.volumeUsd,
      volumeSource: volume.source,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "internal error" }, { status: 500 })
  }
}
