const JITO_TIP_FLOOR_URL = "https://mainnet.block-engine.jito.wtf/api/v1/getTipFloor"

export type JitoTipFloor = {
  lamports: {
    p50: number
    p75: number
    p95: number
  }
  sol: {
    p50: number
    p75: number
    p95: number
  }
  recommended: {
    lamports: number
    sol: number
    bufferPct: number
  }
}

const FALLBACK_LAMPORTS = {
  p50: 100000,
  p75: 500000,
  p95: 1000000,
}

function toSol(lamports: number): number {
  return lamports / 1_000_000_000
}

export async function fetchJitoTipFloor(bufferPct: number = 0.1): Promise<JitoTipFloor> {
  let lamports = { ...FALLBACK_LAMPORTS }

  try {
    const res = await fetch(JITO_TIP_FLOOR_URL, { cache: "no-store" })
    if (res.ok) {
      const data = await res.json()
      const row = Array.isArray(data) ? data[0] : null
      if (row) {
        const p50 = Number(row.ema_landed_tip_50th_percentile)
        const p75 = Number(row.ema_landed_tip_75th_percentile)
        const p95 = Number(row.ema_landed_tip_95th_percentile)
        if (Number.isFinite(p50) && Number.isFinite(p75) && Number.isFinite(p95)) {
          lamports = { p50, p75, p95 }
        }
      }
    }
  } catch {
    // ignore and use fallback
  }

  const recommendedLamports = Math.ceil(lamports.p75 * (1 + bufferPct))

  return {
    lamports,
    sol: {
      p50: toSol(lamports.p50),
      p75: toSol(lamports.p75),
      p95: toSol(lamports.p95),
    },
    recommended: {
      lamports: recommendedLamports,
      sol: toSol(recommendedLamports),
      bufferPct,
    },
  }
}
