
import { Connection, PublicKey } from "@solana/web3.js"
import { safeConnection } from "./config"

interface CacheEntry<T> {
  data: T
  timestamp: number
  expiresAt: number
}

// Global in-memory cache
// Note: In serverless, this resets on cold start, which is acceptable.
const globalCache = new Map<string, CacheEntry<any>>()

const DEFAULT_TTL_MS = 3000 // 3 seconds cache for high-frequency data

/**
 * Get data from cache or fetch it if stale/missing.
 * Implements Stale-While-Revalidate if configured (not fully in this simple version, just blocking fetch on stale).
 */
export async function getCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  const cached = globalCache.get(key)
  const now = Date.now()

  if (cached && now < cached.expiresAt) {
    return cached.data
  }

  // Fetch fresh data
  try {
    const data = await fetcher()
    globalCache.set(key, {
      data,
      timestamp: now,
      expiresAt: now + ttlMs,
    })
    return data
  } catch (error) {
    console.error(`Cache fetch failed for ${key}:`, error)
    // If we have stale data, return it instead of failing
    if (cached) {
      return cached.data
    }
    throw error
  }
}

/**
 * Invalidate a cache key
 */
export function invalidateCache(key: string) {
  globalCache.delete(key)
}

/**
 * Clear entire cache
 */
export function clearCache() {
  globalCache.clear()
}
