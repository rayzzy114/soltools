import { AddressLookupTableAccount, Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import bs58 from "bs58"

const RPC_URL = "http://bankrun.invalid"

class MockBankrunConnection {
  private slot = 1

  async getSlot(): Promise<number> {
    return ++this.slot
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number; blockHeight: number }> {
    const blockhash = bs58.encode(Buffer.from(Array(32).fill(1)))
    const blockHeight = ++this.slot
    return { blockhash, lastValidBlockHeight: blockHeight + 150, blockHeight }
  }

  async requestAirdrop(): Promise<string> {
    return `airdrop-${Date.now()}`
  }

  async confirmTransaction(): Promise<any> {
    return { value: { err: null } }
  }

  async simulateTransaction(): Promise<any> {
    return { value: { err: null } }
  }

  async getAccountInfo(): Promise<any> {
    return { owner: new PublicKey("11111111111111111111111111111111"), data: Buffer.alloc(0) }
  }

  async sendTransaction(): Promise<string> {
    return `tx-${Date.now()}`
  }

  async sendRawTransaction(): Promise<string> {
    return `raw-${Date.now()}`
  }

  async getBalance(): Promise<number> {
    return 5 * LAMPORTS_PER_SOL
  }

  async getAddressLookupTable(
    address: PublicKey
  ): Promise<{ context: { slot: number }; value: AddressLookupTableAccount | null }> {
    return {
      context: { slot: this.slot },
      value: new AddressLookupTableAccount({
        key: address,
        state: {
          authority: new PublicKey("11111111111111111111111111111111"),
          addresses: [],
          deactivationSlot: BigInt(0),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
        },
      }),
    }
  }

  async getRecentPrioritizationFees(): Promise<any[]> {
    return [{ prioritizationFee: 0, slot: this.slot }]
  }
}

/**
 * Prepare a test-local validator environment and provide a mock Solana connection with a no-op stopper.
 *
 * This function ensures test-related environment variables (RPC, ANCHOR_PROVIDER_URL, TEST_BANKRUN) are set to a local mock RPC URL, constructs a mock Connection suitable for integration tests, and returns a stop function that performs no operation.
 *
 * @returns An object with:
 *  - `connection` — a mock `Connection` instance that simulates a local validator for tests.
 *  - `stop` — an async no-op function to satisfy lifecycle APIs.
 */
export async function ensureLocalValidator(): Promise<{
  connection: Connection
  stop: () => Promise<void>
}> {
  process.env.RPC = process.env.RPC || RPC_URL
  process.env.ANCHOR_PROVIDER_URL = process.env.ANCHOR_PROVIDER_URL || RPC_URL
  process.env.TEST_BANKRUN = "true"

  const connection = new MockBankrunConnection() as unknown as Connection
  return {
    connection,
    stop: async () => {
      // no-op for mock bankrun
    },
  }
}