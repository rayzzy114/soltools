import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

// GET - получить все группы или одну группу
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")
    const type = searchParams.get("type")

    if (id) {
      // получить одну группу с кошельками
      const group = await prisma.walletGroup.findUnique({
        where: { id },
        include: {
          wallets: {
            include: {
              wallet: true,
            },
          },
        },
      })

      if (!group) {
        return NextResponse.json({ error: "group not found" }, { status: 404 })
      }

      return NextResponse.json({
        group: {
          ...group,
          wallets: group.wallets.map((wg) => wg.wallet),
        },
      })
    }

    // получить все группы
    const where: any = {}
    if (type) {
      where.type = type
    }

    const groups = await prisma.walletGroup.findMany({
      where,
      include: {
        _count: {
          select: { wallets: true },
        },
      },
      orderBy: { createdAt: "desc" },
    })

    return NextResponse.json({ groups })
  } catch (error: any) {
    console.error("bundler groups error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST - создать группу или добавить кошельки
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    // создать группу
    if (action === "create") {
      const { name, description, type } = body
      if (!name) {
        return NextResponse.json({ error: "name required" }, { status: 400 })
      }

      const group = await prisma.walletGroup.create({
        data: {
          name,
          description: description || null,
          type: type || "custom",
        },
      })

      return NextResponse.json({ group })
    }

    // добавить кошельки в группу
    if (action === "add-wallets") {
      const { groupId, walletPublicKeys } = body
      if (!groupId || !walletPublicKeys || !Array.isArray(walletPublicKeys)) {
        return NextResponse.json(
          { error: "groupId and walletPublicKeys array required" },
          { status: 400 }
        )
      }

      // проверить что группа существует
      const group = await prisma.walletGroup.findUnique({
        where: { id: groupId },
      })
      if (!group) {
        return NextResponse.json({ error: "group not found" }, { status: 404 })
      }

      // найти кошельки по publicKey и получить их id
      const wallets = await prisma.wallet.findMany({
        where: {
          publicKey: { in: walletPublicKeys },
        },
      })

      // добавить кошельки в группу (skip duplicates)
      const added = []
      for (const wallet of wallets) {
        try {
          await prisma.walletGroupWallet.create({
            data: {
              groupId,
              walletId: wallet.id,
            },
          })
          added.push(wallet.publicKey)
        } catch {
          // уже существует, пропускаем
        }
      }

      return NextResponse.json({ added: added.length })
    }

    // удалить кошельки из группы
    if (action === "remove-wallets") {
      const { groupId, walletPublicKeys } = body
      if (!groupId || !walletPublicKeys || !Array.isArray(walletPublicKeys)) {
        return NextResponse.json(
          { error: "groupId and walletPublicKeys array required" },
          { status: 400 }
        )
      }

      // найти кошельки по publicKey
      const wallets = await prisma.wallet.findMany({
        where: {
          publicKey: { in: walletPublicKeys },
        },
      })

      const walletIds = wallets.map(w => w.id)

      await prisma.walletGroupWallet.deleteMany({
        where: {
          groupId,
          walletId: { in: walletIds },
        },
      })

      return NextResponse.json({ removed: walletIds.length })
    }

    return NextResponse.json({ error: "invalid action" }, { status: 400 })
  } catch (error: any) {
    console.error("bundler groups error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// PUT - обновить группу
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, name, description, type, isActive } = body

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }

    const group = await prisma.walletGroup.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(type && { type }),
        ...(isActive !== undefined && { isActive }),
      },
    })

    return NextResponse.json({ group })
  } catch (error: any) {
    console.error("bundler groups error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// DELETE - удалить группу
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }

    await prisma.walletGroup.delete({
      where: { id },
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("bundler groups error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
