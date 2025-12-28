import dotenv from "dotenv"

dotenv.config()

const PUBLIC_DEVNET_RPCS = [
  "https://api.devnet.solana.com",
  "https://rpc.ankr.com/solana_devnet",
]

// silence optional native binding warnings
process.env.BIGINT_DISABLE_NATIVE = "1"

if (!process.env.NEXT_PUBLIC_SOLANA_NETWORK) {
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet"
}

if (!process.env.NEXT_PUBLIC_SOLANA_RPC_URL) {
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL =
    process.env.SOLANA_RPC_URL || PUBLIC_DEVNET_RPCS[0]
}

if (!process.env.NEXT_PUBLIC_SOLANA_RPC_URLS) {
  process.env.NEXT_PUBLIC_SOLANA_RPC_URLS =
    process.env.SOLANA_RPC_URLS ||
    process.env.SOLANA_RPC_URL ||
    PUBLIC_DEVNET_RPCS.join(",")
}

