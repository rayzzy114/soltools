const STORAGE_KEY = "soltools:bundler-wallet-secrets"

export interface StoredBundlerWallet {
  publicKey: string
  secretKey: string
}

const isValidStoredWallet = (entry: any): entry is StoredBundlerWallet => {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.publicKey === "string" &&
    entry.publicKey.length > 0 &&
    typeof entry.secretKey === "string" &&
    entry.secretKey.length > 0
  )
}

export function readStoredBundlerWallets(): StoredBundlerWallet[] {
  if (typeof window === "undefined") return []
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidStoredWallet)
  } catch {
    return []
  }
}

export function persistStoredBundlerWallets(wallets: StoredBundlerWallet[]) {
  if (typeof window === "undefined") return
  const normalized: StoredBundlerWallet[] = []
  const seen = new Set<string>()
  for (const wallet of wallets) {
    if (!isValidStoredWallet(wallet)) continue
    if (seen.has(wallet.publicKey)) continue
    seen.add(wallet.publicKey)
    normalized.push(wallet)
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
}

export function upsertStoredBundlerWallet(wallet: StoredBundlerWallet) {
  if (!isValidStoredWallet(wallet)) return
  const existing = readStoredBundlerWallets()
  const filtered = existing.filter((item) => item.publicKey !== wallet.publicKey)
  filtered.push(wallet)
  persistStoredBundlerWallets(filtered)
}

export function mergeStoredSecrets<T extends { publicKey: string; secretKey?: string }>(
  wallets: T[],
  storedSecrets: StoredBundlerWallet[]
): T[] {
  if (storedSecrets.length === 0) return wallets
  const secretMap = new Map(storedSecrets.map((wallet) => [wallet.publicKey, wallet.secretKey]))
  return wallets.map((wallet) => {
    if (!wallet.secretKey && secretMap.has(wallet.publicKey)) {
      return { ...wallet, secretKey: secretMap.get(wallet.publicKey) }
    }
    return wallet
  })
}

export async function importStoredBundlerWallets(storedSecrets: StoredBundlerWallet[]) {
  if (storedSecrets.length === 0) return
  const importPromises = storedSecrets.map((wallet) =>
    fetch("/api/bundler/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "import",
        secretKey: wallet.secretKey,
        label: "reimported",
      }),
    }).catch(() => null)
  )
  await Promise.all(importPromises)
}
