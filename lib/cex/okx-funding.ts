import ccxt, { okx } from "ccxt"
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { connection } from "../solana/config"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface OkxCredentials {
  apiKey?: string
  secret?: string
  password?: string
}

export interface WithdrawOptions {
  chain?: string
  minAmount?: number
  maxAmount?: number
  fee?: number
  minDelayMs?: number
  maxDelayMs?: number
  clientOrderIdPrefix?: string
}

const DEFAULT_MIN_DELAY_MS = 30_000
const DEFAULT_MAX_DELAY_MS = 300_000
const DEFAULT_MIN_AMOUNT = 0.3
const DEFAULT_MAX_AMOUNT = 0.5
const DEFAULT_FEE = 0.01

/**
 * Create an OKX exchange client configured with the provided credentials or environment variables.
 *
 * @param creds - Optional credentials. If a field is omitted, the corresponding environment variable (`OKX_API_KEY`, `OKX_API_SECRET`, `OKX_PASSWORD`) will be used.
 * @returns An `okx` client instance configured with the resolved API key, secret, and password
 */
export function createOkxClient(creds: OkxCredentials = {}): okx {
  const { apiKey, secret, password } = creds
  const client = new ccxt.okx({
    apiKey: apiKey ?? process.env.OKX_API_KEY,
    secret: secret ?? process.env.OKX_API_SECRET,
    password: password ?? process.env.OKX_PASSWORD,
  })

  return client as okx
}

/**
 * Add SOL withdrawal addresses to the account's whitelist on OKX.
 *
 * Calls the OKX private whitelist API for each address in `addresses` on the specified `chain`.
 * The password used for the operation is taken from `password` if provided, otherwise from
 * `client.password`, and finally from the `OKX_PASSWORD` environment variable.
 *
 * @param addresses - Array of SOL addresses to whitelist
 * @param chain - Destination chain identifier used by OKX for the whitelist entry
 * @param password - Optional account password to authorize the whitelist operation
 */
export async function whitelistWithdrawalAddresses(
  client: okx,
  addresses: string[],
  chain: string = "4",
  password?: string
): Promise<void> {
  const pwd = password ?? (client as any).password ?? process.env.OKX_PASSWORD
  for (const address of addresses) {
    try {
      await client.fetch2("asset/withdrawal/white-list", "private", "POST", {
        addr: address,
        ccy: "SOL",
        chain,
        pwd,
      })
    } catch (error: any) {
      console.error(`[whitelist] failed to whitelist ${address}: ${error?.message || error}`)
    }
  }
}

/**
 * Produce a pseudorandom number greater than or equal to `min` and less than `max`.
 *
 * @param min - The lower bound (inclusive)
 * @param max - The upper bound (exclusive)
 * @returns `min` if `max` is less than or equal to `min`, otherwise a pseudorandom number `x` such that `min <= x < max`
 */
function randomInRange(min: number, max: number): number {
  if (max <= min) return min
  return Math.random() * (max - min) + min
}

/**
 * Sends randomized SOL withdrawals to a list of destination addresses with configurable chain, fee, and inter-withdrawal delays.
 *
 * @param wallets - Array of destination SOL addresses to withdraw to.
 * @param options - Configuration for the withdrawals:
 *   - chain: destination chain identifier (default "4")
 *   - minAmount / maxAmount: lower and upper bounds for the randomized withdrawal amount (defaults 0.3 / 0.5)
 *   - fee: withdrawal fee in SOL units (default 0.01)
 *   - minDelayMs / maxDelayMs: minimum and maximum delay in milliseconds between successive withdrawals (defaults 30000 / 300000)
 *   - clientOrderIdPrefix: optional prefix for idempotent client order IDs (e.g. session/batch ID)
 */
export async function withdrawToSnipers(
  client: okx,
  wallets: string[],
  options: WithdrawOptions = {}
): Promise<{ success: string[]; failed: Array<{ address: string; error: string }> }> {
  const {
    chain = "4",
    minAmount = DEFAULT_MIN_AMOUNT,
    maxAmount = DEFAULT_MAX_AMOUNT,
    fee = DEFAULT_FEE,
    minDelayMs = DEFAULT_MIN_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    clientOrderIdPrefix,
  } = options

  const success: string[] = []
  const failed: Array<{ address: string; error: string }> = []

  for (let i = 0; i < wallets.length; i++) {
    const address = wallets[i]
    try {
      // 1. Check current balance before withdrawal (On-chain check)
      const pubkey = new PublicKey(address)
      const balance = await connection.getBalance(pubkey)
      const targetLamports = BigInt(Math.floor(minAmount * LAMPORTS_PER_SOL))

      if (BigInt(balance) >= targetLamports) {
        console.log(`[withdraw] skipping ${address}, already funded (${balance / LAMPORTS_PER_SOL} SOL)`)
        success.push(address)
        continue
      }

      const amount = randomInRange(minAmount, maxAmount)

      // 2. Generate Client Order ID for idempotency if prefix is provided
      const clientOrderId = clientOrderIdPrefix
        ? `${clientOrderIdPrefix}-${i}-${address.slice(0, 8)}`
        : undefined

      const params = {
        dest: chain,
        fee,
        ...(clientOrderId ? { clientId: clientOrderId } : {})
      }

      await client.withdraw("SOL", amount, address, undefined, params)
      success.push(address)
    } catch (error: any) {
      console.error(`[withdraw] failed for ${address}:`, error)
      failed.push({ address, error: error?.message || String(error) })
    }

    // Delay between processing (skip delay for last item)
    if (i < wallets.length - 1) {
      const delay = randomInRange(minDelayMs, maxDelayMs)
      if (delay > 0) {
        await sleep(delay)
      }
    }
  }
  return { success, failed }
}

export const __testing = {
  randomInRange,
  sleep,
}
