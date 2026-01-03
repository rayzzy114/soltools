import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js"

export type WalletSendTransaction = (
  transaction: Transaction | VersionedTransaction,
  connection: Connection,
  options?: { skipPreflight?: boolean; minContextSlot?: number }
) => Promise<string | undefined>

export type WalletSignTransaction = (
  transaction: Transaction | VersionedTransaction
) => Promise<Transaction | VersionedTransaction>

const serializeTransaction = (transaction: Transaction | VersionedTransaction): Buffer => {
  if (typeof (transaction as any)?.serialize === "function") {
    return (transaction as any).serialize()
  }
  throw new Error("unable to serialize transaction")
}

export async function ensureTransactionSignature({
  transaction,
  connection,
  sendTransaction,
  signTransaction,
  options,
}: {
  transaction: Transaction | VersionedTransaction
  connection: Connection
  sendTransaction?: WalletSendTransaction
  signTransaction?: WalletSignTransaction
  options?: { skipPreflight?: boolean; minContextSlot?: number }
}): Promise<string> {
  let lastError: unknown

  if (sendTransaction) {
    try {
      const maybeSignature = await sendTransaction(transaction, connection, options)
      if (maybeSignature) {
        return maybeSignature
      }
      lastError = new Error("wallet did not return a transaction signature")
    } catch (error) {
      lastError = error
    }
  }

  if (signTransaction) {
    const signed = await signTransaction(transaction)
    const raw = serializeTransaction(signed)
    const fallbackSignature = await connection.sendRawTransaction(raw, {
      skipPreflight: options?.skipPreflight,
      minContextSlot: options?.minContextSlot,
    })
    if (fallbackSignature) {
      return fallbackSignature
    }
    throw new Error("failed to send transaction after signing")
  }

  const message = lastError instanceof Error ? lastError.message : "transaction signature not received"
  throw new Error(message)
}
