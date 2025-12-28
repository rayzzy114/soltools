import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  AccountLayout,
} from "@solana/spl-token"
import bs58 from "bs58"
import { connection, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from "./config"
import { prisma } from "../prisma"

type GatherConfig = {
  mainSecret?: string
  buyerSecret?: string
  walletIds?: string[]
  groupIds?: string[]
  priorityFeeMicroLamports?: number
}

type TokenAccountDecoded = {
  pubkey: PublicKey
  accountInfo: ReturnType<typeof AccountLayout.decode>
}

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: "processed",
})

export async function executeGather(config: GatherConfig = {}): Promise<{ signatures: string[] }> {
  const signatures: string[] = []
  const walletIds = config.walletIds?.filter(Boolean) ?? []
  const groupIds = config.groupIds?.filter(Boolean) ?? []

  const where: any = { isActive: true }
  const orConditions: any[] = []
  if (walletIds.length) {
    orConditions.push({ id: { in: walletIds } })
  }
  if (groupIds.length) {
    orConditions.push({
      groups: {
        some: {
          groupId: { in: groupIds },
        },
      },
    })
  }
  if (orConditions.length) {
    where.OR = orConditions
  }

  const wallets = await prisma.wallet.findMany({
    where,
    select: { secretKey: true },
  })
  if (!wallets.length) throw new Error("no wallets provided")

  const mainSecret = config.mainSecret || process.env.GATHER_MAIN_SECRET
  if (!mainSecret) throw new Error("main secret missing")
  const mainKp = Keypair.fromSecretKey(bs58.decode(mainSecret))

  const buyerSecret = config.buyerSecret || process.env.GATHER_BUYER_SECRET
  const buyerKp = buyerSecret ? Keypair.fromSecretKey(bs58.decode(buyerSecret)) : null

  const walletKeypairs = wallets.map((w) => Keypair.fromSecretKey(bs58.decode(w.secretKey)))
  if (buyerKp) walletKeypairs.push(buyerKp)

  for (let idx = 0; idx < walletKeypairs.length; idx++) {
    const kp = walletKeypairs[idx]
    const ixs: TransactionInstruction[] = []

    // token accounts
    const tokenAccounts = await connection.getTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM_ID }, "confirmed")
    const accounts: TokenAccountDecoded[] = []
    for (const { pubkey, account } of tokenAccounts.value) {
      accounts.push({
        pubkey,
        programId: account.owner,
        accountInfo: AccountLayout.decode(account.data),
      })
    }

    for (const acc of accounts) {
      const baseAta = await getAssociatedTokenAddress(acc.accountInfo.mint, mainKp.publicKey)
      const tokenAccount = acc.pubkey
      const tokenBalance = (await connection.getTokenAccountBalance(tokenAccount)).value

      const tokenBalanceAfterSell = (await connection.getTokenAccountBalance(tokenAccount)).value
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(mainKp.publicKey, baseAta, mainKp.publicKey, acc.accountInfo.mint))
      if (tokenBalanceAfterSell.uiAmount && tokenBalanceAfterSell.uiAmount > 0) {
        ixs.push(
          createTransferCheckedInstruction(
            tokenAccount,
            acc.accountInfo.mint,
            baseAta,
            kp.publicKey,
            BigInt(tokenBalanceAfterSell.amount),
            tokenBalance.decimals,
          ),
        )
      }
      ixs.push(createCloseAccountInstruction(tokenAccount, mainKp.publicKey, kp.publicKey))
    }

    // transfer SOL
    const solBal = await connection.getBalance(kp.publicKey)
    if (solBal > 0) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: mainKp.publicKey,
          lamports: solBal,
        }),
      )
    }

    if (ixs.length) {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports ?? 220_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
        ...ixs,
      )
      tx.feePayer = mainKp.publicKey
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash

      const sig = await sendAndConfirmTransaction(connection, tx, [mainKp, kp], { commitment: "confirmed" })
      signatures.push(sig)
    }
  }

  return { signatures }
}

