import { Connection, PublicKey } from "@solana/web3.js"
import { TOKEN_PROGRAM_ID } from "@solana/spl-token"

export interface HolderRow {
  address: string
  balance: number
  percentage: number
  isBondingCurve: boolean
  isDev: boolean
}

type TrackerOptions = {
  bondingCurve?: PublicKey
  devWallet?: PublicKey
  onUpdate?: (rows: HolderRow[]) => void
  emitThrottleMs?: number
  limit?: number
}

export class TokenHolderTracker {
  private connection: Connection
  private mint: PublicKey
  private bondingCurve?: PublicKey
  private devWallet?: PublicKey
  private holders = new Map<string, bigint>()
  private subscriptionId: number | null = null
  private decimals = 6
  private totalSupplyRaw = 1_000_000_000_000_000n
  private onUpdate?: (rows: HolderRow[]) => void
  private emitThrottleMs: number
  private limit: number
  private lastEmit = 0

  constructor(connection: Connection, mint: PublicKey, opts: TrackerOptions = {}) {
    this.connection = connection
    this.mint = mint
    this.bondingCurve = opts.bondingCurve
    this.devWallet = opts.devWallet
    this.onUpdate = opts.onUpdate
    this.emitThrottleMs = opts.emitThrottleMs ?? 750
    this.limit = opts.limit ?? 12
  }

  async init() {
    await this.loadMintInfo()
    await this.loadSnapshot()
    this.emit(true)
    this.subscribe()
  }

  stop() {
    if (this.subscriptionId) {
      this.connection.removeProgramAccountChangeListener(this.subscriptionId)
      this.subscriptionId = null
    }
  }

  getTopHolders(limit = this.limit): HolderRow[] {
    const supply = Number(this.totalSupplyRaw)
    return Array.from(this.holders.entries())
      .sort((a, b) => Number(b[1] - a[1]))
      .slice(0, limit)
      .map(([address, amount]) => {
        const balance = Number(amount) / Math.pow(10, this.decimals)
        const percentage = supply > 0 ? (Number(amount) / supply) * 100 : 0
        return {
          address,
          balance,
          percentage,
          isBondingCurve: this.bondingCurve ? address === this.bondingCurve.toBase58() : false,
          isDev: this.devWallet ? address === this.devWallet.toBase58() : false,
        }
      })
  }

  private emit(force = false) {
    if (!this.onUpdate) return
    const now = Date.now()
    if (!force && now - this.lastEmit < this.emitThrottleMs) return
    this.lastEmit = now
    this.onUpdate(this.getTopHolders())
  }

  private async loadMintInfo() {
    try {
      const info = await this.connection.getParsedAccountInfo(this.mint, "confirmed")
      const parsed = (info.value?.data as any)?.parsed?.info
      const supply = parsed?.supply
      const decimals = parsed?.decimals
      if (typeof decimals === "number") this.decimals = decimals
      if (typeof supply === "string" && supply.length > 0) {
        this.totalSupplyRaw = BigInt(supply)
      }
    } catch {
      // keep defaults
    }
  }

  private async loadSnapshot() {
    const accounts = await this.connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: this.mint.toBase58() } },
      ],
      encoding: "jsonParsed",
    })

    this.holders.clear()
    for (const acc of accounts) {
      const parsed = (acc.account.data as any)?.parsed?.info
      const amount = parsed?.tokenAmount?.amount
      const owner = parsed?.owner
      if (!owner || typeof amount !== "string") continue
      const raw = BigInt(amount)
      if (raw > 0n) {
        this.holders.set(owner, raw)
      }
    }
  }

  private subscribe() {
    if (this.subscriptionId) return
    this.subscriptionId = this.connection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      (info) => {
        const parsed = (info.accountInfo.data as any)?.parsed?.info
        const owner = parsed?.owner
        const amount = parsed?.tokenAmount?.amount
        if (!owner || typeof amount !== "string") return
        const raw = BigInt(amount)
        if (raw === 0n) {
          this.holders.delete(owner)
        } else {
          this.holders.set(owner, raw)
        }
        this.emit()
      },
      {
        commitment: "confirmed",
        filters: [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: this.mint.toBase58() } },
        ],
        encoding: "jsonParsed",
      }
    )
  }
}
