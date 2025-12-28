export interface FetchRetryOptions extends RequestInit {
  retries?: number
  backoffMs?: number
  retryOn?: number[]
}

import Bottleneck from "bottleneck"

const limiter = new Bottleneck({
  minTime: 100, // ~10 rps
  maxConcurrent: 5,
})

export async function fetchWithRetry(url: string, opts: FetchRetryOptions = {}): Promise<Response> {
  const {
    retries = 2,
    backoffMs = 300,
    retryOn = [429, 500, 502, 503, 504],
    ...rest
  } = opts

  let attempt = 0
  let lastError: any

  while (attempt <= retries) {
    try {
      const res = await limiter.schedule(() => fetch(url, rest))
      if (!retryOn.includes(res.status)) {
        return res
      }
      lastError = new Error(`http ${res.status}`)
    } catch (error) {
      lastError = error
    }

    attempt++
    if (attempt > retries) break
    await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt))
  }

  throw lastError
}

