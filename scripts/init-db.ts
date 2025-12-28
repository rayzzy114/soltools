import { Client } from "pg"

function fail(message: string) {
  console.error(message)
  process.exit(1)
}

const rawUrl = process.env.DATABASE_URL
if (!rawUrl) {
  fail("DATABASE_URL is not set. Add it to your .env before running this script.")
}

let dbUrl: URL
try {
  dbUrl = new URL(rawUrl)
} catch (e) {
  fail(`Invalid DATABASE_URL: ${(e as Error).message}`)
}

const dbName = dbUrl.pathname.replace(/^\//, "")
if (!dbName) {
  fail("DATABASE_URL is missing database name")
}

const schema = dbUrl.searchParams.get("schema") || "public"

// build admin URL pointing to default 'postgres' database
const adminUrl = new URL(dbUrl.toString())
adminUrl.pathname = "/postgres"
adminUrl.search = ""

async function ensureDatabase() {
  const adminClient = new Client({ connectionString: adminUrl.toString() })
  await adminClient.connect()
  try {
    await adminClient.query(`CREATE DATABASE "${dbName}"`)
    console.log(`created database "${dbName}"`)
  } catch (e: any) {
    if (e?.code === "42P04") {
      console.log(`database "${dbName}" already exists`)
    } else {
      throw e
    }
  } finally {
    await adminClient.end()
  }
}

async function ensureSchema() {
  const client = new Client({ connectionString: dbUrl.toString() })
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    console.log(`schema "${schema}" ready`)
  } finally {
    await client.end()
  }
}

async function main() {
  await ensureDatabase()
  await ensureSchema()
  console.log("database initialized")
}

main().catch((e) => {
  console.error("failed to initialize database:", e?.message || e)
  process.exit(1)
})

