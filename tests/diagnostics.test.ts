import { describe, it } from "vitest"
import dotenv from "dotenv"
import bs58 from "bs58"

dotenv.config()

const ENV_KEYS = ["TEST_WALLET_SECRET", "JITO_AUTH_UUID", "JITO_AUTH_KEYPAIR"] as const

function sanitize(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, "").replace(/\s/g, "")
}

function mask(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length)
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

describe("Env base58 diagnostics", () => {
  it("validates base58 secrets from .env", () => {
    for (const key of ENV_KEYS) {
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
})
