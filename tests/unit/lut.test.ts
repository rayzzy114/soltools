/**
 * Address Lookup Tables (LUT) Unit Tests
 */

import { describe, it, expect } from "vitest"
import { 
  PublicKey, 
  Keypair, 
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js"
import {
  KNOWN_ADDRESSES,
  extractAddresses,
  estimateSavings,
} from "@/lib/solana/lut"

describe("Address Lookup Tables", () => {
  // ═══════════════════════════════════════════════════════════════════
  // KNOWN ADDRESSES
  // ═══════════════════════════════════════════════════════════════════
  describe("Known Addresses", () => {
    it("should have correct pump.fun program ID", () => {
      expect(KNOWN_ADDRESSES.pumpFunProgram.toBase58()).toBe(
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
      )
    })

    it("should have correct pump.fun global", () => {
      expect(KNOWN_ADDRESSES.pumpFunGlobal.toBase58()).toBe(
        "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"
      )
    })

    it("should have correct pump.fun event authority", () => {
      expect(KNOWN_ADDRESSES.pumpFunEventAuthority.toBase58()).toBe(
        "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"
      )
    })

    it("should have correct pump.fun fee recipient", () => {
      expect(KNOWN_ADDRESSES.pumpFunFeeRecipient.toBase58()).toBe(
        "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
      )
    })

    it("should have correct system program", () => {
      expect(KNOWN_ADDRESSES.systemProgram.equals(SystemProgram.programId)).toBe(true)
    })

    it("should have correct token program", () => {
      expect(KNOWN_ADDRESSES.tokenProgram.toBase58()).toBe(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      )
    })

    it("should have correct associated token program", () => {
      expect(KNOWN_ADDRESSES.associatedTokenProgram.toBase58()).toBe(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
      )
    })

    it("should have correct rent sysvar", () => {
      expect(KNOWN_ADDRESSES.rent.toBase58()).toBe(
        "SysvarRent111111111111111111111111111111111"
      )
    })

    it("should have correct compute budget program", () => {
      expect(KNOWN_ADDRESSES.computeBudget.toBase58()).toBe(
        "ComputeBudget111111111111111111111111111111"
      )
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // extractAddresses
  // ═══════════════════════════════════════════════════════════════════
  describe("extractAddresses", () => {
    it("should extract all unique addresses from instructions", () => {
      const payer = Keypair.generate()
      const recipient = Keypair.generate()

      const instructions: TransactionInstruction[] = [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient.publicKey,
          lamports: 1000000,
        }),
      ]

      const addresses = extractAddresses(instructions)

      expect(addresses.length).toBe(3) // system program + payer + recipient
      expect(addresses.some(a => a.equals(SystemProgram.programId))).toBe(true)
      expect(addresses.some(a => a.equals(payer.publicKey))).toBe(true)
      expect(addresses.some(a => a.equals(recipient.publicKey))).toBe(true)
    })

    it("should deduplicate addresses", () => {
      const wallet = Keypair.generate()

      const instructions: TransactionInstruction[] = [
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: wallet.publicKey, // self transfer
          lamports: 1000000,
        }),
      ]

      const addresses = extractAddresses(instructions)

      expect(addresses.length).toBe(2) // system program + wallet (deduplicated)
    })

    it("should handle multiple instructions", () => {
      const w1 = Keypair.generate()
      const w2 = Keypair.generate()
      const w3 = Keypair.generate()

      const instructions: TransactionInstruction[] = [
        SystemProgram.transfer({
          fromPubkey: w1.publicKey,
          toPubkey: w2.publicKey,
          lamports: 1000,
        }),
        SystemProgram.transfer({
          fromPubkey: w2.publicKey,
          toPubkey: w3.publicKey,
          lamports: 1000,
        }),
      ]

      const addresses = extractAddresses(instructions)

      // system program + w1 + w2 + w3
      expect(addresses.length).toBe(4)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // estimateSavings
  // ═══════════════════════════════════════════════════════════════════
  describe("estimateSavings", () => {
    it("should calculate savings with no LUT", () => {
      const payer = Keypair.generate()
      const recipient = Keypair.generate()

      const instructions: TransactionInstruction[] = [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient.publicKey,
          lamports: 1000000,
        }),
      ]

      const result = estimateSavings(instructions, [])

      expect(result.withoutLut).toBe(3 * 32) // 3 addresses * 32 bytes
      expect(result.withLut).toBe(3 * 32) // no LUT = same size
      expect(result.saved).toBe(0)
      expect(result.percentage).toBe(0)
    })

    it("should calculate savings correctly with mock LUT", () => {
      // this would need a real LUT account to test properly
      // for now just verify the function exists and returns expected structure
      const instructions: TransactionInstruction[] = [
        SystemProgram.transfer({
          fromPubkey: Keypair.generate().publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000000,
        }),
      ]

      const result = estimateSavings(instructions, [])

      expect(result).toHaveProperty("withoutLut")
      expect(result).toHaveProperty("withLut")
      expect(result).toHaveProperty("saved")
      expect(result).toHaveProperty("percentage")
      expect(typeof result.withoutLut).toBe("number")
      expect(typeof result.percentage).toBe("number")
    })

    it("should handle empty instructions", () => {
      const result = estimateSavings([], [])

      expect(result.withoutLut).toBe(0)
      expect(result.withLut).toBe(0)
      expect(result.saved).toBe(0)
      expect(result.percentage).toBe(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // Edge Cases
  // ═══════════════════════════════════════════════════════════════════
  describe("Edge Cases", () => {
    it("should handle instruction with many keys", () => {
      const keys = Array(10).fill(0).map(() => ({
        pubkey: Keypair.generate().publicKey,
        isSigner: false,
        isWritable: true,
      }))

      const instruction: TransactionInstruction = {
        programId: SystemProgram.programId,
        keys,
        data: Buffer.alloc(0),
      }

      const addresses = extractAddresses([instruction])

      // 10 keys + 1 program
      expect(addresses.length).toBe(11)
    })

    it("should handle duplicate program IDs", () => {
      const payer = Keypair.generate()

      const instructions: TransactionInstruction[] = [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: payer.publicKey,
          lamports: 1000,
        }),
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: payer.publicKey,
          lamports: 2000,
        }),
      ]

      const addresses = extractAddresses(instructions)

      // should dedupe: system program + payer
      expect(addresses.length).toBe(2)
    })
  })
})
