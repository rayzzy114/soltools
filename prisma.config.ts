import { defineConfig } from "prisma/config"
import { PrismaPg } from "@prisma/adapter-pg"
import "dotenv/config"

// hard default for test env; still reads DATABASE_URL if set
const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:5433/pumpfun_panel?schema=public"

const shadowDatabaseUrl =
  process.env.SHADOW_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:5433/pumpfun_shadow?schema=public"

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: databaseUrl,
    shadowDatabaseUrl,
  },
  adapter: async () => {
    return new PrismaPg({ connectionString: databaseUrl })
  },
})
