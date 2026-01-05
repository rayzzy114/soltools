import {
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
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
import { connection } from "./config"
import { prisma } from "../prisma"

type GatherConfig = {
  mainAddress?: string
  buyerAddress?: string
  walletIds?: string[]
  groupIds?: string[]
  priorityFeeMicroLamports?: number
}

type TokenAccountDecoded = {
  pubkey: PublicKey
  accountInfo: ReturnType<typeof AccountLayout.decode>
}

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

  const mainAddress = config.mainAddress || process.env.GATHER_MAIN_ADDRESS
  let mainKp: Keypair
  if (mainAddress) {
    const mainWallet = await prisma.wallet.findUnique({
      where: { publicKey: mainAddress },
      select: { publicKey: true, secretKey: true },
    })
    if (!mainWallet?.secretKey) throw new Error("main wallet missing secret key")
    mainKp = Keypair.fromSecretKey(bs58.decode(mainWallet.secretKey))
  } else if (process.env.GATHER_MAIN_SECRET) {
    mainKp = Keypair.fromSecretKey(bs58.decode(process.env.GATHER_MAIN_SECRET))
  } else {
    throw new Error("main wallet not configured")
  }

  const buyerAddress = config.buyerAddress || process.env.GATHER_BUYER_ADDRESS
  let buyerKp: Keypair | null = null
  if (buyerAddress) {
    const buyerWallet = await prisma.wallet.findUnique({
      where: { publicKey: buyerAddress },
      select: { publicKey: true, secretKey: true },
    })
    if (!buyerWallet?.secretKey) throw new Error("buyer wallet missing secret key")
    buyerKp = Keypair.fromSecretKey(bs58.decode(buyerWallet.secretKey))
  } else if (process.env.GATHER_BUYER_SECRET) {
    buyerKp = Keypair.fromSecretKey(bs58.decode(process.env.GATHER_BUYER_SECRET))
  }

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
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      const message = new TransactionMessage({
        payerKey: mainKp.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports ?? 220_000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
          ...ixs,
        ],
      }).compileToV0Message()
      const tx = new VersionedTransaction(message)
      tx.sign([mainKp, kp])

      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")
      signatures.push(sig)
    }
  }

  return { signatures }
}

