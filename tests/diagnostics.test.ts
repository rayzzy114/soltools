import { describe, it } from "vitest"
import dotenv from "dotenv"
import bs58 from "bs58"

dotenv.config()

const BASE58_KEYS = ["TEST_WALLET_SECRET", "JITO_AUTH_KEYPAIR"] as const
const UUID_KEYS = ["JITO_AUTH_UUID"] as const
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sanitize(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, "").replace(/\s/g, "")
}

function mask(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length)
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

describe("Env diagnostics", () => {
  it("validates base58 secrets from .env", () => {
    for (const key of BASE58_KEYS) {
      const raw = process.env[key] ?? ""
      const cleaned = sanitize(raw)
      if (!cleaned) {
        // Do not throw: just report missing values.
        console.warn(`${key}: missing`)
        continue
      }
      try {
        bs58.decode(cleaned)
        console.info(`${key}: ok (len=${cleaned.length}, sample=${mask(cleaned)})`)
      } catch (error: any) {
        console.error(
          `${key}: invalid base58 (len=${cleaned.length}, sample=${mask(cleaned)}): ${error?.message || error}`
        )
        throw error
      }
    }
  })

  it("validates UUID secrets from .env", () => {
    for (const key of UUID_KEYS) {
      const raw = process.env[key] ?? ""
      const cleaned = sanitize(raw)
      if (!cleaned) {
        console.warn(`${key}: missing`)
        continue
      }
      if (!UUID_REGEX.test(cleaned)) {
        throw new Error(`${key}: invalid UUID (len=${cleaned.length}, sample=${mask(cleaned)})`)
      }
      console.info(`${key}: ok (len=${cleaned.length}, sample=${mask(cleaned)})`)
    }
  })
})
