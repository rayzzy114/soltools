import { z } from "zod"

const DEFAULT_DEVNET_RPCS = [
  "https://api.devnet.solana.com",
  "https://rpc.ankr.com/solana_devnet",
]

const EnvSchema = z.object({
  NEXT_PUBLIC_SOLANA_NETWORK: z.enum(["devnet", "mainnet-beta"]).default("mainnet-beta"),
  NEXT_PUBLIC_SOLANA_RPC_URL: z.string().optional(),
  NEXT_PUBLIC_SOLANA_RPC_URLS: z.string().optional(),
  NEXT_PUBLIC_ALLOW_PRIVATE_KEYS: z.enum(["true", "false"]).optional(),
  EXPOSE_WALLET_SECRETS: z.enum(["true", "false"]).optional(),
  LOG_LEVEL: z.string().optional(),
})

const parsed = EnvSchema.parse(process.env)

const rpcPrimary = parsed.NEXT_PUBLIC_SOLANA_RPC_URL?.trim()
const rpcListFromEnv =
  parsed.NEXT_PUBLIC_SOLANA_RPC_URLS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) || []

const defaultRpcList =
  parsed.NEXT_PUBLIC_SOLANA_NETWORK === "devnet" ? DEFAULT_DEVNET_RPCS : []

const rpcList = Array.from(new Set([rpcPrimary, ...rpcListFromEnv, ...defaultRpcList].filter(Boolean)))

export const ENV = {
  network: parsed.NEXT_PUBLIC_SOLANA_NETWORK,
  rpcPrimary,
  rpcList,
  allowPrivateKeys: parsed.NEXT_PUBLIC_ALLOW_PRIVATE_KEYS !== "false",
  exposeWalletSecrets: parsed.EXPOSE_WALLET_SECRETS !== "false",
  logLevel: parsed.LOG_LEVEL || "info",
}
