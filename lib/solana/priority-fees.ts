import { LAMPORTS_PER_SOL, type Connection } from "@solana/web3.js"
import { getResilientConnection } from "./config"

type Percentiles = {
  p50: number
  p75: number
  p95: number
}

export type PriorityFeePreset = {
  microLamports: number
  feeSol: number
}

export type PriorityFeeRecommendations = {
  computeUnits: number
  samples: number
  percentiles: Percentiles
  presets: {
    default: PriorityFeePreset
    fast: PriorityFeePreset
    turbo: PriorityFeePreset
  }
}

const FALLBACK_PERCENTILES: Percentiles = {
  p50: 1500,
  p75: 3000,
  p95: 6000,
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const idx = Math.min(values.length - 1, Math.max(0, Math.floor((p / 100) * values.length)))
  return values[idx] || 0
}

function microLamportsToSol(microLamports: number, computeUnits: number): number {
  const lamports = (microLamports * computeUnits) / 1_000_000
  return lamports / LAMPORTS_PER_SOL
}

export async function getPriorityFeeRecommendations(
  computeUnits: number = 400000,
  connection?: Connection
): Promise<PriorityFeeRecommendations> {
  const conn = connection ?? (await getResilientConnection())
  let samples: number[] = []

  try {
    const fees = await (conn as any).getRecentPrioritizationFees?.()
    if (Array.isArray(fees)) {
      samples = fees
        .map((f: any) => Number(f?.prioritizationFee))
        .filter((v: number) => Number.isFinite(v) && v > 0)
        .sort((a: number, b: number) => a - b)
    }
  } catch {
    // fall back to static defaults
  }

  const percentiles = samples.length
    ? {
        p50: percentile(samples, 50),
        p75: percentile(samples, 75),
        p95: percentile(samples, 95),
      }
    : FALLBACK_PERCENTILES

  const presets = {
    default: {
      microLamports: percentiles.p50,
      feeSol: microLamportsToSol(percentiles.p50, computeUnits),
    },
    fast: {
      microLamports: percentiles.p75,
      feeSol: microLamportsToSol(percentiles.p75, computeUnits),
    },
    turbo: {
      microLamports: percentiles.p95,
      feeSol: microLamportsToSol(percentiles.p95, computeUnits),
    },
  }

  return {
    computeUnits,
    samples: samples.length,
    percentiles,
    presets,
  }
}
