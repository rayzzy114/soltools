import { NextRequest, NextResponse } from "next/server"
import { triggerEngine } from "@/lib/triggers/engine"
import type { TriggerCreateParams, TriggerUpdateParams, TriggerType } from "@/lib/triggers/types"

// GET - получить триггеры
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")
    const mintAddress = searchParams.get("mint")
    const walletAddress = searchParams.get("wallet")
    const status = searchParams.get("status")

    // получить один триггер по id
    if (id) {
      const trigger = triggerEngine.get(id)
      if (!trigger) {
        return NextResponse.json({ error: "trigger not found" }, { status: 404 })
      }
      return NextResponse.json(trigger)
    }

    // получить все триггеры с фильтрами
    let triggers = triggerEngine.getAll()

    if (mintAddress) {
      triggers = triggers.filter(t => t.mintAddress === mintAddress)
    }

    if (walletAddress) {
      triggers = triggers.filter(t => t.walletAddress === walletAddress)
    }

    if (status) {
      triggers = triggers.filter(t => t.status === status)
    }

    return NextResponse.json({
      triggers,
      count: triggers.length,
      active: triggers.filter(t => t.status === "active").length,
      engineRunning: triggerEngine.isActive(),
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST - создать триггер или управлять engine
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    switch (action) {
      case "create": {
        const { 
          mintAddress, 
          walletAddress, 
          walletSecretKey,
          type,
          condition,
          sellPercent,
          slippage,
          entryPrice,
          note,
        } = body

        if (!mintAddress || !walletAddress || !type || !condition || !sellPercent) {
          return NextResponse.json({ 
            error: "mintAddress, walletAddress, type, condition, sellPercent required" 
          }, { status: 400 })
        }

        const validTypes: TriggerType[] = ["take_profit", "stop_loss", "trailing_stop", "price_target", "time_based"]
        if (!validTypes.includes(type)) {
          return NextResponse.json({ error: `invalid type. valid: ${validTypes.join(", ")}` }, { status: 400 })
        }

        const params: TriggerCreateParams = {
          mintAddress,
          walletAddress,
          walletSecretKey,
          type,
          condition,
          sellPercent: parseFloat(sellPercent),
          slippage: slippage ? parseFloat(slippage) : undefined,
          entryPrice: entryPrice ? parseFloat(entryPrice) : undefined,
          note,
        }

        const trigger = triggerEngine.add(params)

        return NextResponse.json({ 
          success: true, 
          trigger,
          message: "trigger created",
        })
      }

      case "start_engine": {
        triggerEngine.start()
        return NextResponse.json({ 
          success: true, 
          running: triggerEngine.isActive(),
          message: "trigger engine started",
        })
      }

      case "stop_engine": {
        triggerEngine.stop()
        return NextResponse.json({ 
          success: true, 
          running: triggerEngine.isActive(),
          message: "trigger engine stopped",
        })
      }

      case "execute": {
        const { id } = body
        if (!id) {
          return NextResponse.json({ error: "id required" }, { status: 400 })
        }

        const result = await triggerEngine.execute(id)
        if (!result) {
          return NextResponse.json({ error: "trigger not found" }, { status: 404 })
        }

        return NextResponse.json({
          success: result.success,
          trigger: result.trigger,
          signature: result.signature,
          soldAmount: result.soldAmount,
          receivedSol: result.receivedSol,
          error: result.error,
        })
      }

      default:
        return NextResponse.json({ error: "invalid action" }, { status: 400 })
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// PUT - обновить триггер
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, ...params } = body

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }

    const updateParams: TriggerUpdateParams = {}

    if (params.condition) updateParams.condition = params.condition
    if (params.sellPercent) updateParams.sellPercent = parseFloat(params.sellPercent)
    if (params.slippage) updateParams.slippage = parseFloat(params.slippage)
    if (params.status) updateParams.status = params.status
    if (params.note !== undefined) updateParams.note = params.note

    const updated = triggerEngine.update(id, updateParams)

    if (!updated) {
      return NextResponse.json({ error: "trigger not found" }, { status: 404 })
    }

    return NextResponse.json({ 
      success: true, 
      trigger: updated,
      message: "trigger updated",
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// DELETE - удалить триггер
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }

    const removed = triggerEngine.remove(id)

    if (!removed) {
      return NextResponse.json({ error: "trigger not found" }, { status: 404 })
    }

    return NextResponse.json({ 
      success: true, 
      message: "trigger removed",
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
