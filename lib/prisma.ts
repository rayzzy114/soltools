import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const databaseUrl = process.env.DATABASE_URL
const fallbackUrl = "postgresql://user:password@localhost:5432/solana_tools"

if (!databaseUrl) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production")
  }
  console.warn("DATABASE_URL not set; using local fallback connection string")
}

const pool = new Pool({
  connectionString: databaseUrl || fallbackUrl,
  max: 10,
})

const adapter = new PrismaPg(pool)

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter })

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma

