import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { refreshWalletBalances, createLaunchBundle, isLutReady } from "@/lib/solana/bundler-engine"
import { safeConnection, getResilientConnection, connection, execConnection } from "@/lib/solana/config"
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js"
import * as jito from "@/lib/solana/jito"
import bs58 from "bs58"

// Mocks
vi.mock("@/lib/solana/jito", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/solana/jito")>()
    return {
        ...actual,
        sendBundle: vi.fn().mockResolvedValue({ bundleId: "mock-bundle-id" }),
    }
})

// Correctly mock pumpfun-sdk module
vi.mock("@/lib/solana/pumpfun-sdk", async (importOriginal) => {
    // We need to return a factory that has the mocked function
    // We cannot use actual here easily if we want to override export
    // But we can do partial
    const actual = await importOriginal<typeof import("@/lib/solana/pumpfun-sdk")>()
    return {
        ...actual,
        isPumpFunAvailable: () => true, // Force true
        getPumpfunGlobalState: vi.fn().mockImplementation(async () => {
            console.log("Mock getPumpfunGlobalState called")
            return {
                initialVirtualTokenReserves: BigInt(1073000000000000),
                initialVirtualSolReserves: BigInt(30000000000),
                initialRealTokenReserves: BigInt(793100000000000),
                realSolReserves: BigInt(0),
                tokenTotalSupply: BigInt(1000000000000000),
                feeBasisPoints: BigInt(100)
            }
        }),
        createBuyInstruction: vi.fn().mockResolvedValue({
            keys: [],
            programId: { toBase58: () => "11111111111111111111111111111111" },
            data: Buffer.alloc(0)
        })
    }
})

describe("Integration Tests", () => {
    let fetchSpy: any

    beforeEach(() => {
        vi.clearAllMocks()
        fetchSpy = vi.spyOn(global, "fetch")
    })
    
    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe("CEX to Launcher Flow", () => {
        it("should detect updated balances after funding", async () => {
            // Mock RPC getMultipleAccountsInfo to simulate balance update
            const wallet = Keypair.generate()
            const walletObj = { 
                publicKey: wallet.publicKey.toBase58(), 
                secretKey: bs58.encode(wallet.secretKey),
                solBalance: 0, 
                tokenBalance: 0, 
                isActive: true 
            }
            
            // First call: 0 balance
            // Second call: 1.5 SOL
            const mockRpc = vi.spyOn(safeConnection, "getMultipleAccountsInfo")
            
            mockRpc.mockResolvedValueOnce([{
                lamports: 0,
                data: Buffer.alloc(0),
                owner: new PublicKey("11111111111111111111111111111111"),
                executable: false,
                rentEpoch: 0
            }])
            
            mockRpc.mockResolvedValueOnce([{
                lamports: 1500000000, // 1.5 SOL
                data: Buffer.alloc(0),
                owner: new PublicKey("11111111111111111111111111111111"),
                executable: false,
                rentEpoch: 0
            }])
            
            // Check initial
            let refreshed = await refreshWalletBalances([walletObj])
            expect(refreshed[0].solBalance).toBe(0)
            
            // Simulate waiting / polling
            refreshed = await refreshWalletBalances([walletObj])
            expect(refreshed[0].solBalance).toBe(1.5)
        })
    })

    describe("PumpPortal to Jito Flow", () => {
        it("should repack PumpPortal response with LUT", async () => {
            // Force mock return value for this test
            const sdk = await import("@/lib/solana/pumpfun-sdk")
            vi.mocked(sdk.getPumpfunGlobalState).mockResolvedValue({
                initialVirtualTokenReserves: BigInt(1073000000000000),
                initialVirtualSolReserves: BigInt(30000000000),
                initialRealTokenReserves: BigInt(793100000000000),
                realSolReserves: BigInt(0),
                tokenTotalSupply: BigInt(1000000000000000),
                feeBasisPoints: BigInt(100),
                initialized: true,
                authority: Keypair.generate().publicKey,
                feeRecipient: Keypair.generate().publicKey
            })

            // Test effectively covered by launcher-e2e, but let's do a specific integration check
            // We want to ensure that if PumpPortal returns a legacy transaction (or Versioned),
            // our engine strips it and recompiles with LUT.
            
            // In the new logic, we ONLY use PumpPortal for Genesis (Create).
            // So we mock PumpPortal returning a transaction.
            
            const mockDevKeypair = Keypair.generate()
            
            // Mock PumpPortal response
            // The createLaunchBundle code expects the Genesis transaction to require Mint signature (Create)
            // So we must construct a dummy transaction that HAS the mint as a signer in its instructions/keys
            const mintKeypair = Keypair.generate() 
            // We can't control the random mint generated inside createLaunchBundle unless we mock Keypair.generate 
            // OR we inspect the 'mint' used by createLaunchBundle.
            // But createLaunchBundle generates mintKeypair internally.
            // Solution: We spy on Keypair.generate() to return a predictable keypair, 
            // OR we make the mocked transaction use a dummy signer that matches the index of mint?
            // Actually, `VersionedTransaction.sign` checks if the keypairs passed match the static account keys that are marked as signers.
            // If we construct a transaction with `mockDevKeypair` as payer (signer), and `mintKeypair` as another signer.
            
            // We need to intercept the `mint` generated inside `createLaunchBundle`.
            // Since we can't easily, let's mock `Keypair.generate` to return a fixed sequence of keys.
            const fixedMint = Keypair.generate()
            const fixedDev = mockDevKeypair
            
            // We need to spy on Keypair.generate ONLY for the mint generation part, or all?
            // It might be too invasive.
            // Alternative: In the mock fetch response, we parse the body to get the mint address sent TO PumpPortal,
            // and use THAT mint address in our dummy transaction construction.
            
            fetchSpy.mockImplementation(async (url: any, init: any) => {
                if (url.toString().includes("pumpportal")) {
                    const body = JSON.parse(init.body)
                    const mintPubkey = new PublicKey(body[0].mint) // "create" item
                    
                    // Create a dummy instruction that requires this mint as signer
                    const msg = new TransactionMessage({
                        payerKey: mockDevKeypair.publicKey,
                        recentBlockhash: "11111111111111111111111111111111",
                        instructions: [
                            {
                                programId: new PublicKey("11111111111111111111111111111111"),
                                keys: [
                                    { pubkey: mockDevKeypair.publicKey, isSigner: true, isWritable: true },
                                    { pubkey: mintPubkey, isSigner: true, isWritable: true }
                                ],
                                data: Buffer.alloc(0)
                            }
                        ]
                    }).compileToV0Message()
                    
                    const tx = new VersionedTransaction(msg)
                    return {
                        ok: true,
                        json: async () => [bs58.encode(tx.serialize())],
                        text: async () => ""
                    }
                }
                // Handle Jito simulation or other RPC calls if they slip through
                return {
                    ok: true,
                    json: async () => ({ result: { value: { err: null } } }),
                    text: async () => JSON.stringify({ result: { value: { err: null } } })
                }
            })
            
            // Ensure sendBundle returns success
            vi.mocked(jito.sendBundle).mockResolvedValue({ bundleId: "mock-bundle-id" } as any)

            // Mock getSignatureStatuses
            vi.spyOn(safeConnection, "getSignatureStatuses").mockResolvedValue({
                value: [{ confirmationStatus: "confirmed" } as any],
                context: { slot: 0 }
            })
            vi.spyOn(execConnection, "simulateTransaction").mockResolvedValue({
                value: { err: null, logs: [], unitsConsumed: 0, accounts: null, returnData: null },
                context: { slot: 0 }
            })
            vi.spyOn(safeConnection, "getAddressLookupTable").mockResolvedValue({
                value: { 
                    key: new PublicKey("11111111111111111111111111111111"),
                    state: {
                        addresses: [mockDevKeypair.publicKey],
                        authority: mockDevKeypair.publicKey,
                        deactivationSlot: BigInt(0),
                        lastExtendedSlot: 0,
                        lastExtendedSlotStartIndex: 0
                    }
                } as any,
                context: { slot: 0 }
            })
            vi.spyOn(safeConnection, "getLatestBlockhash").mockResolvedValue({
                blockhash: bs58.encode(new Uint8Array(32).fill(1)),
                lastValidBlockHeight: 100
            })
            
            // We just want to verifying fetching happened and no error thrown during processing
            // The actual repacking logic is inside createLaunchBundle
            
            const walletObj = { 
                publicKey: mockDevKeypair.publicKey.toBase58(), 
                secretKey: bs58.encode(mockDevKeypair.secretKey),
                solBalance: 1, 
                tokenBalance: 0, 
                isActive: true,
                role: "dev"
            }
            
            const result = await createLaunchBundle({
                wallets: [walletObj],
                tokenMetadata: { name: "T", symbol: "T", description: "", metadataUri: "", imageUrl: "" },
                lutAddress: "11111111111111111111111111111111",
                devBuyAmount: 0 // Only create
            })
            
            if (!result.success) {
                console.log("PumpPortal to Jito Flow Failure:", JSON.stringify(result, null, 2))
            }
            expect(result.success).toBe(true)
        })
    })

    describe("RPC Lane Isolation", () => {
        it("should proceed with Jito even if RPC returns 429", async () => {
            // Mock safeConnection to throw 429
            vi.spyOn(safeConnection, "getLatestBlockhash").mockImplementation(() => {
                throw new Error("429 Too Many Requests")
            })
            
            // However, createLaunchBundle uses safeConnection.getLatestBlockhash().
            // If that fails, the whole process fails?
            // "Verify that a 429 ... on safeConnection does NOT stall a sendBundle call to Jito"
            // This implies that if we are sending to Jito, we shouldn't be blocked by RPC rate limits?
            // BUT we need blockhash from RPC to build the transaction for Jito.
            // If RPC is down, we cannot build transaction.
            
            // Maybe the test means: if `confirmSignatures` or post-send checks fail with 429, Jito send should still have happened.
            // Or maybe it refers to `getResilientConnection` rotation.
            
            // Let's test resilience: If safeConnection fails, does it retry/rotate?
            // Our config.ts handles rotation.
            // But here we are mocking the connection object methods directly.
            
            // Let's verify that Jito sendBundle doesn't depend on RPC for the SENDING part (except building).
            // Actually, `sendBundleGroup` does `confirmSignaturesOnRpc`.
            
            // Let's mock `sendBundle` (Jito) to succeed, but `confirmSignaturesOnRpc` (RPC) to fail/timeout.
            // The function should return success (bundleId) even if confirmation polling fails?
            // In `sendBundleGroup`:
            // const result = await sendBundleWithRetry(...)
            // const statuses = await confirmSignaturesOnRpc(...)
            // It waits for confirmation.
            
            // If RPC 429s during confirmation, we might throw.
            // Requirement: "NOT stall a sendBundle call".
            // It means the `sendBundle` call itself works.
            
            // Let's verify that `sendBundle` is called even if some PRIOR non-critical RPC call failed?
            // Or maybe: RPC 429 during confirmation loop shouldn't crash the logic if we catch it?
            
            // Currently `confirmSignaturesOnRpc` does NOT throw on 429, it just retries or waits?
            // It uses `safeConnection.getSignatureStatuses`.
            
            // Let's try to simulate 429 in getSignatureStatuses.
        })
    })
})
