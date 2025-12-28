import { NextRequest, NextResponse } from "next/server"
import { isPumpFunAvailable } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK } from "@/lib/solana/config"
import { fetchWithRetry } from "@/lib/utils/fetch-retry"
import { UPLOAD_ALLOWED_PREFIX, UPLOAD_MAX_BYTES, FETCH_TIMEOUT_MS, FETCH_RETRIES, FETCH_BACKOFF_MS } from "@/lib/config/limits"

export async function POST(request: NextRequest) {
  try {
    if (!isPumpFunAvailable()) {
      return NextResponse.json({ 
        error: `pump.fun not available on ${SOLANA_NETWORK}. switch to mainnet-beta` 
      }, { status: 400 })
    }

    const formData = await request.formData()
    
    const file = formData.get("file") as File
    const name = formData.get("name") as string
    const symbol = formData.get("symbol") as string
    const description = formData.get("description") as string
    const twitter = formData.get("twitter") as string | null
    const telegram = formData.get("telegram") as string | null
    const website = formData.get("website") as string | null

    if (!file || !name || !symbol) {
      return NextResponse.json({ error: "file, name, and symbol required" }, { status: 400 })
    }

    const mime = (file as any).type || ""
    if (file.size > UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: "image must be <= 5MB" }, { status: 400 })
    }
    if (mime && !mime.startsWith(UPLOAD_ALLOWED_PREFIX)) {
      return NextResponse.json({ error: "only image uploads are allowed" }, { status: 400 })
    }

    // forward to pump.fun IPFS API
    const pumpFormData = new FormData()
    pumpFormData.append("file", file)
    pumpFormData.append("name", name)
    pumpFormData.append("symbol", symbol)
    pumpFormData.append("description", description || "")
    if (twitter) pumpFormData.append("twitter", twitter)
    if (telegram) pumpFormData.append("telegram", telegram)
    if (website) pumpFormData.append("website", website)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const response = await fetchWithRetry("https://pump.fun/api/ipfs", {
      method: "POST",
      body: pumpFormData,
      signal: controller.signal,
      retries: FETCH_RETRIES,
      backoffMs: FETCH_BACKOFF_MS,
    }).finally(() => clearTimeout(timeout))

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`pump.fun ipfs upload failed: ${errorText}`)
    }

    const data = await response.json()
    
    return NextResponse.json({
      metadataUri: data.metadataUri,
      metadata: data.metadata,
    })
  } catch (error: any) {
    console.error("error uploading metadata:", error)
    return NextResponse.json({ error: error.message || "internal server error" }, { status: 500 })
  }
}
