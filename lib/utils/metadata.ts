/**
 * Generate JSON metadata for pump.fun token
 * This should be uploaded to IPFS or a web server
 */
export interface TokenMetadata {
  name: string
  symbol: string
  description: string
  image: string
  attributes?: Array<{
    trait_type: string
    value: string
  }>
  properties?: {
    files?: Array<{
      uri: string
      type: string
    }>
    category?: string
  }
  website?: string
  twitter?: string
  telegram?: string
}

/**
 * Generate metadata JSON string
 */
export function generateMetadata(params: {
  name: string
  symbol: string
  description: string
  imageUrl: string
  website?: string
  twitter?: string
  telegram?: string
}): string {
  const metadata: TokenMetadata = {
    name: params.name,
    symbol: params.symbol,
    description: params.description,
    image: params.imageUrl,
    properties: {
      files: [
        {
          uri: params.imageUrl,
          type: "image/png",
        },
      ],
      category: "image",
    },
  }

  // Add social links to description if provided
  if (params.website || params.twitter || params.telegram) {
    const links: string[] = []
    if (params.website) links.push(`Website: ${params.website}`)
    if (params.twitter) links.push(`Twitter: ${params.twitter}`)
    if (params.telegram) links.push(`Telegram: ${params.telegram}`)
    metadata.description = `${params.description}\n\n${links.join("\n")}`
  }

  return JSON.stringify(metadata, null, 2)
}

/**
 * For now, return a data URI. In production, upload to IPFS
 */
export function getMetadataUri(metadata: string): string {
  // TODO: Upload to IPFS (Pinata, NFT.Storage, etc.)
  // For now, return data URI (not recommended for production)
  return `data:application/json;base64,${Buffer.from(metadata).toString("base64")}`
}

