
import "dotenv/config"
import { prisma } from "../lib/prisma"

async function main() {
  try {
    const wallets = await prisma.wallet.findMany({
      orderBy: { createdAt: "desc" },
    })

    console.log(`Found ${wallets.length} wallets.\n`)
    console.log("Index | Public Key | Secret Key (Base58)")
    console.log("-".repeat(80))

    wallets.forEach((w, i) => {
      console.log(`${i + 1}. | ${w.publicKey} | ${w.secretKey}`)
    })

    console.log("\nDone.")
  } catch (error) {
    console.error("Error exporting wallets:", error)
  } finally {
    await prisma.$disconnect()
  }
}

main()
