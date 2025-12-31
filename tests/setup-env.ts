import dotenv from "dotenv"

dotenv.config()

// silence optional native binding warnings
process.env.BIGINT_DISABLE_NATIVE = "1"

if (!process.env.NEXT_PUBLIC_SOLANA_NETWORK) {
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet"
}

if (!process.env.RPC) {
  process.env.RPC = ""
}

