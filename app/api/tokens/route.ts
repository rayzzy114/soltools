import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { PublicKey, Keypair } from "@solana/web3.js"
import { buildCreateTokenTransaction, isPumpFunAvailable } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { RPC_ENDPOINT } from "@/lib/solana/config"
import { connection } from "@/lib/solana/config"
import { PUMPFUN_PROGRAM_ID } from "@/lib/solana/pumpfun-sdk"
import bs58 from "bs58"
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults"
import { fetchMetadata, findMetadataPda } from "@metaplex-foundation/mpl-token-metadata"
import { publicKey } from "@metaplex-foundation/umi"

const HYDRATE_COOLDOWN_MS = 10 * 60 * 1000
const HYDRATE_MAX_TOKENS_PER_RUN = 2
const HYDRATE_SIGNATURE_LIMIT = 5
let lastHydrateAt = 0

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const trash = searchParams.get("trash") === "true"
    const tokens = await prisma.token.findMany({
      where: trash ? { deletedAt: { not: null } } : { deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        transactions: {
          where: { status: "confirmed" },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    })

    // Attempt to hydrate placeholder name/symbol from pump.fun so UI doesn't show mint slices.
    // Common placeholder patterns: name == mint.slice(0,6) or symbol == mint.slice(0,4).
    const isPlaceholder = (t: any) => {
      const mint = String(t?.mintAddress || "")
      const name = String(t?.name || "")
      const symbol = String(t?.symbol || "")
      if (!mint) return false
      if (!name || !symbol) return true
      if (name === mint.slice(0, 6)) return true
      if (symbol === mint.slice(0, 4)) return true
      return false
    }

    const candidates = trash ? [] : tokens.filter(isPlaceholder).slice(0, HYDRATE_MAX_TOKENS_PER_RUN)

    const now = Date.now()
    if (candidates.length && now - lastHydrateAt > HYDRATE_COOLDOWN_MS) {
      lastHydrateAt = now
      const mainnetRpc = RPC_ENDPOINT || "https://api.mainnet-beta.solana.com"
      const devnetRpc = "https://api.devnet.solana.com"
      const umiMainnet = createUmi(mainnetRpc)
      const umiDevnet = createUmi(devnetRpc)

      const parseCreateIxData = (buf: Buffer): null | { name: string; symbol: string; uri: string } => {
        try {
          if (!buf || buf.length < 8 + 4 + 1 + 4 + 1 + 4 + 1 + 32) return null
          let offset = 8 // skip discriminator
          const nameLen = buf.readUInt32LE(offset)
          offset += 4
          if (nameLen <= 0 || nameLen > 64 || offset + nameLen > buf.length) return null
          const name = buf.slice(offset, offset + nameLen).toString("utf8").replace(/\0/g, "").trim()
          offset += nameLen

          const symbolLen = buf.readUInt32LE(offset)
          offset += 4
          if (symbolLen <= 0 || symbolLen > 32 || offset + symbolLen > buf.length) return null
          const symbol = buf.slice(offset, offset + symbolLen).toString("utf8").replace(/\0/g, "").trim()
          offset += symbolLen

          const uriLen = buf.readUInt32LE(offset)
          offset += 4
          if (uriLen <= 0 || uriLen > 300 || offset + uriLen > buf.length) return null
          const uri = buf.slice(offset, offset + uriLen).toString("utf8").replace(/\0/g, "").trim()
          offset += uriLen

          // creator pubkey follows, ensure present
          if (buf.length - offset < 32) return null
          if (!name || !symbol || !uri) return null
          return { name, symbol, uri }
        } catch {
          return null
        }
      }

      const fetchFromCreateTx = async (
        mintAddr: string
      ): Promise<null | { name: string; symbol: string; uri: string; signature?: string }> => {
        try {
          const mintPk = new PublicKey(mintAddr)
          const sigs = await connection.getSignaturesForAddress(mintPk, { limit: HYDRATE_SIGNATURE_LIMIT })
          for (const s of sigs) {
            if (!s?.signature) continue
            const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
            if (!tx?.transaction) continue
            const msg: any = (tx.transaction as any).message
            const keys: any[] = msg?.accountKeys || []
            const programIndex = keys.findIndex((k) => {
              try {
                const pk = typeof k === "string" ? new PublicKey(k) : k
                return pk.equals(PUMPFUN_PROGRAM_ID)
              } catch {
                return false
              }
            })
            if (programIndex === -1) continue
            const mintIndex = keys.findIndex((k) => {
              try {
                const pk = typeof k === "string" ? new PublicKey(k) : k
                return pk.equals(mintPk)
              } catch {
                return false
              }
            })
            if (mintIndex === -1) continue
            const ixes: any[] = msg?.instructions || []
            for (const ix of ixes) {
              if (ix?.programIdIndex !== programIndex) continue
              const accounts: number[] = ix?.accounts || []
              if (!accounts.length) continue
              // pump.fun create instruction uses mint as first account
              if (accounts[0] !== mintIndex) continue
              const dataB58: string = ix?.data || ""
              if (!dataB58) continue
              let raw: Buffer | null = null
              try {
                raw = Buffer.from(bs58.decode(dataB58))
              } catch {
                raw = null
              }
              if (!raw) continue
              const parsed = parseCreateIxData(raw)
              if (!parsed) continue
              return { ...parsed, signature: s.signature }
            }
          }
          return null
        } catch (e: any) {
          return null
        }
      }

      const fetchPumpFun = async (mintAddr: string): Promise<null | { name: string; symbol: string; description?: string; imageUrl?: string; creatorWallet?: string }> => {
        try {
          const url = `https://frontend-api.pump.fun/coins/${mintAddr}`
          const res = await fetch(url, {
            cache: "no-store",
            headers: {
              "user-agent": "panel/1.0",
              accept: "application/json",
              referer: "https://pump.fun",
            },
          })
          if (!res.ok) return null
          const data: any = await res.json().catch(() => null)
          if (!data) return null
          const name = String(data?.name || "").trim()
          const symbol = String(data?.symbol || "").trim()
          if (!name || !symbol) return null
          return {
            name,
            symbol,
            description: String(data?.description || "").trim() || undefined,
            imageUrl: String(data?.image_uri || "").trim() || undefined,
            creatorWallet: String(data?.creator || "").trim() || undefined,
          }
        } catch (e: any) {
          return null
        }
      }

      const fetchOnChain = async (umi: any, mintAddr: string, rpc: string): Promise<null | { name: string; symbol: string; uri?: string; usedRpc: string }> => {
        const mintPk = publicKey(mintAddr)
        const mintAcc = await umi.rpc.getAccount(mintPk)
        if (!mintAcc.exists) return null
        const metadataPda = findMetadataPda(umi, { mint: mintPk })
        const metadataAcc = await umi.rpc.getAccount(metadataPda)
        if (!metadataAcc.exists) {
          return null
        }
        const md = await fetchMetadata(umi, metadataPda)
        const name = String(md?.name || "").replace(/\0/g, "").trim()
        const symbol = String(md?.symbol || "").replace(/\0/g, "").trim()
        const uri = String(md?.uri || "").replace(/\0/g, "").trim()
        if (!name || !symbol) return null
        return { name, symbol, uri: uri || undefined, usedRpc: rpc }
      }

      await Promise.all(
        candidates.map(async (t: any) => {
          const mintAddr = String(t.mintAddress || "")
          if (!mintAddr) return
          try {
            // try pump.fun first (fast path), then on-chain mainnet, then on-chain devnet
            const pump = await fetchPumpFun(mintAddr)
            let name: string | undefined
            let symbol: string | undefined
            let desc: string | undefined
            let img: string | undefined

            if (pump) {
              name = pump.name
              symbol = pump.symbol
              desc = pump.description
              img = pump.imageUrl
            } else {
              const onchainMain = await fetchOnChain(umiMainnet, mintAddr, mainnetRpc)
              const onchain = onchainMain || (await fetchOnChain(umiDevnet, mintAddr, devnetRpc))
              if (onchain) {
                name = onchain.name
                symbol = onchain.symbol
                const uri = onchain.uri
                // best-effort: fetch json to fill description/image if available
                try {
                  if (uri && (uri.startsWith("http://") || uri.startsWith("https://"))) {
                    const r = await fetch(uri)
                    if (r.ok) {
                      const j: any = await r.json().catch(() => null)
                      if (j) {
                        desc = String(j?.description || "").trim() || undefined
                        img = String(j?.image || "").trim() || undefined
                      }
                    }
                  }
                } catch {
                  // ignore
                }
              }
              if (!name || !symbol) {
                const fromCreate = await fetchFromCreateTx(mintAddr)
                if (fromCreate) {
                  name = fromCreate.name
                  symbol = fromCreate.symbol
                  const uri = fromCreate.uri
                  // best-effort: fetch json to fill description/image if available
                  try {
                    if (uri && (uri.startsWith("http://") || uri.startsWith("https://"))) {
                      const r = await fetch(uri)
                      if (r.ok) {
                        const j: any = await r.json().catch(() => null)
                        if (j) {
                          desc = String(j?.description || "").trim() || undefined
                          img = String(j?.image || "").trim() || undefined
                        }
                      }
                    }
                  } catch {
                    // ignore
                  }
                }
              }
            }

            if (!name || !symbol) return

            await prisma.token.update({
              where: { id: t.id },
              data: {
                name,
                symbol,
                ...(desc ? { description: desc } : {}),
                ...(img ? { imageUrl: img } : {}),
              },
            })

            // update in-memory payload too (so UI gets it immediately)
            t.name = name
            t.symbol = symbol
            if (desc) t.description = desc
            if (img) t.imageUrl = img
          } catch (e: any) {
            // ignore
          }
        })
      )
    }

    return NextResponse.json(tokens)
  } catch {
    return NextResponse.json([])
  }
}

// DELETE - remove token and related records
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get("mintAddress")
    const id = searchParams.get("id")

    if (!mintAddress && !id) {
      return NextResponse.json({ error: "mintAddress or id required" }, { status: 400 })
    }

    const token = await prisma.token.findFirst({
      where: {
        ...(mintAddress ? { mintAddress } : {}),
        ...(id ? { id } : {}),
      },
      select: { id: true },
    })

    if (!token) {
      return NextResponse.json({ error: "token not found" }, { status: 404 })
    }

    await prisma.token.update({
      where: { id: token.id },
      data: { deletedAt: new Date() },
    })

    return NextResponse.json({ success: true, softDeleted: true })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "delete failed" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { mintAddress, id } = body || {}

    if (!mintAddress && !id) {
      return NextResponse.json({ error: "mintAddress or id required" }, { status: 400 })
    }

    const token = await prisma.token.findFirst({
      where: {
        ...(mintAddress ? { mintAddress } : {}),
        ...(id ? { id } : {}),
      },
      select: { id: true },
    })

    if (!token) {
      return NextResponse.json({ error: "token not found" }, { status: 404 })
    }

    const restored = await prisma.token.update({
      where: { id: token.id },
      data: { deletedAt: null },
    })

    return NextResponse.json({ success: true, token: restored })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "restore failed" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      importMint,
      creatorWallet: importCreator,
      name,
      symbol,
      description,
      metadataUri,
      creatorWallet,
      mintKeypair,
      website,
      twitter,
      telegram,
      imageUrl,
    } = body

    // import existing mint into panel (no tx build)
    if (importMint) {
      const mintAddr = importMint as string
      let data: any = null
      try {
        const resp = await fetch(`https://frontend-api.pump.fun/coins/${mintAddr}`)
        if (resp.ok) data = await resp.json()
      } catch {
        // ignore
      }
      try {
        const token = await prisma.token.upsert({
          where: { mintAddress: mintAddr },
          update: {
            deletedAt: null,
            name: data?.name || name || mintAddr.slice(0, 6),
            symbol: data?.symbol || symbol || mintAddr.slice(0, 4),
            description: data?.description || description || "",
            imageUrl: data?.image_uri || "",
            website: data?.website || website || null,
            twitter: data?.twitter || data?.x || twitter || null,
            telegram: data?.telegram || telegram || null,
            creatorWallet: importCreator || data?.creator || creatorWallet || "",
          },
          create: {
            mintAddress: mintAddr,
            name: data?.name || name || mintAddr.slice(0, 6),
            symbol: data?.symbol || symbol || mintAddr.slice(0, 4),
            decimals: data?.decimals ?? 6,
            totalSupply: "0",
            description: data?.description || description || "",
            imageUrl: data?.image_uri || "",
            website: data?.website || website || null,
            twitter: data?.twitter || data?.x || twitter || null,
            telegram: data?.telegram || telegram || null,
            creatorWallet: importCreator || data?.creator || creatorWallet || "",
            deletedAt: null,
          },
        })
        return NextResponse.json({ token, imported: true, source: data ? "pump.fun" : "manual" })
      } catch (error: any) {
        // if db blocked (EACCES), still return token object for UI (non-persisted)
        return NextResponse.json({
          token: {
            id: mintAddr,
            mintAddress: mintAddr,
            name: data?.name || name || mintAddr.slice(0, 6),
            symbol: data?.symbol || symbol || mintAddr.slice(0, 4),
            description: data?.description || description || "",
            imageUrl: data?.image_uri || "",
            website: data?.website || website || null,
            twitter: data?.twitter || data?.x || twitter || null,
            telegram: data?.telegram || telegram || null,
            creatorWallet: importCreator || data?.creator || creatorWallet || "",
          },
          imported: true,
          source: data ? "pump.fun" : "manual",
          persisted: false,
          error: error?.message || "db write failed",
        })
      }
    }

    if (!creatorWallet || !mintKeypair) {
      return NextResponse.json({ error: "creator wallet and mint keypair required" }, { status: 400 })
    }

    if (!metadataUri) {
      return NextResponse.json({ error: "metadata uri required (upload to ipfs first)" }, { status: 400 })
    }

    // check network
    if (!isPumpFunAvailable()) {
      return NextResponse.json({ 
        error: `pump.fun not available on ${SOLANA_NETWORK}. switch to mainnet-beta` 
      }, { status: 400 })
    }

    // decode mint keypair
    const mintSecretKey = bs58.decode(mintKeypair)
    const mint = Keypair.fromSecretKey(mintSecretKey)
    const creatorPublicKey = new PublicKey(creatorWallet)
    
    // build transaction
    const transaction = await buildCreateTokenTransaction(
      creatorPublicKey,
      mint,
      name,
      symbol,
      metadataUri
    )
    
    // serialize transaction (without signatures)
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })

    // save token to database
    const token = await prisma.token.create({
      data: {
        mintAddress: mint.publicKey.toBase58(),
        name,
        symbol,
        decimals: 6,
        totalSupply: "0",
        description,
        imageUrl: imageUrl || "",
        website: website || null,
        twitter: twitter || null,
        telegram: telegram || null,
        creatorWallet,
      },
    })

    return NextResponse.json({
      token,
      transaction: bs58.encode(serializedTransaction),
      mintAddress: mint.publicKey.toBase58(),
    })
  } catch (error: any) {
    console.error("error creating token:", error)
    return NextResponse.json({ error: error.message || "internal server error" }, { status: 500 })
  }
}
