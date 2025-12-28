import { NextRequest, NextResponse } from "next/server"
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Connection, SystemProgram, Transaction } from "@solana/web3.js"
import bs58 from "bs58"
import {
  createSimulatedToken,
  simulateBuy,
  simulateSell,
  getSimulatedTokenBalance,
  getSimulatedTokenStats,
  clearSimulatedTokens,
} from "@/lib/solana/pumpfun-simulator"
import { RPC_ENDPOINT, SOLANA_NETWORK } from "@/lib/solana/config"

// POST - запуск теста
export async function POST(request: NextRequest) {
  try {
    if (SOLANA_NETWORK !== "devnet") {
      return NextResponse.json(
        { error: "simulator работает только на devnet" },
        { status: 400 }
      )
    }

    const body = await request.json()
    const { action, creatorSecretKey } = body

    if (action === "start-test") {
      const connection = new Connection(RPC_ENDPOINT, "confirmed")

      // парсим creator secret key
      let creator: Keypair
      if (creatorSecretKey) {
        try {
          const secretKey = typeof creatorSecretKey === "string"
            ? bs58.decode(creatorSecretKey)
            : Uint8Array.from(creatorSecretKey)
          creator = Keypair.fromSecretKey(secretKey)
        } catch (error) {
          return NextResponse.json(
            { error: "неверный формат secret key" },
            { status: 400 }
          )
        }
      } else {
        creator = Keypair.generate()
      }

      // проверяем баланс creator
      const creatorBalance = await connection.getBalance(creator.publicKey)
      const creatorBalanceSOL = creatorBalance / LAMPORTS_PER_SOL
      
      // рассчитываем сумму для перевода (оставляем запас на комиссии)
      const reserveForFees = 0.1 * LAMPORTS_PER_SOL // резерв на комиссии
      const availableBalance = creatorBalance - reserveForFees
      const transferAmountPerBuyer = Math.floor(availableBalance / 2.5) // делим на 2.5 чтобы точно хватило
      
      if (creatorBalanceSOL < 0.5) {
        return NextResponse.json(
          { error: `недостаточно SOL на creator кошельке. Текущий баланс: ${creatorBalanceSOL.toFixed(4)} SOL. Нужно минимум 0.5 SOL` },
          { status: 400 }
        )
      }

      // создаем buyer кошельки
      const buyer1 = Keypair.generate()
      const buyer2 = Keypair.generate()

      // переводим SOL на buyer кошельки (меньше, чтобы хватило на оба перевода)
      const transferAmount = transferAmountPerBuyer
      try {
        const transfer1 = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: creator.publicKey,
            toPubkey: buyer1.publicKey,
            lamports: transferAmount,
          })
        )
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
        transfer1.recentBlockhash = blockhash
        transfer1.feePayer = creator.publicKey
        transfer1.sign(creator)
        const sig1 = await connection.sendRawTransaction(transfer1.serialize())
        await connection.confirmTransaction(
          { signature: sig1, blockhash, lastValidBlockHeight },
          "confirmed"
        )

        const transfer2 = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: creator.publicKey,
            toPubkey: buyer2.publicKey,
            lamports: transferAmount,
          })
        )
        transfer2.recentBlockhash = blockhash
        transfer2.feePayer = creator.publicKey
        transfer2.sign(creator)
        const sig2 = await connection.sendRawTransaction(transfer2.serialize())
        await connection.confirmTransaction(
          { signature: sig2, blockhash, lastValidBlockHeight },
          "confirmed"
        )
      } catch (error: any) {
        return NextResponse.json(
          { error: `ошибка перевода SOL: ${error.message}` },
          { status: 500 }
        )
      }

      // создаем токен
      const { mint, signature: createSig } = await createSimulatedToken(
        creator,
        "Test Token",
        "TEST",
        "https://example.com/metadata.json"
      )

      return NextResponse.json({
        success: true,
        creator: creator.publicKey.toBase58(),
        buyer1: buyer1.publicKey.toBase58(),
        buyer2: buyer2.publicKey.toBase58(),
        mint: mint.toBase58(),
        createSignature: createSig,
        buyer1SecretKey: bs58.encode(buyer1.secretKey),
        buyer2SecretKey: bs58.encode(buyer2.secretKey),
      })
    }

    if (action === "buy") {
      const { buyerSecretKey, mint, solAmount } = body
      if (!buyerSecretKey || !mint || !solAmount) {
        return NextResponse.json(
          { error: "требуются buyerSecretKey, mint, solAmount" },
          { status: 400 }
        )
      }

      const connection = new Connection(RPC_ENDPOINT, "confirmed")
      const buyer = Keypair.fromSecretKey(bs58.decode(buyerSecretKey))
      const mintPubkey = new PublicKey(mint)

      const result = await simulateBuy(buyer, mintPubkey, solAmount)
      const stats = getSimulatedTokenStats(mintPubkey)

      return NextResponse.json({
        success: true,
        tokensOut: result.tokensOut.toString(),
        solSpent: result.solSpent ? result.solSpent.toString() : (solAmount * LAMPORTS_PER_SOL).toString(),
        newPrice: stats?.currentPrice || 0,
        stats: stats ? {
          ...stats,
          realSolReserves: stats.realSolReserves.toString(),
          realTokenReserves: stats.realTokenReserves.toString(),
          virtualSolReserves: stats.virtualSolReserves.toString(),
          virtualTokenReserves: stats.virtualTokenReserves.toString(),
        } : null,
      })
    }

    if (action === "sell") {
      const { buyerSecretKey, mint, tokenAmount } = body
      if (!buyerSecretKey || !mint || !tokenAmount) {
        return NextResponse.json(
          { error: "требуются buyerSecretKey, mint, tokenAmount" },
          { status: 400 }
        )
      }

      const connection = new Connection(RPC_ENDPOINT, "confirmed")
      const buyer = Keypair.fromSecretKey(bs58.decode(buyerSecretKey))
      const mintPubkey = new PublicKey(mint)

      const result = await simulateSell(buyer, mintPubkey, BigInt(tokenAmount))
      const stats = getSimulatedTokenStats(mintPubkey)

      return NextResponse.json({
        success: true,
        solOut: result.solOut.toString(),
        tokenAmount: tokenAmount,
        newPrice: stats?.currentPrice || 0,
        stats: stats ? {
          ...stats,
          realSolReserves: stats.realSolReserves.toString(),
          realTokenReserves: stats.realTokenReserves.toString(),
          virtualSolReserves: stats.virtualSolReserves.toString(),
          virtualTokenReserves: stats.virtualTokenReserves.toString(),
        } : null,
      })
    }

    if (action === "get-stats") {
      const { mint } = body
      if (!mint) {
        return NextResponse.json(
          { error: "требуется mint" },
          { status: 400 }
        )
      }

      const mintPubkey = new PublicKey(mint)
      const stats = getSimulatedTokenStats(mintPubkey)
      const balance1 = body.buyer1SecretKey
        ? await getSimulatedTokenBalance(
            Keypair.fromSecretKey(bs58.decode(body.buyer1SecretKey)).publicKey,
            mintPubkey
          )
        : null
      const balance2 = body.buyer2SecretKey
        ? await getSimulatedTokenBalance(
            Keypair.fromSecretKey(bs58.decode(body.buyer2SecretKey)).publicKey,
            mintPubkey
          )
        : null

      return NextResponse.json({
        success: true,
        stats: stats ? {
          ...stats,
          realSolReserves: stats.realSolReserves.toString(),
          realTokenReserves: stats.realTokenReserves.toString(),
          virtualSolReserves: stats.virtualSolReserves.toString(),
          virtualTokenReserves: stats.virtualTokenReserves.toString(),
        } : null,
        balance1: balance1 ? {
          balance: balance1.balance.toString(),
          uiBalance: balance1.uiBalance,
        } : null,
        balance2: balance2 ? {
          balance: balance2.balance.toString(),
          uiBalance: balance2.uiBalance,
        } : null,
      })
    }

    if (action === "clear") {
      clearSimulatedTokens()
      return NextResponse.json({ success: true })
    }

    return NextResponse.json(
      { error: "неизвестное действие" },
      { status: 400 }
    )
  } catch (error: any) {
    console.error("devnet simulator error:", error)
    return NextResponse.json(
      { error: error.message || "internal server error" },
      { status: 500 }
    )
  }
}
