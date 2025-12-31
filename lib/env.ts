import { z } from "zod"

const EnvSchema = z.object({
  NEXT_PUBLIC_SOLANA_NETWORK: z.enum(["devnet", "mainnet-beta"]).default("mainnet-beta"),
  RPC: z.string().optional(),
  NEXT_PUBLIC_ALLOW_PRIVATE_KEYS: z.enum(["true", "false"]).optional(),
  EXPOSE_WALLET_SECRETS: z.enum(["true", "false"]).optional(),
  LOG_LEVEL: z.string().optional(),
})

const parsed = EnvSchema.parse(process.env)

const rpcPrimary = parsed.RPC?.trim()
const rpcList = Array.from(new Set([rpcPrimary].filter(Boolean)))

export const ENV = {
  network: parsed.NEXT_PUBLIC_SOLANA_NETWORK,
  rpcPrimary,
  rpcList,
  allowPrivateKeys: parsed.NEXT_PUBLIC_ALLOW_PRIVATE_KEYS !== "false",
  exposeWalletSecrets: parsed.EXPOSE_WALLET_SECRETS !== "false",
  logLevel: parsed.LOG_LEVEL || "info",
}
