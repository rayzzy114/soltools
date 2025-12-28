/**
 * Address Lookup Tables (LUT) для оптимизации транзакций
 * Уменьшает размер транзакций и комиссии на 30-50%
 */

import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import { connection } from "./config"

// cache для LUT accounts
const lutCache = new Map<string, AddressLookupTableAccount>()

// известные программы pump.fun и solana
const KNOWN_ADDRESSES = {
  // pump.fun
  pumpFunProgram: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  pumpFunGlobal: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"),
  pumpFunEventAuthority: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"),
  pumpFunFeeRecipient: new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"),
  
  // system
  systemProgram: new PublicKey("11111111111111111111111111111111"),
  tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
  
  // compute budget
  computeBudget: new PublicKey("ComputeBudget111111111111111111111111111111"),
}

/**
 * создать новую lookup table
 */
export async function createLookupTable(
  payer: Keypair,
  addresses: PublicKey[],
  conn: Connection = connection
): Promise<PublicKey> {
  // получить последний слот
  const slot = await conn.getSlot()

  // создать LUT
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot - 1,
  })
  
  // extend LUT с адресами
  const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
    lookupTable: lutAddress,
    addresses,
    })
    
  // build and send
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [createIx, extendIx],
  }).compileToV0Message()
  
  const tx = new VersionedTransaction(message)
  tx.sign([payer])
  
  const signature = await conn.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  })

  await conn.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  })

  return lutAddress
}

/**
 * создать pump.fun specific LUT
 */
export async function createPumpFunLUT(
  payer: Keypair,
  additionalAddresses: PublicKey[] = [],
  conn: Connection = connection
): Promise<PublicKey> {
  const addresses = [
    KNOWN_ADDRESSES.pumpFunProgram,
    KNOWN_ADDRESSES.pumpFunGlobal,
    KNOWN_ADDRESSES.pumpFunEventAuthority,
    KNOWN_ADDRESSES.pumpFunFeeRecipient,
    KNOWN_ADDRESSES.systemProgram,
    KNOWN_ADDRESSES.tokenProgram,
    KNOWN_ADDRESSES.associatedTokenProgram,
    KNOWN_ADDRESSES.rent,
    KNOWN_ADDRESSES.computeBudget,
    ...additionalAddresses,
  ]

  return createLookupTable(payer, addresses, conn)
}

/**
 * получить LUT account
 */
export async function getLookupTableAccount(
  lutAddress: PublicKey,
  conn: Connection = connection
): Promise<AddressLookupTableAccount | null> {
  const cacheKey = lutAddress.toBase58()
  
  // check cache
  if (lutCache.has(cacheKey)) {
    return lutCache.get(cacheKey)!
  }

  const accountInfo = await conn.getAddressLookupTable(lutAddress)
  
  if (accountInfo.value) {
    lutCache.set(cacheKey, accountInfo.value)
    return accountInfo.value
  }

  return null
}

/**
 * extend существующую LUT
 */
export async function extendLookupTable(
  payer: Keypair,
  lutAddress: PublicKey,
  newAddresses: PublicKey[],
  conn: Connection = connection
): Promise<string> {
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lutAddress,
    addresses: newAddresses,
  })

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [extendIx],
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  tx.sign([payer])
    
  const signature = await conn.sendTransaction(tx, {
    skipPreflight: false,
  })

  await conn.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  })
    
    // invalidate cache
  lutCache.delete(lutAddress.toBase58())
    
    return signature
  }
  
/**
 * закрыть LUT и вернуть rent
 */
export async function closeLookupTable(
  payer: Keypair,
  lutAddress: PublicKey,
  recipient: PublicKey = payer.publicKey,
  conn: Connection = connection
): Promise<string> {
  const closeIx = AddressLookupTableProgram.closeLookupTable({
    authority: payer.publicKey,
    lookupTable: lutAddress,
    recipient,
  })

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      // небольшой compute budget для надёжности
      AddressLookupTableProgram.freezeLookupTable({ lookupTable: lutAddress, authority: payer.publicKey }),
      closeIx,
    ],
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  tx.sign([payer])

  const signature = await conn.sendTransaction(tx, {
    skipPreflight: false,
  })

  await conn.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  })

  lutCache.delete(lutAddress.toBase58())
  return signature
}
  
  /**
 * создать V0 транзакцию с LUT
 */
export async function createV0Transaction(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  lookupTableAccounts: AddressLookupTableAccount[] = [],
  conn: Connection = connection
): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash()

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTableAccounts)

  return new VersionedTransaction(message)
  }
  
  /**
 * estimate transaction size savings with LUT
 */
export function estimateSavings(
  instructions: TransactionInstruction[],
  lookupTableAccounts: AddressLookupTableAccount[] = []
): { withoutLut: number; withLut: number; saved: number; percentage: number } {
  // collect all unique addresses
  const allAddresses = new Set<string>()
  
  for (const ix of instructions) {
    allAddresses.add(ix.programId.toBase58())
    for (const key of ix.keys) {
      allAddresses.add(key.pubkey.toBase58())
    }
  }

  // size without LUT: 32 bytes per address
  const withoutLut = allAddresses.size * 32

  // addresses in LUT
  const lutAddresses = new Set<string>()
  for (const lut of lookupTableAccounts) {
    for (const addr of lut.state.addresses) {
      lutAddresses.add(addr.toBase58())
    }
  }

  // count matches
  let matches = 0
  for (const addr of allAddresses) {
    if (lutAddresses.has(addr)) {
      matches++
    }
  }

  // size with LUT: 32 bytes for non-matched, 1 byte for matched
  const withLut = (allAddresses.size - matches) * 32 + matches * 1 + lookupTableAccounts.length * 32 // + LUT addresses

  const saved = withoutLut - withLut
  const percentage = withoutLut > 0 ? (saved / withoutLut) * 100 : 0

  return { withoutLut, withLut, saved, percentage }
  }
  
  /**
 * deactivate LUT (для cleanup)
 */
export async function deactivateLookupTable(
  payer: Keypair,
  lutAddress: PublicKey,
  conn: Connection = connection
): Promise<string> {
  const deactivateIx = AddressLookupTableProgram.deactivateLookupTable({
    lookupTable: lutAddress,
    authority: payer.publicKey,
  })

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [deactivateIx],
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  tx.sign([payer])
    
  const signature = await conn.sendTransaction(tx)

  await conn.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  })

  lutCache.delete(lutAddress.toBase58())
    
    return signature
  }
  
  /**
 * helper: get all addresses from instructions
 */
export function extractAddresses(instructions: TransactionInstruction[]): PublicKey[] {
  const addressSet = new Set<string>()
  
  for (const ix of instructions) {
    addressSet.add(ix.programId.toBase58())
    for (const key of ix.keys) {
      addressSet.add(key.pubkey.toBase58())
    }
  }

  return Array.from(addressSet).map(a => new PublicKey(a))
}

// helpers for bundler defaults
export const BUNDLER_COMMON_ADDRESSES = [
  KNOWN_ADDRESSES.pumpFunProgram,
  KNOWN_ADDRESSES.pumpFunGlobal,
  KNOWN_ADDRESSES.pumpFunEventAuthority,
  KNOWN_ADDRESSES.pumpFunFeeRecipient,
  KNOWN_ADDRESSES.systemProgram,
  KNOWN_ADDRESSES.tokenProgram,
  KNOWN_ADDRESSES.associatedTokenProgram,
  KNOWN_ADDRESSES.rent,
  KNOWN_ADDRESSES.computeBudget,
]

export async function getLookupTableAccounts(
  luts: PublicKey[],
  conn: Connection = connection
): Promise<AddressLookupTableAccount[]> {
  const accounts: AddressLookupTableAccount[] = []
  for (const lut of luts) {
    const acc = await getLookupTableAccount(lut, conn)
    if (acc) accounts.push(acc)
  }
  return accounts
}

// export known addresses for external use
export { KNOWN_ADDRESSES }
