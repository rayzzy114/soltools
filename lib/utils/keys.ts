import { Keypair, PublicKey } from "@solana/web3.js"

export function generatePubkey44(): string {
  let keypair = Keypair.generate()
  while (keypair.publicKey.toBase58().length !== 44) {
    keypair = Keypair.generate()
  }
  return keypair.publicKey.toBase58()
}

export function isPubkey(str: string): boolean {
  try {
    const pk = new PublicKey(str)
    return pk.toBase58().length === 44
  } catch {
    return false
  }
}

