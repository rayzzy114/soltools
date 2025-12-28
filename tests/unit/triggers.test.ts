/**
 * Trigger Engine Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { Keypair } from "@solana/web3.js"
import bs58 from "bs58"
import {
  createTrigger,
  updateTrigger,
  checkTrigger,
  TriggerEngine,
} from "@/lib/triggers/engine"
import type { Trigger, TriggerCreateParams } from "@/lib/triggers/types"

describe("Trigger Engine", () => {
  const mockMint = Keypair.generate().publicKey.toBase58()
  const mockWallet = Keypair.generate()
  const mockWalletAddress = mockWallet.publicKey.toBase58()
  const mockSecretKey = bs58.encode(mockWallet.secretKey)

  // ═══════════════════════════════════════════════════════════════════
  // createTrigger
  // ═══════════════════════════════════════════════════════════════════
  describe("createTrigger", () => {
    it("should create take_profit trigger", () => {
      const params: TriggerCreateParams = {
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
        entryPrice: 0.00001,
      }

      const trigger = createTrigger(params)

      expect(trigger.id).toMatch(/^trig-/)
      expect(trigger.type).toBe("take_profit")
      expect(trigger.status).toBe("active")
      expect(trigger.condition.profitPercent).toBe(50)
      expect(trigger.sellPercent).toBe(100)
      expect(trigger.slippage).toBe(10) // default
    })

    it("should create stop_loss trigger", () => {
      const trigger = createTrigger({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "stop_loss",
        condition: { lossPercent: 20 },
        sellPercent: 100,
      })

      expect(trigger.type).toBe("stop_loss")
      expect(trigger.condition.lossPercent).toBe(20)
    })

    it("should create trailing_stop trigger", () => {
      const trigger = createTrigger({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "trailing_stop",
        condition: { trailPercent: 15 },
        sellPercent: 100,
        entryPrice: 0.00001,
      })

      expect(trigger.type).toBe("trailing_stop")
      expect(trigger.condition.trailPercent).toBe(15)
    })

    it("should create price_target trigger", () => {
      const trigger = createTrigger({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "price_target",
        condition: { targetPrice: 0.0001, priceDirection: "above" },
        sellPercent: 50,
      })

      expect(trigger.type).toBe("price_target")
      expect(trigger.condition.targetPrice).toBe(0.0001)
      expect(trigger.condition.priceDirection).toBe("above")
    })

    it("should create time_based trigger", () => {
      const trigger = createTrigger({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "time_based",
        condition: { triggerAfterMinutes: 30 },
        sellPercent: 100,
      })

      expect(trigger.type).toBe("time_based")
      expect(trigger.condition.triggerAfterMinutes).toBe(30)
    })

    it("should accept custom slippage", () => {
      const trigger = createTrigger({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
        slippage: 25,
      })

      expect(trigger.slippage).toBe(25)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // updateTrigger
  // ═══════════════════════════════════════════════════════════════════
  describe("updateTrigger", () => {
    it("should update trigger condition", () => {
      const trigger = createTrigger({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
      })

      const updated = updateTrigger(trigger, {
        condition: { profitPercent: 100 },
      })

      expect(updated.condition.profitPercent).toBe(100)
      // updatedAt should be >= createdAt (may be same ms in fast execution)
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(trigger.updatedAt.getTime())
    })

    it("should update trigger status", () => {
      const trigger = createTrigger({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "stop_loss",
        condition: { lossPercent: 20 },
        sellPercent: 100,
      })

      const updated = updateTrigger(trigger, { status: "paused" })

      expect(updated.status).toBe("paused")
    })

    it("should update sellPercent", () => {
      const trigger = createTrigger({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
      })

      const updated = updateTrigger(trigger, { sellPercent: 50 })

      expect(updated.sellPercent).toBe(50)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // checkTrigger
  // ═══════════════════════════════════════════════════════════════════
  describe("checkTrigger", () => {
    describe("take_profit", () => {
      it("should trigger when profit target reached", () => {
        const trigger = createTrigger({
          mintAddress: mockMint,
          walletAddress: mockWalletAddress,
          type: "take_profit",
          condition: { profitPercent: 50 },
          sellPercent: 100,
          entryPrice: 0.00001,
        })

        // price up 60%
        const result = checkTrigger(trigger, 0.000016)

        expect(result.triggered).toBe(true)
        expect(result.shouldExecute).toBe(true)
        expect(result.priceChange).toBeCloseTo(60, 0)
      })

      it("should not trigger below target", () => {
        const trigger = createTrigger({
          mintAddress: mockMint,
          walletAddress: mockWalletAddress,
          type: "take_profit",
          condition: { profitPercent: 50 },
          sellPercent: 100,
          entryPrice: 0.00001,
        })

        // price up 30%
        const result = checkTrigger(trigger, 0.000013)

        expect(result.triggered).toBe(false)
        expect(result.shouldExecute).toBe(false)
      })
    })

    describe("stop_loss", () => {
      it("should trigger when loss threshold reached", () => {
        const trigger = createTrigger({
          mintAddress: mockMint,
          walletAddress: mockWalletAddress,
          type: "stop_loss",
          condition: { lossPercent: 20 },
          sellPercent: 100,
          entryPrice: 0.00001,
        })

        // price down 25%
        const result = checkTrigger(trigger, 0.0000075)

        expect(result.triggered).toBe(true)
        expect(result.shouldExecute).toBe(true)
      })

      it("should not trigger above threshold", () => {
        const trigger = createTrigger({
          mintAddress: mockMint,
          walletAddress: mockWalletAddress,
          type: "stop_loss",
          condition: { lossPercent: 20 },
          sellPercent: 100,
          entryPrice: 0.00001,
        })

        // price down 10%
        const result = checkTrigger(trigger, 0.000009)

        expect(result.triggered).toBe(false)
      })
    })

    describe("trailing_stop", () => {
      it("should trigger on drop from high", () => {
        const trigger = createTrigger({
          mintAddress: mockMint,
          walletAddress: mockWalletAddress,
          type: "trailing_stop",
          condition: { trailPercent: 15 },
          sellPercent: 100,
          entryPrice: 0.00001,
        })
        
        // set highest price
        ;(trigger as any).highestPrice = 0.00002

        // 20% drop from high
        const result = checkTrigger(trigger, 0.000016)

        expect(result.triggered).toBe(true)
      })

      it("should not trigger if price still rising", () => {
        const trigger = createTrigger({
          mintAddress: mockMint,
          walletAddress: mockWalletAddress,
          type: "trailing_stop",
          condition: { trailPercent: 15 },
          sellPercent: 100,
          entryPrice: 0.00001,
        })
        ;(trigger as any).highestPrice = 0.00001

        // price still going up
        const result = checkTrigger(trigger, 0.000015)

        expect(result.triggered).toBe(false)
      })
    })

    describe("price_target", () => {
      it("should trigger when price above target", () => {
        const trigger = createTrigger({
          mintAddress: mockMint,
          walletAddress: mockWalletAddress,
          type: "price_target",
          condition: { targetPrice: 0.0001, priceDirection: "above" },
          sellPercent: 100,
        })

        const result = checkTrigger(trigger, 0.00012)

        expect(result.triggered).toBe(true)
      })

      it("should trigger when price below target", () => {
        const trigger = createTrigger({
          mintAddress: mockMint,
          walletAddress: mockWalletAddress,
          type: "price_target",
          condition: { targetPrice: 0.00005, priceDirection: "below" },
          sellPercent: 100,
        })

        const result = checkTrigger(trigger, 0.00003)

        expect(result.triggered).toBe(true)
      })
    })

    describe("time_based", () => {
      it("should trigger after elapsed time", () => {
        const trigger = createTrigger({
          mintAddress: mockMint,
          walletAddress: mockWalletAddress,
          type: "time_based",
          condition: { triggerAfterMinutes: 1 }, // 1 minute
          sellPercent: 100,
        })
        
        // set createdAt to 2 minutes ago so trigger should fire
        trigger.createdAt = new Date(Date.now() - 120000)

        const result = checkTrigger(trigger, 0.00001)

        expect(result.triggered).toBe(true)
      })
    })

    it("should not trigger if status is not active", () => {
      const trigger = createTrigger({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 10 },
        sellPercent: 100,
        entryPrice: 0.00001,
      })
      
      ;(trigger as any).status = "triggered"

      const result = checkTrigger(trigger, 0.00002)

      expect(result.triggered).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════
  // TriggerEngine class
  // ═══════════════════════════════════════════════════════════════════
  describe("TriggerEngine", () => {
    let engine: TriggerEngine

    beforeEach(() => {
      engine = new TriggerEngine({ checkIntervalMs: 1000 })
    })

    it("should add triggers", () => {
      const trigger = engine.add({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
      })

      expect(engine.get(trigger.id)).toBeDefined()
      expect(engine.getAll().length).toBe(1)
    })

    it("should update triggers", () => {
      const trigger = engine.add({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
      })

      const updated = engine.update(trigger.id, { sellPercent: 50 })

      expect(updated?.sellPercent).toBe(50)
    })

    it("should remove triggers", () => {
      const trigger = engine.add({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "stop_loss",
        condition: { lossPercent: 20 },
        sellPercent: 100,
      })

      const removed = engine.remove(trigger.id)

      expect(removed).toBe(true)
      expect(engine.get(trigger.id)).toBeUndefined()
    })

    it("should filter by mint address", () => {
      const mint2 = Keypair.generate().publicKey.toBase58()

      engine.add({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
      })

      engine.add({
        mintAddress: mint2,
        walletAddress: mockWalletAddress,
        type: "stop_loss",
        condition: { lossPercent: 20 },
        sellPercent: 100,
      })

      expect(engine.getByMint(mockMint).length).toBe(1)
      expect(engine.getByMint(mint2).length).toBe(1)
    })

    it("should filter by wallet address", () => {
      const wallet2 = Keypair.generate().publicKey.toBase58()

      engine.add({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
      })

      engine.add({
        mintAddress: mockMint,
        walletAddress: wallet2,
        type: "stop_loss",
        condition: { lossPercent: 20 },
        sellPercent: 100,
      })

      expect(engine.getByWallet(mockWalletAddress).length).toBe(1)
      expect(engine.getByWallet(wallet2).length).toBe(1)
    })

    it("should get only active triggers", () => {
      const t1 = engine.add({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
      })

      engine.add({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "stop_loss",
        condition: { lossPercent: 20 },
        sellPercent: 100,
      })

      // mark first as triggered
      engine.update(t1.id, { status: "triggered" })

      expect(engine.getActive().length).toBe(1)
      expect(engine.getAll().length).toBe(2)
    })

    it("should emit events", () => {
      const events: any[] = []
      engine.on((event) => events.push(event))

      engine.add({
        mintAddress: mockMint,
        walletAddress: mockWalletAddress,
        type: "take_profit",
        condition: { profitPercent: 50 },
        sellPercent: 100,
      })

      expect(events.length).toBe(1)
      expect(events[0].type).toBe("trigger_created")
    })

    it("should start and stop", () => {
      expect(engine.isActive()).toBe(false)

      engine.start()
      expect(engine.isActive()).toBe(true)

      engine.stop()
      expect(engine.isActive()).toBe(false)
    })
  })
})
