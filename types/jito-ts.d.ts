declare module "jito-ts/dist/sdk/block-engine/searcher" {
  import type { Keypair } from "@solana/web3.js"
  import type { Bundle } from "jito-ts/dist/sdk/block-engine/types"

  type JitoResult<T> =
    | { ok: true; value: T }
    | { ok: false; error?: { message?: string } | string }

  export function searcherClient(
    endpoint: string,
    authKeypair?: Keypair
  ): {
    sendBundle(bundle: Bundle): Promise<JitoResult<string | { bundleId?: string; bundle_id?: string }>>
    getBundleStatuses(bundleIds: string[]): Promise<JitoResult<any[]>>
    getTipAccounts(): Promise<JitoResult<string[]>>
  }
}

declare module "jito-ts/dist/sdk/block-engine/types" {
  import type { VersionedTransaction } from "@solana/web3.js"

  export class Bundle {
    constructor(transactions: VersionedTransaction[], maxTxPerBundle?: number)
    transactions: VersionedTransaction[]
  }
}

