import { NextResponse } from "next/server"
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults"
import { fetchMetadata, findMetadataPda } from "@metaplex-foundation/mpl-token-metadata"
import { publicKey } from "@metaplex-foundation/umi"
import { Connection, PublicKey } from "@solana/web3.js"
import { getBondingCurveAddress, getMetadataAddress } from "@/lib/solana/pumpfun"

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")

const MAINNET_RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com"
const DEVNET_RPC =
  process.env.DEVNET_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com"
const TOKEN_LIST_URL =
  process.env.TOKEN_LIST_URL ||
  "https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json"
const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK || "devnet"

// #region agent log
const emitDebugLog = (payload: {
  hypothesisId: string
  location: string
  message: string
  data?: Record<string, unknown>
}) => {
  fetch('http://127.0.0.1:7242/ingest/e23f7788-0527-4cc5-ae49-c1d5738f268a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:payload.location,message:payload.message,data:payload.data,timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:payload.hypothesisId})}).catch(()=>{});
}
// #endregion

const isValidBase58Length = (str: string): boolean => {
  return str.length >= 32 && str.length <= 44
}

const isValidPublicKey = (str: string): boolean => {
  if (!isValidBase58Length(str)) return false
  try {
    publicKey(str)
    return true
  } catch {
    return false
  }
}

const normalizeMint = (raw: string): { primary: string | null; alt?: string | null } => {
  let value = raw.trim()
  if (!value) return { primary: null, alt: null }
  if (value.includes("/")) {
    value = value.split("/").filter(Boolean).pop() || value
  }
  if (value.includes("?")) {
    value = value.split("?")[0]
  }
  const alt = value.endsWith("pump") ? value.slice(0, -4) : null
  if (!isValidBase58Length(value)) return { primary: null, alt: null }
  if (alt && !isValidBase58Length(alt)) {
    return { primary: value, alt: null }
  }
  return { primary: value, alt }
}

async function fetchPumpFunMetadata(mint: string, endpoint: string) {
  // #region agent log
  emitDebugLog({
    hypothesisId: "H8",
    location: "app/api/clone/route.ts:fetchPumpFunMetadata",
    message: "fetchPumpFunMetadata entry",
    data: { mint, endpoint },
  })
  // #endregion
  try {
    const connection = new Connection(endpoint, "confirmed")
    let mintPk: PublicKey
    try {
      mintPk = new PublicKey(mint)
    } catch {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H8",
        location: "app/api/clone/route.ts:fetchPumpFunMetadata",
        message: "invalid public key, skipping",
        data: { mint, endpoint },
      })
      // #endregion
      return null
    }
    const bondingCurve = getBondingCurveAddress(mintPk)
    // #region agent log
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/route.ts:fetchPumpFunMetadata",
      message: "pump.fun bonding curve pda derived",
      data: { mint, endpoint, bondingCurve: bondingCurve.toString() },
    })
    // #endregion
    const bondingCurveInfo = await connection.getAccountInfo(bondingCurve)
    if (!bondingCurveInfo || !bondingCurveInfo.data) {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H8",
        location: "app/api/clone/route.ts:fetchPumpFunMetadata",
        message: "pump.fun bonding curve not found - not a pump.fun token",
        data: { mint, endpoint, bondingCurve: bondingCurve.toString() },
      })
      // #endregion
      return null
    }
    // #region agent log
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/route.ts:fetchPumpFunMetadata",
      message: "pump.fun bonding curve found - is pump.fun token",
      data: { mint, endpoint, bondingCurve: bondingCurve.toString(), dataLength: bondingCurveInfo.data.length },
    })
    // #endregion
    // parse bonding curve to check if token is complete and get creator
    const data = bondingCurveInfo.data
    const DISCRIMINATOR_LENGTH = 8
    let offset = DISCRIMINATOR_LENGTH
    const virtualTokenReserves = data.readBigUInt64LE(offset)
    offset += 8
    const virtualSolReserves = data.readBigUInt64LE(offset)
    offset += 8
    const realTokenReserves = data.readBigUInt64LE(offset)
    offset += 8
    const realSolReserves = data.readBigUInt64LE(offset)
    offset += 8
    const tokenTotalSupply = data.readBigUInt64LE(offset)
    offset += 8
    const isComplete = data[offset] === 1
    offset += 1
    const creator = new PublicKey(data.slice(offset, offset + 32))
    offset += 32
    const isMayhemMode = data[offset] === 1
    // #region agent log
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/route.ts:fetchPumpFunMetadata",
      message: "pump.fun bonding curve parsed",
      data: { mint, endpoint, isComplete, creator: creator.toString(), isMayhemMode, tokenTotalSupply: tokenTotalSupply.toString() },
    })
    // #endregion
    // pump.fun uses standard Metaplex Token Metadata, but metadata account might not exist
    // try standard Metaplex metadata first
    const umi = createUmi(endpoint)
    const mintPkUmi = publicKey(mint)
    const standardMetadataPda = findMetadataPda(umi, { mint: mintPkUmi })
    // #region agent log
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/route.ts:fetchPumpFunMetadata",
      message: "pump.fun trying standard Metaplex metadata",
      data: { mint, endpoint, standardMetadataPda: standardMetadataPda.toString() },
    })
    // #endregion
    try {
      const metadata = await fetchMetadata(umi, standardMetadataPda)
      // #region agent log
      emitDebugLog({
        hypothesisId: "H8",
        location: "app/api/clone/route.ts:fetchPumpFunMetadata",
        message: "pump.fun standard Metaplex metadata found",
        data: { mint, endpoint, uri: metadata.uri, name: metadata.name },
      })
      // #endregion
      const uri = metadata.uri
      const res = await fetch(uri)
      if (!res.ok) {
        // #region agent log
        emitDebugLog({
          hypothesisId: "H8",
          location: "app/api/clone/route.ts:fetchPumpFunMetadata",
          message: "pump.fun metadata uri fetch failed",
          data: { mint, endpoint, uri, status: res.status },
        })
        // #endregion
        return null
      }
      const json = await res.json().catch(() => null)
      if (!json) {
        // #region agent log
        emitDebugLog({
          hypothesisId: "H8",
          location: "app/api/clone/route.ts:fetchPumpFunMetadata",
          message: "pump.fun metadata json parse failed",
          data: { mint, endpoint, uri },
        })
        // #endregion
        return null
      }
      // #region agent log
      emitDebugLog({
        hypothesisId: "H8",
        location: "app/api/clone/route.ts:fetchPumpFunMetadata",
        message: "pump.fun standard Metaplex metadata parsed",
        data: { mint, endpoint, name: metadata.name, symbol: metadata.symbol, hasImage: !!json.image },
      })
      // #endregion
      return {
        name: metadata.name || "",
        symbol: metadata.symbol || "",
        description: json.description || "",
        image: json.image || "",
        website: json.website || json.external_url || "",
        twitter: json.twitter || json.x || "",
        telegram: json.telegram || "",
      }
    } catch (error: any) {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H8",
        location: "app/api/clone/route.ts:fetchPumpFunMetadata",
        message: "pump.fun standard Metaplex metadata not found, trying custom metadata",
        data: { mint, endpoint, error: error?.message || String(error) },
      })
      // #endregion
    }
    // if standard Metaplex metadata not found, try pump.fun custom metadata account
    const pumpMetadataPda = getMetadataAddress(mintPk)
    // #region agent log
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/route.ts:fetchPumpFunMetadata",
      message: "pump.fun custom metadata pda derived",
      data: { mint, endpoint, pumpMetadataPda: pumpMetadataPda.toString() },
    })
    // #endregion
    const pumpMetadataInfo = await connection.getAccountInfo(pumpMetadataPda)
    if (!pumpMetadataInfo || !pumpMetadataInfo.data) {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H8",
        location: "app/api/clone/route.ts:fetchPumpFunMetadata",
        message: "pump.fun custom metadata account not found",
        data: { mint, endpoint, pumpMetadataPda: pumpMetadataPda.toString() },
      })
      // #endregion
      return null
    }
    // #region agent log
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/route.ts:fetchPumpFunMetadata",
      message: "pump.fun custom metadata account found",
      data: { mint, endpoint, pumpMetadataPda: pumpMetadataPda.toString(), dataLength: pumpMetadataInfo.data.length },
    })
    // #endregion
    // parse pump.fun custom metadata format (from createPumpFunTokenInstruction)
    const metadataData = pumpMetadataInfo.data
    let metadataOffset = 0
    const nameLen = metadataData[metadataOffset]
    metadataOffset += 1
    const name = metadataData.slice(metadataOffset, metadataOffset + nameLen).toString("utf8")
    metadataOffset += 32
    const symbolLen = metadataData[metadataOffset]
    metadataOffset += 1
    const symbol = metadataData.slice(metadataOffset, metadataOffset + symbolLen).toString("utf8")
    metadataOffset += 10
    const descLen = metadataData.readUInt16LE(metadataOffset)
    metadataOffset += 2
    const description = metadataData.slice(metadataOffset, metadataOffset + descLen).toString("utf8")
    metadataOffset += 200
    const imageLen = metadataData.readUInt16LE(metadataOffset)
    metadataOffset += 2
    const image = metadataData.slice(metadataOffset, metadataOffset + imageLen).toString("utf8")
    metadataOffset += 200
    const websiteLen = metadataData[metadataOffset]
    metadataOffset += 1
    const website = websiteLen > 0 ? metadataData.slice(metadataOffset, metadataOffset + websiteLen).toString("utf8") : ""
    metadataOffset += 100
    const twitterLen = metadataData[metadataOffset]
    metadataOffset += 1
    const twitter = twitterLen > 0 ? metadataData.slice(metadataOffset, metadataOffset + twitterLen).toString("utf8") : ""
    metadataOffset += 50
    const telegramLen = metadataData[metadataOffset]
    metadataOffset += 1
    const telegram = telegramLen > 0 ? metadataData.slice(metadataOffset, metadataOffset + telegramLen).toString("utf8") : ""
    // #region agent log
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/route.ts:fetchPumpFunMetadata",
      message: "pump.fun custom metadata parsed",
      data: { mint, endpoint, name, symbol, hasImage: !!image, hasWebsite: !!website },
    })
    // #endregion
    return {
      name,
      symbol,
      description,
      image,
      website,
      twitter,
      telegram,
    }
  } catch (error: any) {
    // #region agent log
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/route.ts:fetchPumpFunMetadata",
      message: "pump.fun custom metadata fetch failed",
      data: { mint, endpoint, error: error?.message || String(error) },
    })
    // #endregion
    return null
  }
}

// direct metadata reading via Connection (H13)
async function fetchMetadataDirect(mint: string, endpoint: string) {
  // #region agent log
  emitDebugLog({
    hypothesisId: "H13",
    location: "app/api/clone/route.ts:fetchMetadataDirect",
    message: "fetchMetadataDirect entry",
    data: { mint, endpoint },
  })
  // #endregion
  try {
    const connection = new Connection(endpoint, "confirmed")
    const mintPk = new PublicKey(mint)
    // derive metadata PDA manually
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM_ID.toBuffer(),
        mintPk.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    )
    // #region agent log
    emitDebugLog({
      hypothesisId: "H13",
      location: "app/api/clone/route.ts:fetchMetadataDirect",
      message: "metadata PDA derived",
      data: { mint, endpoint, metadataPda: metadataPda.toString() },
    })
    // #endregion
    const accountInfo = await connection.getAccountInfo(metadataPda)
    if (!accountInfo || !accountInfo.data) {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H13",
        location: "app/api/clone/route.ts:fetchMetadataDirect",
        message: "metadata account not found",
        data: { mint, endpoint, metadataPda: metadataPda.toString() },
      })
      // #endregion
      return null
    }
    // #region agent log
    emitDebugLog({
      hypothesisId: "H13",
      location: "app/api/clone/route.ts:fetchMetadataDirect",
      message: "metadata account found, parsing",
      data: { mint, endpoint, dataLength: accountInfo.data.length },
    })
    // #endregion
    // parse Metaplex metadata format manually
    // structure: key (1) + update_authority (33) + mint (32) + data (name + symbol + uri)
    const data = accountInfo.data
    let offset = 1 // skip key
    offset += 33 // skip update_authority
    offset += 32 // skip mint
    // data: name_len (4) + name + symbol_len (4) + symbol + uri_len (4) + uri
    const nameLen = data.readUInt32LE(offset)
    offset += 4
    const name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim()
    offset += nameLen
    const symbolLen = data.readUInt32LE(offset)
    offset += 4
    const symbol = data.slice(offset, offset + symbolLen).toString('utf8').replace(/\0/g, '').trim()
    offset += symbolLen
    const uriLen = data.readUInt32LE(offset)
    offset += 4
    const uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim()
    // #region agent log
    emitDebugLog({
      hypothesisId: "H13",
      location: "app/api/clone/route.ts:fetchMetadataDirect",
      message: "metadata parsed successfully",
      data: { mint, endpoint, name, symbol, uri },
    })
    // #endregion
    return { name, symbol, uri }
  } catch (error: any) {
    // #region agent log
    emitDebugLog({
      hypothesisId: "H13",
      location: "app/api/clone/route.ts:fetchMetadataDirect",
      message: "fetchMetadataDirect failed",
      data: { mint, endpoint, error: error?.message || String(error) },
    })
    // #endregion
    return null
  }
}

async function fetchOnChain(mint: string, endpoint: string) {
  // #region agent log
  emitDebugLog({
    hypothesisId: "H3",
    location: "app/api/clone/route.ts:fetchOnChain",
    message: "fetchOnChain entry",
    data: { mint, endpoint },
  })
  // #endregion
  // try direct method first (H13)
  const directMetadata = await fetchMetadataDirect(mint, endpoint)
  if (directMetadata) {
    return directMetadata
  }
  // fallback to UMI SDK
  const umi = createUmi(endpoint)
  // #region agent log
  emitDebugLog({
    hypothesisId: "H3",
    location: "app/api/clone/route.ts:fetchOnChain",
    message: "umi created",
    data: { mint, endpoint },
  })
  // #endregion
  let mintPk
  try {
    mintPk = publicKey(mint)
    // #region agent log
    emitDebugLog({
      hypothesisId: "H7",
      location: "app/api/clone/route.ts:fetchOnChain",
      message: "publicKey created",
      data: { mint, endpoint, publicKey: mintPk.toString() },
    })
    // #endregion
  } catch (error: any) {
    // #region agent log
    emitDebugLog({
      hypothesisId: "H7",
      location: "app/api/clone/route.ts:fetchOnChain",
      message: "publicKey creation failed",
      data: { mint, endpoint, error: error?.message || String(error) },
    })
    // #endregion
    throw error
  }
  const metadataPda = findMetadataPda(umi, { mint: mintPk })
  // #region agent log
  emitDebugLog({
    hypothesisId: "H3",
    location: "app/api/clone/route.ts:fetchOnChain",
    message: "metadata pda derived",
    data: { mint, endpoint, metadataPda: metadataPda.toString() },
  })
  // #endregion
  const account = await umi.rpc.getAccount(metadataPda)
  // #region agent log
  emitDebugLog({
    hypothesisId: "H3",
    location: "app/api/clone/route.ts:fetchOnChain",
    message: "metadata account probe",
    data: {
      mint,
      endpoint,
      metadataPda: metadataPda.toString(),
      exists: account.exists,
      owner: account.exists ? account.owner.toString() : null,
    },
  })
  // #endregion
  try {
    const metadata = await fetchMetadata(umi, metadataPda)
    // #region agent log
    emitDebugLog({
      hypothesisId: "H3",
      location: "app/api/clone/route.ts:fetchOnChain",
      message: "fetchMetadata success",
      data: { mint, endpoint, uri: metadata.uri, name: metadata.name },
    })
    // #endregion
    return metadata
  } catch (error: any) {
    // #region agent log
    emitDebugLog({
      hypothesisId: "H3",
      location: "app/api/clone/route.ts:fetchOnChain",
      message: "fetchMetadata failed",
      data: { mint, endpoint, error: error?.message || String(error) },
    })
    // #endregion
    throw error
  }
}

export async function GET(request: Request) {
  // #region agent log
  emitDebugLog({
    hypothesisId: "H1",
    location: "app/api/clone/route.ts:GET",
    message: "clone request entry",
    data: { url: request.url },
  })
  // #endregion
  const { searchParams } = new URL(request.url)
  const rawMint = (searchParams.get("mint") || "").trim()
  // #region agent log
  emitDebugLog({
    hypothesisId: "H1",
    location: "app/api/clone/route.ts:GET",
    message: "rawMint extracted",
    data: { rawMint },
  })
  // #endregion

  const { primary, alt } = normalizeMint(rawMint)
  // #region agent log
  emitDebugLog({
    hypothesisId: "H1",
    location: "app/api/clone/route.ts:GET",
    message: "normalizeMint result",
    data: { rawMint, primary, alt },
  })
  // #endregion

  if (!primary) {
    // #region agent log
    emitDebugLog({
      hypothesisId: "H1",
      location: "app/api/clone/route.ts:GET",
      message: "invalid mint address",
      data: { rawMint },
    })
    // #endregion
    return NextResponse.json({ error: "invalid mint address" }, { status: 400 })
  }

  const attempts: Array<{ mint: string; rpc: string; error?: string }> = []

  // #region agent log
  emitDebugLog({
    hypothesisId: "H2",
    location: "app/api/clone/route.ts:GET",
    message: "RPC endpoints",
    data: { MAINNET_RPC, DEVNET_RPC },
  })
  // #endregion
  const candidates = [
    ...(isValidPublicKey(primary) ? [{ mint: primary, rpc: MAINNET_RPC }] : []),
    ...(alt && alt !== primary && isValidPublicKey(alt) ? [{ mint: alt, rpc: MAINNET_RPC }] : []),
    ...(isValidPublicKey(primary) ? [{ mint: primary, rpc: DEVNET_RPC }] : []),
    ...(alt && alt !== primary && isValidPublicKey(alt) ? [{ mint: alt, rpc: DEVNET_RPC }] : []),
  ]
  // #region agent log
  emitDebugLog({
    hypothesisId: "H1",
    location: "app/api/clone/route.ts:GET",
    message: "candidates prepared",
    data: { count: candidates.length, candidates },
  })
  // #endregion

  for (const candidate of candidates) {
    // #region agent log
    emitDebugLog({
      hypothesisId: "H2",
      location: "app/api/clone/route.ts:GET",
      message: "candidate attempt",
      data: { mint: candidate.mint, rpc: candidate.rpc },
    })
    // #endregion

    try {
      const metadata = await fetchOnChain(candidate.mint, candidate.rpc)
      // #region agent log
      emitDebugLog({
        hypothesisId: "H2",
        location: "app/api/clone/route.ts:GET",
        message: "on-chain metadata fetched",
        data: { mint: candidate.mint, rpc: candidate.rpc, uri: metadata.uri, name: metadata.name },
      })
      // #endregion
      const uri = metadata.uri
      // #region agent log
      emitDebugLog({
        hypothesisId: "H4",
        location: "app/api/clone/route.ts:GET",
        message: "fetching metadata uri",
        data: { mint: candidate.mint, uri },
      })
      // #endregion
      const res = await fetch(uri)
      if (!res.ok) {
        // #region agent log
        emitDebugLog({
          hypothesisId: "H4",
          location: "app/api/clone/route.ts:GET",
          message: "metadata uri fetch failed",
          data: { mint: candidate.mint, rpc: candidate.rpc, uri, status: res.status },
        })
        // #endregion
        attempts.push({ ...candidate, error: `metadata uri ${res.status}` })
        continue
      }
      // #region agent log
      emitDebugLog({
        hypothesisId: "H4",
        location: "app/api/clone/route.ts:GET",
        message: "metadata uri fetch ok",
        data: { mint: candidate.mint, uri, status: res.status },
      })
      // #endregion
      const json = await res.json().catch((err: any) => {
        // #region agent log
        emitDebugLog({
          hypothesisId: "H4",
          location: "app/api/clone/route.ts:GET",
          message: "metadata json parse failed",
          data: { mint: candidate.mint, rpc: candidate.rpc, uri, error: err?.message || String(err) },
        })
        // #endregion
        attempts.push({ ...candidate, error: err?.message || "json parse failed" })
        return null
      })
      if (!json) continue
      // #region agent log
      emitDebugLog({
        hypothesisId: "H4",
        location: "app/api/clone/route.ts:GET",
        message: "metadata json parsed",
        data: { mint: candidate.mint, hasImage: !!json.image, hasDescription: !!json.description },
      })
      // #endregion

      // #region agent log
      emitDebugLog({
        hypothesisId: "H2",
        location: "app/api/clone/route.ts:GET",
        message: "returning success response",
        data: { mint: candidate.mint, rpc: candidate.rpc },
      })
      // #endregion
      return NextResponse.json({
        name: metadata.name,
        symbol: metadata.symbol,
        uri,
        description: json.description || "",
        image: json.image || "",
        twitter: json.twitter || json.x || "",
        telegram: json.telegram || "",
        website: json.website || json.external_url || "",
        rawJson: json,
        usedRpc: candidate.rpc,
        usedMint: candidate.mint,
      })
    } catch (error: any) {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H2",
        location: "app/api/clone/route.ts:GET",
        message: "candidate attempt failed",
        data: { mint: candidate.mint, rpc: candidate.rpc, error: error?.message || String(error), errorStack: error?.stack },
      })
      // #endregion
      attempts.push({ ...candidate, error: error?.message || String(error) })
      continue
    }
  }
  // #region agent log
  emitDebugLog({
    hypothesisId: "H2",
    location: "app/api/clone/route.ts:GET",
    message: "all on-chain attempts failed",
    data: { attemptsCount: attempts.length },
  })
  // #endregion

  // try pump.fun on-chain metadata before API fallback
  // for pump.fun, try both primary and alt addresses even if primary is not a valid public key
  // but prioritize alt address (without "pump") for Metaplex metadata lookup
  const pumpCandidates = [
    ...(alt && alt !== primary ? [{ mint: alt, rpc: MAINNET_RPC }] : []),
    ...(primary ? [{ mint: primary, rpc: MAINNET_RPC }] : []),
  ]
  // #region agent log
  emitDebugLog({
    hypothesisId: "H8",
    location: "app/api/clone/route.ts:GET",
    message: "pump.fun candidates prepared",
    data: { primary, alt, pumpCandidatesCount: pumpCandidates.length, pumpCandidates },
  })
  // #endregion
  for (const candidate of pumpCandidates) {
    // #region agent log
    emitDebugLog({
      hypothesisId: "H8",
      location: "app/api/clone/route.ts:GET",
      message: "pump.fun on-chain metadata attempt",
      data: { mint: candidate.mint, rpc: candidate.rpc },
    })
    // #endregion
    try {
      const pumpMetadata = await fetchPumpFunMetadata(candidate.mint, candidate.rpc)
      if (pumpMetadata) {
        // #region agent log
        emitDebugLog({
          hypothesisId: "H8",
          location: "app/api/clone/route.ts:GET",
          message: "pump.fun on-chain metadata success",
          data: { mint: candidate.mint, rpc: candidate.rpc, name: pumpMetadata.name, symbol: pumpMetadata.symbol },
        })
        // #endregion
        return NextResponse.json({
          name: pumpMetadata.name || "",
          symbol: pumpMetadata.symbol || "",
          uri: pumpMetadata.image || "",
          description: pumpMetadata.description || "",
          image: pumpMetadata.image || "",
          twitter: pumpMetadata.twitter || "",
          telegram: pumpMetadata.telegram || "",
          website: pumpMetadata.website || "",
          rawJson: pumpMetadata,
          usedRpc: candidate.rpc,
          usedMint: candidate.mint,
        })
      }
    } catch (error: any) {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H8",
        location: "app/api/clone/route.ts:GET",
        message: "pump.fun on-chain metadata error",
        data: { mint: candidate.mint, rpc: candidate.rpc, error: error?.message || String(error) },
      })
      // #endregion
      attempts.push({ ...candidate, error: error?.message || "pump.fun metadata failed" })
    }
  }

  // try to get metadata from transaction history (H11)
  if (primary && isValidPublicKey(primary)) {
    try {
      const connection = new Connection(MAINNET_RPC, "confirmed")
      const mintPk = new PublicKey(primary)
      const bondingCurve = getBondingCurveAddress(mintPk)
      // #region agent log
      emitDebugLog({
        hypothesisId: "H11",
        location: "app/api/clone/route.ts:GET",
        message: "trying to get metadata from transaction history",
        data: { mint: primary, bondingCurve: bondingCurve.toString() },
      })
      // #endregion
      // get signatures for mint token creation (not bonding curve - bonding curve might be created in a different tx)
      const signatures = await connection.getSignaturesForAddress(mintPk, { limit: 10 }).catch(() => [])
      // #region agent log
      emitDebugLog({
        hypothesisId: "H11",
        location: "app/api/clone/route.ts:GET",
        message: "found mint signatures",
        data: { mint: primary, signatureCount: signatures.length },
      })
      // #endregion
      // try each signature until we find create instruction
      for (let sigIdx = 0; sigIdx < signatures.length; sigIdx++) {
        const tx = await connection.getTransaction(signatures[sigIdx].signature, {
          maxSupportedTransactionVersion: 0,
        }).catch(() => null)
        if (tx && tx.transaction) {
          // extract instructions based on transaction type
          const txAny = tx.transaction as any
          const msg: any = txAny.message
          let instructions: any[] = []
          if (msg) {
            // VersionedTransaction or Legacy Transaction with message
            if (msg.staticAccountKeys) {
              // V0 message - need to decompile
              instructions = (msg.compiledInstructions || []).map((cix: any) => {
                const programId = msg.staticAccountKeys[cix.programIdIndex]
                return {
                  programId: programId.toString(),
                  data: Buffer.from(cix.data).toString('base64'),
                }
              })
            } else if (msg.instructions) {
              // Legacy message
              instructions = msg.instructions
            }
          } else if (txAny.instructions) {
            // Legacy Transaction without message wrapper
            instructions = txAny.instructions
          }
          // also check inner instructions from transaction meta
          if (tx.meta?.innerInstructions) {
            // #region agent log
            emitDebugLog({
              hypothesisId: "H11",
              location: "app/api/clone/route.ts:GET",
              message: "checking inner instructions",
              data: { mint: primary, innerInstructionGroups: tx.meta.innerInstructions.length },
            })
            // #endregion
            for (const innerIxGroup of tx.meta.innerInstructions) {
              for (const innerIx of innerIxGroup.instructions || []) {
                try {
                  let programId: any = null
                  if (innerIx.programIdIndex !== undefined && msg?.staticAccountKeys) {
                    programId = msg.staticAccountKeys[innerIx.programIdIndex]
                  } else if (innerIx.programId) {
                    programId = innerIx.programId
                  }
                  if (programId) {
                    const programIdStr = programId.toString()
                    // #region agent log
                    emitDebugLog({
                      hypothesisId: "H11",
                      location: "app/api/clone/route.ts:GET",
                      message: "inner instruction found",
                      data: { mint: primary, programId: programIdStr, isPumpFun: programIdStr === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
                    })
                    // #endregion
                    instructions.push({
                      programId: programIdStr,
                      data: innerIx.data ? Buffer.from(innerIx.data, 'base64').toString('base64') : '',
                    })
                  }
                } catch (innerError: any) {
                  // #region agent log
                  emitDebugLog({
                    hypothesisId: "H11",
                    location: "app/api/clone/route.ts:GET",
                    message: "inner instruction parse error",
                    data: { mint: primary, error: innerError?.message || String(innerError) },
                  })
                  // #endregion
                }
              }
            }
          } else {
            // #region agent log
            emitDebugLog({
              hypothesisId: "H11",
              location: "app/api/clone/route.ts:GET",
              message: "no inner instructions found",
              data: { mint: primary },
            })
            // #endregion
          }
          // #region agent log
          emitDebugLog({
            hypothesisId: "H11",
            location: "app/api/clone/route.ts:GET",
            message: "transaction found, checking instructions",
            data: { mint: primary, signature: signatures[0].signature, instructionCount: instructions.length },
          })
          // #endregion
          // find pump.fun create instruction and decode it
          const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
          const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119])
          
          for (let i = 0; i < instructions.length; i++) {
            const ix = instructions[i]
            // #region agent log
            emitDebugLog({
              hypothesisId: "H11",
              location: "app/api/clone/route.ts:GET",
              message: "checking instruction",
              data: { mint: primary, instructionIndex: i, hasProgramId: 'programId' in ix, hasData: 'data' in ix },
            })
            // #endregion
            if ('programId' in ix) {
              try {
                const programId = new PublicKey(ix.programId)
                // #region agent log
                emitDebugLog({
                  hypothesisId: "H11",
                  location: "app/api/clone/route.ts:GET",
                  message: "instruction program ID",
                  data: { mint: primary, instructionIndex: i, programId: programId.toString(), isPumpFun: programId.equals(PUMPFUN_PROGRAM_ID) },
                })
                // #endregion
                if (programId.equals(PUMPFUN_PROGRAM_ID) && 'data' in ix) {
                  const data = Buffer.from(ix.data, 'base64')
                  // #region agent log
                  emitDebugLog({
                    hypothesisId: "H11",
                    location: "app/api/clone/route.ts:GET",
                    message: "pump.fun instruction data",
                    data: { mint: primary, instructionIndex: i, dataLength: data.length, firstBytes: Array.from(data.slice(0, 8)) },
                  })
                  // #endregion
                  if (data.length >= 8 && data.slice(0, 8).equals(CREATE_DISCRIMINATOR)) {
                    // #region agent log
                    emitDebugLog({
                      hypothesisId: "H11",
                      location: "app/api/clone/route.ts:GET",
                      message: "found pump.fun create instruction",
                      data: { mint: primary, dataLength: data.length },
                    })
                    // #endregion
                    // decode: discriminator (8) + name (4 bytes len + string) + symbol (4 bytes len + string) + uri (4 bytes len + string) + creator (32)
                    let offset = 8
                    // name
                    const nameLen = data.readUInt32LE(offset)
                    offset += 4
                    const name = data.slice(offset, offset + nameLen).toString('utf8')
                    offset += nameLen
                    // symbol
                    const symbolLen = data.readUInt32LE(offset)
                    offset += 4
                    const symbol = data.slice(offset, offset + symbolLen).toString('utf8')
                    offset += symbolLen
                    // uri
                    const uriLen = data.readUInt32LE(offset)
                    offset += 4
                    const uri = data.slice(offset, offset + uriLen).toString('utf8')
                    // #region agent log
                    emitDebugLog({
                      hypothesisId: "H11",
                      location: "app/api/clone/route.ts:GET",
                      message: "decoded create instruction",
                      data: { mint: primary, name, symbol, uri },
                    })
                    // #endregion
                    // fetch metadata from URI
                    try {
                      const metadataRes = await fetch(uri).catch(() => null)
                      if (metadataRes && metadataRes.ok) {
                        const metadataJson = await metadataRes.json().catch(() => null)
                        if (metadataJson) {
                          // #region agent log
                          emitDebugLog({
                            hypothesisId: "H11",
                            location: "app/api/clone/route.ts:GET",
                            message: "metadata fetched from URI",
                            data: { mint: primary, hasName: !!metadataJson.name, hasImage: !!metadataJson.image },
                          })
                          // #endregion
                          return NextResponse.json({
                            name: name || metadataJson.name || "",
                            symbol: symbol || metadataJson.symbol || "",
                            uri: metadataJson.image || metadataJson.image_uri || "",
                            description: metadataJson.description || "",
                            website: metadataJson.website || metadataJson.external_url || "",
                            twitter: metadataJson.twitter || metadataJson.x || "",
                            telegram: metadataJson.telegram || "",
                          })
                        }
                      }
                    } catch (uriError: any) {
                      // #region agent log
                      emitDebugLog({
                        hypothesisId: "H11",
                        location: "app/api/clone/route.ts:GET",
                        message: "metadata URI fetch failed",
                        data: { mint: primary, uri, error: uriError?.message || String(uriError) },
                      })
                      // #endregion
                    }
                    // if URI fetch failed, return at least name and symbol
                    if (name && symbol) {
                      return NextResponse.json({
                        name,
                        symbol,
                        uri: "",
                        description: "",
                        website: "",
                        twitter: "",
                        telegram: "",
                      })
                    }
                  }
                }
              } catch (pubKeyError: any) {
                // #region agent log
                emitDebugLog({
                  hypothesisId: "H11",
                  location: "app/api/clone/route.ts:GET",
                  message: "failed to parse program ID",
                  data: { mint: primary, instructionIndex: i, error: pubKeyError?.message || String(pubKeyError) },
                })
                // #endregion
              }
            }
          }
        }
        // if we found create instruction and returned, break out of loop
        // (the return statement above would have already exited)
      }
      // if we get here, no create instruction was found in any transaction
      // #region agent log
      emitDebugLog({
        hypothesisId: "H11",
        location: "app/api/clone/route.ts:GET",
        message: "no create instruction found in any mint transaction",
        data: { mint: primary, signaturesChecked: signatures.length },
      })
      // #endregion
    } catch (error: any) {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H11",
        location: "app/api/clone/route.ts:GET",
        message: "transaction history fetch failed",
        data: { mint: primary, error: error?.message || String(error) },
      })
      // #endregion
    }
  }

  // try Solscan as fallback (H14)
  if (primary && isValidPublicKey(primary)) {
    try {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H14",
        location: "app/api/clone/route.ts:GET",
        message: "trying Solscan fallback",
        data: { mint: primary },
      })
      // #endregion
      // try Solscan API first (if available)
      const solscanApiUrl = `https://public-api.solscan.io/token/meta?tokenAddress=${primary}`
      try {
        const apiRes = await fetch(solscanApiUrl, {
          headers: {
            "user-agent": "panel/1.0",
            accept: "application/json",
          },
        }).catch(() => null)
        if (apiRes && apiRes.ok) {
          const apiData = await apiRes.json().catch(() => null)
          if (apiData && apiData.data) {
            // #region agent log
            emitDebugLog({
              hypothesisId: "H14",
              location: "app/api/clone/route.ts:GET",
              message: "Solscan API success",
              data: { mint: primary, hasName: !!apiData.data.name, hasSymbol: !!apiData.data.symbol },
            })
            // #endregion
            const uri = apiData.data.uri || apiData.data.metadataUri
            if (uri) {
              const metadataRes = await fetch(uri).catch(() => null)
              if (metadataRes && metadataRes.ok) {
                const metadataJson = await metadataRes.json().catch(() => null)
                if (metadataJson) {
                  return NextResponse.json({
                    name: apiData.data.name || metadataJson.name || "",
                    symbol: apiData.data.symbol || metadataJson.symbol || "",
                    uri: metadataJson.image || metadataJson.image_uri || "",
                    description: metadataJson.description || "",
                    website: metadataJson.website || metadataJson.external_url || "",
                    twitter: metadataJson.twitter || metadataJson.x || "",
                    telegram: metadataJson.telegram || "",
                  })
                }
              }
            }
          }
        }
      } catch (apiError: any) {
        // #region agent log
        emitDebugLog({
          hypothesisId: "H14",
          location: "app/api/clone/route.ts:GET",
          message: "Solscan API failed, trying HTML",
          data: { mint: primary, error: apiError?.message || String(apiError) },
        })
        // #endregion
      }
      // fallback to HTML parsing
      const solscanUrl = `https://solscan.io/token/${primary}#metadata`
      const solscanRes = await fetch(solscanUrl, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      }).catch(() => null)
      // #region agent log
      emitDebugLog({
        hypothesisId: "H14",
        location: "app/api/clone/route.ts:GET",
        message: "Solscan HTML fetch result",
        data: { mint: primary, ok: solscanRes?.ok, status: solscanRes?.status },
      })
      // #endregion
      if (solscanRes && solscanRes.ok) {
        const html = await solscanRes.text().catch(() => "")
        // #region agent log
        emitDebugLog({
          hypothesisId: "H14",
          location: "app/api/clone/route.ts:GET",
          message: "Solscan HTML received",
          data: { mint: primary, htmlLength: html.length },
        })
        // #endregion
        // extract metadata from pretty-json-container object-container element
        // this is where Solscan stores the metadata JSON
        let metadataJson: any = null
        let uri: string | null = null
        let name: string | null = null
        let symbol: string | null = null
        
        // find the container with class "pretty-json-container object-container" (more flexible pattern)
        // try multiple patterns to find the container
        let containerContent: string | null = null
        const containerPatterns = [
          /<div[^>]*class=["'][^"']*pretty-json-container[^"']*object-container[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
          /<div[^>]*class=["'][^"']*object-container[^"']*pretty-json-container[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
          /class=["']pretty-json-container object-container["'][^>]*>([\s\S]*?)(?:<\/div>|$)/i,
          /class=["']object-container pretty-json-container["'][^>]*>([\s\S]*?)(?:<\/div>|$)/i,
        ]
        
        for (const pattern of containerPatterns) {
          const match = html.match(pattern)
          if (match && match[1]) {
            containerContent = match[1]
            // #region agent log
            emitDebugLog({
              hypothesisId: "H14",
              location: "app/api/clone/route.ts:GET",
              message: "found pretty-json-container",
              data: { mint: primary, containerLength: containerContent.length, pattern: pattern.toString().substring(0, 50) },
            })
            // #endregion
            break
          }
        }
        
        if (containerContent) {
          // try to find JSON object with mint, name, symbol, uri in the container
          // more flexible pattern that handles whitespace and nested structure
          const jsonPatterns = [
            /\{\s*"mint"\s*:\s*"[^"]+"\s*,\s*"updateAuthority"\s*:\s*"[^"]*"\s*,\s*"data"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"symbol"\s*:\s*"([^"]+)"[^}]*"uri"\s*:\s*"([^"]+)"[^}]*\}[^}]*\}/,
            /"name"\s*:\s*"([^"]+)"[^"]*"symbol"\s*:\s*"([^"]+)"[^"]*"uri"\s*:\s*"([^"]+)"/,
            /"data"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"symbol"\s*:\s*"([^"]+)"[^}]*"uri"\s*:\s*"([^"]+)"/,
          ]
          
          for (const pattern of jsonPatterns) {
            const jsonMatch = containerContent.match(pattern)
            if (jsonMatch) {
              name = jsonMatch[1]
              symbol = jsonMatch[2]
              uri = jsonMatch[3]
              // #region agent log
              emitDebugLog({
                hypothesisId: "H14",
                location: "app/api/clone/route.ts:GET",
                message: "extracted metadata from container regex",
                data: { mint: primary, hasName: !!name, hasSymbol: !!symbol, hasUri: !!uri, name, symbol, uri: uri?.substring(0, 50) },
              })
              // #endregion
              break
            }
          }
          
          // if regex didn't work, try to find and parse JSON object directly
          if (!name || !symbol) {
            // look for complete JSON object in container
            const jsonObjMatch = containerContent.match(/\{[^{}]*"mint"[^{}]*"data"[^{}]*\{[^{}]*"name"[^{}]*"symbol"[^{}]*"uri"[^{}]*\}[^{}]*\}/)
            if (jsonObjMatch) {
              try {
                metadataJson = JSON.parse(jsonObjMatch[0])
                // #region agent log
                emitDebugLog({
                  hypothesisId: "H14",
                  location: "app/api/clone/route.ts:GET",
                  message: "found JSON object in container",
                  data: { mint: primary, hasData: !!metadataJson?.data },
                })
                // #endregion
              } catch (e: any) {
                // #region agent log
                emitDebugLog({
                  hypothesisId: "H14",
                  location: "app/api/clone/route.ts:GET",
                  message: "JSON parse error",
                  data: { mint: primary, error: e?.message },
                })
                // #endregion
              }
            }
          }
        } else {
          // #region agent log
          emitDebugLog({
            hypothesisId: "H14",
            location: "app/api/clone/route.ts:GET",
            message: "pretty-json-container not found, trying direct JSON search",
            data: { mint: primary, htmlSnippet: html.substring(html.indexOf('pretty-json'), html.indexOf('pretty-json') + 200) },
          })
          // #endregion
          // fallback: try to find JSON directly in HTML without container
          const directJsonMatch = html.match(/\{\s*"mint"\s*:\s*"[^"]+"\s*,\s*"updateAuthority"\s*:\s*"[^"]*"\s*,\s*"data"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"symbol"\s*:\s*"([^"]+)"[^}]*"uri"\s*:\s*"([^"]+)"[^}]*\}[^}]*\}/)
          if (directJsonMatch) {
            name = directJsonMatch[1]
            symbol = directJsonMatch[2]
            uri = directJsonMatch[3]
            // #region agent log
            emitDebugLog({
              hypothesisId: "H14",
              location: "app/api/clone/route.ts:GET",
              message: "extracted metadata from direct HTML search",
              data: { mint: primary, hasName: !!name, hasSymbol: !!symbol, hasUri: !!uri },
            })
            // #endregion
          }
        }
        
        // if found metadata in JSON, extract from it
        if (metadataJson) {
          // handle nested structure: metadataJson.data.name, metadataJson.data.symbol, metadataJson.data.uri
          if (metadataJson.data) {
            name = metadataJson.data.name || name
            symbol = metadataJson.data.symbol || symbol
            uri = metadataJson.data.uri || uri
          } else {
            name = metadataJson.name || name
            symbol = metadataJson.symbol || symbol
            uri = metadataJson.uri || metadataJson.metadataUri || metadataJson.image_uri || uri
          }
          // #region agent log
          emitDebugLog({
            hypothesisId: "H14",
            location: "app/api/clone/route.ts:GET",
            message: "extracted metadata from JSON object",
            data: { mint: primary, hasUri: !!uri, hasName: !!name, hasSymbol: !!symbol },
          })
          // #endregion
        }
        // #region agent log
        emitDebugLog({
          hypothesisId: "H14",
          location: "app/api/clone/route.ts:GET",
          message: "Solscan HTML parsed",
          data: { mint: primary, foundUri: !!uri, foundName: !!name, foundSymbol: !!symbol, foundJson: !!metadataJson },
        })
        // #endregion
        if (uri) {
          // #region agent log
          emitDebugLog({
            hypothesisId: "H14",
            location: "app/api/clone/route.ts:GET",
            message: "found URI in Solscan HTML, fetching metadata",
            data: { mint: primary, uri },
          })
          // #endregion
          const metadataRes = await fetch(uri).catch(() => null)
          if (metadataRes && metadataRes.ok) {
            const metadataJson = await metadataRes.json().catch(() => null)
            if (metadataJson) {
              // #region agent log
              emitDebugLog({
                hypothesisId: "H14",
                location: "app/api/clone/route.ts:GET",
                message: "metadata fetched from Solscan URI",
                data: { mint: primary, hasName: !!metadataJson.name, hasImage: !!metadataJson.image },
              })
              // #endregion
              return NextResponse.json({
                name: name || metadataJson?.name || "",
                symbol: symbol || metadataJson?.symbol || "",
                uri: metadataJson?.image || metadataJson?.image_uri || "",
                description: metadataJson?.description || "",
                website: metadataJson?.website || metadataJson?.external_url || "",
                twitter: metadataJson?.twitter || metadataJson?.x || "",
                telegram: metadataJson?.telegram || "",
              })
            }
          } else {
            // #region agent log
            emitDebugLog({
              hypothesisId: "H14",
              location: "app/api/clone/route.ts:GET",
              message: "metadata URI fetch failed",
              data: { mint: primary, uri, status: metadataRes?.status },
            })
            // #endregion
          }
        }
      } else {
        // #region agent log
        emitDebugLog({
          hypothesisId: "H14",
          location: "app/api/clone/route.ts:GET",
          message: "Solscan HTML fetch failed",
          data: { mint: primary, status: solscanRes?.status, statusText: solscanRes?.statusText },
        })
        // #endregion
      }
    } catch (error: any) {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H14",
        location: "app/api/clone/route.ts:GET",
        message: "Solscan fallback failed",
        data: { mint: primary, error: error?.message || String(error) },
      })
      // #endregion
    }
  }

  const pumpApiCandidates = [
    { mint: primary, url: `https://frontend-api.pump.fun/coins/${primary}` },
    { mint: primary, url: `https://client-api.pump.fun/coins/${primary}` },
    { mint: primary, url: `https://explorer-api.pump.fun/coins/${primary}` },
    ...(alt && alt !== primary ? [
      { mint: alt, url: `https://frontend-api.pump.fun/coins/${alt}` },
      { mint: alt, url: `https://client-api.pump.fun/coins/${alt}` },
      { mint: alt, url: `https://explorer-api.pump.fun/coins/${alt}` },
    ] : []),
  ]

  for (const candidate of pumpApiCandidates) {
    // #region agent log
    emitDebugLog({
      hypothesisId: "H5",
      location: "app/api/clone/route.ts:GET",
      message: "pump.fun fallback attempt",
      data: { mint: candidate.mint, url: candidate.url },
    })
    // #endregion

    try {
      // #region agent log
      emitDebugLog({
        hypothesisId: "H5",
        location: "app/api/clone/route.ts:GET",
        message: "pump.fun fetch start",
        data: { mint: candidate.mint, url: candidate.url },
      })
      // #endregion
      let res: Response
      try {
        // try without timeout first (H9, H10)
        res = await fetch(candidate.url, {
          cache: "no-store",
          headers: {
            "user-agent": "panel/1.0",
            accept: "application/json",
            referer: "https://pump.fun",
          },
        })
      } catch (fetchError: any) {
        attempts.push({ mint: candidate.mint, rpc: candidate.url, error: fetchError?.message || "fetch failed" })
        // #region agent log
        emitDebugLog({
          hypothesisId: "H5",
          location: "app/api/clone/route.ts:GET",
          message: "pump.fun fetch error",
          data: { mint: candidate.mint, url: candidate.url, error: fetchError?.message || String(fetchError) },
        })
        // #endregion
        continue
      }
      if (!res.ok) {
        const errorText = await res.text().catch(() => "")
        attempts.push({ mint: candidate.mint, rpc: candidate.url, error: `pump.fun ${res.status}` })
        // #region agent log
        emitDebugLog({
          hypothesisId: "H5",
          location: "app/api/clone/route.ts:GET",
          message: "pump.fun fetch not ok",
          data: { mint: candidate.mint, url: candidate.url, status: res.status, statusText: res.statusText, errorText: errorText.substring(0, 200) },
        })
        // #endregion
        continue
      }
      // #region agent log
      emitDebugLog({
        hypothesisId: "H5",
        location: "app/api/clone/route.ts:GET",
        message: "pump.fun fetch ok",
        data: { mint: candidate.mint, url: candidate.url, status: res.status },
      })
      // #endregion
      const data = await res.json().catch((err: any) => {
        attempts.push({ mint: candidate.mint, rpc: candidate.url, error: err?.message || "json parse failed" })
        // #region agent log
        emitDebugLog({
          hypothesisId: "H5",
          location: "app/api/clone/route.ts:GET",
          message: "pump.fun json parse failed",
          data: { mint: candidate.mint, url: candidate.url, error: err?.message || String(err) },
        })
        // #endregion
        return null
      })
      if (!data) continue

      // #region agent log
      emitDebugLog({
        hypothesisId: "H5",
        location: "app/api/clone/route.ts:GET",
        message: "pump.fun response received",
        data: { 
          mint: candidate.mint, 
          url: candidate.url, 
          hasName: !!data?.name, 
          hasSymbol: !!data?.symbol, 
          hasMint: !!data?.mint,
          hasImageUri: !!data?.image_uri,
          keys: Object.keys(data || {}).slice(0, 10),
        },
      })
      // #endregion

      const actualMint = data?.mint || data?.mintAddress || candidate.mint
      // #region agent log
      emitDebugLog({
        hypothesisId: "H5",
        location: "app/api/clone/route.ts:GET",
        message: "using mint from pump.fun response",
        data: { originalMint: candidate.mint, actualMint, dataMint: data?.mint, dataMintAddress: data?.mintAddress },
      })
      // #endregion

      return NextResponse.json({
        name: data?.name || "",
        symbol: data?.symbol || "",
        uri: data?.image_uri || "",
        description: data?.description || "",
        image: data?.image_uri || "",
        twitter: data?.twitter || data?.x || "",
        telegram: data?.telegram || "",
        website: data?.website || data?.external_url || "",
        rawJson: data,
        usedRpc: candidate.url,
        usedMint: actualMint,
      })
    } catch (error: any) {
      attempts.push({ mint: candidate.mint, rpc: candidate.url, error: error?.message || String(error) })
      // #region agent log
      emitDebugLog({
        hypothesisId: "H5",
        location: "app/api/clone/route.ts:GET",
        message: "pump.fun fallback error",
        data: { mint: candidate.mint, url: candidate.url, error: error?.message || String(error) },
      })
      // #endregion
      continue
    }
  }
  // #region agent log
  emitDebugLog({
    hypothesisId: "H5",
    location: "app/api/clone/route.ts:GET",
    message: "all pump.fun attempts failed",
    data: {},
  })
  // #endregion

  // token-list fallback (use mainnet entry first, then devnet)
  const tokenListMints = [primary, ...(alt && alt !== primary ? [alt] : [])]
  const preferredChainIds = NETWORK === "mainnet-beta" ? [101, 102] : [101, 102]

  emitDebugLog({
    hypothesisId: "H7",
    location: "app/api/clone/route.ts:GET",
    message: "token list fetch attempt",
    data: { url: TOKEN_LIST_URL, mints: tokenListMints },
  })

  try {
    const res = await fetch(TOKEN_LIST_URL, { cache: "no-store" })
    if (!res.ok) {
      attempts.push({ mint: primary, rpc: TOKEN_LIST_URL, error: `token list ${res.status}` })
      emitDebugLog({
        hypothesisId: "H7",
        location: "app/api/clone/route.ts:GET",
        message: "token list fetch failed",
        data: { status: res.status },
      })
    } else {
      const list = await res.json().catch((err: any) => {
        attempts.push({ mint: primary, rpc: TOKEN_LIST_URL, error: err?.message || "token list parse failed" })
        emitDebugLog({
          hypothesisId: "H7",
          location: "app/api/clone/route.ts:GET",
          message: "token list parse failed",
          data: { error: err?.message || String(err) },
        })
        return null
      })

      if (list?.tokens && Array.isArray(list.tokens)) {
        const findEntry = (mint: string) => {
          const matches = list.tokens.filter((t: any) => t.address === mint)
          for (const chainId of preferredChainIds) {
            const found = matches.find((t: any) => t.chainId === chainId)
            if (found) return found
          }
          return matches[0]
        }

        let entry: any = null
        for (const mint of tokenListMints) {
          entry = findEntry(mint)
          if (entry) break
        }

        if (entry) {
          emitDebugLog({
            hypothesisId: "H7",
            location: "app/api/clone/route.ts:GET",
            message: "token list match found",
            data: { address: entry.address, chainId: entry.chainId, name: entry.name, symbol: entry.symbol },
          })

          return NextResponse.json({
            name: entry.name || "",
            symbol: entry.symbol || "",
            uri: entry.logoURI || "",
            description: entry.description || "",
            image: entry.logoURI || "",
            twitter: entry.extensions?.twitter || entry.extensions?.x || "",
            telegram: entry.extensions?.telegram || "",
            website:
              entry.extensions?.website ||
              entry.extensions?.discord ||
              entry.extensions?.facebook ||
              entry.extensions?.medium ||
              "",
            rawJson: entry,
            usedRpc: `${TOKEN_LIST_URL}#token-list`,
            usedMint: entry.address,
          })
        } else {
          attempts.push({ mint: primary, rpc: TOKEN_LIST_URL, error: "not found in token list" })
          emitDebugLog({
            hypothesisId: "H7",
            location: "app/api/clone/route.ts:GET",
            message: "token list no match",
            data: { mintsTried: tokenListMints },
          })
        }
      } else {
        attempts.push({ mint: primary, rpc: TOKEN_LIST_URL, error: "token list missing tokens array" })
        emitDebugLog({
          hypothesisId: "H7",
          location: "app/api/clone/route.ts:GET",
          message: "token list missing tokens",
          data: {},
        })
      }
    }
  } catch (error: any) {
    attempts.push({ mint: primary, rpc: TOKEN_LIST_URL, error: error?.message || String(error) })
    emitDebugLog({
      hypothesisId: "H7",
      location: "app/api/clone/route.ts:GET",
      message: "token list fetch error",
      data: { error: error?.message || String(error) },
    })
  }

  // #region agent log
  emitDebugLog({
    hypothesisId: "H2",
    location: "app/api/clone/route.ts:GET",
    message: "all attempts failed, returning error",
    data: { attemptsCount: attempts.length, attempts },
  })
  // #endregion
  return NextResponse.json(
    {
      error: "clone failed",
      attempts,
    },
    { status: 500 },
  )
}

