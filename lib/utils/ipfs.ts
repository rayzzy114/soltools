/**
 * Upload image to IPFS
 * You can use services like Pinata, NFT.Storage, or Web3.Storage
 */
export async function uploadToIPFS(file: File): Promise<string> {
  // For now, return the file URL if it's already a URL
  // In production, implement actual IPFS upload
  if (file instanceof File) {
    // TODO: Implement IPFS upload using Pinata, NFT.Storage, or Web3.Storage
    // Example with NFT.Storage:
    // const client = new NFTStorage({ token: process.env.NEXT_PUBLIC_NFT_STORAGE_TOKEN! })
    // const cid = await client.storeBlob(file)
    // return `https://ipfs.io/ipfs/${cid}`
    
    throw new Error("IPFS upload not implemented. Please provide an image URL.")
  }
  
  return file as unknown as string
}

/**
 * Validate image URL
 */
export function isValidImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

