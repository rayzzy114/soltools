import { describe, expect, it, vi } from "vitest"
import { Connection, Transaction } from "@solana/web3.js"
import { ensureTransactionSignature } from "@/lib/solana/send-helpers"

describe("ensureTransactionSignature", () => {
  const connection = {
    sendRawTransaction: vi.fn().mockResolvedValue("fakesig"),
  } as unknown as Connection

  it("returns signature from wallet sendTransaction", async () => {
    const sendTransaction = vi.fn().mockResolvedValue("abc")
    const transaction = new Transaction()

    const signature = await ensureTransactionSignature({
      transaction,
      connection,
      sendTransaction,
    })

    expect(signature).toBe("abc")
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    expect(connection.sendRawTransaction).not.toHaveBeenCalled()
  })

  it("falls back to sign + sendRawTransaction when sendTransaction is undefined", async () => {
    const transaction = new Transaction()
    const signedTx = { serialize: vi.fn().mockReturnValue(Buffer.from("deadbeef", "hex")) }

    const signature = await ensureTransactionSignature({
      transaction,
      connection,
      sendTransaction: async () => undefined,
      signTransaction: async () => signedTx as unknown as Transaction,
    })

    expect(signature).toBe("fakesig")
    expect(connection.sendRawTransaction).toHaveBeenCalledWith(expect.any(Buffer), {
      skipPreflight: undefined,
      minContextSlot: undefined,
    })
  })

  it("throws if neither sendTransaction nor signTransaction can produce a signature", async () => {
    const transaction = new Transaction()
    const sendTransaction = vi.fn().mockResolvedValue(undefined)

    await expect(
      ensureTransactionSignature({
        transaction,
        connection,
        sendTransaction,
      })
    ).rejects.toThrow(/signature not received|wallet did not return/)
  })
})
