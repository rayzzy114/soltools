/**
 * Validate token creation parameters
 */
export function validateTokenParams(params: {
  name: string
  symbol: string
  description: string
  imageUrl: string
}): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const isDataUrl = params.imageUrl?.startsWith("data:")
  const maxUrlLen = 512

  if (!params.name || params.name.trim().length === 0) {
    errors.push("Token name is required")
  } else if (params.name.length > 32) {
    errors.push("Token name must be 32 characters or less")
  }

  if (!params.symbol || params.symbol.trim().length === 0) {
    errors.push("Token symbol is required")
  } else if (params.symbol.length > 10) {
    errors.push("Token symbol must be 10 characters or less")
  } else if (!/^[A-Z0-9]+$/.test(params.symbol)) {
    errors.push("Token symbol must contain only uppercase letters and numbers")
  }

  if (params.description && params.description.length > 200) {
    errors.push("Description must be 200 characters or less")
  }

  if (!params.imageUrl || params.imageUrl.trim().length === 0) {
    errors.push("Image URL is required")
  } else if (!isDataUrl && params.imageUrl.length > maxUrlLen) {
    errors.push(`Image URL must be ${maxUrlLen} characters or less`)
  } else if (!isDataUrl && !/^https?:\/\//.test(params.imageUrl)) {
    errors.push("Image URL must be a valid HTTP/HTTPS URL")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validate SOL amount for buy
 */
export function validateBuyAmount(amount: string): { valid: boolean; error?: string } {
  const num = parseFloat(amount)
  if (isNaN(num) || num <= 0) {
    return { valid: false, error: "Amount must be a positive number" }
  }
  if (num < 0.001) {
    return { valid: false, error: "Minimum buy amount is 0.001 SOL" }
  }
  return { valid: true }
}

/**
 * Validate token amount for sell
 */
export function validateSellAmount(amount: string): { valid: boolean; error?: string } {
  const num = parseFloat(amount)
  if (isNaN(num) || num <= 0) {
    return { valid: false, error: "Amount must be a positive number" }
  }
  return { valid: true }
}

