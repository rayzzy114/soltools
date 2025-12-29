import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function GET() {
  try {
    const funders = await prisma.funderWallet.findMany({
      orderBy: { updatedAt: "desc" },
      take: 1,
    })
    return NextResponse.json({ funderWallet: funders[0] || null })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "failed to load funder wallet" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { publicKey, label } = body || {}
    if (!publicKey) {
      return NextResponse.json({ error: "publicKey required" }, { status: 400 })
    }

    const funderWallet = await prisma.funderWallet.upsert({
      where: { publicKey },
      update: { label: label || null, isActive: true },
      create: { publicKey, label: label || null, isActive: true },
    })

    return NextResponse.json({ funderWallet })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "failed to save funder wallet" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, publicKey } = body || {}
    if (!id && !publicKey) {
      return NextResponse.json({ error: "id or publicKey required" }, { status: 400 })
    }
    if (id) {
      await prisma.funderWallet.delete({ where: { id } })
    } else {
      await prisma.funderWallet.delete({ where: { publicKey } })
    }
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "failed to delete funder wallet" }, { status: 500 })
  }
}
