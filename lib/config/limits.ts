// central limits/config used by APIs and UI
export const MIN_BUY_SOL = 0.001
export const MAX_BUY_SOL = 10

// raw token amount in base units (assumes 6 decimals)
export const MIN_SELL_RAW = BigInt(1)
export const MAX_SELL_RAW = BigInt(1_000_000_000_000) // ~1,000,000 tokens

export const DEFAULT_SLIPPAGE_PERCENT = 5
export const DEFAULT_RUGPULL_SLIPPAGE = 25

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024
export const UPLOAD_ALLOWED_PREFIX = "image/"

export const FETCH_TIMEOUT_MS = 15_000
export const FETCH_RETRIES = 2
export const FETCH_BACKOFF_MS = 500

export const STAGGER_RETRY_ATTEMPTS = 3
export const STAGGER_RETRY_BASE_MS = 1200
export const STAGGER_RETRY_JITTER_MS = 600

export type SellRoute = "auto" | "bonding_curve" | "pumpswap"

