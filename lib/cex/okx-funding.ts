import ccxt, { okx } from "ccxt"

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
}

const DEFAULT_MIN_DELAY_MS = 30_000
const DEFAULT_MAX_DELAY_MS = 300_000
const DEFAULT_MIN_AMOUNT = 0.3
const DEFAULT_MAX_AMOUNT = 0.5
const DEFAULT_FEE = 0.01

export function createOkxClient(creds: OkxCredentials = {}): okx {
  const { apiKey, secret, password } = creds
  const client = new ccxt.okx({
    apiKey: apiKey ?? process.env.OKX_API_KEY,
    secret: secret ?? process.env.OKX_API_SECRET,
    password: password ?? process.env.OKX_PASSWORD,
  })

  return client as okx
}

export async function whitelistWithdrawalAddresses(
  client: okx,
  addresses: string[],
  chain: string = "4",
  password?: string
): Promise<void> {
  const pwd = password ?? (client as any).password ?? process.env.OKX_PASSWORD
  for (const address of addresses) {
    await client.fetch2("asset/withdrawal/white-list", "private", "POST", {
      addr: address,
      ccy: "SOL",
      chain,
      pwd,
    })
  }
}

function randomInRange(min: number, max: number): number {
  if (max <= min) return min
  return Math.random() * (max - min) + min
}

export async function withdrawToSnipers(
  client: okx,
  wallets: string[],
  options: WithdrawOptions = {}
): Promise<void> {
  const {
    chain = "4",
    minAmount = DEFAULT_MIN_AMOUNT,
    maxAmount = DEFAULT_MAX_AMOUNT,
    fee = DEFAULT_FEE,
    minDelayMs = DEFAULT_MIN_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
  } = options

  for (const address of wallets) {
    const amount = randomInRange(minAmount, maxAmount)
    await client.withdraw("SOL", amount, address, undefined, {
      dest: chain,
      fee,
    })

    const delay = randomInRange(minDelayMs, maxDelayMs)
    if (delay > 0) {
      await sleep(delay)
    }
  }
}

export const __testing = {
  randomInRange,
  sleep,
}
