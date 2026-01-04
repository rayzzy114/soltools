import dotenv from "dotenv"
import { vi } from "vitest"

dotenv.config()

// silence optional native binding warnings
process.env.BIGINT_DISABLE_NATIVE = "1"

if (!process.env.NEXT_PUBLIC_SOLANA_NETWORK) {
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet"
}

if (!process.env.RPC) {
  process.env.RPC = ""
}

vi.mock("ccxt", () => {
  class MockExchange {
    id = "okx"
    password = process.env.OKX_PASSWORD
    async withdraw() {
      return { id: "mock-withdraw" }
    }
    async fetch2() {
      return { id: "mock-whitelist" }
    }
  }

  return {
    default: { okx: MockExchange, __esModule: true },
    okx: MockExchange,
  }
})

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({})),
}))

