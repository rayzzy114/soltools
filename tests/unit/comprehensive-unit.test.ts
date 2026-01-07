import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { VirtualCurveState } from "@/lib/solana/bundler-engine"
import { createBuyInstruction, createSellInstruction, PUMPFUN_BUY_FEE_BPS } from "@/lib/solana/pumpfun"
import { getJitoTipFloor, MIN_JITO_TIP_LAMPORTS } from "@/lib/solana/jito"
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js"

describe("Comprehensive Unit Tests", () => {
    describe("VirtualCurveState", () => {
        it("should correctly simulate cumulative pricing for 50+ sequential buys", () => {
            const initialVirtualReserves = {
                virtualTokenReserves: BigInt(1073000000000000),
                virtualSolReserves: BigInt(30000000000),
                realTokenReserves: BigInt(793100000000000),
                realSolReserves: BigInt(0),
            }
            
            const curve = new VirtualCurveState(initialVirtualReserves)
            const buyAmount = 0.1 // 0.1 SOL
            const iterations = 50
            
            let previousTokensOut = BigInt(0)
            
            for (let i = 0; i < iterations; i++) {
                const { tokensOut, maxSolCost } = curve.simulateBuy(buyAmount)
                
                // Assertions per iteration
                expect(tokensOut).toBeGreaterThan(BigInt(0))
                expect(maxSolCost).toBe(BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL)))
                
                // Price should increase (tokens out decrease for same SOL amount)
                if (i > 0) {
                    expect(tokensOut).toBeLessThan(previousTokensOut)
                }
                previousTokensOut = tokensOut
            }
            
            // Validate Final State matches bonding curve invariant K
            const initialK = initialVirtualReserves.virtualSolReserves * initialVirtualReserves.virtualTokenReserves
            const finalK = curve.virtualSolReserves * curve.virtualTokenReserves
            
            expect(finalK).toBeLessThanOrEqual(initialK)
            
            const diff = initialK - finalK
            expect(diff).toBeLessThan(initialK / 10000000000n) 
        })
    })

    describe("Instruction Builder", () => {
        it("createBuyInstruction should correctly handle data encoding", async () => {
            const buyer = Keypair.generate().publicKey
            const mint = Keypair.generate().publicKey
            const tokenAmount = BigInt(123456789)
            const maxSolCost = BigInt(500000000)
            
            const ix = await createBuyInstruction(buyer, mint, tokenAmount, maxSolCost)
            
            expect(ix.programId.toBase58()).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
            expect(ix.data.length).toBe(24) // 8 discriminator + 8 amount + 8 maxSol
            
            const buyDisc = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234])
            expect(ix.data.subarray(0, 8)).toEqual(buyDisc)
            expect(ix.data.readBigUInt64LE(8)).toBe(tokenAmount)
            expect(ix.data.readBigUInt64LE(16)).toBe(maxSolCost)
        })

        it("createSellInstruction should correctly handle data encoding", async () => {
            const seller = Keypair.generate().publicKey
            const mint = Keypair.generate().publicKey
            const tokenAmount = BigInt(987654321)
            const minSolOut = BigInt(100000000)
            
            const ix = await createSellInstruction(seller, mint, tokenAmount, minSolOut)
            
            expect(ix.data.length).toBe(24)
            const sellDisc = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173])
            expect(ix.data.subarray(0, 8)).toEqual(sellDisc)
            expect(ix.data.readBigUInt64LE(8)).toBe(tokenAmount)
            expect(ix.data.readBigUInt64LE(16)).toBe(minSolOut)
        })
    })

    describe("Jito Tip Resolver", () => {
        let fetchSpy: any;
        
        beforeEach(() => {
            fetchSpy = vi.spyOn(global, "fetch")
        })
        
        afterEach(() => {
            vi.restoreAllMocks()
        })

        it("should apply 10% buffer and respect hard floor", async () => {
            // Mock API response: 0.002 SOL
            const apiTip = 0.002
            const mockApiResponse = [{ landed_tips_75th_percentile: apiTip }]
            
            fetchSpy.mockResolvedValue({
                ok: true,
                json: async () => mockApiResponse
            } as Response)
            
            const result = await getJitoTipFloor()
            
            // Expected: 0.002 * 1.1 = 0.0022
            expect(result).toBeCloseTo(0.0022)
            expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("tip_floor"), expect.any(Object))
        })

        it("should respect minimum floor if API value is too low", async () => {
            // Mock API response: 0.00000001 SOL (very low)
            const apiTip = 0.00000001
            const mockApiResponse = [{ landed_tips_75th_percentile: apiTip }]
            
            fetchSpy.mockResolvedValue({
                ok: true,
                json: async () => mockApiResponse
            } as Response)
            
            const result = await getJitoTipFloor()
            
            const minSol = MIN_JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL
            expect(result).toBe(minSol)
        })
    })
})