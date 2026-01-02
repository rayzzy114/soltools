import { beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({
  wallets: [] as Array<{
    id: string
    publicKey: string
    secretKey: string
    label?: string | null
    role?: string
    solBalance: string
    tokenBalance: string
    isActive: boolean
  }>,
  walletGroupLinks: [] as Array<{ id: string; walletId: string }>,
  nextId: 1,
}))

vi.mock("@/lib/prisma", () => {
  const getWalletsByKeys = (publicKeys: string[]) =>
    store.wallets.filter((w) => publicKeys.includes(w.publicKey))

  const removeWalletsByIds = (ids: string[]) => {
    const before = store.wallets.length
    store.wallets = store.wallets.filter((w) => !ids.includes(w.id))
    return before - store.wallets.length
  }

  const removeGroupLinksByWalletIds = (ids: string[]) => {
    const before = store.walletGroupLinks.length
    store.walletGroupLinks = store.walletGroupLinks.filter((link) => !ids.includes(link.walletId))
    return before - store.walletGroupLinks.length
  }

  return {
    prisma: {
      wallet: {
        upsert: vi.fn(async ({ where, update, create }) => {
          const existing = store.wallets.find((w) => w.publicKey === where.publicKey)
          if (existing) {
            Object.assign(existing, update)
            return existing
          }
          const newWallet = {
            id: `wallet-${store.nextId++}`,
            ...create,
          }
          store.wallets.push(newWallet)
          return newWallet
        }),
        count: vi.fn(async () => store.wallets.length),
        findMany: vi.fn(async () => [...store.wallets].reverse()),
        delete: vi.fn(async ({ where }) => {
          const idx = store.wallets.findIndex((w) => w.publicKey === where.publicKey)
          if (idx >= 0) {
            store.wallets.splice(idx, 1)
          }
          return {}
        }),
      },
      walletGroupWallet: {
        deleteMany: vi.fn(async ({ where }) => {
          const ids = where.walletId?.in || []
          return { count: removeGroupLinksByWalletIds(ids) }
        }),
      },
      $transaction: vi.fn(async (runner) => {
        const tx = {
          wallet: {
            findMany: vi.fn(async ({ where }) => {
              const keys = where.publicKey?.in || []
              return getWalletsByKeys(keys).map((w) => ({ id: w.id, publicKey: w.publicKey }))
            }),
            deleteMany: vi.fn(async ({ where }) => {
              const ids = where.id?.in || []
              return { count: removeWalletsByIds(ids) }
            }),
          },
          walletGroupWallet: {
            deleteMany: vi.fn(async ({ where }) => {
              const ids = where.walletId?.in || []
              return { count: removeGroupLinksByWalletIds(ids) }
            }),
          },
        }
        return runner(tx)
      }),
    },
  }
})

vi.mock("@/lib/solana/config", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, connection: { getBalance: vi.fn(), getLatestBlockhash: vi.fn() } }
})

describe("/api/bundler/wallets batch deletion", () => {
  beforeEach(() => {
    store.wallets = []
    store.walletGroupLinks = []
    store.nextId = 1
    vi.clearAllMocks()
  })

  it("creates 100 wallets then deletes all of them", async () => {
    const { GET, POST } = await import("@/app/api/bundler/wallets/route")

    const generateRequest = {
      url: "http://localhost/api/bundler/wallets?action=generate-multiple&count=100",
      headers: new Headers(),
    } as any

    const generateResponse = await GET(generateRequest)
    const generated = await generateResponse.json()

    expect(generated.wallets).toHaveLength(100)
    expect(store.wallets).toHaveLength(100)

    // attach some group links to ensure cleanup happens
    store.walletGroupLinks = store.wallets.slice(0, 10).map((wallet, index) => ({
      id: `link-${index + 1}`,
      walletId: wallet.id,
    }))

    const deleteRequest = {
      headers: new Headers(),
      json: async () => ({
        action: "delete-batch",
        publicKeys: generated.wallets.map((w: any) => w.publicKey),
      }),
    } as any

    const deleteResponse = await POST(deleteRequest)
    const deleted = await deleteResponse.json()

    expect(deleted).toEqual({ success: true, count: 100 })
    expect(store.wallets).toHaveLength(0)
    expect(store.walletGroupLinks).toHaveLength(0)
  })
})
