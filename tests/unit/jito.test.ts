import { describe, it, expect } from "vitest"
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import {
  JITO_ENDPOINTS,
  JITO_TIP_ACCOUNTS,
  getRandomTipAccount,
  createTipInstruction,
  getTipInstruction,
  estimateTip,
  type JitoRegion,
} from "@/lib/solana/jito"

describe("Jito Integration", () => {
  describe("endpoints", () => {
    it("should have valid mainnet endpoints", () => {
      expect(JITO_ENDPOINTS.ny).toContain("mainnet.block-engine.jito.wtf")
      expect(JITO_ENDPOINTS.amsterdam).toContain("mainnet.block-engine.jito.wtf")
      expect(JITO_ENDPOINTS.frankfurt).toContain("mainnet.block-engine.jito.wtf")
      expect(JITO_ENDPOINTS.tokyo).toContain("mainnet.block-engine.jito.wtf")
      expect(JITO_ENDPOINTS.slc).toContain("mainnet.block-engine.jito.wtf")
    })

    it("should have all regions defined", () => {
      const regions: JitoRegion[] = ["ny", "amsterdam", "frankfurt", "tokyo", "slc"]
      regions.forEach(region => {
        expect(JITO_ENDPOINTS[region]).toBeDefined()
      })
    })
  })

  describe("tip accounts", () => {
    it("should have valid tip account addresses", () => {
      JITO_TIP_ACCOUNTS.forEach(account => {
        expect(() => new PublicKey(account)).not.toThrow()
        expect(account).toHaveLength(44)
      })
    })

    it("should have 8 tip accounts", () => {
      expect(JITO_TIP_ACCOUNTS).toHaveLength(8)
    })

    it("should return random tip account", () => {
      const accounts = new Set<string>()
      for (let i = 0; i < 100; i++) {
        accounts.add(getRandomTipAccount().toBase58())
      }
      // should use multiple different accounts
      expect(accounts.size).toBeGreaterThan(1)
    })

    it("should always return valid PublicKey", () => {
      for (let i = 0; i < 10; i++) {
        const tipAccount = getRandomTipAccount()
        expect(tipAccount).toBeInstanceOf(PublicKey)
        expect(JITO_TIP_ACCOUNTS).toContain(tipAccount.toBase58())
      }
    })
  })

  describe("tip instructions", () => {
    const payer = Keypair.generate().publicKey

    it("should create tip instruction with default amount", () => {
      const tipIx = createTipInstruction(payer)
      
      expect(tipIx.programId.equals(SystemProgram.programId)).toBe(true)
      expect(tipIx.keys).toHaveLength(2)
      expect(tipIx.keys[0].pubkey.equals(payer)).toBe(true)
      expect(tipIx.keys[0].isSigner).toBe(true)
      expect(tipIx.keys[0].isWritable).toBe(true)
    })

    it("should create tip instruction with custom amount", () => {
      const tipIx = createTipInstruction(payer, 0.001)
      expect(tipIx).toBeDefined()
    })

    it("should get tip instruction with lamports", () => {
      const lamports = 100000 // 0.0001 SOL
      const tipIx = getTipInstruction(payer, lamports)
      
      expect(tipIx.programId.equals(SystemProgram.programId)).toBe(true)
      expect(tipIx.keys[1].isWritable).toBe(true)
    })
  })

  describe("tip estimation", () => {
    it("should estimate low priority tip", () => {
      const tip = estimateTip("low")
      expect(tip).toBe(0.00005)
    })

    it("should estimate medium priority tip", () => {
      const tip = estimateTip("medium")
      expect(tip).toBe(0.0001)
    })

    it("should estimate high priority tip", () => {
      const tip = estimateTip("high")
      expect(tip).toBe(0.0005)
    })

    it("should estimate ultra priority tip", () => {
      const tip = estimateTip("ultra")
      expect(tip).toBe(0.001)
    })

    it("should have increasing tips by priority", () => {
      const low = estimateTip("low")
      const medium = estimateTip("medium")
      const high = estimateTip("high")
      const ultra = estimateTip("ultra")
      
      expect(medium).toBeGreaterThan(low)
      expect(high).toBeGreaterThan(medium)
      expect(ultra).toBeGreaterThan(high)
    })
  })

  describe("bundle status types", () => {
    it("should define valid bundle status structure", () => {
      const pendingStatus = {
        bundleId: "test-bundle-id",
        status: "pending" as const,
      }
      
      const landedStatus = {
        bundleId: "test-bundle-id",
        status: "landed" as const,
        landedSlot: 12345678,
      }
      
      const failedStatus = {
        bundleId: "test-bundle-id",
        status: "failed" as const,
        error: "simulation failed",
      }
      
      expect(pendingStatus.status).toBe("pending")
      expect(landedStatus.landedSlot).toBeDefined()
      expect(failedStatus.error).toBeDefined()
    })
  })
})
