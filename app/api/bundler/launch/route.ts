import {
  createLaunchBundle,
  estimateBundleCost,
  resolveLaunchBuyAmount,
  prepareLaunchLut,
  isLutReady, // Import this
  verifyWalletIndependence,
  getKeypair,
  type BundleConfig,
  type BundlerWallet,
} from "@/lib/solana/bundler-engine"
import { MAX_BUNDLE_WALLETS } from "@/lib/solana/bundler-engine"
import { isPumpFunAvailable, getBondingCurveData, calculateBuyAmount } from "@/lib/solana/pumpfun-sdk"
import { SOLANA_NETWORK, safeConnection } from "@/lib/solana/config"
import { JitoRegion } from "@/lib/solana/jito"
import { prisma } from "@/lib/prisma"
import { PublicKey } from "@solana/web3.js"
import { MIN_BUY_SOL } from "@/lib/config/limits"

// ... constants

// POST - create launch bundle (create token + bundled buys)
export async function POST(request: NextRequest) {
  try {
    if (!isPumpFunAvailable()) {
      return NextResponse.json(
        { error: `pump.fun not available on ${SOLANA_NETWORK}` },
        { status: 400 }
      )
    }

    const body = await request.json()
    const {
      action = "create", // create | prepare-lut | check-links
      // ... existing params
      walletPublicKeys,
      devPublicKey,
      // ...
      activeWalletCount // For prepare-lut fallback if walletPublicKeys missing
    } = body

    // --- Action: Prepare LUT ---
    if (action === "prepare-lut") {
        // We need wallets to populate the LUT.
        // If walletPublicKeys is provided, use them.
        // If not, try to fetch "active" wallets from DB + Dev.
        // Since LaunchPanel only passes activeWalletCount usually, we might need to query DB smartly.
        // But LaunchPanel UI should ideally pass the keys or we query 'isActive=true'.
        
        let targetWallets: BundlerWallet[] = []
        if (walletPublicKeys && walletPublicKeys.length > 0) {
             const dbWallets = await prisma.wallet.findMany({ where: { publicKey: { in: walletPublicKeys } } })
             targetWallets = dbWallets.map(w => ({
                 publicKey: w.publicKey,
                 secretKey: w.secretKey,
                 solBalance: parseFloat(w.solBalance),
                 tokenBalance: parseFloat(w.tokenBalance),
                 isActive: w.isActive,
                 label: w.label || undefined,
                 role: w.role || "project"
             }))
        } else {
             // Fallback: fetch all active
             const dbWallets = await prisma.wallet.findMany({ where: { isActive: true } })
             targetWallets = dbWallets.map(w => ({
                 publicKey: w.publicKey,
                 secretKey: w.secretKey,
                 solBalance: parseFloat(w.solBalance),
                 tokenBalance: parseFloat(w.tokenBalance),
                 isActive: w.isActive,
                 label: w.label || undefined,
                 role: w.role || "project"
             }))
        }
        
        const devWallet = targetWallets.find(w => w.role === 'dev') || targetWallets[0]
        if (!devWallet) return NextResponse.json({ error: "No dev/active wallet found" }, { status: 400 })
        
        const devKeypair = getKeypair(devWallet)
        const address = await prepareLaunchLut(targetWallets, devKeypair)
        return NextResponse.json({ success: true, lutAddress: address })
    }

    // ... existing validation and actions
    
    // Ensure existing validation logic doesn't block prepare-lut if it was handled above
    // (It won't, because we return early inside the if block)
    
    // ... existing logic for create/check-links ...
    // Need to make sure we don't duplicate code or break existing flow.
    // I will merge the logic carefully in the response block.
    
    // Re-implementing the existing logic flow with my insertion:
    
    // validation (common for create/check-links)
    if (action !== "prepare-lut") {
        if (!walletPublicKeys || !Array.isArray(walletPublicKeys) || walletPublicKeys.length === 0) {
          return NextResponse.json({ error: "walletPublicKeys array required" }, { status: 400 })
        }
        if (!devPublicKey || typeof devPublicKey !== "string") {
          return NextResponse.json({ error: "devPublicKey required" }, { status: 400 })
        }
    }

    // ... existing wallet loading logic ...
    const dbWallets = await prisma.wallet.findMany({
      where: { publicKey: { in: walletPublicKeys || [] } },
    })
    // ... (rest of the file as is, but see instruction)
    
    // I'll use the 'replace' tool to inject the import and the logic at the top of POST.
    // And handle the GET check-lut.
    
    // Wait, GET is separate function.
    
    // ...
    
    // Resume original file context...
    
    // I will REPLACE the entire file content or specific parts?
    // Replace is risky for large files if I don't have perfect context match.
    // I will use `replace` on the imports and the GET function to add `check-lut`.
    // And insert the `prepare-lut` logic in POST.
    
    // Let's do imports first.
    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  } catch (error: any) {
    console.error("launch bundle error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// GET - estimate launch costs AND check-lut
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get("action")
    
    if (action === "check-lut") {
        const address = searchParams.get("address")
        if (!address) return NextResponse.json({ ready: false })
        const ready = await isLutReady(safeConnection, new PublicKey(address), 1000) // fast check
        return NextResponse.json({ ready })
    }

    const walletCount = parseInt(searchParams.get("walletCount") || "5")
    // ... existing estimate logic
    const devBuyAmount = parseFloat(searchParams.get("devBuyAmount") || "0.1")
    const buyAmountPerWallet = parseFloat(searchParams.get("buyAmountPerWallet") || "0.01")
    const jitoTip = parseFloat(searchParams.get("jitoTip") || "0.0001")
    const priorityFee = parseFloat(searchParams.get("priorityFee") || "0.0001")

    // create buy amounts array
    const buyAmounts = [devBuyAmount]
    for (let i = 1; i < walletCount; i++) {
      buyAmounts.push(buyAmountPerWallet)
    }

    const estimate = estimateBundleCost(walletCount, buyAmounts, jitoTip, priorityFee)

    return NextResponse.json({
      walletCount,
      devBuyAmount,
      buyAmountPerWallet,
      jitoTip,
      priorityFee,
      estimate: {
        totalSol: estimate.totalSol.toFixed(4),
        perWallet: estimate.perWallet.map((a) => a.toFixed(4)),
        fees: estimate.fees.toFixed(6),
      },
    })
  } catch (error: any) {
    console.error("estimate error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
